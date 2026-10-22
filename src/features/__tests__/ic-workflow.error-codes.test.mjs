#!/usr/bin/env node
/* اختبار وحدة لإصلاح بند ٢ من مراجعة 4E (رموز خطأ Firebase) — استيراد نسبي (../ic-workflow.js)،
   يعمل من أي نسخة من المستودع. يُشغَّل: node src/features/__tests__/ic-workflow.error-codes.test.mjs

   تصحيح على مراجعة خارجية ثانية: النسخة الأولى من هذا الاختبار استوردت عبر مسار مطلق خاص بحاوية
   تشغيل الوكيل السحابية (غير صالح على أي جهاز آخر)، ثم عبر مجلد "sandbox" محلي غير مُرفَق مع
   التسليم. هنا استيراد نسبي عادي فقط — لا تجهيز خارجي، لا مجلد غير مُرفَق. */
'use strict';
const { normalizeFunctionsErrorCode } = await import('../ic-workflow.js');

const IC_REQUEST_DEFINITIVE_ERROR_CODES = new Set([
  'invalid-argument', 'permission-denied', 'unauthenticated', 'not-found', 'failed-precondition', 'already-exists',
]);

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`✅ ${name}`); } else { failures++; console.log(`❌ ${name}`); }
}

const BARE = 'permission-denied';
const PREFIXED = 'functions/permission-denied'; // الصيغة الحقيقية الموثقة من Firebase لـ httpsCallable

check('الصيغة بلا بادئة تبقى كما هي بعد التوحيد', normalizeFunctionsErrorCode(BARE) === 'permission-denied');
check('الصيغة بالبادئة "functions/" تُختزَل إلى الرمز الخام', normalizeFunctionsErrorCode(PREFIXED) === 'permission-denied');
check('كِلا الصيغتين، بعد التوحيد، تطابقان IC_REQUEST_DEFINITIVE_ERROR_CODES',
  IC_REQUEST_DEFINITIVE_ERROR_CODES.has(normalizeFunctionsErrorCode(BARE)) &&
  IC_REQUEST_DEFINITIVE_ERROR_CODES.has(normalizeFunctionsErrorCode(PREFIXED)));
check('(توثيق الخلل القديم) المقارنة الخام بلا توحيد كانت تفشل على الصيغة المبدوءة', !IC_REQUEST_DEFINITIVE_ERROR_CODES.has(PREFIXED));
check('قيمة undefined تُعاد كما هي بلا استثناء', normalizeFunctionsErrorCode(undefined) === undefined);
check('قيمة null تُعاد كما هي بلا استثناء', normalizeFunctionsErrorCode(null) === null);
check('رمز غامض آخر (مثل "internal") يبقى غير نهائي', !IC_REQUEST_DEFINITIVE_ERROR_CODES.has(normalizeFunctionsErrorCode('internal')));
check('رمز غامض مبدوء ("functions/internal") يُوحَّد ويبقى غير نهائي أيضاً', !IC_REQUEST_DEFINITIVE_ERROR_CODES.has(normalizeFunctionsErrorCode('functions/internal')));

console.log('');
if (failures === 0) {
  console.log('== النتيجة: 0 فشل. ==');
  process.exit(0);
} else {
  console.log(`== النتيجة: ${failures} حالة فشلت. ==`);
  process.exit(1);
}
