/* =========================================================================
   Transaction-grade scheduled construction events — Phase 3B-6
   -------------------------------------------------------------------------
   Uses an explicit CONSTRUCTION_SPEND_V1 schedule. No default curve exists.
   Land and legacy fixed/transaction fees remain at acquisition; hard cost and
   contingency move only according to the supplied schedule.

   VAT timing is also driven by the same explicit spend dates:
     - VAT on scheduled hard cost is paid on each spend date;
     - VAT on legacy VAT-eligible upfront fees is paid at acquisition;
     - recoverable VAT is refunded after the explicit legacy lag, measured from
       the actual payment date (not from an invented annual spend bucket).

   This is an additive transaction-grade path. The legacy parity generators are
   untouched and continue to reproduce src/core.js exactly.
   ========================================================================= */
import { createFinancialEvent, FINANCIAL_EVENT_TYPES, aggregateEventEffects, sortFinancialEvents } from './financial-event.js';
import { requireAcquisitionDate, addYearsClamped } from './timeline.js';
import { extractProjectCostComponents } from './project-cost-components.js';
import { normalizeConstructionSpendSchedule } from './construction-spend-schedule.js';

const TOL=1e-7;
function n(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }
function positive(v){ return Math.max(0,n(v)); }
function near(a,b,tol=TOL){ return Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b)); }

function pushEvent(events,{scope,sequence,date,type,amount,key,metadata={}}){
  amount=positive(amount);
  if(amount<=TOL) return sequence;
  events.push(createFinancialEvent({scope,sequence,date,type,amount,metadata:{key,...metadata}}));
  return sequence+1;
}

export function generateScheduledProjectCostEvents(computation,{acquisitionDate,constructionSpendSchedule,scope='scheduled-project-cost'}={}){
  requireAcquisitionDate(acquisitionDate);
  const components=extractProjectCostComponents(computation);
  const schedule=normalizeConstructionSpendSchedule(constructionSpendSchedule,{
    acquisitionDate,
    constructionYears:n(computation?.constructionYears),
  });
  const events=[];
  let seq=0;

  seq=pushEvent(events,{scope,sequence:seq,date:acquisitionDate,type:FINANCIAL_EVENT_TYPES.LAND_ACQUISITION,amount:components.landCost,key:'land'});
  for(const [key,amount] of Object.entries(components.fees)){
    seq=pushEvent(events,{scope,sequence:seq,date:acquisitionDate,type:FINANCIAL_EVENT_TYPES.FEE,amount,key,metadata:{feeComponent:key,timingConvention:'LEGACY_UPFRONT_FEE'}});
  }

  for(const row of schedule.entries){
    seq=pushEvent(events,{scope,sequence:seq,date:row.date,type:FINANCIAL_EVENT_TYPES.CONSTRUCTION_COST,amount:components.hardCostBase*row.share,key:`hard-cost-${row.sequence}`,metadata:{scheduleVersion:schedule.version,scheduleBasis:schedule.basis,spendShare:row.share,scheduleSequence:row.sequence}});
    seq=pushEvent(events,{scope,sequence:seq,date:row.date,type:FINANCIAL_EVENT_TYPES.CONTINGENCY,amount:components.contingency*row.share,key:`contingency-${row.sequence}`,metadata:{scheduleVersion:schedule.version,scheduleBasis:schedule.basis,spendShare:row.share,scheduleSequence:row.sequence}});
  }

  const generatedProjectOutflow=-aggregateEventEffects(events).projectCash;
  if(!near(generatedProjectOutflow,components.expectedTPCExcludingVAT)){
    throw new Error(`SCHEDULED_PROJECT_COST_RECONCILIATION_FAILED:${generatedProjectOutflow}:${components.expectedTPCExcludingVAT}`);
  }

  return Object.freeze({
    schedule,
    events:Object.freeze(sortFinancialEvents(events)),
    reconciliation:Object.freeze({
      generatedProjectOutflow,
      expectedTPCExcludingVAT:components.expectedTPCExcludingVAT,
      delta:generatedProjectOutflow-components.expectedTPCExcludingVAT,
      scheduledHardCost:components.hardCost,
      scheduleShareTotal:schedule.shareTotal,
    }),
  });
}

export function generateScheduledConstructionVatEvents(opportunity,computation,{acquisitionDate,constructionSpendSchedule,scope='scheduled-construction-vat'}={}){
  requireAcquisitionDate(acquisitionDate);
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  const schedule=normalizeConstructionSpendSchedule(constructionSpendSchedule,{
    acquisitionDate,
    constructionYears:n(computation.constructionYears),
  });
  const events=[];
  let seq=0;

  const vatInputTotal=positive(computation.vatInputTotal);
  if(vatInputTotal<=TOL){
    return Object.freeze({schedule,events:Object.freeze([]),reconciliation:Object.freeze({vatInputTotal:0,inputPayments:0,recoverableTarget:0,refunds:0,delta:0})});
  }

  const vatEnabled=!!opportunity?.vat?.enabled;
  const vatRate=vatEnabled ? n(opportunity?.vat?.ratePct ?? 0.15) : 0;
  const vatInputRate=vatEnabled ? n(opportunity?.vat?.constructionInputVatPct ?? vatRate) : 0;
  const recoveryPct=Math.max(0,Math.min(1,n(computation.vatRecoveryPct)));
  const refundLagYears=Math.max(0,Math.round(n(computation.vatWorkingCapitalRefundLagYears ?? opportunity?.vat?.refundLagYears)));
  const hardCost=positive(computation.hardCost);
  const feeVatBase=positive(opportunity?.fees?.dueDiligence)+positive(opportunity?.fees?.valuation)+positive(computation.structuringFee);

  const addVatPair=(date,base,key,metadata={})=>{
    const amount=positive(base)*vatInputRate;
    if(amount<=TOL) return;
    seq=pushEvent(events,{scope,sequence:seq,date,type:FINANCIAL_EVENT_TYPES.VAT_INPUT_PAYMENT,amount,key:`${key}-input`,metadata:{...metadata,vatInputRate,recoveryPct,refundLagYears}});
    const refund=amount*recoveryPct;
    if(refund>TOL){
      seq=pushEvent(events,{scope,sequence:seq,date:addYearsClamped(date,refundLagYears),type:FINANCIAL_EVENT_TYPES.VAT_REFUND,amount:refund,key:`${key}-refund`,metadata:{...metadata,sourcePaymentDate:date,vatInputRate,recoveryPct,refundLagYears}});
    }
  };

  addVatPair(acquisitionDate,feeVatBase,'upfront-fee-vat',{timingConvention:'EXPLICIT_FEE_VAT_AT_ACQUISITION'});
  for(const row of schedule.entries){
    addVatPair(row.date,hardCost*row.share,`construction-vat-${row.sequence}`,{scheduleVersion:schedule.version,scheduleBasis:schedule.basis,spendShare:row.share,scheduleSequence:row.sequence,timingConvention:'EXPLICIT_CONSTRUCTION_SPEND_DATE'});
  }

  const inputPayments=events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.VAT_INPUT_PAYMENT).reduce((a,e)=>a+e.amount,0);
  const refunds=events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.VAT_REFUND).reduce((a,e)=>a+e.amount,0);
  const recoverableTarget=vatInputTotal*recoveryPct;
  if(!near(inputPayments,vatInputTotal)) throw new Error(`SCHEDULED_VAT_INPUT_RECONCILIATION_FAILED:${inputPayments}:${vatInputTotal}`);
  if(!near(refunds,recoverableTarget)) throw new Error(`SCHEDULED_VAT_REFUND_RECONCILIATION_FAILED:${refunds}:${recoverableTarget}`);

  return Object.freeze({
    schedule,
    events:Object.freeze(sortFinancialEvents(events)),
    reconciliation:Object.freeze({vatInputTotal,inputPayments,recoverableTarget,refunds,delta:inputPayments-vatInputTotal}),
  });
}

export function generateTransactionGradeConstructionEvents(opportunity,computation,options={}){
  const project=generateScheduledProjectCostEvents(computation,{...options,scope:`${options.scope||'transaction-construction'}-cost`});
  const vat=generateScheduledConstructionVatEvents(opportunity,computation,{...options,scope:`${options.scope||'transaction-construction'}-vat`});
  const events=Object.freeze(sortFinancialEvents([...project.events,...vat.events]));
  const grossProjectOutflow=-events.reduce((sum,event)=>sum+Math.min(0,aggregateEventEffects([event]).projectCash),0);
  const expectedGrossOutflow=positive(computation.TPC);
  if(!near(grossProjectOutflow,expectedGrossOutflow)) throw new Error(`TRANSACTION_GRADE_CONSTRUCTION_GROSS_OUTFLOW_RECONCILIATION_FAILED:${grossProjectOutflow}:${expectedGrossOutflow}`);
  return Object.freeze({project,vat,events,reconciliation:Object.freeze({grossProjectOutflow,expectedGrossOutflow,delta:grossProjectOutflow-expectedGrossOutflow})});
}
