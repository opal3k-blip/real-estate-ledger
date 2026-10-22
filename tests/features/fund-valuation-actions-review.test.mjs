// R1-B2 / B2-3a — review / return / reject / approve in the actions orchestrator, against the fake server ("خادم مزيّف").
// Written BEFORE the implementation. Results here are never attributed to the Firebase emulator or to a real server; the server contract itself is
// compared in fund-valuation-server-contract.test.mjs.  Run: node tests/features/fund-valuation-actions-review.test.mjs
import assert from 'node:assert/strict';
import { scopeKey } from '../../src/features/fund-valuation-requests.js';
import { makeEnv, tick, FM, IC, IC2, ADMIN, ANALYST, FUND } from '../helpers/fund-valuation-server-fake.mjs';
import { createFundValuationReader } from '../../src/features/fund-valuation-reader.js';
import { makeFakeSubscribe } from '../helpers/fund-valuation-fakes.mjs';
import { documentHashHex } from '../../src/domain/validation/document-hash.js';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); console.error(String(e && e.stack || e).split('\n').slice(0, 6).join('\n')); } }

const DAYSTR = '2026-10-11';
const longText = (n) => 'ر'.repeat(n);
/** an environment whose server holds ONE draft (V1) in `state`; the view has caught up */
async function envWith(state, { session = IC, enteredBy = 'fm@example.com', contributors = [], head = null, reviewer = 'ic@example.com', ...rest } = {}) {
  const env = makeEnv({ session, ...rest });
  if (head) env.server.seedHead({ valuationDate: DAYSTR, headId: 'H0', version: 1, suspended: head === 'suspended-by-ic' ? { by: 'ic@example.com' } : head === 'suspended-by-ic2' ? { by: 'ic2@example.com' } : null });
  const doc = await env.server.seedDraft({ valuationId: 'V1', state, enteredBy });
  for (const c of contributors) doc.contributors.push(c);
  if (state === 'reviewed') doc.review = { reviewedBy: reviewer, reviewedContentHash: doc.contentHash };
  env.publish();
  return env;
}
const av = (env) => env.actions.getState().available;
const scopeOf = (env) => scopeKey({ user: env.box.s.email, fundId: FUND, valuationDate: DAYSTR });
const calls = (env, c) => env.server.calls.filter((x) => x.callable === c);
const hashOf = (env) => env.server.docOf('V1').contentHash;
const awaiting = (env) => env.actions.getState().awaiting;
async function go(env, action, opts) { const p = env.actions.prepare(action, opts); if (p.status !== 'ready') return p; return env.actions.confirm(p.token); }

/* ================= 1. who may start what (hand-written expectations; compared with the server in the contract test) ================= */
await t('G1 review: a senior_ic or admin who is not a contributor may; fund_manager, analyst and a contributor may not', async () => {
  assert.equal(av(await envWith('submitted', { session: IC })).review.allowed, true);
  assert.equal(av(await envWith('submitted', { session: ADMIN })).review.allowed, true);
  assert.equal(av(await envWith('submitted', { session: FM })).review.reason, 'ROLE_NOT_ALLOWED');
  const hybrid = av(await envWith('submitted', { session: IC, contributors: ['ic@example.com'] })).review;
  assert.deepEqual([hybrid.allowed, hybrid.reason], [false, 'CONTRIBUTOR_CANNOT_REVIEW']);
  const adminPrep = av(await envWith('submitted', { session: ADMIN, enteredBy: 'admin@example.com', contributors: ['admin@example.com'] })).review;
  assert.deepEqual([adminPrep.allowed, adminPrep.reason], [false, 'CONTRIBUTOR_CANNOT_REVIEW']);
});
await t('G2 approve: not the preparer (admin is not exempt), not a contributor; the reviewer MAY approve; state must be reviewed', async () => {
  assert.equal(av(await envWith('reviewed', { session: IC2 })).approve.allowed, true);
  assert.equal(av(await envWith('reviewed', { session: IC })).approve.allowed, true, 'the reviewer himself');
  assert.equal(av(await envWith('reviewed', { session: ADMIN })).approve.allowed, true);
  const a = av(await envWith('reviewed', { session: ADMIN, enteredBy: 'admin@example.com', contributors: ['admin@example.com'] })).approve;
  assert.deepEqual([a.allowed, a.reason], [false, 'CONTRIBUTOR_CANNOT_APPROVE']);
  const h = av(await envWith('reviewed', { session: IC2, contributors: ['ic2@example.com'] })).approve;
  assert.deepEqual([h.allowed, h.reason], [false, 'CONTRIBUTOR_CANNOT_APPROVE']);
  { // the preparer is refused even when the contributors list does not name him (the server checks BOTH: contributors and enteredBy)
    const e = await envWith('reviewed', { session: ADMIN, enteredBy: 'admin@example.com' }); e.server.vals.get('V1').contributors.length = 0; e.publish();
    const x = av(e).approve; assert.deepEqual([x.allowed, x.reason], [false, 'CONTRIBUTOR_CANNOT_APPROVE']);
  }
  assert.equal(av(await envWith('submitted', { session: IC2 })).approve.reason, 'INVALID_STATE');
  assert.equal(av(await envWith('reviewed', { session: FM })).approve.reason, 'ROLE_NOT_ALLOWED');
  const an = await envWith('reviewed', { session: ANALYST });   // an analyst has no read access at all: no session (same as submit today), nothing offered, nothing prepared
  assert.equal(an.actions.getState().session, null); assert.deepEqual(an.actions.prepare('approve'), { status: 'blocked', code: 'NO_CONTEXT' });
});
await t('G3 states: return needs submitted|reviewed; reject needs submitted|reviewed|returned (never draft)', async () => {
  for (const [s, ret, rej] of [['draft', false, false], ['returned', false, true], ['submitted', true, true], ['reviewed', true, true]]) {
    const a = av(await envWith(s, { session: IC }));
    assert.equal(a.returnDraft.allowed, ret, `return/${s}`); assert.equal(a.reject.allowed, rej, `reject/${s}`);
  }
});
await t('G4 the Riyadh day: review and approve are refused after it crosses; return and reject are NOT', async () => {
  const e1 = await envWith('submitted', { session: IC }); e1.view.selectedDate = DAYSTR; e1.clock.now = new Date('2026-10-12T10:00:00Z'); e1.actions.sync();
  const a1 = av(e1); assert.equal(a1.review.reason, 'DATE_CROSSED'); assert.equal(a1.returnDraft.allowed, true); assert.equal(a1.reject.allowed, true);
  const e2 = await envWith('reviewed', { session: IC2 }); e2.view.selectedDate = DAYSTR; e2.clock.now = new Date('2026-10-12T10:00:00Z'); e2.actions.sync();
  assert.equal(av(e2).approve.reason, 'DATE_CROSSED');
});
await t('G5 the approve gate reads the HEAD the reader reports: unknown / not verified / inconsistent are refused, never guessed', async () => {
  for (const [mode, code] of [[{ kind: 'verifying', headId: 'H0' }, 'HEAD_NOT_VERIFIED'], [{ kind: 'inconsistent', headId: 'H0', reason: 'HEAD_HASH_MISMATCH' }, 'HEAD_INCONSISTENT'], [{ kind: 'eligibility-unknown', headId: 'H0', eligibility: null }, 'HEAD_STATE_UNKNOWN']]) {
    const env = await envWith('reviewed', { session: IC2 }); env.view.approvedMode = mode; env.actions.sync();
    assert.equal(av(env).approve.reason, code);
    assert.deepEqual(env.actions.prepare('approve'), { status: 'blocked', code });
  }
  const old = await envWith('reviewed', { session: IC2 }); old.view.approvedMode = 'unknown'; old.actions.sync();
  assert.equal(av(old).approve.reason, 'HEAD_STATE_UNKNOWN', 'a reader that does not report the head: fail closed');
});
await t('G6 only actions not yet in scope are refused as unknown (B2-4a: suspend / reinstate are in scope and covered by fund-valuation-eligibility-actions.test.mjs)', async () => {
  const env = await envWith('reviewed', { session: IC2 });
  for (const a of ['preview', 'createDraft']) assert.deepEqual(env.actions.prepare(a), { status: 'blocked', code: 'ACTION_UNKNOWN' }, a);
});

/* ================= 2. the requests that are sent ================= */
await t('P1 review: prepare -> confirm sends exactly {requestId, valuationId, expectedContentHash}; one effect', async () => {
  const env = await envWith('submitted'); const hash = hashOf(env);
  const p = env.actions.prepare('review');
  assert.equal(p.status, 'ready'); assert.equal(p.limits.notBoundToContent, false); assert.equal(p.summary.contentHash, hash); assert.equal(p.summary.action, 'review');
  const r = await env.actions.confirm(p.token); assert.equal(r.status, 'success_waiting_view');
  const c = calls(env, 'reviewValuation'); assert.equal(c.length, 1);
  assert.deepEqual(Object.keys(c[0].payload).sort(), ['expectedContentHash', 'requestId', 'valuationId']); assert.equal(c[0].payload.expectedContentHash, hash);
  assert.equal(env.server.effectsOf('review'), 1);
});
await t('P2 review refuses a reason (it would be silently dropped otherwise)', async () => {
  const env = await envWith('submitted');
  assert.deepEqual(env.actions.prepare('review', { reason: 'ملاحظة' }), { status: 'blocked', code: 'REASON_NOT_ACCEPTED' });
  assert.equal(env.server.calls.length, 0);
});
for (const [action, callable] of [['returnDraft', 'returnValuation'], ['reject', 'rejectValuation']]) {
  await t(`P3 ${action}: a reason is required (missing, blank, > 1000); the payload carries it trimmed and nothing else; not bound to the content`, async () => {
    const env = await envWith('submitted');
    for (const bad of [undefined, '', '   \n', longText(1001)]) assert.deepEqual(env.actions.prepare(action, bad === undefined ? {} : { reason: bad }), { status: 'blocked', code: 'REASON_REQUIRED' }, JSON.stringify(bad));
    assert.equal(env.server.calls.length, 0);
    const p = env.actions.prepare(action, { reason: `  ${longText(1000)}  `.slice(0, 1000) }); // exactly 1000 incl. spaces
    assert.equal(p.status, 'ready');
    const p2 = env.actions.prepare(action, { reason: '  السعر لا يطابق التقرير  ' });
    assert.equal(p2.status, 'ready'); assert.equal(p2.limits.notBoundToContent, true); assert.equal(p2.summary.reason, 'السعر لا يطابق التقرير');
    assert.equal((await env.actions.confirm(p2.token)).status, 'success_waiting_view');
    const c = calls(env, callable); assert.equal(c.length, 1);
    assert.deepEqual(Object.keys(c[0].payload).sort(), ['reason', 'requestId', 'valuationId']); assert.equal(c[0].payload.reason, 'السعر لا يطابق التقرير');
  });
}
await t('P4 approve: no reason / ack keys unless asked; a reason is sent trimmed; ack is never sent for a head that is not suspended', async () => {
  const e1 = await envWith('reviewed', { session: IC2 });
  assert.equal((await go(e1, 'approve')).status, 'success_waiting_view');
  assert.deepEqual(Object.keys(calls(e1, 'approveValuation')[0].payload).sort(), ['expectedContentHash', 'requestId', 'valuationId']);
  const e2 = await envWith('reviewed', { session: IC2, head: 'effective' });
  assert.equal((await go(e2, 'approve', { reason: '  ملاحظة  ', acknowledgeSuspended: true })).status, 'success_waiting_view');
  const p2 = calls(e2, 'approveValuation')[0].payload; assert.equal(p2.reason, 'ملاحظة'); assert.equal('acknowledgeSuspended' in p2, false, 'ack on a head that is not suspended is not sent');
  const e3 = await envWith('reviewed', { session: IC2 });
  assert.deepEqual(e3.actions.prepare('approve', { reason: '   ' }).status, 'ready', 'a blank optional reason is simply absent');
  assert.deepEqual(e3.actions.prepare('approve', { reason: longText(1001) }), { status: 'blocked', code: 'REASON_REQUIRED' });
});
await t('P5 approve on a SUSPENDED head: acknowledgement AND a reason are required; the suspender may not; both are sent', async () => {
  const env = await envWith('reviewed', { session: IC2, head: 'suspended-by-ic' });
  for (const o of [{}, { acknowledgeSuspended: true }, { reason: 'سبب' }, { acknowledgeSuspended: false, reason: 'سبب' }, { acknowledgeSuspended: true, reason: '  ' }, { acknowledgeSuspended: 'yes', reason: 'سبب' }]) {
    assert.deepEqual(env.actions.prepare('approve', o), { status: 'blocked', code: 'SUSPENDED_ACK_REQUIRED' }, JSON.stringify(o));
  }
  assert.equal(env.server.calls.length, 0);
  const r = await go(env, 'approve', { acknowledgeSuspended: true, reason: 'استبدال بعد التعليق' });
  assert.equal(r.status, 'success_waiting_view');
  const p = calls(env, 'approveValuation')[0].payload; assert.equal(p.acknowledgeSuspended, true); assert.equal(p.reason, 'استبدال بعد التعليق');
  const self = await envWith('reviewed', { session: IC, head: 'suspended-by-ic', reviewer: 'ic2@example.com' });
  assert.deepEqual(self.actions.prepare('approve', { acknowledgeSuspended: true, reason: 'سبب' }), { status: 'blocked', code: 'SUSPENDER_CANNOT_RESTORE' });
});

/* ================= 3. control 1 — the saved request and its reason are fixed ================= */
await t('C1 an ambiguous return keeps its original payload and requestId: a new reason cannot start a second request, retry resends the original verbatim', async () => {
  const env = await envWith('submitted'); env.server.dropReplyOnce = true;
  const r = await go(env, 'returnDraft', { reason: 'السبب الأول' });
  assert.equal(r.status, 'ambiguous');
  const first = calls(env, 'returnValuation')[0].payload; assert.equal(first.reason, 'السبب الأول');
  const entry = env.runner.get(scopeOf(env)); assert.equal(entry.payload.reason, 'السبب الأول'); assert.equal(entry.requestId, first.requestId);
  // she edits the reason and asks again: nothing may be sent, the saved request is not touched
  assert.deepEqual(env.actions.prepare('returnDraft', { reason: 'سبب معدّل' }), { status: 'blocked', code: 'PENDING_EXISTS' });
  assert.deepEqual(env.actions.prepare('reject', { reason: 'سبب آخر' }), { status: 'blocked', code: 'PENDING_EXISTS' });
  assert.equal(calls(env, 'returnValuation').length, 1);
  assert.equal(env.runner.get(scopeOf(env)).payload.reason, 'السبب الأول');
  // retry: the very same payload and requestId
  const rr = await env.actions.retryPending(scopeOf(env));
  assert.equal(rr.status, 'success_waiting_view');
  const all = calls(env, 'returnValuation'); assert.equal(all.length, 2);
  assert.deepEqual(all[1].payload, first, 'verbatim');
  assert.equal(env.server.effectsOf('returnDraft'), 1, 'one effect for two sends');
});
await t('C2 a prepared confirmation holds its own copy: editing the options object or the returned summary afterwards changes nothing', async () => {
  const env = await envWith('submitted'); const opts = { reason: 'الأصل' };
  const p = env.actions.prepare('returnDraft', opts); opts.reason = 'تغيير بعد التحضير'; p.summary.reason = 'تغيير آخر';
  await env.actions.confirm(p.token);
  assert.equal(calls(env, 'returnValuation')[0].payload.reason, 'الأصل');
});
await t('C3 preparing again replaces the earlier confirmation: the old token sends nothing; only the new one does (with the new reason)', async () => {
  const env = await envWith('submitted');
  const a = env.actions.prepare('returnDraft', { reason: 'أ' }); const b = env.actions.prepare('returnDraft', { reason: 'ب' });
  assert.deepEqual(await env.actions.confirm(a.token), { status: 'blocked', code: 'NOT_PREPARED' });
  assert.equal(env.server.calls.length, 0);
  await env.actions.confirm(b.token); assert.equal(calls(env, 'returnValuation')[0].payload.reason, 'ب');
});
await t('C4 an ambiguous approve with acknowledgement + reason is retried with both, even if the view has since changed; the retry is not gated by state', async () => {
  const env = await envWith('reviewed', { session: IC2, head: 'suspended-by-ic' }); env.server.dropReplyOnce = true;
  const r = await go(env, 'approve', { acknowledgeSuspended: true, reason: 'استبدال' }); assert.equal(r.status, 'ambiguous');
  const first = calls(env, 'approveValuation')[0].payload;
  env.publishFresh();                                     // the view now shows the approval (the effect did happen)
  const rr = await env.actions.retryPending(scopeOf(env)); assert.ok(['success_waiting_view', 'no_effect'].includes(rr.status), rr.status);
  assert.deepEqual(calls(env, 'approveValuation')[1].payload, first);
  assert.equal(env.server.effectsOf('approve'), 1);
});
await t('C5 a refused first attempt (definitive) leaves no pending request; a new reason then starts a NEW request with a new id', async () => {
  const env = await envWith('submitted'); env.server.failBeforeOnce = 'failed-precondition';
  const r = await go(env, 'returnDraft', { reason: 'أ' }); assert.equal(r.status, 'no_effect');
  assert.equal(env.runner.get(scopeOf(env)), null);
  const r2 = await go(env, 'returnDraft', { reason: 'ب' }); assert.equal(r2.status, 'success_waiting_view');
  const c = calls(env, 'returnValuation'); assert.notEqual(c[0].payload.requestId, c[1].payload.requestId); assert.equal(c[1].payload.reason, 'ب');
});

/* ================= 4. control 2 — after success, no new action on the old view ================= */
const ALL4 = ['review', 'returnDraft', 'reject', 'approve'];
await t('W1 review succeeded: every new action is blocked (AWAITING_VIEW) until a CONFIRMED view shows the effect, timers included', async () => {
  const env = await envWith('submitted', { timers: true }); await go(env, 'review');
  assert.ok(awaiting(env)); for (const a of ALL4) assert.equal(av(env)[a].allowed, false, a);
  assert.equal(av(env).returnDraft.reason, 'AWAITING_VIEW');
  env.fire(8000); assert.equal(awaiting(env).phase, 'delayed'); env.fire(20000); assert.equal(awaiting(env).phase, 'stalled');
  for (const a of ALL4) assert.equal(av(env)[a].reason, 'AWAITING_VIEW', `${a} after both timers`);
  assert.deepEqual(env.actions.prepare('returnDraft', { reason: 'x' }), { status: 'blocked', code: 'AWAITING_VIEW' });
  env.publish({ stale: true }); assert.ok(awaiting(env), 'a stale snapshot never releases');
  env.publishFresh(); assert.equal(awaiting(env), null); assert.equal(env.actions.getState().outcome.status, 'reflected');
  assert.equal(av(env).approve.allowed, true, 'now the approve can start, on the NEW view');
});
await t('W2 approve succeeded: the head naming this valuation is the evidence; before it, approve/return/reject stay blocked, even after the timers', async () => {
  const env = await envWith('reviewed', { session: IC2, timers: true }); await go(env, 'approve');
  assert.ok(awaiting(env)); env.fire(8000); env.fire(20000);
  for (const a of ALL4) assert.equal(av(env)[a].reason, 'AWAITING_VIEW', a);
  env.publish({ stale: true }); assert.ok(awaiting(env));
  env.publishFresh(); assert.equal(awaiting(env), null); assert.equal(env.actions.getState().outcome.status, 'reflected');
});
await t('W3 reject succeeded: an EMPTY slot proves nothing by itself (listener data); only a confirmed read started after the reply ends the wait', async () => {
  const env = await envWith('submitted'); await go(env, 'reject', { reason: 'مرفوض' });
  assert.ok(awaiting(env));
  env.publish();                                                   // listener snapshot: the slot is empty, but it carries no order
  assert.ok(awaiting(env), 'absence without order is not evidence');
  env.publishFresh(); assert.equal(awaiting(env), null); assert.equal(env.actions.getState().outcome.status, 'reflected');
});
await t('W4 return succeeded: the view showing the draft as returned ends the wait (identity); the old submitted view does not', async () => {
  const env = await envWith('submitted'); await go(env, 'returnDraft', { reason: 'للتعديل' });
  env.view.drafts.set(DAYSTR, { ...env.view.drafts.get(DAYSTR), state: 'submitted' }); env.actions.sync(); assert.ok(awaiting(env));
  env.publishFresh(); assert.equal(awaiting(env), null);
});
await t('W5 overtaken: the effect was applied, then someone else moved the draft on; a confirmed later read shows another state -> view_overtaken, not "reflected"', async () => {
  const env = await envWith('submitted'); await go(env, 'review');
  env.server.vals.get('V1').state = 'returned'; env.server.vals.get('V1').rev += 1;       // another person returned it after our review
  env.publishFresh();
  assert.equal(awaiting(env), null); assert.equal(env.actions.getState().outcome.status, 'view_overtaken');
  assert.ok(env.actions.getState().banners.some((b) => b.kind === 'view_overtaken'));
});
await t('W5b approve overtaken: after our approval another version became the head; a confirmed later read shows it -> view_overtaken', async () => {
  const env = await envWith('reviewed', { session: IC2 }); await go(env, 'approve');
  env.server.heads.set(`${FUND}::${DAYSTR}`, { headId: 'H9', version: 2, eligibility: { state: 'ELIGIBLE', changedBy: 'x@example.com' } });
  env.publishFresh(); assert.equal(awaiting(env), null); assert.equal(env.actions.getState().outcome.status, 'view_overtaken');
});
await t('W6 a session change during the wait clears it at once (gates never delay clearing)', async () => {
  const env = await envWith('submitted'); await go(env, 'review'); assert.ok(awaiting(env));
  env.setSession(IC2); env.actions.sync(); assert.equal(env.actions.getState().awaiting, null);
  env.setSession(null); env.actions.sync(); assert.equal(env.actions.stats().awaiting, 0);
});

/* ---- W7 (reviewer rounds 2026-10-14): neither a state NAME nor a mark of ours on a later revision is the identity of THIS request — cycles repeat ---- */
const markOf = (action, who, hash) => (action === 'review' ? { review: { reviewedBy: who, reviewedContentHash: hash } } : { returnedBy: who, returnReason: 'للتعديل' });
for (const [action, state, opts, preRev] of [['review', 'reviewed', undefined, 13], ['returnDraft', 'returned', { reason: 'للتعديل' }, 12]]) {
  await t(`W7 ${action}: repeated cycle — a snapshot of an EARLIER cycle (same user's mark, same hash, state "${state}", revision between the view and the effect) never ends the wait; only a read started after the reply does`, async () => {
    const env = await envWith('submitted'); env.server.vals.get('V1').rev = 10; env.publish();           // the view shows rev 10
    const before = env.server.docOf('V1');
    env.server.vals.get('V1').rev = preRev;                                                                 // cycles happened meanwhile; the effect of THIS request will land above them
    assert.equal((await go(env, action, opts)).status, 'success_waiting_view'); assert.ok(awaiting(env));
    const effectRev = env.server.docOf('V1').rev; assert.ok(effectRev > preRev);
    const earlier = { ...before, state, rev: 11, ...markOf(action, 'ic@example.com', before.contentHash) };   // our mark, the same hash and reason, but from a previous cycle
    env.view.drafts.set(DAYSTR, earlier); env.view.status = 'ready'; env.actions.sync();
    assert.ok(awaiting(env), 'an earlier cycle is not evidence'); assert.notEqual(env.actions.getState().outcome.status, 'reflected');
    for (const stale of [{ ...before, state, rev: 2, contentHash: 'b'.repeat(64) }, { ...before, state, rev: 11, ...markOf(action, 'someone@else.com', before.contentHash) }]) {
      env.view.drafts.set(DAYSTR, stale); env.actions.sync(); assert.ok(awaiting(env), 'a name alone, or another person\'s mark, is not evidence');
    }
    env.view.drafts.set(DAYSTR, env.server.docOf('V1')); env.actions.sync();                                // even the real post-effect document, delivered by a listener, carries no order
    assert.ok(awaiting(env), 'listener data proves no order: the wait continues until a confirmed read that started after the reply');
    env.publishFresh(); assert.equal(awaiting(env), null); assert.equal(env.actions.getState().outcome.status, 'reflected');
  });
  await t(`W7b ${action}: a confirmed read started after the reply that shows ANOTHER state is view_overtaken; the expected state is reflected`, async () => {
    const env = await envWith('submitted'); await go(env, action, opts);
    env.server.vals.get('V1').state = action === 'review' ? 'returned' : 'reviewed'; env.server.vals.get('V1').rev += 1;
    env.publishFresh(); assert.equal(awaiting(env), null); assert.equal(env.actions.getState().outcome.status, 'view_overtaken');
  });
}
await t('W7c a retry is never released by a listener snapshot, only by an ordered read', async () => {
  const env = await envWith('submitted'); env.server.dropReplyOnce = true;
  assert.equal((await go(env, 'review')).status, 'ambiguous');
  const rr = await env.actions.retryPending(scopeOf(env)); assert.equal(rr.status, 'success_waiting_view');
  env.publish(); assert.ok(awaiting(env), 'listener data: no ordering evidence');
  env.publishFresh(); assert.equal(awaiting(env), null);
});
await t('W7d submit (B2-2 narrow fix, same defect): an earlier "submitted" snapshot of the same draft never ends the wait; a read started after the reply does; "withdraw" is unchanged (terminal)', async () => {
  const env = await envWith('draft', { session: FM }); env.server.vals.get('V1').rev = 3; env.publish();
  const before = env.server.docOf('V1'); env.server.vals.get('V1').rev = 8;                                  // an earlier submit/return cycle happened; this submit lands at rev 9
  assert.equal((await go(env, 'submit')).status, 'success_waiting_view'); assert.ok(awaiting(env));
  env.view.drafts.set(DAYSTR, { ...before, state: 'submitted', rev: 5 }); env.view.status = 'ready'; env.actions.sync();
  assert.ok(awaiting(env), 'the name "submitted" from an earlier cycle is not evidence');
  env.view.drafts.set(DAYSTR, env.server.docOf('V1')); env.actions.sync(); assert.ok(awaiting(env), 'listener data carries no order');
  env.publishFresh(); assert.equal(awaiting(env), null); assert.equal(env.actions.getState().outcome.status, 'reflected');
  const w = await envWith('draft', { session: FM }); await go(w, 'withdraw');
  if (awaiting(w)) { w.view.drafts.set(DAYSTR, w.server.docOf('V1')); w.actions.sync(); assert.equal(awaiting(w), null, 'withdrawn is terminal: the state name is an identity'); }
});

/* ---- P6 (reviewer round): a preview whose reply is for ANOTHER fingerprint is not a statement about the content on screen ---- */
await t('P6 a preview reply with a different fingerprint is "mismatch": not done, not shown as a result in the summary or the state', async () => {
  const env = await envWith('submitted');
  const shown = hashOf(env);
  await env.server.externalEdit('V1', { ...env.server.docOf('V1'), residualValue: 1234 });   // the server holds B; the view still shows A
  assert.notEqual(env.server.docOf('V1').contentHash, shown);
  const c = await env.actions.checkNow(); assert.equal(c.status, 'mismatch');
  const st = env.actions.getState(); assert.equal(st.preview.status, 'mismatch'); assert.equal(st.preview.reply, null);
  assert.equal(st.preview.mismatch.shown, shown); assert.notEqual(st.preview.mismatch.replied, shown);
  const p = env.actions.prepare('review'); assert.equal(p.status, 'ready'); assert.equal(p.summary.preview.status, 'mismatch'); assert.equal(p.summary.preview.candidate, undefined);
  assert.equal(p.summary.contentHash, shown, 'the confirmation still names what the user sees');
});
await t('P7 a preview reply that names another valuation, or carries no fingerprint, is also "mismatch"; a matching one is done and is shown', async () => {
  const env = await envWith('submitted'); const orig = env.server.handle;
  for (const patch of [{ valuationId: 'OTHER' }, { contentHash: null }]) {
    env.server.handle = async (e, c, p) => { const r = await orig(e, c, p); return c === 'getValuationPreview' ? { ...r, ...patch } : r; };
    assert.equal((await env.actions.checkNow()).status, 'mismatch', JSON.stringify(patch));
  }
  env.server.handle = orig;
  assert.equal((await env.actions.checkNow()).status, 'done');
  const p = env.actions.prepare('review'); assert.equal(p.summary.preview.status, 'done');
});

/* ================= 5. what an old confirmation does and does not protect ================= */
await t('V1 the view changed after prepare (content): the old confirmation is invalid and nothing is sent', async () => {
  const env = await envWith('reviewed', { session: IC2 }); const p = env.actions.prepare('approve');
  await env.server.externalEdit('V1', { ...env.server.docOf('V1'), residualValue: 5 }); env.publish();
  const r = await env.actions.confirm(p.token); assert.equal(r.status, 'blocked'); assert.equal(r.code, 'VIEW_CHANGED'); assert.ok(r.changed.includes('contentHash'));
  assert.equal(env.server.calls.length, 0);
});
await t('V2 the state changed after prepare (reviewed by someone else, then returned): old confirmation is invalid for return and reject too', async () => {
  const env = await envWith('submitted'); const p = env.actions.prepare('reject', { reason: 'س' });
  env.server.vals.get('V1').state = 'reviewed'; env.server.vals.get('V1').rev += 1; env.publish();
  const r = await env.actions.confirm(p.token); assert.equal(r.code, 'VIEW_CHANGED'); assert.ok(r.changed.includes('state'));
  assert.equal(env.server.calls.length, 0);
});
await t('V3 the head changed after prepare (suspended -> effective): the approve confirmation is invalid', async () => {
  const env = await envWith('reviewed', { session: IC2, head: 'suspended-by-ic' }); const p = env.actions.prepare('approve', { acknowledgeSuspended: true, reason: 'ر' });
  assert.equal(p.status, 'ready');
  env.server.seedHead({ valuationDate: DAYSTR, headId: 'H0', version: 1, suspended: null }); env.publish();
  const r = await env.actions.confirm(p.token); assert.equal(r.code, 'VIEW_CHANGED'); assert.equal(env.server.calls.length, 0);
});
await t('V4 the session changed after prepare: nothing is sent', async () => {
  const env = await envWith('submitted'); const p = env.actions.prepare('review'); assert.equal(p.status, 'ready');
  env.setSession(IC2); env.actions.sync(); const r = await env.actions.confirm(p.token);
  assert.equal(r.status, 'blocked'); assert.equal(env.server.calls.length, 0);
});
await t('V5 KNOWN LIMIT (documented, accepted 2026-10-14): return/reject carry no server fingerprint; a change the VIEW has not yet seen is NOT stopped by the client', async () => {
  const env = await envWith('submitted'); const p = env.actions.prepare('returnDraft', { reason: 'س' });
  assert.equal(p.limits.notBoundToContent, true);
  await env.server.externalEdit('V1', { ...env.server.docOf('V1'), residualValue: 7 });         // changed on the server; the view was NOT updated
  const r = await env.actions.confirm(p.token);
  assert.equal(r.status, 'success_waiting_view', 'the client cannot know; the server has no binding for return/reject');
  assert.equal(env.server.effectsOf('returnDraft'), 1);
});
await t('V6 review and approve ARE bound by the server: the same unseen change is refused with CONTENT_CHANGED (definitive, no effect)', async () => {
  const env = await envWith('submitted'); const p = env.actions.prepare('review'); assert.equal(p.limits.notBoundToContent, false);
  await env.server.externalEdit('V1', { ...env.server.docOf('V1'), residualValue: 7 });
  const r = await env.actions.confirm(p.token); assert.equal(r.status, 'no_effect'); assert.equal(r.code, 'CONTENT_CHANGED'); assert.equal(env.server.effectsOf('review'), 0);
});
await t('V7 the server refuses a contributor: CONTRIBUTOR_CANNOT_* is shown as is (a client that thought otherwise would be corrected by the server)', async () => {
  const env = await envWith('submitted', { session: IC }); env.server.vals.get('V1').contributors.push('ic@example.com');   // unseen by the view
  const r = await go(env, 'review'); assert.equal(r.status, 'no_effect'); assert.equal(r.code, 'CONTRIBUTOR_CANNOT_REVIEW');
});

await t('V8 the view stopped being confirmed after prepare (stale): the gate is re-run at confirm and nothing is sent, although the viewed fields are unchanged', async () => {
  const env = await envWith('submitted'); const p = env.actions.prepare('review'); assert.equal(p.status, 'ready');
  env.publish({ stale: true });
  const r = await env.actions.confirm(p.token); assert.deepEqual([r.status, r.code], ['blocked', 'VIEW_NOT_CONFIRMED']); assert.equal(env.server.calls.length, 0);
});

/* ================= 5b. the REAL reader reports the head ================= */
await t('R1 the REAL reader reports the effective head to the orchestrator: suspended -> acknowledgement + reason; no head -> none; head named by the draft slot', async () => {
  const env = makeEnv({ session: IC2 }); const fake = makeFakeSubscribe();
  const reader = createFundValuationReader({ subscribe: fake.subscribe, getSession: () => env.box.s, onChange: () => env.actions.sync(), fetchOnce: async () => ({ docs: [], fromCache: false }) });
  env.hooks.getContext = (d) => reader.contextFor(d === undefined ? DAYSTR : d);
  reader.open(FUND);
  const contentHash = 'a'.repeat(64);
  const headDoc = { valuationId: 'H0', fundId: FUND, valuationDate: DAYSTR, state: 'approved', status: 'approved', version: 1, contentHash, approvedBy: 'ic@example.com', approvedAt: '2026-10-11T08:00:00.000Z' };
  const headHash = await documentHashHex({ valuationId: 'H0', version: 1, contentHash, approvedBy: 'ic@example.com' });
  await env.server.seedDraft({ valuationId: 'V1', state: 'reviewed' }); const v1 = env.server.docOf('V1'); v1.review = { reviewedBy: 'ic@example.com', reviewedContentHash: v1.contentHash };
  const emit = async (eligibility) => {
    fake.emit('heads', FUND, [{ id: `${FUND}__${DAYSTR}`, data: { fundId: FUND, valuationDate: DAYSTR, headId: 'H0', version: 1, headHash, eligibility, activeDraftId: 'V1' } }], false);
    fake.emit('valuations', FUND, [{ id: 'H0', data: headDoc }, { id: 'V1', data: v1 }], false); fake.emit('events', FUND, [], false); await tick(30);
  };
  await emit({ state: 'SUSPENDED', changedBy: 'ic@example.com', reasonCode: 'SUSPENDED', reason: 'x' });
  assert.equal(reader.contextFor(DAYSTR).approved.kind, 'suspended');
  assert.deepEqual(env.actions.prepare('approve'), { status: 'blocked', code: 'SUSPENDED_ACK_REQUIRED' });
  const ok = env.actions.prepare('approve', { acknowledgeSuspended: true, reason: 'استبدال' }); assert.equal(ok.status, 'ready'); assert.equal(ok.summary.head.suspended, true); assert.equal(ok.summary.head.headId, 'H0');
  await emit({ state: 'ELIGIBLE', changedBy: 'ic@example.com', reasonCode: 'APPROVED' });
  assert.equal(reader.contextFor(DAYSTR).approved.kind, 'effective');
  const r = await env.actions.confirm(ok.token); assert.deepEqual([r.status, r.code], ['blocked', 'VIEW_CHANGED'], 'the head changed (suspended -> effective) after prepare');
  assert.equal(env.actions.prepare('approve').status, 'ready', 'a head that is effective needs no acknowledgement');
});

/* ================= 6. nothing leaks between users / scopes ================= */
await t('S1 a prepared confirmation does not survive a user switch; state of the other user is not shown', async () => {
  const env = await envWith('submitted'); const p = env.actions.prepare('review'); assert.equal(p.status, 'ready');
  env.setSession(IC2); env.actions.sync(); assert.equal(env.actions.getState().available.review.allowed, true);
  assert.deepEqual(await env.actions.confirm(p.token), { status: 'blocked', code: 'NOT_PREPARED' });
  assert.equal(env.server.calls.length, 0);
});

await t('R1b FIRST APPROVAL: with the REAL reader and NO approved head (it reports kind "none", not null) approve is allowed on a confirmed view', async () => {
  const env = makeEnv({ session: IC2 }); const fake = makeFakeSubscribe();
  const reader = createFundValuationReader({ subscribe: fake.subscribe, getSession: () => env.box.s, onChange: () => env.actions.sync(), fetchOnce: async () => ({ docs: [], fromCache: false }) });
  env.hooks.getContext = (d) => reader.contextFor(d === undefined ? DAYSTR : d);
  reader.open(FUND);
  await env.server.seedDraft({ valuationId: 'V1', state: 'reviewed' }); const v1 = env.server.docOf('V1'); v1.review = { reviewedBy: 'ic@example.com', reviewedContentHash: v1.contentHash };
  fake.emit('heads', FUND, [{ id: `${FUND}__${DAYSTR}`, data: { fundId: FUND, valuationDate: DAYSTR, headId: null, version: 0, headHash: null, eligibility: null, activeDraftId: 'V1' } }], false);
  fake.emit('valuations', FUND, [{ id: 'V1', data: v1 }], false); fake.emit('events', FUND, [], false); await tick(30); env.actions.sync();
  assert.equal(reader.contextFor(DAYSTR).approved.kind, 'none', 'the real reader reports kind none');
  assert.equal(av(env).approve.allowed, true, 'first approval is allowed: ' + JSON.stringify(av(env).approve));
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
