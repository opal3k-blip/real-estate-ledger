/* Review comment #4: validate-descartes-sturm.mjs must exit non-zero when any of its checks fails.
   The validator is run unmodified (must exit 0), then from an in-memory copy whose expectation is deliberately wrong
   (must exit 1). Nothing is written to the repository. */
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'src/domain/financial/xirr');
const FILE = path.join(DIR, 'validate-descartes-sturm.mjs');
const run = args => spawnSync(process.execPath, args, { encoding: 'utf8' });

const clean = run([FILE]);
assert.equal(clean.status, 0, `unmodified validator must pass:\n${clean.stdout}\n${clean.stderr}`);
assert.match(clean.stdout, /\d+ passed, 0 failed\./);

const src = readFileSync(FILE, 'utf8');
const importLine = 'from "./xirr-opportunity.js"';
assert(src.includes(importLine), 'validator import line changed; update this test');
const mutations = [
  ['a core known-answer check', 'check("degree-3, 3 distinct roots in (0,10)", sturmRealRootCount([-6, 11, -6, 1], 0, 10), 3);', 'check("degree-3, 3 distinct roots in (0,10)", sturmRealRootCount([-6, 11, -6, 1], 0, 10), 4);', 1],
  // Boundary probes are informational until their contract is decided: reported as failed, exit status unchanged.
  ['a boundary probe', 'if (c20 === 20) { probePass++; }', 'if (c20 === 21) { probePass++; }', 0],
];
for (const [label, from, to, expectedExit] of mutations) {
  assert(src.includes(from), `mutation anchor missing for ${label}; update this test`);
  const mutated = src.replace(from, to).replace(importLine, `from ${JSON.stringify(pathToFileURL(path.join(DIR, 'xirr-opportunity.js')).href)}`);
  const r = run(['--input-type=module', '-e', mutated]);
  assert.equal(r.status, expectedExit, `a failing ${label} must make the validator exit ${expectedExit} (got ${r.status})\n${r.stdout}`);
  assert.match(r.stdout, expectedExit === 1 ? /1 failed\./ : /1 failed \(informational/);
}
console.log('PASS verify-descartes-sturm-exit-code: validator exits 0 when all core checks pass and 1 when a core check fails; a failing boundary probe is reported but does not change the exit status.');
