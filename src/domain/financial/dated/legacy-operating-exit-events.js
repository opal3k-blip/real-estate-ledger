/* =========================================================================
   Phase 3B-5D — Legacy operating + exit project cash events (shadow mode)
   -------------------------------------------------------------------------
   Converts the annual legacy project-cash components already exposed by
   `pnlRows` into deterministic dated events without changing economics.

   Important: this is cash-view parity, not a full accounting sub-ledger.
   `OPERATING_INCOME` / `OPERATING_EXPENSE` represent net annual NOI cash.
   Detailed P&L line items remain available in `pnlRows` and are not duplicated
   here because doing so would risk double-counting vacancy / OPEX / management
   fees across asset-class-specific legacy formulas.
   ========================================================================= */
import { createFinancialEvent, FINANCIAL_EVENT_TYPES } from './financial-event.js';
import { requireAcquisitionDate, legacyYearEndDate } from './timeline.js';

const TOL=1e-7;
function n(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }

export function generateLegacyOperatingExitEvents(computation,{acquisitionDate,scope='legacy-operating-exit'}={}){
  requireAcquisitionDate(acquisitionDate);
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  const rows=Array.isArray(computation.pnlRows)?computation.pnlRows:[];
  const events=[];
  let seq=0;

  for(const row of rows){
    const yr=Math.max(0,Math.round(n(row.yr)));
    if(!yr) continue;
    const date=legacyYearEndDate(acquisitionDate,yr);
    const noi=n(row.noi);
    if(noi>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.OPERATING_INCOME,amount:noi,
        metadata:{key:`operating-net-${yr}`,legacyYear:yr,cashBasis:'LEGACY_NET_NOI',phase:row.phase||null},
      }));
    } else if(noi<-TOL){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.OPERATING_EXPENSE,amount:Math.abs(noi),
        metadata:{key:`operating-net-${yr}`,legacyYear:yr,cashBasis:'LEGACY_NET_NOI',phase:row.phase||null},
      }));
    }

    // Phased-sale exit/tranche cash is owned by 3B-5A. Do not duplicate it.
    if(computation.isPhasedSaleMode) continue;

    const exitValue=Math.max(0,n(row.exitValue));
    const exitCosts=Math.max(0,n(row.exitCostsAmt));
    if(exitValue>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.EXIT_PROCEEDS,amount:exitValue,
        metadata:{
          key:`legacy-exit-${yr}`,legacyYear:yr,
          legacyDeemedExit:computation.holdStrategy==='perpetual_hold' || computation.holdStrategy==='refinance_close',
        },
      }));
    }
    if(exitCosts>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.FEE,amount:exitCosts,
        metadata:{key:`legacy-exit-cost-${yr}`,legacyYear:yr,feeComponent:'LEGACY_EXIT_COST'},
      }));
    }
  }

  return Object.freeze({events:Object.freeze(events)});
}
