/* مطلوبة لأن functions/monday-sync.js (محمَّل من index.js عبر Object.assign(exports,
   require('./monday-sync'))) يستورد الحزمة الأساسية require('firebase-functions') مباشرة، بجانب
   المسارات الفرعية v1/v2 المُعترَضة في fakes أخرى — لا علاقة لهذا الاستيراد بطبقة المعاملات
   الموثوقة (P0) إطلاقاً. حالياً هذا الاستيراد غير مُستخدَم فعلياً (متغير محمَّل بلا أي استدعاء
   على `functions.` في monday-sync.js وقت كتابة هذا الملف)، لكنه ملف يعدّله المستخدم بشكل مستقل
   ومتكرر لأغراض Monday.com webhook (شُوهد يتغيّر أكثر من مرة أثناء هذه الجلسة نفسها)، فقد يُستخدَم
   لاحقاً بأي شكل.

   لذلك نرجع هنا Proxy متساهلاً بدل كائن ثابت: أي خاصية غير معروفة تُرجع دالة no-op بدل رمي
   TypeError، حتى لا ينكسر تحميل ملف الاختبار مع كل تعديل مستقبلي غير متوقَّع على monday-sync.js
   تحديداً (ملف خارج نطاق P0 كلياً ولا نلمسه أبداً). الخاصيتان المعروفتان فعلياً (firestore/
   runWith) تُفوَّضان لنفس fake v1 الحقيقي في firebase-functions-v1.js لضمان سلوك متطابق أينما
   استُخدمت الحزمة، سواء عبر المسار الفرعي v1 أو الحزمة الأساسية مباشرة. */
const v1 = require('./firebase-functions-v1');
const known = {
  firestore: v1.firestore,
  runWith: v1.runWith,
  config: () => ({}),
};
module.exports = new Proxy(known, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'symbol' || prop === 'then') return undefined; // ليست Promise/Thenable
    return (..._args) => undefined; // no-op متساهل لأي خاصية أخرى غير متوقَّعة حالياً
  },
});
