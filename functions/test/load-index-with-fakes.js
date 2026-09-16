/* =========================================================================
   محمِّل functions/index.js لأغراض الاختبار البنيوي (بلا Firebase Emulator ولا مشروع حقيقي).
   ---------------------------------------------------------------------------
   functions/index.js يستدعي require('firebase-admin/...')‎/require('firebase-functions/...') في
   وقت التحميل نفسه (module-load time) — initializeApp()‎/getFirestore() فعلياً عند أول require،
   لا داخل أي دالة. لا يمكن تحميل الملف في Node عادي بلا هذه الحزم، وحتى لو كانت مثبَّتة فعلياً
   (للنشر الحقيقي)، getFirestore() الحقيقية تحتاج اعتماد Firebase حقيقي (Service Account) أو
   Emulator — كلاهما غير متاح هنا.

   الحل: نعترض دقة الوحدات (module resolution) بـModule._resolveFilename *قبل* أي require لـ
   index.js، ونُحوِّل أسماء الحزم المحدَّدة أدناه لملفات fakes/*.js محلية خفيفة — بلا أي تثبيت حزمة
   حقيقية، بلا شبكة، بلا بيانات اعتماد. هذا نمط اختبار قياسي (نفس ما تفعله مكتبات مثل proxyquire/
   mock-require)، مطبَّق هنا يدوياً بلا اعتماد إضافي.

   ⚠️ هذا الاعتراض عالمي طوال عمر عملية Node (لا يُعاد للوضع الأصلي تلقائياً) — استخدمه فقط من
   سكربت اختبار مستقل (Node process منفصلة لكل ملف اختبار)، لا داخل عملية تشغّل كوداً آخر يحتاج
   الحزم الحقيقية لاحقاً في نفس العملية.

   ما هذا **لا** يختبره: قواعد firestore.rules نفسها (تلك مسؤولية tests/rules/rules.test.mjs عبر
   Firestore Emulator الحقيقي)، ولا التزامن الحقيقي بين معاملات متوازية (FakeTransaction هنا بلا
   عزل حقيقي). هذا يختبر فقط منطق دوال functions/index.js نفسها: من يُسمح له بفعل ماذا، وما الذي
   يُكتب فعلياً عند كل استدعاء.
   ========================================================================= */
const Module = require('module');
const path = require('path');

const FAKES_DIR = path.join(__dirname, 'fakes');
const FAKE_MAP = {
  'firebase-functions': path.join(FAKES_DIR, 'firebase-functions-bare.js'),
  'firebase-functions/v2/https': path.join(FAKES_DIR, 'firebase-functions-v2-https.js'),
  'firebase-functions/v2/firestore': path.join(FAKES_DIR, 'firebase-functions-v2-firestore.js'),
  'firebase-functions/v1': path.join(FAKES_DIR, 'firebase-functions-v1.js'),
  'firebase-functions/params': path.join(FAKES_DIR, 'firebase-functions-params.js'),
  'firebase-admin/app': path.join(FAKES_DIR, 'firebase-admin-app.js'),
  'firebase-admin/firestore': path.join(FAKES_DIR, 'firebase-admin-firestore.js'),
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

function loadIndexWithFakes() {
  installFakeResolution();
  // مسح أي نسخة محمَّلة سابقاً من index.js (لو استُدعيت هذه الدالة أكثر من مرة في نفس العملية)
  // حتى لا نُعيد استخدام نسخة حُمِّلت قبل تفعيل الاعتراض.
  const indexPath = path.join(__dirname, '..', 'index.js');
  delete require.cache[require.resolve(indexPath)];
  const fns = require(indexPath);
  const db = require(FAKE_MAP['firebase-admin/firestore']).__singleton;
  const { HttpsError } = require(FAKE_MAP['firebase-functions/v2/https']);
  return { fns, db, HttpsError };
}

module.exports = { loadIndexWithFakes };
