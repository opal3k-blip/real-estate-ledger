import coreVmSource from '../tests/helpers/core-vm-source.cjs';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';

let code = coreVmSource.buildCoreVmSource();

const ctx = {
  console,
  setTimeout,
  clearTimeout,
  localStorage: { getItem() { return null; }, setItem() {} },
  document: {
    documentElement: { lang: 'ar' },
    querySelector() { return null; },
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; },
    body: {},
    createElement() { return {}; },
  },
  window: {},
  Notification: undefined,
  navigator: {},
  URL,
  URLSearchParams,
  FileReader: function FileReader() {},
  Intl,
  Math,
  JSON,
  Date,
  parseFloat,
  parseInt,
  isFinite,
  Number,
  String,
  Array,
  Object,
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(code, ctx, { timeout: 20000 });

const { compute, blankOpportunity } = ctx.__C;

function opportunity(i) {
  const o = JSON.parse(JSON.stringify(blankOpportunity()));
  o.meta.name = `Synthetic opportunity ${i}`;
  o.meta.city = i % 3 === 0 ? 'Riyadh' : i % 3 === 1 ? 'Jeddah' : 'Dammam';
  o.meta.neighborhood = 'Synthetic';
  o.meta.tier = 'متوسط';
  o.meta.oppType = i % 2 === 0 ? 'income' : 'development';
  o.meta.useType = '__neutral__';
  o.meta.analyst = 'performance-smoke';
  o.meta.createdBy = 'perf@example.com';
  o.meta.updatedBy = 'perf@example.com';
  o.land.area = 5000 + (i % 500);
  o.land.price = 2000 + (i % 700);
  o.land.far = 2.5;
  o.land.bar = 0.6;
  o.strategy.salePct = 0.7;
  o.income.rent = 850 + (i % 120);
  o.income.occupancy = 0.88;
  o.income.opex = 0.18;
  o.development.salePrice = 9500 + (i % 800);
  o.development.buildCost = 4200 + (i % 500);
  o.development.constructionYears = 2;
  o.development.operationYears = 1;
  o.development.exitCapRate = 0.075;
  o.financing.ltc = 0.55;
  o.financing.saibor = 0.055;
  o.financing.margin = 0.025;
  o.criteria.irrMin = 0.14;
  o.criteria.moicMin = 1.5;
  o.criteria.dscrMin = 1.2;
  return o;
}

const count = Number(process.env.PERF_SMOKE_RECORDS || 10000);
const started = performance.now();
let checksum = 0;

for (let i = 0; i < count; i += 1) {
  const result = compute(opportunity(i));
  checksum += Number.isFinite(result.equityIRR) ? result.equityIRR : 0;
  checksum += Number.isFinite(result.MOIC) ? result.MOIC : 0;
}

const elapsedMs = performance.now() - started;
const perRecordMs = elapsedMs / count;

console.log(JSON.stringify({
  records: count,
  elapsedMs: Math.round(elapsedMs),
  perRecordMs: Number(perRecordMs.toFixed(4)),
  checksum: Number(checksum.toFixed(4)),
}, null, 2));

const budgetMs = Math.max(15000, count * 1.5);
if (elapsedMs > budgetMs) {
  throw new Error(`Performance smoke exceeded ${Math.round(budgetMs)}ms budget for ${count} records.`);
}
