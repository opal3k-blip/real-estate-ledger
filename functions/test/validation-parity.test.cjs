'use strict';
/* =========================================================================
   Phase 3A-3 — client/server parity.
   ---------------------------------------------------------------------------
   The browser classifies with src/core.js (withDefaults + compute) and the SOURCE modules in src/domain/validation.
   The server classifies with the generated bundle through trusted-ic.cjs. This test feeds the SAME stored documents to
   both and requires an identical verdict: status, colour, blocked flag, every issue code and path, every high-risk
   reason, and the compound-warning decision. Any divergence is a failure, so a deployment can never judge differently
   from what the approver saw on screen.
   Server-only structural rejections (unsafe keys, depth, work bounds, snapshot size, non-finite anywhere) are allowed to
   be STRICTER than the client, but a document the server rejects must never be green/yellow on the client when the
   cause is a field the validation engine covers.
   ========================================================================= */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { recompute } = require('../trusted-ic.cjs');
const { readyFixture, setPath, clone } = require('./helpers/ic-fixtures.cjs');

const root = path.resolve(__dirname, '../..');
const imp = rel => import(pathToFileURL(path.join(root, rel)).href);
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`OK ${name}`); }

(async () => {
  const { loadCore } = await imp('tests/domain/core-vm-harness.mjs');
  const { classifyOpportunity, verdictSummary } = await imp('src/domain/validation/risk-classification.js');
  const { FIELD_RULES } = await imp('src/domain/validation/input-validation-engine.js');
  const C = loadCore(['opportunities']);

  function clientVerdict(stored) {
    const input = Object.fromEntries(Object.entries(clone(stored)).filter(([k]) => k !== 'ic'));
    const d = C.withDefaults(input);
    return verdictSummary(classifyOpportunity(d, C.compute(d)));
  }
  async function serverOutcome(stored) {
    try { return { verdict: (await recompute(stored, Date.UTC(2026, 9, 6))).verdict }; }
    catch (e) { return { rejected: e.rejectionCode || 'OTHER:' + e.message }; }
  }
  const STRUCTURAL = new Set(['UNSAFE_KEY', 'TOO_DEEP', 'HORIZON_OUT_OF_BOUNDS', 'SNAPSHOT_TOO_LARGE', 'UNSUPPORTED_TYPE', 'NON_FINITE_INPUT', 'COMPUTE_FAILED', 'READINESS_FAILED']);
  let compared = 0; const divergences = [];
  async function compare(label, stored) {
    const s = await serverOutcome(stored);
    if (s.rejected) {
      // Structurally rejected by the server BEFORE any computation. The client is intentionally NOT run on these documents:
      // src/core.js computes before it validates, so a horizon of 1e9 years would freeze it (a pre-existing client hazard
      // the server is protected from by validateWorkBounds). Covered fields are proven red on the client by the engine tests.
      if (!STRUCTURAL.has(s.rejected)) divergences.push(`${label}: unexpected server rejection ${s.rejected}`);
      compared++;
      return { s, c: { blocked: true, skipped: true } };
    }
    let c;
    try { c = clientVerdict(stored); } catch (e) { c = { blocked: true, status: 'ERROR', thrown: true }; }
    compared++;
    try { assert.deepStrictEqual(JSON.parse(JSON.stringify(s.verdict)), JSON.parse(JSON.stringify(c))); }
    catch (e) { divergences.push(`${label}: verdict differs\n  server=${JSON.stringify(s.verdict).slice(0, 400)}\n  client=${JSON.stringify(c).slice(0, 400)}`); }
    return { s, c };
  }

  await test('the validation modules shipped to the server are byte-identical (LF-normalised) to the source the browser runs', async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../generated/manifest.json'), 'utf8'));
    for (const f of ['src/domain/validation/input-validation-engine.js', 'src/domain/validation/debt-coverage.js', 'src/domain/validation/risk-classification.js']) {
      assert.ok(manifest.files[f], `${f} is in the manifest`);
      const a = fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
      const b = fs.readFileSync(path.join(__dirname, '../generated', f), 'utf8').replace(/\r\n/g, '\n');
      assert.equal(a, b, `${f} generated copy is stale`);
    }
  });

  await test('the 34 reference fixtures: identical verdict on client and server (status, colour, codes, high-risk reasons, compound decision)', async () => {
    const files = ['tests/domain/financial-golden-master.json', 'tests/domain/financing-baseline.json'];
    let n = 0;
    for (const f of files) {
      const fx = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')).fixtures;
      for (const [k, v] of Object.entries(fx)) { await compare(`fixture ${k}`, clone(v.input || v.d)); n++; }
    }
    assert.equal(n, 34);
    assert.deepEqual(divergences, []);
  });

  const ready = await readyFixture();
  const loose = clone(ready); Object.assign(loose.criteria, { irrMin: -1, projIrrMin: -1, moicMin: 0, dscrMin: null });
  await test('adversarial matrix (LTC, boundaries, thresholds, strings, compound risk): identical verdict', async () => {
    const cases = [];
    for (const v of [1.8, 180, 1, 0.85, 0.86, 0.9, -0.2, -1e-15, '0.6', 'abc', null, '', true, [0.6], {}, NaN, Infinity, 1e308, 0.6, 0]) cases.push([`ltc=${String(JSON.stringify(v))}`, 'financing.ltc', v]);
    for (const [p, v] of [['land.area', Number.EPSILON], ['land.area', 1], ['land.area', 0.5], ['land.area', 0], ['land.area', 1e8], ['land.area', 1e8 + 1], ['land.price', 1e12], ['land.price', 1e12 + 1], ['land.price', -0],
      ['development.constructionYears', 100], ['development.constructionYears', 100.0000001], ['development.constructionYears', '2'], ['financing.saibor', 1], ['financing.saibor', 1.0000001], ['financing.saibor', '0.05'],
      ['criteria.dscrMin', -5], ['criteria.dscrMin', 0.5], ['criteria.dscrMin', 1.3], ['criteria.dscrMin', '1.2'], ['criteria.irrMin', -1], ['criteria.irrMin', -1.0000001], ['criteria.preSaleActual', 5],
      ['strategy.salePct', 7], ['strategy.salePct', 0.07], ['economics.carry', 1], ['development.efficiency', 3.5], ['exitCosts.rett', 2], ['financing.seniorPct', 1.5], ['financing.drawSchedulePct', [0.7, 0.7]]]) cases.push([`${p}=${JSON.stringify(v)}`, p, v]);
    for (const [label, doc] of [['base', ready], ['loose', loose]]) {
      for (const [l, p, v] of cases) { const o = clone(doc); setPath(o, p, v); await compare(`${label}:${l}`, o); }
    }
    for (let n = 1; n <= 4; n++) {
      const o = clone(loose);
      [['financing.ltc', 0.9], ['financing.saibor', 0.25], ['development.exitCapRate', 0.25], ['development.constructionYears', 12]].slice(0, n).forEach(([p, v]) => setPath(o, p, v));
      const { s, c } = await compare(`compound x${n}`, o);
      assert.equal(s.verdict.compound.count, n); assert.equal(c.compound.count, n);
      assert.equal(s.verdict.compound.requiresAcknowledgement, n >= 2);
    }
    assert.deepEqual(divergences, []);
  });

  await test('seeded fuzz (600 documents, 1-3 mutations each over every validated field): identical verdict or a documented stricter structural rejection', async () => {
    let seed = 20261006;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const pick = a => a[Math.floor(rnd() * a.length)];
    const hostile = [null, '', 'abc', '1', '0.5', true, false, [], [1], {}, NaN, Infinity, -Infinity, -0, 0, -1, 1, 2, 100, 1e-300, 1e300, Number.EPSILON, Number.MAX_VALUE, -Number.MAX_VALUE, 0.1 + 0.2];
    const docs = [ready, loose];
    for (const f of ['tests/domain/financial-golden-master.json', 'tests/domain/financing-baseline.json']) {
      for (const v of Object.values(JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')).fixtures)) docs.push(v.input || v.d);
    }
    const before = divergences.length; let rejected = 0, blocked = 0, ok = 0;
    for (let i = 0; i < 600; i++) {
      const o = clone(pick(docs));
      const k = 1 + Math.floor(rnd() * 3); const used = [];
      for (let j = 0; j < k; j++) {
        const rule = pick(FIELD_RULES); const v = rnd() < 0.5 ? pick(hostile) : (rnd() * (rule.max || 2) * (rnd() < 0.3 ? 10 : 1));
        // a JSON round-trip cannot carry NaN/Infinity; set them after cloning so the stored doc keeps them (as Firestore can)
        setPath(o, rule.path, v); used.push(`${rule.path}=${typeof v === 'number' ? String(v) : JSON.stringify(v)}`);
      }
      const { s, c } = await compare(`fuzz#${i} [${used.join(', ')}]`, o);
      if (s.rejected) rejected++; else if (c.blocked) blocked++; else ok++;
    }
    console.log(`   fuzz outcomes: ${ok} not blocked, ${blocked} blocked by the engine, ${rejected} stricter structural rejection`);
    assert.ok(ok > 30 && blocked > 30, 'the fuzz must exercise both outcomes');
    assert.deepEqual(divergences.slice(before), []);
  });

  await test('stored documents that carry an ic history and stray non-financial fields are classified from the inputs only (same on both sides)', async () => {
    const o = clone(ready); o.ic = { decisions: [{ decision: 'hold', note: 'x' }] }; o.notes = 'n'; o.extra = { a: [1, 2, 3] };
    await compare('with ic+extra', o); assert.deepEqual(divergences, []);
  });

  console.log(`\n${passed}/${passed} parity tests passed over ${compared} compared documents (client source vs server bundle).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
