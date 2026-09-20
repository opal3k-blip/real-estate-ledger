/* =========================================================================
   Project-cost component extraction — Phase 3B-6
   -------------------------------------------------------------------------
   One deterministic decomposition of the legacy compute() cost outputs.
   Both legacy t0 parity events and transaction-grade scheduled construction
   events consume this function so cost totals cannot drift between adapters.
   ========================================================================= */

function n(v){ return Number.isFinite(Number(v)) ? Number(v) : 0; }
function positive(v){ return Math.max(0,n(v)); }

export function extractProjectCostComponents(computation){
  if(!computation || typeof computation!=='object') throw new Error('MISSING_COMPUTATION');

  const contingency=positive(computation.costBreakdownAmounts?.contingency);
  const hardCostBase=positive(computation.hardCostBase);
  const hardCost=hardCostBase+contingency;
  const fees=Object.freeze({
    oneTimeFixed:positive(computation.oneTimeFixed),
    structuringFee:positive(computation.structuringFee),
    acquisitionFee:positive(computation.acquisitionFee),
    arrangementFee:positive(computation.arrangementFee),
  });
  const feeTotal=Object.values(fees).reduce((a,b)=>a+b,0);
  const landCost=positive(computation.landCost);
  const vatExcluded=positive(computation.vatInputTotal);
  const expectedTPCExcludingVAT=positive(computation.TPC)-vatExcluded;
  const decomposedTPCExcludingVAT=landCost+hardCost+feeTotal;

  return Object.freeze({
    landCost,
    hardCostBase,
    contingency,
    hardCost,
    fees,
    feeTotal,
    vatExcluded,
    expectedTPCExcludingVAT,
    decomposedTPCExcludingVAT,
    decompositionDelta:decomposedTPCExcludingVAT-expectedTPCExcludingVAT,
  });
}
