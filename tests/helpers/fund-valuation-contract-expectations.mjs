// R1-B2 / B2-3a — INDEPENDENT expectations table for review / returnDraft / reject / approve.
// Written by hand as literals from the B1 contract and the decisions of 2026-10-08 (roles) and 2026-10-14 (separation of duties).
// It imports NOTHING from src/features (so it cannot be satisfied by the client model by construction) and NOTHING from the server.
// It is compared BY EXECUTION: (1) against the real server service over an in-memory Firestore stand-in, (2) against the fake server,
// (3) against the client model's availableActions / buildPayload / SERVER_BINDING.
// Vocabulary — actor labels: prep, prep2 = fund_manager; ic1, ic2 = senior_ic; hybrid = a senior_ic who ALSO contributed to the draft (role changed after
// contributing); admin = admin e-mail; analyst; stranger = no team membership.
// expect: 'OK' | a server reason code | 'code:<functions code>' when the server gives no reason.

export const ROLE_OF = Object.freeze({ prep: 'fund_manager', prep2: 'fund_manager', ic1: 'senior_ic', ic2: 'senior_ic', hybrid: 'senior_ic', analyst: 'analyst', admin: 'admin' });

/** action -> roles that may call it (the decided matrix, hand-written; fund_manager is deliberately NOT a reviewer). */
export const ROLES_ALLOWED = Object.freeze({
  review: ['senior_ic', 'admin'], returnDraft: ['senior_ic', 'admin'], reject: ['senior_ic', 'admin'], approve: ['senior_ic', 'admin'],
});
/** states each action accepts (hand-written) */
export const STATES_ALLOWED = Object.freeze({
  review: ['submitted'], returnDraft: ['submitted', 'reviewed'], reject: ['submitted', 'reviewed', 'returned'], approve: ['reviewed'],
});
/** which actions the server checks the Riyadh day for (hand-written; return and reject are NOT day-checked) */
export const DAY_CHECKED = Object.freeze({ review: true, returnDraft: false, reject: false, approve: true });
/** which actions the server binds to the content fingerprint (hand-written) */
export const SERVER_BOUND = Object.freeze({ review: ['contentHash'], returnDraft: [], reject: [], approve: ['contentHash'] });
/** exact payload keys per action (hand-written) */
export const PAYLOAD_KEYS = Object.freeze({
  review: ['requestId', 'valuationId', 'expectedContentHash'],
  returnDraft: ['requestId', 'valuationId', 'reason'],
  reject: ['requestId', 'valuationId', 'reason'],
  approve: ['requestId', 'valuationId', 'expectedContentHash', 'acknowledgeSuspended', 'reason'],
});
export const MAX_REASON = 1000;

const r = (id, action, state, actor, o = {}) => Object.freeze({ id, action, state, actor, preparer: 'prep', contributors: [], day: 'today', hash: 'ok', head: 'none', reason: 'default', ack: undefined, expect: 'OK', ...o });
const longReason = (n) => 'ر'.repeat(n);

export const ROWS = Object.freeze([
  // ---- review ----
  r('R01', 'review', 'submitted', 'ic1'),
  r('R02', 'review', 'submitted', 'admin'),
  r('R03', 'review', 'submitted', 'hybrid', { contributors: ['hybrid'], expect: 'CONTRIBUTOR_CANNOT_REVIEW' }),
  r('R04', 'review', 'submitted', 'admin', { preparer: 'admin', expect: 'CONTRIBUTOR_CANNOT_REVIEW' }),
  r('R05', 'review', 'submitted', 'prep2', { expect: 'ROLE_NOT_ALLOWED' }),
  r('R06', 'review', 'submitted', 'analyst', { expect: 'ROLE_NOT_ALLOWED' }),
  r('R07', 'review', 'draft', 'ic1', { expect: 'INVALID_STATE' }),
  r('R08', 'review', 'reviewed', 'ic2', { expect: 'INVALID_STATE' }),
  r('R09', 'review', 'returned', 'ic1', { expect: 'INVALID_STATE' }),
  r('R10', 'review', 'submitted', 'ic1', { day: 'crossed', expect: 'DATE_CROSSED' }),
  r('R11', 'review', 'submitted', 'ic1', { hash: 'wrong', expect: 'CONTENT_CHANGED' }),
  r('R12', 'review', 'submitted', 'hybrid', { contributors: ['hybrid'], day: 'crossed', expect: 'DATE_CROSSED' }),       // order: day first
  r('R13', 'review', 'draft', 'hybrid', { contributors: ['hybrid'], expect: 'CONTRIBUTOR_CANNOT_REVIEW' }),               // order: contributor before state
  r('R14', 'review', 'submitted', 'stranger', { expect: 'code:permission-denied' }),
  // ---- returnDraft ----
  r('T01', 'returnDraft', 'submitted', 'ic1'),
  r('T02', 'returnDraft', 'reviewed', 'ic2'),
  r('T03', 'returnDraft', 'draft', 'ic1', { expect: 'INVALID_STATE' }),
  r('T04', 'returnDraft', 'returned', 'ic1', { expect: 'INVALID_STATE' }),
  r('T05', 'returnDraft', 'submitted', 'hybrid', { contributors: ['hybrid'], expect: 'CONTRIBUTOR_CANNOT_REVIEW' }),
  r('T06', 'returnDraft', 'submitted', 'admin', { preparer: 'admin', expect: 'CONTRIBUTOR_CANNOT_REVIEW' }),
  r('T07', 'returnDraft', 'submitted', 'ic1', { day: 'crossed' }),                                                         // NOT day-checked
  r('T08', 'returnDraft', 'submitted', 'ic1', { reason: '', expect: 'REASON_REQUIRED' }),
  r('T09', 'returnDraft', 'submitted', 'ic1', { reason: '   ', expect: 'REASON_REQUIRED' }),
  r('T10', 'returnDraft', 'submitted', 'ic1', { reason: longReason(MAX_REASON) }),
  r('T11', 'returnDraft', 'submitted', 'ic1', { reason: longReason(MAX_REASON + 1), expect: 'REASON_REQUIRED' }),
  r('T12', 'returnDraft', 'submitted', 'prep2', { expect: 'ROLE_NOT_ALLOWED' }),
  r('T13', 'returnDraft', 'draft', 'hybrid', { contributors: ['hybrid'], expect: 'CONTRIBUTOR_CANNOT_REVIEW' }),
  r('T14', 'returnDraft', 'submitted', 'ic1', { reason: undefined, expect: 'REASON_REQUIRED' }),
  r('T15', 'returnDraft', 'submitted', 'ic1', { hash: 'wrong' }),                                                          // no fingerprint binding on the server
  // ---- reject ----
  r('J01', 'reject', 'submitted', 'ic1'),
  r('J02', 'reject', 'reviewed', 'ic2'),
  r('J03', 'reject', 'returned', 'ic1'),
  r('J04', 'reject', 'draft', 'ic1', { expect: 'INVALID_STATE' }),
  r('J05', 'reject', 'submitted', 'ic1', { day: 'crossed' }),                                                              // allowed after the day crossed
  r('J06', 'reject', 'submitted', 'hybrid', { contributors: ['hybrid'], expect: 'CONTRIBUTOR_CANNOT_REVIEW' }),
  r('J07', 'reject', 'submitted', 'ic1', { reason: '', expect: 'REASON_REQUIRED' }),
  r('J08', 'reject', 'submitted', 'prep2', { expect: 'ROLE_NOT_ALLOWED' }),
  r('J09', 'reject', 'submitted', 'admin', { preparer: 'admin', expect: 'CONTRIBUTOR_CANNOT_REVIEW' }),
  r('J10', 'reject', 'submitted', 'ic1', { hash: 'wrong' }),                                                               // no fingerprint binding on the server
  // ---- approve ----
  r('A01', 'approve', 'reviewed', 'ic2'),
  r('A02', 'approve', 'reviewed', 'ic1'),                                                                                  // the reviewer MAY approve (decision 2026-10-14)
  r('A03', 'approve', 'reviewed', 'admin'),
  r('A04', 'approve', 'reviewed', 'admin', { preparer: 'admin', expect: 'CONTRIBUTOR_CANNOT_APPROVE' }),                  // admin is not exempt
  r('A05', 'approve', 'reviewed', 'hybrid', { contributors: ['hybrid'], expect: 'CONTRIBUTOR_CANNOT_APPROVE' }),
  r('A06', 'approve', 'submitted', 'ic2', { expect: 'INVALID_STATE' }),
  r('A07', 'approve', 'draft', 'ic2', { expect: 'INVALID_STATE' }),
  r('A08', 'approve', 'reviewed', 'ic2', { day: 'crossed', expect: 'DATE_CROSSED' }),
  r('A09', 'approve', 'reviewed', 'ic2', { hash: 'wrong', expect: 'CONTENT_CHANGED' }),
  r('A10', 'approve', 'reviewed', 'prep2', { expect: 'ROLE_NOT_ALLOWED' }),
  r('A11', 'approve', 'reviewed', 'hybrid', { contributors: ['hybrid'], day: 'crossed', expect: 'DATE_CROSSED' }),         // order: day before contributor
  r('A12', 'approve', 'reviewed', 'ic2', { head: 'suspended-by-ic1', expect: 'SUSPENDED_ACK_REQUIRED' }),
  r('A13', 'approve', 'reviewed', 'ic2', { head: 'suspended-by-ic1', ack: true, reason: undefined, expect: 'SUSPENDED_ACK_REQUIRED' }),
  r('A14', 'approve', 'reviewed', 'ic2', { head: 'suspended-by-ic1', ack: true, reason: 'استبدال بعد التعليق' }),
  r('A15', 'approve', 'reviewed', 'ic2', { head: 'suspended-by-ic1', ack: false, reason: 'سبب', expect: 'SUSPENDED_ACK_REQUIRED' }),
  r('A16', 'approve', 'reviewed', 'ic2', { head: 'suspended-by-ic2', ack: true, reason: 'سبب', expect: 'SUSPENDER_CANNOT_RESTORE' }),
  r('A17', 'approve', 'reviewed', 'ic2', { head: 'effective', ack: true, reason: 'ملاحظة' }),                              // not suspended: ack and reason are accepted
  r('A18', 'approve', 'reviewed', 'ic2', { reason: '', expect: 'REASON_REQUIRED' }),                                       // an EMPTY reason is refused, it is not "absent"
  r('A19', 'approve', 'reviewed', 'ic2', { ack: 'yes', expect: 'ACK_INVALID' }),
  r('A20', 'approve', 'reviewed', 'ic2', { head: 'effective' }),
  r('A21', 'approve', 'reviewed', 'admin', { preparer: 'admin', storedContributors: 'none', expect: 'CONTRIBUTOR_CANNOT_APPROVE' }),   // enteredBy alone is enough (the server checks contributors AND enteredBy)                                                           // replacing an effective head needs nothing extra
]);

export function validateTable() {
  const ids = ROWS.map((x) => x.id); if (new Set(ids).size !== ids.length) throw new Error('duplicate row id');
  for (const x of ROWS) if (!PAYLOAD_KEYS[x.action]) throw new Error(`unknown action in ${x.id}`);
  return ROWS.length;
}
