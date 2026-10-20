// R1-B2 / B2-3a — drives ONE row of the independent expectations table against the REAL server service
// (over the in-memory Firestore stand-in; see fund-valuation-real-service-rig.mjs for what that does and does not prove).
import { makeRealRig, rid, realContent, ADMIN_EMAIL } from './fund-valuation-real-service-rig.mjs';
import { ROLE_OF } from './fund-valuation-contract-expectations.mjs';

export const EMAIL = Object.freeze({ prep: 'prep@x.sa', prep2: 'prep2@x.sa', ic1: 'ic1@x.sa', ic2: 'ic2@x.sa', hybrid: 'hybrid@x.sa', analyst: 'analyst@x.sa', admin: ADMIN_EMAIL, stranger: 'stranger@x.sa' });
export const BUILD_TIME = '2026-10-11T10:00:00Z';
export const NEXT_DAY_TIME = '2026-10-12T10:00:00Z';
export const FUND = 'F1';
export const DAY = '2026-10-11';
export const WRONG_HASH = 'f'.repeat(64);
export const defaultReason = (action) => (action === 'approve' ? undefined : 'سبب مراجع صالح');

export function freshRig() {
  const team = {}; for (const k of ['prep', 'prep2', 'ic1', 'ic2', 'hybrid', 'analyst']) team[EMAIL[k]] = ROLE_OF[k];
  const R = makeRealRig({ now: BUILD_TIME, team }); R.fund(FUND); return R;
}
const must = (res, what) => { if (!res.ok) throw new Error(`setup ${what} failed: ${res.reason || res.code} ${res.message}`); return res.data; };

/** Builds the scenario of a row; returns { R, id, hash, headBefore } with the clock still at BUILD_TIME. */
export async function buildReal(row, R = freshRig()) {
  let headId = null;
  if (row.head && row.head !== 'none') {
    const v0 = must(await R.call('createDraft', EMAIL.prep, { requestId: rid(), fundId: FUND, valuationDate: DAY, content: realContent() }), 'v0 create');
    const s0 = must(await R.call('submit', EMAIL.prep, { requestId: rid(), valuationId: v0.valuationId }), 'v0 submit');
    must(await R.call('review', EMAIL.ic1, { requestId: rid(), valuationId: v0.valuationId, expectedContentHash: s0.contentHash }), 'v0 review');
    must(await R.call('approve', EMAIL.ic1, { requestId: rid(), valuationId: v0.valuationId, expectedContentHash: s0.contentHash }), 'v0 approve');
    headId = v0.valuationId;
    const m = /^suspended-by-(ic1|ic2)$/.exec(row.head);
    if (m) must(await R.call('suspend', EMAIL[m[1]], { requestId: rid(), fundId: FUND, valuationDate: DAY, expectedHeadId: headId, reason: 'تعليق للاختبار' }), 'suspend');
  }
  const preparer = EMAIL[row.preparer];
  const c = must(await R.call('createDraft', preparer, { requestId: rid(), fundId: FUND, valuationDate: DAY, content: realContent() }), 'create');
  const id = c.valuationId; let hash = c.contentHash;
  if (row.contributors.includes('hybrid')) {
    R.setRole(EMAIL.hybrid, 'fund_manager');
    const u = must(await R.call('updateDraft', EMAIL.hybrid, { requestId: rid(), valuationId: id, expectedContentHash: hash, content: realContent({ methodNote: 'تعديل المساهم' }) }), 'hybrid update');
    hash = u.contentHash; R.setRole(EMAIL.hybrid, 'senior_ic');
  }
  if (row.state !== 'draft') {
    const s = must(await R.call('submit', preparer, { requestId: rid(), valuationId: id }), 'submit'); hash = s.contentHash;
    if (row.state === 'reviewed') must(await R.call('review', EMAIL.ic1, { requestId: rid(), valuationId: id, expectedContentHash: hash }), 'review');
    if (row.state === 'returned') must(await R.call('returnDraft', EMAIL.ic1, { requestId: rid(), valuationId: id, reason: 'إرجاع للإعداد' }), 'return');
  }
  return { R, id, hash, headId };
}

/** The payload the table row asks for (raw, as the server contract defines it). */
export function rawPayload(row, id, hash, requestId = rid()) {
  const reason = row.reason === 'default' ? defaultReason(row.action) : row.reason;
  const p = { requestId, valuationId: id };
  if (row.action === 'review' || row.action === 'approve') p.expectedContentHash = row.hash === 'wrong' ? WRONG_HASH : hash;
  if (reason !== undefined && row.action !== 'review') p.reason = reason;
  if (row.action === 'approve' && row.ack !== undefined) p.acknowledgeSuspended = row.ack;
  return p;
}
export const classify = (res) => (res.ok ? 'OK' : (res.reason || `code:${res.code}`));
const WHOLE = (R) => JSON.stringify(R.db.data);

/** Runs the row; returns { got, before, after, R, id, res } */
export async function runRealRow(row) {
  const b = await buildReal(row);
  const { R, id, hash } = b;
  if (row.day === 'crossed') R.setTime(NEXT_DAY_TIME);
  if (row.storedContributors === 'none') { const v = R.db.read('fundValuations', id); v.contributors = []; R.db.seed('fundValuations', id, v); }   // data-level scenario: only enteredBy names him
  const before = WHOLE(R);
  const payload = rawPayload(row, id, hash);
  const method = row.action;
  const res = await R.call(method, EMAIL[row.actor], payload);
  return { ...b, res, got: classify(res), before, after: WHOLE(R), payload };
}
