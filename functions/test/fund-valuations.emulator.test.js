'use strict';
/* =========================================================================
   R1-B1 — fund residual-valuation workflow, against the REAL Firestore emulator (real transaction isolation).
   Run from tests/rules:
     npx firebase emulators:exec --only firestore --project demo-test "node ../../functions/test/fund-valuations.emulator.test.js"
   Covers: request replay (order of checks), eligibility suspension, one active draft per fund + date (concurrent),
   draft validation without a forged approval, explicit role lists, chain / baseHeadId refresh, Riyadh day crossing,
   validation INSIDE the approval transaction, atomicity, and that stored approved records pass the real selector.
   ========================================================================= */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadIndexAgainstRealEmulator } = require('./load-index-with-real-emulator');
const { documentHash } = require('../trusted-ic.cjs');

const { fns, db } = loadIndexAgainstRealEmulator();
const svc = fns._fundValuations;

const D1 = '2026-10-08';
const T1 = () => new Date('2026-10-08T09:00:00.000Z');                 // 12:00 Riyadh, day D1
const T2 = () => new Date('2026-10-09T09:00:00.000Z');                 // next Riyadh day
const LAST_MS_OF_D1 = () => new Date('2026-10-08T20:59:59.999Z');      // 23:59:59.999 Riyadh
const FIRST_MS_OF_D2 = () => new Date('2026-10-08T21:00:00.000Z');     // 00:00:00.000 Riyadh next day
function at(fn) { svc.clock.now = fn; }
at(T1);

const U = {
  prep1: 'prep1@x.sa', prep2: 'prep2@x.sa', rev: 'rev@x.sa', appr: 'appr@x.sa', appr2: 'appr2@x.sa', fm: 'fm@x.sa',
  analyst: 'analyst@x.sa', expired: 'expired@x.sa', stranger: 'stranger@x.sa', admin: 'opal3k@gmail.com',
};
const ROLE_OF = { prep1: 'fund_manager', prep2: 'fund_manager', rev: 'senior_ic', appr: 'senior_ic', appr2: 'senior_ic', fm: 'fund_manager', analyst: 'analyst', expired: 'senior_ic' };

/* Separation-of-duties tests need a person who contributed (preparer role) AND now holds a reviewer role: a role change after
   contributing. The matrix gives no role both lists except admin, so such a person is built by changing the role in between. */
async function withRole(users, role, fn) {
  for (const u of users) await db.collection('team_roles').doc(U[u]).set({ role });
  try { return await fn(); } finally { for (const u of users) await db.collection('team_roles').doc(U[u]).set({ role: ROLE_OF[u] }); }
}
function barrier(n, ms) {
  // releases when n transactions reached the point just before their writes, or after ms (a pessimistic lock may hold some back)
  let arrived = 0; let release; const gate = new Promise((r) => { release = r; }); setTimeout(release, ms);
  return async () => { arrived++; if (arrived >= n) release(); await gate; };
}
let passed = 0;
async function test(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;   // regression runs: ONLY="REVIEW-1" node ...
  at(T1); await fn(); passed++; console.log(`OK ${name}`);
}
const req = (email, data) => ({ auth: { token: { email } }, data });
let ridN = 0;
const rid = () => `req-${Date.now().toString(36)}-${(++ridN).toString().padStart(6, '0')}-x`;
async function expectErr(promise, reason, code) {
  try { await promise; } catch (e) {
    const got = e && e.details && e.details.reason;
    assert.equal(got, reason, `expected ${reason}, got ${got} (${e && e.code}: ${e && e.message})`);
    if (code) assert.equal(e.code, code);
    return e;
  }
  assert.fail(`expected rejection ${reason}, but the call succeeded`);
}
const call = (name, user, data) => fns[name](req(U[user] || user, data));

async function seedTeam() {
  const w = [];
  for (const [k, role] of Object.entries(ROLE_OF)) {
    const email = U[k];
    w.push(db.collection('team_members').doc(email).set({ expiresAt: k === 'expired' ? new Date(Date.now() - 86400000) : null }));
    w.push(db.collection('team_roles').doc(email).set({ role }));
  }
  await Promise.all(w);
}
let fundN = 0;
async function newFund(assets = ['a1', 'a2']) {
  const id = `F${Date.now().toString(36)}${(++fundN)}`;
  await db.collection('funds').doc(id).set({ name: id, assetIds: assets });
  return id;
}
const valid = (o = {}) => JSON.parse(JSON.stringify({
  currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE',
  components: { assetsValue: 1000000, cashRetained: 50000, otherAssets: 20000, otherAssetsItems: [{ description: 'receivable', amount: 20000 }], liabilities: 70000, distributionsPayable: 0 },
  residualValue: 1000000, method: 'appraisal', source: { ref: 'DOC-1', provider: 'Valuer Co' },
  nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: true },
  coverage: { linkedAssets: ['a1', 'a2'], unlinkedHoldings: { declared: 'none' } }, ...o,
}));
const events = async (fundId) => (await db.collection('fundValuationEvents').where('fundId', '==', fundId).get()).docs.map((d) => d.data());
const getV = async (id) => (await db.collection('fundValuations').doc(id).get()).data();
const getHead = async (fundId, date = D1) => (await db.collection('fundValuationHeads').doc(`${fundId}__${date}`).get()).data();
const countDocs = async (coll, field, value) => (await db.collection(coll).where(field, '==', value).get()).size;

async function draft(fundId, user = 'prep1', content = valid(), date = D1) {
  const r = await call('createValuationDraft', user, { requestId: rid(), fundId, valuationDate: date, content });
  return r;
}
async function toSubmitted(fundId, user = 'prep1', content) {
  const d = await draft(fundId, user, content);
  const s = await call('submitValuation', user, { requestId: rid(), valuationId: d.valuationId });
  return { id: d.valuationId, hash: s.contentHash };
}
async function toReviewed(fundId, content) {
  const s = await toSubmitted(fundId, 'prep1', content);
  await call('reviewValuation', 'rev', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash });
  return s;
}
async function toApproved(fundId, content, approver = 'appr') {
  const s = await toReviewed(fundId, content);
  const a = await call('approveValuation', approver, { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash });
  return { ...s, approval: a };
}
async function selectorOn(fundId, date = D1, withEligibility = true) {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'generated', 'src', 'domain', 'financial', 'xirr', 'residual-valuation.js')).href);
  const ap = (await db.collection('fundValuations').where('fundId', '==', fundId).where('valuationDate', '==', date).where('status', '==', 'approved').get()).docs.map((d) => ({ ...d.data(), valuationId: d.id }));
  const fund = (await db.collection('funds').doc(fundId).get()).data();
  const head = (await db.collection('fundValuationHeads').doc(`${fundId}__${date}`).get()).data();
  const recs = [];
  (await db.collection('capitalCalls').where('fundId', '==', fundId).get()).forEach((d) => recs.push({ kind: 'capitalCall', id: d.id, fundId, date: d.data().callDate, status: d.data().status }));
  (await db.collection('distributions').where('fundId', '==', fundId).get()).forEach((d) => recs.push({ kind: 'distribution', id: d.id, fundId, date: d.data().distDate, status: d.data().status }));
  const input = { asOfDate: date, scope: { snapshotDate: date, funds: [fundId], linksByFund: { [fundId]: [...fund.assetIds].sort() } }, valuations: ap, records: recs };
  if (withEligibility && head) input.eligibility = { [fundId]: { headId: head.headId, state: head.eligibility.state } };
  return mod.selectResidualValuation(input);
}

(async () => {
  await seedTeam();

  /* ---------- happy path + stored records pass the REAL selector ---------- */
  await test('happy path: draft -> submit -> review -> approve; the stored approved record passes the real selector', async () => {
    const f = await newFund();
    const a = await toApproved(f);
    const v = await getV(a.id);
    assert.equal(v.state, 'approved'); assert.equal(v.status, 'approved'); assert.equal(v.version, 1); assert.equal(v.supersedes, null);
    assert.equal(v.approvedBy, U.appr); assert.equal(v.enteredBy, U.prep1);
    const h = await getHead(f);
    assert.equal(h.headId, a.id); assert.equal(h.version, 1); assert.equal(h.activeDraftId, null); assert.equal(h.eligibility.state, 'ELIGIBLE');
    const sel = await selectorOn(f);
    assert.equal(sel.status, 'OK', JSON.stringify(sel.issues)); assert.equal(sel.value, 1000000);
    assert.deepEqual((await events(f)).map((e) => e.type).sort(), ['APPROVED', 'DRAFT_CREATED', 'REVIEWED', 'SUBMITTED']);
  });

  await test('a draft never gets status approved or an approver; the candidate path stores no approval', async () => {
    const f = await newFund(); const d = await draft(f);
    const v = await getV(d.valuationId);
    assert.equal(v.status, 'draft'); assert.equal(v.approvedBy, undefined); assert.equal(v.version, undefined); assert.equal(v.supersedes, undefined);
    assert.equal(v.validation.ok, true); assert.equal(v.validation.ruleVersion, 'R1B1-candidate-v1');
  });

  /* ---------- 1. replay: after identity + authorization, before date / head / state ---------- */
  await test('replay: an identical createDraft returns the stored result with replayed=true and writes no second event', async () => {
    const f = await newFund(); const r = rid(); const data = { requestId: r, fundId: f, valuationDate: D1, content: valid() };
    const a = await call('createValuationDraft', 'prep1', data);
    const n = (await events(f)).length;
    const b = await call('createValuationDraft', 'prep1', data);
    assert.equal(b.replayed, true); assert.equal(b.valuationId, a.valuationId); assert.equal((await events(f)).length, n);
    assert.equal(await countDocs('fundValuations', 'fundId', f), 1);
  });

  await test('replay: a successful approval replayed the NEXT DAY returns the stored result (date check is not reached) and changes nothing', async () => {
    const f = await newFund(); const s = await toReviewed(f);
    const data = { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash };
    const a = await call('approveValuation', 'appr', data);
    const before = { v: await getV(s.id), h: await getHead(f), ev: (await events(f)).length };
    at(T2);
    const b = await call('approveValuation', 'appr', data);
    assert.equal(b.replayed, true); assert.equal(b.version, a.version); assert.equal(b.eventId, a.eventId);
    assert.deepEqual(await getV(s.id), before.v); assert.deepEqual(await getHead(f), before.h); assert.equal((await events(f)).length, before.ev);
    // a NEW request id the next day is NOT a replay: state / date rules apply
    await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }), 'DATE_CROSSED');
  });

  await test('replay: a successful approval replayed AFTER THE HEAD WAS REPLACED returns the stored v1 result and leaves v2 as head', async () => {
    const f = await newFund(); const s1 = await toReviewed(f);
    const data1 = { requestId: rid(), valuationId: s1.id, expectedContentHash: s1.hash };
    const a1 = await call('approveValuation', 'appr', data1);
    const s2 = await toReviewed(f, valid({ components: { assetsValue: 1100000, cashRetained: 50000, otherAssets: 20000, otherAssetsItems: [{ description: 'receivable', amount: 20000 }], liabilities: 70000, distributionsPayable: 0 }, residualValue: 1100000 }));
    await call('approveValuation', 'appr', { requestId: rid(), valuationId: s2.id, expectedContentHash: s2.hash });
    const headBefore = await getHead(f); const evBefore = (await events(f)).length;
    assert.equal(headBefore.headId, s2.id); assert.equal(headBefore.version, 2);
    const again = await call('approveValuation', 'appr', data1);
    assert.equal(again.replayed, true); assert.equal(again.valuationId, s1.id); assert.equal(again.version, a1.version);
    assert.deepEqual(await getHead(f), headBefore); assert.equal((await events(f)).length, evBefore);
    assert.equal((await selectorOn(f)).value, 1100000);
  });

  await test('replay: same requestId with a different payload -> REQUEST_ID_REUSED; another actor with that requestId is independent', async () => {
    const f = await newFund(); const r = rid();
    const d = await call('createValuationDraft', 'prep1', { requestId: r, fundId: f, valuationDate: D1, content: valid() });
    await expectErr(call('createValuationDraft', 'prep1', { requestId: r, fundId: f, valuationDate: D1, content: valid({ method: 'nav_statement' }) }), 'REQUEST_ID_REUSED', 'already-exists');
    const other = await call('updateValuationDraft', 'prep2', { requestId: r, valuationId: d.valuationId, expectedContentHash: d.contentHash, content: valid({ method: 'nav_statement' }) });
    assert.notEqual(other.replayed, true);
  });

  await test('replay: a caller who lost the required role is refused BEFORE the replay lookup', async () => {
    const f = await newFund(); const data = { requestId: rid(), fundId: f, valuationDate: D1, content: valid() };
    await call('createValuationDraft', 'prep2', data);
    await db.collection('team_roles').doc(U.prep2).set({ role: 'analyst' });
    try { await expectErr(call('createValuationDraft', 'prep2', data), 'ROLE_NOT_ALLOWED', 'permission-denied'); }
    finally { await db.collection('team_roles').doc(U.prep2).set({ role: 'fund_manager' }); }
  });

  await test('failed requests are not recorded: a retry of a failed approve is a fresh attempt', async () => {
    const f = await newFund(); const s = await toReviewed(f);
    const data = { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash };
    await expectErr(call('approveValuation', 'prep1', data), 'ROLE_NOT_ALLOWED');   // a fund_manager may not approve at all
    await withRole(['prep1'], 'senior_ic', () => expectErr(call('approveValuation', 'prep1', data), 'CONTRIBUTOR_CANNOT_APPROVE'));   // a contributor who became senior_ic still may not
    assert.equal((await db.collection('fundValuationRequests').get()).docs.filter((d) => d.data().payloadHash === documentHash({ action: 'approve', targetId: s.id, payload: { expectedContentHash: s.hash, acknowledgeSuspended: false, reason: null } }) && d.data().actor === U.prep1).length, 0);
    const ok = await call('approveValuation', 'appr', data);   // same requestId, other actor -> not a replay of the failed one
    assert.equal(ok.state, 'approved');
  });

  /* ---------- 2. eligibility ---------- */
  await test('eligibility: suspend targets one head; old requests can neither restore nor touch a newer head', async () => {
    const f = await newFund(); const s1 = await toReviewed(f);
    const apprReq = { requestId: rid(), valuationId: s1.id, expectedContentHash: s1.hash };
    await call('approveValuation', 'appr', apprReq);
    const susp1 = { requestId: rid(), fundId: f, valuationDate: D1, expectedHeadId: s1.id, reason: 'valuer withdrew the report' };
    await call('suspendValuationEligibility', 'rev', susp1);
    assert.equal((await getHead(f)).eligibility.state, 'SUSPENDED');
    const sel = await selectorOn(f); assert.equal(sel.status, 'BLOCKED'); assert.ok(sel.reasonCodes.includes('VALUATION_SUSPENDED')); assert.equal(sel.value, null);
    // replaying the OLD approval must not restore eligibility
    const rp = await call('approveValuation', 'appr', apprReq); assert.equal(rp.replayed, true);
    assert.equal((await getHead(f)).eligibility.state, 'SUSPENDED');
    // a NEW approval request for the already approved version is refused and does not restore either
    await expectErr(call('approveValuation', 'appr2', { requestId: rid(), valuationId: s1.id, expectedContentHash: s1.hash }), 'ALREADY_APPROVED');
    assert.equal((await getHead(f)).eligibility.state, 'SUSPENDED');
    assert.equal(await call('suspendValuationEligibility', 'rev', susp1).then((r) => r.replayed), true);
    await expectErr(call('suspendValuationEligibility', 'rev', { ...susp1, requestId: rid() }), 'ALREADY_SUSPENDED');
    // replacement approval: acknowledgement + reason required; the suspender may not restore
    const s2 = await toReviewed(f, valid({ residualValue: 1000000.004 }));
    await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: s2.id, expectedContentHash: s2.hash }), 'SUSPENDED_ACK_REQUIRED');
    await expectErr(call('approveValuation', 'rev', { requestId: rid(), valuationId: s2.id, expectedContentHash: s2.hash, acknowledgeSuspended: true, reason: 'fixed report' }), 'SUSPENDER_CANNOT_RESTORE');
    const ok = await call('approveValuation', 'appr', { requestId: rid(), valuationId: s2.id, expectedContentHash: s2.hash, acknowledgeSuspended: true, reason: 'replacement report received' });
    assert.equal(ok.eligibility, 'ELIGIBLE');
    const h2 = await getHead(f); assert.equal(h2.headId, s2.id); assert.equal(h2.eligibility.state, 'ELIGIBLE'); assert.equal(h2.eligibility.reasonCode, 'RESTORED_BY_REPLACEMENT');
    assert.equal((await selectorOn(f)).status, 'OK');
    // old suspend request: replay returns the stored result, the NEW head is untouched
    const again = await call('suspendValuationEligibility', 'rev', susp1); assert.equal(again.replayed, true);
    assert.equal((await getHead(f)).eligibility.state, 'ELIGIBLE');
    // a NEW suspend / reinstate aimed at the old head id is STALE_HEAD, with no effect
    await expectErr(call('suspendValuationEligibility', 'rev', { requestId: rid(), fundId: f, valuationDate: D1, expectedHeadId: s1.id, reason: 'late' }), 'STALE_HEAD');
    await expectErr(call('reinstateValuationEligibility', 'appr2', { requestId: rid(), fundId: f, valuationDate: D1, expectedHeadId: s1.id, reason: 'late' }), 'STALE_HEAD');
    assert.equal((await getHead(f)).eligibility.state, 'ELIGIBLE');
  });

  await test('eligibility: reinstate needs a different, non-contributor, non-approver person and a SUSPENDED head', async () => {
    const f = await newFund(); const a = await toApproved(f);
    const base = { fundId: f, valuationDate: D1, expectedHeadId: a.id, reason: 'check' };
    await expectErr(call('reinstateValuationEligibility', 'appr2', { requestId: rid(), ...base }), 'NOT_SUSPENDED');
    await call('suspendValuationEligibility', 'rev', { requestId: rid(), ...base });
    await expectErr(call('reinstateValuationEligibility', 'rev', { requestId: rid(), ...base }), 'SUSPENDER_CANNOT_RESTORE');
    await expectErr(call('reinstateValuationEligibility', 'appr', { requestId: rid(), ...base }), 'CONTRIBUTOR_CANNOT_REINSTATE');   // the approver of that version
    await expectErr(call('reinstateValuationEligibility', 'prep1', { requestId: rid(), ...base }), 'ROLE_NOT_ALLOWED');   // fund_manager may not reinstate
    await withRole(['prep1'], 'senior_ic', () => expectErr(call('reinstateValuationEligibility', 'prep1', { requestId: rid(), ...base }), 'CONTRIBUTOR_CANNOT_REINSTATE'));
    await expectErr(call('reinstateValuationEligibility', 'analyst', { requestId: rid(), ...base }), 'ROLE_NOT_ALLOWED');
    const r = await call('reinstateValuationEligibility', 'appr2', { requestId: rid(), ...base });
    assert.equal(r.eligibility, 'ELIGIBLE'); assert.equal((await selectorOn(f)).status, 'OK');
    await expectErr(call('suspendValuationEligibility', 'rev', { requestId: rid(), ...base, reason: '' }), 'REASON_REQUIRED');
  });

  /* ---------- 3. one active draft per fund + date, concurrent ---------- */
  await test('one active draft: sequential second create is refused; other fund and other date are independent', async () => {
    const f = await newFund(); const f2 = await newFund();
    const d = await draft(f);
    const e = await expectErr(draft(f, 'prep2'), 'ACTIVE_DRAFT_EXISTS', 'already-exists');
    assert.equal(e.details.activeDraftId, d.valuationId);
    await draft(f2, 'prep2');
    at(T2); await draft(f, 'prep1', valid(), '2026-10-09');
  });

  await test('one active draft: 8 genuinely concurrent creates (distinct requestIds) -> exactly one draft', async () => {
    const f = await newFund();
    const users = ['prep1', 'prep2', 'fm', 'admin', 'prep1', 'prep2', 'fm', 'admin'];
    svc.hooks.beforeWrite = barrier(8, 700);   // force every transaction through its reads before any of them writes
    let results;
    try { results = await Promise.allSettled(users.map((u) => call('createValuationDraft', u, { requestId: rid(), fundId: f, valuationDate: D1, content: valid() }))); }
    finally { svc.hooks.beforeWrite = null; }
    const ok = results.filter((r) => r.status === 'fulfilled'); const bad = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.status === 'rejected' ? (r.reason.details && r.reason.details.reason) || r.reason.message : 'ok')));
    for (const b of bad) assert.equal(b.reason.details && b.reason.details.reason, 'ACTIVE_DRAFT_EXISTS');
    assert.equal(await countDocs('fundValuations', 'fundId', f), 1);
    assert.equal((await getHead(f)).activeDraftId, ok[0].value.valuationId);
  });

  await test('one active draft: concurrent calls with the SAME requestId produce one effect and the same result', async () => {
    const f = await newFund(); const data = { requestId: rid(), fundId: f, valuationDate: D1, content: valid() };
    const rs = await Promise.all([1, 2, 3, 4].map(() => call('createValuationDraft', 'prep1', data)));
    assert.equal(new Set(rs.map((r) => r.valuationId)).size, 1); assert.equal(await countDocs('fundValuations', 'fundId', f), 1);
    assert.equal((await events(f)).length, 1);
  });

  await test('slot release: reject / withdraw free the slot (and only then); approve frees it; a race between approve and reject leaves one consistent outcome', async () => {
    const f = await newFund(); const d = await draft(f);
    await call('withdrawValuation', 'prep1', { requestId: rid(), valuationId: d.valuationId });
    assert.equal((await getHead(f)).activeDraftId, null);
    const d2 = await draft(f);
    const s = await call('submitValuation', 'prep1', { requestId: rid(), valuationId: d2.valuationId });
    await call('reviewValuation', 'rev', { requestId: rid(), valuationId: d2.valuationId, expectedContentHash: s.contentHash });
    svc.hooks.beforeWrite = barrier(2, 700);
    let rs;
    try {
      rs = await Promise.allSettled([
        call('approveValuation', 'appr', { requestId: rid(), valuationId: d2.valuationId, expectedContentHash: s.contentHash }),
        call('rejectValuation', 'appr2', { requestId: rid(), valuationId: d2.valuationId, reason: 'racing' }),
      ]);
    } finally { svc.hooks.beforeWrite = null; }
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(rs.map((r) => r.status)));
    const v = await getV(d2.valuationId); const h = await getHead(f);
    assert.ok(['approved', 'rejected'].includes(v.state)); assert.equal(h.activeDraftId, null);
    assert.equal(h.headId, v.state === 'approved' ? d2.valuationId : null);
    await draft(f);   // slot is free again
  });

  /* ---------- 5. explicit role lists ---------- */
  await test('roles: every action x every role (table-driven); disallowed -> ROLE_NOT_ALLOWED, non-member / expired refused', async () => {
    const calls = {
      createDraft: ['createValuationDraft', { fundId: 'nofund', valuationDate: D1, content: valid() }],
      updateDraft: ['updateValuationDraft', { valuationId: 'nov', expectedContentHash: 'a'.repeat(64), content: valid() }],
      submit: ['submitValuation', { valuationId: 'nov' }],
      review: ['reviewValuation', { valuationId: 'nov', expectedContentHash: 'a'.repeat(64) }],
      returnDraft: ['returnValuation', { valuationId: 'nov', reason: 'r' }],
      reject: ['rejectValuation', { valuationId: 'nov', reason: 'r' }],
      withdraw: ['withdrawValuation', { valuationId: 'nov' }],
      approve: ['approveValuation', { valuationId: 'nov', expectedContentHash: 'a'.repeat(64) }],
      suspend: ['suspendValuationEligibility', { fundId: 'nofund', valuationDate: D1, expectedHeadId: 'x', reason: 'r' }],
      reinstate: ['reinstateValuationEligibility', { fundId: 'nofund', valuationDate: D1, expectedHeadId: 'x', reason: 'r' }],
      preview: ['getValuationPreview', { valuationId: 'nov' }],
    };
    // expectations come from the hand-written decision record, NOT from ROLE_LISTS (so an unintended widening fails here)
    const { APPROVED } = require('./helpers/valuation-approved-matrix.cjs');
    assert.deepEqual(Object.keys(calls).sort(), Object.keys(APPROVED).sort());
    for (const [action, [fn, data]] of Object.entries(calls)) {
      for (const user of ['analyst', 'rev', 'prep1', 'admin']) {
        const role = user === 'admin' ? 'admin' : ROLE_OF[user];
        const allowed = APPROVED[action][role] === true;
        let reason = null;
        try { await call(fn, user, { requestId: rid(), ...data }); } catch (e) { reason = e.details && e.details.reason; }
        if (allowed) assert.notEqual(reason, 'ROLE_NOT_ALLOWED', `${action}/${role} must pass the role gate`);
        else assert.equal(reason, 'ROLE_NOT_ALLOWED', `${action}/${role} must be refused`);
      }
      for (const user of ['stranger', 'expired']) {
        let e = null; try { await call(fn, user, { requestId: rid(), ...data }); } catch (x) { e = x; }
        assert.ok(e && e.code === 'permission-denied', `${action}/${user} must be refused`);
      }
    }
  });

  await test('roles: prior contribution alone is not enough — a contributor who lost the role cannot update, submit or withdraw', async () => {
    const f = await newFund(); const d = await draft(f, 'prep2');
    await db.collection('team_roles').doc(U.prep2).set({ role: 'analyst' });
    try {
      await expectErr(call('updateValuationDraft', 'prep2', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: d.contentHash, content: valid({ method: 'nav_statement' }) }), 'ROLE_NOT_ALLOWED');
      await expectErr(call('submitValuation', 'prep2', { requestId: rid(), valuationId: d.valuationId }), 'ROLE_NOT_ALLOWED');
      await expectErr(call('withdrawValuation', 'prep2', { requestId: rid(), valuationId: d.valuationId }), 'ROLE_NOT_ALLOWED');
    } finally { await db.collection('team_roles').doc(U.prep2).set({ role: 'fund_manager' }); }
    await db.collection('team_members').doc(U.prep2).delete();
    try {
      let e = null; try { await call('submitValuation', 'prep2', { requestId: rid(), valuationId: d.valuationId }); } catch (x) { e = x; }
      assert.ok(e && e.code === 'permission-denied', 'a removed team member must be refused');
    } finally { await db.collection('team_members').doc(U.prep2).set({ expiresAt: null }); }
    // a role-holder who is NOT a contributor cannot submit / withdraw someone else's draft
    await expectErr(call('submitValuation', 'fm', { requestId: rid(), valuationId: d.valuationId }), 'NOT_A_CONTRIBUTOR');
    await expectErr(call('withdrawValuation', 'fm', { requestId: rid(), valuationId: d.valuationId }), 'NOT_A_CONTRIBUTOR');
  });

  await test('roles: contributors (creator and editors) can never review, return, reject or approve; admin is not exempt; reviewer may approve', async () => {
    const f = await newFund(); const d = await draft(f, 'prep1');
    await call('updateValuationDraft', 'prep2', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: d.contentHash, content: { method: 'nav_statement' } });   // prep2 becomes a contributor
    const s = await call('submitValuation', 'prep1', { requestId: rid(), valuationId: d.valuationId });
    for (const u of ['prep1', 'prep2']) {   // as fund_manager: not a reviewer role at all
      await expectErr(call('reviewValuation', u, { requestId: rid(), valuationId: d.valuationId, expectedContentHash: s.contentHash }), 'ROLE_NOT_ALLOWED');
      await expectErr(call('returnValuation', u, { requestId: rid(), valuationId: d.valuationId, reason: 'x' }), 'ROLE_NOT_ALLOWED');
      await expectErr(call('rejectValuation', u, { requestId: rid(), valuationId: d.valuationId, reason: 'x' }), 'ROLE_NOT_ALLOWED');
    }
    await withRole(['prep1', 'prep2'], 'senior_ic', async () => {   // contributors who later hold a reviewer role: still refused
      for (const u of ['prep1', 'prep2']) {
        await expectErr(call('reviewValuation', u, { requestId: rid(), valuationId: d.valuationId, expectedContentHash: s.contentHash }), 'CONTRIBUTOR_CANNOT_REVIEW');
        await expectErr(call('returnValuation', u, { requestId: rid(), valuationId: d.valuationId, reason: 'x' }), 'CONTRIBUTOR_CANNOT_REVIEW');
        await expectErr(call('rejectValuation', u, { requestId: rid(), valuationId: d.valuationId, reason: 'x' }), 'CONTRIBUTOR_CANNOT_REVIEW');
      }
    });
    await call('reviewValuation', 'rev', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: s.contentHash });
    await withRole(['prep1', 'prep2'], 'senior_ic', async () => { for (const u of ['prep1', 'prep2']) await expectErr(call('approveValuation', u, { requestId: rid(), valuationId: d.valuationId, expectedContentHash: s.contentHash }), 'CONTRIBUTOR_CANNOT_APPROVE'); });
    // admin as preparer cannot approve their own draft
    const f2 = await newFund(); const ad = await draft(f2, 'admin'); const as = await call('submitValuation', 'admin', { requestId: rid(), valuationId: ad.valuationId });
    await call('reviewValuation', 'rev', { requestId: rid(), valuationId: ad.valuationId, expectedContentHash: as.contentHash });
    await expectErr(call('approveValuation', 'admin', { requestId: rid(), valuationId: ad.valuationId, expectedContentHash: as.contentHash }), 'CONTRIBUTOR_CANNOT_APPROVE');
    // the reviewer himself (not a contributor) may approve
    const ok = await call('approveValuation', 'rev', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: s.contentHash });
    assert.equal(ok.state, 'approved'); assert.equal((await getV(d.valuationId)).review.reviewedBy, U.rev); assert.equal((await getV(d.valuationId)).approvedBy, U.rev);
  });

  /* ---------- 4. draft validation / inside the transaction ---------- */
  await test('validation: submit refuses invalid content with the selector codes; a draft carries no approval', async () => {
    const f = await newFund(); const d = await draft(f, 'prep1', valid({ currency: 'USD' }));
    assert.equal((await getV(d.valuationId)).validation.ok, false);
    const e = await expectErr(call('submitValuation', 'prep1', { requestId: rid(), valuationId: d.valuationId }), 'VALIDATION_FAILED');
    assert.ok(e.details.reasonCodes.includes('INVALID_CURRENCY'));
    await call('updateValuationDraft', 'prep1', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: (await getV(d.valuationId)).contentHash, content: { currency: 'SAR' } });
    assert.equal((await call('submitValuation', 'prep1', { requestId: rid(), valuationId: d.valuationId })).state, 'submitted');
  });

  await test('validation INSIDE the approval transaction: an unpaid distribution added after review is caught by the selector dry run; no write, reason codes reported', async () => {
    const f = await newFund(); const s = await toReviewed(f);
    await db.collection('distributions').doc(`dist-${f}`).set({ fundId: f, distDate: '2026-10-01', amount: 5, status: 'approved' });
    const before = { v: await getV(s.id), h: await getHead(f), ev: (await events(f)).length, rq: (await db.collection('fundValuationRequests').get()).size };
    const e = await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }), 'APPROVAL_VALIDATION_FAILED');
    assert.ok(e.details.reasonCodes.includes('DISTRIBUTIONS_PAYABLE_UNRESOLVED'));
    assert.deepEqual(await getV(s.id), before.v); assert.deepEqual(await getHead(f), before.h);
    assert.equal((await events(f)).length, before.ev); assert.equal((await db.collection('fundValuationRequests').get()).size, before.rq);
    // and the scope / ledger are re-read in the transaction: removing the distribution makes the SAME request succeed
    await db.collection('distributions').doc(`dist-${f}`).delete();
    assert.equal((await call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash })).state, 'approved');
  });

  await test('binding: tampered content (hash mismatch) and a wrong expectedContentHash are refused; the review is bound to base head and scope', async () => {
    const f = await newFund(); const s = await toReviewed(f);
    await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: 'b'.repeat(64) }), 'CONTENT_CHANGED');
    const v = await getV(s.id);
    await db.collection('fundValuations').doc(s.id).update({ 'components.assetsValue': 9999999, residualValue: 9999999 - 70000 + 50000 + 20000 });
    await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }), 'CONTENT_HASH_MISMATCH');
    await db.collection('fundValuations').doc(s.id).set(v);
    assert.equal((await call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash })).state, 'approved');
  });

  await test('scope: assets changed after submit -> SCOPE_CHANGED at review; reviewer returns it; preparer updates coverage and re-submits', async () => {
    const f = await newFund(); const s = await toSubmitted(f);
    await db.collection('funds').doc(f).update({ assetIds: ['a1', 'a2', 'a3'] });
    await expectErr(call('reviewValuation', 'rev', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }), 'SCOPE_CHANGED');
    const e = await expectErr(call('submitValuation', 'prep1', { requestId: rid(), valuationId: s.id }), 'VALIDATION_FAILED');   // stale scope refreshed, but the coverage statement misses a3
    assert.ok(e.details.reasonCodes.includes('COVERAGE_ASSET_MISSING'));
    await call('returnValuation', 'rev', { requestId: rid(), valuationId: s.id, reason: 'scope changed' });
    await call('updateValuationDraft', 'prep1', { requestId: rid(), valuationId: s.id, expectedContentHash: (await getV(s.id)).contentHash, content: { coverage: { linkedAssets: ['a1', 'a2', 'a3'], unlinkedHoldings: { declared: 'none' } } } });
    const r = await call('submitValuation', 'prep1', { requestId: rid(), valuationId: s.id });
    await call('reviewValuation', 'rev', { requestId: rid(), valuationId: s.id, expectedContentHash: r.contentHash });
    assert.equal((await call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: r.contentHash })).state, 'approved');
    assert.equal((await selectorOn(f)).status, 'OK');
  });

  /* ---------- 6. chain, STALE_HEAD, baseHeadId refresh, old review dropped ---------- */
  await test('chain: v1 -> v2 -> v3, versions server-assigned, supersedes linked, only the head is effective', async () => {
    const f = await newFund();
    const mkC = (n) => valid({ components: { assetsValue: n, cashRetained: 0, otherAssets: 0, otherAssetsItems: [], liabilities: 0, distributionsPayable: 0 }, residualValue: n });
    const a1 = await toApproved(f, mkC(100)); const a2 = await toApproved(f, mkC(200)); const a3 = await toApproved(f, mkC(300));
    const vs = await Promise.all([a1, a2, a3].map((a) => getV(a.id)));
    assert.deepEqual(vs.map((v) => v.version), [1, 2, 3]); assert.deepEqual(vs.map((v) => v.supersedes), [null, a1.id, a2.id]);
    assert.deepEqual(vs.map((v) => v.baseHeadId), [null, a1.id, a2.id]);
    const sel = await selectorOn(f); assert.equal(sel.status, 'OK'); assert.equal(sel.value, 300); assert.equal(sel.perFund[0].version, 3);
  });

  await test('STALE_HEAD: head moved after the base was captured -> review / approve refuse; a contributor re-submits: base refreshed, old review dropped, new review needed', async () => {
    const f = await newFund(); const a1 = await toApproved(f);
    const s = await toReviewed(f, valid({ residualValue: 1000000.004 }));            // based on v1, reviewed
    // simulate an out-of-band head move (the slot normally prevents it): a v2 appears and the pointer moves
    const v1 = await getV(a1.id); const v2id = `manual-${f}`;
    await db.collection('fundValuations').doc(v2id).set({ ...v1, valuationId: v2id, version: 2, supersedes: a1.id, approvedAt: '2026-10-08T09:00:00.000Z' });
    const h = await getHead(f); await db.collection('fundValuationHeads').doc(`${f}__${D1}`).set({ ...h, headId: v2id, version: 2 });
    await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }), 'STALE_HEAD');
    const stale = await getV(s.id); assert.equal(stale.state, 'reviewed'); assert.equal(stale.baseHeadId, a1.id);
    const re = await call('submitValuation', 'prep1', { requestId: rid(), valuationId: s.id });
    const fresh = await getV(s.id);
    assert.equal(fresh.baseHeadId, v2id); assert.equal(fresh.state, 'submitted'); assert.equal(fresh.review, null); assert.equal(re.baseHeadId, v2id);
    const ev = (await events(f)).filter((e) => e.type === 'RESUBMITTED_AFTER_STALE'); assert.equal(ev.length, 1);
    assert.equal(ev[0].details.oldBaseHeadId, a1.id); assert.equal(ev[0].details.newBaseHeadId, v2id); assert.equal(ev[0].details.droppedReview.reviewedBy, U.rev);
    await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: re.contentHash }), 'INVALID_STATE');   // old review no longer counts
    await call('reviewValuation', 'rev', { requestId: rid(), valuationId: s.id, expectedContentHash: re.contentHash });
    const ok = await call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: re.contentHash });
    assert.equal(ok.version, 3); assert.equal((await getV(s.id)).supersedes, v2id);
    // a submitted draft that is NOT stale cannot be re-submitted
    const g = await newFund(); const gs = await toSubmitted(g);
    await expectErr(call('submitValuation', 'prep1', { requestId: rid(), valuationId: gs.id }), 'ALREADY_SUBMITTED');
  });

  await test('chain integrity: a head pointer that disagrees with the approved chain blocks create / approve (no repair, no write)', async () => {
    const f = await newFund(); await toApproved(f);
    const h = await getHead(f); await db.collection('fundValuationHeads').doc(`${f}__${D1}`).set({ ...h, headId: 'ghost', version: 1 });
    await expectErr(draft(f, 'prep2'), 'HEAD_POINTER_INCONSISTENT');
    await db.collection('fundValuationHeads').doc(`${f}__${D1}`).set({ ...h, version: 5 });
    await expectErr(draft(f, 'prep2'), 'HEAD_POINTER_INCONSISTENT');
    await db.collection('fundValuationHeads').doc(`${f}__${D1}`).set(h);
    await draft(f, 'prep2');
  });

  /* ---------- Riyadh day crossing ---------- */
  await test('day crossing: submit on D, review / approve / update / submit on D+1 -> DATE_CROSSED with no effect; withdraw and reject still work', async () => {
    const f = await newFund(); const s = await toSubmitted(f);
    at(T2);
    await expectErr(call('reviewValuation', 'rev', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }), 'DATE_CROSSED');
    await expectErr(call('updateValuationDraft', 'prep1', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash, content: { method: 'nav_statement' } }), 'DATE_CROSSED');
    assert.equal((await getV(s.id)).state, 'submitted');
    await call('rejectValuation', 'rev', { requestId: rid(), valuationId: s.id, reason: 'day changed' });
    assert.equal((await getHead(f)).activeDraftId, null);
    // reviewed on D, approval attempted on D+1
    at(T1);
    const f2 = await newFund(); const r = await toReviewed(f2);
    at(T2);
    await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: r.id, expectedContentHash: r.hash }), 'DATE_CROSSED');
    assert.equal((await getV(r.id)).state, 'reviewed'); assert.equal((await getHead(f2)).headId, null);
    await call('withdrawValuation', 'prep1', { requestId: rid(), valuationId: r.id });
    assert.equal((await getV(r.id)).state, 'withdrawn');
    // fresh draft for the new day, copying the withdrawn content, fresh scope
    const nd = await call('createValuationDraft', 'prep1', { requestId: rid(), fundId: f2, valuationDate: '2026-10-09', copyFromValuationId: r.id });
    const nv = await getV(nd.valuationId); assert.equal(nv.copiedFrom, r.id); assert.equal(nv.scopeSnapshot.snapshotDate, '2026-10-09');
    assert.equal(nv.components.assetsValue, 1000000);
    const ns = await call('submitValuation', 'prep1', { requestId: rid(), valuationId: nd.valuationId });
    await call('reviewValuation', 'rev', { requestId: rid(), valuationId: nd.valuationId, expectedContentHash: ns.contentHash });
    assert.equal((await call('approveValuation', 'appr', { requestId: rid(), valuationId: nd.valuationId, expectedContentHash: ns.contentHash })).state, 'approved');
    assert.equal((await selectorOn(f2, '2026-10-09')).status, 'OK');
  });

  await test('day crossing: exact Riyadh midnight boundary (23:59:59.999 is still D, 00:00:00.000 is D+1)', async () => {
    const f = await newFund(); const s = await toSubmitted(f);
    at(LAST_MS_OF_D1);
    await call('reviewValuation', 'rev', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash });
    at(FIRST_MS_OF_D2);
    await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }), 'DATE_CROSSED');
    at(LAST_MS_OF_D1);
    assert.equal((await call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash })).state, 'approved');
  });

  await test('date rules: past and future valuation dates cannot be created; suspend / reinstate are allowed on a later day', async () => {
    const f = await newFund();
    await expectErr(draft(f, 'prep1', valid(), '2026-10-07'), 'DATE_CROSSED');
    await expectErr(draft(f, 'prep1', valid(), '2026-10-09'), 'DATE_IN_FUTURE');
    await expectErr(draft(f, 'prep1', valid(), '2026-02-30'), 'DATE_INVALID');
    const a = await toApproved(f);
    at(T2);
    const r = await call('suspendValuationEligibility', 'rev', { requestId: rid(), fundId: f, valuationDate: D1, expectedHeadId: a.id, reason: 'next-day finding' });
    assert.equal(r.eligibility, 'SUSPENDED');
  });

  /* ---------- atomicity, shape, copy ---------- */
  await test('atomicity: a refused approval leaves no partial write (valuation, head, events, requests unchanged)', async () => {
    const f = await newFund(); const s = await toReviewed(f);
    const snap = async () => JSON.stringify([await getV(s.id), await getHead(f), (await events(f)).length, (await db.collection('fundValuationRequests').get()).size]);
    const before = await snap();
    await expectErr(call('approveValuation', 'prep1', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }), 'ROLE_NOT_ALLOWED');
    await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: 'c'.repeat(64) }), 'CONTENT_CHANGED');
    assert.equal(await snap(), before);
  });

  await test('input shape: bad requestId, unknown content field, unsafe key, missing fund, copy of an approved version', async () => {
    const f = await newFund();
    await expectErr(call('createValuationDraft', 'prep1', { requestId: 'short', fundId: f, valuationDate: D1, content: valid() }), 'REQUEST_ID_INVALID');
    await expectErr(call('createValuationDraft', 'prep1', { requestId: rid(), fundId: f, valuationDate: D1, content: valid({ approvedBy: 'x' }) }), 'CONTENT_UNKNOWN_FIELD');
    await expectErr(call('createValuationDraft', 'prep1', { requestId: rid(), fundId: f, valuationDate: D1, content: JSON.parse('{"components":{"__proto__":{"x":1}}}') }), 'CONTENT_UNSAFE');
    await expectErr(call('createValuationDraft', 'prep1', { requestId: rid(), fundId: 'no-such-fund', valuationDate: D1, content: valid() }), 'FUND_NOT_FOUND');
    await expectErr(call('createValuationDraft', 'prep1', { requestId: rid(), fundId: 'a/b', valuationDate: D1, content: valid() }), 'ID_INVALID');
    const a = await toApproved(f);
    await expectErr(call('createValuationDraft', 'prep2', { requestId: rid(), fundId: f, valuationDate: D1, copyFromValuationId: a.id }), 'COPY_SOURCE_STATE');
  });

  await test('preview: read-only, reports staleness, date and candidate validation, writes nothing', async () => {
    const f = await newFund(); const d = await draft(f, 'prep1', valid({ currency: 'USD' }));
    const evBefore = (await events(f)).length, rqBefore = (await db.collection('fundValuationRequests').get()).size;
    const p = await call('getValuationPreview', 'rev', { valuationId: d.valuationId });
    assert.equal(p.dateOk, true); assert.equal(p.stale, false); assert.ok(p.candidate.reasonCodes.includes('INVALID_CURRENCY'));
    at(T2); assert.equal((await call('getValuationPreview', 'rev', { valuationId: d.valuationId })).dateOk, false);
    assert.equal((await events(f)).length, evBefore); assert.equal((await db.collection('fundValuationRequests').get()).size, rqBefore);
  });


  /* =====================================================================
     Regression tests added after the independent review of the first B1 delivery.
     Each one fails on that first delivery and passes after the fix.
     ===================================================================== */
  const snapshotOf = async (fundId) => JSON.stringify([
    (await db.collection('fundValuations').where('fundId', '==', fundId).get()).docs.map((d) => [d.id, d.data()]).sort(),
    await getHead(fundId) || null, (await events(fundId)).length, (await db.collection('fundValuationRequests').get()).size,
  ]);
  const oneShot = (name, fn) => { svc.hooks[name] = async (...a) => { svc.hooks[name] = null; await fn(...a); }; };

  await test('REVIEW-1: role / membership / expiry are re-read INSIDE the transaction (changed after the pre-check, before the transaction)', async () => {
    const flips = [
      ['role demoted to analyst', () => db.collection('team_roles').doc(U.appr).set({ role: 'analyst' }), () => db.collection('team_roles').doc(U.appr).set({ role: 'senior_ic' }), 'ROLE_NOT_ALLOWED'],
      ['team membership removed', () => db.collection('team_members').doc(U.appr).delete(), () => db.collection('team_members').doc(U.appr).set({ expiresAt: null }), 'MEMBERSHIP_REQUIRED'],
      ['team membership expired', () => db.collection('team_members').doc(U.appr).set({ expiresAt: new Date('2026-10-08T08:00:00.000Z') }), () => db.collection('team_members').doc(U.appr).set({ expiresAt: null }), 'MEMBERSHIP_EXPIRED'],
    ];
    for (const [label, flip, restore, reason] of flips) {
      const f = await newFund(); const s = await toReviewed(f);
      const before = await snapshotOf(f);
      oneShot('beforeTransaction', flip);
      try { await expectErr(call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }), reason, 'permission-denied'); }
      finally { svc.hooks.beforeTransaction = null; await restore(); }
      assert.equal(await snapshotOf(f), before, `${label}: nothing may be written`);
    }
    // the same for a REPLAY: authorization is checked before the stored result is returned
    const f = await newFund(); const s = await toReviewed(f); const data = { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash };
    await call('approveValuation', 'appr', data);
    oneShot('beforeTransaction', () => db.collection('team_roles').doc(U.appr).set({ role: 'analyst' }));
    try { await expectErr(call('approveValuation', 'appr', data), 'ROLE_NOT_ALLOWED', 'permission-denied'); }
    finally { svc.hooks.beforeTransaction = null; await db.collection('team_roles').doc(U.appr).set({ role: 'senior_ic' }); }
    assert.equal((await call('approveValuation', 'appr', data)).replayed, true);
  });

  await test('REVIEW-2: updateDraft requires the expected content hash; a stale hash is refused with no write and no event', async () => {
    const f = await newFund(); const d = await draft(f, 'prep1'); const h0 = d.contentHash;
    const e1 = await call('updateValuationDraft', 'prep1', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: h0, content: { method: 'nav_statement' } });
    assert.notEqual(e1.contentHash, h0);
    const before = await snapshotOf(f);
    await expectErr(call('updateValuationDraft', 'prep2', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: h0, content: { method: 'cost_basis' } }), 'CONTENT_CHANGED');
    assert.equal(await snapshotOf(f), before);
    assert.equal((await getV(d.valuationId)).method, 'nav_statement'); assert.ok(!(await getV(d.valuationId)).contributors.includes(U.prep2));
    await expectErr(call('updateValuationDraft', 'prep2', { requestId: rid(), valuationId: d.valuationId, content: { method: 'cost_basis' } }), 'HASH_INVALID');
    await expectErr(call('updateValuationDraft', 'prep2', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: 'nothex', content: { method: 'cost_basis' } }), 'HASH_INVALID');
    assert.equal(await snapshotOf(f), before);
    // with the CURRENT hash the second editor succeeds and the new hash chains on
    const e2 = await call('updateValuationDraft', 'prep2', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: e1.contentHash, content: { method: 'cost_basis' } });
    assert.equal((await getV(d.valuationId)).method, 'cost_basis'); assert.notEqual(e2.contentHash, e1.contentHash);
    // stored content that no longer matches its recorded hash is refused too
    await db.collection('fundValuations').doc(d.valuationId).update({ 'components.liabilities': 1 });
    await expectErr(call('updateValuationDraft', 'prep1', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: e2.contentHash, content: { method: 'appraisal' } }), 'CONTENT_HASH_MISMATCH');
  });

  await test('REVIEW-2b: two concurrent edits carrying the same hash -> exactly one wins, the other is CONTENT_CHANGED', async () => {
    const f = await newFund(); const d = await draft(f, 'prep1');
    svc.hooks.beforeWrite = barrier(2, 700);
    let rs;
    try {
      rs = await Promise.allSettled([
        call('updateValuationDraft', 'prep1', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: d.contentHash, content: { method: 'nav_statement' } }),
        call('updateValuationDraft', 'prep2', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: d.contentHash, content: { method: 'cost_basis' } }),
      ]);
    } finally { svc.hooks.beforeWrite = null; }
    assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(rs.map((r) => r.status)));
    assert.equal(rs.find((r) => r.status === 'rejected').reason.details.reason, 'CONTENT_CHANGED');
    const winner = rs.findIndex((r) => r.status === 'fulfilled');
    assert.equal((await getV(d.valuationId)).method, winner === 0 ? 'nav_statement' : 'cost_basis');
    assert.equal((await events(f)).filter((e) => e.type === 'DRAFT_UPDATED').length, 1);
  });

  await test('REVIEW-3: the Riyadh day is re-checked AFTER the reads and checks and BEFORE the writes (midnight crossed inside one request)', async () => {
    const setups = {
      createDraft: async () => { const f = await newFund(); return { f, run: () => call('createValuationDraft', 'prep1', { requestId: rid(), fundId: f, valuationDate: D1, content: valid() }) }; },
      updateDraft: async () => { const f = await newFund(); const d = await draft(f); return { f, run: () => call('updateValuationDraft', 'prep1', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: d.contentHash, content: { method: 'nav_statement' } }) }; },
      submit: async () => { const f = await newFund(); const d = await draft(f); return { f, run: () => call('submitValuation', 'prep1', { requestId: rid(), valuationId: d.valuationId }) }; },
      review: async () => { const f = await newFund(); const s = await toSubmitted(f); return { f, run: () => call('reviewValuation', 'rev', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }) }; },
      approve: async () => { const f = await newFund(); const s = await toReviewed(f); return { f, run: () => call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash }) }; },
    };
    for (const [name, setup] of Object.entries(setups)) {
      at(LAST_MS_OF_D1);                                   // 23:59:59.999 Riyadh: every check at the start of the request passes
      const { f, run } = await setup();
      const before = await snapshotOf(f);
      oneShot('beforeWrite', () => at(FIRST_MS_OF_D2));    // the clock crosses midnight after the reads, before the writes
      try { await expectErr(run(), 'DATE_CROSSED'); }
      finally { svc.hooks.beforeWrite = null; at(T1); }
      assert.equal(await snapshotOf(f), before, `${name}: a request whose check instant is on the next day must write nothing`);
    }
    // control: the same approve with the clock staying inside the day succeeds
    at(LAST_MS_OF_D1); const f = await newFund(); const s = await toReviewed(f);
    assert.equal((await call('approveValuation', 'appr', { requestId: rid(), valuationId: s.id, expectedContentHash: s.hash })).state, 'approved');
  });

  await test('REVIEW-4: every action has an allow-list of top-level payload keys; unknown keys and wrong types are refused', async () => {
    const withBogus = {
      createValuationDraft: ['prep1', { fundId: 'nofund', valuationDate: D1, content: valid() }],
      updateValuationDraft: ['prep1', { valuationId: 'nov', content: valid(), expectedContentHash: 'a'.repeat(64) }],
      submitValuation: ['prep1', { valuationId: 'nov' }],
      reviewValuation: ['rev', { valuationId: 'nov', expectedContentHash: 'a'.repeat(64) }],
      returnValuation: ['rev', { valuationId: 'nov', reason: 'r' }],
      rejectValuation: ['rev', { valuationId: 'nov', reason: 'r' }],
      withdrawValuation: ['prep1', { valuationId: 'nov' }],
      approveValuation: ['rev', { valuationId: 'nov', expectedContentHash: 'a'.repeat(64) }],
      suspendValuationEligibility: ['rev', { fundId: 'nofund', valuationDate: D1, expectedHeadId: 'x', reason: 'r' }],
      reinstateValuationEligibility: ['rev', { fundId: 'nofund', valuationDate: D1, expectedHeadId: 'x', reason: 'r' }],
      getValuationPreview: ['rev', { valuationId: 'nov' }],
    };
    for (const [fn, [user, data]] of Object.entries(withBogus)) {
      const extra = fn === 'getValuationPreview' ? {} : { requestId: rid() };
      await expectErr(call(fn, user, { ...extra, ...data, bogusKey: 1 }), 'PAYLOAD_UNKNOWN_FIELD');
      await expectErr(call(fn, user, { ...extra, ...data, approvedBy: 'x@x.sa' }), 'PAYLOAD_UNKNOWN_FIELD');
    }
    // keys of another action are unknown here (expectedContentHash on submit, valuationId on suspend)
    await expectErr(call('submitValuation', 'prep1', { requestId: rid(), valuationId: 'nov', expectedContentHash: 'a'.repeat(64) }), 'PAYLOAD_UNKNOWN_FIELD');
    await expectErr(call('suspendValuationEligibility', 'rev', { requestId: rid(), fundId: 'nofund', valuationDate: D1, expectedHeadId: 'x', reason: 'r', valuationId: 'nov' }), 'PAYLOAD_UNKNOWN_FIELD');
    // payload must be a plain object; flags must be real booleans
    await expectErr(fns.submitValuation({ auth: { token: { email: U.prep1 } }, data: null }), 'PAYLOAD_INVALID');
    await expectErr(fns.submitValuation({ auth: { token: { email: U.prep1 } }, data: [] }), 'PAYLOAD_INVALID');
    await expectErr(call('approveValuation', 'rev', { requestId: rid(), valuationId: 'nov', expectedContentHash: 'a'.repeat(64), acknowledgeSuspended: 'yes' }), 'ACK_INVALID');
    // known keys still work end to end (the allow-list is not too tight)
    const f = await newFund(); const d = await draft(f);
    await call('updateValuationDraft', 'prep1', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: d.contentHash, content: { method: 'nav_statement' } });
  });

  await test('slot: a head whose active-draft pointer does not name the draft blocks editing (SLOT_INCONSISTENT), no write', async () => {
    const f = await newFund(); const d = await draft(f);
    const headRef = db.collection('fundValuationHeads').doc(`${f}__${D1}`);
    await headRef.set({ activeDraftId: null }, { merge: true });          // out-of-band corruption
    const before = (await getV(d.valuationId)).contentHash;
    await expectErr(call('updateValuationDraft', 'prep1', { requestId: rid(), valuationId: d.valuationId, expectedContentHash: before, content: { method: 'nav_statement' } }), 'SLOT_INCONSISTENT');
    assert.equal((await getV(d.valuationId)).contentHash, before);
  });

  console.log(`\n${passed} real-emulator workflow tests passed (R1-B1).`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });
