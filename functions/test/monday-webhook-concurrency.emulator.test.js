'use strict';
/* =========================================================================
   إصلاح مستقل تماماً عن مرحلة 2R-4E — اعتماد functions/monday-webhook.js المفقود من git
   (كان على القرص منذ 15 سبتمبر، غير مُلتزَم به إطلاقاً). راجع functions/monday-webhook.js
   نفسه للتصميم الكامل وسبب كل قرار فيه (الفقرة ج خصوصاً لتاريخ الإصلاحين السابقين).

   هذا الملف يُثبِت فعلياً (لا منطقياً فقط) بالضد الحقيقي (Firestore Emulator، لا fakes)
   تحديداً أن معاملة Firestore واحدة (لا قراءة ثم كتابة منفصلتين خارج معاملة) تُسلسِل طلبين
   متزامنين حقيقيين بنفس itemId+الحالة، فلا يُنشأ سوى سجل إشعار واحد في mondayNotificationQueue
   (لا اثنان، ولا مفقود) — هذا ما لا يمكن لـfakes إثباته (بلا عزل معاملات حقيقي فيها).

   ⚠️ هذا الملف يختبر تزامن *طلب الويب هوك نفسه فقط* (أكثر من مُنادٍ متزامن حقيقي لـ
   db.runTransaction على وثيقة المهمة نفسها). سيناريوهات التداخل الزمني بين الويب هوك ودالة
   الإرسال (onWrite) — "انتقال جديد أثناء إرسال سابق قيد التنفيذ"، و"فشل تسجيل sent بعد نجاح
   SMTP" — ليست تزامناً حقيقياً بين عمليتين مستقلتين بل تداخلاً زمنياً متحكَّماً به بالكامل من
   الاختبار نفسه ضمن عملية واحدة؛ fakes كافية ومستخدَمة لهما فعلياً في
   functions/test/monday-webhook.unit-test.cjs (انظر تعليق رأس ذلك الملف لتفصيل هذا التمييز).

   يُشغَّل عبر (من جذر المستودع):
     cd tests/rules && npm install   (مرة واحدة كافية)
     firebase emulators:exec --only firestore --project demo-test \
       --config tests/rules/firebase.json \
       "node functions/test/monday-webhook-concurrency.emulator.test.js"
   ========================================================================= */
const assert = require('node:assert/strict');
const { loadIndexAgainstRealEmulator } = require('./load-index-with-real-emulator');

const QUEUE_COLLECTION = 'mondayTaskQueue';
const NOTIF_COLLECTION = 'mondayNotificationQueue';

const TOKEN = 'emulator-test-token-xyz';
process.env.MONDAY_WEBHOOK_TOKEN = TOKEN;

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`OK ${name}`); }

function fakeReq(body) {
  return { query: { token: TOKEN }, body, get() { return null; } };
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
async function callWebhook(fns, itemId, statusText) {
  const req = fakeReq({ event: { pulseId: itemId, value: { label: { text: statusText } } } });
  const res = fakeRes();
  await fns.mondayWebhook(req, res);
  return res._json || { status: res._status, body: res._sent };
}

(async () => {
  const { fns, db } = loadIndexAgainstRealEmulator();

  await test('two genuinely concurrent, byte-identical webhook deliveries for the same transition produce exactly ONE notification record (not two, not a lost one)', async () => {
    const taskId = 'TASK-CONC-1';
    await db.collection(QUEUE_COLLECTION).doc(taskId).set({ mondayItemId: 'ITEM-CONC-1', mondayStatus: 'Working' });

    // لا await بين الطلبين — متزامنان حقيقياً.
    const [r1, r2] = await Promise.all([
      callWebhook(fns, 'ITEM-CONC-1', 'Done'),
      callWebhook(fns, 'ITEM-CONC-1', 'Done'),
    ]);
    const outcomes = [r1.outcome, r2.outcome].sort();
    assert.deepEqual(outcomes, ['already-pending', 'transitioned'], 'أحدهما فقط ينفّذ الانتقال، والآخر يرى أنه مُسجَّل بالفعل — لا اثنان "transitioned"، ولا اثنان مفقودان');

    const taskSnap = await db.collection(QUEUE_COLLECTION).doc(taskId).get();
    const taskData = taskSnap.data();
    assert.equal(taskData.mondayStatus, 'Done');
    assert.ok(taskData.latestNotificationId, 'latestNotificationId مكتوب');

    // الإثبات الحاسم: سجل إشعار واحد فقط لهذه المهمة — لا سجلان من كتابتين متنازعتين (ذلك
    // كان عطل الإصدار الأول قبل المعاملة الواحدة)، ولا سجل واحد مُستبدَل ببيانات خاطئة.
    const notifsSnap = await db.collection(NOTIF_COLLECTION).where('taskId', '==', taskId).get();
    assert.equal(notifsSnap.size, 1, 'سجل إشعار واحد فقط، لا اثنان، لهذا الانتقال');
    const notif = notifsSnap.docs[0].data();
    assert.equal(notif.status, 'pending');
    assert.equal(notif.attempts, 0, 'الويب هوك نفسه لا يلمس attempts إطلاقاً — هذا حقل المُرسِل فقط');
    assert.equal(notif.oldStatus, 'Working');
    assert.equal(notif.newStatus, 'Done');
    assert.equal(notifsSnap.docs[0].id, taskData.latestNotificationId);
  });

  await test('two concurrent deliveries where the task already has a prior PENDING notification (retry window): neither call double-writes, both report a stable outcome, no new notification record is created', async () => {
    const taskId = 'TASK-CONC-2';
    // حالة تُحاكي بالضبط "تحديث الحالة نجح سابقاً، لكن البريد لم يُرسَل بعد (إشعار pending)".
    const notifRef = db.collection(NOTIF_COLLECTION).doc();
    await notifRef.set({
      taskId, mondayItemId: 'ITEM-CONC-2',
      oldStatus: 'Working', newStatus: 'Done', status: 'pending',
      attempts: 1, lastError: 'ECONNECTION simulated SMTP failure', ackFailed: false, sentAt: null,
    });
    await db.collection(QUEUE_COLLECTION).doc(taskId).set({
      mondayItemId: 'ITEM-CONC-2', mondayStatus: 'Done', latestNotificationId: notifRef.id,
    });

    const [r1, r2] = await Promise.all([
      callWebhook(fns, 'ITEM-CONC-2', 'Done'), // إعادة إرسال Monday لنفس الحدث
      callWebhook(fns, 'ITEM-CONC-2', 'Done'),
    ]);
    assert.equal(r1.outcome, 'already-pending');
    assert.equal(r2.outcome, 'already-pending');

    const notifsSnap = await db.collection(NOTIF_COLLECTION).where('taskId', '==', taskId).get();
    assert.equal(notifsSnap.size, 1, 'لا سجل إشعار جديد من أي من الطلبين المتزامنين');
    const notif = notifsSnap.docs[0].data();
    // لا كتابة على الإطلاق من الويب هوك في هذه الحالة — attempts/lastError تبقيان كما كانتا،
    // لأن إعادة المحاولة الفعلية مسؤولية المُرسِل المنفصل (onWrite)، لا الويب هوك.
    assert.equal(notif.attempts, 1, 'لم يُعاد ضبط attempts من الويب هوك — الإشعار المعلّق لم يُفقَد ولم يُستبدَل');
    assert.equal(notif.status, 'pending', 'لا يزال pending — جاهز لمحاولة المُرسِل التالية، لا failed ولا sent زائفة');
  });

  console.log(`\n${passed}/${passed} real-emulator monday-webhook concurrency tests passed.`);
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
