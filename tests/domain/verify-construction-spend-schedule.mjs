import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { buildTimingFixtures } from './timing-fixtures.mjs';
import { normalizeConstructionSpendSchedule, CONSTRUCTION_SPEND_SCHEDULE_VERSION, CONSTRUCTION_SPEND_BASIS } from '../../src/domain/financial/dated/construction-spend-schedule.js';
import { generateScheduledProjectCostEvents, generateScheduledConstructionVatEvents, generateTransactionGradeConstructionEvents } from '../../src/domain/financial/dated/scheduled-construction-events.js';
import { FINANCIAL_EVENT_TYPES } from '../../src/domain/financial/dated/financial-event.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.join(__dirname,'..','..');
let code=fs.readFileSync(path.join(ROOT,'src/core.js'),'utf8').replace(/export\s*\{/,'globalThis.__C = {');
const ctx={console,setTimeout,clearTimeout,localStorage:{getItem(){return null},setItem(){}},document:{documentElement:{lang:'ar'},querySelector(){return null},addEventListener(){},getElementById(){return null},querySelectorAll(){return[]},body:{},createElement(){return{}}},window:{},Notification:undefined,navigator:{},URL,FileReader:function(){},Intl,Math,JSON,Date,parseFloat,parseInt,isFinite,Number,String,Array,Object};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx,{timeout:20000});
const C=ctx.__C;
const fixtures=buildTimingFixtures(C);
const get=id=>fixtures.find(f=>f.id===id);
const acquisitionDate='2026-01-15';
const schedule={
  version:CONSTRUCTION_SPEND_SCHEDULE_VERSION,
  basis:CONSTRUCTION_SPEND_BASIS,
  entries:[
    {date:'2026-04-15',share:0.10},
    {date:'2026-10-15',share:0.25},
    {date:'2027-04-15',share:0.35},
    {date:'2027-10-15',share:0.30},
  ],
};

// Contract is strict: transaction-grade timing is never invented or silently normalized.
assert.throws(()=>normalizeConstructionSpendSchedule(null,{acquisitionDate,constructionYears:2}),/MISSING_CONSTRUCTION_SPEND_SCHEDULE/);
assert.throws(()=>normalizeConstructionSpendSchedule({...schedule,entries:[{date:'2026-04-15',share:0.4},{date:'2026-10-15',share:0.5}]},{acquisitionDate,constructionYears:2}),/CONSTRUCTION_SPEND_SHARES_MUST_SUM_TO_ONE/);
assert.throws(()=>normalizeConstructionSpendSchedule({...schedule,entries:[{date:'2026-04-15',share:0.5},{date:'2026-04-15',share:0.5}]},{acquisitionDate,constructionYears:2}),/DUPLICATE_CONSTRUCTION_SPEND_DATE/);
assert.throws(()=>normalizeConstructionSpendSchedule({...schedule,entries:[{date:'2026-04-15',share:0.5},{date:'2028-04-15',share:0.5}]},{acquisitionDate,constructionYears:2}),/CONSTRUCTION_SPEND_AFTER_MODELED_COMPLETION/);

const base=get('T01-base-development');
const baseInput=JSON.parse(JSON.stringify(base.input));
const baseC=C.compute(baseInput,'base');
const project=generateScheduledProjectCostEvents(baseC,{acquisitionDate,constructionSpendSchedule:schedule,scope:'t01-scheduled'});
assert(Math.abs(project.reconciliation.delta)<1e-6,'scheduled project costs must preserve total TPC excluding VAT');
const constructionDates=[...new Set(project.events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.CONSTRUCTION_COST||e.type===FINANCIAL_EVENT_TYPES.CONTINGENCY).map(e=>e.date))];
assert.deepEqual(constructionDates,schedule.entries.map(e=>e.date),'construction spend dates must be exactly the explicit schedule dates');
assert(project.events.find(e=>e.type===FINANCIAL_EVENT_TYPES.LAND_ACQUISITION)?.date===acquisitionDate,'land remains at acquisition');
assert(project.events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.FEE).every(e=>e.date===acquisitionDate),'legacy fixed/transaction fees remain upfront');
const repeat=generateScheduledProjectCostEvents(baseC,{acquisitionDate,constructionSpendSchedule:schedule,scope:'t01-scheduled'});
assert.deepEqual(repeat.events,project.events,'scheduled event generation must be deterministic');

const vatFixture=get('T11-vat-refund-lag2');
const vatInput=JSON.parse(JSON.stringify(vatFixture.input));
const vatC=C.compute(vatInput,'base');
const vatSchedule={
  version:CONSTRUCTION_SPEND_SCHEDULE_VERSION,
  basis:CONSTRUCTION_SPEND_BASIS,
  entries:[
    {date:'2026-03-15',share:0.20},
    {date:'2026-12-15',share:0.30},
    {date:'2027-09-15',share:0.30},
    {date:'2028-01-15',share:0.20},
  ],
};
const vat=generateScheduledConstructionVatEvents(vatInput,vatC,{acquisitionDate,constructionSpendSchedule:vatSchedule,scope:'t11-scheduled-vat'});
assert(Math.abs(vat.reconciliation.inputPayments-vatC.vatInputTotal)<1e-6,'scheduled VAT payments must reconcile to vatInputTotal');
assert(Math.abs(vat.reconciliation.refunds-vatC.vatInputTotal*vatC.vatRecoveryPct)<1e-6,'scheduled VAT refunds must reconcile to recoverable VAT');
const hardVatPayments=vat.events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.VAT_INPUT_PAYMENT && e.metadata.timingConvention==='EXPLICIT_CONSTRUCTION_SPEND_DATE');
assert.deepEqual(hardVatPayments.map(e=>e.date),vatSchedule.entries.map(e=>e.date),'construction VAT must follow actual spend dates');
const firstRefund=vat.events.find(e=>e.type===FINANCIAL_EVENT_TYPES.VAT_REFUND && e.metadata.timingConvention==='EXPLICIT_CONSTRUCTION_SPEND_DATE');
assert.equal(firstRefund.date,'2028-03-15','refund lag must be measured from actual VAT payment date');

const combined=generateTransactionGradeConstructionEvents(vatInput,vatC,{acquisitionDate,constructionSpendSchedule:vatSchedule,scope:'t11-transaction-construction'});
assert(Math.abs(combined.reconciliation.delta)<1e-6,'gross scheduled project + VAT outflow must reconcile to legacy TPC total');

console.table([
  {case:'T01 explicit spend',entries:schedule.entries.length,projectCostOutflow:project.reconciliation.generatedProjectOutflow,delta:project.reconciliation.delta},
  {case:'T11 VAT lag2',entries:vatSchedule.entries.length,vatInputs:vat.reconciliation.inputPayments,vatRefunds:vat.reconciliation.refunds,grossOutflow:combined.reconciliation.grossProjectOutflow},
]);
console.log('PASS verify-construction-spend-schedule: strict explicit schedule + scheduled hard-cost/contingency/VAT timing; no invented S-curve.');
