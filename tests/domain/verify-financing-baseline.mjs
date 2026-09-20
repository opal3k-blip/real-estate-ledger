/* =========================================================================
   verify-financing-baseline.mjs — Phase 3B-4A: Financing Baseline — حارس
   ---------------------------------------------------------------------------
   يُعيد تشغيل كل fixture من financing-baseline.json المُجمَّد عبر core.js
   *الحالي* (نفس vm.createContext loader)، ويقارن financingFacts +
   derivedForDocumentation حرفياً.
   التشغيل: node tests/domain/verify-financing-baseline.mjs
   ========================================================================= */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import assert from 'assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let coreCode = fs.readFileSync(path.join(ROOT, 'src/core.js'), 'utf8');
coreCode = coreCode.replace(/export\s*\{/, 'globalThis.__C = {');
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

function unsafeNum(v){ if(v==='__NaN__')return NaN; if(v==='__Infinity__')return Infinity; if(v==='__-Infinity__')return -Infinity; return v; }
function deepUnsafe(v){ if(Array.isArray(v))return v.map(deepUnsafe); if(v&&typeof v==='object'){const o={};for(const k in v)o[k]=deepUnsafe(v[k]);return o;} return unsafeNum(v); }
function safeForCompare(v){
  // ملاحظة حاسمة: v قد يأتي من سياق vm منفصل (realm مختلف) — Array/Object الخاصة به
  // مختلفة عن Array/Object في هذا الـrealm، فيفشل assert.deepStrictEqual بخطأ
  // "same structure but are not reference-equal" حتى لو كانت القيم متطابقة حرفياً.
  // الحل: تطبيع كامل عبر JSON.stringify/parse (بهذا الـrealm) مع معالجة NaN/Infinity
  // يدوياً (JSON الافتراضي يحوّلها إلى null ويفقد المعلومة).
  const replacer = (_k, val) => {
    if (typeof val === 'number') {
      if (Number.isNaN(val)) return '__NaN__';
      if (val === Infinity) return '__Infinity__';
      if (val === -Infinity) return '__-Infinity__';
    }
    return val;
  };
  return JSON.parse(JSON.stringify(v, replacer));
}

let failures = 0;
function ok(l){ console.log(`OK  ${l}`); }
function fail(l,d){ failures++; console.log(`FAIL ${l}${d?`\n   ${d}`:''}`); }

const baseline = JSON.parse(fs.readFileSync(path.join(__dirname,'financing-baseline.json'),'utf8'));
const ids = Object.keys(baseline.fixtures);
console.log(`=== Phase 3B-4A Financing Baseline: ${ids.length} fixture(s) ===\n`);

for (const id of ids) {
  const f = baseline.fixtures[id];
  const input = deepUnsafe(f.input);
  let c;
  try { c = C.compute(input, f.scenarioKey); }
  catch(e){ fail(`${id}: threw during re-computation`, e.message); continue; }

  const totalInterest = c.pnlRows.reduce((a,r)=>a+(r.interestExpense||0),0);
  const derivedPnlRows = c.pnlRows.map(r=>{
    const impliedCashInterest = (r.debtService||0)-(r.principalPayment||0);
    const impliedCapInterest = (r.interestExpense||0)-impliedCashInterest;
    return { yr:r.yr, impliedCashInterest, impliedCapInterest };
  });
  const equityCFNegativeYears = c.equityCF.map((v,i)=>({i,v})).filter(x=>x.v<0);

  const freshFacts = safeForCompare({
    TPC:c.TPC, debt:c.debt, seniorDebt:c.seniorDebt, mezzDebt:c.mezzDebt, equity:c.equity, contributedEquity:c.contributedEquity,
    interestRate:c.interestRate, Kd:c.Kd, amortType:c.amortType, holdStrategy:c.holdStrategy, drawSchedule:c.drawSchedule,
    balloonBalanceAtExit:c.balloonBalanceAtExit, totalYears:c.totalYears, constructionYears:c.constructionYears, equityCF:c.equityCF,
    pnlRows: c.pnlRows.map(r=>({yr:r.yr,phase:r.phase,isExitYear:r.isExitYear,interestExpense:r.interestExpense,principalPayment:r.principalPayment,debtService:r.debtService,debtPayoffAtExit:r.debtPayoffAtExit})),
  });
  const freshDerived = safeForCompare({ totalInterest, pnlRows: derivedPnlRows, equityCFNegativeYearCount: equityCFNegativeYears.length, equityCFNegativeYears });

  let mismatched = false;
  try { assert.deepStrictEqual(freshFacts, f.financingFacts); } catch(e){ mismatched=true; fail(`${id}: financingFacts drifted`, e.message); }
  try { assert.deepStrictEqual(freshDerived, f.derivedForDocumentation); } catch(e){ mismatched=true; fail(`${id}: derivedForDocumentation drifted`, e.message); }
  if(!mismatched) ok(`${id}: matches frozen baseline exactly.`);
}

console.log(`\n${'='.repeat(70)}`);
if (failures) { console.log(`${failures} FAILURE(S).`); process.exit(1); }
console.log(`${ids.length}/${ids.length} fixtures: Financing Baseline (Phase 3B-4A) matches current core.js exactly.`);
