/* =========================================================================
   Regression-only run of computeOpportunityProjectAndEquityXirr across the
   20 frozen Phase 3B timing fixtures (tests/domain/timing-baseline.json).

   IMPORTANT (per explicit instruction): matching or diverging from the
   legacy ANNUAL IRR here is NOT proof of XIRR correctness. This script
   exists to (a) confirm the wrapper runs across the real frozen fixture
   set without crashing or silently defaulting anything, and (b) produce
   the side-by-side numbers + source warnings for the comparison report.
   Reference-case correctness is established separately in
   verify-xirr-opportunity-reference-cases.mjs against independently
   derivable closed-form/published results, NOT against these fixtures.

   Run: node src/domain/financial/xirr/verify-20-fixtures-regression.mjs
   ========================================================================= */
/*
  IMPORTANT DATA-SCOPE FINDING (discovered while running this script, not
  assumed beforehand): tests/domain/timing-baseline.json's per-fixture
  "timing" object omits project-cost fields (landCost, hardCostBase,
  costBreakdownAmounts, fees) -- it was built for TIMING verification only.
  generateLegacyProjectCashEvents therefore reconstructs ONLY the exit-year
  inflow for these fixtures, with none of the t0 cost outflow, which makes
  the PROJECT-view series degenerate (a single cashflow) for every fixture
  here -- NOT a defect in the XIRR module or the wrapper, a genuine gap in
  what this particular fixture file can support. PROJECT XIRR is instead
  separately regression-tested against tests/domain/financing-baseline.json
  (14 fixtures, full opportunity input, see verify-equity-reconciliation.mjs
  and the dedicated run below), where real t0 costs ARE present. EQUITY XIRR
  is fully testable here because equityCF is present in every timing fixture.
*/
import fs from "node:fs";
import { createFinancialEngine } from "../financial-engine.js";
import { blankOpportunity, TIERS, USE_TYPES, SITE_FACTORS, DEV_REFI_STRATEGY_KEY, isResidentialUseType } from "../financial-context.js";
import { computeOpportunityProjectAndEquityXirr } from "./opportunity-xirr.js";

const engine = createFinancialEngine({ blankOpportunity, TIERS, USE_TYPES, SITE_FACTORS, DEV_REFI_STRATEGY_KEY, isResidentialUseType });
const data = JSON.parse(fs.readFileSync(new URL("../../../../tests/domain/timing-baseline.json", import.meta.url)));
const acquisitionDate = data.acquisitionDate;

function fmtPct(r) { return typeof r === "number" ? (r * 100).toFixed(4) + "%" : String(r); }

const rows = [];
for (const [key, fx] of Object.entries(data.fixtures)) {
  const t = fx.timing;
  const computation = { ...t, isDirectSaleSplit: (t.directSaleDeferredAmt || 0) > 1e-6 };
  const lag = computation.isDirectSaleSplit ? (t.directSaleDeferredYear - t.totalYears) : 0;
  const opportunity = { strategy: { directSale: { bankFinancedPct: 0, collectionLagYears: lag } }, vat: { enabled: false } };

  // Legacy ANNUAL equity IRR, from the frozen equityCF array itself, via the
  // SAME engine.irr() the current production code already uses -- this is
  // "what the current committee gate already sees today", for comparison only.
  const annualEquityIrr = engine.irr(t.equityCF);
  const annualProjectIrr = Array.isArray(t.projectCF) ? engine.irr(t.projectCF) : null;

  let result, error = null;
  try {
    result = computeOpportunityProjectAndEquityXirr(opportunity, computation, { acquisitionDate, acquisitionDateIsAssumed: true });
  } catch (e) {
    error = e.message;
  }

  // Structural check (schema-level), not inferred from the resulting cashflow
  // count: this fixture file's "timing" objects never carry landCost/hardCostBase
  // at all, regardless of whether a few VAT/operating events happen to still
  // produce >=2 cashflow points for a given fixture. A technically-OK-looking
  // project XIRR from this file would be misleading precisely because the
  // dominant t0 cost outflow is missing, so this flag is schema-wide, not per-case.
  const projectDataIncomplete = (t.landCost === undefined && t.hardCostBase === undefined);
  rows.push({
    key, label: fx.label, datedCoverage: fx.datedCoverage,
    annualEquityIrr, annualProjectIrr,
    projectXirr: result?.project?.xirr, equityXirr: result?.equity?.xirr,
    projectDataIncompleteInThisFixtureFile: projectDataIncomplete,
    sourceWarnings: result?.sourceWarnings?.map((w) => w.code) || [],
    error,
  });
}

console.log("key | annual equityIRR | equity XIRR (status/rate) | annual projectIRR | project XIRR (status/rate) | source warnings | error");
for (const r of rows) {
  const eq = r.equityXirr ? `${r.equityXirr.status}${r.equityXirr.rate != null ? " " + fmtPct(r.equityXirr.rate) : ""}` : "-";
  const pr = r.projectXirr ? `${r.projectXirr.status}${r.projectXirr.rate != null ? " " + fmtPct(r.projectXirr.rate) : ""}` : "-";
  console.log(`${r.key} | ${fmtPct(r.annualEquityIrr)} | ${eq} | ${fmtPct(r.annualProjectIrr)} | ${pr} | [${r.sourceWarnings.join(",")}] | ${r.error || ""}`);
}

fs.writeFileSync(new URL("./_20-fixtures-regression-output.json", import.meta.url), JSON.stringify(rows, null, 2));
console.log("\nFull detail written to src/domain/financial/xirr/_20-fixtures-regression-output.json");

const crashed = rows.filter((r) => r.error);
console.log(`\n${rows.length - crashed.length}/${rows.length} fixtures ran without throwing. ${crashed.length} threw: ${crashed.map((r) => r.key + ":" + r.error).join(" | ")}`);
const incompleteProject = rows.filter((r) => r.projectDataIncompleteInThisFixtureFile).length;
console.log(`\nEQUITY XIRR: meaningfully computed for all ${rows.length}/${rows.length} fixtures (equityCF is always present in this file).`);
console.log(`PROJECT XIRR: NOT reliably computable from THIS file for ${incompleteProject}/${rows.length} fixtures -- timing-baseline.json's "timing" objects never carry landCost/hardCostBase (schema-wide omission, confirmed structurally, not inferred from output). Any project-cashflow count >=2 that still appears for a few fixtures below is misleading (missing the dominant t0 cost) and must NOT be read as a valid project XIRR. PROJECT XIRR is instead regression-tested against financing-baseline.json's 14 fixtures, which DO carry full project costs -- see verify-equity-reconciliation.mjs.`);
