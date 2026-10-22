// R1-B2 / B2-4c — DEDICATED browser test of the ELIGIBILITY section (suspend / reinstate) and its overlap with the reviewer section, in headless Chromium (cloud; NOT the user's machine, NOT Edge/Windows).
// Real: index.html, core.js, the real render()/auth path, the section hooks, the real panel, reader, actions orchestrator, request runner and focus keeper — all served by the B2-4c acceptance server.
// Faked: Firebase + CDN (stubs), the Firestore listener + explicit read + callables (the in-page fake server of the unit tests), IME (CDP imeSetComposition). Real mouse clicks and real key input.
// Usage: node tests/browser/b4c-eligibility-real.mjs     (starts tests/manual/b2-4c-acceptance-server.mjs as a child; only that child's own PID is ever killed)
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
const A = (s) => `[data-acc="${s}"]`; const ACT = (a) => `[data-action="${a}"]`;
const EL = (a) => `[data-action="fve-el-open"][data-act="${a}"]`; const RV = (a) => `[data-action="fve-rv-open"][data-act="${a}"]`;
const EF = '[data-fvp-field="el.reason"]'; const RF = '[data-fvp-field="rv.reason"]';
const ui = (p) => p.evaluate(() => { const u = window.__accKit.H.wiring.ui(); return { el: u.el ? { act: u.el.act, reason: u.el.reason } : null, rv: u.rv ? { act: u.rv.act, reason: u.rv.reason } : null, prepared: u.prepared ? u.prepared.action : null, notice: u.notice ? u.notice.code || u.notice.status : null }; });
const calls = (p, re) => p.evaluate((s) => window.__accKit.H.log.filter((e) => new RegExp(s, 'i').test(e.callable)).map((e) => ({ callable: e.callable, requestId: e.requestId, reason: e.reason, outcome: e.outcome, same: e.samePayloadAsFirst })), re.source);
const html = (p) => p.evaluate(() => document.documentElement.innerHTML);
const txt = (p, sel) => p.$eval(sel, (e) => e.innerText);
const waitFor = async (p, fn, arg, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.evaluate(fn, arg)) return true; await p.waitForTimeout(100); } return false; };
const elState = (p) => p.evaluate(() => { const e = document.querySelector('[data-fve="el-state"]'); return e ? e.textContent.trim() : null; });
try {
  for (let i = 0; i < 50 && !/acceptance kit/.test(out); i += 1) await new Promise((r) => setTimeout(r, 100));
  ok(/acceptance kit/.test(out), 'server did not start: ' + out);
  const browser = await chromium.launch({ args: ['--no-sandbox'] }); const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = []; const requests = [];
  const fresh = async () => { const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(String(e))); page.on('request', (r) => requests.push(r.url())); await page.goto(`http://127.0.0.1:${PORT}/`); await page.waitForSelector('#acc', { timeout: 15000 }); await waitFor(page, () => !!window.__accKit, null, 15000); await page.waitForTimeout(500); return page; };
  const as = async (page, k) => { await mclick(page, A('as:' + k)); await page.waitForTimeout(1000); };
  const seed = async (page, k) => { await mclick(page, A('seed:' + k)); await page.waitForTimeout(900); };
  const storm = (p, ms) => p.evaluate((m) => { window.__storm = setInterval(() => window.__accKit.H.core.render(), m); }, ms);
  const stopStorm = (p) => p.evaluate(() => clearInterval(window.__storm));
  const type = async (p, sel, s) => { await mclick(p, sel); await p.keyboard.insertText(s); await p.waitForTimeout(60); };
  console.log('— B2-4c eligibility section in a REAL browser page — ' + browser.version() + ' (headless, cloud; not Edge, not Windows)');

  await t('B0 boots on the real page: no section for a fund_manager, none before a head exists; for IC with a head: the section, the head, both buttons (reinstate disabled WITH a visible reason); no external requests, no page errors', async () => {
    const p = await fresh(); await as(p, 'fm'); await seed(p, 'head'); eq(await p.$('[data-fve="eligibility"]'), null, 'fund_manager sees no section');
    await as(p, 'ic'); await p.waitForSelector('[data-fve="eligibility"]', { timeout: 5000 }); ok((await txt(p, '[data-fve="el-head"]')).includes('H0'), 'head shown'); eq(await elState(p), 'سارية');
    eq(await p.$eval(EL('suspend'), (e) => e.disabled), false); eq(await p.$eval(EL('reinstate'), (e) => e.disabled), true); ok((await txt(p, '[data-fve="el-why"]')).length > 10, 'visible reason'); ok(await p.$('[data-fve="el-limit"]'), 'server limit visible at once');
    const ext = requests.filter((u) => !u.startsWith(`http://127.0.0.1:${PORT}`) && !u.startsWith('data:') && !u.startsWith('blob:') && !/^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)/.test(u)); eq(ext.length, 0, ext.join(' '));
    eq(errors.length, 0, errors.join(' | ')); await p.close();
  });

  await t('B1 REAL clicks + real keys: suspend → reason → fixed card (head, now, target, reason, effect, limit) → NOTHING sent until confirm → confirm sends exactly the card\'s reason once → state «معلّقة»', async () => {
    const p = await fresh(); await seed(p, 'head'); await p.waitForSelector(EL('suspend')); await mclick(p, EL('suspend')); await p.waitForSelector(EF);
    await type(p, EF, '  سبب التعليق الأول  '); await mclick(p, ACT('fve-el-prepare')); await p.waitForSelector('[data-fve="prepared"][data-kind="eligibility"]');
    const card = await txt(p, '[data-fve="prepared"]'); for (const v of ['H0', 'سارية', 'معلّقة', 'سبب التعليق الأول', 'R1-C', 'expectedHeadId']) ok(card.includes(v), 'card shows ' + v);
    eq((await calls(p, /./)).length, 0, 'nothing sent before the confirm'); eq(await p.$(EF), null, 'the field is not on the card');
    await mclick(p, ACT('fve-confirm-act')); await waitFor(p, () => window.__accKit.H.log.length >= 1); await p.waitForTimeout(600);
    const sent = await calls(p, /suspend/); eq(sent.length, 1); eq(sent[0].reason, 'سبب التعليق الأول'); eq((await ui(p)).el, null, 'form gone'); eq(await p.$(EF), null);
    ok(await waitFor(p, () => (document.querySelector('[data-fve="el-state"]') || {}).textContent === 'معلّقة'), 'the view shows suspended'); await p.close();
  });

  await t('B2 reinstate: the suspender cannot (disabled, reason shown); another reviewer reinstates via the card and the head becomes eligible', async () => {
    const p = await fresh(); await seed(p, 'susp'); await as(p, 'ic'); await p.waitForSelector(EL('reinstate')); eq(await p.$eval(EL('reinstate'), (e) => e.disabled), true); ok((await txt(p, '[data-fve="el-why"]')).includes('SUSPENDER_CANNOT_RESTORE') || (await txt(p, '[data-fve="el-why"]')).includes('علّق'), 'reason');
    await as(p, 'ic2'); await p.waitForSelector(EL('reinstate') + ':not([disabled])', { timeout: 5000 }); await mclick(p, EL('reinstate')); await type(p, EF, 'زال سبب التعليق'); await mclick(p, ACT('fve-el-prepare')); await p.waitForSelector('[data-fve="prepared"][data-kind="eligibility"]');
    ok((await txt(p, '[data-fve="el-card-now"]')).includes('ic@example.com'), 'who suspended is on the card'); await mclick(p, ACT('fve-confirm-act'));
    ok(await waitFor(p, () => (document.querySelector('[data-fve="el-state"]') || {}).textContent === 'سارية'), 'eligible again'); eq((await calls(p, /reinstate/)).length, 1); await p.close();
  });

  await t('B3 separation of duties: a contributor of the head is disabled with a visible reason; an admin who is neither contributor nor suspender is not', async () => {
    const p = await fresh(); await seed(p, 'suspC'); await as(p, 'ic2'); await p.waitForSelector(EL('reinstate')); eq(await p.$eval(EL('reinstate'), (e) => e.disabled), true);
    const why = await txt(p, '[data-fve="el-why"]'); ok(why.includes('CONTRIBUTOR_CANNOT_REINSTATE') || why.includes('مساهم'), 'reason visible: ' + why);
    await as(p, 'admin'); await p.waitForSelector(EL('reinstate') + ':not([disabled])', { timeout: 5000 }); await p.close();
  });

  await t('B4 OVERLAP (return form first): a typed return reason, then an eligibility card is prepared → the return field stays visible AND writable (real typing is stored), both reasons survive renders; preparing the return is refused visibly; cancelling the return form keeps the eligibility card', async () => {
    const p = await fresh(); await seed(p, 'both'); await p.waitForSelector(RV('returnDraft')); await mclick(p, RV('returnDraft')); await p.waitForSelector(RF); await type(p, RF, 'إرجاع-أ');
    await mclick(p, EL('suspend')); await p.waitForSelector(EF); await type(p, EF, 'تعليق-أ'); await mclick(p, ACT('fve-el-prepare')); await p.waitForSelector('[data-fve="prepared"][data-kind="eligibility"]');
    ok(await p.$(RF), 'the return field is still on the page'); await type(p, RF, '-ب'); await storm(p, 40); await p.waitForTimeout(300); await stopStorm(p);
    eq(await p.$eval(RF, (e) => e.value), 'إرجاع-أ-ب', 'field'); eq((await ui(p)).rv.reason, 'إرجاع-أ-ب', 'state'); eq((await ui(p)).el.reason, 'تعليق-أ', 'eligibility reason kept');
    await mclick(p, '[data-action="fve-rv-prepare"]'); await p.waitForSelector('[data-fve="rv-notice"]'); ok((await txt(p, '[data-fve="rv-notice"]')).length > 5, 'visible notice'); eq((await ui(p)).prepared, 'suspend', 'the eligibility card was not replaced');
    await mclick(p, '[data-action="fve-rv-cancel"]'); await p.waitForTimeout(200); eq((await ui(p)).prepared, 'suspend', 'return cancel keeps the eligibility card'); ok(await p.$('[data-fve="prepared"][data-kind="eligibility"]'), 'card on the page');
    await mclick(p, '[data-action="fve-el-edit"]'); await p.waitForSelector(EF); eq(await p.$eval(EF, (e) => e.value), 'تعليق-أ', 'edit gives the form back with its reason'); eq((await calls(p, /./)).length, 0, 'nothing was sent'); await p.close();
  });

  await t('B5 OVERLAP (eligibility form first): a typed eligibility reason, then a RETURN card is prepared → the eligibility field stays writable; eligibility prepare is refused visibly; eligibility cancel keeps the return card', async () => {
    const p = await fresh(); await seed(p, 'both'); await p.waitForSelector(EL('suspend')); await mclick(p, EL('suspend')); await p.waitForSelector(EF); await type(p, EF, 'تعليق-1');
    await mclick(p, RV('returnDraft')); await p.waitForSelector(RF); await type(p, RF, 'إرجاع-1'); await mclick(p, ACT('fve-rv-prepare')); await p.waitForSelector('[data-fve="prepared"]');
    ok(await p.$(EF), 'the eligibility field is still on the page'); await type(p, EF, '-2'); eq(await p.$eval(EF, (e) => e.value), 'تعليق-1-2'); eq((await ui(p)).el.reason, 'تعليق-1-2');
    await mclick(p, ACT('fve-el-prepare')); await p.waitForSelector('[data-fve="el-notice"]'); eq((await ui(p)).prepared, 'returnDraft', 'the return card was not replaced');
    await mclick(p, '[data-action="fve-el-cancel"]'); await p.waitForTimeout(200); eq((await ui(p)).prepared, 'returnDraft', 'eligibility cancel keeps the return card'); eq((await ui(p)).el, null); eq((await calls(p, /./)).length, 0, 'nothing sent'); await p.close();
  });

  await t('B6 TYPING a 200-character Arabic reason one key at a time while core.render() runs every 40 ms: nothing lost, focus kept, state equals the field', async () => {
    const p = await fresh(); await seed(p, 'head'); await mclick(p, EL('suspend')); await p.waitForSelector(EF); await mclick(p, EF); await storm(p, 40);
    const text = 'سبب التعليق '.repeat(17).slice(0, 200); for (const ch of text) await p.keyboard.insertText(ch); await stopStorm(p); await p.waitForTimeout(150);
    const v = await p.evaluate(() => { const e = document.querySelector('[data-fvp-field="el.reason"]'); return { value: e.value, start: e.selectionStart, active: document.activeElement.getAttribute('data-fvp-field') }; });
    eq(v.value, text); eq(v.start, text.length, 'caret'); eq((await ui(p)).el.reason, text, 'state'); eq(v.active, 'el.reason', 'focus'); await p.close();
  });

  await t('B6b a multi-line reason keeps ITS OWN scroll under the render storm (the typed line stays in view)', async () => {
    const p = await fresh(); await seed(p, 'head'); await mclick(p, EL('suspend')); await p.waitForSelector(EF); await mclick(p, EF); await storm(p, 40);
    for (let i = 1; i <= 7; i += 1) { for (const ch of 'السطر ' + i + ' نص') await p.keyboard.insertText(ch); if (i < 7) await p.keyboard.press('Enter'); await p.waitForTimeout(120); }
    await p.waitForTimeout(250); const m = await p.evaluate(() => { const e = document.querySelector('[data-fvp-field="el.reason"]'); return { st: e.scrollTop, sh: e.scrollHeight, ch: e.clientHeight, end: e.selectionStart === e.value.length }; }); await stopStorm(p);
    ok(m.sh > m.ch, 'meaningful: ' + JSON.stringify(m)); ok(m.end, 'caret at end'); ok(m.st + m.ch >= m.sh - 4, 'last line in view ' + JSON.stringify(m)); await p.close();
  });

  await t('B7 IME composition in the eligibility reason under renders every 200 ms: no render during it, the commit leaves the text intact in field and state', async () => {
    const p = await fresh(); await seed(p, 'head'); await mclick(p, EL('suspend')); await p.waitForSelector(EF); await mclick(p, EF); const cdp = await ctx.newCDPSession(p); await storm(p, 200);
    const renders = () => p.evaluate(() => window.__accKit.H.renderCount()); const holds = () => p.evaluate(() => window.__accKit.H.wiring.holdsRender());
    await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await p.waitForTimeout(100); const r0 = await renders(); eq(await holds(), true, 'holds');
    await p.waitForTimeout(900); eq(await renders(), r0, 'no render during the composition'); await cdp.send('Input.imeSetComposition', { text: 'كت', selectionStart: 2, selectionEnd: 2 }); await p.waitForTimeout(150);
    await cdp.send('Input.insertText', { text: 'كتب' }); await p.waitForTimeout(500); await stopStorm(p);
    eq(await p.$eval(EF, (e) => e.value), 'كتب'); eq((await ui(p)).el.reason, 'كتب'); eq(await holds(), false); await p.close();
  });

  const loseAccess = {
    'user switch': (p) => p.evaluate(() => { const H = window.__accKit.H; H.box.s = { ...H.USERS.ic2 }; window.__authCb({ uid: H.USERS.ic2.uid, email: H.USERS.ic2.email }); }),
    'sign-out': (p) => p.evaluate(() => { const H = window.__accKit.H; H.box.s = null; window.__authCb(null); }),
    'read denied': (p) => p.evaluate(() => { window.__accKit.O.actions.deny(); }),
    'role unresolved': (p) => p.evaluate(() => { const H = window.__accKit.H; H.box.s = { ...H.box.s, roleResolved: false }; H.core.render(); }),
    'role lost': (p) => p.evaluate(() => { const H = window.__accKit.H; H.box.s = { ...H.box.s, role: 'viewer' }; H.core.render(); }),
  };
  for (const [name, fn] of Object.entries(loseAccess)) {
    await t(`B8 CLEARING (${name}) while typing + an open composition: section, form, reason and card are gone at once; the text is not in the page; a late composition commit does not bring it back`, async () => {
      const p = await fresh(); await seed(p, 'head'); await mclick(p, EL('suspend')); await p.waitForSelector(EF); await mclick(p, EF); await p.keyboard.type('SECRET-E', { delay: 10 });
      const cdp = await ctx.newCDPSession(p); await storm(p, 150); await cdp.send('Input.imeSetComposition', { text: 'ك', selectionStart: 1, selectionEnd: 1 }); await p.waitForTimeout(150);
      await fn(p); await p.waitForTimeout(100);
      const res = await p.evaluate(() => ({ form: !!document.querySelector('[data-fvp-field="el.reason"]'), html: document.documentElement.innerHTML.includes('SECRET-E'), el: window.__accKit.H.wiring.ui().el, prepared: window.__accKit.H.wiring.ui().prepared }));
      eq(res.form, false, 'field gone'); eq(res.html, false, 'text not in the page'); eq(res.el, null, 'state'); eq(res.prepared, null);
      await cdp.send('Input.insertText', { text: 'LATEZQ' }).catch(() => {}); await p.waitForTimeout(600); await stopStorm(p);
      const after = await p.evaluate(() => ({ html: /SECRET-E|LATEZQ/.test(document.documentElement.innerHTML), el: window.__accKit.H.wiring.ui().el })); eq(after.html, false, 'nothing comes back'); eq(after.el, null); await p.close();
    });
  }

  await t('B8b a PREPARED card is also gone at once when access is lost (and a click on a stale confirm sends nothing)', async () => {
    const p = await fresh(); await seed(p, 'head'); await mclick(p, EL('suspend')); await type(p, EF, 'سري-بطاقة'); await mclick(p, ACT('fve-el-prepare')); await p.waitForSelector('[data-fve="prepared"][data-kind="eligibility"]');
    await loseAccess['read denied'](p); await p.waitForTimeout(200); eq(await p.$('[data-fve="prepared"]'), null, 'card gone'); ok(!(await html(p)).includes('سري-بطاقة'), 'text gone'); eq((await calls(p, /suspend/)).length, 0); await p.close();
  });

  await t('B9 a LATE reply of the previous user touches NOTHING of the new user: neither the half-typed reason nor the new user\'s visible notice (the old request still lands on the server)', async () => {
    const p = await fresh(); await seed(p, 'head'); await mclick(p, EL('suspend')); await type(p, EF, 'قديم'); await mclick(p, ACT('fve-el-prepare')); await p.waitForSelector('[data-fve="prepared"]');
    await p.evaluate(() => { window.__accKit.H.srv.delay = 2500; }); await mclick(p, ACT('fve-confirm-act'));
    await p.evaluate(() => { const H = window.__accKit.H; H.box.s = { ...H.USERS.ic2 }; window.__authCb({ uid: H.USERS.ic2.uid, email: H.USERS.ic2.email }); setTimeout(() => H.reopen(), 200); });
    await p.waitForSelector(EL('suspend') + ':not([disabled])', { timeout: 5000 }); await mclick(p, EL('suspend')); await p.waitForSelector(EF);
    await mclick(p, ACT('fve-el-prepare')); await p.waitForSelector('[data-fve="el-notice"]', { timeout: 3000 });   // an empty reason: the new user\'s own notice
    await type(p, EF, 'مستخدم جديد'); const before = await ui(p); eq(before.notice, 'REASON_REQUIRED');
    await p.waitForTimeout(3200);   // the old reply has come back by now
    await p.evaluate(() => { window.__accKit.H.srv.delay = 0; });
    eq(await p.evaluate(() => window.__accKit.H.srv.effectsOf('suspend')), 1, 'the old request did land (the test is meaningful)');
    const after = await ui(p); eq(after.el && after.el.reason, 'مستخدم جديد', 'state'); eq(await p.$eval(EF, (e) => e.value), 'مستخدم جديد', 'field'); eq(after.notice, 'REASON_REQUIRED', 'the new user\'s notice is untouched'); ok(await p.$('[data-fve="el-notice"]'), 'notice still on the page');
    await p.close();
  });

  await t('B10 HEAD CHANGE: another person suspends the same head under a prepared card → the card goes (notice shown), the reason stays, nothing sent; a NEW head under the form removes form and reason', async () => {
    const p = await fresh(); await seed(p, 'head'); await mclick(p, EL('suspend')); await type(p, EF, 'سبب-ثابت'); await mclick(p, ACT('fve-el-prepare')); await p.waitForSelector('[data-fve="prepared"][data-kind="eligibility"]');
    await mclick(p, A('ext-suspend')); ok(await waitFor(p, () => !document.querySelector('[data-fve="prepared"][data-kind="eligibility"]'), null, 6000), 'card dropped');
    const s = await ui(p); eq(s.prepared, null); ok(s.el && s.el.reason === 'سبب-ثابت', 'reason kept'); ok(await p.$('[data-fve="el-notice"]'), 'notice'); eq((await calls(p, /^suspend/)).length, 0, 'nothing sent from the stale card');
    await p.close();
    const q = await fresh(); await seed(q, 'head'); await mclick(q, EL('suspend')); await type(q, EF, 'سيُمسح'); await mclick(q, A('ext-newhead'));
    ok(await waitFor(q, () => !document.querySelector('[data-fvp-field="el.reason"]'), null, 6000), 'form gone'); ok(!(await html(q)).includes('سيُمسح'), 'text gone'); eq((await ui(q)).el, null); ok((await txt(q, '[data-fve="el-head"]')).includes('H1'), 'new head shown'); await q.close();
  });

  await t('B11 AMBIGUOUS: a dropped reply → buttons disabled with a visible reason; retry from the pending list resends the SAME requestId and payload; the effect happens once', async () => {
    const p = await fresh(); await seed(p, 'head'); await mclick(p, EL('suspend')); await type(p, EF, 'غامض-مميّز'); await mclick(p, ACT('fve-el-prepare')); await p.waitForSelector('[data-fve="prepared"]');
    await mclick(p, A('drop')); await mclick(p, ACT('fve-confirm-act')); await p.waitForTimeout(900);
    eq(await p.$eval(EL('suspend'), (e) => e.disabled), true); ok((await txt(p, '[data-fve="el-why"]')).length > 5, 'visible reason');
    const retry = await p.$('[data-action="fve-retry"], [data-action="fve-retry-pending"], [data-fve="pending"] button'); ok(retry, 'a retry control'); await retry.click(); await p.waitForTimeout(1200);
    const log = await calls(p, /suspend/); ok(log.length >= 2, 'two calls ' + log.length); eq(log[0].requestId, log[1].requestId); eq(log[1].same, true); eq(await p.evaluate(() => window.__accKit.H.srv.effectsOf('suspend')), 1, 'one effect'); await p.close();
  });

  await browser.close();
} catch (e) { fail += 1; console.error('  ✗ harness: ' + e.message); } finally { child.kill(); }
console.log(`\n${pass} passed, ${fail} failed.`); process.exit(fail ? 1 : 0);
