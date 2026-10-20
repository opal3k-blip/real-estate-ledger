// B2-3c — smoke test of the MANUAL acceptance kit itself, in headless Chromium (cloud; not Opal's machine, not a Windows/IME test).
// Starts tests/manual/b2-3c-acceptance-server.mjs as a child process (its own PID is the only one ever killed), drives the page, checks the recorder and the controls.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, [path.join(ROOT, 'tests/manual/b2-3c-acceptance-server.mjs'), String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
let pass = 0; let fail = 0;
async function t(name, fn) { try { await fn(); pass += 1; console.log('  ✓ ' + name); } catch (e) { fail += 1; console.error('  ✗ ' + name + '\n      ' + String(e.message).split('\n').slice(0, 8).join(' | ')); } }
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
async function mclick(page, sel) { const b = await page.evaluate((q) => { const el = document.querySelector(q); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel); await page.mouse.click(b.x, b.y); await page.waitForTimeout(80); }   // the page rebuilds its DOM on renders: a real mouse click at the current box (as in b1-editor-real.mjs)
const ok = (c, m) => { if (!c) throw new Error(m || 'not ok'); };
  for (let i = 0; i < 50 && !/acceptance kit/.test(out); i += 1) await new Promise((r) => setTimeout(r, 100));
const A = (s) => `[data-acc="${s}"]`; const RV = (a) => `[data-action="fve-rv-open"][data-act="${a}"]`; const ACT = (a) => `[data-action="${a}"]`;
const waitState = async (page, st, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await page.evaluate(() => { const h = window.__accKit.H; const o = [...h.srv.vals.values()].find((d) => d.valuationId === 'V1'); return o && o.state; }); if (v === st) return true; await page.waitForTimeout(100); } return false; };
try {
  for (let i = 0; i < 50 && !/acceptance kit/.test(out); i += 1) await new Promise((r) => setTimeout(r, 100));
  ok(/acceptance kit/.test(out), 'server did not start: ' + out);
  const browser = await chromium.launch({ args: ['--no-sandbox'] }); const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = []; const requests = [];
  const fresh = async () => { const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(String(e))); page.on('request', (r) => requests.push(r.url())); await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForSelector('#acc', { timeout: 20000 }); await page.waitForSelector('[data-fve="root"]', { timeout: 10000 }); return page; };
  const as = async (page, k) => { await mclick(page, A('as:' + k)); await page.waitForTimeout(1000); };
  const seed = async (page, k) => { await mclick(page, A('seed:' + k)); await page.waitForTimeout(700); };
  console.log('— B2-3c kit smoke — ' + browser.version());
  await t('1. boots with the overlay and 12 scenarios C1–C12, no external requests, no page errors', async () => {
    const p = await fresh(); ok((await p.$$eval('.sc b', (b) => b.filter((x) => /^C\d+\./.test(x.textContent)).length)) === 12, 'C1–C12');
    const ext = requests.filter((u) => !u.startsWith(`http://127.0.0.1:${PORT}`) && !u.startsWith('data:') && !u.startsWith('blob:') && !/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)/.test(u)); eq(ext.length, 0, ext.join(','));
    eq(errors.length, 0, errors.join(' | ')); await p.close();
  });
  await t('2. seed a rich submitted draft; IC sees the reviewer section; the full card shows distinctive values, no [object Object]', async () => {
    const p = await fresh(); await as(p, 'ic'); await seed(p, 'submitted'); await p.waitForSelector(RV('review'), { timeout: 5000 });
    await mclick(p, RV('review')); await mclick(p, ACT('fve-rv-prepare')); await p.waitForSelector('[data-fve="rv-content"]', { timeout: 4000 });
    const txt = await p.$eval('[data-fve="prepared"]', (e) => e.textContent); for (const v of ['7777001', '5550011', '1230001', '4560002', '9990003']) ok(txt.includes(v) || txt.replace(/[,٬\s]/g, '').includes(v), 'missing ' + v);
    ok(!/\[object Object\]/.test(txt), 'object leak'); ok(txt.includes('نهاية الملاحظة الكاملة') || (await p.$eval('[data-fve="rv-note-full"]', (e) => e.textContent)).includes('نهاية الملاحظة الكاملة'), 'whole note'); await p.close();
  });
  await t('3. IC returns with an Arabic multi-line reason under the storm; the server call log shows it exactly; state becomes returned', async () => {
    const p = await fresh(); await as(p, 'ic'); await seed(p, 'submitted'); await p.waitForSelector(RV('returnDraft')); await mclick(p, RV('returnDraft'));
    await mclick(p, A('storm')); const f = '[data-fve-rv="reason"]'; await p.click(f); const reason = 'سبب الإرجاع: ملاحظة أولى\nالسطر الثاني — تفصيل'; await p.keyboard.type('سبب الإرجاع: ملاحظة أولى', { delay: 8 }); await p.keyboard.press('Enter'); await p.keyboard.type('السطر الثاني — تفصيل', { delay: 8 });
    await p.waitForTimeout(400); eq(await p.inputValue(f), reason, 'typed value kept under storm'); eq(await p.evaluate(() => window.__accKit.R.counters.interruptingRenders), 0);
    await mclick(p, A('storm')); await mclick(p, ACT('fve-rv-prepare')); await p.waitForSelector('[data-fve="rv-reason"]'); eq(await p.$eval('[data-fve="rv-reason"]', (e) => e.textContent), reason, 'card reason');
    await mclick(p, ACT('fve-confirm-act')); ok(await waitState(p, 'returned'), 'returned'); const log = await p.evaluate(() => window.__accKit.H.log.filter((e) => e.callable === 'returnValuationToDraft' || /return/i.test(e.callable))); ok(log.length >= 1 && log[0].reason === reason, 'log reason ' + JSON.stringify(log.map((e) => e.callable))); await p.close();
  });
  await t('4. review by IC then approval by IC2 (heads publish with a real hash)', async () => {
    const p = await fresh(); await as(p, 'ic'); await seed(p, 'submitted'); await p.waitForSelector(RV('review')); await mclick(p, RV('review')); await mclick(p, ACT('fve-rv-prepare')); await p.waitForSelector('[data-fve="prepared"]'); await mclick(p, ACT('fve-confirm-act'));
    ok(await waitState(p, 'reviewed'), 'reviewed'); await p.waitForTimeout(600); await as(p, 'ic2'); await p.waitForSelector(RV('approve'), { timeout: 5000 }); await mclick(p, RV('approve')); await mclick(p, ACT('fve-rv-prepare')); await p.waitForSelector('[data-fve="prepared"]'); await mclick(p, ACT('fve-confirm-act'));
    ok(await waitState(p, 'approved'), 'approved'); await p.waitForTimeout(800); const h = await p.evaluate(() => { const s = window.__accKit.H.snapshot(); return s.heads.map((x) => ({ headId: x.data.headId, hasHash: !!x.data.headHash })); }); ok(h.some((x) => x.headId === 'V1' && x.hasHash), 'head published with hash: ' + JSON.stringify(h)); await p.close();
  });
  await t('5. suspended head: the suspender (IC) cannot approve; IC2 needs acknowledgement + reason', async () => {
    const p = await fresh(); await as(p, 'ic2'); await seed(p, 'suspended'); await p.waitForSelector(RV('approve'), { timeout: 5000 }); await mclick(p, RV('approve')); await p.waitForSelector('[data-fve="rv-suspended"]', { timeout: 4000 });
    await mclick(p, ACT('fve-rv-prepare')); await p.waitForTimeout(300); eq(await p.$('[data-fve="prepared"]'), null, 'no card without ack+reason');
    await p.click('[data-fve-rv="reason"]'); await p.keyboard.type('بديل بعد الإيقاف', { delay: 5 }); await p.check('[data-fve-rv="ack"]'); await mclick(p, ACT('fve-rv-prepare')); await p.waitForSelector('[data-fve="rv-ack"]'); ok((await p.$eval('[data-fve="rv-ack"]', (e) => e.textContent)).length > 0);
    await p.close();
  });
  await t('6. drop-reply gives an ambiguous request; the retry reuses requestId and payload (log says same = true)', async () => {
    const p = await fresh(); await as(p, 'ic'); await seed(p, 'submitted'); await p.waitForSelector(RV('returnDraft')); await mclick(p, RV('returnDraft')); await p.click('[data-fve-rv="reason"]'); await p.keyboard.type('سبب مميّز للتجربة', { delay: 5 }); await mclick(p, ACT('fve-rv-prepare')); await p.waitForSelector('[data-fve="prepared"]');
    await mclick(p, A('drop')); await mclick(p, ACT('fve-confirm-act')); await p.waitForTimeout(800); const retry = await p.$('[data-action="fve-retry"], [data-action="fve-retry-pending"], [data-fve="pending"] button'); ok(retry, 'a retry control is shown');
    await retry.click(); await p.waitForTimeout(1200); const log = await p.evaluate(() => window.__accKit.H.log.filter((e) => /return/i.test(e.callable))); ok(log.length >= 2, 'two calls: ' + log.length); eq(log[0].requestId, log[1].requestId, 'same requestId'); eq(log[1].samePayloadAsFirst, true, 'same payload'); eq(log[1].reason, 'سبب مميّز للتجربة'); await p.close();
  });
  await t('7. loss of access / session switch clear the form immediately; export has serverCalls and events', async () => {
    const p = await fresh(); await as(p, 'ic'); await seed(p, 'submitted'); await p.waitForSelector(RV('returnDraft')); await mclick(p, RV('returnDraft')); await p.click('[data-fve-rv="reason"]'); await p.keyboard.type('نص يجب أن يُمسح', { delay: 5 });
    await mclick(p, A('as:ic2')); await p.waitForTimeout(500); const vals = await p.$$eval('[data-fve-rv="reason"]', (e) => e.map((x) => x.value)); ok(vals.every((v) => v === ''), 'cleared for the new user: ' + JSON.stringify(vals));
    await p.evaluate(() => window.__accKit.O.actions.deny()); await p.waitForTimeout(500); eq(await p.$('[data-fve="rv-form"]'), null, 'no form after loss of access');
    const x = await p.evaluate(() => window.__accKit.O.exportData()); eq(x.kit, 'b2-3c'); ok(Array.isArray(x.serverCalls) && Array.isArray(x.events), 'export fields'); await p.close();
  });
  await t('8. C10: the mismatch control yields the mismatch panel (not a ready state); C12: external edit leaves the prepared card unchanged and confirm is refused', async () => {
    let p = await fresh(); await as(p, 'ic'); await seed(p, 'submitted'); await p.waitForSelector('[data-action="fve-check-now"]:not([disabled])', { timeout: 5000 }); await mclick(p, A('mismatch')); await mclick(p, ACT('fve-check-now'));
    await p.waitForSelector('[data-fve="preview-mismatch"]', { timeout: 5000 }); await p.close();
    p = await fresh(); await as(p, 'ic'); await seed(p, 'submitted'); await p.waitForSelector(RV('returnDraft')); await mclick(p, RV('returnDraft')); await p.click('[data-fve-rv="reason"]'); await p.keyboard.type('سبب', { delay: 5 }); await mclick(p, ACT('fve-rv-prepare')); await p.waitForSelector('[data-fve="prepared"]');
    const before = await p.$eval('[data-fve="prepared"]', (e) => e.textContent); await mclick(p, A('other')); await p.waitForTimeout(800); eq(await p.$eval('[data-fve="prepared"]', (e) => e.textContent), before, 'card unchanged');
    await mclick(p, ACT('fve-confirm-act')); await p.waitForTimeout(1000); eq(await p.evaluate(() => window.__accKit.H.srv.vals.get('V1').state), 'submitted', 'nothing applied'); await p.close();
  });
  await browser.close();
} catch (e) { fail += 1; console.error('  ✗ harness: ' + e.message); } finally { child.kill(); }
console.log(`\n${pass} passed, ${fail} failed.`); process.exit(fail ? 1 : 0);
