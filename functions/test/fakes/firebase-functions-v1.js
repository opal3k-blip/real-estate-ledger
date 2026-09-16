/* مطلوبة فقط لأن functions/index.js على هذا الجهاز يحمل حالياً تعديلات محلية منفصلة تماماً عن
   P0 (تحويل mirrorOpportunityAuditLog من v2 إلى v1، ومزامنة Monday.com عبر monday-sync.js التي
   تستخدم runWith({secrets:[...]}).firestore.document(...).onCreate(...)) — require('index.js')
   ينفّذ الملف كاملاً من أعلاه لأسفل (ويُحمِّل monday-sync.js بالتبعية)، فيحتاج هذا الاعتراض
   ليغطي كل أشكال استخدام firebase-functions/v1 التي يستخدمها الجهاز فعلياً حالياً، بغضّ النظر
   عن تلك التعديلات المحلية المنفصلة تماماً عن طبقة المعاملات الموثوقة. runWith() هنا مجرد
   تمرير شفاف (لا نتحقق فعلياً من opts.secrets في الاختبار) — القيمة الحقيقية المختبَرة دائماً
   منطق functions/index.js نفسه، لا سلوك أي trigger v1/onCreate/onWrite حقيقي. إن أُزيلت هذه
   التعديلات المحلية لاحقاً، يصبح هذا الملف غير مُستخدَم — بلا ضرر، لا داعي لحذفه فوراً.*/
function onWrite(handler) {
  const wrapped = async (change, context) => handler(change, context);
  wrapped.__isTrigger = true;
  return wrapped;
}
function onCreate(handler) {
  const wrapped = async (snap, context) => handler(snap, context);
  wrapped.__isTrigger = true;
  return wrapped;
}
const firestoreNS = {
  document() { return { onWrite, onCreate }; },
};
function runWith(_opts) {
  return { firestore: firestoreNS };
}
module.exports = { firestore: firestoreNS, runWith };
