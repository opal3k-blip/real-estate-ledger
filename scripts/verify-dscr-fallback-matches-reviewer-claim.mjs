#!/usr/bin/env node
/* تحقق مباشر (لا تعديل) لبند DSCR — استيراد حقيقي لمحرك src/domain/financial/max-acquisition-price.js
   الفعلي الموجود ضمن functions/generated/ في هذا المستودع (نسخة الـbundle المُستخدَمة فعلياً من
   Cloud Functions) — نفس الدوال المُصدَّرة (maxAcquisitionPrice/irrAtPrice)، بلا أي تعديل ولا أي
   محاكاة لمنطق الحساب نفسه؛ فقط دالة compute(trial) اصطناعية بسيطة (IRR وDSCR كدالة خطية في السعر)
   لتشغيل البحث الثنائي الحقيقي ضدها والتحقق من أن DSCR يصبح القيد الحاكم فعلياً حين يكون أضيق. */
import { maxAcquisitionPrice } from '../functions/generated/src/domain/financial/max-acquisition-price.js';

let failures = 0;
function check(name, cond) {
  if (cond) { console.log(`✅ ${name}`); } else { failures++; console.log(`❌ ${name}`); }
}

// compute اصطناعية بسيطة: كلما زاد السعر، نقص IRR ونقص DSCR (علاقة معقولة اقتصادياً) —
// الهدف فقط تحريك البحث الثنائي الحقيقي، لا اختبار صحة نموذج تمويل حقيقي.
function makeSyntheticCompute({ irrAt0, irrSlopePer100, dscrAt0, dscrSlopePer100 }) {
  return (trial) => {
    const price = trial.land.price || 0;
    return {
      equityIRR: irrAt0 - irrSlopePer100 * (price / 100),
      dscrMin: dscrAt0 - dscrSlopePer100 * (price / 100),
    };
  };
}

// ========== الحالة ١: المعامل الرابع (targetDSCR) غائب كلياً — كما كل نقاط الاستخدام الفعلية ==========
// dscrMin الحاكم على الفرصة (d.criteria.dscrMin) = 1.2 — هو ما يجب أن يُستخدَم تلقائياً بدل القيمة الفارغة.
{
  const d = { land: { price: 50 }, criteria: { irrMin: 0.15, dscrMin: 1.2 } };
  // IRR ينخفض بالتدريج (يبقى فوق 15% حتى سعر مرتفع نسبياً)، DSCR ينخفض بشكل أسرع (يصطدم بـ1.2 أولاً).
  const compute = makeSyntheticCompute({ irrAt0: 0.40, irrSlopePer100: 0.08, dscrAt0: 2.0, dscrSlopePer100: 0.30 });

  const targetIRR = d.criteria.irrMin; // كما تستدعيه كل نقاط الاستخدام الفعلية (negotiation.js وغيرها)
  const res = maxAcquisitionPrice(compute, d, targetIRR); // << بلا معامل رابع — بالضبط كما في كل نقاط الاستخدام الحقيقية

  check('المعامل الرابع غائب، لكن res.targetDSCR أصبح 1.2 تلقائياً (لا null) — التعيين التلقائي يعمل فعلياً', res.targetDSCR === 1.2);
  check('bindingConstraint أصبح "dscr" فعلياً — القيد الحاكم ليس IRR بل DSCR، رغم عدم تمرير targetDSCR صراحة', res.bindingConstraint === 'dscr');
  check('maxPrice منطقي (بين 0 والسقف المستخدَم في البحث الثنائي)', res.maxPrice > 0 && res.maxPrice < 1000);

  // إثبات مباشر أن الاستنتاج القديم ("DSCR متجاهَل لأن لا نقطة تمرره") غير صحيح: لو كان targetDSCR
  // يبقى null فعلاً (كما افترضت المذكرة القديمة)، dscrOk في feasibleAtPrice كانت ستكون true دائماً
  // (targetDSCR==null) وbindingConstraint كانت لتكون 'irr' دوماً — لم يحدث هذا هنا.
  console.log(`   (للتوضيح: maxPrice=${res.maxPrice.toFixed(2)}, targetDSCR الفعلي المُستخدَم=${res.targetDSCR}, bindingConstraint=${res.bindingConstraint})`);
}

// ========== الحالة ٢: عكس الحالة — DSCR فضفاض وIRR هو القيد الحاكم (للتأكد أن السلوك ليس دوماً dscr) ==========
{
  const d = { land: { price: 50 }, criteria: { irrMin: 0.15, dscrMin: 0.5 } }; // حد DSCR منخفض جداً (سهل التحقق)
  const compute = makeSyntheticCompute({ irrAt0: 0.30, irrSlopePer100: 0.25, dscrAt0: 3.0, dscrSlopePer100: 0.10 });
  const res = maxAcquisitionPrice(compute, d, d.criteria.irrMin);
  check('حين يكون حد DSCR فضفاضاً، bindingConstraint يصبح "irr" (السلوك ليس مثبَّتاً دائماً على dscr)', res.bindingConstraint === 'irr');
}

// ========== الحالة ٣: الفرصة بلا criteria.dscrMin إطلاقاً (null) — يجب أن يبقى targetDSCR null فعلياً (لا قيد DSCR أصلاً، كما هو متوقَّع لفرصة بلا شريحة دين) ==========
{
  const d = { land: { price: 50 }, criteria: { irrMin: 0.15, dscrMin: null } };
  const compute = makeSyntheticCompute({ irrAt0: 0.40, irrSlopePer100: 0.08, dscrAt0: 2.0, dscrSlopePer100: 0.30 });
  const res = maxAcquisitionPrice(compute, d, d.criteria.irrMin);
  check('بلا dscrMin على الفرصة أصلاً: targetDSCR يبقى null (لا قيد DSCR مُفترَض من فراغ)', res.targetDSCR === null);
  check('وبالتالي bindingConstraint دائماً "irr" في هذه الحالة (لا قيد DSCR ليُقاس أصلاً)', res.bindingConstraint === 'irr');
}

console.log('');
if (failures === 0) {
  console.log('== النتيجة: 0 فشل — المحرك الحقيقي (functions/generated/.../max-acquisition-price.js) يُفعِّل DSCR تلقائياً عبر d.criteria.dscrMin عند غياب المعامل الرابع، ويمكن أن يصبح القيد الحاكم فعلياً. الاستنتاج القديم ("DSCR متجاهَل") غير صحيح. ==');
  process.exit(0);
} else {
  console.log(`== النتيجة: ${failures} حالة فشلت. ==`);
  process.exit(1);
}
