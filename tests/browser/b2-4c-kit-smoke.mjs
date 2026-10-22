// B2-4c — smoke test of the MANUAL acceptance kit itself (overlay, seeders, external-change controls, recorder, export), headless Chromium in the cloud. Not Opal's machine, not Edge/Windows.
// Starts tests/manual/b2-4c-acceptance-server.mjs as a child (its own PID is the only one ever killed).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const child = spawn(process.execPath, [path.join(ROOT, 'tests/manual/b2-4c-acceptance-server.mjs'), String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
let pass = 0; let fail = 0;
async function t(name, fn) { try { await fn(); pass += 1; console.log('  ✓ ' + name); } catch (e) { fail += 1; console.error('  ✗ ' + name + '\n      ' + String(e.message).split('\n').slice(0, 6).join(' | ')); } }
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'not ok'); };
async function mclick(page, sel) { const b = await page.evaluate((q) => { const el = document.querySelector(q); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel); if (!b) throw new Error('no element ' + sel); await page.mouse.click(b.x, b.y); await page.waitForTimeout(80); }
const A = (s) => `[data-acc="${s}"]`; const EL = (a) => `[data-action="fve-el-open"][data-act="${a}"]`;
try {
  for (let i = 0; i < 50 && !/acceptance kit/.test(out); i += 1) await new Promise((r) => setTimeout(r, 100));
  ok(/acceptance kit/.test(out), 'server did not start: ' + out);
  const browser = await chromium.launch({ args: ['--no-sandbox'] }); const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = []; const requests = [];
  const fresh = async () => { const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(String(e))); page.on('request', (r) => requests.push(r.url())); await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForSelector('#acc', { timeout: 15000 }); await page.waitForFunction(() => !!window.__accKit, null, { timeout: 15000 }); await page.waitForTimeout(500); return page; };
  const as = async (page, k) => { await mclick(page, A('as:' + k)); await page.waitForTimeout(1000); };
  const seed = async (page, k) => { await mclick(page, A('seed:' + k)); await page.waitForTimeout(900); };
  console.log('— B2-4c kit smoke — ' + browser.version());
  await t('1. boots with the overlay and 9 scenarios E1–E9, no external requests, no page errors, no leftover B2-3c wording', async () => {
    const p = await fresh(); eq(await p.$$eval('.sc b', (b) => b.filter((x) => /^E\d+\./.test(x.textContent)).length), 9, 'E1–E9'); eq(await p.$$eval('.sc b', (b) => b.filter((x) => /^C\d+\./.test(x.textContent)).length), 0);
    const ext = requests.filter((u) => !u.startsWith(`http://127.0.0.1:${PORT}`) && !u.startsWith('data:') && !u.startsWith('blob:') && !/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)/.test(u)); eq(ext.length, 0, ext.join(' '));
    ok((await p.$eval('#acc', (e) => e.innerText)).includes('B2-4c'), 'title'); eq(errors.length, 0, errors.join(' | ')); await p.close();
  });
  await t('2. the four seeders: head, suspended-by-IC, suspended with IC2 as contributor, head + submitted draft', async () => {
    for (const [k, who, expectState] of [['head', 'ic', 'سارية'], ['susp', 'ic', 'معلّقة'], ['suspC', 'ic2', 'معلّقة']]) {
      const p = await fresh(); await seed(p, k); if (who !== 'ic') await as(p, who); await p.waitForSelector('[data-fve="el-state"]', { timeout: 5000 }); eq((await p.$eval('[data-fve="el-state"]', (e) => e.textContent)).trim(), expectState, k); await p.close();
    }
    const p = await fresh(); await seed(p, 'both'); await p.waitForSelector(EL('suspend')); ok(await p.$('[data-action="fve-rv-open"][data-act="returnDraft"]'), 'both sections'); await p.close();
  });
  await t('3. the external-change controls: another user suspends H0 / a new head H1 replaces it (the page follows)', async () => {
    let p = await fresh(); await seed(p, 'head'); await p.waitForSelector(EL('suspend')); await mclick(p, A('ext-suspend'));
    await p.waitForFunction(() => (document.querySelector('[data-fve="el-state"]') || {}).textContent === 'معلّقة', null, { timeout: 6000 }); await p.close();
    p = await fresh(); await seed(p, 'head'); await p.waitForSelector(EL('suspend')); await mclick(p, A('ext-newhead')); await p.waitForFunction(() => /H1/.test((document.querySelector('[data-fve="el-head"]') || {}).textContent || ''), null, { timeout: 6000 }); await p.close();
  });
  await t('4. a full suspend through the kit leaves ONE server call in the log with the typed reason, and the export carries serverCalls, events and the results sheet (E1–E9)', async () => {
    const p = await fresh(); await seed(p, 'head'); await mclick(p, EL('suspend')); await p.waitForSelector('[data-fvp-field="el.reason"]'); await mclick(p, '[data-fvp-field="el.reason"]'); await p.keyboard.insertText('سبب من اللوحة');
    await mclick(p, '[data-action="fve-el-prepare"]'); await p.waitForSelector('[data-fve="prepared"]'); await mclick(p, '[data-action="fve-confirm-act"]'); await p.waitForTimeout(800);
    for (let i = 0; i < 4 && (await p.evaluate(() => window.__accKit.O.state.results.E1.status)) !== 'ok'; i += 1) { await mclick(p, A('ok:E1')); await p.waitForTimeout(250); }   // the overlay repaints itself every 1.5 s: a click that lands during a repaint is repeated
    const x = await p.evaluate(() => window.__accKit.O.exportData()); eq(x.kit, 'b2-4c'); eq(x.serverCalls.filter((c) => /suspend/i.test(c.callable)).length, 1); eq(x.serverCalls.find((c) => /suspend/i.test(c.callable)).reason, 'سبب من اللوحة');
    ok(Array.isArray(x.events) && x.events.length > 0, 'events'); eq(x.results.E1.status, 'ok'); eq(Object.keys(x.results).length, 9); ok(x.env && x.env.userAgent, 'env'); await p.close();
  });
  await t('5. loss of access and a user switch clear the eligibility form at once (the kit controls)', async () => {
    const p = await fresh(); await seed(p, 'head'); await mclick(p, EL('suspend')); await p.waitForSelector('[data-fvp-field="el.reason"]'); await mclick(p, '[data-fvp-field="el.reason"]'); await p.keyboard.insertText('يجب أن يُمسح');
    await mclick(p, A('as:ic2')); await p.waitForTimeout(500); ok(!(await p.content()).includes('يجب أن يُمسح'), 'cleared for the new user'); await p.evaluate(() => window.__accKit.O.actions.deny()); await p.waitForTimeout(400); eq(await p.$('[data-fve="eligibility"]'), null, 'no section after loss of access'); await p.close();
  });
  await browser.close();
} catch (e) { fail += 1; console.error('  ✗ harness: ' + e.message); } finally { child.kill(); }
console.log(`\n${pass} passed, ${fail} failed.`); process.exit(fail ? 1 : 0);
