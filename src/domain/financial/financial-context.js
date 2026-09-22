/* Shared legacy defaults and classification context. Literal extraction from core.js;
   browser schema extenders stay in core.js. No economic defaults changed in 4C. */
export const CITIES = ["الرياض","جدة","مكة المكرمة","المدينة المنورة","الدمام","الخبر","الأحساء","أخرى"];
export const TIERS = { "بريميوم":1.50, "راقي":1.20, "متوسط":1.00, "شعبي":0.75 };

export function isResidentialUseType(useType){
  return useType==='سكني (Residential)' || useType==='سكني - كمبوند مغلق ومسوّر (Gated Compound)';
}

export const USE_TYPES = {
  "سكني (Residential)":            { mult:0.90, niy:0.060 },
  "تجاري - تجزئة (Retail)":         { mult:1.15, niy:0.080 },
  "مكاتب (Office)":                 { mult:1.20, niy:0.075 },
  "مختلط سكني+تجاري (Mixed Use)":   { mult:1.08, niy:0.072 },
  "فندقي (Hospitality)":            { mult:1.45, niy:0.090 },
  "مستودعات ولوجستيات (Logistics)": { mult:0.70, niy:0.085 },
  "رعاية صحية (Healthcare)":        { mult:1.35, niy:0.070 },
  "تعليمي (Education)":             { mult:1.10, niy:0.065 },
  "مركز بيانات (Data Center)":      { mult:1.90, niy:0.065 },
  "مخطط رئيسي شامل (Master Plan)":  { mult:1.40, niy:null },
  // "سكني (Residential)" أعلاه = سكني مفتوح/تقليدي (بدون تسوير أو خدمات مجتمعية خاصة).
  // الإضافة التالية لتغطية الكمبوندات السكنية المغلقة (مسوّرة + أمن + مرافق مشتركة) كنوع منفصل —
  // أرقام تقديرية أولية (علاوة سعرية أعلى مقابل NIY أضيق نسبياً بسبب رسوم الخدمة)، عدّلها من بيانات سوق فعلية.
  "سكني - كمبوند مغلق ومسوّر (Gated Compound)": { mult:1.05, niy:0.055 },
  // إضافة سبتمبر 2026 (بموافقة المستخدم — أربعة استخدامات لم تكن مغطاة) — تحذير: لا يوجد مصدر سوقي
  // سعودي منشور موثوق per-m² لأيٍّ من الأربعة أدناه وقت الإضافة (بحث فعلي عبر WebSearch لم يُظهر
  // سوى بيانات أمريكية/عامة أو أرقام مشاريع عملاقة غير تمثيلية) — كل رقم هنا استدلال هندسي مسنود
  // بمقارنة مع أقرب فئة موجودة فعلاً في النموذج، لا رقم سوق مُتحقَّق منه. عدّلها فور توفر مصدر فعلي.
  // رعاية كبار السن: بين المكاتب (تجهيز قياسي) والرعاية الصحية (أنظمة طبية/تحمل أحمال) — منشآت
  // الرعاية طويلة الأمد عادة أخف طبياً من مستشفى كامل لكنها أثقل من سكني عادي (تحكم مناخي، ممرات
  // كراسي متحركة، أنظمة نداء ممرضات). NIY قريب من المكاتب لاستقرار العقود التشغيلية طويلة الأمد.
  "رعاية كبار السن / دور رعاية (Senior Living / Care Homes)": { mult:1.20, niy:0.075 },
  // سكن طلابي/جماعي مؤسسي: كثافة غرف عالية وتشطيب أبسط من الشقق التمليكية، لكن نسبة ممرات/مرافق
  // مشتركة (مطابخ، غسيل، صالات دراسة) أعلى من السكني التقليدي — وضعناه بين السكني المفتوح والكمبوند.
  "سكن طلابي / سكن جماعي مؤسسي (Student / Institutional Housing)": { mult:0.95, niy:0.065 },
  // مرافق رياضية كبرى/استادات: من أعلى الفئات كثافة رأسمالية بسبب الأسقف طويلة الباع والإنشاء
  // الهيكلي المعقد ومقصورات الضيافة وأنظمة البث، مع كثافة إشغال منخفضة نسبياً للمساحة المبنية —
  // niy=null لأن نموذج الإيراد (رعاية/تذاكر/تسمية) لا يقاس بـNIY تقليدي، بنفس معاملة "مخطط رئيسي شامل".
  "مرافق رياضية كبرى / استادات (Major Sports Facilities / Stadiums)": { mult:1.75, niy:null },
  // التخزين الذاتي: أبسط الفئات إنشائياً (جدران فاصلة داخلية + أبواب فردية، بلا تحميل أرضيات ثقيل
  // أو أرصفة شحن كاللوجستي التقليدي) — أقل من معامل اللوجستيات العام، بينما NIY أعلى نسبياً
  // لانخفاض مصاريف التشغيل واستقرار الإشغال المعروف عالمياً لهذا القطاع.
  "التخزين الذاتي (Self-Storage)": { mult:0.65, niy:0.085 },
};

export const SITE_FACTORS = {
  soil:      [ ["🟢 صخرية / تحمل عالٍ (>300 kN/m²)",0.95], ["🟡 متوسطة — تحتاج فحص", 1.00], ["🔴 رملية ضعيفة — تحسين تربة", 1.10] ],
  water:     [ ["🟢 منسوب عميق (>10م) — آمن",1.00], ["🟡 متوسط — عزل رطوبة",1.05], ["🔴 مرتفع — نزح دائم",1.15] ],
  tower:     [ ["🟢 مبنى منخفض (≤4 أدوار)",1.00], ["🟡 متوسط (5-9 أدوار)",1.08], ["🔴 برج (≥10 أدوار)",1.20] ],
  topo:      [ ["🟢 مستوية (ميل <2%)",1.00], ["🟡 ميل معتدل (2-8%)",1.06], ["🔴 شديدة الانحدار (>8%)",1.15] ],
  infra:     [ ["🟢 جاهزة على حدود الأرض",1.00], ["🟡 تحتاج تمديد قريب",1.06], ["🔴 تحتاج بنية تحتية كاملة",1.18] ],
};

export const DEV_REFI_STRATEGY_KEY = "إعادة تمويل (Hold/Refinance)";
export const CRITERIA_DEFAULTS = { irrMin:0.15, dscrMin:1.30, moicMin:1.50, yocMin:0.08, projIrrMin:0.10, preLeasingMin:0.30, preSaleMin:0.30 };

export function blankOpportunity(){
  return {
    id: null,
    // تحديث (سبتمبر 2026): الفئة الافتراضية كانت "راقي" (×1.20) — كانت هذه القيمة غير مؤثرة مالياً
    // قبل إصلاح خلل tierMult (راجع masterMultiplier أدناه)، فمرّت دون أن يُلاحَظ أنها تفترض مسبقاً
    // فرصة "راقية" لكل فرصة جديدة. بعد تفعيل tierMult فعلياً في حسابات التكلفة، أصبحت "متوسط" (×1.00 —
    // محايدة) نقطة بداية أكثر منطقية لفرصة جديدة لم يُحدِّد المستخدم فئتها بعد؛ يبقى قابلاً للتغيير فوراً
    // من شاشة الفرضيات حسب موقع الفرصة الفعلي.
    meta: { name:'', city:CITIES[0], neighborhood:'', tier:'متوسط', oppType:'income', useType:Object.keys(USE_TYPES)[3], analyst:'Opal', createdAt:null, updatedAt:null, createdBy:null, updatedBy:null },
    land: { area:0, price:0, far:0, bar:0, floorsAllowed:0, basements:0, floorHeight:0, setbacks:0, bonusAreaPct:0,
      basementCostPremiumPct:0, basementDepthEscalationPct:0, floorHeightPremiumPct:0 },
    site: { soil:0, water:0, tower:0, topo:0, infra:0 },
    strategy: { exitStrategy:"مختلط (Mixed Sell+Rent)", salePct:0,
      // البيع على الخارطة (نظام "وافي") — بيع كامل وحدات المشروع على مراحل الإنشاء بدل انتظار التسليم،
      // مع تأخير زمني (Lag) لتحرير المبلغ من حساب الضمان. معطَّل افتراضياً؛ حصري مع نسبة البيع/الإيجار
      // المختلطة العادية (يبيع 100% من الوحدات عبر الشرائح بدل تقسيمها بين بيع وإيجار).
      offPlanSale: { enabled:false, preSalePctThreshold:0, curve:'even', escrowLagYears:0, priceEscalationAnnual:0 },
      // البيع المباشر — تمييز مشترٍ كاش عن مشترٍ بتمويل عقاري بنكي: حصة الأخير تتأخر في التحصيل الفعلي
      // (موافقة البنك وتحويل التمويل يستغرقان وقتاً أطول من دفعة كاش مباشرة). معطَّلة افتراضياً (0%).
      directSale: { bankFinancedPct:0, collectionLagYears:0 } },
    income: { gla:null, rent:0, occupancy:0, opex:0, wale:0, tenantConc:0, distFreq:"ربع سنوي (Quarterly)",
      assetClass:'عام', holdStrategy:'exit_sale', mixedUse:false,
      nnn: { tenantCreditTier:'وطني (National)', leaseTermRemaining:0, pctRent:false, pctRentRate:0, annualSales:0, envReserveAnnual:0 },
      hospitality: { adr:0, keys:0, gopMargin:0 },
      logisticsSpec: { clearHeight:0, dockDoors:0 },
      dataCenterSpec: { powerDensityKw:0, redundancyTier:'Tier III (N+1)' },
      refinance: { intervalYears:0, refiLtv:0, refiCostPct:0, analysisHorizon:0 },
    },
    // تحديث buildCost الافتراضي من 3,800 إلى 4,800 ر.س/م² (سبتمبر 2026) بعد مراجعة مقابل مصادر
    // تكلفة بناء سعودية حديثة (Turner & Townsend KSAMI 2025، Compass Project Consulting H2 2024،
    // الرقم القياسي لتكاليف البناء GASTAT) — القيمة السابقة كانت متدنية بوضوح عن السوق الحالي لمعظم
    // أنواع الاستخدام بعد ضرب معامل USE_TYPES.mult (مثال: مكاتب 3,800×1.20=4,560 مقابل نطاق سوقي
    // 7,000-10,000 لمباني مكاتب Grade A). هذا لا يزال تقديراً متحفظاً (دون أرقام الأبراج الفاخرة في
    // مناطق الأعمال المركزية) يمكن تعديله يدوياً لكل فرصة حسب موقعها ومستوى تشطيبها الفعلي — راجع
    // أيضاً ROWS في space-efficiency-data.js لمرجع أكثر تفصيلاً بحسب نوع المنتج.
    development: { salePrice:0, buildCost:0, constructionYears:0, operationYears:0, exitCapRate:0, efficiency:0, contingency:0,
      scopeType:'both', infraCostPerSqm:0,
      costBreakdown:{ structure:0, mep:0, finishes:0, external:0, fees:0 } },
    landbank: { appreciation:0, holdingYears:0, carryAnnual:0, zoningNote:'', hbuNote:'', interimAnnualIncome:0,
      whiteLandFeePct:0.025, whiteLandFeeExempt:false },
    // الزكاة الشرعية — تقدير توضيحي مبسّط لأثرها على عائد المستثمر السعودي/الخليجي (وليس احتساباً زكوياً
    // معتمداً — الوعاء الفعلي يعتمد على تفاصيل الأصول والمطلوبات ونوع الصندوق). معطَّلة افتراضياً.
    zakat: { enabled:false, ratePct:0.025 },
    // ضريبة القيمة المضافة (VAT) — تُطبَّق تلقائياً حسب نوع الاستخدام الرئيسي (meta.useType) عند التفعيل:
    // الاستخدامات السكنية معفاة (فتتحول ضريبة المدخلات غير المستردة على OpEx إلى تكلفة حقيقية إضافية تُخصم
    // من NOI)، وبقية الاستخدامات خاضعة للنسبة الأساسية (تُحصَّل فوق الإيجار وتُورَّد للجهة الضريبية — محايدة
    // على NOI بافتراض استرداد كامل لضريبة المدخلات، وتظهر فقط كبند إفصاحي). معطَّلة افتراضياً.
    vat: { enabled:false, ratePct:0.15, constructionInputVatPct:0.15, inputRecoveryPct:null, refundLagYears:0, professionalFeesVatPct:0.15 },
    // تقسيم الأراضي (Land Subdivision) — بيع القطع على مراحل متعددة عبر سنوات (امتصاص تدريجي) بدل بيعة
    // واحدة. يُفعَّل فقط لفرص التطوير بنطاق "أرض مخدَّمة فقط" (scopeType='infra_only'). عند التفعيل، يحل
    // جدول الامتصاص هذا محل نمط سداد الدين المعتاد بآلية "تحرير رهن تناسبي" (كل شريحة مباعة تُسدِّد حصتها
    // النسبية من الدين — وهي الآلية المصرفية الفعلية المعتادة لتمويل تقسيم الأراضي في السوق السعودي).
    subdivision: { phasedAbsorption:false, absorptionYears:0, curve:'even', priceEscalationAnnual:0 },
    subscription: { minInvestment:0, subscriptionFee:0, lockupYears:0, distPolicy:"عند الإغلاق فقط (At Exit Only)", investorClass:"Class A - تجزئة (Retail)", hwm:true },
    economics: { hurdle:0, carry:0, lpShare:0, gpShare:0, devShare:0 },
    fees: { mgmt:0, structuring:0, arrangement:0, acquisition:0, disposition:0, assetMgmt:0, propMgmt:0, regAuditCustodian:0, cmaSetup:0, dueDiligence:0, valuation:0,
      // رسوم منصة "إيجار" (٪ من الإيراد الإجمالي الفعلي سنوياً) وتأمين الأصل (٪ من إجمالي تكلفة المشروع
      // سنوياً) — بندان اختياريان منفصلان لملخص الرسوم (صفر افتراضياً = لا تغيير). لا تُفعِّلهما لو كانا
      // مُدرجين أصلاً ضمن نسبة OPEX العامة، تفادياً لازدواج الاحتساب.
      ejarFeePct:0, insuranceAnnualPct:0 },
    financing: { ltc:0, saibor:0, margin:0, tenor:0, structure:'single', seniorPct:0, mezzMarginAdj:0, amortType:'interest_only', graceYears:0, amortYears:0, interestDuringConstruction:'cash',
      // الهيكل الشرعي للتمويل — وصفي/عرضي بحت: يُغيّر فقط تسمية "الفائدة/الدين" في المذكرة والتقارير إلى
      // مسمّاها الشرعي المكافئ اقتصادياً، دون أي تغيير في معادلات SAIBOR+الهامش أو التدفقات النقدية أو
      // النتائج المالية (IRR/MOIC/DSCR...) — عقد التمويل الإسلامي الفعلي يحتاج صياغة واعتماداً شرعياً منفصلاً.
      shariahStructure:'تقليدي (فائدة تقليدية)', drawSchedulePct:[] },
    wacc: { rf:0, mrp:0, beta:0, crp:0, sp:0, alpha:0, marketCap:0, growth:0 },
    exitCosts: { broker:0, legal:0, rett:0.05, exitFee:0 },
    criteria: Object.assign({}, CRITERIA_DEFAULTS, { preLeasingActual:0, preSaleActual:0 }),
    scenarios: {
      optimistic: { rentMult:1.08, salePriceMult:1.08, costMult:0.95, capRateDelta:-0.005, rateDelta:-0.0025 },
      pessimistic:{ rentMult:0.90, salePriceMult:0.88, costMult:1.10, capRateDelta:0.010, rateDelta:0.0075 },
    },
    closing: {
      titleDeed:'completed', zoning:'in_progress', environmental:'not_started',
      conditions: [
        { text:'تثبيت سعر الأرض عبر اتفاقية شراء موقعة', status:'pending' },
        { text:'توقيع عقود إيجار مسبقة ≥ 30% من GLA قبل بدء الإنشاء', status:'pending' },
      ],
      ddNotes: '',
    },
    // متطلبات نظام صناديق الاستثمار العقارية (لائحة هيئة السوق المالية) — قائمة تحقق نظامية صريحة، بنفس
    // بنية "شروط الإغلاق" أعلاه (قابلة للتعديل/الإضافة/الحذف يدوياً). تختلف جذرياً بين الطرح الخاص المحدود
    // والطرح العام (عدد المستثمرين، متطلبات الإفصاح، النشرة). تحقق دائماً من آخر تحديث للائحة عند الاستخدام.
    regulatory: {
      offeringType: 'طرح خاص (Private Placement)',
      items: [
        { text:'عدد المستثمرين ضمن الحد الأقصى المسموح للطرح الخاص حسب لائحة صناديق الاستثمار العقارية', status:'pending' },
        { text:'الحد الأدنى للاستثمار للمستثمر الواحد مستوفى حسب اللائحة', status:'pending' },
        { text:'مذكرة معلومات خاصة (Private Placement Memorandum) مُعدَّة ومُعتمَدة', status:'pending' },
        { text:'مدير الصندوق مرخّص من هيئة السوق المالية لإدارة صناديق استثمار عقارية', status:'pending' },
        { text:'أمين الحفظ (Custodian) مُعيَّن ومرخّص', status:'pending' },
      ],
    },
    notes: '',
  };
}
