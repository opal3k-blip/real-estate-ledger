'use strict';
/* =========================================================================
   Phase 3A-3 — deployment guard.
   A stale functions/generated would run an OLD copy of the domain logic in production. These tests prove the guards
   that stop it: the build check detects every kind of drift, the server refuses to start from a damaged bundle, and the
   policy files (firebase.json, functions/package.json, CI) cannot silently lose the gate.
   ========================================================================= */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`OK ${name}`); }
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

// A throw-away copy of exactly what the build needs: source modules + the whole functions/ folder (without node_modules).
function makeRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opal-deploy-guard-'));
  fs.cpSync(path.join(root, 'src/domain'), path.join(tmp, 'src/domain'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src/features'), { recursive: true });
  fs.copyFileSync(path.join(root, 'src/features/ic-decision-gate.js'), path.join(tmp, 'src/features/ic-decision-gate.js'));
  fs.cpSync(path.join(root, 'functions'), path.join(tmp, 'functions'), { recursive: true, filter: s => !s.includes('node_modules') });
  return tmp;
}
function check(tmp) {
  try { execFileSync(process.execPath, [path.join(tmp, 'functions/scripts/build-domain.cjs'), '--check'], { stdio: 'pipe' }); return { ok: true }; }
  catch (e) { return { ok: false, message: String(e.stderr || e.message) }; }
}
function build(tmp) { execFileSync(process.execPath, [path.join(tmp, 'functions/scripts/build-domain.cjs')], { stdio: 'pipe' }); }
const withRoot = async fn => { const tmp = makeRoot(); try { await fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); } };

(async () => {
  await test('the committed bundle is up to date right now (check:domain passes on the real repository)', async () => {
    execFileSync(process.execPath, [path.join(root, 'functions/scripts/build-domain.cjs'), '--check'], { stdio: 'pipe' });
  });
  await test('editing a source module WITHOUT rebuilding is detected (stale logic can not ship)', async () => {
    await withRoot(async tmp => {
      assert.equal(check(tmp).ok, true);
      fs.appendFileSync(path.join(tmp, 'src/domain/validation/risk-classification.js'), '\n// edited, not rebuilt\n');
      const r = check(tmp); assert.equal(r.ok, false); assert.match(r.message, /Stale domain bundle: src\/domain\/validation\/risk-classification\.js/);
    });
  });
  for (const f of ['src/domain/validation/input-validation-engine.js', 'src/domain/validation/debt-coverage.js', 'src/domain/validation/risk-classification.js', 'src/domain/financial/financial-engine.js']) {
    await test(`a single changed byte in generated/${f} is detected`, async () => {
      await withRoot(async tmp => {
        fs.appendFileSync(path.join(tmp, 'functions/generated', f), ' ');
        assert.equal(check(tmp).ok, false);
      });
    });
  }
  await test('an unexpected extra file inside generated/ is detected', async () => {
    await withRoot(async tmp => {
      fs.writeFileSync(path.join(tmp, 'functions/generated/src/domain/validation/old-copy.js'), 'export const x = 1;\n');
      const r = check(tmp); assert.equal(r.ok, false); assert.match(r.message, /Unexpected file/);
    });
  });
  await test('a deleted generated file and a deleted manifest are detected', async () => {
    await withRoot(async tmp => {
      fs.rmSync(path.join(tmp, 'functions/generated/src/domain/validation/debt-coverage.js')); assert.equal(check(tmp).ok, false);
    });
    await withRoot(async tmp => {
      fs.rmSync(path.join(tmp, 'functions/generated/manifest.json')); assert.equal(check(tmp).ok, false);
    });
  });
  await test('rebuilding restores a passing check, and LF/CRLF checkouts hash identically (Windows safe)', async () => {
    await withRoot(async tmp => {
      fs.appendFileSync(path.join(tmp, 'src/domain/validation/debt-coverage.js'), '\n// intended change\n');
      assert.equal(check(tmp).ok, false); build(tmp); assert.equal(check(tmp).ok, true);
      for (const f of ['src/domain/validation/risk-classification.js', 'functions/generated/src/domain/validation/risk-classification.js']) {
        const p = path.join(tmp, f); fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/\n/g, '\r\n'));
      }
      assert.equal(check(tmp).ok, true, 'CRLF working-tree copies of source and bundle still verify');
    });
  });
  await test('the server REFUSES to load a damaged bundle (integrity failure, missing file, forged manifest) — no silent fallback', async () => {
    const cases = [
      ['changed byte', tmp => fs.appendFileSync(path.join(tmp, 'functions/generated/src/domain/validation/risk-classification.js'), ' ')],
      ['missing module', tmp => fs.rmSync(path.join(tmp, 'functions/generated/src/domain/validation/risk-classification.js'))],
      ['missing manifest', tmp => fs.rmSync(path.join(tmp, 'functions/generated/manifest.json'))],
      ['forged manifest hash', tmp => { const m = path.join(tmp, 'functions/generated/manifest.json'); const j = JSON.parse(fs.readFileSync(m, 'utf8')); j.engineVersion = 'f'.repeat(64); fs.writeFileSync(m, JSON.stringify(j)); }],
    ];
    for (const [name, damage] of cases) {
      await withRoot(async tmp => {
        damage(tmp);
        const run = "require('./trusted-ic.cjs').loadEngine().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(7)})";
        assert.throws(() => execFileSync(process.execPath, ['-e', run], { cwd: path.join(tmp, 'functions'), stdio: 'pipe' }), e => e.status === 7, name);
      });
    }
  });
  await test('every domain file the server relies on for validation is in the build list', async () => {
    const src = read('functions/scripts/build-domain.cjs');
    for (const f of ['input-validation-engine.js', 'debt-coverage.js', 'risk-classification.js']) assert.ok(src.includes(`src/domain/validation/${f}`), f);
  });

  console.log('\n== policy: the gate cannot silently disappear ==');
  const firebase = JSON.parse(read('firebase.json'));
  const pkg = JSON.parse(read('functions/package.json'));
  await test('firebase.json runs the predeploy gate for the functions codebase (covers a direct `firebase deploy`)', async () => {
    const fn = (Array.isArray(firebase.functions) ? firebase.functions : [firebase.functions]).find(f => f.source === 'functions');
    assert.ok(fn, 'functions codebase present');
    assert.ok(Array.isArray(fn.predeploy) && fn.predeploy.length > 0, 'predeploy hook present');
    assert.ok(fn.predeploy.some(c => /run\s+predeploy/.test(c) && /RESOURCE_DIR/.test(c)), 'predeploy calls the functions "predeploy" npm script');
  });
  await test('the npm predeploy script is the gate script; lint contains the domain drift check; test has a check:domain pre-hook', async () => {
    assert.match(pkg.scripts.predeploy, /scripts\/predeploy\.cjs/);
    assert.match(pkg.scripts.lint, /check:domain/); assert.match(pkg.scripts.pretest, /check:domain/);
    assert.match(pkg.scripts['check:domain'], /build-domain\.cjs --check/, 'check:domain uses --check');
    assert.ok(!/--force|--non-interactive.*--only/.test(pkg.scripts.deploy), 'deploy script does not bypass the gate');
    assert.match(pkg.scripts['deploy:emergency'], /deploy-emergency\.cjs/);
  });
  const plan = (env) => {
    try { return { code: 0, out: JSON.parse(execFileSync(process.execPath, [path.join(root, 'functions/scripts/predeploy.cjs'), '--plan'], { env: { ...process.env, EMERGENCY_REASON: '', ...env }, stdio: 'pipe' }).toString()) }; }
    catch (e) { return { code: e.status, out: JSON.parse(String(e.stdout)) }; }
  };
  await test('normal deploy gate: lint (with the drift check) THEN the whole test suite', async () => {
    const r = plan({}); assert.equal(r.code, 0); assert.equal(r.out.mode, 'normal');
    assert.deepEqual(r.out.steps, ['npm run lint', 'npm test']);
  });
  await test('emergency gate: needs a real reason; runs lint (drift check) but never skips it; skips only the long test suite', async () => {
    let r = plan({ EMERGENCY_REASON: 'short' }); assert.notEqual(r.code, 0); assert.equal(r.out.reasonOk, false);
    r = plan({ EMERGENCY_REASON: 'production outage in approvals' }); assert.equal(r.code, 0); assert.equal(r.out.mode, 'emergency');
    assert.deepEqual(r.out.steps, ['npm run lint']);
  });
  const runGate = (tmp, env) => {
    try { execFileSync(process.execPath, [path.join(tmp, 'functions/scripts/predeploy.cjs')], { cwd: path.join(tmp, 'functions'), env: { ...process.env, ...env }, stdio: 'pipe' }); return { code: 0 }; }
    catch (e) { return { code: e.status, err: String(e.stderr) }; }
  };
  await test('emergency deploy on a clean bundle passes and records one audit line (time, operator, host, reason, bundle version)', async () => {
    const tmp = makeRoot(); const log = path.join(tmp, 'emergency.log');
    try {
      const r = runGate(tmp, { EMERGENCY_REASON: 'production outage in approvals', EMERGENCY_LOG_FILE: log });
      assert.equal(r.code, 0);
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n'); assert.equal(lines.length, 1);
      const e = JSON.parse(lines[0]);
      assert.equal(e.event, 'EMERGENCY_DEPLOY'); assert.match(e.gate, /^passed/); assert.equal(e.reason, 'production outage in approvals');
      assert.ok(e.at && e.host && 'operator' in e && 'gitHead' in e); assert.match(e.engineVersion, /^[0-9a-f]{64}$/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  await test('emergency deploy with a drifted bundle is REFUSED (drift check is never skipped) and the refusal is logged', async () => {
    const tmp = makeRoot(); const log = path.join(tmp, 'emergency.log');
    try {
      fs.appendFileSync(path.join(tmp, 'functions/generated/src/domain/validation/risk-classification.js'), '\n// tampered\n');
      const r = runGate(tmp, { EMERGENCY_REASON: 'production outage in approvals', EMERGENCY_LOG_FILE: log });
      assert.notEqual(r.code, 0);
      const e = JSON.parse(fs.readFileSync(log, 'utf8').trim()); assert.match(e.gate, /^refused/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  await test('an emergency without a valid reason is refused and writes no audit line; deploy:emergency refuses before calling firebase', async () => {
    const tmp = makeRoot(); const log = path.join(tmp, 'emergency.log');
    try {
      assert.notEqual(runGate(tmp, { EMERGENCY_REASON: 'x', EMERGENCY_LOG_FILE: log }).code, 0);
      assert.ok(!fs.existsSync(log), 'no audit line for a refused request');
      let threw = false;
      try { execFileSync(process.execPath, [path.join(tmp, 'functions/scripts/deploy-emergency.cjs')], { env: { ...process.env, EMERGENCY_REASON: '' }, stdio: 'pipe' }); }
      catch (e) { threw = true; assert.notEqual(e.status, 0); assert.match(String(e.stderr), /EMERGENCY_REASON/); }
      assert.ok(threw, 'deploy:emergency without a reason must fail');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
  await test('the local emergency audit log is git-ignored (a run artefact, never committed)', async () => {
    assert.match(read('.gitignore'), /^functions\/emergency-deploys\.log\s*$/m);
  });
  await test('the npm test script runs every server-side validation suite (none can be dropped silently)', async () => {
    for (const t of ['p0-trusted-transaction-layer.test.js', 'trusted-ic.test.cjs', 'server-validation-enforcement.test.cjs', 'validation-parity.test.cjs', 'validation-parity.property.test.cjs', 'deploy-guard.test.cjs']) assert.ok(pkg.scripts.test.includes(t), t);
  });
  await test('CI runs the domain check first and fails when generated/ is not committed in sync', async () => {
    const ci = read('.github/workflows/ci.yml');
    assert.match(ci, /check:domain/); assert.match(ci, /functions\/generated/);
    assert.ok(ci.indexOf('check:domain') < ci.indexOf('JavaScript syntax check'), 'the domain check runs before the other suites');
    assert.match(ci, /git status --porcelain -- functions\/generated/);
  });

  console.log(`\n${passed}/${passed} deploy-guard tests passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
