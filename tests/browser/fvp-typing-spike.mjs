// R1-B2 / B2-2b-b0 — SPIKE: typing while core.render() rebuilds #app.innerHTML, in a REAL Chromium (headless, CLOUD container — not Opal's machine).
// The page reproduces core.js's render shape exactly (render() = renderInner() then render-end hooks; renderInner assigns #app.innerHTML) and registers the
// real focus keeper through a render-end hook. Nothing here touches core.js. Run: node tests/browser/fvp-typing-spike.mjs   (exit 0 only if every restore test passes;
// the IME tests are reported separately: RESULT lines, with and without the PROTOTYPE gate that lives only in this harness).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_MODULE || '/home/claude/.npm-global/lib/node_modules/playwright';
const { chromium } = require(PW);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PAGE = `<!doctype html><meta charset="utf-8"><title>spike</title>
<style>body{margin:0;font:14px sans-serif} #app{padding:8px} .scroller{height:120px;overflow:auto;border:1px solid #888} .pad{height:900px} input,textarea,select{display:block;margin:6px 0;width:260px}</style>
<div id="app"></div>
<script type="module">
import { createFocusKeeper } from '/src/features/fund-valuation-focus-keeper.js';
const S = { a: '', b: '', c: 'x', d: false, showGone: true, gone: '', far: '' };
const hooks = []; const registerRenderEnd = (fn) => hooks.push(fn);
let gateOn = false; let deferred = false; let sessionLive = true; let editorWanted = true; let deferredAt = 0; const MAX_MS = 4000; const log = [];
const app = document.getElementById('app');
let ignoreState = false; let shrink = false;
function renderInner() {
  if (shrink) { app.innerHTML = ''; void app.offsetHeight; }      // a framework that empties the container first: the page height collapses and the browser clamps the scroll
  if (!sessionLive) { app.innerHTML = '<div id="login">sign in</div>'; return; }      // core.js: a lost session / denied access renders the login or denied view, which has no editor at all
  app.innerHTML = '<section data-fvp-section="editor" tabindex="-1" id="sec"><h3>editor</h3>'
    + '<input data-fvp-field="a" value="' + S.a + '">'
    + '<textarea data-fvp-field="b">' + S.b + '</textarea>'
    + '<select data-fvp-field="c"><option value="x"' + (S.c === 'x' ? ' selected' : '') + '>x</option><option value="y"' + (S.c === 'y' ? ' selected' : '') + '>y</option><option value="z"' + (S.c === 'z' ? ' selected' : '') + '>z</option></select>'
    + '<label><input type="checkbox" data-fvp-field="d"' + (S.d && !ignoreState ? ' checked' : '') + '> d</label>'
    + (S.showGone ? '<input data-fvp-field="gone" value="' + S.gone + '">' : '')
    + '<div class="scroller" data-fvp-scroll="sc"><div class="pad"></div><input data-fvp-field="far" value="' + S.far + '"></div>'
    + '</section><div style="height:1500px"></div>';
}
const keeper = createFocusKeeper({ getRoot: () => app, onLost: ({ key }) => { log.push('lost:' + key); } });
keeper.attach();
registerRenderEnd(() => keeper.afterRender());
let keeperOn = true; let captureOn = true;
function doRender() { try { renderInner(); } finally { if (keeperOn) for (const h of hooks) h(); } }
// the PROTOTYPE gate (harness only): defers an ordinary render while a composition is open; a forced render (teardown / permission loss / leaving the view) is never deferred
// prototype gate for the IME comparison only (T9a/T9b); the proposed gate itself is tested on the real core.js in core-gate-real.mjs
function render(force) {
  if (keeperOn && captureOn && keeper.captureLive) keeper.captureLive();      // core.js asks the render gate at the start of EVERY render; the page's gate hook is what reads the live caret and scroll
  if (gateOn && !force && sessionLive && editorWanted && (keeper.holds ? keeper.holds() : keeper.isComposing())) { deferred = true; return; }
  deferred = false; doRender();
}
for (const evn of ['compositionend', 'keyup']) document.addEventListener(evn, () => { if (gateOn && deferred) setTimeout(() => render(), 0); }, true);
// Chromium commits an open composition when its node is removed and fires input on the DETACHED node: a handler must ignore a detached target and a dead session (b1 requirement)
document.addEventListener('input', (e) => { if (!sessionLive || !e.target.isConnected) return; const k = e.target.getAttribute && e.target.getAttribute('data-fvp-field'); if (!k) return; S[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; render(); }, true);
document.addEventListener('change', (e) => { const k = e.target.getAttribute && e.target.getAttribute('data-fvp-field'); if (k === 'c' || k === 'd') { S[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; render(); } }, true);
let timer = null;
window.__spike = {
  S, keeper, log, render, startTimer(ms) { clearInterval(timer); timer = setInterval(() => render(), ms); }, stopTimer() { clearInterval(timer); },
  setKeeper(v) { keeperOn = v; }, setCapture(v) { captureOn = v; }, setIgnoreState(v) { ignoreState = v; }, setShrink(v) { shrink = v; }, setSession(v) { sessionLive = v; }, setEditorWanted(v) { editorWanted = v; }, setMax(v) { /* ceiling is fixed at 4000 ms like the proposal */ }, setGate(v) { gateOn = v; }, deferred: () => deferred, forceTeardown() { keeper.clear(); S.a = S.b = S.far = S.gone = ''; render(true); },
  renders: () => keeper.stats().renders,
};
render(true);
</script>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) { res.setHeader('content-type', 'text/html'); return res.end(PAGE); }
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('no'); }
  res.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/plain'); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
console.log('— B2-2b/b0 typing-during-render spike — ' + browser.version() + ' (headless, cloud container; NOT a test on the user\'s machine)');

let pass = 0; let fail = 0; const results = [];
// --- T5/T6 flake probe (investigation only; defaults leave the spike exactly as it was) ---
//   ONLY=T5,T6        run only tests whose name starts with one of these prefixes
//   DIAG=1            on a failure print what the page looked like (document focus, active element, scroll, state, load)
//   T56_VARIANT       focus (default: page.focus, as the spike always did) | click (a real mouse click) | front (bringToFront + wait for document.hasFocus())
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean); const DIAG = !!process.env.DIAG; const VARIANT = process.env.T56_VARIANT || 'focus'; let lastPage = null;
async function diag(page) {
  try { return JSON.stringify(await page.evaluate(() => ({ hasFocus: document.hasFocus(), visibility: document.visibilityState, active: document.activeElement && (document.activeElement.getAttribute('data-fvp-field') || document.activeElement.tagName), S: window.__spike.S, y: Math.round(window.scrollY), sc: (document.querySelector('[data-fvp-scroll="sc"]') || {}).scrollTop, renders: window.__spike.renders(), t: Math.round(performance.now()) }))) + ' load=' + os.loadavg().map((x) => x.toFixed(2)).join('/'); } catch (e) { return 'diag failed: ' + e.message; }
}
async function fresh({ keeper = true, gate = false, tick = 25 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  lastPage = page; await page.goto(url); await page.waitForFunction(() => window.__spike);
  await page.evaluate(([k, g, t]) => { window.__spike.setKeeper(k); window.__spike.setGate(g); window.__spike.startTimer(t); }, [keeper, gate, tick]);
  return { ctx, page, errors };
}
const active = (page) => page.evaluate(() => { const a = document.activeElement; return a && a.getAttribute ? (a.getAttribute('data-fvp-field') || a.id || a.tagName) : null; });
async function t(name, fn, { report = false } = {}) {
  if (ONLY.length && !ONLY.some((o) => name.startsWith(o + ' '))) return;
  try { const out = await fn(); if (report) { results.push(`RESULT ${name}: ${out}`); console.log(`  • ${name}: ${out}`); } else { pass += 1; console.log(`  ✓ ${name}`); } }
  catch (e) { if (report) { results.push(`RESULT ${name}: ERROR ${e.message}`); console.log(`  • ${name}: ERROR ${e.message}`); } else { fail += 1; console.error(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 3).join(' | ')}`); if (DIAG && lastPage) console.error('      DIAG ' + await diag(lastPage)); } }
}
// Playwright's own click waits for a STABLE element; the page rebuilds its DOM every 25 ms by design, so the click is a real mouse click at the field's current box.
const clickField = async (page, key) => { const box = await page.evaluate((k) => { const r = document.querySelector('[data-fvp-field="' + k + '"]').getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; }, key); await page.mouse.click(box.x, box.y); };
const focusField = async (page, key) => {
  if (VARIANT === 'click') return clickField(page, key);
  if (VARIANT === 'front') { await page.bringToFront(); await page.waitForFunction(() => document.hasFocus(), null, { timeout: 3000 }).catch(() => {}); }
  return page.focus('[data-fvp-field="' + key + '"]');
};
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`); };

if (process.env.SPIKE_DEBUG) {
  const { ctx, page } = await fresh(); await page.evaluate(() => { for (const n of ['focusin', 'focusout', 'input', 'blur']) document.addEventListener(n, (e) => window.__spike.log.push(n + ':' + (e.target.getAttribute && e.target.getAttribute('data-fvp-field')) + ':conn=' + (e.target.isConnected)), true); });
  await clickField(page, 'a'); await page.keyboard.type('ab', { delay: 60 }); await page.waitForTimeout(100);
  console.log(JSON.stringify(await page.evaluate(() => ({ log: window.__spike.log, stats: window.__spike.keeper.stats(), tracked: window.__spike.keeper.tracked(), active: document.activeElement.tagName, v: window.__spike.S.a }))));
  await ctx.close();
}
await t('T0 control: WITHOUT the keeper, typing under frequent renders loses focus (the problem is real)', async () => {
  const { ctx, page } = await fresh({ keeper: false }); await clickField(page, 'a');
  await page.keyboard.type('abcdefghijklmnopqrstuvwxyz', { delay: 20 });
  const v = await page.evaluate(() => window.__spike.S.a); const a = await active(page);
  await ctx.close(); if (v.length === 26 && a === 'a') throw new Error('control did not reproduce the loss (spike would prove nothing)');
}, {});
await t('T1 keeper: 60 characters typed with a render on every keystroke AND every 25 ms: nothing lost, focus kept', async () => {
  const { ctx, page, errors } = await fresh(); const text = 'The quick brown fox jumps over the lazy dog 0123456789 abcdefgh'.slice(0, 60);
  await clickField(page, 'a'); await page.keyboard.type(text, { delay: 15 });
  eq(await page.inputValue('[data-fvp-field="a"]'), text, 'dom value'); eq(await page.evaluate(() => window.__spike.S.a), text, 'state'); eq(await active(page), 'a', 'focus');
  const n = await page.evaluate(() => window.__spike.renders()); if (n < 60) throw new Error('too few renders to mean anything: ' + n); eq(errors.length, 0, 'page errors'); await ctx.close();
});
await t('T2 caret in the middle survives: AAAA, Home, Right×2, type XY -> AAXYAA', async () => {
  const { ctx, page } = await fresh(); await clickField(page, 'a'); await page.keyboard.type('AAAA', { delay: 30 });
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.type('XY', { delay: 40 });
  eq(await page.inputValue('[data-fvp-field="a"]'), 'AAXYAA'); await ctx.close();
});
await t('T3 selection range survives a render (shift+arrows, then wait through several renders)', async () => {
  const { ctx, page } = await fresh(); await clickField(page, 'a'); await page.keyboard.type('0123456789', { delay: 10 });
  await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight'); await page.keyboard.down('Shift'); for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  const sel = await page.evaluate(() => { const e = document.activeElement; return [e.selectionStart, e.selectionEnd]; }); eq(JSON.stringify(sel), '[1,5]'); await ctx.close();
});
await t('T4 textarea: multi-line typing with Enter under renders', async () => {
  const { ctx, page } = await fresh(); await clickField(page, 'b');
  for (const l of ['first line', 'second line', 'third']) { await page.keyboard.type(l, { delay: 12 }); if (l !== 'third') await page.keyboard.press('Enter'); }
  eq(await page.inputValue('[data-fvp-field="b"]'), 'first line\nsecond line\nthird'); eq(await active(page), 'b'); await ctx.close();
});
await t('T4b the keeper ALONE (no capture at render start, as before the gate hook existed): multi-line typing with Enter under renders still survives — the keeper does not depend on the gate hook for this', async () => {
  const { ctx, page } = await fresh(); await page.evaluate(() => window.__spike.setCapture(false)); await clickField(page, 'b');
  for (const l of ['first line', 'second line', 'third']) { await page.keyboard.type(l, { delay: 12 }); if (l !== 'third') await page.keyboard.press('Enter'); }
  eq(await page.inputValue('[data-fvp-field="b"]'), 'first line\nsecond line\nthird'); eq(await active(page), 'b'); await ctx.close();
});
await t('T5 select and checkbox: keyboard change keeps focus and the new value through renders (with the render gate, as in core.js)', async () => {
  const { ctx, page } = await fresh({ gate: true }); await focusField(page, 'c'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(120);
  eq(await page.inputValue('[data-fvp-field="c"]'), 'y'); eq(await active(page), 'c');
  await focusField(page, 'd'); await page.keyboard.press('Space'); await page.waitForTimeout(120);
  eq(await page.evaluate(() => window.__spike.S.d), true, 'state'); eq(await page.isChecked('[data-fvp-field="d"]'), true, 'dom'); eq(await active(page), 'd', 'focus'); await ctx.close();
});
await t('T6 scroll: window and inner scroller positions survive renders; typing in a field deep in the scroller does not jump', async () => {
  const { ctx, page } = await fresh(); await page.evaluate(() => { window.scrollTo(0, 220); document.querySelector('[data-fvp-scroll="sc"]').scrollTop = 150; });
  await page.waitForTimeout(100); await focusField(page, 'far'); await page.evaluate(() => document.querySelector('[data-fvp-field="far"]').scrollIntoView({ block: 'center' }));   // fully visible: the browser's own caret-into-view scroll must not enter the measurement
  await page.waitForTimeout(100);
  const before = await page.evaluate(() => [Math.round(window.scrollY), document.querySelector('[data-fvp-scroll="sc"]').scrollTop]);
  await page.keyboard.type('deep field text', { delay: 20 }); await page.waitForTimeout(120);
  const after = await page.evaluate(() => [Math.round(window.scrollY), document.querySelector('[data-fvp-scroll="sc"]').scrollTop]);
  eq(JSON.stringify(after), JSON.stringify(before), 'scroll'); eq(await page.inputValue('[data-fvp-field="far"]'), 'deep field text'); await ctx.close();
});
await t('T7 the focused field disappears: no exception, the loss is reported once, focus falls back to the section (not to <body>)', async () => {
  const { ctx, page, errors } = await fresh(); await clickField(page, 'gone'); await page.keyboard.type('abc', { delay: 10 });
  await page.evaluate(() => { window.__spike.S.showGone = false; window.__spike.render(true); }); await page.waitForTimeout(80);
  eq(await active(page), 'sec', 'fallback focus'); eq(await page.evaluate(() => window.__spike.log.filter((x) => x === 'lost:gone').length), 1, 'reported once'); eq(errors.length, 0, 'page errors'); await ctx.close();
});
await t('T8 clear() (session teardown / permission loss): nothing typed is restored afterwards, focus is not re-seated, state is empty at once', async () => {
  const { ctx, page } = await fresh(); await clickField(page, 'a'); await page.keyboard.type('secret', { delay: 10 });
  await page.evaluate(() => window.__spike.forceTeardown()); await page.waitForTimeout(100);
  eq(await page.inputValue('[data-fvp-field="a"]'), '', 'dom value gone'); eq(await page.evaluate(() => window.__spike.keeper.tracked()), null, 'nothing tracked');
  eq(await active(page) === 'a', false, 'focus not re-seated on the cleared field'); await ctx.close();
});

// ---- IME: composition is reported, not asserted. A replaced node ends a composition; whether the gate is needed is what this measures.
async function ime(gate) {
  const { ctx, page } = await fresh({ gate }); await clickField(page, 'a'); const cdp = await ctx.newCDPSession(page);
  await page.keyboard.type('ab', { delay: 20 });
  await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(120);
  const mid = await page.evaluate(() => ({ v: document.activeElement.value, comp: window.__spike.keeper.stats().composing, deferred: window.__spike.deferred(), renders: window.__spike.renders() }));
  await cdp.send('Input.imeSetComposition', { text: 'كت', selectionStart: 2, selectionEnd: 2 }); await page.waitForTimeout(120);
  await cdp.send('Input.insertText', { text: 'كتب' }); await page.waitForTimeout(150);
  const end = await page.evaluate(() => ({ v: document.querySelector('[data-fvp-field="a"]').value, s: window.__spike.S.a, f: document.activeElement.getAttribute('data-fvp-field'), comp: window.__spike.keeper.stats().composing }));
  await ctx.close(); return JSON.stringify({ gate, duringComposition: mid, afterCommit: end });
}
await t('T9a IME composition WITHOUT a gate (restore only)', () => ime(false), { report: true });
await t('T9b IME composition WITH the PROTOTYPE gate (harness only; core.js untouched)', () => ime(true), { report: true });

async function composing() { const { ctx, page } = await fresh({ gate: true, tick: 200 }); await clickField(page, 'a'); const cdp = await ctx.newCDPSession(page); await page.keyboard.type('ab', { delay: 20 }); await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await page.waitForTimeout(30); return { ctx, page, cdp }; }
// T10-T12 (gate never delays a lost session / leaving the view / ceiling) were tests of a PROTOTYPE gate inside this page. They are replaced by G2-G11 in core-gate-real.mjs, which run the proposed gate on the REAL core.js.
await t('T13 a composition that is REALLY going on is never timed out: +120 s on the clock and it still holds a gate (node connected and focused)', async () => {
  const { ctx, page } = await composing(); eq(await page.evaluate(() => window.__spike.keeper.isComposing()), true, 'open');
  eq(await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 120000; const v = window.__spike.keeper.isComposing(); Date.now = real; return v; }), true, 'still composing after +120 s'); await ctx.close();
});
await t('T13b the composition node was REPLACED (removed from the page): it no longer holds a gate, at once', async () => {
  const { ctx, page } = await composing(); eq(await page.evaluate(() => window.__spike.keeper.isComposing()), true, 'open');
  eq(await page.evaluate(() => { document.querySelector('[data-fvp-field="a"]').remove(); return window.__spike.keeper.isComposing(); }), false, 'node gone'); await ctx.close();
});
await t('T13c focus left the composition node while NO compositionend arrived (synthetic start, node still in the page): it no longer holds a gate, at once', async () => {
  const { ctx, page } = await fresh({ tick: 1e9 }); await clickField(page, 'a');
  eq(await page.evaluate(() => { document.querySelector('[data-fvp-field="a"]').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); return window.__spike.keeper.isComposing(); }), true, 'open');
  eq(await page.evaluate(() => { const o = document.createElement('button'); o.id = 'elsewhere'; document.body.appendChild(o); o.focus(); return window.__spike.keeper.isComposing(); }), false, 'focus elsewhere, node still connected'); await ctx.close();
});
await t('T13d a focused element OUTSIDE our fields never holds a gate, even with a composition started on it', async () => {
  const { ctx, page } = await fresh({ tick: 1e9 });
  eq(await page.evaluate(() => { const o = document.createElement('input'); o.id = 'outside'; document.body.appendChild(o); o.focus(); o.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); return window.__spike.keeper.isComposing(); }), false, 'outside'); await ctx.close();
});
await t('T14 a render that does not carry the checkbox state: the keeper re-seats what the person just toggled (checked + focus)', async () => {
  const { ctx, page } = await fresh({ tick: 40 }); await page.evaluate(() => window.__spike.setIgnoreState(true)); await page.focus('[data-fvp-field="d"]'); await page.keyboard.press('Space'); await page.waitForTimeout(200);
  eq(await page.isChecked('[data-fvp-field="d"]'), true, 'checked kept'); eq(await active(page), 'd', 'focus kept'); await ctx.close();
});
await t('T15 a render that empties the container first (page height collapses, scroll is clamped): the window scroll is put back', async () => {
  const { ctx, page } = await fresh({ tick: 40 }); await page.evaluate(() => { window.scrollTo(0, 300); window.__spike.setShrink(true); }); await clickField(page, 'a'); await page.waitForTimeout(250);
  const y = await page.evaluate(() => Math.round(window.scrollY)); if (Math.abs(y - 300) > 2) throw new Error('scrollY ' + y); await ctx.close();
});

await t('T16 an inner scroller the person scrolled keeps its position while she types in a field OUTSIDE it (nothing else re-derives it)', async () => {
  const { ctx, page } = await fresh(); await page.evaluate(() => { document.querySelector('[data-fvp-scroll="sc"]').scrollTop = 150; }); await page.waitForTimeout(100);
  await clickField(page, 'a'); await page.keyboard.type('hello', { delay: 25 }); await page.waitForTimeout(150);
  eq(await page.evaluate(() => document.querySelector('[data-fvp-scroll="sc"]').scrollTop), 150, 'inner scroll'); await ctx.close();
});

await browser.close(); server.close();
console.log(`\n${pass} passed, ${fail} failed (restore tests).`); for (const r of results) console.log(r);
process.exit(fail ? 1 : 0);
