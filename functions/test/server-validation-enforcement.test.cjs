'use strict';
/* =========================================================================
   Phase 3A-3 — Server-side enforcement tests (callable logic over fakes).
   ---------------------------------------------------------------------------
   Every case is an ATTEMPT TO GET AN APPROVAL THE SERVER MUST NOT GIVE, or a proof that a legitimate approval
   still works. Attacks are simulated at the two places a caller controls: the request payload and the stored
   opportunity document (a direct Firestore write can store NaN, Infinity, strings, unsafe keys...).
   Fakes do not prove isolation between concurrent transactions: that is p0-approve-validation.emulator.test.js.
   ========================================================================= */
const assert = require('node:assert/strict');
const { readyFixture, setPath, makeEnv, clone, EMAIL } = require('./helpers/ic-fixtures.cjs');
const { documentHash, canonicalDocValue, VOLATILE_DOC_FIELDS, recompute } = require('../trusted-ic.cjs');

const env = makeEnv();
const { fns, db } = env;
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`OK ${name}`); }

// Approval must be refused: nothing may be written anywhere.
async function refused(request, code, rejectionCode) {
  const before = JSON.stringify(db.__get('opportunities', request.data && request.data.oppId || 'OPP'));
  const counts = env.counts();
  await assert.rejects(fns.approveOpportunity(request), e => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    if (rejectionCode) assert.ok([].concat(rejectionCode).includes(e.details && e.details.rejectionCode), `rejectionCode ${e.details && e.details.rejectionCode} not in ${[].concat(rejectionCode)}`);
    return true;
  });
  assert.deepEqual(env.counts(), counts, 'a refused request writes nothing');
  assert.equal(JSON.stringify(db.__get('opportunities', request.data && request.data.oppId || 'OPP')), before, 'a refused request does not mutate the opportunity');
}

(async () => {
  const ready = await readyFixture();
  const loose = clone(ready); Object.assign(loose.criteria, { irrMin: -1, projIrrMin: -1, moicMin: 0, dscrMin: null }); // isolate the risk logic from the readiness gate
  const withFlags = (n) => {
    const o = clone(loose);
    const flags = [['financing.ltc', 0.9], ['financing.saibor', 0.25], ['development.exitCapRate', 0.25], ['development.constructionYears', 12]];
    flags.slice(0, n).forEach(([p, v]) => setPath(o, p, v));
    return o;
  };

  // ---------------------------------------------------------------- L0: the request payload
  console.log('\n== L0: request payload (strict whitelist, types, no client-supplied verdict) ==');
  await test('baseline: a clean stored opportunity and a clean request approve and record the SERVER verdict', async () => {
    env.seed(clone(ready)); const reviewedHash = env.hash();
    const r = await fns.approveOpportunity(env.req());
    const rec = db.__get('icDecisions', r.decisionId);
    assert.equal(rec.decision.validation.status, 'OK');
    assert.equal(rec.decision.validation.color, 'green');
    assert.equal(rec.decision.docHash, reviewedHash, 'the record binds the document as it was BEFORE the decision');
    assert.equal(rec.decision.warningsAcknowledged, false);
    const version = db.__get('underwritingVersions', r.versionId);
    assert.equal(version.validationColor, 'green'); assert.equal(version.docHash, rec.decision.docHash);
  });
  const FORGED = {
    status: 'OK', color: 'green', label: 'green', verdict: { color: 'green', blocked: false }, validation: { color: 'green' },
    readiness: { ready: true, gates: {} }, metrics: { equityIRR: 9.99 }, invalidMetrics: [], inputHash: 'x'.repeat(64),
    docHash: 'a'.repeat(64), engineVersion: 'forged', decidedBy: 'attacker@example.com', decidedAt: '1999-01-01', highRisk: false,
    compound: { requiresAcknowledgement: false }, blocked: false, ready: true, overridden: true, version: 99, __proto__x: 1,
  };
  for (const [k, v] of Object.entries(FORGED)) {
    await test(`forged top-level field "${k}" is REJECTED (not ignored), nothing written`, async () => {
      env.seed(clone(ready)); await refused(env.req({ [k]: v }), 'invalid-argument', 'UNEXPECTED_FIELD');
    });
  }
  await test('forged fields cannot rescue a blocked opportunity either (status:green on an INVALID LTC)', async () => {
    const o = clone(ready); setPath(o, 'financing.ltc', 1.8); env.seed(o);
    await refused(env.req({ status: 'OK', color: 'green', blocked: false }), 'invalid-argument', 'UNEXPECTED_FIELD');
    await refused(env.req(), 'failed-precondition', 'INPUTS_BLOCKED');
  });
  await test('forged keys inside decision{} and inside a condition are REJECTED', async () => {
    env.seed(clone(ready));
    await refused(env.req({ decision: { decision: 'approve', decidedBy: 'attacker', inputHash: 'forged' } }), 'invalid-argument', 'UNEXPECTED_FIELD');
    await refused(env.req({ decision: { decision: 'approve_conditions' }, conditions: [{ text: 'ok', owner: '', dueDate: '', status: 'pending', id: 'forged' }] }), 'invalid-argument', 'UNEXPECTED_FIELD');
  });
  await test('prototype-pollution keys in the payload are rejected and pollute nothing', async () => {
    env.seed(clone(ready));
    const evil = JSON.parse('{"oppId":"OPP","decision":{"decision":"approve"},"requestId":"R-evil","expectedDocHash":"' + env.hash() + '","__proto__":{"polluted":true}}');
    await refused({ auth: { token: { email: EMAIL } }, data: evil }, 'invalid-argument', 'UNSAFE_KEY');
    const nested = JSON.parse('{"oppId":"OPP","decision":{"decision":"approve","constructor":{"prototype":{"polluted":true}}},"requestId":"R-evil2","expectedDocHash":"' + env.hash() + '"}');
    await refused({ auth: { token: { email: EMAIL } }, data: nested }, 'invalid-argument', 'UNSAFE_KEY');
    assert.equal({}.polluted, undefined);
  });
  for (const data of [null, undefined, 'approve', 42, ['approve'], true]) {
    await test(`a non-object request body is rejected (${JSON.stringify(data)})`, async () => {
      env.seed(clone(ready));
      await assert.rejects(fns.approveOpportunity({ auth: { token: { email: EMAIL } }, data }), e => e.code === 'invalid-argument');
    });
  }
  for (const [name, v] of [['override', 'true'], ['override', 1], ['override', {}], ['warningsAcknowledged', 'true'], ['warningsAcknowledged', 1], ['warningsAcknowledged', []]]) {
    await test(`${name} must be a real boolean (${JSON.stringify(v)})`, async () => {
      env.seed(clone(ready)); await refused(env.req({ [name]: v }), 'invalid-argument');
    });
  }
  for (const h of [undefined, '', 'abc', 'A'.repeat(64), 'g'.repeat(64), 123, null, 'a'.repeat(63), 'a'.repeat(65)]) {
    await test(`an approval needs a well-formed expectedDocHash (${JSON.stringify(h)})`, async () => {
      env.seed(clone(ready)); await refused(env.req({ expectedDocHash: h }), 'invalid-argument');
    });
  }
  await test('a decision that is not an approval does not need expectedDocHash, but a malformed one is still rejected', async () => {
    env.seed(clone(ready));
    const data = env.req({ decision: { decision: 'reject' } }).data; delete data.expectedDocHash;
    const r = await fns.approveOpportunity({ auth: { token: { email: EMAIL } }, data });
    assert.equal(r.ok, true);
    await refused(env.req({ decision: { decision: 'hold' }, expectedDocHash: 'nope' }), 'invalid-argument');
  });
  for (const oppId of ['a/b', '', '   ', 7, null, {}]) {
    await test(`unsafe oppId rejected (${JSON.stringify(oppId)})`, async () => {
      env.seed(clone(ready)); await refused(env.req({ oppId }), 'invalid-argument');
    });
  }

  // ---------------------------------------------------------------- L2-L4: the stored document
  console.log('\n== L2-L4: stored document — LTC / leverage tampering ==');
  const LTC_BAD = [
    [1.8, 'INPUTS_BLOCKED'], [180, 'INPUTS_BLOCKED'], [1, 'INPUTS_BLOCKED'], [-0.2, 'INPUTS_BLOCKED'], [-1e-15, 'INPUTS_BLOCKED'],
    ['0.6', 'INPUTS_BLOCKED'], ['abc', 'INPUTS_BLOCKED'], ['', null], [true, 'INPUTS_BLOCKED'], [[0.6], 'INPUTS_BLOCKED'], [{ $number: '0.6' }, 'INPUTS_BLOCKED'],
    [{}, 'INPUTS_BLOCKED'], [NaN, 'NON_FINITE_INPUT'], [Infinity, 'NON_FINITE_INPUT'], [-Infinity, 'NON_FINITE_INPUT'], [1e308, 'INPUTS_BLOCKED'],
  ];
  for (const [v, code] of LTC_BAD) {
    await test(`stored financing.ltc = ${typeof v === 'number' ? String(v) : JSON.stringify(v)} cannot be approved${code ? ' (' + code + ')' : ''}`, async () => {
      const o = clone(ready); setPath(o, 'financing.ltc', v); env.seed(o);
      if (code) await refused(env.req({ override: true, reasons: ['accept the risk'], warningsAcknowledged: true }), 'failed-precondition', code);
      else { // empty string = "not entered": the engine treats it as absent exactly like the client, so it is legitimate input
        const r = await fns.approveOpportunity(env.req({ override: true, reasons: ['x'] })); assert.equal(r.ok, true);
      }
    });
  }
  await test('NaN/Infinity stored by a direct Firestore write are tagged with the offending path (figure-free)', async () => {
    const o = clone(ready); o.financing.ltc = NaN; env.seed(o);
    await assert.rejects(fns.approveOpportunity(env.req()), e => e.details.rejectionCode === 'NON_FINITE_INPUT' && e.details.path === 'financing.ltc' && !/NaN/.test(JSON.stringify(e.details)));
  });
  await test('an override and a written justification can NEVER approve a red (INVALID) opportunity', async () => {
    const o = clone(ready); setPath(o, 'financing.ltc', 1.8); env.seed(o);
    await refused(env.req({ override: true, reasons: ['I know what I am doing'], warningsAcknowledged: true }), 'failed-precondition', 'INPUTS_BLOCKED');
  });
  await test('the refusal reports issue codes and paths but no financial figures', async () => {
    const o = clone(ready); setPath(o, 'financing.ltc', 1.8); env.seed(o);
    await assert.rejects(fns.approveOpportunity(env.req()), e => {
      const d = e.details;
      assert.equal(d.status, 'INVALID'); assert.equal(d.color, 'red');
      assert.ok(d.issueCodes.some(i => i.path === 'financing.ltc' && i.code === 'FRACTION_AT_OR_ABOVE_ONE'));
      assert.ok(!/1\.8|equityIRR|MOIC/i.test(JSON.stringify(d)), 'no figures / metric names in the refusal');
      return true;
    });
  });
  await test('a red opportunity can still be REJECTED / put on HOLD / sent for REVISION (only approval is blocked), and the record says red', async () => {
    for (const decision of ['reject', 'hold', 'revise']) {
      const o = clone(ready); setPath(o, 'financing.ltc', 1.8); env.seed(o);
      const r = await fns.approveOpportunity(env.req({ decision: { decision } }));
      const rec = db.__get('icDecisions', r.decisionId);
      assert.equal(rec.decision.validation.color, 'red'); assert.equal(rec.decision.validation.status, 'INVALID');
      assert.equal(r.versionId, null);
    }
  });
  await test('LTC just under the soft limit (0.85) approves green; above it approves yellow; above 1 never approves', async () => {
    for (const [v, color] of [[0.85, 'green'], [0.86, 'yellow']]) {
      const o = clone(loose); setPath(o, 'financing.ltc', v); env.seed(o);
      const r = await fns.approveOpportunity(env.req());
      assert.equal(db.__get('icDecisions', r.decisionId).decision.validation.color, color, `ltc ${v}`);
    }
  });

  console.log('\n== L2-L4: stored document — boundary numbers, required fields, ceilings ==');
  const EDGE = [
    ['land.area', Number.EPSILON], ['land.area', Number.MIN_VALUE], ['land.area', 0.5], ['land.area', 0], ['land.area', -1], ['land.area', 1e9],
    ['land.price', 1e308], ['land.price', Number.MAX_VALUE], ['land.price', -1e-15], ['land.price', -1],
    ['land.far', 1e6], ['land.far', 0], ['development.salePrice', 1e9], ['development.buildCost', 1e9], ['development.buildCost', -3000],
    ['development.efficiency', 3.5], ['development.contingency', -0.05], ['development.constructionYears', 101], ['development.operationYears', 1e9],
    ['financing.saibor', 5], ['financing.margin', 5], ['financing.tenor', 1e9], ['financing.seniorPct', 1.5],
    ['strategy.salePct', 7], ['economics.carry', 1], ['exitCosts.rett', 2],
  ];
  for (const [p, v] of EDGE) {
    await test(`stored ${p} = ${String(v)} cannot be approved`, async () => {
      const o = clone(ready); setPath(o, p, v); env.seed(o);
      await refused(env.req({ override: true, reasons: ['accept'], warningsAcknowledged: true }), 'failed-precondition');
    });
  }
  for (const [p, v] of [['land.area', 1], ['land.price', 1e12], ['development.constructionYears', 100]]) {
    await test(`boundary value ${p} = ${String(v)} is accepted by the validation layer (not clamped, not refused as a boundary)`, async () => {
      const o = clone(ready); setPath(o, p, v);
      const verdict = (await recompute(o, Date.now())).verdict;
      assert.ok(!verdict.issueCodes.some(i => i.path === p && ['ABOVE_MAX', 'BELOW_MIN', 'NEGATIVE_NOT_ALLOWED'].includes(i.code)), `${p}`);
    });
  }
  await test('-0 is zero (no crash); 0.1+0.2 reaches the engine UNMODIFIED (inputs are never rounded)', async () => {
    const o = clone(ready); setPath(o, 'development.contingency', 0.1 + 0.2); setPath(o, 'land.price', 2000);
    const stored = clone(o); stored.development.contingency = 0.30000000000000004;
    const r = await recompute(stored, Date.now());
    assert.equal(JSON.parse(r.audit.inputJson).development.contingency, 0.30000000000000004);
    const z = clone(ready); z.financing.margin = -0; assert.equal(documentHash(z), documentHash(clone(ready).financing.margin === 0 ? Object.assign(clone(ready), { financing: Object.assign({}, ready.financing, { margin: 0 }) }) : z));
  });
  await test('numeric text in the six fields that silently change returns is refused (was a warning before 3A-3)', async () => {
    for (const [p, v] of [['development.constructionYears', '2'], ['development.operationYears', '1'], ['development.contingency', '0.05'], ['financing.saibor', '0.05'], ['financing.margin', '0.02'], ['financing.graceYears', '1']]) {
      const o = clone(ready); setPath(o, p, v); env.seed(o);
      // years fields are caught by the work-bound guard first (a string is not a horizon); the rest by the validation engine
      await refused(env.req({ override: true, reasons: ['x'] }), 'failed-precondition', ['INPUTS_BLOCKED', 'HORIZON_OUT_OF_BOUNDS']);
    }
  });
  await test('required inputs set to null / missing cannot slip through as "absent": approval is refused or needs the readiness override', async () => {
    for (const p of ['land.area', 'land.price', 'development.salePrice', 'land.far', 'development.buildCost']) {
      const o = clone(ready); setPath(o, p, null); env.seed(o);
      await refused(env.req(), 'failed-precondition');
    }
  });
  await test('structural attacks on the stored document: unsafe keys, depth 31, horizon overflow all fail closed with a code', async () => {
    const o = clone(ready); env.seed(o);
    Object.defineProperty(db.__get('opportunities', 'OPP'), '__proto__', { enumerable: true, value: { forged: true } });
    await refused(env.req(), 'failed-precondition', 'UNSAFE_KEY'); assert.equal({}.forged, undefined);
    const deep = clone(ready); let x = deep; for (let i = 0; i < 31; i++) { x.n = {}; x = x.n; } env.seed(deep);
    await refused(env.req(), 'failed-precondition', 'TOO_DEEP');
    const hz = clone(ready); setPath(hz, 'development.operationYears', 1e9); env.seed(hz);
    await refused(env.req({ override: true, reasons: ['x'] }), 'failed-precondition');
  });
  await test('a stored document over the snapshot limit is refused', async () => {
    const big = clone(ready); big.notes = 'x'.repeat(400000); env.seed(big);
    await refused(env.req(), 'failed-precondition', 'SNAPSHOT_TOO_LARGE');
  });

  console.log('\n== DSCR / IC-criteria tampering ==');
  const CRITERIA = [['criteria.dscrMin', -5], ['criteria.dscrMin', '1.2'], ['criteria.dscrMin', NaN], ['criteria.dscrMin', 1e9], ['criteria.irrMin', -2], ['criteria.irrMin', 'x'],
    ['criteria.moicMin', -1], ['criteria.preSaleActual', 5], ['criteria.preLeasingActual', 1e9], ['criteria.preSaleMin', 50]];
  for (const [p, v] of CRITERIA) {
    await test(`forged gate threshold ${p} = ${typeof v === 'number' ? String(v) : JSON.stringify(v)} cannot approve (a weakened gate is a blocked input)`, async () => {
      const o = clone(ready); setPath(o, p, v); env.seed(o);
      await refused(env.req({ override: true, reasons: ['x'], warningsAcknowledged: true }), 'failed-precondition');
    });
  }
  await test('a DSCR floor below 1x is only a warning: it is recorded yellow and never blocks', async () => {
    const o = clone(loose); setPath(o, 'criteria.dscrMin', 0.5); env.seed(o); // the readiness gate itself fails here (no debt service to measure); use the written override
    const r = await fns.approveOpportunity(env.req({ override: true, reasons: ['gate floor is deliberately low'] }));
    const rec = db.__get('icDecisions', r.decisionId);
    assert.equal(rec.decision.validation.color, 'yellow');
    assert.ok(rec.decision.validation.issueCodes.some(i => i.path === 'criteria.dscrMin' && i.code === 'UNUSUALLY_LOW'));
  });
  await test('debt-service shortfall years (a documented reference case) are reported as a high-risk reason, never silently dropped', async () => {
    const fx = require('../../tests/domain/financing-baseline.json').fixtures;
    const f04 = Object.entries(fx).find(([k]) => k.startsWith('F04'))[1];
    const stored = clone(f04.input || f04.d);
    const r = await recompute(stored, Date.now());
    assert.ok(r.verdict.highRiskCodes.some(h => h.code === 'DEBT_SHORTFALL'), 'F04 has a debt-service shortfall');
    assert.equal(r.verdict.color, 'yellow'); assert.equal(r.verdict.blocked, false);
  });

  // ---------------------------------------------------------------- compound warnings (decision 6, option B)
  console.log('\n== Compound financial risk: written acknowledgement (option B) ==');
  await test('a single high-risk reason approves without any acknowledgement (yellow)', async () => {
    for (const n of [1]) {
      env.seed(withFlags(n)); const r = await fns.approveOpportunity(env.req());
      const v = db.__get('icDecisions', r.decisionId).decision.validation;
      assert.equal(v.color, 'yellow'); assert.equal(v.compound.count, n); assert.equal(v.compound.requiresAcknowledgement, false);
    }
  });
  await test('2, 3 and 4 compound reasons: approval is refused with WARNINGS_ACK_REQUIRED until a written acknowledgement is sent', async () => {
    for (const n of [2, 3, 4]) {
      env.seed(withFlags(n));
      await refused(env.req(), 'failed-precondition', 'WARNINGS_ACK_REQUIRED');
      await refused(env.req({ warningsAcknowledged: false, reasons: ['I accept'] }), 'failed-precondition', 'WARNINGS_ACK_REQUIRED');
      await refused(env.req({ warningsAcknowledged: true }), 'failed-precondition', 'WARNINGS_ACK_REQUIRED'); // no written reason
      await refused(env.req({ warningsAcknowledged: true, reasons: ['   '] }), 'failed-precondition', 'WARNINGS_ACK_REQUIRED'); // blank reason
      await refused(env.req({ override: true, reasons: ['readiness override is NOT the acknowledgement'] }), 'failed-precondition', 'WARNINGS_ACK_REQUIRED');
    }
  });
  await test('acknowledged compound approval succeeds and the audit records the acknowledgement, the exact reasons and the hash', async () => {
    env.seed(withFlags(4));
    const r = await fns.approveOpportunity(env.req({ warningsAcknowledged: true, reasons: ['  Sponsor guarantee covers the leverage  '] }));
    const rec = db.__get('icDecisions', r.decisionId);
    assert.equal(rec.decision.warningsAcknowledged, true);
    assert.equal(rec.decision.validation.compound.count, 4);
    assert.deepEqual(rec.decision.validation.highRiskCodes.map(h => h.path).sort(), ['development.constructionYears', 'development.exitCapRate', 'financing.ltc', 'financing.saibor']);
    assert.deepEqual(rec.decision.reasons, ['Sponsor guarantee covers the leverage']);
    assert.equal(rec.decision.docHash, documentHash(withFlags(4)));
  });
  await test('the acknowledgement is not needed (and recorded false) when the threshold is not reached', async () => {
    env.seed(withFlags(1)); const r = await fns.approveOpportunity(env.req({ warningsAcknowledged: true, reasons: ['x'] }));
    assert.equal(db.__get('icDecisions', r.decisionId).decision.warningsAcknowledged, false);
  });
  await test('non-approving decisions never need the acknowledgement', async () => {
    env.seed(withFlags(4)); const r = await fns.approveOpportunity(env.req({ decision: { decision: 'hold' } }));
    assert.equal(r.ok, true);
  });
  await test('readiness override and warnings acknowledgement are independent: both gates must be satisfied when both apply', async () => {
    const o = withFlags(4); o.meta.city = ''; env.seed(o); // not ready AND compound
    await refused(env.req({ warningsAcknowledged: true, reasons: ['ack only'] }), 'failed-precondition');
    await refused(env.req({ override: true, reasons: ['override only'] }), 'failed-precondition', 'WARNINGS_ACK_REQUIRED');
    const r = await fns.approveOpportunity(env.req({ override: true, warningsAcknowledged: true, reasons: ['both'] }));
    const rec = db.__get('icDecisions', r.decisionId);
    assert.equal(rec.decision.overridden, true); assert.equal(rec.decision.warningsAcknowledged, true);
  });
  await test('a compound-risk opportunity that is ALSO red is refused as red (acknowledgement cannot rescue it)', async () => {
    const o = withFlags(4); setPath(o, 'land.area', 0); env.seed(o);
    await refused(env.req({ warningsAcknowledged: true, override: true, reasons: ['x'] }), 'failed-precondition', 'INPUTS_BLOCKED');
  });

  // ---------------------------------------------------------------- docHash binding
  console.log('\n== Approval bound to the reviewed document (docHash) ==');
  const CHANGES = {
    'a condition-like free-text note': o => { o.notes = 'edited after review'; },
    'the thesis': o => { o.thesis = 'a different thesis'; },
    'a due-diligence status': o => { const k = Object.keys(o.dd.items)[0]; o.dd.items[k].status = 'pending'; },
    'an evidence note': o => { const k = Object.keys(o.evidence)[0]; o.evidence[k].source = 'changed'; },
    'meta.updatedAt': o => { o.meta.updatedAt = '2030-01-01'; },
    'a financial input': o => { o.land.price = 2001; },
    'an unrelated extra field': o => { o.extra = { a: 1 }; },
    'an appended IC decision': o => { o.ic = { decisions: [{ decision: 'hold' }] }; },
    'a nested array element': o => { o.tags = ['a', 'b']; },
  };
  for (const [name, mut] of Object.entries(CHANGES)) {
    await test(`a change to ${name} after review invalidates the approval (DOC_CHANGED), nothing written`, async () => {
      env.seed(clone(ready)); const stale = env.hash();
      const doc = db.__get('opportunities', 'OPP'); mut(doc);
      assert.notEqual(documentHash(doc), stale);
      await refused(env.req({ expectedDocHash: stale }), 'failed-precondition', 'DOC_CHANGED');
    });
  }
  await test('the hash reflects an edit made between the preview and the transaction (race on the server side)', async () => {
    env.seed(clone(ready)); const reviewed = env.hash(); const original = db.runTransaction;
    db.runTransaction = async cb => { db.__get('opportunities', 'OPP').notes = 'edited while approving'; return original.call(db, cb); };
    const counts = env.counts();
    try { await assert.rejects(fns.approveOpportunity(env.req({ expectedDocHash: reviewed })), e => e.code === 'failed-precondition' && e.details.rejectionCode === 'DOC_CHANGED'); }
    finally { db.runTransaction = original; }
    assert.deepEqual(env.counts(), counts, 'nothing written');
  });
  await test('a replayed request still returns the ORIGINAL result even though the document legitimately changed (idempotency wins)', async () => {
    env.seed(clone(ready)); const request = env.req(); const first = await fns.approveOpportunity(request);
    const doc = db.__get('opportunities', 'OPP'); doc.notes = 'edited later';
    assert.deepEqual(await fns.approveOpportunity(request), first);
    assert.equal(Object.keys(db.__all('icDecisions')).length, 1);
  });
  await test('reusing a requestId with a different expectedDocHash or warningsAcknowledged is rejected as a different payload', async () => {
    env.seed(clone(ready)); const first = env.req({ requestId: 'R-fixed' }); await fns.approveOpportunity(first);
    await assert.rejects(fns.approveOpportunity(env.req({ requestId: 'R-fixed', expectedDocHash: 'f'.repeat(64) })), e => e.code === 'already-exists');
    await assert.rejects(fns.approveOpportunity({ auth: first.auth, data: Object.assign({}, first.data, { warningsAcknowledged: true }) }), e => e.code === 'already-exists');
  });
  await test('canonical hash: key order does not matter; value, type, array order and nesting do', async () => {
    const a = { x: 1, y: { p: [1, 2], q: 'z' } };
    assert.equal(documentHash(a), documentHash({ y: { q: 'z', p: [1, 2] }, x: 1 }));
    for (const b of [{ x: 2, y: a.y }, { x: '1', y: a.y }, { x: 1, y: { p: [2, 1], q: 'z' } }, { x: 1, y: { p: [1, 2], q: 'Z' } }, { x: 1, y: { p: [1, 2] } }, { x: 1, y: { p: [1, 2], q: 'z' }, w: null }]) {
      assert.notEqual(documentHash(a), documentHash(b), JSON.stringify(b));
    }
    assert.equal(documentHash({ n: -0 }), documentHash({ n: 0 }));
    assert.notEqual(documentHash({ n: NaN }), documentHash({ n: null }));
    assert.notEqual(documentHash({ n: Infinity }), documentHash({ n: -Infinity }));
    assert.notEqual(documentHash({ d: new Date(0) }), documentHash({ d: new Date(1) }));
    class Timestamp { constructor(s, n) { this.seconds = s; this.nanoseconds = n; } toMillis() { return this.seconds * 1000; } }   // like the SDK class
    const ts = (s, n) => new Timestamp(s, n);
    assert.equal(documentHash({ t: ts(5, 7) }), documentHash({ t: ts(5, 7) })); assert.notEqual(documentHash({ t: ts(5, 7) }), documentHash({ t: ts(5, 8) }));
    // a plain object carrying a function is not data: it is refused instead of being guessed at
    assert.throws(() => documentHash({ t: { seconds: 5, nanoseconds: 7, toMillis: () => 5000 } }), e => e.rejectionCode === 'UNSUPPORTED_TYPE');
  });
  await test('canonical hashing rejects cyclic documents and does not blow up on hostile ones', async () => {
    const c = { a: 1 }; c.self = c;
    assert.throws(() => canonicalDocValue(c), e => e.rejectionCode === 'CYCLIC_DOCUMENT');
    assert.doesNotThrow(() => documentHash(JSON.parse('{"__proto__":{"x":1},"constructor":{"y":2}}')));
  });
  await test('VOLATILE_DOC_FIELDS is empty (no server-managed field is written to opportunities today) and the exclusion mechanism works when used', async () => {
    assert.deepEqual([...VOLATILE_DOC_FIELDS], []);
    const a = { meta: { updatedAt: '2026-01-01', city: 'R' }, v: 1 }; const b = { meta: { updatedAt: '2030-01-01', city: 'R' }, v: 1 };
    assert.notEqual(documentHash(a), documentHash(b));
    assert.equal(documentHash(a, ['meta.updatedAt']), documentHash(b, ['meta.updatedAt']));
    assert.notEqual(documentHash(a, ['meta.updatedAt']), documentHash({ meta: { updatedAt: '2030-01-01', city: 'X' }, v: 1 }, ['meta.updatedAt']));
  });

  // ---------------------------------------------------------------- type-ambiguity fix: effect on old previews / requests
  console.log('\n== document fingerprint: unambiguous encoding and compatibility ==');
  const { legacyDocumentHash } = require('./helpers/legacy-canonical.cjs');
  await test('look-alike values have different fingerprints, also when volatile paths are excluded (no JSON round trip)', async () => {
    assert.notEqual(documentHash({ notes: NaN }), documentHash({ notes: { $number: 'NaN' } }));
    assert.notEqual(documentHash({ notes: NaN, m: { u: 1 } }, ['m.u']), documentHash({ notes: { $number: 'NaN' }, m: { u: 2 } }, ['m.u']));
    assert.equal(documentHash({ a: 1, m: { u: 1 } }, ['m.u']), documentHash({ a: 1, m: { u: 2 } }, ['m.u']));
    assert.notEqual(documentHash({ m: { path: 'x', id: 'y1', firestore: true } }), documentHash({ m: { path: 'x', id: 'y2', firestore: true } }));
  });
  await test('an ordinary stored opportunity keeps EXACTLY the fingerprint it had before the fix (old previews and pending requests stay valid)', async () => {
    env.seed(clone(ready));
    const stored = db.__get('opportunities', 'OPP');
    assert.equal(documentHash(stored), legacyDocumentHash(stored));
    const p = await fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP' } });
    assert.equal(p.docHash, legacyDocumentHash(stored), 'a preview taken under the old format still equals what the server hashes now');
  });
  await test('a document whose fingerprint DID change: an old preview/hash is refused safely (DOC_CHANGED, nothing written); a request that already succeeded still replays its original result', async () => {
    const o = clone(ready); o.meta.extra = { $number: 'NaN' }; env.seed(o);   // a plain "$number" key: the one ambiguous shape
    const stored = db.__get('opportunities', 'OPP');
    const oldHash = legacyDocumentHash(stored), newHash = documentHash(stored);
    assert.notEqual(oldHash, newHash);
    // (1) a client still holding the OLD fingerprint (taken before the fix) cannot approve with it
    await refused(env.req({ expectedDocHash: oldHash, requestId: 'R-old-preview' }), 'failed-precondition', 'DOC_CHANGED');
    // (2) a request that SUCCEEDED earlier with the old fingerprint is stored with that fingerprint; replaying it returns the original result
    const seeded = { ok: true, decisionId: 'D-before-change', versionId: 'V-before-change' };
    const payload = { email: EMAIL, oppId: 'OPP', decisionType: 'approve', reasons: ['approved before the format change'], conditions: [], override: false, warningsAcknowledged: false, expectedDocHash: oldHash };
    db.__seed('icDecisionRequests', 'R-succeeded-before', { payload, result: seeded });
    const counts = env.counts();
    const replay = await fns.approveOpportunity({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP', decision: { decision: 'approve' }, reasons: ['approved before the format change'], requestId: 'R-succeeded-before', expectedDocHash: oldHash } });
    assert.deepEqual(replay, seeded, 'idempotent replay returns the stored result without re-checking the fingerprint');
    assert.deepEqual(env.counts(), counts, 'the replay wrote nothing');
    // (3) the same requestId with a different fingerprint is a different payload, not a replay
    await assert.rejects(fns.approveOpportunity({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP', decision: { decision: 'approve' }, reasons: ['approved before the format change'], requestId: 'R-succeeded-before', expectedDocHash: newHash } }), e => e.code === 'already-exists');
    // (4) a fresh preview (new format) works with a new requestId
    const p = await fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP' } });
    assert.equal(p.docHash, newHash);
    assert.equal((await fns.approveOpportunity(env.req({ expectedDocHash: p.docHash, requestId: 'R-fresh-new-format' }))).ok, true);
  });

  // ---------------------------------------------------------------- getApprovalPreview
  console.log('\n== getApprovalPreview ==');
  await test('the preview returns the server hash and verdict; approving with it succeeds', async () => {
    env.seed(clone(ready));
    const p = await fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP' } });
    assert.equal(p.docHash, env.hash()); assert.equal(p.verdict.color, 'green'); assert.equal(p.ready, true);
    assert.ok(/^[0-9a-f]{64}$/.test(p.docHash) && /^[0-9a-f]{64}$/.test(p.inputHash));
    const r = await fns.approveOpportunity(env.req({ expectedDocHash: p.docHash })); assert.equal(r.ok, true);
  });
  await test('the preview of a red opportunity says red and lists codes only', async () => {
    const o = clone(ready); setPath(o, 'financing.ltc', 1.8); env.seed(o);
    const p = await fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP' } });
    assert.equal(p.verdict.color, 'red'); assert.equal(p.verdict.blocked, true);
    assert.ok(!/1\.8/.test(JSON.stringify(p.verdict)));
  });
  await test('the preview of a compound-risk opportunity announces that an acknowledgement is required', async () => {
    env.seed(withFlags(3));
    const p = await fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP' } });
    assert.equal(p.verdict.compound.requiresAcknowledgement, true); assert.equal(p.verdict.color, 'yellow');
  });
  await test('the preview is role-gated, strict about its input, and reveals nothing for a missing opportunity', async () => {
    env.seed(clone(ready));
    db.__seed('team_roles', EMAIL, { role: 'analyst' });
    await assert.rejects(fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP' } }), e => e.code === 'permission-denied');
    db.__seed('team_roles', EMAIL, { role: 'senior_ic' });
    await assert.rejects(fns.getApprovalPreview({ data: { oppId: 'OPP' } }), e => e.code === 'unauthenticated');
    await assert.rejects(fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP', extra: 1 } }), e => e.code === 'invalid-argument');
    await assert.rejects(fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'a/b' } }), e => e.code === 'invalid-argument');
    await assert.rejects(fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'NOPE' } }), e => e.code === 'not-found');
    await assert.rejects(fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: null }), e => e.code === 'invalid-argument');
  });
  await test('displayedDocHash: displayedMatches is null without it, true for the same stored document, false for any other (even a green one or a note-only change); malformed values are refused', async () => {
    env.seed(clone(ready));
    const pv = (data) => fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP', ...data } });
    const base = await pv({}); assert.equal(base.displayedMatches, null);
    assert.equal((await pv({ displayedDocHash: base.docHash })).displayedMatches, true);
    const other = clone(ready); setPath(other, 'development.salePrice', 9500);
    const m = await pv({ displayedDocHash: documentHash(other) });
    assert.equal(m.displayedMatches, false); assert.equal(m.verdict.color, 'green'); assert.equal(m.docHash, base.docHash);
    const noted = clone(ready); setPath(noted, 'meta.notes', 'only a note');
    assert.equal((await pv({ displayedDocHash: documentHash(noted) })).displayedMatches, false);
    for (const bad of ['', 'abc', 'A'.repeat(64), base.docHash.slice(1), base.docHash + '0', 123, null, {}, [base.docHash]]) {
      await assert.rejects(pv({ displayedDocHash: bad }), e => e.code === 'invalid-argument', 'rejects ' + JSON.stringify(bad));
    }
  });
  await test('the preview writes nothing', async () => {
    env.seed(clone(ready)); const before = JSON.stringify(db.store);
    await fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP' } });
    assert.equal(JSON.stringify(db.store), before);
  });

  // ---------------------------------------------------------------- audit trail
  console.log('\n== Audit trail ==');
  await test('every recorded decision carries status, colour, codes, compound count, docHash, inputHash and engine version — no figures', async () => {
    env.seed(withFlags(1)); const r = await fns.approveOpportunity(env.req());
    const rec = db.__get('icDecisions', r.decisionId); const d = rec.decision;
    assert.deepEqual(Object.keys(d.validation).sort(), ['blocked', 'color', 'compound', 'highRisk', 'highRiskCodes', 'issueCodes', 'status']);
    assert.equal(d.engineVersion, rec.evaluation.engineVersion); assert.equal(d.inputHash, rec.evaluation.inputHash); assert.equal(rec.evaluation.docHash, d.docHash);
    assert.ok(!/ratio|×|IRR/.test(JSON.stringify(d.validation)), 'the verdict carries codes, not figures');
    assert.deepEqual(db.__get('opportunities', 'OPP').ic.decisions.at(-1), d, 'the mirror on the opportunity is the same record');
  });

  // ---------------------------------------------------------------- structured rejection log
  console.log('\n== Structured rejection log (codes only) ==');
  async function captureWarnings(fn) {
    const lines = []; const orig = console.warn; console.warn = (...a) => lines.push(a.join(' '));
    try { await fn(); } finally { console.warn = orig; }
    return lines.filter(l => l.startsWith('{')).map(l => JSON.parse(l));
  }
  await test('a refused approval writes ONE structured line with codes only — no figures, reasons, email or hash', async () => {
    const o = clone(ready); setPath(o, 'land.price', 123456789); setPath(o, 'financing.ltc', 1.8); env.seed(o);
    const SECRET = 'SECRET-REASON-TEXT';
    const logs = await captureWarnings(() => refused(env.req({ reasons: [SECRET] }), 'failed-precondition', 'INPUTS_BLOCKED'));
    assert.equal(logs.length, 1);
    const l = logs[0];
    assert.deepEqual(Object.keys(l).sort(), ['code', 'decision', 'event', 'fn', 'oppId', 'rejectionCode', 'verdictColor', 'verdictStatus']);
    assert.equal(l.event, 'IC_APPROVAL_REJECTED'); assert.equal(l.fn, 'approveOpportunity'); assert.equal(l.rejectionCode, 'INPUTS_BLOCKED');
    assert.equal(l.verdictColor, 'red'); assert.equal(l.decision, 'approve'); assert.equal(l.oppId, 'OPP');
    const raw = JSON.stringify(l);
    for (const forbidden of ['123456789', '1.8', SECRET, EMAIL, '@']) assert.ok(!raw.includes(forbidden), `the log line must not contain ${forbidden}`);
  });
  await test('the log carries the rejection code for DOC_CHANGED, UNEXPECTED_FIELD and WARNINGS_ACK_REQUIRED', async () => {
    env.seed(clone(ready));
    let logs = await captureWarnings(() => refused(env.req({ expectedDocHash: 'f'.repeat(64) }), 'failed-precondition', 'DOC_CHANGED'));
    assert.deepEqual(logs.map(l => l.rejectionCode), ['DOC_CHANGED']);
    logs = await captureWarnings(() => refused(env.req({ color: 'green' }), 'invalid-argument', 'UNEXPECTED_FIELD'));
    assert.deepEqual(logs.map(l => l.rejectionCode), ['UNEXPECTED_FIELD']);
    env.seed(withFlags(2));
    logs = await captureWarnings(() => refused(env.req(), 'failed-precondition', 'WARNINGS_ACK_REQUIRED'));
    assert.deepEqual(logs.map(l => l.rejectionCode), ['WARNINGS_ACK_REQUIRED']);
  });
  await test('a successful approval and a successful preview log nothing', async () => {
    env.seed(clone(ready));
    const logs = await captureWarnings(async () => { await fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP' } }); await fns.approveOpportunity(env.req()); });
    assert.deepEqual(logs, []);
  });
  await test('a refused preview is logged too (fn = getApprovalPreview)', async () => {
    env.seed(clone(ready));
    const logs = await captureWarnings(async () => { await assert.rejects(fns.getApprovalPreview({ auth: { token: { email: EMAIL } }, data: { oppId: 'OPP', extra: 1 } })); });
    assert.equal(logs.length, 1); assert.equal(logs[0].fn, 'getApprovalPreview'); assert.equal(logs[0].rejectionCode, 'UNEXPECTED_FIELD');
  });

  console.log(`\n${passed}/${passed} server-side validation enforcement tests passed (fakes; concurrency is covered by the emulator test).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
