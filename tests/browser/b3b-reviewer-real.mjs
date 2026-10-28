// R1-B2 / B2-3b — the REVIEWER section (view + wiring + keeper + gate) on the REAL core.js, in headless Chromium (cloud container; NOT the user's machine).
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
  const clock = { now: new Date('2026-10-11T10:00:00Z') }; const srv = S.makeServer({ clock }); const box = { s: { uid: 'u3', email: 'ic@example.com', role: 'senior_ic', roleResolved: true } }; await srv.seedDraft({ valuationId: 'V1', state: 'submitted' });
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
  window.__authCb({ uid: 'u3', email: 'ic@example.com' });
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
const RV = (a) => act('fve-rv-open', `[data-act="${a}"]`);
const RF = '[data-fvp-field="rv.reason"]';
const rv = (page) => page.evaluate(() => { const u = window.__b1.wiring.ui(); return { rv: u.rv ? { act: u.rv.act, reason: u.rv.reason } : null, prepared: !!u.prepared }; });
async function openReturn(page) { await page.waitForSelector(RV('returnDraft'), { timeout: 3000 }); await click(page, RV('returnDraft')); await page.waitForSelector(RF, { timeout: 3000 }); }


await t('V0 the page boots on the real core.js with a senior_ic: the reviewer section is rendered by the real section hook; no page errors', async () => {
  const { ctx, page, errors } = await fresh(); ok(await page.$('[data-fve="reviewer"]'), 'reviewer section'); ok(await page.$(RV('review')), 'review button'); eq(errors.length, 0, 'errors: ' + errors.join(' ; ')); await ctx.close();
});
await t('V1 TYPING a 200-character reason one key at a time while core.render() runs every 40 ms: nothing lost, focus kept, state equals the field', async () => {
  const { ctx, page } = await fresh(); await openReturn(page); await click(page, RF); await storm(page, 40);
  // The typing and the renders are COORDINATED, which lowers the test's dependence on execution speed: every 8 keys, while text is still left to type, the test waits (up to 2 s, no retry)
  // until the storm has really executed one more render. `typed` is fixed at the LAST such checkpoint, before the text is complete; renders after it are never counted.
  // A render blocked during typing, or timers frozen for longer than the wait, still fail the test.
  const text = 'سبب الإرجاع '.repeat(17).slice(0, 200); const r0 = await page.evaluate(() => window.__b1.renderCount()); let last = r0; let k = 0; let typed = 0;
  for (const ch of text) {
    await page.keyboard.insertText(ch); k += 1;
    if (k % 8 === 0 && k < text.length) {
      await page.waitForFunction((n) => window.__b1.renderCount() > n, last, { timeout: 2000 }).catch(() => { throw new Error(`no render ran while typing (key ${k}/${text.length}, renders since typing started: ${last - r0})`); });
      last = await page.evaluate(() => window.__b1.renderCount()); typed = last - r0;
    }
  }
  await stopStorm(page); await page.waitForTimeout(150);
  const v = await page.evaluate(() => { const e = document.querySelector('[data-fvp-field="rv.reason"]'); return { value: e.value, start: e.selectionStart }; });
  eq(v.value, text); eq(v.start, text.length, 'caret'); eq((await rv(page)).rv.reason, text, 'state'); eq((await dom(page)).active, 'rv.reason', 'focus'); ok(typed > 20, `renders ran while typing: ${typed} at the last checkpoint (need > 20; nothing after the typing is counted)`); await ctx.close();
});
await t('V2 IME COMPOSITION in the reason field under renders every 200 ms: no render during it, the commit leaves the text intact in field and state', async () => {
  const { ctx, page } = await fresh(); await openReturn(page); await click(page, RF); const cdp = await ctx.newCDPSession(page); await storm(page, 200);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(100); const r0 = (await dom(page)).renders; eq((await dom(page)).comp, true, 'holds');
  await page.waitForTimeout(900); eq((await dom(page)).renders, r0, 'no render during the composition');
  await cdp.send('Input.imeSetComposition', { text: 'كت', selectionStart: 2, selectionEnd: 2 }); await page.waitForTimeout(150); await cdp.send('Input.insertText', { text: 'كتب' }); await page.waitForTimeout(500); await stopStorm(page);
  eq(await page.$eval(RF, (e) => e.value), 'كتب', 'field'); eq((await rv(page)).rv.reason, 'كتب', 'state'); eq((await dom(page)).comp, false); await ctx.close();
});
await t('V3 SIGN-OUT during an open composition in the reason field: form, reason and prepared card are gone at once; nothing comes back', async () => {
  const { ctx, page } = await fresh(); await openReturn(page); await click(page, RF); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('SECRET-V', { delay: 12 }); await storm(page, 150);
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(150); eq((await dom(page)).comp, true);
  const res = await page.evaluate(() => { const b = window.__b1; b.box.s = null; window.__authCb(null); const u = b.wiring.ui(); return { section: !!document.querySelector('[data-fve="reviewer"]'), field: !!document.querySelector('[data-fvp-field="rv.reason"]'), rv: u.rv, html: document.documentElement.innerHTML.includes('SECRET-V') }; });
  eq(res.section, false, 'section gone synchronously'); eq(res.field, false); eq(res.rv, null); eq(res.html, false, 'text not in the page');
  await cdp.send('Input.insertText', { text: 'LATEZQ' }); await page.waitForTimeout(700); await stopStorm(page);
  const after = await page.evaluate(() => ({ html: document.documentElement.innerHTML.includes('SECRET-V') || document.documentElement.innerHTML.includes('LATEZQ'), rv: window.__b1.wiring.ui().rv })); eq(after.html, false, 'late composition text does not come back'); eq(after.rv, null); await ctx.close();
});
await t('V4 PERMISSION LOSS during a composition (role becomes viewer): the next render() shows no reviewer section at once', async () => {
  const { ctx, page } = await fresh(); await openReturn(page); await click(page, RF); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('SECRET-W', { delay: 12 });
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(120); eq((await dom(page)).comp, true);
  const res = await page.evaluate(() => { const b = window.__b1; b.box.s = { ...b.box.s, role: 'viewer' }; b.core.render(); return { section: !!document.querySelector('[data-fve="reviewer"]'), hold: b.wiring.holdsRender(), rv: b.wiring.ui().rv, html: document.documentElement.innerHTML.includes('SECRET-W') }; });
  eq(res.section, false); eq(res.hold, false); eq(res.rv, null); eq(res.html, false); await ctx.close();
});
await t('V5 REAL CLICKS: return with a reason → prepare → the card shows the reason and the unbound notice → confirm; the server got exactly the card\'s reason; the form is gone', async () => {
  const { ctx, page } = await fresh(); await openReturn(page); await click(page, RF); await page.keyboard.insertText('  أعد المصدر  ');
  await click(page, act('fve-rv-prepare')); await page.waitForSelector('[data-fve="rv-reason"]', { timeout: 3000 });
  eq(await page.$eval('[data-fve="rv-reason"]', (e) => e.textContent), 'أعد المصدر'); ok(await page.$('[data-fve="rv-unbound"]'), 'unbound notice'); eq(await page.$(RF), null, 'the field is not on the card');
  await click(page, act('fve-confirm-act')); await page.waitForTimeout(300);
  const sent = await page.evaluate(() => window.__b1.srv.calls.filter((c) => /return/i.test(c.callable)).map((c) => c.payload)); eq(sent.length, 1); eq(sent[0].reason, 'أعد المصدر');
  eq((await rv(page)).rv, null, 'form gone'); await ctx.close();
});
await t('V6 REAL CLICKS: review → the card shows the fingerprint → confirm sends it; then, until the view shows the effect, the buttons are disabled', async () => {
  const { ctx, page } = await fresh(); await page.waitForSelector(RV('review')); await click(page, RV('review')); await click(page, act('fve-rv-prepare')); await page.waitForSelector('[data-fve="rv-hash"]');
  const shown = await page.$eval('[data-fve="rv-hash"] code', (e) => e.textContent); const stored = await page.evaluate(() => window.__b1.srv.vals.get('V1').contentHash); eq(shown, stored);
  await page.evaluate(() => { window.__b1.net.auto = false; }); await click(page, act('fve-confirm-act')); await page.waitForTimeout(250);
  const sent = await page.evaluate(() => window.__b1.srv.calls.filter((c) => /review/i.test(c.callable) && !/preview/i.test(c.callable)).map((c) => c.payload)); eq(sent.length, 1); eq(sent[0].expectedContentHash, stored);
  const dis = await page.$$eval('[data-action="fve-rv-open"]', (els) => els.map((e) => e.disabled)); ok(dis.length === 4 && dis.every(Boolean), 'all four disabled while waiting for the view: ' + JSON.stringify(dis));
  await page.evaluate(() => { window.__b1.net.auto = true; window.__b1.net.releaseAll(); window.__b1.listen(); }); await page.waitForTimeout(300); await ctx.close();
});

const RICH_JS = `(() => ({ currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE', residualValue: 7777001,
  components: { assetsValue: 5550011, cashRetained: 4440022, otherAssets: 3330033, liabilities: 2220044, distributionsPayable: 1110055, otherAssetsItems: [{ description: 'ذمم-مميزة-ALPHA', amount: 1230001 }, { description: 'عقار-مميز-BETA', amount: 4560002 }] },
  method: 'appraisal', methodNote: 'ملاحظة-' + 'م'.repeat(900) + '-نهاية-الملاحظة-الكاملة', source: { ref: 'REF-ZZ91', provider: 'مزوّد-مميز' },
  nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: false },
  coverage: { linkedAssets: ['ASSET-Q1', 'ASSET-Q2'], unlinkedHoldings: { declared: 'included', items: [{ description: 'غير-مرتبط-GAMMA', amount: 9990003 }] } } }))()`;
async function richCard(page) {
  await page.evaluate(async (js) => { const b = window.__b1; const c = (0, eval)(js); await b.srv.externalEdit('V1', { ...b.srv.vals.get('V1'), ...c }); await b.reader.refresh(); b.listen(); }, RICH_JS); await page.waitForTimeout(300);
  await click(page, RV('review')); await click(page, act('fve-rv-prepare')); await page.waitForSelector('[data-fve="rv-content"]', { timeout: 3000 });
}
await t('V7 THE CARD on the real page: every section of the stored content is readable (items with descriptions and amounts, basis, coverage, non-overlap declarations), no "[object Object]", the long note opens and is whole', async () => {
  const { ctx, page } = await fresh(); await richCard(page);
  const txt = await page.$eval('[data-fve="prepared"]', (e) => e.innerText);
  ok(!/\[object Object\]/.test(await page.content()), '[object Object] on the page');
  for (const v of ['7777001', 'RESIDUAL_VALUE_AS_OF_DATE', '5550011', '4440022', '3330033', '2220044', '1110055', 'ذمم-مميزة-ALPHA', '1230001', 'عقار-مميز-BETA', '4560002', 'REF-ZZ91', 'مزوّد-مميز', 'ASSET-Q1', 'ASSET-Q2', 'غير-مرتبط-GAMMA', '9990003']) ok(txt.includes(v), 'card shows ' + v);
  eq(await page.$$eval('[data-fve="rv-item"]', (e) => e.length), 2, 'two items');
  ok(await page.$('[data-fve="rv-note-full"]'), 'the long note is in an openable section');
  eq(await page.$eval('[data-fve="rv-note-full"]', (e) => e.open), false, 'closed at first');
  await click(page, '[data-fve="rv-note-full"] summary'); const open = await page.$eval('[data-fve="rv-note-full"] div', (e) => ({ h: e.offsetHeight, t: e.textContent })); ok(open.h > 0 && await page.$eval('[data-fve="rv-note-full"]', (e) => e.open), 'opened: drawn'); ok(open.t.includes('نهاية-الملاحظة-الكاملة') && open.t.includes('م'.repeat(900)), 'whole note');
  await page.screenshot({ path: process.env.SHOT_DIR ? process.env.SHOT_DIR + '/card.png' : '/tmp/card.png', fullPage: false }); await ctx.close();
});
await t('V7b the card keeps showing the PREPARED content when the server data changes under it, and survives a re-render storm', async () => {
  const { ctx, page } = await fresh(); await richCard(page); await storm(page, 40);
  await page.evaluate(async () => { const b = window.__b1; await b.srv.externalEdit('V1', { ...b.srv.vals.get('V1'), residualValue: 5550999 }); await b.reader.refresh(); b.listen(); }); await page.waitForTimeout(400); await stopStorm(page);
  const txt = await page.$eval('[data-fve="prepared"]', (e) => e.innerText); ok(txt.includes('7777001') && !txt.includes('5550999'), 'prepared content, not the live one'); ok(txt.includes('ذمم-مميزة-ALPHA'));
  await click(page, act('fve-confirm-act')); await page.waitForTimeout(250);
  eq(await page.evaluate(() => window.__b1.srv.calls.filter((c) => /review/i.test(c.callable) && !/preview/i.test(c.callable)).length), 0, 'refused: nothing sent'); await ctx.close();
});
await t('V7c the general check panel: a mismatching reply shows the plain warning and both fingerprints on the real page, no empty result fields', async () => {
  const { ctx, page } = await fresh();
  await page.evaluate(async () => { const b = window.__b1; await b.srv.externalEdit('V1', { ...b.srv.vals.get('V1'), residualValue: 1234 }); });
  await click(page, act('fve-check-now')); await page.waitForSelector('[data-fve="preview-mismatch"]', { timeout: 3000 });
  const t2 = await page.$eval('[data-fve="preview"]', (e) => e.innerText); ok(t2.includes('نسخة أخرى'), 'warning'); ok(!t2.includes('اليوم عند الخادم'), 'no result fields');
  const hashes = await page.$$eval('[data-fve="preview"] code', (e) => e.map((x) => x.textContent)); ok(hashes.filter((h) => /^[0-9a-f]{64}$/.test(h)).length >= 2, 'both fingerprints: ' + JSON.stringify(hashes)); await ctx.close();
});
await t('V8 a LATE reply of the previous user does not erase the new user\'s half-typed return reason on the real page', async () => {
  const { ctx, page } = await fresh();
  await click(page, RV('review')); await click(page, act('fve-rv-prepare')); await page.evaluate(() => { window.__b1.srv.delay = 500; }); await click(page, act('fve-confirm-act'));
  await page.evaluate(() => { const b = window.__b1; b.box.s = { uid: 'u4', email: 'ic2@example.com', role: 'senior_ic', roleResolved: true }; window.__authCb({ uid: 'u4', email: 'ic2@example.com' }); b.core.STORE.funds = [{ id: 'F1', data: Object.assign(b.core.blankFund ? b.core.blankFund() : {}, { name: 'F One', assetIds: ['A1', 'A2'] }) }]; b.core.setCoreState({ fundsViewOpen: true, fundsSubTab: 'funds', openFundId: 'F1', render: true }); b.listen(); });
  await page.waitForTimeout(250); if (process.env.DBG) console.log(await page.evaluate(() => ({ s: window.__b1.wiring.actions.getState().session, view: window.__b1.reader.getView().status, rv: !!document.querySelector('[data-fve="reviewer"]'), html: (document.querySelector('[data-fve="root"]')||{innerText:'none'}).innerText.slice(0, 400) })));
  await page.waitForSelector(RV('returnDraft'), { timeout: 3000 }); await click(page, RV('returnDraft')); await page.waitForSelector(RF); await click(page, RF); await page.keyboard.insertText('سبب المستخدم الثاني');
  await page.waitForTimeout(800);   // the old reply has come back by now
  eq(await page.$eval(RF, (e) => e.value), 'سبب المستخدم الثاني', 'field'); eq((await rv(page)).rv.reason, 'سبب المستخدم الثاني', 'state'); eq((await rv(page)).rv.act, 'returnDraft'); await ctx.close();
});

await t('V9 a multi-line reason keeps ITS OWN scroll while core.render() runs every 40 ms: the line being typed stays in view (the textarea is not sent back to its first rows)', async () => {
  const { ctx, page } = await fresh(); await openReturn(page); await click(page, RF); await storm(page, 40);
  for (let i = 1; i <= 7; i += 1) { for (const ch of 'السطر ' + i + ' نص') await page.keyboard.insertText(ch); if (i < 7) await page.keyboard.press('Enter'); await page.waitForTimeout(120); }
  await page.waitForTimeout(250);
  const m = await page.evaluate(() => { const e = document.querySelector('[data-fvp-field="rv.reason"]'); return { st: e.scrollTop, sh: e.scrollHeight, ch: e.clientHeight, caretAtEnd: e.selectionStart === e.value.length }; });
  await stopStorm(page);
  ok(m.sh > m.ch, 'the text is taller than the box (test is meaningful): ' + JSON.stringify(m)); ok(m.caretAtEnd, 'caret at the end');
  ok(m.st + m.ch >= m.sh - 4, 'the last line is in view (scrollTop ' + m.st + ', client ' + m.ch + ', scroll ' + m.sh + ')'); await ctx.close();
});

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed.`); process.exit(fail ? 1 : 0);
