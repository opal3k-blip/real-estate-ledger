#!/usr/bin/env node
/* اختبار وحدة (unit test) للمنطق الصرف داخل underwriting-version-audit.cjs — بلا لمس Admin SDK
   ولا أي بيانات حقيقية. يُشغَّل من جذر المستودع أو من داخل functions/scripts مباشرة:
     node functions/scripts/underwriting-version-audit.unit-test.cjs
   يستورد عبر مسار نسبي (require('./underwriting-version-audit.cjs')) — يعمل من أي نسخة من
   المستودع (لا مسار مطلق خاص بأي بيئة تشغيل)، ولا يحتاج أي مجلد/تجهيز خارجي غير مرفق.

   تصحيح على مراجعة خارجية ثانية (بعد الإصلاح الأول لهذا الملف):
   ١) الاختبار السابق كان يستورد عبر مسار مطلق خاص بحاوية الوكيل السحابية — هنا الآن مسار نسبي
      صالح لأي نسخة من المستودع.
   ٢) اختبار "قرار بلا نسخة" كان يعيد كتابة منطق الفرز بنفسه داخل ملف الاختبار، فلا يثبت أن
      السكربت الفعلي ينفّذ هذا الجزء — هنا يستدعي findDecisionsWithoutVersion المُصدَّرة من
      الملف الحقيقي نفسه (استُخرجت كدالة صرفة مستقلة لهذا الغرض بالضبط). نفس الأمر لـ
      findDuplicateVersionsForSameDecision وfindDecisionsMissingEvaluationMetrics. */
'use strict';
const {
  buildV4Record, numbersDiffer, COMPARABLE_METRIC_FIELDS,
  findDuplicateVersionsForSameDecision, findDecisionsMissingEvaluationMetrics, findDecisionsWithoutVersion,
} = require('./underwriting-version-audit.cjs');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`✅ ${name}`); } else { failures++; console.log(`❌ ${name}`); }
}

// ========== الحالة ١: سيناريو المراجع بالضبط — عائد 15% (قرار) مقابل 999% (نسخة) ==========
{
  const icDecisions = {
    'dec-1': { oppId: 'opp-1', decision: { decision: 'approve' }, evaluation: { metrics: { equityIRR: 0.15, projectIRR: 0.12, MOIC: 1.4, dscrMin: 1.2 }, inputHash: 'hash-A' } },
  };
  const v = { oppId: 'opp-1', sourceDecisionId: 'dec-1', stage: 'v4_ic_approved', metrics: { equityIRR: 9.99, projectIRR: 5.0, MOIC: 9.9, dscrMin: 0.1 } };
  const rec = buildV4Record('UWV-dec-1', v, icDecisions);
  check('سيناريو المراجع: classification لا يحتوي "ok"', !rec.classification.includes('ok'));
  check('سيناريو المراجع: classification يحتوي metricsMismatch', rec.classification.includes('metricsMismatch'));
  check('metricsFullyVerified === false', rec.verification.metricsFullyVerified === false);
}

// ========== الحالة ٢: تطابق حقيقي كامل ==========
{
  const icDecisions = { 'dec-2': { oppId: 'opp-2', decision: { decision: 'approve_conditions' }, evaluation: { metrics: { equityIRR: 0.18, projectIRR: 0.14, MOIC: 1.6, dscrMin: 1.3 }, inputHash: 'hash-B' } } };
  const v = { oppId: 'opp-2', sourceDecisionId: 'dec-2', stage: 'v4_ic_approved', metrics: { equityIRR: 0.18, projectIRR: 0.14, MOIC: 1.6, dscrMin: 1.3 }, inputHash: 'hash-B' };
  const rec = buildV4Record('UWV-dec-2', v, icDecisions);
  check('تطابق حقيقي كامل: classification === ["ok"]', rec.classification.length === 1 && rec.classification[0] === 'ok');
  check('metricsFullyVerified === true', rec.verification.metricsFullyVerified === true);
}

// ========== الحالة ٣: فجوة أدلة كاملة (v.metrics غائب كلياً) ==========
{
  const icDecisions = { 'dec-3': { oppId: 'opp-3', decision: { decision: 'approve' }, evaluation: { metrics: { equityIRR: 0.2, projectIRR: 0.15, MOIC: 1.5, dscrMin: 1.1 } } } };
  const v = { oppId: 'opp-3', sourceDecisionId: 'dec-3', stage: 'v4_ic_approved' };
  const rec = buildV4Record('UWV-dec-3', v, icDecisions);
  check('فجوة أدلة كاملة: metricsUnverifiable لا ok', rec.classification.includes('metricsUnverifiable'));
  check('لا metricsMismatch خطأً', !rec.classification.includes('metricsMismatch'));
}

// ========== الحالة ٤: فجوة أدلة جزئية (حقل حقيقي مفقود — المفتاح غائب أصلاً، لا null) ==========
{
  const icDecisions = { 'dec-4': { oppId: 'opp-4', decision: { decision: 'approve' }, evaluation: { metrics: { equityIRR: 0.2, projectIRR: 0.15, MOIC: 1.5, dscrMin: 1.1 } } } };
  const v = { oppId: 'opp-4', sourceDecisionId: 'dec-4', stage: 'v4_ic_approved', metrics: { equityIRR: 0.2, projectIRR: 0.15 } }; // MOIC/dscrMin غائبان كمفتاح أصلاً
  const rec = buildV4Record('UWV-dec-4', v, icDecisions);
  check('فجوة أدلة جزئية: metricsPartiallyUnverifiable', rec.classification.includes('metricsPartiallyUnverifiable'));
  check('الحقلان المفقودان reason=missingField', rec.verification.metricsComparison.MOIC.reason === 'missingField' && rec.verification.metricsComparison.dscrMin.reason === 'missingField');
}

// ========== الحالة ٥: dscrMin:null صريحة على الطرفين معاً — يجب أن تُعامَل كتطابق حقيقي، لا فجوة أدلة ==========
// (هذا هو الإصلاح على المراجعة الخارجية الثانية — السلوك القديم كان يصنّف هذا metricsPartiallyUnverifiable خطأً)
{
  const icDecisions = { 'dec-5': { oppId: 'opp-5', decision: { decision: 'approve' }, evaluation: { metrics: { equityIRR: 0.2, projectIRR: 0.15, MOIC: 1.5, dscrMin: null } } } };
  const v = { oppId: 'opp-5', sourceDecisionId: 'dec-5', stage: 'v4_ic_approved', metrics: { equityIRR: 0.2, projectIRR: 0.15, MOIC: 1.5, dscrMin: null } };
  const rec = buildV4Record('UWV-dec-5', v, icDecisions);
  check('dscrMin:null على الطرفين: classification === ["ok"] (لا metricsPartiallyUnverifiable)', rec.classification.length === 1 && rec.classification[0] === 'ok');
  check('metricsFullyVerified === true', rec.verification.metricsFullyVerified === true);
  check('dscrMin.match === true وreason=bothExplicitlyNotApplicable', rec.verification.metricsComparison.dscrMin.match === true && rec.verification.metricsComparison.dscrMin.reason === 'bothExplicitlyNotApplicable');
}

// ========== الحالة ٦: dscrMin:null على القرار، لكن رقم فعلي على النسخة — اختلاف حقيقي مؤكَّد (لا فجوة أدلة) ==========
{
  const icDecisions = { 'dec-6': { oppId: 'opp-6', decision: { decision: 'approve' }, evaluation: { metrics: { equityIRR: 0.2, projectIRR: 0.15, MOIC: 1.5, dscrMin: null } } } };
  const v = { oppId: 'opp-6', sourceDecisionId: 'dec-6', stage: 'v4_ic_approved', metrics: { equityIRR: 0.2, projectIRR: 0.15, MOIC: 1.5, dscrMin: 1.2 } };
  const rec = buildV4Record('UWV-dec-6', v, icDecisions);
  check('null مقابل رقم فعلي: metricsMismatch صريحة (ليس unverifiable)', rec.classification.includes('metricsMismatch'));
  check('dscrMin.match === false وreason=nullVsNumberMismatch', rec.verification.metricsComparison.dscrMin.match === false && rec.verification.metricsComparison.dscrMin.reason === 'nullVsNumberMismatch');
}

// ========== الحالة ٧: اختلاف inputHash حقيقي مع تطابق المقاييس ==========
{
  const icDecisions = { 'dec-7': { oppId: 'opp-7', decision: { decision: 'approve' }, evaluation: { metrics: { equityIRR: 0.2, projectIRR: 0.15, MOIC: 1.5, dscrMin: 1.1 }, inputHash: 'hash-X' } } };
  const v = { oppId: 'opp-7', sourceDecisionId: 'dec-7', stage: 'v4_ic_approved', metrics: { equityIRR: 0.2, projectIRR: 0.15, MOIC: 1.5, dscrMin: 1.1 }, inputHash: 'hash-Y' };
  const rec = buildV4Record('UWV-dec-7', v, icDecisions);
  check('اختلاف inputHash حقيقي: inputHashMismatch', rec.classification.includes('inputHashMismatch'));
  check('المقاييس نفسها متطابقة: metricsFullyVerified === true', rec.verification.metricsFullyVerified === true);
}

// ========== الحالة ٨: findDecisionsWithoutVersion — استدعاء الدالة الفعلية المُصدَّرة، لا نسخة معاد كتابتها ==========
{
  const icDecisions = {
    'dec-8': { oppId: 'opp-8', decision: { decision: 'approve' }, evaluation: { metrics: { equityIRR: 0.1, projectIRR: 0.1, MOIC: 1.1, dscrMin: 1.0 } } },
    'dec-9': { oppId: 'opp-9', decision: { decision: 'reject' } },
  };
  const v4Records = []; // لا نسخ v4 أصلاً في هذا الاختبار
  const result = findDecisionsWithoutVersion(icDecisions, v4Records);
  check('findDecisionsWithoutVersion (الدالة الحقيقية): dec-8 يظهر', result.some((r) => r.decisionId === 'dec-8'));
  check('findDecisionsWithoutVersion (الدالة الحقيقية): dec-9 (مرفوض) لا يظهر', !result.some((r) => r.decisionId === 'dec-9'));
}

// ========== الحالة ٩: findDuplicateVersionsForSameDecision + findDecisionsMissingEvaluationMetrics (الدوال الحقيقية) ==========
{
  const v4Records = [
    { versionId: 'UWV-a', sourceDecisionId: 'dec-10', classification: ['ok'] },
    { versionId: 'UWV-a-dup', sourceDecisionId: 'dec-10', classification: ['ok'] },
  ];
  const dup = findDuplicateVersionsForSameDecision(v4Records);
  check('findDuplicateVersionsForSameDecision: يكتشف التكرار', dup.length === 1 && dup[0].sourceDecisionId === 'dec-10' && dup[0].count === 2);

  const icDecisions = { 'dec-11': { oppId: 'opp-11', decision: { decision: 'approve' } } }; // بلا evaluation.metrics إطلاقاً
  const missing = findDecisionsMissingEvaluationMetrics(icDecisions);
  check('findDecisionsMissingEvaluationMetrics: يكتشف الغياب', missing.some((r) => r.decisionId === 'dec-11'));
}

console.log('');
if (failures === 0) {
  console.log('== النتيجة: 0 فشل — بما فيها إصلاح null الصريحة مقابل الحقل الغائب، وجميع الدوال المختبَرة هي الدوال الحقيقية المُصدَّرة من السكربت نفسه. ==');
  process.exit(0);
} else {
  console.log(`== النتيجة: ${failures} حالة فشلت. ==`);
  process.exit(1);
}
