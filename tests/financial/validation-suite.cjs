const fs=require('fs'), vm=require('vm'), assert=require('assert'), path=require('path');
let code=fs.readFileSync(path.join(__dirname,'../../src/core.js'),'utf8');
code=code.replace(/export\s*\{/,'globalThis.__C = {');
const ctx={console,setTimeout,clearTimeout,localStorage:{getItem(){return null},setItem(){}},document:{documentElement:{lang:'ar'},querySelector(){return null},addEventListener(){},getElementById(){return null},querySelectorAll(){return[]},body:{},createElement(){return {}}},window:{},Notification:undefined,navigator:{},URL,FileReader:function(){},Intl,Math,JSON,Date,parseFloat,parseInt,isFinite,Number,String,Array,Object};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx,{timeout:20000});
const C=ctx.__C;
let mapCode=fs.readFileSync(path.join(__dirname,'../../src/features/max-acquisition-price.js'),'utf8');
mapCode=mapCode.replace(/export\s+function/g,'function').replace(/export\s*\{[^}]*\};?/, 'globalThis.__MAP = { maxAcquisitionPrice, irrAtPrice };');
vm.runInContext(mapCode, ctx, {timeout:20000});
const MAP=ctx.__MAP;
// ملاحظة (سبتمبر 2026): blankOpportunity() صارت تُرجع أصفاراً لكل حقل خاص بالمشروع (طلب المستخدم —
// معالج "فرصة جديدة" بالواجهة يجب ألا يعرض أي رقم افتراضي جاهز). هذا الملف يختبر صحة صيغ compute()
// نفسها بمعزل عن الواجهة، فنطبّق هنا نسخة معزولة من الافتراضات الواقعية القديمة فوق الهيكل الفارغ —
// أي حقل لا يحدده base()/الاختبار صراحة بنفسه (مثل development.exitCapRate) يحتاجها ليبقى قابلاً للتنبؤ.
const REALISTIC_TEST_DEFAULTS = {
  land: { area:5000, price:3500, far:2.0, bar:0.5, floorsAllowed:4, basements:1, floorHeight:3.6, setbacks:0.15,
    basementCostPremiumPct:0.30, basementDepthEscalationPct:0.07, floorHeightPremiumPct:0.04 },
  strategy: { salePct:0.5, offPlanSale:{ preSalePctThreshold:0.30 }, directSale:{ collectionLagYears:1 } },
  income: { rent:1000, occupancy:0.92, opex:0.28, wale:4.0, tenantConc:0.20,
    nnn: { leaseTermRemaining:10, pctRentRate:0.06 },
    hospitality: { adr:450, keys:120, gopMargin:0.35 },
    logisticsSpec: { clearHeight:11, dockDoors:8 },
    dataCenterSpec: { powerDensityKw:1.5 },
    refinance: { intervalYears:5, refiLtv:0.65, refiCostPct:0.01, analysisHorizon:10 },
  },
  development: { salePrice:9000, buildCost:4800, constructionYears:2, operationYears:1, exitCapRate:0.08, efficiency:0.85, contingency:0.05,
    costBreakdown:{ structure:0.42, mep:0.18, finishes:0.20, external:0.08, fees:0.12 } },
  landbank: { appreciation:0.08, holdingYears:4, carryAnnual:250000 },
  vat: { refundLagYears:1 },
  subdivision: { absorptionYears:4, priceEscalationAnnual:0.05 },
  subscription: { minInvestment:100000, subscriptionFee:0.02, lockupYears:5 },
  economics: { hurdle:0.12, carry:0.20, lpShare:0.60, gpShare:0.25, devShare:0.15 },
  fees: { mgmt:0.008, structuring:0.008, arrangement:0.010, acquisition:0.015, disposition:0.010, assetMgmt:0.0075, propMgmt:0.04, regAuditCustodian:200000, cmaSetup:750000, dueDiligence:200000, valuation:150000 },
  financing: { ltc:0.60, saibor:0.055, margin:0.025, tenor:5, seniorPct:0.80, mezzMarginAdj:0.04, amortYears:10 },
  wacc: { rf:0.045, mrp:0.065, beta:0.95, crp:0.012, sp:0.020, alpha:0.015, marketCap:0.075, growth:0.03 },
  exitCosts: { broker:0.025, legal:0.010, exitFee:0.005 },
  criteria: { preLeasingActual:0.30, preSaleActual:0.30 },
};
function deepMergeOverride(dst,src){for(const k in src){const sv=src[k];if(sv&&typeof sv==='object'&&!Array.isArray(sv)){if(!dst[k]||typeof dst[k]!=='object')dst[k]={};deepMergeOverride(dst[k],sv);}else{dst[k]=sv;}}return dst;}
function cp(){return deepMergeOverride(JSON.parse(JSON.stringify(C.blankOpportunity())), REALISTIC_TEST_DEFAULTS);}
function set(o,p,v){const a=p.split('.');let x=o;for(let i=0;i<a.length-1;i++)x=x[a[i]];x[a.at(-1)]=v;}
function clean(o){for(const k of ['mgmt','assetMgmt','regAuditCustodian','structuring','acquisition','arrangement','cmaSetup','dueDiligence','valuation'])set(o,'fees.'+k,0);set(o,'subscription.subscriptionFee',0);for(const k of ['broker','legal','rett','exitFee'])set(o,'exitCosts.'+k,0);set(o,'fees.disposition',0);}
function base(){const o=cp();set(o,'meta.oppType','development');set(o,'meta.tier','متوسط');set(o,'meta.useType','__neutral__');for(const k of ['soil','water','tower','topo','infra'])set(o,'site.'+k,1);set(o,'land.floorHeight',3.6);set(o,'land.area',5000);set(o,'land.price',2000);set(o,'land.far',2);set(o,'land.bar',.5);set(o,'land.basements',0);set(o,'development.buildCost',3000);set(o,'development.salePrice',6000);set(o,'development.efficiency',.85);set(o,'development.contingency',.05);set(o,'development.constructionYears',2);set(o,'development.operationYears',0);set(o,'development.scopeType','both');set(o,'strategy.salePct',1);set(o,'financing.ltc',.6);set(o,'financing.saibor',.055);set(o,'financing.margin',.025);set(o,'financing.interestDuringConstruction','cash');clean(o);return o;}
const tests=[]; function t(id,name,fn){try{fn();tests.push({id,name,status:'PASS'});}catch(e){tests.push({id,name,status:'FAIL',error:e.message});}}
t('001','Base development vs independent control',()=>{const c=C.compute(base(),'base');const sf=1*1.05*1.08*1.06*1.06;const expectedHard=10000*3000*sf*1.05;const expectedTPC=10000000+expectedHard;const expectedDebt=expectedTPC*.6;assert(Math.abs(c.TPC-expectedTPC)<1);assert(Math.abs(c.debt-expectedDebt)<1);assert(Math.abs(c.equity-(expectedTPC-expectedDebt))<1);});
t('002','Senior / Mezz weighted debt rate',()=>{const o=base();o.financing.structure='senior_mezz';o.financing.seniorPct=.8;o.financing.mezzMarginAdj=.04;const c=C.compute(o,'base');assert(Math.abs(c.interestRate-.088)<1e-12);});
t('003','Capitalized construction interest changes equity return',()=>{const a=base();const b=base();b.financing.interestDuringConstruction='capitalized';const ca=C.compute(a,'base'),cb=C.compute(b,'base');assert(cb.equityIRR>ca.equityIRR);assert(cb.balloonBalanceAtExit>ca.balloonBalanceAtExit);});
t('004','Refinance close records debt shortfall instead of flooring to zero',()=>{const o=base();o.strategy.exitStrategy='إعادة تمويل (Hold/Refinance)';o.income.refinance={intervalYears:5,refiLtv:.10,refiCostPct:.10,analysisHorizon:10};o.development.operationYears=1;o.income.rent=100;const c=C.compute(o,'base');assert(c.equityCF.at(-1)<0 || c.equityIRR<0);});
t('005','Off-plan escrow lag extends collection horizon',()=>{const o=base();o.strategy.offPlanSale.enabled=true;o.strategy.offPlanSale.escrowLagYears=1;o.development.operationYears=0;const c=C.compute(o,'base');assert.equal(c.totalYears,3);assert.equal(c.offPlanSchedule.at(-1).yr,3);});
t('006','Phased subdivision distributes sales and principal',()=>{const o=base();o.development.scopeType='infra_only';o.development.infraCostPerSqm=100;o.subdivision.phasedAbsorption=true;o.subdivision.absorptionYears=4;o.strategy.salePct=1;const c=C.compute(o,'base');assert.equal(c.totalYears,6);assert.equal(c.absorptionSchedule.length,4);assert(Math.abs(c.absorptionSchedule.reduce((a,x)=>a+x.pct,0)-1)<1e-12);});
t('007','Mixed sell + rent values retained area only',()=>{const o=base();o.strategy.salePct=.5;o.income.rent=1000;const c=C.compute(o,'base');const gla=5000*2*.85;const correctRentValue=(gla*.5*1000*.92*(1-.28)*(1-.04))/.08;const wrongFull=(gla*1000*.92*(1-.28)*(1-.04))/.08;const sale=gla*.5*6000;assert(Math.abs(c.projectCF.at(-1)-(sale+correctRentValue))<100);assert(Math.abs(c.projectCF.at(-1)-(sale+wrongFull))>10000);});
t('008','Subscription fee is included in investor MOIC denominator',()=>{const o=base();o.subscription.subscriptionFee=.02;const c=C.compute(o,'base');assert(Math.abs(c.MOIC-c.totalDistrib/(c.contributedEquity+c.investorSideFees))<1e-10);});
t('009','VAT residential operating input is treated as irrecoverable OPEX',()=>{const o=base();o.meta.oppType='income';o.meta.useType='سكني (Residential)';o.development.constructionYears=1;o.development.operationYears=2;o.income.rent=1000;o.income.gla=1000;o.income.occupancy=1;o.income.opex=.2;o.fees.propMgmt=0;o.vat.enabled=true;o.vat.ratePct=.15;const on=C.compute(o,'base');o.vat.enabled=false;const off=C.compute(o,'base');const delta=off.pnlRows.find(r=>r.yr===2).noi-on.pnlRows.find(r=>r.yr===2).noi;assert(delta>0);assert(Math.abs(delta-1000*1000*.2*.15)<1);});
t('010','Landbank includes annual debt interest',()=>{const o=cp();o.meta.oppType='landbank';o.meta.tier='متوسط';o.land.area=5000;o.land.price=2000;o.financing.ltc=.6;o.financing.saibor=.055;o.financing.margin=.025;o.landbank.holdingYears=4;o.landbank.appreciation=.08;o.landbank.carryAnnual=250000;clean(o);const c=C.compute(o,'base');assert(Math.abs(c.equityCF[1]+980000)<1);assert(c.equityIRR<0);});
t('011','Maximum acquisition price reaches target IRR boundary',()=>{const o=base();o.criteria.irrMin=.15;const src=fs.readFileSync(path.join(__dirname,'../../src/features/max-acquisition-price.js'),'utf8');assert(src.includes('for(let i=0;i<50;i++)'));});
t('012','Sensitivity changes one assumption in each direction',()=>{const o=base();const rows=C.sensitivityRows(o);assert(rows.length>=5);assert(rows.every(r=>r.base!=null&&r.down!=null&&r.up!=null));});
t('013','Optimizer never loses the current baseline as a candidate',()=>{const o=base();const r=C.runOptimizer(o);assert(r.best);assert(r.best.irr>=r.base.equityIRR-1e-12);});
t('014','IC gate includes Project IRR as a financial blocker',()=>{const src=fs.readFileSync(path.join(__dirname,'../../src/features/ic-decision-gate.js'),'utf8');assert(src.includes("label:'Project IRR'"));assert(src.includes('const financialOk = finChecks.every(x=>x.ok)'));});
t('015','Construction draw profile uses average outstanding debt',()=>{const a=base();const b=base();b.financing.drawSchedulePct=[.2,.8];const ca=C.compute(a,'base'),cb=C.compute(b,'base');assert(cb.pnlRows[0].interestExpense<ca.pnlRows[0].interestExpense);assert(cb.pnlRows[1].interestExpense<ca.pnlRows[1].interestExpense);assert.deepEqual(cb.drawSchedule,[.2,.8]);});
t('016','VAT recovery and refund lag are modeled without double-counting',()=>{const o=base();o.meta.oppType='income';o.meta.useType='مكاتب (Office)';o.development.constructionYears=2;o.development.operationYears=1;o.vat.enabled=true;o.vat.ratePct=.15;o.vat.constructionInputVatPct=.15;o.vat.inputRecoveryPct=1;o.vat.refundLagYears=1;const c=C.compute(o,'base');assert(c.vatInputTotal>0);assert.equal(c.vatIrrecoverableUpfront,0);assert(c.pnlRows[1].noi!==undefined);assert(c.equityCF[2]>c.equityCF[1]);});
t('017','Follow-on negative equity cash flows are included in PIC and MOIC denominator',()=>{const o=base();o.development.operationYears=2;o.income.rent=1;o.strategy.salePct=1;const c=C.compute(o,'base');assert(c.equityCF.slice(1).some(v=>v<0));const expectedPIC=c.equityCF.reduce((s,v)=>s+(v<0?Math.abs(v):0),0);assert(Math.abs(c.PIC-expectedPIC)<1e-6);assert(Math.abs(c.MOIC-c.totalDistrib/(expectedPIC+c.investorSideFees))<1e-10);assert(c.PIC>c.equity);});
t('018','IC gate enforces DD completion, evidence verification, and planning feasibility',()=>{const src=fs.readFileSync(path.join(__dirname,'../../src/features/ic-decision-gate.js'),'utf8');assert(src.includes('DD_COMPLETION_MIN'));assert(src.includes('EVIDENCE_VERIFIED_MIN'));assert(src.includes('planningFeasibility'));assert(src.includes('planningOk'));});
t('019','In-kind commitments must be asset-bound before cash timing deducts them',()=>{const src=fs.readFileSync(path.join(__dirname,'../../src/features/cash-flow-timing.js'),'utf8');assert(src.includes('cm.data.inKindAssetId && cm.data.inKindAssetId===oppId'));});
t('020','Waived capital calls are excluded from active called capital',()=>{const src=fs.readFileSync(path.join(__dirname,'../../src/core.js'),'utf8');assert(src.includes("const activeCalls = calls.filter(c=>c.data.status!=='waived')"));assert(src.includes('const called = activeCalls.reduce'));});
t('021','Portfolio NAV and Net IRR labels are explicitly indicative until independent valuations exist',()=>{const p=fs.readFileSync(path.join(__dirname,'../../src/features/portfolio.js'),'utf8');assert(p.includes('Estimated Underwriting NAV'));assert(p.includes('Indicative Net IRR'));});
t('022','Cloud Functions expose server-side business invariant commands',()=>{const src=fs.readFileSync(path.join(__dirname,'../../functions/index.js'),'utf8');assert(src.includes('exports.approveOpportunity = onCall'));assert(src.includes('exports.linkAssetToFund = onCall'));assert(src.includes('exports.postCapitalCall = onCall'));assert(src.includes('Capital call exceeds investor commitment'));});
t('023','English language mode switches the whole app to LTR',()=>{const core=fs.readFileSync(path.join(__dirname,'../../src/core.js'),'utf8');const html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8');assert(core.includes("const dir = LANG==='en' ? 'ltr' : 'rtl'"));assert(core.includes('document.documentElement.dir = dir'));assert(html.includes('html[dir="ltr"] body'));assert(html.includes('html[dir="ltr"] .field input'));});
t('024','Maximum acquisition price respects DSCR, not just IRR, as a binding constraint',()=>{
  const o=base();o.strategy.salePct=0.2;o.development.operationYears=8;o.development.constructionYears=1;o.income.rent=800;o.criteria.irrMin=-1;o.criteria.dscrMin=1.30;
  const coreShim={compute:(x)=>C.compute(x,'base')};
  const withDSCR=MAP.maxAcquisitionPrice(coreShim,o,-1,1.30);
  assert.equal(withDSCR.bindingConstraint,'dscr');
  const atMax=coreShim.compute({...o,land:{...o.land,price:withDSCR.maxPrice}});
  assert(atMax.dscrMin>=1.30-1e-6,'DSCR-aware max price must not breach the DSCR covenant');
  // نفس السيناريو بلا وعي بـDSCR إطلاقاً (كما كان الكود قبل الإصلاح) يقترح سعراً أعلى بكثير ينتهك DSCR فعلياً —
  // هذا يثبت أن قيد DSCR كان مفقوداً فعلاً وأن الإصلاح يمنع توصية سعر شراء يخالف تغطية خدمة الدين المعتمدة.
  const oNoDscr={...o,criteria:{...o.criteria,dscrMin:null}};
  const oldStyle=MAP.maxAcquisitionPrice(coreShim,oNoDscr,-1,null);
  assert(oldStyle.maxPrice>withDSCR.maxPrice*1.5,'pre-fix IRR-only search must overshoot the DSCR-safe price substantially');
  const atOldMax=coreShim.compute({...o,land:{...o.land,price:oldStyle.maxPrice}});
  assert(atOldMax.dscrMin<1.30,'pre-fix IRR-only price must actually violate the DSCR covenant, proving the bug was real');
});
console.table(tests);if(tests.some(x=>x.status==='FAIL'))process.exit(1);
