function safeNum(v){
  if(typeof v !== 'number') return v;
  if(Number.isNaN(v)) return '__NaN__';
  if(v === Infinity) return '__Infinity__';
  if(v === -Infinity) return '__-Infinity__';
  return v;
}

export function deepSafe(v){
  if(Array.isArray(v)) return Array.from(v, deepSafe);
  if(v && typeof v === 'object'){
    const out = {};
    for(const k of Object.keys(v)) out[k] = deepSafe(v[k]);
    return out;
  }
  return safeNum(v);
}

function pickPnlRow(r){
  const keys = [
    'yr','phase','isExitYear','revenue','noi','interestExpense','principalPayment','debtService',
    'debtPayoffAtExit','vatIrrecoverableCost','projectCF','equityCF'
  ];
  const out = {};
  for(const k of keys) if(Object.prototype.hasOwnProperty.call(r,k)) out[k] = r[k];
  return out;
}

function pickCheck(c){
  return { k:c.k, v:c.v, min:c.min, fmt:c.fmt, skip:!!c.skip };
}

export function projectFinancialResult(c){
  const scalarKeys = [
    'landCost','gfa','footprint','floorsNeeded','buildingHeight','landCostPerGFA','masterMultiplier',
    'hardCost','hardCostBase','contingencyPct','oneTimeFixed','structuringFee','acquisitionFee','arrangementFee',
    'TPC','debt','seniorDebt','mezzDebt','equity','contributedEquity','investorCashInvested','interestRate','Ke','Kd','WACC',
    'balloonBalanceAtExit','gla','totalYears','constructionYears','operationYears',
    'equityIRR','projectIRR','npvEquity','npvProject','totalDistrib','MOIC','DPI','RVPI','TVPI','paybackPeriod',
    'dscrMin','dscrAvg','equityIRRCashOnly','MOICCashOnly','totalDistribCashOnly','stabilizedNOIyr1','yieldOnCost','NAV','ROI',
    'mgmtFeeTotal','assetMgmtTotal','regAuditCustodianTotal','fundSideFees','investorSideFees','feesPctOfTPC',
    'PIC','roc','pref','catchup','lpStandard','carryPool','lpBonus','gpManager','devPromote','lpTotal','gpTotal','devTotal',
    'passCount','failCount','applicable','verdict','salePct','applySalePctToIncome','annualFundFee',
    'isSubdivisionPhased','isOffPlanSale','isPhasedSaleMode','isDirectSaleSplit','directSaleDeferredAmt','directSaleDeferredYear',
    'equityIRRAfterZakat','MOICAfterZakat','totalZakatEstimate','vatIsResidentialExempt','totalVatIrrecoverableCost',
    'vatInputTotal','vatIrrecoverableUpfront','holdStrategy','amortType','scopeType','assetClass'
  ];
  const out = {};
  for(const k of scalarKeys) if(Object.prototype.hasOwnProperty.call(c,k)) out[k] = c[k];
  out.projectCF = c.projectCF;
  out.equityCF = c.equityCF;
  out.equityCFCashOnly = c.equityCFCashOnly;
  out.pnlRows = Array.isArray(c.pnlRows) ? c.pnlRows.map(pickPnlRow) : [];
  out.checks = Array.isArray(c.checks) ? c.checks.map(pickCheck) : [];
  out.drawSchedule = c.drawSchedule;
  out.absorptionSchedule = c.absorptionSchedule;
  out.offPlanSchedule = c.offPlanSchedule;
  return deepSafe(out);
}
