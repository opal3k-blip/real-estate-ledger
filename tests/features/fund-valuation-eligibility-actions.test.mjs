// R1-B2 / B2-4a — suspend / reinstate the EFFECTIVE HEAD in the actions orchestrator, against the fake server ("خادم مزيّف") and the real reader.
// Results here are never attributed to the Firebase emulator, to CI or to a real server; the server's own order of checks is compared in fund-valuation-server-contract.test.mjs.
// Run: node tests/features/fund-valuation-eligibility-actions.test.mjs
import assert from 'node:assert/strict';
import { scopeKey } from '../../src/features/fund-valuation-requests.js';
import { makeEnv, tick, FM, IC, IC2, ADMIN, FUND } from '../helpers/fund-valuation-server-fake.mjs';
import { createFundValuationReader } from '../../src/features/fund-valuation-reader.js';
import { makeFakeSubscribe, approvedPair } from '../helpers/fund-valuation-fakes.mjs';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); console.error(String(e && e.stack || e).split('\n').slice(0, 6).join('\n')); } }

const DAYSTR = '2026-10-11';
const SUSP = 'suspendValuationEligibility'; const REINST = 'reinstateValuationEligibility';
const T0 = '2026-10-11T09:00:00.000Z';
const HDOC = { contributors: ['fm@example.com'], approvedBy: 'boss@example.com' };
/** an environment whose server holds ONE approved head (H0) for the day and NO draft at all; the view has caught up */
function envHead({ session = IC, head = 'effective', headDoc = HDOC, rev, changedAt = T0, ...rest } = {}) {
  const env = makeEnv({ session, ...rest });
  const by = head === 'suspended-by-ic' ? 'ic@example.com' : head === 'suspended-by-ic2' ? 'ic2@example.com' : null;
  env.server.seedHead({ valuationDate: DAYSTR, headId: 'H0', version: 1, suspended: by ? { by } : null, rev, changedAt, headDoc });
  env.publish();
  return env;
}
const av = (env) => env.actions.getState().available;
const scopeOf = (env) => scopeKey({ user: env.box.s.email, fundId: FUND, valuationDate: DAYSTR });
const calls = (env, c) => env.server.calls.filter((x) => x.callable === c);
const awaiting = (env) => env.actions.getState().awaiting;
async function go(env, action, opts) { const p = env.actions.prepare(action, opts); if (p.status !== 'ready') return p; return env.actions.confirm(p.token); }
const ext = (env, who, action, reason = 'خارجي') => env.server.handle(who, action === 'suspend' ? SUSP : REINST, { requestId: 'ext-' + Math.random().toString(36).slice(2), fundId: FUND, valuationDate: DAYSTR, expectedHeadId: 'H0', reason });
const advance = (env, ms = 3600000) => { env.clock.now = new Date(env.clock.now.getTime() + ms); };

/* ================= 1. a head without ANY draft ================= */
await t('E1 an effective head with NO draft anywhere: suspend can be prepared and sent; nothing about a draft is needed (no DRAFT_DOC_MISSING, no NO_TARGET)', async () => {
  const env = envHead({ session: IC });
  assert.equal(env.view.drafts.size, 0); assert.equal(env.actions.getState().review, null, 'no draft: no reviewer form data');
  assert.equal(av(env).suspend.allowed, true); assert.equal(av(env).reinstate.reason, 'NOT_SUSPENDED');
  const p = env.actions.prepare('suspend', { reason: '  مراجعة  ' }); assert.equal(p.status, 'ready');
  const r = await env.actions.confirm(p.token); assert.equal(r.status, 'success_waiting_view');
  const sent = calls(env, SUSP); assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0].payload).sort(), ['expectedHeadId', 'fundId', 'reason', 'requestId', 'valuationDate']);
  assert.deepEqual({ ...sent[0].payload, requestId: undefined }, { requestId: undefined, fundId: FUND, valuationDate: DAYSTR, expectedHeadId: 'H0', reason: 'مراجعة' });
  assert.equal(env.server.effectsOf('suspend'), 1);
});
await t('E1b the same for reinstate: a suspended head with no draft; and a MISSING draft document does not block either action', async () => {
  const env = envHead({ session: IC2, head: 'suspended-by-ic' });
  assert.equal(av(env).reinstate.allowed, true); assert.equal(av(env).suspend.reason, 'ALREADY_SUSPENDED');
  env.view.drafts.set(DAYSTR, { valuationId: 'GONE', __missing: true }); env.actions.sync();
  assert.equal(av(env).reinstate.allowed, true, 'a dangling draft pointer is about the draft, not the head');
  env.view.drafts.clear(); env.actions.sync();
  const r = await go(env, 'reinstate', { reason: 'زال السبب' }); assert.equal(r.status, 'success_waiting_view');
  assert.equal(calls(env, REINST)[0].payload.expectedHeadId, 'H0'); assert.equal(env.server.effectsOf('reinstate'), 1);
});

/* ================= 2. who may, and what is required ================= */
await t('E2 roles: senior_ic and admin may; fund_manager may not (nothing prepared, nothing sent)', async () => {
  assert.equal(av(envHead({ session: IC })).suspend.allowed, true);
  assert.equal(av(envHead({ session: ADMIN })).suspend.allowed, true);
  const fm = envHead({ session: FM }); assert.equal(av(fm).suspend.reason, 'ROLE_NOT_ALLOWED');
  assert.deepEqual(fm.actions.prepare('suspend', { reason: 'x' }), { status: 'blocked', code: 'ROLE_NOT_ALLOWED' }); assert.equal(fm.server.calls.length, 0);
});
await t('E3 the reason is required (1..1000 after trim) and no acknowledgement exists; every refusal sends nothing', async () => {
  const env = envHead({ session: IC });
  for (const o of [undefined, {}, { reason: '' }, { reason: '   ' }, { reason: 5 }, { reason: null }, { reason: 'ر'.repeat(1001) }]) assert.deepEqual(env.actions.prepare('suspend', o), { status: 'blocked', code: 'REASON_REQUIRED' }, JSON.stringify(o));
  assert.deepEqual(env.actions.prepare('suspend', { reason: 'x', acknowledgeSuspended: true }), { status: 'blocked', code: 'REASON_NOT_ACCEPTED' });
  assert.equal(env.actions.prepare('suspend', { reason: 'ر'.repeat(1000) }).status, 'ready');
  assert.equal(env.server.calls.length, 0);
});
await t('E4 reinstate separation of duties: not the suspender, not a contributor, not the approver of the head valuation (admin is not exempt)', async () => {
  assert.equal(av(envHead({ session: IC2, head: 'suspended-by-ic' })).reinstate.allowed, true);
  assert.equal(av(envHead({ session: ADMIN, head: 'suspended-by-ic' })).reinstate.allowed, true);
  assert.equal(av(envHead({ session: IC, head: 'suspended-by-ic' })).reinstate.reason, 'SUSPENDER_CANNOT_RESTORE');
  assert.equal(av(envHead({ session: IC2, head: 'suspended-by-ic', headDoc: { contributors: ['fm@example.com', 'ic2@example.com'], approvedBy: 'boss@example.com' } })).reinstate.reason, 'CONTRIBUTOR_CANNOT_REINSTATE');
  assert.equal(av(envHead({ session: IC2, head: 'suspended-by-ic', headDoc: { contributors: ['fm@example.com'], approvedBy: 'IC2@example.com' } })).reinstate.reason, 'CONTRIBUTOR_CANNOT_REINSTATE');
  assert.equal(av(envHead({ session: ADMIN, head: 'suspended-by-ic', headDoc: { contributors: ['admin@example.com'], approvedBy: 'boss@example.com' } })).reinstate.reason, 'CONTRIBUTOR_CANNOT_REINSTATE');
});
await t('E5 reinstate is FAIL-CLOSED: head valuation not loaded / incomplete -> blocked (HEAD_DOC_NOT_LOADED); suspend does not depend on it', async () => {
  const none = envHead({ session: IC2, head: 'suspended-by-ic', headDoc: null });   // the view has no provenance of the head valuation
  assert.equal(av(none).reinstate.reason, 'HEAD_DOC_NOT_LOADED'); assert.deepEqual(none.actions.prepare('reinstate', { reason: 'x' }), { status: 'blocked', code: 'HEAD_DOC_NOT_LOADED' });
  const bad = envHead({ session: IC2, head: 'suspended-by-ic' }); bad.view.approvedByDate.get(DAYSTR).headValuation = { contributors: null, approvedBy: 'boss@example.com' }; bad.actions.sync();
  assert.equal(av(bad).reinstate.reason, 'HEAD_DOC_NOT_LOADED');
  bad.view.approvedByDate.get(DAYSTR).headValuation = { contributors: [], approvedBy: null }; bad.actions.sync(); assert.equal(av(bad).reinstate.reason, 'HEAD_DOC_NOT_LOADED');
  assert.equal(none.server.calls.length + bad.server.calls.length, 0);
  assert.equal(av(envHead({ session: IC, headDoc: null })).suspend.allowed, true, 'suspend needs only the head');
});
await t('E6 the head must be known, verified and consistent, and the view confirmed; otherwise NO default permission', async () => {
  for (const [mode, code] of [[{ kind: 'verifying', headId: 'H0' }, 'HEAD_NOT_VERIFIED'], [{ kind: 'inconsistent', headId: 'H0', reason: 'HEAD_HASH_MISMATCH' }, 'HEAD_INCONSISTENT'], [{ kind: 'eligibility-unknown', headId: 'H0', eligibility: null }, 'HEAD_STATE_UNKNOWN']]) {
    const env = envHead({ session: IC }); env.view.approvedMode = mode; env.actions.sync();
    for (const a of ['suspend', 'reinstate']) { assert.equal(av(env)[a].reason, code, a); assert.deepEqual(env.actions.prepare(a, { reason: 'x' }), { status: 'blocked', code }); }
  }
  const old = envHead({ session: IC }); old.view.approvedMode = 'unknown'; old.actions.sync(); assert.equal(av(old).suspend.reason, 'HEAD_STATE_UNKNOWN');
  const stale = envHead({ session: IC }); stale.publish({ stale: true }); assert.equal(av(stale).suspend.reason, 'VIEW_NOT_CONFIRMED');
  const nohead = makeEnv({ session: IC }); nohead.publish(); nohead.view.status = 'ready'; nohead.actions.sync();
  assert.equal(av(nohead).suspend.reason, 'NO_HEAD'); assert.equal(av(nohead).reinstate.reason, 'NO_HEAD');
});
await t('E7 the effect wording: eligibility only; no calculation and no rate is activated before R1-C', async () => {
  const p = envHead({ session: IC }).actions.prepare('suspend', { reason: 'x' });
  assert.equal(p.summary.effect.changesEligibilityOnly, true); assert.equal(p.summary.effect.activatesCalculations, false); assert.equal(p.summary.effect.activatesRates, false);
  for (const s of p.summary.effect.text) assert.match(s, /R1-C/);
  assert.match(p.summary.effect.text[0], /أهلية/); assert.match(p.summary.effect.text[1], /eligibility/);
  assert.equal(p.summary.targetEligibility, 'SUSPENDED');
  const q = envHead({ session: IC2, head: 'suspended-by-ic' }).actions.prepare('reinstate', { reason: 'x' }); assert.equal(q.summary.targetEligibility, 'ELIGIBLE');
  assert.equal(p.limits.boundToHeadId, true); assert.equal(p.limits.notBoundToEligibilityChange, true, 'expectedHeadId alone does not prevent every eligibility change on the same head');
});

/* ================= 3. awaiting: ONLY a confirmed server read that started after the reply ================= */
await t('E8 after the reply every action of the scope is blocked; a LISTENER snapshot, a timer, a stale snapshot and a read that started BEFORE the reply never end the wait', async () => {
  const env = envHead({ session: IC }); env.view.issued = 5;
  const r = await go(env, 'suspend', { reason: 'x' }); assert.equal(r.status, 'success_waiting_view'); assert.ok(awaiting(env));
  for (const a of ['suspend', 'reinstate', 'approve']) assert.equal(av(env)[a].reason, 'AWAITING_VIEW', a);
  env.publish();                                                   // a listener snapshot that already shows the effect
  assert.ok(awaiting(env), 'listener data proves no order');
  env.fire(8000); env.fire(20000); assert.equal(awaiting(env).phase, 'stalled'); assert.ok(awaiting(env), 'timers never release');
  env.publish({ stale: true }); assert.ok(awaiting(env));
  env.deliverRead(5); assert.ok(awaiting(env), 'a read numbered <= the high-water mark at the reply STARTED before it (it may have been in flight)');
  env.deliverRead(4); assert.ok(awaiting(env));
  env.publishFresh({ stale: true }); assert.ok(awaiting(env), 'an unconfirmed read');
  env.publishFresh(); assert.equal(awaiting(env), null); assert.equal(env.actions.getState().outcome.status, 'reflected');
});
await t('E9 a reader that reports no read marker / no `issued` can never end the wait (fail closed)', async () => {
  const a = envHead({ session: IC }); a.view.legacyRead = true; await go(a, 'suspend', { reason: 'x' }); a.publishFresh(); assert.ok(awaiting(a), 'no issued at the reply');
  const b = envHead({ session: IC }); await go(b, 'suspend', { reason: 'x' }); b.view.noRead = true; b.publish(); assert.ok(awaiting(b), 'no read marker');
});
await t('E10 an ordered read whose head data is INCOMPLETE (verifying / inconsistent / unknown) keeps the block', async () => {
  for (const mode of [{ kind: 'verifying', headId: 'H0' }, { kind: 'inconsistent', headId: 'H0', reason: 'HEAD_HASH_MISMATCH' }, { kind: 'eligibility-unknown', headId: 'H0', eligibility: null }, { kind: 'none' }]) {
    const env = envHead({ session: IC }); await go(env, 'suspend', { reason: 'x' });
    env.view.issued += 1; env.view.dataEpoch = env.view.issued; env.view.readConfirmed = true; env.view.approvedMode = mode; env.actions.sync();
    if (mode.kind === 'none') { assert.equal(awaiting(env), null, 'a verified ordered read with NO head is a different state: overtaken'); assert.equal(env.actions.getState().outcome.status, 'view_overtaken'); }
    else assert.ok(awaiting(env), mode.kind);
  }
});
await t('E11 OVERTAKEN: an ordered read shows the same head in ANOTHER state, or another head -> view_overtaken (the block is released, nothing claims our effect)', async () => {
  const a = envHead({ session: IC }); await go(a, 'suspend', { reason: 'x' });
  await ext(a, 'admin@example.com', 'reinstate'); a.publishFresh();
  assert.equal(awaiting(a), null); assert.equal(a.actions.getState().outcome.status, 'view_overtaken'); assert.ok(a.actions.getState().banners.some((b) => b.kind === 'view_overtaken'));
  const b = envHead({ session: IC }); await go(b, 'suspend', { reason: 'x' });
  b.server.seedHead({ valuationDate: DAYSTR, headId: 'H1', version: 2, headDoc: HDOC }); b.publishFresh();
  assert.equal(b.actions.getState().outcome.status, 'view_overtaken', 'another head');
});
await t('E12 REFLECTED means only "the read shows the targeted head in the requested state": a later suspend by SOMEONE ELSE looks the same, and changedBy is not used as identity', async () => {
  const env = envHead({ session: IC }); await go(env, 'suspend', { reason: 'x' });
  await ext(env, 'admin@example.com', 'reinstate'); await ext(env, 'ic2@example.com', 'suspend'); env.publishFresh();
  const o = env.actions.getState().outcome; assert.equal(o.status, 'reflected');
  assert.equal(env.actions.getState().eligibility.changedBy, 'ic2@example.com', 'the head shows another person; the verdict does not depend on it');
  assert.equal(o.by, undefined); assert.equal(o.identity, undefined);
});
await t('E13 the head action leaves a draft editor exactly as it was (dirty input survives the reflected verdict)', async () => {
  const env = envHead({ session: ADMIN }); await env.server.seedDraft({ valuationId: 'V1', state: 'draft', valuationDate: DAYSTR }); env.publish();
  assert.equal(env.actions.openActiveDraft().status, 'opened'); env.actions.setField('methodNote', 'تعديل لم يُحفظ');
  const before = JSON.stringify(env.actions.getState().editor.form);
  await go(env, 'suspend', { reason: 'x' }); env.publishFresh();
  assert.equal(env.actions.getState().outcome.status, 'reflected');
  const ed = env.actions.getState().editor; assert.equal(ed.dirty, true); assert.equal(JSON.stringify(ed.form), before);
  /* and the draft's conflict detection is not silently re-based by a head verdict: someone else changes the draft while the head request is awaited */
  const e2 = envHead({ session: ADMIN }); const doc2 = await e2.server.seedDraft({ valuationId: 'V1', state: 'draft', valuationDate: DAYSTR }); e2.publish();
  e2.actions.openActiveDraft(); e2.actions.setField('methodNote', 'كتابتي'); const hashAtOpen = doc2.contentHash;
  await go(e2, 'suspend', { reason: 'x' });
  const { goodContent } = await import('../helpers/fund-valuation-server-fake.mjs'); await e2.server.externalEdit('V1', goodContent({ methodNote: 'تعديل شخص آخر' }));
  e2.publishFresh();
  const st2 = e2.actions.getState().editor; assert.equal(e2.actions.getState().outcome.status, 'reflected');
  assert.ok(st2.serverChanged && st2.serverChanged.contentHash !== hashAtOpen, 'the draft editor still knows the server version moved under it'); assert.equal(st2.dirty, true);
});

/* ================= 4. the card and the cycle ================= */
await t('E14 CYCLE on one head (suspend -> reinstate -> suspend): a card prepared before is refused although head id, version, state and person look the same again; nothing is sent', async () => {
  const env = envHead({ session: ADMIN, head: 'suspended-by-ic2', rev: 1, changedAt: T0 });
  const p = env.actions.prepare('reinstate', { reason: 'x' }); assert.equal(p.status, 'ready'); assert.deepEqual([p.summary.head.suspended, p.summary.head.changedBy, p.summary.head.rev], [true, 'ic2@example.com', 1]);
  advance(env); await ext(env, 'ic@example.com', 'reinstate'); advance(env); await ext(env, 'ic2@example.com', 'suspend'); env.publishFresh();
  assert.deepEqual([env.actions.getState().eligibility.suspended, env.actions.getState().eligibility.changedBy], [true, 'ic2@example.com'], 'looks the same as before');
  const n = env.server.calls.length; const r = await env.actions.confirm(p.token);
  assert.deepEqual([r.status, r.code], ['blocked', 'VIEW_CHANGED']); assert.deepEqual(r.changed, ['head']); assert.equal(env.server.calls.length, n, 'no request was sent');
  assert.equal(env.server.effectsOf('reinstate'), 1, 'only the external one');
});
await t('E14b the fingerprint includes changedAt ITSELF: with no head revision in the view, a repeated cycle is still told apart by the time of the change', async () => {
  const env = envHead({ session: ADMIN, head: 'suspended-by-ic2', rev: 1, changedAt: T0 });
  const nullRev = () => { env.view.approvedByDate.get(DAYSTR).headRev = null; env.actions.sync(); };
  nullRev(); const p = env.actions.prepare('reinstate', { reason: 'x' }); assert.equal(p.status, 'ready'); assert.equal(p.summary.head.rev, null);
  advance(env); await ext(env, 'ic@example.com', 'reinstate'); advance(env); await ext(env, 'ic2@example.com', 'suspend'); env.publishFresh(); nullRev();
  const r = await env.actions.confirm(p.token); assert.deepEqual([r.status, r.code], ['blocked', 'VIEW_CHANGED']);
  assert.equal(calls(env, REINST).filter((c) => c.payload.reason === 'x').length, 0);
});
await t('E15 a card whose head changed state (or whose view was replaced by another head) is refused; a new prepare after the change is ready', async () => {
  const env = envHead({ session: IC }); const p = env.actions.prepare('suspend', { reason: 'x' });
  await ext(env, 'ic2@example.com', 'suspend'); env.publish();
  assert.deepEqual((({ status, code }) => ({ status, code }))(await env.actions.confirm(p.token)), { status: 'blocked', code: 'VIEW_CHANGED' });
  assert.equal(env.actions.prepare('suspend', { reason: 'x' }).code, 'ALREADY_SUSPENDED');
  const q = env.actions.prepare('reinstate', { reason: 'y' }); assert.equal(q.status, 'ready');
  env.server.seedHead({ valuationDate: DAYSTR, headId: 'H1', version: 2, headDoc: HDOC }); env.publish();
  assert.equal((await env.actions.confirm(q.token)).code, 'VIEW_CHANGED');
});
await t('E16 the card is fixed at prepare time: the sent reason and head are the prepared ones; a token is single-use', async () => {
  const env = envHead({ session: IC }); const p = env.actions.prepare('suspend', { reason: 'أول' }); const p2 = env.actions.prepare('suspend', { reason: 'ثانٍ' });
  assert.deepEqual(await env.actions.confirm(p.token), { status: 'blocked', code: 'NOT_PREPARED' }, 'a newer prepare replaces the older card');
  await env.actions.confirm(p2.token); assert.equal(calls(env, SUSP)[0].payload.reason, 'ثانٍ');
  assert.deepEqual(await env.actions.confirm(p2.token), { status: 'blocked', code: 'NOT_PREPARED' });
});
await t('E17 LIMIT, documented and shown: the server binds the request to expectedHeadId ONLY — a change of eligibility of the SAME head that the view has not seen yet is not prevented', async () => {
  const env = envHead({ session: ADMIN, head: 'suspended-by-ic2' }); const p = env.actions.prepare('reinstate', { reason: 'x' }); assert.equal(p.limits.notBoundToEligibilityChange, true);
  advance(env); await ext(env, 'ic@example.com', 'reinstate'); advance(env); await ext(env, 'ic2@example.com', 'suspend');   // unseen: the view was not refreshed
  const r = await env.actions.confirm(p.token);
  assert.equal(r.status, 'success_waiting_view', 'the server accepts it: it reinstated a suspension the card never showed');
  assert.equal(env.server.effectsOf('reinstate'), 2);
});
await t('E18 the server\'s own refusals are shown as they are: ALREADY_SUSPENDED / NOT_SUSPENDED / STALE_HEAD / SUSPENDER_CANNOT_RESTORE / CONTRIBUTOR_CANNOT_REINSTATE leave no request and no wait', async () => {
  const a = envHead({ session: IC }); const pa = a.actions.prepare('suspend', { reason: 'x' }); await ext(a, 'ic2@example.com', 'suspend');   // unseen
  const ra = await a.actions.confirm(pa.token); assert.deepEqual([ra.status, ra.code], ['no_effect', 'ALREADY_SUSPENDED']); assert.equal(a.runner.get(scopeOf(a)), null); assert.equal(awaiting(a), null);
  const b = envHead({ session: IC2, head: 'suspended-by-ic' }); const pb = b.actions.prepare('reinstate', { reason: 'x' }); advance(b); await ext(b, 'admin@example.com', 'reinstate');
  const rb = await b.actions.confirm(pb.token); assert.deepEqual([rb.status, rb.code], ['no_effect', 'NOT_SUSPENDED']);
  const c = envHead({ session: IC }); const pc = c.actions.prepare('suspend', { reason: 'x' }); c.server.seedHead({ valuationDate: DAYSTR, headId: 'H1', version: 2, headDoc: HDOC });
  const rc = await c.actions.confirm(pc.token); assert.deepEqual([rc.status, rc.code], ['no_effect', 'STALE_HEAD']);
  const e = envHead({ session: IC2, head: 'suspended-by-ic' }); const pe = e.actions.prepare('reinstate', { reason: 'x' }); e.server.heads.get(`${FUND}::${DAYSTR}`).eligibility.changedBy = 'ic2@example.com';   // unseen: the suspender is the requester
  const re = await e.actions.confirm(pe.token); assert.deepEqual([re.status, re.code], ['no_effect', 'SUSPENDER_CANNOT_RESTORE']);
  const d = envHead({ session: IC2, head: 'suspended-by-ic' }); const pd = d.actions.prepare('reinstate', { reason: 'x' }); d.server.vals.get('H0').contributors.push('ic2@example.com');   // unseen
  const rd = await d.actions.confirm(pd.token); assert.deepEqual([rd.status, rd.code], ['no_effect', 'CONTRIBUTOR_CANNOT_REINSTATE']);
});

/* ================= 5. ambiguous request, shared scope, session ================= */
await t('E19 AMBIGUOUS: the original payload is kept, the whole scope is blocked, a view that shows the effect does NOT settle it, and the retry resends the original request verbatim', async () => {
  const env = envHead({ session: IC }); env.server.dropReplyOnce = true;
  const r = await go(env, 'suspend', { reason: 'سبب أصلي' }); assert.equal(r.status, 'ambiguous');
  const entry = env.runner.get(scopeOf(env)); assert.ok(entry); const original = JSON.parse(JSON.stringify(entry.payload));
  assert.deepEqual({ ...original, requestId: undefined }, { requestId: undefined, fundId: FUND, valuationDate: DAYSTR, expectedHeadId: 'H0', reason: 'سبب أصلي' });
  for (const a of ['suspend', 'reinstate', 'approve']) assert.equal(av(env)[a].reason, 'PENDING_EXISTS', a);
  assert.deepEqual(env.actions.prepare('suspend', { reason: 'جديد' }), { status: 'blocked', code: 'PENDING_EXISTS' });
  assert.equal(env.actions.canStart('createDraft').reason, 'PENDING_EXISTS', 'the scope is shared by every action');
  env.publishFresh(); assert.ok(env.runner.get(scopeOf(env)), 'the effect is visible, yet the request is NOT settled by inference'); assert.equal(av(env).suspend.reason, 'PENDING_EXISTS');
  const rr = await env.actions.retryPending(scopeOf(env)); assert.equal(rr.status, 'success_waiting_view');
  assert.deepEqual(calls(env, SUSP)[1].payload, original); assert.equal(env.server.effectsOf('suspend'), 1, 'the server replayed the stored result');
  assert.equal(awaiting(env).valuationId, 'H0', 'the retry waits for the head named in the ORIGINAL payload');
  env.publishFresh(); assert.equal(awaiting(env), null); assert.equal(env.actions.getState().outcome.status, 'reflected'); assert.equal(env.runner.get(scopeOf(env)), null);
});
await t('E20 session change clears the UI state (cards, waits) but NOT the stored ambiguous request; it is not shown to, nor usable by, the other user', async () => {
  const env = envHead({ session: IC }); env.server.dropReplyOnce = true;
  await go(env, 'suspend', { reason: 'x' }); const scope = scopeOf(env); const stored = JSON.stringify(env.runner.get(scope));
  env.setSession(IC2); env.actions.sync(); assert.deepEqual(env.actions.getState().pending, [], 'another user sees nothing'); assert.equal(env.actions.getState().awaiting, null);
  env.setSession(IC); env.actions.sync(); assert.equal(JSON.stringify(env.runner.get(scope)), stored, 'the record was not deleted'); assert.equal(env.actions.getState().pending.length, 1);
  assert.equal(av(env).suspend.reason, 'PENDING_EXISTS');
  const w = envHead({ session: IC }); await go(w, 'suspend', { reason: 'x' }); assert.ok(awaiting(w));
  w.setSession(IC2); w.actions.sync(); assert.equal(w.actions.getState().awaiting, null, 'the wait is UI state: cleared');
  const c = envHead({ session: IC }); const p = c.actions.prepare('suspend', { reason: 'x' }); c.setSession(IC2); c.actions.sync(); c.setSession(IC); c.actions.sync();
  assert.deepEqual(await c.actions.confirm(p.token), { status: 'blocked', code: 'NOT_PREPARED' }); assert.equal(c.server.calls.length, 0);
});
await t('E21 a session that loses permission mid-way: the prepared card cannot be confirmed (gate re-run)', async () => {
  const env = envHead({ session: IC }); const p = env.actions.prepare('suspend', { reason: 'x' });
  env.setSession({ ...IC, role: 'fund_manager' }); env.actions.sync();
  const r = await env.actions.confirm(p.token); assert.equal(r.status, 'blocked'); assert.equal(env.server.calls.length, 0);
});

/* ================= 6. the REAL reader ================= */
await t('R1 the REAL reader exposes headRev and the head valuation\'s provenance (no value) for a suspended head; reinstate is allowed only with a complete provenance and the card follows the real head', async () => {
  const env = makeEnv({ session: IC2 }); const fake = makeFakeSubscribe();
  const reader = createFundValuationReader({ subscribe: fake.subscribe, getSession: () => env.box.s, onChange: () => env.actions.sync(), fetchOnce: async () => ({ docs: [], fromCache: false }) });
  env.hooks.getContext = (d) => reader.contextFor(d === undefined ? DAYSTR : d);
  reader.open(FUND);
  const emit = async ({ eligibility, doc = {}, headRev = 3 }) => {
    const p = await approvedPair({ date: DAYSTR, valuationId: 'H0', approvedBy: 'boss@example.com', contentHash: 'a'.repeat(64), eligibility, doc, head: { rev: headRev } });
    fake.emit('heads', FUND, [p.head], false); fake.emit('valuations', FUND, [p.doc], false); fake.emit('events', FUND, [], false); await tick(30);
  };
  const susp = { state: 'SUSPENDED', changedBy: 'ic@example.com', changedAt: '2026-10-11T08:00:00.000Z', reasonCode: 'SUSPENDED', reason: 'x' };
  await emit({ eligibility: susp, doc: { contributors: ['fm@example.com'] } });
  const a = reader.contextFor(DAYSTR).approved; assert.equal(a.kind, 'suspended'); assert.equal(a.headRev, 3); assert.equal(a.doc, undefined, 'still no value for a suspended head');
  assert.deepEqual(a.headValuation, { contributors: ['fm@example.com'], approvedBy: 'boss@example.com' });
  assert.equal(env.actions.getState().eligibility.headValuationLoaded, true); assert.equal(av(env).reinstate.allowed, true);
  const p = env.actions.prepare('reinstate', { reason: 'زال السبب' }); assert.equal(p.status, 'ready'); assert.equal(p.summary.head.rev, 3);
  await emit({ eligibility: { ...susp, changedAt: '2026-10-11T09:30:00.000Z' }, doc: { contributors: ['fm@example.com'] }, headRev: 5 });   // the same suspender, state, head and version: a later cycle
  assert.equal((await env.actions.confirm(p.token)).code, 'VIEW_CHANGED');
  await emit({ eligibility: susp, doc: {} });                                   // the approved document carries no contributors list: provenance incomplete
  assert.equal(reader.contextFor(DAYSTR).approved.headValuation.contributors, null); assert.equal(av(env).reinstate.reason, 'HEAD_DOC_NOT_LOADED');
  await emit({ eligibility: { state: 'ELIGIBLE', changedBy: 'ic@example.com', reasonCode: 'APPROVED' }, doc: { contributors: ['fm@example.com'] } });
  assert.equal(reader.contextFor(DAYSTR).approved.kind, 'effective'); assert.equal(av(env).suspend.allowed, true);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
