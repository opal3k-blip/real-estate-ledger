/* =========================================================================
   Self-test for scripts/run-verify-suite.mjs.
   Builds an isolated temporary tree (os.tmpdir(), removed afterwards) with
   throw-away tests and drives runGroups() against it, so a deliberate
   failing test never touches the real suites.

   Run: node scripts/verify-run-verify-suite.mjs
   ========================================================================= */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGroups, preflight, GROUPS } from './run-verify-suite.mjs';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}  ${detail !== undefined ? JSON.stringify(detail) : ''}`); }
}
const quiet = { log: () => {}, quiet: true };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-verify-suite-selftest-'));
const T = path.join(root, 't');
fs.mkdirSync(T);
const w = (name, body) => fs.writeFileSync(path.join(T, name), body);
w('verify-a-pass.mjs', 'process.exit(0);\n');
w('verify-b-pass.mjs', 'process.exit(0);\n');
w('verify-c-fail.mjs', 'process.exit(3);\n');
w('verify-d-signal.mjs', "try { process.kill(process.pid, 'SIGKILL'); } catch {} setTimeout(() => process.exit(1), 5000);\n");
w('verify-e-hang.mjs', 'setTimeout(() => {}, 60000);\n');
w('capture-baseline.mjs', 'process.exit(0);\n');
w('verify-unlisted.mjs', 'process.exit(0);\n');
fs.mkdirSync(path.join(root, 'empty'));

const G = (expected, extra = {}) => ({ dir: 't', pattern: null, expected, ...extra });

try {
  // 1. success
  let r = runGroups({ g: G(['verify-a-pass.mjs', 'verify-b-pass.mjs']) }, ['g'], { root, ...quiet });
  check('1. all-passing group succeeds (ok, 2 executed, 0 failures)', r.ok === true && r.executed === 2 && r.failures.length === 0, r);

  // 2. deliberate failing test -> failure reported, other tests still run
  r = runGroups({ g: G(['verify-a-pass.mjs', 'verify-c-fail.mjs', 'verify-b-pass.mjs']) }, ['g'], { root, ...quiet });
  check('2. a non-zero exit fails the run', r.ok === false && r.failures.length === 1 && r.failures[0].file === 'verify-c-fail.mjs' && /exit code 3/.test(r.failures[0].reason), r);
  check('2b. tests after the failing one still executed (3 executed)', r.executed === 3, r);

  // 3. killed by signal / abnormal end -> failure
  r = runGroups({ g: G(['verify-d-signal.mjs']) }, ['g'], { root, ...quiet });
  check('3. a test killed by a signal (or ending abnormally) fails the run', r.ok === false && r.failures.length === 1, r);

  // 4. timeout -> failure
  r = runGroups({ g: G(['verify-e-hang.mjs']) }, ['g'], { root, timeoutMs: 400, ...quiet });
  check('4. a test exceeding the timeout fails the run', r.ok === false && r.failures.length === 1 && /timed out|signal/.test(r.failures[0].reason), r);

  // 5. expected test missing -> preflight failure, nothing executed
  r = runGroups({ g: G(['verify-a-pass.mjs', 'verify-zzz-missing.mjs']) }, ['g'], { root, ...quiet });
  check('5. a missing expected test fails in preflight and executes nothing', r.ok === false && r.executed === 0 && r.preflightErrors.some((e) => /expected test not found/.test(e)), r);

  // 6. unlisted test matching the pattern -> preflight failure
  const g6 = { dir: 't', pattern: /^verify-.*\.mjs$/, expected: ['verify-a-pass.mjs'] };
  r = runGroups({ g: g6 }, ['g'], { root, ...quiet });
  check('6. an unlisted test matching the pattern fails in preflight (never silently skipped)', r.ok === false && r.executed === 0 && r.preflightErrors.some((e) => /unlisted test/.test(e)), r);

  // 7. capture-* / generator in expected list -> refused
  r = runGroups({ g: { dir: 't', pattern: null, expected: ['capture-baseline.mjs'] } }, ['g'], { root, ...quiet });
  check('7. a capture-* generator can never be scheduled', r.ok === false && r.executed === 0 && r.preflightErrors.some((e) => /generator\/capture/.test(e)), r);
  const gf = { dir: 't', pattern: null, expected: ['golden-fixtures.mjs'] };
  check('7b. golden-fixtures.* is refused by name', preflight({ g: gf }, ['g'], root).errors.some((e) => /generator\/capture/.test(e)));

  // 8. Node cannot be run -> failure
  r = runGroups({ g: G(['verify-a-pass.mjs']) }, ['g'], { root, nodePath: path.join(root, 'no-such-node-binary'), ...quiet });
  check('8. an unrunnable Node binary fails the run', r.ok === false && r.failures.length === 1 && /could not run/.test(r.failures[0].reason), r);

  // 9. missing directory / empty selection / unknown group / zero tests
  r = runGroups({ g: { dir: 'no-such-dir', pattern: null, expected: ['x.mjs'] } }, ['g'], { root, ...quiet });
  check('9a. a missing directory fails in preflight', r.ok === false && r.preflightErrors.some((e) => /directory not found/.test(e)), r);
  r = runGroups({ g: G(['verify-a-pass.mjs']) }, [], { root, ...quiet });
  check('9b. empty group selection fails', r.ok === false && r.executed === 0, r);
  r = runGroups({ g: G(['verify-a-pass.mjs']) }, ['nope'], { root, ...quiet });
  check('9c. unknown group fails', r.ok === false && r.preflightErrors.some((e) => /unknown group/.test(e)), r);
  r = runGroups({ g: { dir: 'empty', pattern: /^verify-.*\.mjs$/, expected: [] } }, ['g'], { root, ...quiet });
  check('9d. a group with zero tests fails', r.ok === false && r.executed === 0, r);

  // 10. shipped configuration sanity (no execution; real preflight is exercised by running the runner itself)
  check('10. shipped domain/xirr/features lists contain 16 + 14 + 6 entries', GROUPS.domain.expected.length === 16 && GROUPS.xirr.expected.length === 14 && GROUPS.features.expected.length === 6);
  check('10b. no shipped expected entry is a generator', Object.values(GROUPS).every((g) => g.expected.every((f) => !/^capture-|^golden-fixtures\./.test(f))));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
