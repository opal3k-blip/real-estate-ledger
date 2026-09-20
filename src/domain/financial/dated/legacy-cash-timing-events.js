/* =========================================================================
   Phase 3B-5A — Legacy cash-timing events (shadow mode)
   -------------------------------------------------------------------------
   Reconstructs dated legacy behavior that was frozen as BASELINE_ONLY in
   3B1-RECOVERY-V1:
     - VAT input funding at t0 + recoverable VAT refunds by legacy lag rules
     - phased-sale proceeds/costs + proportional principal releases for
       off-plan and phased-subdivision modes

   This is parity/shadow logic only. It does not invent construction spend
   curves, escrow milestones, or new facility economics.
   ========================================================================= */
import { createFinancialEvent, FINANCIAL_EVENT_TYPES, replayDebtBalance } from './financial-event.js';
import { requireAcquisitionDate, legacyYearEndDate, legacyYearMidpointDate } from './timeline.js';
import { buildLegacyBlendedFacility } from './legacy-financing-events.js';

const TOL=1e-7;
function n(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }
function near(a,b,tol=TOL){ return Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b)); }

export function generateLegacyVatEvents(opportunity,computation,{acquisitionDate,scope='legacy-vat'}={}){
  requireAcquisitionDate(acquisitionDate);
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  const vatInputTotal=Math.max(0,n(computation.vatInputTotal));
  const recoveryPct=Math.max(0,Math.min(1,n(computation.vatRecoveryPct)));
  const lag=Math.max(0,Math.round(n(computation.vatWorkingCapitalRefundLagYears ?? opportunity?.vat?.refundLagYears)));
  const constructionYears=Math.max(0,Math.round(n(computation.constructionYears)));
  const totalYears=Math.max(0,Math.round(n(computation.totalYears)));
  const events=[];
  let seq=0;

  if(vatInputTotal>0){
    events.push(createFinancialEvent({
      scope,sequence:seq++,date:acquisitionDate,type:FINANCIAL_EVENT_TYPES.VAT_INPUT_PAYMENT,amount:vatInputTotal,
      metadata:{key:'vat-input-t0',timingConvention:'LEGACY_GROSS_INPUT_VAT_FUNDED_IN_TPC_AT_T0',recoveryPct,refundLagYears:lag},
    }));
  }

  const vatEnabled=!!opportunity?.vat?.enabled;
  const vatRate=vatEnabled ? n(opportunity?.vat?.ratePct ?? 0.15) : 0;
  const vatInputRate=vatEnabled ? n(opportunity?.vat?.constructionInputVatPct ?? vatRate) : 0;
  const hardCost=Math.max(0,n(computation.hardCost));
  const feesForLegacyRefund=Math.max(0,n(opportunity?.fees?.dueDiligence))+Math.max(0,n(opportunity?.fees?.valuation))+Math.max(0,n(computation.structuringFee));
  const ncy=Math.max(1,constructionYears);
  const refundRows=[];

  for(let yr=1;yr<=totalYears;yr++){
    let sourceYear=null;
    let sourceSpend=0;
    if(vatEnabled && vatInputTotal>0 && lag>0 && yr>1){
      sourceYear=yr-lag;
      if(sourceYear>=1 && sourceYear<=ncy){
        sourceSpend=(hardCost/ncy)+(sourceYear===1 ? feesForLegacyRefund/ncy : 0);
      }
    } else if(vatEnabled && vatInputTotal>0 && lag===0 && yr<=constructionYears){
      sourceYear=yr;
      sourceSpend=(hardCost/ncy)+(yr===1 ? feesForLegacyRefund/ncy : 0);
    }
    const amount=sourceSpend*vatInputRate*recoveryPct;
    if(amount>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date:legacyYearEndDate(acquisitionDate,yr),type:FINANCIAL_EVENT_TYPES.VAT_REFUND,amount,
        metadata:{key:`vat-refund-${yr}`,legacyYear:yr,sourceConstructionYear:sourceYear,refundLagYears:lag,sourceSpend,vatInputRate,recoveryPct},
      }));
      refundRows.push(Object.freeze({yr,sourceYear,sourceSpend,amount}));
    }
  }

  const refunds=refundRows.reduce((a,r)=>a+r.amount,0);
  const recoverableTarget=vatInputTotal*recoveryPct;
  const unrecoveredWithinLegacyHorizon=Math.max(0,recoverableTarget-refunds);
  const findings=[];
  if(unrecoveredWithinLegacyHorizon>TOL){
    findings.push(Object.freeze({
      code:'LEGACY_VAT_RECOVERY_NOT_FULLY_RETURNED_WITHIN_HORIZON',
      amount:unrecoveredWithinLegacyHorizon,
      message:'Legacy annual refund mechanics do not return the full recoverable VAT amount within the modeled horizon.',
    }));
  }

  return Object.freeze({
    events:Object.freeze(events),
    refundRows:Object.freeze(refundRows),
    reconciliation:Object.freeze({vatInputTotal,recoveryPct,recoverableTarget,refunds,unrecoveredWithinLegacyHorizon,findings:Object.freeze(findings)}),
  });
}

function phasedSchedule(computation){
  if(computation?.isOffPlanSale) return {kind:'OFF_PLAN',schedule:Array.isArray(computation.offPlanSchedule)?computation.offPlanSchedule:[]};
  if(computation?.isSubdivisionPhased) return {kind:'SUBDIVISION',schedule:Array.isArray(computation.absorptionSchedule)?computation.absorptionSchedule:[]};
  return {kind:null,schedule:[]};
}

export function generateLegacyPhasedSaleEvents(opportunity,computation,{acquisitionDate,scope='legacy-phased-sale'}={}){
  requireAcquisitionDate(acquisitionDate);
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');
  if(!computation.isPhasedSaleMode) throw new Error('NOT_LEGACY_PHASED_SALE_MODE');
  if(opportunity?.financing?.interestDuringConstruction==='capitalized') throw new Error('UNSUPPORTED_3B5A_PHASED_SALE_CAPITALIZED_INTEREST');

  const {kind,schedule}=phasedSchedule(computation);
  if(!kind || !schedule.length) throw new Error('MISSING_LEGACY_PHASED_SALE_SCHEDULE');
  const facility=buildLegacyBlendedFacility(opportunity,computation);
  const debt=Math.max(0,n(computation.debt));
  const events=[];
  let seq=0;
  const drawSchedule=Array.isArray(computation.drawSchedule)?computation.drawSchedule:null;

  if(debt>0){
    if(drawSchedule && drawSchedule.length){
      drawSchedule.forEach((share,i)=>{
        const amount=debt*Math.max(0,n(share));
        if(amount<=TOL) return;
        events.push(createFinancialEvent({
          scope,sequence:seq++,date:legacyYearMidpointDate(acquisitionDate,i+1),type:FINANCIAL_EVENT_TYPES.DEBT_DRAW,amount,
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

  for(const tranche of schedule){
    const yr=Math.max(1,Math.round(n(tranche.yr)));
    const date=legacyYearEndDate(acquisitionDate,yr);
    const revenue=Math.max(0,n(tranche.trancheRevenue));
    const costs=Math.max(0,n(tranche.trancheCosts));
    const principal=Math.max(0,n(tranche.tranchePrincipalPay));
    const pct=Math.max(0,n(tranche.pct));
    if(revenue>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.SALE_PROCEEDS,amount:revenue,
        metadata:{key:`${kind.toLowerCase()}-sale-${yr}`,legacyYear:yr,phasedSaleKind:kind,tranchePct:pct},
      }));
    }
    if(costs>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.FEE,amount:costs,
        metadata:{key:`${kind.toLowerCase()}-sale-cost-${yr}`,legacyYear:yr,phasedSaleKind:kind,tranchePct:pct,feeComponent:'PHASED_SALE_EXIT_COST'},
      }));
    }
    if(principal>TOL){
      events.push(createFinancialEvent({
        scope,sequence:seq++,date,type:FINANCIAL_EVENT_TYPES.DEBT_REPAYMENT,amount:principal,
        metadata:{key:`${kind.toLowerCase()}-principal-release-${yr}`,legacyYear:yr,facilityId:facility.id,phasedSaleKind:kind,tranchePct:pct,repaymentKind:'PROPORTIONAL_RELEASE'},
      }));
    }
  }

  const saleProceeds=events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.SALE_PROCEEDS).reduce((a,e)=>a+e.amount,0);
  const saleCosts=events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.FEE).reduce((a,e)=>a+e.amount,0);
  const draws=events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.DEBT_DRAW).reduce((a,e)=>a+e.amount,0);
  const repayments=events.filter(e=>e.type===FINANCIAL_EVENT_TYPES.DEBT_REPAYMENT).reduce((a,e)=>a+e.amount,0);
  const scheduledRevenue=schedule.reduce((a,t)=>a+Math.max(0,n(t.trancheRevenue)),0);
  const scheduledCosts=schedule.reduce((a,t)=>a+Math.max(0,n(t.trancheCosts)),0);
  const scheduledPrincipal=schedule.reduce((a,t)=>a+Math.max(0,n(t.tranchePrincipalPay)),0);
  const ledger=replayDebtBalance(events);
  const findings=[];
  if(!near(repayments,debt)) findings.push(Object.freeze({code:'LEGACY_PHASED_RELEASES_DO_NOT_EQUAL_INITIAL_PRINCIPAL',amount:debt-repayments}));

  return Object.freeze({
    kind,facility,events:Object.freeze(events),
    reconciliation:Object.freeze({
      saleProceeds,saleCosts,draws,repayments,scheduledRevenue,scheduledCosts,scheduledPrincipal,
      closingDebtBalance:ledger.closingBalance,
      revenueMatchesSchedule:near(saleProceeds,scheduledRevenue),costsMatchSchedule:near(saleCosts,scheduledCosts),
      principalMatchesSchedule:near(repayments,scheduledPrincipal),drawsMatchDebt:near(draws,debt),findings:Object.freeze(findings),
    }),
  });
}
