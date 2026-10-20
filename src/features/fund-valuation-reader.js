/* =========================================================================
   قارئ تقييمات القيمة المتبقية للصندوق (R1-B2 / B2-1) — قراءة فقط
   ---------------------------------------------------------------------------
   يدير: (١) المستمعات الثلاثة (الرؤوس، التقييمات، الأحداث) لصندوق واحد مفتوح ولدور قراءة محسوم فقط،
   (٢) دورة الجلسة (تبدّل المستخدم/فقد الدور ⇒ إيقاف ومسح وإبطال الجيل)، (٣) حالة التحميل/التأكيد من الخادم،
   (٤) اختيار التاريخ، (٥) التحقق من اتساق الرأس مع وثيقة المعتمد.
   لا DOM ولا Firebase هنا: كل شيء يُحقَن (subscribe / getSession / verify / onChange).
   لا callables ولا مخزن طلبات ولا أي كتابة. لا استيراد من وحدات XIRR.

   قواعد صارمة:
   - دور غير محسوم أو غير قارئ ⇒ صفر اشتراكات وصفر استعلامات.
   - لا يُعدّ المصدر مؤكَّدًا إلا بلقطة fromCache=false. عودة مصدر مؤكَّد إلى fromCache تجعله قديمًا فورًا.
   - نتيجة التحقق مفتاحها (جيل، صندوق، تاريخ، رأس، وثيقة المعتمد): نتيجة متأخرة لسياق سابق لا تُطبَّق ولا تُعرض.
   - عند عدم الاتساق/التعليق/غياب الوثيقة: لا قيمة سارية ولا الرجوع لإصدار أقدم.
   ========================================================================= */
import { canRead, createGenerationGuard, createSessionTracker, deepClone, isRealIsoDay, verifyHeadConsistency } from './fund-valuation-model.js';

export const SOURCES = Object.freeze(['heads', 'valuations', 'events']);
export const EVENTS_DISPLAY_LIMIT = 50;
const ACTIVE_STATES = Object.freeze(['draft', 'returned', 'submitted', 'reviewed']);
const DENIED_CODES = new Set(['permission-denied', 'firestore/permission-denied']);

function emptySource() { return { docs: [], confirmedOnce: false, fromCache: null, stale: false, error: null, stamp: null, snapN: 0 }; }
function emptyData() { return { heads: emptySource(), valuations: emptySource(), events: emptySource() }; }

/** رأس: التاريخ من الحقل إن صح وإلا من معرّف الوثيقة fundId__YYYY-MM-DD. */
function headDateOf(h) {
  const d = h.data && h.data.valuationDate;
  if (typeof d === 'string' && isRealIsoDay(d)) return d;
  const parts = String(h.id).split('__');
  const cand = parts.length === 2 ? parts[1] : null;
  return cand && isRealIsoDay(cand) ? cand : null;
}
const latestFirst = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : (a.id < b.id ? 1 : -1)));

export function createFundValuationReader({ subscribe, getSession, verify = verifyHeadConsistency, onChange = () => {}, eventsLimit = EVENTS_DISPLAY_LIMIT, fetchOnce } = {}) {
  if (typeof subscribe !== 'function' || typeof getSession !== 'function') throw new Error('reader: subscribe and getSession are required');
  const guard = createGenerationGuard();
  let wantedFund = null;
  let active = null;                 // { id, fundId, gen, unsubs, denied }
  let seq = 0;
  let data = emptyData();
  let userDate = null;
  let showAll = false;
  let logOpen = false;
  let verif = new Map();             // token -> { state: 'pending' | 'ok' | 'fail', reason }
  let session = { resolved: false, readable: false };
  let notifyQueued = false;
  /* ---- explicit reads (B2-2b/b0). Two different numbers, never mixed:
     readSeq  = reads STARTED (monotonic for the whole life of the reader: never reset, never reused). It is the high-water mark a caller records
                when it receives a reply; only a read numbered ABOVE it started after the reply.
     stamp    = the number of the read that PRODUCED the docs on screen (heads / valuations); null when the docs came from a listener. A listener
                snapshot replaces the docs and so wipes the stamp: listener data proves nothing about order. */
  let readSeq = 0;
  let lastRead = null;               // { n, ok, reason, code? } the last COMPLETED read (applied or not)
  const stats = { subscribed: 0, unsubscribed: 0 };

  const tracker = createSessionTracker({ guard, onReset: () => { teardown(); } });

  function notify() {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => { notifyQueued = false; try { onChange(); } catch (e) { /* a render failure must not break the reader */ } });
  }

  /** يوقف كل المستمعات ويمسح كل بيانات العرض ويُبطل الجيل. يعيد true إن كان هناك ما يُمسح. */
  function teardown() {
    const had = !!active || userDate != null || showAll || logOpen || verif.size > 0
      || SOURCES.some((s) => data[s].docs.length > 0 || data[s].confirmedOnce);
    const unsubs = active ? active.unsubs.slice() : [];
    active = null;
    guard.bump();
    for (const u of unsubs) { try { u(); } catch (e) { /* ignore */ } }
    data = emptyData(); userDate = null; showAll = false; logOpen = false; verif = new Map(); lastRead = null;
    if (had) notify();
    return had;
  }

  function stopListenersKeepNothing() {
    // permission-denied: إيقاف المستمعات ومسح البيانات مع بقاء حالة denied حتى يُعاد الاشتراك صراحةً
    const a = active;
    if (!a) return;
    const unsubs = a.unsubs.slice(); a.unsubs.length = 0; a.denied = true;
    guard.bump();
    a.gen = guard.current();
    for (const u of unsubs) { try { u(); } catch (e) { /* ignore */ } }
    data = emptyData(); verif = new Map();
  }

  function start(fundId) {
    const id = ++seq;
    const gen = guard.bump();
    active = { inFlight: 0, id, fundId, gen, unsubs: [], denied: false };
    data = emptyData(); verif = new Map(); userDate = null; showAll = false; logOpen = false; lastRead = null;
    for (const source of SOURCES) {
      const live = () => !!active && active.id === id && active.gen === gen && guard.isCurrent(gen) && !active.denied;
      const onNext = (snap) => { if (live()) handleSnapshot(source, snap); };
      const onError = (err) => { if (live()) handleError(source, err); };
      try {
        const u = subscribe(source, fundId, onNext, onError);
        stats.subscribed += 1;
        let done = false;
        active.unsubs.push(() => { if (done) return; done = true; stats.unsubscribed += 1; if (typeof u === 'function') u(); });
      } catch (e) {
        if (live()) handleError(source, e);
      }
    }
    notify();
  }

  function handleSnapshot(source, snap) {
    const d = data[source];
    if (snap && snap.fromCache) {
      // لقطة من الذاكرة المحلية لا تحلّ محل آخر لقطة مؤكَّدة من الخادم أبدًا:
      // بعد التأكيد تُعلِّم المصدر «قديمًا» فقط وتبقى البيانات المؤكَّدة كما هي؛
      // وقبل أول تأكيد لا تُخزَّن أي وثائق (يبقى التحميل بلا قيم).
      d.fromCache = true;
      if (d.confirmedOnce) d.stale = true;
    } else {
      const raw = snap && Array.isArray(snap.docs) ? snap.docs : [];
      d.docs = raw.filter((x) => x && x.id != null).map((x) => ({ id: String(x.id), data: deepClone(x.data || {}) }));
      d.fromCache = false; d.confirmedOnce = true; d.stale = false; d.error = null;
      d.stamp = null; d.snapN += 1;    // listener data: no order proof, and a read that was in flight across it is superseded
    }
    afterChange();
  }

  function handleError(source, err) {
    const code = err && typeof err.code === 'string' ? err.code : null;
    if (code && DENIED_CODES.has(code)) { stopListenersKeepNothing(); notify(); return; }
    const d = data[source];
    d.error = { code, message: err && typeof err.message === 'string' ? err.message : null, reason: err && err.details && typeof err.details.reason === 'string' ? err.details.reason : null, raw: err };
    if (d.confirmedOnce) d.stale = true;         // المستمع بعد الخطأ ميت: ما عُرض سابقًا يصبح قديمًا
    afterChange();
  }

  /* ---------- الجلسة ---------- */
  function sync() {
    const s = getSession() || {};
    const resolved = !!s.roleResolved;
    session = { resolved, readable: resolved && canRead(s.role) };
    tracker.update(resolved ? s : { ...s, role: null });
    const key = tracker.key();
    if (key == null || wantedFund == null) { if (active) teardown(); return; }
    if (active && active.fundId === wantedFund) return;
    if (active) teardown();
    start(wantedFund);
  }
  function open(fundId) {
    wantedFund = typeof fundId === 'string' && fundId ? fundId : null;
    sync();
  }
  function close() {
    wantedFund = null;
    if (active) teardown();
  }
  /** نهاية الجلسة (خروج/تبديل مستخدم مباشر): إيقاف ومسح وإلغاء الصندوق المطلوب. */
  function reset() {
    wantedFund = null;
    teardown();
  }
  function retry() {
    teardown();
    sync();
  }

  /* ---------- النموذج المشتق (نقي: لا يغيّر الحالة) ---------- */
  function computeModel() {
    const fundId = active ? active.fundId : null;
    const heads = [];
    let excluded = 0;
    for (const h of data.heads.docs) {
      const date = headDateOf(h);
      if (!date || (h.data.fundId !== undefined && h.data.fundId !== fundId)) { excluded += 1; continue; }
      heads.push({ id: h.id, date, d: h.data });
    }
    const vals = [];
    for (const v of data.valuations.docs) {
      const d = v.data;
      if (d.fundId !== fundId || typeof d.valuationDate !== 'string' || !isRealIsoDay(d.valuationDate) || (d.valuationId !== undefined && d.valuationId !== v.id)) { excluded += 1; continue; }
      vals.push({ id: v.id, date: d.valuationDate, stamp: String(d.updatedAt || d.approvedAt || ''), d });
    }
    const dates = [...new Set([...heads.map((h) => h.date), ...vals.map((v) => v.date)])].sort().reverse();
    const approvedHeads = heads.filter((h) => typeof h.d.headId === 'string' && h.d.headId);
    let defaultDate = null; let defaultKind = 'none';
    if (approvedHeads.length) { defaultDate = approvedHeads.map((h) => h.date).sort().reverse()[0]; defaultKind = 'head'; }
    else if (vals.length) { defaultDate = [...vals].sort(latestFirst)[0].date; defaultKind = 'valuation'; }
    else if (heads.length) { defaultDate = heads.map((h) => h.date).sort().reverse()[0]; defaultKind = 'draft-head'; }   // رأس بلا معتمد ولا تقييم متاح
    const userPick = userDate && dates.includes(userDate) ? userDate : null;
    const selected = userPick || defaultDate;
    return { fundId, heads, vals, dates, defaultDate, defaultKind, selected, selection: userPick ? 'user' : (selected ? `default-${defaultKind}` : 'none'), excluded };
  }

  function allConfirmed() { return SOURCES.every((s) => data[s].confirmedOnce); }

  function approvedKeyOf(m) {
    if (!m.selected) return null;
    const head = m.heads.find((h) => h.date === m.selected);
    if (!head || typeof head.d.headId !== 'string' || !head.d.headId) return { kind: 'none', head: head || null };
    const doc = m.vals.find((v) => v.id === head.d.headId && v.date === m.selected);
    if (!doc) return { kind: 'no-doc', head };
    const token = JSON.stringify([active.gen, m.fundId, m.selected, head.d.headId, head.d.version, head.d.headHash, doc.d.state, doc.d.version, doc.d.contentHash, doc.d.approvedBy]);
    return { kind: 'checkable', head, doc, token };
  }

  /* ---------- التحقق من اتساق الرأس (غير متزامن، مرتبط بالسياق) ---------- */
  function refreshVerification() {
    if (!active || active.denied || !allConfirmed()) return;
    const k = approvedKeyOf(computeModel());
    if (!k || k.kind !== 'checkable' || verif.has(k.token)) return;
    if (verif.size > 24) verif = new Map();
    verif.set(k.token, { state: 'pending' });
    const myId = active.id; const myGen = active.gen; const token = k.token;
    const headCopy = { headId: k.head.d.headId, headHash: k.head.d.headHash, version: k.head.d.version };
    const docCopy = { state: k.doc.d.state, valuationId: k.doc.id, version: k.doc.d.version, contentHash: k.doc.d.contentHash, approvedBy: k.doc.d.approvedBy };
    const apply = (res) => {
      if (!active || active.id !== myId || active.gen !== myGen || !guard.isCurrent(myGen) || active.denied) return;   // سياق سابق: يُهمَل
      if (!verif.has(token)) return;
      verif.set(token, res && res.ok === true ? { state: 'ok' } : { state: 'fail', reason: (res && res.reason) || 'HEAD_UNVERIFIABLE' });
      notify();
    };
    Promise.resolve().then(() => verify(headCopy, docCopy)).then(apply, () => apply({ ok: false, reason: 'HEAD_UNVERIFIABLE' }));
  }

  /* ---------- explicit server reads ---------- */
  const mapDocs = (raw) => (Array.isArray(raw) ? raw : []).filter((x) => x && x.id != null).map((x) => ({ id: String(x.id), data: deepClone(x.data || {}) }));
  /** Structural consistency of two reads that are NOT one atomic snapshot: every head that names an active draft must find that draft (same fund/date,
      active state) and every active draft must be named by the head of its date. A mismatch means the two gets straddled a write: nothing is applied. */
  function pairProblem(headDocs, valDocs, fundId) {
    const heads = new Map();
    for (const h of headDocs) { const date = headDateOf(h); if (date && (h.data.fundId === undefined || h.data.fundId === fundId)) heads.set(date, h.data); }
    const vals = new Map(valDocs.map((v) => [v.id, v.data]));
    for (const [date, h] of heads) {
      if (typeof h.activeDraftId === 'string' && h.activeDraftId) {
        const v = vals.get(h.activeDraftId);
        if (!v || v.fundId !== fundId || v.valuationDate !== date || !ACTIVE_STATES.includes(v.state)) return 'HEAD_DRAFT_MISSING';
      }
      if (typeof h.headId === 'string' && h.headId && !vals.has(h.headId)) return 'HEAD_DOC_MISSING';
    }
    for (const [id, v] of vals) {
      if (v.fundId !== fundId || !ACTIVE_STATES.includes(v.state)) continue;
      const h = heads.get(v.valuationDate);
      if (!h || h.activeDraftId !== id) return 'ACTIVE_DOC_WITHOUT_POINTER';
    }
    return null;
  }
  /** Starts ONE new server read of heads and valuations. The number is taken NOW (even if the fetch cannot start or fails later) and is never
      merged with a read in flight. ONLY THE LATEST ISSUED read may apply: when a newer read has been issued, an older result is dropped.
      Each of the two gets is watched on its own, so a permission-denied is never hidden behind another failure and clears everything the moment it
      arrives (if the session is still the one that issued the read). A failed, cached or structurally inconsistent result keeps what is on screen
      but marks it stale: it is not a confirmation. A completed read that is current, the latest issued, unmixed with listener data and consistent
      replaces the docs and gives them its number. */
  function refresh() {
    const a = active;
    if (!a || a.denied || !session.readable || typeof fetchOnce !== 'function') return Promise.resolve({ status: 'unavailable', issued: readSeq });
    const n = ++readSeq; const id = a.id; const gen = a.gen; const fundId = a.fundId;
    const snap0 = { heads: data.heads.snapN, valuations: data.valuations.snapN };
    const live = () => !!active && active.id === id && active.gen === gen && guard.isCurrent(gen) && !active.denied;
    a.inFlight += 1;   // per CONTEXT: a read of an old session / fund never counts against the current one
    /** what is shown stays, but it is no longer a valid confirmation */
    const unconfirm = () => { for (const s of ['heads', 'valuations']) if (data[s].confirmedOnce) data[s].stale = true; };   // events are not part of an explicit read
    let deniedHere = false;
    const watch = (source) => {
      let p;
      try { p = Promise.resolve(fetchOnce(source, fundId)); } catch (e) { p = Promise.reject(e); }
      return p.then((v) => ({ ok: true, v }), (err) => {
        const code = err && typeof err.code === 'string' ? err.code : null;
        if (code && DENIED_CODES.has(code) && live()) { deniedHere = true; stopListenersKeepNothing(); lastRead = { n, ok: false, reason: 'PERMISSION_DENIED' }; notify(); }   // refused is not "offline": nothing stays on screen, at once
        else if (live() && n === readSeq) { unconfirm(); lastRead = { n, ok: false, reason: 'READ_FAILED', code }; notify(); }   // ANY failing part of the CURRENT, latest read drops the confirmation now: no waiting for the other get
        return { ok: false, err, code };
      });
    };
    const done = (result, record) => { a.inFlight -= 1; if (record && live()) { lastRead = { n, ...record }; notify(); } return { issued: n, ...result }; };
    return Promise.all([watch('heads'), watch('valuations')]).then(([h, v]) => {
      if (deniedHere) { a.inFlight -= 1; return { issued: n, status: 'denied', reason: 'PERMISSION_DENIED' }; }
      if (!live()) return done({ status: 'dropped', reason: 'CONTEXT_CHANGED' });
      if (n < readSeq) return done({ status: 'dropped', reason: 'SUPERSEDED_BY_NEWER_ISSUE' }, { ok: false, reason: 'SUPERSEDED_BY_NEWER_ISSUE' });
      if (!h.ok || !v.ok) { const bad = h.ok ? v : h; return done({ status: 'failed', reason: 'READ_FAILED', code: bad.code }, { ok: false, reason: 'READ_FAILED', code: bad.code }); }   // offline / transient: what is shown is untouched, gains no stamp
      if (!h.v || !v.v || h.v.fromCache || v.v.fromCache) { unconfirm(); return done({ status: 'not_confirmed', reason: 'FROM_CACHE' }, { ok: false, reason: 'FROM_CACHE' }); }
      if (data.heads.snapN !== snap0.heads || data.valuations.snapN !== snap0.valuations) return done({ status: 'dropped', reason: 'SUPERSEDED_BY_LISTENER' }, { ok: false, reason: 'SUPERSEDED_BY_LISTENER' });
      const hd = mapDocs(h.v.docs); const vd = mapDocs(v.v.docs);
      const problem = pairProblem(hd, vd, fundId);
      if (problem) { unconfirm(); return done({ status: 'inconsistent', reason: problem }, { ok: false, reason: problem }); }
      for (const [src, docs] of [['heads', hd], ['valuations', vd]]) {
        const d = data[src]; d.docs = docs; d.fromCache = false; d.confirmedOnce = true; d.stale = false; d.error = null; d.stamp = n;
      }
      lastRead = { n, ok: true, reason: null };
      a.inFlight -= 1; afterChange();
      return { issued: n, status: 'applied' };
    });
  }

  function afterChange() { refreshVerification(); notify(); }

  /* ---------- أفعال المستخدم (قراءة فقط) ---------- */
  function selectDate(date) {
    if (!active || active.denied || typeof date !== 'string' || !isRealIsoDay(date)) return false;
    if (!computeModel().dates.includes(date)) return false;
    userDate = date; afterChange(); return true;
  }
  function toggleLog() { logOpen = !logOpen; notify(); }
  function toggleShowAll() { showAll = !showAll; notify(); }

  /* ---------- العرض ---------- */
  function statusOf() {
    if (!session.resolved) return 'unresolved';
    if (!session.readable) return 'forbidden';
    if (!active) return 'idle';
    if (active.denied) return 'denied';
    if (!allConfirmed()) return SOURCES.some((s) => data[s].error && !data[s].confirmedOnce) ? 'error' : 'loading';
    const m = computeModel();
    return m.heads.length === 0 && m.vals.length === 0 ? 'empty' : 'ready';
  }

  /** The read marker. `epoch` is non-null only when BOTH heads and valuations on screen came from the same explicit read; `confirmed` also needs both
      sources confirmed, fresh and error-free. `issued` is the high-water mark of reads started. */
  function readMarker() {
    const hs = data.heads.stamp; const vs = data.valuations.stamp;
    const epoch = hs !== null && hs === vs ? hs : null;
    const confirmed = epoch !== null && ['heads', 'valuations'].every((s) => data[s].confirmedOnce && data[s].fromCache === false && !data[s].stale && !data[s].error) && !!active && !active.denied;
    return { issued: readSeq, epoch, confirmed, fundId: active ? active.fundId : null, inFlight: active ? active.inFlight : 0, lastResult: lastRead ? { ...lastRead } : null };
  }

  function getView() { return buildView(null); }

  function buildView(forcedDate) {
    const status = statusOf();
    const view = { status, stale: false, read: readMarker(), fundId: active ? active.fundId : null, sources: {}, errors: [], dates: [], selectedDate: null, selection: 'none', approved: { kind: 'none' }, draft: null, events: { total: 0, shown: 0, showAll, open: logOpen, rows: [] }, excluded: 0 };
    if (!active || status === 'unresolved' || status === 'forbidden' || status === 'idle' || status === 'denied') return view;
    for (const s of SOURCES) {
      const d = data[s];
      view.sources[s] = d.error && !d.confirmedOnce ? 'error' : (!d.confirmedOnce ? 'pending' : (d.stale ? 'stale' : 'confirmed'));
      if (d.error) view.errors.push({ source: s, code: d.error.code, reason: d.error.reason, message: d.error.message });
      if (d.stale) view.stale = true;
    }
    if (status === 'loading' || status === 'error') return view;
    const m0 = computeModel();
    const m = forcedDate ? { ...m0, selected: forcedDate, selection: 'pinned' } : m0;
    view.dates = m.dates.slice(); view.selectedDate = m.selected; view.selection = m.selection; view.excluded = m.excluded;
    if (m.selected) {
      const k = approvedKeyOf(m);
      const head = k && k.head ? k.head.d : null;
      if (k && k.kind === 'checkable') {
        const r = verif.get(k.token);
        const base = { headId: head.headId, version: head.version, valuationDate: m.selected };
        const elig = head.eligibility && typeof head.eligibility === 'object' ? deepClone(head.eligibility) : null;
        if (!r || r.state === 'pending') view.approved = { kind: 'verifying', ...base };
        else if (r.state === 'fail') view.approved = { kind: 'inconsistent', reason: r.reason, ...base };
        else if (elig && elig.state === 'SUSPENDED') view.approved = { kind: 'suspended', eligibility: elig, approvedBy: k.doc.d.approvedBy, approvedAt: k.doc.d.approvedAt, ...base };
        else if (elig && elig.state === 'ELIGIBLE') view.approved = { kind: 'effective', eligibility: elig, doc: deepClone(k.doc.d), ...base };
        else view.approved = { kind: 'eligibility-unknown', eligibility: elig, ...base };
      } else if (k && k.kind === 'no-doc') {
        view.approved = { kind: 'inconsistent', reason: 'HEAD_DOC_MISSING', headId: head.headId, version: head.version, valuationDate: m.selected };
      }
      const draftId = head && typeof head.activeDraftId === 'string' && head.activeDraftId ? head.activeDraftId : null;
      if (draftId) {
        const dv = m.vals.find((v) => v.id === draftId);
        view.draft = dv ? { id: draftId, missing: false, doc: deepClone(dv.d) } : { id: draftId, missing: true, doc: null };
      }
      if (!k || k.kind === 'none') {
        // لا رأس معتمد لهذا التاريخ: يُعرض أحدث تقييم بحالته صراحةً (دون ادعاء أنه ساري)
        const here = m.vals.filter((v) => v.date === m.selected).sort(latestFirst);
        if (here.length && !(view.draft && !view.draft.missing && view.draft.id === here[0].id)) view.latestValuation = { id: here[0].id, doc: deepClone(here[0].d) };
      }
    }
    const evs = data.events.docs.filter((e) => e.data && e.data.fundId === active.fundId)
      .map((e) => ({ id: e.id, d: e.data, at: String(e.data.at || '') }))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : (a.id < b.id ? 1 : -1)));
    const shown = showAll ? evs : evs.slice(0, eventsLimit);
    view.events = { total: evs.length, shown: shown.length, showAll, open: logOpen, rows: shown.map((e) => ({ id: e.id, at: e.d.at, type: e.d.type, action: e.d.action, valuationId: e.d.valuationId, valuationDate: e.d.valuationDate, actor: e.d.actor, role: e.d.role, reason: e.d.details && typeof e.d.details.reason === 'string' ? e.d.details.reason : null })) };
    return view;
  }

  /** The context an editor needs for ONE date, which may differ from the date the panel shows. Null when there is nothing to base it on. */
  function contextFor(date) {
    if (typeof date !== 'string' || !isRealIsoDay(date) || !active) return null;
    const v = buildView(date);
    return { fundId: v.fundId, valuationDate: date, status: v.status, stale: v.stale, draft: v.draft, approved: v.approved || null, latestValuation: v.latestValuation || null, read: { ...v.read, valuationDate: date } };
  }

  return {
    open, close, reset, sync, retry, selectDate, toggleLog, toggleShowAll, getView, refresh, contextFor,
    /** تشخيص للاختبار: اشتراكات مفتوحة، وعدد الوثائق المحتفَظ بها في الذاكرة (يجب أن يكون 0 بعد المسح). */
    stats: () => ({ subscribed: stats.subscribed, unsubscribed: stats.unsubscribed, live: stats.subscribed - stats.unsubscribed, heldDocs: SOURCES.reduce((n, s) => n + data[s].docs.length, 0), heldVerifications: verif.size }),
    wanted: () => wantedFund,
  };
}
