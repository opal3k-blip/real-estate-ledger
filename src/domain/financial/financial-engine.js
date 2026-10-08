/*
 * Phase 2R-2 shared financial engine.
 *
 * Recovery rule: this module is a literal extraction of the current financial
 * calculations from src/core.js. It intentionally receives legacy context
 * (defaults and classification tables) as dependencies so the extraction can be
 * proven equivalent before any authority cutover or defaults consolidation.
 */

const REQUIRED_DEPENDENCIES = [
  'blankOpportunity',
  'TIERS',
  'USE_TYPES',
  'SITE_FACTORS',
  'DEV_REFI_STRATEGY_KEY',
  'isResidentialUseType',
];

export function createFinancialEngine(dependencies = {}){
  for(const key of REQUIRED_DEPENDENCIES){
    if(dependencies[key] == null){
      throw new Error(`createFinancialEngine: missing dependency ${key}`);
    }
  }

  const {
    blankOpportunity,
    TIERS,
    USE_TYPES,
    SITE_FACTORS,
    DEV_REFI_STRATEGY_KEY,
    isResidentialUseType,
  } = dependencies;

  function irr(cashflows){
    // Newton's method with bisection fallback. cashflows[0] is year 0.
    // حارس ضروري: عندما تكون كل التدفقات صفراً (مثلاً معالج فرصة جديدة لم تُعبَّأ
    // أرقامه بعد)، فإن NPV(r)=0 عند أي معدل r — ما كان يجعل الحلقة تتقارب فوراً
    // على تخمين نيوتن الابتدائي (0.15 = 15%) وتُعيده كأنه معدل عائد داخلي حقيقي،
    // رغم أنه رقم عشوائي بلا أي معنى. نتحقق هنا صراحة ونُرجع NaN بدلاً من ذلك.
    if(!Array.isArray(cashflows) || cashflows.length<2) return NaN;
    if(cashflows.every(v=>!v || Math.abs(v)<1e-9)) return NaN;
    function npv(r){ let s=0; for(let t=0;t<cashflows.length;t++) s += cashflows[t]/Math.pow(1+r,t); return s; }
    let r = 0.15;
    for(let i=0;i<60;i++){
      const f = npv(r);
      const df = (npv(r+1e-5)-f)/1e-5;
      if(Math.abs(df)<1e-9) break;
      const rn = r - f/df;
      if(!isFinite(rn)) break;
      if(Math.abs(rn-r)<1e-7){ r=rn; break; }
      r = rn;
    }
    if(isFinite(r) && Math.abs(npv(r))<1) return r;
    // bisection fallback over a wide range
    let lo=-0.95, hi=5, flo=npv(lo), fhi=npv(hi);
    if(flo*fhi>0) return NaN;
    for(let i=0;i<200;i++){
      const mid=(lo+hi)/2, fm=npv(mid);
      if(Math.abs(fm)<1) return mid;
      if(flo*fm<0){ hi=mid; fhi=fm; } else { lo=mid; flo=fm; }
    }
    return (lo+hi)/2;
  }
  function npvAt(rate, cashflows){ let s=0; for(let t=0;t<cashflows.length;t++) s+=cashflows[t]/Math.pow(1+rate,t); return s; }

  /* Backward-compatible defaults merge: fills any field missing from an older
     saved record (or a partially-built draft) with blankOpportunity()'s defaults,
     without touching anything the record already has. */
  function withDefaults(o){
    const b = blankOpportunity();
    function merge(dst, src){
      for(const k in src){
        const sv = src[k];
        if(sv && typeof sv==='object' && !Array.isArray(sv)){
          if(dst[k]==null || typeof dst[k]!=='object' || Array.isArray(dst[k])) dst[k] = {};
          merge(dst[k], sv);
        } else if(dst[k]===undefined){
          dst[k] = sv;
        }
      }
      return dst;
    }
    return merge(JSON.parse(JSON.stringify(o||{})), b);
  }

  function compute(o, scenarioKey){
    o = withDefaults(o);
    const scn = (scenarioKey && scenarioKey!=='base' && o.scenarios && o.scenarios[scenarioKey]) ? o.scenarios[scenarioKey] : null;
    const rentMult = scn? scn.rentMult : 1;
    const salePriceMult = scn? scn.salePriceMult : 1;
    const costMult = scn? scn.costMult : 1;
    const capRateDelta = scn? scn.capRateDelta : 0;
    const rateDelta = scn? scn.rateDelta : 0;

    const land = o.land, site = o.site, strat = o.strategy, meta = o.meta;
    const tierMult = TIERS[meta.tier] ?? 1.0;
    const useInfo = USE_TYPES[meta.useType] || {mult:1,niy:0.07};
    const siteFactor = [site.soil,site.water,site.tower,site.topo,site.infra].reduce((prod,idx,i)=>{
      const keys=['soil','water','tower','topo','infra'];
      const opt = SITE_FACTORS[keys[i]][idx||0];
      return prod * opt[1];
    },1);

    const landCost = land.area * land.price;
    const gfa = land.area * land.far;
    const footprint = land.area * land.bar;
    const floorsNeeded = footprint>0? Math.ceil(gfa/footprint) : 0;
    const buildingHeight = floorsNeeded * land.floorHeight;
    const landCostPerGFA = gfa>0? landCost/gfa : 0;
    // إصلاح حوكمة: كان tierMult يُحسب هنا ويُعرَض في التقارير كـ"المعامل المركّب الكلي" دون أن
    // يُضرَب فعلياً في أي تكلفة أو إيراد — أي أن تغيير "فئة الحي" (بريميوم/راقي/متوسط/شعبي) لم يكن
    // يُغيّر أي رقم مالي فعلي رغم ظهوره في الواجهة وكأنه مؤثر. الآن يُضرَب tierMult فعلياً في تكلفة
    // البناء الرأسية (verticalCost) وتكلفة البدرومات لفرص التطوير والدخل (انظر أدناه)، بما يطابق هذا
    // التعريف نفسه.
    const masterMultiplier = tierMult * useInfo.mult * siteFactor;

    // علاوة تكلفة الارتفاع — أي زيادة في ارتفاع الدور عن المرجع القياسي (3.6م) تعني هيكلاً ووزناً
    // ذاتياً وواجهات ومصاعد أثقل، فتُحمَّل كنسبة إضافية على تكلفة البناء للمتر (فوق الأرض وتحتها معاً).
    const BASE_FLOOR_HEIGHT = 3.6;
    const floorHeightPremiumPct = land.floorHeightPremiumPct ?? 0.04;
    const heightPremiumMult = 1 + Math.max(0, (land.floorHeight||BASE_FLOOR_HEIGHT) - BASE_FLOOR_HEIGHT) * floorHeightPremiumPct;

    // علاوة تكلفة البدرومات — البناء تحت منسوب الأرض أعلى تكلفة دوماً (حفر، دعم جوانب الحفرة، عزل
    // مائي، خفض منسوب المياه الجوفية)، وتتصاعد العلاوة كل ما ازداد العمق (بدروم 2 أغلى من 1، وهكذا).
    // مساحة البدرومات = بصمة المبنى (footprint) لكل مستوى، ولا تُحتسب ضمن GFA لأنها لا تدخل في FAR عادة.
    const basementLevels = Math.max(0, Math.round(land.basements||0));
    const basementCostPremiumPct = land.basementCostPremiumPct ?? 0.30;
    const basementDepthEscalationPct = land.basementDepthEscalationPct ?? 0.07;
    let basementArea = 0, basementPremiumAvgPct = 0;
    for(let lvl=1; lvl<=basementLevels; lvl++){
      basementArea += footprint;
      basementPremiumAvgPct += (basementCostPremiumPct + (lvl-1)*basementDepthEscalationPct);
    }
    if(basementLevels>0) basementPremiumAvgPct /= basementLevels;
    const gfaWithBasements = gfa + basementArea;
    // تكلفة البدرومات الإجمالية — تُحتسب لاحقاً داخل كل نوع فرصة (تصفير لفرص البنية التحتية فقط أو تخزين الأرض)
    function basementCostFor(costMultLocal){
      let sum = 0;
      for(let lvl=1; lvl<=basementLevels; lvl++){
        const levelPremiumMult = 1 + basementCostPremiumPct + (lvl-1)*basementDepthEscalationPct;
        sum += footprint * ((o.development.buildCost||0)*costMultLocal) * tierMult * useInfo.mult * siteFactor * heightPremiumMult * levelPremiumMult;
      }
      return sum;
    }

    const type = meta.oppType; // income | development | landbank
    const assetClass = type==='income' ? (o.income.assetClass||'عام') : 'عام';
    // لفرص التطوير: "إعادة تمويل (Hold/Refinance)" في قائمة استراتيجية الخروج كانت مجرد تسمية بدون أي أثر
    // حسابي فعلي (تضبط نسبة البيع فقط، مثل بقية الخيارات) — الآن تُفعِّل فعلياً منطق إعادة التمويل عند الخروج
    // بدل البيع بمعدل الرسملة، بنفس آلية "إعادة تمويل لإغلاق الصندوق" المستخدَمة أصلاً لفرص الدخل التأجيري.
    const holdStrategy = type==='income' ? (o.income.holdStrategy||'exit_sale')
      : (type==='development' && strat.exitStrategy===DEV_REFI_STRATEGY_KEY) ? 'refinance_close'
      : 'exit_sale';
    const refi = Object.assign({intervalYears:5, refiLtv:0.65, refiCostPct:0.01, analysisHorizon:10}, o.income.refinance||{});
    const scopeType = (type==='development'||type==='income') ? (o.development.scopeType||'both') : 'both';
    const infraCostPerSqm = o.development.infraCostPerSqm || 0;

    let hardCostBase = 0, hardCost = 0, salePct = strat.salePct;
    // تعميم "البيع + الإيجار المختلط" لفرص الدخل — معطَّل افتراضياً (o.income.mixedUse=false) للحفاظ على
    // سلوك أي فرصة دخل محفوظة مسبقاً دون أي تغيير (قيمة strategy.salePct الافتراضية 0.5 تبقى بلا أثر ما لم
    // يُفعِّل المستخدم هذا الخيار صراحةً من واجهة المعالج). عند التفعيل، تُطبَّق بالضبط نفس آلية فرص التطوير:
    // جزء salePct من المساحة "يُباع" (يقلّص الإشغال المؤجَّر تناسبياً طوال مدة التشغيل)، وقيمته النقدية تُحتسب
    // عند الخروج بجانب قيمة الجزء المُبقى مؤجَّراً مرسملةً بمعدل الرسملة السوقي.
    const applySalePctToIncome = type==='income' && !!(o.income.mixedUse);
    let constructionYears = 0, operationYears = 0;
    let verticalCost = 0;
    const contingencyPct = o.development.contingency ?? 0.05;
    const cb = o.development.costBreakdown || {structure:0.42,mep:0.18,finishes:0.20,external:0.08,fees:0.12};
    const infraCostAmt = (type!=='landbank' && scopeType!=='vertical_only') ? land.area * infraCostPerSqm * costMult : 0;

    let basementCostAmt = 0;
    if(type==='landbank'){
      hardCostBase = 0; hardCost = 0;
      constructionYears = 0;
      operationYears = o.landbank.holdingYears;
    } else if(type==='development'){
      verticalCost = scopeType==='infra_only' ? 0 : gfa * (o.development.buildCost*costMult) * tierMult * useInfo.mult * siteFactor * heightPremiumMult;
      basementCostAmt = scopeType==='infra_only' ? 0 : basementCostFor(costMult);
      hardCostBase = verticalCost + basementCostAmt + infraCostAmt;
      hardCost = hardCostBase * (1+contingencyPct);
      constructionYears = o.development.constructionYears;
      // تقسيم الأراضي على مراحل: مدة "التشغيل" = مدة جدول الامتصاص نفسه (كل شريحة تُباع في سنة مختلفة)،
      // بدل قيمة operationYears العادية التي لا معنى لها هنا (لا يوجد تشغيل تأجيري، فقط بيع تدريجي).
      // البيع على الخارطة: كل الوحدات تُباع وتُسلَّم بنهاية الإنشاء نفسه (100% مُباعة عبر الشرائح) — لا توجد
      // مدة تشغيل تأجيري لاحقة إطلاقاً، فمدة الصندوق الكلية = مدة الإنشاء فقط.
      operationYears = (scopeType==='infra_only' && o.subdivision && o.subdivision.phasedAbsorption)
        ? Math.max(1, o.subdivision.absorptionYears||4)
        : (scopeType!=='infra_only' && strat.offPlanSale && strat.offPlanSale.enabled) ? 0
        : o.development.operationYears;
    } else { // income
      verticalCost = scopeType==='infra_only' ? 0 : gfa * ((o.development.buildCost||4800)*costMult) * tierMult * useInfo.mult * siteFactor * heightPremiumMult;
      basementCostAmt = scopeType==='infra_only' ? 0 : basementCostFor(costMult);
      hardCostBase = verticalCost + basementCostAmt + infraCostAmt;
      hardCost = hardCostBase * (1+contingencyPct);
      constructionYears = o.development.constructionYears || 1;
      operationYears = o.development.operationYears || 5;
    }
    // Cost breakdown (structure/MEP/finishes/external/fees) describes the composition of the
    // VERTICAL building cost only — infrastructure cost is a separate, structurally distinct
    // line item and must not dilute these percentages.
    const costBreakdownAmounts = {
      structure: verticalCost*(cb.structure||0), mep: verticalCost*(cb.mep||0), finishes: verticalCost*(cb.finishes||0),
      external: verticalCost*(cb.external||0), fees: verticalCost*(cb.fees||0), contingency: hardCostBase*contingencyPct,
    };

    // one-time / fixed fund fees
    const oneTimeFixed = o.fees.cmaSetup + o.fees.dueDiligence + o.fees.valuation;
    const structuringFee = o.fees.structuring * (landCost + hardCost);
    const acquisitionFee = o.fees.acquisition * landCost;

    // البيع على الخارطة قد يمتد تحصيله إلى ما بعد نهاية الإنشاء بسبب تأخير الضمان.
    // يجب أن يمتد أفق الصندوق معه بدلاً من قصّ سنة التحصيل الأخيرة داخل سنة الإنشاء الأخيرة.
    const offPlanLagYears = (type==='development' && scopeType!=='infra_only' && strat.offPlanSale && strat.offPlanSale.enabled)
      ? Math.max(0, Math.round(strat.offPlanSale.escrowLagYears||0)) : 0;
    const offPlanCollectionHorizon = constructionYears + offPlanLagYears;
    const totalYears = holdStrategy==='perpetual_hold'
      ? Math.max(1, constructionYears + Math.max(1, refi.analysisHorizon||10), offPlanCollectionHorizon)
      : Math.max(1, constructionYears + operationYears, offPlanCollectionHorizon);

    // Debt sizing — single tranche, or Senior + Mezzanine
    const preTPC = landCost + hardCost + oneTimeFixed + structuringFee + acquisitionFee;
    const totalDebtTarget = preTPC * o.financing.ltc;
    const seniorRate = o.financing.saibor + o.financing.margin + rateDelta;
    let seniorDebt, mezzDebt, interestRate;
    if(o.financing.structure==='senior_mezz'){
      seniorDebt = totalDebtTarget * (o.financing.seniorPct??0.80);
      mezzDebt = totalDebtTarget - seniorDebt;
      const mezzRate = seniorRate + (o.financing.mezzMarginAdj??0.04);
      interestRate = totalDebtTarget>0 ? (seniorDebt*seniorRate + mezzDebt*mezzRate)/totalDebtTarget : seniorRate;
    } else {
      seniorDebt = totalDebtTarget; mezzDebt = 0;
      interestRate = seniorRate;
    }
    const debt = totalDebtTarget;
    const arrangementFee = o.financing.ltc>0 ? o.fees.arrangement * debt : 0;
    // Stage 2 institutional financing: construction debt can now have an explicit draw profile.
    // Empty profile preserves legacy full-balance behavior; otherwise percentages are normalized
    // across construction years and interest is charged on average beginning/ending balance.
    const rawDraw = Array.isArray(o.financing.drawSchedulePct) ? o.financing.drawSchedulePct.map(Number).filter(v=>isFinite(v)&&v>=0) : [];
    const drawSchedule = (constructionYears>0 && rawDraw.length)
      ? (()=>{ const a=rawDraw.slice(0,Math.max(1,Math.round(constructionYears))); while(a.length<Math.max(1,Math.round(constructionYears))) a.push(0); const sum=a.reduce((x,y)=>x+y,0); return sum>0?a.map(x=>x/sum):null; })()
      : null;
    const vatEnabled = !!(o.vat && o.vat.enabled);
    const vatRate = vatEnabled ? (o.vat.ratePct!=null?o.vat.ratePct:0.15) : 0;
    const vatInputRate = vatEnabled ? (o.vat.constructionInputVatPct!=null?o.vat.constructionInputVatPct:vatRate) : 0;
    const residentialVat = isResidentialUseType(meta.useType);
    // Recovery defaults to 0% for exempt residential use and 100% for taxable use, but remains
    // explicitly overrideable for mixed/restricted recovery cases.
    const vatRecoveryPct = vatEnabled ? Math.max(0,Math.min(1, o.vat.inputRecoveryPct==null ? (residentialVat?0:1) : Number(o.vat.inputRecoveryPct))) : 0;
    const vatConstructionBase = vatEnabled ? (hardCost + (o.fees.dueDiligence||0) + (o.fees.valuation||0) + structuringFee) : 0;
    const vatInputTotal = vatConstructionBase * vatInputRate;
    const vatIrrecoverableUpfront = vatInputTotal * (1-vatRecoveryPct);
    const TPC = preTPC + arrangementFee + vatInputTotal;
    const equity = TPC - debt;

    // الرسوم المتكررة السنوية على مستوى الصندوق (إدارة الصندوق، إدارة الأصول، تنظيمي/تدقيق/أمين حفظ) —
    // تصحيح: كانت هذه الرسوم تُحسَب فقط كأرقام إجمالية للعرض في "ملخص الرسوم" دون أن تُخصَم فعلياً من
    // تدفقات حقوق الملكية، ما يعني أن Equity IRR/MOIC المُبلَّغ عنهما كانا يتجاهلان أثرها الحقيقي على
    // عائد المستثمر. الآن تُخصَم سنوياً من تدفق حقوق الملكية (وليس تدفق المشروع — فهي تكلفة غلاف الصندوق
    // وليست تكلفة تشغيل العقار) طوال عمر الصندوق بالكامل (بما في ذلك سنوات الإنشاء، لأن رأس المال يكون
    // مُلتزَماً به من البداية).
    const annualFundFee = (o.fees.mgmt||0)*(equity+debt)/2 + (o.fees.assetMgmt||0)*TPC + (o.fees.regAuditCustodian||0);

    // WACC (CAPM build-up)
    const Ke = o.wacc.rf + o.wacc.beta*o.wacc.mrp + o.wacc.crp + o.wacc.sp + o.wacc.alpha;
    const Kd = interestRate;
    const V = debt + equity;
    const WACC = V>0 ? (equity/V)*Ke + (debt/V)*Kd : Ke;

    // GLA / revenue assumptions
    const efficiency = (o.development.efficiency)||0.85;
    const gla = type==='income' ? (o.income.gla || gfa*efficiency) : gfa*efficiency;
    const rentAnnual = o.income.rent*rentMult;
    const occupancy = o.income.occupancy;
    const opexPct = o.income.opex;
    const exitCapRateEff = Math.max(0.02, o.development.exitCapRate + capRateDelta);
    const marketCapEff = Math.max(0.02, (o.wacc.marketCap||0.075) + capRateDelta);
    const salePriceEff = o.development.salePrice * salePriceMult;
    const amortType = o.financing.amortType || 'interest_only';
    const graceYears = o.financing.graceYears||0;
    const amortYears = Math.max(1, o.financing.amortYears||10);

    // ---- تقسيم الأراضي على مراحل (Phased Subdivision Absorption) ----
    // بدل بيع كل الأرض المُخدَّمة دفعة واحدة عند الخروج، نوزّع البيع على عدة سنوات (امتصاص تدريجي للقطع)،
    // مع تصاعد سعري اختياري بين الشرائح، وسداد دين تناسبي ("تحرير رهن") مع كل شريحة مباعة — بدل أي من
    // أنماط السداد الثلاثة المعتادة (فوائد فقط/استهلاك جزئي/استهلاك كامل) التي لا تناسب هذا الهيكل.
    const isSubdivisionPhased = type==='development' && scopeType==='infra_only' && !!(o.subdivision && o.subdivision.phasedAbsorption);
    function absorptionPcts(n, curve){
      n = Math.max(1, Math.round(n));
      if(n<=1) return [1];
      if(curve==='front_loaded'){ const w=Array.from({length:n},(_,i)=>n-i); const s=w.reduce((a,b)=>a+b,0); return w.map(x=>x/s); }
      if(curve==='back_loaded'){ const w=Array.from({length:n},(_,i)=>i+1); const s=w.reduce((a,b)=>a+b,0); return w.map(x=>x/s); }
      return Array.from({length:n}, ()=>1/n); // even: امتصاص متساوٍ كل سنة
    }
    let absorptionSchedule = null;
    if(isSubdivisionPhased){
      const nAbs = Math.max(1, Math.round(o.subdivision.absorptionYears||4));
      const pcts = absorptionPcts(nAbs, o.subdivision.curve||'even');
      const totalSaleValueBase = land.area * salePriceEff; // كل مساحة الأرض المُخدَّمة تُباع كقطع عبر الخطة
      const escAnnual = o.subdivision.priceEscalationAnnual||0;
      const exitCostPctSub = o.exitCosts.broker + o.exitCosts.legal + o.exitCosts.rett + o.exitCosts.exitFee + o.fees.disposition;
      absorptionSchedule = pcts.map((pct,i)=>({
        yr: constructionYears + 1 + i, // أول شريحة تُباع في أول سنة بعد اكتمال أعمال التخديم/البنية التحتية
        pct,
        trancheRevenue: totalSaleValueBase * pct * Math.pow(1+escAnnual, i),
        trancheCosts: totalSaleValueBase * pct * Math.pow(1+escAnnual, i) * exitCostPctSub,
        tranchePrincipalPay: pct * debt, // تحرير رهن تناسبي: كل شريحة تُسدِّد حصتها من إجمالي الدين الأصلي
      }));
    }

    // ---- البيع على الخارطة (Off-Plan Sale — نظام "وافي") ----
    // بيع كامل وحدات المشروع (وليس أرضاً مُخدَّمة) للمشترين على مراحل الإنشاء نفسها بدل انتظار التسليم،
    // مع تأخير زمني (Escrow Lag) لتحرير كل دفعة من حساب الضمان للمطوّر بعد اعتماد المستشار الهندسي المستقل
    // نسبة الإنجاز. حصري مع "نسبة البيع/الإيجار المختلطة" العادية — كل الوحدات هنا تُباع (100%) عبر الشرائح
    // بدل تقسيمها بين بيع وإيجار، وتحل شرائح البيع محل أنماط السداد البنكي المعتادة (نفس آلية "تحرير رهن
    // تناسبي" المستخدمة في تقسيم الأراضي، لكن مرتبطة بسنوات الإنشاء نفسها بدل السنوات اللاحقة للتسليم).
    const isOffPlanSale = type==='development' && scopeType!=='infra_only' && !!(strat.offPlanSale && strat.offPlanSale.enabled);
    let offPlanSchedule = null;
    if(isOffPlanSale){
      const nYears = Math.max(1, Math.round(constructionYears));
      const pcts = absorptionPcts(nYears, strat.offPlanSale.curve||'even');
      const sellableAreaOP = gfa*efficiency;
      const totalSaleValueBaseOP = sellableAreaOP * salePriceEff;
      const escAnnualOP = strat.offPlanSale.priceEscalationAnnual||0;
      const exitCostPctOP = o.exitCosts.broker + o.exitCosts.legal + o.exitCosts.rett + o.exitCosts.exitFee + o.fees.disposition;
      const lag = Math.round(strat.offPlanSale.escrowLagYears||0);
      // نجمع كل شريحة "نظرية" (مرتبطة بنسبة إنجاز الإنشاء) في سنة "التحصيل الفعلي" بعد تطبيق تأخير الضمان،
      // مع تجميع أي شرائح تتقارب على نفس سنة التحصيل بدل معاملتها كإدخالات منفصلة (تفادياً لتكرار السنة).
      const buckets = {};
      pcts.forEach((pct,i)=>{
        const nominalYear = i+1;
        // لا نقصّ سنة التحصيل عند نهاية الإنشاء: escrow lag حقيقي قد يدفع التحصيل إلى سنة لاحقة.
        const collectionYear = Math.max(1, nominalYear + lag);
        const trancheRevenue = totalSaleValueBaseOP * pct * Math.pow(1+escAnnualOP, i);
        const trancheCosts = trancheRevenue * exitCostPctOP;
        const tranchePrincipalPay = pct * debt;
        if(!buckets[collectionYear]) buckets[collectionYear] = { yr: collectionYear, pct:0, trancheRevenue:0, trancheCosts:0, tranchePrincipalPay:0 };
        buckets[collectionYear].pct += pct;
        buckets[collectionYear].trancheRevenue += trancheRevenue;
        buckets[collectionYear].trancheCosts += trancheCosts;
        buckets[collectionYear].tranchePrincipalPay += tranchePrincipalPay;
      });
      offPlanSchedule = Object.keys(buckets).map(k=>buckets[k]).sort((a,b)=>a.yr-b.yr);
    }
    // علم موحّد لأي "نمط بيع على مراحل" (تقسيم أراضٍ أو بيع على الخارطة) — الاثنان يستخدمان نفس آلية
    // "تحرير رهن تناسبي" وإلغاء أنماط السداد المعتادة، ولا يمكن أن يتفعّلا معاً لنفس الفرصة (يشترطان
    // scopeType مختلفاً: تقسيم الأراضي infra_only فقط، والبيع على الخارطة أي نطاق آخر).
    const isPhasedSaleMode = isSubdivisionPhased || isOffPlanSale;
    const activeTrancheSchedule = isSubdivisionPhased ? absorptionSchedule : (isOffPlanSale ? offPlanSchedule : null);

    function noiForYear(){
      if(type==='landbank') return 0;
      if(type==='development' && scopeType==='infra_only') return 0; // serviced-plot sale: no interim rental income
      if(assetClass==='hospitality'){
        const hosp = o.income.hospitality||{};
        const revPAR = (hosp.adr||0) * occupancy; // occupancy reused as hotel occupancy rate
        const totalRevenue = revPAR * 365 * (hosp.keys||0);
        const gop = totalRevenue * (hosp.gopMargin!=null? hosp.gopMargin : 0.35);
        return gop * (1 - o.fees.propMgmt);
      }
      if(assetClass==='gas_station' || assetClass==='qsr_pharmacy'){
        const nnn = o.income.nnn||{};
        let totalRent = gla * rentAnnual;
        if(nnn.pctRent){
          const naturalBreakpoint = nnn.pctRentRate>0 ? totalRent/nnn.pctRentRate : Infinity;
          const overage = Math.max(0, (nnn.annualSales||0) - naturalBreakpoint) * nnn.pctRentRate;
          totalRent += overage;
        }
        // NNN (triple-net): tenant covers opex directly, so no opexPct deduction on the landlord's side
        let noi = totalRent * occupancy * (1 - o.fees.propMgmt);
        if(assetClass==='gas_station') noi -= (nnn.envReserveAnnual||0);
        return noi;
      }
      const pgi = gla * rentAnnual;
      const effOcc = (type==='development' || applySalePctToIncome) ? occupancy*(1-salePct) : occupancy; // if selling, rented share shrinks
      const egi0 = pgi*effOcc, opexAmt0 = egi0*opexPct;
      // ضريبة القيمة المضافة (VAT) غير القابلة للاسترداد — تنطبق فقط على الاستخدامات السكنية المعفاة من ضريبة
      // القيمة المضافة (لا الإيجار التجاري الخاضع لـ15%): المؤجِّر المُعفى لا يستطيع استرداد ضريبة المدخلات
      // المدفوعة على مصاريف التشغيل، فتتحول عملياً إلى تكلفة حقيقية إضافية تُخصم من صافي الدخل التشغيلي.
      // الإيجار التجاري الخاضع (15%) يُحصَّل فوق الإيجار ويُورَّد للجهة الضريبية — محايد على صافي دخل المؤجِّر
      // (بافتراض تسجيل ضريبي واسترداد كامل لضريبة المدخلات)، ولذلك لا يُخصَم من NOI هنا — يظهر فقط كبند إفصاحي.
      const vatIrrecoverableCost = (o.vat && o.vat.enabled && isResidentialUseType(meta.useType)) ? opexAmt0*(o.vat.ratePct!=null?o.vat.ratePct:0.15) : 0;
      // رسوم منصة "إيجار" (تسجيل إلزامي لعقود الإيجار) وتأمين الأصل — بندان اختياريان (صفر افتراضياً = لا
      // تغيير عن أي فرصة موجودة). فعّلهما فقط لو لم تكونا مُدرجتين أصلاً ضمن نسبة OPEX العامة أعلاه، تفادياً
      // لازدواج الاحتساب — راجع حقلي الإدخال في خطوة "الرسوم" للتفاصيل والتحذير.
      const ejarFeeAmt = egi0*(o.fees.ejarFeePct||0);
      const insuranceAmt = TPC*(o.fees.insuranceAnnualPct||0);
      const noi = (egi0 - opexAmt0) * (1 - o.fees.propMgmt) - vatIrrecoverableCost - ejarFeeAmt - insuranceAmt;
      return noi;
    }

    // نسخة "مُفصَّلة" من noiForYear() تُرجع بنود قائمة الدخل (الإيراد الإجمالي المحتمل، خسارة الإشغال،
    // الإيراد الإجمالي الفعلي EGI، المصاريف التشغيلية، أتعاب إدارة الملكية) بدل رقم NOI فقط — تُستخدم فقط
    // لعرض قائمة الدخل (P&L) لكل سنة، ولا تُستخدم في أي حساب مالي آخر (لتفادي أي تغيير في السلوك القائم).
    // كل فرع مطابق رياضياً لمعادلة noiForYear() المقابلة له تماماً — التحقق تم عبر Playwright.
    function revenueBreakdownForYear(){
      if(type==='landbank') return { revenue:0, vacancyLoss:0, egi:0, opexAmt:0, propMgmtFeeAmt:0 };
      if(type==='development' && scopeType==='infra_only') return { revenue:0, vacancyLoss:0, egi:0, opexAmt:0, propMgmtFeeAmt:0 };
      if(assetClass==='hospitality'){
        const hosp = o.income.hospitality||{};
        const revPAR = (hosp.adr||0) * occupancy;
        const totalRevenue = revPAR * 365 * (hosp.keys||0);
        const gopMargin = hosp.gopMargin!=null? hosp.gopMargin : 0.35;
        const gop = totalRevenue * gopMargin;
        const propMgmtFeeAmt = gop * o.fees.propMgmt;
        return { revenue:totalRevenue, vacancyLoss:0, egi:totalRevenue, opexAmt: totalRevenue-gop, propMgmtFeeAmt };
      }
      if(assetClass==='gas_station' || assetClass==='qsr_pharmacy'){
        const nnn = o.income.nnn||{};
        let totalRent = gla * rentAnnual;
        if(nnn.pctRent){
          const naturalBreakpoint = nnn.pctRentRate>0 ? totalRent/nnn.pctRentRate : Infinity;
          const overage = Math.max(0, (nnn.annualSales||0) - naturalBreakpoint) * nnn.pctRentRate;
          totalRent += overage;
        }
        const vacancyLoss = totalRent*(1-occupancy);
        const egi = totalRent*occupancy;
        const propMgmtFeeAmt = egi*o.fees.propMgmt;
        const envReserve = assetClass==='gas_station' ? (nnn.envReserveAnnual||0) : 0;
        return { revenue:totalRent, vacancyLoss, egi, opexAmt:envReserve, propMgmtFeeAmt };
      }
      const pgi = gla * rentAnnual;
      const effOcc = (type==='development' || applySalePctToIncome) ? occupancy*(1-salePct) : occupancy;
      const vacancyLoss = pgi*(1-effOcc);
      const egi = pgi*effOcc;
      const opexAmt = egi*opexPct;
      const afterOpex = egi-opexAmt;
      const propMgmtFeeAmt = afterOpex*o.fees.propMgmt;
      // بندا VAT الإفصاحيان (للعرض في P&L فقط — مطابقان تماماً لمنطق noiForYear() أعلاه):
      const vatIrrecoverableCost = (o.vat && o.vat.enabled && isResidentialUseType(meta.useType)) ? opexAmt*(o.vat.ratePct!=null?o.vat.ratePct:0.15) : 0;
      const vatOnRevenueInfo = (o.vat && o.vat.enabled && !isResidentialUseType(meta.useType)) ? egi*(o.vat.ratePct!=null?o.vat.ratePct:0.15) : 0;
      const ejarFeeAmt = egi*(o.fees.ejarFeePct||0);
      const insuranceAmt = TPC*(o.fees.insuranceAnnualPct||0);
      return { revenue:pgi, vacancyLoss, egi, opexAmt, propMgmtFeeAmt, vatIrrecoverableCost, vatOnRevenueInfo, ejarFeeAmt, insuranceAmt };
    }

    // ---- Build year-by-year cashflows (unlevered / project, and levered / equity) ----
    const projectCF = []; const equityCF = []; const dscrSeries = []; const pnlRows = [];
    let remainingDebt = debt;
    let navGrossValue = 0, navDebt = 0; // نلتقط قيمة الأصل والدين المتبقي في سنة الخروج/الاستقرار لحساب NAV بعد الحلقة
    let balloonBalanceAtExit = 0; // الرصيد المتبقي من الدين وقت الخروج (يُسدَّد دفعة واحدة) — يظهر في كل أنماط السداد
                                   // (كامل الدين لو "فوائد فقط"، جزء متبقٍ لو "استهلاك جزئي + بالون"، صفر تقريباً لو استهلاك كامل يغطي كل المدة)
    let finalSaleValueAtExit = 0; // حصة "البيع الفعلي لمشترين" (لا الجزء المؤجَّر/المُقيَّم) من قيمة الخروج — تُستخدم لاحقاً
                                   // في تمييز البيع المباشر كاش/تمويل بنكي (Direct Sale)، لو مُفعَّلاً.
    let finalExitValueForSplit = 0; // إجمالي قيمة الخروج في آخر سنة (نفس مرجع finalSaleValueAtExit) — يلزم لحساب حصة "البيع" النسبية.

    projectCF.push(-TPC);
    const initialEquityOutlay = -(equity) - o.subscription.subscriptionFee*equity;
    equityCF.push(initialEquityOutlay);

    for(let yr=1; yr<=totalYears; yr++){
      const inConstruction = yr<=constructionYears && type!=='landbank';
      let noi = 0;
      if(type==='landbank'){
        // دخل تأجيري مؤقت خلال فترة الاحتفاظ (تأجير مؤقت للأرض الخام لموقف سيارات/زراعة/لوحات إعلانية إلخ
        // بانتظار التطوير) — ممارسة سوقية فعلية لتخفيف تكلفة الحمل. اختياري بالكامل (صفر افتراضياً = لا تغيير
        // عن السلوك السابق لأي فرصة بنك أراضٍ محفوظة مسبقاً).
        // رسوم الأراضي البيضاء — رسم سنوي نظامي على الأرض الفضاء داخل النطاق العمراني (احتُسب هنا على أساس
        // سعر الشراء الأصلي كتبسيط، وليس القيمة السوقية الحالية المُحدَّثة كما تشترط اللائحة فعلياً — تحقق من
        // النسبة والإعفاءات الحالية عند الاستخدام الفعلي). معطَّلة تلقائياً لو استُثنيت القطعة صراحةً.
        const whiteLandFeeAmt = (!o.landbank.whiteLandFeeExempt) ? landCost*(o.landbank.whiteLandFeePct||0) : 0;
        noi = -o.landbank.carryAnnual - whiteLandFeeAmt + (o.landbank.interimAnnualIncome||0);
      } else if(!inConstruction){
        noi = noiForYear();
      }
      // بنود قائمة الدخل التفصيلية لهذه السنة (للعرض فقط في تقرير P&L — لا تُستخدم في أي حساب آخر)
      const rb = (!inConstruction && type!=='landbank') ? revenueBreakdownForYear() : { revenue:0, vacancyLoss:0, egi:0, opexAmt:0, propMgmtFeeAmt:0 };
      const drawEnd = (drawSchedule && inConstruction)
        ? Math.min(debt, debt * drawSchedule.slice(0,yr).reduce((a,b)=>a+b,0))
        : remainingDebt;
      const drawStart = (drawSchedule && inConstruction)
        ? (yr===1 ? 0 : Math.min(debt, debt * drawSchedule.slice(0,yr-1).reduce((a,b)=>a+b,0)))
        : remainingDebt;
      const interestBase = (drawSchedule && inConstruction) ? (drawStart + drawEnd)/2 : remainingDebt;
      const interest = interestBase * interestRate;
      let principalPay = 0;
      if((amortType==='amortizing'||amortType==='partial_amort_balloon') && type!=='landbank' && !isPhasedSaleMode && !inConstruction && yr>constructionYears+graceYears && remainingDebt>0){
        principalPay = Math.min(remainingDebt, debt/amortYears);
      }
      // خيار "فائدة الإنشاء" (شائع في تمويل البناء البنكي): تُسدَّد نقداً من حقوق الملكية أولاً بأول (الافتراض
      // القائم)، أو تُرسمَل (تُضاف إلى رصيد القرض ليُسدَّد لاحقاً) — وهو الهيكل الأكثر شيوعاً فعلياً في قروض
      // الإنشاء البنكية حيث لا يوجد إيراد تشغيلي بعد لتغطية الفائدة نقداً. الفائدة المرسملة تزيد رصيد الدين
      // (فتزيد الفائدة اللاحقة تراكمياً) بدل أن تُسحب من حقوق الملكية فوراً — ما يغيّر توقيت التدفقات وIRR.
      const capitalizeInterest = inConstruction && type!=='landbank' && (o.financing.interestDuringConstruction==='capitalized');
      const cashInterest = capitalizeInterest ? 0 : interest;
      const capitalizedInterestThisYear = capitalizeInterest ? interest : 0;
      // بنك الأراضي: الفائدة تكلفة نقدية سنوية حقيقية حتى لو لم يوجد تشغيل/NOI.
      // أصل الدين يبقى بالوناً حتى الخروج، لكن الفائدة لا تختفي من التدفقات.
      const debtService = remainingDebt>0 ? cashInterest+principalPay : 0;
      const isLast = (yr===totalYears);
      const yearsIntoOperation = yr - constructionYears;
      const isRefiYear = (holdStrategy==='perpetual_hold' && !inConstruction && !isLast && yearsIntoOperation>0
                          && refi.intervalYears>0 && yearsIntoOperation % refi.intervalYears === 0);

      // شريحة تقسيم الأراضي المُباعة هذه السنة (لو كانت الفرصة على نمط الامتصاص التدريجي) — قد تقع في أي
      // سنة ضمن جدول الامتصاص، بما فيها آخر سنة (isLast)، والتي تُعامَل كحالة خاصة أدناه.
      const thisTranche = isPhasedSaleMode ? (activeTrancheSchedule.find(t=>t.yr===yr)||null) : null;

      let exitValue = 0, exitCostsAmt = 0, debtPayoff = 0, saleValueAtExit = 0, exitCostPctAtExit = 0;
      if(isLast){
        if(isPhasedSaleMode){
          // آخر سنة = بيع آخر شريحة (لو ضمن الجدول) + سداد كامل رصيد الدين المتبقي من عائدات هذه الشريحة
          // (بصرف النظر عن حصتها "المستهدفة" نظرياً — فهي آخر سنة، ولا يجوز أن يبقى دين بعدها).
          exitValue = thisTranche ? thisTranche.trancheRevenue : 0;
          exitCostsAmt = thisTranche ? thisTranche.trancheCosts : 0;
          // ملاحظة: لو كانت آخر سنة لا تزال "قيد الإنشاء" (ممكن فقط في نمط البيع على الخارطة، حيث لا توجد
          // مدة تشغيل لاحقة) وفائدة الإنشاء تُرسمَل، فإن فائدة هذه السنة نفسها لم تُضَف بعد لرصيد الدين
          // (تُضاف فقط في نهاية الحلقة) — نضيفها هنا صراحةً حتى لا تُفقَد ولا تُترك بلا سداد أو خصم.
          debtPayoff = remainingDebt + capitalizedInterestThisYear;
          // لا يوجد "بالون" فعلي هنا (balloonBalanceAtExit تبقى صفراً): الدين يُسدَّد تدريجياً بحصص تناسبية
          // مع كل شريحة مباعة (تحرير رهن) — لا يتراكم أي رصيد إلى دفعة ختامية واحدة كما في القروض الأخرى.
          balloonBalanceAtExit = 0;
          navGrossValue = 0; navDebt = 0; // خطة تقسيم مكتملة — لا يوجد "أصل متبقٍ" يستحق تقييم NAV، كل القيمة تحقّقت كتدفقات
        } else if(type==='landbank'){
          exitValue = landCost * Math.pow(1+o.landbank.appreciation, totalYears);
        } else if(type==='development'){
          const sellableArea = scopeType==='infra_only' ? land.area : gfa*efficiency;
          const saleValue = sellableArea * salePriceEff * salePct;
          const rentedValue = (1-salePct)>0
            ? ((gla*(1-salePct))*rentAnnual*occupancy*(1-opexPct)*(1-o.fees.propMgmt))/exitCapRateEff
            : 0;
          exitValue = saleValue + (scopeType==='infra_only' ? 0 : rentedValue);
          saleValueAtExit = saleValue; // الجزء المُباع فعلياً (لو تطوير مختلط) — يلزم لاحقاً لو الاستراتيجية "إعادة تمويل" بدل بيع الجزء المُبقى
        } else if(applySalePctToIncome){
          // فرصة دخل بنمط "مختلط" — نفس آلية التطوير المختلط بالضبط: جزء salePct من GLA يُباع بسعر البيع
          // (يُعاد استخدام development.salePrice، بنفس نمط إعادة استخدام حقول development.* الأخرى — buildCost/
          // constructionYears/operationYears/exitCapRate — كمدخلات "بناء" عامة بصرف النظر عن نوع الفرصة)،
          // والجزء المُبقى مؤجَّراً (1-salePct) يُقيَّم بترسيمه على NOI المستقر بمعدل الرسملة السوقي (marketCapEff)
          // تماماً كفرصة الدخل العادية — noiForYear() تعكس effOcc المخفَّضة أصلاً بفعل applySalePctToIncome أعلاه.
          const sellableAreaInc = gla;
          const saleValueInc = sellableAreaInc * salePriceEff * salePct;
          const stabilizedNOI = noiForYear() * Math.pow(1+o.wacc.growth, totalYears);
          const rentedValueInc = stabilizedNOI / marketCapEff;
          exitValue = saleValueInc + rentedValueInc;
          saleValueAtExit = saleValueInc;
        } else { // income fund exit via cap rate
          const stabilizedNOI = noiForYear() * Math.pow(1+o.wacc.growth, totalYears);
          exitValue = stabilizedNOI / marketCapEff;
        }
        if(!isPhasedSaleMode){
          const exitCostPct = o.exitCosts.broker + o.exitCosts.legal + o.exitCosts.rett + o.exitCosts.exitFee + o.fees.disposition;
          exitCostsAmt = exitValue * exitCostPct;
          exitCostPctAtExit = exitCostPct;
          debtPayoff = remainingDebt - principalPay; // remaining balance after this year's amortization, paid off at exit
          balloonBalanceAtExit = debtPayoff;
          navGrossValue = exitValue; navDebt = debtPayoff; // القيمة الإجمالية للأصل والدين وقت الاستقرار/الخروج (بدون خصم تكاليف بيع افتراضية — NAV مش عملية بيع فعلية)
        }
        finalSaleValueAtExit = saleValueAtExit;
        finalExitValueForSplit = exitValue;
      }

      // صافي عائد الشريحة المُباعة هذه السنة (لو لم تكن آخر سنة — الحالة الأخيرة معالجة أعلاه ضمن isLast)
      const midTrancheNet = (!isLast && thisTranche) ? (thisTranche.trancheRevenue - thisTranche.trancheCosts) : 0;
      const midTranchePrincipalPay = (!isLast && thisTranche) ? thisTranche.tranchePrincipalPay : 0;

      // VAT working-capital layer: VAT is paid with construction spend, while recoverable VAT
      // returns after the configured refund lag. Irrecoverable VAT is already capitalized in TPC,
      // so only the recoverable cash timing is added here to avoid double counting.
      let vatPaidThisYear = 0, vatRefundThisYear = 0;
      // Gross input VAT is included in TPC/initial funding. Recoverable VAT is then returned after
      // the configured lag; irrecoverable VAT remains embedded in project cost. This avoids double
      // counting VAT in the cash-flow model while still exposing recovery and working-capital timing.
      if(vatEnabled && vatInputTotal>0 && (o.vat.refundLagYears||0)>0 && yr>1){
        const sourceYear = yr - Math.max(0,Math.round(o.vat.refundLagYears||0));
        if(sourceYear>=1 && sourceYear<=Math.max(1,Math.round(constructionYears))){
          const ncy=Math.max(1,Math.round(constructionYears));
          const sourceSpend=(hardCost/ncy)+(sourceYear===1?((o.fees.dueDiligence||0)+(o.fees.valuation||0)+structuringFee)/ncy:0);
          vatRefundThisYear += sourceSpend*vatInputRate*vatRecoveryPct;
        }
      }
      if(vatEnabled && vatInputTotal>0 && (o.vat.refundLagYears||0)===0 && inConstruction){
        const ncy=Math.max(1,Math.round(constructionYears));
        const spendShare=(hardCost/ncy)+(yr===1?((o.fees.dueDiligence||0)+(o.fees.valuation||0)+structuringFee)/ncy:0);
        vatRefundThisYear += spendShare*vatInputRate*vatRecoveryPct;
      }
      const vatNetCashThisYear = vatRefundThisYear;
      const projFlow = noi + (isLast? (exitValue - exitCostsAmt) : 0) + midTrancheNet + vatNetCashThisYear;
      // رسوم الصندوق السنوية (إدارة صندوق + إدارة أصول + تنظيمي/تدقيق) تنطبق على أي هيكل صندوق أياً كان
      // نوع الفرصة — بما فيها تخزين الأراضي (تكلفة الحمل landbank.carryAnnual تكلفة عقارية منفصلة تماماً
      // عن أتعاب مدير الصندوق نفسه، والاثنتان قد تنطبقان معاً).
      const netOperatingCF = noi - debtService - annualFundFee + vatNetCashThisYear; // can be negative: a shortfall is a real equity capital call, not floored to zero

      let equityFlow, newLoanAfterRefi = null;
      if(isLast && holdStrategy==='refinance_close' && !isPhasedSaleMode){
        // إعادة تمويل عند الخروج بدل بيع الجزء المُبقى بمعدل الرسملة: نسحب قرضاً جديداً على قيمته العادلة
        // (noiForYear() يراعي نسبة البيع تلقائياً لفرص التطوير المختلطة، فتعكس القيمة الجزء المُبقى فقط)،
        // نسدد به الدين القائم بالكامل، ونوزّع الفائض على حقوق الملكية — الأصل (أو الجزء المُبقى منه) لا يُباع فعلياً.
        // لو كانت فرصة تطوير "مختلطة" (بيع جزء + إعادة تمويل الباقي)، صافي عائد الجزء المُباع (بعد تكاليف
        // التصرّف) يُضاف كمصدر تمويل إضافي لنفس عملية سداد الدين الموحّدة، بدل افتراض تقسيم الدين بين الجزأين.
        const propertyValue = noiForYear() * Math.pow(1+o.wacc.growth, totalYears) / marketCapEff;
        const newLoan = propertyValue * (refi.refiLtv||0.65);
        const refiCost = newLoan * (refi.refiCostPct||0.01);
        const oldDebtRemaining = remainingDebt - principalPay;
        const saleNetProceeds = saleValueAtExit>0 ? saleValueAtExit*(1-exitCostPctAtExit) : 0;
        const distribution = newLoan + saleNetProceeds - oldDebtRemaining - refiCost;
        equityFlow = netOperatingCF + distribution;
      } else if(isRefiYear){
        const propertyValue = noiForYear() * Math.pow(1+o.wacc.growth, yr) / marketCapEff;
        const newLoan = propertyValue * (refi.refiLtv||0.65);
        const refiCost = newLoan * (refi.refiCostPct||0.01);
        const oldDebtRemaining = remainingDebt - principalPay;
        const distribution = newLoan - oldDebtRemaining - refiCost;
        equityFlow = netOperatingCF + distribution;
        if(distribution>0) newLoanAfterRefi = oldDebtRemaining + distribution + refiCost; // == newLoan
      } else if(isLast){
        equityFlow = netOperatingCF + (exitValue - exitCostsAmt - debtPayoff);
      } else {
        equityFlow = netOperatingCF + midTrancheNet - midTranchePrincipalPay;
      }

      projectCF.push(projFlow);
      equityCF.push(equityFlow);
      if(!inConstruction && type!=='landbank'){
        // إصلاح: لا نُدرج سنة في سلسلة DSCR إلا لو كان لها معنى فعلي —
        // إما فيها خدمة دين فعلية (النسبة الطبيعية NOI/Debt Service)، أو فيها دخل تشغيلي موجب بدون دين
        // (تغطية شبه لا نهائية، نمثّلها بـ 99×). أما سنة بلا دين وبلا دخل تشغيلي موجب (مثلاً مشروع تطوير
        // للبيع بالكامل بدون تمويل بنكي، حيث لا يوجد إيجار تشغيلي متبقٍ) فـ DSCR غير ذي معنى فيها إطلاقاً —
        // ندعها خارج السلسلة بدل ما ندخل 0 (كان بيظهر خطأً كـ"فشل" 0.00× رغم إن المؤشر أصلاً لا ينطبق).
        if(debtService>0){ dscrSeries.push(noi/debtService); }
        else if(noi>0){ dscrSeries.push(99); }
      }
      // ---- سطر قائمة الدخل (P&L) لهذه السنة ----
      pnlRows.push({
        yr, phase: inConstruction? 'construction':'operation',
        revenue: rb.revenue, vacancyLoss: rb.vacancyLoss, egi: rb.egi,
        opexAmt: rb.opexAmt, propMgmtFeeAmt: rb.propMgmtFeeAmt,
        landCarryCost: (type==='landbank'? o.landbank.carryAnnual : 0),
        whiteLandFee: (type==='landbank' && !o.landbank.whiteLandFeeExempt) ? landCost*(o.landbank.whiteLandFeePct||0) : 0,
        interimLeaseIncome: (type==='landbank'? (o.landbank.interimAnnualIncome||0) : 0),
        vatIrrecoverableCost: rb.vatIrrecoverableCost||0, vatOnRevenueInfo: rb.vatOnRevenueInfo||0,
        ejarFeeAmt: rb.ejarFeeAmt||0, insuranceAmt: rb.insuranceAmt||0,
        noi, interestExpense: interest, principalPayment: principalPay, debtService,
        fundFee: annualFundFee,
        // صافي الدخل التشغيلي المحاسبي = NOI ناقص فائدة الدين ناقص رسوم الصندوق السنوية —
        // بدون سداد أصل الدين (بند ميزانية عمومية لا قائمة دخل) وبدون بنود البيع لمرة واحدة (أدناه).
        netOperatingIncome: noi - interest - annualFundFee,
        // بند الخروج/التصرف لمرة واحدة: للفرص العادية يظهر فقط في آخر سنة (isLast). لفرص تقسيم الأراضي على
        // مراحل، يظهر في كل سنة تُباع فيها شريحة (بما فيها آخر سنة)، وكل شريحة تحمل "ربحها" التناسبي الخاص.
        isExitYear: isLast || !!thisTranche,
        exitValue: isLast? exitValue : (thisTranche? thisTranche.trancheRevenue : 0),
        exitCostsAmt: isLast? exitCostsAmt : (thisTranche? thisTranche.trancheCosts : 0),
        debtPayoffAtExit: isLast? debtPayoff : (thisTranche? thisTranche.tranchePrincipalPay : 0),
        // ربح/خسارة رأسمالية تقريبية مقارنةً بإجمالي تكلفة المشروع (TPC) كأساس تكلفة مبسّط — لفرص التقسيم
        // على مراحل، كل شريحة تحمل حصتها النسبية من TPC (بنفس نسبتها من إجمالي مساحة الأرض المخطَّطة للبيع).
        // عرض تقديري وليس محاسبة إهلاك رسمية (لا يوجد جدول إهلاك في هذا النموذج الاستثماري).
        gainOnExit: isLast? (exitValue - exitCostsAmt - (isPhasedSaleMode && thisTranche? TPC*thisTranche.pct : TPC))
                  : (thisTranche? (thisTranche.trancheRevenue - thisTranche.trancheCosts - TPC*thisTranche.pct) : 0),
      });
      remainingDebt = isLast ? 0 : (newLoanAfterRefi!=null ? newLoanAfterRefi : Math.max(0, remainingDebt - principalPay - midTranchePrincipalPay + capitalizedInterestThisYear));
    }

    // perpetual hold: report both a "cash-only" realized series and a "mark-to-market" series
    // that adds the unrealized residual property value (net of remaining debt) at the horizon's end.
    const equityCFCashOnly = equityCF.slice();
    if(holdStrategy==='perpetual_hold'){
      const propertyValueEnd = noiForYear() * Math.pow(1+o.wacc.growth, totalYears) / marketCapEff;
      const residualEquityValue = Math.max(0, propertyValueEnd - remainingDebt);
      equityCF[equityCF.length-1] += residualEquityValue;
    }

    // ---- البيع المباشر: تمييز مشترٍ كاش عن مشترٍ بتمويل عقاري بنكي (Direct Sale — Cash vs. Bank-Financed Buyer) ----
    // ينطبق فقط على البيع "المباشر" العادي (لا على البيع على الخارطة أو تقسيم الأراضي، اللذين لهما أصلاً جدول
    // تحصيل مفصَّل خاص بهما)، ولا يُحسَب إلا لحصة "البيع الفعلي لمشترين" من قيمة الخروج (لا الجزء المؤجَّر/المُقيَّم) —
    // بالتناسب مع نصيبها من صافي توزيع سنة الخروج (بعد تكاليف البيع وسداد الدين، لا القيمة الإجمالية قبلهما،
    // تفادياً لقلب توزيع صافٍ موجب إلى ما يشبه نداءً رأسمالياً سالباً بالخطأ).
    // تبسيط متعمّد: نفترض تسوية كامل تكاليف البيع وسداد الدين عند سنة الخروج كما لو كانت الصفقة نقدية بالكامل
    // (الممارسة الشائعة فعلياً: المطوّر يُسوّي الالتزامات فوراً من دفعات المشترين النقديين أو تمويل جسر قصير)،
    // ثم تُضاف حصة المشترين بالتمويل البنكي كدفعة إضافية صافية بعد التأخير الزمني المحدد لتحصيلها فعلياً —
    // هذا يُبرز أثر تأخير التحصيل على IRR دون الحاجة لنمذجة تمويل جسر منفصل بالكامل. لو كان التأخير صفراً،
    // تنعدم أي أثر عملياً (خصم ثم إضافة لنفس السنة). ولو كانت سنة الخروج خاسرة أصلاً (صافي سالب)، لا نؤجّل شيئاً.
    const ds = o.strategy.directSale || {};
    let isDirectSaleSplit = false, directSaleDeferredAmt = 0, directSaleDeferredYear = null;
    if(!isPhasedSaleMode && (ds.bankFinancedPct||0)>0 && finalSaleValueAtExit>0 && finalExitValueForSplit>0 && equityCF[totalYears]>0){
      const bankPct = Math.min(1, Math.max(0, ds.bankFinancedPct));
      const lag = Math.max(0, Math.round(ds.collectionLagYears||0));
      const saleShare = finalSaleValueAtExit / finalExitValueForSplit;
      const rawDeferred = equityCF[totalYears] * saleShare * bankPct;
      const cappedDeferred = Math.max(0, Math.min(rawDeferred, equityCF[totalYears]));
      if(cappedDeferred>0){
        isDirectSaleSplit = true;
        directSaleDeferredAmt = cappedDeferred;
        directSaleDeferredYear = totalYears + lag;
        equityCF[totalYears] -= cappedDeferred;
        projectCF[totalYears] -= cappedDeferred;
        while(equityCF.length <= directSaleDeferredYear){ equityCF.push(0); projectCF.push(0); }
        equityCF[directSaleDeferredYear] += cappedDeferred;
        projectCF[directSaleDeferredYear] += cappedDeferred;
      }
    }

    const equityIRR = irr(equityCF);
    const projectIRR = irr(projectCF);
    const npvEquity = npvAt(Ke, equityCF);
    const npvProject = npvAt(WACC, projectCF);
    const totalDistrib = equityCF.slice(1).reduce((a,b)=>a+Math.max(0,b),0);
    const investorSideFees = o.subscription.subscriptionFee*equity;
    const contributedEquity = equityCF.reduce((sum, cf)=> sum + (cf<0 ? Math.abs(cf) : 0), 0);
    const investorCashInvested = contributedEquity + investorSideFees;
    // MOIC للمستثمر يجب أن يعكس كل النقد المدفوع فعلياً: مساهمة البداية + أي نداءات حقوق ملكية لاحقة
    // تظهر كتدفقات سالبة في equityCF + رسوم الاشتراك. هذا يمنع تضخيم MOIC/PIC/Waterfall عندما تظهر
    // shortfalls تشغيلية أو تمويلية بعد السنة صفر.
    const MOIC = investorCashInvested>0 ? totalDistrib/investorCashInvested : 0;
    const DPI = MOIC; const RVPI = 0; const TVPI = DPI+RVPI;

    // ---- فترة استرداد رأس المال (Payback Period) ----
    // السنة (بكسرها التقريبي) التي تتساوى عندها التوزيعات النقدية التراكمية لحقوق الملكية مع
    // رأس المال المستثمر (equity) — مقياس "بسيط" غير مخصوم بالقيمة الزمنية للنقود، يكمّل
    // IRR/MOIC/NPV ولا يغني عنها. null تعني أن الاسترداد الكامل لم يتحقق خلال مدة الاحتفاظ بالمشروع.
    let paybackPeriod = null;
    if(investorCashInvested<=0){
      paybackPeriod = 0;
    } else {
      let cum = (equityCF[0]||0) - investorSideFees;
      for(let yr=1; yr<equityCF.length; yr++){
        const prevCum = cum;
        cum += equityCF[yr];
        if(cum >= 0){
          const cfThisYear = equityCF[yr];
          paybackPeriod = cfThisYear>0 ? (yr-1) + Math.min(1, Math.max(0, -prevCum/cfThisYear)) : yr;
          break;
        }
      }
    }

    const dscrMin = dscrSeries.length? Math.min(...dscrSeries.filter(x=>isFinite(x))) : null;
    const dscrAvg = dscrSeries.length? dscrSeries.reduce((a,b)=>a+b,0)/dscrSeries.length : null;

    const equityIRRCashOnly = holdStrategy==='perpetual_hold' ? irr(equityCFCashOnly) : equityIRR;
    const totalDistribCashOnly = equityCFCashOnly.slice(1).reduce((a,b)=>a+Math.max(0,b),0);
    const MOICCashOnly = holdStrategy==='perpetual_hold' ? (investorCashInvested>0 ? totalDistribCashOnly/investorCashInvested : 0) : MOIC;

    const stabilizedNOIyr1 = type!=='landbank' ? noiForYear() : 0;
    const yieldOnCost = TPC>0 ? stabilizedNOIyr1/TPC : 0;

    // ---- NAV و ROI ----
    // NAV المقدَّر عند الاستقرار/الخروج = القيمة الإجمالية المقدَّرة للأصل (بنفس افتراضات الخروج المستخدمة في التدفقات)
    // ناقص الدين المتبقي وقتها — بدون خصم تكاليف بيع افتراضية (لأن NAV تقييم "ماسك للأصل"، مش عملية بيع فعلية).
    const NAV = navGrossValue - navDebt;
    // ROI بسيط (Cash-on-Cash على مدى العمر) = صافي الربح / رأس المال المستثمر — مقياس مبسّط يكمّل MOIC وIRR،
    // بدون تسوية بالقيمة الزمنية للنقود (على عكس IRR).
    const ROI = investorCashInvested>0 ? (totalDistrib - investorCashInvested)/investorCashInvested : 0;

    // ---- Fees rollups ----
    const mgmtFeeTotal = o.fees.mgmt * (equity+debt)/2 * totalYears; // approx on avg NAV proxy
    const assetMgmtTotal = o.fees.assetMgmt * TPC * totalYears;
    const regAuditCustodianTotal = (o.fees.regAuditCustodian + o.fees.mgmt*0) * totalYears;
    const custodianTotal = 0.0015*(equity)*totalYears;
    const fundSideFees = structuringFee + arrangementFee + mgmtFeeTotal + assetMgmtTotal + regAuditCustodianTotal + oneTimeFixed + acquisitionFee;
    const dispositionFeeAmt = (equityCF[equityCF.length-1]||0) * 0; // already embedded in exit cost pct above
    const feesPctOfTPC = TPC>0 ? fundSideFees/TPC : 0;

    // ---- Waterfall ----
    const PIC = contributedEquity;
    const roc = Math.min(PIC, totalDistrib);
    let remaining = totalDistrib - roc;
    const prefTarget = PIC*(Math.pow(1+o.economics.hurdle, totalYears)-1);
    const pref = Math.min(remaining, Math.max(0,prefTarget));
    remaining -= pref;
    const catchupTarget = remaining>0 ? (o.economics.carry/(1-o.economics.carry))*pref : 0;
    const catchup = Math.min(remaining, Math.max(0,catchupTarget));
    remaining -= catchup;
    const lpStandard = (1-o.economics.carry)*remaining;
    const carryPool = o.economics.carry*remaining;
    const lpBonus = o.economics.lpShare*carryPool;
    const gpManager = o.economics.gpShare*carryPool;
    const devPromote = o.economics.devShare*carryPool;
    const lpTotal = roc+pref+lpStandard+lpBonus;
    const gpTotal = catchup+gpManager;
    const devTotal = devPromote;

    // ---- IC verdict checks ----
    const checks = [
      { k:'Equity IRR', v:equityIRR, min:o.criteria.irrMin, fmt:'pct' },
      { k:'DSCR', v:dscrMin, min:o.criteria.dscrMin, fmt:'x' },
      { k:'MOIC', v:MOIC, min:o.criteria.moicMin, fmt:'x' },
      { k:'Yield on Cost', v:type==='landbank'?null:yieldOnCost, min:o.criteria.yocMin, fmt:'pct', skip:((type==='development'||applySalePctToIncome)&&salePct>=0.999) || isOffPlanSale },
      { k:'Project IRR', v:projectIRR, min:o.criteria.projIrrMin, fmt:'pct' },
      { k:'Pre-Leasing', v:o.criteria.preLeasingActual, min:o.criteria.preLeasingMin, fmt:'pct', skip:type!=='income' },
      // نسبة ما قبل البيع — نظير "نسبة التأجير المسبق" لفرص البيع على الخارطة: تشترط لائحة "وافي" حداً أدنى
      // من الجاهزية/البيع المسبق قبل الترخيص ببدء تحصيل دفعات المشترين.
      { k:'Pre-Sale %', v:o.criteria.preSaleActual, min:o.criteria.preSaleMin, fmt:'pct', skip:!isOffPlanSale },
    ];
    let passCount=0, failCount=0, applicable=0;
    checks.forEach(c=>{ if(c.skip || c.v==null || !isFinite(c.v)) return; applicable++; if(c.v>=c.min) passCount++; else failCount++; });
    let verdict = 'good';
    if(npvProject<0 || failCount>=3) verdict='bad';
    else if(failCount>=1) verdict='warn';

    // ---- الزكاة الشرعية (تقدير توضيحي مبسّط) ----
    // تُطبَّق كطبقة "ماذا لو" منفصلة تماماً فوق equityCF المُحتسَبة فعلاً — لا تُغيّر Equity IRR/MOIC
    // الأساسيين (لأن الزكاة لا تنطبق على كل المستثمرين بالضرورة: مستثمر أجنبي مثلاً يخضع لضريبة استقطاع
    // مختلفة تماماً لا لزكاة). تقدير مبسّط فقط: نسبة سنوية ثابتة من رأس المال المستثمر (وليس احتساباً
    // زكوياً معتمداً على وعاء زكاة فعلي يعتمد على تفاصيل الأصول والمطلوبات ونوع الصندوق).
    let equityIRRAfterZakat = null, MOICAfterZakat = null, totalZakatEstimate = 0;
    if(o.zakat && o.zakat.enabled && equity>0){
      const zRate = o.zakat.ratePct!=null ? o.zakat.ratePct : 0.025;
      const zakatCF = equityCF.map((cf,i)=> i===0 ? cf : cf - equity*zRate);
      totalZakatEstimate = equity*zRate*Math.max(0, equityCF.length-1);
      equityIRRAfterZakat = irr(zakatCF);
      const totalDistribAfterZakat = zakatCF.slice(1).reduce((a,b)=>a+Math.max(0,b),0);
      MOICAfterZakat = totalDistribAfterZakat/equity;
    }

    return {
      tierMult, useInfo, siteFactor, landCost, gfa, footprint, floorsNeeded, buildingHeight, landCostPerGFA, masterMultiplier,
      heightPremiumMult, basementLevels, basementArea, basementCostAmt, basementPremiumAvgPct, gfaWithBasements,
      hardCost, hardCostBase, contingencyPct, costBreakdownAmounts,
      oneTimeFixed, structuringFee, acquisitionFee, arrangementFee, TPC, debt, seniorDebt, mezzDebt, equity, interestRate, Ke, Kd, WACC,
      amortType, assetClass, holdStrategy, scopeType, infraCostAmt, verticalCost, balloonBalanceAtExit,
      gla, totalYears, constructionYears, operationYears,
      equityIRR, projectIRR, npvEquity, npvProject, totalDistrib, contributedEquity, investorCashInvested, MOIC, DPI, RVPI, TVPI, paybackPeriod, dscrMin, dscrAvg,
      equityIRRCashOnly, MOICCashOnly, totalDistribCashOnly,
      stabilizedNOIyr1, yieldOnCost, NAV, ROI,
      mgmtFeeTotal, assetMgmtTotal, regAuditCustodianTotal, fundSideFees, investorSideFees, feesPctOfTPC,
      PIC, roc, pref, catchup, lpStandard, carryPool, lpBonus, gpManager, devPromote, lpTotal, gpTotal, devTotal,
      checks, passCount, failCount, applicable, verdict, salePct, applySalePctToIncome,
      projectCF, equityCF, equityCFCashOnly, pnlRows, annualFundFee,
      isSubdivisionPhased, absorptionSchedule, isOffPlanSale, offPlanSchedule, isPhasedSaleMode,
      equityIRRAfterZakat, MOICAfterZakat, totalZakatEstimate,
      isDirectSaleSplit, directSaleDeferredAmt, directSaleDeferredYear,
      vatIsResidentialExempt: isResidentialUseType(meta.useType),
      totalVatIrrecoverableCost: pnlRows.reduce((a,r)=>a+(r.vatIrrecoverableCost||0),0) + vatIrrecoverableUpfront,
      vatInputTotal, vatRecoveryPct, vatIrrecoverableUpfront, vatWorkingCapitalRefundLagYears: o.vat.refundLagYears||0, drawSchedule,
      totalVatOnRevenueInfo: pnlRows.reduce((a,r)=>a+(r.vatOnRevenueInfo||0),0),
      totalEjarFee: pnlRows.reduce((a,r)=>a+(r.ejarFeeAmt||0),0),
      totalInsurance: pnlRows.reduce((a,r)=>a+(r.insuranceAmt||0),0),
      scenarioKey: scenarioKey||'base',
    };
  }

  return Object.freeze({
    irr,
    npvAt,
    withDefaults,
    compute,
  });
}
