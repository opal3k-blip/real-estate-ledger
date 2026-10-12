/* XIRR-R1B2 / B2-2a — fund residual-valuation ACTIONS orchestrator (no DOM, no Firebase, no XIRR import, no direct storage).
   It binds three things that already exist: the reader's view (B2-1), the request runner (B2-0) and the editor model (B2-2a).
   Everything comes in by injection: getContext, getSession, runner, callPreview, refreshView, now, timers.

   Rules this module is built around (approved 2026-10-11):
   1. STARTING a new action and RECOVERING an earlier request are different things. Starting is gated by the day, the state, the
      head, the freshness of the view; recovering (retryPending / discardPending) is gated only by the session, the lock and the
      storage, and resends the original requestId and payload verbatim. A refused retry stays "unresolved" (B2-0).
   2. "Check now" checks the version STORED on the server. Unsaved edits are not checked and the result never says they were.
      A preview reply is bound to (session generation, valuation, stored content hash, sequence); a late reply is dropped.
   3. Coverage is never an automatic statement; a copy is a new draft whose content and coverage still have to be reviewed.
   4. After a request succeeded and before a CONFIRMED view that REFLECTS its effect arrives, nothing new may be sent from the old view.
      "Succeeded, waiting for the view" and "outcome unresolved" are different states. An unresolved request is never settled
      by inference from the event log; this module does not read events at all. Only a snapshot ends the wait (never a timer, never a
      stale / loading / incomplete snapshot): a timer may ask the reader to re-fetch or show that the view is late, nothing more.
      What ends the wait is EVIDENCE, of two kinds only: (a) IDENTITY: the view shows the very artifact the reply names (the draft id the
      create returned; the content hash the update returned; the state the submit/withdraw returned) - never merely something different;
      (b) ORDER: either the reply carries a revision and the view's document is at/after it, or a CONFIRMED read that STARTED AFTER the reply
      was received (ctx.read.epoch > the epoch recorded at receipt, same fund/date/session, confirmed) shows the state. A different hash, a
      missing draft or another occupant of the slot is never enough by itself; ABSENCE (empty slot) counts only under (b).
      VIEW_OVERTAKEN needs (b) and a state that does not show the effect. Without evidence the wait stays and the reader is asked to re-read.
   5. Input typed while a request is in flight or while the view catches up is never replaced: it stays as unsaved edits over the version
      that was SENT (the baseline becomes the sent form when the request succeeds).
   6. The server is the authority. Submit and withdraw carry no fingerprint on the server (contract §6.1); the guard here
      (prepare/confirm + snapshot comparison) is a courtesy and does not prevent a race on the server. */
import {
  availableActions, riyadhDay, classifyDate, snapshotOf, diffSnapshots, createGenerationGuard, createSessionTracker, describeError, canRead,
} from './fund-valuation-model.js';
import { scopeKey } from './fund-valuation-requests.js';
import * as E from './fund-valuation-editor.js';

export const AWAIT_DELAYED_MS = 8000;   // "the view is late": ask the reader to re-fetch from the server
export const AWAIT_STALLED_MS = 20000;  // "still not reflected": if the view is confirmed and still different, it was overtaken
const ACTIONS_STARTED_HERE = Object.freeze(['createDraft', 'updateDraft', 'submit', 'withdraw']);

export function msUntilNextRiyadhDay(nowMs) {
  const DAY = 86400000; const local = nowMs + 3 * 3600000; // Asia/Riyadh is fixed UTC+3, no DST
  return DAY - (((local % DAY) + DAY) % DAY);
}
const lc = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const pickResult = (d) => (d && typeof d === 'object' ? { action: d.action ?? null, valuationId: d.valuationId ?? null, fundId: d.fundId ?? null, valuationDate: d.valuationDate ?? null, state: d.state ?? null, contentHash: d.contentHash ?? null, rev: Number.isInteger(d.rev) ? d.rev : null, replayed: d.replayed === true } : {});
const contentOfDoc = (doc) => { const c = {}; if (doc) for (const k of E.CONTENT_KEYS) if (doc[k] !== undefined) c[k] = doc[k]; return c; };
const sectionOf = (path) => {
  const p = path.replace(/#len$/, '');
  const m = p.match(/^(otherAssetsItems|coverage\.unlinkedHoldings\.items)(\.|$)/); if (m) return m[1];
  if (/^coverage\.linkedAssets/.test(p)) return 'coverage.linkedAssets';
  return p;
};
const getIn = (o, path) => path.split('.').reduce((c, k) => (c == null ? undefined : c[k]), o);
const setIn = (o, path, v) => { const parts = path.split('.'); let c = o; for (const k of parts.slice(0, -1)) c = c[k]; c[parts[parts.length - 1]] = v; };

export function createValuationActions(deps) {
  const {
    getContext, getSession, runner, callPreview, refreshView = () => {}, now = () => new Date(), onChange = () => {},
    awaitDelayedMs = AWAIT_DELAYED_MS, awaitStalledMs = AWAIT_STALLED_MS, setTimer = setTimeout, clearTimer = clearTimeout,
  } = deps;
  const guard = deps.guard || createGenerationGuard();
  let states = new Map();   // scopeKey(user,fund,date) -> per-scope state; wiped on any session change
  let tokenSeq = 0; let dayTimer = null;
  const tracker = createSessionTracker({ guard, onReset: () => reset() });
  const notify = () => { try { onChange(); } catch (e) { /* a listener never breaks the module */ } };
  const unsubRunner = typeof runner.subscribe === 'function' ? runner.subscribe(notify) : () => {};

  function reset() {
    for (const s of states.values()) { if (s.awaiting) clearAwaitTimers(s.awaiting); }
    states = new Map(); notify();
  }
  function sync() {
    const s = getSession();
    tracker.update(s ? { uid: s.uid, email: s.email, role: s.role } : null);
    const sess = session();
    if (sess) for (const [k, st] of states) { refreshScope(st, k); }
    return sess;
  }
  function session() { const s = getSession(); return s && s.uid && s.email && canRead(s.role) ? { uid: s.uid, email: lc(s.email), role: s.role } : null; }
  const today = () => riyadhDay(now());

  function ctxFor(date) {
    let c; try { c = date === undefined ? getContext() : getContext(date); } catch (e) { return null; }
    if (!c || !c.fundId || !c.valuationDate) return null;
    return c;
  }
  const keyOf = (sess, ctx) => scopeKey({ user: sess.email, fundId: ctx.fundId, valuationDate: ctx.valuationDate });
  function stateOf(key, ctx) {
    if (!states.has(key)) states.set(key, { fundId: ctx.fundId, valuationDate: ctx.valuationDate, editor: null, awaiting: null, preview: null, prepared: null, outcome: null, copyReviews: new Map(), previewSeq: 0, sentForms: new Map() });
    return states.get(key);
  }
  const draftDoc = (ctx) => (ctx && ctx.draft && !ctx.draft.missing && ctx.draft.doc ? ctx.draft.doc : null);
  const viewConfirmed = (ctx) => !ctx.stale && (ctx.status === 'ready' || ctx.status === 'empty');

  /* ---------------- gating: STARTING a new action ---------------- */
  const no = (reason) => ({ allowed: false, reason });
  function gate(action, ctx, sess, st) {
    if (!sess) return no('NO_SESSION');
    if (!ctx) return no('NO_CONTEXT');
    if (runner.isBlocked({ fundId: ctx.fundId, valuationDate: ctx.valuationDate })) return no('PENDING_EXISTS'); // also true when unknown (fail closed)
    if (st && st.awaiting) return no('AWAITING_VIEW');
    if (!viewConfirmed(ctx)) return no('VIEW_NOT_CONFIRMED');
    const mg = runner.mutationGate(); if (!mg.allowed) return no(mg.reasons[0]);
    const doc = draftDoc(ctx);
    if (action !== 'createDraft' && ctx.draft && ctx.draft.missing) return no('DRAFT_DOC_MISSING');
    const preview = st && st.preview && st.preview.status === 'done' ? st.preview.reply : null;
    const av = availableActions({ role: sess.role, email: sess.email, today: today(), valuation: doc || undefined, head: { activeDraftId: ctx.draft ? ctx.draft.id : null }, createDate: ctx.valuationDate, stale: !!(preview && preview.stale === true) })[action];
    if (!av || !av.allowed) return no(av ? av.reason : 'ACTION_UNKNOWN');
    if (action === 'updateDraft' || action === 'submit' || action === 'withdraw') {
      if (!doc) return no('NO_TARGET');
    }
    return { allowed: true, reason: null };
  }

  /* ---------------- per-scope refresh on every view change ---------------- */
  function copyReviewFor(st, doc) {
    if (!doc || !doc.copiedFrom) return null;
    if (!st.copyReviews.has(doc.valuationId)) st.copyReviews.set(doc.valuationId, E.newCopyReview({ kind: E.COPY_KINDS.SERVER_COPY, sourceId: doc.copiedFrom }));
    return st.copyReviews.get(doc.valuationId);
  }
  const startedFromDoc = (doc) => ({ valuationId: doc.valuationId, contentHash: doc.contentHash ?? null, rev: doc.rev ?? null, state: doc.state ?? null, scopeHash: doc.scopeHash ?? null });
  function openEditorFromDoc(st, doc) {
    const copy = copyReviewFor(st, doc);
    const form = E.formFromContent(doc, { unconfirmCoverage: !!copy && !E.copyReviewComplete(copy) });
    st.editor = { mode: 'edit', form, baseline: JSON.parse(JSON.stringify(form)), startedFrom: startedFromDoc(doc), conflict: null, serverChanged: null, blockedByActive: null };
  }
  function refreshScope(st, key) {
    const ctx = ctxFor(st.valuationDate === undefined ? undefined : st.valuationDate);
    if (!ctx || ctx.fundId !== st.fundId || ctx.valuationDate !== st.valuationDate) return;
    const doc = draftDoc(ctx);
    if (doc) copyReviewFor(st, doc);
    // 1. awaiting: ONLY a confirmed snapshot can end the wait (not a timer, not stale / loading / incomplete data)
    if (st.awaiting && viewConfirmed(ctx)) {
      const aw = st.awaiting; const verdict = awaitVerdict(aw, ctx);
      if (verdict) {
        clearAwaitTimers(aw); st.awaiting = null;
        if (verdict === 'reflected') {
          const ed0 = st.editor;
          if (aw.action === 'createDraft' && doc && doc.valuationId === aw.valuationId) {
            if (ed0 && ed0.mode === 'create' && aw.sentForm) { // the typed form stays; everything typed after the send stays unsaved over the sent version
              ed0.mode = 'edit'; ed0.baseline = aw.sentForm; ed0.startedFrom = startedFromDoc(doc); ed0.conflict = null; ed0.serverChanged = null; ed0.blockedByActive = null; ed0.goneFromView = false;
            } else if (aw.opensEditor && !(ed0 && E.isDirty(ed0.form, ed0.baseline))) openEditorFromDoc(st, doc); // a server copy opens for review, unless she is typing something else
          } else if (ed0 && ed0.mode === 'edit' && doc && doc.valuationId === ed0.startedFrom.valuationId) {
            ed0.startedFrom = startedFromDoc(doc); ed0.conflict = null; ed0.serverChanged = null;
            ed0.baseline = aw.sentForm || E.formFromContent(doc, { unconfirmCoverage: false });
          }
          if (aw.action === 'withdraw' || (aw.action === 'submit' && !doc)) st.editor = null;
          st.outcome = { action: aw.action, status: 'reflected', code: null };
        } else {
          st.outcome = { action: aw.action, status: 'view_overtaken', code: 'VIEW_OVERTAKEN' };
        }
      }
    }
    // 2. editor follows the server version of its draft
    const ed = st.editor;
    if (ed && ed.mode === 'edit') {
      if (!doc || doc.valuationId !== ed.startedFrom.valuationId) { ed.goneFromView = true; }
      else {
        ed.goneFromView = false;
        if ((doc.contentHash ?? null) !== ed.startedFrom.contentHash && !st.awaiting) {
          if (!E.isDirty(ed.form, ed.baseline)) { const copy = copyReviewFor(st, doc); const f = E.formFromContent(doc, { unconfirmCoverage: !!copy && !E.copyReviewComplete(copy) }); ed.form = f; ed.baseline = JSON.parse(JSON.stringify(f)); ed.startedFrom = startedFromDoc(doc); ed.serverChanged = null; }
          else ed.serverChanged = { contentHash: doc.contentHash ?? null, rev: doc.rev ?? null };
        }
      }
    }
    if (ed && ed.mode === 'create' && ctx.draft && !st.awaiting) ed.blockedByActive = { draftId: ctx.draft.id };
    if (ed && ed.mode === 'create' && !ctx.draft) ed.blockedByActive = null;
    // 3. a stored preview is only valid for the exact stored version it checked
    if (st.preview && st.preview.status === 'done' && (!doc || doc.valuationId !== st.preview.token.valuationId || (doc.contentHash ?? null) !== st.preview.token.storedHash)) st.preview = { ...st.preview, status: 'outdated' };
  }

  /* ---------------- awaiting: a CONFIRMED view must show the effect ---------------- */
  /** A confirmed read that STARTED after the reply was received, for the same session, fund and date. */
  function readAfterResult(aw, ctx) {
    const r = ctx.read;
    return !!r && r.confirmed === true && Number.isInteger(r.epoch) && Number.isInteger(aw.epochAtResult) && r.epoch > aw.epochAtResult
      && r.fundId === aw.fundId && r.valuationDate === aw.valuationDate && ctx.fundId === aw.fundId && ctx.valuationDate === aw.valuationDate && guard.isCurrent(aw.gen);
  }
  /** 'reflected' = the view shows the effect of THIS request; 'overtaken' = a read ordered after the reply shows a state without it; null = no evidence.
      Called only with a confirmed view. Never decided by a difference alone. */
  function awaitVerdict(aw, ctx) {
    if (ctx.draft && ctx.draft.missing) return null;
    if (!aw.valuationId) return null;
    if (ctx.fundId !== aw.fundId || ctx.valuationDate !== aw.valuationDate) return null;
    const doc = draftDoc(ctx); const slotId = ctx.draft ? ctx.draft.id : null;
    const same = !!doc && doc.valuationId === aw.valuationId;
    const hash = doc ? (doc.contentHash ?? null) : null;
    const ours = aw.result.contentHash ?? null; const expected = aw.result.state || (aw.action === 'submit' ? 'submitted' : aw.action === 'withdraw' ? 'withdrawn' : null);
    // (a) identity: the artifact the reply names
    if (same) {
      if (aw.action === 'createDraft') return 'reflected';
      if (aw.action === 'updateDraft' && ours !== null && hash === ours) return 'reflected';
      if ((aw.action === 'submit' || aw.action === 'withdraw') && expected && doc.state === expected) return 'reflected';
    }
    // (b) order, from a revision the reply itself carries
    if (same && Number.isInteger(aw.result.rev) && Number.isInteger(doc.rev) && doc.rev > aw.result.rev) return 'overtaken'; // the view is provably past the reply and not showing it
    // (b) order, from a confirmed read that began after the reply
    if (!readAfterResult(aw, ctx)) return null;
    switch (aw.action) {
      case 'createDraft': return 'overtaken';                                    // after the reply the draft exists; it is not (or no longer) the occupant
      case 'updateDraft': return ours !== null || !!aw.prev ? 'overtaken' : null;  // not our hash, read after the reply: a later version (or none)
      case 'submit': return 'overtaken';
      case 'withdraw': return !doc && slotId === null ? 'reflected' : 'overtaken'; // empty slot, read after the reply: the draft is gone
      default: return null;
    }
  }
  function clearAwaitTimers(aw) { if (aw.t1) clearTimer(aw.t1); if (aw.t2) clearTimer(aw.t2); aw.t1 = aw.t2 = null; }
  /** Timers never release the block. 'delayed': ask the reader to re-fetch. 'stalled': say so. Only a snapshot ends the wait. */
  function startAwaiting(key, st, aw) {
    const gen = guard.current();
    aw.phase = 'waiting'; aw.t1 = setTimer(() => {
      if (!guard.isCurrent(gen) || st.awaiting !== aw) return;
      aw.phase = 'delayed'; try { refreshView(); } catch (e) { /* the reader decides what to do */ } notify();
    }, awaitDelayedMs);
    aw.t2 = setTimer(() => {
      if (!guard.isCurrent(gen) || st.awaiting !== aw) return;
      aw.phase = 'stalled'; notify();
    }, awaitStalledMs);
    st.awaiting = aw;
  }
  function requestRefresh() { try { refreshView(); } catch (e) { /* ignore */ } }

  /* ---------------- results of begin / retry ---------------- */
  function outcomeFromError(action, res) {
    const e = res.error || {};
    return { action, status: res.status, code: e.reason || e.code || res.code || null, reason: e.reason || null, message: e.message || null };
  }
  function applyResult(key, st, action, res, meta) {
    // meta: { prev, valuationId }
    if (res.status === 'background') return { status: 'background' };
    if (res.status === 'success') {
      const result = pickResult(res.data);
      const vid = result.valuationId || (meta && meta.valuationId) || null;
      const sentForm = meta ? meta.sentForm || (meta.entryId && st.sentForms.get(meta.entryId)) || null : null;
      const c0 = ctxFor(st.valuationDate); // the read epoch at the moment the reply was RECEIVED: only a later epoch can prove order
      const epochAtResult = c0 && c0.read && Number.isInteger(c0.read.epoch) ? c0.read.epoch : null;
      startAwaiting(key, st, { action, valuationId: vid, result, prev: meta ? meta.prev || null : null, sentForm, opensEditor: !!(meta && meta.opensEditor), fundId: st.fundId, valuationDate: st.valuationDate, gen: guard.current(), epochAtResult, startedAt: now().getTime() });
      if (sentForm && st.editor) st.editor.baseline = JSON.parse(JSON.stringify(sentForm)); // from now on "unsaved" means: typed AFTER what was sent
      st.outcome = { action, status: 'success_waiting_view', code: null, replayed: result.replayed };
      refreshScope(st, key); notify();
      requestRefresh(); // a re-read that starts AFTER the reply is the evidence that ends the wait; ask for it at once (a read, never a request that modifies)
      return { status: 'success_waiting_view', result };
    }
    if (res.status === 'no_effect') {
      const o = outcomeFromError(action, res); st.outcome = o;
      if (o.code === 'CONTENT_CHANGED' && st.editor && st.editor.mode === 'edit') markConflict(st);
      if (o.code === 'ACTIVE_DRAFT_EXISTS') { try { refreshView(); } catch (e) { /* ignore */ } }
      notify(); return { status: 'no_effect', code: o.code, message: o.message };
    }
    if (res.status === 'ambiguous' || res.status === 'unresolved') {
      if (meta && meta.sentForm && res.entry && res.entry.requestId) st.sentForms.set(res.entry.requestId, meta.sentForm); // so a later retry knows what it sent
      st.outcome = { action, status: res.status, code: res.status === 'unresolved' ? 'UNRESOLVED_PERMISSION' : 'NETWORK_AMBIGUOUS' };
      notify(); return { status: res.status, code: st.outcome.code, entry: res.entry };
    }
    if (res.status === 'blocked') { st.outcome = { action, status: 'blocked', code: res.code }; notify(); return { status: 'blocked', code: res.code, entry: res.entry }; }
    if (res.status === 'aborted') { st.outcome = { action, status: 'aborted', code: res.code }; notify(); return { status: 'aborted', code: res.code }; }
    if (res.status === 'invalid') { st.outcome = { action, status: 'invalid', code: res.code }; notify(); return { status: 'invalid', code: res.code }; }
    return { status: res.status || 'unknown' };
  }

  /* ---------------- conflicts ---------------- */
  function markConflict(st) {
    const ctx = ctxFor(st.valuationDate); const doc = draftDoc(ctx); const ed = st.editor;
    if (!ed || !doc) return;
    const serverForm = E.formFromContent(doc);
    const mineChanged = E.diffForms(ed.baseline, ed.form).map(sectionOf);
    const serverChanged = E.diffForms(ed.baseline, serverForm).map(sectionOf);
    const sections = (a) => [...new Set(a)].sort();
    ed.conflict = {
      serverHash: doc.contentHash ?? null, serverForm, base: ed.baseline, mine: ed.form,
      changedByMe: sections(mineChanged), changedOnServer: sections(serverChanged),
      overlapping: sections(mineChanged.filter((p) => serverChanged.includes(p))),
    };
  }
  function resolveConflict(choice, { confirm } = {}) {
    const sess = sync(); const ctx = ctxFor(); if (!sess || !ctx) return { status: 'blocked', code: 'NO_CONTEXT' };
    const st = states.get(keyOf(sess, ctx)); const ed = st && st.editor; const doc = draftDoc(ctx);
    if (!ed || !ed.conflict || !doc) return { status: 'blocked', code: 'NO_CONFLICT' };
    if ((doc.contentHash ?? null) !== ed.conflict.serverHash) { markConflict(st); notify(); return { status: 'blocked', code: 'CONFLICT_CHANGED_AGAIN' }; }
    if (choice === 'reapply') {
      const next = JSON.parse(JSON.stringify(ed.conflict.serverForm));
      for (const sec of ed.conflict.changedByMe) setIn(next, sec, JSON.parse(JSON.stringify(getIn(ed.form, sec))));
      const overlapping = ed.conflict.overlapping;
      ed.baseline = ed.conflict.serverForm; ed.form = next; ed.startedFrom = startedFromDoc(doc); ed.conflict = null; ed.serverChanged = null;
      notify(); return { status: 'reapplied', overlapping, dirty: E.isDirty(ed.form, ed.baseline) }; // nothing is sent; she must save explicitly
    }
    if (choice === 'discard-mine') {
      if (E.isDirty(ed.form, ed.baseline) && confirm !== true) return { status: 'confirm_required', unsaved: E.diffForms(ed.baseline, ed.form) };
      openEditorFromDoc(st, doc); notify(); return { status: 'discarded' };
    }
    return { status: 'blocked', code: 'CHOICE_UNKNOWN' };
  }

  /* ---------------- editor API ---------------- */
  function currentScope() {
    const sess = sync(); const ctx = ctxFor();
    if (!sess || !ctx) return null;
    const key = keyOf(sess, ctx); return { sess, ctx, key, st: stateOf(key, ctx) };
  }
  function linkProposalFor(ctx, doc) {
    if (doc && doc.scopeSnapshot && doc.scopeSnapshot.linksByFund && Array.isArray(doc.scopeSnapshot.linksByFund[ctx.fundId])) {
      return E.makeLinkProposal({ fundId: ctx.fundId, assetIds: doc.scopeSnapshot.linksByFund[ctx.fundId], source: E.LINK_SOURCES.SERVER_SCOPE_SNAPSHOT });
    }
    return ctx.linkProposal || null;
  }
  function startCreate() {
    const sess = sync(); const t = today(); const ctx = ctxFor(t);
    if (!sess) return { status: 'blocked', code: 'NO_SESSION' };
    if (!ctx) return { status: 'blocked', code: 'NO_CONTEXT' };
    const key = keyOf(sess, ctx); const st = stateOf(key, ctx);
    const g = gate('createDraft', ctx, sess, st); if (!g.allowed) return { status: 'blocked', code: g.reason };
    const form = E.emptyForm();
    st.editor = { mode: 'create', form, baseline: JSON.parse(JSON.stringify(form)), startedFrom: null, conflict: null, serverChanged: null, blockedByActive: null };
    notify(); return { status: 'started' };
  }
  function editor() { const c = currentScope(); return c ? c.st.editor : null; }
  function mutateForm(fn) {
    const c = currentScope(); if (!c || !c.st.editor) return { status: 'blocked', code: 'NO_EDITOR' };
    try { c.st.editor.form = fn(c.st.editor.form); } catch (e) { return { status: 'invalid', code: e.clientCode || 'FIELD_INVALID' }; }
    c.st.prepared = null; notify(); return { status: 'ok' };
  }
  const setField = (path, value) => mutateForm((f) => E.setField(f, path, value));
  const addItem = (list) => mutateForm((f) => E.addItem(f, list));
  const removeItem = (list, i) => mutateForm((f) => E.removeItem(f, list, i));
  function confirmLinks() {
    const c = currentScope(); if (!c || !c.st.editor) return { status: 'blocked', code: 'NO_EDITOR' };
    const proposal = linkProposalFor(c.ctx, draftDoc(c.ctx)); if (!proposal) return { status: 'blocked', code: 'LINK_PROPOSAL_REQUIRED' };
    return mutateForm((f) => E.confirmLinkedAssets(f, proposal));
  }
  const clearLinks = () => mutateForm((f) => E.clearLinkedAssets(f));
  function acknowledgeCopy(which) {
    const c = currentScope(); if (!c) return { status: 'blocked', code: 'NO_CONTEXT' };
    const doc = draftDoc(c.ctx); const ed = c.st.editor;
    let review = doc ? copyReviewFor(c.st, doc) : null;
    if (!review) return { status: 'blocked', code: 'NOT_A_COPY' };
    if (which === 'coverage' && !(ed && ed.form.coverage.linkedAssets.confirmed)) return { status: 'blocked', code: 'COVERAGE_NOT_CONFIRMED' }; // an acknowledgement is not a statement
    if (which === 'coverage' && ed && E.diffForms(ed.form, ed.baseline).some((p) => p.startsWith('coverage'))) return { status: 'blocked', code: 'SAVE_FIRST' };
    review = E.ackCopyReview(review, which);
    c.st.copyReviews.set(doc.valuationId, review);
    c.st.prepared = null; notify(); return { status: 'ok', review };
  }
  function closeEditor({ confirm } = {}) {
    const c = currentScope(); if (!c || !c.st.editor) return { status: 'ok' };
    const ed = c.st.editor; const dirty = E.isDirty(ed.form, ed.baseline);
    if (dirty && confirm !== true) return { status: 'confirm_required', unsaved: E.diffForms(ed.baseline, ed.form) };
    c.st.editor = null; c.st.prepared = null; notify(); return { status: 'closed', discarded: dirty };
  }
  function requestLeave() { const e = editor(); const dirty = !!(e && E.isDirty(e.form, e.baseline)); return { needsConfirm: dirty, unsaved: dirty ? E.diffForms(e.baseline, e.form) : [] }; }
  function openActiveDraft({ confirm } = {}) {
    const c = currentScope(); if (!c) return { status: 'blocked', code: 'NO_CONTEXT' };
    const doc = draftDoc(c.ctx); if (!doc) return { status: 'blocked', code: 'NO_TARGET' };
    const ed = c.st.editor;
    if (ed && E.isDirty(ed.form, ed.baseline) && confirm !== true) return { status: 'confirm_required', unsaved: E.diffForms(ed.baseline, ed.form) };
    openEditorFromDoc(c.st, doc); notify(); return { status: 'opened' };
  }

  /* ---------------- save / copy / submit / withdraw ---------------- */
  async function save() {
    const c = currentScope(); if (!c || !c.st.editor) return { status: 'blocked', code: 'NO_EDITOR' };
    const { sess, key, st } = c; let { ctx } = c; const ed = st.editor; const create = ed.mode === 'create';
    if (create) { ctx = ctxFor(today()) || ctx; if (ctx.valuationDate !== st.valuationDate) return { status: 'blocked', code: 'DATE_CROSSED' }; }
    const action = create ? 'createDraft' : 'updateDraft';
    if (ed.conflict) return { status: 'blocked', code: 'CONFLICT_UNRESOLVED' };
    if (ed.goneFromView) return { status: 'blocked', code: 'DRAFT_GONE' };
    const g = gate(action, ctx, sess, st); if (!g.allowed) { st.outcome = { action, status: 'blocked', code: g.reason }; notify(); return { status: 'blocked', code: g.reason }; }
    const doc = draftDoc(ctx);
    if (!create && (doc.contentHash ?? null) !== ed.startedFrom.contentHash) { markConflict(st); st.outcome = { action, status: 'blocked', code: 'CONTENT_CHANGED' }; notify(); return { status: 'blocked', code: 'CONTENT_CHANGED' }; }
    const built = E.buildContent(ed.form, { stored: create ? null : contentOfDoc(doc) });
    const sentForm = JSON.parse(JSON.stringify(ed.form)); // exactly what is sent; anything typed from here on is new input
    if (!built.canSave) return { status: 'invalid', code: 'EDITOR_ERRORS', errors: built.errors };
    const fields = create ? { fundId: ctx.fundId, valuationDate: ctx.valuationDate, content: built.content } : { valuationId: doc.valuationId, expectedContentHash: ed.startedFrom.contentHash, content: built.content };
    const gen = guard.current();
    const res = await runner.begin({ action, fields, scope: { fundId: ctx.fundId, valuationDate: ctx.valuationDate } });
    if (!guard.isCurrent(gen) || states.get(key) !== st) return { status: 'background' };
    return applyResult(key, st, action, res, { prev: create ? null : { rev: doc.rev ?? null, contentHash: doc.contentHash ?? null, state: doc.state ?? null }, valuationId: create ? null : doc.valuationId, sentForm });
  }
  /** Copy as a NEW draft, performed by the SERVER (it keeps the server's stored content). The server cannot copy an approved version; a pre-fill
      from an approved version is NOT part of this package (deferred), so such a source is refused here without any request. */
  async function copyFrom({ sourceId, sourceState }) {
    const sess = sync(); const t = today(); const ctx = ctxFor(t);
    if (!sess) return { status: 'blocked', code: 'NO_SESSION' };
    if (!ctx) return { status: 'blocked', code: 'NO_CONTEXT' };
    const key = keyOf(sess, ctx); const st = stateOf(key, ctx);
    if (!E.canServerCopy(sourceState)) return { status: 'blocked', code: 'COPY_SOURCE_STATE' };
    const g = gate('createDraft', ctx, sess, st); if (!g.allowed) { st.outcome = { action: 'createDraft', status: 'blocked', code: g.reason }; notify(); return { status: 'blocked', code: g.reason }; }
    if (st.editor && E.isDirty(st.editor.form, st.editor.baseline)) return { status: 'blocked', code: 'UNSENT_INPUT' }; // her typing is never traded for a copy
    const gen = guard.current();
    const res = await runner.begin({ action: 'createDraft', fields: { fundId: ctx.fundId, valuationDate: ctx.valuationDate, copyFromValuationId: sourceId }, scope: { fundId: ctx.fundId, valuationDate: ctx.valuationDate } });
    if (!guard.isCurrent(gen) || states.get(key) !== st) return { status: 'background' };
    return applyResult(key, st, 'createDraft', res, { prev: null, valuationId: null, opensEditor: true });
  }
  function prepare(action) {
    if (action !== 'submit' && action !== 'withdraw') return { status: 'blocked', code: 'ACTION_UNKNOWN' };
    const c = currentScope(); if (!c) return { status: 'blocked', code: 'NO_CONTEXT' };
    const { sess, ctx, st } = c; const doc = draftDoc(ctx);
    const g = gate(action, ctx, sess, st); if (!g.allowed) return { status: 'blocked', code: g.reason };
    const ed = st.editor;
    if (action === 'submit') {
      if (ed && E.isDirty(ed.form, ed.baseline)) return { status: 'blocked', code: 'UNSAVED_EDITS' };
      const review = copyReviewFor(st, doc) || null;
      if (!E.copyReviewComplete(review)) return { status: 'blocked', code: 'COPY_REVIEW_REQUIRED', review };
    }
    const snapshot = snapshotOf({ valuation: doc, head: { headId: null }, today: today() });
    const token = `p${++tokenSeq}`;
    st.prepared = { token, action, snapshot, gen: guard.current(), valuationId: doc.valuationId };
    return {
      status: 'ready', token,
      summary: { action, valuationId: doc.valuationId, fundId: ctx.fundId, valuationDate: ctx.valuationDate, state: doc.state, contentHash: doc.contentHash ?? null, rev: doc.rev ?? null, validation: doc.validation || null, copiedFrom: doc.copiedFrom || null },
      limits: { notBoundToContent: true }, // contract §6.1: the server does not bind submit/withdraw to a fingerprint
    };
  }
  async function confirm(token) {
    const c = currentScope(); if (!c) return { status: 'blocked', code: 'NO_CONTEXT' };
    const { sess, key, ctx, st } = c; const p = st.prepared;
    if (!p || p.token !== token || !guard.isCurrent(p.gen)) return { status: 'blocked', code: 'NOT_PREPARED' };
    st.prepared = null;
    const doc = draftDoc(ctx);
    if (!doc || doc.valuationId !== p.valuationId) return { status: 'blocked', code: 'VIEW_CHANGED' };
    const changed = diffSnapshots(p.snapshot, snapshotOf({ valuation: doc, head: { headId: null }, today: today() }));
    if (changed.length) return { status: 'blocked', code: 'VIEW_CHANGED', changed };
    const ed = st.editor; if (p.action === 'submit' && ed && E.isDirty(ed.form, ed.baseline)) return { status: 'blocked', code: 'UNSAVED_EDITS' };
    const g = gate(p.action, ctx, sess, st); if (!g.allowed) { st.outcome = { action: p.action, status: 'blocked', code: g.reason }; notify(); return { status: 'blocked', code: g.reason }; }
    const gen = guard.current();
    const res = await runner.begin({ action: p.action, fields: { valuationId: doc.valuationId }, scope: { fundId: ctx.fundId, valuationDate: ctx.valuationDate } });
    if (!guard.isCurrent(gen) || states.get(key) !== st) return { status: 'background' };
    return applyResult(key, st, p.action, res, { prev: { rev: doc.rev ?? null, contentHash: doc.contentHash ?? null, state: doc.state ?? null }, valuationId: doc.valuationId });
  }

  /* ---------------- "check now": the STORED version, bound to session + valuation + hash + sequence ---------------- */
  async function checkNow() {
    const c = currentScope(); if (!c) return { status: 'blocked', code: 'NO_CONTEXT' };
    const { sess, ctx, key, st } = c; const doc = draftDoc(ctx);
    if (!doc) return { status: 'blocked', code: 'NO_TARGET' };
    const av = availableActions({ role: sess.role, email: sess.email, today: today(), valuation: doc, head: {}, createDate: ctx.valuationDate }).preview;
    if (!av.allowed) return { status: 'blocked', code: av.reason };
    const ed = st.editor;
    const token = { gen: guard.current(), valuationId: doc.valuationId, storedHash: doc.contentHash ?? null, seq: ++st.previewSeq, dirtyAtRequest: !!(ed && E.isDirty(ed.form, ed.baseline)) };
    st.preview = { status: 'loading', token };
    notify();
    let reply; let failure = null;
    try { reply = await callPreview({ valuationId: doc.valuationId }); } catch (e) { failure = describeError(e); }
    const live = states.get(key) === st && guard.isCurrent(token.gen) && st.preview && st.preview.token === token;
    if (!live) return { status: 'dropped' }; // late reply: other session, other draft, or a newer request
    const ctxNow = ctxFor(st.valuationDate); const docNow = draftDoc(ctxNow);
    if (!docNow || docNow.valuationId !== token.valuationId) { st.preview = { status: 'outdated', token }; notify(); return { status: 'dropped' }; }
    if (failure) { st.preview = { status: 'error', token, error: failure }; notify(); return { status: 'error', error: failure }; }
    const r = reply || {};
    st.preview = { status: 'done', token, reply: { valuationId: r.valuationId ?? null, state: r.state ?? null, contentHash: r.contentHash ?? null, today: r.today ?? null, dateOk: r.dateOk ?? null, stale: r.stale ?? null, scopeChanged: r.scopeChanged ?? null, currentHeadId: r.currentHeadId ?? null, candidate: r.candidate ? { status: r.candidate.status ?? null, reasonCodes: Array.isArray(r.candidate.reasonCodes) ? [...r.candidate.reasonCodes] : [], issues: r.candidate.issues ?? null } : null } };
    if ((docNow.contentHash ?? null) !== token.storedHash) st.preview.status = 'outdated'; // the stored version moved while the request was out
    notify(); return { status: st.preview.status };
  }

  /* ---------------- recovering an earlier request (NOT gated by day / state / head) ---------------- */
  async function retryPending(scope) {
    const sess = sync(); if (!sess) return { status: 'blocked', code: 'NO_SESSION' };
    let parts; try { parts = JSON.parse(scope); } catch (e) { return { status: 'blocked', code: 'SCOPE_MISMATCH' }; }
    const entry = runner.get(scope); const [, fundId, valuationDate] = parts;
    const key = scopeKey({ user: sess.email, fundId, valuationDate });
    const st = states.get(key) || stateOf(key, { fundId, valuationDate });
    const gen = guard.current();
    const res = await runner.retry(scope);
    if (!guard.isCurrent(gen) || states.get(key) !== st) return { status: 'background' };
    if (res.status === 'none') { notify(); return { status: 'none' }; }
    const payload = entry && entry.payload ? entry.payload : {};
    const prev = payload.expectedContentHash ? { contentHash: payload.expectedContentHash } : null; // the version the request was based on
    return applyResult(key, st, entry ? entry.action : (res.data && res.data.action) || 'unknown', res, { prev, valuationId: payload.valuationId || null, entryId: entry ? entry.requestId : null, opensEditor: !!(payload.copyFromValuationId) });
  }
  async function discardPending(scope, { acknowledgeRisk } = {}) {
    sync();
    const res = await runner.discard(scope, { acknowledgeRisk });
    notify(); return res;
  }
  const recover = () => { sync(); return runner.recoverInflight(); };

  /* ---------------- the Riyadh day ---------------- */
  function watchDay() {
    if (dayTimer) clearTimer(dayTimer);
    const arm = () => { dayTimer = setTimer(() => { dayTimer = null; sync(); notify(); arm(); }, msUntilNextRiyadhDay(now().getTime()) + 50); };
    arm();
    return () => { if (dayTimer) clearTimer(dayTimer); dayTimer = null; };
  }

  /* ---------------- everything the screen needs, as plain data ---------------- */
  function getState() {
    const sess = sync(); const ctx = ctxFor();
    const t = today();
    const out = { today: t, session: sess ? { email: sess.email, role: sess.role } : null, scope: null, available: {}, banners: [], pending: [], editor: null, awaiting: null, preview: null, outcome: null, limits: { submitAndWithdrawNotBoundToContent: true }, dayKind: null, unsentElsewhere: [] };
    if (!sess || !ctx) return out;
    const key = keyOf(sess, ctx); const st = states.get(key) || { editor: null, awaiting: null, preview: null, outcome: null, copyReviews: new Map() };
    const doc = draftDoc(ctx);
    out.scope = { fundId: ctx.fundId, valuationDate: ctx.valuationDate, key };
    // unsent input that belongs to ANOTHER date than the one on screen (e.g. the default date rolled over): it must not vanish silently
    for (const [k, other] of states) if (k !== key && other.editor && E.isDirty(other.editor.form, other.editor.baseline)) out.unsentElsewhere.push({ fundId: other.fundId, valuationDate: other.valuationDate, mode: other.editor.mode });
    out.dayKind = classifyDate(ctx.valuationDate, t);
    const createCtx = ctxFor(t);
    out.available = {
      createDraft: createCtx ? gate('createDraft', createCtx, sess, states.get(keyOf(sess, createCtx))) : no('NO_CONTEXT'),
      updateDraft: gate('updateDraft', ctx, sess, st), submit: gate('submit', ctx, sess, st), withdraw: gate('withdraw', ctx, sess, st),
    };
    if (out.available.submit.allowed) {
      const ed = st.editor; const review = (doc && st.copyReviews.get(doc.valuationId)) || null;
      if (ed && E.isDirty(ed.form, ed.baseline)) out.available.submit = no('UNSAVED_EDITS');
      else if (!E.copyReviewComplete(review)) out.available.submit = no('COPY_REVIEW_REQUIRED');
    }
    const mine = runner.pending().filter((e) => { try { const p = JSON.parse(e.scope); return p[1] === ctx.fundId && p[2] === ctx.valuationDate; } catch (x) { return false; } });
    out.pending = mine.map((e) => ({ scope: e.scope, action: e.action, status: e.status, attempts: e.attempts, requestId: e.requestId, lastOutcome: e.lastOutcome }));
    for (const e of mine) out.banners.push({ kind: e.status === 'unresolved' ? 'pending_unresolved' : e.status === 'inflight' ? 'pending_inflight' : 'pending_ambiguous', scope: e.scope, action: e.action });
    if (st.awaiting) { out.awaiting = { action: st.awaiting.action, phase: st.awaiting.phase, valuationId: st.awaiting.valuationId }; out.banners.push({ kind: 'awaiting_view', phase: st.awaiting.phase, action: st.awaiting.action }); }
    if (st.outcome && st.outcome.status === 'view_overtaken') out.banners.push({ kind: 'view_overtaken', action: st.outcome.action });
    out.outcome = st.outcome ? { ...st.outcome } : null;
    const ed = st.editor;
    if (ed) {
      const stored = ed.mode === 'edit' && doc ? contentOfDoc(doc) : null;
      const built = E.buildContent(ed.form, { stored });
      const proposal = linkProposalFor(ctx, doc);
      const frozenKind = ed.mode === 'edit' ? classifyDate(ctx.valuationDate, t) : classifyDate(st.valuationDate, t);
      out.editor = {
        mode: ed.mode, form: ed.form, dirty: E.isDirty(ed.form, ed.baseline), dirtyPaths: E.diffForms(ed.form, ed.baseline), errors: built.errors, issues: built.issues, ready: built.ready, check: built.check,
        frozen: frozenKind === 'today' ? null : frozenKind, conflict: ed.conflict ? { changedByMe: ed.conflict.changedByMe, changedOnServer: ed.conflict.changedOnServer, overlapping: ed.conflict.overlapping } : null,
        serverChanged: ed.serverChanged, goneFromView: !!ed.goneFromView, blockedByActive: ed.blockedByActive,
        copyReview: (doc && ed.mode === 'edit' && st.copyReviews.get(doc.valuationId)) || null,
        coverage: {
          proposal: proposal ? { ids: [...proposal.ids], source: proposal.source } : null,
          statement: { confirmed: ed.form.coverage.linkedAssets.confirmed, ids: [...ed.form.coverage.linkedAssets.ids] },
          reconcile: E.reconcileCoverage(ed.form, proposal && proposal.source === E.LINK_SOURCES.SERVER_SCOPE_SNAPSHOT ? proposal.ids : undefined),
          statementStale: E.isStatementStale(ed.form, proposal) && E.reconcileCoverage(ed.form, proposal && proposal.source === E.LINK_SOURCES.SERVER_SCOPE_SNAPSHOT ? proposal.ids : undefined).status !== 'MATCH', // a change of BASIS alone (browser data -> server snapshot) is not an alarm when the ids agree
          proposalIsOnlyBrowserData: !!proposal && proposal.source === E.LINK_SOURCES.BROWSER_FUND_DATA,
        },
      };
    }
    if (st.preview) {
      const p = st.preview; const dirtyNow = !!(ed && E.isDirty(ed.form, ed.baseline));
      out.preview = { status: p.status, checks: 'STORED_VERSION', storedContentHash: p.token.storedHash, unsavedEditsNotChecked: dirtyNow, dirtyWhenRequested: p.token.dirtyAtRequest, reply: p.status === 'done' ? p.reply : null, error: p.error || null };
    }
    return out;
  }

  function dispose() { reset(); if (dayTimer) clearTimer(dayTimer); dayTimer = null; try { unsubRunner(); } catch (e) { /* ignore */ } }
  const stats = () => ({ scopes: states.size, awaiting: [...states.values()].filter((s) => s.awaiting).length, editors: [...states.values()].filter((s) => s.editor).length, previews: [...states.values()].filter((s) => s.preview).length, dayTimer: !!dayTimer });

  return {
    sync, requestRefresh, getState, startCreate, copyFrom, setField, addItem, removeItem, confirmLinks, clearLinks, acknowledgeCopy, closeEditor, requestLeave, openActiveDraft,
    save, prepare, confirm, checkNow, resolveConflict, retryPending, discardPending, recover, watchDay, dispose, stats,
    canStart: (action) => {
      const c = currentScope(); const sess = c ? c.sess : sync();
      if (!sess) return no('NO_SESSION');
      if (action === 'createDraft') { const cc = ctxFor(today()); return cc ? gate(action, cc, sess, states.get(keyOf(sess, cc))) : no('NO_CONTEXT'); }
      return c ? gate(action, c.ctx, sess, c.st) : no('NO_CONTEXT');
    },
    get guard() { return guard; },
  };
}
export { ACTIONS_STARTED_HERE };
