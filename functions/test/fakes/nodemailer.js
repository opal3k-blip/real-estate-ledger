/* مطلوبة لأن monday-webhook.js (مُحمَّل من index.js) يستخدم nodemailer لإرسال بريد إشعار — لا
   علاقة لها بـP0. لا نرسل أي بريد فعلي في الاختبار بالطبع. */
function createTransport() { return { sendMail: async () => ({}) }; }
module.exports = { createTransport };
