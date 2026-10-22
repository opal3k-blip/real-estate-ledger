/* =========================================================================
   Is the `ambiguousZero` branch of computeOpportunityXirr reachable from
   PUBLIC inputs (ISO dates + finite amounts)?

   Premise under test: ambiguousZero (classificationAmbiguous) can only be true
   if some calendar-year bucket of the whole-year polynomial receives MORE THAN
   ONE aggregated cashflow, so that its net can sit near its own noise floor
   (localAbsSum * LOCAL_FLOAT_NOISE_REL_EPS). But the whole-year path only runs
   when EVERY date is within 1e-9 years of an integer; distinct ISO dates differ
   by >= 1 day = 1/365 year, so two distinct dates can never land in the same
   integer-year bucket, and same-DATE duplicates are already summed into one
   entry by normalizeCashflows BEFORE the polynomial is built. Hence
   localAbsSum[y] === |coeff[y]| for every nonempty year, the ratio is the
   constant 1/LOCAL_FLOAT_NOISE_REL_EPS (~4.5e11), and the ambiguous band
   (0.1 .. 10) is never entered.

   This script checks that premise two ways, without changing the algorithm:
     A. Structural, on the REAL exported normalizeCashflows: over a seeded fuzz
        of whole-year-aligned inputs (incl. duplicate same-date entries and
        near-cancelling pairs), no two cashflows ever share an integer-year bucket.
     B. Dynamic: an instrumented COPY of xirr-opportunity.js (the same source with
        a counter spliced into classificationAmbiguous; the splice points are
        asserted to exist) is run on the same fuzz; classificationAmbiguous must be
        CALLED (so the probe is live) and must NEVER return true.
   Outcome: unreachable from current public inputs -> no "no proof under
   ambiguity" case can be constructed through the public API. The defensive code
   stays; the day this check fails (e.g. INTEGER_TOL loosened, or per-year
   bucketing changed) a reachable ambiguity must get its own test.

   Run: node src/domain/financial/xirr/verify-ambiguouszero-reachability.mjs
   ========================================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeCashflows } from './xirr-opportunity.js';

let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS ', l); } else { fail++; console.log('FAIL ', l, d ? JSON.stringify(d) : ''); } };

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20261005);
const isoPlusDays = (days) => new Date(Date.UTC(2026, 0, 1) + days * 86400000).toISOString().slice(0, 10);
const logUniform = (lo, hi) => Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * rnd());

function genWholeYearCase() {
  const nYears = 2 + Math.floor(rnd() * 14);
  const years = new Set([0, 1 + Math.floor(rnd() * nYears)]);
  const extra = Math.floor(rnd() * nYears);
  for (let i = 0; i < extra; i++) years.add(Math.floor(rnd() * (nYears + 1)));
  const cfs = [];
  for (const y of years) {
    const date = isoPlusDays(y * 365);
    const a = (rnd() < 0.5 ? -1 : 1) * logUniform(1e-9, 1e12);
    cfs.push({ date, amount: a });
    const dup = rnd();
    if (dup < 0.25) cfs.push({ date, amount: -a * (1 + (rnd() - 0.5) * 1e-12) }); // near-cancelling SAME-date pair
    else if (dup < 0.4) cfs.push({ date, amount: (rnd() < 0.5 ? -1 : 1) * logUniform(1e-9, 1e12) });
  }
  return cfs;
}

const N = 3000;
const cases = Array.from({ length: N }, genWholeYearCase);

/* A. structural premise on the real normalizeCashflows */
let aligned = 0, collisions = 0, nonLocal = 0;
for (const c of cases) {
  const n = normalizeCashflows(c);
  if (!n.ok) continue;
  if (!n.cashflows.every((cf) => Math.abs(cf.years - Math.round(cf.years)) < 1e-9)) continue;
  aligned++;
  const seen = new Set();
  for (const cf of n.cashflows) { const y = Math.round(cf.years); if (seen.has(y)) collisions++; seen.add(y); }
}
check(`A. ${aligned} whole-year-aligned normalized series: zero integer-year bucket collisions`, aligned > 1000 && collisions === 0, { aligned, collisions });

/* B. dynamic probe on an instrumented copy of the real module source */
const src = fs.readFileSync(new URL('./xirr-opportunity.js', import.meta.url), 'utf8');
const fnHead = 'function classificationAmbiguous(rawCoeffs, localAbsSum) {';
const hitLine = 'if (ratio > 1 / LOCAL_AMBIGUOUS_MARGIN && ratio < LOCAL_AMBIGUOUS_MARGIN) return true;';
check('B0. splice points exist in the real source', src.includes(fnHead) && src.includes(hitLine));
const inst = src.replace(fnHead, fnHead + ' globalThis.__ambigProbe.calls++;').replace(hitLine, 'if (ratio > 1 / LOCAL_AMBIGUOUS_MARGIN && ratio < LOCAL_AMBIGUOUS_MARGIN) { globalThis.__ambigProbe.hits++; return true; }');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xirr-probe-')), 'xirr-opportunity.probe.mjs');
fs.writeFileSync(tmp, inst);
globalThis.__ambigProbe = { calls: 0, hits: 0 };
const probe = await import(pathToFileURL(tmp).href);
let statuses = {};
for (const c of cases) { const r = probe.computeOpportunityXirr(c); statuses[r.status] = (statuses[r.status] || 0) + 1; }
check(`B1. probe is live: classificationAmbiguous was called ${globalThis.__ambigProbe.calls} times`, globalThis.__ambigProbe.calls > 1000, globalThis.__ambigProbe);
check('B2. classificationAmbiguous NEVER returned true on any fuzz input (ambiguousZero unreachable)', globalThis.__ambigProbe.hits === 0, globalThis.__ambigProbe);
console.log('   status mix over the fuzz:', JSON.stringify(statuses));
try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
