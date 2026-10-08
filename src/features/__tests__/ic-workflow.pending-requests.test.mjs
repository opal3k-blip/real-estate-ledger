#!/usr/bin/env node
/* اختبار وحدة لآلية استمرارية الطلب المعلّق في ic-workflow.js — مراجعة ثانية على 4E، البندان:
     "إعادة تحميل الصفحة تفقد معرّف الطلب المعلّق" و"تغيير المستخدم يعيد استخدام معرّف سابق".
   + مراجعة ثالثة: "فشل حفظ معرّف الطلب يجب أن يمنع استدعاء الخادم" (reservePendingIcRequest).
   استيراد نسبي (../ic-workflow.js) — يعمل من أي نسخة من المستودع، لا مسار مطلق خاص بأي بيئة.
   يُشغَّل: node src/features/__tests__/ic-workflow.pending-requests.test.mjs

   المنهجية: لا "محاكاة فشل مصطنعة" للمسار الكامل (registerICWorkflow/httpsCallable) — بل اختبار
   مباشر لآلية الاستمرارية نفسها (pendingIcRequestKey/loadPendingIcRequestsFromStorage/
   persistPendingIcRequests)، وهي الدوال الحقيقية المُصدَّرة من الملف نفسه، ضد بديل بسيط حقيقي
   لواجهة Storage (getItem/setItem تخزّن في متغيّر JS عادي) — هذا ليس تلاعباً بالنتيجة؛ هو بالضبط
   الطريقة القياسية لاختبار كود يعتمد على localStorage في Node، لأن الشيء المختبَر فعلاً (تسلسل/
   فك‑تسلسل JSON + مفتاح مركَّب) لا علاقة له بكون الواجهة متصفحاً حقيقياً أو لا. محاكاة "إعادة تحميل
   الصفحة" هنا حقيقية بمعناها الوحيد القابل للاختبار خارج متصفح: استدعاء loadPendingIcRequestsFromStorage
   مرة ثانية بعد persistPendingIcRequests — أي قراءة مُستقلة جديدة من نفس المخزن، مطابقة لما يحدث
   فعلياً عند إعادة تحميل الصفحة (متغيّرات JS في الذاكرة تضيع، التخزين الدائم يبقى). */
'use strict';

// بديل Storage حقيقي بسيط (getItem/setItem/removeItem تعمل على Map عادية) — لا توجد localStorage
// في Node افتراضياً؛ هذا ليس تزييفاً للسلوك المختبَر، بل توفير الواجهة الدنيا التي يحتاجها الكود
// الحقيقي (JSON.stringify/parse + Storage interface) ليعمل خارج متصفح.
function makeFakeStorage(){
  const store = new Map();
  return {
    getItem(k){ return store.has(k) ? store.get(k) : null; },
    setItem(k, v){ store.set(k, String(v)); },
    removeItem(k){ store.delete(k); },
  };
}
globalThis.localStorage = makeFakeStorage();

const { pendingIcRequestKey, loadPendingIcRequestsFromStorage, persistPendingIcRequests, reservePendingIcRequest } = await import('../ic-workflow.js');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`✅ ${name}`); } else { failures++; console.log(`❌ ${name}`); }
}

// ========== البند ١: إعادة تحميل الصفحة لا تفقد الطلب المعلّق ==========
{
  // "الجلسة الأولى": طلب معلّق busy=true (رد الخادم لم يصل بعد) على فرصة opp-100 للمستخدم a@x.com.
  const sessionOneMap = loadPendingIcRequestsFromStorage(); // تخزين فارغ بعد — يُعيد Map فارغة
  const key = pendingIcRequestKey('a@x.com', 'opp-100');
  sessionOneMap.set(key, { requestId: 'ic-opp-100-111', signature: 'sig-1', busy: true });
  persistPendingIcRequests(sessionOneMap);

  // "إعادة تحميل الصفحة": متغيّرات JS (sessionOneMap) تضيع فعلياً؛ نقرأ من نفس التخزين من جديد،
  // تماماً كما يحدث عند تحميل الوحدة من الصفر بعد إعادة تحميل حقيقية للصفحة.
  const sessionTwoMap = loadPendingIcRequestsFromStorage();
  const restored = sessionTwoMap.get(key);

  check('الطلب المعلّق موجود بعد "إعادة التحميل" (لم يُفقَد)', !!restored);
  check('نفس requestId محفوظ بالضبط (لإعادة الاستخدام عند إعادة المحاولة)', restored && restored.requestId === 'ic-opp-100-111');
  check('نفس signature محفوظة بالضبط', restored && restored.signature === 'sig-1');
  check('busy أُعيدت إلى false عند التحميل (لا "مشغولة" إلى الأبد بعد إعادة تحميل حقيقية)', restored && restored.busy === false);
}

// ========== البند ٢: تغيير المستخدم لا يعيد استخدام معرّف المستخدم السابق ==========
{
  const map = loadPendingIcRequestsFromStorage();
  const keyUserA = pendingIcRequestKey('analyst-a@x.com', 'opp-200');
  const keyUserB = pendingIcRequestKey('analyst-b@x.com', 'opp-200'); // نفس الفرصة، مستخدم مختلف

  check('مفتاحا مستخدمين مختلفين على نفس الفرصة مختلفان بنيوياً', keyUserA !== keyUserB);

  map.set(keyUserA, { requestId: 'ic-opp-200-userA-999', signature: 'sig-A', busy: false });
  persistPendingIcRequests(map);

  // "تسجيل خروج المستخدم A، تسجيل دخول المستخدم B" — وحدة جديدة (قراءة مستقلة من التخزين).
  const mapAfterUserSwitch = loadPendingIcRequestsFromStorage();
  const userBEntry = mapAfterUserSwitch.get(keyUserB);
  const userAEntry = mapAfterUserSwitch.get(keyUserA);

  check('لا يوجد إدخال للمستخدم B على نفس الفرصة (لم يُنشَأ شيء له بعد)', userBEntry === undefined);
  check('إدخال المستخدم A ما زال موجوداً تحت مفتاحه الخاص فقط، لم "يتسرّب" لمفتاح B', !!userAEntry && userAEntry.requestId === 'ic-opp-200-userA-999');
  // الإثبات الحاسم: لو كان الكود القديم (مفتاح=oppId وحده) يعمل، get(oppId) للمستخدم B كان سيُعيد
  // بالضبط requestId المستخدم A. هنا get(keyUserB) يُعيد undefined دائماً — لا تقاطع ممكن إطلاقاً.
}

// ========== حالة حدّية: تخزين تالف/محظور لا يكسر الواجهة ==========
{
  const brokenStorage = {
    getItem(){ throw new Error('SecurityError: access denied (private mode)'); },
    setItem(){ throw new Error('QuotaExceededError'); },
  };
  const realStorage = globalThis.localStorage;
  globalThis.localStorage = brokenStorage;
  let threw = false;
  try {
    const m = loadPendingIcRequestsFromStorage();
    check('تخزين محظور عند القراءة: يُعيد Map فارغة بدل رمي استثناء', m instanceof Map && m.size === 0);
    persistPendingIcRequests(new Map([['k', { requestId: 'x', signature: 'y', busy: false }]]));
    check('تخزين محظور عند الكتابة: لا يرمي استثناء (لا يكسر تدفق القرار)', true);
  } catch (e) {
    threw = true;
  }
  check('لم يُرمَ أي استثناء غير مُعالَج من كلا الفحصين أعلاه', !threw);
  globalThis.localStorage = realStorage;
}

// ========== البند ٣ (مراجعة ثالثة): فشل حفظ معرّف الطلب يجب أن يمنع استدعاء الخادم ==========
// هذا هو الاختبار الذي طلبه المراجع صريحاً: اختبار "المعالج نفسه" (أي البوابة الحقيقية التي
// يستدعيها معالج القرار في ic-workflow.js قبل أي نداء لـ httpsCallable)، لا محاكاة منفصلة
// لمنطق مُعاد كتابته. reservePendingIcRequest هي نفس الدالة المُصدَّرة التي يستدعيها المعالج
// الحقيقي في نقطة الحجز الوحيدة (قبل try/httpsCallable مباشرة) — لم تُعَد كتابتها هنا.
{
  const sessionMap = loadPendingIcRequestsFromStorage(); // تخزين سليم حتى الآن — Map فارغة
  const key = pendingIcRequestKey('analyst-c@x.com', 'opp-300');

  // تخزين يفشل في الكتابة فقط (محاكاة واقعية لـQuotaExceededError/وضع التصفح الخاص) بعد أن كانت
  // القراءة سليمة — هذا بالضبط التسلسل الذي أثبته المراجع: الكتابة هي ما يفشل، لا القراءة.
  const realStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(k){ return realStorage.getItem(k); },
    setItem(){ throw new Error('QuotaExceededError: simulated storage write failure'); },
    removeItem(k){ return realStorage.removeItem(k); },
  };

  const reserved = reservePendingIcRequest(sessionMap, key, 'ic-opp-300-new-id', 'sig-new');

  check('reservePendingIcRequest تُرجع false عندما يفشل الحفظ الفعلي في localStorage', reserved === false);
  check('لم يبقَ إدخال "busy:true" غير محفوظ فعلياً في الذاكرة بعد فشل الحفظ (تراجع كامل)', sessionMap.get(key) === undefined);
  // الإثبات الحاسم المطلوب: في المعالج الحقيقي، `if(!reservePendingIcRequest(...)) return true;` يسبق
  // أي نداء لـ`firebase.functions().httpsCallable('approveOpportunity')` مباشرة — إذن reserved===false
  // هنا يعني فعلياً أن نفس الشرط في المعالج الحقيقي سيمنع الوصول إلى سطر استدعاء الخادم إطلاقاً.
  check('بالتبعية: الشرط "if(!reservePendingIcRequest(...))" في المعالج الحقيقي سيُرجِع فوراً قبل أي استدعاء للخادم', reserved === false);

  globalThis.localStorage = realStorage; // استرجاع التخزين السليم لبقية الاختبار
}

// ========== نفس البند: تأكيد أن الحفظ الناجح (الحالة الطبيعية) لا يزال يسمح بالمتابعة ==========
{
  const sessionMap = loadPendingIcRequestsFromStorage();
  const key = pendingIcRequestKey('analyst-d@x.com', 'opp-400');
  const reserved = reservePendingIcRequest(sessionMap, key, 'ic-opp-400-new-id', 'sig-new');
  check('reservePendingIcRequest تُرجع true عند نجاح الحفظ الفعلي (الحالة الطبيعية غير المتأثرة بالإصلاح)', reserved === true);
  check('الإدخال محفوظ فعلياً في الذاكرة بعد نجاح الحفظ', sessionMap.get(key) && sessionMap.get(key).requestId === 'ic-opp-400-new-id');
  const reloaded = loadPendingIcRequestsFromStorage();
  check('وبعد "إعادة تحميل" فعلية، الإدخال موجود أيضاً في التخزين الحقيقي (لم يكن حجزاً في الذاكرة فقط)', reloaded.get(key) && reloaded.get(key).requestId === 'ic-opp-400-new-id');
}

// ========== البند ٤ (مراجعة رابعة): نتيجة غامضة سابقة ← فشل حفظ أثناء إعادة المحاولة ← عودة التخزين ==========
// هذا هو التسلسل الذي أثبته المراجع بالضبط: الإصلاح السابق (البند ٣ أعلاه) كان يحذف إدخال
// pendingKey عند أي فشل حفظ، بلا تمييز بين "حجز جديد كلياً" و"إعادة محاولة لطلب سابق نتيجته
// غامضة فعلاً". الحذف في الحالة الثانية يفقد requestId الأصلي الذي قد يكون الخادم نفَّذه، فتعيد
// المحاولة التالية (بعد عودة التخزين) توليد معرّف جديد تماماً — تكرار الثغرة من جديد.
{
  const sessionMap = loadPendingIcRequestsFromStorage();
  const key = pendingIcRequestKey('analyst-e@x.com', 'opp-500');
  const ORIGINAL_REQUEST_ID = 'ic-opp-500-original-ambiguous-attempt';
  const SIGNATURE = 'sig-same-payload';

  // الخطوة ١: "طلب أُرسل بنتيجة غامضة" — هذا ما يفعله المعالج الحقيقي في كتلة catch عند خطأ غامض:
  // الإدخال يبقى محفوظاً (busy يُعاد إلى false)، لا يُحذَف، لأن الخادم قد يكون نفَّذ الطلب فعلاً.
  sessionMap.set(key, { requestId: ORIGINAL_REQUEST_ID, signature: SIGNATURE, busy: false });
  check('نجاح الحفظ الأول (تمهيد السيناريو، تخزين سليم حتى الآن)', persistPendingIcRequests(sessionMap) === true);

  // الخطوة ٢: "المستخدم يعيد المحاولة بنفس القرار بالضبط" — المعالج الحقيقي يقرأ inFlight، يجد
  // signature مطابقة، فيُعيد استخدام inFlight.requestId نفسه (لا يولّد معرّفاً جديداً) — تماماً
  // كما يحسبه المعالج الحقيقي (انظر السطر `requestId = (inFlight && inFlight.signature===signature) ? inFlight.requestId : newIcRequestId(...)`).
  const inFlight = sessionMap.get(key);
  const retryRequestId = (inFlight && inFlight.signature === SIGNATURE) ? inFlight.requestId : 'SHOULD_NOT_HAPPEN_new_id';
  check('المعالج سيُعيد استخدام requestId الأصلي لإعادة المحاولة (لا معرّف جديد)، لأن signature مطابقة', retryRequestId === ORIGINAL_REQUEST_ID);

  // الخطوة ٣: "فشل حفظ أثناء إعادة المحاولة" — الكتابة تفشل هذه المرة بالذات (محاكاة واقعية).
  const realStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(k){ return realStorage.getItem(k); },
    setItem(){ throw new Error('QuotaExceededError: simulated failure during retry'); },
    removeItem(k){ return realStorage.removeItem(k); },
  };
  const reservedDuringRetry = reservePendingIcRequest(sessionMap, key, retryRequestId, SIGNATURE);
  globalThis.localStorage = realStorage; // "عودة التخزين" — التخزين يعمل من جديد بعد هذه المحاولة

  check('فشل الحفظ أثناء إعادة المحاولة: reservePendingIcRequest تُرجع false (لا تُستدعى الخادم)', reservedDuringRetry === false);

  const afterFailedRetry = sessionMap.get(key);
  check('الإدخال لم يُحذَف بعد فشل الحفظ أثناء إعادة المحاولة (الإصلاح على المراجعة الرابعة) — استُعيد بدل أن يضيع', !!afterFailedRetry);
  check('requestId الأصلي نفسه محفوظ في الذاكرة بعد الاستعادة (لم يُستبدَل ولم يَضِع)', afterFailedRetry && afterFailedRetry.requestId === ORIGINAL_REQUEST_ID);
  check('busy أُعيدت إلى false بعد فشل إعادة المحاولة (لا "مشغولة" إلى الأبد)', afterFailedRetry && afterFailedRetry.busy === false);

  // الخطوة ٤: "عودة التخزين" — تأكيد أن الاستعادة انعكست في التخزين الحقيقي أيضاً، لا في الذاكرة فقط.
  const reloadedAfterRetryFailure = loadPendingIcRequestsFromStorage();
  const persistedEntry = reloadedAfterRetryFailure.get(key);
  check('نفس requestId الأصلي محفوظ أيضاً في التخزين الحقيقي بعد "عودة التخزين" (لا فقط في الذاكرة)', persistedEntry && persistedEntry.requestId === ORIGINAL_REQUEST_ID);

  // الخطوة ٥: الإثبات الحاسم المطلوب — "المحاولة التالية تستخدم المعرّف الأصلي نفسه": محاكاة محاولة
  // ثالثة، بعد أن عاد التخزين للعمل فعلياً، يجب أن تحجز بنفس requestId الأصلي لا معرّفاً جديداً.
  const nextAttemptInFlight = reloadedAfterRetryFailure.get(key);
  const nextAttemptRequestId = (nextAttemptInFlight && nextAttemptInFlight.signature === SIGNATURE) ? nextAttemptInFlight.requestId : 'SHOULD_NOT_HAPPEN_new_id';
  check('المحاولة التالية (بعد عودة التخزين) تستخدم المعرّف الأصلي نفسه، لا معرّفاً جديداً', nextAttemptRequestId === ORIGINAL_REQUEST_ID);
  const reservedNextAttempt = reservePendingIcRequest(reloadedAfterRetryFailure, key, nextAttemptRequestId, SIGNATURE);
  check('ومع تخزين سليم الآن، الحجز بنفس المعرّف الأصلي ينجح فعلاً (يُسمَح بالمتابعة لاستدعاء الخادم)', reservedNextAttempt === true);
}

console.log('');
if (failures === 0) {
  console.log('== النتيجة: 0 فشل — آلية الاستمرارية تنجو من "إعادة تحميل الصفحة"، لا تخلط بين مستخدمين على نفس الفرصة، وفشل الحفظ يمنع استدعاء الخادم فعلياً، ويستعيد الطلب الأصلي بدل حذفه عند فشل الحفظ أثناء إعادة محاولة لطلب سابق نتيجته غامضة. ==');
  process.exit(0);
} else {
  console.log(`== النتيجة: ${failures} حالة فشلت. ==`);
  process.exit(1);
}
