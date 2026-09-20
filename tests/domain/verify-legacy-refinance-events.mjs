import coreVmSource from '../helpers/core-vm-source.cjs';
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { buildTimingFixtures } from './timing-fixtures.mjs';
import { generateLegacyRefinanceEvents } from '../../src/domain/financial/dated/legacy-refinance-events.js';
import { FINANCIAL_EVENT_TYPES } from '../../src/domain/financial/dated/financial-event.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.join(__dirname,'..','..');
let code=coreVmSource.buildCoreVmSource();
const ctx={console,setTimeout,clearTimeout,localStorage:{getItem(){return null},setItem(){}},document:{documentElement:{lang:'ar'},querySelector(){return null},addEventListener(){},getElementById(){return null},querySelectorAll(){return[]},body:{},createElement(){return{}}},window:{},Notification:undefined,navigator:{},URL,FileReader:function(){},Intl,Math,JSON,Date,parseFloat,parseInt,isFinite,Number,String,Array,Object};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx,{timeout:20000});
const C=ctx.__C;
const fixtures=Object.fromEntries(buildTimingFixtures(C).map(f=>[f.id,f]));
const acquisitionDate='2026-01-01';
const tol=(a,b)=>Math.abs(a-b)<=1e-6*Math.max(1,Math.abs(a),Math.abs(b));
const countType=(events,type)=>events.filter(e=>e.type===type).length;

const results=[];

// T16 — terminal refinance-close.
{
  const id='T16-refinance-close';
  const f=fixtures[id];
  const input=JSON.parse(JSON.stringify(f.input));
  const c=C.compute(input,f.scenarioKey||'base');
  const out=generateLegacyRefinanceEvents(input,c,{acquisitionDate,scope:`fixture-${id}`});
  assert.equal(c.holdStrategy,'refinance_close');
  assert.equal(out.refinanceRows.length,1);
  const r=out.refinanceRows[0];
  assert.equal(r.yr,c.totalYears);
  assert.equal(r.date,'2033-01-01');
  assert.equal(r.kind,'TERMINAL_CLOSE');
  assert(tol(r.oldDebtRemaining,c.balloonBalanceAtExit),'T16: refinance must repay the legacy pre-refi balloon');
  assert(tol(r.newLoan,r.propertyValue*input.income.refinance.refiLtv),'T16: replacement loan must equal refi LTV × collateral value');
  assert(tol(r.refiCost,r.newLoan*input.income.refinance.refiCostPct),'T16: fee must equal refi cost % × new loan');
  const finalPnl=c.pnlRows.at(-1);
  const netOperating=finalPnl.noi-finalPnl.interestExpense-finalPnl.principalPayment-c.annualFundFee;
  assert(tol(c.equityCF[c.totalYears]-netOperating,r.distribution),'T16: terminal equity cash must decompose into operating cash + refi distribution');
  assert.equal(countType(out.events,FINANCIAL_EVENT_TYPES.REFINANCE_DRAW),1);
  assert.equal(countType(out.events,FINANCIAL_EVENT_TYPES.REFINANCE_REPAYMENT),1);
  assert.equal(countType(out.events,FINANCIAL_EVENT_TYPES.REFINANCE_FEE),1);
  assert.equal(countType(out.events,FINANCIAL_EVENT_TYPES.DISTRIBUTION),1);
  assert(tol(out.reconciliation.canonicalClosingDebtBalance,r.newLoan),'T16: canonical ledger must retain replacement debt after close-refi');
  assert(out.reconciliation.allInterestMatchesLegacy,'T16: interest path must reconcile year-by-year');
  assert(out.reconciliation.findings.some(x=>x.code==='LEGACY_REFINANCE_CLOSE_TERMINAL_DEBT_REPORTS_PRE_REFI_BALANCE'),'T16: expected terminal debt reporting finding');
  results.push({id,refiYears:out.refinanceRows.map(x=>x.yr).join(','),closingDebt:out.reconciliation.canonicalClosingDebtBalance,findings:out.reconciliation.findings.map(x=>x.code)});
}

// T17 — periodic refinance in perpetual hold, plus terminal horizon anomaly.
{
  const id='T17-perpetual-hold-periodic-refi';
  const f=fixtures[id];
  const input=JSON.parse(JSON.stringify(f.input));
  const c=C.compute(input,f.scenarioKey||'base');
  const out=generateLegacyRefinanceEvents(input,c,{acquisitionDate,scope:`fixture-${id}`});
  assert.equal(c.holdStrategy,'perpetual_hold');
  assert.deepEqual(out.refinanceRows.map(r=>r.yr),[4,7],'T17: periodic refinance years must follow years-into-operation interval');
  assert.equal(countType(out.events,FINANCIAL_EVENT_TYPES.REFINANCE_DRAW),2);
  assert.equal(countType(out.events,FINANCIAL_EVENT_TYPES.REFINANCE_REPAYMENT),2);
  assert.equal(countType(out.events,FINANCIAL_EVENT_TYPES.REFINANCE_FEE),2);
  assert.equal(countType(out.events,FINANCIAL_EVENT_TYPES.DISTRIBUTION),2);
  assert(out.reconciliation.allInterestMatchesLegacy,'T17: post-refi interest path must reconcile year-by-year');

  for(const r of out.refinanceRows){
    const pnl=c.pnlRows.find(x=>x.yr===r.yr);
    const netOperating=pnl.noi-pnl.interestExpense-pnl.principalPayment-c.annualFundFee;
    assert(tol(c.equityCFCashOnly[r.yr]-netOperating,r.distribution),`${id}: year ${r.yr} equity cash must decompose into operating cash + refi distribution`);
  }

  const p=out.reconciliation.perpetual;
  assert(p,'T17: perpetual reconciliation required');
  assert(tol(out.reconciliation.canonicalClosingDebtBalance,out.refinanceRows.at(-1).newLoan),'T17: canonical debt remains after measurement horizon');
  assert(tol(p.legacyNAV,p.canonicalResidualEquity),'T17: legacy NAV should equal property value less canonical outstanding debt');
  assert(p.navMatchesCanonicalResidual,'T17: NAV residual reconciliation expected');
  assert(tol(p.legacyResidualAdded,p.propertyValueEnd),'T17: legacy book series adds full property value after deemed exit');
  assert(out.reconciliation.findings.some(x=>x.code==='LEGACY_PERPETUAL_HOLD_HORIZON_RUNS_DEEMED_EXIT'),'T17: expected deemed-exit finding');
  assert(out.reconciliation.findings.some(x=>x.code==='LEGACY_PERPETUAL_HOLD_RESIDUAL_VALUE_DOUBLE_COUNT'),'T17: expected residual double-count finding');
  results.push({id,refiYears:out.refinanceRows.map(x=>x.yr).join(','),closingDebt:out.reconciliation.canonicalClosingDebtBalance,findings:out.reconciliation.findings.map(x=>x.code)});
}

console.table(results);
console.log('PASS verify-legacy-refinance-events: T16 terminal refinance + T17 periodic refinance reconcile, with terminal legacy inconsistencies surfaced explicitly.');
