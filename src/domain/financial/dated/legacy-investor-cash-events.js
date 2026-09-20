/* =========================================================================
   Phase 3B-5D — Legacy investor cash events (shadow mode)
   -------------------------------------------------------------------------
   Converts the authoritative legacy equity cash series into dated investor
   calls/distributions. Negative entries are capital calls; positive entries
   are distributions.

   For perpetual-hold, the cash-only series is authoritative for cash events.
   The separate mark-to-market residual in `equityCF` is not fabricated into a
   cash distribution; 3B-5B already surfaces that legacy terminal inconsistency.
   ========================================================================= */
import { createFinancialEvent, FINANCIAL_EVENT_TYPES } from './financial-event.js';
import { requireAcquisitionDate, legacyYearEndDate } from './timeline.js';

const TOL=1e-7;
function n(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }

export function legacyInvestorCashSeries(computation){
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  if(computation.holdStrategy==='perpetual_hold' && Array.isArray(computation.equityCFCashOnly)){
    return Object.freeze({
      series:Object.freeze([...computation.equityCFCashOnly].map(n)),
      basis:'LEGACY_EQUITY_CF_CASH_ONLY',
      excludesUnrealizedResidual:true,
    });
  }
  return Object.freeze({
    series:Object.freeze((Array.isArray(computation.equityCF)?computation.equityCF:[]).map(n)),
    basis:'LEGACY_EQUITY_CF',
    excludesUnrealizedResidual:false,
  });
}

export function generateLegacyInvestorCashEvents(computation,{acquisitionDate,scope='legacy-investor-cash'}={}){
  requireAcquisitionDate(acquisitionDate);
  const {series,basis,excludesUnrealizedResidual}=legacyInvestorCashSeries(computation);
  const events=[];
  let seq=0;
  series.forEach((value,index)=>{
    if(Math.abs(value)<=TOL) return;
    const date=index===0?acquisitionDate:legacyYearEndDate(acquisitionDate,index);
    const contribution=value<0;
    events.push(createFinancialEvent({
      scope,sequence:seq++,date,
      type:contribution?FINANCIAL_EVENT_TYPES.EQUITY_CONTRIBUTION:FINANCIAL_EVENT_TYPES.DISTRIBUTION,
      amount:Math.abs(value),
      metadata:{
        key:`investor-cash-${index}`,
        legacyEquityCFIndex:index,
        investorCashBasis:basis,
        cashKind:contribution?(index===0?'INITIAL_CONTRIBUTION':'FOLLOW_ON_CONTRIBUTION'):'DISTRIBUTION',
      },
    }));
  });
  return Object.freeze({events:Object.freeze(events),series,basis,excludesUnrealizedResidual});
}
