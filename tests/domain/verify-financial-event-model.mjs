import assert from 'assert/strict';
import {
  FINANCIAL_EVENT_TYPES, EVENT_TYPE_META, createFinancialEvent,
  deterministicEventId, eventEffects, replayDebtBalance,
} from '../../src/domain/financial/dated/financial-event.js';
import {
  addMonthsClamped, addYearsClamped, legacyYearEndDate,
  legacyYearMidpointDate, buildLegacyAnnualTimeline,
} from '../../src/domain/financial/dated/timeline.js';

const d='2026-01-31';
assert.equal(addMonthsClamped(d,1),'2026-02-28');
assert.equal(addYearsClamped('2024-02-29',1),'2025-02-28');
assert.equal(legacyYearEndDate('2026-04-15',2),'2028-04-15');
assert.equal(legacyYearMidpointDate('2026-04-15',1),'2026-10-15');
assert.deepEqual(buildLegacyAnnualTimeline({acquisitionDate:'2026-01-01',totalYears:2}).yearEnds,['2027-01-01','2028-01-01']);
assert.throws(()=>buildLegacyAnnualTimeline({acquisitionDate:'09/20/2026',totalYears:1}),/INVALID_ACQUISITION_DATE/);

const id1=deterministicEventId({scope:'x',type:FINANCIAL_EVENT_TYPES.DEBT_DRAW,date:'2026-01-01',sequence:1,key:'a'});
const id2=deterministicEventId({scope:'x',type:FINANCIAL_EVENT_TYPES.DEBT_DRAW,date:'2026-01-01',sequence:1,key:'a'});
assert.equal(id1,id2);

const eq=createFinancialEvent({scope:'x',sequence:0,date:'2026-01-01',type:FINANCIAL_EVENT_TYPES.EQUITY_CONTRIBUTION,amount:100});
assert.deepEqual(eventEffects(eq),{projectCash:0,equityCash:-100,debtBalance:0,financingCash:100});
const cap=createFinancialEvent({scope:'x',sequence:1,date:'2026-12-31',type:FINANCIAL_EVENT_TYPES.INTEREST_CAPITALIZED,amount:8});
assert.deepEqual(eventEffects(cap),{projectCash:0,equityCash:0,debtBalance:8,financingCash:0});
const refiFee=createFinancialEvent({scope:'x',sequence:2,date:'2026-12-31',type:FINANCIAL_EVENT_TYPES.REFINANCE_FEE,amount:3});
assert.deepEqual(eventEffects(refiFee),{projectCash:0,equityCash:0,debtBalance:0,financingCash:-3});
const directDeferral=createFinancialEvent({scope:'x',sequence:3,date:'2026-12-31',type:FINANCIAL_EVENT_TYPES.DIRECT_SALE_DEFERRAL,amount:25});
assert.deepEqual(eventEffects(directDeferral),{projectCash:-25,equityCash:-25,debtBalance:0,financingCash:0});
const directCollection=createFinancialEvent({scope:'x',sequence:4,date:'2028-12-31',type:FINANCIAL_EVENT_TYPES.DIRECT_SALE_COLLECTION,amount:25});
assert.deepEqual(eventEffects(directCollection),{projectCash:25,equityCash:25,debtBalance:0,financingCash:0});
assert.throws(()=>createFinancialEvent({date:'2026-01-01',type:FINANCIAL_EVENT_TYPES.DEBT_DRAW,amount:-1}),/INVALID_EVENT_AMOUNT/);
assert.throws(()=>createFinancialEvent({date:'2026-13-01',type:FINANCIAL_EVENT_TYPES.DEBT_DRAW,amount:1}),/INVALID_EVENT_DATE/);

const ledger=replayDebtBalance([
  createFinancialEvent({scope:'l',sequence:0,date:'2026-01-01',type:FINANCIAL_EVENT_TYPES.DEBT_DRAW,amount:100}),
  createFinancialEvent({scope:'l',sequence:1,date:'2026-12-31',type:FINANCIAL_EVENT_TYPES.INTEREST_CAPITALIZED,amount:8}),
  createFinancialEvent({scope:'l',sequence:2,date:'2027-01-01',type:FINANCIAL_EVENT_TYPES.DEBT_REPAYMENT,amount:108}),
]);
assert.equal(ledger.closingBalance,0);

for(const type of Object.values(FINANCIAL_EVENT_TYPES)) assert(EVENT_TYPE_META[type],`missing metadata for ${type}`);
console.log('PASS verify-financial-event-model: deterministic FinancialEvent contract + explicit timeline.');
