/* Bug #5 end-to-end: real engine + real financing-baseline fixtures, through the actual
   computeOpportunityProjectAndEquityXirr wrapper. For EVERY fixture: complete cost data
   -> project XIRR status OK; landCost deleted / null / NaN / string, hardCostBase deleted / null
   -> INSUFFICIENT_SOURCE_DATA (never OK); explicit landCost=0 -> accepted (not INSUFFICIENT).
   Run: node src/domain/financial/xirr/verify-opal-bug5-wrapper-e2e.mjs */
import fs from 'node:fs';
import { createFinancialEngine } from '../financial-engine.js';
import { blankOpportunity, TIERS, USE_TYPES, SITE_FACTORS, DEV_REFI_STRATEGY_KEY, isResidentialUseType } from '../financial-context.js';
import { computeOpportunityProjectAndEquityXirr } from './opportunity-xirr.js';
const engine = createFinancialEngine({ blankOpportunity, TIERS, USE_TYPES, SITE_FACTORS, DEV_REFI_STRATEGY_KEY, isResidentialUseType });
const fixtures = JSON.parse(fs.readFileSync(new URL('../../../../tests/domain/financing-baseline.json', import.meta.url))).fixtures;
let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) pass++; else { fail++; console.log('FAIL', l, d ? JSON.stringify(d) : ''); } };
const run = (fx, mut) => {
  const comp = engine.compute(fx.input, fx.input.scenarioKey || 'base');
  mut(comp);
  return computeOpportunityProjectAndEquityXirr(fx.input, comp, { acquisitionDate: '2026-01-01', acquisitionDateIsAssumed: true }).project.xirr;
};
const rows = [];
for (const [key, fx] of Object.entries(fixtures)) {
  const base = run(fx, () => {});
  check(`${key} baseline OK`, base.status === 'OK', base);
  const cases = {
    'landCost deleted': (c) => { delete c.landCost; },
    'landCost null': (c) => { c.landCost = null; },
    'landCost NaN': (c) => { c.landCost = NaN; },
    'landCost string': (c) => { c.landCost = '1000'; },
    'hardCostBase deleted': (c) => { delete c.hardCostBase; },
    'hardCostBase null': (c) => { c.hardCostBase = null; },
  };
  const out = { key, baseline: base.rate };
  for (const [name, m] of Object.entries(cases)) {
    const r = run(fx, m);
    check(`${key}: ${name} rejected`, r.status === 'INSUFFICIENT_SOURCE_DATA', r);
    out[name] = r.status;
  }
  const z = run(fx, (c) => { c.landCost = 0; });
  check(`${key}: explicit landCost=0 accepted`, z.status !== 'INSUFFICIENT_SOURCE_DATA', z);
  out['landCost=0'] = z.status;
  rows.push(out);
}
console.log(JSON.stringify(rows.slice(0, 2), null, 1));
console.log(`${pass} passed, ${fail} failed across ${rows.length} fixtures.`);
process.exit(fail === 0 ? 0 : 1);
