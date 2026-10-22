/* =========================================================================
   محمِّل functions/index.js لأغراض اختبار التزامن الحقيقي (Phase 2R-4E، بند التحقق
   المفتوح رقم ٦) — بخلاف load-index-with-fakes.js تماماً: هنا نُبقي firebase-admin/app
   وfirebase-admin/firestore على حقيقتهما الكاملة (الحزمة المثبَّتة فعلياً في
   functions/node_modules)، بحيث getFirestore() تُعيد عميل Firestore حقيقياً يتحدث فعلياً
   مع Firestore Emulator الحقيقي (عبر متغيّر البيئة FIRESTORE_EMULATOR_HOST الذي يضبطه
   `firebase emulators:exec` تلقائياً) — لا محاكاة يدوية بلا عزل حقيقي بين المعاملات، بخلاف
   FakeTransaction في fakes/firebase-admin-firestore.js. هذا هو الفرق الجوهري الذي يسمح
   بإثبات التزامن الحقيقي (طلبان متزامنان بنفس requestId+الحمولة ينتجان قراراً واحداً فقط)
   الذي لا يمكن لملفات fakes إثباته إطلاقاً (لا عزل معاملات حقيقي فيها، كما تُقر fakes
   بصراحة في تعليقها).

   طبقة firebase-functions (onCall/HttpsError/الزناد v1/v2/params) تبقى مُزيَّفة بنفس فَكّات
   load-index-with-fakes.js بالضبط — onCall هناك لا يفعل شيئاً سوى إعادة الدالة نفسها
   للاستدعاء المباشر (request)=>handler(request)‎، فلا حاجة لمحاكي Functions كامل (Functions
   Framework/Eventarc) لاستدعاء المنطق مباشرة؛ هذا لا يمسّ Firestore بأي شكل فيؤثر على صحة
   اختبار التزامن. nodemailer يبقى مُزيَّفاً كذلك (لا بريد حقيقي في اختبار).

   ⚠️ يتطلب: (أ) FIRESTORE_EMULATOR_HOST مضبوطاً فعلياً (وإلا فإن firebase-admin الحقيقية
   ستحاول الاتصال بمشروع Firebase حقيقي بلا بيانات اعتماد فتفشل) — تحقّق صريح أدناه يرفض
   العمل بلا هذا المتغيّر، حتى لا يُشغَّل هذا الملف بالخطأ ضد بيانات إنتاج حقيقية. (ب) نفس
   الاعتراض العالمي طوال عمر العملية الموصوف في load-index-with-fakes.js (Module._resolveFilename
   لا يُعاد للوضع الأصلي) — عملية Node مستقلة لكل ملف اختبار.
   ========================================================================= */
const Module = require('module');
const path = require('path');

const FAKES_DIR = path.join(__dirname, 'fakes');
// عمداً بلا firebase-admin/app وbلا firebase-admin/firestore هنا — تبقى تُحلّ للحزمة
// الحقيقية المثبَّتة في functions/node_modules (خلافاً لـload-index-with-fakes.js).
const FAKE_MAP = {
  'firebase-functions': path.join(FAKES_DIR, 'firebase-functions-bare.js'),
  'firebase-functions/v2/https': path.join(FAKES_DIR, 'firebase-functions-v2-https.js'),
  'firebase-functions/v2/firestore': path.join(FAKES_DIR, 'firebase-functions-v2-firestore.js'),
  'firebase-functions/v1': path.join(FAKES_DIR, 'firebase-functions-v1.js'),
  'firebase-functions/params': path.join(FAKES_DIR, 'firebase-functions-params.js'),
  'nodemailer': path.join(FAKES_DIR, 'nodemailer.js'),
};

let installed = false;
function installFakeResolution() {
  if (installed) return;
  installed = true;
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(FAKE_MAP, request)) return FAKE_MAP[request];
    return originalResolve.call(this, request, ...rest);
  };
}

function loadIndexAgainstRealEmulator() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST غير مضبوط — هذا الملف يستخدم firebase-admin الحقيقية عمداً؛ ' +
      'تشغيله بلا هذا المتغيّر يخاطر بالاتصال بمشروع Firebase حقيقي. شغِّله فقط عبر ' +
      '`firebase emulators:exec --only firestore --project <demo-project> "node <هذا الملف>"`.'
    );
  }
  installFakeResolution();
  const indexPath = path.join(__dirname, '..', 'index.js');
  delete require.cache[require.resolve(indexPath)];
  const fns = require(indexPath);
  const { getFirestore } = require('firebase-admin/firestore');
  const db = getFirestore();
  const { HttpsError } = require(FAKE_MAP['firebase-functions/v2/https']);
  return { fns, db, HttpsError };
}

module.exports = { loadIndexAgainstRealEmulator };
