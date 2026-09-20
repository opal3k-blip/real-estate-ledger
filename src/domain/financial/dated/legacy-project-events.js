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
import { extractProjectCostComponents } from './project-cost-components.js';

function positive(v){ return Math.max(0,Number.isFinite(Number(v)) ? Number(v) : 0); }

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

  const components=extractProjectCostComponents(computation);
  push(FINANCIAL_EVENT_TYPES.LAND_ACQUISITION, components.landCost, 'land');
  push(FINANCIAL_EVENT_TYPES.CONSTRUCTION_COST, components.hardCostBase, 'hard-cost-base');
  push(FINANCIAL_EVENT_TYPES.CONTINGENCY, components.contingency, 'contingency');

  for(const [key,amount] of Object.entries(components.fees)) push(FINANCIAL_EVENT_TYPES.FEE,amount,key,{feeComponent:key});

  const generatedOutflow=-aggregateEventEffects(events).projectCash;
  const expectedWithoutVat=components.expectedTPCExcludingVAT;

  return Object.freeze({
    events:Object.freeze(events),
    reconciliation:Object.freeze({
      generatedProjectOutflow:generatedOutflow,
      expectedLegacyTPCExcludingVAT:expectedWithoutVat,
      delta:generatedOutflow-expectedWithoutVat,
      excludedVAT:components.vatExcluded,
      timingFinding:'LEGACY_ALL_TPC_AT_T0_NO_CANONICAL_SPEND_CURVE',
    }),
  });
}
