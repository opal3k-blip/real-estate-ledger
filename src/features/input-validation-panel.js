/* =========================================================================
   لوحة التحقق من المدخلات (Phase 3A-2) — عرض + حارس مؤشرات
   ---------------------------------------------------------------------------
   يستهلك محرك التحقق (src/domain/validation/input-validation-engine.js) ولا يغيّر
   core.compute ولا Golden Master ولا أي حفظ:
   1) registerMetricGuard: عند حالة INVALID أو INCOMPLETE يستبدل core.js مؤشرات
      الربحية الرئيسية (Equity/Project IRR وMOIC) والحكم بشارة "غير معتمد" على الشاشة.
      التحذيرات (WARNINGS) لا تحجب شيئًا. إن فشل الحارس نفسه فالإخفاء هو الافتراضي
      (fail-closed): رقم لم يُتحقَّق منه لا يُعرض كأنه متحقَّق.
   2) registerAlertCenter (3A-2b): مركز التنبيهات أعلى المذكرة (بدل القسم السفلي القديم).
   عند الحجب تُعرض مذكرة مختصرة بلا أي رقم ربحية، وتُرفض عمليات التصدير.
   خارج التغطية (مُوثَّق): العروض العابرة للمحفظة (مركز الذكاء المؤسسي، كتاب IC، التنبيهات،
   سجل إصدارات الاكتتاب، مجاميع المحفظة).
   ========================================================================= */
import { validateOpportunity, STATUS } from '../domain/validation/input-validation-engine.js';
import { registerAlertCenter } from './alert-center.js';

/** نقي: يُرجع تقرير التحقق، ولا يرمي أبدًا (الفشل يُترجم إلى حالة خطأ صريحة). */
export function runValidation(d, c) {
  try {
    return { ok: true, report: validateOpportunity(d, c) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** نقي: قرار الحجب للحارس. */
export function guardDecision(d, c) {
  const v = runValidation(d, c);
  if (!v.ok) return { blocked: true, status: 'GUARD_ERROR' };
  const s = v.report.status;
  if (s === STATUS.INVALID || s === STATUS.INCOMPLETE) {
    return { blocked: true, status: s, count: v.report.blocking.length + v.report.incomplete.length };
  }
  return null;
}

export function registerInputValidationPanel(core) {
  core.registerMetricGuard((d, c) => guardDecision(d, c));

  registerAlertCenter(core);
}
