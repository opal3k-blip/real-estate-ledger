'use strict';
// Callable logic and transaction callback contract. Fakes do not prove Rules or isolation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { loadIndexWithFakes } = require('./load-index-with-fakes');
const { recompute, loadEngine } = require('../trusted-ic.cjs');
const { fns, db } = loadIndexWithFakes();
const EMAIL = 'ic@example.com';
const clone = x => JSON.parse(JSON.stringify(x));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`OK ${name}`); }
function seed(o) {
  db.__reset();
  db.__seed('team_members', EMAIL, { expiresAt: null });
  db.__seed('team_roles', EMAIL, { role: 'senior_ic' });
  db.__seed('opportunities', 'OPP', clone(o));
}
function req(data = {}) {
  return { auth: { token: { email: EMAIL } }, data: { oppId: 'OPP', decision: { decision: 'approve' }, ...data } };
}
async function denied(request, code = 'failed-precondition') {
  const before = JSON.stringify(db.__get('opportunities', 'OPP'));
  await assert.rejects(fns.approveOpportunity(request), e => e.code === code);
  assert.equal(Object.keys(db.__all('icDecisions')).length, 0);
  assert.equal(JSON.stringify(db.__get('opportunities', 'OPP')), before, 'rejection must not mutate the opportunity');
}
async function readyFixture() {
  const engine = await loadEngine();
  const o = engine.withDefaults({});
  Object.assign(o.meta, { name: 'Ready Development', city: 'Riyadh', neighborhood: 'Test', analyst: 'Analyst', oppType: 'development', tier: 'متوسط', useType: '__neutral__' });
  for (const k of ['soil', 'water', 'tower', 'topo', 'infra']) o.site[k] = 1;
  Object.assign(o.land, { area: 5000, price: 2000, far: 2, bar: 0.5, setbacks: 0.15, floorsAllowed: 10, floorHeight: 3.6 });
  Object.assign(o.development, { salePrice: 9000, buildCost: 3000, efficiency: 0.85, contingency: 0.05, constructionYears: 2, operationYears: 1, scopeType: 'both', exitCapRate: 0.08 });
  o.strategy.salePct = 1;
  Object.assign(o.financing, { ltc: 0.5, saibor: 0.05, margin: 0.02 });
  o.regulatory.offeringType = 'private';
  Object.assign(o.criteria, { irrMin: 0.05, projIrrMin: -1, moicMin: 0, dscrMin: null });
  const { defaultItemsDict } = await import('../generated/src/domain/due-diligence/dd-engine.js');
  o.dd = { items: defaultItemsDict() };
  Object.values(o.dd.items).forEach(it => { it.status = 'completed'; it.severity = 'medium'; });
  const { KEY_FIELDS } = await import('../generated/src/domain/evidence/evidence-engine.js');
  o.evidence = {};
  for (const f of KEY_FIELDS.filter(f => !f.appliesTo || f.appliesTo === 'development')) {
    o.evidence[f.path] = { source: 'test-source', tier: 'tier1', confidence: 'high', verifiedBy: EMAIL, date: '2099-01-01' };
  }
  return o;
}

(async () => {
  const ready = await readyFixture();
  const unready = clone(ready); unready.meta.city = '';
  await test('complete saved opportunity approves without client readiness; audit binds input and engine', async () => {
    seed(ready);
    const response = await fns.approveOpportunity(req({ decision: { decision: 'approve', decidedBy: 'attacker', decidedAt: 'forged', inputHash: 'forged', arbitrary: true },
      readiness: { ready: false }, override: true, metrics: { equityIRR: 999 } }));
    const audit = db.__get('icDecisions', response.decisionId);
    const mirror = db.__get('opportunities', 'OPP').ic.decisions.at(-1);
    assert.equal(audit.version, 2); assert.equal(audit.readiness.ready, true);
    assert.equal(audit.decision.decidedBy, EMAIL); assert.equal(audit.decision.arbitrary, undefined);
    assert.equal(audit.decision.overridden, false); assert.equal(audit.decision.decidedAt, audit.evaluation.evaluatedAt);
    assert.deepEqual(audit.decision, mirror);
    assert.equal(audit.evaluation.inputHash, crypto.createHash('sha256').update(audit.evaluation.inputJson).digest('hex'));
    assert.equal(audit.evaluation.engineVersion, (await loadEngine()).engineVersion);
    const input = JSON.parse(audit.evaluation.inputJson);
    assert.equal(input.ic, undefined); assert.equal(input.land.price, ready.land.price);
    assert.notEqual(audit.evaluation.metrics.equityIRR, 999);
    const replay = await recompute(input, Date.parse(audit.evaluation.evaluatedAt));
    assert.deepEqual(clone(replay.audit.readiness), audit.readiness);
  });
  await test('fabricated ready with empty gates cannot approve incomplete stored inputs', async () => {
    seed(unready); await denied(req({ readiness: { ready: true, gates: {} } }));
  });
  for (const override of [false, undefined, 'true']) await test(`override must be explicit boolean (${String(override)})`, async () => {
    seed(unready); await denied(req({ override, reasons: ['Justification'] }));
  });
  for (const reasons of [[], ['   '], ['\n\t']]) await test(`blank justification rejected ${JSON.stringify(reasons)}`, async () => {
    seed(unready); await denied(req({ override: true, reasons }));
  });
  for (const reasons of [[{}], [42], 'Justification']) await test(`non-text reason rejected ${JSON.stringify(reasons)}`, async () => {
    seed(unready); await denied(req({ override: true, reasons }), 'invalid-argument');
  });
  await test('justified override records actual failed gates and bilingual reasons', async () => {
    seed(unready);
    const result = await fns.approveOpportunity(req({ override: true, reasons: ['  City evidence pending  '], decision: { decision: 'approve_conditions', gateReasonsAtDecision: ['forged'] },
      conditions: [{ text: '  Confirm city  ', status: 'met', arbitrary: 'forged' }] }));
    const record = db.__get('icDecisions', result.decisionId);
    assert.equal(record.readiness.ready, false); assert.equal(record.decision.overridden, true);
    assert.deepEqual(record.decision.reasons, ['City evidence pending']);
    assert.ok(record.readiness.reasons.some(r => r.code === 'DQ_CRITICAL_MISSING'));
    assert.ok(record.decision.gateReasonsAtDecision.every(r => typeof r.ar === 'string' && typeof r.en === 'string'));
    assert.deepEqual(record.decision.conditions, [{ text: 'Confirm city', status: 'pending', owner: '', dueDate: '' }]);
  });
  await test('override cannot approve undefined financial return', async () => {
    seed({}); await denied(req({ override: true, reasons: ['Accept risk'] }));
  });
  for (const decision of ['reject', 'hold', 'revise']) await test(`non-approval ${decision} records actual readiness`, async () => {
    seed(unready);
    const result = await fns.approveOpportunity(req({ decision: { decision }, override: true }));
    const record = db.__get('icDecisions', result.decisionId);
    assert.equal(record.readiness.ready, false); assert.equal(record.decision.overridden, false);
  });
  await test('unknown decision rejected', async () => { seed(ready); await denied(req({ decision: { decision: 'approved' } }), 'invalid-argument'); });
  await test('missing document rejected', async () => { seed(ready); await denied(req({ oppId: 'MISSING' }), 'not-found'); });
  await test('unauthenticated request rejected', async () => { seed(ready); await denied({ data: req().data }, 'unauthenticated'); });
  await test('analyst cannot decide', async () => { seed(ready); db.__seed('team_roles', EMAIL, { role: 'analyst' }); await denied(req(), 'permission-denied'); });
  await test('expired IC member cannot decide', async () => {
    seed(ready); db.__seed('team_members', EMAIL, { expiresAt: { toMillis: () => 1 } }); await denied(req(), 'permission-denied');
  });
  await test('stored horizon bounds fail before computation and no override bypass', async () => {
    const o = clone(ready); o.strategy.offPlanSale.escrowLagYears = 1e9;
    seed(o); await denied(req({ override: true, reasons: ['Accept'] }));
  });
  await test('non-finite saved input fails closed', async () => {
    seed(ready); db.__get('opportunities', 'OPP').land.price = Infinity;
    await denied(req({ override: true, reasons: ['Accept'] }));
  });
  await test('unsafe object keys fail closed', async () => {
    seed(ready); Object.defineProperty(db.__get('opportunities', 'OPP'), '__proto__', { enumerable: true, value: { forged: true } });
    await denied(req()); assert.equal({}.forged, undefined);
  });
  await test('retry callback recomputes the newly read document and leaves no stale decision', async () => {
    seed(ready); const original = db.runTransaction;
    let reads = 0;
    db.runTransaction = async callback => {
      // Dry-run the first attempt; Firestore discards writes before a retry.
      await callback({ get: async ref => { reads++; return ref.get(); }, set() {}, update() {} });
      db.__seed('opportunities', 'OPP', clone(unready));
      return original.call(db, callback);
    };
    try { await assert.rejects(fns.approveOpportunity(req()), e => e.code === 'failed-precondition'); }
    finally { db.runTransaction = original; }
    assert.equal(reads, 1); assert.equal(Object.keys(db.__all('icDecisions')).length, 0);
    assert.equal(db.__get('opportunities', 'OPP').ic, undefined);
  });
  await test('engine package runs without src outside functions; tampering is rejected', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opal-ic-'));
    try {
      fs.cpSync(path.join(__dirname, '../generated'), path.join(tmp, 'generated'), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '../trusted-ic.cjs'), path.join(tmp, 'trusted-ic.cjs'));
      const run = "require('./trusted-ic.cjs').loadEngine().then(e=>console.log(e.compute(e.withDefaults({})).totalYears)).catch(e=>{console.error(e.message);process.exit(1)})";
      execFileSync(process.execPath, ['-e', run], { cwd: tmp, stdio: 'pipe' });
      fs.appendFileSync(path.join(tmp, 'generated/src/domain/financial/financial-engine.js'), '\n// unexpected drift\n');
      assert.throws(() => execFileSync(process.execPath, ['-e', run], { cwd: tmp, stdio: 'pipe' }));
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  console.log(`\n${passed}/${passed} trusted IC tests passed (fakes; not a Rules/concurrency certification).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
