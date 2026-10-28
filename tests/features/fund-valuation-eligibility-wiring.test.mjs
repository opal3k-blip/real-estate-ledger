// R1-B2 / B2-4b — the ELIGIBILITY section (suspend / reinstate the effective head): wiring + pure view on the REAL reader, REAL actions orchestrator and REAL request runner, against the fake server.
// No DOM here: the wiring's handlers are called directly (the DOM layer is exercised in tests/browser/b3b-reviewer-real.mjs). Cloud, in-process results; never the emulator, CI or a user's machine.
// Run: node tests/features/fund-valuation-eligibility-wiring.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFundValuationReader } from '../../src/features/fund-valuation-reader.js';
import { createEditorWiring } from '../../src/features/fund-valuation-editor-wiring.js';
import { renderEditor } from '../../src/features/fund-valuation-editor-view.js';
import { documentHashHex } from '../../src/domain/validation/document-hash.js';
import { makeServer, makeStorage, FakeLocks, tick, FUND, FM, IC, IC2, ADMIN } from '../helpers/fund-valuation-server-fake.mjs';
import { makeFakeSubscribe } from '../helpers/fund-valuation-fakes.mjs';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); console.error(String(e && e.stack || e).split('\n').slice(0, 5).join('\n')); } }
const clone = (v) => JSON.parse(JSON.stringify(v));
const DAY = '2026-10-11'; const CH = 'a'.repeat(64); const BOSS = 'boss@example.com';
const SUSP = 'suspendValuationEligibility'; const REINST = 'reinstateValuationEligibility';

function rig({ session = IC, now = '2026-10-11T10:00:00Z', autoRead = true } = {}) {
  const clock = { now: new Date(now) }; const server = makeServer({ clock }); const box = { s: session ? { ...session } : null };
  const fake = makeFakeSubscribe(); const net = { calls: [], auto: autoRead }; const storage = makeStorage(); let seq = 0; let headHash = null;
  /** the explicit server read: the head document is built from the SERVER's head right now (the hash does not depend on eligibility) */
  const snapshot = () => {
    const heads = []; const valuations = []; const h = server.headOf(FUND, DAY);
    for (const doc of server.vals.values()) {
      valuations.push({ id: doc.valuationId, data: clone(doc) });
      if (doc.valuationDate !== DAY && server.slotId(doc.fundId, doc.valuationDate) === doc.valuationId) heads.push({ id: `${doc.fundId}__${doc.valuationDate}`, data: { fundId: doc.fundId, valuationDate: doc.valuationDate, headId: null, version: 0, headHash: null, eligibility: null, activeDraftId: doc.valuationId, rev: 1 } });
    }
    if (h || server.slotId(FUND, DAY)) heads.push({ id: `${FUND}__${DAY}`, data: { fundId: FUND, valuationDate: DAY, headId: h ? h.headId : null, version: h ? h.version : 0, headHash: h ? headHash : null, eligibility: h ? h.eligibility : null, activeDraftId: server.slotId(FUND, DAY), rev: h && Number.isInteger(h.rev) ? h.rev : 1 } });
    return { heads, valuations };
  };
  const fetchOnce = (source, fundId) => new Promise((resolve, reject) => { const c = { source, fundId, at: snapshot(), resolve, reject, done: false }; net.calls.push(c); if (net.auto) { c.done = true; resolve({ docs: c.at[source], fromCache: false }); } });
  net.release = (i) => { const c = net.calls[i]; c.done = true; c.resolve({ docs: snapshot()[c.source], fromCache: false }); };
  let wiring; let renders = 0;
  const reader = createFundValuationReader({ subscribe: fake.subscribe, getSession: () => (box.s ? { ...box.s } : { uid: null, email: null, role: null, roleResolved: false }), onChange: () => { renders += 1; if (wiring) { wiring.actions.sync(); if (wiring.onReaderChange) wiring.onReaderChange(); } }, fetchOnce });
  wiring = createEditorWiring({
    reader, call: (callable, payload, { user }) => server.handle(user, callable, payload), getSession: () => (box.s ? { ...box.s } : null), getFundAssetIds: () => ['A1', 'A2'],
    requestRender: () => { renders += 1; }, storage, locks: new FakeLocks(), now: () => clock.now, setTimer: () => 1, clearTimer: () => {}, genId: () => `req_${String(++seq).padStart(6, '0')}`,
  });
  const listen = async () => { const s = snapshot(); fake.emit('heads', FUND, s.heads); fake.emit('valuations', FUND, s.valuations); fake.emit('events', FUND, []); await tick(30); };
  /** an approved head H0 (prepared by fm, approved by boss) in the given eligibility */
  const seedHead = async ({ by = null, contributors = ['fm@example.com'], rev = 1, changedAt = '2026-10-11T08:00:00.000Z', headId = 'H0', version = 1 } = {}) => {
    server.seedHead({ valuationDate: DAY, headId, version, suspended: by ? { by } : null, rev, changedAt, headDoc: { contributors, approvedBy: BOSS } });
    const d = server.vals.get(headId); d.contentHash = CH; d.approvedAt = '2026-10-11T07:00:00.000Z'; d.updatedAt = d.approvedAt; d.status = 'approved';
    headHash = await documentHashHex({ valuationId: headId, version, contentHash: CH, approvedBy: BOSS });
  };
  const open = async () => { reader.open(FUND); await listen(); await reader.refresh(); await tick(30); };
  const html = () => wiring.renderSlot();
  return { clock, server, box, fake, net, storage, reader, wiring, listen, open, html, seedHead, snapshot, renders: () => renders };
}
const ui = (r) => r.wiring.ui();
const has = (h, s) => h.includes(s);
const calls = (r, c) => r.server.calls.filter((x) => x.callable === c);
const st = (r) => r.wiring.actions.getState();
async function ready(session = IC, o = {}) { const r = rig({ session }); await r.seedHead(o); await r.open(); r.html(); return r; }
const disabledOpen = (h, act) => new RegExp(`data-action="fve-el-open"[^>]*data-act="${act}"[^>]*disabled`).test(h);
async function toCard(r, act, reason = 'سبب التعليق') {
  assert.equal((await r.wiring.handleAction('fve-el-open', { act })).status, 'ok');
  assert.equal(r.wiring.onElInput('reason', reason).status, 'ok');
  const p = await r.wiring.handleAction('fve-el-prepare'); assert.equal(p.status, 'ready', JSON.stringify(p)); return p;
}

console.log('— B2-4b eligibility wiring + view —');

await t('W1 the section works with NO draft at all: the effective head, its state and both buttons with the reason for the disabled one; a fund_manager sees no section', async () => {
  const r = await ready(IC); assert.equal(st(r).review, null, 'no draft in this view'); const h = r.html();
  assert.ok(has(h, 'data-fve="eligibility"')); assert.ok(has(h, 'data-fve="el-head"')); assert.ok(has(h, '>H0<')); assert.match(h, /data-fve="el-state">سارية/);
  assert.ok(!disabledOpen(h, 'suspend')); assert.ok(disabledOpen(h, 'reinstate'));
  assert.match(h, /data-fve="el-why"[\s\S]*data-act="reinstate"[^>]*>[^<]*<\/?[^>]*>?[\s\S]*NOT_SUSPENDED/);
  assert.ok(has(h, 'data-fve="el-limit"'), 'the server limit is visible before anything is opened');
  const fm = await ready(FM); assert.ok(!has(fm.html(), 'data-fve="eligibility"'));
});

await t('W2 suspend: open -> reason -> prepare -> a FIXED card (head, version, rev, state now, state after, reason, effect, server limit) -> confirm sends exactly that; the form is gone; the view reflects it', async () => {
  const r = await ready(IC); await r.wiring.handleAction('fve-el-open', { act: 'suspend' });
  let h = r.html(); assert.ok(has(h, 'data-fve="el-form"')); assert.ok(has(h, 'data-fve-el="reason"')); assert.ok(has(h, 'data-fve="el-effect"')); assert.ok(has(h, 'data-fve="el-limit"'));
  r.wiring.onElInput('reason', '  سبب التعليق  '); assert.equal(calls(r, SUSP).length, 0, 'typing sends nothing');
  const p = await r.wiring.handleAction('fve-el-prepare'); assert.equal(p.status, 'ready'); h = r.html();
  assert.ok(has(h, 'data-kind="eligibility"')); assert.ok(has(h, 'data-fve="el-card-head"') && has(h, '>H0<')); assert.match(h, /data-fve="el-card-now"[^>]*><b>سارية/); assert.match(h, /data-fve="el-card-target">معلّقة/);
  assert.match(h, /data-fve="el-card-reason">سبب التعليق</); assert.match(h, /data-fve="el-card-effect">ℹ️[^<]*R1-C/); assert.ok(has(h, 'data-fve="el-limit"') && has(h, 'expectedHeadId'));
  assert.equal(r.wiring.onElInput('reason', 'تغيير بعد التجهيز').status, 'ignored', 'the reason is locked once the card exists');
  const c = await r.wiring.handleAction('fve-confirm-act', {}); assert.ok(['success_waiting_view'].includes(c.status), JSON.stringify(c));
  const sent = calls(r, SUSP); assert.equal(sent.length, 1); assert.deepEqual({ ...sent[0].payload, requestId: undefined }, { requestId: undefined, fundId: FUND, valuationDate: DAY, expectedHeadId: 'H0', reason: 'سبب التعليق' });
  await tick(30); assert.equal(ui(r).el, null, 'the typed reason leaves the page once the request exists');
  assert.equal(st(r).outcome.status, 'reflected'); h = r.html(); assert.match(h, /data-fve="el-state">معلّقة/); assert.ok(has(h, 'data-fve="reflected"')); assert.ok(!has(h, 'data-fve="el-form"'));
});

await t('W3 reinstate by another person after a suspension: the card shows who suspended and when; the suspender is disabled with SUSPENDER_CANNOT_RESTORE', async () => {
  const ic = await ready(IC, { by: 'ic@example.com' }); const h1 = ic.html(); assert.ok(disabledOpen(h1, 'reinstate')); assert.ok(has(h1, 'SUSPENDER_CANNOT_RESTORE'));
  const r = await ready(IC2, { by: 'ic@example.com' }); await toCard(r, 'reinstate', 'زال السبب'); const h = r.html();
  assert.match(h, /data-fve="el-card-now"[^>]*><b>معلّقة<\/b> · ic@example.com · 2026-10-11T08:00:00.000Z/); assert.match(h, /data-fve="el-card-target">سارية/);
  assert.equal((await r.wiring.handleAction('fve-confirm-act', {})).status, 'success_waiting_view'); assert.equal(calls(r, REINST).length, 1);
});

await t('W4 every disabling cause shows a plain reason: no head, head document not loaded, ambiguous request, waiting for the read, role', async () => {
  const none = rig({ session: IC }); await none.open(); const h0 = none.html(); assert.ok(disabledOpen(h0, 'suspend')); assert.ok(has(h0, 'NO_HEAD'));
  const nd = rig({ session: IC2 }); await nd.seedHead({ by: 'ic@example.com' }); nd.server.vals.get('H0').contributors = undefined; await nd.open(); const h1 = nd.html(); assert.ok(disabledOpen(h1, 'reinstate')); assert.ok(has(h1, 'HEAD_DOC_NOT_LOADED'));
  const amb = await ready(IC); amb.server.dropReplyOnce = true; await toCard(amb, 'suspend'); const a = await amb.wiring.handleAction('fve-confirm-act', {}); assert.equal(a.status, 'ambiguous');
  const h2 = amb.html(); assert.ok(disabledOpen(h2, 'suspend')); assert.ok(has(h2, 'PENDING_EXISTS')); assert.equal(ui(amb).el, null);
  const aw = rig({ session: IC, autoRead: false }); await aw.seedHead(); aw.reader.open(FUND); await aw.listen(); aw.net.auto = true; await aw.reader.refresh(); await tick(30); aw.html(); aw.net.auto = false;
  await toCard(aw, 'suspend'); await aw.wiring.handleAction('fve-confirm-act', {}); const h3 = aw.html(); assert.ok(has(h3, 'data-fve="awaiting"')); assert.ok(disabledOpen(h3, 'suspend')); assert.ok(has(h3, 'AWAITING_VIEW'));
  assert.equal(st(aw).available.suspend.reason, 'AWAITING_VIEW');
});

await t('W5 the reason is required: an empty / blank prepare shows REASON_REQUIRED and sends nothing; the form stays', async () => {
  const r = await ready(IC); await r.wiring.handleAction('fve-el-open', { act: 'suspend' }); r.wiring.onElInput('reason', '   ');
  const p = await r.wiring.handleAction('fve-el-prepare'); assert.deepEqual([p.status, p.code], ['blocked', 'REASON_REQUIRED']);
  const h = r.html(); assert.ok(has(h, 'data-fve="el-notice"') && has(h, 'REASON_REQUIRED')); assert.ok(has(h, 'data-fve="el-form"')); assert.equal(r.server.calls.length, 0);
});

await t('W6 SESSION CHANGE clears the form, the reason and the card at once: user switch, logout and permission loss; nothing of it reaches the new user\'s page', async () => {
  const secret = 'سرّ-لا-يظهر';
  const sw = await ready(IC); await toCard(sw, 'suspend', secret); assert.ok(has(sw.html(), secret));
  sw.box.s = { ...IC2 }; const h = sw.html(); assert.ok(!has(h, secret)); assert.equal(ui(sw).el, null); assert.equal(ui(sw).prepared, null); assert.ok(!has(h, 'data-fve="el-form"'));
  const lo = await ready(IC); await lo.wiring.handleAction('fve-el-open', { act: 'suspend' }); lo.wiring.onElInput('reason', secret); lo.box.s = null; lo.wiring.teardown();
  assert.equal(ui(lo).el, null); assert.equal(lo.wiring.onElInput('reason', 'x').status, 'ignored'); assert.equal(lo.html(), ''); lo.box.s = { ...IC }; assert.ok(!has(lo.html(), secret), 'a returning user starts with an empty form');
  const pl = await ready(IC); await toCard(pl, 'suspend', secret); pl.box.s = { ...IC, role: 'analyst' }; assert.equal(pl.html(), ''); assert.equal(ui(pl).el, null); assert.equal(ui(pl).prepared, null);
  assert.equal((await pl.wiring.handleAction('fve-confirm-act', { token: 'p1' })).code, 'NO_SESSION'); assert.equal(calls(pl, SUSP).length, 0);
});

await t('W7 a LATE reply of the old session does not touch the new user\'s form, reason or notice', async () => {
  const r = await ready(IC); await toCard(r, 'suspend', 'قديم'); r.server.delay = 40;
  const late = r.wiring.handleAction('fve-confirm-act', {}); await tick(2);
  r.box.s = { ...IC2 }; r.html(); await r.wiring.handleAction('fve-el-open', { act: 'suspend' }); r.wiring.onElInput('reason', 'جديد للمستخدم الجديد'); r.wiring.onElInput('reason', '  '); await r.wiring.handleAction('fve-el-prepare'); r.wiring.onElInput('reason', 'جديد للمستخدم الجديد');
  const noticeBefore = clone(ui(r).notice); assert.equal(noticeBefore && noticeBefore.code, 'REASON_REQUIRED');
  await late; const mine = ui(r).el; assert.ok(mine && mine.reason === 'جديد للمستخدم الجديد', 'the new form and its reason survive'); assert.deepEqual(clone(ui(r).notice), noticeBefore, 'the late reply neither clears nor replaces the new user\'s notice');
  assert.ok(has(r.html(), 'جديد للمستخدم الجديد'));
});

await t('W8 the head or date changes under an open form: another head -> the form goes; a moved head under a CARD -> the card goes (VIEW_CHANGED) and the typed reason stays', async () => {
  const a = await ready(IC); await toCard(a, 'suspend', 'x');
  await a.server.handle('ic2@example.com', SUSP, { requestId: 'ext-1', fundId: FUND, valuationDate: DAY, expectedHeadId: 'H0', reason: 'خارجي' }); await a.reader.refresh(); await tick(30);
  const h = a.html(); assert.equal(ui(a).prepared, null, 'the card is dropped'); assert.ok(ui(a).el && ui(a).el.reason === 'x', 'the reason stays'); assert.ok(has(h, 'data-fve="el-notice"') && has(h, 'VIEW_CHANGED'));
  assert.equal(calls(a, SUSP).filter((c) => c.payload.reason === 'x').length, 0, 'nothing was sent from the stale card');
  const d = await ready(IC); await toCard(d, 'suspend', 'z'); await d.seedHead({ rev: 2, changedAt: '2026-10-11T09:30:00.000Z' }); await d.reader.refresh(); await tick(30); d.html();
  assert.equal(ui(d).prepared, null, 'rev/changedAt moved with the SAME eligibility: the card is still dropped'); assert.ok(has(d.html(), 'VIEW_CHANGED'));
  const b = await ready(IC); await b.wiring.handleAction('fve-el-open', { act: 'suspend' }); b.wiring.onElInput('reason', 'y');
  await b.seedHead({ headId: 'H1', version: 2 }); await b.reader.refresh(); await tick(30); b.html(); assert.equal(ui(b).el, null, 'another head: the form is not carried over');
});

await t('W9 AMBIGUOUS: the original request is kept and still recoverable after the page is cleared; another user never sees it', async () => {
  const r = await ready(IC); r.server.dropReplyOnce = true; await toCard(r, 'suspend', 'أصلي'); const res = await r.wiring.handleAction('fve-confirm-act', {}); assert.equal(res.status, 'ambiguous');
  const pend = r.wiring.runner.pending(); assert.equal(pend.length, 1); const original = clone(pend[0].payload); assert.equal(original.reason, 'أصلي'); assert.equal(original.expectedHeadId, 'H0');
  r.box.s = { ...IC2 }; r.html(); assert.deepEqual(r.wiring.runner.pending().filter((e) => JSON.parse(e.scope)[0] === 'ic2@example.com'), []); assert.ok(!has(r.html(), 'data-fve="el-form"'));
  r.box.s = { ...IC }; r.html(); assert.equal(r.wiring.runner.pending().length, 1); assert.deepEqual(clone(r.wiring.runner.pending()[0].payload), original);
  const back = await r.wiring.handleAction('fve-retry-pending', { scope: r.wiring.runner.pending()[0].scope }); assert.ok(['success_waiting_view', 'no_effect'].includes(back.status), back.status);
  assert.deepEqual(clone(calls(r, SUSP)[1].payload), original); assert.equal(r.server.effectsOf('suspend'), 1);
});

await t('W10 view safety: hostile text is shown as text everywhere; the card comes from the prepared record, not from the live form', async () => {
  const r = await ready(IC); const bad = '<img src=x onerror=alert(1)>&"\''; await r.wiring.handleAction('fve-el-open', { act: 'suspend' }); r.wiring.onElInput('reason', bad);
  assert.ok(!r.html().includes('<img')); await r.wiring.handleAction('fve-el-prepare'); const h = r.html(); assert.ok(!h.includes('<img src=x')); assert.ok(h.includes('&lt;img src=x'));
  const model = { state: { ...st(r) }, ui: { prepared: { token: 't', action: 'suspend', summary: { action: 'suspend', head: { headId: '<b>H</b>', version: 1 }, reason: bad, targetEligibility: 'SUSPENDED' }, limits: {} }, el: { act: 'suspend', reason: 'live', headId: 'H0' } }, reader: {}, pendingAll: [] };
  const out = renderEditor(model, {}); assert.ok(!out.includes('<b>H</b>')); assert.ok(!out.includes('>live<'));
});

await t('W11 opening, typing and preparing send nothing; the eligibility modules add no storage, no Firebase, no DOM globals', () => {
  for (const f of ['fund-valuation-editor-view.js', 'fund-valuation-editor-wiring.js']) {
    const raw = fs.readFileSync(new URL(`../../src/features/${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/localStorage|sessionStorage|indexedDB|firebase|firestore/i.test(raw.replace(/data-fve[-\w]*/g, '')), f);
  }
});


/* ---- both sections on one page: a submitted draft under review AND an effective head ---- */
async function both() {
  const r = rig({ session: IC }); await r.seedHead(); await r.server.seedDraft({ valuationId: 'V1', valuationDate: DAY, state: 'submitted', enteredBy: 'fm@example.com' });
  await r.open(); r.html(); return r;
}
async function openRv(r, act = 'returnDraft', reason = 'سبب الإرجاع') { const o = await r.wiring.handleAction('fve-rv-open', { act }); assert.equal(o.status, 'ok', JSON.stringify([o, r.wiring.actions.getState().available, r.wiring.actions.getState().review])); assert.equal(r.wiring.onRvInput('reason', reason).status, 'ok'); }
const rvPrep = async (r) => r.wiring.handleAction('fve-rv-prepare');
const writable = (h, kind) => (kind === 'rv' ? has(h, 'data-fve="rv-form"') && !has(h, 'data-fve="prepared" data-kind="review') : has(h, 'data-fve="el-form"'));

await t('X1 return form open + typed reason, then an ELIGIBILITY card is prepared: the return field keeps accepting input (nothing visible is ignored), both reasons survive re-render', async () => {
  const r = await both(); await openRv(r, 'returnDraft', 'إرجاع-1'); await toCard(r, 'suspend', 'تعليق-1');
  let h = r.html(); assert.ok(has(h, 'data-kind="eligibility"')); assert.ok(has(h, 'data-fve="rv-form"'), 'the return form is still on the page');
  assert.equal(r.wiring.onRvInput('reason', 'إرجاع-2').status, 'ok', 'visible and writable => accepted'); assert.equal(ui(r).rv.reason, 'إرجاع-2'); h = r.html(); assert.ok(has(h, 'إرجاع-2'));
  assert.equal(r.wiring.onElInput('reason', 'x').status, 'ignored', 'the eligibility reason is locked WHILE ITS OWN card is shown'); assert.ok(!has(h, 'data-fve="el-form"'), 'and its form is not shown then');
  assert.equal(ui(r).el.reason, 'تعليق-1'); assert.equal(r.server.calls.filter((c) => c.callable !== undefined && /return|suspend/i.test(c.callable)).length, 0, 'nothing was sent');
});

await t('X2 the reverse: eligibility form open + typed reason, then a RETURN card is prepared: the eligibility field keeps accepting input', async () => {
  const r = await both(); assert.equal((await r.wiring.handleAction('fve-el-open', { act: 'suspend' })).status, 'ok'); r.wiring.onElInput('reason', 'تعليق-1');
  await openRv(r, 'returnDraft', 'إرجاع-1'); const p = await rvPrep(r); assert.equal(p.status, 'ready', JSON.stringify(p));
  let h = r.html(); assert.ok(has(h, 'data-kind="review')|| has(h, 'data-fve="prepared"')); assert.ok(has(h, 'data-fve="el-form"'));
  assert.equal(r.wiring.onElInput('reason', 'تعليق-2').status, 'ok'); assert.equal(ui(r).el.reason, 'تعليق-2'); assert.ok(has(r.html(), 'تعليق-2'));
  assert.equal(r.wiring.onRvInput('reason', 'x').status, 'ignored', 'the return reason is locked while ITS card is shown'); assert.equal(ui(r).rv.reason, 'إرجاع-1');
});

await t('X3 one card at a time, no silent replacement: preparing in the OTHER section while a card is pending is blocked with a visible reason; the pending card and both reasons stay', async () => {
  const r = await both(); await openRv(r, 'returnDraft', 'إرجاع-1'); const tok = (await toCard(r, 'suspend', 'تعليق-1')).token;
  const b = await rvPrep(r); assert.deepEqual([b.status, b.code], ['blocked', 'OTHER_CARD_PENDING']);
  const h = r.html(); assert.ok(has(h, 'data-fve="rv-notice"') && has(h, 'OTHER_CARD_PENDING') || has(h, 'بطاقة تأكيد معلّقة')); assert.equal(ui(r).prepared.token, tok); assert.equal(ui(r).rv.reason, 'إرجاع-1');
  assert.equal(r.server.calls.length, 0, 'nothing sent');
  // the reverse direction
  const r2 = await both(); await r2.wiring.handleAction('fve-el-open', { act: 'suspend' }); r2.wiring.onElInput('reason', 'تعليق-1'); await openRv(r2, 'returnDraft', 'إرجاع-1'); const t2 = (await rvPrep(r2)).token;
  const b2 = await r2.wiring.handleAction('fve-el-prepare'); assert.deepEqual([b2.status, b2.code], ['blocked', 'OTHER_CARD_PENDING']); assert.ok(has(r2.html(), 'data-fve="el-notice"')); assert.equal(ui(r2).prepared.token, t2); assert.equal(ui(r2).el.reason, 'تعليق-1');
});

await t('X4 edit / cancel are owned: cancelling or editing the OTHER section never removes a card it does not own; each section\'s own cancel removes only its form (+ its own card and notice)', async () => {
  const r = await both(); await openRv(r, 'returnDraft', 'إرجاع-1'); await toCard(r, 'suspend', 'تعليق-1'); const tok = ui(r).prepared.token;
  await r.wiring.handleAction('fve-rv-cancel'); assert.equal(ui(r).rv, null); assert.equal(ui(r).prepared && ui(r).prepared.token, tok, 'the eligibility card survives the return cancel'); assert.ok(has(r.html(), 'data-kind="eligibility"'));
  await openRv(r, 'returnDraft', 'إرجاع-3'); await r.wiring.handleAction('fve-rv-edit'); assert.equal(ui(r).prepared && ui(r).prepared.token, tok, 'rv-edit does not touch it either');
  await r.wiring.handleAction('fve-rv-open', { act: 'reject' }); assert.equal(ui(r).prepared && ui(r).prepared.token, tok, 'opening another reviewer form does not drop it');
  await r.wiring.handleAction('fve-el-edit'); assert.equal(ui(r).prepared, null, 'its owner can edit it'); assert.equal(ui(r).el.reason, 'تعليق-1', 'the reason is kept on edit'); assert.ok(has(r.html(), 'data-fve="el-form"'));
  // reverse: return card, then eligibility cancel/edit
  const q = await both(); await openRv(q, 'returnDraft', 'ر'); await rvPrep(q); const t3 = ui(q).prepared.token; await q.wiring.handleAction('fve-el-open', { act: 'suspend' }); q.wiring.onElInput('reason', 'ت');
  await q.wiring.handleAction('fve-el-cancel'); assert.equal(ui(q).el, null); assert.equal(ui(q).prepared && ui(q).prepared.token, t3, 'the return card survives the eligibility cancel');
  await q.wiring.handleAction('fve-el-edit'); assert.equal(ui(q).prepared && ui(q).prepared.token, t3); await q.wiring.handleAction('fve-rv-cancel'); assert.equal(ui(q).prepared, null); assert.equal(ui(q).rv, null);
  // a notice of the other section is not wiped by a cancel
  const n = await both(); await openRv(n, 'returnDraft', 'ر'); await toCard(n, 'suspend', 'ت'); await rvPrep(n); assert.ok(ui(n).notice && ui(n).notice.code === 'OTHER_CARD_PENDING');
  await n.wiring.handleAction('fve-el-cancel'); assert.equal(ui(n).notice, null, 'the pending-card notice goes with that card');
});

await t('X5 confirming the pending card works unchanged and sends exactly its own payload; the other section\'s form + reason stay; no automatic send anywhere', async () => {
  const r = await both(); await openRv(r, 'returnDraft', 'إرجاع-1'); await toCard(r, 'suspend', 'تعليق-1'); assert.equal(r.server.calls.length, 0);
  const c = await r.wiring.handleAction('fve-confirm-act', {}); assert.equal(c.status, 'success_waiting_view', JSON.stringify(c)); assert.equal(calls(r, SUSP).length, 1); assert.equal(calls(r, SUSP)[0].payload.reason, 'تعليق-1');
  assert.equal(r.server.calls.filter((x) => x.callable !== SUSP).length, 0, 'the return was never sent'); assert.ok(ui(r).rv && ui(r).rv.reason === 'إرجاع-1');
});

await t('X6 session change / access loss clears BOTH forms and any card together; a late reply cannot restore either', async () => {
  const r = await both(); await openRv(r, 'returnDraft', 'سري-1'); await toCard(r, 'suspend', 'سري-2'); r.box.s = { ...IC2 }; const h = r.html();
  assert.ok(!has(h, 'سري-1') && !has(h, 'سري-2')); assert.deepEqual([ui(r).rv, ui(r).el, ui(r).prepared], [null, null, null]);
  const l = await both(); await openRv(l, 'returnDraft', 'سري-1'); await l.wiring.handleAction('fve-el-open', { act: 'suspend' }); l.wiring.onElInput('reason', 'سري-2'); l.box.s = null; l.wiring.teardown();
  assert.equal(l.html(), ''); assert.deepEqual([ui(l).rv, ui(l).el, ui(l).prepared], [null, null, null]); assert.equal(l.wiring.onRvInput('reason', 'x').status, 'ignored'); assert.equal(l.wiring.onElInput('reason', 'x').status, 'ignored');
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
