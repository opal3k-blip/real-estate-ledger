/* Phase 3A-2 / 3A-2b — metric guard + alert center + blocked memo + export refusal.
   Run: node tests/features/input-validation-panel.test.mjs   (exit 0 only if all pass)
   Part A: unit tests with a fake core. Part B: integration against the REAL src/core.js
   (vm harness) — renderDetail/renderTable must hide IRR/MOIC/verdict when the guard blocks
   and must be unchanged when no guard is registered. */
import assert from 'assert/strict';
import { loadCore } from '../domain/core-vm-harness.mjs';
import { registerInputValidationPanel, runValidation, guardDecision } from '../../src/features/input-validation-panel.js';

let passed = 0, failed = 0;
const pending = [];
function check(name, fn) {
  const ok = () => { passed += 1; console.log('PASS  ' + name); };
  const bad = (e) => { failed += 1; console.log('FAIL  ' + name + '\n      ' + String(e && e.message || e).split('\n')[0]); };
  try { const r = fn(); if (r && typeof r.then === 'function') pending.push(r.then(ok, bad)); else ok(); } catch (e) { bad(e); }
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function set(o, p, v) { const a = p.split('.'); let x = o; for (let i = 0; i < a.length - 1; i++) x = x[a[i]]; x[a.at(-1)] = v; }

/* ---------- Part A: fake core ---------- */
function fakeCore() {
  const f = { guards: [], sections: [] };
  f.T = (a) => a;
  f.esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  f.registerMetricGuard = (fn) => f.guards.push(fn);
  f.registerMemoTopSection = (fn) => f.sections.push(fn);
  f.canEditOpp = () => true;
  f.wizardStepForPath = (path) => ({ path, step: 1 });
  return f;
}
const C0 = loadCore(['opportunities', 'renderDetail', 'renderTable']);
function sane(type = 'development') {
  const o = clone(C0.blankOpportunity());
  set(o, 'meta.oppType', type); set(o, 'meta.tier', 'متوسط'); set(o, 'meta.useType', '__neutral__');
  for (const k of ['soil', 'water', 'tower', 'topo', 'infra']) set(o, 'site.' + k, 1);
  set(o, 'land.floorHeight', 3.6); set(o, 'land.area', 5000); set(o, 'land.price', 2000);
  set(o, 'land.far', 2); set(o, 'land.bar', 0.5); set(o, 'land.basements', 0);
  set(o, 'development.buildCost', 3000); set(o, 'development.salePrice', 9000);
  set(o, 'development.efficiency', 0.85); set(o, 'development.contingency', 0.05);
  set(o, 'development.constructionYears', 2); set(o, 'development.operationYears', 0);
  set(o, 'development.scopeType', 'both'); set(o, 'strategy.salePct', 1);
  set(o, 'financing.ltc', 0.6); set(o, 'financing.saibor', 0.055); set(o, 'financing.margin', 0.025);
  set(o, 'financing.interestDuringConstruction', 'cash');
  return o;
}
const cOf = (d) => C0.compute(clone(d), 'base');

check('registers exactly one guard and one memo-top section (alert center)', () => {
  const f = fakeCore(); registerInputValidationPanel(f);
  assert.equal(f.guards.length, 1); assert.equal(f.sections.length, 1);
});
check('guardDecision: sane → null; WARNINGS-only → null (warnings never block)', () => {
  const d = sane();
  assert.equal(guardDecision(d, cOf(d)), null);
  const w = sane(); set(w, 'financing.ltc', 0.9);
  assert.equal(guardDecision(w, cOf(w)), null);
});
check('guardDecision: INVALID and INCOMPLETE block with the right status', () => {
  const a = sane(); set(a, 'financing.ltc', 1.8);
  const ga = guardDecision(a, cOf(a)); assert.equal(ga.blocked, true); assert.equal(ga.status, 'INVALID');
  const b = sane(); set(b, 'land.area', 0);
  const gb = guardDecision(b, cOf(b)); assert.equal(gb.blocked, true); assert.equal(gb.status, 'INCOMPLETE');
});
check('guard fails closed when validation throws', () => {
  const d = {}; Object.defineProperty(d, 'land', { get() { throw new Error('boom'); } });
  const g = guardDecision(d, {});
  assert.deepEqual(g, { blocked: true, status: 'GUARD_ERROR' });
  assert.equal(runValidation(d, {}).ok, false);
});
check('section: OK → green "no alerts" state, no issue cards, no high-risk banner', () => {
  const f = fakeCore(); registerInputValidationPanel(f);
  const d = sane(); const h = f.sections[0](d, cOf(d), { id: 'r1' });
  assert.ok(h.includes('data-alert-center="OK"') && h.includes('ac-ok'));
  assert.ok(!h.includes('data-validation-code=') && !h.includes('data-ac-high-risk'));
});
check('section: INVALID lists errors with path, code, hint; says not approved', () => {
  const f = fakeCore(); registerInputValidationPanel(f);
  const d = sane(); set(d, 'financing.ltc', 60);
  const h = f.sections[0](d, cOf(d), { id: 'r1' });
  assert.ok(h.includes('data-validation-panel="INVALID"'));
  assert.ok(h.includes('data-validation-path="financing.ltc"') && h.includes('data-validation-code="FRACTION_AT_OR_ABOVE_ONE"'));
  assert.ok(h.includes('0.6'), 'percent hint');
  assert.ok(h.includes('تمنع الاعتماد'));
});
check('section: INCOMPLETE and WARNINGS states render distinct headers', () => {
  const f = fakeCore(); registerInputValidationPanel(f);
  const a = sane(); set(a, 'land.area', 0);
  assert.ok(f.sections[0](a, cOf(a), { id: 'r1' }).includes('data-validation-panel="INCOMPLETE"'));
  const b = sane(); set(b, 'financing.ltc', 0.9);
  const hb = f.sections[0](b, cOf(b), { id: 'r1' });
  assert.ok(hb.includes('data-validation-panel="WARNINGS"') && hb.includes('لا تمنع الاعتماد'));
});
check('section: user-controlled values are HTML-escaped', () => {
  const f = fakeCore(); registerInputValidationPanel(f);
  const d = sane(); set(d, 'land.price', '<script>alert(1)</script>');
  const h = f.sections[0](d, {}, { id: 'r1' });
  assert.ok(!h.includes('<script>') && h.includes('&lt;script&gt;'));
});
check('section: engine failure renders an explicit error panel (no throw)', () => {
  const f = fakeCore(); registerInputValidationPanel(f);
  const d = {}; Object.defineProperty(d, 'land', { get() { throw new Error('boom'); } });
  const h = f.sections[0](d, {}, { id: 'r1' });
  assert.ok(h.includes('data-validation-panel="ERROR"') && h.includes('boom'));
});
check('section: works without core.T/core.esc (defensive)', () => {
  const f = { registerMetricGuard() {}, registerMemoTopSection(fn) { f.fn = fn; } };
  registerInputValidationPanel(f);
  const d = sane(); set(d, 'financing.ltc', 1.8);
  assert.ok(f.fn(d, {}).includes('INVALID'));
});

/* ---------- Part B: real core ---------- */
function fresh(withPanel) {
  const C = loadCore(['opportunities', 'renderDetail', 'renderTable']);
  if (withPanel) registerInputValidationPanel(C);
  return C;
}
function addOpp(C, id, d) { C.opportunities.push({ id, data: clone(d) }); }
const KPI_EQ = (C, d) => `Equity IRR</div><div class="v">${C.fmtPct(C.compute(clone(d), 'base').equityIRR)}</div>`;
const KPI_EQ_BLOCKED = 'Equity IRR</div><div class="v"><span class="metric-blocked"';

check('real core exports registerMetricGuard/metricGuard', () => {
  const C = fresh(false);
  assert.equal(typeof C.registerMetricGuard, 'function'); assert.equal(typeof C.metricGuard, 'function');
  assert.equal(C.metricGuard({}, {}), null, 'no guard registered → null');
});
check('no guard registered: detail page shows the real IRR/MOIC/verdict (unchanged behaviour)', () => {
  const C = fresh(false); const d = sane(); addOpp(C, 'a1', d);
  const h = C.renderDetail('a1');
  assert.ok(h.includes(KPI_EQ(C, d)), 'IRR shown');
  assert.ok(!h.includes('metric-blocked') && !h.includes('غير معتمد'));
});
check('sane opportunity with the panel registered: IRR shown, nothing blocked', () => {
  const C = fresh(true); const d = sane(); addOpp(C, 'a2', d);
  const h = C.renderDetail('a2');
  assert.ok(h.includes(KPI_EQ(C, d)));
  assert.ok(!h.includes('metric-blocked'));
  assert.ok(h.includes('data-alert-center="OK"') && !h.includes('data-ac-high-risk'), 'green alert center when OK');
});
check('INVALID (ltc 1.8): blocked memo — no KPI strip, not-approved verdict, alert center lists issues', () => {
  const C = fresh(true); const d = sane(); set(d, 'financing.ltc', 1.8); addOpp(C, 'a3', d);
  const h = C.renderDetail('a3');
  assert.ok(h.includes('data-blocked-memo="1"') && !h.includes('class="kpis"'));
  assert.ok(!h.includes(KPI_EQ(C, d)), 'real IRR text absent');
  assert.ok(h.includes('verdict-bad') && h.includes('مدخلات غير صالحة'), 'verdict replaced');
  assert.ok(h.includes('data-validation-panel="INVALID"') && h.includes('data-validation-path="financing.ltc"'));
});
check('INCOMPLETE (area 0 → NaN): badge instead of NaN, message says incomplete', () => {
  const C = fresh(true); const d = sane(); set(d, 'land.area', 0); addOpp(C, 'a4', d);
  const h = C.renderDetail('a4');
  assert.ok(h.includes('data-blocked-memo="1"') && h.includes('مدخلات ناقصة'));
  assert.ok(h.includes('data-validation-panel="INCOMPLETE"'));
});
check('WARNINGS only (ltc 0.9): numbers still shown, notice section present', () => {
  const C = fresh(true); const d = sane(); set(d, 'financing.ltc', 0.9); addOpp(C, 'a5', d);
  const h = C.renderDetail('a5');
  assert.ok(h.includes(KPI_EQ(C, d)) && !h.includes('metric-blocked'));
  assert.ok(h.includes('data-validation-panel="WARNINGS"'));
});
check('list table: only the invalid row is blocked', () => {
  const C = fresh(true);
  const good = sane(); const bad = sane(); set(bad, 'strategy.salePct', 7);
  addOpp(C, 'g1', good); addOpp(C, 'b1', bad);
  const h = C.renderTable();
  const rowOf = (id) => { const i = h.indexOf(`data-id="${id}"`); const j = h.indexOf('</tr>', i); return h.slice(i, j); };
  assert.ok(rowOf('b1').includes('metric-blocked'));
  assert.ok(!rowOf('g1').includes('metric-blocked'));
  assert.ok(rowOf('g1').includes(C.fmtPct(C.compute(clone(good), 'base').equityIRR)));
});
check('guard that throws → real core fails closed (badge), page still renders', () => {
  const C = fresh(false); C.registerMetricGuard(() => { throw new Error('guard bug'); });
  const d = sane(); addOpp(C, 't1', d);
  const orig = console.error; console.error = () => {};
  let h; try { h = C.renderDetail('t1'); } finally { console.error = orig; }
  assert.ok(h.includes('data-blocked-memo="1"') && h.includes('تعذّر التحقق') && !h.includes('class="kpis"'));
});
check('validation never changes compute(): same output before/after rendering', () => {
  const C = fresh(true); const d = sane(); set(d, 'financing.ltc', 1.8); addOpp(C, 'c1', d);
  const before = JSON.stringify(C.compute(clone(d), 'base'));
  C.renderDetail('c1'); C.renderTable();
  assert.equal(JSON.stringify(C.compute(clone(d), 'base')), before);
});


/* ---------- Part C: 3A-2b alert center, high-risk flag, fix-field, zero-leak, exports ---------- */
check('alert center: counters, dimension cards, fix-field buttons for INVALID', () => {
  const f = fakeCore(); registerInputValidationPanel(f);
  const d = sane(); set(d, 'financing.ltc', 1.8);
  const h = f.sections[0](d, cOf(d), { id: 'r9' });
  assert.ok(h.includes('data-alert-center="INVALID"'));
  assert.ok(/data-ac-counter="bad"[^>]*>\s*<b[^>]*>[1-9]/.test(h), 'error counter ≥ 1');
  for (const k of ['inputs', 'dataQuality', 'dueDiligence', 'riskRegister', 'concentration']) assert.ok(h.includes(`data-ac-dim="${k}"`), 'dim ' + k);
  assert.ok(h.includes('data-action="fix-field"') && h.includes('data-id="r9"') && h.includes('data-path="financing.ltc"'));
});
check('alert center: no fix-field button when the user cannot edit', () => {
  const f = fakeCore(); f.canEditOpp = () => false; registerInputValidationPanel(f);
  const d = sane(); set(d, 'financing.ltc', 1.8);
  assert.ok(!f.sections[0](d, cOf(d), { id: 'r9' }).includes('data-action="fix-field"'));
});
check('high-risk banner: LTC 0.9 → shown (notice only), status stays non-blocking', () => {
  const f = fakeCore(); registerInputValidationPanel(f);
  const d = sane(); set(d, 'financing.ltc', 0.9);
  const h = f.sections[0](d, cOf(d), { id: 'r1' });
  assert.ok(h.includes('data-ac-high-risk="1"') && h.includes('تنبيه: فرصة عالية المخاطر'));
  assert.ok(h.includes('لا يمنع الحفظ'));
  assert.equal(guardDecision(d, cOf(d)), null);
});
check('high-risk banner: absent for a sane opportunity', () => {
  const f = fakeCore(); registerInputValidationPanel(f);
  const d = sane(); assert.ok(!f.sections[0](d, cOf(d), { id: 'r1' }).includes('data-ac-high-risk'));
});
const rowsOf = (...r) => ({ pnlRows: r });
check('debtCoverageByYear: shortfall when debt service > 0 and nothing available; covered by sale proceeds', async () => {
  const { debtCoverageByYear } = await import('../../src/domain/validation/debt-coverage.js');
  const r = debtCoverageByYear(rowsOf(
    { yr: 3, phase: 'operation', noi: 0, debtService: 100 },
    { yr: 4, phase: 'operation', noi: 50, debtService: 100 },
    { yr: 5, phase: 'operation', noi: 0, debtService: 100, isExitYear: true, exitValue: 500, exitCostsAmt: 20 },
    { yr: 6, phase: 'operation', noi: 90, debtService: 0 }));
  assert.equal(r.years.length, 3); assert.deepEqual(r.shortfalls.map((y) => y.yr), [3, 4]);
  assert.equal(r.worst.yr, 3); assert.ok(Math.abs(r.years[2].ratio - 4.8) < 1e-9);
});
check('debtCoverageByYear: no debt / garbage input never throws', async () => {
  const { debtCoverageByYear } = await import('../../src/domain/validation/debt-coverage.js');
  for (const c of [null, undefined, {}, { pnlRows: null }, { pnlRows: [null, 5, {}] }, rowsOf({ yr: 1, noi: NaN, debtService: NaN })]) {
    const r = debtCoverageByYear(c); assert.equal(r.hasDebtService, false); assert.deepEqual(r.shortfalls, []);
  }
});
check('high risk: operation/sale-year coverage shortfall raises the flag with years and lowest ratio', async () => {
  const { buildAlertModel } = await import('../../src/features/alert-center.js');
  const d = sane(); const c = { ...cOf(d), pnlRows: [{ yr: 1, phase: 'construction', noi: 0, debtService: 50 }, { yr: 3, phase: 'operation', noi: 40, debtService: 100 }] };
  const m = buildAlertModel(fakeCore(), d, c);
  assert.ok(m.highRisk.flag);
  const r = m.highRisk.reasons.find((x) => x.ar.includes('خدمة الدين'));
  assert.ok(r && r.ar.includes('3') && r.ar.includes('0.40') && !r.ar.includes('السنوات 1'));
  assert.equal(m.dims.find((x) => x.key === 'debtCoverage').level, 'bad');
});
check('high risk: construction-phase equity-funded interest is a note (dimension warn), not a high-risk flag by itself', async () => {
  const { buildAlertModel } = await import('../../src/features/alert-center.js');
  const d = sane(); const c = { ...cOf(d), pnlRows: [{ yr: 1, phase: 'construction', noi: 0, debtService: 50 }, { yr: 2, phase: 'construction', noi: 0, debtService: 50 }] };
  const m = buildAlertModel(fakeCore(), d, c);
  assert.ok(!m.highRisk.reasons.some((x) => x.ar.includes('خدمة الدين')));
  const dim = m.dims.find((x) => x.key === 'debtCoverage'); assert.equal(dim.level, 'warn');
});
check('high risk: sale proceeds in the same year cover the debt service (development-for-sale) → no flag', async () => {
  const { buildAlertModel } = await import('../../src/features/alert-center.js');
  const d = sane(); const c = { ...cOf(d), pnlRows: [{ yr: 3, phase: 'operation', noi: 0, debtService: 100, isExitYear: true, exitValue: 400, exitCostsAmt: 10 }] };
  const m = buildAlertModel(fakeCore(), d, c);
  assert.ok(!m.highRisk.flag && m.dims.find((x) => x.key === 'debtCoverage').level === 'good');
});
check('high risk: when blocked, the coverage reason carries no ratio figure', async () => {
  const { buildAlertModel } = await import('../../src/features/alert-center.js');
  const d = sane(); set(d, 'financing.ltc', 1.8);
  const c = { ...cOf(d), pnlRows: [{ yr: 3, phase: 'operation', noi: 40, debtService: 100 }] };
  const m = buildAlertModel(fakeCore(), d, c);
  assert.equal(m.status, 'INVALID');
  assert.ok(m.highRisk.reasons.some((x) => x.ar.includes('خدمة الدين')) && m.highRisk.reasons.every((x) => !x.ar.includes('0.40')));
});
check('register-high risk is reported', async () => {
  const { buildAlertModel } = await import('../../src/features/alert-center.js');
  const d2 = sane(); d2.risk = { items: { market: { probability: 5, impact: 5 } } };
  const m2 = buildAlertModel(fakeCore(), d2, cOf(d2));
  assert.ok(m2.dims.find((x) => x.key === 'riskRegister'));
});
check('messages: no raw NaN / Infinity / metric key in any user-facing issue text', async () => {
  const { validateOpportunity } = await import('../../src/domain/validation/input-validation-engine.js');
  const bad = [['land.area', 0], ['land.far', 0]].map(([p, v]) => { const d = sane(); set(d, p, v); return validateOpportunity(d, cOf(d)); });
  const all = bad.flatMap((r) => [...r.blocking, ...r.incomplete, ...r.warnings]);
  assert.ok(all.length >= 3);
  for (const i of all) for (const t of [i.messageAr, i.messageEn, i.hintAr || '', i.hintEn || '']) assert.ok(!/NaN|Infinity|equityIRR|projectIRR|undefined/.test(t), t);
  const h = (() => { const f = fakeCore(); registerInputValidationPanel(f); const d = sane(); set(d, 'land.area', 0); return f.sections[0](d, cOf(d), { id: 'r1' }); })();
  const t = h.replace(/data-validation-path="[^"]*"/g, ''); const m = t.match(/.{50}(NaN|Infinity|equityIRR|projectIRR|result\.).{30}/); assert.ok(!m, 'alert center text: ' + (m && m[0].replace(/\s+/g, ' ')));
});
check('buildAlertModel never throws on a hostile object (dimension marked unavailable/ERROR)', async () => {
  const { buildAlertModel } = await import('../../src/features/alert-center.js');
  const d = {}; Object.defineProperty(d, 'land', { get() { throw new Error('boom'); } });
  const m = buildAlertModel(fakeCore(), d, {});
  assert.equal(m.status, 'ERROR'); assert.ok(m.dims.length >= 4);
});
check('alert center: XSS in values and paths is escaped', () => {
  const f = fakeCore(); registerInputValidationPanel(f);
  const d = sane(); set(d, 'land.price', '<img src=x onerror=alert(1)>');
  const h = f.sections[0](d, {}, { id: 'r"1' });
  assert.ok(!h.includes('<img src=x') && !h.includes('data-id="r"1"'));
});

const LEAKY = (C, d) => {
  const c = C.compute(clone(d), 'base');
  return [C.fmtPct(c.equityIRR), C.fmtPct(c.projectIRR), c.MOIC.toFixed(2) + '×', c.MOIC.toFixed(2)].filter((x) => x && x !== '—' && !/NaN|undefined|Infinity/.test(x));
};
check('ZERO LEAK: INVALID memo contains 0 occurrences of Equity IRR / Project IRR / MOIC values', () => {
  const C = fresh(true); const d = sane(); set(d, 'financing.ltc', 1.8); addOpp(C, 'z1', d);
  const h = C.renderDetail('z1');
  for (const t of LEAKY(C, d)) assert.equal(h.split(t).length - 1, 0, 'leaked: ' + t);
  assert.ok(h.includes('data-blocked-memo="1"') && h.includes('data-alert-center="INVALID"'));
  assert.ok(!h.includes('class="kpis"'), 'no KPI strip');
});
check('ZERO LEAK: INCOMPLETE memo shows no NaN and no IRR/MOIC values', () => {
  const C = fresh(true); const d = sane(); set(d, 'land.area', 0); addOpp(C, 'z2', d);
  const h = C.renderDetail('z2');
  assert.ok(!h.includes('<bdi dir="ltr">NaN') && !h.includes('Infinity') && !h.includes('result.equityIRR</code> ='), 'no raw output values');
  assert.ok(h.includes('data-blocked-memo="1"') && h.includes('data-alert-center="INCOMPLETE"'));
});
check('ZERO LEAK: every blocked type (dev/income) hides all metrics', () => {
  for (const type of ['development', 'income']) {
    const C = fresh(true); const d = sane(type); set(d, 'financing.ltc', 1.8); addOpp(C, 'z3', d);
    const h = C.renderDetail('z3');
    assert.ok(h.includes('data-blocked-memo="1"'), type);
    for (const t of LEAKY(C, d)) assert.equal(h.split(t).length - 1, 0, type + ' leaked: ' + t);
  }
});
check('alert center sits under the verdict banner on the normal memo too (warnings case)', () => {
  const C = fresh(true); const d = sane(); set(d, 'financing.ltc', 0.9); addOpp(C, 'w1', d);
  const h = C.renderDetail('w1');
  assert.ok(h.indexOf('verdict-banner') < h.indexOf('data-alert-center="WARNINGS"') && h.indexOf('data-alert-center="WARNINGS"') < h.indexOf('class="kpis"'));
  assert.ok(h.includes('data-ac-high-risk="1"') && h.includes(KPI_EQ(C, d)));
});
check('fix-field: wizardStepForPath finds a step for known inputs; null for unknown', () => {
  const C = fresh(true); const d = C.withDefaults(sane());
  const hit = C.wizardStepForPath('financing.ltc', d);
  assert.ok(hit && hit.path === 'financing.ltc' && Number.isInteger(hit.step));
  assert.equal(C.wizardStepForPath('no.such.path', d), null);
  const ex = C.wizardStepForPath('exitCosts.rett', d); assert.ok(ex, 'exit costs map');
});
check('registerMemoTopSection: a throwing extension does not break the memo', () => {
  const C = fresh(false); C.registerMemoTopSection(() => { throw new Error('ext bug'); });
  const d = sane(); addOpp(C, 'e1', d);
  const orig = console.error; console.error = () => {};
  let h; try { h = C.renderDetail('e1'); } finally { console.error = orig; }
  assert.ok(h.includes('class="kpis"'));
});

/* exports refused when blocked (alert shown, nothing built) */
function spyEnv() {
  const env = { alerts: [], built: 0 };
  env.alert = (m) => env.alerts.push(String(m));
  env.ExcelJS = { Workbook: function () { env.built += 1; throw new Error('should not build'); } };
  env.PptxGenJS = function () { env.built += 1; throw new Error('should not build'); };
  return env;
}
function coreWithEnv(env) {
  const C = loadCore(['opportunities', 'renderDetail', 'renderTable'], { alert: env.alert, ExcelJS: env.ExcelJS, PptxGenJS: env.PptxGenJS });
  registerInputValidationPanel(C); return C;
}
check('core Excel + PPTX export refuse a blocked opportunity (alert, nothing built)', async () => {
  const env = spyEnv(); const C = coreWithEnv(env);
  const d = sane(); set(d, 'financing.ltc', 1.8); addOpp(C, 'x1', d);
  await C.exportOpportunityExcel('x1'); await C.exportOpportunityPptx('x1');
  assert.equal(env.alerts.length, 2); assert.equal(env.built, 0);
});
check('core exports are NOT refused for a sane opportunity (proceeds to the builder)', async () => {
  const env = spyEnv(); const C = coreWithEnv(env);
  const d = sane(); addOpp(C, 'x2', d);
  const orig = console.error; console.error = () => {};
  try { await C.exportOpportunityExcel('x2'); C.exportOpportunityPptx('x2'); } catch (e) { /* builder spy throws */ } finally { console.error = orig; }
  assert.ok(env.built >= 1, 'builder reached');
});
check('underwriting workbook + IC presentation refuse a blocked opportunity', async () => {
  const { exportUnderwritingWorkbook } = await import('../../src/features/excel-workbook.js');
  const { exportICPresentation } = await import('../../src/features/ic-presentation.js');
  const alerts = []; const prev = globalThis.alert; globalThis.alert = (m) => alerts.push(m);
  try {
    const d = sane(); const core = { opportunities: [{ id: 'q', data: d }], withDefaults: (x) => x, compute: () => ({}), metricGuard: () => ({ blocked: true, status: 'INVALID' }), T: (a) => a };
    await exportUnderwritingWorkbook(core, 'q'); await exportICPresentation(core, 'q');
  } finally { globalThis.alert = prev; }
  assert.equal(alerts.length, 2);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
