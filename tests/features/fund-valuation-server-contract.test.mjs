// R1-B2 / B2-3a — the independent expectations table (review / returnDraft / reject / approve) compared BY EXECUTION with
//   (A) the REAL server service over an in-memory Firestore stand-in   -> "الخدمة الحقيقية فوق مخزن Firestore مزيّف"
//   (B) the client model (availableActions, buildPayload, PAYLOAD_SPEC, ACTION_ROLES, SERVER_BINDING)
// This is NOT the Firebase emulator and its results are never attributed to it: no real transaction isolation, no security rules.
// Run: node tests/features/fund-valuation-server-contract.test.mjs
import assert from 'node:assert/strict';
import { ROWS, ROLES_ALLOWED, STATES_ALLOWED, DAY_CHECKED as T_DAY, SERVER_BOUND, PAYLOAD_KEYS, ROLE_OF, validateTable } from '../helpers/fund-valuation-contract-expectations.mjs';
import { runRealRow, buildReal, rawPayload, EMAIL, FUND, DAY, NEXT_DAY_TIME, classify, freshRig } from '../helpers/fund-valuation-contract-driver-real.mjs';
import { runFakeRow } from '../helpers/fund-valuation-contract-driver-fake.mjs';
import { SERVER_ROLE_LISTS, SERVER_ALLOWED_KEYS, rid } from '../helpers/fund-valuation-real-service-rig.mjs';
import { availableActions, buildPayload, PAYLOAD_SPEC, ACTION_ROLES, SERVER_BINDING, riyadhDay } from '../../src/features/fund-valuation-model.js';

let passed = 0;
async function t(name, fn) { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
const FOUR = ['review', 'returnDraft', 'reject', 'approve'];
const EVENT_OF = { review: 'REVIEWED', returnDraft: 'RETURNED', reject: 'REJECTED', approve: 'APPROVED' };
const STATE_AFTER = { review: 'reviewed', returnDraft: 'returned', reject: 'rejected', approve: 'approved' };

await t('table sanity: unique ids, known actions', () => { assert.ok(validateTable() >= 55); });

await t('(A) every row of the table gives exactly the expected outcome on the real service (outcome + no write on refusal + effect on success)', async () => {
  const bad = [];
  for (const row of ROWS) {
    const o = await runRealRow(row);
    if (o.got !== row.expect) { bad.push(`${row.id}: expected ${row.expect}, got ${o.got} (${o.res.message || ''})`); continue; }
    if (row.expect !== 'OK') { if (o.before !== o.after) bad.push(`${row.id}: a refused request changed the store`); continue; }
    const v = o.R.db.read('fundValuations', o.id); const head = o.R.db.read('fundValuationHeads', `${FUND}__${DAY}`);
    if (v.state !== STATE_AFTER[row.action]) bad.push(`${row.id}: state ${v.state}`);
    const ev = o.R.db.all('fundValuationEvents').filter((e) => e.valuationId === o.id && e.type === EVENT_OF[row.action]);
    if (ev.length !== 1) bad.push(`${row.id}: ${ev.length} ${EVENT_OF[row.action]} events`);
    if (row.action === 'reject' && head.activeDraftId !== null) bad.push(`${row.id}: slot not released by reject`);
    if (row.action === 'returnDraft' && head.activeDraftId !== o.id) bad.push(`${row.id}: return must keep the slot`);
    if (row.action === 'review' && head.activeDraftId !== o.id) bad.push(`${row.id}: review must keep the slot`);
    if (row.action === 'approve') {
      if (head.headId !== o.id || head.activeDraftId !== null || head.eligibility.state !== 'ELIGIBLE') bad.push(`${row.id}: head after approve ${JSON.stringify(head)}`);
      if (/^suspended/.test(row.head) && head.eligibility.reasonCode !== 'RESTORED_BY_REPLACEMENT') bad.push(`${row.id}: reasonCode ${head.eligibility.reasonCode}`);
    }
  }
  assert.deepEqual(bad, []);
});

await t('(A) role matrix: every role x every one of the four actions, decided hand-written lists == server ROLE_LISTS == client ACTION_ROLES', async () => {
  for (const a of FOUR) {
    assert.deepEqual([...SERVER_ROLE_LISTS[a]].sort(), [...ROLES_ALLOWED[a]].sort(), `server ${a}`);
    assert.deepEqual([...ACTION_ROLES[a]].sort(), [...ROLES_ALLOWED[a]].sort(), `client ${a}`);
  }
  const users = { analyst: EMAIL.analyst, fund_manager: EMAIL.prep2, senior_ic: EMAIL.ic2, admin: EMAIL.admin };
  for (const a of FOUR) for (const [role, email] of Object.entries(users)) {
    const state = STATES_ALLOWED[a][0];
    const row = { action: a, state, actor: 'x', preparer: 'prep', contributors: [], day: 'today', hash: 'ok', head: 'none', reason: 'default', ack: undefined };
    const b = await buildReal(row);
    const res = await b.R.call(a, email, rawPayload(row, b.id, b.hash));
    const allowed = ROLES_ALLOWED[a].includes(role);
    assert.equal(res.ok, allowed, `${a}/${role}: ${classify(res)}`);
    if (!allowed) assert.equal(res.reason, 'ROLE_NOT_ALLOWED', `${a}/${role}`);
  }
});

await t('(A) states and day rules in the table are the ones the rows exercise (hand-written lists vs outcomes, all states)', async () => {
  const ALL = ['draft', 'returned', 'submitted', 'reviewed'];
  for (const a of FOUR) for (const state of ALL) {
    const actor = a === 'approve' ? 'ic2' : 'ic1';
    const row = { action: a, state, actor, preparer: 'prep', contributors: [], day: 'today', hash: 'ok', head: 'none', reason: 'default', ack: undefined };
    const o = await runRealRow(row);
    assert.equal(o.res.ok, STATES_ALLOWED[a].includes(state), `${a}/${state}: ${o.got}`);
    if (!o.res.ok) assert.equal(o.got, 'INVALID_STATE', `${a}/${state}`);
  }
  for (const a of FOUR) {
    const state = STATES_ALLOWED[a][0]; const actor = a === 'approve' ? 'ic2' : 'ic1';
    const o = await runRealRow({ action: a, state, actor, preparer: 'prep', contributors: [], day: 'crossed', hash: 'ok', head: 'none', reason: 'default', ack: undefined });
    assert.equal(o.res.ok, !T_DAY[a], `${a} on a crossed day: ${o.got}`);
    if (T_DAY[a]) assert.equal(o.got, 'DATE_CROSSED');
  }
});

await t('(A) payload keys: hand-written == server ALLOWED_KEYS == client PAYLOAD_SPEC; unknown / foreign keys are refused by the server', async () => {
  for (const a of FOUR) {
    assert.deepEqual([...SERVER_ALLOWED_KEYS[a]].sort(), [...PAYLOAD_KEYS[a]].sort(), `server ${a}`);
    assert.deepEqual([...PAYLOAD_SPEC[a].required, ...PAYLOAD_SPEC[a].optional].sort(), [...PAYLOAD_KEYS[a]].sort(), `client ${a}`);
  }
  const b1 = await buildReal({ state: 'submitted', preparer: 'prep', contributors: [], head: 'none' });
  assert.equal((await b1.R.call('review', EMAIL.ic1, { requestId: rid(), valuationId: b1.id, expectedContentHash: b1.hash, reason: 'x' })).reason, 'PAYLOAD_UNKNOWN_FIELD');
  assert.equal((await b1.R.call('returnDraft', EMAIL.ic1, { requestId: rid(), valuationId: b1.id, reason: 'x', expectedContentHash: b1.hash })).reason, 'PAYLOAD_UNKNOWN_FIELD');
  assert.equal((await b1.R.call('reject', EMAIL.ic1, { requestId: rid(), valuationId: b1.id, reason: 'x', acknowledgeSuspended: true })).reason, 'PAYLOAD_UNKNOWN_FIELD');
  assert.equal((await b1.R.call('review', EMAIL.ic1, { requestId: rid(), valuationId: b1.id })).reason, 'HASH_INVALID');
});

await t('(A) fingerprint binding: hand-written == client SERVER_BINDING (rows T15/J10 show the server really does not bind return/reject)', () => {
  for (const a of FOUR) assert.deepEqual([...SERVER_BINDING[a]], [...SERVER_BOUND[a]], a);
});

await t('(A) replay: same requestId + same payload is replayed once (one event); same requestId + DIFFERENT reason is REQUEST_ID_REUSED (why a retry must resend the original verbatim)', async () => {
  const b = await buildReal({ state: 'submitted', preparer: 'prep', contributors: [], head: 'none' });
  const rq = rid(); const p = { requestId: rq, valuationId: b.id, reason: 'السبب الأول' };
  const r1 = await b.R.call('returnDraft', EMAIL.ic1, p); assert.ok(r1.ok);
  const r2 = await b.R.call('returnDraft', EMAIL.ic1, { ...p }); assert.ok(r2.ok); assert.equal(r2.data.replayed, true);
  assert.equal(b.R.db.all('fundValuationEvents').filter((e) => e.type === 'RETURNED' && e.valuationId === b.id).length, 1);
  const r3 = await b.R.call('returnDraft', EMAIL.ic1, { ...p, reason: 'سبب مختلف' });
  assert.equal(r3.reason, 'REQUEST_ID_REUSED'); assert.equal(r3.code, 'already-exists');
  // approve replay with the SAME payload after success is replayed even though the state is no longer 'reviewed'
  const c = await buildReal({ state: 'reviewed', preparer: 'prep', contributors: [], head: 'none' });
  const ap = { requestId: rid(), valuationId: c.id, expectedContentHash: c.hash };
  assert.ok((await c.R.call('approve', EMAIL.ic2, ap)).ok);
  const again = await c.R.call('approve', EMAIL.ic2, { ...ap }); assert.ok(again.ok); assert.equal(again.data.replayed, true);
  assert.equal((await c.R.call('approve', EMAIL.ic2, { ...ap, reason: 'ملاحظة جديدة' })).reason, 'REQUEST_ID_REUSED');
});

await t('(B) the client model agrees with the table on every row it can know (role, day, contributor/preparer, state) and never forbids what the server allows', async () => {
  const bad = [];
  const MODELLED = new Set(['ROLE_NOT_ALLOWED', 'CONTRIBUTOR_CANNOT_REVIEW', 'CONTRIBUTOR_CANNOT_APPROVE', 'INVALID_STATE', 'DATE_CROSSED']);
  for (const row of ROWS) {
    if (row.actor === 'stranger') continue;
    const b = await buildReal(row);
    if (row.day === 'crossed') b.R.setTime(NEXT_DAY_TIME);
    const doc = { ...b.R.db.read('fundValuations', b.id), valuationId: b.id };
    const today = riyadhDay(new Date(b.R.clock.t));
    const av = availableActions({ role: row.actor === 'hybrid' ? 'senior_ic' : ROLE_OF[row.actor], email: EMAIL[row.actor], today, valuation: doc, head: { activeDraftId: b.id } })[row.action];
    const expectedAllowed = row.expect === 'OK' || !MODELLED.has(row.expect);
    if (av.allowed !== expectedAllowed) { bad.push(`${row.id}: client allowed=${av.allowed} (${av.reason}), table ${row.expect}`); continue; }
    if (!av.allowed && av.reason !== row.expect) bad.push(`${row.id}: client reason ${av.reason}, table ${row.expect}`);
  }
  assert.deepEqual(bad, []);
});

await t('(B) the payloads the client builds are accepted by the real service in a legal scenario (no PAYLOAD_* / HASH_INVALID / ACK_INVALID)', async () => {
  const s = await buildReal({ state: 'submitted', preparer: 'prep', contributors: [], head: 'none' });
  const pr = buildPayload('review', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash });
  assert.ok((await s.R.call('review', EMAIL.ic1, pr)).ok);
  const pa = buildPayload('approve', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash, acknowledgeSuspended: undefined, reason: undefined });
  assert.deepEqual(Object.keys(pa).sort(), ['expectedContentHash', 'requestId', 'valuationId']);
  assert.ok((await s.R.call('approve', EMAIL.ic2, pa)).ok);
  const u = await buildReal({ state: 'submitted', preparer: 'prep', contributors: [], head: 'none' });
  assert.ok((await u.R.call('returnDraft', EMAIL.ic1, buildPayload('returnDraft', { requestId: rid(), valuationId: u.id, reason: 'سبب' }))).ok);
  const w = await buildReal({ state: 'submitted', preparer: 'prep', contributors: [], head: 'none' });
  assert.ok((await w.R.call('reject', EMAIL.ic1, buildPayload('reject', { requestId: rid(), valuationId: w.id, reason: 'سبب' }))).ok);
  const h = await buildReal({ state: 'reviewed', preparer: 'prep', contributors: [], head: 'suspended-by-ic1' });
  const pk = buildPayload('approve', { requestId: rid(), valuationId: h.id, expectedContentHash: h.hash, acknowledgeSuspended: true, reason: 'استبدال' });
  assert.equal(pk.acknowledgeSuspended, true);
  assert.ok((await h.R.call('approve', EMAIL.ic2, pk)).ok);
});

await t('(C) the fake server ("خادم مزيّف") gives the same outcome as the table on every row, refuses without writing, and applies the same effects', async () => {
  const bad = [];
  for (const row of ROWS) {
    const o = await runFakeRow(row);
    if (o.got !== row.expect) { bad.push(`${row.id}: expected ${row.expect}, got ${o.got}`); continue; }
    if (row.expect !== 'OK') { if (o.before !== o.after) bad.push(`${row.id}: a refused request changed the fake`); continue; }
    const d = o.S.docOf(o.id);
    if (d.state !== STATE_AFTER[row.action]) bad.push(`${row.id}: state ${d.state}`);
    const slot = o.S.slotId('F1', DAY);
    if ((row.action === 'reject' || row.action === 'approve') && slot !== null) bad.push(`${row.id}: slot kept`);
    if ((row.action === 'review' || row.action === 'returnDraft') && slot !== o.id) bad.push(`${row.id}: slot lost`);
    if (row.action === 'approve') { const h = o.S.headOf('F1', DAY); if (h.headId !== o.id || h.eligibility.state !== 'ELIGIBLE') bad.push(`${row.id}: head ${JSON.stringify(h)}`); }
  }
  assert.deepEqual(bad, []);
});

await t('(C) the fake replays a repeated request and refuses the same requestId with a different payload, like the server', async () => {
  const o = await runFakeRow(ROWS.find((x) => x.id === 'T01'));
  const p = { ...o.payload };
  const again = await o.S.handle('ic@example.com', 'returnValuation', { ...p });
  assert.equal(again.replayed, true);
  await assert.rejects(() => o.S.handle('ic@example.com', 'returnValuation', { ...p, reason: 'سبب آخر' }), (e) => e.details && e.details.reason === 'REQUEST_ID_REUSED');
  assert.equal(o.S.effects.filter((e) => e.action === 'returnDraft').length, 1, 'one effect for the original request, none for the replay or the refused reuse');
});

console.log(`\n${passed} tests passed`);
