/* =========================================================================
   Phase 3B-4C — Legacy-compatible actual-balance interest shadow engine
   -------------------------------------------------------------------------
   Recomputes interest from financing inputs/balances; it does NOT copy
   pnlRows.interestExpense as the source of truth. It deliberately mirrors the
   current core.js annual mechanics so differences become explicit.

   Important known legacy defect surfaced here:
   for capitalized construction interest in the final project year, core.js
   computes the interest expense but its normal exit payoff excludes that same
   year's newly capitalized interest, then sets remainingDebt to zero. The
   shadow ledger DOES NOT silently erase it; it reports a residual with code
   LEGACY_FINAL_PERIOD_CAP_INTEREST_NOT_PAID.
   ========================================================================= */
import { createFinancialEvent, FINANCIAL_EVENT_TYPES, replayDebtBalance } from './financial-event.js';
import { requireAcquisitionDate, legacyYearEndDate } from './timeline.js';
import { generateLegacyPrincipalEvents, buildLegacyBlendedFacility } from './legacy-financing-events.js';

const TOL=1e-7;
function n(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }
function near(a,b,tol=TOL){ return Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b)); }

function legacyInterestRows(opportunity,computation){
  const debt=Math.max(0,n(computation.debt));
  const rate=n(computation.interestRate);
  const totalYears=Math.max(0,Math.round(n(computation.totalYears)));
  const constructionYears=Math.max(0,Math.round(n(computation.constructionYears)));
  const type=opportunity?.meta?.oppType||'';
  const drawSchedule=Array.isArray(computation.drawSchedule)?computation.drawSchedule:null;
  const amortType=computation.amortType||opportunity?.financing?.amortType||'interest_only';
  const graceYears=Math.max(0,Math.round(n(opportunity?.financing?.graceYears)));
  const amortYears=Math.max(1,n(opportunity?.financing?.amortYears)||10);
  const capitalizationMode=opportunity?.financing?.interestDuringConstruction||'cash';

  let remainingDebt=debt;
  const rows=[];
  for(let yr=1;yr<=totalYears;yr++){
    const inConstruction=yr<=constructionYears && type!=='landbank';
    const drawEnd=(drawSchedule&&inConstruction)
      ? Math.min(debt,debt*drawSchedule.slice(0,yr).reduce((a,b)=>a+n(b),0))
      : remainingDebt;
    const drawStart=(drawSchedule&&inConstruction)
      ? (yr===1?0:Math.min(debt,debt*drawSchedule.slice(0,yr-1).reduce((a,b)=>a+n(b),0)))
      : remainingDebt;
    const interestBase=(drawSchedule&&inConstruction)?(drawStart+drawEnd)/2:remainingDebt;
    const interest=interestBase*rate;
    let principalPay=0;
    if((amortType==='amortizing'||amortType==='partial_amort_balloon') && type!=='landbank' && !inConstruction && yr>constructionYears+graceYears && remainingDebt>0){
      principalPay=Math.min(remainingDebt,debt/amortYears);
    }
    const capitalized=inConstruction && type!=='landbank' && capitalizationMode==='capitalized';
    const capInterest=capitalized?interest:0;
    const cashInterest=capitalized?0:interest;
    const isLast=yr===totalYears;
    rows.push({yr,inConstruction,openingLegacyBalance:remainingDebt,drawStart,drawEnd,interestBase,interest,cashInterest,capitalizedInterest:capInterest,principalPay,isLast});
    remainingDebt=isLast?0:Math.max(0,remainingDebt-principalPay+capInterest);
  }
  return rows;
}

export function generateLegacyInterestEvents(opportunity,computation,{acquisitionDate,scope='legacy-interest'}={}){
  requireAcquisitionDate(acquisitionDate);
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  if(computation.isPhasedSaleMode) throw new Error('UNSUPPORTED_3B4C_PHASED_SALE');
  if(computation.holdStrategy==='perpetual_hold' || String(opportunity?.strategy?.exitStrategy||'').includes('Refinance')){
    throw new Error('UNSUPPORTED_3B4C_REFINANCE');
  }

  const facility=buildLegacyBlendedFacility(opportunity,computation);
  const principal=generateLegacyPrincipalEvents(opportunity,computation,{acquisitionDate,scope:`${scope}-principal`});
  const rows=legacyInterestRows(opportunity,computation);
  const events=[...principal.events];
  let seq=10000;
  for(const row of rows){
    const date=legacyYearEndDate(acquisitionDate,row.yr);
    if(row.cashInterest>0){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.INTEREST_PAYMENT,amount:row.cashInterest,
        metadata:{key:`cash-interest-${row.yr}`,facilityId:facility.id,legacyYear:row.yr,interestBasis:row.interestBase,interestRate:facility.interestRate},
      }));
    }
    if(row.capitalizedInterest>0){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.INTEREST_CAPITALIZED,amount:row.capitalizedInterest,
        metadata:{key:`capitalized-interest-${row.yr}`,facilityId:facility.id,legacyYear:row.yr,interestBasis:row.interestBase,interestRate:facility.interestRate},
      }));
    }
  }

  /* core.js exit debtPayoff includes prior capitalized interest but excludes the
     final-period capitalization in the normal non-phased exit path. Add exactly
     the capitalized-interest repayment that is observable in legacy payoff,
     while leaving any final-period unpaid amount visible in closing balance. */
  const finalRow=(Array.isArray(computation.pnlRows)?computation.pnlRows:[]).find(r=>Math.round(n(r.yr))===Math.round(n(computation.totalYears)));
  const finalDebtPayoff=Math.max(0,n(finalRow?.debtPayoffAtExit));
  const principalExitEvent=principal.events.find(e=>e.type===FINANCIAL_EVENT_TYPES.DEBT_REPAYMENT && e.metadata.repaymentKind==='EXIT_BALLOON');
  const principalExitAmount=principalExitEvent?.amount||0;
  const paidCapitalizedInterestAtExit=Math.max(0,finalDebtPayoff-principalExitAmount);
  if(paidCapitalizedInterestAtExit>TOL){
    events.push(createFinancialEvent({
      scope,sequence:seq++,date:legacyYearEndDate(acquisitionDate,Math.round(n(computation.totalYears))),
      type:FINANCIAL_EVENT_TYPES.DEBT_REPAYMENT,amount:paidCapitalizedInterestAtExit,
      metadata:{key:'exit-capitalized-interest-repayment',facilityId:facility.id,legacyYear:Math.round(n(computation.totalYears)),repaymentComponent:'CAPITALIZED_INTEREST',repaymentKind:'EXIT_BALLOON'},
    }));
  }

  const legacyPnlRows=Array.isArray(computation.pnlRows)?computation.pnlRows:[];
  const interestChecks=rows.map(row=>{
    const legacy=legacyPnlRows.find(r=>Math.round(n(r.yr))===row.yr);
    const legacyInterest=n(legacy?.interestExpense);
    return {yr:row.yr,computedInterest:row.interest,legacyInterest,delta:row.interest-legacyInterest,ok:near(row.interest,legacyInterest)};
  });
  const ledger=replayDebtBalance(events);
  const residual=ledger.closingBalance;
  const finalCap=rows.at(-1)?.capitalizedInterest||0;
  const findings=[];
  if(residual>TOL){
    findings.push(Object.freeze({
      code:'LEGACY_FINAL_PERIOD_CAP_INTEREST_NOT_PAID',
      amount:residual,
      finalPeriodCapitalizedInterest:finalCap,
      message:'Canonical event ledger retains debt that legacy core implicitly zeroes at final exit.',
    }));
  }

  return Object.freeze({
    facility,
    rows:Object.freeze(rows.map(Object.freeze)),
    events:Object.freeze(events),
    reconciliation:Object.freeze({
      interestChecks:Object.freeze(interestChecks.map(Object.freeze)),
      allInterestMatchesLegacy:interestChecks.every(x=>x.ok),
      paidCapitalizedInterestAtExit,
      canonicalClosingDebtBalance:residual,
      findings:Object.freeze(findings),
    }),
  });
}
