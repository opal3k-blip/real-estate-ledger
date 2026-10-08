import fs from 'fs';
import path from 'path';
import assert from 'assert/strict';
import { fileURLToPath } from 'url';
import { loadCore } from './core-vm-harness.mjs';
import { projectFinancialResult } from './financial-golden-projection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'financial-golden-master.json'), 'utf8'));
const C = loadCore();
const GOLDEN_ABS_TOLERANCE = 1e-12;
const GOLDEN_REL_TOLERANCE = 1e-12;

function assertGoldenEqual(actual, expected, valuePath = 'root'){
  if(typeof actual === 'number' || typeof expected === 'number'){
    assert.equal(typeof actual, 'number', `${valuePath}: type drift`);
    assert.equal(typeof expected, 'number', `${valuePath}: type drift`);
    if(!Number.isFinite(actual) || !Number.isFinite(expected)){
      assert.deepStrictEqual(actual, expected, `${valuePath}: non-finite numeric drift`);
      return;
    }
    const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
    const tolerance = Math.max(GOLDEN_ABS_TOLERANCE, GOLDEN_REL_TOLERANCE * scale);
    const delta = Math.abs(actual - expected);
    assert.ok(
      delta <= tolerance,
      `${valuePath}: numeric drift actual=${actual} expected=${expected} delta=${delta} tolerance=${tolerance}`
    );
    return;
  }

  if(Array.isArray(actual) || Array.isArray(expected)){
    assert.ok(Array.isArray(actual) && Array.isArray(expected), `${valuePath}: array/type drift`);
    assert.equal(actual.length, expected.length, `${valuePath}: array length drift`);
    for(let i = 0; i < actual.length; i++) assertGoldenEqual(actual[i], expected[i], `${valuePath}[${i}]`);
    return;
  }

  if(actual && expected && typeof actual === 'object' && typeof expected === 'object'){
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    assert.deepStrictEqual(actualKeys, expectedKeys, `${valuePath}: object shape drift`);
    for(const key of actualKeys) assertGoldenEqual(actual[key], expected[key], `${valuePath}.${key}`);
    return;
  }

  assert.deepStrictEqual(actual, expected, `${valuePath}: value drift`);
}

if(baseline.schemaVersion !== 'PHASE_2R1_FINANCIAL_GOLDEN_MASTER_V1') throw new Error('Unexpected golden-master schemaVersion');
const entries = Object.entries(baseline.fixtures || {});
if(entries.length !== baseline.fixtureCount) throw new Error(`fixtureCount mismatch: header=${baseline.fixtureCount}, actual=${entries.length}`);

let passed = 0;
for(const [id, fx] of entries){
  const actual = projectFinancialResult(C.compute(fx.input, fx.scenarioKey || 'base'));
  try{
    assertGoldenEqual(actual, fx.expected);
    console.log(`OK  ${id}: full financial projection matches frozen golden master within deterministic numeric tolerance.`);
    passed++;
  } catch(err){
    console.error(`FAIL ${id}: financial projection drifted from frozen golden master.`);
    throw err;
  }
}
console.log(`\n${passed}/${entries.length} fixtures: Phase 2R-1 financial golden master matches current core.js (abs/rel tolerance ${GOLDEN_ABS_TOLERANCE}).`);
