/* =========================================================================
   نقطة الدخول — Opal Real Estate Intelligence Platform
   ---------------------------------------------------------------------------
   core.js يبقى المحرك الأساسي (الفرص/التمويل/المستثمرين والصناديق) دون أي
   تغيير في منطقه الداخلي. أي نظام جديد (Investment Pipeline، Due Diligence،
   Investment Committee Workflow، Risk Engine، Investment Score، Data Quality
   Score، Audit Trail، وغيرها لاحقاً) يُبنى في ملف مستقل تحت src/features/
   ويُسجَّل نفسه هنا عبر نقاط التوسّع المُصدَّرة من core.js
   (registerTopbarButton / registerBodyView / registerDetailSection /
   registerActionHandler / registerWizardStepExtra / registerOpportunitySchemaExtender /
   registerDataCollection / registerBeforeOpportunitySave).
   هذا هو المكان الوحيد الذي يُفترض تعديله لإضافة/إزالة وحدة كاملة.

   ⚠️ ترتيب مهم: كل التسجيلات (register*) يجب أن تحدث هنا قبل استدعاء core.initDb() في
   نهاية هذا الملف — initDb() هي التي تبدأ تحميل/مزامنة البيانات لأول مرة (محلياً أو عبر
   Firestore)، فأي مجموعة بيانات إضافية (registerDataCollection) يجب أن تكون مُسجَّلة قبلها
   حتى تُحمَّل من أول تشغيل.
   ========================================================================= */
import * as core from './core.js?v=20260913-institutional-intelligence';

// إتاحة كل صادرات core.js على window — للتوافق الخلفي الكامل مع كل سكربتات
// الاختبار (Playwright) المكتوبة طوال هذا المشروع (تستدعي
// blankOpportunity()/compute()/render()/... كمتغيرات عامة في صفحة المتصفح)،
// ولسهولة التصحيح المباشر من Console المتصفح. core.js نفسه لا يعتمد على هذا
// (يستخدم أسماءه الداخلية مباشرة)، فهذا لا يؤثر على تسلسل التهيئة الداخلي.
//
// ⚠️ ملاحظة هندسية مهمة: لا نستخدم Object.assign(window, core) هنا عمداً.
// Object.assign ينسخ القيمة الحالية لكل خاصية *لحظة التنفيذ فقط* (نسخة
// جامدة/snapshot)، بينما خاصيات كائن وحدة ES (Module Namespace Object) هي
// "live bindings" فعلياً — قيمتها الحقيقية تتغيّر لاحقاً كلما أعاد core.js
// تعيين متغير let مُصدَّر داخلياً (مثال: opportunities تُعاد كتابتها بالكامل
// داخل initDb()/loadAll() بعد أن ينفَّذ هذا السطر بلحظات، بشكل غير متزامن).
// نسخ Object.assign كان سيجمّد window.opportunities على القيمة الأولى (مصفوفة
// فارغة) إلى الأبد، بينما التطبيق نفسه (عبر render() الداخلية) يعمل بشكل
// صحيح — تناقض صامت بين ما يُعرض فعلياً وما تراه أي سكربتات اختبار خارجية.
// الحل: نُعرِّف كل خاصية على window كـ getter حي يقرأ من core[key] في كل
// مرة — يعكس القيمة الحقيقية اللحظية دائماً. الكتابة المباشرة لمتغير عام
// (مثل `wizard = {...}` من خارج core.js) تبقى غير مدعومة كما كانت (استخدم
// core.setCoreState() بدلاً من ذلك) — هذا التغيير يُصلح جهة القراءة فقط.
for (const key of Object.keys(core)) {
  try {
    Object.defineProperty(window, key, {
      get(){ return core[key]; },
      configurable: true,
      enumerable: true,
    });
  } catch(e) {
    console.warn('تعذّر ربط', key, 'كخاصية حيّة على window:', e);
  }
}

/* ---------------- تسجيل الوحدات الإضافية (Phase 1+) ---------------- */
// المذكرة التنفيذية الآلية (automated-ic-memo.js) تُسجَّل أولاً عمداً — قبل كل الوحدات الأخرى —
// حتى يظهر قسمها ("الملخص التنفيذي الآلي") في أعلى قائمة الأقسام الإضافية داخل مذكرة كل فرصة
// (مباشرة بعد محتوى core.js الأساسي، قبل بقية الأقسام). لا يعتمد على ترتيب استيراد ai-analyst.js
// (الذي تستورد منه generateAnalystNarrative) — استيراد ES modules يُحل عند التحميل بصرف النظر
// عن ترتيب استدعاء دوال register*.
import { registerAutomatedICMemo } from './features/automated-ic-memo.js';
registerAutomatedICMemo(core);

import { registerAuditTrail } from './features/audit-trail.js';
registerAuditTrail(core);

import { registerPipeline } from './features/pipeline.js';
registerPipeline(core);

import { registerDueDiligence } from './features/due-diligence.js';
registerDueDiligence(core);

import { registerDataQuality } from './features/data-quality.js';
registerDataQuality(core);

import { registerRiskEngine } from './features/risk-engine.js';
registerRiskEngine(core);

import { registerInvestmentScore } from './features/investment-score.js';
registerInvestmentScore(core);

import { registerICWorkflow } from './features/ic-workflow.js?v=20260913-stage7b';
registerICWorkflow(core);

/* ---------------- المرحلة ٢ ---------------- */
import { registerMaxAcquisitionPrice } from './features/max-acquisition-price.js';
registerMaxAcquisitionPrice(core);

// لوحة XIRR المقارنة (Shadow، للمقارنة فقط، تاريخ أساس يدوي) — لا تغيّر IRR ولا بوابة اللجنة.
import { registerXirrComparisonPanel } from './features/xirr-comparison-panel.js';
registerXirrComparisonPanel(core);

import { registerNegotiation } from './features/negotiation.js';
registerNegotiation(core);

import { registerScenarioManager } from './features/scenario-manager.js';
registerScenarioManager(core);

import { registerComparables } from './features/comparables.js';
registerComparables(core);

import { registerValuationEngine } from './features/valuation-engine.js';
registerValuationEngine(core);

import { registerEvidenceTracking } from './features/evidence-tracking.js';
registerEvidenceTracking(core);

/* ---------------- المرحلة ٣ ---------------- */
import { registerPortfolio } from './features/portfolio.js';
registerPortfolio(core);

import { registerConcentrationRisk } from './features/concentration-risk.js';
registerConcentrationRisk(core);

import { registerBenchmarkEngine } from './features/benchmark-engine.js';
registerBenchmarkEngine(core);

import { registerAlerts } from './features/alerts.js';
registerAlerts(core);

import { registerCommandCenter } from './features/command-center.js';
registerCommandCenter(core);

import { registerAIAnalyst } from './features/ai-analyst.js';
registerAIAnalyst(core);

import { registerDataRoom } from './features/data-room.js';
registerDataRoom(core);

/* ---------------- إعادة هيكلة التقارير (Print / Excel / PowerPoint) ---------------- */
// كتاب لجنة الاستثمار الكامل (٢١ قسماً) — طريقة عرض رئيسية جديدة مستقلة عن renderDetail
// الحالية في core.js (انظر التعليق التفصيلي في رأس ic-book-print.js لسبب هذا القرار).
import { registerICBookPrint } from './features/ic-book-print.js';
registerICBookPrint(core);

// دفتر الاكتتاب الاستثماري الكامل (٢١ ورقة Excel) — تصدير مستقل عن exportOpportunityExcel
// القديمة في core.js؛ أزيلت أزرار التصدير القديمة من رأس مذكرة الفرصة حتى لا تختلط
// النسخة القديمة بالدفتر المؤسسي الجديد.
import { registerExcelWorkbook } from './features/excel-workbook.js';
registerExcelWorkbook(core);

// عرض لجنة الاستثمار (١٢ شريحة PowerPoint) — تصدير مستقل عن exportOpportunityPptx
// القديمة في core.js؛ أصبح هذا هو مسار العرض الرسمي من داخل قسم تفاصيل الفرصة.
import { registerICPresentation } from './features/ic-presentation.js';
registerICPresentation(core);

/* ---------------- المرحلة ٤ (الأدوار والصلاحيات + إثراء المكتبات المرجعية) ---------------- */
// الأدوار والصلاحيات — يجب تسجيلها أولاً بين وحدات المرحلة ٤ لأن الوحدات التالية (المكتبات
// المرجعية الجديدة) تستورد دوال الفحص منها مباشرة (canManageLibraries/certifyBadge) — لا علاقة
// بترتيب التسجيل نفسه (وحدات ES تُحل عند الاستيراد بصرف النظر عن هذا الترتيب)، فقط توضيح منطقي.
import { registerRolesPermissions } from './features/roles-permissions.js';
registerRolesPermissions(core);

// مكتبة الكفاءة المعمارية والتكلفة المرجعية — تُسجَّل بعد الأدوار مباشرة (تستورد
// canManageLibraries/certifyBadge منها). طلب المستخدم الثاني في هذه المرحلة: مكتبة
// كفاءة/تكلفة غنية تُظهر مؤشرات معمارية لحظة الإدخال (Step 3: نوع الاستخدام الرئيسي).
import { registerSpaceEfficiencyLibrary } from './features/space-efficiency-library.js';
registerSpaceEfficiencyLibrary(core);

// قنوات الخروج المؤسسية (REIT بالجملة / Strata / إعادة تمويل / IPO / تصفية صندوق) — طلب
// المستخدم الثالث في هذه المرحلة. لا علاقة بـEXIT_STRATEGIES/holdStrategy الحاليين في
// core.js (يبقيان بلا أي تعديل) — بُعد "قناة المشتري" إضافي وإعلامي فقط (انظر رأس الملف).
import { registerExitChannels } from './features/exit-channels.js';
registerExitChannels(core);

// رافعات الجدوى القابلة للتفعيل — طلب المستخدم الرابع. تستورد matchBenchmarks/
// aggregateBench من benchmark-engine.js مباشرة (يجب أن يكون معرَّفاً/مُصدَّراً وقت
// الاستيراد — ترتيب الاستيراد هنا غير حرج فعلياً لأن ES modules تُحل كل الاستيرادات
// أولاً بصرف النظر عن ترتيب سطور import، لكن نضعه بعد تسجيل benchmark-engine منطقياً).
import { registerFeasibilityLevers } from './features/feasibility-levers.js';
registerFeasibilityLevers(core);

// مكتبة منحنيات التوزيع الإحصائي للتكاليف/الافتراضات — طلب المستخدم الخامس (سؤال
// اقترحه ووافقنا عليه). مرجعي/تثقيفي بالكامل، لا يُغيِّر أي حساب.
import { registerCostDistributionLibrary } from './features/cost-distribution-library.js';
registerCostDistributionLibrary(core);

/* ---------------- المرحلة ٥ (رسوم/مصاريف الصندوق + خريطة الفرص) ---------------- */
// مكتبة رسوم الصندوق والمصاريف التشغيلية المرجعية — تُسجَّل قبل space-efficiency-library
// (فوق) بحكم ترتيب الاستيراد فقط (لا يؤثر على تسلسل التسجيل الفعلي — ES modules تُحل كل
// الاستيرادات أولاً)؛ يُصدِّر OPEX_BY_SECTOR الذي تستورده space-efficiency-library.js
// باتجاه واحد فقط (طلب المستخدم "كلاهما": مكتبة رسوم جديدة + إغناء المكتبة القائمة).
import { registerFundFeesOpexLibrary } from './features/fund-fees-opex-library.js';
registerFundFeesOpexLibrary(core);

// خريطة الفرص العقارية (Leaflet.js) — طلب المستخدم الثاني في هذه المرحلة، بموقع دقيق
// (Lat/Lng) لكل فرصة (حقل جذر جديد geo، عبر registerOpportunitySchemaExtender) بدل مجرد
// تجميع فرص كل مدينة عند نقطة واحدة. راجع رأس opportunities-map.js لتفاصيل آلية التهيئة بعد
// الرسم (MutationObserver) بلا أي تعديل على core.js.
import { registerOpportunitiesMap } from './features/opportunities-map.js';
registerOpportunitiesMap(core);

/* ---------------- المرحلة ٦ (الأنظمة السعودية + Rent Roll + السياق الاقتصادي + الاستدامة) ---------------- */
// طلب المستخدم (بعد اختيار الأربعة معاً عبر AskUserQuestion): مكتبة الأنظمة واللوائح
// السعودية المرجعية، سجل عقود الإيجار التفصيلي (Rent Roll)، طبقة السياق الاقتصادي الكلي
// على الخريطة (مشاريع رؤية ٢٠٣٠)، وتصنيف الاستدامة (مستدام/ESG). ملاحظة استيراد مهمة:
// geo-utils.js (وُرِثَ من المرحلة ٥) ملف "ورقة" بلا أي استيراد، تستورده كل من
// opportunities-map.js وmacro-context.js باتجاه واحد فقط؛ وopportunities-map.js يستورد
// MEGAPROJECTS من macro-context.js باتجاه واحد أيضاً (macro-context.js لا يستورد شيئاً من
// opportunities-map.js) — فلا استيراد دائري بين الملفين الثلاثة، بصرف النظر عن ترتيب
// استدعاءات register* أدناه (ES modules تُحل كل الاستيرادات وقت التحميل، لا وقت التسجيل).

// مكتبة الأنظمة واللوائح العقارية السعودية المرجعية — تستورد canManageLibraries/certifyBadge
// من roles-permissions.js (مُسجَّلة فعلاً أعلاه في المرحلة ٤).
import { registerSaudiRegulatoryLibrary } from './features/saudi-regulatory-library.js';
registerSaudiRegulatoryLibrary(core);

// سجل عقود الإيجار التفصيلي (Rent Roll) — بيانات عملياتية خاصة بكل فرصة (حقل جذر جديد
// rentRoll)، محمية بصلاحية core.canEditOpp(rec) نفسها (لا canManageLibraries — ليست مكتبة
// مرجعية مشتركة للفريق، بل بيانات صفقة). لا يستورد ولا يُستورَد من أي ملف آخر هنا.
import { registerRentRoll } from './features/rent-roll.js';
registerRentRoll(core);

// طبقة السياق الاقتصادي الكلي (مشاريع رؤية ٢٠٣٠) — تُسجَّل بعد خريطة الفرص منطقياً (تُضيف
// طبقة اختيارية فوقها عبر opportunities-map.js نفسه الذي استورد MEGAPROJECTS منها أعلاه)،
// وتُسجِّل بنفسها قسم تفاصيل "أقرب مشروع كبرى" (Haversine، عبر geo-utils.js).
import { registerMacroContext } from './features/macro-context.js';
registerMacroContext(core);

// تصنيف الاستدامة (مستدام/ESG) — النظام الرابع والأخير المطلوب في هذه المرحلة. حقل جذر جديد
// (sustainability) عبر registerOpportunitySchemaExtender، مرجعي بالكامل بلا أي تعديل على أي
// حساب فعلي في core.js. لا يستورد ولا يُستورَد من أي ملف آخر هنا.
import { registerSustainabilityMostadam } from './features/sustainability-mostadam.js';
registerSustainabilityMostadam(core);

/* ---------------- المرحلة ٧ (الحوكمة والضبط المؤسسي — P0) ---------------- */
// "لا أريد الآن أن نصل إلى ٩٫٥ بإضافة Features. أريد أن نصل إلى ٩٫٥ بالحوكمة."
// هذه المرحلة لا تضيف نظاماً استثمارياً جديداً بالمعنى المعتاد — تُحكِّم ما هو
// موجود فعلاً: صلاحيات لجنة الاستثمار الحقيقية (لا owner-based)، بوابة جهوزية
// حقيقية بدل "تسجيل قرار" حر، توحيد نموذج الصلاحيات بين الواجهة وFirestore،
// سجل تدقيق غير قابل للتلاعب (Cloud Function، انظر ../../functions)، وتسعير
// موثَّق بالإصدارات. تعديلات ic-workflow.js/comparables.js/evidence-tracking.js/
// audit-trail.js نفسها أعلاه (لا تسجيل جديد لها — register* الحالي لكل منها
// كافٍ)؛ وحدتان جديدتان فقط تحتاجان تسجيلاً:

// بوابة قرار لجنة الاستثمار — تستورد evidenceCoverageStats من evidence-tracking.js
// (المُسجَّلة أعلاه في المرحلة ٢) ودوال أخرى من due-diligence.js/data-quality.js/
// max-acquisition-price.js (كل ذلك عبر import ثابت، لا يعتمد على ترتيب التسجيل).
// يجب تسجيلها قبل ic-workflow.js منطقياً في العرض (تظهر بوابة الجهوزية في قسمها
// المستقل، ثم قسم "لجنة الاستثمار" الذي يستخدم icReadiness() داخلياً لمنع الاعتماد
// دون جهوزية) — لكن ic-workflow.js نفسه مُسجَّل أعلاه في Phase 1 بالفعل، فهذا الترتيب
// هنا يؤثر فقط على ترتيب ظهور الأقسام الإضافية الجديدة نسبياً لبعضها، لا على الاستيراد.
import { registerICDecisionGate } from './features/ic-decision-gate.js';
registerICDecisionGate(core);

// التسعير الموثَّق بالإصدارات (v1→v4 + Actual vs. Underwriting) — مجموعة بيانات
// جديدة مستقلة (underwritingVersions) + حقل جذر جديد (actuals). يستمع تلقائياً لكل
// حفظ فرصة (registerBeforeOpportunitySave) لاكتشاف قرار لجنة اعتماد جديد.
import { registerUnderwritingVersions } from './features/underwriting-versions.js?v=20260913-stage7b';
registerUnderwritingVersions(core);

// دقة زمنية للتدفقات النقدية (شهري/ربع سنوي/سنوي) + ذروة الاحتياج النقدي الفعلي + صافي
// النقدي المطلوب من المستثمرين النقديين بعد خصم المساهمات العينية.
import { registerCashFlowTiming } from './features/cash-flow-timing.js';
registerCashFlowTiming(core);

// التحصين المؤسسي (المرحلة الثانية) — سجل قرارات لجنة استثمار مستقل append-only (icDecisions)،
// ملف تخصيص رأسمالي على مستوى الفرصة، وقسم تفصيلي يعرض Draw Profile/VAT Recovery/Variance.
import { registerInstitutionalHardening } from './features/institutional-hardening.js';
registerInstitutionalHardening(core);

// محرك ربط رأس المال (المرحلة الخامسة) — يُسجَّل بعد institutional-hardening.js عمداً (يقرأ
// capitalAllocation التي يضيفها ذلك الملف للمخطط)؛ يربط فعلياً IC decisions/Conditions
// بربط الفرصة كأصل صندوق (fund.assetIds عبر بوابة registerAssetLinkGuard في core.js) وبسعة
// دفتر الصندوق الرأسمالية (fundLedgerSummary) — يغلق الفجوة التي أثبتتها المرحلة الرابعة حياً.
import { registerCapitalAllocationEngine } from './features/capital-allocation-engine.js';
registerCapitalAllocationEngine(core);

/* ---------------- المرحلة التاسعة (تكامل Monday.com — إعداد آمن جانب التطبيق) ---------------- */
// إعداد جانب التطبيق فقط: لوحة أدمن وقائمة انتظار مزامنة بلا أي رمز API في العميل.
import { registerMondayIntegration } from './features/monday-integration.js';
registerMondayIntegration(core);

/* ---------------- محرك الذكاء الاستثماري المؤسسي ---------------- */
// لوحة موحدة: Investment Intelligence، Portfolio Intelligence، Allocation
// Optimizer، Portfolio Stress Testing، Early Warning Engine، Investment Passport،
// Knowledge Engine، Reporting Hub، وRegression/Security dashboards.
import { registerInstitutionalInvestmentIntelligence } from './features/institutional-investment-intelligence.js?v=20260913-institutional-intelligence';
registerInstitutionalInvestmentIntelligence(core);

/* ---------------- التهيئة ---------------- */
core.initDb();
