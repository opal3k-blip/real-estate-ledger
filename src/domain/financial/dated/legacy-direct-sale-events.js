/* =========================================================================
   Phase 3B-5C — Legacy direct-sale buyer-bank collection timing (shadow mode)
   -------------------------------------------------------------------------
   Mirrors core.js directSale semantics for ordinary (non off-plan/non-phased)
   exits: a net portion of terminal project/equity cash is deferred from the
   exit year and collected after collectionLagYears.

   The legacy core intentionally defers a share of NET terminal cash (after
   sale costs and debt payoff), not gross sale proceeds. The dated shadow model
   therefore represents the timing shift as a matched DEFERRAL/COLLECTION pair
   rather than pretending the deferred amount is gross sale consideration.
   ========================================================================= */
import {
  createFinancialEvent,
  FINANCIAL_EVENT_TYPES,
  aggregateEventEffects,
} from './financial-event.js';
import { requireAcquisitionDate, legacyYearEndDate } from './timeline.js';

const TOL=1e-7;
function n(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }
function near(a,b,tol=TOL){ return Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b)); }

export function generateLegacyDirectSaleTimingEvents(opportunity, computation, { acquisitionDate, scope='legacy-direct-sale' }={}){
  requireAcquisitionDate(acquisitionDate);
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  if(computation.isPhasedSaleMode) throw new Error('UNSUPPORTED_3B5C_PHASED_SALE_DIRECT_SALE');

  const totalYears=Math.max(0,Math.round(n(computation.totalYears)));
  const deferredYear=computation.directSaleDeferredYear==null ? null : Math.max(0,Math.round(n(computation.directSaleDeferredYear)));
  const deferredAmount=Math.max(0,n(computation.directSaleDeferredAmt));
  const bankPct=Math.max(0,Math.min(1,n(opportunity?.strategy?.directSale?.bankFinancedPct)));
  const lag=Math.max(0,Math.round(n(opportunity?.strategy?.directSale?.collectionLagYears)));
  const events=[];
  let seq=0;

  if(!computation.isDirectSaleSplit || deferredAmount<=TOL){
    return Object.freeze({
      events:Object.freeze(events),
      reconciliation:Object.freeze({
        isDirectSaleSplit:false,
        deferredAmount:0,
        terminalYear:totalYears,
        deferredYear:null,
        lagYears:lag,
        bankFinancedPct:bankPct,
        projectTimingNet:0,
        equityTimingNet:0,
        findings:Object.freeze([]),
      }),
    });
  }

  if(deferredYear==null) throw new Error('MISSING_DIRECT_SALE_DEFERRED_YEAR');
  if(deferredYear < totalYears) throw new Error('INVALID_DIRECT_SALE_DEFERRED_YEAR');
  if(deferredYear !== totalYears + lag) throw new Error('DIRECT_SALE_LAG_MISMATCH');

  const exitDate=legacyYearEndDate(acquisitionDate,totalYears);
  const collectionDate=legacyYearEndDate(acquisitionDate,deferredYear);

  events.push(createFinancialEvent({
    scope, sequence:seq++, date:exitDate,
    type:FINANCIAL_EVENT_TYPES.DIRECT_SALE_DEFERRAL,
    amount:deferredAmount,
    metadata:{
      key:'buyer-bank-deferral',
      legacyYear:totalYears,
      deferredYear,
      collectionLagYears:lag,
      bankFinancedPct:bankPct,
      timingConvention:'LEGACY_NET_EXIT_CASH_SHARE_DEFERRED',
    },
  }));
  events.push(createFinancialEvent({
    scope, sequence:seq++, date:collectionDate,
    type:FINANCIAL_EVENT_TYPES.DIRECT_SALE_COLLECTION,
    amount:deferredAmount,
    metadata:{
      key:'buyer-bank-collection',
      legacyYear:deferredYear,
      sourceExitYear:totalYears,
      collectionLagYears:lag,
      bankFinancedPct:bankPct,
      timingConvention:'LEGACY_NET_EXIT_CASH_SHARE_COLLECTED_AFTER_LAG',
    },
  }));

  const effects=aggregateEventEffects(events);
  const findings=[];
  if(!near(effects.projectCash,0) || !near(effects.equityCash,0)){
    findings.push(Object.freeze({code:'DIRECT_SALE_TIMING_SHIFT_NOT_NET_ZERO',projectCash:effects.projectCash,equityCash:effects.equityCash}));
  }

  return Object.freeze({
    events:Object.freeze(events),
    reconciliation:Object.freeze({
      isDirectSaleSplit:true,
      deferredAmount,
      terminalYear:totalYears,
      deferredYear,
      lagYears:lag,
      bankFinancedPct:bankPct,
      projectTimingNet:effects.projectCash,
      equityTimingNet:effects.equityCash,
      findings:Object.freeze(findings),
    }),
  });
}
