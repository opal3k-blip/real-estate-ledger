// R1-B2 / B2-4a — suspend / reinstate: an INDEPENDENT hand-written table compared BY EXECUTION with
//   (A) the REAL server service over an in-memory Firestore stand-in  ("الخدمة الحقيقية فوق مخزن Firestore مزيّف")
//   (B) the client model (availableActions with requireHeadValuation, buildPayload, PAYLOAD_SPEC, ACTION_ROLES, SERVER_BINDING)
//   (C) the fake server ("خادم مزيّف") used by the orchestrator tests
// NOT the Firebase emulator: no real transaction isolation, no security rules. Results are never attributed to it, to CI or to a deployed server.
// Run: node tests/features/fund-valuation-eligibility-contract.test.mjs
import assert from 'node:assert/strict';
import { freshRig, EMAIL, FUND, DAY, NEXT_DAY_TIME, classify } from '../helpers/fund-valuation-contract-driver-real.mjs';
import { rid, realContent, SERVER_ROLE_LISTS, SERVER_ALLOWED_KEYS } from '../helpers/fund-valuation-real-service-rig.mjs';
import { makeServer } from '../helpers/fund-valuation-server-fake.mjs';
import { FAKE_EMAIL } from '../helpers/fund-valuation-contract-driver-fake.mjs';
import { availableActions, buildPayload, PAYLOAD_SPEC, ACTION_ROLES, SERVER_BINDING, CALLABLES, riyadhDay } from '../../src/features/fund-valuation-model.js';
import { ROLE_OF } from '../helpers/fund-valuation-contract-expectations.mjs';

let passed = 0;
async function t(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }

/* ---- the table (hand-written literals; imports nothing from src/features except for the comparison itself) ----
   head: 'effective' | 'suspended-by-ic1' | 'suspended-by-ic2' | 'none';  headContributors: who contributed to the head valuation besides the preparer;
   stale: the request names another head id;  actor labels as in the B2-3 table (ic1 APPROVED the head valuation, prep prepared it). */
const SUSP = 'سبب تعليق صالح'; const longReason = (n) => 'ر'.repeat(n);
const r = (id, action, actor, o = {}) => Object.freeze({ id, action, actor, head: 'effective', headContributors: [], day: 'today', stale: false, reason: SUSP, expect: 'OK', ...o });
const ROWS = Object.freeze([
  r('S01', 'suspend', 'ic1'), r('S02', 'suspend', 'ic2'), r('S03', 'suspend', 'admin'),
  r('S04', 'suspend', 'prep2', { expect: 'ROLE_NOT_ALLOWED' }), r('S05', 'suspend', 'analyst', { expect: 'ROLE_NOT_ALLOWED' }), r('S06', 'suspend', 'stranger', { expect: 'code:permission-denied' }),
  r('S07', 'suspend', 'ic1', { head: 'suspended-by-ic2', expect: 'ALREADY_SUSPENDED' }), r('S08', 'suspend', 'ic1', { head: 'suspended-by-ic1', expect: 'ALREADY_SUSPENDED' }),
  r('S09', 'suspend', 'ic1', { head: 'none', expect: 'NO_HEAD' }), r('S10', 'suspend', 'ic1', { stale: true, expect: 'STALE_HEAD' }),
  r('S11', 'suspend', 'ic1', { head: 'suspended-by-ic2', stale: true, expect: 'STALE_HEAD' }),                         // order: STALE_HEAD before ALREADY_SUSPENDED
  r('S12', 'suspend', 'ic1', { reason: '', expect: 'REASON_REQUIRED' }), r('S13', 'suspend', 'ic1', { reason: '   ', expect: 'REASON_REQUIRED' }), r('S14', 'suspend', 'ic1', { reason: undefined, expect: 'REASON_REQUIRED' }),
  r('S15', 'suspend', 'ic1', { reason: longReason(1000) }), r('S16', 'suspend', 'ic1', { reason: longReason(1001), expect: 'REASON_REQUIRED' }),
  r('S17', 'suspend', 'ic1', { day: 'crossed' }),                                                                          // NOT day-checked
  r('S18', 'suspend', 'ic1', { headContributors: ['hybrid'] }),                                                            // contributors do not matter for suspend
  r('N01', 'reinstate', 'ic2', { head: 'suspended-by-ic1' }), r('N02', 'reinstate', 'admin', { head: 'suspended-by-ic1' }),
  r('N03', 'reinstate', 'ic1', { head: 'suspended-by-ic1', expect: 'SUSPENDER_CANNOT_RESTORE' }),
  r('N04', 'reinstate', 'ic2', { head: 'suspended-by-ic2', expect: 'SUSPENDER_CANNOT_RESTORE' }),
  r('N05', 'reinstate', 'ic1', { head: 'suspended-by-ic2', expect: 'CONTRIBUTOR_CANNOT_REINSTATE' }),                       // ic1 APPROVED the head valuation
  r('N06', 'reinstate', 'hybrid', { head: 'suspended-by-ic1', headContributors: ['hybrid'], expect: 'CONTRIBUTOR_CANNOT_REINSTATE' }),
  r('N07', 'reinstate', 'ic2', { head: 'effective', expect: 'NOT_SUSPENDED' }), r('N08', 'reinstate', 'ic1', { head: 'effective', expect: 'NOT_SUSPENDED' }),  // order: NOT_SUSPENDED before the separation checks
  r('N09', 'reinstate', 'prep2', { head: 'suspended-by-ic1', expect: 'ROLE_NOT_ALLOWED' }), r('N10', 'reinstate', 'analyst', { head: 'suspended-by-ic1', expect: 'ROLE_NOT_ALLOWED' }),
  r('N11', 'reinstate', 'ic2', { head: 'none', expect: 'NO_HEAD' }), r('N12', 'reinstate', 'ic2', { head: 'suspended-by-ic1', stale: true, expect: 'STALE_HEAD' }),
  r('N13', 'reinstate', 'ic2', { head: 'suspended-by-ic1', reason: '', expect: 'REASON_REQUIRED' }), r('N14', 'reinstate', 'ic2', { head: 'suspended-by-ic1', reason: longReason(1001), expect: 'REASON_REQUIRED' }),
  r('N15', 'reinstate', 'ic2', { head: 'suspended-by-ic1', day: 'crossed' }),                                              // NOT day-checked
  r('N16', 'reinstate', 'ic2', { head: 'suspended-by-ic1', reason: longReason(1000) }),
]);
const PAYLOAD_KEYS = { suspend: ['requestId', 'fundId', 'valuationDate', 'expectedHeadId', 'reason'], reinstate: ['requestId', 'fundId', 'valuationDate', 'expectedHeadId', 'reason'] };
const ROLES = { suspend: ['senior_ic', 'admin'], reinstate: ['senior_ic', 'admin'] };

const must = (res, what) => { if (!res.ok) throw new Error(`setup ${what} failed: ${res.reason || res.code} ${res.message}`); return res.data; };
async function buildRealHead(row) {
  const R = freshRig(); let headId = null;
  if (row.head !== 'none') {
    const v0 = must(await R.call('createDraft', EMAIL.prep, { requestId: rid(), fundId: FUND, valuationDate: DAY, content: realContent() }), 'create');
    let hash = v0.contentHash;
    if (row.headContributors.includes('hybrid')) { R.setRole(EMAIL.hybrid, 'fund_manager'); hash = must(await R.call('updateDraft', EMAIL.hybrid, { requestId: rid(), valuationId: v0.valuationId, expectedContentHash: hash, content: realContent({ methodNote: 'مساهمة' }) }), 'hybrid').contentHash; R.setRole(EMAIL.hybrid, 'senior_ic'); }
    hash = must(await R.call('submit', EMAIL.prep, { requestId: rid(), valuationId: v0.valuationId }), 'submit').contentHash;
    must(await R.call('review', EMAIL.ic2, { requestId: rid(), valuationId: v0.valuationId, expectedContentHash: hash }), 'review');
    must(await R.call('approve', EMAIL.ic1, { requestId: rid(), valuationId: v0.valuationId, expectedContentHash: hash }), 'approve');   // ic1 APPROVES
    headId = v0.valuationId;
    const m = /^suspended-by-(ic1|ic2)$/.exec(row.head);
    if (m) must(await R.call('suspend', EMAIL[m[1]], { requestId: rid(), fundId: FUND, valuationDate: DAY, expectedHeadId: headId, reason: 'تعليق للاختبار' }), 'suspend');
    R.setTime('2026-10-11T10:30:00Z');
  }
  return { R, headId };
}
const payloadOf = (row, headId) => { const p = { requestId: rid(), fundId: FUND, valuationDate: DAY, expectedHeadId: row.stale ? 'NOT-THE-HEAD' : (headId || 'H-none') }; if (row.reason !== undefined) p.reason = row.reason; return p; };
async function runReal(row) {
  const { R, headId } = await buildRealHead(row);
  if (row.day === 'crossed') R.setTime(NEXT_DAY_TIME);
  const before = JSON.stringify(R.db.data); const payload = payloadOf(row, headId);
  const res = await R.call(row.action, EMAIL[row.actor], payload);
  return { R, headId, res, got: classify(res), before, after: JSON.stringify(R.db.data), payload };
}
async function runFake(row) {
  const clock = { now: new Date('2026-10-11T10:30:00Z') }; const S = makeServer({ clock });
  const m = /^suspended-by-(ic1|ic2)$/.exec(row.head);
  if (row.head !== 'none') S.seedHead({ valuationDate: DAY, headId: 'H0', version: 1, suspended: m ? { by: FAKE_EMAIL[m[1]] } : null, headDoc: { contributors: [FAKE_EMAIL.prep, ...row.headContributors.map((x) => FAKE_EMAIL[x])], approvedBy: FAKE_EMAIL.ic1 } });
  if (row.day === 'crossed') clock.now = new Date(NEXT_DAY_TIME);
  const before = JSON.stringify([...S.heads.entries()]); const payload = payloadOf(row, row.head === 'none' ? null : 'H0');
  let res; try { res = { ok: true, data: await S.handle(FAKE_EMAIL[row.actor], CALLABLES[row.action], payload) }; } catch (e) { res = { ok: false, code: String(e.code || '').replace(/^functions\//, '') || null, reason: (e.details && e.details.reason) || null, message: e.message }; }
  return { S, res, got: classify(res), before, after: JSON.stringify([...S.heads.entries()]), payload };
}

await t('table sanity: unique ids', () => { assert.equal(new Set(ROWS.map((x) => x.id)).size, ROWS.length); assert.ok(ROWS.length >= 30); });

await t('(A) every row gives exactly the expected outcome on the real service; a refusal writes NOTHING; a success writes the eligibility change and exactly one event', async () => {
  const bad = [];
  for (const row of ROWS) {
    const o = await runReal(row);
    if (o.got !== row.expect) { bad.push(`${row.id}: expected ${row.expect}, got ${o.got} (${o.res.message || ''})`); continue; }
    if (row.expect !== 'OK') { if (o.before !== o.after) bad.push(`${row.id}: a refused request changed the store`); continue; }
    const head = o.R.db.read('fundValuationHeads', `${FUND}__${DAY}`);
    const want = row.action === 'suspend' ? 'SUSPENDED' : 'ELIGIBLE';
    if (head.eligibility.state !== want) bad.push(`${row.id}: state ${head.eligibility.state}`);
    if (head.eligibility.changedBy !== EMAIL[row.actor]) bad.push(`${row.id}: changedBy ${head.eligibility.changedBy}`);
    if (typeof head.eligibility.changedAt !== 'string') bad.push(`${row.id}: changedAt ${JSON.stringify(head.eligibility.changedAt)}`);
    if (head.eligibility.reasonCode !== (row.action === 'suspend' ? 'SUSPENDED' : 'REINSTATED')) bad.push(`${row.id}: reasonCode ${head.eligibility.reasonCode}`);
    if (head.headId !== o.headId) bad.push(`${row.id}: head moved`);
    const ev = o.R.db.all('fundValuationEvents').filter((e) => e.type === (row.action === 'suspend' ? 'ELIGIBILITY_SUSPENDED' : 'ELIGIBILITY_REINSTATED'));
    if (ev.length !== 1) bad.push(`${row.id}: ${ev.length} events`);
    for (const k of ['eligibility', 'fundId', 'headId', 'valuationDate']) if (!(k in o.res.data)) bad.push(`${row.id}: reply lacks ${k}`);   // the real envelope adds ok / action / eventId; the orchestrator reads only these four
    if ('valuationId' in o.res.data) bad.push(`${row.id}: a head reply names no valuationId (the orchestrator targets the head id it SENT)`);
    if (o.res.data.eligibility !== want || o.res.data.headId !== o.headId) bad.push(`${row.id}: reply ${JSON.stringify(o.res.data)}`);
  }
  assert.deepEqual(bad, []);
});

await t('(A) head revision: every successful change bumps head.rev by one (a repeated cycle on one head is told apart by rev and changedAt, never by id / version / state alone)', async () => {
  const { R, headId } = await buildRealHead({ head: 'effective', headContributors: [] });
  const key = `${FUND}__${DAY}`; const seen = [];
  const step = async (action, who, iso) => { R.setTime(iso); must(await R.call(action, EMAIL[who], { requestId: rid(), fundId: FUND, valuationDate: DAY, expectedHeadId: headId, reason: 'دورة' }), action); const h = R.db.read('fundValuationHeads', key); seen.push([h.rev, h.eligibility.state, h.eligibility.changedBy, h.eligibility.changedAt, h.version]); };
  await step('suspend', 'ic2', '2026-10-11T11:00:00Z'); await step('reinstate', 'admin', '2026-10-11T12:00:00Z'); await step('suspend', 'ic2', '2026-10-11T13:00:00Z');
  assert.deepEqual(seen.map((x) => x[0]), [seen[0][0], seen[0][0] + 1, seen[0][0] + 2]);
  assert.equal(seen[0][1], seen[2][1]); assert.equal(seen[0][2], seen[2][2]); assert.equal(seen[0][4], seen[2][4], 'same state, same person, same version ...');
  assert.notEqual(seen[0][3], seen[2][3], '... but another changedAt'); assert.notEqual(seen[0][0], seen[2][0], '... and another rev');
});

await t('(A) role lists and payload keys: hand-written == server == client', () => {
  for (const a of ['suspend', 'reinstate']) {
    assert.deepEqual([...SERVER_ROLE_LISTS[a]].sort(), [...ROLES[a]].sort(), `server ${a}`); assert.deepEqual([...ACTION_ROLES[a]].sort(), [...ROLES[a]].sort(), `client ${a}`);
    assert.deepEqual([...SERVER_ALLOWED_KEYS[a]].sort(), [...PAYLOAD_KEYS[a]].sort(), `server keys ${a}`); assert.deepEqual([...PAYLOAD_SPEC[a].required, ...PAYLOAD_SPEC[a].optional].sort(), [...PAYLOAD_KEYS[a]].sort(), `client keys ${a}`);
    assert.deepEqual([...SERVER_BINDING[a]], ['headId'], 'bound to the head id only');
  }
});

await t('(A) the server really binds ONLY the head id: a second change of the same head by another person is accepted with the same expectedHeadId (the documented limit)', async () => {
  const { R, headId } = await buildRealHead({ head: 'suspended-by-ic1', headContributors: [] });
  const p = { fundId: FUND, valuationDate: DAY, expectedHeadId: headId, reason: 'x' };
  must(await R.call('reinstate', EMAIL.ic2, { requestId: rid(), ...p }), 'first reinstate'); must(await R.call('suspend', EMAIL.ic1, { requestId: rid(), ...p }), 'suspend again');
  assert.ok((await R.call('reinstate', EMAIL.admin, { requestId: rid(), ...p })).ok, 'a request that was prepared against the FIRST suspension still succeeds on the second');
});

await t('(A) replay: same requestId + same payload is replayed once (one event); same requestId + different reason is REQUEST_ID_REUSED; an unknown / foreign key is refused', async () => {
  const { R, headId } = await buildRealHead({ head: 'effective', headContributors: [] });
  const p = { requestId: rid(), fundId: FUND, valuationDate: DAY, expectedHeadId: headId, reason: 'الأول' };
  assert.ok((await R.call('suspend', EMAIL.ic1, p)).ok); const again = await R.call('suspend', EMAIL.ic1, { ...p }); assert.ok(again.ok); assert.equal(again.data.replayed, true);
  assert.equal(R.db.all('fundValuationEvents').filter((e) => e.type === 'ELIGIBILITY_SUSPENDED').length, 1);
  const r3 = await R.call('suspend', EMAIL.ic1, { ...p, reason: 'آخر' }); assert.equal(r3.reason, 'REQUEST_ID_REUSED'); assert.equal(r3.code, 'already-exists');
  assert.equal((await R.call('suspend', EMAIL.ic1, { ...p, requestId: rid(), valuationId: 'x' })).reason, 'PAYLOAD_UNKNOWN_FIELD');
  assert.equal((await R.call('suspend', EMAIL.ic1, { ...p, requestId: rid(), acknowledgeSuspended: true })).reason, 'PAYLOAD_UNKNOWN_FIELD');
});

await t('(B) the client model agrees with the table on every row it can know (role, head presence/state, separation of duties) and never forbids what the server allows', async () => {
  const bad = [];
  const MODELLED = new Set(['ROLE_NOT_ALLOWED', 'ALREADY_SUSPENDED', 'NOT_SUSPENDED', 'NO_HEAD', 'SUSPENDER_CANNOT_RESTORE', 'CONTRIBUTOR_CANNOT_REINSTATE']);
  for (const row of ROWS) {
    if (row.actor === 'stranger' || row.stale) continue;   // a stale head id is what the CLIENT cannot know: it sends the id it saw (covered by the orchestrator tests, E18)
    const { R, headId } = await buildRealHead(row);
    const head = headId ? R.db.read('fundValuationHeads', `${FUND}__${DAY}`) : null; const hv = headId ? R.db.read('fundValuations', headId) : null;
    const role = row.actor === 'hybrid' ? 'senior_ic' : ROLE_OF[row.actor];
    const av = availableActions({ role, email: EMAIL[row.actor], today: DAY, head: head ? { headId, eligibility: { state: head.eligibility.state, changedBy: head.eligibility.changedBy } } : undefined, headValuation: hv ? { contributors: hv.contributors, approvedBy: hv.approvedBy } : undefined, requireHeadValuation: true })[row.action];
    /* the model knows nothing about a stale id or a reason; the table's expectation for those rows is a payload-level / head-id fact: compare only modelled rows */
    const modelled = MODELLED.has(row.expect) || row.expect === 'OK' || ['STALE_HEAD', 'REASON_REQUIRED', 'code:permission-denied'].includes(row.expect);
    if (!modelled) continue;
    const expectedAllowed = !MODELLED.has(row.expect) && row.expect !== 'code:permission-denied';
    if (av.allowed !== expectedAllowed) { bad.push(`${row.id}: client allowed=${av.allowed} (${av.reason}), table ${row.expect}`); continue; }
    if (!av.allowed && av.reason !== row.expect) bad.push(`${row.id}: client reason ${av.reason}, table ${row.expect}`);
  }
  assert.deepEqual(bad, []);
});

await t('(B) fail-closed in the model: reinstate without a loaded head valuation is HEAD_DOC_NOT_LOADED with requireHeadValuation, and unchanged (a hint) without it', () => {
  const head = { headId: 'H', eligibility: { state: 'SUSPENDED', changedBy: 'a@x' } };
  const base = { role: 'senior_ic', email: 'b@x', today: DAY, head };
  assert.equal(availableActions({ ...base, requireHeadValuation: true }).reinstate.reason, 'HEAD_DOC_NOT_LOADED');
  assert.equal(availableActions({ ...base, headValuation: { contributors: null, approvedBy: 'c@x' }, requireHeadValuation: true }).reinstate.reason, 'HEAD_DOC_NOT_LOADED');
  assert.equal(availableActions({ ...base, headValuation: { contributors: [], approvedBy: 5 }, requireHeadValuation: true }).reinstate.reason, 'HEAD_DOC_NOT_LOADED');
  assert.equal(availableActions({ ...base, headValuation: { contributors: [], approvedBy: 'c@x' }, requireHeadValuation: true }).reinstate.allowed, true);
  assert.equal(availableActions(base).reinstate.allowed, true, 'the old hint behaviour is unchanged when the option is not given');
  assert.equal(availableActions({ ...base, requireHeadValuation: true }).suspend.reason, 'ALREADY_SUSPENDED', 'suspend never depends on it');
});

await t('(B) the payloads the client builds are accepted by the real service (no PAYLOAD_* / REASON_REQUIRED)', async () => {
  const a = await buildRealHead({ head: 'effective', headContributors: [] });
  assert.ok((await a.R.call('suspend', EMAIL.ic1, buildPayload('suspend', { requestId: rid(), fundId: FUND, valuationDate: DAY, expectedHeadId: a.headId, reason: 'سبب' }))).ok);
  assert.ok((await a.R.call('reinstate', EMAIL.ic2, buildPayload('reinstate', { requestId: rid(), fundId: FUND, valuationDate: DAY, expectedHeadId: a.headId, reason: 'زال' }))).ok);
});

await t('(C) the fake server ("خادم مزيّف") gives the same outcome as the table on every row, refuses without writing, and applies the same effect and the same head fields as the real service', async () => {
  const bad = [];
  for (const row of ROWS) {
    const o = await runFake(row);
    if (o.got !== row.expect) { bad.push(`${row.id}: expected ${row.expect}, got ${o.got}`); continue; }
    if (row.expect !== 'OK') { if (o.before !== o.after) bad.push(`${row.id}: a refused request changed the fake`); continue; }
    const h = o.S.headOf(FUND, DAY); const want = row.action === 'suspend' ? 'SUSPENDED' : 'ELIGIBLE';
    if (h.eligibility.state !== want || h.eligibility.changedBy !== FAKE_EMAIL[row.actor] || typeof h.eligibility.changedAt !== 'string' || !Number.isInteger(h.rev)) bad.push(`${row.id}: head ${JSON.stringify(h)}`);
    const real = (await runReal(row)).R.db.read('fundValuationHeads', `${FUND}__${DAY}`);
    if (JSON.stringify(Object.keys(h.eligibility).sort()) !== JSON.stringify(Object.keys(real.eligibility).sort())) bad.push(`${row.id}: eligibility fields differ (fake ${Object.keys(h.eligibility)} vs real ${Object.keys(real.eligibility)})`);
    if (JSON.stringify(Object.keys(o.res.data).sort()) !== JSON.stringify(['eligibility', 'fundId', 'headId', 'valuationDate'])) bad.push(`${row.id}: reply keys`);
  }
  assert.deepEqual(bad, []);
});

console.log(`\n${passed} tests passed`);
