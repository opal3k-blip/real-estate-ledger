'use strict';
/* =========================================================================
   Phase 3A-3 follow-up — PROPERTY-BASED parity (fast-check, devDependency only).
   ---------------------------------------------------------------------------
   The seeded fuzz in validation-parity.test.cjs is a fixed sample. This file generates new random documents on EVERY
   run (random seed, printed first) and requires:
     P1  parity      — for any generated stored document, the server verdict equals the client verdict
                       (or the server refuses it structurally, before any computation);
     P2  invariants  — blocked <=> colour red; green <=> status OK with zero high-risk reasons;
                       requiresAcknowledgement <=> (not blocked and count >= threshold); highRisk.flag <=> count > 0.
   On any failure fast-check shrinks to a minimal counter-example and prints the seed. Reproduce exactly with:
       PARITY_SEED=<seed> PARITY_RUNS=<n> node test/validation-parity.property.test.cjs
   Environment: PARITY_SEED (default: random), PARITY_RUNS (default 250; CI may raise it).
   ========================================================================= */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fc = require('fast-check');
const { recompute } = require('../trusted-ic.cjs');
const { readyFixture, setPath, clone } = require('./helpers/ic-fixtures.cjs');

const root = path.resolve(__dirname, '../..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
const STRUCTURAL = new Set(['UNSAFE_KEY', 'TOO_DEEP', 'HORIZON_OUT_OF_BOUNDS', 'SNAPSHOT_TOO_LARGE', 'UNSUPPORTED_TYPE', 'NON_FINITE_INPUT', 'COMPUTE_FAILED', 'READINESS_FAILED']);

const seed = process.env.PARITY_SEED !== undefined ? Number(process.env.PARITY_SEED) : (Date.now() ^ (process.pid << 8)) >>> 0;
const numRuns = Number(process.env.PARITY_RUNS || 250);
console.log(`PARITY_SEED=${seed} PARITY_RUNS=${numRuns}`);

(async () => {
  const { loadCore } = await imp('tests/domain/core-vm-harness.mjs');
  const { classifyOpportunity, verdictSummary } = await imp('src/domain/validation/risk-classification.js');
  const { FIELD_RULES } = await imp('src/domain/validation/input-validation-engine.js');
  const C = loadCore(['opportunities']);

  const ready = await readyFixture();
  const loose = clone(ready); Object.assign(loose.criteria, { irrMin: -1, projIrrMin: -1, moicMin: 0, dscrMin: null });
  const bases = [ready, loose];
  for (const f of ['tests/domain/financial-golden-master.json', 'tests/domain/financing-baseline.json']) {
    for (const v of Object.values(JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')).fixtures)) bases.push(v.input || v.d);
  }

  const clientVerdict = (stored) => {
    const input = Object.fromEntries(Object.entries(clone(stored)).filter(([k]) => k !== 'ic'));
    const d = C.withDefaults(input);
    return verdictSummary(classifyOpportunity(d, C.compute(d)));
  };
  const serverOutcome = async (stored) => {
    try { return { verdict: (await recompute(stored, Date.UTC(2026, 9, 6))).verdict }; }
    catch (e) { return { rejected: e.rejectionCode || 'OTHER:' + e.message }; }
  };

  // ---- generators -------------------------------------------------------------------------------------------------
  const paths = FIELD_RULES.map(r => r.path);
  // the high-risk fields get extra weight so compound combinations are common, not rare
  const riskPaths = ['financing.ltc', 'financing.saibor', 'financing.margin', 'development.constructionYears', 'development.exitCapRate'];
  const awkward = [null, '', 'abc', '1', '0.5', ' 7 ', true, false, [], [1], {}, -0, 0, -1, 1, 2, 100, 1e-300, 1e300, Number.EPSILON, Number.MAX_VALUE, -Number.MAX_VALUE, 0.1 + 0.2, 1e8, 1e8 + 1, 1e12, 1e12 + 1];
  const value = fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom(...awkward) },
    { weight: 2, arbitrary: fc.double({ noNaN: false, noDefaultInfinity: false }) },       // includes NaN / ±Infinity
    { weight: 3, arbitrary: fc.double({ min: 0, max: 1, noNaN: true }) },                   // fractions
    { weight: 2, arbitrary: fc.double({ min: 0, max: 40, noNaN: true }) },
    { weight: 1, arbitrary: fc.integer({ min: -5, max: 150 }) },
    { weight: 1, arbitrary: fc.string({ maxLength: 6 }) },
    { weight: 1, arbitrary: fc.double({ min: -1e-9, max: 1e-9, noNaN: true }) });          // tiny values near zero
  const mutation = fc.oneof(
    { weight: 3, arbitrary: fc.tuple(fc.constantFrom(...paths), value) },
    { weight: 2, arbitrary: fc.tuple(fc.constantFrom(...riskPaths), fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom(0.9, 0.25, 12, 0.6, 0.05))) });
  const docArb = fc.record({ base: fc.nat({ max: bases.length - 1 }), muts: fc.array(mutation, { minLength: 1, maxLength: 5 }) });
  const build = ({ base, muts }) => { const o = clone(bases[base]); for (const [p, v] of muts) setPath(o, p, v); return o; };

  let compared = 0, skipped = 0, blocked = 0, ack = 0;
  const params = { seed, numRuns, verbose: 0 };
  const failHint = `reproduce: PARITY_SEED=${seed} PARITY_RUNS=${numRuns} node test/validation-parity.property.test.cjs`;

  try {
    await fc.assert(fc.asyncProperty(docArb, async (g) => {
      const doc = build(g);
      const s = await serverOutcome(doc);
      compared++;
      if (s.rejected) {
        // stricter structural rejection happens BEFORE any computation; the client is not run (pre-existing hang hazard on huge horizons)
        skipped++;
        assert.ok(STRUCTURAL.has(s.rejected), `unexpected server rejection ${s.rejected}`);
        return;
      }
      const v = s.verdict;
      // P2 invariants
      assert.equal(v.blocked, v.color === 'red', 'blocked <=> red');
      assert.equal(v.color === 'green', v.status === 'OK' && v.highRiskCodes.length === 0, 'green <=> OK with no high-risk reasons');
      assert.equal(v.compound.requiresAcknowledgement, !v.blocked && v.compound.count >= v.compound.threshold, 'acknowledgement rule');
      assert.equal(v.compound.count, v.highRiskCodes.length, 'count equals the reasons');
      assert.equal(v.highRisk, v.highRiskCodes.length > 0, 'flag equals presence of reasons');
      if (v.blocked) blocked++; if (v.compound.requiresAcknowledgement) ack++;
      // P1 parity
      let c;
      try { c = clientVerdict(doc); } catch (e) { c = { status: 'ERROR', thrown: String(e && e.message) }; }
      assert.deepStrictEqual(JSON.parse(JSON.stringify(v)), JSON.parse(JSON.stringify(c)), 'client and server verdicts must be identical');
    }), params);
  } catch (e) {
    console.error('\nPROPERTY FAILED — ' + failHint);
    console.error(String(e && e.message || e).split('\n').slice(0, 25).join('\n'));
    process.exitCode = 1;
    return;
  }
  assert.ok(compared >= numRuns, 'all runs executed');
  console.log(`OK property parity + invariants: ${numRuns} random documents (${skipped} structural rejections, ${blocked} blocked, ${ack} needing acknowledgement; every one identical on client and server).`);
})().catch(error => { console.error(error); console.error(`reproduce: PARITY_SEED=${seed} PARITY_RUNS=${numRuns} node test/validation-parity.property.test.cjs`); process.exitCode = 1; });
