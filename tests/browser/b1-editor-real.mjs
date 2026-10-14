// R1-B2 / B2-2b-b1 — the EDITOR (view + wiring + keeper + gate) on the REAL core.js, in headless Chromium (cloud container; NOT the user's machine).
// Real: index.html, core.js (CORE_OVERRIDE optional), the real render()/auth path (window.__authCb drives onAuthStateChanged), registerFundDetailSection / RenderEnd / SessionTeardown /
// ActionHandler / RenderGate, the real panel registration (registerFundValuationPanel) with the real reader, actions, request runner and focus keeper.
// Faked: Firebase + CDN (stub / blocked), the Firestore listener + explicit server read (in-page fake), the callables (the in-page fake server of the unit tests), and IME (CDP imeSetComposition).
// Usage: node tests/browser/b1-editor-real.mjs   (ROOT = repo root; CORE_OVERRIDE optional)
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
  const u = decodeURIComponent(req.url.split('?')[0]); let f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (OVERRIDE && u === '/src/core.js') f = OVERRIDE;
  if (!f.startsWith(ROOT) && f !== OVERRIDE) { res.statusCode = 403; return res.end('no'); }
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('content-type', f.endsWith('.js') || f.endsWith('.mjs') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : f.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
console.log('— B2-2b/b1 editor on the REAL core.js — ' + browser.version() + ' (headless, cloud; core.js ' + (OVERRIDE ? 'OVERRIDE' : 'as served from ROOT') + ')');

const FIREBASE_STUB = `(() => {
  const mk = () => new Proxy(function () {}, { get(t, k) { if (k === 'then') return undefined; if (k === 'onSnapshot') return () => () => {}; if (k === 'docs') return []; if (k === 'exists') return false; if (k === 'data') return () => ({}); if (k === Symbol.toPrimitive) return () => ''; return mk(); }, apply() { return mk(); } });
  const db = mk();
  window.firebase = { initializeApp() {}, firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 0, delete: () => 0 } }), auth: () => ({ onAuthStateChanged(cb) { window.__authCb = cb; }, signOut: async () => {} }), functions: () => ({ httpsCallable: () => async () => ({ data: {} }) }), storage: () => mk() };
})();`;

const SETUP = `async ({ coreUrl, panelUrl, serverUrl, fakesUrl }) => {
  const core = await import(coreUrl); const P = await import(panelUrl); const S = await import(serverUrl); const F = await import(fakesUrl);
  const clock = { now: new Date('2026-10-11T10:00:00Z') }; const srv = S.makeServer({ clock }); const box = { s: { uid: 'u1', email: 'fm@example.com', role: 'fund_manager', roleResolved: true } };
  const fake = F.makeFakeSubscribe(); const net = { calls: [], auto: true };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const snapshot = () => { const heads = []; const valuations = []; for (const d of srv.vals.values()) { valuations.push({ id: d.valuationId, data: clone(d) }); if (srv.slotId(d.fundId, d.valuationDate) === d.valuationId) heads.push({ id: d.fundId + '__' + d.valuationDate, data: { fundId: d.fundId, valuationDate: d.valuationDate, headId: null, version: 0, headHash: null, eligibility: null, activeDraftId: d.valuationId, rev: 1 } }); } return { heads, valuations }; };
  const fetchOnce = (source, fundId) => new Promise((resolve) => { const c = { source, resolve, at: snapshot() }; net.calls.push(c); if (net.auto) resolve({ docs: c.at[source], fromCache: false }); });
  net.releaseAll = () => { for (const c of net.calls) if (!c.done) { c.done = true; c.resolve({ docs: snapshot()[c.source], fromCache: false }); } };
  const listen = () => { const s = snapshot(); fake.emit('heads', 'F1', s.heads); fake.emit('valuations', 'F1', s.valuations); fake.emit('events', 'F1', []); };
  const store = new Map(); const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
  let seq = 0;
  const reader = P.registerFundValuationPanel(core, {
    subscribe: fake.subscribe, fetchOnce, getSession: () => (box.s ? { ...box.s } : { uid: null, email: null, role: null, roleResolved: false }),
    editorDeps: { call: (callable, payload, { user }) => srv.handle(user, callable, payload), storage, locks: new S.FakeLocks(), getFundAssetIds: () => ['A1', 'A2'], doc: document, win: window, now: () => clock.now, genId: () => 'req_' + String(++seq).padStart(6, '0') },
  });
  let renders = 0; core.registerRenderEnd(() => { renders += 1; });
  window.__b1 = { core, reader, wiring: reader.editor, box, clock, srv, net, fake, listen, storage, store, renderCount: () => renders, snapshot };
  window.__authCb({ uid: 'u1', email: 'fm@example.com' });
  core.STORE.funds = [{ id: 'F1', data: Object.assign(core.blankFund ? core.blankFund() : {}, { name: 'F One', assetIds: ['A1', 'A2'] }) }];
  core.setCoreState({ fundsViewOpen: true, fundsSubTab: 'funds', openFundId: 'F1', render: true });
  listen();
  return { hasEditor: !!reader.editor, root: !!document.querySelector('[data-fve="root"]') };
}`;
const SETUP_FN = (0, eval)('(' + SETUP + ')');
async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } }); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });   // blocked CDN loads are expected
  await ctx.route('**/*', (r) => {
    const url = r.request().url(); if (!url.startsWith(base)) return r.abort();
    if (/\/fund-valuation-panel\.js/.test(url) && !/real=1/.test(url)) return r.fulfill({ status: 200, contentType: 'text/javascript', body: 'export function registerFundValuationPanel(){ return null; }\nexport function renderPanel(){ return ""; }\nexport const esc = (v)=>String(v); export const fmtAmount = (v)=>String(v); export function makeFirestoreSubscribe(){} export function makeFirestoreFetchOnce(){} export function makeSession(){}' });
    return r.continue();
  });
  await page.addInitScript(FIREBASE_STUB);
  await page.goto(base + '/index.html'); await page.waitForFunction(() => typeof window.__authCb === 'function', null, { timeout: 15000 }); await page.waitForTimeout(400);
  const info = await page.evaluate(SETUP_FN, { coreUrl: CORE_URL, panelUrl: '/src/features/fund-valuation-panel.js?real=1', serverUrl: '/tests/helpers/fund-valuation-server-fake.mjs', fakesUrl: '/tests/helpers/fund-valuation-fakes.mjs' });
  await page.waitForSelector('[data-fve="root"]', { timeout: 5000 }).catch(() => {});
  return { ctx, page, errors, info };
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'not ok'); };
async function rectOf(page, sel) { return page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + Math.min(12, r.width / 2), y: r.y + r.height / 2 }; }, sel); }
async function click(page, sel) { const b = await rectOf(page, sel); if (!b) throw new Error('no element ' + sel); await page.mouse.click(b.x, b.y); await page.waitForTimeout(60); }
const F = (p) => `[data-fvp-field="${p}"]`;
const act = (a, extra = '') => `[data-action="${a}"]${extra}`;
const model = (page) => page.evaluate(() => { const s = window.__b1.wiring.actions.getState(); return { editor: !!s.editor, form: s.editor && JSON.parse(JSON.stringify(s.editor.form)), dirty: s.editor && s.editor.dirty, frozen: s.editor && s.editor.frozen, awaiting: s.awaiting, scope: s.scope && s.scope.valuationDate }; });
const dom = (page) => page.evaluate(() => ({ root: !!document.querySelector('[data-fve="root"]'), editor: !!document.querySelector('#fve-editor'), active: (document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute('data-fvp-field')) || null,
  renders: window.__b1.renderCount(), comp: window.__b1.wiring.holdsRender(), html: document.documentElement.innerHTML, warn: !!document.querySelector('[data-fve="day-warning"]') }));
const storm = (page, ms) => page.evaluate((m) => { window.__storm = setInterval(() => window.__b1.core.render(), m); }, ms);
const stopStorm = (page) => page.evaluate(() => clearInterval(window.__storm));
let pass = 0; let fail = 0;
async function t(name, fn) { try { await fn(); pass += 1; console.log(`  ✓ ${name}`); } catch (e) { fail += 1; console.error(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 3).join(' | ')}`); } }
async function startEditor(page) { await click(page, act('fve-create')); await page.waitForSelector('#fve-editor', { timeout: 3000 }); }

await t('E0 the page boots on the real core.js; the editor slot is rendered under the fund detail by the real section hook; no page errors', async () => {
  const { ctx, page, info, errors } = await fresh(); ok(info.hasEditor, 'editor wiring created'); ok(info.root, 'editor slot rendered'); eq(errors.length, 0, 'errors: ' + errors.join(' ; '));
  ok(await page.$(act('fve-create')), 'create button'); await ctx.close();
});
await t('E1 TYPING: 200 characters one by one into a text area while core.render() runs every 40 ms: nothing lost, focus kept, caret at the end, model equals the field', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); await storm(page, 40);
  const text = 'abcdefghij'.repeat(20); await page.keyboard.type(text, { delay: 6 }); await stopStorm(page); await page.waitForTimeout(150);
  const v = await page.evaluate(() => { const e = document.querySelector('[data-fvp-field="methodNote"]'); return { value: e.value, start: e.selectionStart, end: e.selectionEnd }; });
  eq(v.value.length, 200, 'length'); eq(v.value, text.slice(0, 200)); eq(v.start, 200, 'caret'); eq((await model(page)).form.methodNote, text, 'model'); eq((await dom(page)).active, 'methodNote', 'focus');
  ok((await dom(page)).renders > 20, 'renders actually ran'); await ctx.close();
});
await t('E2 TYPING in the MIDDLE of a numeric field under renders: the caret keeps its place', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('components.assetsValue')); await storm(page, 30);
  await page.keyboard.type('123456', { delay: 15 }); await page.evaluate(() => { const e = document.activeElement; e.setSelectionRange(3, 3); }); /* ArrowLeft does not move the caret in this headless Chromium (even in a plain input), so the caret is placed by script */ await page.keyboard.type('X', { delay: 15 }); await page.waitForTimeout(150); await stopStorm(page);
  const v = await page.evaluate(() => { const e = document.querySelector('[data-fvp-field="components.assetsValue"]'); return { value: e.value, start: e.selectionStart }; });
  eq(v.value, '123X456'); eq(v.start, 4, 'caret after X'); eq((await model(page)).form.components.assetsValue, '123X456'); await ctx.close();
});
await t('E2b the caret is read at the START of a render: a caret moved by script and rendered in the SAME task (no selectionchange yet) is still restored', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('components.assetsValue')); await page.keyboard.type('123456', { delay: 15 });
  await page.evaluate(() => { const e = document.activeElement; e.setSelectionRange(3, 3); window.__b1.core.render(); });
  await page.keyboard.type('X', { delay: 15 }); await page.waitForTimeout(150);
  const v = await page.evaluate(() => { const e = document.querySelector('[data-fvp-field="components.assetsValue"]'); return { value: e.value, start: e.selectionStart }; });
  eq(v.value, '123X456'); eq(v.start, 4, 'caret after X'); eq((await model(page)).form.components.assetsValue, '123X456'); await ctx.close();
});
await t('E14 READ DENIED by the server during an IME composition (the local role is still fund_manager): the editor is gone from the page at once — the composition hold does not delay it — and the typed text is nowhere', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('SECRET-D', { delay: 12 });
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(120); eq((await dom(page)).comp, true, 'held');
  await page.evaluate(() => { window.__b1.fake.fail('heads', 'F1', Object.assign(new Error('no'), { code: 'permission-denied' })); }); await page.waitForTimeout(60);   /* well under the gate's 250 ms retry: the hold itself did not wait */
  const res = await page.evaluate(() => { const b = window.__b1; return { status: b.reader.getView().status, root: !!document.querySelector('[data-fve="root"]'), field: !!document.querySelector('[data-fvp-field="methodNote"]'), editors: b.wiring.actions.stats().editors, hold: b.wiring.holdsRender(), html: document.documentElement.innerHTML.includes('SECRET-D') }; });
  eq(res.status, 'denied'); eq(res.root, false, 'slot gone with no explicit render call'); eq(res.field, false); eq(res.editors, 0); eq(res.hold, false); eq(res.html, false, 'text not in the page');
  await cdp.send('Input.insertText', { text: 'LATEZQ' }); await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ html: document.documentElement.innerHTML.includes('SECRET-D') || document.documentElement.innerHTML.includes('LATEZQ'), editors: window.__b1.wiring.actions.stats().editors })); eq(after.html, false, 'late composition text does not come back'); eq(after.editors, 0); await ctx.close();
});
await t('E15 ROLE UNRESOLVED during an IME composition: the editor is gone at the next render at once; when the role resolves again the old text does not return', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('SECRET-R', { delay: 12 });
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(120); eq((await dom(page)).comp, true);
  const res = await page.evaluate(() => { const b = window.__b1; b.box.s = { ...b.box.s, roleResolved: false }; b.core.render(); return { root: !!document.querySelector('[data-fve="root"]'), editors: b.wiring.actions.stats().editors, hold: b.wiring.holdsRender(), html: document.documentElement.innerHTML.includes('SECRET-R') }; });
  eq(res.root, false); eq(res.editors, 0); eq(res.hold, false); eq(res.html, false);
  const back = await page.evaluate(() => { const b = window.__b1; b.box.s = { ...b.box.s, roleResolved: true }; b.core.render(); b.listen(); b.core.render(); return { editor: !!document.querySelector('#fve-editor'), editors: b.wiring.actions.stats().editors, html: document.documentElement.innerHTML.includes('SECRET-R') }; });
  eq(back.editor, false, 'no editor comes back'); eq(back.editors, 0); eq(back.html, false); await ctx.close();
});
await t('E3 the PAGE scroll position survives typing under renders (the field sits low on the page)', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('source.provider')); const y0 = await page.evaluate(() => Math.round(window.scrollY)); ok(y0 > 0, 'page scrolled to reach the field');
  await storm(page, 40); await page.keyboard.type('Valuer Company', { delay: 25 }); await stopStorm(page); await page.waitForTimeout(120);
  const y1 = await page.evaluate(() => Math.round(window.scrollY)); ok(Math.abs(y1 - y0) <= 2, `scrollY ${y0} -> ${y1}`); eq((await model(page)).form.source.provider, 'Valuer Company'); await ctx.close();
});
await t('E16 a scroll the person just made (its scroll event not delivered yet) is not undone by a render in the same task (the root cause found for the T6 flake)', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('source.provider')); await page.waitForTimeout(150);
  const y0 = await page.evaluate(() => Math.round(window.scrollY)); ok(y0 > 200, 'page scrolled to reach the field: ' + y0);
  const r = await page.evaluate((y) => { window.scrollTo(0, y - 150); window.__b1.core.render(); return { sync: Math.round(window.scrollY) }; }, y0);
  await page.waitForTimeout(150); const later = await page.evaluate(() => Math.round(window.scrollY));
  eq(r.sync, y0 - 150, 'right after the render'); eq(later, y0 - 150, 'and later'); await ctx.close();
});
await t('E17 SPACE on a checkbox / a button: a render between key-down and key-up does not lose the activation (root cause found for the T5 flake); the render waits for the key-up, then runs', async () => {
  const { ctx, page } = await fresh(); await startEditor(page);
  const cb = F('nonOverlap.cashNotInAssets'); await page.evaluate((q) => { const el = document.querySelector(q); el.scrollIntoView({ block: 'center' }); el.focus(); }, cb); await page.waitForTimeout(80);
  await page.keyboard.down('Space'); const r0 = await page.evaluate(() => { const b = window.__b1; const n = b.renderCount(); b.core.render(); return { n, after: b.renderCount(), hold: b.wiring.holdsRender() }; });
  await page.keyboard.up('Space'); await page.waitForTimeout(450);
  eq(r0.after, r0.n, 'no render while the key is down'); eq(r0.hold, true, 'the gate holds'); eq((await model(page)).form.nonOverlap.cashNotInAssets, true, 'the checkbox toggled');
  ok((await page.evaluate(() => window.__b1.renderCount())) > r0.n, 'the held render ran after the key-up'); eq((await page.evaluate(() => window.__b1.wiring.holdsRender())), false, 'released');
  // a button: Space on "add item"
  const addBtn = act('fve-add-item', '[data-list="otherAssetsItems"]'); await page.evaluate((q) => { const el = document.querySelector(q); el.scrollIntoView({ block: 'center' }); el.focus(); }, addBtn); await page.waitForTimeout(80);
  await page.keyboard.down('Space'); await page.evaluate(() => window.__b1.core.render()); await page.keyboard.up('Space'); await page.waitForTimeout(450);
  ok(await page.$(F('otherAssetsItems.0.description')), 'the button press was not lost'); await ctx.close();
});
await t('E17b the key-press hold never outlives its node: focus moved away / node removed / permission lost ⇒ no hold', async () => {
  const { ctx, page } = await fresh(); await startEditor(page);
  const cb = F('nonOverlap.cashNotInAssets'); await page.evaluate((q) => { const el = document.querySelector(q); el.scrollIntoView({ block: 'center' }); el.focus(); }, cb); await page.waitForTimeout(80);
  await page.keyboard.down('Space'); eq(await page.evaluate(() => window.__b1.wiring.holdsRender()), true, 'held');
  eq(await page.evaluate(() => { document.activeElement.blur(); return window.__b1.wiring.holdsRender(); }), false, 'blur releases'); await page.keyboard.up('Space');
  await page.evaluate((q) => document.querySelector(q).focus(), cb); await page.keyboard.down('Space');
  eq(await page.evaluate(() => { const b = window.__b1; b.box.s = { ...b.box.s, role: 'viewer' }; b.core.render(); return !!document.querySelector('[data-fve="root"]') || b.wiring.holdsRender(); }), false, 'permission loss is never held'); await page.keyboard.up('Space'); await ctx.close();
});
await t('E17c a Space hold is dropped when the WINDOW loses focus: no key-up arrives, and the hold does not come back with the focus (no new press)', async () => {
  const { ctx, page } = await fresh(); await startEditor(page);
  const cb = F('nonOverlap.cashNotInAssets'); await page.evaluate((q) => { const el = document.querySelector(q); el.scrollIntoView({ block: 'center' }); el.focus(); }, cb); await page.waitForTimeout(80);
  // (a) the window-blur EVENT arrives; the key-up goes to another window and never reaches this page
  await page.keyboard.down('Space'); eq(await page.evaluate(() => window.__b1.wiring.holdsRender()), true, 'held while Space is down');
  eq(await page.evaluate(() => { const real = document.hasFocus; document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); document.hasFocus = real; return window.__b1.wiring.holdsRender(); }), false, 'back with the focus and no key-up: NOT held');
  await page.keyboard.up('Space');
  // (b) no blur event is delivered at all; the gate is asked while the document has no focus
  await page.evaluate((q) => document.querySelector(q).focus(), cb); await page.keyboard.down('Space'); eq(await page.evaluate(() => window.__b1.wiring.holdsRender()), true, 'held again by a NEW press');
  eq(await page.evaluate(() => { const real = document.hasFocus; document.hasFocus = () => false; const during = window.__b1.wiring.holdsRender(); document.hasFocus = real; return JSON.stringify([during, window.__b1.wiring.holdsRender()]); }), '[false,false]', 'asked while unfocused: not held, and not held after the focus returns');
  await page.keyboard.up('Space'); await ctx.close();
});
await t('E17d only the release of SPACE ends a Space hold: Shift (or any other key) coming up does not', async () => {
  const { ctx, page } = await fresh(); await startEditor(page);
  const cb = F('nonOverlap.cashNotInAssets'); await page.evaluate((q) => { const el = document.querySelector(q); el.scrollIntoView({ block: 'center' }); el.focus(); }, cb); await page.waitForTimeout(80);
  await page.keyboard.down('Space'); await page.keyboard.down('Shift'); await page.keyboard.up('Shift');
  eq(await page.evaluate(() => window.__b1.wiring.holdsRender()), true, 'Shift up: Space is still down, still held');
  await page.keyboard.up('Space'); eq(await page.evaluate(() => window.__b1.wiring.holdsRender()), false, 'Space up releases'); await ctx.close();
});
await t('E4 IME COMPOSITION 6 s under renders every 200 ms (editor field): no render during it, then the commit leaves the text intact in field and model', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('ab', { delay: 20 }); await storm(page, 200);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(100); const r0 = (await dom(page)).renders; eq((await dom(page)).comp, true, 'holds');
  await page.waitForTimeout(6000); eq((await dom(page)).renders, r0, 'no render while composing');
  await cdp.send('Input.imeSetComposition', { text: 'كت', selectionStart: 2, selectionEnd: 2 }); await page.waitForTimeout(150); await cdp.send('Input.insertText', { text: 'كتب' }); await page.waitForTimeout(500); await stopStorm(page);
  const v = await page.evaluate(() => document.querySelector('[data-fvp-field="methodNote"]').value); eq(v, 'abكتب', 'field'); eq((await model(page)).form.methodNote, 'abكتب', 'model'); ok((await dom(page)).renders > r0, 'the deferred render ran after the commit'); await ctx.close();
});
await t('E5 controls by real clicks: select (method), checkbox (non-overlap), radio (unlinked) reach the model', async () => {
  const { ctx, page } = await fresh(); await startEditor(page);
  await page.selectOption(F('method'), 'appraisal'); await page.waitForTimeout(100);
  await click(page, F('nonOverlap.cashNotInAssets')); await click(page, F('coverage.unlinkedHoldings.declared:none'));
  const f = (await model(page)).form; eq(f.method, 'appraisal'); eq(f.nonOverlap.cashNotInAssets, true); eq(f.coverage.unlinkedHoldings.declared, 'none');
  await click(page, act('fve-add-item', '[data-list="otherAssetsItems"]')); ok(await page.$(F('otherAssetsItems.0.description')), 'row added'); await ctx.close();
});
await t('E6 USER SWITCH mid-typing (u1 -> u2 through the real onAuthStateChanged): the typed text is nowhere — not in the page, not in the model — and typing on does not bring it back', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); await page.keyboard.type('SECRET-U1', { delay: 10 });
  const res = await page.evaluate(() => { const b = window.__b1; b.box.s = { uid: 'u2', email: 'fm2@example.com', role: 'fund_manager', roleResolved: true }; window.__authCb({ uid: 'u2', email: 'fm2@example.com' });
    const inputs = [...document.querySelectorAll('input,textarea')].map((e) => e.value).join('|'); return { html: document.documentElement.innerHTML.includes('SECRET-U1'), inputs: inputs.includes('SECRET-U1'), editors: b.wiring.actions.stats().editors, pins: b.wiring.pins.size }; });
  eq(res.html, false, 'html'); eq(res.inputs, false, 'inputs'); eq(res.editors, 0, 'editors'); eq(res.pins, 0, 'pins'); await page.keyboard.type('more', { delay: 10 }); await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({ html: document.documentElement.innerHTML.includes('SECRET-U1'), editors: window.__b1.wiring.actions.stats().editors, email: window.__b1.wiring.actions.getState().session && window.__b1.wiring.actions.getState().session.email }));
  eq(after.html, false); eq(after.editors, 0); ok(after.email === null || after.email === 'fm2@example.com', 'session is the new user or none: ' + after.email); eq((await dom(page)).editor, false, 'no editor'); await ctx.close();
});
await t('E7 SIGN-OUT during an open composition: torn down and rendered at once; nothing comes back after the gate\'s retry interval', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('ab', { delay: 20 }); await storm(page, 150);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(150);
  const res = await page.evaluate(() => { const b = window.__b1; b.box.s = null; window.__authCb(null); return { editor: !!document.querySelector('#fve-editor'), editors: b.wiring.actions.stats().editors, pins: b.wiring.pins.size, html: document.documentElement.innerHTML.includes('ab') && !!document.querySelector('[data-fvp-field="methodNote"]') }; });
  eq(res.editor, false, 'editor gone synchronously'); eq(res.editors, 0); eq(res.pins, 0); await page.waitForTimeout(700); await stopStorm(page); eq((await dom(page)).editor, false, 'nothing re-appears'); await ctx.close();
});
await t('E8 PERMISSION LOSS during a composition: the next render() shows no editor at once (the hold lets go)', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(120); eq((await dom(page)).comp, true);
  const res = await page.evaluate(() => { const b = window.__b1; b.box.s = { ...b.box.s, role: 'viewer' }; b.core.render(); return { root: !!document.querySelector('[data-fve="root"]'), editors: b.wiring.actions.stats().editors, hold: b.wiring.holdsRender() }; });
  eq(res.root, false, 'slot gone'); eq(res.editors, 0, 'input gone'); eq(res.hold, false); await ctx.close();
});
await t('E9 LEAVING the fund view during a composition renders at once; coming back, the unsent text is still there but focus is not forced into it', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('keep', { delay: 15 });
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(120);
  const gone = await page.evaluate(() => { window.__b1.core.setCoreState({ openFundId: null, render: true }); return !!document.querySelector('#fve-editor'); }); eq(gone, false, 'editor gone synchronously');
  await page.evaluate(() => window.__b1.core.setCoreState({ openFundId: 'F1', render: true })); await page.waitForSelector('#fve-editor');
  const m = await model(page); ok(m.form.methodNote.startsWith('keep'), 'unsent input kept in memory'); ok((await dom(page)).active !== 'methodNote', 'focus not re-seated'); await ctx.close();
});
await t('E10 THE DAY CROSSES with an open editor: a fixed warning, the input stays, saving is disabled, nothing is moved or hidden', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); await page.keyboard.type('draft text', { delay: 10 });
  await page.evaluate(() => { window.__b1.clock.now = new Date('2026-10-12T01:00:00Z'); window.__b1.core.render(); });
  const d = await dom(page); ok(d.warn, 'warning'); ok(d.editor, 'editor still shown'); eq((await model(page)).form.methodNote, 'draft text'); eq((await model(page)).scope, '2026-10-11', 'still pinned to the old day');
  ok(await page.$(act('fve-save') + '[disabled]'), 'save disabled'); await page.keyboard.type('!', { delay: 10 }); eq((await model(page)).form.methodNote, 'draft text!', 'typing still reaches the model');
  await click(page, act('fve-move-day')); ok(await page.$(act('fve-move-day-confirm')), 'confirmation shown, nothing moved yet'); eq((await model(page)).scope, '2026-10-11');
  await click(page, act('fve-move-day-confirm')); await page.waitForTimeout(100); const m = await model(page); eq(m.scope, '2026-10-12'); eq(m.form.methodNote, 'draft text!'); eq(m.form.coverage.linkedAssets.confirmed, false); eq((await dom(page)).warn, false); await ctx.close();
});
await t('E11 REFRESH button: one click starts one read, the button is disabled while it is in flight and a second click does nothing; it is enabled again afterwards', async () => {
  const { ctx, page } = await fresh(); await page.evaluate(() => { window.__b1.net.auto = false; });
  await click(page, act('fve-refresh')); await page.waitForTimeout(100); const s1 = await page.evaluate(() => ({ issued: window.__b1.reader.getView().read.issued, inFlight: window.__b1.reader.getView().read.inFlight, disabled: !!document.querySelector('[data-action="fve-refresh"][disabled]') }));
  eq(s1.issued, 1); eq(s1.inFlight, 1); eq(s1.disabled, true, 'disabled'); await page.evaluate(() => window.__b1.wiring.actionHandler('fve-refresh', null)); await page.waitForTimeout(60);
  eq(await page.evaluate(() => window.__b1.reader.getView().read.issued), 1, 'still one read');
  await page.evaluate(() => window.__b1.net.releaseAll()); await page.waitForTimeout(200); eq(await page.evaluate(() => !!document.querySelector('[data-action="fve-refresh"][disabled]')), false, 're-enabled'); await ctx.close();
});
await t('E12 HOSTILE TEXT typed into the editor is shown as text only: no element is created, no handler runs', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); const evil = '<img src=x onerror=window.__pwn=1><script>window.__pwn=2</script>';
  await page.keyboard.insertText(evil); await page.waitForTimeout(100); await page.evaluate(() => window.__b1.core.render()); await page.waitForTimeout(200);
  const r = await page.evaluate(() => ({ img: !!document.querySelector('#fve-editor img'), script: !!document.querySelector('#fve-editor script'), pwn: window.__pwn === undefined, value: document.querySelector('[data-fvp-field="methodNote"]').value }));
  eq(r.img, false); eq(r.script, false); eq(r.pwn, true); eq(r.value, evil); await ctx.close();
});
await t('E13 USER SWITCH during an IME composition: the old text does not reach the new session (keeper stays quiet), the new user starts empty', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('OLD', { delay: 15 }); await storm(page, 120);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(150);
  await page.evaluate(() => { const b = window.__b1; b.box.s = { uid: 'u2', email: 'fm2@example.com', role: 'fund_manager', roleResolved: true }; window.__authCb({ uid: 'u2', email: 'fm2@example.com' }); });
  await page.waitForTimeout(800); await stopStorm(page); const r = await page.evaluate(() => ({ leak: [...document.querySelectorAll('input,textarea')].some((e) => e.value.includes('OLD')), editors: window.__b1.wiring.actions.stats().editors, tracked: window.__b1.wiring.keeper.tracked() }));
  eq(r.leak, false, 'leak'); eq(r.editors, 0); eq(r.tracked, null); await ctx.close();
});

// ---- B2-2c round 5: an OPEN <select> popup must survive renders (found on the user's Edge and Chrome: a mouse-opened list closed under the 200 ms storm) ----
// A native popup lives on its <select> node: a render that replaces the node closes it. The popup state is not readable, so the keeper holds renders from the mouse-down (or Alt+Down / F4 / Space)
// on a select until: a value is chosen (change), focus leaves the select / the window / the page, Escape / Tab / Enter, a second press on it (toggle), or 30 s. Session / permission changes are never held.
const openSelectByMouse = async (page, sel) => { const b = await rectOf(page, sel); await page.mouse.move(b.x, b.y); await page.mouse.down(); };
await t('E18 OPEN SELECT (mouse down on «method») under a storm of core.render() every 120 ms: the select node is NOT replaced and no render runs while it is open; choosing a value ends the hold, the held render runs, and the choice and focus survive', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); const sel = F('method');
  await openSelectByMouse(page, sel);
  await page.evaluate((q) => { document.querySelector(q).__mark = 'same'; window.__r0 = window.__b1.renderCount(); }, sel); await storm(page, 120); await page.waitForTimeout(900);
  const mid = await page.evaluate((q) => { const el = document.querySelector(q); return { same: !!el && el.__mark === 'same', renders: window.__b1.renderCount() - window.__r0, hold: window.__b1.wiring.holdsRender(), focused: document.activeElement === el }; }, sel);
  eq(mid.same, true, 'the select node survived (its popup would still be open)'); eq(mid.renders, 0, 'no render ran while the list was open'); eq(mid.hold, true, 'the gate holds'); eq(mid.focused, true, 'focus on the select');
  await page.mouse.up(); await page.selectOption(sel, 'appraisal'); await page.waitForTimeout(700); await stopStorm(page);
  const end = await page.evaluate((q) => ({ renders: window.__b1.renderCount() - window.__r0, hold: window.__b1.wiring.holdsRender(), value: document.querySelector(q).value, active: document.activeElement && document.activeElement.getAttribute('data-fvp-field') }), sel);
  ok(end.renders > 0, 'the held renders ran after the choice'); eq(end.hold, false, 'released by the choice'); eq(end.value, 'appraisal', 'the chosen value is in the field'); eq(end.active, 'method', 'focus stays on the select'); eq((await model(page)).form.method, 'appraisal', 'and in the model'); await ctx.close();
});
await t('E18b READ DENIED while the list is open: the editor is gone at once (well under the 250 ms retry) and nothing comes back', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); await page.keyboard.type('SECRET-S', { delay: 10 }); await openSelectByMouse(page, F('method'));
  eq(await page.evaluate(() => window.__b1.wiring.holdsRender()), true, 'held');
  await page.evaluate(() => { window.__b1.fake.fail('heads', 'F1', Object.assign(new Error('no'), { code: 'permission-denied' })); }); await page.waitForTimeout(60);
  const res = await page.evaluate(() => { const b = window.__b1; return { status: b.reader.getView().status, root: !!document.querySelector('[data-fve="root"]'), editors: b.wiring.actions.stats().editors, hold: b.wiring.holdsRender(), html: document.documentElement.innerHTML.includes('SECRET-S') }; });
  eq(res.status, 'denied'); eq(res.root, false, 'slot gone with no explicit render call'); eq(res.editors, 0); eq(res.hold, false); eq(res.html, false); await page.mouse.up(); await page.waitForTimeout(300);
  eq(await page.evaluate(() => document.documentElement.innerHTML.includes('SECRET-S')), false, 'text does not come back'); await ctx.close();
});
await t('E18c ROLE UNRESOLVED and USER SWITCH while the list is open: cleared at the next render / at once; the old text is nowhere; the new user starts empty', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); await click(page, F('methodNote')); await page.keyboard.type('OLD-S', { delay: 10 }); await openSelectByMouse(page, F('method'));
  const a = await page.evaluate(() => { const b = window.__b1; b.box.s = { ...b.box.s, roleResolved: false }; b.core.render(); return { root: !!document.querySelector('[data-fve="root"]'), editors: b.wiring.actions.stats().editors, hold: b.wiring.holdsRender(), html: document.documentElement.innerHTML.includes('OLD-S') }; });
  eq(a.root, false); eq(a.editors, 0); eq(a.hold, false); eq(a.html, false); await page.mouse.up();
  const { ctx: c2, page: p2 } = await fresh(); await startEditor(p2); await click(p2, F('methodNote')); await p2.keyboard.type('OLD-U', { delay: 10 }); await openSelectByMouse(p2, F('method'));
  await p2.evaluate(() => { const b = window.__b1; b.box.s = { uid: 'u2', email: 'fm2@example.com', role: 'fund_manager', roleResolved: true }; window.__authCb({ uid: 'u2', email: 'fm2@example.com' }); }); await p2.waitForTimeout(500);
  const r = await p2.evaluate(() => ({ leak: document.documentElement.innerHTML.includes('OLD-U'), editors: window.__b1.wiring.actions.stats().editors, tracked: window.__b1.wiring.keeper.tracked(), hold: window.__b1.wiring.holdsRender() }));
  eq(r.leak, false); eq(r.editors, 0); eq(r.tracked, null); eq(r.hold, false); await p2.mouse.up(); await ctx.close(); await c2.close();
});
await t('E18d the hold ends by itself: focus moved / Escape / Tab / Enter / a second press on the select (toggle) / 30 s / the node removed; and it never comes back with the focus', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); const sel = F('method'); const hold = () => page.evaluate(() => window.__b1.wiring.holdsRender());
  await openSelectByMouse(page, sel); await page.mouse.up(); eq(await hold(), true, 'open');
  await page.evaluate(() => document.querySelector('[data-fvp-field="methodNote"]').focus()); eq(await hold(), false, 'focus moved away'); await page.evaluate((q) => document.querySelector(q).focus(), sel); eq(await hold(), false, 'focus back WITHOUT a new press: not held');
  for (const key of ['Escape', 'Tab', 'Enter']) { await openSelectByMouse(page, sel); await page.mouse.up(); eq(await hold(), true, key + ': open'); await page.keyboard.press(key); eq(await hold(), false, key + ' ends it'); await page.evaluate((q) => document.querySelector(q).focus(), sel); }
  await openSelectByMouse(page, sel); await page.mouse.up(); eq(await hold(), true); const b = await rectOf(page, sel); await page.mouse.move(b.x, b.y); await page.mouse.down(); await page.mouse.up(); eq(await hold(), false, 'a second press on the select closes its popup: toggle');
  await openSelectByMouse(page, sel); await page.mouse.up(); eq(await hold(), true);
  eq(await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 31000; const during = window.__b1.wiring.holdsRender(); Date.now = real; return JSON.stringify([during, window.__b1.wiring.holdsRender()]); }), '[false,false]', '30 s: let go, and not held again after the clock is back');
  await openSelectByMouse(page, sel); await page.mouse.up(); eq(await hold(), true);
  eq(await page.evaluate(() => { const b = window.__b1; b.core.setCoreState({ fundsViewOpen: false, render: true }); return b.wiring.holdsRender(); }), false, 'leaving the view: not held'); await ctx.close();
});
await t('E18f the hold is dropped at once by a window blur and by the keeper clear() (session end), even while the select node is still alive and focused', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); const sel = F('method'); const hold = () => page.evaluate(() => window.__b1.wiring.holdsRender());
  await openSelectByMouse(page, sel); await page.mouse.up(); eq(await hold(), true, 'open');
  eq(await page.evaluate(() => { window.dispatchEvent(new Event('blur')); return [document.activeElement && document.activeElement.tagName, window.__b1.wiring.keeper.isPopupOpen()]; }).then(JSON.stringify), '["SELECT",false]', 'window blur drops it although the node is still focused');
  await openSelectByMouse(page, sel); await page.mouse.up(); eq(await hold(), true, 'open again');
  eq(await page.evaluate(() => { window.__b1.wiring.keeper.clear(); return [document.activeElement && document.activeElement.tagName, window.__b1.wiring.keeper.isPopupOpen()]; }).then(JSON.stringify), '["SELECT",false]', 'clear() drops it although the node is still focused'); await ctx.close();
});
await t('E18e KEYBOARD: ArrowUp / ArrowDown change the value of a closed select with NO hold (S4 keeps working); Alt+Down, F4 and Space (which open the popup) hold; Escape lets go', async () => {
  const { ctx, page } = await fresh(); await startEditor(page); const sel = F('method'); const hold = () => page.evaluate(() => window.__b1.wiring.holdsRender());
  await page.evaluate((q) => { const el = document.querySelector(q); el.scrollIntoView({ block: 'center' }); el.focus(); }, sel); await page.waitForTimeout(80);
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(80); eq(await hold(), false, 'ArrowDown: no hold'); ok(!!(await model(page)).form.method, 'value changed');
  await page.keyboard.press('Alt+ArrowDown'); eq(await hold(), true, 'Alt+Down holds'); await page.keyboard.press('Escape'); eq(await hold(), false);
  await page.keyboard.press('F4'); eq(await hold(), true, 'F4 holds'); await page.keyboard.press('Escape'); eq(await hold(), false);
  await page.keyboard.press('Space'); eq(await hold(), true, 'Space holds'); await page.keyboard.press('Escape'); eq(await hold(), false); await ctx.close();
});

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed.`); process.exit(fail ? 1 : 0);
