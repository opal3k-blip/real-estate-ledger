/* =========================================================================
   طبقة توصيل Net XIRR (R1-C3) — مصدر نتيجة واحد للشاشتين (ذكاء المحفظة ومركز القيادة)
   ---------------------------------------------------------------------------
   تغلّف createPortfolioValuationSource (R1-C2) وتضيف ما لا يجوز أن يقع داخل المصدر النقي (لا ساعة هناك):
     - دورة الحياة: تبدأ القراءة حين يُرسم عرض يحمل العلامة data-netxirr-live، وتتوقف (stop) فور اختفاء العلامة من الصفحة
       (مراقِب DOM) أو عند pagehide. لا اشتراكات بلا عرض ظاهر.
     - إبطال العرض عند منتصف ليل الرياض (مؤقّت للحد التالي) وعند عودة التبويب/التركيز/الاتصال (sync فوري).
     - استعادة القراءة بعد خطأ ينهي المستمع (أو رفض/انتهاك عقد) عبر recover() بتراجع أسّي: 2 ث، 4، 8 … حتى 60 ث، مؤقّت واحد معلّق
       فقط، ولا يُستدعى recover أبكر من نافذة التراجع مهما تكرّرت الأحداث. يُصفَّر العدّاد عند الوصول إلى ready.
     - إعادة الرسم فقط حين تتغير بصمة العرض (حالة/جيل/أسباب/معدّل)، لا عند كل إشعار.
   كل الاعتماديات مُحقنة (now, timers, doc, win, observe)؛ الافتراضي هو بيئة المتصفح إن وُجدت.
   ========================================================================= */
import { riyadhDay } from './fund-valuation-model.js';

export const LIVE_MARKER = 'data-netxirr-live';
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_CAP_MS = 60000;
const MAX_TIMEOUT = 2147483647;
const EARLY_TOLERANCE_MS = 50;      // a timer may fire a hair early; never more than this counts as "on time"
const RECOVERABLE = (r) => typeof r === 'string' && (r.startsWith('READ_ERROR') || r === 'PERMISSION_DENIED');

/** ms until the next Asia/Riyadh midnight (UTC+3, no DST) from the injected instant. */
export function msUntilRiyadhMidnight(nowDate) {
  const day = riyadhDay(nowDate);
  const boundary = Date.parse(`${day}T00:00:00Z`) + 86400000 - 3 * 3600000;
  return boundary - nowDate.getTime();
}

export function viewSignature(v) {
  return [v.status, v.generation, v.day, (v.reasons || []).join(','), v.result && typeof v.result.rate === 'number' ? v.result.rate : ''].join('|');
}

export function createNetXirrLive({ source, now, requestRender = () => {}, timers, doc = null, win = null, isShown, observe } = {}) {
  if (!source || typeof source.getView !== 'function' || typeof now !== 'function') throw new Error('net-xirr-live: source and now are required');
  const T = timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
  const shown = isShown || (() => !!(doc && doc.querySelector && doc.querySelector(`[${LIVE_MARKER}]`)));
  let on = false;                    // listeners / observer installed and the source started by us
  let midnightTimer = null; let retryTimer = null; let disconnect = null;
  let attempts = 0; let gateStart = null;      // gateStart = when the current wait began (error first seen, or last recover)
  let lastSig = null;
  const stats = { acquires: 0, releases: 0, renders: 0, recovers: 0, midnightFires: 0, retriesScheduled: 0 };
  const handlers = [];

  const clearTimer = (h) => { if (h !== null) T.clearTimeout(h); return null; };
  const backoff = () => Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * (2 ** attempts));

  function scheduleMidnight() {
    midnightTimer = clearTimer(midnightTimer);
    let d; try { d = msUntilRiyadhMidnight(now()); } catch (e) { return; }
    midnightTimer = T.setTimeout(() => {
      midnightTimer = null; stats.midnightFires += 1;
      if (!on) return;
      source.sync(); check(); scheduleMidnight();
    }, Math.min(MAX_TIMEOUT, Math.max(1000, d + 50)));
  }

  /** Re-evaluate: render if the view changed; schedule / cancel recovery. */
  function check() {
    if (!on) return;
    const v = source.getView();
    const sig = viewSignature(v);
    if (sig !== lastSig) { lastSig = sig; stats.renders += 1; requestRender(); }
    if (v.status === 'ready') { attempts = 0; retryTimer = clearTimer(retryTimer); return; }
    if (v.status === 'blocked' && v.reasons.some(RECOVERABLE)) scheduleRetry(); else retryTimer = clearTimer(retryTimer);
  }

  function scheduleRetry() {
    if (retryTimer !== null) return;
    const wait = backoff();
    gateStart = now().getTime();
    stats.retriesScheduled += 1;
    retryTimer = T.setTimeout(() => { retryTimer = null; tryRecover(); }, wait);
  }

  /** recover() at most once per backoff window, whatever triggers it. */
  function tryRecover() {
    if (!on) return false;
    const v = source.getView();
    if (!(v.status === 'blocked' && v.reasons.some(RECOVERABLE))) return false;
    const t = now().getTime();
    if (retryTimer !== null) { if (gateStart !== null && t - gateStart < backoff() - EARLY_TOLERANCE_MS) return false; retryTimer = clearTimer(retryTimer); }   // too early: the armed timer will do it
    else if (gateStart === null || t - gateStart < backoff() - EARLY_TOLERANCE_MS) { scheduleRetry(); return false; }
    attempts += 1; stats.recovers += 1; gateStart = t;
    source.recover(); check();
    return true;
  }

  function onEnvEvent() { if (!on) return; source.sync(); check(); tryRecover(); }

  function listen(target, name, fn) { if (target && target.addEventListener) { target.addEventListener(name, fn); handlers.push(() => target.removeEventListener(name, fn)); } }

  function acquire() {
    if (on) return;
    on = true; stats.acquires += 1; attempts = 0; gateStart = null; lastSig = null;
    source.start();
    scheduleMidnight();
    listen(doc, 'visibilitychange', () => { if (!doc.visibilityState || doc.visibilityState === 'visible') onEnvEvent(); });
    listen(win, 'focus', onEnvEvent);
    listen(win, 'online', onEnvEvent);
    listen(win, 'pagehide', () => release());
    const obs = observe || (doc && typeof globalThis.MutationObserver === 'function' && doc.body
      ? (cb) => { const m = new globalThis.MutationObserver(cb); m.observe(doc.body, { childList: true, subtree: true }); return () => m.disconnect(); }
      : null);
    if (obs) disconnect = obs(() => { if (on && !shown()) release(); });
  }

  function release() {
    if (!on) return;
    on = false; stats.releases += 1;
    source.stop();
    midnightTimer = clearTimer(midnightTimer); retryTimer = clearTimer(retryTimer);
    while (handlers.length) { try { handlers.pop()(); } catch (e) { /* ignore */ } }
    if (disconnect) { try { disconnect(); } catch (e) { /* ignore */ } disconnect = null; }
  }

  /** Called by a screen when it renders. Starts the read if needed and returns the CURRENT view (never a remembered one). */
  function view() {
    acquire();
    const v = source.getView();
    lastSig = viewSignature(v);
    return v;
  }

  return {
    view, acquire, release,
    /** the source's onChange: re-evaluate and request a render only if the view changed */
    onSourceChange: check,
    sync: onEnvEvent,
    isOn: () => on,
    stats: () => ({ ...stats, attempts, midnightArmed: midnightTimer !== null, retryArmed: retryTimer !== null, listeners: handlers.length }),
  };
}

/* ---- the single shared instance both screens read (installed by main.js) ---- */
let shared = null;
export function setNetXirrLive(l) { shared = l; }
export function getNetXirrLive() { return shared; }
