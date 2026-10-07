/* =========================================================================
   مركز التنبيهات (Phase 3A-2b) — لوحة بصرية موحّدة أعلى مذكرة الفرصة
   ---------------------------------------------------------------------------
   يجمع في عرض واحد:
   1) سلامة المدخلات (محرك التحقق 3A-1): أخطاء / نواقص / تنبيهات بأعداد واضحة،
      كل بند بزر «انتقل إلى الحقل» يفتح معالج التعديل عند الخطوة والحقل المعنيين.
   2) أبعاد الخطر القائمة: جودة البيانات، العناية الواجبة، سجل المخاطر، تركّز المحفظة.
   3) بطاقة «تنبيه: فرصة عالية المخاطر» (لا تحجب الحفظ ولا الاعتماد): LTC > 85%، سايبور/هامش
      مرتفعان، مدة إنشاء طويلة، IRR مرتفع جدًا، DSCR < 1، مخاطر عالية مسجَّلة، تركّز ≥ 50%.
   لا يحسب أي رقم مالي جديد، ولا يغيّر core.compute ولا الحفظ. كل بُعد يُجلب داخل try/catch؛
   فشل بُعد يُعرض كـ«غير متاح» بدل إسقاط اللوحة.
   ========================================================================= */
import { STATUS } from '../domain/validation/input-validation-engine.js';
import { classifyOpportunity, HIGH_RISK_PATHS, COUNT_CONSTRUCTION_SHORTFALL_AS_RISK, isBlockedStatus } from '../domain/validation/risk-classification.js';
import { dataQualityStats } from './data-quality.js';
import { ddStats, defaultItemsDict } from './due-diligence.js';
import { riskStats, defaultRiskItems } from './risk-engine.js';
import { portfolioIntelligenceStats, WARN_THRESHOLD } from './portfolio.js';

export const HIGH_CONCENTRATION = 0.5;
/* 3A-3: التصنيف المالي (مسارات المخاطر العالية، قاعدة الإنشاء) صار في وحدة نطاق مشتركة مع الخادم
   (src/domain/validation/risk-classification.js). تُعاد تصديرها هنا للتوافق مع الاستيرادات السابقة. */
export { HIGH_RISK_PATHS, COUNT_CONSTRUCTION_SHORTFALL_AS_RISK };

const LEVEL = { bad: 'bad', warn: 'warn', good: 'good', na: 'na' };

function safe(fn) { try { return { ok: true, v: fn() }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; } }

/** نقي قدر الإمكان: يبني نموذج اللوحة من بيانات الفرصة ونتيجة الحساب. لا يرمي. */
export function buildAlertModel(core, d, c) {
  /* 3A-3: القرار (الحالة/اللون/الحجب/المخاطر المالية) يأتي من الوحدة المشتركة نفسها التي يشغّلها الخادم. */
  const cls = classifyOpportunity(d, c);
  const rv = cls.error ? { ok: false, error: cls.error } : { ok: true, v: cls.report };
  const report = rv.ok ? rv.v : { status: 'ERROR', blocking: [], incomplete: [], warnings: [] };
  const model = {
    status: rv.ok ? report.status : 'ERROR',
    validationError: rv.ok ? null : rv.error,
    counts: { errors: report.blocking.length, incomplete: report.incomplete.length, warnings: report.warnings.length },
    issues: { blocking: report.blocking, incomplete: report.incomplete, warnings: report.warnings },
    dims: [],
    highRisk: { flag: false, reasons: [] },
  };
  const reasons = model.highRisk.reasons;

  // ---- الأبعاد ----
  model.dims.push({
    key: 'inputs', ar: 'سلامة المدخلات', en: 'Input validity',
    level: !rv.ok ? LEVEL.bad : report.status === STATUS.OK ? LEVEL.good : report.status === STATUS.WARNINGS ? LEVEL.warn : LEVEL.bad,
    headAr: !rv.ok ? 'تعذّر التحقق' : report.status === STATUS.OK ? 'سليمة' : report.status === STATUS.WARNINGS ? 'سليمة مع تنبيهات' : report.status === STATUS.INCOMPLETE ? 'ناقصة' : 'غير صالحة',
    headEn: !rv.ok ? 'Could not validate' : report.status === STATUS.OK ? 'Valid' : report.status === STATUS.WARNINGS ? 'Valid with notices' : report.status === STATUS.INCOMPLETE ? 'Incomplete' : 'Invalid',
    subAr: `${model.counts.errors} أخطاء · ${model.counts.incomplete} نواقص · ${model.counts.warnings} تنبيهات`,
    subEn: `${model.counts.errors} errors · ${model.counts.incomplete} incomplete · ${model.counts.warnings} notices`,
  });

  const dq = safe(() => dataQualityStats(core, d));
  model.dims.push(dq.ok ? {
    key: 'dataQuality', ar: 'جودة البيانات', en: 'Data quality',
    level: dq.v.criticalMissing.length ? LEVEL.bad : dq.v.pct >= 0.9 ? LEVEL.good : LEVEL.warn,
    headAr: `${Math.round(dq.v.pct * 100)}% مكتملة`, headEn: `${Math.round(dq.v.pct * 100)}% complete`,
    subAr: dq.v.criticalMissing.length ? `${dq.v.criticalMissing.length} مُدخل حرج مفقود` : 'لا نقص حرج',
    subEn: dq.v.criticalMissing.length ? `${dq.v.criticalMissing.length} critical input(s) missing` : 'No critical gaps',
  } : { key: 'dataQuality', ar: 'جودة البيانات', en: 'Data quality', level: LEVEL.na, headAr: 'غير متاح', headEn: 'Unavailable', subAr: '', subEn: '' });

  const dd = safe(() => ddStats((d.dd && d.dd.items) || defaultItemsDict()));
  model.dims.push(dd.ok ? {
    key: 'dueDiligence', ar: 'العناية الواجبة', en: 'Due diligence',
    level: dd.v.criticalPending ? LEVEL.bad : dd.v.pct >= 0.9 ? LEVEL.good : LEVEL.warn,
    headAr: `${Math.round(dd.v.pct * 100)}% منجَزة`, headEn: `${Math.round(dd.v.pct * 100)}% done`,
    subAr: dd.v.criticalPending ? `${dd.v.criticalPending} بند حرج معلّق` : 'لا بنود حرجة معلّقة',
    subEn: dd.v.criticalPending ? `${dd.v.criticalPending} critical item(s) pending` : 'No critical items pending',
  } : { key: 'dueDiligence', ar: 'العناية الواجبة', en: 'Due diligence', level: LEVEL.na, headAr: 'غير متاح', headEn: 'Unavailable', subAr: '', subEn: '' });

  const rk = safe(() => riskStats((d.risk && d.risk.items) || defaultRiskItems()));
  if (rk.ok) {
    const band = rk.v.overall.key;
    model.dims.push({
      key: 'riskRegister', ar: 'سجل المخاطر', en: 'Risk register',
      level: band === 'high' ? LEVEL.bad : band === 'medium' ? LEVEL.warn : band === 'low' ? LEVEL.good : LEVEL.na,
      headAr: rk.v.overall.ar, headEn: rk.v.overall.en,
      subAr: `${rk.v.highCount} مرتفعة · ${rk.v.unassessedCount} لم تُقيَّم`, subEn: `${rk.v.highCount} high · ${rk.v.unassessedCount} not assessed`,
    });
    if (rk.v.highCount > 0) reasons.push({ ar: `${rk.v.highCount} من مخاطر السجل مصنَّفة «مرتفعة».`, en: `${rk.v.highCount} register risk(s) rated "High".` });
  } else {
    model.dims.push({ key: 'riskRegister', ar: 'سجل المخاطر', en: 'Risk register', level: LEVEL.na, headAr: 'غير متاح', headEn: 'Unavailable', subAr: '', subEn: '' });
  }

  // التركّز: يحتاج صناديق في المخزن (نفس شرط concentration-risk.js)
  const hasFunds = core && core.STORE && Array.isArray(core.STORE.funds) && core.STORE.funds.length > 0;
  if (hasFunds) {
    const cc = safe(() => {
      const s = portfolioIntelligenceStats(core);
      const city = (d.meta && d.meta.city) || '';
      const ti = core.OPP_TYPE_INFO && core.OPP_TYPE_INFO[d.meta && d.meta.oppType];
      const tlabel = ti ? core.T(ti.t, ti.en) : (d.meta && d.meta.oppType);
      const cr = s.cityConc.find((r) => r.key === city);
      const tr = s.typeConc.find((r) => r.key === tlabel);
      return { cityPct: cr ? cr.pct : 0, typePct: tr ? tr.pct : 0, city, tlabel };
    });
    if (cc.ok) {
      const mx = Math.max(cc.v.cityPct, cc.v.typePct);
      model.dims.push({
        key: 'concentration', ar: 'تركّز المحفظة', en: 'Portfolio concentration',
        level: mx >= HIGH_CONCENTRATION ? LEVEL.bad : mx >= WARN_THRESHOLD ? LEVEL.warn : LEVEL.good,
        headAr: `${Math.round(mx * 100)}% أعلى حصة`, headEn: `${Math.round(mx * 100)}% top share`,
        subAr: `المدينة ${Math.round(cc.v.cityPct * 100)}% · النوع ${Math.round(cc.v.typePct * 100)}%`, subEn: `City ${Math.round(cc.v.cityPct * 100)}% · Type ${Math.round(cc.v.typePct * 100)}%`,
      });
      if (mx >= HIGH_CONCENTRATION) reasons.push({ ar: `تركّز مرتفع في المحفظة (${Math.round(mx * 100)}%).`, en: `High portfolio concentration (${Math.round(mx * 100)}%).` });
    } else {
      model.dims.push({ key: 'concentration', ar: 'تركّز المحفظة', en: 'Portfolio concentration', level: LEVEL.na, headAr: 'غير متاح', headEn: 'Unavailable', subAr: '', subEn: '' });
    }
  } else {
    model.dims.push({ key: 'concentration', ar: 'تركّز المحفظة', en: 'Portfolio concentration', level: LEVEL.na, headAr: 'لا صناديق', headEn: 'No funds', subAr: 'يُقاس عند وجود صناديق', subEn: 'Measured once funds exist' });
  }

  // ---- مخاطر عالية (لا تحجب شيئًا): الأسباب المالية من الوحدة المشتركة؛ السياقية (السجل/التركّز) أعلاه للعرض فقط ----
  cls.highRisk.reasons.forEach((r) => reasons.push({ ar: r.ar, en: r.en }));
  const blockedNow = isBlockedStatus(model.status);
  {
    const { riskShort, conShort, hasDebtService } = cls.debt;
    const yrs = (list) => list.map((y) => y.yr).join('، ');
    const yrsEn = (list) => list.map((y) => y.yr).join(', ');
    if (cls.debt.ok) {
      model.dims.push({
        key: 'debtCoverage', ar: 'تغطية خدمة الدين', en: 'Debt service coverage',
        level: !hasDebtService ? LEVEL.na : riskShort.length ? LEVEL.bad : conShort.length ? LEVEL.warn : LEVEL.good,
        headAr: !hasDebtService ? 'لا خدمة دين' : riskShort.length ? `عجز في ${riskShort.length} سنة` : conShort.length ? 'تُموَّل من الملاك في الإنشاء' : 'مغطّاة',
        headEn: !hasDebtService ? 'No debt service' : riskShort.length ? `Shortfall in ${riskShort.length} year(s)` : conShort.length ? 'Equity-funded during construction' : 'Covered',
        subAr: conShort.length && !blockedNow ? `خدمة الدين في الإنشاء بلا تدفق متاح: السنوات ${yrs(conShort)}` : '',
        subEn: conShort.length && !blockedNow ? `Construction-phase debt service with no cash available: year(s) ${yrsEn(conShort)}` : '',
      });
    } else {
      model.dims.push({ key: 'debtCoverage', ar: 'تغطية خدمة الدين', en: 'Debt service coverage', level: LEVEL.na, headAr: 'غير متاح', headEn: 'Unavailable', subAr: '', subEn: '' });
    }
  }
  model.highRisk.flag = reasons.length > 0;
  model.verdict = { status: cls.status, color: cls.color, blocked: cls.blocked, highRisk: cls.highRisk.flag, compound: cls.compound };
  return model;
}

const STYLE = `<style data-alert-center-style>
.alert-center{margin:14px 0;padding:14px;border:1px solid var(--line,#d8dce3);border-radius:12px;background:var(--surface,#fff)}
.alert-center .ac-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.alert-center .ac-head h3{margin:0;font-size:17px}
.alert-center .ac-chip{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;color:#fff}
.alert-center .ac-counters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
.alert-center .ac-counter{border-radius:10px;padding:10px 12px;border:1px solid transparent}
.alert-center .ac-counter b{display:block;font-size:26px;line-height:1.1}
.alert-center .ac-counter span{font-size:12px}
.alert-center .ac-risk{border:2px solid var(--bad,#c23b5b);background:rgba(194,59,91,.08);border-radius:10px;padding:10px 12px;margin-bottom:12px}
.alert-center .ac-risk h4{margin:0 0 6px;color:var(--bad,#c23b5b);font-size:15px}
.alert-center .ac-risk ul{margin:0;padding-inline-start:18px;font-size:13px}
.alert-center .ac-dims{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.alert-center .ac-dim{border-radius:10px;padding:8px 10px;background:var(--surface-2,#f4f6f9);border-inline-start:5px solid var(--ink-faint,#9aa3b2)}
.alert-center .ac-dim small{display:block;color:var(--ink-faint,#6b7280)}
.alert-center .ac-dim strong{display:block;font-size:14px;margin:2px 0}
.alert-center .ac-dim.bad{border-inline-start-color:var(--bad,#c23b5b)}
.alert-center .ac-dim.warn{border-inline-start-color:var(--gold,#c98a2e)}
.alert-center .ac-dim.good{border-inline-start-color:var(--good,#1fa67e)}
.alert-center .ac-issues{display:flex;flex-direction:column;gap:8px}
.alert-center .ac-issue{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;border-radius:10px;padding:8px 10px;background:var(--surface-2,#f4f6f9);border-inline-start:5px solid var(--ink-faint,#9aa3b2)}
.alert-center .ac-issue.bad{border-inline-start-color:var(--bad,#c23b5b)}
.alert-center .ac-issue.warn{border-inline-start-color:var(--gold,#c98a2e)}
.alert-center .ac-issue .ac-msg{font-size:13px;font-weight:600}
.alert-center .ac-issue .ac-meta{font-size:11px;color:var(--ink-faint,#6b7280)}
.alert-center .ac-ok{padding:10px 12px;border-radius:10px;background:rgba(31,166,126,.1);color:var(--good,#1fa67e);font-weight:700}
@media print{.alert-center .btn{display:none}}
</style>`;

/* عند الحجب لا يُعرض أي رقم ناتج عن الحساب (عدّ ظهور IRR = 0): رسائل result.* تُستبدل بنص عام بلا قيمة. */
const NEUTRAL_OUTPUT_MSG = {
  OUTPUT_NOT_FINITE: ['مؤشر رئيسي غير قابل للحساب بسبب المدخلات — صحّح المدخلات أعلاه.', 'A headline metric cannot be computed from the current inputs — correct the inputs above.'],
  OUTPUT_IMPLAUSIBLE_IRR: ['العائد المحسوب خارج النطاق المعقول — غالبًا حقوق ملكية صفرية أو مدخل خاطئ.', 'The computed return is outside the plausible range — usually zero equity or a wrong input.'],
  OUTPUT_VERY_HIGH_IRR: ['العائد المحسوب مرتفع جدًا — راجع الافتراضات.', 'The computed return is very high — review the assumptions.'],
  OUTPUT_NOT_AN_OBJECT: ['تعذّر احتساب النتائج.', 'Results could not be computed.'],
};

const COLORS = { bad: 'var(--bad,#c23b5b)', warn: 'var(--gold,#c98a2e)', good: 'var(--good,#1fa67e)', na: 'var(--ink-faint,#9aa3b2)' };

export function renderAlertCenter(core, model, rec, d) {
  const T = (a, e) => (typeof core.T === 'function' ? core.T(a, e) : a);
  const esc = (x) => (typeof core.esc === 'function' ? core.esc(String(x)) : String(x));
  const canEdit = rec && typeof core.canEditOpp === 'function' ? !!core.canEditOpp(rec) : false;
  const level = model.status === 'ERROR' || model.status === STATUS.INVALID || model.status === STATUS.INCOMPLETE ? 'bad'
    : model.status === STATUS.WARNINGS || model.highRisk.flag ? 'warn' : 'good';
  const chipText = model.status === 'ERROR' ? T('تعذّر التحقق', 'Validation failed')
    : model.status === STATUS.INVALID ? T('مدخلات غير صالحة', 'Invalid inputs')
      : model.status === STATUS.INCOMPLETE ? T('مدخلات ناقصة', 'Incomplete inputs')
        : model.highRisk.flag ? T('عالية المخاطر', 'High risk')
          : model.status === STATUS.WARNINGS ? T('تنبيهات للمراجعة', 'Notices to review') : T('لا تنبيهات', 'No alerts');

  const counter = (n, ar, en, lvl) => `<div class="ac-counter" data-ac-counter="${esc(lvl)}" style="background:${n ? COLORS[lvl] + '1a' : 'rgba(31,166,126,.08)'};border-color:${n ? COLORS[lvl] : 'transparent'}">
      <b style="color:${n ? COLORS[lvl] : COLORS.good}">${n}</b><span>${esc(T(ar, en))}</span></div>`;

  const risk = model.highRisk.flag ? `<div class="ac-risk" data-ac-high-risk="1" role="alert">
      <h4>⚠️ ${T('تنبيه: فرصة عالية المخاطر', 'Alert: High-risk opportunity')}</h4>
      <ul>${model.highRisk.reasons.map((r) => `<li>${esc(T(r.ar, r.en))}</li>`).join('')}</ul>
      <div class="ac-meta" style="font-size:11px;margin-top:6px">${T('تنبيه فقط — لا يمنع الحفظ ولا الاعتماد.', 'Notice only — it does not block saving or approval.')}</div></div>` : '';

  const dims = `<div class="ac-dims">${model.dims.map((x) => `<div class="ac-dim ${esc(x.level)}" data-ac-dim="${esc(x.key)}">
      <small>${esc(T(x.ar, x.en))}</small><strong>${esc(T(x.headAr, x.headEn))}</strong><small>${esc(T(x.subAr, x.subEn))}</small></div>`).join('')}</div>`;

  const neutral = isBlockedStatus(model.status);
  function issueRow(i, lvl) {
    const isOut = neutral && typeof i.path === 'string' && i.path.startsWith('result.');
    const nm = isOut ? NEUTRAL_OUTPUT_MSG[i.code] : null;
    const hit = canEdit && d && !String(i.path || '').startsWith('result.') && typeof core.wizardStepForPath === 'function' ? core.wizardStepForPath(i.path, d) : null;
    const btn = hit ? `<button type="button" class="btn btn-sm" data-action="fix-field" data-id="${esc(rec.id)}" data-path="${esc(hit.path)}">${T('انتقل إلى الحقل', 'Go to field')}</button>` : '';
    const hint = i.hintAr ? `<div class="ac-meta">${esc(T(i.hintAr, i.hintEn))}</div>` : '';
    const rawV = i.value === null || i.value === undefined ? '' : String(i.value);
    const shownV = /^-?(NaN|Infinity)$/.test(rawV) ? T('غير رقمي', 'not a number') : rawV;
    const val = isOut || rawV === '' ? '' : ` = <bdi dir="ltr">${esc(shownV)}</bdi>`;
    return `<div class="ac-issue ${lvl}" data-validation-code="${esc(i.code)}" data-validation-path="${esc(i.path)}">
      <div><div class="ac-msg">${esc(nm ? T(nm[0], nm[1]) : T(i.messageAr, i.messageEn))}</div>${hint}${isOut ? '' : `<div class="ac-meta"><code>${esc(i.path)}</code>${val} · <code>${esc(i.code)}</code></div>`}</div>${btn}</div>`;
  }
  const group = (title, list, lvl) => list.length ? `<h4 style="margin:10px 0 6px;font-size:13px">${esc(title)} (${list.length})</h4><div class="ac-issues">${list.map((i) => issueRow(i, lvl)).join('')}</div>` : '';

  const body = model.status === 'ERROR'
    ? `<div class="ac-issue bad" data-validation-panel="ERROR"><div><div class="ac-msg">${T('تعذّر تشغيل التحقق من المدخلات؛ النتائج غير معتمدة.', 'Input validation could not run; results are not approved.')}</div><div class="ac-meta">${esc(model.validationError)}</div></div></div>`
    : (model.counts.errors + model.counts.incomplete + model.counts.warnings === 0
      ? `<div class="ac-ok">✓ ${T('المدخلات سليمة ولا توجد تنبيهات.', 'Inputs are valid and there are no alerts.')}</div>`
      : group(T('أخطاء تمنع الاعتماد', 'Errors that block approval'), model.issues.blocking, 'bad')
        + group(T('مدخلات ناقصة تمنع الاعتماد', 'Incomplete inputs that block approval'), model.issues.incomplete, 'bad')
        + group(T('تنبيهات للمراجعة (لا تمنع الاعتماد)', 'Notices to review (do not block approval)'), model.issues.warnings, 'warn'));

  return `${STYLE}<div class="alert-center" data-alert-center="${esc(model.status)}" data-validation-panel="${esc(model.status)}">
    <div class="ac-head"><span style="font-size:22px">🚨</span><h3>${T('مركز التنبيهات', 'Alert center')}</h3>
      <span class="ac-chip" style="background:${COLORS[level]}">${esc(chipText)}</span></div>
    <div class="ac-counters">
      ${counter(model.counts.errors, 'أخطاء', 'Errors', 'bad')}
      ${counter(model.counts.incomplete, 'نواقص', 'Incomplete', 'warn')}
      ${counter(model.counts.warnings, 'تنبيهات', 'Notices', 'warn')}
    </div>
    ${risk}${dims}${body}</div>`;
}

export function registerAlertCenter(core) {
  core.registerMemoTopSection((d, c, rec) => {
    const model = buildAlertModel(core, d, c);
    return renderAlertCenter(core, model, rec, d);
  });
}
