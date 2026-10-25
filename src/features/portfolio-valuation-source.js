/* =========================================================================
   مصدر تقييمات المحفظة المتعدد الصناديق (R1-C2) — قراءة فقط، غير موصول بأي واجهة
   ---------------------------------------------------------------------------
   يقرأ رؤوس التقييم والتقييمات المعتمدة لكل صناديق نطاق المحفظة، ويتحقق من headHash لكل صندوق،
   ثم يستدعي الجسر النقي computeResidualBackedNetXirr (R1-C1) مرة واحدة فقط حين تكتمل كل الشروط.
   لا DOM ولا Firebase ولا ساعة خاصة (الوقت يُحقَن) ولا كتابة ولا callables.
   لا يُستورد من أي واجهة بعد (R1-C3)، ولا يمسّ portfolioIntelligenceStats (تبقى متزامنة).

   القواعد:
   1. أي تغيّر في الجلسة/الدور/النطاق/التدفقات/الرؤوس/التقييمات/الأهلية أو عبور يوم الرياض يُخفي النتيجة السابقة فورًا
      (getView() يعيد المزامنة قبل أن يُرجع شيئًا؛ لا نتيجة تُعرض إلا لبصمة مدخلات تساوي الحالية الآن).
   2. لا نتيجة جزئية: كل صندوق في النطاق يلزمه رأس ليوم الرياض الحالي + وثيقة معتمدة + تأكيد من الخادم (fromCache=false)
      + نجاح التحقق من headHash. ناقص واحد ⇒ لا معدّل.
   3. القراءة والتحقق غير المتزامنان مربوطان بجيل المدخلات؛ ردّ قديم لا يعيد نتيجة أُبطلت.
   4. فشل القراءة/الرفض/عدم القدرة على التحقق/أهلية غائبة أو غير معروفة ⇒ حجب. لا يُفترض أي رأس صالحًا.
   ========================================================================= */
import { sessionKey, riyadhDay, deepClone, verifyHeadConsistency } from './fund-valuation-model.js';
import { computeResidualBackedNetXirr } from '../domain/financial/xirr/residual-nav-bridge.js';

export const SOURCE_NAMES = Object.freeze(['heads', 'valuations']);
const DENIED_CODES = new Set(['permission-denied', 'firestore/permission-denied']);
const ELIG_STATES = ['ELIGIBLE', 'SUSPENDED'];
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

const emptySrc = () => ({ docs: [], confirmedOnce: false, stale: false, error: null });

export function createPortfolioValuationSource({ subscribe, getSession, getInputs, now, verify = verifyHeadConsistency, compute = computeResidualBackedNetXirr, onChange = () => {} } = {}) {
  if (typeof subscribe !== 'function' || typeof getSession !== 'function' || typeof getInputs !== 'function' || typeof now !== 'function') {
    throw new Error('portfolio-valuation-source: subscribe, getSession, getInputs and now are required');
  }
  let gen = 0;                     // input generation: bumped on every context change
  let ctx = null;                  // { key, day, fp, funds[], inputs }
  let funds = new Map();           // fundId -> { heads, valuations }
  let unsubs = [];
  let denied = false;
  let verifState = null;           // { token, pending, results: Map(fundId -> {ok,reason}), done }
  let result = null;               // { token, out }  (never exposed unless token === current token)
  let queued = false;
  let running = false;             // explicit lifecycle: nothing is read, held or shown until start(); stop() returns to this state
  const stats = { subscribed: 0, unsubscribed: 0, verifyStarted: 0, verifyIgnored: 0, bridgeCalls: 0 };

  function notify() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; try { onChange(); } catch (e) { /* a render failure must not break the source */ } });
  }

  function teardown() {
    const u = unsubs; unsubs = [];
    for (const f of u) { try { f(); } catch (e) { /* ignore */ } }
    funds = new Map(); denied = false; verifState = null; result = null;
  }

  function readInputs() {
    let raw;
    try { raw = getInputs(); } catch (e) { return { ok: false, reason: 'INPUTS_UNAVAILABLE' }; }
    if (isPlain(raw) && typeof raw.unavailable === 'string' && raw.unavailable) return { ok: false, reason: raw.unavailable };   // e.g. the ledger is not server-confirmed yet
    if (!isPlain(raw) || !isPlain(raw.scope) || !Array.isArray(raw.scope.funds) || raw.scope.funds.length === 0 || !raw.scope.funds.every(isStr) || !Array.isArray(raw.records)) {
      return { ok: false, reason: 'INPUTS_INVALID' };
    }
    return { ok: true, scope: raw.scope, records: raw.records };
  }

  /** Synchronous: recompute session / day / inputs. Any change bumps the generation, drops everything held and restarts. */
  function sync() {
    if (!running) return;
    let sess; try { sess = getSession(); } catch (e) { sess = null; }
    const key = sess && sess.roleResolved === true ? sessionKey(sess) : null;   // an unresolved role never reads, whatever a cached value says
    let day = null;
    try { day = riyadhDay(now()); } catch (e) { day = null; }
    const inp = key === null ? { ok: false, reason: 'NO_READ_ACCESS' } : readInputs();
    const fp = JSON.stringify([key, day, inp.ok ? [inp.scope, inp.records] : inp.reason]);
    if (ctx && ctx.fp === fp) return;
    gen += 1;
    teardown();
    ctx = { key, day, fp, inputs: inp, funds: inp.ok ? [...new Set(inp.scope.funds)] : [] };
    if (key !== null && day !== null && inp.ok) startReads(gen);
    notify();
  }

  function startReads(myGen) {
    for (const fundId of ctx.funds) {
      funds.set(fundId, { heads: emptySrc(), valuations: emptySrc() });
      for (const source of SOURCE_NAMES) {
        const live = () => myGen === gen && !denied;
        const onNext = (snap) => { if (live()) onSnapshot(fundId, source, snap); };
        const onError = (err) => { if (live()) onFail(fundId, source, err); };
        try {
          const u = subscribe(source, fundId, onNext, onError);
          stats.subscribed += 1;
          let done = false;
          unsubs.push(() => { if (done) return; done = true; stats.unsubscribed += 1; if (typeof u === 'function') u(); });
        } catch (e) { onFail(fundId, source, e); }
      }
    }
  }

  /* Snapshot contract with the Firestore adapter (R1-C3 must honour it): a snapshot is { docs:[{id,data}], fromCache:boolean, hasPendingWrites:boolean }.
     Data is accepted as CONFIRMED only when fromCache === false AND hasPendingWrites === false (strict booleans).
       - fromCache === true, or hasPendingWrites === true : not confirmed. Before the first confirmation nothing is stored; after it the source
         becomes stale (blocks and hides at once) and the confirmed docs are kept untouched.
       - a missing / non-boolean flag, a non-object snapshot or non-array docs : CONTRACT VIOLATION => error (blocks and hides at once);
         the docs are not stored. A later valid confirmed snapshot clears it. */
  function onSnapshot(fundId, source, snap) {
    const s = funds.get(fundId)[source];
    const valid = isPlain(snap) && typeof snap.fromCache === 'boolean' && typeof snap.hasPendingWrites === 'boolean' && Array.isArray(snap.docs);
    if (!valid) { s.error = 'SNAPSHOT_CONTRACT_VIOLATION'; if (s.confirmedOnce) s.stale = true; }
    else if (snap.fromCache === true || snap.hasPendingWrites === true) { if (s.confirmedOnce) s.stale = true; }
    else {
      s.docs = snap.docs.filter((x) => x && x.id != null).map((x) => ({ id: String(x.id), data: deepClone(x.data || {}) }));
      s.confirmedOnce = true; s.stale = false; s.error = null;
    }
    progress();
  }

  function onFail(fundId, source, err) {
    const code = err && typeof err.code === 'string' ? err.code : null;
    if (code && DENIED_CODES.has(code)) { const u = unsubs; unsubs = []; for (const f of u) { try { f(); } catch (e) { /* ignore */ } } funds = new Map(); denied = true; verifState = null; result = null; notify(); return; }
    const s = funds.get(fundId) && funds.get(fundId)[source];
    if (s) { s.error = code || 'READ_ERROR'; if (s.confirmedOnce) s.stale = true; }
    progress();
  }

  /* ---- what the held data says, as a pure function of the current state ---- */
  function readState() {
    if (!ctx || !ctx.inputs.ok) return { status: 'blocked', reasons: [ctx && ctx.inputs.reason ? ctx.inputs.reason : 'NO_CONTEXT'] };
    if (denied) return { status: 'blocked', reasons: ['PERMISSION_DENIED'] };
    if (ctx.day === null) return { status: 'blocked', reasons: ['CALCULATION_DAY_UNKNOWN'] };
    const reasons = [];
    let waiting = false;
    for (const fundId of ctx.funds) {
      const f = funds.get(fundId);
      if (!f) { reasons.push('READ_NOT_STARTED'); continue; }
      for (const source of SOURCE_NAMES) {
        const s = f[source];
        if (s.error) reasons.push(`READ_ERROR:${source}:${fundId}`);
        else if (s.stale) reasons.push(`READ_STALE:${source}:${fundId}`);
        else if (!s.confirmedOnce) waiting = true;
      }
    }
    if (reasons.length) return { status: 'blocked', reasons: [...new Set(reasons)] };
    if (waiting) return { status: 'loading', reasons: [] };
    return { status: 'confirmed', reasons: [] };
  }

  /** Structure per fund (pure): the head for today's Riyadh day, its approved doc, and the eligibility copy. */
  function collect() {
    const problems = []; const eligibility = {}; const valuations = []; const pairs = [];
    for (const fundId of ctx.funds) {
      const f = funds.get(fundId);
      const head = f.heads.docs.find((d) => d.id === `${fundId}__${ctx.day}` && (d.data.fundId === undefined || d.data.fundId === fundId));
      if (!head) { problems.push(`HEAD_MISSING:${fundId}`); continue; }
      const h = head.data;
      if (!isStr(h.headId)) { problems.push(`HEAD_INCOMPLETE:${fundId}`); continue; }
      const e = h.eligibility;
      if (!isPlain(e) || !ELIG_STATES.includes(e.state)) problems.push(`ELIGIBILITY_MISSING:${fundId}`);
      else eligibility[fundId] = { headId: h.headId, state: e.state };
      const approved = f.valuations.docs.filter((d) => d.data && d.data.state === 'approved' && d.data.fundId === fundId && d.data.valuationDate === ctx.day);
      for (const d of approved) {
        if (d.data.valuationId !== undefined && d.data.valuationId !== d.id) { problems.push(`VALUATION_ID_MISMATCH:${d.id}`); continue; }
        valuations.push({ ...d.data, valuationId: d.id });
      }
      const doc = approved.find((d) => d.id === h.headId);
      if (!doc) { problems.push(`HEAD_DOC_MISSING:${fundId}`); continue; }
      pairs.push({ fundId, head: { ...h, headId: h.headId }, doc: { ...doc.data, valuationId: doc.id } });
    }
    return { problems, eligibility, valuations, pairs };
  }

  const dataFp = (c) => JSON.stringify([c.pairs, c.valuations, c.eligibility]);

  /** Drives the async part. Safe to call at any time. */
  function progress() {
    const rs = readState();
    if (rs.status !== 'confirmed') { verifState = null; result = null; notify(); return; }
    const c = collect();
    if (c.problems.length) { verifState = null; result = null; notify(); return; }
    const token = `${gen}|${dataFp(c)}`;
    if (verifState && verifState.token === token) { notify(); return; }
    result = null;
    const vs = { token, results: new Map(), done: false };
    verifState = vs;
    for (const p of c.pairs) {
      stats.verifyStarted += 1;
      let pr;
      try { pr = Promise.resolve(verify(deepClone(p.head), deepClone(p.doc))); } catch (e) { pr = Promise.resolve({ ok: false, reason: 'HEAD_UNVERIFIABLE' }); }
      pr.then((r) => ({ ok: !!(r && r.ok === true), reason: r && typeof r.reason === 'string' ? r.reason : null }), () => ({ ok: false, reason: 'HEAD_UNVERIFIABLE' }))
        .then((r) => {
          if (verifState !== vs || vs.token !== token) { stats.verifyIgnored += 1; return; }   // late reply for an older generation / data: ignored
          vs.results.set(p.fundId, r);
          if (vs.results.size === c.pairs.length) finish(vs, c);
        });
    }
    notify();
  }

  function finish(vs, c) {
    // re-check synchronously that nothing moved while verification was in flight
    sync();
    if (verifState !== vs) { stats.verifyIgnored += 1; return; }
    const rs = readState();
    if (rs.status !== 'confirmed') return;
    const c2 = collect();
    if (c2.problems.length || `${gen}|${dataFp(c2)}` !== vs.token) { stats.verifyIgnored += 1; return; }
    vs.done = true;
    if ([...vs.results.values()].some((r) => !r.ok)) { notify(); return; }                 // verification failed: blocked, bridge never called
    stats.bridgeCalls += 1;
    let at; try { at = now(); } catch (e) { at = undefined; }
    const out = compute({ asOfDate: ctx.day, scope: deepClone(ctx.inputs.scope), valuations: c2.valuations, records: deepClone(ctx.inputs.records), eligibility: c2.eligibility }, { now: at });
    result = { token: vs.token, out };
    notify();
  }

  /** The only way to see anything. Re-syncs first, so a stale answer can never be returned. */
  function getView() {
    if (!running) return { generation: gen, day: null, status: 'stopped', reasons: ['STOPPED'], result: null };
    sync();
    const base = { generation: gen, day: ctx ? ctx.day : null, status: 'hidden', reasons: [], result: null };
    if (!ctx || ctx.key === null) return { ...base, status: 'hidden', reasons: [ctx && ctx.inputs && ctx.inputs.reason ? ctx.inputs.reason : 'NO_READ_ACCESS'] };
    if (!ctx.inputs.ok) return { ...base, status: 'blocked', reasons: [ctx.inputs.reason] };
    const rs = readState();
    if (rs.status !== 'confirmed') return { ...base, status: rs.status, reasons: rs.reasons };
    const c = collect();
    if (c.problems.length) return { ...base, status: 'blocked', reasons: c.problems };
    const token = `${gen}|${dataFp(c)}`;
    if (!verifState || verifState.token !== token) { progress(); return { ...base, status: 'verifying' }; }
    if (!verifState.done) return { ...base, status: 'verifying' };
    const failed = [...verifState.results.entries()].filter(([, r]) => !r.ok).map(([fid, r]) => `${r.reason || 'HEAD_UNVERIFIABLE'}:${fid}`);
    if (failed.length) return { ...base, status: 'blocked', reasons: failed };
    if (!result || result.token !== token) return { ...base, status: 'verifying' };
    const out = result.out;
    if (out && out.status === 'OK' && typeof out.rate === 'number' && Number.isFinite(out.rate)) return { ...base, status: 'ready', result: out };
    return { ...base, status: 'blocked', reasons: Array.isArray(out && out.reasonCodes) && out.reasonCodes.length ? out.reasonCodes.slice() : [out && out.status ? String(out.status) : 'BLOCKED'], result: out || null };
  }

  /** Explicit lifecycle. stop() is final until start(): getView()/sync()/recover() never reopen subscriptions or show a result. */
  function start() { if (running) { sync(); return; } running = true; ctx = null; sync(); }
  function stop() { running = false; gen += 1; teardown(); ctx = null; notify(); }
  /** Recovery after a read error that ended a listener (or after a denial that may have been lifted): a clean restart with a new generation.
      The wiring layer decides WHEN (visibility change, back online, a timer); this module has no clock. No-op (false) when stopped. */
  function recover() { if (!running) return false; teardown(); ctx = null; sync(); return true; }   // sync() bumps the generation

  return {
    start,
    recover,
    sync,
    getView,
    stop,
    stats: () => ({ ...stats, live: stats.subscribed - stats.unsubscribed, generation: gen, running, heldDocs: [...funds.values()].reduce((n, f) => n + f.heads.docs.length + f.valuations.docs.length, 0), holdsResult: result !== null }),
  };
}
