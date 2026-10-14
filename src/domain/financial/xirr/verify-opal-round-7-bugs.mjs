/* Round-7 regression: (1) phantom tangent root + scale invariance on irregular dates,
   (2) discriminant ambiguity must reach the fallback and block any "proven" wording.
   Run: node src/domain/financial/xirr/verify-opal-round-7-bugs.mjs */
import { computeOpportunityXirr } from './xirr-opportunity.js';
let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log('PASS ', l); } else { fail++; console.log('FAIL ', l, d ? JSON.stringify(d) : ''); } };
const mk = (dates, amts, k = 1) => dates.map((d, i) => ({ date: d, amount: amts[i] * k }));

/* 1. irregular dates, equal 182-day spacing: y=(1+r)^(-182/365), NPV=-100+200y-100.00000001y^2, disc<0 */
const D = ['2026-01-01', '2026-07-02', '2026-12-31'];
const scales = [1, 1e-10, 1e-3, 1e6, 1e-7];
const res = scales.map((k) => computeOpportunityXirr(mk(D, [-100, 200, -100.00000001], k)));
res.forEach((r, i) => check(`1. scale ${scales[i]}: never OK / never a confirmed tangent root`, r.status !== 'OK' && r.method !== 'tangent-critical-point', r));
check('1. status identical across all scales', new Set(res.map((r) => r.status)).size === 1, res.map((r) => r.status));
// earlier case (no root, wide margin)
const w = [1, 1e-10].map((k) => computeOpportunityXirr(mk(D, [-100, 300, -250], k)));
check('1b. clearly-no-root irregular case same status at both scales, not OK', w[0].status === w[1].status && w[0].status !== 'OK', w);
// genuine crossing irregular case must still resolve OK at all scales
const g = [1, 1e-10, 1e6].map((k) => computeOpportunityXirr(mk(['2026-01-01', '2027-02-04'], [-1000, 1200], k)));
check('1c. genuine irregular root still OK and scale-invariant', g.every((r) => r.status === 'OK' && Math.abs(r.rate - (Math.pow(1.2, 365 / 399) - 1)) < 1e-6), g);

/* 2. -100,+200,-100.000000000001 whole years */
const Y = ['2026-01-01', '2027-01-01', '2028-01-01'];
for (const k of [1, 1e-10, 1e6]) {
  const r = computeOpportunityXirr(mk(Y, [-100, 200, -100.000000000001], k));
  const txt = JSON.stringify(r);
  check(`2. scale ${k}: ambiguous disc -> NUMERICALLY_AMBIGUOUS, no sturm fields`, r.status === 'NUMERICALLY_AMBIGUOUS' && r.sturmCount === undefined, r);
  check(`2. scale ${k}: no proven/confirmed/exact/certified wording anywhere in the output`, !/prov(es|en)|confirmed|certif|exact/i.test(txt), r.reason);
}
console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
