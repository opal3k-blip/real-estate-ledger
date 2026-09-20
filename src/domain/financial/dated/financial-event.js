/* =========================================================================
   FinancialEvent — Phase 3B dated-financial model (recovery rebuild)
   -------------------------------------------------------------------------
   Pure deterministic event contract. No Date.now(), randomness, storage, UI,
   or mutation of src/core.js. Event amounts are ALWAYS non-negative magnitudes;
   semantic signs live in EVENT_TYPE_META.
   ========================================================================= */

export const FINANCIAL_EVENT_TYPES = Object.freeze({
  LAND_ACQUISITION: 'LAND_ACQUISITION',
  CONSTRUCTION_COST: 'CONSTRUCTION_COST',
  CONTINGENCY: 'CONTINGENCY',
  FEE: 'FEE',
  VAT_INPUT_PAYMENT: 'VAT_INPUT_PAYMENT',
  VAT_REFUND: 'VAT_REFUND',
  RENT_INCOME: 'RENT_INCOME',
  OPEX: 'OPEX',
  SALE_PROCEEDS: 'SALE_PROCEEDS',
  EXIT_PROCEEDS: 'EXIT_PROCEEDS',

  EQUITY_CONTRIBUTION: 'EQUITY_CONTRIBUTION',
  DISTRIBUTION: 'DISTRIBUTION',

  DEBT_DRAW: 'DEBT_DRAW',
  DEBT_REPAYMENT: 'DEBT_REPAYMENT',
  INTEREST_PAYMENT: 'INTEREST_PAYMENT',
  INTEREST_CAPITALIZED: 'INTEREST_CAPITALIZED',
  REFINANCE_DRAW: 'REFINANCE_DRAW',
  REFINANCE_REPAYMENT: 'REFINANCE_REPAYMENT',
  REFINANCE_FEE: 'REFINANCE_FEE',
});

/*
  Sign semantics:
  - projectCashSign: unlevered project cash-flow view. Financing events do not
    alter this view.
  - equityCashSign: LP/investor cash-flow view. Only actual calls/distributions
    alter this view; debt service is a use inside the financed project and is
    NOT counted a second time here.
  - debtBalanceSign: effect on outstanding debt.
  - financingCashSign: cash movement inside the financing/funding layer; this is
    supplementary and intentionally separate from project/equity views.
*/
export const EVENT_TYPE_META = Object.freeze({
  LAND_ACQUISITION:      { projectCashSign:-1, equityCashSign: 0, debtBalanceSign: 0, financingCashSign: 0 },
  CONSTRUCTION_COST:     { projectCashSign:-1, equityCashSign: 0, debtBalanceSign: 0, financingCashSign: 0 },
  CONTINGENCY:           { projectCashSign:-1, equityCashSign: 0, debtBalanceSign: 0, financingCashSign: 0 },
  FEE:                   { projectCashSign:-1, equityCashSign: 0, debtBalanceSign: 0, financingCashSign: 0 },
  VAT_INPUT_PAYMENT:     { projectCashSign:-1, equityCashSign: 0, debtBalanceSign: 0, financingCashSign: 0 },
  VAT_REFUND:            { projectCashSign: 1, equityCashSign: 0, debtBalanceSign: 0, financingCashSign: 0 },
  RENT_INCOME:           { projectCashSign: 1, equityCashSign: 0, debtBalanceSign: 0, financingCashSign: 0 },
  OPEX:                  { projectCashSign:-1, equityCashSign: 0, debtBalanceSign: 0, financingCashSign: 0 },
  SALE_PROCEEDS:         { projectCashSign: 1, equityCashSign: 0, debtBalanceSign: 0, financingCashSign: 0 },
  EXIT_PROCEEDS:         { projectCashSign: 1, equityCashSign: 0, debtBalanceSign: 0, financingCashSign: 0 },

  EQUITY_CONTRIBUTION:   { projectCashSign: 0, equityCashSign:-1, debtBalanceSign: 0, financingCashSign: 1 },
  DISTRIBUTION:          { projectCashSign: 0, equityCashSign: 1, debtBalanceSign: 0, financingCashSign:-1 },

  DEBT_DRAW:             { projectCashSign: 0, equityCashSign: 0, debtBalanceSign: 1, financingCashSign: 1 },
  DEBT_REPAYMENT:        { projectCashSign: 0, equityCashSign: 0, debtBalanceSign:-1, financingCashSign:-1 },
  INTEREST_PAYMENT:      { projectCashSign: 0, equityCashSign: 0, debtBalanceSign: 0, financingCashSign:-1 },
  INTEREST_CAPITALIZED:  { projectCashSign: 0, equityCashSign: 0, debtBalanceSign: 1, financingCashSign: 0 },
  REFINANCE_DRAW:        { projectCashSign: 0, equityCashSign: 0, debtBalanceSign: 1, financingCashSign: 1 },
  REFINANCE_REPAYMENT:   { projectCashSign: 0, equityCashSign: 0, debtBalanceSign:-1, financingCashSign:-1 },
  REFINANCE_FEE:         { projectCashSign: 0, equityCashSign: 0, debtBalanceSign: 0, financingCashSign:-1 },
});

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isStrictIsoDate(value){
  if(typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const [y,m,d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y,m-1,d));
  return dt.getUTCFullYear()===y && dt.getUTCMonth()===m-1 && dt.getUTCDate()===d;
}

function cleanToken(v){
  return String(v??'')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g,'-')
    .replace(/^-+|-+$/g,'') || 'na';
}

export function deterministicEventId({ scope='legacy', type, date, sequence=0, key='' }){
  if(!EVENT_TYPE_META[type]) throw new Error(`UNKNOWN_EVENT_TYPE:${type}`);
  if(!isStrictIsoDate(date)) throw new Error(`INVALID_EVENT_DATE:${date}`);
  if(!Number.isInteger(sequence) || sequence<0) throw new Error(`INVALID_EVENT_SEQUENCE:${sequence}`);
  return [cleanToken(scope), cleanToken(type), cleanToken(date), String(sequence).padStart(4,'0'), cleanToken(key)].join(':');
}

export function createFinancialEvent({ id, scope='legacy', sequence=0, date, type, amount, source='legacy-core', metadata={} }){
  if(!EVENT_TYPE_META[type]) throw new Error(`UNKNOWN_EVENT_TYPE:${type}`);
  if(!isStrictIsoDate(date)) throw new Error(`INVALID_EVENT_DATE:${date}`);
  if(!Number.isInteger(sequence) || sequence<0) throw new Error(`INVALID_EVENT_SEQUENCE:${sequence}`);
  if(typeof amount !== 'number' || !Number.isFinite(amount) || amount<0) throw new Error(`INVALID_EVENT_AMOUNT:${amount}`);
  const eventId = id || deterministicEventId({scope,type,date,sequence,key:metadata.key||''});
  if(typeof eventId !== 'string' || !eventId.trim()) throw new Error('INVALID_EVENT_ID');
  return Object.freeze({
    id:eventId,
    scope,
    sequence,
    date,
    type,
    amount,
    source,
    metadata:Object.freeze({...metadata}),
  });
}

export function eventEffects(event){
  const meta = EVENT_TYPE_META[event.type];
  if(!meta) throw new Error(`UNKNOWN_EVENT_TYPE:${event.type}`);
  return {
    projectCash: meta.projectCashSign * event.amount,
    equityCash: meta.equityCashSign * event.amount,
    debtBalance: meta.debtBalanceSign * event.amount,
    financingCash: meta.financingCashSign * event.amount,
  };
}

export function sortFinancialEvents(events){
  return [...events].sort((a,b)=> a.date.localeCompare(b.date) || a.sequence-b.sequence || a.id.localeCompare(b.id));
}

export function aggregateEventEffects(events){
  return sortFinancialEvents(events).reduce((a,event)=>{
    const e=eventEffects(event);
    a.projectCash += e.projectCash;
    a.equityCash += e.equityCash;
    a.debtBalance += e.debtBalance;
    a.financingCash += e.financingCash;
    return a;
  }, {projectCash:0,equityCash:0,debtBalance:0,financingCash:0});
}

export function replayDebtBalance(events, { tolerance=1e-7 }={}){
  let balance=0;
  const rows=[];
  for(const event of sortFinancialEvents(events)){
    const delta=eventEffects(event).debtBalance;
    if(delta===0) continue;
    const opening=balance;
    balance += delta;
    if(balance < -tolerance) throw new Error(`NEGATIVE_DEBT_BALANCE:${event.id}:${balance}`);
    if(Math.abs(balance)<tolerance) balance=0;
    rows.push({eventId:event.id,date:event.date,type:event.type,opening,delta,closing:balance});
  }
  return {closingBalance:balance, rows};
}
