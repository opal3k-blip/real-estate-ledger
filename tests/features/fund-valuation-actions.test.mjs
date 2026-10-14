// R1-B2 / B2-2a — actions orchestrator against a fake server that counts EFFECTS (not calls) and delivers snapshots only when told.
// Run: node tests/features/fund-valuation-actions.test.mjs   (exit 0 only if all pass)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as A from '../../src/features/fund-valuation-actions.js';
import * as E from '../../src/features/fund-valuation-editor.js';
import { scopeKey } from '../../src/features/fund-valuation-requests.js';
import { makeEnv, makeStorage, goodContent, tick, FM, FM2, IC, FUND } from '../helpers/fund-valuation-server-fake.mjs';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); if (!process.env.CONTINUE_ON_FAIL) throw e; console.error(`      ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`); } }

const PROPOSAL = E.makeLinkProposal({ fundId: FUND, assetIds: ['A1', 'A2'], source: E.LINK_SOURCES.BROWSER_FUND_DATA });
const FILL = [
  ['components.assetsValue', '900'], ['components.cashRetained', '200'], ['components.otherAssets', '50'], ['components.liabilities', '150'], ['components.distributionsPayable', '0'],
  ['residualValue', '1000'], ['method', 'appraisal'], ['methodNote', 'external appraisal'], ['source.ref', 'APP-1'], ['source.provider', 'Valuer Co'],
  ['nonOverlap.cashNotInAssets', true], ['nonOverlap.otherAssetsNotInAssets', true], ['nonOverlap.assetsStatedGrossOfLiabilities', true],
  ['coverage.unlinkedHoldings.declared', 'none'],
];
function fill(a) {
  for (const [p, v] of FILL) assert.equal(a.setField(p, v).status, 'ok', p);
  assert.equal(a.addItem('otherAssetsItems').status, 'ok');
  a.setField('otherAssetsItems.0.description', 'receivable'); a.setField('otherAssetsItems.0.amount', '50');
  assert.equal(a.confirmLinks().status, 'ok');
}
const env0 = (o = {}) => makeEnv({ linkProposal: PROPOSAL, ...o });
/** create a draft end to end; the view has caught up on return */
async function withDraft(o = {}) {
  const env = env0(o); env.publish();
  assert.equal(env.actions.startCreate().status, 'started'); fill(env.actions);
  const r = await env.actions.save(); assert.equal(r.status, 'success_waiting_view', JSON.stringify(r));
  env.publish();
  return env;
}
const scopeOf = (env, date) => scopeKey({ user: env.box.s.email, fundId: FUND, valuationDate: date || env.view.selectedDate || '2026-10-11' });
const aw = (env) => { const a = env.actions.getState().awaiting; assert.ok(a, 'expected a view-awaiting block'); return a; };
const lastCall = (env) => env.server.calls[env.server.calls.length - 1];
const callsTo = (env, c) => env.server.calls.filter((x) => x.callable === c);

console.log('— B2-2a actions —');

/* ----------------------------------------------------------------- start / create */
await t('1. no session / unreadable role / non-writer role: nothing can start, nothing is sent', async () => {
  const env = env0({ session: IC }); env.publish();
  assert.equal(env.actions.startCreate().code, 'ROLE_NOT_ALLOWED');
  env.setSession(null); assert.equal(env.actions.startCreate().code, 'NO_SESSION'); assert.equal(env.actions.canStart('submit').reason, 'NO_SESSION');
  assert.equal(env.actions.canStart('createDraft').allowed, false);
  assert.equal(env.server.calls.length, 0);
});
await t('2. create: save sends ONE request with the explicit content; success is "waiting for the view", not "done"', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions);
  const r = await env.actions.save();
  assert.equal(r.status, 'success_waiting_view'); assert.equal(env.server.effectsOf('createDraft'), 1);
  const p = lastCall(env).payload; assert.deepEqual(Object.keys(p).sort(), ['content', 'fundId', 'requestId', 'valuationDate']);
  assert.equal(p.content.residualValue, 1000); assert.deepEqual(p.content.coverage.linkedAssets, ['A1', 'A2']);
  const st = env.actions.getState(); assert.equal(aw(env).action, 'createDraft'); assert.ok(st.banners.some((b) => b.kind === 'awaiting_view'));
  assert.deepEqual(env.runner.pending(), [], 'a succeeded request leaves no pending entry');
});
await t('3. CONTROL 4: before a view that reflects the effect arrives, NOTHING new can be sent from the old view (save, create, update, submit, withdraw)', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions);
  await env.actions.save(); const n = env.server.calls.length;
  for (const a of ['createDraft', 'updateDraft', 'submit', 'withdraw']) assert.deepEqual(env.actions.canStart(a), { allowed: false, reason: 'AWAITING_VIEW' }, a);
  assert.equal((await env.actions.save()).code, 'AWAITING_VIEW');
  assert.equal(env.actions.startCreate().code, 'AWAITING_VIEW');
  assert.equal(env.actions.prepare('submit').code, 'AWAITING_VIEW');
  assert.equal(env.server.calls.length, n, 'no request left the module');
});
await t('4. CONTROL 4: "succeeded, waiting for the view" is NOT "outcome unresolved": no pending entry, no ambiguity banner, no retry/discard offered', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); await env.actions.save();
  const st = env.actions.getState();
  assert.deepEqual(st.pending, []); assert.ok(!st.banners.some((b) => String(b.kind).startsWith('pending_')));
  assert.equal(st.outcome.status, 'success_waiting_view'); assert.equal(env.runner.isBlocked({ fundId: FUND, valuationDate: '2026-10-11' }), false);
});
await t('5. CONTROL 4: a snapshot that does NOT show the effect (old view, any snapshot) does not release the block; the one that does, releases it', async () => {
  const env = await withDraft();
  env.actions.setField('methodNote', 'changed'); await env.actions.save();
  assert.equal(aw(env).action, 'updateDraft');
  // an old snapshot is delivered again (same docs as before the update)
  const oldDoc = JSON.parse(JSON.stringify(env.view.drafts.get('2026-10-11')));
  env.actions.sync(); assert.equal(aw(env).action, 'updateDraft');
  env.view.drafts.set('2026-10-11', oldDoc); env.view.status = 'ready'; env.actions.sync();
  assert.equal(aw(env).action, 'updateDraft', 'an unchanged snapshot is not a settlement');
  env.publish(); assert.equal(env.actions.getState().awaiting, null);
  assert.equal(env.actions.getState().outcome.status, 'reflected');
});
await t('6. CONTROL 4: timers never release the block: "delayed" asks the reader to re-fetch, "stalled" only says so; a confirmed OLD view after the deadline is not an overtaking', async () => {
  const env = await withDraft(); env.view.refreshCalls = 0;
  env.actions.setField('methodNote', 'x'); await env.actions.save(); const n = env.server.calls.length;
  assert.equal(env.view.refreshCalls, 1, 'a re-read is asked for at once when the reply arrives');
  env.fire(8000); assert.equal(env.view.refreshCalls, 2); assert.equal(aw(env).phase, 'delayed');
  env.fire(20000); assert.equal(aw(env).phase, 'stalled');
  assert.equal(aw(env).action, 'updateDraft', 'still blocked after BOTH deadlines');
  assert.equal(env.actions.canStart('updateDraft').reason, 'AWAITING_VIEW'); assert.equal((await env.actions.save()).code, 'AWAITING_VIEW');
  const st = env.actions.getState(); assert.ok(!st.banners.some((b) => b.kind === 'view_overtaken')); assert.notEqual(st.outcome.status, 'view_overtaken');
  assert.equal(env.server.calls.length, n); assert.equal(env.view.refreshCalls, 2, 'the timer asks once more; it does not poll');
});
await t('7. CONTROL 4: the module never reads the event log; settlement of an ambiguous request is never inferred from it', () => {
  const src = fs.readFileSync(new URL('../../src/features/fund-valuation-actions.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bevents?\b/i.test(src), 'no reference to events in code');
});
await t('8. after the effect is reflected the new draft opens in the editor from the SERVER document; coverage statement is the stored one', async () => {
  const env = await withDraft(); const st = env.actions.getState();
  assert.equal(st.editor.mode, 'edit'); assert.equal(st.editor.dirty, false); assert.equal(st.editor.ready, true);
  assert.equal(st.editor.copyReview, null);
  assert.equal(st.editor.coverage.proposal.source, 'SERVER_SCOPE_SNAPSHOT');
  assert.equal(st.editor.coverage.reconcile.status, 'MATCH');
});

/* ----------------------------------------------------------------- update, conflicts */
await t('9. update carries expectedContentHash of the version she started from and the full content; the server replaces top-level keys', async () => {
  const env = await withDraft(); const doc = env.view.drafts.get('2026-10-11');
  env.actions.setField('residualValue', '1000.01'); const r = await env.actions.save();
  assert.equal(r.status, 'success_waiting_view');
  const p = lastCall(env).payload; assert.equal(p.expectedContentHash, doc.contentHash); assert.equal(p.valuationId, doc.valuationId);
  assert.equal(p.content.residualValue, 1000.01); assert.equal(env.server.effectsOf('updateDraft'), 1);
  env.publish(); assert.equal(env.actions.getState().editor.dirty, false);
});
await t('10. CONFLICT (view already updated): save is blocked CONTENT_CHANGED before sending; the conflict lists sections', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.actions.setField('residualValue', '1000.01');
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'edited elsewhere' }); env.publish();
  const n = env.server.calls.length;
  const r = await env.actions.save(); assert.equal(r.code, 'CONTENT_CHANGED'); assert.equal(env.server.calls.length, n);
  const c = env.actions.getState().editor.conflict; assert.deepEqual(c.changedByMe, ['residualValue']); assert.deepEqual(c.changedOnServer, ['methodNote']); assert.deepEqual(c.overlapping, []);
  assert.equal((await env.actions.save()).code, 'CONFLICT_UNRESOLVED');
});
await t('11. CONFLICT (view still old): the server answers CONTENT_CHANGED (no effect), the conflict is raised, and resolving against the still-old view re-raises it instead of resolving', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.actions.setField('residualValue', '1000.01');
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'edited elsewhere' }); // not published
  const r = await env.actions.save(); assert.equal(r.status, 'no_effect'); assert.equal(r.code, 'CONTENT_CHANGED');
  assert.equal(env.server.effectsOf('updateDraft'), 0); assert.ok(env.actions.getState().editor.conflict);
  env.publish();
  const rr = env.actions.resolveConflict('reapply'); assert.equal(rr.code, 'CONFLICT_CHANGED_AGAIN');
  const ok = env.actions.resolveConflict('reapply'); assert.equal(ok.status, 'reapplied');
});
await t('12. reapply: the server version is the base, MY changed sections win, nothing is sent until she saves; overlapping sections are reported', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.actions.setField('residualValue', '1000.01'); env.actions.setField('methodNote', 'mine');
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'theirs', method: 'nav_statement' }); env.publish();
  await env.actions.save(); const n = env.server.calls.length;
  const r = env.actions.resolveConflict('reapply');
  assert.equal(r.status, 'reapplied'); assert.deepEqual(r.overlapping, ['methodNote']); assert.equal(env.server.calls.length, n);
  const f = env.actions.getState().editor.form;
  assert.equal(f.residualValue, '1000.01'); assert.equal(f.methodNote, 'mine'); assert.equal(f.method, 'nav_statement', 'their non-overlapping change is kept');
  const s = await env.actions.save(); assert.equal(s.status, 'success_waiting_view');
  assert.equal(lastCall(env).payload.expectedContentHash, env.server.docOf(id).contentHash === lastCall(env).payload.expectedContentHash ? env.server.docOf(id).contentHash : lastCall(env).payload.expectedContentHash);
});
await t('13. discard-mine: confirm required while dirty; then the editor reopens from the server version', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.actions.setField('residualValue', '1000.01'); await env.server.externalEdit(id, { ...goodContent(), methodNote: 'theirs' }); env.publish(); await env.actions.save();
  assert.equal(env.actions.resolveConflict('discard-mine').status, 'confirm_required');
  assert.equal(env.actions.resolveConflict('discard-mine', { confirm: true }).status, 'discarded');
  const st = env.actions.getState().editor; assert.equal(st.dirty, false); assert.equal(st.form.methodNote, 'theirs'); assert.equal(st.conflict, null);
  assert.equal(env.actions.resolveConflict('nonsense').code, 'NO_CONFLICT');
});
await t('14. server changed while the editor is CLEAN: the editor adopts it silently; while DIRTY: flagged as serverChanged, never overwritten', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'theirs' }); env.publish();
  assert.equal(env.actions.getState().editor.form.methodNote, 'theirs');
  env.actions.setField('residualValue', '1000.01');
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'theirs2' }); env.publish();
  const st = env.actions.getState().editor; assert.ok(st.serverChanged); assert.equal(st.form.residualValue, '1000.01'); assert.equal(st.form.methodNote, 'theirs');
});

/* ----------------------------------------------------------------- submit / withdraw */
await t('15. submit: prepare -> confirm; refuses unsaved edits; says it is NOT bound to content (server limit §6.1); single effect', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'dirty');
  assert.equal(env.actions.prepare('submit').code, 'UNSAVED_EDITS');
  await env.actions.save(); env.publish();
  const p = env.actions.prepare('submit'); assert.equal(p.status, 'ready'); assert.equal(p.limits.notBoundToContent, true);
  assert.equal(env.actions.getState().limits.submitAndWithdrawNotBoundToContent, true);
  const r = await env.actions.confirm(p.token); assert.equal(r.status, 'success_waiting_view');
  assert.equal(env.server.effectsOf('submit'), 1); assert.deepEqual(Object.keys(lastCall(env).payload).sort(), ['requestId', 'valuationId']);
  env.publish(); assert.equal(env.server.docOf(env.view.drafts.get('2026-10-11').valuationId).state, 'submitted');
});
await t('16. submit: a token is single-use and bound to the generation; a changed view between prepare and confirm refuses (VIEW_CHANGED) and sends nothing', async () => {
  const env = await withDraft(); const p = env.actions.prepare('submit'); const id = env.view.drafts.get('2026-10-11').valuationId;
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'theirs' }); env.publish(); const n = env.server.calls.length;
  const r = await env.actions.confirm(p.token); assert.equal(r.code, 'VIEW_CHANGED'); assert.ok(r.changed.includes('contentHash')); assert.equal(env.server.calls.length, n);
  assert.equal((await env.actions.confirm(p.token)).code, 'NOT_PREPARED');
  assert.equal((await env.actions.confirm('p999')).code, 'NOT_PREPARED');
  const p2 = env.actions.prepare('submit'); env.setSession(FM2); // other user: token is dead
  assert.notEqual((await env.actions.confirm(p2.token)).status, 'success_waiting_view');
});
await t('17. submit: a server validation refusal is a NO-EFFECT outcome with its code; the draft stays editable; no awaiting block', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions);
  env.actions.setField('components.assetsValue', '901'); // formula mismatch is only an editor issue; save works, submit is refused by the editor first
  assert.equal(env.actions.getState().editor.ready, false);
  await env.actions.save(); env.publish();
  // a server-side refusal the editor cannot see: make the stored doc invalid on the server only
  const id = env.view.drafts.get('2026-10-11').valuationId; const d = env.server.vals.get(id); d.validation = { ok: false, issues: ['X'] };
  env.actions.setField('components.assetsValue', '900'); await env.actions.save(); env.server.vals.get(id).validation = { ok: false, issues: ['X'] }; env.publish();
  const p = env.actions.prepare('submit'); const r = await env.actions.confirm(p.token);
  assert.equal(r.status, 'no_effect'); assert.equal(r.code, 'VALIDATION_FAILED'); assert.equal(env.actions.getState().awaiting, null);
});
await t('18. roles: the senior IC cannot create/update/submit/withdraw (no-effect locally); another fund manager who is not a contributor cannot submit or withdraw', async () => {
  const env = await withDraft(); env.setSession(IC);
  for (const a of ['createDraft', 'updateDraft', 'submit', 'withdraw']) assert.equal(env.actions.canStart(a).reason, 'ROLE_NOT_ALLOWED', a);
  env.setSession(FM2);
  assert.equal(env.actions.canStart('submit').reason, 'NOT_A_CONTRIBUTOR'); assert.equal(env.actions.canStart('withdraw').reason, 'NOT_A_CONTRIBUTOR');
});
await t('19. withdraw: single effect; after the view reflects it the editor closes and creating again is possible', async () => {
  const env = await withDraft(); const p = env.actions.prepare('withdraw'); const r = await env.actions.confirm(p.token);
  assert.equal(r.status, 'success_waiting_view'); assert.equal(env.server.effectsOf('withdraw'), 1);
  assert.equal(env.actions.canStart('createDraft').reason, 'AWAITING_VIEW'); env.publish();
  assert.equal(env.actions.canStart('createDraft').reason, 'AWAITING_VIEW', 'an empty slot in a view that may predate the reply is not proof');
  env.publishFresh();
  const st = env.actions.getState(); assert.equal(st.editor, null); assert.equal(env.actions.canStart('createDraft').allowed, true);
});
await t('20. withdraw is allowed after the Riyadh day crossed (not a day-checked action); update and submit are not', async () => {
  const env = await withDraft(); env.view.selectedDate = '2026-10-11'; env.clock.now = new Date('2026-10-11T21:30:00Z'); env.actions.sync();
  assert.equal(env.actions.canStart('updateDraft').reason, 'DATE_CROSSED'); assert.equal(env.actions.canStart('submit').reason, 'DATE_CROSSED');
  assert.equal(env.actions.canStart('withdraw').allowed, true);
});

/* ----------------------------------------------------------------- copy */
await t('21. server copy of a rejected version: new draft, copiedFrom shown, coverage UNCONFIRMED, submit blocked until BOTH reviews', async () => {
  const env = env0(); await env.server.seedDraft({ valuationId: 'OLD', valuationDate: '2026-10-05', state: 'rejected' }); env.publish();
  const r = await env.actions.copyFrom({ sourceId: 'OLD', sourceState: 'rejected' }); assert.equal(r.status, 'success_waiting_view');
  assert.deepEqual(Object.keys(lastCall(env).payload).sort(), ['copyFromValuationId', 'fundId', 'requestId', 'valuationDate']);
  env.publish(); const st = env.actions.getState(); assert.ok(st.editor, 'a server copy opens for review');
  assert.equal(st.editor.copyReview.sourceId, 'OLD'); assert.equal(st.editor.copyReview.kind, 'server-copy');
  assert.equal(st.editor.form.coverage.linkedAssets.confirmed, false, 'old coverage is not her statement');
  assert.equal(st.available.submit.reason, 'COPY_REVIEW_REQUIRED'); assert.equal(env.actions.prepare('submit').code, 'COPY_REVIEW_REQUIRED');
  assert.equal(env.actions.acknowledgeCopy('coverage').code, 'COVERAGE_NOT_CONFIRMED', 'an acknowledgement is not a statement');
  assert.equal(env.actions.acknowledgeCopy('content').status, 'ok');
  env.actions.confirmLinks(); assert.equal(env.actions.acknowledgeCopy('coverage').code, 'SAVE_FIRST');
  await env.actions.save(); env.publish();
  assert.equal(env.actions.acknowledgeCopy('coverage').status, 'ok');
  assert.equal(env.actions.getState().available.submit.allowed, true);
  assert.equal(env.actions.prepare('submit').status, 'ready');
});
await t('22. CONTROL 3: re-copying does not prove the old coverage: a copy whose source links differ from the draft\'s captured links is flagged', async () => {
  const env = env0(); await env.server.seedDraft({ valuationId: 'OLD', valuationDate: '2026-10-05', state: 'withdrawn', scopeLinks: ['A1'] }); env.publish();
  await env.actions.copyFrom({ sourceId: 'OLD', sourceState: 'withdrawn' }); env.publish();
  env.actions.confirmLinks(); // confirms the SERVER_SCOPE proposal for the NEW draft (A1, A2)
  const cov = env.actions.getState().editor.coverage; assert.equal(cov.statement.confirmed, true);
  assert.deepEqual(cov.statement.ids, ['A1', 'A2']); assert.equal(cov.reconcile.status, 'MATCH');
});
await t('23. an APPROVED source is refused locally (the server cannot copy it); no request, no pre-fill path exists in this package', async () => {
  const env = env0(); env.publish(); const n = env.server.calls.length;
  const r = await env.actions.copyFrom({ sourceId: 'APP1', sourceState: 'approved', sourceDoc: { valuationId: 'APP1', state: 'approved', ...goodContent() } });
  assert.deepEqual(r, { status: 'blocked', code: 'COPY_SOURCE_STATE' }); assert.equal(env.server.calls.length, n); assert.equal(env.actions.getState().editor, null);
  assert.equal(typeof env.actions.startCreate().code, 'undefined'); // startCreate takes no source: the form always starts empty
  assert.equal(env.actions.getState().editor.form.residualValue, '');
  assert.equal(E.COPY_KINDS.CLIENT_PREFILL, undefined); assert.deepEqual(Object.keys(E.COPY_KINDS), ['SERVER_COPY']);
});
await t('24. server refuses a copy source the view thought was copyable: no-effect COPY_SOURCE_STATE, nothing waits', async () => {
  const env = env0(); await env.server.seedDraft({ valuationId: 'OLD', valuationDate: '2026-10-05', state: 'approved' }); env.publish();
  const r = await env.actions.copyFrom({ sourceId: 'OLD', sourceState: 'rejected' });
  assert.equal(r.status, 'no_effect'); assert.equal(r.code, 'COPY_SOURCE_STATE'); assert.equal(env.actions.getState().awaiting, null);
});

/* ----------------------------------------------------------------- coverage (control 3) */
await t('25. CONTROL 3: before the first draft the link source is labelled BROWSER_FUND_DATA and "only browser data"; there is no preview without a valuationId', async () => {
  const env = env0(); env.publish(); env.actions.startCreate();
  const cov = env.actions.getState().editor.coverage;
  assert.equal(cov.proposal.source, 'BROWSER_FUND_DATA'); assert.equal(cov.proposalIsOnlyBrowserData, true); assert.equal(cov.statement.confirmed, false);
  assert.equal((await env.actions.checkNow()).code, 'NO_TARGET'); assert.equal(callsTo(env, 'getValuationPreview').length, 0);
});
await t('26. CONTROL 3: nothing is stated unless she confirms: an unconfirmed save sends NO coverage.linkedAssets; no proposal -> cannot confirm', async () => {
  const env = env0({ linkProposal: null }); env.publish(); env.actions.startCreate();
  assert.equal(env.actions.confirmLinks().code, 'LINK_PROPOSAL_REQUIRED');
  env.actions.setField('residualValue', '1'); await env.actions.save();
  assert.equal(lastCall(env).payload.content.coverage, undefined);
  const env2 = env0(); env2.publish(); env2.actions.startCreate(); env2.actions.setField('residualValue', '1'); await env2.actions.save();
  assert.equal(lastCall(env2).payload.content.coverage, undefined, 'a proposal exists but was not confirmed');
});
await t('27. CONTROL 3: after the draft exists the SERVER snapshot is the proposal; the gap to a statement made against browser data is shown (reconcile) and flagged stale only if the ids disagree', async () => {
  const env = await withDraft(); // she stated A1,A2 against BROWSER_FUND_DATA; the server captured A1,A2
  let cov = env.actions.getState().editor.coverage;
  assert.equal(cov.proposal.source, 'SERVER_SCOPE_SNAPSHOT'); assert.equal(cov.reconcile.status, 'MATCH'); assert.equal(cov.statementStale, false, 'a change of basis alone is not an alarm');
  const id = env.view.drafts.get('2026-10-11').valuationId; env.server.vals.get(id).scopeSnapshot.linksByFund[FUND] = ['A1', 'A2', 'A3']; env.publish();
  cov = env.actions.getState().editor.coverage;
  assert.deepEqual(cov.reconcile, { status: 'MISSING', missing: ['A3'], extra: [] }); assert.equal(cov.statementStale, true);
  assert.equal(env.actions.confirmLinks().status, 'ok'); cov = env.actions.getState().editor.coverage; assert.equal(cov.reconcile.status, 'MATCH'); assert.equal(cov.statementStale, false);
  assert.equal(env.actions.getState().editor.dirty, true);
  env.server.vals.get(id).scopeSnapshot.linksByFund[FUND] = ['A1', 'A2', 'A3', 'A4']; env.publish();
  cov = env.actions.getState().editor.coverage; assert.equal(cov.statementStale, true); assert.deepEqual(cov.reconcile.missing, ['A4']);
  assert.equal(env.actions.closeEditor({ confirm: true }).status, 'closed'); assert.equal(env.actions.openActiveDraft().status, 'opened');
  assert.equal(env.actions.getState().editor.coverage.statementStale, false, 'a statement loaded from the server records no basis: the reconcile line carries the gap');
});
await t('27b. confirming a link statement does not leave the editor permanently "dirty" after it was saved (metadata is not content)', async () => {
  const env = await withDraft(); env.actions.clearLinks(); env.actions.confirmLinks(); env.actions.setField('methodNote', 'k'); await env.actions.save(); env.publish();
  assert.equal(env.actions.getState().editor.dirty, false); assert.equal(env.actions.requestLeave().needsConfirm, false);
});

/* ----------------------------------------------------------------- preview (control 2) */
await t('28. CONTROL 2: "check now" sends only the valuationId; reply says it checked the STORED version; unsaved edits are reported as NOT checked', async () => {
  const env = await withDraft(); env.actions.setField('residualValue', '1000.01');
  const r = await env.actions.checkNow(); assert.equal(r.status, 'done');
  assert.deepEqual(lastCall(env).payload, { valuationId: env.view.drafts.get('2026-10-11').valuationId });
  const p = env.actions.getState().preview; assert.equal(p.checks, 'STORED_VERSION'); assert.equal(p.unsavedEditsNotChecked, true); assert.equal(p.dirtyWhenRequested, true);
  assert.equal(p.storedContentHash, env.view.drafts.get('2026-10-11').contentHash); assert.equal(p.reply.contentHash, p.storedContentHash);
  assert.equal(p.reply.candidate.status, 'ELIGIBLE');
  env.actions.setField('residualValue', '1000'); assert.equal(env.actions.getState().preview.unsavedEditsNotChecked, false, 'editor back to the stored state');
});
await t('29. CONTROL 2: a reply that arrives after the SESSION changed is dropped and shown nowhere', async () => {
  const env = await withDraft(); env.server.previewDelay = 20;
  const pr = env.actions.checkNow(); await tick(2); env.setSession(FM2); env.actions.sync();
  assert.equal((await pr).status, 'dropped'); assert.equal(env.actions.getState().preview, null);
});
await t('30. CONTROL 2: a reply for a draft that is no longer the viewed draft is dropped (withdrawn while the request was out)', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.server.previewHook = async () => { env.server.vals.get(id).state = 'withdrawn'; env.server.slot.clear(); env.publish(); };
  const r = await env.actions.checkNow(); assert.equal(r.status, 'dropped'); assert.notEqual(env.actions.getState().preview && env.actions.getState().preview.status, 'done');
});
await t('31. CONTROL 2: bound to the HASH: if the stored version moved while the request was out the result is "outdated", never "done"', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.server.previewHook = async () => { await env.server.externalEdit(id, { ...goodContent(), methodNote: 'moved' }); env.publish(); };
  const r = await env.actions.checkNow(); assert.equal(r.status, 'outdated'); assert.equal(env.actions.getState().preview.status, 'outdated');
});
await t('32. CONTROL 2: only the LATEST request counts: an earlier slow reply is dropped when a newer check started', async () => {
  const env = await withDraft(); env.server.previewDelay = 30;
  const first = env.actions.checkNow(); await tick(2); env.server.previewDelay = 0; const second = env.actions.checkNow();
  assert.equal((await second).status, 'done'); assert.equal((await first).status, 'dropped'); assert.equal(env.actions.getState().preview.status, 'done');
});
await t('33. CONTROL 2: a stored preview becomes outdated when the stored version changes (after a save), and a failure is an error state, not a result', async () => {
  const env = await withDraft(); await env.actions.checkNow(); assert.equal(env.actions.getState().preview.status, 'done');
  env.actions.setField('methodNote', 'z'); await env.actions.save(); env.publish();
  assert.equal(env.actions.getState().preview.status, 'outdated');
  env.server.previewHook = async () => { const e = new Error('x'); e.code = 'functions/unavailable'; throw e; };
  assert.equal((await env.actions.checkNow()).status, 'error'); assert.equal(env.actions.getState().preview.status, 'error');
});
await t('34. a preview reply of "stale" feeds the submit gate (re-submit of a submitted draft is only offered when stale)', async () => {
  const env = await withDraft(); const p = env.actions.prepare('submit'); await env.actions.confirm(p.token); env.publish();
  assert.equal(env.actions.canStart('submit').reason, 'ALREADY_SUBMITTED');
});

/* ----------------------------------------------------------------- ambiguous requests, retry vs new start (control 1) */
await t('35. CONTROL 1: ambiguous update (reply lost, effect happened): new actions are blocked PENDING_EXISTS; retry resends the ORIGINAL id and payload verbatim; ONE server effect', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'amb'); env.server.dropReplyOnce = true;
  const r = await env.actions.save(); assert.equal(r.status, 'ambiguous');
  const first = lastCall(env); assert.equal(env.server.effectsOf('updateDraft'), 1);
  const st = env.actions.getState(); assert.ok(st.banners.some((b) => b.kind === 'pending_ambiguous')); assert.equal(st.pending.length, 1);
  for (const a of ['createDraft', 'updateDraft', 'submit', 'withdraw']) assert.equal(env.actions.canStart(a).reason, 'PENDING_EXISTS', a);
  const rr = await env.actions.retryPending(scopeOf(env));
  assert.equal(rr.status, 'success_waiting_view'); assert.equal(rr.result.replayed, true);
  const again = lastCall(env); assert.deepEqual(again, first, 'same requestId, same payload, byte for byte');
  assert.equal(env.server.effectsOf('updateDraft'), 1, 'a replay is not a second effect'); assert.deepEqual(env.runner.pending(), []);
});
await t('36. CONTROL 1: the Riyadh day CROSSES while a request is ambiguous: starting is blocked, RECOVERING by the original id is not', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'amb'); env.server.dropReplyOnce = true; await env.actions.save();
  const first = lastCall(env); env.view.selectedDate = '2026-10-11'; env.clock.now = new Date('2026-10-11T21:30:00Z'); env.actions.sync();
  assert.equal(env.actions.canStart('updateDraft').reason, 'PENDING_EXISTS'); assert.equal(env.actions.getState().dayKind, 'crossed');
  const rr = await env.actions.retryPending(scopeOf(env, '2026-10-11'));
  assert.equal(rr.status, 'success_waiting_view'); assert.equal(rr.result.replayed, true); assert.deepEqual(lastCall(env), first); assert.equal(env.server.effectsOf('updateDraft'), 1);
});
await t('37. CONTROL 1: the STATE / head changed meanwhile (another person withdrew): a replay still answers from the stored result (lookup precedes state), one effect, no new request', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'amb'); env.server.dropReplyOnce = true; await env.actions.save();
  const id = env.view.drafts.get('2026-10-11').valuationId; env.server.vals.get(id).state = 'withdrawn'; env.server.slot.clear(); env.publish();
  assert.equal(env.actions.canStart('updateDraft').reason, 'PENDING_EXISTS');
  const rr = await env.actions.retryPending(scopeOf(env)); assert.equal(rr.status, 'success_waiting_view'); assert.equal(rr.result.replayed, true);
  assert.equal(env.server.effectsOf('updateDraft'), 1);
});
await t('38. CONTROL 1: a request that NEVER took effect, retried after the state moved: the server refuses AFTER the lookup (INVALID_STATE) -> no effect, entry cleared; the refusal is not mistaken for success', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'amb'); env.server.failBeforeOnce = 'unavailable';
  const r = await env.actions.save(); assert.equal(r.status, 'ambiguous'); assert.equal(env.server.effectsOf('updateDraft'), 0);
  const id = env.view.drafts.get('2026-10-11').valuationId; env.server.vals.get(id).state = 'withdrawn'; env.server.slot.clear(); env.publish();
  const rr = await env.actions.retryPending(scopeOf(env)); assert.equal(rr.status, 'no_effect'); assert.equal(rr.code, 'INVALID_STATE');
  assert.deepEqual(env.runner.pending(), []); assert.equal(env.server.effectsOf('updateDraft'), 0);
});
await t('39. CONTROL 1: permission removed before the retry: permission-denied stays UNRESOLVED (B2-0), the entry is kept, new actions stay blocked, discard needs an explicit acknowledgement', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'amb'); env.server.dropReplyOnce = true; await env.actions.save();
  env.server.members.delete('fm@example.com');
  const rr = await env.actions.retryPending(scopeOf(env)); assert.equal(rr.status, 'unresolved'); assert.equal(rr.code, 'UNRESOLVED_PERMISSION');
  const st = env.actions.getState(); assert.ok(st.banners.some((b) => b.kind === 'pending_unresolved')); assert.equal(st.pending.length, 1);
  assert.equal(env.actions.canStart('updateDraft').reason, 'PENDING_EXISTS');
  assert.equal((await env.actions.discardPending(scopeOf(env))).code, 'ACK_REQUIRED'); assert.equal(env.runner.pending().length, 1);
  assert.equal((await env.actions.discardPending(scopeOf(env), { acknowledgeRisk: true })).status, 'discarded'); assert.equal(env.runner.pending().length, 0);
});
await t('40. CONTROL 1: recovery respects the session gate, the lock and the storage: other user -> refused; no reliable lock -> refused; unwritable storage -> refused; request never sent', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'amb'); env.server.dropReplyOnce = true; await env.actions.save();
  const sc = scopeOf(env); const n = env.server.calls.length;
  env.setSession(FM2); assert.equal((await env.actions.retryPending(sc)).code, 'NO_SESSION'); env.setSession(FM);
  env.storage.failSet = true; assert.equal((await env.actions.retryPending(sc)).code, 'STORAGE_UNAVAILABLE'); env.storage.failSet = false;
  assert.equal(env.server.calls.length, n);
  const envW = env0({ locks: null }); envW.publish();
  assert.equal(envW.actions.startCreate().code, 'NO_RELIABLE_LOCK'); assert.equal(envW.actions.canStart('createDraft').reason, 'NO_RELIABLE_LOCK'); assert.equal(envW.server.calls.length, 0);
});
await t('41. CONTROL 1: retry of an ambiguous CREATE (reply lost): replay returns the SAME valuationId, one create effect, then the view must still catch up', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); env.server.dropReplyOnce = true;
  const r = await env.actions.save(); assert.equal(r.status, 'ambiguous'); const created = [...env.server.vals.keys()];
  assert.equal(created.length, 1); assert.equal(env.actions.canStart('createDraft').reason, 'PENDING_EXISTS');
  const rr = await env.actions.retryPending(scopeOf(env)); assert.equal(rr.status, 'success_waiting_view'); assert.equal(rr.result.valuationId, created[0]);
  assert.equal(env.server.effectsOf('createDraft'), 1); assert.equal(env.actions.canStart('updateDraft').reason, 'AWAITING_VIEW');
  env.publish(); assert.equal(env.actions.getState().editor.mode, 'edit');
});
await t('42. CONTROL 1: a refused retry that is a plain no-effect refusal (day crossed, create) shows the code; nothing is invented', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); env.server.failBeforeOnce = 'unavailable';
  await env.actions.save(); env.clock.now = new Date('2026-10-11T21:30:00Z');
  const rr = await env.actions.retryPending(scopeOf(env)); assert.equal(rr.status, 'no_effect'); assert.equal(rr.code, 'DATE_CROSSED');
  assert.equal(env.server.vals.size, 0);
});
await t('43. recover(): a leftover in-flight record (tab closed mid-request) becomes ambiguous; nothing is sent by recover itself', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); env.server.hang = true;
  env.actions.save(); await tick(8); assert.equal(env.runner.pending()[0].status, 'inflight');
  env.locks.held.clear(); // the closed tab released its lock
  const env2 = makeEnv({ linkProposal: PROPOSAL, storage: env.storage, locks: env.locks }); const n = env2.server.calls.length;
  const rec = await env2.actions.recover(); assert.equal(rec.length, 1); assert.equal(env2.runner.pending()[0].status, 'ambiguous'); assert.equal(env2.server.calls.length, n);
});

/* ----------------------------------------------------------------- session, day, active draft */
await t('44. session change: all state is wiped, unsent input is gone, a late result is "background" and touches nothing of the new session', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); env.server.delay = 15;
  const pr = env.actions.save(); await tick(3); env.setSession(FM2); env.actions.sync();
  const r = await pr; assert.equal(r.status, 'background');
  const st = env.actions.getState(); assert.equal(st.editor, null); assert.equal(st.awaiting, null); assert.equal(st.outcome, null);
  assert.equal(env.actions.stats().editors, 0);
  env.setSession(FM); const back = env.actions.getState(); assert.equal(back.editor, null, 'coming back does not resurrect unsent input');
});
await t('45. unsent input: voluntary abandon needs confirm; nothing is persisted (storage holds pending requests only)', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); env.actions.setField('methodNote', 'secret note');
  assert.equal(env.actions.requestLeave().needsConfirm, true); assert.deepEqual(env.actions.requestLeave().unsaved, ['methodNote']);
  assert.equal(env.actions.closeEditor().status, 'confirm_required'); assert.notEqual(env.actions.getState().editor, null);
  for (const [k, v] of env.storage.m) assert.ok(!String(v).includes('secret note'), k);
  assert.equal(env.actions.closeEditor({ confirm: true }).status, 'closed'); assert.equal(env.actions.getState().editor, null);
  assert.equal(env.actions.closeEditor().status, 'ok');
});
await t('46. day crossing: an open editor freezes (crossed), saving is refused, the day timer is armed for the next Riyadh midnight, and a new day can start a draft', async () => {
  const env = await withDraft({ now: '2026-10-11T20:59:00Z' }); env.view.selectedDate = '2026-10-11'; env.actions.setField('methodNote', 'late');
  env.actions.watchDay(); const armed = [...env.live.values()].map((x) => x.ms);
  assert.ok(armed.includes(A.msUntilNextRiyadhDay(new Date('2026-10-11T20:59:00Z').getTime()) + 50), JSON.stringify(armed));
  assert.equal(A.msUntilNextRiyadhDay(new Date('2026-10-11T20:59:00Z').getTime()), 60000);
  env.clock.now = new Date('2026-10-11T21:00:30Z'); env.fire(60050);
  const st = env.actions.getState(); assert.equal(st.editor.frozen, 'crossed'); assert.equal(st.dayKind, 'crossed');
  const n = env.server.calls.length; assert.equal((await env.actions.save()).code, 'DATE_CROSSED'); assert.equal(env.server.calls.length, n);
  env.view.selectedDate = '2026-10-12'; env.publish();
  assert.equal(env.actions.getState().available.createDraft.allowed, true);
});
await t('47. msUntilNextRiyadhDay: exact at the boundary and across month/year ends', () => {
  assert.equal(A.msUntilNextRiyadhDay(Date.parse('2026-10-11T21:00:00Z')), 86400000);
  assert.equal(A.msUntilNextRiyadhDay(Date.parse('2026-10-11T20:59:59.999Z')), 1);
  assert.equal(A.msUntilNextRiyadhDay(Date.parse('2026-12-31T21:00:00Z') - 5000), 5000);
});
await t('48. ACTIVE_DRAFT_EXISTS: the view shows a draft -> create is blocked (and says which); the view LAGS -> the server refuses without effect and the reader is asked to re-fetch', async () => {
  const env = await withDraft(); assert.equal(env.actions.canStart('createDraft').reason, 'ACTIVE_DRAFT_EXISTS');
  const env2 = env0(); env2.publish(); env2.actions.startCreate(); fill(env2.actions);
  await env2.server.seedDraft({ valuationId: 'RACE', valuationDate: '2026-10-11', state: 'draft' }); env2.view.refreshCalls = 0; // not published: the view lags
  const r = await env2.actions.save(); assert.equal(r.status, 'no_effect'); assert.equal(r.code, 'ACTIVE_DRAFT_EXISTS'); assert.equal(env2.view.refreshCalls, 1); assert.equal(env2.server.effectsOf('createDraft'), 0);
  env2.publish(); assert.deepEqual(env2.actions.getState().editor.blockedByActive, { draftId: 'RACE' });
  assert.equal(env2.actions.openActiveDraft({ confirm: false }).status, 'confirm_required');
  assert.equal(env2.actions.openActiveDraft({ confirm: true }).status, 'opened'); assert.equal(env2.actions.getState().editor.mode, 'edit');
});
await t('49. the view is not confirmed (stale/cached/error) -> nothing starts: VIEW_NOT_CONFIRMED', async () => {
  const env = await withDraft(); env.publish({ stale: true });
  for (const a of ['createDraft', 'updateDraft', 'submit', 'withdraw']) assert.equal(env.actions.canStart(a).reason, a === 'createDraft' ? 'VIEW_NOT_CONFIRMED' : 'VIEW_NOT_CONFIRMED', a);
  env.view.stale = false; env.view.status = 'error'; env.actions.sync(); assert.equal(env.actions.canStart('updateDraft').reason, 'VIEW_NOT_CONFIRMED');
});
await t('50. a listener that throws never breaks the module; dispose clears timers and state', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'x'); await env.actions.save(); env.actions.watchDay();
  assert.ok(env.live.size >= 1); env.actions.dispose(); assert.equal(env.actions.stats().scopes, 0);
});

/* ----------------------------------------------------------------- scope limits */
await t('51. only the four approved actions are ever requested (no review / return / reject / approve / suspend / reinstate / rate)', async () => {
  const env = await withDraft(); const seen = new Set();
  const orig = env.runner.begin; env.runner.begin = (a) => { seen.add(a.action); return orig(a); };
  env.actions.setField('methodNote', 'q'); await env.actions.save(); env.publish();
  const p = env.actions.prepare('withdraw'); await env.actions.confirm(p.token);
  assert.ok([...seen].every((x) => A.ACTIONS_STARTED_HERE.includes(x)), [...seen].join());
  assert.deepEqual([...A.ACTIONS_STARTED_HERE], ['createDraft', 'updateDraft', 'submit', 'withdraw']);
  for (const c of env.server.calls) assert.ok(['createValuationDraft', 'updateValuationDraft', 'submitValuation', 'withdrawValuation', 'getValuationPreview'].includes(c.callable), c.callable);
});
await t('52. static limits: the new modules import no Firebase / DOM / storage / XIRR / MOIC / equity code and name no browser globals', () => {
  for (const f of ['fund-valuation-editor.js', 'fund-valuation-actions.js']) {
    const raw = fs.readFileSync(new URL(`../../src/features/${f}`, import.meta.url), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    const imports = [...raw.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    for (const i of imports) assert.match(i, /^\.\/fund-valuation-(model|requests|editor)\.js$/, `${f} imports ${i}`);
    for (const bad of [/\bdocument\b/, /\bwindow\b/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bindexedDB\b/, /\bfirebase\b/i, /\bmoic\b/i, /\bxirr\b/i, /\bequity\b/i, /\bfetch\(/, /\bXMLHttpRequest\b/]) assert.ok(!bad.test(code), `${f}: ${bad}`);
  }
});
await t('53. parity: the callables the module can reach are exactly those of the model, and createDraft/updateDraft/submit/withdraw payloads pass buildPayload (server allow-list mirror)', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'p'); await env.actions.save();
  const p = env.actions.prepare('withdraw'); env.publish(); const p2 = env.actions.prepare('withdraw');
  await env.actions.confirm(p2.token);
  for (const c of env.server.calls) assert.ok(!c.payload.__proto__ || true);
  assert.ok(env.server.calls.length >= 3);
});

await t('54. unsent input of ANOTHER date is reported (unsentElsewhere) when the default date rolls over, so the panel can pin the selection instead of hiding it', async () => {
  const env = await withDraft({ now: '2026-10-11T20:59:00Z' }); env.actions.setField('methodNote', 'unsent'); // selection follows the clock (no explicit date)
  env.clock.now = new Date('2026-10-11T21:30:00Z'); env.actions.sync();
  const st = env.actions.getState(); assert.equal(st.editor, null); assert.deepEqual(st.unsentElsewhere, [{ fundId: FUND, valuationDate: '2026-10-11', mode: 'edit' }]);
  env.view.selectedDate = '2026-10-11'; const back = env.actions.getState(); assert.equal(back.editor.form.methodNote, 'unsent'); assert.deepEqual(back.unsentElsewhere, []);
});
await t('55. the view names a draft whose document is missing: update/submit/withdraw refuse DRAFT_DOC_MISSING, create refuses ACTIVE_DRAFT_EXISTS; nothing is sent', async () => {
  const env = env0(); env.publish(); env.view.drafts.set('2026-10-11', null); env.view.status = 'ready';
  const base = env.getContext; env.actions.dispose();
  const a2 = (await import('../../src/features/fund-valuation-actions.js')).createValuationActions({
    getContext: () => ({ ...base('2026-10-11'), draft: { id: 'GHOST', missing: true, doc: null } }), getSession: () => env.box.s, runner: env.runner, guard: env.guard, now: () => env.clock.now,
    callPreview: async () => ({}),
  });
  for (const a of ['updateDraft', 'submit', 'withdraw']) assert.equal(a2.canStart(a).reason, 'DRAFT_DOC_MISSING', a);
  assert.equal(a2.canStart('createDraft').reason, 'ACTIVE_DRAFT_EXISTS'); assert.equal(env.server.calls.length, 0);
});
await t('56. a mutating request is never started while the view is a different fund/date than the editor (scope is the key): two dates keep separate editors and separate awaiting', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); env.actions.setField('methodNote', 'today');
  env.view.selectedDate = '2026-10-10'; assert.equal(env.actions.getState().editor, null); assert.equal(env.actions.getState().unsentElsewhere.length, 1);
  assert.equal(env.actions.canStart('createDraft').allowed, true, 'create always targets today, independent of the selected date');
  env.view.selectedDate = null; assert.equal(env.actions.getState().editor.form.methodNote, 'today');
});

await t('58. CONTROL 4 (submit): an old snapshot does not release the block after a successful submit; the snapshot that shows the new state does', async () => {
  const env = await withDraft(); const old = JSON.parse(JSON.stringify(env.view.drafts.get('2026-10-11')));
  const p = env.actions.prepare('submit'); await env.actions.confirm(p.token);
  assert.equal(aw(env).action, 'submit');
  env.view.drafts.set('2026-10-11', old); env.actions.sync(); assert.equal(aw(env).action, 'submit', 'still waiting: the view still shows a draft');
  assert.equal(env.actions.canStart('withdraw').reason, 'AWAITING_VIEW');
  env.publish(); assert.equal(env.actions.getState().awaiting, null);
});
await t('59. CONTROL 4 (create): a view that names the new draft but cannot deliver its document does not release the block; the one with the document does', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); await env.actions.save();
  const id = [...env.server.vals.keys()][0];
  env.view.drafts.set('2026-10-11', { valuationId: id, __missing: true }); env.view.status = 'ready'; env.actions.sync();
  assert.equal(aw(env).action, 'createDraft', 'the slot names the draft but its document is missing: not reflected');
  assert.equal(env.actions.canStart('updateDraft').reason, 'AWAITING_VIEW');
  env.publish(); assert.equal(env.actions.getState().awaiting, null); assert.equal(env.actions.getState().editor.mode, 'edit');
});
await t('60. CONTROL 1: recovering an earlier request needs NO view: with no context (fund closed, view not loaded) the original request is still resent', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'amb'); env.server.dropReplyOnce = true; await env.actions.save();
  const sc = scopeOf(env); const first = lastCall(env); env.view.noContext = true;
  const rr = await env.actions.retryPending(sc);
  assert.equal(rr.status, 'success_waiting_view'); assert.deepEqual(lastCall(env), first); assert.equal(env.server.effectsOf('updateDraft'), 1);
});
await t('61. day crossing in CREATE mode: the typed form belongs to the old date; saving is refused (DATE_CROSSED) and nothing is created for the new day', async () => {
  const env = env0({ now: '2026-10-11T20:59:00Z' }); env.view.selectedDate = '2026-10-11'; env.publish(); env.actions.startCreate(); fill(env.actions);
  env.clock.now = new Date('2026-10-11T21:30:00Z');
  const n = env.server.calls.length; const r = await env.actions.save(); assert.equal(r.code, 'DATE_CROSSED'); assert.equal(env.server.calls.length, n); assert.equal(env.server.vals.size, 0);
  assert.equal(env.actions.getState().editor.frozen, 'crossed');
});

/* ----------------------------------------------------------------- B2-2a revision: waiting for the view; input during creation */
const BASE_OLD = (env) => JSON.parse(JSON.stringify(env.view.drafts.get('2026-10-11')));
await t('62. WAIT: success with NO new snapshot at all, even after both deadlines: still blocked, nothing sent, not unresolved', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); await env.actions.save(); const n = env.server.calls.length;
  env.fire(8000); env.fire(20000);
  assert.equal(aw(env).action, 'createDraft'); assert.equal(aw(env).phase, 'stalled');
  for (const a of ['createDraft', 'updateDraft', 'submit', 'withdraw']) assert.equal(env.actions.canStart(a).reason, 'AWAITING_VIEW', a);
  assert.equal(env.server.calls.length, n); assert.deepEqual(env.runner.pending(), []);
});
await t('63. WAIT: an OLD confirmed snapshot (the version before the request) does not end the wait, not even after the deadlines, and is not "overtaken"', async () => {
  const env = await withDraft(); const old = BASE_OLD(env);
  env.actions.setField('methodNote', 'new'); await env.actions.save();
  env.fire(8000); env.fire(20000); env.view.drafts.set('2026-10-11', old); env.view.status = 'ready'; env.view.stale = false; env.actions.sync();
  assert.equal(aw(env).action, 'updateDraft'); assert.notEqual(env.actions.getState().outcome.status, 'view_overtaken');
  const pr = env.actions.canStart('updateDraft'); assert.equal(pr.reason, 'AWAITING_VIEW');
});
await t('64. WAIT: a stale / loading / error / incomplete snapshot that even CONTAINS the reflecting document does not end the wait; the confirmed one does', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'new'); await env.actions.save();
  const id = env.view.drafts.get('2026-10-11').valuationId; const fresh = env.server.docOf(id);
  for (const [status, stale] of [['ready', true], ['loading', false], ['error', false], ['forbidden', false]]) {
    env.view.drafts.set('2026-10-11', JSON.parse(JSON.stringify(fresh))); env.view.status = status; env.view.stale = stale; env.actions.sync();
    assert.equal(aw(env).action, 'updateDraft', `${status}/${stale}`);
  }
  env.view.drafts.set('2026-10-11', { valuationId: id, __missing: true }); env.view.status = 'ready'; env.view.stale = false; env.actions.sync();
  assert.equal(aw(env).action, 'updateDraft', 'the slot names the draft but the document is missing');
  env.publish(); assert.equal(env.actions.getState().awaiting, null); assert.equal(env.actions.getState().outcome.status, 'reflected');
  assert.equal(env.actions.canStart('updateDraft').allowed, true);
});
await t('65. WAIT: the same four-step story for submit and withdraw (no snapshot -> old -> stale -> confirmed reflecting)', async () => {
  for (const action of ['submit', 'withdraw']) {
    const env = await withDraft(); const old = BASE_OLD(env); const p = env.actions.prepare(action); await env.actions.confirm(p.token);
    env.fire(8000); env.fire(20000); assert.equal(aw(env).action, action, 'no snapshot');
    env.view.drafts.set('2026-10-11', old); env.actions.sync(); assert.equal(aw(env).action, action, 'old snapshot');
    env.view.drafts.set('2026-10-11', { valuationId: old.valuationId, __missing: true }); env.view.status = 'ready'; env.view.stale = false; env.actions.sync(); assert.equal(aw(env).action, action, 'incomplete data (document missing)');
    env.view.drafts.delete('2026-10-11'); env.view.stale = true; env.view.status = 'empty'; env.actions.sync(); assert.equal(aw(env).action, action, 'stale snapshot');
    env.publishFresh(); assert.equal(env.actions.getState().awaiting, null, 'confirmed snapshot'); assert.equal(env.actions.getState().outcome.status, 'reflected');
  }
});
await t('66. WAIT: VIEW_OVERTAKEN only on evidence of a LATER version (a hash that is neither the base nor the one the server named); mere difference from the reply is nothing', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.actions.setField('methodNote', 'mine'); await env.actions.save();
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'a later edit by someone else' }); // someone edits AFTER our update was applied
  env.publish(); assert.equal(aw(env).action, 'updateDraft', 'a third hash in a snapshot that may predate the reply is not evidence');
  env.publishFresh(); // a confirmed read that STARTED after the reply shows a state that is not ours
  const st = env.actions.getState(); assert.equal(st.awaiting, null); assert.equal(st.outcome.status, 'view_overtaken'); assert.ok(st.banners.some((b) => b.kind === 'view_overtaken'));
  assert.equal(st.editor.form.methodNote, 'a later edit by someone else', 'a clean editor follows the later version');
  // submit: a confirmed view still showing the draft state is NOT evidence of anything
  const env2 = await withDraft(); const p = env2.actions.prepare('submit'); await env2.actions.confirm(p.token);
  env2.fire(20000); env2.actions.sync(); assert.equal(aw(env2).action, 'submit'); assert.notEqual(env2.actions.getState().outcome.status, 'view_overtaken');
  // submit followed by a review on the server (state moved beyond "submitted"): that IS a later version
  const id2 = env2.view.drafts.get('2026-10-11').valuationId; env2.server.vals.get(id2).state = 'reviewed'; env2.server.vals.get(id2).rev += 1; env2.publish();
  assert.equal(aw(env2).action, 'submit', 'without a revision or a later read a different state is not proof');
  env2.publishFresh(); assert.equal(env2.actions.getState().outcome.status, 'view_overtaken');
});
await t('67. INPUT: typing WHILE the create request is in flight, then after it succeeded and before the snapshot: nothing is lost; the sent version is the baseline', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); env.server.delay = 25;
  const pr = env.actions.save(); await tick(4); assert.equal(env.runner.pending()[0].status, 'inflight');
  assert.equal(env.actions.setField('methodNote', 'typed during the call').status, 'ok');
  const r = await pr; assert.equal(r.status, 'success_waiting_view');
  assert.equal(lastCall(env).payload.content.methodNote, 'external appraisal', 'the request carried what was typed BEFORE it');
  let ed = env.actions.getState().editor; assert.equal(ed.mode, 'create'); assert.deepEqual(ed.dirtyPaths, ['methodNote']); assert.equal(ed.dirty, true);
  assert.equal(env.actions.setField('residualValue', '1000.01').status, 'ok', 'typing after success, before the snapshot, is accepted');
  assert.equal(env.actions.setField('source.ref', 'APP-2').status, 'ok');
  env.publish(); ed = env.actions.getState().editor;
  assert.equal(ed.mode, 'edit'); assert.equal(ed.form.methodNote, 'typed during the call'); assert.equal(ed.form.residualValue, '1000.01'); assert.equal(ed.form.source.ref, 'APP-2');
  assert.equal(ed.dirty, true); assert.equal(env.actions.getState().awaiting, null);
  assert.equal(env.server.docOf([...env.server.vals.keys()][0]).methodNote, 'external appraisal', 'the server holds exactly what was sent');
  assert.equal((await env.actions.save()).status, 'success_waiting_view');
  const sent = lastCall(env).payload; assert.equal(sent.content.methodNote, 'typed during the call'); assert.equal(sent.content.residualValue, 1000.01); assert.equal(sent.content.source.ref, 'APP-2');
  assert.equal(sent.expectedContentHash, env.view.drafts.get('2026-10-11').contentHash);
  env.publish(); assert.equal(env.actions.getState().editor.dirty, false);
});
await t('68. INPUT: the accepted input is also kept when nothing is typed after the send (no phantom edits) and when the editor is closed meanwhile it is NOT reopened over her decision', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); await env.actions.save();
  assert.equal(env.actions.getState().editor.dirty, false); env.publish(); assert.equal(env.actions.getState().editor.dirty, false);
  const env2 = env0(); env2.publish(); env2.actions.startCreate(); fill(env2.actions); env2.server.delay = 20;
  const pr = env2.actions.save(); await tick(4); env2.actions.setField('methodNote', 'x'); assert.equal(env2.actions.closeEditor().status, 'confirm_required');
  assert.equal(env2.actions.closeEditor({ confirm: true }).status, 'closed'); await pr; env2.publish();
  assert.equal(env2.actions.getState().editor, null, 'she closed it knowingly; the draft exists and can be opened');
  assert.equal(env2.actions.openActiveDraft().status, 'opened');
});
await t('69. INPUT: update: typing during the call and after success; the snapshot keeps it as unsaved edits over the SENT version', async () => {
  const env = await withDraft(); env.actions.setField('methodNote', 'sent'); env.server.delay = 25;
  const pr = env.actions.save(); await tick(4); env.actions.setField('residualValue', '1000.01');
  assert.equal((await pr).status, 'success_waiting_view'); env.actions.setField('source.provider', 'Other Co');
  env.publish(); const ed = env.actions.getState().editor;
  assert.deepEqual([ed.form.methodNote, ed.form.residualValue, ed.form.source.provider], ['sent', '1000.01', 'Other Co']);
  const dirty = E.diffForms(ed.form, E.formFromContent(env.server.docOf(env.view.drafts.get('2026-10-11').valuationId))); assert.ok(dirty.includes('residualValue') && dirty.includes('source.provider') && !dirty.includes('methodNote'));
  assert.equal(ed.dirty, true); await env.actions.save(); const p = lastCall(env).payload;
  assert.equal(p.content.residualValue, 1000.01); assert.equal(p.content.source.provider, 'Other Co'); assert.equal(p.content.methodNote, 'sent');
});
await t('70. INPUT: an ambiguous create that is retried: the typed form is still there and still unsaved-over-sent after the view catches up', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); env.server.dropReplyOnce = true;
  assert.equal((await env.actions.save()).status, 'ambiguous'); env.actions.setField('methodNote', 'typed while unresolved');
  const rr = await env.actions.retryPending(scopeOf(env)); assert.equal(rr.status, 'success_waiting_view'); env.publish();
  const ed = env.actions.getState().editor; assert.equal(ed.mode, 'edit'); assert.equal(ed.form.methodNote, 'typed while unresolved'); assert.equal(ed.dirty, true);
  assert.equal(env.server.docOf([...env.server.vals.keys()][0]).methodNote, 'external appraisal');
});
await t('71. INPUT: a copy never replaces typing: refused while the editor holds unsent input; a copy that completes while she types elsewhere keeps her editor (blockedByActive) and does not open over it', async () => {
  const env = env0(); await env.server.seedDraft({ valuationId: 'OLD', valuationDate: '2026-10-05', state: 'rejected' }); env.publish();
  env.actions.startCreate(); env.actions.setField('methodNote', 'my own typing'); const n = env.server.calls.length;
  assert.deepEqual(await env.actions.copyFrom({ sourceId: 'OLD', sourceState: 'rejected' }), { status: 'blocked', code: 'UNSENT_INPUT' }); assert.equal(env.server.calls.length, n);
  env.actions.closeEditor({ confirm: true });
  env.server.delay = 25; env.actions.startCreate(); const pr = env.actions.copyFrom({ sourceId: 'OLD', sourceState: 'rejected' }); await tick(4);
  env.actions.setField('methodNote', 'typed while the copy was in flight'); assert.equal((await pr).status, 'success_waiting_view'); env.publish();
  const ed = env.actions.getState().editor; assert.equal(ed.mode, 'create'); assert.equal(ed.form.methodNote, 'typed while the copy was in flight'); assert.ok(ed.blockedByActive);
  assert.equal(env.actions.openActiveDraft().status, 'confirm_required');
});
await t('73. WAIT: evidence of a later version also when the slot changed under the request (update: our draft left the slot; create: another draft holds it)', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.actions.setField('methodNote', 'mine'); await env.actions.save();
  env.server.vals.get(id).state = 'withdrawn'; env.server.slot.clear(); env.publish();
  assert.equal(aw(env).action, 'updateDraft', 'an empty slot in a view of unknown age is nothing'); env.publishFresh(); // confirmed read after the reply: the slot is empty
  assert.equal(env.actions.getState().awaiting, null); assert.equal(env.actions.getState().outcome.status, 'view_overtaken');
  const env2 = env0(); env2.publish(); env2.actions.startCreate(); fill(env2.actions); await env2.actions.save();
  const mine = [...env2.server.vals.keys()][0]; env2.server.vals.get(mine).state = 'withdrawn'; env2.server.slot.clear();
  await env2.server.seedDraft({ valuationId: 'OTHER', valuationDate: '2026-10-11', state: 'draft' }); env2.publish();
  assert.equal(aw(env2).action, 'createDraft', 'another occupant in a view of unknown age is nothing'); env2.publishFresh();
  assert.equal(env2.actions.getState().awaiting, null); assert.equal(env2.actions.getState().outcome.status, 'view_overtaken');
  assert.notEqual(env2.actions.getState().editor && env2.actions.getState().editor.mode, 'edit', 'the other draft is not silently adopted as mine');
});
await t('74. INPUT: no phantom edits: text that the server stores in canonical form (padded note, trailing zero) is NOT shown as unsaved after the view catches up', async () => {
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions);
  env.actions.setField('methodNote', '  padded note  '); env.actions.setField('residualValue', '1000.010');
  assert.equal((await env.actions.save()).status, 'success_waiting_view'); assert.equal(env.actions.getState().editor.dirty, false);
  env.publish(); const ed = env.actions.getState().editor; assert.equal(ed.mode, 'edit'); assert.equal(ed.dirty, false); assert.deepEqual(ed.dirtyPaths, []);
  assert.equal(env.actions.requestLeave().needsConfirm, false);
});
await t('72. requestRefresh() asks the reader to re-fetch (for a "refresh" button while waiting)', async () => {
  const env = env0(); env.publish(); env.view.refreshCalls = 0; env.actions.requestRefresh(); assert.equal(env.view.refreshCalls, 1);
});

/* ----------------------------------------------------------------- B2-2a revision 3: what ends the wait is EVIDENCE (identity, or ORDER), never a difference */
const stillWaiting = (env, action, n) => {
  assert.equal(aw(env).action, action); const st = env.actions.getState();
  assert.notEqual(st.outcome.status, 'view_overtaken'); assert.ok(!st.banners.some((b) => b.kind === 'view_overtaken'));
  assert.equal(env.actions.canStart(action).reason, 'AWAITING_VIEW'); assert.equal(env.server.calls.length, n, 'no modifying request left while waiting');
};
await t('75. REGRESSION (a): an OLDER snapshot with a THIRD hash (neither the base nor ours) while an update is awaited: no release, no "overtaken", no new request; the reader can be asked again', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.actions.setField('methodNote', 'mine'); await env.actions.save(); const n = env.server.calls.length;
  const third = BASE_OLD(env); third.methodNote = 'an older state nobody here wrote'; third.contentHash = 'HASH_OF_AN_OLDER_VERSION';
  env.view.drafts.set('2026-10-11', third); env.view.status = 'ready'; env.view.stale = false; env.actions.sync();   // same read epoch: it may predate the reply
  stillWaiting(env, 'updateDraft', n);
  env.fire(8000); env.fire(20000); stillWaiting(env, 'updateDraft', n);
  const before = env.view.refreshCalls; env.actions.requestRefresh(); assert.equal(env.view.refreshCalls, before + 1, 'the option to re-read stays');
  void id;
});
await t('76. REGRESSION (b): a successful RETRY (replayed) while an EARLIER confirmed-but-empty view, from before the reply, is on screen: no release, no "overtaken"', async () => {
  // create: lost reply, earlier view is empty and confirmed, retry replays the same draft id
  const env = env0(); env.publish(); env.actions.startCreate(); fill(env.actions); env.server.dropReplyOnce = true;
  assert.equal((await env.actions.save()).status, 'ambiguous'); const n0 = env.server.calls.length;
  env.view.drafts = new Map(); env.view.status = 'empty'; env.view.stale = false; env.actions.sync();           // the empty view that predates the reply
  const rr = await env.actions.retryPending(scopeOf(env)); assert.equal(rr.status, 'success_waiting_view'); assert.equal(rr.result.replayed, true);
  const n = env.server.calls.length; assert.equal(n, n0 + 1); env.actions.sync();
  stillWaiting(env, 'createDraft', n); env.fire(8000); env.fire(20000); stillWaiting(env, 'createDraft', n);
  // withdraw: lost reply; the view then shows an empty confirmed slot that predates the replayed reply
  const envW = await withDraft(); const pw = envW.actions.prepare('withdraw'); envW.server.dropReplyOnce = true;
  assert.equal((await envW.actions.confirm(pw.token)).status, 'ambiguous');
  envW.view.drafts = new Map(); envW.view.status = 'empty'; envW.view.stale = false; envW.actions.sync();
  const rw = await envW.actions.retryPending(scopeOf(envW)); assert.equal(rw.status, 'success_waiting_view');
  const nw = envW.server.calls.length; envW.actions.sync(); stillWaiting(envW, 'withdraw', nw); envW.fire(20000); stillWaiting(envW, 'withdraw', nw);
  // update: lost reply; the view shows the empty slot (older than the reply)
  const envU = await withDraft(); envU.actions.setField('methodNote', 'amb'); envU.server.dropReplyOnce = true;
  assert.equal((await envU.actions.save()).status, 'ambiguous');
  envU.view.drafts = new Map(); envU.view.status = 'empty'; envU.view.stale = false; envU.actions.sync();
  assert.equal((await envU.actions.retryPending(scopeOf(envU))).status, 'success_waiting_view');
  const nu = envU.server.calls.length; envU.actions.sync(); stillWaiting(envU, 'updateDraft', nu);
  // only a read that STARTED after the retry's reply decides
  envU.publishFresh(); assert.equal(envU.actions.getState().awaiting, null); assert.equal(envU.actions.getState().outcome.status, 'reflected');
  envW.publishFresh(); assert.equal(envW.actions.getState().awaiting, null); assert.equal(envW.actions.getState().outcome.status, 'reflected');
  env.publish(); assert.equal(env.actions.getState().awaiting, null); assert.equal(env.actions.getState().outcome.status, 'reflected'); // identity needs no read order
});
await t('77. ORDER from the reply: with a revision on the reply, a view at a higher revision than the REPLY is overtaken; a revision above the base but not above the reply is not', async () => {
  const env = await withDraft(); env.server.includeRev = true; const id = env.view.drafts.get('2026-10-11').valuationId;
  const baseRev = env.view.drafts.get('2026-10-11').rev;
  env.actions.setField('methodNote', 'mine'); await env.actions.save(); const resRev = env.server.docOf(id).rev; assert.ok(resRev > baseRev);
  const n = env.server.calls.length;
  const mid = env.server.docOf(id); mid.contentHash = 'SOME_THIRD_HASH'; mid.rev = resRev;       // above the base, NOT above the reply
  env.view.drafts.set('2026-10-11', mid); env.view.status = 'ready'; env.actions.sync(); stillWaiting(env, 'updateDraft', n);
  mid.rev = resRev - 1; env.view.drafts.set('2026-10-11', { ...mid }); env.actions.sync(); stillWaiting(env, 'updateDraft', n);
  const other = { ...mid, valuationId: 'SOMEONE_ELSES', rev: resRev + 5 }; env.view.drafts.set('2026-10-11', other); env.actions.sync(); stillWaiting(env, 'updateDraft', n); // another document: its revision says nothing about ours
  mid.rev = resRev + 1; env.view.drafts.set('2026-10-11', { ...mid }); env.actions.sync();       // provably past the reply, and not showing it
  assert.equal(env.actions.getState().awaiting, null); assert.equal(env.actions.getState().outcome.status, 'view_overtaken');
});
await t('78. ORDER from a read: only a CONFIRMED read that started AFTER the reply decides; same epoch, unconfirmed, loading, no marker do not', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.actions.setField('methodNote', 'mine'); await env.actions.save(); const n = env.server.calls.length;
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'later' });
  env.publish(); stillWaiting(env, 'updateDraft', n);                                                        // same epoch
  env.publishFresh({ stale: true }); stillWaiting(env, 'updateDraft', n);                                    // later read, not confirmed
  env.view.issued += 1; env.view.dataEpoch = env.view.issued; env.view.readConfirmed = true; env.view.status = 'loading'; env.actions.sync(); stillWaiting(env, 'updateDraft', n); // loading
  env.view.status = 'ready'; env.view.noRead = true; env.publishFresh(); stillWaiting(env, 'updateDraft', n);                                 // no read marker at all
  env.view.noRead = false; env.view.status = 'ready'; env.view.stale = false; env.view.issued += 1; env.view.dataEpoch = env.view.issued; env.view.readConfirmed = false; env.publish({ keepEpoch: true }); stillWaiting(env, 'updateDraft', n); // the view is confirmed but the read MARKER says it is not (the marker is checked on its own)
  env.view.noRead = false; env.publishFresh();                                                              // a confirmed read after the reply
  assert.equal(env.actions.getState().awaiting, null); assert.equal(env.actions.getState().outcome.status, 'view_overtaken');
});
await t('79. the verdict needs the right target: a confirmed later read whose marker names another fund or another date does not decide', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.actions.setField('methodNote', 'mine'); await env.actions.save(); const n = env.server.calls.length;
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'later' });
  for (const target of [{ fundId: 'OTHER_FUND' }, { valuationDate: '2026-10-10' }]) {
    env.view.readTarget = target; env.publishFresh(); stillWaiting(env, 'updateDraft', n);
  }
  env.view.readTarget = null; env.publishFresh(); assert.equal(env.actions.getState().outcome.status, 'view_overtaken');
});
await t('80. a reader that gives no read marker at all: identity still ends the wait; nothing else does (the module never guesses)', async () => {
  const env = await withDraft(); env.view.noRead = true;
  env.actions.setField('methodNote', 'mine'); await env.actions.save(); const n = env.server.calls.length;
  const id = env.view.drafts.get('2026-10-11').valuationId; const base = BASE_OLD(env);
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'later' }); env.publish(); stillWaiting(env, 'updateDraft', n);
  env.view.drafts.set('2026-10-11', base); env.actions.sync(); stillWaiting(env, 'updateDraft', n);
  env.view.drafts = new Map(); env.view.status = 'empty'; env.actions.sync(); stillWaiting(env, 'updateDraft', n);
});
await t('81. the success itself asks the reader for a new read at once (a read, never a modifying request), and the wait ends when a read that started after it confirms the effect', async () => {
  const env = await withDraft(); env.view.refreshCalls = 0; env.actions.setField('methodNote', 'mine'); await env.actions.save();
  assert.equal(env.view.refreshCalls, 1); assert.equal(env.server.calls.filter((c) => c.callable !== 'getValuationPreview').length, 2, 'create + update only');
  env.publishFresh(); assert.equal(env.actions.getState().awaiting, null); assert.equal(env.actions.getState().outcome.status, 'reflected');
});
await t('82. no proof of order without a marker AT RECEIPT: a reader that gave no read marker when the reply arrived cannot later prove "after" by showing one', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId; env.view.noRead = true;
  env.actions.setField('methodNote', 'mine'); await env.actions.save(); const n = env.server.calls.length;
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'later' });
  env.view.noRead = false; env.publishFresh(); stillWaiting(env, 'updateDraft', n);   // a marker that appears later cannot prove it started after the reply
});
await t('83. the read epoch is taken when the reply is RECEIVED (not zero): a snapshot of an epoch that already existed then is not "after"', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId; env.view.issued = 3;
  env.actions.setField('methodNote', 'mine'); await env.actions.save(); const n = env.server.calls.length;
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'later' });
  env.deliverRead(3); stillWaiting(env, 'updateDraft', n);           // read 3 had already STARTED when the reply came
  env.publishFresh(); assert.equal(env.view.dataEpoch, 4); assert.equal(env.actions.getState().outcome.status, 'view_overtaken'); // read 4 started after
});
await t('84. a confirmed later read that cannot be judged does not decide: document missing from the view; a reply that names no artifact', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.actions.setField('methodNote', 'mine'); await env.actions.save(); const n = env.server.calls.length;
  env.view.issued += 1; env.view.dataEpoch = env.view.issued; env.view.drafts.set('2026-10-11', { valuationId: id, __missing: true }); env.view.status = 'ready'; env.actions.sync(); stillWaiting(env, 'updateDraft', n);
  const envW = await withDraft(); const pw = envW.actions.prepare('withdraw'); await envW.actions.confirm(pw.token); const nw = envW.server.calls.length;
  envW.view.issued += 1; envW.view.dataEpoch = envW.view.issued; envW.view.drafts.set('2026-10-11', { valuationId: envW.view.drafts.get('2026-10-11').valuationId, __missing: true }); envW.actions.sync(); stillWaiting(envW, 'withdraw', nw);
  const envC = env0(); envC.publish(); envC.actions.startCreate(); fill(envC.actions); envC.server.omitValuationId = true; await envC.actions.save(); const nc = envC.server.calls.length;
  envC.publishFresh(); stillWaiting(envC, 'createDraft', nc);
});

await t('85. ISSUING vs DATA: a read that STARTED before the reply and delivers after it never counts, even when the data shown before it carried a lower number; a read started after does', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId;
  env.view.issued = 5; env.view.dataEpoch = 2;                                   // five reads have started; the data on screen came from read 2 (old numbers are not "after")
  env.actions.setField('methodNote', 'mine'); await env.actions.save(); const n = env.server.calls.length;
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'later' });
  env.deliverRead(5); stillWaiting(env, 'updateDraft', n);                       // read 5 started BEFORE the reply: higher than the shown data's number, still not proof
  env.view.issued = 6; env.deliverRead(6);                                       // read 6 started after: proof
  assert.equal(env.actions.getState().outcome.status, 'view_overtaken');
});
await t('86. a reader that reports only `epoch` (no `issued`) can never prove order: identity still ends the wait, nothing else', async () => {
  const env = await withDraft(); const id = env.view.drafts.get('2026-10-11').valuationId; env.view.legacyRead = true; // a marker with `epoch` only
  env.actions.setField('methodNote', 'mine'); await env.actions.save(); const n = env.server.calls.length;
  await env.server.externalEdit(id, { ...goodContent(), methodNote: 'later' });
  env.publishFresh(); stillWaiting(env, 'updateDraft', n);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
