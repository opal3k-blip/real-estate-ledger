// Runs the headless-Chromium browser tests one after another and fails if any fails.
// Each test starts its own local harness server as a child and kills only that child's PID.
//   node scripts/run-browser-tests.mjs            # all
//   node scripts/run-browser-tests.mjs r1c3       # only files whose name contains "r1c3"
// Playwright: PLAYWRIGHT_MODULE if set, else tests/browser/node_modules/playwright (npm ci --prefix tests/browser).
// core-gate-real runs with EXPECT_GATE=1: it must find the render gate in core.js and FAIL (not skip) if it is missing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = ['b1-editor-real', 'b3b-reviewer-real', 'b4c-eligibility-real', 'b2-2c-kit-smoke', 'b2-3c-kit-smoke', 'b2-4c-kit-smoke', 'core-gate-real', 'r1c3-net-xirr-real'];
const local = path.join(ROOT, 'tests/browser/node_modules/playwright');
const pw = process.env.PLAYWRIGHT_MODULE || (fs.existsSync(local) ? local : null);
if (!pw) { console.error('Playwright not found: run `npm ci --prefix tests/browser` and `npx --prefix tests/browser playwright install --with-deps chromium` (or set PLAYWRIGHT_MODULE).'); process.exit(2); }
const filter = process.argv[2] || '';
const picked = TESTS.filter((t) => t.includes(filter));
if (!picked.length) { console.error(`no browser test matches "${filter}"`); process.exit(2); }
const results = [];
for (const name of picked) {
  console.log(`\n=== ${name} ===`);
  const env = { ...process.env, PLAYWRIGHT_MODULE: pw, ...(name === 'core-gate-real' ? { EXPECT_GATE: '1' } : {}) };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests/browser', `${name}.mjs`)], { cwd: ROOT, env, stdio: 'inherit', timeout: 300000 });
  results.push([name, r.status === 0]);
}
console.log('\n=== browser tests summary ===');
for (const [n, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
