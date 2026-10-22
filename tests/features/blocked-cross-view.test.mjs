/* Phase 3A-2c — blocked (INVALID/INCOMPLETE) opportunities must not leak into ANY cross-opportunity view.
   Run: node tests/features/blocked-cross-view.test.mjs   (exit 0 only if all pass)
   Method (generic, not per-view): build two worlds that differ ONLY in the numeric inputs of the blocked
   opportunity (same name/city/type). If every cross view renders identically in both worlds, no number
   derived from the blocked opportunity reaches it. Plus fingerprint checks (its own computed figures never
   appear) and positive checks (approved opportunities are still shown with real numbers). */
import assert from 'assert/strict';
import { loadCore } from '../domain/core-vm-harness.mjs';

globalThis.document ??= { addEventListener() {}, querySelector() { return null; }, getElementById() { return null; }, querySelectorAll() { return []; }, documentElement: { lang: 'ar' }, body: {}, createElement() { return {}; } };
globalThis.window ??= globalThis;

let passed = 0, failed = 0;
const pending = [];
function check(name, fn) {
  const ok = () => { passed += 1; console.log('PASS  ' + name); };
  const bad = (e) => { failed += 1; console.log('FAIL  ' + name + '\n      ' + String(e && e.message || e).split('\n')[0]); };
  try { const r = fn(); if (r && typeof r.then === 'function') pending.push(r.then(ok, bad)); else ok(); } catch (e) { bad(e); }
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function set(o, p, v) { const a = p.split('.'); let x = o; for (let i = 0; i < a.length - 1; i++) x = x[a[i]]; x[a.at(-1)] = v; }

const FEATURES = ['automated-ic-memo', 'audit-trail', 'pipeline', 'due-diligence', 'data-quality', 'risk-engine', 'investment-score', 'ic-workflow', 'max-acquisition-price', 'xirr-comparison-panel', 'input-validation-panel', 'negotiation', 'scenario-manager', 'comparables', 'valuation-engine', 'evidence-tracking', 'portfolio', 'concentration-risk', 'benchmark-engine', 'alerts', 'command-center', 'ai-analyst', 'data-room', 'ic-book-print', 'excel-workbook', 'ic-presentation', 'roles-permissions', 'space-efficiency-library', 'exit-channels', 'feasibility-levers', 'cost-distribution-library', 'fund-fees-opex-library', 'opportunities-map', 'saudi-regulatory-library', 'rent-roll', 'macro-context', 'sustainability-mostadam', 'ic-decision-gate', 'underwriting-versions', 'cash-flow-timing', 'institutional-hardening', 'capital-allocation-engine', 'monday-integration', 'institutional-investment-intelligence'];
const EXPORTS = ['opportunities', 'renderDetail', 'renderTable', '_bodyViewHooks', '_mainViews', 'STORE', 'portfolioKPIs', 'renderCompare', 'fundEquityAndValue', 'investorLedgerRows', 'setCoreState', 'renderKPIs', 'oppMetricGuard', 'sortedOpportunities'];

async function makeCore(withFeatures = true) {
  const C = loadCore(EXPORTS);
  if (withFeatures) {
    for (const f of FEATURES) {
      const m = await import('../../src/features/' + f + '.js');
      const fn = Object.entries(m).find(([k, v]) => typeof v === 'function' && k.startsWith('register'));
      assert.ok(fn, 'no register fn in ' + f);
      fn[1](C);
    }
  }
  return C;
}
function sane(C, type, over) {
  const o = clone(C.blankOpportunity());
  const S = { 'meta.oppType': type, 'meta.tier': 'متوسط', 'meta.useType': '__neutral__', 'meta.city': 'الرياض', 'land.floorHeight': 3.6, 'land.area': 5000, 'land.price': 2000, 'land.far': 2, 'land.bar': 0.5, 'land.basements': 0, 'development.buildCost': 3000, 'development.salePrice': 9000, 'development.efficiency': 0.85, 'development.contingency': 0.05, 'development.constructionYears': 2, 'development.operationYears': 0, 'development.scopeType': 'both', 'strategy.salePct': 1, 'financing.ltc': 0.6, 'financing.saibor': 0.055, 'financing.margin': 0.025, 'financing.interestDuringConstruction': 'cash', ...over };
  for (const k of ['soil', 'water', 'tower', 'topo', 'infra']) set(o, 'site.' + k, 1);
  for (const [k, v] of Object.entries(S)) set(o, k, v);
  return o;
}
async function world(badOver, withFeatures = true) {
  const C = await makeCore(withFeatures);
  C.opportunities.push(
    { id: 's1', data: sane(C, 'development', { 'meta.name': 'S1' }) },
    { id: 's2', data: sane(C, 'development', { 'meta.name': 'S2', 'land.price': 2600, 'development.buildCost': 3300, 'financing.ltc': 0.5 }) },
    { id: 'bad', data: sane(C, 'development', { 'meta.name': 'BAD', 'strategy.salePct': 7, 'land.price': 2222, 'land.area': 4321, ...badOver }) },
  );
  C.STORE.funds.push({ id: 'f1', data: { name: 'F1', assetIds: ['s1', 's2', 'bad'] } });
  return C;
}
function renderAll(C) {
  const out = {};
  const t = (k, fn) => { try { const r = fn(); out[k] = typeof r === 'string' ? r : JSON.stringify(r); } catch (e) { out[k] = 'ERR ' + e.message; } };
  for (const k of Object.keys(C._mainViews)) t('main:' + k, () => { C.setCoreState({ mainView: k, openDetailId: null }); return C._mainViews[k](); });
  C.setCoreState({ mainView: null, openDetailId: null });
  C._bodyViewHooks.forEach((fn, i) => t('body:' + i, fn));
  t('kpis', () => C.portfolioKPIs());
  t('renderKPIs', () => C.renderKPIs());
  t('table', () => C.renderTable());
  t('fundEV', () => C.fundEquityAndValue('f1'));
  t('investors', () => C.investorLedgerRows());
  for (const id of ['s1', 's2', 'bad']) t('detail:' + id, () => C.renderDetail(id));
  t('compare', () => { C.setCoreState({ compareOpen: true, compareIds: ['s1', 'bad', 's2'] }); return C.renderCompare(); });
  t('icbook:bad', () => { C.openDetailId = 'bad'; return C._mainViews.icBook(); });
  t('icbook:s1', () => { C.openDetailId = 's1'; return C._mainViews.icBook(); });
  C.openDetailId = null;
  C.setCoreState({ openDetailId: null, mainView: null, compareOpen: false });
  return out;
}
const norm = (s) => s.replace(/\s+/g, ' ');

const A = await world({});
const B = await world({ 'land.price': 777777, 'land.area': 12345, 'development.buildCost': 4321, 'strategy.salePct': 9 });
const oa = renderAll(A), ob = renderAll(B);

check('no view throws while rendering with a blocked opportunity present', () => {
  const errs = Object.entries(oa).filter(([, v]) => /^ERR/.test(v)).map(([k, v]) => k + ': ' + v);
  assert.deepEqual(errs, []);
});
check('GENERIC PARITY: every cross view is independent of the blocked opportunity\'s numeric inputs', () => {
  const diffs = Object.keys(oa).filter((k) => k !== 'detail:bad' && k !== 'icbook:bad' && norm(oa[k]) !== norm(ob[k]));
  assert.deepEqual(diffs, [], 'views whose output depends on blocked-opportunity numbers: ' + diffs.join(', '));
});
check('FINGERPRINT: no computed figure of the blocked opportunity appears in any view', () => {
  const d = A.withDefaults(A.opportunities.find((o) => o.id === 'bad').data); const c = A.compute(d);
  const fp = [A.fmtSAR(c.TPC), A.fmtSAR(c.equity), A.fmtSAR(c.debt), A.fmtSAR(c.NAV), A.fmtPct(c.equityIRR), A.fmtPct(c.projectIRR), c.MOIC.toFixed(2) + '×', A.fmtSAR(c.npvProject)]
    .filter((x) => x && x !== '—' && !/NaN|undefined|Infinity/.test(x) && !/^0\.00/.test(x));
  assert.ok(fp.length >= 4);
  for (const [k, v] of Object.entries(oa)) for (const f of fp) assert.ok(!v.includes(f), `${k} leaks ${f}`);
});
check('dashboard KPIs: blocked counted separately and excluded from n of sums', () => {
  const k = A.portfolioKPIs();
  assert.equal(k.n_, 3); assert.equal(k.blockedN, 1); assert.equal(k.list.length, 2);
  const only = Object.fromEntries(['tpcSum', 'equitySum', 'debtSum'].map((x) => [x, k[x]]));
  const exp = ['s1', 's2'].reduce((a, id) => { const c = A.compute(A.opportunities.find((o) => o.id === id).data); a.tpcSum += c.TPC; a.equitySum += c.equity; a.debtSum += c.debt; return a; }, { tpcSum: 0, equitySum: 0, debtSum: 0 });
  for (const x of Object.keys(exp)) assert.ok(Math.abs(only[x] - exp[x]) < 1e-6, x);
  assert.ok(oa.renderKPIs.includes('data-blocked-excluded="1"'));
});
check('list table: blocked row shows no TPC/IRR/MOIC; approved row keeps real numbers; blocked sorts last', () => {
  const c1 = A.compute(A.opportunities.find((o) => o.id === 's1').data);
  assert.ok(oa.table.includes(A.fmtSAR(c1.TPC)) && oa.table.includes(A.fmtPct(c1.equityIRR)));
  for (const key of ['tpc', 'irr', 'moic', 'verdict']) for (const dir of ['asc', 'desc']) {
    A.setCoreState({ sortKey: key, sortDir: dir });
    assert.equal(A.sortedOpportunities().at(-1).id, 'bad', `${key}/${dir}`);
  }
  A.setCoreState({ sortKey: 'updated', sortDir: 'desc' });
});
check('compare: blocked column has badges in every computed row; approved columns keep real numbers', () => {
  const row = (label) => { const i = oa.compare.indexOf(label); const j = oa.compare.indexOf('</tr>', i); return oa.compare.slice(i, j); };
  for (const label of ['Equity IRR', 'Project IRR', 'MOIC', 'WACC', 'ROI']) assert.ok((row(label).match(/metric-blocked/g) || []).length === 1, label);
  const c1 = A.compute(A.opportunities.find((o) => o.id === 's1').data);
  assert.ok(row('Equity IRR').includes(A.fmtPct(c1.equityIRR)));
});
check('portfolio / command center / hub: blocked assets excluded and announced', () => {
  for (const k of ['main:portfolio', 'main:commandCenter']) assert.ok(oa[k].includes('data-blocked-excluded="1"'), k);
  assert.ok(oa['main:institutional-intelligence'].includes('data-blocked-excluded="1"') && oa['main:institutional-intelligence'].includes('data-blocked-row="1"'));
});
check('fund ledger value excludes the blocked asset', () => {
  const r = A.fundEquityAndValue('f1'); assert.equal(r.blockedAssets, 1);
  const ex = ['s1', 's2'].reduce((a, id) => { const c = A.compute(A.opportunities.find((o) => o.id === id).data); return a + c.equity; }, 0);
  assert.ok(Math.abs(r.totalEquity - ex) < 1e-6);
});
check('IC book for a blocked opportunity is a notice page with no figures; approved opportunity still builds', () => {
  assert.ok(oa['icbook:bad'].includes('data-blocked-book="1"'));
  assert.ok(!oa['icbook:s1'].includes('data-blocked-book'));
});
check('alerts: blocked opportunity yields one figure-free alert (no DSCR/IRR alerts from its numbers)', async () => {
  const { computeAlerts } = await import('../../src/features/alerts.js');
  const list = computeAlerts(A).filter((a) => a.oppId === 'bad');
  assert.ok(list.some((a) => a.kind === 'مدخلات' || a.kind === 'Inputs'));
  assert.ok(!list.some((a) => a.kind === 'DSCR' || a.kind === 'Equity IRR'));
});
check('underwriting snapshot of a blocked opportunity stores no profitability metrics', async () => {
  const { buildUnderwritingVersionRecord } = await import('../../src/features/underwriting-versions.js');
  const d = A.withDefaults(A.opportunities.find((o) => o.id === 'bad').data);
  const rec = buildUnderwritingVersionRecord(A, 'bad', d, 'manual', 'test', null);
  const m = rec.metrics || (rec.data && rec.data.metrics);
  assert.ok(m && m.equityIRR === null && m.projectIRR === null && m.MOIC === null && m.blocked === true);
});
check('no guard registered (feature off): bad opportunity is aggregated exactly as before (zero behaviour change)', async () => {
  const C = await world({}, false);
  const k = C.portfolioKPIs(); assert.equal(k.blockedN, 0); assert.equal(k.list.length, 3);
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
