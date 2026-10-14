/* Phase 3A-1 — verification of the shadow input-validation engine.
   Run: node tests/domain/verify-input-validation-engine.mjs
   Exit code 0 only if every check passes.

   Two kinds of evidence:
   (1) NO FALSE POSITIVES: every frozen reference fixture (20 golden-master
       inputs + 14 financing-baseline inputs) must raise zero BLOCKING and zero
       INCOMPLETE issues, on inputs and on the real compute() output.
   (2) REAL DETECTION: every silent-failure case observed on 2026-10-06 is
       reproduced through the real src/core.js engine and must now be flagged.
   Golden-master / baseline JSON files are only READ here, never written. */
import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCore } from './core-vm-harness.mjs';
import {
  validateOpportunityInputs,
  validateComputationOutputs,
  validateOpportunity,
  FIELD_RULES,
  SEVERITY,
  STATUS,
} from '../../src/domain/validation/input-validation-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const C = loadCore();

let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log('PASS  ' + name); }
  catch (e) { failed += 1; console.log('FAIL  ' + name + '\n      ' + String(e && e.message || e).split('\n')[0]); }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
function set(o, p, v) { const a = p.split('.'); let x = o; for (let i = 0; i < a.length - 1; i++) x = x[a[i]]; x[a.at(-1)] = v; }
function codes(r) { return r.blocking.concat(r.incomplete, r.warnings).map((i) => `${i.code}@${i.path}`); }
function has(r, code, p) { return codes(r).includes(`${code}@${p}`); }

/* Same base as tests/domain/capture-financing-baseline.mjs (development, sane). */
function sane(type = 'development') {
  const o = clone(C.blankOpportunity());
  set(o, 'meta.oppType', type); set(o, 'meta.tier', 'متوسط'); set(o, 'meta.useType', '__neutral__');
  for (const k of ['soil', 'water', 'tower', 'topo', 'infra']) set(o, 'site.' + k, 1);
  set(o, 'land.floorHeight', 3.6); set(o, 'land.area', 5000); set(o, 'land.price', 2000);
  set(o, 'land.far', 2); set(o, 'land.bar', 0.5); set(o, 'land.basements', 0);
  set(o, 'development.buildCost', 3000); set(o, 'development.salePrice', 6000);
  set(o, 'development.efficiency', 0.85); set(o, 'development.contingency', 0.05);
  set(o, 'development.constructionYears', 2); set(o, 'development.operationYears', 0);
  set(o, 'development.scopeType', 'both'); set(o, 'strategy.salePct', 1);
  set(o, 'financing.ltc', 0.6); set(o, 'financing.saibor', 0.055); set(o, 'financing.margin', 0.025);
  set(o, 'financing.interestDuringConstruction', 'cash');
  return o;
}
function full(d) { return validateOpportunity(d, C.compute(clone(d), 'base')); }

/* ---------------- (1) no false positives on frozen references ---------------- */
const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'financial-golden-master.json'), 'utf8')).fixtures;
const fin = JSON.parse(fs.readFileSync(path.join(__dirname, 'financing-baseline.json'), 'utf8')).fixtures;
const inputOf = (f) => f.input || f.d;

check('golden-master: 20 reference inputs present', () => {
  assert.equal(Object.keys(golden).length, 20);
  Object.values(golden).forEach((f) => assert.ok(inputOf(f), 'missing input'));
});
check('financing-baseline: 14 reference inputs present', () => {
  assert.equal(Object.keys(fin).length, 14);
  Object.values(fin).forEach((f) => assert.ok(inputOf(f), 'missing input'));
});
check('golden-master: zero BLOCKING/INCOMPLETE on inputs AND real compute output (20 cases)', () => {
  for (const [id, f] of Object.entries(golden)) {
    const d = inputOf(f);
    const r = validateOpportunity(d, C.compute(clone(d), f.scenarioKey || 'base'));
    assert.deepEqual([r.blocking.length, r.incomplete.length], [0, 0], `${id}: ${codes(r).join(',')}`);
  }
});
check('financing-baseline: zero BLOCKING/INCOMPLETE on inputs AND real compute output (14 cases)', () => {
  for (const [id, f] of Object.entries(fin)) {
    const d = inputOf(f);
    const r = validateOpportunity(d, C.compute(clone(d), f.scenarioKey || 'base'));
    assert.deepEqual([r.blocking.length, r.incomplete.length], [0, 0], `${id}: ${codes(r).join(',')}`);
  }
});
check('sane development base: status OK', () => {
  assert.equal(validateOpportunityInputs(sane()).status, STATUS.OK);
});
check('sane income / landbank bases: no BLOCKING on inputs', () => {
  for (const t of ['income', 'landbank']) {
    const d = sane(t); set(d, 'income.rent', 800); set(d, 'income.occupancy', 0.9); set(d, 'income.opex', 0.2);
    assert.equal(validateOpportunityInputs(d).blocking.length, 0, t);
  }
});

/* ---------------- (2) real detection of the observed silent failures ---------------- */
const SILENT_CASES = [
  ['land.price = -5000', (d) => set(d, 'land.price', -5000), 'NEGATIVE_NOT_ALLOWED', 'land.price'],
  ['development.efficiency = 3.5', (d) => set(d, 'development.efficiency', 3.5), 'FRACTION_ABOVE_ONE', 'development.efficiency'],
  ['development.salePrice = -6000', (d) => set(d, 'development.salePrice', -6000), 'NEGATIVE_NOT_ALLOWED', 'development.salePrice'],
  ['financing.ltc = 1.8', (d) => set(d, 'financing.ltc', 1.8), 'FRACTION_AT_OR_ABOVE_ONE', 'financing.ltc'],
  ['financing.ltc = 1 (zero equity)', (d) => set(d, 'financing.ltc', 1), 'FRACTION_AT_OR_ABOVE_ONE', 'financing.ltc'],
  ['financing.ltc = -0.5', (d) => set(d, 'financing.ltc', -0.5), 'NEGATIVE_NOT_ALLOWED', 'financing.ltc'],
  ['land.bar = 4', (d) => set(d, 'land.bar', 4), 'FRACTION_ABOVE_ONE', 'land.bar'],
  ['strategy.salePct = 7', (d) => set(d, 'strategy.salePct', 7), 'FRACTION_ABOVE_ONE', 'strategy.salePct'],
  ['development.contingency = -0.5', (d) => set(d, 'development.contingency', -0.5), 'NEGATIVE_NOT_ALLOWED', 'development.contingency'],
  ['economics.carry = 1 (div by zero in waterfall)', (d) => set(d, 'economics.carry', 1), 'FRACTION_AT_OR_ABOVE_ONE', 'economics.carry'],
];
for (const [label, mut, code, p] of SILENT_CASES) {
  check(`silent case flagged BLOCKING: ${label}`, () => {
    const d = sane(); mut(d);
    const r = validateOpportunityInputs(d);
    assert.equal(r.status, STATUS.INVALID);
    assert.ok(r.blocking.some((i) => i.code === code && i.path === p), codes(r).join(','));
  });
}
const NAN_CASES = [
  ['land.area = 0', 'development', (d) => set(d, 'land.area', 0), 'land.area'],
  ['land.far = 0 (development)', 'development', (d) => set(d, 'land.far', 0), 'land.far'],
  ['land.far = 0 (income)', 'income', (d) => set(d, 'land.far', 0), 'land.far'],
  ['salePrice = 0 with salePct = 1 (development)', 'development', (d) => set(d, 'development.salePrice', 0), 'development.salePrice'],
];
for (const [label, type, mut, p] of NAN_CASES) {
  check(`NaN trigger flagged INCOMPLETE and engine really emits NaN: ${label}`, () => {
    const d = sane(type); mut(d);
    const c = C.compute(clone(d), 'base');
    assert.ok(!Number.isFinite(c.equityIRR), 'precondition: engine returns non-finite equity IRR');
    const r = full(d);
    assert.ok(r.incomplete.some((i) => i.code === 'REQUIRED_INPUT_MISSING' && i.path === p), codes(r).join(','));
    assert.ok(r.incomplete.some((i) => i.code === 'OUTPUT_NOT_FINITE'), 'NaN output reported as consequence (INCOMPLETE)');
    assert.equal(r.blocking.length, 0, 'explained NaN is not a separate BLOCKING error');
    assert.equal(r.status, STATUS.INCOMPLETE);
  });
}
check('no false NaN flag: salePrice = 0 with salePct = 0 is legal (engine returns finite IRR)', () => {
  const d = sane(); set(d, 'development.salePrice', 0); set(d, 'strategy.salePct', 0);
  // pure-hold economics (no sale): needs income and an exit cap rate to be computable at all
  set(d, 'development.operationYears', 3); set(d, 'development.exitCapRate', 0.08);
  set(d, 'income.rent', 800); set(d, 'income.occupancy', 0.9); set(d, 'income.opex', 0.2);
  assert.ok(Number.isFinite(C.compute(clone(d), 'base').equityIRR), 'precondition');
  assert.equal(full(d).incomplete.length, 0);
});
check('no false NaN flag: land.far = 0 on landbank is legal (engine returns finite IRR)', () => {
  const d = sane('landbank'); set(d, 'land.far', 0);
  assert.ok(Number.isFinite(C.compute(clone(d), 'base').equityIRR));
  assert.equal(validateOpportunityInputs(d).incomplete.length, 0);
});
check('unexplained NaN output (no INCOMPLETE input) stays BLOCKING', () => {
  const d = sane();
  const r = validateOpportunity(d, { equityIRR: NaN, projectIRR: 0.1, MOIC: 1 });
  assert.equal(r.status, STATUS.INVALID);
  assert.ok(r.blocking.some((i) => i.code === 'OUTPUT_NOT_FINITE'));
});
check('ltc = 1: engine really returns an absurd IRR, and the output check also blocks it', () => {
  const d = sane(); set(d, 'financing.ltc', 1);
  const c = C.compute(clone(d), 'base');
  assert.ok(c.equityIRR > 10, 'precondition: absurd IRR ' + c.equityIRR);
  assert.ok(validateComputationOutputs(c).blocking.some((i) => i.code === 'OUTPUT_IMPLAUSIBLE_IRR'));
});
check('every silent case is non-OK end-to-end through the real engine (inputs + outputs)', () => {
  for (const [label, mut] of SILENT_CASES) {
    const d = sane(); mut(d);
    assert.notEqual(full(d).status, STATUS.OK, label);
  }
});

/* ---------------- hints, types, robustness ---------------- */
check('percent typed as whole number gets a hint (ltc = 60)', () => {
  const r = validateOpportunityInputs((() => { const d = sane(); set(d, 'financing.ltc', 60); return d; })());
  const i = r.blocking.find((x) => x.path === 'financing.ltc');
  assert.ok(i && i.hintAr && i.hintEn && i.hintEn.includes('0.6'));
});
check('numeric string is BLOCKING (3A-3: text where a number is required is rejected, never coerced)', () => {
  const d = sane(); set(d, 'land.price', '2000');
  const r = validateOpportunityInputs(d);
  assert.ok(has(r, 'NUMERIC_STRING', 'land.price'));
  assert.equal(r.status, 'INVALID');
  assert.equal(r.blocking.find((i) => i.code === 'NUMERIC_STRING').severity, 'BLOCKING');
});
check('3A-3 hard bounds: absurd / overflow / meaningless-tiny values are BLOCKING (never clamped)', () => {
  const cases = [
    ['land.area', Number.EPSILON, 'BELOW_MIN'], ['land.area', Number.MIN_VALUE, 'BELOW_MIN'], ['land.area', 0.5, 'BELOW_MIN'],
    ['land.area', 1e9, 'ABOVE_MAX'], ['land.price', 1e308, 'ABOVE_MAX'], ['land.price', Number.MAX_VALUE, 'ABOVE_MAX'],
    ['land.price', -1e-15, 'NEGATIVE_NOT_ALLOWED'], ['land.far', 1e6, 'ABOVE_MAX'], ['development.constructionYears', 101, 'ABOVE_MAX'],
    ['financing.tenor', 1e9, 'ABOVE_MAX'], ['financing.saibor', 5, 'ABOVE_MAX'],
  ];
  for (const [path, v, code] of cases) {
    const d = sane(); set(d, path, v);
    const before = JSON.stringify(d);
    const r = validateOpportunityInputs(d);
    assert.ok(has(r, code, path), `${path}=${String(v)} -> ${code}`);
    assert.equal(r.status, 'INVALID');
    assert.equal(JSON.stringify(d), before, 'input is never mutated / rounded');
  }
});
check('3A-3 IC criteria thresholds cannot be forged to make a gate meaningless', () => {
  const cases = [
    ['criteria.dscrMin', -5, 'NEGATIVE_NOT_ALLOWED'], ['criteria.dscrMin', 1e9, 'ABOVE_MAX'], ['criteria.dscrMin', '1.2', 'NUMERIC_STRING'],
    ['criteria.irrMin', -2, 'BELOW_LOWER_BOUND'], ['criteria.irrMin', 1e6, 'ABOVE_MAX'], ['criteria.projIrrMin', -1.5, 'BELOW_LOWER_BOUND'],
    ['criteria.moicMin', -1, 'NEGATIVE_NOT_ALLOWED'], ['criteria.preSaleActual', 5, 'FRACTION_ABOVE_ONE'], ['criteria.preLeasingActual', -0.2, 'NEGATIVE_NOT_ALLOWED'],
    ['criteria.preSaleMin', 50, 'FRACTION_ABOVE_ONE'],
  ];
  for (const [path, v, code] of cases) {
    const d = sane(); set(d, path, v);
    assert.ok(has(validateOpportunityInputs(d), code, path), `${path}=${String(v)} -> ${code}`);
  }
  // legitimate values (including "no return floor" = -1, and no DSCR floor = null) stay valid
  const ok = sane(); set(ok, 'criteria.projIrrMin', -1); set(ok, 'criteria.dscrMin', null); set(ok, 'criteria.irrMin', 0.12);
  assert.equal(validateOpportunityInputs(ok).blocking.length, 0);
  const low = sane(); set(low, 'criteria.dscrMin', 0.5);
  const lr = validateOpportunityInputs(low);
  assert.equal(lr.blocking.length, 0); assert.ok(has(lr, 'UNUSUALLY_LOW', 'criteria.dscrMin'), 'a DSCR floor below 1x is a WARNING, never a block');
});
check('3A-3 -0 is treated as zero (no crash, no false negative), and 0.1+0.2 passes unmodified', () => {
  const d = sane(); set(d, 'land.price', -0);
  assert.equal(validateOpportunityInputs(d).blocking.some((i) => i.path === 'land.price'), false);
  const e = sane(); set(e, 'income.occupancy', 0.1 + 0.2);
  const r = validateOpportunityInputs(e);
  assert.equal(r.blocking.some((i) => i.path === 'income.occupancy'), false);
  assert.equal(e.income.occupancy, 0.30000000000000004, 'no precision normalisation of inputs');
});
check('3A-3 exact boundary values: min/max accepted, just beyond rejected', () => {
  const ok1 = sane(); set(ok1, 'land.area', 1);
  assert.equal(validateOpportunityInputs(ok1).blocking.some((i) => i.path === 'land.area'), false);
  const ok2 = sane(); set(ok2, 'development.constructionYears', 100);
  assert.equal(validateOpportunityInputs(ok2).blocking.some((i) => i.path === 'development.constructionYears'), false);
  const bad = sane(); set(bad, 'development.constructionYears', 100.0000001);
  assert.ok(has(validateOpportunityInputs(bad), 'ABOVE_MAX', 'development.constructionYears'));
});
check('non-numeric string / NaN / Infinity / object are BLOCKING NOT_A_FINITE_NUMBER', () => {
  for (const bad of ['abc', NaN, Infinity, -Infinity, {}, [], true]) {
    const d = sane(); set(d, 'land.price', bad);
    assert.ok(has(validateOpportunityInputs(d), 'NOT_A_FINITE_NUMBER', 'land.price'), String(bad));
  }
});
check('null / undefined / empty string fields are not judged here (completeness is data-quality’s job)', () => {
  for (const absent of [null, undefined, '', '   ']) {
    const d = sane(); set(d, 'development.exitCapRate', absent);
    assert.ok(!codes(validateOpportunityInputs(d)).some((c) => c.endsWith('@development.exitCapRate')));
  }
});
check('non-object input is a BLOCKING issue, never a throw', () => {
  for (const bad of [null, undefined, 5, 'x', [], true]) {
    const r = validateOpportunityInputs(bad);
    assert.equal(r.status, STATUS.INVALID);
    assert.equal(r.blocking[0].code, 'INPUT_NOT_AN_OBJECT');
  }
});
check('missing nested sections do not throw', () => {
  assert.doesNotThrow(() => validateOpportunityInputs({}));
  assert.doesNotThrow(() => validateOpportunityInputs({ land: null, financing: 5, scenarios: 'x' }));
  assert.equal(validateOpportunityInputs({}).status, STATUS.OK);
});
check('output validator: non-object / empty result handled', () => {
  assert.equal(validateComputationOutputs(null).status, STATUS.INVALID);
  assert.equal(validateComputationOutputs({}).status, STATUS.OK);
  assert.equal(validateComputationOutputs({ equityIRR: NaN }).status, STATUS.INVALID);
  assert.equal(validateComputationOutputs({ equityIRR: 0.2, MOIC: 1.5 }).status, STATUS.OK);
  assert.equal(validateComputationOutputs({ equityIRR: 1.5 }).status, STATUS.WARNINGS);
  assert.equal(validateComputationOutputs({ equityIRR: -1.2 }).status, STATUS.INVALID);
});

/* ---------------- structured rules ---------------- */
check('warnings: unusually high LTC / construction years do not block', () => {
  const d = sane(); set(d, 'financing.ltc', 0.9); set(d, 'development.constructionYears', 12);
  const r = validateOpportunityInputs(d);
  assert.equal(r.blocking.length, 0);
  assert.ok(has(r, 'UNUSUALLY_HIGH', 'financing.ltc') && has(r, 'UNUSUALLY_HIGH', 'development.constructionYears'));
  assert.equal(r.status, STATUS.WARNINGS);
});
check('exit costs: total >= 100% BLOCKING; > 15% WARNING', () => {
  const a = sane(); set(a, 'exitCosts.broker', 0.6); set(a, 'exitCosts.legal', 0.5);
  assert.ok(has(validateOpportunityInputs(a), 'EXIT_COSTS_TOTAL_AT_OR_ABOVE_ONE', 'exitCosts.*'));
  const b = sane(); set(b, 'exitCosts.broker', 0.1); set(b, 'exitCosts.rett', 0.05);
  const rb = validateOpportunityInputs(b);
  assert.ok(has(rb, 'EXIT_COSTS_TOTAL_HIGH', 'exitCosts.*') && rb.blocking.length === 0);
});
check('draw schedule: sum > 1 BLOCKING, sum != 1 WARNING, bad entry BLOCKING, exact 1 OK', () => {
  const mk = (arr) => { const d = sane(); set(d, 'financing.drawSchedulePct', arr); return validateOpportunityInputs(d); };
  assert.ok(has(mk([0.6, 0.6]), 'DRAW_SCHEDULE_SUM_ABOVE_ONE', 'financing.drawSchedulePct'));
  assert.ok(has(mk([0.3, 0.3]), 'DRAW_SCHEDULE_SUM_NOT_ONE', 'financing.drawSchedulePct'));
  assert.ok(has(mk([0.5, -0.1, 0.6]), 'DRAW_SCHEDULE_ENTRY_INVALID', 'financing.drawSchedulePct'));
  assert.equal(mk([0.2, 0.3, 0.5]).status, STATUS.OK);
  assert.equal(mk([]).status, STATUS.OK);
});
check('scenarios: multiplier <= 0 BLOCKING, extreme WARNING, defaults OK', () => {
  const d = sane(); set(d, 'scenarios.pessimistic.rentMult', 0); set(d, 'scenarios.optimistic.costMult', 5);
  const r = validateOpportunityInputs(d);
  assert.ok(has(r, 'MUST_BE_POSITIVE', 'scenarios.pessimistic.rentMult'));
  assert.ok(has(r, 'UNUSUALLY_EXTREME', 'scenarios.optimistic.costMult'));
  assert.equal(validateOpportunityInputs(sane()).blocking.length, 0);
});
check('ownership shares outside 0–1 are BLOCKING', () => {
  const d = sane(); set(d, 'economics.lpShare', 1.4); set(d, 'economics.gpShare', -0.1);
  const r = validateOpportunityInputs(d);
  assert.ok(has(r, 'FRACTION_ABOVE_ONE', 'economics.lpShare') && has(r, 'NEGATIVE_NOT_ALLOWED', 'economics.gpShare'));
});

/* ---------------- engine hygiene ---------------- */
check('rule table: every path exists in blankOpportunity() (no typos) and kinds are known', () => {
  const blank = C.blankOpportunity();
  const kinds = new Set(['nonneg', 'fraction', 'fraction_lt1', 'positive', 'signed']);
  const seen = new Set();
  for (const r of FIELD_RULES) {
    assert.ok(!seen.has(r.path), 'duplicate ' + r.path); seen.add(r.path);
    assert.ok(kinds.has(r.kind), r.path);
    let x = blank;
    for (const k of r.path.split('.')) { assert.ok(x && Object.prototype.hasOwnProperty.call(x, k), 'unknown path ' + r.path); x = x[k]; }
    assert.ok(r.ar && r.en, 'labels ' + r.path);
  }
});
check('every issue has code, severity, path, bilingual messages', () => {
  const d = sane(); set(d, 'financing.ltc', 60); set(d, 'land.area', 0); set(d, 'land.far', 99);
  const r = validateOpportunityInputs(d);
  for (const i of r.blocking.concat(r.incomplete, r.warnings)) {
    assert.ok(i.code && i.severity && typeof i.path === 'string' && i.messageAr && i.messageEn);
    assert.ok(Object.values(SEVERITY).includes(i.severity));
  }
});
check('pure: does not mutate a deeply frozen input; deterministic', () => {
  const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };
  const d = sane(); set(d, 'financing.ltc', 60);
  const before = JSON.stringify(d);
  const frozen = deepFreeze(clone(d));
  const r1 = validateOpportunityInputs(frozen);
  const r2 = validateOpportunityInputs(frozen);
  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify(frozen), before);
});
check('shadow guarantee: validation never changes compute() output', () => {
  const d = sane();
  const before = JSON.stringify(C.compute(clone(d), 'base'));
  validateOpportunity(d, C.compute(clone(d), 'base'));
  assert.equal(JSON.stringify(C.compute(clone(d), 'base')), before);
});
check('module has no imports / globals (pure domain module)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'domain', 'validation', 'input-validation-engine.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'no imports');
  assert.ok(!/\b(document|window|localStorage|fetch|Date\.now|new Date|Math\.random)\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'no impure globals');
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
