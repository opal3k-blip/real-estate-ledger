#!/usr/bin/env node
/* =========================================================================
   سكربت تدقيق للقراءة فقط — Phase 2R-4E، بند ٧ من رسالة الموافقة ("وسّع تقرير التدقيق قليلاً")
   ---------------------------------------------------------------------------
   لا يُعدِّل أي بيانات إطلاقاً (لا write، لا update، لا delete) — فقط يقرأ underwritingVersions
   وicDecisions وopportunities ويقارن بينها. يفحص بالضبط سجلات v4_ic_approved (اللقطات اليدوية
   manual لا تحمل sourceDecisionId أصلاً، فلا معنى لفحص ارتباطها بقرار — تُذكَر في totals فقط
   للسياق العام).

   السياق: قبل Phase 2R-4E، كانت لقطة v4_ic_approved تُكتَب من العميل (ic-workflow.js) بمعزل زمني
   تام عن اللحظة الفعلية لحساب الخادم عند اتخاذ القرار — سجلات قديمة (قبل هذه المرحلة) قد تحمل
   metrics/thesisSnapshot لم تُحسَب فعلياً من نفس evaluated.audit المخزَّن في icDecisions المرتبط،
   ولا تحمل حقلي inputHash/engineVersion على وثيقة النسخة نفسها إطلاقاً (أُضيفا فقط من هذه المرحلة
   فصاعداً). هذا السكربت **لا يفترض** أن غياب دليل يعني تطابقاً أو اختلافاً — أي فجوة أدلة (سجل
   قديم بلا inputHash على النسخة نفسها للمقارنة، مثلاً) تُصنَّف "غير قابل للتحقق" بصريح النص، لا
   "متطابق" ولا "مختلف".

   الفحوصات (بند ٧ بالضبط):
     ١) نسخة v4_ic_approved تشير إلى قرار (sourceDecisionId) غير موجود إطلاقاً في icDecisions.
     ٢) نسخة v4_ic_approved مرتبطة بقرار فعلاً، لكن ذلك القرار يخص فرصة (oppId) مختلفة عن الفرصة
        المذكورة على النسخة نفسها.
     ٣) نسخة v4_ic_approved مرتبطة بقرار فعلاً ولنفس الفرصة، لكن القرار نفسه ليس اعتماداً
        (decision.decision ليست 'approve' ولا 'approve_conditions').
     ٤) سجلات icDecisions من نوع اعتماد (approve/approve_conditions) تفتقد evaluation.metrics
        بالكامل (سجلات قبل P0 — Trusted Transaction Layer، أو أي كتابة يدوية سابقة عبر Admin SDK
        بلا هذا الحقل) — هذه القرارات، لو ارتبطت بها نسخة v4، لا يمكن التحقق من تطابق metrics
        النسخة معها إطلاقاً (فجوة أدلة، لا اختلاف مؤكَّد).
     +) فحصان إضافيان لا يغيّران التصنيف الأساسي، بروح "قد يفيد المراجعة البشرية" فقط:
        - تطابق inputHash المخزَّن على النسخة نفسها (إن وُجد — فقط سجلات هذه المرحلة فصاعداً) مع
          inputHash المخزَّن على القرار المرتبط — أي اختلاف هنا (لو وُجد الحقلان معاً) يعني تلفاً
          حقيقياً محتملاً، لا مجرَّد فجوة أدلة، فيُصنَّف mismatch فعلياً لا unverifiable.
        - أكثر من نسخة v4 واحدة تشير لنفس sourceDecisionId (لا ينبغي أن يحدث بعد هذه المرحلة —
          معرّف النسخة الجديد حتمي UWV-<decisionId> — لكن سجلات قديمة عشوائية المعرّف قد تتكرر).

   الاستخدام (من جذر المستودع):
     node functions/scripts/underwriting-version-audit.cjs --project <PROJECT_ID>
     node functions/scripts/underwriting-version-audit.cjs --project <PROJECT_ID> --out report.json
   (من داخل functions/: node scripts/underwriting-version-audit.cjs --project <PROJECT_ID>)

   --project إلزامي عمداً — لا افتراض ولا مشروع افتراضي صامت (نفس نمط legacy-inkind-audit.cjs
   بالضبط). راجع .firebaserc لمعرفة المشروع الافتراضي المُعرَّف لهذا المستودع وتأكد أنه المقصود
   فعلاً قبل أي تشغيل على بيانات حقيقية — ⚠️ لا تُشغِّله على مشروع الإنتاج الحقيقي دون تحديد
   المشروع صراحةً هنا وموافقة صريحة مسبقة من مالك المشروع، بالضبط كما طلب المستخدم (بند ٧).

   الاعتماد (Credentials) — نفس تنبيه legacy-inkind-audit.cjs بالضبط: firebase login وحده لا يكفي؛
   يلزم GOOGLE_APPLICATION_CREDENTIALS يشير لملف مفتاح حساب خدمة له صلاحية قراءة Firestore على
   المشروع المستهدف، أو تشغيل gcloud auth application-default login بحساب له تلك الصلاحية.
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

// ملاحظة اختبارية (إصلاح بند ١ من مراجعة 4E): كل ما تحته حتى سطر "db = getFirestore()" هو كود
// تنفيذ السكربت الحقيقي (يتحقق من --project، يهيّئ Admin SDK، يخرج العملية عند الخطأ) — يبقى كما
// كان بالضبط، لكنه الآن مؤجَّل إلى داخل `if (require.main === module)` في أسفل الملف، بدل أن
// يُنفَّذ فوراً عند require(). هذا يسمح باختبار buildV4Record/numbersDiffer وحدها (unit test) من
// سكربت خارجي عبر require() دون تشغيل Admin SDK أو process.exit() إطلاقاً — لا تغيير في سلوك
// التشغيل المباشر (node ... --project ...)، فقط فُصل التعريف عن التنفيذ.
function argOrEnv(flag, envName) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[envName] || null;
}

let db; // تُعيَّن فقط عند التشغيل المباشر (داخل require.main===module أدناه)؛ غير مستخدَمة في وضع الاختبار

async function fetchAll(coll) {
  const snap = await db.collection(coll).get();
  const out = {};
  snap.forEach((doc) => { out[doc.id] = doc.data() || {}; });
  return out;
}

const UNVERIFIABLE = 'غير قابل للتحقق (unverifiable) — لا دليل كافٍ، لا يُفسَّر كتطابق ولا كاختلاف';

// المقاييس الأربعة المنسوخة فعلياً من evaluated.audit.metrics إلى النسخة عند approveOpportunity
// (functions/index.js) — وحدها قابلة للمقارنة المباشرة بين النسخة والقرار؛ price مستثنى عمداً
// لأن مصدره opp.land.price وقت القرار، ولا يوجد نظير له مخزَّن على icDecisions للمقارنة.
const COMPARABLE_METRIC_FIELDS = ['equityIRR', 'projectIRR', 'MOIC', 'dscrMin'];
const METRIC_EPSILON = 1e-9; // يتجاوز ضجيج الفاصلة العائمة البحت فقط، لا يخفي أي اختلاف حقيقي

function numbersDiffer(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !isFinite(a) || !isFinite(b)) return true;
  return Math.abs(a - b) > METRIC_EPSILON;
}

function buildV4Record(versionId, v, icDecisions) {
  const sourceId = v.sourceDecisionId;
  const hasSourceId = typeof sourceId === 'string' && sourceId.trim();
  const decisionDoc = hasSourceId ? icDecisions[sourceId] : null;
  const decisionExists = !!decisionDoc;
  const flags = [];

  if (!hasSourceId || !decisionExists) {
    flags.push('missingDecisionReference');
  } else {
    const decisionOppId = decisionDoc.oppId;
    const sameOpp = decisionOppId === v.oppId;
    if (!sameOpp) flags.push('differentOpportunityReference');
    const decisionType = decisionDoc.decision && decisionDoc.decision.decision;
    const isApproved = decisionType === 'approve' || decisionType === 'approve_conditions';
    if (sameOpp && !isApproved) flags.push('unapprovedDecisionReference');
  }

  // evaluation.metrics على القرار المرتبط نفسه — لا على النسخة (metrics على النسخة نفسها هي لقطة
  // منسوخة، evaluation.metrics على icDecisions هو "الحقيقة" التي نُسخت منها، منذ Phase 2R-4E).
  const decisionHasEvaluationMetrics = !!(decisionExists && decisionDoc.evaluation && decisionDoc.evaluation.metrics);
  if (decisionExists && !decisionHasEvaluationMetrics) flags.push('decisionMissingEvaluationMetrics');

  // مقارنة مباشرة للمقاييس الأربعة — هذا هو الفحص الذي كان غائباً تماماً: الاعتماد على تطابق
  // inputHash وحده (أدناه) لا يكتشف شيئاً إطلاقاً لأي سجل لا يحمل الحقلين معاً (كل السجلات قبل
  // هذه المرحلة، وأي سجل لحق خطأ لاحقاً)، فكان قرار عائده 15% ونسخة عائدها 999% يُصنَّف "ok" بصمت.
  // الآن: كل حقل من الأربعة موجود على *كلا* الوثيقتين يُقارَن رقمياً مباشرة، بصرف النظر عن inputHash.
  //
  // إصلاح إضافي (مراجعة خارجية ثانية على هذا الإصلاح نفسه): null صريحة محفوظة عمداً (مثلاً
  // dscrMin:null لفرصة بلا شريحة دين أصلاً — قيمة شرعية "غير منطبق"، ليست نقصاً في البيانات) لا
  // يجوز أن تُعامَل كفجوة أدلة بنفس معاملة الحقل الغائب كلياً (مفتاح غير موجود أصلاً على الوثيقة،
  // وهو فجوة أدلة حقيقية لأننا لا نعرف لو كانت ستساوي عدداً أو null لو حُسبت). الفرق جوهري:
  //   • missing (المفتاح غائب أصلاً): فجوة أدلة حقيقية — لا نخمّن.
  //   • explicitNull (محفوظة صراحة null): قيمة شرعية؛ null على الطرفين معاً = تطابق حقيقي (كلاهما
  //     "غير منطبق")، لا فجوة أدلة ولا حتى تحتاج تخمين deref؛ null على طرف مقابل رقم فعلي على
  //     الآخر = اختلاف **حقيقي مؤكَّد** (أحدهما يقول "غير منطبق" والآخر يحمل قيمة فعلية) — ليس
  //     فجوة أدلة، بل اختلاف فعلي يستحق flag mismatch بالضبط كاختلاف رقمي.
  //   • number: المقارنة العددية المعتادة (numbersDiffer).
  function fieldState(obj, field) {
    if (obj == null || !Object.prototype.hasOwnProperty.call(obj, field)) return { kind: 'missing', value: undefined };
    const val = obj[field];
    if (val === null) return { kind: 'explicitNull', value: null };
    if (typeof val === 'number' && isFinite(val)) return { kind: 'number', value: val };
    return { kind: 'other', value: val }; // نوع غير متوقَّع (نص/NaN/...) — فجوة أدلة أيضاً، لا تخمين
  }
  const metricsComparison = {};
  const mismatchedFields = [];
  const comparableFields = [];
  if (decisionExists && decisionHasEvaluationMetrics && v.metrics) {
    COMPARABLE_METRIC_FIELDS.forEach((field) => {
      const vState = fieldState(v.metrics, field);
      const dState = fieldState(decisionDoc.evaluation.metrics, field);

      if (vState.kind === 'missing' || dState.kind === 'missing' || vState.kind === 'other' || dState.kind === 'other') {
        metricsComparison[field] = {
          versionValue: vState.kind === 'explicitNull' ? null : (vState.kind === 'missing' ? undefined : vState.value),
          decisionValue: dState.kind === 'explicitNull' ? null : (dState.kind === 'missing' ? undefined : dState.value),
          comparable: false,
          reason: (vState.kind === 'missing' || dState.kind === 'missing') ? 'missingField' : 'unsupportedValueType',
        };
        return;
      }

      if (vState.kind === 'explicitNull' && dState.kind === 'explicitNull') {
        // كلاهما "غير منطبق" صراحة — تطابق حقيقي (مثلاً: لا شريحة دين على هذه الفرصة إطلاقاً).
        comparableFields.push(field);
        metricsComparison[field] = { versionValue: null, decisionValue: null, comparable: true, match: true, reason: 'bothExplicitlyNotApplicable' };
        return;
      }

      if (vState.kind === 'explicitNull' || dState.kind === 'explicitNull') {
        // أحد الطرفين "غير منطبق" صراحة والآخر رقم فعلي — اختلاف حقيقي مؤكَّد، لا فجوة أدلة.
        comparableFields.push(field);
        mismatchedFields.push(field);
        metricsComparison[field] = {
          versionValue: vState.kind === 'explicitNull' ? null : vState.value,
          decisionValue: dState.kind === 'explicitNull' ? null : dState.value,
          comparable: true, match: false, reason: 'nullVsNumberMismatch',
        };
        return;
      }

      // كلاهما رقم فعلي — المقارنة العددية المعتادة.
      comparableFields.push(field);
      const differs = numbersDiffer(vState.value, dState.value);
      metricsComparison[field] = { versionValue: vState.value, decisionValue: dState.value, comparable: true, match: !differs };
      if (differs) mismatchedFields.push(field);
    });
  }
  if (mismatchedFields.length > 0) {
    // اختلاف مؤكَّد في قيمة فعلية — ليس فجوة أدلة، هذا هو الخلل الذي فاتنا سابقاً.
    flags.push('metricsMismatch');
  } else if (decisionExists && decisionHasEvaluationMetrics && comparableFields.length < COMPARABLE_METRIC_FIELDS.length) {
    // لم نستطع مقارنة كل الأربعة (حقل مفقود على أحد الطرفين) — فجوة أدلة حقيقية، يجب أن تظهر في
    // التصنيف العام نفسه، لا تبقى صامتة بينما classification تقول 'ok'.
    flags.push(comparableFields.length === 0 ? 'metricsUnverifiable' : 'metricsPartiallyUnverifiable');
  }

  // مطابقة inputHash — فحص إضافي تكميلي (ليس بديلاً عن المقارنة المباشرة أعلاه)، فقط إن وُجد الحقل
  // على *كلا* الوثيقتين (سجلات هذه المرحلة فصاعداً على النسخة نفسها). غياب inputHash على النسخة
  // (سجل قديم قبل هذه المرحلة) هو فجوة أدلة لهذا الفحص بعينه، لا اختلاف — ولا يُسقِط قيمة المقارنة
  // المباشرة للمقاييس أعلاه، التي تبقى الفحص الأساسي والحاسم.
  let inputHashCheck = UNVERIFIABLE;
  if (v.inputHash != null && decisionExists && decisionDoc.evaluation && decisionDoc.evaluation.inputHash != null) {
    inputHashCheck = (v.inputHash === decisionDoc.evaluation.inputHash) ? 'match' : 'mismatch';
    if (inputHashCheck === 'mismatch') flags.push('inputHashMismatch');
  }

  return {
    versionId,
    oppId: v.oppId || null,
    sourceDecisionId: hasSourceId ? sourceId : null,
    savedBy: v.savedBy || null,
    savedAt: v.savedAt || null,
    classification: flags.length ? flags : ['ok'],
    verification: {
      decisionReferenceExists: decisionExists,
      decisionOppIdMatches: decisionExists ? (decisionDoc.oppId === v.oppId) : null,
      decisionIsApproved: decisionExists
        ? (decisionDoc.decision && (decisionDoc.decision.decision === 'approve' || decisionDoc.decision.decision === 'approve_conditions'))
        : null,
      decisionHasEvaluationMetrics,
      metricsComparison,
      metricsFullyVerified: comparableFields.length === COMPARABLE_METRIC_FIELDS.length && mismatchedFields.length === 0,
      inputHashOnVersionPresent: v.inputHash != null,
      inputHashComparison: inputHashCheck,
    },
  };
}

// --- ثلاث دوال صرفة إضافية (بلا أي أثر جانبي)، مستخرجة من داخل IIFE التشغيل الفعلي أدناه ---
// --- حصراً ليكون بالإمكان اختبارها مباشرة (نفس الكود المُشغَّل فعلياً، لا نسخة معاد كتابتها في
// --- ملف الاختبار) — إصلاح على مراجعة خارجية ثانية لاحظت أن اختبار "قرار بلا نسخة" كان يعيد كتابة
// --- منطق الفرز بنفسه بدل استدعاء السكربت الفعلي.

function findDuplicateVersionsForSameDecision(v4Records) {
  const byDecision = {};
  v4Records.filter((r) => r.sourceDecisionId).forEach((r) => {
    (byDecision[r.sourceDecisionId] = byDecision[r.sourceDecisionId] || []).push(r.versionId);
  });
  return Object.entries(byDecision)
    .filter(([, ids]) => ids.length > 1)
    .map(([sourceDecisionId, versionIds]) => ({ sourceDecisionId, count: versionIds.length, versionIds }));
}

function findDecisionsMissingEvaluationMetrics(icDecisions) {
  return Object.entries(icDecisions)
    .filter(([, d]) => {
      const type = d.decision && d.decision.decision;
      const isApproved = type === 'approve' || type === 'approve_conditions';
      return isApproved && !(d.evaluation && d.evaluation.metrics);
    })
    .map(([id, d]) => ({ decisionId: id, oppId: d.oppId || null, decision: (d.decision && d.decision.decision) || null, recordedBy: d.recordedBy || null }));
}

function findDecisionsWithoutVersion(icDecisions, v4Records) {
  const versionedDecisionIds = new Set(v4Records.filter((r) => r.sourceDecisionId).map((r) => r.sourceDecisionId));
  return Object.entries(icDecisions)
    .filter(([id, d]) => {
      const type = d.decision && d.decision.decision;
      const isApproved = type === 'approve' || type === 'approve_conditions';
      return isApproved && !versionedDecisionIds.has(id);
    })
    .map(([id, d]) => ({
      decisionId: id,
      oppId: d.oppId || null,
      decision: (d.decision && d.decision.decision) || null,
      recordedBy: d.recordedBy || null,
      recordedAt: d.recordedAt || null,
      hasEvaluationMetrics: !!(d.evaluation && d.evaluation.metrics),
    }));
}

// --- كل ما تحته هنا ينفَّذ فقط عند تشغيل الملف مباشرة (node ... --project ...)، لا عند require() ---
// --- (إصلاح بند ١ من مراجعة 4E: يسمح باختبار buildV4Record وحدها دون تهيئة Admin SDK) ---
if (require.main === module) {
(async () => {
  const projectId = argOrEnv('--project', 'FIRESTORE_AUDIT_PROJECT_ID');
  if (!projectId) {
    console.error([
      'خطأ: معرّف المشروع (--project) إلزامي — لا مشروع افتراضي صامت.',
      'الاستخدام: node functions/scripts/underwriting-version-audit.cjs --project <PROJECT_ID>',
      '(راجع .firebaserc لمعرفة المشروع الافتراضي المُعرَّف لهذا المستودع، وتأكد أنه المقصود فعلاً.)',
      '',
      'تنبيه: firebase login وحده لا يكفي — راجع رأس هذا الملف لشرح الاعتماد المطلوب (ADC).',
      'تنبيه إضافي (بند ٧ من موافقة Phase 2R-4E): لا تُشغِّل هذا على مشروع الإنتاج الحقيقي دون',
      'موافقة صريحة مسبقة من مالك المشروع على تحديداً هذا المشروع.',
    ].join('\n'));
    process.exit(1);
    return;
  }

  const { initializeApp, applicationDefault } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  try {
    initializeApp({ projectId, credential: applicationDefault() });
    db = getFirestore();
  } catch (e) {
    console.error('فشل تهيئة Admin SDK — راجع قسم "الاعتماد" في رأس هذا الملف (GOOGLE_APPLICATION_CREDENTIALS أو gcloud auth application-default login):', (e && e.message) || e);
    process.exit(1);
    return;
  }

  const [underwritingVersions, icDecisions] = await Promise.all([
    fetchAll('underwritingVersions'),
    fetchAll('icDecisions'),
  ]);

  const v4Entries = Object.entries(underwritingVersions).filter(([, v]) => v.stage === 'v4_ic_approved');
  const manualEntries = Object.entries(underwritingVersions).filter(([, v]) => v.stage === 'manual');
  const otherStageEntries = Object.entries(underwritingVersions).filter(([, v]) => v.stage !== 'v4_ic_approved' && v.stage !== 'manual');

  const v4Records = v4Entries.map(([id, v]) => buildV4Record(id, v, icDecisions));

  const missingDecisionReference = v4Records.filter((r) => r.classification.includes('missingDecisionReference'));
  const differentOpportunityReference = v4Records.filter((r) => r.classification.includes('differentOpportunityReference'));
  const unapprovedDecisionReference = v4Records.filter((r) => r.classification.includes('unapprovedDecisionReference'));
  const inputHashMismatch = v4Records.filter((r) => r.classification.includes('inputHashMismatch'));
  // الفحص الذي كان غائباً: اختلاف مؤكَّد في قيمة فعلية لأحد المقاييس الأربعة بين النسخة وقرارها —
  // هذا ما كان سيُصنَّف 'ok' خطأً قبل هذا الإصلاح (مثال الاختبار: عائد 15% مقابل 999%).
  const metricsMismatch = v4Records.filter((r) => r.classification.includes('metricsMismatch'));
  // فجوة أدلة حقيقية على المقارنة المباشرة نفسها (لا على inputHash) — يجب أن تظهر هنا، لا تبقى
  // صامتة داخل verification.metricsComparison بينما classification تقول 'ok'.
  const metricsUnverifiable = v4Records.filter((r) => r.classification.includes('metricsUnverifiable') || r.classification.includes('metricsPartiallyUnverifiable'));

  // أكثر من نسخة v4 واحدة لنفس sourceDecisionId — لا ينبغي أن يحدث لسجلات هذه المرحلة فصاعداً
  // (المعرّف الحتمي UWV-<decisionId> يمنعه بنيوياً)، لكن سجلات قديمة عشوائية المعرّف قد تتكرر.
  const duplicateVersionsForSameDecision = findDuplicateVersionsForSameDecision(v4Records);

  // قرارات اعتماد (approve/approve_conditions) في icDecisions بلا evaluation.metrics إطلاقاً —
  // بمعزل عن وجود نسخة v4 مرتبطة بها أصلاً (بند ٧: "السجلات التي تفتقد evaluation.metrics").
  const decisionsMissingEvaluationMetrics = findDecisionsMissingEvaluationMetrics(icDecisions);

  // قرارات اعتماد (approve/approve_conditions) لا توجد لها أي نسخة v4_ic_approved مرتبطة بها
  // إطلاقاً — كانت غائبة تماماً عن هذا السكربت قبل هذا الإصلاح. سبب شرعي محتمل (مثلاً: الطلب
  // سقط بين كتابة icDecisions وكتابة النسخة في معاملات ما قبل Phase 2R-4E، أو اعتماد مُسجَّل يدوياً
  // عبر Admin SDK بمعزل عن هذا المسار) — لكنه يستحق مراجعة بشرية في كل الحالات، فلا يجوز أن يبقى
  // غير مُقارَن بصمت فقط لأنه لا نسخة لمقارنتها بها أصلاً.
  const decisionsWithoutVersion = findDecisionsWithoutVersion(icDecisions, v4Records);

  const report = {
    generatedAt: new Date().toISOString(),
    projectId,
    unverifiableMeaning: UNVERIFIABLE,
    totals: {
      versionsScanned: Object.keys(underwritingVersions).length,
      v4Versions: v4Entries.length,
      manualVersions: manualEntries.length,
      otherStageVersions: otherStageEntries.length, // v1/v2/v3 — متروكة في الـbacklog، لم تُنشَأ أصلاً حسب مراجعة 2R-4E؛ عدد غير صفري هنا يستحق تحرياً بشرياً
      icDecisionsScanned: Object.keys(icDecisions).length,
      missingDecisionReference: missingDecisionReference.length,
      differentOpportunityReference: differentOpportunityReference.length,
      unapprovedDecisionReference: unapprovedDecisionReference.length,
      metricsMismatch: metricsMismatch.length,
      metricsUnverifiable: metricsUnverifiable.length,
      inputHashMismatch: inputHashMismatch.length,
      duplicateVersionsForSameDecisionGroups: duplicateVersionsForSameDecision.length,
      decisionsMissingEvaluationMetrics: decisionsMissingEvaluationMetrics.length,
      decisionsWithoutVersion: decisionsWithoutVersion.length,
    },
    v4Records,
    missingDecisionReference,
    differentOpportunityReference,
    unapprovedDecisionReference,
    metricsMismatch,
    metricsUnverifiable,
    inputHashMismatch,
    duplicateVersionsForSameDecision,
    decisionsMissingEvaluationMetrics,
    decisionsWithoutVersion,
  };

  console.log('== تدقيق underwritingVersions/icDecisions (للقراءة فقط — بلا أي تعديل) — Phase 2R-4E بند ٧ ==');
  console.log(`المشروع: ${projectId}`);
  console.log(`نسخ فُحصت: ${report.totals.versionsScanned} (v4: ${report.totals.v4Versions}، يدوية: ${report.totals.manualVersions}، مراحل أخرى v1/v2/v3: ${report.totals.otherStageVersions})`);
  console.log(`قرارات IC فُحصت: ${report.totals.icDecisionsScanned}`);
  console.log(`تشير لقرار مفقود: ${report.totals.missingDecisionReference}`);
  console.log(`تشير لفرصة مختلفة عن قرارها: ${report.totals.differentOpportunityReference}`);
  console.log(`تشير لقرار غير معتمَد: ${report.totals.unapprovedDecisionReference}`);
  console.log(`⚠️ اختلاف مؤكَّد في قيمة فعلية لأحد المقاييس الأربعة (equityIRR/projectIRR/MOIC/dscrMin): ${report.totals.metricsMismatch}`);
  console.log(`فجوة أدلة على مقارنة المقاييس نفسها (لا يمكن التحقق من بعض/كل الحقول): ${report.totals.metricsUnverifiable}`);
  console.log(`اختلاف inputHash مؤكَّد (فحص تكميلي، لا بديل عن مقارنة المقاييس أعلاه): ${report.totals.inputHashMismatch}`);
  console.log(`مجموعات تكرار (أكثر من نسخة واحدة لنفس القرار): ${report.totals.duplicateVersionsForSameDecisionGroups}`);
  console.log(`قرارات اعتماد بلا evaluation.metrics إطلاقاً: ${report.totals.decisionsMissingEvaluationMetrics}`);
  console.log(`قرارات اعتماد بلا أي نسخة v4 مرتبطة بها إطلاقاً: ${report.totals.decisionsWithoutVersion}`);
  console.log(`(تذكير: فجوة أدلة حقيقية تُدرَج الآن كتصنيف صريح (metricsUnverifiable/metricsPartiallyUnverifiable) لا تبقى صامتة بينما classification تقول 'ok'.)`);
  console.log('');

  function printSection(title, list) {
    if (list.length === 0) return;
    console.log(`-- ${title} --`);
    list.forEach((r) => console.log(JSON.stringify(r, null, 2)));
    console.log('');
  }

  printSection('تشير لقرار مفقود (تحتاج مراجعة يدوية بشرية — لا إجراء آلي هنا)', missingDecisionReference);
  printSection('تشير لفرصة مختلفة عن قرارها', differentOpportunityReference);
  printSection('تشير لقرار غير معتمَد', unapprovedDecisionReference);
  printSection('⚠️ اختلاف مؤكَّد في قيمة فعلية لأحد المقاييس الأربعة — يحتاج مراجعة فورية', metricsMismatch);
  printSection('فجوة أدلة على مقارنة المقاييس (لا تُفسَّر كتطابق)', metricsUnverifiable);
  printSection('اختلاف inputHash مؤكَّد بين النسخة وقرارها', inputHashMismatch);
  printSection('مجموعات تكرار (أكثر من نسخة واحدة لنفس القرار)', duplicateVersionsForSameDecision);
  printSection('قرارات اعتماد بلا evaluation.metrics إطلاقاً', decisionsMissingEvaluationMetrics);
  printSection('قرارات اعتماد بلا أي نسخة v4 مرتبطة بها إطلاقاً (تحتاج مراجعة يدوية)', decisionsWithoutVersion);

  if (report.totals.v4Versions === 0) {
    console.log('لا نسخ v4_ic_approved على الإطلاق.');
  }

  const outFlagIdx = process.argv.indexOf('--out');
  if (outFlagIdx !== -1 && process.argv[outFlagIdx + 1]) {
    const outPath = path.resolve(process.argv[outFlagIdx + 1]);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nتم حفظ تقرير كامل (JSON) محلياً في: ${outPath}`);
    console.log('تنبيه: هذا الملف يحتوي بيانات مالية حقيقية للمشروع — لا تُضِفه لأي مستودع عام ولا تشاركه خارجياً دون إذن صريح.');
  }

  process.exit(0);
})().catch((e) => {
  console.error('فشل التدقيق:', (e && e.stack) || e);
  process.exit(1);
});
} // end if (require.main === module)

// تصدير الدوال الصرفة فقط (بلا أي أثر جانبي) لاستخدامها في اختبار وحدة خارجي — لا تُصدَّر أي من
// fetchAll/db (تتطلب Admin SDK حقيقياً، ولا معنى لاختبارها هنا؛ الاختبار الحقيقي للقراءة من
// Firestore يبقى عبر Firestore Emulator في tests/rules، لا عبر هذا التصدير).
module.exports = {
  buildV4Record, numbersDiffer, COMPARABLE_METRIC_FIELDS, UNVERIFIABLE,
  findDuplicateVersionsForSameDecision, findDecisionsMissingEvaluationMetrics, findDecisionsWithoutVersion,
};
