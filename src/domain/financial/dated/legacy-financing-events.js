/* =========================================================================
   Phase 3B-4B — Legacy financing funding/principal events (shadow mode)
   -------------------------------------------------------------------------
   - one blended facility; senior/mezz remain sizing metadata only
   - principalDrawLimit applies to principal draws only
   - equity contributions follow every negative legacy equityCF entry
   - no interest is created here (Phase 3B-4C owns interest)
   - no refinance / VAT / distributions / true multi-facility modelling here
   ========================================================================= */
import { createFinancialEvent, FINANCIAL_EVENT_TYPES, replayDebtBalance } from './financial-event.js';
import { requireAcquisitionDate, legacyYearEndDate, legacyYearMidpointDate } from './timeline.js';

const TOL=1e-7;
function n(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }
function near(a,b,tol=TOL){ return Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b)); }

export function buildLegacyBlendedFacility(opportunity,computation){
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  const originalRepaymentMode=computation.amortType||opportunity?.financing?.amortType||'interest_only';
  const canonicalLegacyBehavior=(originalRepaymentMode==='amortizing'||originalRepaymentMode==='partial_amort_balloon')
    ? 'LEGACY_PERIODIC_AMORTIZATION' : 'LEGACY_INTEREST_ONLY';
  return Object.freeze({
    id:'LEGACY_BLENDED_DEBT',
    principalDrawLimit:n(computation.debt),
    limitScope:'PRINCIPAL_DRAWS_ONLY',
    interestRate:n(computation.interestRate),
    originalStructure:opportunity?.financing?.structure||'single',
    originalRepaymentMode,
    canonicalLegacyBehavior,
    legacySizing:Object.freeze({seniorDebt:n(computation.seniorDebt),mezzDebt:n(computation.mezzDebt)}),
  });
}

export function generateLegacyEquityContributionEvents(computation,{acquisitionDate,scope='legacy-equity'}={}){
  requireAcquisitionDate(acquisitionDate);
  const cf=Array.isArray(computation?.equityCF)?computation.equityCF:[];
  const events=[];
  let seq=0;
  cf.forEach((value,index)=>{
    const amount=n(value);
    if(amount>=0) return;
    const date=index===0?acquisitionDate:legacyYearEndDate(acquisitionDate,index);
    events.push(createFinancialEvent({
      scope,sequence:seq++,date,
      type:FINANCIAL_EVENT_TYPES.EQUITY_CONTRIBUTION,
      amount:Math.abs(amount),
      metadata:{key:`equity-cf-${index}`,legacyEquityCFIndex:index,contributionKind:index===0?'INITIAL':'FOLLOW_ON'},
    }));
  });
  const total=events.reduce((a,e)=>a+e.amount,0);
  return Object.freeze({events:Object.freeze(events),totalContributedEquity:total,legacyContributedEquity:n(computation?.contributedEquity),delta:total-n(computation?.contributedEquity)});
}

export function generateLegacyPrincipalEvents(opportunity,computation,{acquisitionDate,scope='legacy-debt'}={}){
  requireAcquisitionDate(acquisitionDate);
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  if(computation.isPhasedSaleMode) throw new Error('UNSUPPORTED_3B4B_PHASED_SALE');
  if(computation.holdStrategy==='perpetual_hold' || String(opportunity?.strategy?.exitStrategy||'').includes('Refinance')){
    throw new Error('UNSUPPORTED_3B4B_REFINANCE');
  }

  const facility=buildLegacyBlendedFacility(opportunity,computation);
  const debt=Math.max(0,n(computation.debt));
  const events=[];
  let seq=0;
  const drawSchedule=Array.isArray(computation.drawSchedule)?computation.drawSchedule:null;

  if(debt>0){
    if(drawSchedule && drawSchedule.length){
      drawSchedule.forEach((share,i)=>{
        const amount=debt*Math.max(0,n(share));
        if(amount<=0) return;
        events.push(createFinancialEvent({
          scope,sequence:seq++,date:legacyYearMidpointDate(acquisitionDate,i+1),
          type:FINANCIAL_EVENT_TYPES.DEBT_DRAW,amount,
          metadata:{key:`principal-draw-${i+1}`,facilityId:facility.id,legacyYear:i+1,drawShare:n(share),timingConvention:'LEGACY_AVERAGE_BALANCE_EQUIVALENT_MIDYEAR_DRAW'},
        }));
      });
    } else {
      events.push(createFinancialEvent({
        scope,sequence:seq++,date:acquisitionDate,type:FINANCIAL_EVENT_TYPES.DEBT_DRAW,amount:debt,
        metadata:{key:'principal-draw-t0',facilityId:facility.id,legacyYear:0,timingConvention:'LEGACY_FULL_BALANCE_AT_T0'},
      }));
    }
  }

  let principalOutstanding=debt;
  const rows=Array.isArray(computation.pnlRows)?computation.pnlRows:[];
  for(const row of rows){
    const yr=Math.max(0,Math.round(n(row.yr)));
    if(!yr) continue;
    const date=legacyYearEndDate(acquisitionDate,yr);
    const scheduled=Math.min(principalOutstanding,Math.max(0,n(row.principalPayment)));
    if(scheduled>0){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.DEBT_REPAYMENT,amount:scheduled,
        metadata:{key:`scheduled-principal-${yr}`,facilityId:facility.id,legacyYear:yr,repaymentComponent:'PRINCIPAL',repaymentKind:'SCHEDULED'},
      }));
      principalOutstanding-=scheduled;
    }
    if(yr===Math.round(n(computation.totalYears)) && principalOutstanding>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.DEBT_REPAYMENT,amount:principalOutstanding,
        metadata:{key:`exit-principal-${yr}`,facilityId:facility.id,legacyYear:yr,repaymentComponent:'PRINCIPAL',repaymentKind:'EXIT_BALLOON'},
      }));
      principalOutstanding=0;
    }
  }

  const draws=events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.DEBT_DRAW).reduce((a,e)=>a+e.amount,0);
  const repayments=events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.DEBT_REPAYMENT).reduce((a,e)=>a+e.amount,0);
  const principalClosing=draws-repayments;
  if(!near(draws,debt)) throw new Error(`PRINCIPAL_DRAWS_DO_NOT_MATCH_LIMIT:${draws}:${debt}`);
  if(principalClosing < -TOL) throw new Error(`PRINCIPAL_REPAYMENT_EXCEEDS_DRAWS:${principalClosing}`);

  return Object.freeze({
    facility,
    events:Object.freeze(events),
    reconciliation:Object.freeze({principalDraws:draws,principalRepayments:repayments,principalClosing}),
  });
}

export function generateLegacyFundingPrincipalEvents(opportunity,computation,options={}){
  const equity=generateLegacyEquityContributionEvents(computation,options);
  const principal=generateLegacyPrincipalEvents(opportunity,computation,options);
  return Object.freeze({facility:principal.facility,equity,principal,events:Object.freeze([...equity.events,...principal.events])});
}
