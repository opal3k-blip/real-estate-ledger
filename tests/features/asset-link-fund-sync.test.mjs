// Phase 2R-4D4-C (الجولة الخامسة من المراجعة): اختبار وحدة لـ applyFetchedFundSnapshot في
// src/core.js — الدالة الوحيدة التي يستدعيها معالج if-toggle-asset الآن بعد أي استجابة ناجحة من
// الخادم (linkAssetToFund)، سواء كانت تنفيذاً جديداً أو نتيجة مُعادة (replay) لطلب سبق تنفيذه.
//
// الخلل الذي يُثبت هذا الاختبار إصلاحه: الكود السابق (applyConfirmedLinkChange) كان يُطبّق التبديل
// محلياً بناءً على *اتجاه هذا النداء تحديداً* (ربط أم فك) بافتراض أن كل نجاح يعني تنفيذ هذا الاتجاه
// الآن فعلاً -- خاطئ في سيناريو: ربط ← فك ناجح ← إعادة ربط ناجحة ← إعادة إرسال طلب الفك القديم
// (نفس requestId والحمولة). الخادم يعيد نجاحاً محفوظاً (نتيجة مُعادة) دون تنفيذ فعلي، لكن الكود
// القديم كان سيُظهر الأصل "غير مربوط" محلياً رغم بقائه مربوطاً فعلياً على الخادم.
//
// applyFetchedFundSnapshot لا تملك أي معامل "اتجاه" إطلاقاً بتصميمها -- تأخذ فقط fundId ومحتوى
// وثيقة مجلوبة فعلياً من الخادم، وتستبدل بها STORE.funds[fundId] كاملة. هذا يُثبت بنيوياً أن
// التحديث لا يمكنه تخمين الاتجاه: مهما كان الطلب المُرسَل (ربط/فك/إعادة إرسال)، ما يُعرَض هو
// محتوى آخر جلب فعلي من الخادم فقط -- تماماً ما طلبته المراجعة: "تحديث العرض من حالة الخادم
// الحالية، بدل تطبيق العملية القديمة محلياً".
//
// نطاق هذا الاختبار: يغطي دالة المزامنة النقية (applyFetchedFundSnapshot) المستخدَمة فعلياً من
// داخل معالج if-toggle-asset الحقيقي في كلا موضعي الاستدعاء بعد النجاح (انظر refreshFundFromServerAfterSuccess
// وhandleStaleOrUnknown في src/core.js). لا يُشغِّل هذا الاختبار معالج نقرة DOM فعلياً ولا يُحاكي
// firebase.functions().httpsCallable -- ذلك يتطلّب DB/firebase حقيقيين لا تتيحهما بيئة VM المستخدَمة
// هنا لبقية اختبارات src/core.js (انظر تعليق "حدود الاختبار" في docs/PHASE_2R_4D4C_HANDOFF.md).
// المسار الكامل (نقرة ← نداء خادم ← هذه الدالة ← render) يبقى غير مُغطّى آلياً، مثل حارس الجلسة
// (authSessionSeq) الموثَّق سابقاً بنفس القيد.

import assert from 'assert';
import { loadCore } from '../domain/core-vm-harness.mjs';

const C = loadCore();

function resetStore(){
  C.STORE.funds.length = 0;
}

// (أ) الحالة الأساسية: صندوق غير موجود بعد في STORE.funds -- أول جلب يُدرجه.
resetStore();
C.applyFetchedFundSnapshot('FNDSYNC1', { assetIds: ['OPPSYNC1'], name: 'صندوق تجريبي' });
{
  const f = C.STORE.funds.find(x=>x.id==='FNDSYNC1');
  assert.ok(f, 'الصندوق يجب أن يُدرَج بعد أول جلب');
  assert.deepStrictEqual(f.data.assetIds, ['OPPSYNC1']);
}
console.log('  ✓ (أ) جلب أول لصندوق غير موجود في STORE.funds يُدرجه بمحتواه الفعلي');

// (ب) السيناريو المحدَّد في المراجعة: ربط ← فك ناجح ← إعادة ربط ناجحة ← إعادة إرسال طلب الفك
// القديم (نتيجة مُعادة من الخادم دون تنفيذ فعلي). التسلسل هنا يُمثَّل بأربعة استدعاءات متتالية لنفس
// الدالة التي يستدعيها المعالج الحقيقي بعد كل استجابة ناجحة -- بمحتوى الوثيقة كما سيُجلب فعلياً من
// الخادم في كل لحظة (لا بأي "اتجاه" مُخمَّن).
resetStore();
C.applyFetchedFundSnapshot('FNDSYNC2', { assetIds: [] });                 // حالة أولية: غير مربوط
C.applyFetchedFundSnapshot('FNDSYNC2', { assetIds: ['OPPSYNC2'] });       // بعد ربط ناجح
C.applyFetchedFundSnapshot('FNDSYNC2', { assetIds: [] });                 // بعد فك ناجح
C.applyFetchedFundSnapshot('FNDSYNC2', { assetIds: ['OPPSYNC2'] });       // بعد إعادة ربط ناجحة
// الآن يُعاد إرسال طلب الفك القديم؛ الخادم يعيد نجاحاً محفوظاً (نتيجة مُعادة)، فيُستدعى نفس المسار
// -- لكن الجلب الفعلي من الخادم (وهذا ما تختبره الدالة) يعيد الوثيقة الحقيقية الحالية: لا تزال
// مربوطة (لأن إعادة الإرسال لم تُنفِّذ شيئاً فعلياً، فقط أعادت نتيجة الفك الأصلي المحفوظة).
C.applyFetchedFundSnapshot('FNDSYNC2', { assetIds: ['OPPSYNC2'] });
{
  const f = C.STORE.funds.find(x=>x.id==='FNDSYNC2');
  assert.deepStrictEqual(f.data.assetIds, ['OPPSYNC2'],
    'REGRESSION: بعد إعادة إرسال طلب الفك القديم المنفَّذ سابقاً، يجب أن يبقى الأصل مربوطاً محلياً (مطابقاً لحالة الخادم الحقيقية) -- لا أن يظهر "غير مربوط" بسبب تخمين الاتجاه من الطلب المُعاد');
}
console.log('  ✓ (ب) إعادة إرسال طلب فك قديم بعد إعادة ربط -- العرض يتبع محتوى آخر جلب فعلي من الخادم (مربوط)، لا اتجاه الطلب المُعاد');

// (ج) يستبدل الوثيقة كاملة (لا يدمج جزئياً) -- حقل آخر غير assetIds يُستبدَل أيضاً بما وصل فعلياً،
// إثباتاً أن لا حالة قديمة متبقية جزئياً بعد التحديث.
resetStore();
C.STORE.funds.push({ id: 'FNDSYNC3', data: { assetIds: ['OLD'], name: 'اسم قديم', updatedAt: '2020-01-01' } });
C.applyFetchedFundSnapshot('FNDSYNC3', { assetIds: ['NEW'], name: 'اسم جديد', updatedAt: '2026-09-28' });
{
  const f = C.STORE.funds.find(x=>x.id==='FNDSYNC3');
  assert.deepStrictEqual(f.data, { assetIds: ['NEW'], name: 'اسم جديد', updatedAt: '2026-09-28' });
}
console.log('  ✓ (ج) الجلب الفعلي يستبدل وثيقة الصندوق كاملة في STORE.funds، لا تحديثاً جزئياً يُبقي حقولاً قديمة');

console.log('\nكل اختبارات applyFetchedFundSnapshot (مزامنة حالة الصندوق من الخادم بعد نجاح الربط/الفك) نجحت.');
