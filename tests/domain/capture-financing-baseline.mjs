import coreVmSource from '../helpers/core-vm-source.cjs';
/* =========================================================================
   capture-financing-baseline.mjs — Phase 3B-4A: Financing Baseline (REBUILD)
   ---------------------------------------------------------------------------
   إعادة بناء كاملة بعد فقدان بيئة العمل السحابية السابقة (commit 4ffce48 لم
   يعد موجوداً في أي مكان). هذه المرة العمل مباشرة ضد src/core.js *الحقيقي*
   في هذا المستودع (لا يوجد src/domain/financial/financial-engine.js منفصل
   إطلاقاً — تم التحقق بالبحث الفعلي).

   تحميل core.js: نفس تقنية vm.createContext المُثبَتة في
   tests/financial/validation-suite.cjs وtests/domain/golden-fixtures.mjs —
   لا إعادة اختراع.

   يكتب: tests/domain/financing-baseline.json
   يُستهلَك من: tests/domain/verify-financing-baseline.mjs
   التشغيل: node tests/domain/capture-financing-baseline.mjs
   ========================================================================= */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

const coreCode = coreVmSource.buildCoreVmSource();
const ctx = {
  console, setTimeout, clearTimeout,
  localStorage: { getItem(){ return null; }, setItem(){} },
  document: { documentElement:{ lang:'ar' }, querySelector(){ return null; }, addEventListener(){}, getElementById(){ return null; }, querySelectorAll(){ return []; }, body:{}, createElement(){ return {}; } },
  window: {}, Notification: undefined, navigator: {}, URL, FileReader: function(){}, Intl, Math, JSON, Date, parseFloat, parseInt, isFinite, Number, String, Array, Object,
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(coreCode, ctx, { timeout: 20000 });
const C = ctx.__C;

function deepMergeOverride(dst, src) {
  for (const k in src) {
    const sv = src[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {};
      deepMergeOverride(dst[k], sv);
    } else { dst[k] = sv; }
  }
  return dst;
}
function set(o, p, v) { const a = p.split('.'); let x = o; for (let i = 0; i < a.length - 1; i++) x = x[a[i]]; x[a.at(-1)] = v; }
function clean(o) {
  for (const k of ['mgmt','assetMgmt','regAuditCustodian','structuring','acquisition','arrangement','cmaSetup','dueDiligence','valuation']) set(o, 'fees.'+k, 0);
  set(o, 'subscription.subscriptionFee', 0);
  for (const k of ['broker','legal','rett','exitFee']) set(o, 'exitCosts.'+k, 0);
  set(o, 'fees.disposition', 0);
  return o;
}
function cp() { return JSON.parse(JSON.stringify(C.blankOpportunity())); }
function base() {
  const o = cp();
  set(o,'meta.oppType','development'); set(o,'meta.tier','متوسط'); set(o,'meta.useType','__neutral__');
  for (const k of ['soil','water','tower','topo','infra']) set(o,'site.'+k,1);
  set(o,'land.floorHeight',3.6); set(o,'land.area',5000); set(o,'land.price',2000);
  set(o,'land.far',2); set(o,'land.bar',.5); set(o,'land.basements',0);
  set(o,'development.buildCost',3000); set(o,'development.salePrice',6000);
  set(o,'development.efficiency',.85); set(o,'development.contingency',.05);
  set(o,'development.constructionYears',2); set(o,'development.operationYears',0);
  set(o,'development.scopeType','both'); set(o,'strategy.salePct',1);
  set(o,'financing.ltc',.6); set(o,'financing.saibor',.055); set(o,'financing.margin',.025);
  set(o,'financing.interestDuringConstruction','cash');
  clean(o);
  return o;
}

const fixtures = [];
function fx(id, label, financingFocus, mutate) {
  const o = base();
  mutate(o);
  fixtures.push({ id, label, financingFocus, d: o, scenarioKey: 'base' });
}

fx('T01-base-development','Base development — single tranche, cash interest, no draw schedule','بلا drawSchedule — دين أحادي، فائدة نقدية، سداد interest_only.', ()=>{});
fx('T02-construction-heavy','Construction-heavy (4yr)','مثل T01 لكن إنشاء أطول (4 سنوات) — تراكم فائدة أطول بلا drawSchedule.', o=>{ set(o,'development.constructionYears',4); });
fx('T05-debt-draw-schedule','Explicit 3-year draw schedule [20/30/50]','جدول سحب صريح 3 سنوات — يختبر drawStart/drawEnd averaging.', o=>{ set(o,'development.constructionYears',3); set(o,'financing.drawSchedulePct',[0.2,0.3,0.5]); });
fx('T06-capitalized-interest','Capitalized construction interest','فائدة إنشاء مُرسمَلة.', o=>{ set(o,'financing.interestDuringConstruction','capitalized'); });
fx('T07-cash-interest','Cash construction interest (explicit contrast to T06)','فائدة إنشاء نقدية صراحة — نظير T06 للمقارنة المباشرة.', o=>{ set(o,'financing.interestDuringConstruction','cash'); });
fx('T13-landbank','Landbank with real debt (ltc=0.4)','بنك أراضٍ بدين فعلي — لا سنوات إنشاء، فائدة على كامل مدة الاحتفاظ.', o=>{
  set(o,'meta.oppType','landbank'); set(o,'land.area',5000); set(o,'land.price',2000);
  set(o,'financing.ltc',0.4); set(o,'landbank.holdingYears',4); set(o,'landbank.appreciation',0.08); set(o,'landbank.carryAnnual',250000);
});
fx('T14-one-year-project','One-year horizon only','أفق سنة واحدة فقط — حدود منطق isLast مع سنة الإنشاء نفسها.', o=>{ set(o,'development.constructionYears',1); set(o,'development.operationYears',0); });
fx('T15-senior-mezz','Senior + Mezz structure','هيكل senior_mezz — معدلا فائدة مختلفان يُدمَجان في interestRate مرجَّح واحد وقت التحجيم (t=0) فقط.', o=>{
  set(o,'financing.structure','senior_mezz'); set(o,'financing.seniorPct',0.8); set(o,'financing.mezzMarginAdj',0.04);
});
fx('T18-high-leverage','High leverage (ltc=0.90)','رافعة شبه كاملة — حدّي DSCR/equity.', o=>{ set(o,'financing.ltc',0.90); });
fx('F01-no-debt','No debt at all (ltc=0)','equity=TPC بالكامل، debt=0, seniorDebt=0, mezzDebt=0.', o=>{ set(o,'financing.ltc',0); });
fx('F02-empty-draw-schedule-explicit','Explicit empty draw schedule ([])','يثبت أن [] الصريحة تُنتج نفس سلوك عدم التحديد (T01).', o=>{ set(o,'financing.drawSchedulePct',[]); });
fx('F03-draw-schedule-2yr','2-year draw schedule [30/70]','نظير T05 لكن سنتين فقط — تطبيع/تقصير المصفوفة.', o=>{ set(o,'development.constructionYears',2); set(o,'financing.drawSchedulePct',[0.3,0.7]); });
fx('F04-amort-amortizing','Amortizing repayment','principalPay = min(remainingDebt, debt/amortYears) لكل سنة تشغيل بعد graceYears.', o=>{
  set(o,'development.operationYears',5); set(o,'financing.amortType','amortizing'); set(o,'financing.amortYears',10); set(o,'financing.graceYears',0);
});
fx('F05-amort-partial-balloon','Partial amortization + balloon','نفس صيغة amortizing حرفياً + graceYears=1 يختبر تأجيل بداية الاستهلاك.', o=>{
  set(o,'development.operationYears',5); set(o,'financing.amortType','partial_amort_balloon'); set(o,'financing.amortYears',15); set(o,'financing.graceYears',1);
});

function safeNum(v) {
  if (typeof v !== 'number') return v;
  if (Number.isNaN(v)) return '__NaN__';
  if (v === Infinity) return '__Infinity__';
  if (v === -Infinity) return '__-Infinity__';
  return v;
}
function deepSafe(v) {
  if (Array.isArray(v)) return v.map(deepSafe);
  if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = deepSafe(v[k]); return o; }
  return safeNum(v);
}

const baseline = { generatedAt: new Date().toISOString(), fixtureCount: fixtures.length, fixtures: {} };
let errors = 0;
const summary = [];

for (const f of fixtures) {
  let c;
  try { c = C.compute(f.d, f.scenarioKey); }
  catch (e) { errors++; console.log(`FAIL ${f.id}: threw — ${e.message}`); continue; }

  const totalInterest = c.pnlRows.reduce((a,r)=> a + (r.interestExpense||0), 0);
  const derivedPnlRows = c.pnlRows.map(r => {
    const impliedCashInterest = (r.debtService||0) - (r.principalPayment||0);
    const impliedCapInterest = (r.interestExpense||0) - impliedCashInterest;
    return { yr: r.yr, impliedCashInterest, impliedCapInterest };
  });
  const equityCFNegativeYears = c.equityCF.map((v,i)=>({i, v})).filter(x=>x.v<0);

  baseline.fixtures[f.id] = {
    label: f.label, scenarioKey: f.scenarioKey, financingFocus: f.financingFocus,
    input: deepSafe(f.d),
    financingFacts: deepSafe({
      TPC: c.TPC, debt: c.debt, seniorDebt: c.seniorDebt, mezzDebt: c.mezzDebt,
      equity: c.equity, contributedEquity: c.contributedEquity, interestRate: c.interestRate, Kd: c.Kd,
      amortType: c.amortType, holdStrategy: c.holdStrategy, drawSchedule: c.drawSchedule,
      balloonBalanceAtExit: c.balloonBalanceAtExit, totalYears: c.totalYears, constructionYears: c.constructionYears,
      equityCF: c.equityCF,
      pnlRows: c.pnlRows.map(r => ({ yr:r.yr, phase:r.phase, isExitYear:r.isExitYear, interestExpense:r.interestExpense, principalPayment:r.principalPayment, debtService:r.debtService, debtPayoffAtExit:r.debtPayoffAtExit })),
    }),
    derivedForDocumentation: deepSafe({ totalInterest, pnlRows: derivedPnlRows, equityCFNegativeYearCount: equityCFNegativeYears.length, equityCFNegativeYears }),
  };
  summary.push({ id:f.id, debt:Math.round(c.debt), senior:Math.round(c.seniorDebt), mezz:Math.round(c.mezzDebt), equity:Math.round(c.equity), contributedEquity:Math.round(c.contributedEquity), amort:c.amortType, balloon:Math.round(c.balloonBalanceAtExit) });
}

console.table(summary);
if (errors) { console.log(`FAILED: ${errors} fixture(s) threw.`); process.exit(1); }

const outPath = path.join(__dirname, 'financing-baseline.json');
fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2));
console.log(`\nFinancing Baseline written: ${path.relative(ROOT, outPath)} (${fixtures.length} fixtures)`);
