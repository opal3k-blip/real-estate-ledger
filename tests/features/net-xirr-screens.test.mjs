// R1-C3 — عرض Net XIRR الموحّد في الشاشتين، الوصف المحدَّث، وبقاء portfolioIntelligenceStats متزامنة وبقية المؤشرات دون تغيير.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { netXirrHtml, netXirrDescription, portfolioIntelligenceStats } from '../../src/features/portfolio.js';
import { setNetXirrLive } from '../../src/features/net-xirr-live.js';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); } }
const core = { T: (a) => a, esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])), fmtPct: (v) => `${(v * 100).toFixed(1)}%`, fmtSAR: (v) => `SAR ${v}` };
const liveOf = (v) => ({ view: () => v });
const okResult = { status: 'OK', rate: 0.5, asOfDate: '2026-03-31', asOfDateSource: 'calculation-date', navValue: 1500000, navSource: 'FUND_VALUATIONS_APPROVED', sourceWarnings: [{ code: 'VALUATION_NOT_VERIFIED_BY_VALIDATOR', message: 'm' }] };

console.log('— R1-C3 screens —');
await t('1. جاهز: النسبة والتاريخ والقيمة المتبقية المعتمدة وتحذيرات المصدر، مع العلامة data-netxirr-live', async () => {
  setNetXirrLive(liveOf({ status: 'ready', result: okResult, reasons: [], generation: 1, day: '2026-03-31' }));
  const h = netXirrHtml(core, {});
  assert.ok(h.includes('50.0%')); assert.ok(h.includes('data-netxirr-live="1"')); assert.ok(h.includes('data-netxirr-status="OK"')); assert.ok(h.includes('SAR 1500000')); assert.ok(h.includes('FUND_VALUATIONS_APPROVED')); assert.ok(h.includes('VALUATION_NOT_VERIFIED_BY_VALIDATOR')); assert.ok(h.includes('2026-03-31'));
  setNetXirrLive(null);
});
await t('2. الشاشتان تستدعيان الدالة نفسها بالمصدر نفسه ⇒ ناتج متطابق حرفيًا مهما كان الإحصاء الممرَّر', async () => {
  setNetXirrLive(liveOf({ status: 'ready', result: okResult, reasons: [], generation: 1, day: 'x' }));
  assert.equal(netXirrHtml(core, { netXirr: { status: 'INSUFFICIENT_SOURCE_DATA' } }), netXirrHtml(core, { netXirr: undefined })); setNetXirrLive(null);
  for (const f of ['portfolio.js', 'command-center.js']) { const s = fs.readFileSync(new URL(`../../src/features/${f}`, import.meta.url), 'utf8'); assert.ok(/netXirrHtml\(core, s\)/.test(s), f); }
});
await t('3. لا معدل في غير ready: loading / verifying / blocked / hidden / stopped (لا نسبة أبدًا)', async () => {
  for (const status of ['loading', 'verifying', 'blocked', 'hidden', 'stopped']) {
    setNetXirrLive(liveOf({ status, result: null, reasons: status === 'blocked' ? ['HEAD_MISSING:f2'] : [], generation: 1, day: 'x' }));
    const h = netXirrHtml(core, {}); assert.ok(!/\d+\.\d%/.test(h), status); assert.ok(h.includes('data-netxirr-live="1"'), status); assert.ok(h.includes(`data-netxirr-status="${status}"`), status);
  }
  for (const status of ['hidden', 'stopped']) { setNetXirrLive(liveOf({ status, result: null, reasons: ['NO_READ_ACCESS'], generation: 1, day: null })); assert.ok(netXirrHtml(core, {}).includes('>—</span>'), status); }
  setNetXirrLive(liveOf({ status: 'blocked', result: null, reasons: ['HEAD_MISSING:f2', 'ELIGIBILITY_MISSING:f1'], generation: 1, day: 'x' }));
  const h = netXirrHtml(core, {}); assert.ok(h.includes('HEAD_MISSING:f2') && h.includes('No valuation head') === false); assert.ok(h.includes('لا رأس تقييم'));
  setNetXirrLive(null);
});
await t('4. نتيجة جسر محجوبة (مثل VALUATION_SUSPENDED) تُعرض بحالتها وأسبابها بلا نسبة', async () => {
  const x = { status: 'INSUFFICIENT_SOURCE_DATA', asOfDate: '2026-03-31', asOfDateSource: 'calculation-date', issues: [{ code: 'VALUATION_SUSPENDED', ids: ['fund:f1'] }], reasonCodes: ['VALUATION_SUSPENDED'], sourceWarnings: [] };
  setNetXirrLive(liveOf({ status: 'blocked', result: x, reasons: ['VALUATION_SUSPENDED'], generation: 1, day: 'x' }));
  const h = netXirrHtml(core, {}); assert.ok(!/\d+\.\d%/.test(h)); assert.ok(h.includes('VALUATION_SUSPENDED')); assert.ok(h.includes('التقييم الفعّال معلّق')); setNetXirrLive(null);
});
await t('5. بدون مصدر حي مثبَّت (اختبارات/بيئة قديمة): السلوك القديم كما هو', async () => {
  setNetXirrLive(null); assert.equal(netXirrHtml(core, undefined), '—');
  const h = netXirrHtml(core, { netXirr: { status: 'INSUFFICIENT_SOURCE_DATA', issues: [{ code: 'NAV_BASIS_UNRESOLVED' }], asOfDate: '2026-03-31' } }); assert.ok(h.includes('data-netxirr-status="INSUFFICIENT_SOURCE_DATA"')); assert.ok(!h.includes('data-netxirr-live'));
});
await t('6. الوصف: المصدر الحي يغيّر نص التسمية إلى «قيمة متبقية من تقييمات معتمدة» ولا يذكر NAV الاكتتاب؛ وبدونه النص القديم', async () => {
  assert.ok(netXirrDescription(core).includes('NAV تقديرية من الاكتتاب'));
  setNetXirrLive(liveOf({ status: 'loading', result: null, reasons: [], generation: 1, day: 'x' }));
  const d = netXirrDescription(core); assert.ok(d.includes('قيمة متبقية من تقييمات صناديق معتمدة')); assert.ok(!d.includes('الاكتتاب')); assert.ok(d.includes('غير متحقَّق')); setNetXirrLive(null);
  const src = fs.readFileSync(new URL('../../src/features/portfolio.js', import.meta.url), 'utf8');
  assert.ok(src.includes('${netXirrDescription(core)}'));
});
await t('7. portfolioIntelligenceStats ما زالت متزامنة، لا تلمس المصدر الحي، وnetXirr/NAV/بقية المؤشرات كما كانت', async () => {
  const src = fs.readFileSync(new URL('../../src/features/portfolio.js', import.meta.url), 'utf8');
  assert.ok(/function portfolioIntelligenceStats\(/.test(src) && !/async\s+function portfolioIntelligenceStats/.test(src));
  const body = src.slice(src.indexOf('function portfolioIntelligenceStats'), src.indexOf('/* عرض Net XIRR'));
  assert.ok(!body.includes('getNetXirrLive') && !body.includes('await') && !body.includes('Promise'));
  let touched = 0; setNetXirrLive({ view: () => { touched += 1; return {}; } });
  const c = { STORE: { funds: [] }, opportunities: [], capitalCallsFor: () => [], distributionsFor: () => [], commitmentsForFund: () => [], fundEquityAndValue: () => ({ equity: 0, value: 0 }), fundLedgerSummary: () => ({ committed: 0, called: 0, paidIn: 0, distPaid: 0 }), withDefaults: (d) => d, compute: () => ({}), T: (a) => a, OPP_TYPE_INFO: {} };
  let r; try { r = portfolioIntelligenceStats(c); } catch (e) { r = { error: String(e.message) }; }
  assert.equal(touched, 0); setNetXirrLive(null);
  assert.ok(!r.error, r.error); { assert.ok(!(r instanceof Promise)); assert.ok('netXirr' in r && r.netXirr.status === 'INSUFFICIENT_SOURCE_DATA'); assert.equal(r.netIRR, null); }
});
await t('8. السبعة مواضع الاستدعاء ما زالت تستدعي portfolioIntelligenceStats(core) بلا await', async () => {
  let n = 0;
  for (const f of ['portfolio.js', 'command-center.js', 'alert-center.js', 'concentration-risk.js', 'institutional-investment-intelligence.js']) {
    const s = fs.readFileSync(new URL(`../../src/features/${f}`, import.meta.url), 'utf8'); n += (s.match(/portfolioIntelligenceStats\(core\)/g) || []).length; assert.ok(!/await\s+portfolioIntelligenceStats/.test(s), f);
  }
  assert.equal(n, 7);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
