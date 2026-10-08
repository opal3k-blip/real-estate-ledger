import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCore } from './core-vm-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const coreSource = fs.readFileSync(path.join(ROOT, 'src/core.js'), 'utf8');
const engineSource = fs.readFileSync(path.join(ROOT, 'src/domain/financial/financial-engine.js'), 'utf8');

assert.match(coreSource, /import\s*\{\s*createFinancialEngine\s*\}\s*from\s*['"]\.\/domain\/financial\/financial-engine\.js['"]/,
  'core.js must import the canonical shared financial engine');
assert.doesNotMatch(coreSource, /\bfunction\s+compute\s*\(/,
  'core.js must not retain a second compute implementation');
assert.doesNotMatch(coreSource, /\bfunction\s+irr\s*\(/,
  'core.js must not retain a second IRR implementation');
assert.doesNotMatch(coreSource, /\bfunction\s+withDefaults\s*\(/,
  'core.js must not retain a second defaults-merge implementation');
assert.match(coreSource, /const\s+_financialEngine\s*=\s*createFinancialEngine\s*\(/,
  'core.js must instantiate the shared engine with explicit dependencies');
assert.match(engineSource, /function\s+compute\s*\(/,
  'shared financial engine must own compute implementation');

const C = loadCore();
assert.equal(typeof C.compute, 'function');
assert.equal(typeof C.withDefaults, 'function');
assert.equal(typeof C.irr, 'function');
assert.equal(typeof C.npvAt, 'function');
assert.equal(typeof C.blankOpportunity, 'function');

console.log('PASS Phase 2R-3 financial authority: core.js delegates to the shared engine and retains no duplicate financial implementation.');
