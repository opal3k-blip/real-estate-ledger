/* =========================================================================
   مكتبة الكفاءة المعمارية والتكلفة المرجعية — Space Efficiency & Cost Reference
   Library (المرحلة ٤، النظام الثاني)
   ---------------------------------------------------------------------------
   الفكرة: ١٥٣ سجلاً مرجعياً (منتج/استخدام عقاري ← نطاق %/تكلفة، منطق معماري،
   تصنيف كفاءة GLA/Non-GLA/Amenity، عبء مواقف، توجيه، مستوى مسموح، تكلفة/م²
   مرجعية) — مصدرها space-efficiency-data.js (ثابت في الكود، لا يُعدَّل من
   الواجهة، تماماً كمرجع مؤسسي أساسي). فوق هذا الأساس نبني طبقتين:

   (1) طبقة معرفة عقارية مكثّفة (SECTOR_KNOWLEDGE) — خلاصة مهنية مركّزة لكل
       قطاع (نسب كفاءة GLA/BUA المرجعية، معايير مواقف، WALE، هامش NOI، حساسية
       معدل الرسملة، ملاحظات مناخية/تسويقية) تُعرَض كنص غني عند تصفح المكتبة
       وفي مؤشر الفرصة — هذا ما طلبه المستخدم صريحاً: "زوّد المكتبة بكل ما تعرفه
       لتكون غنية بالمعلومات... نلخص كل خبرتك العقارية فيها بشكل مكثف جداً".

   (2) طبقة تجاوزات/تخصيص محلي قابلة للتعديل (SPACE_EFF_OVERRIDES، مجموعة
       Firestore منفصلة بنفس نمط comparables.js/benchmark-engine.js) — يضيف
       فيها مدير الصندوق فأعلى (canManageLibraries) ملاحظات معايرة محلية على
       سجل موجود، أو سجلات مخصّصة جديدة، مع تصديق (certifyBadge) — دون الحاجة
       لكتابة الـ١٥٣ سجلاً الأساسية في كل قاعدة Firestore (تبقى في الكود، سريعة
       ومتاحة فوراً دون أي استدعاء شبكة).

   نقاط العرض الثلاث (حسب قرار المستخدم: "مؤشرات خفيفة الآن" لا تغييراً كاملاً
   في نموذج البيانات):
     أ. registerWizardStepExtra(3, ...) — في لحظة اختيار "نوع الاستخدام
        الرئيسي" (Step 3) أثناء إدخال الفرصة: صندوق مؤشرات معمارية فوري.
     ب. registerDetailSection — نفس المؤشر + الخلاصة القطاعية الكاملة على
        صفحة الفرصة المحفوظة.
     ج. Main View كاملة (تصفح/بحث بالقطاع/تصديق/إضافة تجاوزات) — بنفس نمط
        مكتبة أوبال المرجعية (benchmark-engine.js)، محمية بنفس أدوار الفريق.

   لا تعديل على منطق core.js الداخلي ولا على نموذج meta.useType الحالي (قيمة
   واحدة لكل فرصة) — هذا بالكامل عبر نقاط التوسّع المُصدَّرة.

   إثراء المرحلة ٥ (طلب المستخدم "كلاهما" — مكتبة رسوم جديدة + إغناء المكتبات
   القائمة بالمصاريف): نستورد OPEX_BY_SECTOR من fund-fees-opex-library.js
   (اتجاه واحد فقط — ذلك الملف لا يستورد من هنا أبداً، فلا تعارض استيراد
   دائري) لعرض نطاق مصاريف التشغيل المرجعي لكل قطاع بجانب مؤشرات الكفاءة
   المعمارية الموجودة أصلاً، ليكون مؤشر الإدخال غنياً بالمساحة والتكلفة
   والمصروف معاً في مكان واحد.
   ========================================================================= */

import { ROWS, SECTORS, USE_TYPE_TO_SECTORS, EFF_CLASS } from './space-efficiency-data.js';
import { canManageLibraries, certifyBadge } from './roles-permissions.js';
import { OPEX_BY_SECTOR } from './fund-fees-opex-library.js';

const OVERRIDES_COLLECTION = 'spaceEffOverrides';

/* =========================================================================
   طبقة المعرفة العقارية المكثّفة — خلاصة مهنية لكل قطاع (Sector Knowledge)
   ---------------------------------------------------------------------------
   هذه ليست نصوصاً عامة — كل بند رقم/نسبة/معيار هو ما يُستخدَم فعلياً في
   الاكتتاب العقاري المؤسسي (Institutional Underwriting) لكل قطاع، ليكون
   "مدخل البيانات" أذكى لحظة الإدخال لا بعد الحفظ فقط.
   ========================================================================= */
const SECTOR_KNOWLEDGE = {
  residential: {
    ar: `الكفاءة الصافية (NSA÷GFA) القياسية للأبراج السكنية الفاخرة ٧٥-٨٠٪، وللمتوسط/الاقتصادي ٨٠-٨٥٪ (كل ما قلّت الفخامة زادت الكفاءة — ردهات وممرات أصغر). الشرفات نادراً ما تُحتسَب ١٠٠٪ من مساحة البيع — المعيار السوقي ٥٠٪ من مساحتها الفعلية في حساب سعر البيع/م² للوحدة. WALE غير منطبق مباشرة على البيع على الخارطة، لكنه حرج في السكني للتأجير المؤسسي (Build-to-Rent) — عقود سكنية عادة ١-٣ سنوات فقط (عكس التجاري)، فمعدل الدوران (Turnover) وتكلفة التجديد (Make-ready) هما المحرك الحقيقي للـNOI لا WALE. حساسية معدل الرسملة: كل ١٠٠ نقطة أساس (bps) زيادة في Exit Cap Rate تُخفّض قيمة الخروج ٨-١٢٪ تقريباً حسب مدة الإمساك. نسبة المواقف المرجعية بالسعودية عادة ١ موقف/وحدة للاقتصادي وحتى ٢-٢.٥ موقف/وحدة للفاخر — نقصها يخفض القيمة السوقية أكثر من أثره الإنشائي المباشر.`,
    en: `Net-to-gross (NSA÷GFA) benchmarks: 75-80% for luxury towers, 80-85% for mid/affordable (less luxury = smaller lobbies/corridors = higher efficiency). Balconies are typically counted at only ~50% of actual area in sellable-area pricing. WALE is less relevant for off-plan sale but critical for institutional build-to-rent — residential leases run 1-3 years (vs. commercial), so tenant turnover and make-ready cost drive NOI more than WALE. Cap-rate sensitivity: every 100bps rise in exit cap rate cuts exit value ~8-12% depending on hold period. Saudi parking benchmarks run 1 space/unit (affordable) up to 2-2.5 spaces/unit (luxury) — a shortfall hurts market value more than its direct construction saving.`,
  },
  office: {
    ar: `الكفاءة الصافية لمكاتب Grade A عادة ٨٠-٨٥٪ (نظام تخطيط مفتوح Open-Plan)، وتنخفض لـ٧٠-٧٥٪ في المباني القديمة أو ذات الأعمدة الكثيفة. WALE المستهدف لمكاتب مؤسسية ٥-٧ سنوات (المستأجرون الحكوميون/الشركات الكبرى غالباً ٧-١٠ سنوات) — WALE أقل من ٣ سنوات يرفع علاوة معدل الرسملة (Risk Premium) ٥٠-١٠٠ نقطة أساس تقريباً. معيار المواقف الشائع: ١ موقف لكل ٥٠-٦٠م² مكتبي صافي. هامش NOI (بعد مصاريف التشغيل والصيانة) يتراوح ٦٥-٧٥٪ من الإيراد الإجمالي للمكاتب Grade A المُدارة جيداً. اتجاه السوق الحالي (Flight to Quality) يعني أن مباني B/C تواجه إشغالاً أضعف حتى مع خصومات إيجارية، فيما Grade A المعتمد بيئياً (LEED/مستدام) يحقق علاوة إيجارية ٥-١٥٪.`,
    en: `Grade A office net efficiency typically 80-85% (open-plan), dropping to 70-75% in older/heavily-columned buildings. Target institutional WALE 5-7 years (government/large-corporate tenants often 7-10). WALE under 3 years adds roughly 50-100bps of risk premium to the cap rate. Common parking ratio: 1 space per 50-60m² net office. NOI margin for well-managed Grade A typically 65-75% of gross revenue. Current "flight to quality" trend means B/C-grade stock faces weaker occupancy even with rent discounts, while certified Grade A (LEED/Mostadam) commands a 5-15% rent premium.`,
  },
  retail: {
    ar: `كفاءة GLA في المولات الإقليمية عادة ٥٥-٦٥٪ فقط من إجمالي BUA (الباقي ممرات، أماكن جذب، خدمات) — أقل بكثير من أي قطاع آخر، وهذا طبيعي وليس عيباً تصميمياً. المستأجر الرئيسي (Anchor) يدفع إيجاراً أقل للم² (غالباً ٢٠-٤٠٪ من إيجار المحلات الخطية) لكنه يجلب الحركة (Footfall) التي ترفع إيجار بقية المحلات — لذلك تقييمه لا يكون بمعدل الإيجار وحده بل بأثره على "صحة" المزيج التجاري (Tenant Mix Health). نسبة تركّز المستأجرين (Tenant Concentration): اعتماد أكثر من ٣٠٪ من الإيراد الإجمالي على مستأجر واحد يُعد علم إنذار احتمالي في أي مذكرة استثمارية. مطاعم/مقاهي غالباً تدفع نسبة من المبيعات (Percentage Rent) فوق حد أدنى مضمون (Base + Turnover Rent) — نموذج إيراد مختلط عن التجزئة التقليدية. WALE التجزئة القياسي ٣-٥ سنوات للمحلات الخطية، وحتى ١٠-١٥ سنة لمرساة سوبرماركت/هايبرماركت.`,
    en: `Regional mall GLA efficiency is typically only 55-65% of total BUA (the rest is circulation, anchors' drawing space, back-of-house) — much lower than any other sector, and that's by design, not a flaw. Anchor tenants pay lower rent/m² (often 20-40% of line-shop rent) but drive footfall that lifts rent for the rest — so an anchor should be valued by its effect on overall tenant-mix health, not rent alone. Tenant concentration: relying on one tenant for >30% of total revenue is a standard red flag in an IC memo. F&B tenants often pay percentage rent (base + turnover) rather than flat rent. Standard retail WALE is 3-5 years for line shops, up to 10-15 years for a supermarket/hypermarket anchor.`,
  },
  hospitality: {
    ar: `مقاييس الفندقة تختلف جذرياً: الإيراد يُقاس بـRevPAR (=ADR×نسبة الإشغال) لا بالإيجار/م². هامش الربح التشغيلي الإجمالي (GOP Margin) المرجعي ٣٥-٤٥٪ للفنادق 4-5 نجوم المُدارة بعلامة عالمية، وقد ينخفض لـ٢٥-٣٠٪ للفئات الاقتصادية بسبب ثبات تكاليف معينة (طاقة، رواتب أساسية) نسبةً للإيراد. نسبة المفاتيح للمساحة الإجمالية (Keys-to-BUA) معيار كفاءة أساسي: فندق فاخر ٦٠-٩٠م² BUA/مفتاح، واقتصادي ٣٠-٤٥م²/مفتاح. عقود إدارة الفنادق (Management/Franchise Agreements) عادة رسوم أساسية ٢-٣٪ من الإيراد الإجمالي + رسوم حافزة ٦-١٠٪ من GOP — يجب اعتبارها بند تكلفة تشغيلي منفصل لا يُحمَّل خطأً على تكلفة البناء. حساسية الإشغال: كل ١٠٪ تراجع في نسبة الإشغال قد تُخفّض NOI ١٥-٢٥٪ (وليس ١٠٪) بسبب رافعة التكاليف الثابتة التشغيلية.`,
    en: `Hospitality economics are fundamentally different: revenue is measured by RevPAR (ADR × occupancy), not rent/m². Benchmark GOP margin: 35-45% for branded 4-5★ hotels, dropping to 25-30% for budget tiers (fixed costs — energy, base payroll — are a larger share of a smaller revenue base). Keys-to-BUA is a core efficiency metric: luxury ~60-90m² BUA/key, budget ~30-45m²/key. Management/franchise agreements typically run a 2-3% base fee plus 6-10% incentive fee on GOP — model this as a separate opex line, never folded into construction cost. Occupancy sensitivity: a 10-point occupancy drop can cut NOI by 15-25% (not 10%) due to operating-cost leverage.`,
  },
  logistics: {
    ar: `كفاءة GLA للمستودعات مرتفعة جداً (٩٥-٩٨٪) لأن نسبة الهدر التصميمي منخفضة — القيمة الحقيقية في الارتفاع الصافي للسقف (Clear Height)، حيث كل متر إضافي في الارتفاع (فوق ٩-١٢م القياسي) يرفع سعة التخزين التكعيبية دون زيادة مساوية في تكلفة الأرض. معدل الرسملة للمستودعات الحديثة (Grade A Logistics) أصبح من أضيق المعدلات في السوق العقاري نتيجة الطلب المرتبط بالتجارة الإلكترونية — أضيق من التجزئة التقليدية في كثير من الأسواق الناضجة. WALE اللوجستي طويل نسبياً (٥-١٠ سنوات) لأن تكلفة انتقال المستأجر (رفوف، أنظمة WMS) مرتفعة. نسبة أرصفة التحميل (Dock Doors) المرجعية: رصيف واحد لكل ٩٣٠-١٤٠٠م² تقريباً حسب طبيعة النشاط (توزيع سريع = كثافة أرصفة أعلى).`,
    en: `Warehouse GLA efficiency is very high (95-98%) — low design waste. Real value driver is clear height: every extra meter above the 9-12m standard adds cubic storage capacity without a proportional land-cost increase. Grade A logistics cap rates have compressed sharply on e-commerce-driven demand — in many mature markets now tighter than traditional retail. Logistics WALE runs long (5-10 years) because tenant fit-out cost (racking, WMS systems) is high. Benchmark dock-door ratio: roughly 1 dock per 930-1,400m², denser for fast-turn distribution.`,
  },
  datacenter: {
    ar: `أعلى قطاع من حيث تكلفة البناء/م² (كما يعكسه السجل المرجعي هنا: ~١٦,٠٠٠ ر.س/م² — أكثر من ٤× تكلفة المكاتب Grade A) بسبب أنظمة التبريد والطاقة الاحتياطية (UPS/Generators) وأنظمة الحماية من الحريق المتخصصة. القياس السوقي المعياري ليس م² بل ميجاوات القدرة الحرجة (Critical IT Load MW) وسعر الإيجار بالدولار/كيلوواط شهرياً. WALE طويل جداً (١٠-١٥+ سنة) لأن تكلفة انتقال المستأجر (Hyperscaler) هائلة. معدل PUE (Power Usage Effectiveness — نسبة الطاقة الكلية المستخدمة إلى طاقة تشغيل المعدات فعلياً) هو مؤشر الكفاءة التشغيلية الأهم؛ 1.2-1.4 يُعد ممتازاً حالياً. موقع محصّن وبعيد عن مناطق الفيضان/الاضطرابات الجيولوجية شرط تمويلي (Bankability) لا تفضيلي فقط.`,
    en: `The single highest cost/m² sector (as this reference reflects: ~SAR 16,000/m² — over 4× Grade A office) due to cooling systems, backup power (UPS/generators), and specialized fire suppression. The market benchmark unit isn't m² but critical IT load (MW) and rent priced in $/kW/month. WALE is very long (10-15+ years) given massive hyperscaler fit-out/switching costs. PUE (Power Usage Effectiveness) is the key operational efficiency metric — 1.2-1.4 is currently excellent. A hardened, flood/seismic-safe location is a financing (bankability) requirement, not just a preference.`,
  },
  healthcare: {
    ar: `تكلفة البناء/م² للمستشفيات مرتفعة جداً (أنظمة غازات طبية، تبريد دقيق، تحمل أحمال أثقل من المعدات) — يعكسها السجل هنا (~١٠,٢٥٠ ر.س/م² للمستشفى العام). عقود إيجار العيادات/المجمعات الطبية غالباً طويلة (٧-١٥ سنة) بسبب تكلفة الترخيص وتجهيز الوحدة الطبية على المستأجر. مؤشر أسرّة/م² (Beds-to-BUA) معيار كفاءة أساسي لتقييم المستشفيات لا يقل أهمية عن GLA. الفصل الكامل لحركة المرضى/الزوار/الخدمات (Circulation Separation) ليس فقط شرط تشغيلي بل يؤثر مباشرة على كفاءة المسقط (كل ممر إضافي هدر مساحة). الرعاية الصحية من أكثر القطاعات دفاعية (Defensive Asset Class) — طلب غير مرن نسبياً تجاه الدورة الاقتصادية، ما يبرر أحياناً قبول معدل رسملة أضيق قليلاً مقابل استقرار الإيراد.`,
    en: `Hospital construction cost/m² is very high (medical gas systems, precision HVAC, heavier equipment loads) — reflected here (~SAR 10,250/m² for a general hospital). Clinic/polyclinic leases run long (7-15 years) since licensing and medical fit-out cost falls on the tenant. Beds-to-BUA is a core hospital efficiency metric, as important as GLA ratios elsewhere. Full separation of patient/visitor/service circulation isn't only operational — every extra corridor is a direct efficiency loss. Healthcare is a defensive asset class with relatively inelastic demand through economic cycles, sometimes justifying a slightly tighter cap rate for revenue stability.`,
  },
  education: {
    ar: `المباني التعليمية غالباً مبنى مستقل كامل (لا جزء من مشروع مختلط) بسبب اشتراطات الملاعب والباصات المدرسية والمساحات الخارجية الكبيرة. WALE عقود المدارس الدولية طويل جداً (١٠-٢٥ سنة) لأنها استثمار تشغيلي (Operator) لا إيجار عقاري بسيط — التقييم يعتمد أكثر على قوة المشغّل (Operator Credit) من موقع العقار نفسه. المعامل والفصول المتخصصة (علوم، حاسوب) تتطلب تحميل كهربائي وتهوية أعلى من الفصل العادي — بند غالباً يُهمَل في تقدير تكلفة MEP الأولي. حساسية الإشغال في التعليم الخاص مرتبطة بموسمية السنة الدراسية والهجرة السكانية للحي، لا بدورة السوق العقاري العامة.`,
    en: `Educational buildings are usually a full standalone building (not part of a mixed-use podium) due to playground, school-bus, and large-outdoor-space requirements. International-school lease WALE is very long (10-25 years) — it's really an operator investment, not simple property leasing, so valuation hinges more on operator credit than location alone. Specialized labs/computer rooms need higher electrical load and ventilation than a standard classroom — an often-underestimated MEP line item. Private-education occupancy sensitivity tracks the academic-year cycle and neighborhood demographic migration, not the general real-estate cycle.`,
  },
  entertainment: {
    ar: `مراكز الترفيه العائلي والسينما تُقيَّم غالباً بإيجار مختلط (Base + % من التذاكر/الإيراد) لا إيجاراً ثابتاً بحتاً، لأن نجاحها التجاري متقلب بطبيعته (اتجاهات، منافسة رقمية). عبء المواقف في وقت الذروة (المساء/عطلة الأسبوع) أعلى بكثير من متوسط اليوم — يجب تصميم/تسعير المواقف على أساس الذروة لا المتوسط. دورها الأساسي غالباً "مولّد حركة" (Anchor/Traffic Driver) للمول المحيط أكثر من كونه مصدر إيراد مباشر قوي بذاته — قيمته الحقيقية تظهر في ارتفاع إيرادات المحلات المجاورة (Halo Effect) لا في بند إيراده وحده.`,
    en: `Cinemas and family entertainment centers are often leased on hybrid terms (base + % of ticket/spend revenue) rather than pure fixed rent, since their commercial performance is inherently volatile (trends, digital competition). Peak-hour parking load (evenings/weekends) is far higher than the daily average — size and price parking for peak demand, not the average. Their real role is often as a traffic-driving anchor for the surrounding mall rather than a strong direct revenue line on its own — true value shows up as a halo effect lifting neighboring shop revenue, not in its own rent line alone.`,
  },
  parking: {
    ar: `المواقف بند تكلفة صافٍ (Non-GLA) في الغالبية العظمى من المشاريع — لا تُدر إيراداً مباشراً إلا في حالات محددة (مواقف مدفوعة تجارية/مطارات/مواقف ذكية مؤجَّرة). القبو أغلى تنفيذياً من البوديوم للمتر الواحد (حفر + عزل مائي + خفض منسوب مياه) لكنه يوفر أرضاً للاستخدامات المُدرة للدخل فوقه — المفاضلة الحقيقية اقتصادية (تكلفة القبو الإضافية × مقابل قيمة GLA المُحرَّرة فوقه) لا تصميمية بحتة. أنظمة المواقف الذكية (Robotic Parking) تقلّص المساحة اللازمة نحو ٤٠٪ لكن بتكلفة تنفيذ وتشغيل أعلى — تُبرَّر تجارياً فقط عند سعر الأرض/م² المرتفع جداً (مواقع مركزية كثيفة).`,
    en: `Parking is a pure cost line (Non-GLA) in most projects — direct revenue only in specific cases (paid public parking, airports, leased smart-parking). Basement parking costs more per m² than podium (excavation, waterproofing, dewatering) but frees ground-level land for income-generating uses above — the real trade-off is economic (extra basement cost vs. the GLA value it unlocks above), not purely a design choice. Robotic/automated parking cuts required area by ~40% but at higher build and running cost — only justified commercially where land value/m² is very high (dense central sites).`,
  },
  mep_infra: {
    ar: `بنود MEP/البنية التحتية (محطات تحويل، خزانات مياه/صرف، أنظمة إنذار وإطفاء، ألياف بصرية) اشتراطات إلزامية غالباً (Mandatory) لا اختيارية — يجب حجزها في المخطط المبدئي من اليوم الأول، إذ إن تأخير تخصيص مساحتها لاحقاً يعني غالباً التضحية بمساحة GLA مخطَّط لها مسبقاً. تكلفتها لا تتناسب خطياً مع حجم المشروع (Economies/Diseconomies of Scale) — مشروع صغير قد يتحمل نسبة أعلى من تكلفة البنية التحتية للمتر مقارنة بمشروع كبير يوزّع التكلفة الثابتة (محولة كهرباء واحدة، خزان واحد) على مساحة أكبر. دور الخدمات (MEP Floor) في الأبراج العالية "ضريبة ارتفاع" غير مرئية غالباً في نماذج التقييم المبسّطة — كل دور خدمات هو دور كامل مفقود من الإيراد.`,
    en: `MEP/infrastructure items (substations, water/sewage tanks, fire alarm & suppression, fiber) are usually mandatory code requirements, not optional — reserve their footprint in the earliest massing study, since deferring the decision later usually means sacrificing already-planned GLA. Their cost doesn't scale linearly with project size — a small project can bear a proportionally higher infrastructure cost/m² than a large one that spreads the same fixed cost (one substation, one tank) over more area. A technical/MEP floor in a high-rise is often an invisible "height tax" in simplified valuation models — each MEP floor is one full floor of foregone revenue.`,
  },
  site_masterplan: {
    ar: `نسبة الهدر التشغيلي (Non-Leasable Circulation) في الأدوار الأرضية (ممرات، حمامات عامة، غرف خدمة) تُقاس عادة كنسبة من مساحة الأرضي لا من إجمالي المشروع — معيار صحي ١٠-٢٥٪. عدد الشوارع/الواجهات التجارية الفعالة (Active Frontages) يرفع القيمة الإيجارية للمحلات المحيطة بشكل غير خطي — الزاوية بين شارعين قيمتها أعلى من متوسط طول الواجهة. عمق المعرض التجاري المثالي للتأجير ١٢-٣٠ متراً (أقل من ذلك يحد من مرونة استخدام المستأجر، أكثر منه يصعّب الإضاءة الطبيعية والعرض الداخلي). المخطط الرئيسي الجيد يوازن بين "معدل تغطية الأرض" (BAR) و"عامل البناء" (FAR) بحيث لا تُستهلك حقوق البناء الرأسية على حساب الفراغات الأرضية المُدرة للحركة والقيمة.`,
    en: `Non-leasable ground-floor circulation (corridors, public restrooms, service rooms) is best benchmarked as a % of ground-floor area, not total project — healthy range 10-25%. The number of active commercial frontages raises surrounding retail rental value non-linearly — a corner between two streets is worth more than the average of the two frontage lengths. Ideal retail-shop depth for leasing is 12-30m (shallower limits tenant flexibility; deeper hurts natural light and in-store display). A good master plan balances site coverage (BAR) against the building ratio (FAR) so vertical building rights aren't consumed at the expense of ground-level, footfall-and-value-generating open space.`,
  },
  fuel_highway: {
    ar: `محطات الوقود من أعلى القطاعات كفاءة إيرادية للمتر بسبب عقود التشغيل طويلة الأجل مع علامات وقود عالمية/محلية (NNN Leases — المستأجر يتحمل كل المصاريف التشغيلية والضريبية والتأمين) — نموذج إيراد شبه سندي (Bond-like) منخفض المخاطر التشغيلية على المالك. الموقع الاستراتيجي (زاوية/مدخل طريق بشارعين) شرط جوهري لا تفضيلي، لأنه يحدد حركة المركبات مباشرة. متجر الملاءمة (C-Store) والمغسلة والصيانة السريعة بنود إيراد "مكمّلة" ذات هامش ربح أعلى نسبياً من بيع الوقود نفسه (الذي يعمل بهامش ضيق جداً كمولّد حركة أساساً). محطات الشحن الكهربائي أصبحت بند بنية تحتية استراتيجي في محطات الوقود الحديثة، تحويلها لاحقاً أصعب وأغلى من تخصيصها من التصميم الأولي.`,
    en: `Fuel stations rank among the highest revenue-efficiency-per-m² sectors due to long-term NNN leases with global/national fuel brands (tenant bears opex, tax, insurance) — a near bond-like, low operational-risk revenue model for the owner. A strategic corner/two-street-access location is a fundamental requirement, not a preference, since it directly drives vehicle throughput. The convenience store, car wash, and quick-lube are "complementary" revenue lines with materially higher margins than fuel sales itself (which runs on razor-thin margins mainly as a traffic driver). EV charging has become a strategic infrastructure line in modern stations — retrofitting later is far costlier than reserving space from the initial design.`,
  },
  amenities: {
    ar: `المرافق (Amenities) لا تُدر إيراداً مباشراً في الغالب، لكنها تؤثر على ثلاثة أمور قابلة للقياس: (١) سرعة الامتصاص/البيع (Absorption Velocity) — مشاريع بمرافق قوية تُباع/تُؤجَّر أسرع، (٢) علاوة السعر/الإيجار (Price Premium) — ٣-٨٪ علاوة سعرية شائعة لمشاريع فاخرة بمرافق متكاملة، (٣) معدل رضا السكان وتجديد العقود (Renewal Rate) في التأجير المؤسسي. القاعدة العملية: أي مرفق يجب أن يُبرَّر بعائد قابل للقياس على الأقل بأحد هذه الثلاثة، لا بالفخامة لذاتها — الإفراط في المرافق (Amenity Overload) دون طلب سوقي فعلي يرفع تكلفة البناء والتشغيل (رسوم الخدمة/الصيانة) دون عائد مقابل، وقد يُنفّر مشترياً حساساً للسعر. المسابح والحدائق المعلقة (تكلفة تشغيل وصيانة مستمرة تُحمَّل على رسوم الخدمة) يجب اعتبارها التزاماً تشغيلياً طويل الأجل لا بنداً إنشائياً لمرة واحدة فقط.`,
    en: `Amenities rarely generate direct revenue, but affect three measurable things: (1) absorption/leasing velocity — strong-amenity projects sell or lease faster, (2) price/rent premium — a 3-8% premium is common for well-amenitized luxury projects, (3) resident satisfaction and renewal rate in institutional leasing. Practical rule: any amenity should be justified by a measurable return on at least one of these, not by luxury for its own sake — amenity overload without real market demand raises both construction and ongoing operating cost (service-charge/maintenance) without a matching return, and can even deter price-sensitive buyers. Pools and sky gardens (continuing maintenance cost passed through service charges) should be treated as a long-term operating commitment, not a one-time construction line.`,
  },
};

function classificationTip(core, icon){
  const c = EFF_CLASS[icon] || EFF_CLASS[''];
  const tips = {
    '🟢': core.T('يُحسَب ضمن GLA — يُدر إيراداً مباشراً؛ الهدف زيادة نسبته ضمن الحدود المعمارية/التنظيمية المذكورة دون التضحية بجودة التصميم.','Counts toward GLA — generates direct revenue; the goal is maximizing its share within the stated design/code limits without sacrificing design quality.'),
    '🔴': core.T('مساحة Non-GLA — تكلفة بناء بلا إيراد مباشر؛ الهدف تقليصها للحد الأدنى الوظيفي المذكور، لا حذفها (غالباً اشتراط تنظيمي/تشغيلي إلزامي).','Non-GLA area — construction cost with no direct revenue; the goal is trimming it to the stated functional minimum, not eliminating it (often a mandatory code/operational requirement).'),
    '🟡': core.T('مرفق داعم (Amenity) — قيمته غير مباشرة (سرعة بيع/علاوة سعرية/رضا مستأجر) — يجب أن يُبرَّر بعائد قابل للقياس لا بالفخامة لذاتها.','Supporting amenity — its value is indirect (faster absorption / price premium / tenant satisfaction) — should be justified by a measurable return, not luxury for its own sake.'),
    '': core.T('بند مرجعي/بنية عامة — معيار تصميمي أو تنظيمي عام لا يُصنَّف GLA/Non-GLA مباشرة.','Reference / general structural item — a general design or code parameter, not directly classified GLA/Non-GLA.'),
  };
  return tips[icon!=null && EFF_CLASS[icon]? icon : ''] || '';
}

function fmtRange(row){
  if(row.unitKind==='pct') return `${row.min}–${row.max}`;
  return `${row.min} – ${row.max}`;
}
function sectorLabel(core, key){
  const s = SECTORS[key];
  return s? core.T(s.ar, s.en) : (key||'—');
}
function rowLabel(core, row){
  const base = core.T(row.productAr, row.productFull.replace(/^.*\(([^)]*)\)\s*$/, '$1') || row.productFull);
  return row.variant? `${base} — ${row.variant}` : row.productFull;
}

/* أهم صفوف قطاع مُعيَّن — الأكثر تمثيلاً لقرارات الكفاءة (نرتّب: GLA أولاً كي
   يرى مدخل البيانات فرص الإيراد أولاً، ثم Amenity، ثم Non-GLA). limit افتراضي
   يناسب "مؤشر خفيف" لا قائمة كاملة (المكتبة الكاملة متاحة من زر المكتبة). */
function topRowsForSector(sectorKey, limit=5){
  const order = { '🟢':0, '🟡':1, '🔴':2, '':3 };
  return ROWS.filter(r=>r.sector===sectorKey)
    .slice()
    .sort((a,b)=> (order[a.effIcon]??3) - (order[b.effIcon]??3))
    .slice(0, limit);
}
function sectorsForUseType(useType){
  return USE_TYPE_TO_SECTORS[useType] || [];
}

/* سطر مصاريف تشغيلية مرجعية (OPEX) لقطاع مُعيَّن — إثراء مرحلة ٥ (المصدر
   الفعلي للنطاقات: OPEX_BY_SECTOR في fund-fees-opex-library.js). null يعني
   قطاعاً داعماً بلا إيراد مستقل (مثل مواقف/بنية تحتية) — لا نعرض سطراً له. */
function opexLineHtml(core, sectorKey){
  const b = OPEX_BY_SECTOR[sectorKey];
  if(!b) return '';
  return `<p class="note" style="margin:6px 0 0; font-size:11px;">🧾 ${core.T('نسبة المصاريف التشغيلية المرجعية (OPEX)','Reference operating expense ratio (OPEX)')}: <b>${core.fmtPct(b.min,0)}–${core.fmtPct(b.max,0)}</b> ${core.T('من الإيراد الفعلي','of EGI')} — <span style="color:var(--ink-faint);">${core.T(b.ar, b.en)}</span> (${core.T('مكتبة رسوم الصندوق والمصاريف','Fund Fees & Opex Library')})</p>`;
}

function indicatorBoxHtml(core, d){
  const useType = d.meta.useType;
  const sectors = sectorsForUseType(useType);
  if(!sectors.length) return '';
  const primary = sectors[0];
  const rows = topRowsForSector(primary, 6);
  return `
  <div class="section" style="margin-top:16px; background:var(--surface-2); border:1px dashed var(--border);">
    <p class="step-sub" style="margin:0 0 6px; display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
      <span>🏗️ ${core.T('مؤشرات معمارية مرجعية','Reference architectural indicators')} — ${sectorLabel(core, primary)}</span>
      <button type="button" class="btn btn-sm btn-ghost" data-action="seff-open" data-sector="${primary}">📚 ${core.T('المكتبة الكاملة','Full library')}</button>
    </p>
    <div class="tablewrap"><table class="db" style="font-size:11px;">
      <thead><tr>
        <th>${core.T('البند','Item')}</th><th>${core.T('النطاق','Range')}</th><th>${core.T('التصنيف','Class')}</th><th>${core.T('تكلفة/م² مرجعية','Ref. cost/m²')}</th>
      </tr></thead>
      <tbody>
        ${rows.map(r=>`<tr>
          <td style="font-size:10.5px;" title="${core.esc(r.logic)}">${core.esc(rowLabel(core,r))}</td>
          <td class="num mono" style="font-size:10.5px;">${core.esc(fmtRange(r))} <span style="color:var(--ink-faint);">${core.esc(r.unit)}</span></td>
          <td style="text-align:center;" title="${core.esc(classificationTip(core, r.effIcon))}">${r.effIcon||'—'}</td>
          <td class="num mono" style="font-size:10.5px;">${r.avgCostNum!=null? core.fmtSAR(r.avgCostNum)+'/'+core.esc(r.costUnit) : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    ${opexLineHtml(core, primary)}
    <p class="note" style="margin:8px 0 0; font-size:11px;">${core.T('مؤشر معلوماتي فقط — لا يُغيِّر أي حساب فعلي في الفرصة (النموذج الحالي يدعم نوع استخدام رئيسي واحد لكل فرصة). لعرض المكتبة الكاملة وخلاصة القطاع المهنية اضغط "المكتبة الكاملة" أعلاه.','Informational indicator only — does not change any actual calculation on this opportunity (the current model supports one primary use type per opportunity). Click "Full library" above for the complete library and sector professional brief.')}</p>
  </div>`;
}

export function registerSpaceEfficiencyLibrary(core){
  core.registerDataCollection(OVERRIDES_COLLECTION);
  let currentSectorFilter = null; // فلتر عرض محلي (module state) — لا يُخزَّن في core state، بنفس منطق أزرار الإجراءات النقرية (انظر ملاحظة roles-permissions.js حول عدم الاعتماد على أحداث change).

  core.registerTopbarButton(()=>{
    return `<button class="btn btn-sm" data-action="seff-open">🏗️ ${core.T('مكتبة الكفاءة والتكلفة','Efficiency & Cost Library')}</button>`;
  });

  /* (أ) لحظة الإدخال — Step 3 "نوع الاستخدام الرئيسي" */
  core.registerWizardStepExtra(3, (d)=> indicatorBoxHtml(core, d));

  /* (ب) صفحة الفرصة المحفوظة — نفس المؤشر + خلاصة القطاع المهنية الكاملة */
  core.registerDetailSection((d)=>{
    const useType = d.meta.useType;
    const sectors = sectorsForUseType(useType);
    if(!sectors.length) return '';
    const primary = sectors[0];
    const knowledge = SECTOR_KNOWLEDGE[primary];
    return `
    <div class="section">
      <h3>🏗️ ${core.T('الكفاءة المعمارية والتكلفة المرجعية','Architectural Efficiency & Cost Reference')} — ${sectorLabel(core, primary)}</h3>
      ${indicatorBoxHtml(core, d)}
      ${knowledge? `
      <div class="section" style="margin-top:10px; background:var(--surface-2);">
        <p class="step-sub" style="margin:0 0 6px;">💡 ${core.T('خلاصة مهنية للقطاع','Sector professional brief')}</p>
        <p class="note" style="line-height:1.8;">${core.T(knowledge.ar, knowledge.en)}</p>
      </div>` : ''}
    </div>`;
  });

  /* (ج) Main View كاملة — تصفح كل ١٥٣ سجلاً + التجاوزات، فلترة بالقطاع، تصديق/إضافة (FM+) */
  core.registerMainView('space-efficiency', ()=>{
    const overrides = core.STORE[OVERRIDES_COLLECTION] || [];
    const sectorKeys = Object.keys(SECTORS);
    const visibleRows = currentSectorFilter? ROWS.filter(r=>r.sector===currentSectorFilter) : ROWS;
    const visibleOverrides = currentSectorFilter? overrides.filter(o=>o.data.sector===currentSectorFilter) : overrides;

    return `
    <div class="section" style="margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
      <div>
        <h2 style="margin:0;">🏗️ ${core.T('مكتبة الكفاءة المعمارية والتكلفة المرجعية','Space Efficiency & Cost Reference Library')}</h2>
        <p class="note" style="margin:4px 0 0;">${core.T('سجلات أساسية (مرجع مؤسسي ثابت)','Baseline records (fixed institutional reference)')}: <b>${ROWS.length}</b> &nbsp;·&nbsp; ${core.T('تجاوزات/إضافات الفريق','Team overrides/additions')}: <b>${overrides.length}</b></p>
      </div>
      <button class="btn btn-sm btn-ghost" data-action="seff-close">✖ ${core.T('إغلاق ورجوع للوحة الفرص','Close & return to dashboard')}</button>
    </div>

    <div class="section" style="margin-bottom:14px;">
      <div class="small-btns" style="flex-wrap:wrap;">
        <button type="button" class="btn btn-sm ${!currentSectorFilter?'btn-primary':'btn-ghost'}" data-action="seff-filter-sector" data-sector="">${core.T('الكل','All')}</button>
        ${sectorKeys.map(k=>`<button type="button" class="btn btn-sm ${currentSectorFilter===k?'btn-primary':'btn-ghost'}" data-action="seff-filter-sector" data-sector="${k}">${sectorLabel(core,k)}</button>`).join('')}
      </div>
    </div>

    ${currentSectorFilter && SECTOR_KNOWLEDGE[currentSectorFilter]? `
    <div class="section" style="margin-bottom:14px; background:var(--surface-2); border:1px dashed var(--border);">
      <p class="step-sub" style="margin:0 0 6px;">💡 ${core.T('خلاصة مهنية للقطاع','Sector professional brief')} — ${sectorLabel(core,currentSectorFilter)}</p>
      <p class="note" style="line-height:1.8;">${core.T(SECTOR_KNOWLEDGE[currentSectorFilter].ar, SECTOR_KNOWLEDGE[currentSectorFilter].en)}</p>
      ${opexLineHtml(core, currentSectorFilter)}
    </div>` : ''}

    <div class="tablewrap"><table class="db" style="font-size:11px;">
      <thead><tr>
        <th>${core.T('الكود','ID')}</th><th>${core.T('البند','Item')}</th><th>${core.T('القطاع','Sector')}</th>
        <th>${core.T('النطاق','Range')}</th><th>${core.T('المنطق المعماري','Architectural logic')}</th>
        <th>${core.T('التصنيف','Class')}</th><th>${core.T('عبء المواقف','Parking load')}</th>
        <th>${core.T('تكلفة/م² مرجعية','Ref. cost/m²')}</th><th>${core.T('الحالة','Status')}</th>
      </tr></thead>
      <tbody>
        ${visibleRows.map(r=>`<tr>
          <td class="mono" style="font-size:10px;">${core.esc(r.id)}</td>
          <td style="font-size:10.5px;">${core.esc(rowLabel(core,r))}</td>
          <td style="font-size:10.5px;">${sectorLabel(core,r.sector)}</td>
          <td class="num mono" style="font-size:10.5px;">${core.esc(fmtRange(r))} <span style="color:var(--ink-faint);">${core.esc(r.unit)}</span></td>
          <td style="font-size:10px; color:var(--ink-faint);">${core.esc(r.logic)}</td>
          <td style="text-align:center;" title="${core.esc(classificationTip(core, r.effIcon))}">${r.effIcon||'—'} <span style="font-size:9px;">${core.esc(r.effText)}</span></td>
          <td style="font-size:10px;">${core.esc(r.parkingLoad||'—')}</td>
          <td class="num mono" style="font-size:10.5px;">${r.avgCostNum!=null? core.fmtSAR(r.avgCostNum)+'/'+core.esc(r.costUnit) : '—'}</td>
          <td>—</td>
        </tr>`).join('')}
        ${visibleOverrides.map(rec=>{
          const o = rec.data;
          return `<tr style="background:var(--surface-2);">
            <td class="mono" style="font-size:10px;">${core.esc(o.id||rec.id)}</td>
            <td style="font-size:10.5px;">${core.esc(o.label||'—')}</td>
            <td style="font-size:10.5px;">${sectorLabel(core,o.sector)}</td>
            <td class="num mono" style="font-size:10.5px;">${core.esc(o.min!=null?String(o.min):'—')}–${core.esc(o.max!=null?String(o.max):'—')} <span style="color:var(--ink-faint);">${core.esc(o.unit||'')}</span></td>
            <td style="font-size:10px; color:var(--ink-faint);">${core.esc(o.note||'—')}</td>
            <td style="text-align:center;">${core.esc(o.effIcon||'—')}</td>
            <td style="font-size:10px;">${core.esc(o.parkingLoad||'—')}</td>
            <td class="num mono" style="font-size:10.5px;">${o.avgCost!=null? core.fmtSAR(o.avgCost) : '—'}</td>
            <td>
              ${certifyBadge(core, o)}
              ${canManageLibraries(core)? `<div class="small-btns" style="margin-top:4px;">
                ${!o.certified? `<button class="btn btn-sm btn-ghost" data-action="seff-certify-override" data-id="${rec.id}">✅</button>` : ''}
                <button class="btn btn-sm btn-ghost" data-action="seff-delete-override" data-id="${rec.id}">🗑️</button>
              </div>` : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table></div>

    ${canManageLibraries(core)? `
    <div class="section" style="margin-top:14px; background:var(--surface-2); border:1px dashed var(--border);">
      <p class="step-sub" style="margin:0 0 10px;">➕ ${core.T('إضافة تجاوز/سجل محلي مخصّص (معايرة محلية للسوق أو بند غير مذكور في المكتبة الأساسية)','Add a local override / custom record (local market calibration, or an item not covered in the baseline library)')}</p>
      <form id="seff-add-form" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(140px,1fr)); gap:8px;">
        <input type="text" name="id" placeholder="${core.T('كود مقترح (اختياري)','Suggested ID (optional)')}" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
        <input type="text" name="label" placeholder="${core.T('اسم البند','Item name')}" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
        <select name="sector" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
          ${sectorKeys.map(k=>`<option value="${k}">${sectorLabel(core,k)}</option>`).join('')}
        </select>
        <input type="text" name="min" placeholder="${core.T('الحد الأدنى','Min')}" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
        <input type="text" name="max" placeholder="${core.T('الحد الأقصى','Max')}" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
        <input type="text" name="unit" placeholder="${core.T('الوحدة','Unit')}" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
        <input type="number" name="avgCost" placeholder="${core.T('تكلفة/م² مرجعية','Ref. cost/m²')}" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
        <select name="effIcon" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
          <option value="🟢">🟢 GLA</option><option value="🔴">🔴 Non-GLA</option><option value="🟡">🟡 Amenity</option>
        </select>
        <input type="text" name="parkingLoad" placeholder="${core.T('عبء المواقف','Parking load')}" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
        <input type="text" name="note" placeholder="${core.T('ملاحظة/معايرة محلية','Note / local calibration')}" style="grid-column:1/-1; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
      </form>
      <button type="button" class="btn btn-sm btn-primary" style="margin-top:8px;" data-action="seff-add-override">➕ ${core.T('إضافة','Add')}</button>
    </div>` : `
    <div class="section" style="margin-top:14px; background:var(--surface-2); border:1px dashed var(--border);">
      <p class="note" style="margin:0;">🔒 ${core.T('إضافة/تصديق/حذف التجاوزات المحلية يتطلب صلاحية مدير صندوق فأعلى — السجلات الأساسية متاحة للجميع دائماً للاستخدام في المقارنة.','Adding, certifying, or deleting local overrides requires Fund Manager tier or above — baseline records remain visible to everyone for comparison use.')}</p>
    </div>`}`;
  });

  core.registerActionHandler(async (action, el)=>{
    if(action==='seff-open'){
      currentSectorFilter = el.dataset.sector || null;
      core.setCoreState({ mainView:'space-efficiency', openDetailId:null, render:true });
      return true;
    }
    if(action==='seff-close'){ core.setCoreState({ mainView:null, render:true }); return true; }
    if(action==='seff-filter-sector'){
      currentSectorFilter = el.dataset.sector || null;
      core.render();
      return true;
    }
    if(action==='seff-add-override'){
      if(!canManageLibraries(core)) return true;
      const form = document.getElementById('seff-add-form');
      if(!form) return true;
      const g = name => form.querySelector(`[name="${name}"]`).value.trim();
      const label = g('label');
      if(!label) return true;
      const rec = { id: core.uid('SEFO'), data: {
        id: g('id') || null, label, sector: g('sector'),
        min: g('min') || null, max: g('max') || null, unit: g('unit') || null,
        avgCost: g('avgCost')!==''? Number(g('avgCost')) : null,
        effIcon: g('effIcon'), parkingLoad: g('parkingLoad') || null, note: g('note') || null,
        addedBy: core.currentUser? core.currentUser.email : (core.DEMO_MODE? 'زائر تجريبي':'محلي'),
        certified: false, certifiedBy: null, certifiedAt: null,
      }};
      await core.persistIfRecord(OVERRIDES_COLLECTION, rec);
      core.render();
      return true;
    }
    if(action==='seff-certify-override'){
      if(!canManageLibraries(core)) return true;
      const rec = (core.STORE[OVERRIDES_COLLECTION]||[]).find(r=>r.id===el.dataset.id);
      if(!rec) return true;
      const updated = { id: rec.id, data: { ...rec.data, certified:true, certifiedBy: core.currentUser? core.currentUser.email : 'محلي', certifiedAt: new Date().toISOString() } };
      await core.persistIfRecord(OVERRIDES_COLLECTION, updated);
      core.render();
      return true;
    }
    if(action==='seff-delete-override'){
      if(!canManageLibraries(core)) return true;
      await core.deleteIfRecord(OVERRIDES_COLLECTION, el.dataset.id);
      core.render();
      return true;
    }
    return false;
  });
}

export { SECTOR_KNOWLEDGE, topRowsForSector, sectorsForUseType };
