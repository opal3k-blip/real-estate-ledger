/* =========================================================================
   Scale-invariance check (explicit instruction): multiplying every cashflow
   amount by a positive constant must NOT change the computed rate, status,
   or (where applicable) root count -- the unit of currency used must never
   affect the classification. Run across all 16 reference cases plus the two
   dedicated no-real-root / multiple-roots cases, at several very different
   scales (1, 0.0001, 1000, 1e6, 1e-7) to probe both directions.
   Run: node src/domain/financial/xirr/verify-scale-invariance.mjs
   ========================================================================= */
import { computeOpportunityXirr } from "./xirr-opportunity.js";

const SCALES = [1, 1000, 1e6, 0.001, 1e-7];

const CASES = [
  { name: "simple 1yr", cf: [{ date: "2026-01-01", amount: -100 }, { date: "2027-01-01", amount: 110 }] },
  { name: "leap-year span", cf: [{ date: "2028-01-01", amount: -100 }, { date: "2029-01-01", amount: 110 }] },
  { name: "MS doc example", cf: [
    { date: "2008-01-01", amount: -10000 }, { date: "2008-03-01", amount: 2750 },
    { date: "2008-10-30", amount: 4250 }, { date: "2009-02-15", amount: 3250 },
    { date: "2009-04-01", amount: 2750 },
  ] },
  { name: "no real root (quadratic)", cf: [
    { date: "2026-01-01", amount: -100 }, { date: "2027-01-01", amount: 300 }, { date: "2028-01-01", amount: -250 },
  ] },
  { name: "multiple roots (0%, 50%)", cf: [
    { date: "2026-01-01", amount: -1 }, { date: "2027-01-01", amount: 2.5 }, { date: "2028-01-01", amount: -1.5 },
  ] },
  { name: "tangent root at 0%", cf: [
    { date: "2026-01-01", amount: -100 }, { date: "2027-01-01", amount: 200 }, { date: "2028-01-01", amount: -100 },
  ] },
  { name: "real-estate-scale good deal", cf: [
    { date: "2026-01-01", amount: -50136115.60000001 }, { date: "2027-01-01", amount: -2406533.5488 }, { date: "2028-01-01", amount: 60511797.09 },
  ] },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const results = SCALES.map((s) => computeOpportunityXirr(c.cf.map((cf) => ({ date: cf.date, amount: cf.amount * s }))));
  const statuses = results.map((r) => r.status);
  const rates = results.map((r) => r.rate);
  const rootCounts = results.map((r) => (r.roots ? r.roots.length : (r.status === "OK" ? 1 : 0)));

  const statusesAgree = statuses.every((s) => s === statuses[0]);
  const ratesAgree = rates.every((r) => (r == null && rates[0] == null) || (typeof r === "number" && typeof rates[0] === "number" && Math.abs(r - rates[0]) < 1e-6));
  const rootCountsAgree = rootCounts.every((n) => n === rootCounts[0]);

  const ok = statusesAgree && ratesAgree && rootCountsAgree;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`   statuses across scales ${JSON.stringify(SCALES)}: ${JSON.stringify(statuses)}`);
  console.log(`   rates: ${JSON.stringify(rates)}`);
  console.log(`   rootCounts: ${JSON.stringify(rootCounts)}`);
  if (ok) pass++; else fail++;
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
