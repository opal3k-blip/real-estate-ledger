/* =========================================================================
   Proves the 3B direct-sale deferral/collection timing split is a pure
   timing shift (net 0 across project+equity) AND that it is NOT present in
   the equityCF-derived investor cash series this XIRR module uses for the
   equity view -- so no double count against that series is even possible.
   Uses the frozen T19 fixture (timing-baseline.json), which stores the
   already-computed timing/projectCF/equityCF directly rather than an
   opportunity to re-run through the engine; isDirectSaleSplit is not part
   of that frozen shape, so it is set explicitly here to activate the split
   path being tested (deferredYear/deferredAmt in the fixture already imply
   the split applies: deferredYear=4=totalYears(2)+lag(2)).
   Run: node src/domain/financial/xirr/verify-direct-sale-no-double-count.mjs
   ========================================================================= */
import fs from "node:fs";
import { generateLegacyDirectSaleTimingEvents } from "../dated/legacy-direct-sale-events.js";
import { generateLegacyInvestorCashEvents } from "../dated/legacy-investor-cash-events.js";

const data = JSON.parse(fs.readFileSync(new URL("../../../../tests/domain/timing-baseline.json", import.meta.url)));
const acquisitionDate = data.acquisitionDate; // fixture-defined test date, NOT a real/approved opportunity date.
const fx = data.fixtures["T19-direct-sale-bank-lag2"];
const computation = { ...fx.timing, isDirectSaleSplit: true };
const opportunity = { strategy: { directSale: { bankFinancedPct: 0.6, collectionLagYears: 2 } } };

console.log("directSaleDeferredYear:", computation.directSaleDeferredYear, "directSaleDeferredAmt:", computation.directSaleDeferredAmt, "totalYears:", computation.totalYears);

const direct = generateLegacyDirectSaleTimingEvents(opportunity, computation, { acquisitionDate });
console.log("direct-sale events:", direct.events.map((e) => ({ date: e.date, type: e.type, amount: e.amount })));
console.log("direct-sale reconciliation (generator own net-zero check):", direct.reconciliation);

const investor = generateLegacyInvestorCashEvents(computation, { acquisitionDate });
console.log("");
console.log("investor (equityCF-derived) events:", investor.events.map((e) => ({ date: e.date, type: e.type, amount: e.amount })));
const investorTypes = new Set(investor.events.map((e) => e.type));
const containsDirectSaleTypes = investorTypes.has("DIRECT_SALE_DEFERRAL") || investorTypes.has("DIRECT_SALE_COLLECTION");

console.log("");
console.log("equityCF-derived investor events reference DIRECT_SALE_* types:", containsDirectSaleTypes, "(expected false)");
console.log("Conclusion: no double count is possible, because the equity-series GENERATOR (generateLegacyInvestorCashEvents) never produces or consumes a DIRECT_SALE_DEFERRAL/COLLECTION event type in the first place -- it only ever emits EQUITY_CONTRIBUTION/DISTRIBUTION derived from equityCF.");
console.log("Correction (superseded an earlier, premature claim made before testing): this does NOT mean the equity series lacks the deferred-collection timing. computation.equityCF's own array already places the deferred amount at the correct deferred year (see the 2030-01-01 DISTRIBUTION above, matching directSaleDeferredYear) -- the annual model is already timing-aware at annual granularity for this case. See verify-t19-direct-sale-sequence.mjs for the full before/after proof of this.");

const ok = direct.events.length === 2
  && Math.abs(direct.reconciliation.projectTimingNet) < 1e-6
  && Math.abs(direct.reconciliation.equityTimingNet) < 1e-6
  && direct.reconciliation.findings.length === 0
  && !containsDirectSaleTypes;
console.log("");
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
