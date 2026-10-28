/* =========================================================================
   T19 (direct-sale, 60% bank-financed, 2-year collection lag): proves, from
   the ACTUAL final series handed to computeOpportunityXirr, that the
   deferred collection amount appears exactly once, and that
   DIRECT_SALE_DEFERRAL/COLLECTION are NOT re-applied on top of equityCF
   (which the T19 fixture shows already carries the deferred timing).
   Prints a BEFORE (raw equityCF, annual index) / AFTER (dated events, actual
   calendar dates, as fed into XIRR) table.
   Run: node src/domain/financial/xirr/verify-t19-direct-sale-sequence.mjs
   ========================================================================= */
import fs from "node:fs";
import { generateLegacyDirectSaleTimingEvents } from "../dated/legacy-direct-sale-events.js";
import { generateLegacyInvestorCashEvents } from "../dated/legacy-investor-cash-events.js";
import { computeOpportunityProjectAndEquityXirr } from "./opportunity-xirr.js";

const data = JSON.parse(fs.readFileSync(new URL("../../../../tests/domain/timing-baseline.json", import.meta.url)));
const acquisitionDate = data.acquisitionDate; // fixture-defined TEST date, not a real/approved opportunity date.
const fx = data.fixtures["T19-direct-sale-bank-lag2"];
const computation = { ...fx.timing, isDirectSaleSplit: true };
const opportunity = { strategy: { directSale: { bankFinancedPct: 0.6, collectionLagYears: 2 } } };

console.log("=== BEFORE: raw computation.equityCF (annual index, as the CURRENT annual model already produces it) ===");
computation.equityCF.forEach((v, i) => console.log(`  year ${i}: ${v}`));
console.log(`  (deferred terminal amount ${computation.directSaleDeferredAmt} appears at index 4 = the deferred COLLECTION year, not the exit year 2 -- already timing-aware at annual granularity)`);

const result = computeOpportunityProjectAndEquityXirr(opportunity, computation, { acquisitionDate });

console.log("\n=== AFTER: dated EQUITY cashflow series actually handed to computeOpportunityXirr ===");
result.equity.cashflows.forEach((cf) => console.log(`  ${cf.date}: ${cf.amount}`));

const deferredAmt = computation.directSaleDeferredAmt;
const occurrences = result.equity.cashflows.filter((cf) => Math.abs(Math.abs(cf.amount) - deferredAmt) < 1e-6);
console.log(`\nDeferred amount (${deferredAmt}) occurrences in the final equity series handed to XIRR: ${occurrences.length}`);
occurrences.forEach((o) => console.log("  ", o));

// The REAL lineage proof is at the event-TYPE level, not a date/amount match:
// a date/amount coincidence check is unreliable here because the equity series'
// 2030-01-01 entry and the project-level DIRECT_SALE_COLLECTION event legitimately
// land on the same date and amount by construction (that IS the point -- equityCF
// already encodes the collection at the correct calendar date). Coincidence in the
// OUTPUT is expected; what must be false is that the equity GENERATOR ever produces
// or consumes a DIRECT_SALE_* event type at all.
const direct = generateLegacyDirectSaleTimingEvents(opportunity, computation, { acquisitionDate });
console.log("\nProject-level DIRECT_SALE_DEFERRAL/COLLECTION events (for comparison only, NOT fed into the equity series):", direct.events.map((e) => `${e.date} ${e.type} ${e.amount}`));
console.log("(Note: 2030-01-01/11,107,078.25 appears in BOTH lists above. That is expected and is NOT a double count: equityCF already carries this amount at this date by itself; the project-level DIRECT_SALE_COLLECTION event is a separate, independent construct for the PROJECT view and is never merged into the equity series below.)");

const investorRaw = generateLegacyInvestorCashEvents(computation, { acquisitionDate });
const investorEventTypes = new Set(investorRaw.events.map((e) => e.type));
const equityGeneratorEverProducesDirectSaleTypes = investorEventTypes.has("DIRECT_SALE_DEFERRAL") || investorEventTypes.has("DIRECT_SALE_COLLECTION");
console.log("Equity-series generator (generateLegacyInvestorCashEvents) event types produced:", [...investorEventTypes]);
console.log("Does the equity generator ever produce/consume DIRECT_SALE_* types?", equityGeneratorEverProducesDirectSaleTypes, "(expected: false -- it only ever produces EQUITY_CONTRIBUTION/DISTRIBUTION from equityCF)");

const ok = occurrences.length === 1 && !equityGeneratorEverProducesDirectSaleTypes;
console.log(`\nResult.equity.xirr:`, result.equity.xirr);
console.log(`\n${ok ? "PASS: deferred collection appears exactly once; no re-application of DIRECT_SALE_* onto equityCF." : "FAIL"}`);
process.exit(ok ? 0 : 1);
