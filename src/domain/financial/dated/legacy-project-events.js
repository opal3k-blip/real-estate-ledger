/* =========================================================================
   Legacy project-side event generator — Phase 3B-3 recovery rebuild.
   -------------------------------------------------------------------------
   core.js books the entire TPC at t0. There is no canonical construction spend
   curve in the legacy engine. Therefore this adapter decomposes that t0 amount
   semantically but DOES NOT invent monthly/S-curve dates.

   VAT is intentionally excluded here. It belongs to a dedicated VAT timing
   layer; callers receive the excluded amount explicitly.
   ========================================================================= */
import { createFinancialEvent, FINANCIAL_EVENT_TYPES, aggregateEventEffects } from './financial-event.js';
import { requireAcquisitionDate } from './timeline.js';

function n(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }
function positive(v){ return Math.max(0,n(v)); }

export function generateLegacyProjectCostEvents(computation,{acquisitionDate,scope='legacy-project'}={}){
  requireAcquisitionDate(acquisitionDate);
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  const events=[];
  let seq=0;
  const push=(type,amount,key,metadata={})=>{
    amount=positive(amount);
    if(amount===0) return;
    events.push(createFinancialEvent({scope,sequence:seq++,date:acquisitionDate,type,amount,metadata:{key,...metadata}}));
  };

  const contingency = positive(computation.costBreakdownAmounts?.contingency);
  const hardCostBase = positive(computation.hardCostBase);
  push(FINANCIAL_EVENT_TYPES.LAND_ACQUISITION, computation.landCost, 'land');
  push(FINANCIAL_EVENT_TYPES.CONSTRUCTION_COST, hardCostBase, 'hard-cost-base');
  push(FINANCIAL_EVENT_TYPES.CONTINGENCY, contingency, 'contingency');

  const feeComponents={
    oneTimeFixed:positive(computation.oneTimeFixed),
    structuringFee:positive(computation.structuringFee),
    acquisitionFee:positive(computation.acquisitionFee),
    arrangementFee:positive(computation.arrangementFee),
  };
  for(const [key,amount] of Object.entries(feeComponents)) push(FINANCIAL_EVENT_TYPES.FEE,amount,key,{feeComponent:key});

  const vatExcluded=positive(computation.vatInputTotal);
  const generatedOutflow=-aggregateEventEffects(events).projectCash;
  const expectedWithoutVat=positive(computation.TPC)-vatExcluded;

  return Object.freeze({
    events:Object.freeze(events),
    reconciliation:Object.freeze({
      generatedProjectOutflow:generatedOutflow,
      expectedLegacyTPCExcludingVAT:expectedWithoutVat,
      delta:generatedOutflow-expectedWithoutVat,
      excludedVAT:vatExcluded,
      timingFinding:'LEGACY_ALL_TPC_AT_T0_NO_CANONICAL_SPEND_CURVE',
    }),
  });
}
