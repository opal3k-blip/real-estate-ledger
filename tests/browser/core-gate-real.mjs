// R1-B2 / B2-2b-b0 round 2 — the PROPOSED render gate tested on the REAL core.js (loaded in headless Chromium, cloud container; NOT the user's machine).
// core.js is served unchanged, or replaced by the proposed copy with CORE_OVERRIDE=<path>. Firebase and the CDN libraries are stubbed/blocked, so the real onAuthStateChanged
// path (sign-in / sign-out), the real render() / renderInner() (#app.innerHTML), the real render-end and session-teardown hooks and the real registerMainView run.
// Usage: node tests/browser/core-gate-real.mjs   (ROOT = repo root; CORE_OVERRIDE optional; EXPECT_GATE=1 means the gate API must exist)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright');
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OVERRIDE = process.env.CORE_OVERRIDE ? path.resolve(process.env.CORE_OVERRIDE) : null;
const CORE_URL = '/src/core.js?v=20261011-b2-1-fund-valuation-panel';

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  let f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (OVERRIDE && u === '/src/core.js') f = OVERRIDE;
  if (!f.startsWith(ROOT) && f !== OVERRIDE) { res.statusCode = 403; return res.end('no'); }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('content-type', f.endsWith('.js') || f.endsWith('.mjs') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : f.endsWith('.css') ? 'text/css' : 'application/octet-stream');
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
console.log('— B2-2b/b0 render gate on the REAL core.js — ' + browser.version() + ' (headless, cloud; core.js ' + (OVERRIDE ? 'OVERRIDE ' + path.basename(path.dirname(OVERRIDE)) + '/core.js' : 'as served from ROOT') + ')');

// a stub of the firebase compat globals: enough for core.initDb(); sign-in/out are driven by calling window.__authCb(user | null)
const FIREBASE_STUB = `(() => {
  const mk = () => new Proxy(function () {}, { get(t, k) { if (k === 'then') return undefined; if (k === 'onSnapshot') return () => () => {}; if (k === 'docs') return []; if (k === 'exists') return false; if (k === 'data') return () => ({}); if (k === Symbol.toPrimitive) return () => ''; return mk(); }, apply() { return mk(); } });
  const db = mk();
  window.firebase = { initializeApp() {}, firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 0, delete: () => 0 } }), auth: () => ({ onAuthStateChanged(cb) { window.__authCb = cb; }, signOut: async () => {} }), functions: () => ({ httpsCallable: () => async () => ({ data: {} }) }), storage: () => mk() };
})();`;

const SETUP = `async ({ coreUrl, keeperUrl }) => {
  const core = await import(coreUrl); const K = await import(keeperUrl);
  const S = { text: '', perm: true, live: true }; const W = window.__gate = { S, renders: 0, log: [], allowed: true };
  const keeper = K.createFocusKeeper({ getRoot: () => document.getElementById('app') }); keeper.attach(); W.keeper = keeper; W.core = core;
  core.registerMainView('gate-spike', () => !S.perm ? '<div id="forbidden">no access</div>' : '<section data-fvp-section="editor" tabindex="-1" id="sec"><input id="gate-input" data-fvp-field="a" value="' + S.text + '"></section>');
  core.registerRenderEnd(() => { W.renders += 1; keeper.afterRender(); });
  core.registerSessionTeardown(() => { keeper.clear(); S.text = ''; });
  if (typeof core.registerRenderGate === 'function') { core.registerRenderGate(() => W.allowed && S.perm && keeper.isComposing()); document.addEventListener('compositionend', () => setTimeout(() => core.flushDeferredRender(), 0), true); }
  document.addEventListener('input', (e) => { if (!S.live || !e.target.isConnected || e.target.id !== 'gate-input') return; S.text = e.target.value; }, true);
  W.hasGate = typeof core.registerRenderGate === 'function';
  window.__authCb({ uid: 'u1', email: 'fm@example.com' });
  core.setCoreState({ mainView: 'gate-spike', render: true });
  return { hasGate: W.hasGate, field: !!document.getElementById('gate-input') };
}`;

const SETUP_FN = (0, eval)('(' + SETUP + ')');
async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } }); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route('**/*', (r) => (r.request().url().startsWith(base) ? r.continue() : r.abort()));
  await page.addInitScript(FIREBASE_STUB);
  await page.goto(base + '/index.html'); await page.waitForFunction(() => typeof window.__authCb === 'function', null, { timeout: 15000 });
  await page.waitForTimeout(300);
  const info = await page.evaluate(SETUP_FN, { coreUrl: CORE_URL, keeperUrl: '/src/features/fund-valuation-focus-keeper.js' });
  return { ctx, page, errors, info };
}
const box = async (page) => page.evaluate(() => { const r = document.getElementById('gate-input').getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; });
async function focusField(page) { const b = await box(page); await page.mouse.click(b.x, b.y); }
const st = (page) => page.evaluate(() => ({ renders: window.__gate.renders, v: (document.getElementById('gate-input') || {}).value ?? null, S: window.__gate.S.text, comp: window.__gate.keeper.isComposing(), field: !!document.getElementById('gate-input'), forbidden: !!document.getElementById('forbidden'), tracked: window.__gate.keeper.tracked() }));
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
let pass = 0; let fail = 0; const reports = [];
async function t(name, fn, report = false) {
  try { const out = await fn(); if (report) { reports.push(`RESULT ${name}: ${out}`); console.log(`  • ${name}: ${out}`); } else { pass += 1; console.log(`  ✓ ${name}`); } }
  catch (e) { if (report) { reports.push(`RESULT ${name}: ERROR ${e.message}`); console.log(`  • ${name}: ERROR ${e.message}`); } else { fail += 1; console.error(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 3).join(' | ')}`); } }
}
const hasGateExpected = process.env.EXPECT_GATE === '1';
const needGate = (info) => { if (!info.hasGate) throw new Error('this core.js has no registerRenderGate (run with CORE_OVERRIDE to test the proposal)'); };
const storm = (page, ms) => page.evaluate((m) => { window.__gate.timer = setInterval(() => window.__gate.core.render(), m); }, ms);
const stopStorm = (page) => page.evaluate(() => clearInterval(window.__gate.timer));

await t('G0 the page boots on the real core.js, signs in through the real auth path and renders the test view', async () => {
  const { ctx, page, info, errors } = await fresh(); eq(info.field, true, 'editor field rendered by the real renderInner'); eq(info.hasGate, hasGateExpected, 'gate API presence'); eq(errors.length, 0, 'page errors: ' + errors.join(' ; ')); await ctx.close();
});
await t('G1 control — IME composition under core.render() every 200 ms, no gate API on this core: text is corrupted (report only)', async () => {
  const { ctx, page, info } = await fresh(); if (info.hasGate) { await ctx.close(); return 'skipped: this core has a gate'; }
  await focusField(page); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('ab', { delay: 20 }); await storm(page, 200);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(500); await cdp.send('Input.imeSetComposition', { text: 'كت', selectionStart: 2, selectionEnd: 2 }); await page.waitForTimeout(300);
  await cdp.send('Input.insertText', { text: 'كتب' }); await page.waitForTimeout(300); await stopStorm(page); const s = await st(page); await ctx.close(); return JSON.stringify({ v: s.v, expected: 'abكتب' });
}, true);
async function composeLong({ holdMs, stormMs = 200, extra = async () => {} }) {
  const { ctx, page, info } = await fresh(); needGate(info);
  await focusField(page); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('ab', { delay: 20 });
  const before = (await st(page)).renders; await storm(page, stormMs);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(100);
  const mid0 = await st(page); eq(mid0.comp, true, 'composition open');
  await extra({ page, cdp }); await page.waitForTimeout(holdMs);
  return { ctx, page, cdp, before, mid: await st(page) };
}
await t('G2 a composition LONGER than 4 s (6 s) under core.render() every 200 ms: no render runs during it, the node stays, nothing is lost', async () => {
  const { ctx, page, cdp, mid } = await composeLong({ holdMs: 6000 });
  const r0 = mid.renders; await page.waitForTimeout(600); const r1 = (await st(page)).renders; eq(r1, r0, 'renders while composing');
  await cdp.send('Input.imeSetComposition', { text: 'كت', selectionStart: 2, selectionEnd: 2 }); await page.waitForTimeout(150);
  await cdp.send('Input.insertText', { text: 'كتب' });            // commit
  await page.waitForTimeout(150);
  const end = await st(page); eq(end.v, 'abكتب', 'text after commit'); eq(end.S, 'abكتب', 'state after commit'); eq(end.comp, false, 'composition closed'); await page.evaluate(() => clearInterval(window.__gate.timer)); await ctx.close();
});
await t('G3 the deferred render is flushed right after the composition ends (<= 150 ms, i.e. by the compositionend flush, not by the 250 ms retry timer), and the text survives that render', async () => {
  const { ctx, page, cdp, mid } = await composeLong({ holdMs: 1200 });
  const r0 = mid.renders; await cdp.send('Input.insertText', { text: 'كتب' }); const t0 = Date.now();
  await page.waitForFunction((r) => window.__gate.renders > r, r0, { timeout: 2000 }); const dt = Date.now() - t0; if (dt > 150) throw new Error('flush took ' + dt + ' ms');
  const end = await st(page); eq(end.v, 'abكتب', 'text'); eq(end.field, true); await page.evaluate(() => clearInterval(window.__gate.timer)); await ctx.close();
});
await t('G4 the flush does not depend on a later render() call or compositionend: with no storm and no event, the retry timer renders once the gate stops holding', async () => {
  const { ctx, page, info } = await fresh(); needGate(info); await focusField(page); const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(100);
  await page.evaluate(() => { window.__gate.core.render(); }); const r0 = (await st(page)).renders;            // deferred, once
  await page.evaluate(() => { window.__gate.allowed = false; }); await page.waitForFunction((r) => window.__gate.renders > r, r0, { timeout: 1500 });
  await ctx.close();
});
await t('G5 a REAL composition held for 32 s (past the old 30 s limit) under core.render() every 200 ms: no render runs at any moment, the node stays, and after the commit the text is intact', async () => {
  const { ctx, page, cdp, before } = await composeLong({ holdMs: 100 });
  const r0 = (await st(page)).renders; const samples = [];
  for (let k = 0; k < 8; k += 1) {                                  // 8 x 4 s = 32 s of real time; the composition is kept alive with updates
    await page.waitForTimeout(4000);
    await cdp.send('Input.imeSetComposition', { text: k % 2 ? 'كت' : 'ك', selectionStart: 1, selectionEnd: 1 });
    const s1 = await st(page); samples.push(s1.renders - r0); eq(s1.comp, true, 'still composing at ~' + (k + 1) * 4 + ' s'); eq(s1.field, true, 'node still there');
  }
  eq(samples.every((n) => n === 0), true, 'renders during the hold: ' + JSON.stringify(samples));
  const t0 = Date.now(); await cdp.send('Input.insertText', { text: 'كتب' });
  await page.waitForFunction((r) => window.__gate.renders > r, r0, { timeout: 2000 }); const dt = Date.now() - t0; if (dt > 400) throw new Error('flush took ' + dt + ' ms');
  const end = await st(page); eq(end.v, 'abكتب', 'text after commit'); eq(end.S, 'abكتب', 'state after commit'); eq(end.comp, false, 'closed'); void before;
  await page.evaluate(() => clearInterval(window.__gate.timer)); await ctx.close();
});
await t('G5b the composition node is REMOVED while composing (no compositionend relied on): the gate stops holding by node state and the deferred render runs, with no further render() call', async () => {
  const { ctx, page, info } = await fresh(); needGate(info); await focusField(page); const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(100);
  await page.evaluate(() => { window.__gate.core.render(); }); const r0 = (await st(page)).renders; eq(r0, (await st(page)).renders);
  const comp = await page.evaluate(() => { const g = window.__gate; document.getElementById('gate-input').remove(); return g.keeper.isComposing(); });
  eq(comp, false, 'isComposing right after the node left the page');
  await page.waitForFunction((r) => window.__gate.renders > r, r0, { timeout: 1500 }); const s = await st(page); eq(s.field, true, 'view re-rendered'); await ctx.close();
});
await t('G5c FOCUS LEAVES the composition node (focus moved elsewhere): the gate stops holding and the deferred render runs, with no further render() call', async () => {
  const { ctx, page, info } = await fresh(); needGate(info); await focusField(page); const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(100);
  await page.evaluate(() => { window.__gate.core.render(); }); const r0 = (await st(page)).renders;
  const comp = await page.evaluate(() => { document.getElementById('sec').focus(); return window.__gate.keeper.isComposing(); });
  eq(comp, false, 'isComposing right after focus left the node');
  await page.waitForFunction((r) => window.__gate.renders > r, r0, { timeout: 1500 }); await ctx.close();
});
await t('G6 LEAVING THE VIEW during a composition renders at once (no 250 ms wait): the editor is gone', async () => {
  const { ctx, page } = await composeLong({ holdMs: 200 });
  const res = await page.evaluate(() => { const r = window.__gate.renders; window.__gate.core.setCoreState({ mainView: null, render: true }); return { dr: window.__gate.renders - r, field: !!document.getElementById('gate-input') }; });
  eq(res.dr >= 1, true, 'rendered synchronously'); eq(res.field, false, 'editor gone'); await page.evaluate(() => clearInterval(window.__gate.timer)); await ctx.close();
});
await t('G7 SESSION LOSS (sign-out through the real onAuthStateChanged) during a composition: torn down and rendered at once, nothing of the text remains or comes back', async () => {
  const { ctx, page } = await composeLong({ holdMs: 200 });
  const res = await page.evaluate(() => { window.__authCb(null); const g = window.__gate; return { field: !!document.getElementById('gate-input'), text: g.S.text, tracked: g.keeper.tracked() }; });
  eq(res.field, false, 'editor gone synchronously'); eq(res.text, '', 'state cleared'); eq(res.tracked, null, 'keeper cleared');
  await page.waitForTimeout(700); const s = await st(page); eq(s.field, false, 'nothing comes back after the gate retry'); eq(s.S, '', 'state still empty'); await page.evaluate(() => clearInterval(window.__gate.timer)); await ctx.close();
});
await t('G8 USER SWITCH during a composition (u1 -> u2 in one callback): same, and the new session starts empty', async () => {
  const { ctx, page } = await composeLong({ holdMs: 200 });
  const res = await page.evaluate(() => { window.__authCb({ uid: 'u2', email: 'fm2@example.com' }); const g = window.__gate; return { text: g.S.text, tracked: g.keeper.tracked(), value: (document.getElementById('gate-input') || {}).value ?? null }; });
  eq(res.text, '', 'state cleared'); eq(res.tracked, null, 'keeper cleared'); eq(res.value === null || res.value === '', true, 'no old text on screen'); await page.evaluate(() => clearInterval(window.__gate.timer)); await ctx.close();
});
await t('G9 PERMISSION LOSS during a composition: the panel predicate says "no": the next render() runs at once and shows no editor', async () => {
  const { ctx, page } = await composeLong({ holdMs: 200 });
  const res = await page.evaluate(() => { const g = window.__gate; g.keeper.clear(); g.S.text = ''; g.S.perm = false; const r = g.renders; g.core.render(); return { dr: g.renders - r, field: !!document.getElementById('gate-input'), forbidden: !!document.getElementById('forbidden') }; });
  eq(res.dr >= 1, true, 'rendered synchronously'); eq(res.field, false, 'editor gone'); eq(res.forbidden, true, 'forbidden view'); await page.evaluate(() => clearInterval(window.__gate.timer)); await ctx.close();
});
await t('G10 no composition: plain typing under core.render() every 100 ms is unaffected by the gate (renders keep running, text intact)', async () => {
  const { ctx, page, info } = await fresh(); needGate(info); await focusField(page); await storm(page, 100); const r0 = (await st(page)).renders;
  await page.keyboard.type('plain typing under renders 123', { delay: 25 }); await stopStorm(page);
  const s = await st(page); eq(s.v, 'plain typing under renders 123'); eq(s.renders > r0 + 5, true, 'renders ran'); await ctx.close();
});
await t('G11 a gate function that throws does not break core.render()', async () => {
  const { ctx, page, info } = await fresh(); needGate(info);
  const res = await page.evaluate(() => { const g = window.__gate; g.core.registerRenderGate(() => { throw new Error('boom'); }); const r = g.renders; g.core.render(); return g.renders - r; }); eq(res >= 1, true, 'rendered'); await ctx.close();
});

await t('G12 after the deferred render ran, nothing is pending: a further flushDeferredRender() renders nothing, and the retry timer is gone', async () => {
  const { ctx, page, cdp, mid } = await composeLong({ holdMs: 600 });
  await page.evaluate(() => clearInterval(window.__gate.timer)); await cdp.send('Input.insertText', { text: 'كتب' }); await page.waitForTimeout(400);
  const r0 = (await st(page)).renders; await page.evaluate(() => window.__gate.core.flushDeferredRender()); await page.waitForTimeout(500);
  eq((await st(page)).renders, r0, 'renders after a needless flush / stray timer'); void mid; await ctx.close();
});

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed.`); for (const r of reports) console.log(r);
process.exit(fail ? 1 : 0);
