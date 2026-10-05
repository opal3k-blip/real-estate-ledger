#!/usr/bin/env node
/* =========================================================================
   Deterministic verification-suite runner (Windows / Linux / macOS).

   Usage:  node scripts/run-verify-suite.mjs <group> [<group> ...]
   Groups: domain  xirr  features  tooling   (see GROUPS below)

   Design rules (all enforced, none left to shell behaviour):
   - NO shell glob expansion. Each group names one directory, an optional
     filename pattern and an EXPLICIT expected file list. Files are spawned
     with process.execPath (the same Node that runs this script) and an
     argument array, so no shell, PATH lookup or quoting is involved.
   - Preflight BEFORE running anything. The run is refused (exit 1) when:
       * a group directory is missing;
       * an expected test file is missing;
       * a file matches the group's pattern but is not in the expected list
         (an unlisted test would otherwise be silently skipped);
       * an expected entry looks like a generator (capture-*, golden-fixtures,
         anything that writes a Golden Master) or fails its own pattern;
       * the same file is listed twice, or the group selection is empty.
   - Fixed order: groups in the order given on the command line, files in
     plain code-point order (no locale collation).
   - A test FAILS when it exits non-zero, is killed by a signal, exceeds the
     per-test timeout, or cannot be spawned (e.g. Node not runnable).
     All tests still run after a failure so one report lists every failure.
   - Zero executed tests is a failure.
   - This runner never runs capture-* scripts or Golden Master generators.
   ========================================================================= */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Names that must never be executed by this runner (generators / writers of
// frozen baselines). Checked against every expected entry.
const FORBIDDEN = [/^capture-/i, /^golden-fixtures\./i, /golden-master.*generate/i];

export const GROUPS = {
  // tests/domain: the 15 tracked verify-*.mjs (capture-*.mjs are NOT matched).
  domain: {
    dir: 'tests/domain',
    pattern: /^verify-.*\.mjs$/,
    expected: [
      'verify-construction-spend-schedule.mjs',
      'verify-financial-authority-cutover.mjs',
      'verify-financial-event-model.mjs',
      'verify-financial-golden-master.mjs',
      'verify-financing-baseline.mjs',
      'verify-ic-readiness-shadow.mjs',
      'verify-legacy-cash-timing-events.mjs',
      'verify-legacy-dated-cashflow.mjs',
      'verify-legacy-direct-sale-events.mjs',
      'verify-legacy-financing-events.mjs',
      'verify-legacy-refinance-events.mjs',
      'verify-project-event-generators.mjs',
      'verify-server-financial-golden.mjs',
      'verify-shared-financial-engine.mjs',
      'verify-timing-baseline.mjs',
    ],
  },
  // XIRR shadow package: 1 validate-* + 13 verify-* = 14 scripts.
  xirr: {
    dir: 'src/domain/financial/xirr',
    pattern: /^(verify|validate)-.*\.mjs$/,
    expected: [
      'validate-descartes-sturm.mjs',
      'verify-20-fixtures-regression.mjs',
      'verify-ambiguouszero-reachability.mjs',
      'verify-direct-sale-no-double-count.mjs',
      'verify-domain-fix-and-ambiguity.mjs',
      'verify-equity-reconciliation.mjs',
      'verify-financing-fixtures-full-xirr.mjs',
      'verify-opal-bug5-guard-logic.mjs',
      'verify-opal-bug5-wrapper-e2e.mjs',
      'verify-opal-round-6-bugs.mjs',
      'verify-opal-round-7-bugs.mjs',
      'verify-scale-invariance.mjs',
      'verify-t19-direct-sale-sequence.mjs',
      'verify-xirr-opportunity-reference-cases.mjs',
    ],
  },
  // tests/features: same three tests that `npm run test:features` chains.
  features: {
    dir: 'tests/features',
    pattern: /\.test\.mjs$/,
    expected: [
      'asset-link-fund-sync.test.mjs',
      'capital-allocation-engine.landfirst.test.mjs',
      'fund-ledger-inkind-classification.test.mjs',
    ],
  },
  // The runner's own self-test (explicit file, no pattern discovery).
  tooling: {
    dir: 'scripts',
    pattern: null,
    expected: ['verify-run-verify-suite.mjs'],
  },
};

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}
function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Returns { errors: string[], plan: [{group, file, abs}] } without running anything. */
export function preflight(groups, names, root) {
  const errors = [];
  const plan = [];
  if (!Array.isArray(names) || names.length === 0) {
    errors.push('no group selected');
    return { errors, plan };
  }
  const seenGroups = new Set();
  for (const name of names) {
    if (seenGroups.has(name)) { errors.push(`group "${name}" selected twice`); continue; }
    seenGroups.add(name);
    const g = groups[name];
    if (!g) { errors.push(`unknown group "${name}" (known: ${Object.keys(groups).join(', ')})`); continue; }
    const dirAbs = path.join(root, g.dir);
    if (!isDir(dirAbs)) { errors.push(`[${name}] directory not found: ${g.dir}`); continue; }
    const expected = [...g.expected].sort(cmp);
    if (expected.length === 0) errors.push(`[${name}] expected list is empty`);
    if (new Set(expected).size !== expected.length) errors.push(`[${name}] duplicate entries in expected list`);
    for (const f of expected) {
      if (FORBIDDEN.some((re) => re.test(f))) errors.push(`[${name}] "${f}" is a generator/capture script and must never be run by this runner`);
      if (g.pattern && !g.pattern.test(f)) errors.push(`[${name}] "${f}" does not match the group pattern ${g.pattern}`);
      if (!isFile(path.join(dirAbs, f))) errors.push(`[${name}] expected test not found: ${path.join(g.dir, f)}`);
    }
    if (g.pattern) {
      const found = readdirSync(dirAbs).filter((f) => g.pattern.test(f) && isFile(path.join(dirAbs, f)));
      const unlisted = found.filter((f) => !expected.includes(f)).sort(cmp);
      for (const f of unlisted) errors.push(`[${name}] unlisted test matches ${g.pattern} but is not in the expected list: ${path.join(g.dir, f)}`);
    }
    for (const f of expected) plan.push({ group: name, file: f, abs: path.join(dirAbs, f) });
  }
  if (plan.length === 0 && errors.length === 0) errors.push('zero tests planned');
  return { errors, plan };
}

/**
 * Runs the selected groups. Never throws for test failures; returns
 * { ok, executed, failures: [{group,file,reason}], preflightErrors }.
 */
export function runGroups(groups, names, opts = {}) {
  const root = opts.root ?? REPO_ROOT;
  const timeoutMs = opts.timeoutMs ?? 180000;
  const nodePath = opts.nodePath ?? process.execPath;
  const log = opts.log ?? ((s) => console.log(s));

  const { errors, plan } = preflight(groups, names, root);
  if (errors.length) {
    for (const e of errors) log(`PREFLIGHT FAIL: ${e}`);
    return { ok: false, executed: 0, failures: [], preflightErrors: errors };
  }

  const failures = [];
  let executed = 0;
  for (const t of plan) {
    log(`\n=== [${t.group}] ${t.file} ===`);
    const started = Date.now();
    const r = spawnSync(nodePath, [t.abs], { cwd: root, stdio: opts.quiet ? 'ignore' : 'inherit', timeout: timeoutMs, windowsHide: true });
    executed++;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    let reason = null;
    if (r.error) reason = r.error.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs} ms` : `could not run: ${r.error.code || r.error.message}`;
    else if (r.signal) reason = `terminated by signal ${r.signal}`;
    else if (r.status !== 0) reason = `exit code ${r.status}`;
    if (reason) { failures.push({ group: t.group, file: t.file, reason }); log(`--- FAIL [${t.group}] ${t.file}: ${reason} (${secs}s)`); }
    else log(`--- ok   [${t.group}] ${t.file} (${secs}s)`);
  }

  log(`\n=== SUMMARY: ${executed} executed, ${executed - failures.length} passed, ${failures.length} failed ===`);
  for (const f of failures) log(`  FAILED [${f.group}] ${f.file}: ${f.reason}`);
  const ok = executed > 0 && failures.length === 0;
  if (executed === 0) log('FAIL: zero tests executed');
  return { ok, executed, failures, preflightErrors: [] };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error(`Usage: node scripts/run-verify-suite.mjs <group> [<group> ...]\nGroups: ${Object.keys(GROUPS).join(', ')}`);
    process.exit(2);
  }
  const res = runGroups(GROUPS, names);
  process.exit(res.ok ? 0 : 1);
}
