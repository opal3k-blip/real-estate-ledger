import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { projectFinancialResult } from './financial-golden-projection.mjs';
const require = createRequire(import.meta.url);
const { loadEngine } = require('../../functions/trusted-ic.cjs');
const engine = await loadEngine();
const baseline = JSON.parse(fs.readFileSync(new URL('./financial-golden-master.json', import.meta.url), 'utf8'));
// Same abs/relative tolerance as the frozen browser golden-master verifier.
function compare(actual, expected, field) {
  if (typeof actual === 'number' && typeof expected === 'number' && Number.isFinite(actual) && Number.isFinite(expected)) {
    assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(actual), Math.abs(expected)), `${field}: numeric drift`);
  } else if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    assert.equal(Array.isArray(actual), Array.isArray(expected), field);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), field);
    for (const key of Object.keys(expected)) compare(actual[key], expected[key], `${field}.${key}`);
  } else assert.deepEqual(actual, expected, field);
}
for (const [id, fixture] of Object.entries(baseline.fixtures)) {
  compare(projectFinancialResult(engine.compute(fixture.input, fixture.scenarioKey || 'base')), fixture.expected, id);
  console.log(`OK ${id}: packaged server engine matches frozen financial golden master`);
}
console.log(`${Object.keys(baseline.fixtures).length}/${baseline.fixtureCount} packaged financial fixtures passed.`);
