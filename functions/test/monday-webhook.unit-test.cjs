'use strict';
/* =========================================================================
   اختبار بنيوي (fakes، بلا Firestore Emulator حقيقي) لـfunctions/monday-webhook.js
   — الإصدار الرابع، بعد ثلاث مراجعات خارجية متتالية. راجع تعليق رأس monday-webhook.js
   نفسه (الفقرة ج) لتاريخ الأعطال الثلاثة التي صحَّحتها كل مراجعة، والمُختبَرة هنا بالاسم:
   "عدم استبدال إشعار سابق بانتقال لاحق"، "فشل تسجيل sent لا يُعامَل كفشل إرسال مؤكَّد"، و
   "فشل sendMail نفسها لا يُعامَل كمؤكَّد إلا بدليل واضح — غيره يُعامَل كملتبس بلا إعادة تلقائية".

   هذا الملف يكفي لكل سيناريو هنا لأنه بنيوي/تسلسلي (حتى سيناريو "انتقال جديد أثناء إرسال
   سابق" هو تداخل زمني (interleaving) مُتحكَّم به بالكامل من الاختبار نفسه، لا سباق تزامن
   حقيقي بين عمليتين مستقلتين) — سيناريو التزامن الحقيقي (طلبان متزامنان فعلياً بمعاملتين
   متنازعتين على Firestore حقيقي) يبقى في monday-webhook-concurrency.emulator.test.js.

   ⚠️ ملاحظة بنية الاختبار: fakes/firebase-admin-firestore.js (المشتركة، غير المُعدَّلة هنا)
   لا توفّر .update() مباشرة على FakeDocRef (فقط FakeTransaction.update(ref,patch) داخل
   معاملة) — لأن الكود الحقيقي لا يحتاجها هناك. لكن دالة الإرسال (mondayStatusNotifyOnQueueWrite)
   تستدعي after.ref.update(...) مباشرة *خارج* أي معاملة (تماماً كما تفعل Firestore API الحقيقية
   على DocumentSnapshot.ref) لتسجيل نتيجة الإرسال. makeAfterChange أدناه تُضيف .update() محلياً
   فقط على نسخة ref واحدة يستخدمها الاختبار، فوق FakeDocRef الحقيقي (تحتفظ بـ.coll/.id/.get()
   التي تحتاجها معاملة "الحجز" الداخلية بالدالة) — بلا أي تعديل على الملف المشترك نفسه.
   ========================================================================= */
const assert = require('node:assert/strict');
const path = require('path');
const { loadIndexWithFakes } = require('./load-index-with-fakes');

const TOKEN = 'unit-test-token-abc123';
process.env.MONDAY_WEBHOOK_TOKEN = TOKEN;

const QUEUE_COLLECTION = 'mondayTaskQueue';
const NOTIF_COLLECTION = 'mondayNotificationQueue';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`✅ ${name}`);
}

function fakeReq({ body, token, header, authorization } = {}) {
  return {
    query: token !== undefined ? { token } : {},
    body: body || {},
    get(name) {
      if (name === 'X-Monday-Webhook-Token') return header || null;
      if (name === 'Authorization') return authorization || null;
      return null;
    },
  };
}
function fakeRes() {
  const res = {
    _status: 200, _json: null, _sent: null,
    status(code) { res._status = code; return res; },
    json(obj) { res._json = obj; return res; },
    send(text) { res._sent = text; return res; },
  };
  return res;
}
// ⚠️ token=null (لا undefined) هو السنتينل المقصود لـ"لا تُرسِل أي token في query" — افتراضي
// الوسيط (= TOKEN) يُفعَّل فقط عند undefined فعلياً (قاعدة JS للوسائط الافتراضية)، فلو استُخدِم
// token: undefined لهذا الغرض لانقلب خطأً إلى TOKEN الصحيح بدل غيابه، فيُخفي اختبار الرفض نفسه.
async function callWebhook(fns, { itemId, statusText, token = TOKEN, header, authorization, body } = {}) {
  const req = fakeReq({
    token: token === null ? undefined : token,
    header,
    authorization,
    body: body || { event: { pulseId: itemId, value: { label: { text: statusText } } } },
  });
  const res = fakeRes();
  await fns.mondayWebhook(req, res);
  if (res._json != null) return { ...res._json, _status: res._status };
  return { _status: res._status, _body: res._sent };
}

(async () => {
  const { fns, db } = loadIndexWithFakes();
  const nodemailerFake = require(path.join(__dirname, 'fakes', 'nodemailer.js'));
  const originalCreateTransport = nodemailerFake.createTransport;

  function seedTask(taskId, itemId, initialStatus) {
    db.__seed(QUEUE_COLLECTION, taskId, { mondayItemId: itemId, mondayStatus: initialStatus });
  }
  function getTask(taskId) { return db.__get(QUEUE_COLLECTION, taskId); }
  function getNotif(notifId) { return db.__get(NOTIF_COLLECTION, notifId); }
  function latestNotifId(taskId) { return getTask(taskId).latestNotificationId; }

  // انظر التعليق أعلى الملف — يضيف .update() محلياً فوق FakeDocRef حقيقي (يبقي .coll/.id/.get()).
  function makeAfterChange(notifId, { failOnStatus } = {}) {
    const ref = db.collection(NOTIF_COLLECTION).doc(notifId);
    ref.update = async (patch) => {
      if (failOnStatus && patch.status === failOnStatus) {
        throw new Error('simulated Firestore write failure while recording status=' + failOnStatus);
      }
      const current = getNotif(notifId);
      if (!current) throw new Error('update on missing notification: ' + notifId);
      Object.assign(current, patch);
    };
    return { after: { exists: true, ref, data: () => getNotif(notifId) } };
  }
  async function runNotifier(notifId, opts) {
    return fns.mondayStatusNotifyOnQueueWrite(makeAfterChange(notifId, opts), {});
  }
  // أخطاء SMTP مُصنَّفة بوضوح عبر خصائص err.code/err.responseCode الحقيقية التي يستخدمها
  // isConfirmedNonDelivery في monday-webhook.js — لا مجرد نص رسالة يحتوي اسم الكود مصادفةً.
  function makeSmtpError(message, props) {
    const err = new Error(message);
    Object.assign(err, props || {});
    return err;
  }

  // =======================================================================
  // تحقّق المصدر — يُرفَض قبل أي لمس لـFirestore
  // =======================================================================
  await test('بلا أي token: رمز الحالة 401، ولا كتابة على mondayTaskQueue', async () => {
    seedTask('TASK-NOAUTH', 'ITEM-NOAUTH', 'A');
    const before = JSON.stringify(getTask('TASK-NOAUTH'));
    const r = await callWebhook(fns, { itemId: 'ITEM-NOAUTH', statusText: 'B', token: null });
    assert.equal(r._status, 401);
    assert.equal(JSON.stringify(getTask('TASK-NOAUTH')), before, 'الوثيقة لم تُلمَس إطلاقاً');
  });

  await test('رمز خاطئ عبر query: رمز الحالة 401', async () => {
    const r = await callWebhook(fns, { itemId: 'ITEM-X', statusText: 'B', token: 'wrong-token' });
    assert.equal(r._status, 401);
  });

  await test('رمز صحيح عبر X-Monday-Webhook-Token header (بلا query token): يُقبَل', async () => {
    seedTask('TASK-HEADER', 'ITEM-HEADER', 'A');
    const r = await callWebhook(fns, { itemId: 'ITEM-HEADER', statusText: 'B', token: null, header: TOKEN });
    assert.notEqual(r._status, 401);
  });

  await test('challenge مع رمز خاطئ: يُرفَض بـ401 (لا يُعاد الصدى بلا تحقّق)', async () => {
    const r = await callWebhook(fns, { token: 'wrong', body: { challenge: 'abc123' } });
    assert.equal(r._status, 401);
    assert.equal(r.challenge, undefined);
  });

  await test('challenge مع رمز صحيح: يُعاد كما هو', async () => {
    const r = await callWebhook(fns, { body: { challenge: 'abc123' } });
    assert.equal(r.challenge, 'abc123');
  });

  await test('لا تُسجَّل أي قيمة Authorization (ولو جزئياً) — فقط وجودها المنطقي', async () => {
    const secretLookingValue = 'Bearer super-secret-jwt-should-never-appear-in-logs-xyz987';
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    try {
      await callWebhook(fns, { body: { challenge: 'x' }, authorization: secretLookingValue });
    } finally {
      console.log = originalLog;
    }
    const joined = logs.join('\n');
    assert.ok(!joined.includes(secretLookingValue), 'القيمة الكاملة غير موجودة في السجلات');
    assert.ok(!joined.includes(secretLookingValue.slice(0, 16)), 'ولا حتى جزء منها (جذر العطل الذي صحَّحته المراجعة)');
  });

  // =======================================================================
  // الانتقال والتكرار — المنطق الأساسي
  // =======================================================================
  await test('انتقال حقيقي: outcome=transitioned، mondayStatus تحدَّثت، سجل إشعار مستقل بحالة pending', async () => {
    seedTask('TASK-T1', 'ITEM-T1', 'Working');
    const r = await callWebhook(fns, { itemId: 'ITEM-T1', statusText: 'Done' });
    assert.equal(r.outcome, 'transitioned');
    const task = getTask('TASK-T1');
    assert.equal(task.mondayStatus, 'Done');
    const notif = getNotif(task.latestNotificationId);
    assert.ok(notif);
    assert.equal(notif.status, 'pending');
    assert.equal(notif.oldStatus, 'Working');
    assert.equal(notif.newStatus, 'Done');
    assert.equal(notif.attempts, 0);
  });

  await test('لا تغيّر (newStatus يطابق mondayStatus الحالية، لا إشعار سابق): outcome=no-change', async () => {
    seedTask('TASK-NC', 'ITEM-NC', 'Done');
    const r = await callWebhook(fns, { itemId: 'ITEM-NC', statusText: 'Done' });
    assert.equal(r.outcome, 'no-change');
    assert.equal(getTask('TASK-NC').latestNotificationId, undefined);
  });

  await test('إعادة إرسال Monday لنفس الحدث بينما الإشعار السابق pending: outcome=already-pending، attempts لا تتغيّر', async () => {
    seedTask('TASK-DUP', 'ITEM-DUP', 'Working');
    await callWebhook(fns, { itemId: 'ITEM-DUP', statusText: 'Done' });
    const notifId = latestNotifId('TASK-DUP');
    const r2 = await callWebhook(fns, { itemId: 'ITEM-DUP', statusText: 'Done' }); // إعادة إرسال
    assert.equal(r2.outcome, 'already-pending');
    assert.equal(latestNotifId('TASK-DUP'), notifId, 'لم يُنشأ سجل إشعار جديد');
    assert.equal(getNotif(notifId).attempts, 0, 'الويب هوك نفسه لا يلمس attempts إطلاقاً');
  });

  await test('عنصر غير موجود: 404', async () => {
    const r = await callWebhook(fns, { itemId: 'NO-SUCH-ITEM', statusText: 'Done' });
    assert.equal(r._status, 404);
  });

  // =======================================================================
  // العطل الأول المُصحَّح: استبدال إشعار سابق بانتقال لاحق (notifyState واحد سابقاً)
  // =======================================================================
  await test('انتقالان مختلفان قبل أن يُرسَل أيٌّ منهما: سجلان مستقلان، لا استبدال لأي منهما', async () => {
    seedTask('TASK-TWO-TRANS', 'ITEM-TWO-TRANS', 'A');
    const r1 = await callWebhook(fns, { itemId: 'ITEM-TWO-TRANS', statusText: 'B' });
    assert.equal(r1.outcome, 'transitioned');
    const notifB = latestNotifId('TASK-TWO-TRANS');

    const r2 = await callWebhook(fns, { itemId: 'ITEM-TWO-TRANS', statusText: 'C' }); // قبل أي إرسال فعلي لـB
    assert.equal(r2.outcome, 'transitioned');
    const notifC = latestNotifId('TASK-TWO-TRANS');

    assert.notEqual(notifB, notifC, 'سجلان مستقلان بمعرّفين مختلفين');
    assert.equal(getNotif(notifB).oldStatus, 'A');
    assert.equal(getNotif(notifB).newStatus, 'B');
    assert.equal(getNotif(notifB).status, 'pending', 'لم يُستبدَل أو يُفقَد بوصول C');
    assert.equal(getNotif(notifC).oldStatus, 'B');
    assert.equal(getNotif(notifC).newStatus, 'C');
    assert.equal(getNotif(notifC).status, 'pending');

    // كلاهما قابل للإرسال فعلياً بشكل مستقل:
    await runNotifier(notifB);
    await runNotifier(notifC);
    assert.equal(getNotif(notifB).status, 'sent');
    assert.equal(getNotif(notifC).status, 'sent');
    assert.equal(getNotif(notifB).newStatus, 'B', 'لم يصبح B مُعلَّماً كأنه C');
    assert.equal(getNotif(notifC).newStatus, 'C');
  });

  await test('انتقال جديد يصل أثناء إرسال انتقال سابق قيد التنفيذ فعلياً (sending): لا يُعلِّم أحدهما الآخر بالخطأ', async () => {
    seedTask('TASK-INTERLEAVE', 'ITEM-IL', 'A');
    const r1 = await callWebhook(fns, { itemId: 'ITEM-IL', statusText: 'B' });
    assert.equal(r1.outcome, 'transitioned');
    const notifB = latestNotifId('TASK-INTERLEAVE');

    let sendMailStartedResolve;
    const sendMailStarted = new Promise((res) => { sendMailStartedResolve = res; });
    let releaseSendMail;
    const sendMailGate = new Promise((res) => { releaseSendMail = res; });
    nodemailerFake.createTransport = () => ({
      sendMail: async () => { sendMailStartedResolve(); await sendMailGate; return {}; },
    });

    let notifierPromise;
    try {
      notifierPromise = runNotifier(notifB); // لا await — يبدأ الحجز (sending) ثم يدخل sendMail ويتوقف
      await sendMailStarted; // الحجز اكتمل فعلياً هنا (status=sending)، sendMail بدأت وتنتظر الإفراج

      assert.equal(getNotif(notifB).status, 'sending', 'الحجز اكتمل قبل وصول الانتقال الجديد');

      // انتقال جديد حقيقي يصل الآن، بينما B لا يزال "قيد الإرسال":
      const r2 = await callWebhook(fns, { itemId: 'ITEM-IL', statusText: 'C' });
      assert.equal(r2.outcome, 'transitioned');
      const notifC = latestNotifId('TASK-INTERLEAVE');
      assert.notEqual(notifC, notifB);
      assert.equal(getNotif(notifC).status, 'pending', 'C مستقل تماماً، لم يُلمَس بإرسال B الجاري');

      // تأكيد أن B لم يُلمَس بوصول C (العطل الذي أثبتته المراجعة: استبدال notifyState الواحد):
      assert.equal(getNotif(notifB).status, 'sending');
      assert.equal(getNotif(notifB).newStatus, 'B');

      releaseSendMail();
      await notifierPromise;
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }

    const notifBFinal = getNotif(notifB);
    assert.equal(notifBFinal.status, 'sent', 'B اكتمل إرساله بنجاح');
    assert.equal(notifBFinal.newStatus, 'B', 'لم يُعلَّم B بالخطأ كأنه C (العطل المُصحَّح هنا تحديداً)');
    assert.equal(notifBFinal.oldStatus, 'A');

    const notifC = getNotif(latestNotifId('TASK-INTERLEAVE'));
    assert.equal(notifC.status, 'pending', 'C لم يُمَس ولم يُعلَّم مُرسَلاً خطأً، لا يزال في انتظار دوره');
  });

  // =======================================================================
  // العطل الثاني المُصحَّح: فشل تسجيل "sent" بعد نجاح SMTP الفعلي يُعامَل كنتيجة ملتبسة،
  // لا كفشل إرسال مؤكَّد — لا يجوز إعادته إلى pending (إرسال مكرر محتمل).
  // =======================================================================
  await test('SMTP ينجح فعلياً، لكن كتابة "sent" تفشل: السجل يبقى عالقاً على sending مع ackFailed=true، ولا يُعاد إلى pending', async () => {
    seedTask('TASK-ACK-FAIL', 'ITEM-ACK-FAIL', 'A');
    await callWebhook(fns, { itemId: 'ITEM-ACK-FAIL', statusText: 'B' });
    const notifId = latestNotifId('TASK-ACK-FAIL');

    let sendMailCalls = 0;
    nodemailerFake.createTransport = () => ({ sendMail: async () => { sendMailCalls++; return {}; } });
    try {
      await runNotifier(notifId, { failOnStatus: 'sent' });
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    assert.equal(sendMailCalls, 1, 'البريد أُرسِل فعلياً مرة واحدة (SMTP نجح من منظور الكود)');

    const notif = getNotif(notifId);
    assert.equal(notif.status, 'sending', 'لم يُعَد إلى pending — ذلك كان يُسبِّب إرسالاً مكرراً (العطل المُصحَّح)');
    assert.equal(notif.ackFailed, true);
    assert.ok(notif.lastError, 'سبب فشل تسجيل sent محفوظ لمراجعة يدوية');

    // تأكيد: لا إعادة محاولة تلقائية لاحقة (status ليست pending، فـonWrite يتجاهل السجل تماماً):
    sendMailCalls = 0;
    nodemailerFake.createTransport = () => ({ sendMail: async () => { sendMailCalls++; return {}; } });
    try {
      await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    assert.equal(sendMailCalls, 0, 'لا إرسال مكرر تلقائي لسجل عالق على sending');
  });

  // =======================================================================
  // العطل الثالث المُصحَّح: ليس كل استثناء من sendMail "فشل إرسال مؤكَّد قبل التسليم".
  // إعادة المحاولة التلقائية مقصورة على دليل واضح (isConfirmedNonDelivery) أن الخادم لم يقبل
  // الرسالة؛ غير ذلك (مهلة/انقطاع اتصال لا يُعرَف أوصل المحتوى أم لا) يُعامَل كملتبس بلا إعادة.
  //
  // ⚠️ مراجعة ثالثة صحَّحت محاولة أولى هنا كانت تعتبر err.code==='ECONNECTION' مؤكَّداً بلا شرط
  // (بفرض أنه يعني فقط "فشل إنشاء الاتصال أصلاً"). هذا خطأ: نسخ/حالات فعلية من
  // nodemailer/smtp-connection تُصدِر ECONNECTION نفسه أيضاً لانقطاعات *أثناء أو بعد* إرسال
  // DATA — فاسم الكود وحده لا يُثبت المرحلة. الاختبارات أدناه تثبت تحديداً أن ECONNECTION
  // بكل أشكاله (أثناء DATA، بعد DATA، أو بلا مرحلة معلومة إطلاقاً) لا يُفعِّل إعادة محاولة
  // تلقائية الآن، وأن EDNS (فشل تحليل DNS، المرحلة الوحيدة التي يستحيل فيها بنيوياً اتصال TCP
  // أصلاً) هو مثال الاستخدام الصحيح للفشل المؤكَّد قبل الاتصال.
  // =======================================================================
  await test('ECONNECTION أثناء/بعد إرسال DATA (الرسالة انتقلت جزئياً أو كلياً فعلاً قبل الانقطاع): ملتبس، لا إعادة إرسال تلقائية', async () => {
    seedTask('TASK-ECONN-DURING-DATA', 'ITEM-ECONN-DURING-DATA', 'A');
    await callWebhook(fns, { itemId: 'ITEM-ECONN-DURING-DATA', statusText: 'B' });
    const notifId = latestNotifId('TASK-ECONN-DURING-DATA');

    let sendMailCalls = 0;
    nodemailerFake.createTransport = () => ({
      sendMail: async () => {
        sendMailCalls++;
        // يُحاكي انقطاعاً وقع بعد أن بدأ العميل إرسال أمر DATA فعلياً — نفس err.code الذي كانت
        // المحاولة الأولى هنا تعتبره "فشل اتصال أولي" بلا شرط؛ الملاحظة التوضيحية duringData
        // هنا لسرد الاختبار فقط، لا يقرأها isConfirmedNonDelivery ولا يجوز أن يعتمد عليها.
        throw makeSmtpError('Connection closed while sending message content', { code: 'ECONNECTION', duringData: true });
      },
    });
    try {
      await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    assert.equal(sendMailCalls, 1, 'استدعاء واحد فقط — لا إعادة محاولة فورية');
    const notif = getNotif(notifId);
    assert.equal(notif.status, 'sending', 'لم يُعَد إلى pending — قد يكون المحتوى قد انتقل فعلياً قبل الانقطاع');
    assert.equal(notif.ackFailed, true);

    sendMailCalls = 0;
    nodemailerFake.createTransport = () => ({ sendMail: async () => { sendMailCalls++; return {}; } });
    try { await runNotifier(notifId); } finally { nodemailerFake.createTransport = originalCreateTransport; }
    assert.equal(sendMailCalls, 0, 'لا إرسال مكرر تلقائي');
  });

  await test('ECONNECTION بلا أي مرحلة معلومة (لا نعرف متى حدث الانقطاع): ملتبس أيضاً، لا إعادة إرسال تلقائية', async () => {
    seedTask('TASK-ECONN-UNKNOWN', 'ITEM-ECONN-UNKNOWN', 'A');
    await callWebhook(fns, { itemId: 'ITEM-ECONN-UNKNOWN', statusText: 'B' });
    const notifId = latestNotifId('TASK-ECONN-UNKNOWN');

    nodemailerFake.createTransport = () => ({
      sendMail: async () => { throw makeSmtpError('connection closed', { code: 'ECONNECTION' }); }, // لا دليل إضافي على المرحلة إطلاقاً
    });
    try {
      await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    const notif = getNotif(notifId);
    assert.equal(notif.status, 'sending', 'ECONNECTION وحده، بلا دليل مرحلة، لا يكفي للتصنيف كمؤكَّد — يبقى ملتبساً بالافتراض الأكثر حذراً');
    assert.equal(notif.ackFailed, true);
  });

  await test('err.responseCode=250 (رمز نجاح، لا رفض) على كائن استثناء: لا يُثبت رفضاً، ملتبس، لا إعادة إرسال تلقائية', async () => {
    seedTask('TASK-RESPCODE-250', 'ITEM-RESPCODE-250', 'A');
    await callWebhook(fns, { itemId: 'ITEM-RESPCODE-250', statusText: 'B' });
    const notifId = latestNotifId('TASK-RESPCODE-250');

    nodemailerFake.createTransport = () => ({
      // حالة شاذة عمداً (250 يعني نجاحاً في SMTP، لا رفضاً) — تختبر أن الفحص يتحقق من النطاق
      // 400-599 فعلياً، لا typeof==='number' وحدها فقط.
      sendMail: async () => { throw makeSmtpError('unexpected error with a success-looking code', { responseCode: 250 }); },
    });
    try {
      await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    const notif = getNotif(notifId);
    assert.equal(notif.status, 'sending', '250 خارج نطاق الرفض 400-599 — لا يُعامَل كمؤكَّد');
    assert.equal(notif.ackFailed, true);
  });

  await test('err.responseCode=NaN: قيمة غير صالحة، لا تُثبت رفضاً، ملتبس، لا إعادة إرسال تلقائية', async () => {
    seedTask('TASK-RESPCODE-NAN', 'ITEM-RESPCODE-NAN', 'A');
    await callWebhook(fns, { itemId: 'ITEM-RESPCODE-NAN', statusText: 'B' });
    const notifId = latestNotifId('TASK-RESPCODE-NAN');

    nodemailerFake.createTransport = () => ({
      sendMail: async () => { throw makeSmtpError('malformed response code', { responseCode: NaN }); },
    });
    try {
      await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    const notif = getNotif(notifId);
    assert.equal(notif.status, 'sending', 'NaN ليس عدداً صحيحاً صالحاً — Number.isInteger ترفضه، لا typeof==="number" وحدها (NaN من نوع number في JS)');
    assert.equal(notif.ackFailed, true);
  });

  await test('فشل مؤكَّد قبل أي اتصال (err.code=EDNS — فشل تحليل DNS نفسه) ثم نجاح إعادة المحاولة: البريد يُرسَل مرة واحدة بالضبط عند النجاح، text فقط بلا HTML', async () => {
    seedTask('TASK-RETRY', 'ITEM-RETRY', 'A');
    await callWebhook(fns, { itemId: 'ITEM-RETRY', statusText: '<script>alert(1)</script>' });
    const notifId = latestNotifId('TASK-RETRY');

    nodemailerFake.createTransport = () => ({
      sendMail: async () => { throw makeSmtpError('getaddrinfo ENOTFOUND smtp.office365.com', { code: 'EDNS' }); },
    });
    try {
      await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    let notif = getNotif(notifId);
    assert.equal(notif.status, 'pending', 'EDNS — لا اتصال TCP بدأ بنيوياً أصلاً — آمن إعادته إلى pending');
    assert.equal(notif.attempts, 1);
    assert.ok(notif.lastError.includes('ENOTFOUND'));
    assert.equal(notif.ackFailed, false, 'هذا فرع مؤكَّد، لا ملتبس — ackFailed تبقى false');

    let sentPayload = null;
    nodemailerFake.createTransport = () => ({ sendMail: async (opts) => { sentPayload = opts; return {}; } });
    try {
      await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    notif = getNotif(notifId);
    assert.equal(notif.status, 'sent');
    assert.equal(notif.attempts, 2);
    assert.ok(sentPayload, 'البريد أُرسِل فعلياً عند إعادة المحاولة');
    assert.equal(sentPayload.html, undefined, 'لا حقل html إطلاقاً');
    assert.ok(sentPayload.text.includes('<script>alert(1)</script>'), 'القيمة الخام محفوظة كما هي في text بلا أي تفسير HTML');
  });

  await test('رفض SMTP صريح (err.responseCode=550: حوار تم فعلاً، الخادم ردّ برفضه، ضمن نطاق 400-599) يُعامَل أيضاً كمؤكَّد — إعادة المحاولة تعمل', async () => {
    seedTask('TASK-RESPCODE', 'ITEM-RESPCODE', 'A');
    await callWebhook(fns, { itemId: 'ITEM-RESPCODE', statusText: 'B' });
    const notifId = latestNotifId('TASK-RESPCODE');

    nodemailerFake.createTransport = () => ({
      sendMail: async () => { throw makeSmtpError('550 5.1.1 mailbox unavailable', { responseCode: 550 }); },
    });
    try {
      await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    const notif = getNotif(notifId);
    assert.equal(notif.status, 'pending', 'رد SMTP رقمي صريح وصل فعلاً (حتى لو رفضاً) — مؤكَّد، لا ملتبس');
    assert.equal(notif.ackFailed, false);
  });

  await test('خطأ ملتبس (err.code=ETIMEDOUT، بلا responseCode: لا يُعرَف أوصلت الرسالة للخادم قبل انقطاع المهلة أم لا): لا إعادة إرسال تلقائية — يبقى عالقاً لمراجعة يدوية', async () => {
    seedTask('TASK-AMBIG-SEND', 'ITEM-AMBIG-SEND', 'A');
    await callWebhook(fns, { itemId: 'ITEM-AMBIG-SEND', statusText: 'B' });
    const notifId = latestNotifId('TASK-AMBIG-SEND');

    let sendMailCalls = 0;
    nodemailerFake.createTransport = () => ({
      sendMail: async () => {
        sendMailCalls++;
        // يُحاكي بالضبط "قُبِلت الرسالة من حيث استلام الخادم للمحتوى، ثم ضاع تأكيد القبول قبل
        // أن يصل رد 250 النهائي للعميل" — لا فرق ظاهري لعميل nodemailer بين هذا وبين عدم وصول
        // شيء للخادم إطلاقاً؛ كلاهما يظهران كمهلة/انقطاع اتصال بلا رد صريح.
        throw makeSmtpError('Timeout waiting for final response', { code: 'ETIMEDOUT' });
      },
    });
    try {
      await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    assert.equal(sendMailCalls, 1, 'استدعاء واحد فقط — لا إعادة محاولة تلقائية فورية');

    const notif = getNotif(notifId);
    assert.equal(notif.status, 'sending', 'لم يُعَد إلى pending — قد تكون الرسالة وصلت فعلاً، إعادة الإرسال تلقائياً قد تُكرِّرها');
    assert.equal(notif.ackFailed, true, 'عُلِّم كنتيجة ملتبسة تحتاج مراجعة يدوية، تماماً كفشل تسجيل sent');
    assert.ok(notif.lastError.includes('Timeout'));

    // تأكيد: لا إعادة محاولة تلقائية لاحقة (status ليست pending، فـonWrite يتجاهل السجل تماماً) —
    // هذا هو إثبات "عدم إعادة إرسالها تلقائياً" المطلوب تحديداً:
    sendMailCalls = 0;
    nodemailerFake.createTransport = () => ({ sendMail: async () => { sendMailCalls++; return {}; } });
    try {
      await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    assert.equal(sendMailCalls, 0, 'لا إرسال مكرر تلقائي لسجل ملتبس عالق على sending — نفس سلوك فشل تسجيل sent بالضبط');
  });

  await test('المحاولة الخامسة من فشل مؤكَّد متكرر (EDNS): status=failed نهائياً، تتوقف الحلقة', async () => {
    seedTask('TASK-MAXFAIL', 'ITEM-MAXFAIL', 'A');
    await callWebhook(fns, { itemId: 'ITEM-MAXFAIL', statusText: 'B' });
    const notifId = latestNotifId('TASK-MAXFAIL');
    nodemailerFake.createTransport = () => ({
      sendMail: async () => { throw makeSmtpError('still down', { code: 'EDNS' }); },
    });
    try {
      for (let i = 0; i < 5; i++) await runNotifier(notifId);
    } finally {
      nodemailerFake.createTransport = originalCreateTransport;
    }
    const notif = getNotif(notifId);
    assert.equal(notif.attempts, 5);
    assert.equal(notif.status, 'failed');
  });

  console.log(`\n== النتيجة: ${passed}/${passed} نجح، 0 فشل ==`);
})().catch((err) => { console.error('FAILED:', err); process.exit(1); });
