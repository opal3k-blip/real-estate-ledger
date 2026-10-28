#!/usr/bin/env node
/* =========================================================================
   سكربت تدقيق للقراءة فقط — Phase 2R-4D4-C، بند 4 (السجلات القديمة)
   ---------------------------------------------------------------------------
   لا يُعدِّل أي بيانات إطلاقاً (لا write، لا update، لا delete) — فقط يقرأ.

   تنبيه مهم حول التصنيف: وجود inKindAssetId على نداء رأس مال يعني فقط أن
   السجل *مرتبط بمرجع أصل* — هذا لا يُثبت أن نقل الملكية وُثِّق فعلياً ولا أن
   المرجع صحيح. لذلك هذا السكربت يفصل بين أمرين مختلفين تماماً:
     • التصنيف البنيوي (classification): "linkedToAsset" (inKindAssetId موجود)
       مقابل "missingAssetLink" (inKindAssetId غائب) — حقيقة بنيوية بحتة.
     • التحقق (verification): حقول منفصلة لكل سجل تفحص هل المرجع المذكور
       (الأصل، الالتزام) موجود فعلاً، هل نوع الالتزام in_kind فعلاً، هل السجل
       نفسه قيد عكسي (إصلاح لتنفيذ سابق، لا تنفيذ جديد)، وهل توجد ملاحظات —
       دون افتراض أن أياً من هذا يُثبت التوثيق الفعلي لنقل الملكية.
   كما يفحص السكربت: مراجع مفقودة (inKindAssetId أو linkedCommitmentId يشير
   لمستند غير موجود)، وتكرارات (أكثر من نداء رأس مال واحد مرتبط بنفس
   linkedCommitmentId — يجب أن يكون واحداً فقط عادة)، وقيوداً عكسية (سجلات
   تمثّل تصحيحاً لتنفيذ سابق، تُعرَض بشكل منفصل لا ضمن "تنفيذ جديد غير موثَّق").
   لا يخمِّن ولا يقترح أي أصل مطابق لأي سجل — يعرض الحقائق الخام فقط للمراجعة
   البشرية.

   الاستخدام (من جذر المستودع):
     node functions/scripts/legacy-inkind-audit.cjs --project <PROJECT_ID>
     node functions/scripts/legacy-inkind-audit.cjs --project <PROJECT_ID> --out report.json
   (من داخل functions/: node scripts/legacy-inkind-audit.cjs --project <PROJECT_ID>)

   --project إلزامي عمداً — لا افتراض ولا مشروع افتراضي صامت. راجع
   .firebaserc لمعرفة المشروع الافتراضي المُعرَّف لهذا المستودع
   (real-estate-ledger-f85a6 وقت كتابة هذا) وتأكد أنه المقصود فعلاً قبل أي
   تشغيل على بيانات حقيقية — لا تُشغِّله على بيانات حقيقية قبل مراجعة هذا
   السكربت وتحديد المشروع المستهدف صراحةً.

   الاعتماد (Credentials) — تنبيه: تسجيل الدخول عبر firebase login (المستخدَم
   لنشر functions/index.js عبر firebase deploy) هو اعتماد لأداة Firebase CLI
   نفسها فقط، ولا يوفِّر تلقائياً Application Default Credentials (ADC) التي
   يحتاجها Admin SDK هنا. يلزم أحد التاليين على هذا الجهاز قبل التشغيل الفعلي:
     • GOOGLE_APPLICATION_CREDENTIALS يشير لملف مفتاح حساب خدمة (service
       account JSON) له صلاحية قراءة Firestore على المشروع المستهدف، أو
     • تشغيل gcloud auth application-default login بحساب له تلك الصلاحية على
       المشروع المستهدف تحديداً.
   بدون أحد هذين، سيفشل السكربت عند أول قراءة فعلية من Firestore — هذا سلوك
   متعمَّد (فشل واضح لا اتصال صامت بمشروع أو اعتماد غير مقصود).
   ========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

function argOrEnv(flag, envName) {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env[envName] || null;
}

const projectId = argOrEnv('--project', 'FIRESTORE_AUDIT_PROJECT_ID');
if (!projectId) {
  console.error([
    'خطأ: معرّف المشروع (--project) إلزامي — لا مشروع افتراضي صامت.',
    'الاستخدام: node functions/scripts/legacy-inkind-audit.cjs --project <PROJECT_ID>',
    '(راجع .firebaserc لمعرفة المشروع الافتراضي المُعرَّف لهذا المستودع، وتأكد أنه المقصود فعلاً.)',
    '',
    'تنبيه: firebase login وحده لا يكفي — راجع رأس هذا الملف لشرح الاعتماد المطلوب (ADC).',
  ].join('\n'));
  process.exit(1);
}

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

let db;
try {
  initializeApp({ projectId, credential: applicationDefault() });
  db = getFirestore();
} catch (e) {
  console.error('فشل تهيئة Admin SDK — راجع قسم "الاعتماد" في رأس هذا الملف (GOOGLE_APPLICATION_CREDENTIALS أو gcloud auth application-default login):', (e && e.message) || e);
  process.exit(1);
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

async function fetchAll(coll) {
  const snap = await db.collection(coll).get();
  const out = {};
  snap.forEach((doc) => { out[doc.id] = doc.data() || {}; });
  return out;
}

function classify(r) {
  return r.inKindAssetId ? 'linkedToAsset' : 'missingAssetLink';
}

function buildRecord(r, commitments, opportunities, funds) {
  const cmt = commitments[r.linkedCommitmentId] || null;
  const opp = r.inKindAssetId ? (opportunities[r.inKindAssetId] || null) : null;
  const fund = funds[r.fundId] || null;
  const isReversal = n(r.amount) < 0 || !!r.reversalOfId;
  return {
    capitalCallId: r.id,
    fundId: r.fundId || null,
    investorId: r.investorId || null,
    amount: n(r.amount),
    status: r.status || null,
    callDate: r.callDate || null,
    notes: r.notes || null,
    reversalOfId: r.reversalOfId || null,
    linkedCommitmentId: r.linkedCommitmentId,
    inKindAssetId: r.inKindAssetId || null,
    classification: classify(r),
    verification: {
      referencedAssetExists: r.inKindAssetId ? !!opp : null,
      referencedCommitmentExists: !!cmt,
      commitmentContributionTypeIsInKind: cmt ? (cmt.contributionType === 'in_kind') : null,
      isReversalEntry: isReversal,
      hasNotes: !!(r.notes && String(r.notes).trim()),
    },
    commitment: cmt ? {
      contributionType: cmt.contributionType || null,
      dateCommitted: cmt.dateCommitted || null,
      commitmentAmount: n(cmt.commitmentAmount),
      reversalOfId: cmt.reversalOfId || null,
    } : null,
    fundCurrentAssetIds: fund ? (fund.assetIds || []) : null,
  };
}

(async () => {
  const [capitalCalls, commitments, opportunities, funds] = await Promise.all([
    fetchAll('capitalCalls'),
    fetchAll('commitments'),
    fetchAll('opportunities'),
    fetchAll('funds'),
  ]);

  const inKindLinked = Object.entries(capitalCalls)
    .filter(([, d]) => !!d.linkedCommitmentId)
    .map(([id, d]) => Object.assign({ id }, d));

  const records = inKindLinked.map((r) => buildRecord(r, commitments, opportunities, funds));

  const linkedToAsset = records.filter((r) => r.classification === 'linkedToAsset');
  const missingAssetLink = records.filter((r) => r.classification === 'missingAssetLink');

  // القيود العكسية تُستثنى من فحص التكرار عمداً: تنفيذ أصلي واحد + عكسه
  // الخاص به يتشاركان نفس linkedCommitmentId بشكل طبيعي ومتوقَّع (تصحيح
  // موثَّق، لا تنفيذ مزدوج خاطئ) — التكرار الحقيقي هو أكثر من تنفيذ *أصلي*
  // واحد (غير عكسي) لنفس الالتزام.
  const byCommitment = {};
  records.filter((r) => !r.verification.isReversalEntry).forEach((r) => {
    (byCommitment[r.linkedCommitmentId] = byCommitment[r.linkedCommitmentId] || []).push(r);
  });
  const duplicateGroups = Object.entries(byCommitment)
    .filter(([, group]) => group.length > 1)
    .map(([commitmentId, group]) => ({
      linkedCommitmentId: commitmentId,
      count: group.length,
      capitalCallIds: group.map((r) => r.capitalCallId),
    }));

  const missingReferences = records.filter((r) =>
    !r.verification.referencedCommitmentExists ||
    (r.inKindAssetId != null && r.verification.referencedAssetExists === false)
  );

  const reversalEntries = records.filter((r) => r.verification.isReversalEntry);

  const report = {
    generatedAt: new Date().toISOString(),
    projectId,
    totals: {
      capitalCallsScanned: Object.keys(capitalCalls).length,
      linkedToCommitment: records.length,
      linkedToAsset: linkedToAsset.length,
      missingAssetLink: missingAssetLink.length,
      duplicateCommitmentGroups: duplicateGroups.length,
      missingReferences: missingReferences.length,
      reversalEntries: reversalEntries.length,
    },
    linkedToAsset,
    missingAssetLink,
    duplicateGroups,
    missingReferences,
    reversalEntries,
  };

  console.log('== تدقيق السجلات القديمة (للقراءة فقط — بلا أي تعديل) — Phase 2R-4D4-C بند 4 ==');
  console.log(`المشروع: ${projectId}`);
  console.log(`نداءات رأس مال مفحوصة: ${report.totals.capitalCallsScanned}`);
  console.log(`مرتبطة بالتزام (linkedCommitmentId موجود): ${report.totals.linkedToCommitment}`);
  console.log(`  مرتبطة بمرجع أصل (inKindAssetId موجود — لا يعني توثيقاً مؤكَّداً، انظر verification): ${report.totals.linkedToAsset}`);
  console.log(`  يفتقد رابط الأصل (inKindAssetId غائب): ${report.totals.missingAssetLink}`);
  console.log(`مجموعات مكرَّرة (أكثر من نداء لنفس الالتزام): ${report.totals.duplicateCommitmentGroups}`);
  console.log(`مراجع مفقودة (التزام أو أصل غير موجود فعلياً): ${report.totals.missingReferences}`);
  console.log(`قيود عكسية (تصحيح لتنفيذ سابق): ${report.totals.reversalEntries}`);
  console.log('');

  function printSection(title, list) {
    if (list.length === 0) return;
    console.log(`-- ${title} --`);
    list.forEach((r) => console.log(JSON.stringify(r, null, 2)));
    console.log('');
  }

  printSection('يفتقد رابط الأصل (تحتاج مراجعة يدوية بشرية — لا إجراء آلي هنا)', missingAssetLink);
  printSection('مرتبطة بمرجع أصل — للمراجعة اليدوية لتأكيد التوثيق الفعلي (وجود المرجع وحده لا يكفي)', linkedToAsset);
  printSection('مجموعات مكرَّرة (أكثر من نداء واحد لنفس الالتزام)', duplicateGroups);
  printSection('مراجع مفقودة (التزام أو أصل مذكور غير موجود فعلياً في قاعدة البيانات)', missingReferences);
  printSection('قيود عكسية (تصحيح لتنفيذ سابق — ليست تنفيذاً جديداً)', reversalEntries);

  if (report.totals.linkedToCommitment === 0) {
    console.log('لا سجلات مرتبطة بمساهمة عينية على الإطلاق.');
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
