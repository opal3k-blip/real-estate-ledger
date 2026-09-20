/* Phase 3B-1 recovery timing fixtures.
   These are a newly reconstructed baseline against the authoritative src/core.js.
   They are not claimed to be byte-identical to the lost historical d34b922 fixture set. */

function set(o,path,value){
  const parts=path.split('.');
  let cur=o;
  for(let i=0;i<parts.length-1;i++) cur=cur[parts[i]];
  cur[parts.at(-1)]=value;
}

function cleanFees(o){
  for(const k of ['mgmt','assetMgmt','regAuditCustodian','structuring','acquisition','arrangement','cmaSetup','dueDiligence','valuation']) set(o,`fees.${k}`,0);
  set(o,'subscription.subscriptionFee',0);
  for(const k of ['broker','legal','rett','exitFee']) set(o,`exitCosts.${k}`,0);
  set(o,'fees.disposition',0);
  return o;
}

export function makeTimingBase(C){
  const o=JSON.parse(JSON.stringify(C.blankOpportunity()));
  set(o,'meta.oppType','development');
  set(o,'meta.tier','متوسط');
  set(o,'meta.useType','__neutral__');
  for(const k of ['soil','water','tower','topo','infra']) set(o,`site.${k}`,1);
  set(o,'land.floorHeight',3.6);
  set(o,'land.area',5000);
  set(o,'land.price',2000);
  set(o,'land.far',2);
  set(o,'land.bar',0.5);
  set(o,'land.basements',0);
  set(o,'development.buildCost',3000);
  set(o,'development.salePrice',6000);
  set(o,'development.efficiency',0.85);
  set(o,'development.contingency',0.05);
  set(o,'development.constructionYears',2);
  set(o,'development.operationYears',0);
  set(o,'development.scopeType','both');
  set(o,'development.exitCapRate',0.08);
  set(o,'strategy.salePct',1);
  set(o,'financing.ltc',0.6);
  set(o,'financing.saibor',0.055);
  set(o,'financing.margin',0.025);
  set(o,'financing.interestDuringConstruction','cash');
  set(o,'wacc.marketCap',0.075);
  set(o,'wacc.growth',0.02);
  return cleanFees(o);
}

const DEFINITIONS=[
  ['T01-base-development','Base development (2 construction years)','IMPLEMENTED',()=>{}],
  ['T02-construction-heavy','Four-year construction horizon','IMPLEMENTED',o=>set(o,'development.constructionYears',4)],
  ['T03-operation-hold','Two construction + five operation years','IMPLEMENTED',o=>set(o,'development.operationYears',5)],
  ['T04-offplan-no-lag','Off-plan sale with no escrow lag','BASELINE_ONLY',o=>{set(o,'strategy.offPlanSale.enabled',true);set(o,'strategy.offPlanSale.escrowLagYears',0);} ],
  ['T05-debt-draw-schedule','Three-year 20/30/50 debt draw schedule','IMPLEMENTED',o=>{set(o,'development.constructionYears',3);set(o,'financing.drawSchedulePct',[0.2,0.3,0.5]);}],
  ['T06-capitalized-interest','Capitalized construction interest','IMPLEMENTED_WITH_FINDING',o=>set(o,'financing.interestDuringConstruction','capitalized')],
  ['T07-cash-interest','Cash construction interest','IMPLEMENTED',o=>set(o,'financing.interestDuringConstruction','cash')],
  ['T08-offplan-lag1','Off-plan collection extends one year beyond nominal tranche','BASELINE_ONLY',o=>{set(o,'development.constructionYears',3);set(o,'strategy.offPlanSale.enabled',true);set(o,'strategy.offPlanSale.escrowLagYears',1);} ],
  ['T09-offplan-lag2-backloaded','Back-loaded off-plan with two-year escrow lag','BASELINE_ONLY',o=>{set(o,'development.constructionYears',3);set(o,'strategy.offPlanSale.enabled',true);set(o,'strategy.offPlanSale.escrowLagYears',2);set(o,'strategy.offPlanSale.curve','back_loaded');}],
  ['T10-vat-refund-lag0','Recoverable VAT with zero refund lag','BASELINE_ONLY',o=>{set(o,'vat.enabled',true);set(o,'vat.inputRecoveryPct',1);set(o,'vat.refundLagYears',0);} ],
  ['T11-vat-refund-lag2','Recoverable VAT with two-year refund lag','BASELINE_ONLY',o=>{set(o,'development.constructionYears',3);set(o,'development.operationYears',2);set(o,'vat.enabled',true);set(o,'vat.inputRecoveryPct',1);set(o,'vat.refundLagYears',2);} ],
  ['T12-phased-subdivision','Four-year serviced-land absorption after construction','BASELINE_ONLY',o=>{set(o,'development.scopeType','infra_only');set(o,'development.infraCostPerSqm',800);set(o,'development.constructionYears',2);set(o,'subdivision.phasedAbsorption',true);set(o,'subdivision.absorptionYears',4);set(o,'subdivision.curve','even');}],
  ['T13-landbank','Four-year landbank hold','IMPLEMENTED',o=>{set(o,'meta.oppType','landbank');set(o,'financing.ltc',0.4);set(o,'landbank.holdingYears',4);set(o,'landbank.appreciation',0.08);set(o,'landbank.carryAnnual',250000);} ],
  ['T14-one-year-project','One-year boundary case','IMPLEMENTED',o=>{set(o,'development.constructionYears',1);set(o,'development.operationYears',0);} ],
  ['T15-senior-mezz','Senior/mezz sizing timing control','IMPLEMENTED',o=>{set(o,'financing.structure','senior_mezz');set(o,'financing.seniorPct',0.8);set(o,'financing.mezzMarginAdj',0.04);} ],
  ['T16-refinance-close','Refinance-close at terminal year','IMPLEMENTED_WITH_FINDINGS',o=>{set(o,'strategy.exitStrategy','إعادة تمويل (Hold/Refinance)');set(o,'strategy.salePct',0);set(o,'development.operationYears',5);set(o,'income.rent',800);set(o,'income.occupancy',0.9);set(o,'income.opex',0.2);set(o,'income.refinance.refiLtv',0.65);set(o,'income.refinance.refiCostPct',0.01);} ],
  ['T17-perpetual-hold-periodic-refi','Perpetual hold with periodic refinance','IMPLEMENTED_WITH_FINDINGS',o=>{set(o,'meta.oppType','income');set(o,'income.holdStrategy','perpetual_hold');set(o,'income.rent',800);set(o,'income.occupancy',0.9);set(o,'income.opex',0.2);set(o,'income.refinance.intervalYears',3);set(o,'income.refinance.refiLtv',0.65);set(o,'income.refinance.refiCostPct',0.01);set(o,'income.refinance.analysisHorizon',8);set(o,'development.constructionYears',1);set(o,'development.operationYears',5);} ],
  ['T18-high-leverage','High-leverage timing control','IMPLEMENTED',o=>set(o,'financing.ltc',0.9)],
];

export function buildTimingFixtures(C){
  return DEFINITIONS.map(([id,label,datedCoverage,mutate])=>{
    const input=makeTimingBase(C);
    mutate(input);
    return {id,label,datedCoverage,input,scenarioKey:'base'};
  });
}
