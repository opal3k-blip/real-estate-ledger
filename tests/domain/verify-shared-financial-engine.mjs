import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFinancialEngine } from '../../src/domain/financial/financial-engine.js';
import { loadCore } from './core-vm-harness.mjs';
import { buildTimingFixtures } from './timing-fixtures.mjs';
import { projectFinancialResult } from './financial-golden-projection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'financial-golden-master.json'), 'utf8'));

const C = loadCore([
  'TIERS',
  'USE_TYPES',
  'SITE_FACTORS',
  'DEV_REFI_STRATEGY_KEY',
  'isResidentialUseType',
]);

const shared = createFinancialEngine({
  blankOpportunity: C.blankOpportunity,
  TIERS: C.TIERS,
  USE_TYPES: C.USE_TYPES,
  SITE_FACTORS: C.SITE_FACTORS,
  DEV_REFI_STRATEGY_KEY: C.DEV_REFI_STRATEGY_KEY,
  isResidentialUseType: C.isResidentialUseType,
});

const ABS_TOLERANCE = 1e-12;
const REL_TOLERANCE = 1e-12;

function assertEquivalent(actual, expected, valuePath = 'root'){
  if(typeof actual === 'number' || typeof expected === 'number'){
    assert.equal(typeof actual, 'number', `${valuePath}: type drift`);
    assert.equal(typeof expected, 'number', `${valuePath}: type drift`);
    if(!Number.isFinite(actual) || !Number.isFinite(expected)){
      assert.deepStrictEqual(actual, expected, `${valuePath}: non-finite numeric drift`);
      return;
    }
    const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
    const tolerance = Math.max(ABS_TOLERANCE, REL_TOLERANCE * scale);
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
    for(let i = 0; i < actual.length; i++) assertEquivalent(actual[i], expected[i], `${valuePath}[${i}]`);
    return;
  }

  if(actual && expected && typeof actual === 'object' && typeof expected === 'object'){
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    assert.deepStrictEqual(actualKeys, expectedKeys, `${valuePath}: object shape drift`);
    for(const key of actualKeys) assertEquivalent(actual[key], expected[key], `${valuePath}.${key}`);
    return;
  }

  assert.deepStrictEqual(actual, expected, `${valuePath}: value drift`);
}

if(baseline.schemaVersion !== 'PHASE_2R1_FINANCIAL_GOLDEN_MASTER_V1'){
  throw new Error(`Unexpected golden-master schemaVersion: ${baseline.schemaVersion}`);
}

const fixtures = buildTimingFixtures(C);
assert.equal(fixtures.length, baseline.fixtureCount, 'Timing fixtures and financial golden master must cover the same fixture count');

let passed = 0;
for(const fixture of fixtures){
  const frozen = baseline.fixtures[fixture.id];
  assert.ok(frozen, `${fixture.id}: missing frozen financial golden-master entry`);

  const scenarioKey = fixture.scenarioKey || 'base';
  const legacyProjection = projectFinancialResult(C.compute(fixture.input, scenarioKey));
  const sharedProjection = projectFinancialResult(shared.compute(fixture.input, scenarioKey));

  try{
    assertEquivalent(sharedProjection, legacyProjection, `${fixture.id}.shared_vs_core`);
    assertEquivalent(sharedProjection, frozen.expected, `${fixture.id}.shared_vs_golden`);
    console.log(`OK  ${fixture.id}: shared engine == core.js == frozen golden master.`);
    passed++;
  } catch(err){
    console.error(`FAIL ${fixture.id}: shared financial engine equivalence drift.`);
    throw err;
  }
}

console.log(`\n${passed}/${fixtures.length} fixtures: Phase 2R-2 shared financial engine shadow-reconciles core.js and the frozen Phase 2R-1 baseline.`);
