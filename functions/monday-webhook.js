/* =========================================================================
   Cloud Function — ويب هوك إشعارات Monday.com (monday-webhook)
   ---------------------------------------------------------------------------
   يستقبل تحديثات حالة من Monday.com (تغيّر عمود الحالة على عنصر/pulse)، يحدّث
   mondayTaskQueue بالحالة الجديدة (حقل عرض لا يقرأه أي كود آخر في هذا المستودع
   حالياً)، ويُنشئ سجل إشعار مستقل لكل انتقال فعلي — الإرسال الفعلي يتم من دالة
   منفصلة تماماً (mondayStatusNotifyOnQueueWrite أدناه)، لا من هذه الدالة نفسها.

   هذا امتداد منفصل عن functions/monday-sync.js (الاتصال الصادر الموثَّق،
   "المرحلة التاسعة") — لم يكن مُلتزَماً به بـgit من الأساس (كان على القرص فقط،
   خارج أي فرع، منذ 15 سبتمبر). هذا الإصلاح يضيفه للمستودع ضمن حزمة مستقلة
   تماماً عن مرحلة 2R-4E، بعد ثلاث مراجعات خارجية متتالية صحَّحت ثلاثة إصدارات
   سابقة (انظر الفقرة (ج) أدناه للتفصيل الكامل).

   ========================================================================
   (أ) تحقّق مصدر الطلب — بحث في وثائق Monday.com الرسمية ومجتمعها (2022–2026،
       آخر تحديث مُراجَع يوليو 2026):
   ========================================================================
   Monday.com **لا توفّر** أي توقيع HMAC أو Authorization header موثَّق لهذا
   النوع من الويب هوك (الذي يُنشأ من Integrations Center بصيغة "عند تغيّر
   الحالة أرسل webhook"، ويُصادق بمصافحة {challenge} عند التسجيل فقط — هذا هو
   النوع المستخدم هنا بالضبط، يتطابق شكل الحمولة {event:{pulseId,value:{label:
   {text}}}} مع هذا النوع تحديداً، لا مع "monday Apps" ذات JWT الموثَّق).
   التوثيق الرسمي لـJWT/Authorization header (developer.monday.com/apps/docs/
   authorization-header) يصف فقط الطلبات الواردة لتطبيقات Monday Apps
   (custom app actions)، لا تسليم الويب هوك العادي. ردود طاقم Monday في منتدى
   المطوّرين (مثلاً developer-community.monday.com، 2022) تؤكد: "the challenge
   ... only when I register the webhook, not when it triggers" — أي لا تحقّق
   مستمر بعد التسجيل. دليل Hookdeck المُحدَّث يوليو 2026 يذكر صريحاً: "Monday
   does not support HMAC signature verification for webhooks created via the
   UI or with personal API tokens"، ويوصي بالضبط بما طُبِّق هنا: رمز سري ضمن
   رابط الويب هوك نفسه (secret token in the path/query).
   ⚠️ هذا بحث وليس تأكيداً من إعدادات Monday الفعلية لحساب الصندوق — إن كان
   هذا الويب هوك مُسجَّلاً فعلياً عبر create_webhook GraphQL API (لا واجهة
   Integrations Center) فقد تصل بعض الطلبات بـAuthorization header إضافي
   (shortLivedToken لتطبيقات Apps Framework فقط حسب نفس البحث، فالأرجح لا
   ينطبق هنا). لا نسجّل محتوى هذه الترويسة إطلاقاً (مراجعة ثانية صحّحت تسجيل
   جزء من قيمتها في إصدار سابق — قيمة Authorization ولو جزئياً تبقى بيانات
   حساسة لا يجوز كتابتها في سجلات التشغيل) — فقط نسجّل قيمة منطقية: هل وردت
   هذه الترويسة في هذا الطلب أم لا، لمراجعة مستقبلية بلا أي اعتماد عليها في
   قرار القبول/الرفض. الحماية الفعلية والوحيدة المضمونة هنا: رمز سري
   (MONDAY_WEBHOOK_TOKEN من Secret Manager) يُرفَض أي طلب بلا تطابقه معه،
   بمقارنة زمن ثابت.

   ========================================================================
   (ب) الصلاحيات — Admin SDK فقط، لا تعديل على firestore.rules المهيَّأة فعلاً
       ضمن حزمة 2R-4E (رُفع هذا القيد عمداً دون المساس بها):
   ========================================================================
   mondayTaskQueue: firestore.rules (راجع السطور 192-199 فيه) تمنع أي تحديث/حذف
   عميل على هذه المجموعة تماماً (allow update, delete: if false)، والإنشاء
   مقصور على مدير صندوق فأعلى بشرط status=='pending' — القيد الحقيقي هنا هو
   (أ) أعلاه (رمز الويب هوك)، لا قواعد Firestore نفسها.
   mondayNotificationQueue (مجموعة جديدة مستقلة، أدناه): مطابقة `/mondayTaskQueue/{id}`
   في القواعد **غير تكرارية** (بلا `{id=**}`)، فلا تغطي هذه المجموعة الجديدة
   أصلاً، ولا يوجد في firestore.rules أي قاعدة شاملة أخرى (`match /{document=**}`)
   قد تغطيها بالخطأ (تم التحقّق من هذا بقراءة الملف كاملاً). غياب أي قاعدة
   مطابقة = رفض تلقائي كامل (قراءة وكتابة) من أي عميل بتصميم Firestore نفسه،
   بلا حاجة لإضافة أي سطر جديد لـfirestore.rules (الذي هو جزء من ملفات 4E
   العشرين المهيأة فعلاً، ولا يجوز لمسه في هذه الحزمة المستقلة). فقط Admin SDK
   (هذا الملف ومُرسِله) يستطيع قراءتها أو كتابتها.

   ========================================================================
   (ج) منع تكرار الإشعار وفصل حالاته — تاريخ الإصلاح الكامل لهذه الدالة:
   ========================================================================
   • الإصدار الأول (الأصلي، غير المُلتزَم به بـgit): oldStatus===newStatus كشرط
     وحيد لمنع التكرار، والإرسال داخل معاملة الويب هوك نفسها. مراجعة خارجية
     أولى أثبتت بالاعتماديات الوهمية: (1) طلبان متزامنان متطابقان كلاهما يرسل
     بريداً، (2) تحديث الحالة ثم فشل البريد يُفقِد الإشعار.
   • الإصدار الثاني: معاملة Firestore واحدة للتسجيل، وحالة إشعار واحدة
     (notifyState) على حقل واحد في وثيقة المهمة. مراجعة خارجية ثانية شغَّلت
     الملف وأثبتت عطلين، كلاهما ناتج عن حقل notifyState الواحد القابل
     للاستبدال: (2-أ) إشعار قيد الإرسال يُعلَّم بالخطأ كمُرسَل لإشعار لاحق
     استبدله، (2-ب) فشل تسجيل 'sent' بعد نجاح SMTP كان يُعامَل كفشل إرسال،
     فيُعاد 'pending' فيُعاد الإرسال فعلياً — بريد مكرر.
   • الإصدار الثالث: أصلح (2-أ) بمجموعة mondayNotificationQueue (سجل مستقل
     بمعرّف ثابت لكل انتقال، لا حقل واحد مُشارَك)، وأصلح (2-ب) بتفريق try/catch
     بين فشل transporter.sendMail نفسها وفشل كتابة 'sent' اللاحق لنجاح SMTP
     فعلياً (الأخير يُعلَّم ackFailed=true بلا إعادة لـ'pending'). مراجعة خارجية
     ثالثة شغَّلت هذا الإصدار الثالث نفسه وأثبتت عطلاً متبقياً، أدق من (2-ب):
       (3) **ليس كل استثناء من sendMail يعني "لم يُرسَل بريد قطعاً"**. الإصدار
           الثالث كان يُعامِل أي خطأ من transporter.sendMail — بما فيها مهلة
           اتصال (timeout) أو انقطاع اتصال (socket/connection reset) لا يمكن
           تحديد المرحلة التي حدث فيها — كفشل إرسال مؤكَّد، فيُعيد الحالة إلى
           'pending' ويُعيد المحاولة تلقائياً. لكن توقّف الاتصال *بعد* أن استلم
           الخادم الرسالة كاملة فعلاً وبدأ معالجتها، *قبل* أن يصل ردّ القبول
           النهائي (250 OK) للعميل، يُنتج هذا الاستثناء نفسه — فلا فرق ظاهري
           بين "لم يُرسَل شيء إطلاقاً" و"أُرسِل فعلاً، فقط ضاع التأكيد"، وإعادة
           المحاولة تلقائياً في الحالة الثانية تعني بريداً مكرراً — بالضبط نفس
           فئة عطل (2-ب) لكن من طبقة SMTP نفسها لا من طبقة كتابة Firestore.

   • الإصدار الرابع (هذا الملف، الحالي): يُصلح (3) بتصنيف صريح لأخطاء sendMail
     عبر isConfirmedNonDelivery() أدناه — إعادة المحاولة التلقائية ('pending')
     مقصورة على حالتين فقط، وهما الحالتان الوحيدتان اللتان لا تحتاجان معرفة
     *مرحلة* حدوث الفشل فعلياً لإثبات عدم القبول (مراجعة ثالثة صحَّحت محاولة
     أولى هنا كانت تضيف حالة ثالثة خاطئة — انظر التنبيه أدناه):
       (أ) رد SMTP رقمي وصل فعلاً من الخادم **ضمن نطاق الرفض الحقيقي 400-599
           تحديداً** (err.responseCode، بفحص صريح للنطاق والصحة الرقمية، لا
           typeof==='number' وحدها) — رقم مثل 250 (نجاح) أو NaN لا يُثبتان
           رفضاً مهما كان مصدرهما، فلا يُعامَلان كمؤكَّدين.
       (ب) فشل تحليل DNS نفسه تحديداً (err.code==='EDNS') — المرحلة الوحيدة
           التي يستحيل فيها بنيوياً أن يبدأ أي اتصال TCP أصلاً، في أي نسخة من
           nodemailer/smtp-connection؛ لا حوار SMTP وقع بتاتاً فلا يمكن لأي
           محتوى أن يكون قد انتقل.
     ⚠️ **ECONNECTION عُزِل عمداً من هذه القائمة**: محاولة أولى لهذا الإصدار
     الرابع ضمَّته كحالة مؤكَّدة (بفرض أنه يعني "فشل إنشاء الاتصال أصلاً" فقط)
     — خطأ صحَّحته مراجعة ثالثة: هذا الكود تُصدِره أكثر من نسخة/حالة فعلية من
     nodemailer/smtp-connection أيضاً لانقطاعات تحدث *أثناء أو بعد* إرسال أمر
     DATA نفسه (أي بعد أن يكون محتوى الرسالة قد انتقل فعلياً، أو جزء منه)، لا
     فقط فشل إنشاء الاتصال الأولي قبل أي حوار. اسم الكود وحده لا يُثبت مرحلة
     الفشل بلا فحص فعلي لسلوك نسخة nodemailer المثبَّتة تحديداً (رقم الإصدار،
     سلوك smtp-connection الداخلي) — وهذا الملف لا يقوم بذلك الفحص، فيُعامَل
     ECONNECTION بكل أشكاله كملتبس افتراضياً حتى يُثبَت العكس بدليل فعلي من
     سلوك النسخة المثبَّتة، لا بافتراضه من اسم الكود.
     أي خطأ آخر غير (أ)/(ب) — ECONNECTION بكل أشكاله، مهلة انتظار الرد
     (ETIMEDOUT)، خطأ مقبس/TLS (ESOCKET)، أو أي استثناء غير مصنَّف — يُعامَل
     كنتيجة **ملتبسة**: لا نعرف أوصلت الرسالة أم لا، فلا يجوز إعادة المحاولة
     تلقائياً (قد تكون قد وصلت فعلاً). يُعلَّم السجل بـackFailed=true ويبقى
     عالقاً على 'sending' لمراجعة يدوية — تماماً نفس المعالجة المطبَّقة على
     فشل تسجيل 'sent' في (2-ب)، فالسياسة متّسقة في كل نقطة ملتبسة بالملف.

   ========================================================================
   (د) حد "بريد واحد بالضبط" — لا نضمنه، ونُوثِّقه بوضوح هنا:
   ========================================================================
   ⚠️ سجل إشعار ينتهي عالقاً على 'sending' (ackFailed=true) — سواء بسبب فشل
   تسجيل 'sent' بعد نجاح SMTP مؤكَّد، أو بسبب خطأ sendMail ملتبس المرحلة (انظر
   (ج)(3) أعلاه) — لا تُعاد معالجته تلقائياً إطلاقاً. لا أداة "فحص دوري للسجلات
   العالقة" مُضافة في هذا الإصلاح. مراجعته والتعامل معه (تأكيد وصول البريد
   يدوياً من صندوق saeed@opalco.sa، ثم تصحيح الحالة يدوياً إلى 'sent' أو
   'failed' بحسب الواقع) مسؤولية تشغيلية يدوية حالياً، ومُقترَحة كعمل مستقبلي
   إن احتُجت فعلاً.
   ========================================================================= */
const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const v1Functions = require('firebase-functions/v1');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const nodemailer = require('nodemailer');

const db = getFirestore();
const QUEUE_COLLECTION = 'mondayTaskQueue';
const NOTIFICATIONS_COLLECTION = 'mondayNotificationQueue';
const MONDAY_NOTIFY_MAX_ATTEMPTS = 5;

function isAuthorizedWebhookCall(req) {
  const expected = process.env.MONDAY_WEBHOOK_TOKEN || '';
  if (!expected) return false; // لا سرّ مُعدَّد = رفض كل الطلبات، لا سماح افتراضي أبداً
  const provided = String((req.query && req.query.token) || req.get('X-Monday-Webhook-Token') || '');
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // timingSafeEqual يتطلب طولاً متساوياً مسبقاً
  return crypto.timingSafeEqual(a, b);
}

// يُسجِّل فقط *وجود* ترويسة Authorization من عدمه (قيمة منطقية) — لا جزء من محتواها إطلاقاً.
// انظر الفقرة (أ) أعلاه — لا اعتماد عليها في قرار القبول/الرفض، تسجيل تشخيصي بحت.
function logAuthorizationHeaderPresence(req) {
  const present = Boolean(req.get && req.get('Authorization'));
  if (present) console.log('[monday-webhook] Authorization header present on this delivery (value not logged; not verified).');
}

// دليل واضح أن خادم SMTP لم يقبل الرسالة — انظر الفقرة (ج)(3)/(الإصدار الرابع) أعلاه للتفصيل
// الكامل، وتحديداً تنبيه استثناء ECONNECTION عمداً (مراجعة ثالثة صحَّحت محاولة أولى كانت تعتبره
// مؤكَّداً بلا شرط — هذا الكود يظهر أيضاً لانقطاعات أثناء/بعد إرسال DATA في نسخ فعلية من
// nodemailer، لا فقط فشل الاتصال الأولي، فاسم الكود وحده لا يُثبت المرحلة). أي خطأ لا يطابق
// أحد الشرطين أدناه بالضبط — ECONNECTION بكل أشكاله بينها — يُعامَل كملتبس عمداً (افتراضي أكثر
// حذراً عند الشك)، لا كمؤكَّد.
function isConfirmedNonDelivery(err) {
  if (!err) return false;
  // (أ) رد SMTP رقمي وصل فعلاً من الخادم، ضمن نطاق ردود الرفض الحقيقي فقط (400 تنبيه مؤقت وحتى
  // 599 أعلى رفض نهائي) — فحص صريح للنطاق والصحة الرقمية، لا typeof==='number' وحدها: رقم مثل
  // 250 (نجاح) أو NaN لا يُثبتان رفضاً مهما كان مصدرهما على كائن الاستثناء.
  if (Number.isInteger(err.responseCode) && err.responseCode >= 400 && err.responseCode <= 599) return true;
  // (ب) فشل تحليل DNS نفسه تحديداً — المرحلة الوحيدة التي يستحيل فيها بنيوياً أن يبدأ أي اتصال
  // TCP أصلاً، في أي نسخة من nodemailer/smtp-connection. (ECONNECTION عمداً غير مُدرَج هنا.)
  if (err.code === 'EDNS') return true;
  return false;
}

exports.mondayWebhook = onRequest({ secrets: ['MONDAY_WEBHOOK_TOKEN'] }, async (req, res) => {
  if (!isAuthorizedWebhookCall(req)) {
    return res.status(401).send('Unauthorized');
  }
  logAuthorizationHeaderPresence(req);
  if (req.body && req.body.challenge) return res.json({ challenge: req.body.challenge });

  try {
    const event = req.body && req.body.event;
    if (!event) return res.status(400).send('No event');
    const itemId = String(event.pulseId || event.itemId || '');
    const newStatus = event.value && event.value.label && event.value.label.text;
    if (!itemId || !newStatus) return res.status(400).send('Missing data');

    const outcome = await db.runTransaction(async (tx) => {
      const query = db.collection(QUEUE_COLLECTION).where('mondayItemId', '==', itemId).limit(1);
      const snap = await tx.get(query);
      if (snap.empty) return { status: 404 };

      const doc = snap.docs[0];
      // نبني مرجع وثيقة المهمة من doc.id عبر collection().doc(id) عمداً، لا من doc.ref مباشرة —
      // محاكيات الاختبار البنيوية لا تضيف .ref لنتائج الاستعلامات؛ البناء من id أكثر قابلية للنقل.
      const docRef = db.collection(QUEUE_COLLECTION).doc(doc.id);
      const data = doc.data();
      const oldStatus = data.mondayStatus || '';

      if (oldStatus !== newStatus) {
        // انتقال حقيقي جديد — سجل إشعار مستقل خاص به وحده، بمعرّف تلقائي ثابت، لا يُشارَك مع أي
        // انتقال آخر سابق أو لاحق. معاملات Firestore تُسلسِل القراءة-ثم-الكتابة المتنازعة على
        // وثيقة المهمة تلقائياً (تحل سباق الطلبين المتزامنين)، وتفرّد سجل الإشعار نفسه يحل عطل
        // "الاستبدال" الموصوف في الفقرة (ج) أعلاه بشكل مستقل تماماً عن مسألة التزامن.
        const notifRef = db.collection(NOTIFICATIONS_COLLECTION).doc();
        tx.set(notifRef, {
          taskId: doc.id,
          mondayItemId: itemId,
          oldStatus,
          newStatus,
          status: 'pending',
          attempts: 0,
          lastError: null,
          ackFailed: false,
          createdAt: FieldValue.serverTimestamp(),
          sentAt: null,
        });
        tx.update(docRef, {
          mondayStatus: newStatus,
          mondayStatusUpdatedAt: new Date().toISOString(),
          latestNotificationId: notifRef.id,
        });
        return { status: 200, outcome: 'transitioned', notificationId: notifRef.id };
      }

      // لا تغيّر في mondayStatus — تحقّق مما إذا كان آخر إشعار مسجَّل يخص هذه الحالة نفسها ولم
      // يُرسَل بعد (إعادة إرسال Monday لنفس الحدث، أو الخاسر في سباق تزامن فاز به طلب آخر بالفعل)؛
      // latestNotificationId مؤشّر لمنع التكرار فقط، لا هدف لأي كتابة من المُرسِل إطلاقاً.
      const latestId = data.latestNotificationId;
      if (latestId) {
        const latestRef = db.collection(NOTIFICATIONS_COLLECTION).doc(latestId);
        const latestSnap = await tx.get(latestRef);
        if (latestSnap.exists) {
          const latest = latestSnap.data();
          if (latest.newStatus === newStatus && latest.status !== 'sent') {
            return { status: 200, outcome: 'already-pending' };
          }
        }
      }
      return { status: 200, outcome: 'no-change' };
    });

    if (outcome.status === 404) return res.status(404).send('Item not found');
    return res.json({ ok: true, outcome: outcome.outcome });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Error');
  }
});

// =========================================================================
// الإرسال الفعلي — منفصل تماماً عن معاملة الويب هوك أعلاه، v1 Firestore trigger على مجموعة
// mondayNotificationQueue (لا v2/onDocumentWritten — نفس القرار المُتَّخذ محلياً لـ
// mirrorOpportunityAuditLog أعلى هذا الملف، للتوافق الفعلي مع خطة النشر؛ ونفس نمط
// monday-sync.js: runWith({secrets}).firestore.document(...).onWrite(...)). يُستدعى مرة واحدة
// لكل وثيقة إشعار بعينها عبر مرجعها الخاص — لا يلمس أبداً وثيقة المهمة نفسها أو أي إشعار آخر.
// =========================================================================
exports.mondayStatusNotifyOnQueueWrite = v1Functions
  .runWith({ secrets: ['OUTLOOK_PASSWORD'] })
  .firestore.document(`${NOTIFICATIONS_COLLECTION}/{notificationId}`)
  .onWrite(async (change, _context) => {
    const after = change.after && change.after.exists ? change.after : null;
    if (!after) return; // حذف الوثيقة — لا شيء لإرساله
    const afterData = after.data();
    if (!afterData || afterData.status !== 'pending') return;

    // خطوة "الحجز" — معاملة منفصلة قصيرة، بلا أي I/O شبكي بداخلها، تمنع استدعاءين متزامنين لهذه
    // الدالة نفسها (نادر لكنه ممكن في Cloud Functions) من محاولة الإرسال معاً لنفس السجل.
    const claimed = await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(after.ref);
      if (!freshSnap.exists) return null;
      const fresh = freshSnap.data();
      if (!fresh || fresh.status !== 'pending') return null;
      const nextAttempts = (fresh.attempts || 0) + 1;
      tx.update(after.ref, { status: 'sending', attempts: nextAttempts });
      return { oldStatus: fresh.oldStatus, newStatus: fresh.newStatus, attempts: nextAttempts };
    });
    if (!claimed) return; // لم نفز بالحجز (مُعالَج بالفعل، أو حالة غير pending)

    let sendErr = null;
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.office365.com',
        port: 587,
        secure: false,
        auth: { user: 'saeed@opalco.sa', pass: process.env.OUTLOOK_PASSWORD },
      });
      await transporter.sendMail({
        from: 'saeed@opalco.sa',
        to: 'saeed@opalco.sa',
        subject: 'تحديث حالة المهمة',
        // نص فقط (لا HTML) — القيمتان نصّان يصلان أصلاً من Monday.com عبر هذا الويب هوك المحمي
        // برمز سري، فلا حاجة لتضمينهما داخل HTML يحتاج تهريباً إضافياً.
        text: 'الحالة الجديدة: ' + claimed.newStatus + '\nالحالة القديمة: ' + claimed.oldStatus,
      });
    } catch (err) {
      sendErr = err;
    }

    if (sendErr) {
      if (isConfirmedNonDelivery(sendErr)) {
        // دليل واضح أن الخادم لم يقبل الرسالة — انظر isConfirmedNonDelivery أعلاه. آمن تماماً
        // إعادة المحاولة؛ هذا هو الفرع الوحيد الذي يجوز له إعادة الحالة إلى 'pending'.
        console.error('[monday-webhook] notify send failed — confirmed the server did not accept the message (safe to retry):', sendErr);
        const terminal = claimed.attempts >= MONDAY_NOTIFY_MAX_ATTEMPTS;
        try {
          await after.ref.update({
            status: terminal ? 'failed' : 'pending',
            lastError: String((sendErr && sendErr.message) || sendErr),
          });
        } catch (writeErr) {
          console.error('[monday-webhook] failed to record the confirmed send failure itself:', writeErr);
        }
        return;
      }

      // نتيجة ملتبسة: خطأ مهلة/انقطاع اتصال لا يمكن تحديد مرحلة حدوثه بثقة (قد يكون الخادم استلم
      // الرسالة كاملة فعلاً قبل أن يضيع تأكيد القبول) — لا يجوز معاملته كفشل إرسال مؤكَّد، ولا
      // إعادة المحاولة تلقائياً (قد يُرسِل بريداً مكرراً). نُعلِّم السجل ونتركه عالقاً على
      // 'sending' لمراجعة يدوية — نفس سياسة فشل تسجيل 'sent' أدناه بالضبط، اتساقاً كاملاً.
      console.error('[monday-webhook] notify send failed with an ambiguous error (cannot confirm whether the server accepted the message before the error) — left for manual review, not auto-retried:', sendErr);
      try {
        await after.ref.update({
          ackFailed: true,
          lastError: String((sendErr && sendErr.message) || sendErr),
        });
      } catch (writeErr) {
        console.error('[monday-webhook] failed to flag the ambiguous send error itself:', writeErr);
      }
      return;
    }

    // SMTP نجح فعلياً من هنا فصاعداً. أي فشل في الكتابة التالية هو فشل "تسجيل"، لا فشل "إرسال" —
    // نتيجة ملتبسة (قد يكون البريد وصل فعلاً) لا يجوز معاملتها كفشل إرسال مؤكَّد. لا تُعاد الحالة
    // إلى 'pending' هنا بأي شكل (قد يُرسِل بريداً مكرراً لنفس الانتقال)؛ السجل يبقى على 'sending'
    // مع ackFailed=true لمراجعة يدوية. انظر الفقرة (د) أعلاه لحدود هذا الاختيار بوضوح.
    try {
      await after.ref.update({ status: 'sent', sentAt: FieldValue.serverTimestamp() });
    } catch (ackErr) {
      console.error('[monday-webhook] SMTP succeeded but failed to record sent status (ambiguous; left on "sending", not re-queued as unsent):', ackErr);
      try {
        await after.ref.update({
          ackFailed: true,
          lastError: String((ackErr && ackErr.message) || ackErr),
        });
      } catch (ackErr2) {
        console.error('[monday-webhook] also failed to flag ackFailed on the stuck record:', ackErr2);
      }
    }
  });
