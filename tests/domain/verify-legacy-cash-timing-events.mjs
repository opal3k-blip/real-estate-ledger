import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { buildTimingFixtures } from './timing-fixtures.mjs';
import { generateLegacyProjectCostEvents } from '../../src/domain/financial/dated/legacy-project-events.js';
import { generateLegacyVatEvents, generateLegacyPhasedSaleEvents } from '../../src/domain/financial/dated/legacy-cash-timing-events.js';
import { FINANCIAL_EVENT_TYPES, aggregateEventEffects } from '../../src/domain/financial/dated/financial-event.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.join(__dirname,'..','..');
let code=fs.readFileSync(path.join(ROOT,'src/core.js'),'utf8').replace(/export\s*\{/,'globalThis.__C = {');
const ctx={console,setTimeout,clearTimeout,localStorage:{getItem(){return null},setItem(){}},document:{documentElement:{lang:'ar'},querySelector(){return null},addEventListener(){},getElementById(){return null},querySelectorAll(){return[]},body:{},createElement(){return{}}},window:{},Notification:undefined,navigator:{},URL,FileReader:function(){},Intl,Math,JSON,Date,parseFloat,parseInt,isFinite,Number,String,Array,Object};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx,{timeout:20000});
const C=ctx.__C;
const fixtures=Object.fromEntries(buildTimingFixtures(C).map(f=>[f.id,f]));
const acquisitionDate='2026-01-01';
const tol=(a,b)=>Math.abs(a-b)<=1e-6*Math.max(1,Math.abs(a),Math.abs(b));

const phasedIds=['T04-offplan-no-lag','T08-offplan-lag1','T09-offplan-lag2-backloaded','T12-phased-subdivision'];
const phasedResults=[];
for(const id of phasedIds){
  const f=fixtures[id];
  const input=JSON.parse(JSON.stringify(f.input));
  const c=C.compute(input,f.scenarioKey||'base');
  const out=generateLegacyPhasedSaleEvents(input,c,{acquisitionDate,scope:`fixture-${id}`});
  assert(out.reconciliation.revenueMatchesSchedule,`${id}: sale proceeds must match legacy tranche schedule`);
  assert(out.reconciliation.costsMatchSchedule,`${id}: sale costs must match legacy tranche schedule`);
  assert(out.reconciliation.principalMatchesSchedule,`${id}: releases must match legacy tranche schedule`);
  assert(out.reconciliation.drawsMatchDebt,`${id}: debt draws must match debt sizing`);
  assert(tol(out.reconciliation.closingDebtBalance,0),`${id}: phased principal ledger must close`);

  const byYear={};
  for(const e of out.events){
    if(e.type!==FINANCIAL_EVENT_TYPES.SALE_PROCEEDS && e.type!==FINANCIAL_EVENT_TYPES.FEE) continue;
    const yr=Math.round((new Date(`${e.date}T00:00:00Z`)-new Date(`${acquisitionDate}T00:00:00Z`))/(365.25*86400000));
    const fx=e.type===FINANCIAL_EVENT_TYPES.SALE_PROCEEDS?e.amount:-e.amount;
    byYear[yr]=(byYear[yr]||0)+fx;
  }
  for(const tranche of (c.offPlanSchedule||c.absorptionSchedule||[])){
    assert(tol(byYear[tranche.yr]||0,tranche.trancheRevenue-tranche.trancheCosts),`${id}: year ${tranche.yr} sale cash timing mismatch`);
    assert(tol(c.projectCF[tranche.yr],tranche.trancheRevenue-tranche.trancheCosts),`${id}: fixture projectCF must expose same phased-sale cash timing`);
  }
  phasedResults.push({id,kind:out.kind,tranches:(c.offPlanSchedule||c.absorptionSchedule||[]).length,closingDebt:out.reconciliation.closingDebtBalance});
}

const vatIds=['T10-vat-refund-lag0','T11-vat-refund-lag2'];
const vatResults=[];
for(const id of vatIds){
  const f=fixtures[id];
  const input=JSON.parse(JSON.stringify(f.input));
  const c=C.compute(input,f.scenarioKey||'base');
  const vat=generateLegacyVatEvents(input,c,{acquisitionDate,scope:`fixture-${id}`});
  const project=generateLegacyProjectCostEvents(c,{acquisitionDate,scope:`fixture-${id}-project`});
  const vatInput=vat.events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.VAT_INPUT_PAYMENT).reduce((a,e)=>a+e.amount,0);
  assert(tol(vatInput,c.vatInputTotal),`${id}: VAT t0 funding must equal vatInputTotal`);
  assert(tol(project.reconciliation.generatedProjectOutflow+vatInput,c.TPC),`${id}: project cost + VAT t0 must equal TPC`);
  assert(tol(vat.reconciliation.refunds,vat.reconciliation.recoverableTarget),`${id}: fixture must fully recover modeled recoverable VAT`);
  assert.equal(vat.reconciliation.findings.length,0,`${id}: no VAT truncation expected in fixture`);

  for(const row of vat.refundRows){
    const pnl=c.pnlRows.find(r=>Math.round(Number(r.yr))===row.yr);
    const exitNet=(pnl?.exitValue||0)-(pnl?.exitCostsAmt||0);
    const nonExitProjectCash=(c.projectCF[row.yr]||0)-exitNet;
    assert(tol(nonExitProjectCash,row.amount),`${id}: year ${row.yr} VAT refund timing must reconcile to legacy projectCF`);
  }
  vatResults.push({id,lag:c.vatWorkingCapitalRefundLagYears,refundEvents:vat.refundRows.length,refunds:vat.reconciliation.refunds});
}

console.table(phasedResults);
console.table(vatResults);
console.log(`PASS verify-legacy-cash-timing-events: ${phasedIds.length} phased-sale fixtures + ${vatIds.length} VAT fixtures reconcile to current core.js timing.`);
