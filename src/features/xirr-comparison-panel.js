/* =========================================================================
   لوحة XIRR المقارنة (Shadow / للمقارنة فقط)
   ---------------------------------------------------------------------------
   تعرض بجانب IRR الحالي كلاً من XIRR المشروع وXIRR حقوق الملكية المحسوبين من
   تدفقات النموذج عند "تاريخ أساس افتراضي" يُدخله المستخدم يدوياً.

   قواعد صارمة (الخيار أ المتفق عليه):
   - التاريخ المحلي يدوي، وفارغ عند أول استخدام (لا تاريخ اليوم ولا أي تاريخ مُخمَّن).
   - لا يُجرى أي حساب قبل وجود تاريخ صالح (YYYY-MM-DD، تاريخ تقويمي حقيقي).
   - اختيار التاريخ لا يُنشئ جدول تحصيل/صرف تشغيلياً جديداً، ولا يغيّر IRR الحالي
     ولا بوابة اللجنة ولا التقارير ولا المحرك المالي: هذا ملف عرض فقط.
   - النسبة الرئيسية تظهر فقط عند status === 'OK' وrate منتهٍ؛ الصفر الحقيقي يظهر 0.00%
     (بما فيه -2.4e-16 الناتج عن الأخطاء العددية، دون "-0.00%").
   - تعدد الجذور/الغموض العددي: تُعرض الحالة بلا نسبة رئيسية، والجذور/المرشَّحات في
     <details> منفصل مع بيان أنها ليست عائداً معتمداً.
   - التحذيرات تُشرح بالعربية مع بقاء الرمز التقني ونصه الأصلي في التفاصيل؛ الرموز
     غير المعروفة تبقى ظاهرة حرفياً.
   - الحساب عند طلب المستخدم (زر "احسب") أو عند تغيّر مدخلات الفرصة، لا عند كل إعادة رسم
     (ذاكرة مؤقتة مفتاحها: مستخدم + فرصة + تاريخ + محتوى المدخلات).
   - الحفظ المحلي (اختياري) بمفتاح منفصل لكل مستخدم ولكل فرصة، وفشل التخزين لا يكسر العرض.
   لا تعديل على core.js أو المحرك أو Golden Master.
   ========================================================================= */
import { computeOpportunityProjectAndEquityXirr as defaultCompute } from '../domain/financial/xirr/opportunity-xirr.js';

export const STORAGE_PREFIX = 'opal.xirrBaseDate.v1';
const MAX_CACHE = 50;

/* ---------- أدوات نقية (قابلة للاختبار بلا DOM) ---------- */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXT_ARABIC_INDIC = '۰۱۲۳۴۵۶۷۸۹';
export function normalizeDigits(s) {
  return String(s ?? '').replace(/[٠-٩۰-۹]/g, (ch) => {
    const i = ARABIC_INDIC.indexOf(ch);
    return String(i >= 0 ? i : EXT_ARABIC_INDIC.indexOf(ch));
  });
}

/** تاريخ تقويمي حقيقي بصيغة YYYY-MM-DD صارمة (2000–2100). يعيد النص الموحَّد أو null. */
export function parseBaseDate(raw) {
  const s = normalizeDigits(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return s;
}

/** نسبة مئوية للعرض؛ الصفر العددي (|x|<0.005%) يظهر 0.00% دائماً. */
export function formatRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '—';
  const pct = rate * 100;
  if (Math.abs(pct) < 0.005) return '0.00%';
  return pct.toFixed(2) + '%';
}

const NO_RATE_TEXT = {
  NO_REAL_ROOT: ['لا يوجد معدل حقيقي يحقق المعادلة لهذه التدفقات.', 'No real rate satisfies the equation for these cash flows.'],
  NO_SIGN_CHANGE: ['التدفقات لا تتغير إشارتها (لا تدفق خارج ثم داخل)، فلا يوجد عائد مُعرَّف.', 'The cash flows never change sign, so no return is defined.'],
  NO_ROOT_FOUND_IN_SEARCH_RANGE: ['لم يُعثر على معدل ضمن نطاق البحث المسموح.', 'No rate was found within the allowed search range.'],
  ROOT_PROVEN_OUTSIDE_SEARCH_RANGE: ['ثبت أن الجذر خارج نطاق البحث المسموح؛ لا يُعرض معدل.', 'The root is proven to lie outside the allowed search range; no rate is shown.'],
  DEGENERATE_NO_TIME_SPREAD: ['كل التدفقات في التاريخ نفسه تقريباً (لا امتداد زمني)، فلا يمكن حساب XIRR.', 'All cash flows fall on essentially the same date (no time spread), so XIRR cannot be computed.'],
  INSUFFICIENT_INPUT: ['مدخلات غير كافية لحساب XIRR.', 'Insufficient input to compute XIRR.'],
  INVALID_INPUT: ['مدخلات غير صالحة لحساب XIRR.', 'Invalid input for the XIRR computation.'],
  INTERNAL_INCONSISTENCY: ['عدم اتساق داخلي في الحساب؛ لا يُعرض معدل.', 'Internal inconsistency in the computation; no rate is shown.'],
  INSUFFICIENT_SOURCE_DATA: ['بيانات التكلفة المصدرية ناقصة أو غير صالحة، فلم تُبنَ سلسلة التدفقات.', 'Source cost data is missing or invalid, so the cash-flow series was not built.'],
  UPSTREAM_GENERATION_FAILED: ['تعذّر توليد التدفقات المؤرَّخة من النموذج.', 'Generating the dated cash flows from the model failed.'],
  PANEL_COMPUTE_ERROR: ['حدث خطأ أثناء الحساب؛ لا يُعرض معدل.', 'An error occurred during the computation; no rate is shown.'],
  MISSING_RESULT: ['لا توجد نتيجة لهذه السلسلة.', 'No result is available for this series.'],
  OK_WITHOUT_FINITE_RATE: ['الحالة OK لكن المعدل غير منتهٍ؛ لا يُعرض.', 'Status is OK but the rate is not finite; nothing is shown.'],
};
const UNDETERMINED_TEXT = {
  POSSIBLE_MULTIPLE_ROOTS: ['يوجد أكثر من معدل رياضي محتمل لهذه التدفقات، فلا نعرض معدلاً رئيسياً.', 'More than one mathematically possible rate exists for these cash flows, so no headline rate is shown.'],
  NUMERICALLY_AMBIGUOUS: ['النتيجة غامضة عددياً (المرشَّحات غير مؤكَّدة)، فلا نعرض معدلاً رئيسياً.', 'The result is numerically ambiguous (candidates are unverified), so no headline rate is shown.'],
};

const WARNING_TEXT = {
  ASSUMED_DATE_NOT_OPERATIONAL: ['التاريخ المُدخل افتراض للمقارنة وليس تاريخاً تشغيلياً مؤكَّداً؛ النتيجة عائد "مُستنتَج من النموذج" وليست عائداً محققاً.', 'The entered date is an assumption for comparison, not a confirmed operational date; the result is model-implied, not a realized return.'],
  PERPETUAL_HOLD_DEEMED_EXIT_IN_EQUITY_SERIES: ['استراتيجية احتفاظ دائم: سلسلة حقوق الملكية تتضمن خروجاً افتراضياً عند نهاية الأفق كأنه بيع فعلي، فالنتيجة ليست دليلاً على عائد محقق.', 'Perpetual-hold strategy: the equity series includes a deemed exit at the horizon as if it were a real sale; the result is not evidence of a realized return.'],
  PHASED_SALE_MODE_DEBT_LEDGER_NOT_RECONCILED_HERE: ['وضع البيع المرحلي: لم تُطابَق دفتر الديون هنا؛ سلسلتا المشروع وحقوق الملكية صالحتان لكن لم يُجرَ إثبات إغلاق النقد لهذا الوضع.', 'Phased-sale mode: the debt ledger is not reconciled here; the project and equity series remain valid but no closed-cash proof was run for this mode.'],
  DRAW_SCHEDULE_TIMING_NOT_ALIGNED_TO_PROJECT_COST_BOOKING: ['جدول السحب غير متطابق زمنياً مع تسجيل تكلفة المشروع (يتطابقان في الإجمالي فقط)؛ لا يؤثر على السلسلتين المعروضتين لكنه يؤثر على قراءة توقيت التمويل.', 'The draw schedule does not align date-by-date with project-cost booking (only in total); the displayed series are unaffected but funding timing should be read with care.'],
  INSUFFICIENT_SOURCE_DATA_PROJECT_COST: ['حقول تكلفة المشروع (الأرض/البناء) ناقصة أو غير صالحة، فلم يُحسب XIRR المشروع.', 'Project cost fields (land/hard cost) are missing or invalid, so project XIRR was not computed.'],
  PROJECT_CASH_GENERATION_FAILED: ['تعذّر توليد تدفقات المشروع.', 'Generating project cash flows failed.'],
  EQUITY_CASH_GENERATION_FAILED: ['تعذّر توليد تدفقات حقوق الملكية.', 'Generating equity cash flows failed.'],
};

function finiteList(a) {
  return Array.isArray(a) ? a.filter((x) => typeof x === 'number' && Number.isFinite(x)) : [];
}

/** يصنّف نتيجة XIRR واحدة إلى RATE | UNDETERMINED | NO_RATE دون اختراع أي معدل. */
export function classifyXirr(x) {
  if (!x || typeof x !== 'object') return { kind: 'NO_RATE', status: 'MISSING_RESULT', rate: null, candidates: null };
  const status = String(x.status);
  if (status === 'OK') {
    if (typeof x.rate === 'number' && Number.isFinite(x.rate)) return { kind: 'RATE', status, rate: x.rate, candidates: null };
    return { kind: 'NO_RATE', status: 'OK_WITHOUT_FINITE_RATE', rate: null, candidates: null };
  }
  if (status === 'POSSIBLE_MULTIPLE_ROOTS' || status === 'NUMERICALLY_AMBIGUOUS') {
    return {
      kind: 'UNDETERMINED', status, rate: null,
      candidates: {
        roots: finiteList(x.roots),
        crossingRates: finiteList(x.crossingRates),
        tangentCandidates: finiteList(x.tangentCandidates),
        candidateRates: finiteList(x.candidateRates),
        unverified: x.candidateRatesAreUnverified === true,
      },
    };
  }
  return { kind: 'NO_RATE', status, rate: null, candidates: null };
}

/* ---------- ذاكرة الحالة والتخزين ---------- */

function esc0(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function userKeyOf(user) {
  if (!user) return 'anonymous';
  const k = user.uid || user.email;
  return k ? String(k).toLowerCase() : 'anonymous';
}
export function storageKeyFor(userKey, oppId) {
  return `${STORAGE_PREFIX}:${userKey}:${oppId}`;
}

function defaultStorage() {
  return {
    getItem(k) { return globalThis.localStorage.getItem(k); },
    setItem(k, v) { globalThis.localStorage.setItem(k, v); },
    removeItem(k) { globalThis.localStorage.removeItem(k); },
  };
}

export function registerXirrComparisonPanel(core, deps = {}) {
  const compute = deps.compute || defaultCompute;
  const storage = deps.storage || defaultStorage();
  const getDoc = deps.getDoc || (() => globalThis.document);
  const T = (ar, en) => (typeof core.T === 'function' ? core.T(ar, en) : ar);
  const esc = typeof core.esc === 'function' ? core.esc : esc0;
  const stats = { computeCalls: 0, cacheHits: 0 };

  const states = new Map();   // storageKey -> { applied, draft, error, loaded, storageFailed }
  const cache = new Map();    // cacheKey -> wrapper result | {error}

  function stateFor(sk) {
    let st = states.get(sk);
    if (!st) { st = { applied: null, draft: '', error: null, loaded: false, storageFailed: false }; states.set(sk, st); }
    if (!st.loaded) {
      st.loaded = true;
      try {
        const v = storage.getItem(sk);
        const ok = v == null ? null : parseBaseDate(v);
        if (ok) { st.applied = ok; st.draft = ok; }
      } catch (e) { st.storageFailed = true; }
    }
    return st;
  }
  function persist(sk, st, value) {
    try {
      if (value) storage.setItem(sk, value); else storage.removeItem(sk);
      st.storageFailed = false;
    } catch (e) { st.storageFailed = true; }
  }

  function runCompute(sk, oppId, date, d, c) {
    let sigD = null;
    let sigC = null;
    try { sigD = JSON.stringify(d); } catch (e) { sigD = null; }
    try { sigC = JSON.stringify(c); } catch (e) { sigC = null; }

    const ck = (sigD && sigC) ? `${sk}|${date}|${sigD}|${sigC}` : null;
    if (ck && cache.has(ck)) { stats.cacheHits++; return cache.get(ck); }

    stats.computeCalls++;
    let res;
    try {
      res = compute(d, c, { acquisitionDate: date, acquisitionDateIsAssumed: true });
    } catch (e) {
      res = { panelError: String(e && e.message || e) };
    }
    if (ck) {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(ck, res);
    }
    return res;
  }

  /* ---------- HTML ---------- */

  const pctNum = (r) => `<bdi dir="ltr">${esc(formatRate(r))}</bdi>`;

  function candidatesHtml(cl) {
    const cs = cl.candidates;
    const rows = [
      ['roots', T('الجذور', 'Roots'), cs.roots],
      ['crossingRates', T('نقاط العبور', 'Crossing rates'), cs.crossingRates],
      ['tangentCandidates', T('مرشَّحات التماس', 'Tangent candidates'), cs.tangentCandidates],
      ['candidateRates', T('معدلات مرشَّحة', 'Candidate rates'), cs.candidateRates],
    ].filter((r) => r[2].length);
    const body = rows.length
      ? rows.map((r) => `<div>${esc(r[1])}: ${r[2].map(pctNum).join(' · ')}</div>`).join('')
      : `<div>${T('لا توجد قيم مرشَّحة منتهية.', 'No finite candidate values.')}</div>`;
    return `<details class="xirr-candidates"><summary>${T('الجذور/المرشَّحات (ليست عائداً معتمداً)', 'Roots / candidates (not an approved return)')}</summary>
      <div class="muted" style="font-size:12px;margin:4px 0">${T('هذه قيم رياضية محتملة فقط' + (cs.unverified ? ' وغير مُتحقَّق منها' : '') + '، ولا تمثّل عائداً معتمداً ولا يُبنى عليها قرار.', 'These are mathematical candidates only' + (cs.unverified ? ' and are unverified' : '') + '; they are not an approved return and no decision should rest on them.')}</div>
      ${body}</details>`;
  }

  function seriesRow(label, x) {
    const cl = classifyXirr(x);
    let head, note = '', extra = '';
    if (cl.kind === 'RATE') {
      head = `<strong>${pctNum(cl.rate)}</strong>`;
    } else if (cl.kind === 'UNDETERMINED') {
      head = `<strong>${T('غير محدَّد', 'Undetermined')}</strong>`;
      const t = UNDETERMINED_TEXT[cl.status];
      note = `<div class="muted" style="font-size:12px">${esc(T(t[0], t[1]))}</div>`;
      extra = candidatesHtml(cl);
    } else {
      head = `<strong>—</strong>`;
      const t = NO_RATE_TEXT[cl.status];
      note = `<div class="muted" style="font-size:12px">${t ? esc(T(t[0], t[1])) : esc(T('حالة غير معروفة للحساب؛ لا يُعرض معدل.', 'Unknown computation status; no rate is shown.'))}</div>`;
    }
    const reason = (x && typeof x === 'object' && x.reason) ? `<div class="muted" style="font-size:12px">${esc(String(x.reason))}</div>` : '';
    return `<tr data-xirr-series="${esc(label.key)}"><td>${esc(label.text)}</td><td>${head}${note}${reason}${extra}</td><td><span class="xirr-status" style="font-size:12px">${esc(cl.status)}</span></td></tr>`;
  }

  function warningsHtml(list) {
    if (!Array.isArray(list) || !list.length) return '';
    const items = list.map((w) => {
      const code = String(w && w.code);
      const t = WARNING_TEXT[code];
      const human = t ? esc(T(t[0], t[1])) : esc(T('تحذير برمز غير معروف — راجع التفاصيل التقنية.', 'Warning with an unrecognized code — see technical details.'));
      return `<li data-xirr-warning="${esc(code)}">${human}
        <details><summary>${T('التفاصيل التقنية', 'Technical details')}</summary><div><code>${esc(code)}</code></div><div class="muted" style="font-size:12px">${esc(String((w && w.message) ?? ''))}</div></details></li>`;
    }).join('');
    return `<div style="margin-top:8px"><strong>${T('تنبيهات', 'Notices')}</strong><ul style="margin:4px 0 0;padding-inline-start:18px">${items}</ul></div>`;
  }

  function currentIrrHtml(c) {
    const f = (v) => (typeof core.fmtPct === 'function' ? core.fmtPct(v, 1) : formatRate(v));
    const eq = c && typeof c.equityIRR === 'number' ? f(c.equityIRR) : '—';
    const pr = c && typeof c.projectIRR === 'number' ? f(c.projectIRR) : '—';
    return `<div style="margin:6px 0">${T('IRR الحالي (النموذج، دون تغيير)', 'Current IRR (model, unchanged)')}:
      ${T('حقوق الملكية', 'Equity')} <strong><bdi dir="ltr">${esc(eq)}</bdi></strong> ·
      ${T('المشروع', 'Project')} <strong><bdi dir="ltr">${esc(pr)}</bdi></strong></div>`;
  }

  function renderPanel(d, c) {
    const oppId = core.openDetailId;
    if (oppId == null) return '';
    const sk = storageKeyFor(userKeyOf(core.currentUser), oppId);
    const st = stateFor(sk);

    let resultHtml = '';
    if (st.error) {
      const msg = st.error === 'empty'
        ? T('أدخل تاريخاً بصيغة YYYY-MM-DD ثم اضغط "احسب". لا يُحسب شيء بدون تاريخ.', 'Enter a date as YYYY-MM-DD, then press Calculate. Nothing is computed without a date.')
        : T('تاريخ غير صالح. استخدم صيغة YYYY-MM-DD لتاريخ تقويمي حقيقي (مثال: 2027-03-15). لم يُجرَ أي حساب.', 'Invalid date. Use YYYY-MM-DD for a real calendar date (e.g. 2027-03-15). Nothing was computed.');
      resultHtml = `<div class="xirr-error" role="alert" style="color:#b45309;margin-top:8px">${esc(msg)}</div>`;
    } else if (!st.applied) {
      resultHtml = `<div class="muted" style="margin-top:8px">${T('لم يُحدَّد تاريخ أساس بعد. أدخل تاريخاً ثم اضغط "احسب".', 'No base date set yet. Enter a date and press Calculate.')}</div>`;
    } else {
      const res = runCompute(sk, oppId, st.applied, d, c);
      if (!res || res.panelError !== undefined) {
        const t = NO_RATE_TEXT.PANEL_COMPUTE_ERROR;
        resultHtml = `<div class="xirr-error" role="alert" style="margin-top:8px">${esc(T(t[0], t[1]))}
          <details><summary>${T('التفاصيل التقنية', 'Technical details')}</summary><code>PANEL_COMPUTE_ERROR</code> <span class="muted">${esc(String(res && res.panelError))}</span></details></div>`;
      } else {
        resultHtml = `<div style="margin-top:8px">${T('تاريخ الأساس الافتراضي', 'Assumed base date')}: <strong><bdi dir="ltr">${esc(st.applied)}</bdi></strong></div>
          <table style="width:100%;margin-top:6px"><thead><tr><th>${T('السلسلة', 'Series')}</th><th>XIRR</th><th>${T('الحالة', 'Status')}</th></tr></thead><tbody>
          ${seriesRow({ key: 'project', text: T('المشروع', 'Project') }, res.project && res.project.xirr)}
          ${seriesRow({ key: 'equity', text: T('حقوق الملكية', 'Equity') }, res.equity && res.equity.xirr)}
          </tbody></table>${warningsHtml(res.sourceWarnings)}`;
      }
    }

    const value = st.draft || '';
    const storageNote = st.storageFailed
      ? `<div class="muted" style="font-size:12px;margin-top:4px">${T('تعذّر الحفظ المحلي للتاريخ؛ سيبقى في هذه الجلسة فقط.', 'Could not save the date locally; it will last for this session only.')}</div>` : '';
    return `<div class="section" id="xirr-comparison-panel" data-xirr-opp="${esc(oppId)}">
      <h3>${T('XIRR وفق تدفقات النموذج وتاريخ أساس افتراضي — للمقارنة فقط', 'XIRR on model cash flows and an assumed base date — for comparison only')}</h3>
      <div class="muted" style="font-size:12px;margin-bottom:6px">${T('اختيار تاريخ هنا لا ينشئ جدول تحصيل أو صرف تشغيلياً جديداً، ولا يغيّر IRR الحالي أو بوابة اللجنة أو التقارير. هذه مقارنة للقراءة فقط.', 'Choosing a date here does not create a new operational collection or spend schedule and does not change the current IRR, the committee gate or the reports. This is a read-only comparison.')}</div>
      ${currentIrrHtml(c)}
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <label for="xirr-base-date">${T('تاريخ الأساس (YYYY-MM-DD)', 'Base date (YYYY-MM-DD)')}</label>
        <input type="text" id="xirr-base-date" inputmode="numeric" dir="ltr" placeholder="YYYY-MM-DD" autocomplete="off" value="${esc(value)}">
        <button type="button" class="btn" data-action="xirr-apply" data-xirr-opp="${esc(oppId)}">${T('احسب', 'Calculate')}</button>
        <button type="button" class="btn" data-action="xirr-clear" data-xirr-opp="${esc(oppId)}">${T('مسح', 'Clear')}</button>
      </div>
      ${storageNote}
      ${resultHtml}
    </div>`;
  }

  /* ---------- الإجراءات ---------- */

  function handleAction(action, el) {
    if (action !== 'xirr-apply' && action !== 'xirr-clear') return false;
    const attr = el && typeof el.getAttribute === 'function' ? el.getAttribute('data-xirr-opp') : null;
    const oppId = attr != null ? attr : core.openDetailId;
    if (oppId == null) return true;
    const sk = storageKeyFor(userKeyOf(core.currentUser), oppId);
    const st = stateFor(sk);
    if (action === 'xirr-clear') {
      st.applied = null; st.draft = ''; st.error = null;
      persist(sk, st, null);
    } else {
      const doc = getDoc();
      const input = doc && typeof doc.getElementById === 'function' ? doc.getElementById('xirr-base-date') : null;
      const raw = input ? String(input.value ?? '') : '';
      st.draft = raw;
      if (raw.trim() === '') {
        st.applied = null; st.error = 'empty'; persist(sk, st, null);
      } else {
        const ok = parseBaseDate(raw);
        if (!ok) { st.applied = null; st.error = 'invalid'; persist(sk, st, null); }
        else { st.applied = ok; st.draft = ok; st.error = null; persist(sk, st, ok); }
      }
    }
    if (typeof core.render === 'function') core.render();
    return true;
  }

  core.registerDetailSection((d, c) => renderPanel(d, c));
  core.registerActionHandler((action, el) => handleAction(action, el));

  return { stats, _renderPanel: renderPanel, _handleAction: handleAction, _cacheSize: () => cache.size };
}
