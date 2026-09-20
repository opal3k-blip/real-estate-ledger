/* =========================================================================
   Phase 3B-5B — Legacy refinance timing events (shadow mode)
   -------------------------------------------------------------------------
   Reconstructs the refinance mechanics that remained BASELINE_ONLY after
   3B-5A:
     - refinance-close at the terminal year;
     - periodic refinance during perpetual-hold analysis.

   The module mirrors legacy timing/calculation inputs but keeps a canonical
   debt ledger that does NOT silently erase replacement debt at an analysis
   boundary. Where legacy core.js terminal handling conflicts with the stated
   hold strategy, the difference is surfaced as an explicit finding.
   ========================================================================= */
import {
  createFinancialEvent,
  FINANCIAL_EVENT_TYPES,
  replayDebtBalance,
} from './financial-event.js';
import {
  requireAcquisitionDate,
  legacyYearEndDate,
  legacyYearMidpointDate,
} from './timeline.js';
import { buildLegacyBlendedFacility } from './legacy-financing-events.js';

const TOL=1e-7;
function n(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }
function near(a,b,tol=TOL){ return Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b)); }

function scenarioFor(opportunity,computation){
  const key=computation?.scenarioKey||'base';
  if(key==='base') return null;
  return opportunity?.scenarios?.[key]||null;
}

function effectiveMarketCap(opportunity,computation){
  const scn=scenarioFor(opportunity,computation);
  return Math.max(0.02,n(opportunity?.wacc?.marketCap||0.075)+n(scn?.capRateDelta));
}

function refiParams(opportunity){
  const r=opportunity?.income?.refinance||{};
  // Mirror core.js `||` semantics exactly: explicit zero falls back to defaults.
  return Object.freeze({
    intervalYears:n(r.intervalYears),
    refiLtv:n(r.refiLtv)||0.65,
    refiCostPct:n(r.refiCostPct)||0.01,
  });
}

function refiPropertyValue(opportunity,computation,legacyYear){
  const growth=n(opportunity?.wacc?.growth);
  const noi=n(computation?.stabilizedNOIyr1);
  return noi*Math.pow(1+growth,legacyYear)/effectiveMarketCap(opportunity,computation);
}

function saleNetAtRefiClose(opportunity,computation){
  const salePct=Math.max(0,Math.min(1,n(computation?.salePct)));
  if(salePct<=TOL) return 0;
  const scn=scenarioFor(opportunity,computation);
  const salePriceEff=n(opportunity?.development?.salePrice)*(scn? n(scn.salePriceMult)||1 : 1);
  const type=opportunity?.meta?.oppType;
  let saleValue=0;
  if(type==='development'){
    const sellableArea=computation?.scopeType==='infra_only'
      ? n(opportunity?.land?.area)
      : n(computation?.gfa)*n(opportunity?.development?.efficiency);
    saleValue=sellableArea*salePriceEff*salePct;
  } else if(type==='income' && computation?.applySalePctToIncome){
    saleValue=n(computation?.gla)*salePriceEff*salePct;
  }
  const exitCostPct=n(opportunity?.exitCosts?.broker)+n(opportunity?.exitCosts?.legal)+n(opportunity?.exitCosts?.rett)
    +n(opportunity?.exitCosts?.exitFee)+n(opportunity?.fees?.disposition);
  return saleValue*(1-exitCostPct);
}

function addInitialPrincipalDraws(events,opportunity,computation,{acquisitionDate,scope,seqRef}){
  const debt=Math.max(0,n(computation?.debt));
  const drawSchedule=Array.isArray(computation?.drawSchedule)?computation.drawSchedule:null;
  if(debt<=TOL) return;
  if(drawSchedule&&drawSchedule.length){
    drawSchedule.forEach((share,i)=>{
      const amount=debt*Math.max(0,n(share));
      if(amount<=TOL) return;
      events.push(createFinancialEvent({
        scope,sequence:seqRef.value++,date:legacyYearMidpointDate(acquisitionDate,i+1),
        type:FINANCIAL_EVENT_TYPES.DEBT_DRAW,amount,
        metadata:{key:`principal-draw-${i+1}`,facilityId:'LEGACY_BLENDED_DEBT',legacyYear:i+1,drawShare:n(share),timingConvention:'LEGACY_AVERAGE_BALANCE_EQUIVALENT_MIDYEAR_DRAW'},
      }));
    });
  } else {
    events.push(createFinancialEvent({
      scope,sequence:seqRef.value++,date:acquisitionDate,type:FINANCIAL_EVENT_TYPES.DEBT_DRAW,amount:debt,
      metadata:{key:'principal-draw-t0',facilityId:'LEGACY_BLENDED_DEBT',legacyYear:0,timingConvention:'LEGACY_FULL_BALANCE_AT_T0'},
    }));
  }
}

/**
 * Build dated refinance events while retaining an economically coherent debt
 * ledger. `legacyBalance` separately mirrors core.js for interest parity, so a
 * future legacy shortfall oddity can be surfaced without corrupting the
 * canonical event ledger.
 */
export function generateLegacyRefinanceEvents(opportunity,computation,{acquisitionDate,scope='legacy-refinance'}={}){
  requireAcquisitionDate(acquisitionDate);
  if(!computation||typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  const hold=computation.holdStrategy;
  if(hold!=='refinance_close'&&hold!=='perpetual_hold') throw new Error('NOT_LEGACY_REFINANCE_MODE');
  if(computation.isPhasedSaleMode) throw new Error('UNSUPPORTED_3B5B_PHASED_SALE_REFINANCE');

  const totalYears=Math.max(0,Math.round(n(computation.totalYears)));
  const constructionYears=Math.max(0,Math.round(n(computation.constructionYears)));
  const type=opportunity?.meta?.oppType||'';
  const facility=buildLegacyBlendedFacility(opportunity,computation);
  const debt=Math.max(0,n(computation.debt));
  const rate=n(computation.interestRate);
  const drawSchedule=Array.isArray(computation.drawSchedule)?computation.drawSchedule:null;
  const amortType=computation.amortType||opportunity?.financing?.amortType||'interest_only';
  const graceYears=Math.max(0,Math.round(n(opportunity?.financing?.graceYears)));
  const amortYears=Math.max(1,n(opportunity?.financing?.amortYears)||10);
  const capMode=opportunity?.financing?.interestDuringConstruction||'cash';
  const refi=refiParams(opportunity);
  const events=[];
  const seqRef={value:0};
  const rows=[];
  const interestChecks=[];
  const findings=[];

  addInitialPrincipalDraws(events,opportunity,computation,{acquisitionDate,scope,seqRef});

  // core.js starts with full target debt as its legacy balance even when a draw
  // schedule exists; drawSchedule changes construction interest basis only.
  let legacyBalance=debt;
  let canonicalBalance=debt;
  const pnlRows=Array.isArray(computation.pnlRows)?computation.pnlRows:[];

  for(let yr=1;yr<=totalYears;yr++){
    const date=legacyYearEndDate(acquisitionDate,yr);
    const inConstruction=yr<=constructionYears&&type!=='landbank';
    const drawEnd=(drawSchedule&&inConstruction)
      ? Math.min(debt,debt*drawSchedule.slice(0,yr).reduce((a,b)=>a+n(b),0))
      : legacyBalance;
    const drawStart=(drawSchedule&&inConstruction)
      ? (yr===1?0:Math.min(debt,debt*drawSchedule.slice(0,yr-1).reduce((a,b)=>a+n(b),0)))
      : legacyBalance;
    const interestBase=(drawSchedule&&inConstruction)?(drawStart+drawEnd)/2:legacyBalance;
    const interest=interestBase*rate;
    let principalPay=0;
    if((amortType==='amortizing'||amortType==='partial_amort_balloon')&&type!=='landbank'&&!inConstruction&&yr>constructionYears+graceYears&&legacyBalance>0){
      principalPay=Math.min(legacyBalance,debt/amortYears);
    }
    const capitalized=inConstruction&&type!=='landbank'&&capMode==='capitalized';
    const cashInterest=capitalized?0:interest;
    const capInterest=capitalized?interest:0;
    const legacyRow=pnlRows.find(r=>Math.round(n(r.yr))===yr);
    const legacyInterest=n(legacyRow?.interestExpense);
    interestChecks.push(Object.freeze({yr,computedInterest:interest,legacyInterest,delta:interest-legacyInterest,ok:near(interest,legacyInterest)}));

    if(cashInterest>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seqRef.value++,date,type:FINANCIAL_EVENT_TYPES.INTEREST_PAYMENT,amount:cashInterest,
        metadata:{key:`cash-interest-${yr}`,facilityId:facility.id,legacyYear:yr,interestBasis:interestBase,interestRate:rate},
      }));
    }
    if(capInterest>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seqRef.value++,date,type:FINANCIAL_EVENT_TYPES.INTEREST_CAPITALIZED,amount:capInterest,
        metadata:{key:`capitalized-interest-${yr}`,facilityId:facility.id,legacyYear:yr,interestBasis:interestBase,interestRate:rate},
      }));
      canonicalBalance+=capInterest;
    }

    const scheduledPrincipal=Math.min(canonicalBalance,Math.max(0,principalPay));
    if(scheduledPrincipal>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seqRef.value++,date,type:FINANCIAL_EVENT_TYPES.DEBT_REPAYMENT,amount:scheduledPrincipal,
        metadata:{key:`scheduled-principal-${yr}`,facilityId:facility.id,legacyYear:yr,repaymentKind:'SCHEDULED'},
      }));
      canonicalBalance-=scheduledPrincipal;
    }

    const isLast=yr===totalYears;
    const yearsIntoOperation=yr-constructionYears;
    const periodicRefi=hold==='perpetual_hold'&&!inConstruction&&!isLast&&yearsIntoOperation>0&&refi.intervalYears>0&&yearsIntoOperation%refi.intervalYears===0;
    const terminalRefi=hold==='refinance_close'&&isLast;
    let refiRow=null;

    if(periodicRefi||terminalRefi){
      const propertyValue=refiPropertyValue(opportunity,computation,yr);
      const newLoan=propertyValue*refi.refiLtv;
      const refiCost=newLoan*refi.refiCostPct;
      const oldDebtRemaining=Math.max(0,legacyBalance-principalPay);
      const saleNetProceeds=terminalRefi?saleNetAtRefiClose(opportunity,computation):0;
      const distribution=newLoan+saleNetProceeds-oldDebtRemaining-refiCost;

      // Repay the economically outstanding canonical balance, then replace it
      // with the new refinance loan. In current fixtures this equals the legacy
      // old balance; keeping the event ledger canonical prevents terminal debt
      // from disappearing merely because the analysis horizon ended.
      const refinanceRepayment=Math.max(0,canonicalBalance);
      if(refinanceRepayment>TOL){
        events.push(createFinancialEvent({
          scope,sequence:seqRef.value++,date,type:FINANCIAL_EVENT_TYPES.REFINANCE_REPAYMENT,amount:refinanceRepayment,
          metadata:{key:`refinance-repay-${yr}`,facilityId:facility.id,legacyYear:yr,refinanceKind:terminalRefi?'TERMINAL_CLOSE':'PERIODIC'},
        }));
        canonicalBalance=0;
      }
      if(newLoan>TOL){
        events.push(createFinancialEvent({
          scope,sequence:seqRef.value++,date,type:FINANCIAL_EVENT_TYPES.REFINANCE_DRAW,amount:newLoan,
          metadata:{key:`refinance-draw-${yr}`,facilityId:facility.id,legacyYear:yr,refinanceKind:terminalRefi?'TERMINAL_CLOSE':'PERIODIC',propertyValue,refiLtv:refi.refiLtv},
        }));
        canonicalBalance+=newLoan;
      }
      if(refiCost>TOL){
        events.push(createFinancialEvent({
          scope,sequence:seqRef.value++,date,type:FINANCIAL_EVENT_TYPES.REFINANCE_FEE,amount:refiCost,
          metadata:{key:`refinance-fee-${yr}`,facilityId:facility.id,legacyYear:yr,refiCostPct:refi.refiCostPct},
        }));
      }
      if(distribution>TOL){
        events.push(createFinancialEvent({
          scope,sequence:seqRef.value++,date,type:FINANCIAL_EVENT_TYPES.DISTRIBUTION,amount:distribution,
          metadata:{key:`refinance-distribution-${yr}`,legacyYear:yr,distributionKind:'REFINANCE_NET_PROCEEDS',saleNetProceeds},
        }));
      }

      refiRow=Object.freeze({yr,date,kind:terminalRefi?'TERMINAL_CLOSE':'PERIODIC',propertyValue,newLoan,refiCost,oldDebtRemaining,saleNetProceeds,distribution,canonicalDebtAfterRefi:canonicalBalance});
      rows.push(refiRow);

      // Mirror core.js legacy future-balance behavior. It only resets periodic
      // debt to newLoan when distribution is positive; terminal years are then
      // zeroed by the loop boundary regardless of replacement debt.
      if(periodicRefi&&distribution>0) legacyBalance=newLoan;
      else if(isLast) legacyBalance=0;
      else legacyBalance=Math.max(0,legacyBalance-principalPay+capInterest);

      if(periodicRefi&&distribution<=TOL&&!near(newLoan,oldDebtRemaining)){
        findings.push(Object.freeze({
          code:'LEGACY_REFINANCE_SHORTFALL_DOES_NOT_RESET_DEBT_TO_NEW_LOAN',legacyYear:yr,
          newLoan,oldDebtRemaining,distribution,
          message:'Legacy balance changes to the refinance loan only when refinance distribution is positive.',
        }));
      }
      continue;
    }

    if(isLast){
      // For perpetual hold the canonical shadow retains outstanding debt at the
      // measurement horizon. core.js instead runs its normal terminal exit and
      // then zeros remainingDebt before adding a residual-value mark.
      if(hold==='perpetual_hold') legacyBalance=0;
      else legacyBalance=0;
    } else {
      legacyBalance=Math.max(0,legacyBalance-principalPay+capInterest);
    }
  }

  const ledger=replayDebtBalance(events);
  const canonicalClosingDebtBalance=ledger.closingBalance;

  if(hold==='refinance_close'){
    const terminal=rows.find(r=>r.kind==='TERMINAL_CLOSE');
    if(terminal){
      const reportedOldDebt=Math.max(0,n(computation.balloonBalanceAtExit));
      if(!near(reportedOldDebt,terminal.newLoan)){
        findings.push(Object.freeze({
          code:'LEGACY_REFINANCE_CLOSE_TERMINAL_DEBT_REPORTS_PRE_REFI_BALANCE',
          legacyYear:terminal.yr,
          reportedBalloonBalanceAtExit:reportedOldDebt,
          replacementLoan:terminal.newLoan,
          delta:terminal.newLoan-reportedOldDebt,
          message:'Legacy terminal debt metric reports the pre-refinance payoff rather than the replacement refinance loan.',
        }));
      }
    }
  }

  let perpetual=null;
  if(hold==='perpetual_hold'){
    const finalRow=pnlRows.find(r=>Math.round(n(r.yr))===totalYears);
    const propertyValueEnd=refiPropertyValue(opportunity,computation,totalYears);
    const canonicalResidualEquity=Math.max(0,propertyValueEnd-canonicalClosingDebtBalance);
    const legacyCashOnly=Array.isArray(computation.equityCFCashOnly)?n(computation.equityCFCashOnly[totalYears]):0;
    const legacyBook=Array.isArray(computation.equityCF)?n(computation.equityCF[totalYears]):0;
    const legacyResidualAdded=legacyBook-legacyCashOnly;
    const legacyExitValue=n(finalRow?.exitValue);
    const legacyExitDebtPayoff=n(finalRow?.debtPayoffAtExit);

    if(legacyExitValue>TOL||legacyExitDebtPayoff>TOL){
      findings.push(Object.freeze({
        code:'LEGACY_PERPETUAL_HOLD_HORIZON_RUNS_DEEMED_EXIT',legacyYear:totalYears,
        exitValue:legacyExitValue,debtPayoffAtExit:legacyExitDebtPayoff,
        message:'Perpetual-hold cash-only series executes the normal terminal exit/payoff path at the analysis horizon.',
      }));
    }
    if(legacyResidualAdded>TOL&&near(legacyResidualAdded,propertyValueEnd)){
      findings.push(Object.freeze({
        code:'LEGACY_PERPETUAL_HOLD_RESIDUAL_VALUE_DOUBLE_COUNT',legacyYear:totalYears,
        overstatement:legacyResidualAdded,propertyValueEnd,canonicalResidualEquity,canonicalClosingDebtBalance,
        message:'Legacy book series adds full property value after the cash-only series already includes a deemed exit; debt was zeroed before the residual mark.',
      }));
    }
    perpetual=Object.freeze({
      propertyValueEnd,canonicalClosingDebtBalance,canonicalResidualEquity,
      legacyCashOnlyTerminal:legacyCashOnly,legacyBookTerminal:legacyBook,
      legacyResidualAdded,legacyExitValue,legacyExitDebtPayoff,
      legacyNAV:n(computation.NAV),navMatchesCanonicalResidual:near(n(computation.NAV),canonicalResidualEquity),
    });
  }

  return Object.freeze({
    facility,
    events:Object.freeze(events),
    refinanceRows:Object.freeze(rows),
    reconciliation:Object.freeze({
      interestChecks:Object.freeze(interestChecks),
      allInterestMatchesLegacy:interestChecks.every(x=>x.ok),
      canonicalClosingDebtBalance,
      perpetual,
      findings:Object.freeze(findings),
    }),
  });
}
