// B2-2c — T5/T6 flake PROBE runner (investigation tool; cross-platform, plain Node). Runs `fvp-typing-spike.mjs` restricted to T5+T6 many times, per focus variant, and prints a table.
//   node tests/browser/t56-probe.mjs [runsPerVariant=40] [variants=focus,click,front]
// Needs Playwright reachable: set PLAYWRIGHT_MODULE=<path to an installed playwright package> (and CHROMIUM_PATH=<browser exe> if its own browser is not installed).
// It starts child processes of its own and waits for each; it never kills or touches any other process. Output: one JSON line per failure (with the page's focus/scroll state) and a summary.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runs = Number(process.argv[2] || 40); const variants = (process.argv[3] || 'focus,click,front').split(',');
const rows = []; const fails = [];
for (const v of variants) {
  let pass = 0; let bad = 0;
  for (let i = 1; i <= runs; i += 1) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tests/browser/fvp-typing-spike.mjs')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ONLY: 'T5,T6', DIAG: '1', T56_VARIANT: v }, timeout: 120000 });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === 0 && !/✗/.test(out)) pass += 1;
    else { bad += 1; fails.push({ variant: v, run: i, status: r.status, lines: out.split('\n').filter((l) => /✗|DIAG|got |Error/.test(l)).slice(0, 8) }); }
  }
  rows.push({ variant: v, runs, pass, fail: bad });
}
for (const f of fails) console.log(JSON.stringify(f));
console.log(JSON.stringify({ host: { platform: process.platform, release: os.release(), cpus: os.cpus().length, node: process.version }, rows }, null, 1));
process.exit(0);
