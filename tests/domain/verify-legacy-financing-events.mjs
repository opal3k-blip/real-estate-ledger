import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { generateLegacyFundingPrincipalEvents } from '../../src/domain/financial/dated/legacy-financing-events.js';
import { generateLegacyInterestEvents } from '../../src/domain/financial/dated/legacy-interest-engine.js';
import { FINANCIAL_EVENT_TYPES } from '../../src/domain/financial/dated/financial-event.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.join(__dirname,'..','..');
let code=fs.readFileSync(path.join(ROOT,'src/core.js'),'utf8').replace(/export\s*\{/,'globalThis.__C = {');
const ctx={console,setTimeout,clearTimeout,localStorage:{getItem(){return null},setItem(){}},document:{documentElement:{lang:'ar'},querySelector(){return null},addEventListener(){},getElementById(){return null},querySelectorAll(){return[]},body:{},createElement(){return{}}},window:{},Notification:undefined,navigator:{},URL,FileReader:function(){},Intl,Math,JSON,Date,parseFloat,parseInt,isFinite,Number,String,Array,Object};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx,{timeout:20000});
const C=ctx.__C;
const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'financing-baseline.json'),'utf8'));

const results=[];
for(const [id,f] of Object.entries(baseline.fixtures)){
  const input=JSON.parse(JSON.stringify(f.input));
  const c=C.compute(input,f.scenarioKey||'base');
  const opts={acquisitionDate:'2026-01-01',scope:`fixture-${id}`};
  const b=generateLegacyFundingPrincipalEvents(input,c,opts);
  const c4=generateLegacyInterestEvents(input,c,opts);

  assert(Math.abs(b.equity.delta)<1e-6,`${id}: contributions must reconcile to contributedEquity`);
  assert(Math.abs(b.principal.reconciliation.principalDraws-c.debt)<1e-6,`${id}: principal draws must equal debt sizing`);
  assert(Math.abs(b.principal.reconciliation.principalClosing)<1e-6,`${id}: principal-only ledger must close at exit`);
  assert.equal(b.facility.id,'LEGACY_BLENDED_DEBT');
  assert.equal(b.facility.limitScope,'PRINCIPAL_DRAWS_ONLY');
  assert(c4.reconciliation.allInterestMatchesLegacy,`${id}: recomputed interest must match legacy pnlRows`);

  const hasInterestIn4B=b.events.some(e=>e.type===FINANCIAL_EVENT_TYPES.INTEREST_PAYMENT||e.type===FINANCIAL_EVENT_TYPES.INTEREST_CAPITALIZED);
  assert.equal(hasInterestIn4B,false,`${id}: 4B must not generate interest`);

  results.push({id,eqEvents:b.equity.events.length,draws:b.principal.events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.DEBT_DRAW).length,interestResidual:c4.reconciliation.canonicalClosingDebtBalance,findings:c4.reconciliation.findings.map(x=>x.code)});
}

for(const id of ['F04-amort-amortizing','F05-amort-partial-balloon']){
  const r=results.find(x=>x.id===id);
  assert(r.eqEvents>1,`${id}: must contain follow-on equity contributions`);
}
const t15=baseline.fixtures['T15-senior-mezz'];
const t15c=C.compute(JSON.parse(JSON.stringify(t15.input)),t15.scenarioKey||'base');
const t15b=generateLegacyFundingPrincipalEvents(t15.input,t15c,{acquisitionDate:'2026-01-01'});
assert(t15b.facility.legacySizing.seniorDebt>0 && t15b.facility.legacySizing.mezzDebt>0);
assert.equal(t15b.facility.id,'LEGACY_BLENDED_DEBT');

const t06=results.find(x=>x.id==='T06-capitalized-interest');
assert(t06.interestResidual>0,'T06 must surface final-period capitalized-interest residual instead of silently erasing it');
assert(t06.findings.includes('LEGACY_FINAL_PERIOD_CAP_INTEREST_NOT_PAID'));
const t06base=baseline.fixtures['T06-capitalized-interest'].financingFacts.pnlRows.at(-1).interestExpense;
assert(Math.abs(t06.interestResidual-t06base)<1e-6,'T06 residual must equal final-period capitalized interest omitted from legacy payoff');

console.table(results);
console.log(`PASS verify-legacy-financing-events: ${results.length}/${results.length} fixtures; 4B funding/principal and 4C interest reconcile, with legacy final-period capitalization defect surfaced explicitly.`);
