// R1-C3 — Net XIRR in a REAL browser page (headless Chromium, cloud; NOT the user's machine, NOT Edge/Windows, NOT CI).
// Real: index.html, main.js with every feature registered, core.js, render(), the portfolio and command-center screens, net-xirr-live (MutationObserver, document/window events, real timers), the valuation source and the bridge.
// Faked: Firebase + CDN (stubs), the Firestore listener (in-page fake emitting the explicit {docs, fromCache, hasPendingWrites} contract), the ledger inputs, the clock.
// Usage: node tests/browser/r1c3-net-xirr-real.mjs   (starts tests/manual/r1c3-net-xirr-server.mjs as a child; only that child's own PID is ever killed)
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, [path.join(ROOT, 'tests/manual/r1c3-net-xirr-server.mjs'), String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
let pass = 0; let fail = 0;
async function t(name, fn) { try { await fn(); pass += 1; console.log('  ✓ ' + name); } catch (e) { fail += 1; console.error('  ✗ ' + name + '\n      ' + String(e.message).split('\n').slice(0, 4).join('\n      ')); } }
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'not ok'); };
const waitFor = async (p, fn, arg, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return true; await p.waitForTimeout(60); } return false; };
const status = (p) => p.evaluate(() => { const e = document.querySelector('[data-netxirr-live]'); return e ? { st: e.getAttribute('data-netxirr-status'), text: e.textContent.trim() } : null; });
const live = (p) => p.evaluate(() => ({ subs: window.__r1c3.fake.live().length, on: window.__r1c3.layer.isOn(), stats: window.__r1c3.layer.stats() }));
const go = (p, view) => p.evaluate((v) => window.__r1c3.core.setCoreState({ mainView: v, openDetailId: null, fundsViewOpen: false, render: true }), view);
try {
  for (let i = 0; i < 50 && !/R1-C3 harness/.test(out); i += 1) await new Promise((r) => setTimeout(r, 100));
  ok(/R1-C3 harness/.test(out), 'server did not start: ' + out);
  const browser = await chromium.launch({ args: ['--no-sandbox'] }); const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = []; const requests = [];
  const fresh = async () => { const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(String(e))); page.on('request', (r) => { if (!['stylesheet', 'font', 'image'].includes(r.resourceType())) requests.push(r.url()); }); await page.goto(`http://127.0.0.1:${PORT}/`); await waitFor(page, () => window.__r1c3 || window.__bootError, null, 15000); const be = await page.evaluate(() => window.__bootError); if (be) throw new Error('boot: ' + be); await page.waitForTimeout(500); return page; };
  console.log('— R1-C3 Net XIRR in a REAL browser page — ' + browser.version() + ' (headless, cloud; not Edge, not Windows)');

  await t('1. شاشة المحفظة: العرض يبدأ القراءة (4 اشتراكات) ويظهر loading بلا نسبة؛ بعد وصول البيانات المؤكدة ready 50% مع الوصف الجديد', async () => {
    const p = await fresh(); eq((await live(p)).subs, 0, 'no subscriptions before the screen is opened'); await go(p, 'portfolio');
    await waitFor(p, () => document.querySelector('[data-netxirr-live]')); eq((await status(p)).st, 'loading'); eq((await live(p)).subs, 4);
    await p.evaluate(() => window.__r1c3.feedAll()); ok(await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]')), 'ready never rendered');
    const s = await status(p); ok(/50(\.0)?\s*%|50٪|٥٠/.test(s.text) || /50/.test(s.text), s.text);
    const label = await p.evaluate(() => { const k = [...document.querySelectorAll('.k')].find((e) => /Indicative Net IRR/.test(e.textContent)); return k ? k.textContent : null; });
    ok(label && (label.includes('قيمة متبقية من تقييمات صناديق معتمدة') || label.includes('residual value from approved fund valuations')), 'new description: ' + label); ok(!label.includes('الاكتتاب') && !/underwriting/i.test(label), 'old underwriting wording gone from the Net IRR label');
    const html = await p.evaluate(() => document.querySelector('#app').innerHTML); ok(html.includes('data-netxirr-nav="FUND_VALUATIONS_APPROVED"'), 'nav source shown'); await p.close();
  });
  await t('2. مركز القيادة: النتيجة نفسها حرفيًا من المصدر نفسه، بلا اشتراكات إضافية ولا انقطاع عند التنقل بين الشاشتين', async () => {
    const p = await fresh(); await go(p, 'portfolio'); await p.evaluate(() => window.__r1c3.feedAll()); await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]'));
    const a = await status(p); const subsLog1 = await p.evaluate(() => window.__r1c3.subscribeLog.length);
    await go(p, 'commandCenter'); await p.waitForTimeout(400); const b = await status(p); eq(b.st, 'OK'); eq(b.text, a.text, 'same rate text on both screens');
    const l = await live(p); eq(l.subs, 4); eq(await p.evaluate(() => window.__r1c3.subscribeLog.length), subsLog1, 'no re-subscription when moving between the two screens'); await p.close();
  });
  await t('3. مغادرة العرض (لوحة الفرص) ⇒ إيقاف فوري: صفر مستمعات والطبقة متوقفة؛ والعودة تبدأ قراءة جديدة (loading) لا نتيجة قديمة', async () => {
    const p = await fresh(); await go(p, 'portfolio'); await p.evaluate(() => window.__r1c3.feedAll()); await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]'));
    await go(p, null); ok(await waitFor(p, () => !window.__r1c3.layer.isOn()), 'layer must stop'); const l = await live(p); eq(l.subs, 0); eq(l.stats.listeners, 0);
    eq(await p.evaluate(() => window.__r1c3.source.getView().status), 'stopped'); eq(await p.evaluate(() => document.querySelector('[data-netxirr-live]')), null);
    await go(p, 'portfolio'); await waitFor(p, () => document.querySelector('[data-netxirr-live]')); eq((await status(p)).st, 'loading'); eq((await live(p)).subs, 4); await p.close();
  });
  await t('4. تغيّر التدفقات ثم رسم: النتيجة السابقة تختفي من الصفحة فورًا (قبل وصول أي بيانات)', async () => {
    const p = await fresh(); await go(p, 'portfolio'); await p.evaluate(() => window.__r1c3.feedAll()); await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]'));
    await p.evaluate(() => { const H = window.__r1c3; H.inputs = { ...H.inputs, records: [...H.inputs.records, { kind: 'capitalCall', id: 'c2', fundId: 'f1', date: '2025-06-30', amount: 5, status: 'paid', reversalOfId: null }] }; H.core.render(); });
    const s = await status(p); ok(s && s.st !== 'OK', 'previous rate must not stay on screen: ' + JSON.stringify(s)); await p.close();
  });
  await t('5. تجاوز منتصف ليل الرياض: حدث visibilitychange (عودة التبويب) يُخفي النتيجة وتظهر الحالة الجديدة دون أي تفاعل من المستخدم', async () => {
    const p = await fresh(); await go(p, 'portfolio'); await p.evaluate(() => window.__r1c3.feedAll()); await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]'));
    await p.evaluate(() => { window.__r1c3.clock.base = new Date('2026-04-01T05:00:00Z').getTime(); window.__r1c3.clock.t0 = performance.now(); document.dispatchEvent(new Event('visibilitychange')); });
    ok(await waitFor(p, () => { const e = document.querySelector('[data-netxirr-live]'); return e && e.getAttribute('data-netxirr-status') !== 'OK'; }), 'rate must disappear without user interaction'); await p.close();
  });
  await t('6. تغيّر الدور إلى غير قارئ ⇒ تُخفى النتيجة والاشتراكات تتوقف (المنطقة تبقى بعلامة بلا نسبة)', async () => {
    const p = await fresh(); await go(p, 'commandCenter'); await p.evaluate(() => window.__r1c3.feedAll()); await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]'));
    await p.evaluate(() => { window.__r1c3.session.role = 'analyst'; window.__r1c3.core.render(); }); ok(await waitFor(p, () => { const e = document.querySelector('[data-netxirr-live]'); return e && e.getAttribute('data-netxirr-status') === 'hidden'; }));
    eq((await live(p)).subs, 0); eq((await status(p)).text, '—'); await p.close();
  });
  await t('7. فشل مستمع ⇒ حجب فوري؛ واستعادة آلية بعد ~2 ث بتراجع؛ وعاصفة أحداث online/focus لا تُنتج استعادات مبكرة', async () => {
    const p = await fresh(); await go(p, 'portfolio'); await p.evaluate(() => window.__r1c3.feedAll()); await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]'));
    await p.evaluate(() => window.__r1c3.fake.fail('valuations', 'f1', { code: 'unavailable' })); ok(await waitFor(p, () => document.querySelector('[data-netxirr-status="blocked"]')), 'blocked must render');
    for (let i = 0; i < 20; i += 1) await p.evaluate(() => { window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus')); }); eq((await live(p)).stats.recovers, 0, 'no early recover');
    ok(await waitFor(p, () => window.__r1c3.layer.stats().recovers === 1, null, 5000), 'recover after the backoff'); eq((await live(p)).stats.recovers, 1);
    await p.evaluate(() => window.__r1c3.feedAll()); ok(await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]')), 'ready again after recovery'); await p.close();
  });
  await t('8. مصدر الدفتر المستقل في صفحة حقيقية: لا معدّل قبل تأكيد الدفتر (والعلم القديم/STORE لا يكفيان)؛ ready بعد تأكيد الدفتر والتقييمات؛ cache أو معلّقة بالوثائق نفسها ⇒ يختفي من الصفحة فورًا؛ ولا يعود إلا بتأكيد جديد', async () => {
    const p = await fresh(); await p.evaluate(() => window.__r1c3.useLedgerSource()); await go(p, 'portfolio'); await waitFor(p, () => document.querySelector('[data-netxirr-live]'));
    await p.evaluate(() => window.__r1c3.feedAll()); await p.waitForTimeout(300); ok((await status(p)).st !== 'OK', 'valuations alone (ledger unconfirmed; STORE has funds) must not show a rate');
    ok(await p.evaluate(() => window.__r1c3.ledgerSubs.filter((s) => !s.closed).length) === 3, 'three ledger listeners');
    await p.evaluate(() => { window.__r1c3.ledgerAll(); window.__r1c3.feedAll(); }); ok(await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]')), 'ready after the ledger is confirmed');
    for (const flags of [{ fromCache: true, hasPendingWrites: false }, { fromCache: false, hasPendingWrites: true }]) {
      await p.evaluate(() => { window.__r1c3.feedAll(); window.__r1c3.ledgerAll(); }); ok(await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]')), 'ready (loop)');
      await p.evaluate((f) => window.__r1c3.ledgerEmit('capitalCalls', [{ id: 'c1', data: { fundId: 'f1', callDate: '2025-03-31', amount: 1000000, status: 'paid' } }], f), flags);
      ok(await waitFor(p, () => { const e = document.querySelector('[data-netxirr-live]'); return e && e.getAttribute('data-netxirr-status') === 'blocked'; }), 'rate must vanish from the page at once: ' + JSON.stringify(flags));
      ok(!/\d\s*%/.test((await status(p)).text), 'no percentage text while unconfirmed');
      await p.evaluate(() => { window.__r1c3.ledgerEmit('capitalCalls', [{ id: 'c1', data: { fundId: 'f1', callDate: '2025-03-31', amount: 1000000, status: 'paid' } }]); window.__r1c3.feedAll(); });
      ok(await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]')), 'back only after a fresh confirmation');
    }
    await p.evaluate(() => { window.__r1c3.feedAll(); window.__r1c3.ledgerAll(); }); ok(await waitFor(p, () => document.querySelector('[data-netxirr-status="OK"]')), 'ready before the stray record');
    await p.evaluate(() => window.__r1c3.ledgerEmit('capitalCalls', [{ id: 'c1', data: { fundId: 'f1', callDate: '2025-03-31', amount: 1000000, status: 'paid' } }, { id: 'c9', data: { fundId: 'OUT', callDate: '2025-04-01', amount: 1000000, status: 'paid' } }]));
    await p.evaluate(() => window.__r1c3.feedAll()); ok(await waitFor(p, () => { const e = document.querySelector('[data-netxirr-live]'); return e && e.getAttribute('data-netxirr-status') !== 'OK' && /COVERAGE_FUND_MISSING/.test(document.querySelector('#app').innerHTML); }), 'a paid call of a fund outside the scope must block the rate on the page: ' + JSON.stringify(await p.evaluate(() => window.__r1c3.source.getView())));
    ok((await p.evaluate(() => document.querySelector('#app').innerHTML)).includes('COVERAGE_FUND_MISSING'), 'reason shown'); ok(!/\d\s*%/.test((await status(p)).text), 'no percentage');
    await go(p, 'opportunities'); ok(await waitFor(p, () => window.__r1c3.ledgerSubs.every((s) => s.closed)), 'leaving the view closes the ledger listeners'); await p.close();
  });
  await t('9. لا أخطاء صفحة، ولا طلبات خارج 127.0.0.1', async () => {
    eq(errors.length, 0, errors.join(' | ')); const ext = requests.filter((u) => !/^http:\/\/127\.0\.0\.1:/.test(u) && !/^data:|^blob:/.test(u)); eq(ext.length, 0, ext.slice(0, 3).join(' '));
  });
  await browser.close();
} catch (e) { fail += 1; console.error('FATAL', e.message); }
finally { try { child.kill(); } catch (e) { /* own child only */ } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
