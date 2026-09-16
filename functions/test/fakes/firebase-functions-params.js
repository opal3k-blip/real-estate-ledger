/* مطلوبة لأن monday-sync.js (مُحمَّل من index.js عبر Object.assign(exports, require('./monday-sync')))
   يستخدم defineSecret('MONDAY_API_TOKEN') — لا علاقة لها بـP0، لكن require('index.js') يحمّلها
   بالتبعية. القيمة الفارغة دوماً مقصودة: أي اختبار P0 لا يجب أن يعتمد فعلياً على قيمة هذا السر. */
function defineSecret(name) { return { name, value: () => '' }; }
module.exports = { defineSecret };
