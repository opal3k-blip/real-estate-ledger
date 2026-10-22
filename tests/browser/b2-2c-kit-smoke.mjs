// B2-2c — smoke test of the MANUAL acceptance kit itself, in headless Chromium (cloud; not Opal's machine, not a Windows/IME test).
// Starts tests/manual/b2-2c-acceptance-server.mjs as a child process (its own PID is the only one ever killed), drives the page, checks the recorder and the controls.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, [path.join(ROOT, 'tests/manual/b2-2c-acceptance-server.mjs'), String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
let pass = 0; let fail = 0;
async function t(name, fn) { try { await fn(); pass += 1; console.log('  ✓ ' + name); } catch (e) { fail += 1; console.error('  ✗ ' + name + '\n      ' + String(e.message).split('\n').slice(0, 8).join(' | ')); } }
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
async function mclick(page, sel) { const b = await page.evaluate((q) => { const el = document.querySelector(q); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel); await page.mouse.click(b.x, b.y); await page.waitForTimeout(80); }   // the page rebuilds its DOM on renders: a real mouse click at the current box (as in b1-editor-real.mjs)
const ok = (c, m) => { if (!c) throw new Error(m || 'not ok'); };
try {
  for (let i = 0; i < 50 && !/acceptance kit/.test(out); i += 1) await new Promise((r) => setTimeout(r, 100));
  ok(/acceptance kit/.test(out), 'server did not start: ' + out);
  const browser = await chromium.launch({ args: ['--no-sandbox'] }); const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, acceptDownloads: true }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const requests = []; page.on('request', (r) => requests.push(r.url()));
  await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForSelector('#acc', { timeout: 20000 }); await page.waitForSelector('[data-fve="root"]', { timeout: 10000 });
  console.log('— B2-2c kit smoke — ' + browser.version());
  await t('1. the page boots with the overlay, the fund editor slot, and no external network request', async () => {
    ok(await page.$('[data-acc="storm"]')); ok((await page.$$eval('.sc b', (b) => b.filter((x) => /^S\d+\./.test(x.textContent)).length)) === 12, 'scenarios S1–S12');
    const ext = requests.filter((u) => !u.startsWith(`http://127.0.0.1:${PORT}`) && !u.startsWith('data:') && !u.startsWith('blob:')); eq(ext.filter((u) => !/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net\/npm\/leaflet@[\d.]+\/dist\/leaflet\.css)/.test(u)).length, 0, 'unexpected external requests: ' + ext.join(','));   // only the page's own web fonts and the map stylesheet link; no script, no Firebase
    eq(errors.length, 0, errors.join(' | '));
  });
  await t('2. .git is never served, and firebase-config.js is a dummy (no real project values)', async () => {
    for (const p of ['/.git/config', '/node_modules/x']) { const r = await ctx.request.get(`http://127.0.0.1:${PORT}${p}`); ok([403, 404].includes(r.status()), p + ' -> ' + r.status()); }
    const c = await (await ctx.request.get(`http://127.0.0.1:${PORT}/firebase-config.js`)).text(); ok(/acceptance-kit/.test(c) && !/real-estate-ledger/.test(c), 'dummy config');
  });
  await t('3. the editor works through the kit; typing under the storm; the recorder counts inputs', async () => {
    await mclick(page, '[data-action="fve-create"]'); await page.waitForSelector('#fve-editor'); await mclick(page, '[data-acc="storm"]');
    const f = '[data-fvp-field="methodNote"]'; await page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), f);
    const b = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x + 20, y: r.y + 10 }; }, f); await page.mouse.click(b.x, b.y);
    await page.keyboard.type('abcdefghij'.repeat(6), { delay: 8 }); await page.waitForTimeout(300);
    eq(await page.inputValue(f), 'abcdefghij'.repeat(6)); const c = await page.evaluate(() => window.__accKit.R.counters); ok(c.inputs >= 60, 'inputs ' + c.inputs);
  });
  await t('4. IME composition (CDP) under the storm: recorded, zero renders during it, text intact', async () => {
    const cdp = await ctx.newCDPSession(page); await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(1200);
    await cdp.send('Input.insertText', { text: 'كتب' }); await page.waitForTimeout(500);
    const c = await page.evaluate(() => window.__accKit.R.counters); ok(c.compositions >= 1, 'compositions'); eq(c.rendersDuringComposition, 0, 'renders during composition'); eq(c.interruptingRenders, 0, 'interrupting'); eq(await page.evaluate(() => window.__accKit.R.open()), null, 'no composition left open');
    ok((await page.inputValue('[data-fvp-field="methodNote"]')).endsWith('كتب'), 'text');
  });
  await t('5. the deny control hides the editor at once', async () => {
    await page.click('[data-acc="deny"]'); await page.waitForTimeout(150); eq(await page.$('#fve-editor'), null, 'editor gone');
  });
  await t('6. export returns env, results and events (and results can be marked)', async () => {
    await page.click('[data-acc="ok:S1"]'); const d = await page.evaluate(() => window.__accKit.O.exportData());
    eq(d.results.S1.status, 'ok'); ok(d.env.userAgent && d.events.length > 10 && d.counters.compositions >= 1, 'export content');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-acc="export"]')]); ok(/^b2-2c-acceptance-log-.*\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());
  });
  await t('7. user switch and reload controls do not throw', async () => {
    await page.click('[data-acc="switch"]'); await page.waitForTimeout(200); eq(errors.length, 0, errors.join(' | '));
  });
  async function freshKit() { const pg = await ctx.newPage(); pg.on('pageerror', (e) => errors.push(String(e))); await pg.goto(`http://127.0.0.1:${PORT}/`); await pg.waitForSelector('#acc'); await pg.waitForSelector('[data-fve="root"]'); await mclick(pg, '[data-action="fve-create"]'); await pg.waitForSelector('#fve-editor'); await mclick(pg, '[data-acc="storm"]'); await pg.click('[data-fvp-field="methodNote"]'); return pg; }
  await t('8. a render that lands DURING an open composition is counted at that moment (composition not ended), shown as interrupting, and the open composition is in the export', async () => {
    const pg = await freshKit(); const cdp = await ctx.newCDPSession(pg); await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await pg.waitForTimeout(300);
    eq(await pg.evaluate(() => window.__accKit.R.counters.interruptingRenders), 0, 'held so far');
    await pg.evaluate(() => { window.__realHold = window.__acc.wiring.holdsRender; window.__acc.wiring.holdsRender = () => false; }); await pg.waitForTimeout(600);   // a FAILED hold (simulated): the storm's render lands while the composition has not ended
    const x = await pg.evaluate(() => window.__accKit.O.exportData()); ok(x.counters.interruptingRenders >= 1, 'counted before compositionend: ' + x.counters.interruptingRenders); eq(x.counters.rendersDuringComposition, x.counters.interruptingRenders + x.counters.clearingRenders, 'sum');
    ok(x.cancelledCompositions.length === 1 && x.cancelledCompositions[0].reason === 'node-replaced' && x.cancelledCompositions[0].interruptingRenders >= 1, 'the replaced node\'s composition is an explicit cancelled record that kept its interrupting count'); eq(x.openComposition, null, 'and is out of the active slot'); ok(x.events.some((e) => /INTERRUPTING/.test(e.type)), 'event'); await pg.evaluate(() => { window.__acc.wiring.holdsRender = window.__realHold; });
    ok(/class="no">[1-9]/.test(await pg.evaluate(() => { window.__accKit.O.paint(); return document.querySelector('#acc').innerHTML; })), 'shown red in the overlay'); await pg.close();
  });
  await t('9. a DELAYED deny armed BEFORE the composition fires during it: the clearing render is counted as necessary (not interrupting), the editor is gone, the text never returns', async () => {
    const pg = await freshKit(); await pg.evaluate(() => { document.querySelector('[data-acc-delay]').value = '3'; document.querySelector('[data-acc-delay]').dispatchEvent(new Event('input', { bubbles: true })); });
    await pg.evaluate(() => { window.__accKit.O.state.delaySec = 3; });
    await pg.evaluate(() => window.__accKit.O.actions.arm('deny')); await pg.click('[data-fvp-field="methodNote"]');
    const cdp = await ctx.newCDPSession(pg); await cdp.send('Input.imeSetComposition', { text: 'ZQSECRETZQ', selectionStart: 10, selectionEnd: 10 });
    eq(await pg.evaluate(() => !!window.__accKit.O.state.armed), true, 'still armed while composing'); await pg.waitForTimeout(3700);
    const x = await pg.evaluate(() => window.__accKit.O.exportData()); eq(await pg.$('#fve-editor'), null, 'editor gone'); ok(x.counters.clearingRenders >= 1, 'clearing counted'); eq(x.counters.interruptingRenders, 0, 'not interrupting');
    ok(x.events.some((e) => /^ARMED-FIRE deny/.test(e.type) && e.compositionOpen), 'fired during the composition'); eq(await pg.evaluate(() => document.documentElement.innerHTML.includes('ZQSECRETZQ')), false, 'text not in the page');
    await cdp.send('Input.insertText', { text: 'LATEZQ' }); await pg.waitForTimeout(500); eq(await pg.evaluate(() => document.documentElement.innerHTML.includes('LATEZQ')), false, 'late text does not return'); await pg.close();
  });
  await t('10. composition LIFECYCLE across a necessary clear: the removed node\'s composition is recorded as cancelled-by-clear and leaves the active slot; the NEW editor\'s renders are not charged to it; a late compositionend from the old node cannot end a new composition; a stuck composition on a LIVE node stays visible in the export', async () => {
    const pg = await freshKit(); const cdp = await ctx.newCDPSession(pg);
    await pg.evaluate(() => { window.__old = document.querySelector('[data-fvp-field="methodNote"]'); });
    await cdp.send('Input.imeSetComposition', { text: 'ZQOLDZQ', selectionStart: 7, selectionEnd: 7 }); await pg.waitForTimeout(300);
    eq(await pg.evaluate(() => window.__accKit.R.open().nodeStillInPage), true, 'open on a live node');
    await pg.evaluate(() => window.__accKit.O.actions.unres()); await pg.waitForTimeout(400);   // necessary clear (role unresolved): the editor is removed, no compositionend ever arrives
    let x = await pg.evaluate(() => window.__accKit.O.exportData()); eq(await pg.$('#fve-editor'), null, 'editor gone'); ok(x.counters.clearingRenders >= 1, 'clearing counted'); eq(x.counters.interruptingRenders, 0, 'not interrupting');
    eq(x.openComposition, null, 'the removed node\'s composition is out of the active slot'); eq(x.counters.cancelledByClear, 1, 'cancelled counter'); ok(x.cancelledCompositions.length === 1 && x.cancelledCompositions[0].reason === 'editor-cleared' && x.cancelledCompositions[0].clearingRenders >= 1, 'explicit cancelled record'); ok(x.events.some((e) => e.type === 'composition-cancelled-by-clear'), 'event');
    const clearing0 = x.counters.clearingRenders;
    await pg.evaluate(() => window.__accKit.O.actions.res()); await pg.waitForTimeout(500); await mclick(pg, '[data-action="fve-create"]'); await pg.waitForSelector('#fve-editor');   // a NEW editor appears (access is back) and the storm keeps rendering
    await pg.waitForTimeout(700); x = await pg.evaluate(() => window.__accKit.O.exportData()); eq(x.counters.interruptingRenders, 0, 'the new editor\'s renders are not charged to the old composition'); eq(x.counters.clearingRenders, clearing0, 'nor counted as clearing'); eq(x.openComposition, null, 'nothing open');
    await pg.click('[data-fvp-field="methodNote"]'); await cdp.send('Input.imeSetComposition', { text: 'ZQNEWZQ', selectionStart: 7, selectionEnd: 7 }); await pg.waitForTimeout(300);
    await pg.evaluate(() => { window.__old.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'late' })); }); await pg.waitForTimeout(100);   // the OLD node's late end
    x = await pg.evaluate(() => window.__accKit.O.exportData()); ok(x.openComposition && x.openComposition.nodeStillInPage, 'the new composition is still open on its live node, visible in the export'); eq(x.counters.lateEndsIgnored, 1, 'late end recorded and ignored');
    await pg.waitForTimeout(500); x = await pg.evaluate(() => window.__accKit.O.exportData()); eq(x.counters.interruptingRenders, 0, 'held'); ok(x.openComposition, 'still open (a stuck composition on a live node is shown)');
    await cdp.send('Input.insertText', { text: 'done' }); await pg.waitForTimeout(300); eq(await pg.evaluate(() => window.__accKit.R.open()), null, 'the real end closes it'); await pg.close();
  });
  await browser.close();
} catch (e) { fail += 1; console.error('  ✗ harness: ' + e.message); } finally { child.kill(); }
console.log(`\n${pass} passed, ${fail} failed.`); process.exit(fail ? 1 : 0);
