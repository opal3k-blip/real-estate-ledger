/* =========================================================================
   R1-B2 / B2-2b-b1 — غراء محرّر تقييم القيمة المتبقية: يربط القارئ (B2-1/b0) والمنسّق (B2-2a) ومشغّل الطلبات (B2-0) والمحرّر والعرض.
   لا Firebase هنا ولا DOM إلا في attachDom (طبقة رقيقة). كل ما يلزم يُحقن، فيُختبر المنطق كله بلا متصفح.

   القواعد التي يقوم عليها:
   1. التاريخ المثبَّت: لكل صندوق تاريخ للمحرّر (pins) يُثبَّت عند فتح المحرّر ولا يتبع التاريخ المعروض في اللوحة ولا يتغير بعبور اليوم. سياق المنسّق
      (getContext بلا وسيط) هو سياق التاريخ المثبَّت. الانتقال إلى اليوم الجديد صريح بتأكيد ولا يحذف الإدخال القديم قبل نجاح المحرّر الجديد.
   2. القراءة اليدوية والداخلية لا تُجوِّع القارئ: «التحقق الآن» معطّل ما دامت قراءة جارية؛ والقراءة الداخلية بعد الرد لا تُصدَر إن كانت قراءة جارية بدأت بعد
      آخر رد (فهي دليل صالح)، إلا إن تجاوزت عمرًا أقصى. «آخر قراءة صدرت فقط» في القارئ تبقى كما هي.
   3. تبدّل الجلسة أو فقد الصلاحية: مسح فوري بلا تأكيد (الإدخال، الأقفال المحلية، التثبيت، حالة الواجهة، الحافظ). التأكيد لخروج المستخدم الاختياري فقط (إغلاق المحرّر).
   4. لا حفظ للإدخال في تخزين المتصفح؛ يبقى في ذاكرة المنسّق فقط.
   ========================================================================= */
import { createValuationActions } from './fund-valuation-actions.js';
import { createRequestRunner } from './fund-valuation-requests.js';
import { createFocusKeeper } from './fund-valuation-focus-keeper.js';
import { createGenerationGuard, riyadhDay, canRead, roleCanDo, CALLABLES } from './fund-valuation-model.js';
import * as E from './fund-valuation-editor.js';
import { renderEditor } from './fund-valuation-editor-view.js';

export const READ_MAX_AGE_MS = 30000;   // a read in flight older than this no longer suppresses a new one (it may be hung)
const CARRIED_PREFIXES = ['components.', 'otherAssetsItems', 'residualValue', 'method', 'methodNote', 'source.'];   // moved to a new day: typed numbers and text only; attestations and coverage are NOT carried

const clone = (v) => JSON.parse(JSON.stringify(v));

/** deps: { reader, call(callable,payload,{user}), getSession(), getFundAssetIds(fundId), requestRender(), storage, locks, now(), setTimer, clearTimer, genId?, T?, doc?, win?, runner? } */
export function createEditorWiring(deps) {
  const { reader, call, getSession, getFundAssetIds = () => null, requestRender = () => {}, now = () => new Date(), T = (ar) => ar } = deps;
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms)); const clearTimer = deps.clearTimer || ((id) => clearTimeout(id));
  const guard = deps.guard || createGenerationGuard();
  const pins = new Map();                       // fundId -> pinned valuation date of the editor
  let ui = freshUi();
  let dead = false;                             // set by the session teardown: the module sees no session until the next render finds a valid one
  let inRender = false; let renderPending = false; let disposed = false;
  let sessionOk = false; let lastHasEditor = false;
  let repliesSeen = 0; let repliesAtIssue = -1; let lastIssueAt = 0;
  const stats = { refreshIssued: 0, refreshCoalesced: 0, refreshBlockedManual: 0, inputIgnored: 0 };

  function freshUi() { return { confirm: null, prepared: null, discarding: null, notice: null, rv: null }; }
  const RV_ACTS = ['review', 'returnDraft', 'reject', 'approve'];
  /** access = a signed-in user whose role is RESOLVED and may read, and a reader that has not been refused. Any other state is a LOSS: it is detected wherever the
      module is asked for the session (not only at a render), clears everything at once (no confirmation), and the module then sees no session until a render finds access. */
  const accessOk = (s) => !!(s && s.uid && s.email && s.roleResolved === true && canRead(s.role));
  const readerRefused = () => { let st = null; try { st = reader.getView().status; } catch (e) { st = null; } return st === 'denied'; };
  const sess = () => {
    if (dead) return null;
    let s = null; try { s = getSession(); } catch (e) { s = null; }
    if (!accessOk(s) || readerRefused()) { loseAccess(); return null; }
    return s;
  };
  function loseAccess() { if (dead) return; dead = true; sessionOk = false; clearAll(); actions.sync(); }   // the ambiguous-request records are NOT touched: recovery needs them
  const proposalFor = (fundId) => {
    let ids = null; try { ids = getFundAssetIds(fundId); } catch (e) { ids = null; }
    return Array.isArray(ids) ? E.makeLinkProposal({ fundId, assetIds: ids, source: E.LINK_SOURCES.BROWSER_FUND_DATA }) : null;
  };
  const today = () => riyadhDay(now());

  /* ---------------- context: the PINNED date (if any), else the displayed date ---------------- */
  function getContext(date) {
    const v = reader.getView(); const fundId = v.fundId; if (!fundId) return null;
    const d = date === undefined ? (pins.get(fundId) || v.selectedDate || today()) : date;
    const c = reader.contextFor(d); if (!c) return null;
    return { ...c, linkProposal: proposalFor(fundId) };
  }

  /* ---------------- reads: no starvation ---------------- */
  function issueRead() {
    lastIssueAt = now().getTime(); repliesAtIssue = repliesSeen; stats.refreshIssued += 1;
    const p = reader.refresh(); scheduleRender();   // the button's disabled state follows the read: show it now
    return p;
  }
  /** the actions module asks for a re-read after a reply: needed only if a reply arrived since the read in flight began */
  function internalRefresh() {
    const r = reader.getView().read;
    if (r.inFlight > 0 && repliesSeen === repliesAtIssue && now().getTime() - lastIssueAt < READ_MAX_AGE_MS) { stats.refreshCoalesced += 1; return Promise.resolve({ status: 'coalesced' }); }
    return issueRead();
  }
  function refreshState() {
    const v = reader.getView(); if (!v.fundId || !sess()) return { allowed: false, reason: 'NO_CONTEXT' };
    if (v.read.inFlight > 0) return { allowed: false, reason: 'IN_FLIGHT' };
    return { allowed: true, reason: null };
  }
  function refreshNow() {
    const s = refreshState(); if (!s.allowed) { stats.refreshBlockedManual += 1; return Promise.resolve({ status: 'blocked', code: s.reason }); }
    return issueRead();
  }

  const wrappedCall = async (callable, payload, meta) => { const r = await call(callable, payload, meta); repliesSeen += 1; return r; };   // a reply that CAME BACK (an error is not evidence)
  const runner = deps.runner || createRequestRunner({
    getUser: () => { const s = sess(); return s ? s.email : null; }, call: wrappedCall, storage: deps.storage, locks: deps.locks, guard,
    now: () => now().getTime(), ...(deps.genId ? { genId: deps.genId } : {}),
  });
  const actions = deps.actions || createValuationActions({
    getContext, getSession: () => sess(), runner, guard, now,
    callPreview: ({ valuationId }) => wrappedCall(CALLABLES.preview, { valuationId }, { user: (sess() || {}).email }),
    refreshView: internalRefresh, onChange: scheduleRender, setTimer, clearTimer,
  });
  const stopDay = actions.watchDay();

  function scheduleRender() {
    if (inRender || renderPending || disposed) return;
    renderPending = true;
    queueMicrotask(() => { renderPending = false; if (!disposed) { try { requestRender(); } catch (e) { /* the host decides */ } } });
  }

  /* ---------------- focus keeper ---------------- */
  const keeper = deps.keeper || (deps.doc ? createFocusKeeper({ doc: deps.doc, win: deps.win, getRoot: deps.getRoot }) : null);

  /* ---------------- pins ---------------- */
  const fundNow = () => reader.getView().fundId;
  function pinHere(date) { const f = fundNow(); if (f) pins.set(f, date); }
  function releaseIfIdle(state) {
    const f = fundNow(); if (!f || !pins.has(f)) return false;
    if (!state.editor && !state.awaiting) { pins.delete(f); return true; }
    return false;
  }

  /* ---------------- render slot ---------------- */
  function clearAll() {
    pins.clear(); ui = freshUi(); lastHasEditor = false; if (keeper) keeper.clear();
  }
  function model() {
    const s = sess();
    const state = actions.getState();
    dropStaleRv(state);
    if (releaseIfIdle(state)) return model();
    const v = reader.getView(); const ctx = getContext();
    const hasDraft = !!(ctx && ctx.draft && !ctx.draft.missing);
    const lv = ctx && ctx.latestValuation && ctx.latestValuation.doc ? ctx.latestValuation : null;
    const prev = ctx && s ? roleCanDo('preview', s.role) : false;
    return {
      state, ui, pinnedDate: pins.get(fundNow()) || null, now: today(), pendingAll: runner.pending(), refresh: refreshState(),
      reader: { read: v.read, selectedDate: v.selectedDate, hasDraft, copySource: lv ? { id: lv.id, state: lv.doc.state } : null },
      checkAllowed: hasDraft && prev, checkWhy: !hasDraft ? 'NO_TARGET' : (prev ? '' : 'ROLE_NOT_ALLOWED'),
    };
  }
  /** the reviewer form belongs to ONE scope and ONE valuation: when either changes it (and its prepared card) goes at once */
  function dropStaleRv(state) {
    const rv = ui.rv; if (!rv) return;
    const same = state.scope && state.scope.key === rv.scopeKey && state.review && state.review.valuationId === rv.valuationId;
    if (!same) { ui.rv = null; if (ui.prepared && RV_ACTS.includes(ui.prepared.action)) ui.prepared = null; }
  }
  function renderSlot() {
    inRender = true;
    try {
      const s = getSession && (() => { try { return getSession(); } catch (e) { return null; } })();
      const valid = accessOk(s) && !readerRefused();
      if (!valid) { if (!dead) loseAccess(); else { sessionOk = false; clearAll(); } return ''; }
      dead = false; sessionOk = true; actions.sync();
      const m = model(); lastHasEditor = !!m.state.editor;
      return renderEditor(m, { T });
    } finally { inRender = false; }
  }

  /* ---------------- teardown (logout / user switch / permission loss): immediate, no confirmation ---------------- */
  function teardown() {
    dead = true; sessionOk = false; clearAll(); actions.sync();
  }

  /* ---------------- user input ---------------- */
  /** a typed value from the form. Ignored when the session is gone or the target is no longer part of the page. */
  function onInput(path, value, { connected = true } = {}) {
    if (!connected || dead || !sess()) { stats.inputIgnored += 1; return { status: 'ignored' }; }
    return actions.setField(path, value);
  }

  /** a typed value of the reviewer form. The fields are LOCKED once a confirmation is prepared (what is shown there is what will be sent). */
  function onRvInput(field, value, { connected = true } = {}) {
    if (!connected || dead || !sess()) { stats.inputIgnored += 1; return { status: 'ignored' }; }
    const rv = ui.rv; if (!rv || ui.prepared) { stats.inputIgnored += 1; return { status: 'ignored' }; }
    if (field === 'reason' && typeof value === 'string') rv.reason = value; else if (field === 'ack') rv.ack = value === true; else return { status: 'ignored' };
    return { status: 'ok' };
  }

  /* ---------------- actions from buttons ---------------- */
  async function handleAction(action, data = {}) {
    if (dead || !sess()) return { status: 'blocked', code: 'NO_SESSION' };
    // A reply that comes back AFTER the session changed belongs to the old session: it must not touch the new one's form, notices or pins.
    // `ui` is replaced wholesale by every clear, and the generation moves on every session change, so either one tells a late reply from a live one.
    const ui0 = ui; const gen0 = guard.current(); const live = () => ui === ui0 && guard.isCurrent(gen0) && !dead;
    const note = (r) => { if (live()) ui.notice = r && r.status && r.status !== 'ok' ? { action, status: r.status, code: r.code || null } : null; return r; };
    switch (action) {
      case 'fve-create': {
        if (actions.getState().editor) return note({ status: 'blocked', code: 'EDITOR_OPEN' });
        const r = actions.startCreate(); if (r.status === 'started') pinHere(today()); return note(r);
      }
      case 'fve-open-draft': {
        const v = reader.getView(); if (!v.fundId) return note({ status: 'blocked', code: 'NO_CONTEXT' });
        const had = pins.get(v.fundId); pins.set(v.fundId, had || v.selectedDate || today());
        const r = actions.openActiveDraft({ confirm: data.confirm === true }); if (r.status !== 'opened' && !had) pins.delete(v.fundId); return note(r);
      }
      case 'fve-copy': {
        const had = pins.get(fundNow()); pinHere(today());
        const r = await actions.copyFrom({ sourceId: data.sourceId, sourceState: data.sourceState });
        if (!live()) return r;
        if (!actions.getState().editor && !actions.getState().awaiting) { if (had) pinHere(had); else pins.delete(fundNow()); }
        return note(r);
      }
      case 'fve-add-item': return note(actions.addItem(data.list));
      case 'fve-remove-item': return note(actions.removeItem(data.list, Number(data.index)));
      case 'fve-confirm-links': return note(actions.confirmLinks());
      case 'fve-clear-links': return note(actions.clearLinks());
      case 'fve-ack-copy': return note(actions.acknowledgeCopy(data.which));
      case 'fve-save': ui.prepared = null; return note(await actions.save());
      case 'fve-prepare': {
        const r = actions.prepare(data.act);
        ui.prepared = r.status === 'ready' ? { token: r.token, action: data.act, summary: r.summary } : null; return note(r);
      }
      case 'fve-rv-open': {
        if (!RV_ACTS.includes(data.act)) return note({ status: 'blocked', code: 'ACTION_UNKNOWN' });
        const st = actions.getState(); const g = st.available && st.available[data.act];
        if (!g || !g.allowed || !st.review || !st.scope) return note({ status: 'blocked', code: (g && g.reason) || 'NO_CONTEXT' });
        ui.prepared = null; ui.rv = { act: data.act, reason: '', ack: false, scopeKey: st.scope.key, valuationId: st.review.valuationId }; ui.notice = null; return { status: 'ok' };
      }
      case 'fve-rv-prepare': {
        const rv = ui.rv; if (!rv) return note({ status: 'blocked', code: 'NOT_PREPARED' });
        dropStaleRv(actions.getState()); if (!ui.rv) return note({ status: 'blocked', code: 'VIEW_CHANGED' });
        const r = actions.prepare(rv.act, { reason: rv.reason, acknowledgeSuspended: rv.ack === true });
        ui.prepared = r.status === 'ready' ? { token: r.token, action: rv.act, summary: r.summary, limits: r.limits } : null;
        ui.notice = r.status === 'ready' ? null : { action, status: r.status, code: r.code || null }; return r;
      }
      case 'fve-rv-edit': ui.prepared = null; return { status: 'ok' };            // back to the fields; the prepared record is replaced by the next prepare
      case 'fve-rv-cancel': ui.rv = null; ui.prepared = null; ui.notice = null; return { status: 'ok' };
      case 'fve-confirm-act': {
        const p = ui.prepared; ui.prepared = null; const rvAct = !!(p && RV_ACTS.includes(p.action));
        const rvAt = ui.rv;
        const r = await actions.confirm(data.token || (p && p.token));
        if (!live()) return r;                                              // a late reply of an OLD session / form: the new form, its reason and its notices are not touched
        if (rvAct) { if ((!r || r.status !== 'blocked') && ui.rv === rvAt) ui.rv = null; ui.notice = r && r.status === 'blocked' ? { action, status: r.status, code: r.code || null, rv: true } : null; return r; }   // the typed reason leaves the page once the request exists
        return note(r);
      }
      case 'fve-cancel-prepare': ui.prepared = null; return { status: 'ok' };
      case 'fve-check-now': return note(await actions.checkNow());
      case 'fve-resolve': {
        const r = actions.resolveConflict(data.choice);
        if (r.status === 'confirm_required') { ui.confirm = { kind: 'discard-mine' }; return { status: 'confirm_required' }; }
        return note(r);
      }
      case 'fve-resolve-confirm': ui.confirm = null; return note(actions.resolveConflict('discard-mine', { confirm: true }));
      case 'fve-resolve-cancel': ui.confirm = null; return { status: 'ok' };
      case 'fve-close': {
        const r = actions.closeEditor(); if (r.status === 'confirm_required') { ui.confirm = { kind: 'close' }; return r; }
        releaseIfIdle(actions.getState()); return note(r);
      }
      case 'fve-close-confirm': case 'fve-ignore-confirm': { ui.confirm = null; const r = actions.closeEditor({ confirm: true }); releaseIfIdle(actions.getState()); return note(r); }
      case 'fve-close-cancel': case 'fve-ignore-cancel': case 'fve-move-day-cancel': ui.confirm = null; return { status: 'ok' };
      case 'fve-ignore': ui.confirm = { kind: 'ignore-input' }; return { status: 'confirm_required' };
      case 'fve-move-day': ui.confirm = { kind: 'move-day' }; return { status: 'confirm_required' };
      case 'fve-move-day-confirm': ui.confirm = null; return note(moveToNewDay());
      case 'fve-retry-pending': return note(await actions.retryPending(data.scope));
      case 'fve-discard-pending': ui.discarding = data.scope; return { status: 'confirm_required' };
      case 'fve-discard-cancel': ui.discarding = null; return { status: 'ok' };
      case 'fve-discard-confirm': { ui.discarding = null; return note(await actions.discardPending(data.scope, { acknowledgeRisk: data.ack === true })); }
      case 'fve-refresh': return note(await refreshNow());
      default: return { status: 'unknown_action' };
    }
  }

  /** The editor's day ended. A NEW editor for today receives a copy of the typed numbers and text. Not carried: coverage, attestations (non-overlap),
      copy review. Nothing is sent; no earlier request is touched; the old input stays until the new editor has started. */
  function moveToNewDay() {
    const fundId = fundNow(); const state = actions.getState();
    if (!fundId || !state.editor || !state.scope) return { status: 'blocked', code: 'NO_EDITOR' };
    const t = today(); const oldDate = state.scope.valuationDate;
    if (state.editor.frozen !== 'crossed' || oldDate === t) return { status: 'blocked', code: 'NOT_CROSSED' };
    if (state.awaiting) return { status: 'blocked', code: 'AWAITING_VIEW' };   // the old day still waits for its view: its banner must not disappear behind a new editor
    const can = actions.canStart('createDraft'); if (!can.allowed) return { status: 'blocked', code: can.reason };
    const typed = clone(state.editor.form);
    const started = actions.startCreate(); if (started.status !== 'started') return { status: 'blocked', code: started.code };
    pins.set(fundId, t);
    const empty = E.emptyForm();
    try {
      for (const [list, key, src] of [['otherAssetsItems', 'otherAssetsItems', typed.otherAssetsItems]]) {
        for (let i = 0; i < src.length; i += 1) actions.addItem(list);
        src.forEach((row, i) => { actions.setField(`${key}.${i}.description`, row.description); actions.setField(`${key}.${i}.amount`, row.amount); });
      }
      for (const p of E.diffForms(empty, { ...typed, otherAssetsItems: [] })) {
        if (p.includes('#') || !CARRIED_PREFIXES.some((x) => p === x || p.startsWith(x))) continue;
        const v = p.split('.').reduce((c, k) => (c == null ? undefined : c[k]), typed); if (typeof v === 'string') actions.setField(p, v);
      }
    } catch (e) {
      // the new editor could not be filled: keep the old one exactly as it was
      pins.set(fundId, t); actions.closeEditor({ confirm: true }); pins.set(fundId, oldDate); return { status: 'blocked', code: 'MOVE_FAILED' };
    }
    pins.set(fundId, oldDate); actions.closeEditor({ confirm: true }); pins.set(fundId, t);   // the old editor goes only now that the new one is in place
    ui.notice = { action: 'fve-move-day', status: 'moved', code: null, from: oldDate };
    return { status: 'moved', from: oldDate, to: t };
  }

  /* ---------------- DOM layer (thin; exercised by the browser test) ---------------- */
  function pathValue(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'checkbox') return el.checked;
    if (type === 'radio') return el.checked ? el.value : undefined;
    return el.value;
  }
  function attachDom() {
    const D = deps.doc; if (!D) return () => {};
    const onEvent = (ev) => {
      const el = ev.target; if (!el || !el.getAttribute) return;
      const rvField = el.getAttribute('data-fve-rv');
      if (rvField) { const ty = (el.getAttribute('type') || '').toLowerCase(); if (ty === 'checkbox' ? ev.type === 'change' : ev.type === 'input') onRvInput(rvField, ty === 'checkbox' ? el.checked : el.value, { connected: !!el.isConnected }); return; }
      const path = el.getAttribute('data-fve-path'); if (!path) return;
      const type = (el.getAttribute('type') || '').toLowerCase(); const isText = el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio'].includes(type));
      if (isText && ev.type !== 'input') return;                          // text: every keystroke arrives as `input`; `change` would only repeat it
      if (!isText && ev.type !== 'change') return;
      const v = pathValue(el); if (v === undefined) return;
      onInput(path, v, { connected: !!el.isConnected });
    };
    D.addEventListener('input', onEvent, true); D.addEventListener('change', onEvent, true);
    if (keeper) keeper.attach();
    return () => { D.removeEventListener('input', onEvent, true); D.removeEventListener('change', onEvent, true); if (keeper) keeper.detach(); };
  }
  /** the data-action handler for core.registerActionHandler: returns true when it took the action */
  function actionHandler(action, el) {
    if (typeof action !== 'string' || !action.startsWith('fve-')) return false;
    const ds = el && el.dataset ? el.dataset : {};
    const li = el && el.closest ? el.closest('li') : null; const ack = li ? li.querySelector('[data-fve-ack="risk"]') : null;
    const data = { list: ds.list, index: ds.index, which: ds.which, act: ds.act, token: ds.token, choice: ds.choice, scope: ds.scope, sourceId: ds.sourceId, sourceState: ds.sourceState, ack: !!(ack && ack.checked) };
    Promise.resolve(handleAction(action, data)).catch(() => {}).then(scheduleRender);
    return true;
  }
  /** the reader reports a change (e.g. permission-denied): look at access now, without waiting for a render */
  function onReaderChange() { if (!disposed) sess(); }
  /** composition holds a render only while the session is valid (permission loss lets go at once) */
  const holdsRender = () => {
    if (!sess()) return false;                                         // a loss of access is detected here too: the gate never delays hiding the data
    if (keeper && sessionOk) keeper.captureLive();                      // the gate is asked at the start of every render: the one moment to read the live caret before the DOM is replaced
    return sessionOk && !!keeper && (keeper.holds ? keeper.holds() : keeper.isComposing());
  };

  function dispose() { disposed = true; try { stopDay(); } catch (e) { /* ignore */ } try { actions.dispose(); } catch (e) { /* ignore */ } if (keeper) { keeper.clear(); keeper.detach(); } pins.clear(); ui = freshUi(); }

  return { renderSlot, teardown, onInput, onRvInput, handleAction, actionHandler, attachDom, getContext, holdsRender, refreshNow, refreshState, moveToNewDay, onReaderChange, dispose,
    actions, runner, keeper, pins, stats: () => ({ ...stats, pins: pins.size, repliesSeen }), ui: () => ui, isDead: () => dead };
}
