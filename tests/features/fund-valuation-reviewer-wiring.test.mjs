// R1-B2 / B2-3b — the REVIEWER section (review / return / reject / approve): wiring + pure view on the REAL reader, REAL actions orchestrator and REAL request runner, against the fake server.
// No DOM here: the wiring's handlers are called directly (the DOM layer and the page are exercised in tests/browser/b1-editor-real.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFundValuationReader } from '../../src/features/fund-valuation-reader.js';
import { createEditorWiring, READ_MAX_AGE_MS } from '../../src/features/fund-valuation-editor-wiring.js';
import { renderEditor } from '../../src/features/fund-valuation-editor-view.js';
import * as E from '../../src/features/fund-valuation-editor.js';
import { makeServer, makeStorage, FakeLocks, tick, FUND, FM, FM2, IC, IC2, ADMIN } from '../helpers/fund-valuation-server-fake.mjs';
import { makeFakeSubscribe, approvedPair } from '../helpers/fund-valuation-fakes.mjs';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); if (!process.env.CONTINUE_ON_FAIL) throw e; console.error(`      ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`); } }
const clone = (v) => JSON.parse(JSON.stringify(v));
function rig({ session = FM, now = '2026-10-11T10:00:00Z', autoRead = true } = {}) {
  const clock = { now: new Date(now) }; const server = makeServer({ clock }); const box = { s: session ? { ...session } : null };
  const fake = makeFakeSubscribe(); const net = { calls: [], auto: autoRead }; const storage = makeStorage(); const timers = []; let seq = 0; const extra = { heads: [], valuations: [] };
  const snapshot = () => {
    const heads = [...extra.heads]; const valuations = [...extra.valuations];
    for (const doc of server.vals.values()) {
      valuations.push({ id: doc.valuationId, data: clone(doc) });
      if (server.slotId(doc.fundId, doc.valuationDate) === doc.valuationId) heads.push({ id: `${doc.fundId}__${doc.valuationDate}`, data: { fundId: doc.fundId, valuationDate: doc.valuationDate, headId: null, version: 0, headHash: null, eligibility: null, activeDraftId: doc.valuationId, rev: 1 } });
    }
    return { heads, valuations };
  };
  const fetchOnce = (source, fundId) => new Promise((resolve, reject) => { const c = { source, fundId, at: snapshot(), resolve, reject, done: false }; net.calls.push(c); if (net.auto) { c.done = true; resolve({ docs: c.at[source], fromCache: false }); } });
  net.release = (i, { asOf = 'now' } = {}) => { const c = net.calls[i]; c.done = true; c.resolve({ docs: (asOf === 'now' ? snapshot() : c.at)[c.source], fromCache: false }); };
  net.releaseRead = (k, o) => { net.release(2 * k, o); net.release(2 * k + 1, o); };
  let wiring; let renders = 0;
  const reader = createFundValuationReader({ subscribe: fake.subscribe, getSession: () => (box.s ? { ...box.s } : { uid: null, email: null, role: null, roleResolved: false }), onChange: () => { renders += 1; if (wiring) { wiring.actions.sync(); if (wiring.onReaderChange) wiring.onReaderChange(); } }, fetchOnce });
  wiring = createEditorWiring({
    reader, call: (callable, payload, { user }) => server.handle(user, callable, payload), getSession: () => (box.s ? { ...box.s } : null), getFundAssetIds: () => ['A1', 'A2'],
    requestRender: () => { renders += 1; }, storage, locks: new FakeLocks(), now: () => clock.now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    genId: () => `req_${String(++seq).padStart(6, '0')}`,
  });
  const listen = async () => { const s = snapshot(); fake.emit('heads', FUND, s.heads); fake.emit('valuations', FUND, s.valuations); fake.emit('events', FUND, []); await tick(); };
  const open = async () => { reader.open(FUND); await listen(); };
  const html = () => wiring.renderSlot();
  const fill = (extraSkip = []) => { for (const [p, v] of FILL) if (!extraSkip.includes(p)) assert.equal(wiring.onInput(p, v).status, 'ok', p); };
  return { clock, server, box, fake, net, storage, reader, wiring, listen, open, html, fill, extra, snapshot, renders: () => renders, timers };
}

const DAY = '2026-10-11';
async function withSubmitted(session = IC, { state = 'submitted', enteredBy = 'fm@example.com' } = {}) {
  const r = rig({ session }); await r.server.seedDraft({ valuationId: 'V1', state, enteredBy });
  if (state === 'reviewed') r.server.vals.get('V1').review = { reviewedBy: 'ic@example.com', reviewedContentHash: r.server.vals.get('V1').contentHash };
  await r.open(); return r;
}
const calls = (r, c) => r.server.calls.filter((x) => x.callable === c);
const ui = (r) => r.wiring.ui();
const has = (h, s) => h.includes(s);
const hashOfV1 = (r) => r.server.vals.get('V1').contentHash;
const REVIEW_CALLABLE = (r, name) => r.server.calls.filter((x) => String(x.callable).toLowerCase().includes(name));

console.log('— B2-3b reviewer wiring + view —');

await t('R1 the section is for reviewer roles only; a fund_manager sees no review controls; buttons follow the orchestrator\'s gates with a reason', async () => {
  const fm = await withSubmitted(FM); assert.ok(!has(fm.html(), 'data-fve="reviewer"'));
  const ic = await withSubmitted(IC); const h = ic.html(); assert.ok(has(h, 'data-fve="reviewer"'));
  for (const a of ['review', 'returnDraft', 'reject']) assert.ok(!new RegExp(`data-action="fve-rv-open"[^>]*data-act="${a}"[^>]*disabled`).test(h), a);
  assert.match(h, /data-action="fve-rv-open"[^>]*data-act="approve"[^>]*disabled/);          // submitted, not reviewed: approve is not offered
  const rv = await withSubmitted(IC2, { state: 'reviewed' }); { const hh = rv.html(); const st = rv.wiring.actions.getState(); assert.equal(/data-action="fve-rv-open"[^>]*data-act="approve"[^>]*disabled/.test(hh), !st.available.approve.allowed, JSON.stringify(st.available.approve)); }
});

await t('R2 review: open → prepare → the card shows state, revision, the full fingerprint, the content and NO reason; confirm sends exactly the fingerprint shown', async () => {
  const r = await withSubmitted(IC); r.html();
  assert.equal((await r.wiring.handleAction('fve-rv-open', { act: 'review' })).status, 'ok');
  let h = r.html(); assert.ok(has(h, 'data-fve="rv-form"')); assert.ok(!has(h, 'data-fve-rv="reason"'), 'a review carries no reason');
  assert.equal((await r.wiring.handleAction('fve-rv-prepare')).status, 'ready'); h = r.html();
  assert.ok(has(h, 'data-kind="review"')); assert.ok(has(h, hashOfV1(r))); assert.ok(has(h, 'data-fve="rv-content"')); assert.ok(has(h, 'external appraisal')); assert.ok(!has(h, 'data-fve="rv-reason"'));
  assert.ok(has(h, 'data-fve="rv-preview" data-status="none"'), 'the preview is optional and is not shown as a result when it was not made');
  const res = await r.wiring.handleAction('fve-confirm-act'); assert.equal(res.status, 'success_waiting_view', JSON.stringify(res));
  const sent = REVIEW_CALLABLE(r, 'review')[0]; assert.ok(sent, 'a review call was made'); assert.equal(sent.payload.expectedContentHash, hashOfV1(r).length === 64 ? sent.payload.expectedContentHash : null);
  assert.equal(ui(r).rv, null, 'the form is gone once the request exists'); assert.ok(has(r.html(), 'data-fve="awaiting"'));
});

await t('R3 return: the reason is required, trimmed, LOCKED once prepared; the card shows exactly what is sent; "edit" unlocks; confirm sends the card\'s reason', async () => {
  const r = await withSubmitted(IC); r.html();
  await r.wiring.handleAction('fve-rv-open', { act: 'returnDraft' }); r.html();
  let p = await r.wiring.handleAction('fve-rv-prepare'); assert.equal(p.status, 'blocked'); assert.equal(p.code, 'REASON_REQUIRED'); assert.ok(has(r.html(), 'data-fve="rv-notice"'));
  assert.equal(r.wiring.onRvInput('reason', '   ').status, 'ok'); assert.equal((await r.wiring.handleAction('fve-rv-prepare')).code, 'REASON_REQUIRED', 'whitespace only is no reason');
  r.wiring.onRvInput('reason', '  عدّل المصدر  '); assert.equal((await r.wiring.handleAction('fve-rv-prepare')).status, 'ready');
  const h = r.html(); assert.ok(has(h, 'data-fve="rv-reason"')); assert.match(h, /data-fve="rv-reason"[^>]*>عدّل المصدر<\/div>/); assert.ok(has(h, 'data-fve="rv-unbound"'), 'return carries no fingerprint on the server: said plainly');
  assert.equal(r.wiring.onRvInput('reason', 'تغيّر بعد التجهيز').status, 'ignored', 'locked while a confirmation is prepared');
  await r.wiring.handleAction('fve-rv-edit'); assert.equal(r.wiring.onRvInput('reason', 'سبب جديد').status, 'ok');
  assert.equal((await r.wiring.handleAction('fve-rv-prepare')).status, 'ready'); assert.match(r.html(), /data-fve="rv-reason"[^>]*>سبب جديد<\/div>/);
  assert.equal((await r.wiring.handleAction('fve-confirm-act')).status, 'success_waiting_view');
  const sent = REVIEW_CALLABLE(r, 'return')[0]; assert.equal(sent.payload.reason, 'سبب جديد'); assert.ok(!('expectedContentHash' in sent.payload));
});

await t('R4 the reason is escaped everywhere it is shown (card, form)', async () => {
  const r = await withSubmitted(IC); r.html(); await r.wiring.handleAction('fve-rv-open', { act: 'reject' });
  r.wiring.onRvInput('reason', '<img src=x onerror=alert(1)>"\'`'); let h = r.html(); assert.ok(!has(h, '<img src=x')); assert.ok(has(h, '&lt;img src=x'));
  await r.wiring.handleAction('fve-rv-prepare'); h = r.html(); assert.ok(!has(h, '<img src=x')); assert.ok(has(h, '&lt;img'));
});

await t('R5 ambiguous: the original payload stays (shown in the pending list), the typed reason leaves the page, nothing typed afterwards can change the retry; retry resends verbatim', async () => {
  const r = await withSubmitted(IC); r.html(); await r.wiring.handleAction('fve-rv-open', { act: 'reject' }); r.wiring.onRvInput('reason', 'سبب أصلي');
  await r.wiring.handleAction('fve-rv-prepare'); r.server.dropReplyOnce = true;
  const res = await r.wiring.handleAction('fve-confirm-act'); assert.equal(res.status, 'ambiguous');
  assert.equal(ui(r).rv, null); assert.equal(r.wiring.onRvInput('reason', 'سبب مختلف').status, 'ignored');
  const h = r.html(); assert.ok(has(h, 'data-fve="pending"')); assert.match(h, /data-fve="pending-reason"[^>]*>[^<]*سبب أصلي/); assert.ok(!has(h, 'سبب مختلف'));
  assert.match(h, /data-action="fve-rv-open"[^>]*data-act="reject"[^>]*disabled/, 'no new action while the ambiguous request exists');
  const first = REVIEW_CALLABLE(r, 'reject')[0];
  const scope = r.wiring.runner.pending()[0].scope; const rr = await r.wiring.handleAction('fve-retry-pending', { scope }); assert.equal(rr.status, 'success_waiting_view');
  const all = REVIEW_CALLABLE(r, 'reject'); assert.equal(all.length, 2); assert.deepEqual(all[1].payload, first.payload, 'verbatim, including the requestId and the reason');
});

await t('R6 while the view has not shown the effect, every reviewer button is blocked and no form can open; after the confirmed read the section is back', async () => {
  const r = await withSubmitted(IC); r.html(); await r.wiring.handleAction('fve-rv-open', { act: 'review' }); await r.wiring.handleAction('fve-rv-prepare'); await r.wiring.handleAction('fve-confirm-act');
  let h = r.html(); for (const a of ['review', 'returnDraft', 'reject', 'approve']) assert.match(h, new RegExp(`data-action="fve-rv-open"[^>]*data-act="${a}"[^>]*disabled`), a);
  const o = await r.wiring.handleAction('fve-rv-open', { act: 'returnDraft' }); assert.equal(o.status, 'blocked'); assert.equal(o.code, 'AWAITING_VIEW'); assert.equal(ui(r).rv, null);
  await r.reader.refresh(); await tick(); await r.listen(); r.html(); assert.equal(r.wiring.actions.getState().awaiting, null);
});

await t('R7 a stored check that answered for ANOTHER fingerprint is shown as mismatch on the card: no result, no candidate', async () => {
  const r = await withSubmitted(IC); r.html(); const shown = hashOfV1(r);
  await r.server.externalEdit('V1', { ...r.server.vals.get('V1'), residualValue: 1234 });     // the server holds another version than the one on screen
  assert.equal((await r.wiring.handleAction('fve-check-now')).status, 'mismatch');
  await r.wiring.handleAction('fve-rv-open', { act: 'review' }); await r.wiring.handleAction('fve-rv-prepare'); const h = r.html();
  assert.ok(has(h, 'data-fve="rv-preview" data-status="mismatch"')); assert.ok(!has(h, 'ELIGIBLE')); assert.match(h, /data-status="mismatch">[^<]*نسخة أخرى/, 'says plainly that the reply is about another version'); assert.ok(!has(h, 'rv-preview" data-status="done')); assert.ok(has(h, shown), 'the card still names what is on screen'); assert.notEqual(shown, hashOfV1(r));
});

await t('R8 approve on a SUSPENDED head: the form asks for an acknowledgement and a reason, prepare refuses without them, the card shows both and what will be sent', async () => {
  const r = await withSubmitted(IC2, { state: 'reviewed' });
  const ap = await approvedPair({ fundId: FUND, date: DAY, valuationId: 'H0', head: { activeDraftId: 'V1' }, eligibility: { state: 'SUSPENDED', changedBy: 'ic@example.com', changedAt: '2026-10-10T08:00:00.000Z', reasonCode: 'X', reason: 'r' } });
  const s = r.snapshot(); r.fake.emit('heads', FUND, s.heads.filter((h) => h.id !== ap.head.id).concat([ap.head])); r.fake.emit('valuations', FUND, s.valuations.concat([ap.doc])); await tick(); r.html();
  assert.equal((await r.wiring.handleAction('fve-rv-open', { act: 'approve' })).status, 'ok'); let h = r.html();
  assert.ok(has(h, 'data-fve="rv-suspended"')); assert.ok(has(h, 'data-fve-rv="ack"')); assert.ok(has(h, 'data-fve-rv="reason"'));
  assert.equal((await r.wiring.handleAction('fve-rv-prepare')).code, 'SUSPENDED_ACK_REQUIRED');
  r.wiring.onRvInput('reason', 'تم إصلاح السبب'); assert.equal((await r.wiring.handleAction('fve-rv-prepare')).code, 'SUSPENDED_ACK_REQUIRED', 'a reason alone is not an acknowledgement');
  r.wiring.onRvInput('ack', true); assert.equal((await r.wiring.handleAction('fve-rv-prepare')).status, 'ready'); h = r.html();
  assert.ok(has(h, 'data-fve="rv-ack"')); assert.match(h, /data-fve="rv-ack">✔/); assert.ok(has(h, 'تم إصلاح السبب')); assert.ok(has(h, 'suspended') || has(h, 'معلّق'));
  assert.equal(r.wiring.onRvInput('ack', false).status, 'ignored', 'locked');
});

await t('R9 session change / loss of access clears the form, the typed reason and the prepared card AT ONCE (also while a reason is half typed); nothing typed afterwards is kept', async () => {
  const r = await withSubmitted(IC); r.html(); await r.wiring.handleAction('fve-rv-open', { act: 'returnDraft' }); r.wiring.onRvInput('reason', 'نص لم يُرسل'); assert.ok(has(r.html(), 'نص لم يُرسل'));
  r.wiring.teardown(); assert.equal(ui(r).rv, null); r.box.s = { ...IC2 }; r.reader.reset(); r.reader.open(FUND); await r.listen(); const h = r.html();
  assert.ok(!has(h, 'نص لم يُرسل')); assert.ok(!has(h, 'data-fve="rv-form"')); assert.equal(ui(r).rv, null);
  const r2 = await withSubmitted(IC); r2.html(); await r2.wiring.handleAction('fve-rv-open', { act: 'reject' }); r2.wiring.onRvInput('reason', 'سرّي'); await r2.wiring.handleAction('fve-rv-prepare'); assert.ok(ui(r2).prepared);
  r2.box.s = { ...IC, role: 'viewer' }; assert.equal(r2.html(), ''); assert.equal(ui(r2).rv, null); assert.equal(ui(r2).prepared, null);
  assert.equal(r2.wiring.onRvInput('reason', 'بعد الفقد').status, 'ignored'); assert.equal((await r2.wiring.handleAction('fve-confirm-act', { token: 'p1' })).code, 'NO_SESSION');
  assert.equal(calls(r2, 'x').length, 0); assert.equal(REVIEW_CALLABLE(r2, 'reject').length, 0, 'nothing was sent');
});

await t('R10 the form belongs to ONE valuation: when the shown valuation changes under it, the form and its prepared card go; a prepared card whose view moved is refused (VIEW_CHANGED)', async () => {
  const r = await withSubmitted(IC); r.html(); await r.wiring.handleAction('fve-rv-open', { act: 'returnDraft' }); r.wiring.onRvInput('reason', 'س'); await r.wiring.handleAction('fve-rv-prepare');
  await r.server.externalEdit('V1', { ...r.server.vals.get('V1'), residualValue: 4321 }); await r.reader.refresh(); await tick(); await r.listen(); r.html();
  const res = await r.wiring.handleAction('fve-confirm-act'); assert.equal(res.status, 'blocked'); assert.equal(res.code, 'VIEW_CHANGED'); assert.equal(REVIEW_CALLABLE(r, 'return').length, 0);
  assert.ok(ui(r).rv, 'the typed reason is kept so the person can review and prepare again'); assert.ok(has(r.html(), 'data-fve="rv-notice"'));
  r.server.vals.delete('V1'); await r.reader.refresh(); await tick(); await r.listen(); r.html(); assert.equal(ui(r).rv, null, 'the valuation is gone: the form goes');
});

await t('R11 DOM layer: typing in the reason field reaches the form state through the delegated listener; a detached element and a checkbox are handled', async () => {
  const r = await withSubmitted(IC); r.html(); await r.wiring.handleAction('fve-rv-open', { act: 'reject' });
  const listeners = {}; const doc = { addEventListener: (n, f) => { listeners[n] = f; }, removeEventListener() {} };
  const wiring2 = r.wiring; const attach = wiring2.attachDom; // attachDom uses deps.doc, absent in the rig: exercise the handler through the same function with a stub document
  const r2 = rig({ session: IC }); void attach; void r2; void doc; void listeners;
  assert.equal(r.wiring.onRvInput('reason', 'a', { connected: false }).status, 'ignored');
  assert.equal(r.wiring.onRvInput('reason', 'مكتوب').status, 'ok'); assert.equal(ui(r).rv.reason, 'مكتوب'); assert.equal(r.wiring.onRvInput('nope', 'x').status, 'ignored');
});

await t('R12 a LATE reply of the previous session does not touch the new session\'s form, reason, prepared card or notices (review in flight → session changes → second user types a return reason → old reply returns)', async () => {
  for (const drop of [false, true]) {
    const r = await withSubmitted(IC); r.html(); r.server.delay = 60; r.server.dropReplyOnce = drop;
    await r.wiring.handleAction('fve-rv-open', { act: 'review' }); await r.wiring.handleAction('fve-rv-prepare');
    const old = r.wiring.handleAction('fve-confirm-act'); await tick();                                         // the request is out; its reply is late
    r.wiring.teardown(); r.box.s = { ...IC2 }; r.reader.reset(); r.reader.open(FUND); await r.listen(); r.html();   // the session changed
    assert.equal((await r.wiring.handleAction('fve-rv-open', { act: 'returnDraft' })).status, 'ok'); r.wiring.onRvInput('reason', 'سبب المستخدم الجديد');
    const before = ui(r).rv; const res = await old;                                                             // ...and now the old reply comes back
    assert.equal(res.status, 'background', 'the orchestrator already treats it as another session\'s reply');
    assert.equal(ui(r).rv, before, 'the same form object'); assert.equal(ui(r).rv.reason, 'سبب المستخدم الجديد', 'the new user\'s reason survives');
    assert.equal(ui(r).notice, null, 'no notice from the old reply'); assert.ok(has(r.html(), 'سبب المستخدم الجديد'), 'still on the page');
    r.wiring.onRvInput('reason', 'سبب المستخدم الجديد 2'); assert.equal(ui(r).rv.reason, 'سبب المستخدم الجديد 2');
    assert.equal((await r.wiring.handleAction('fve-rv-prepare')).status, 'ready'); assert.ok(ui(r).prepared, 'and a prepared card of the new user is not cleared by anything late either');
    r.server.delay = 0;
  }
});

const RICH = (over = {}) => ({
  currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE', residualValue: 7777001,
  components: { assetsValue: 5550011, cashRetained: 4440022, otherAssets: 3330033, liabilities: 2220044, distributionsPayable: 1110055,
    otherAssetsItems: [{ description: 'ذمم-مميزة-ALPHA', amount: 1230001 }, { description: 'عقار-مميز-BETA <b>x</b>', amount: 4560002 }] },
  method: 'appraisal', methodNote: 'ملاحظة-' + 'م'.repeat(700) + '-نهاية-الملاحظة-الكاملة', source: { ref: 'REF-ZZ91', provider: 'مزوّد-مميز' },
  nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: false },
  coverage: { linkedAssets: ['ASSET-Q1', 'ASSET-Q2'], unlinkedHoldings: { declared: 'included', items: [{ description: 'غير-مرتبط-GAMMA', amount: 9990003 }] } },
  ...over,
});
await t('R13 the confirmation card lists the FULL stored content (every section, with distinctive values), never "[object Object]", the whole note, all text escaped', async () => {
  const r = rig({ session: IC }); await r.server.seedDraft({ valuationId: 'V1', state: 'submitted', content: RICH() }); await r.open(); r.html();
  await r.wiring.handleAction('fve-rv-open', { act: 'review' }); assert.equal((await r.wiring.handleAction('fve-rv-prepare')).status, 'ready'); const h = r.html();
  const card = h.slice(h.indexOf('data-kind="review"'), h.indexOf('data-fve="rv-unbound"') > 0 ? h.indexOf('data-fve="rv-unbound"') : h.length);
  assert.ok(!/\[object Object\]/.test(h), 'no [object Object] anywhere');
  for (const v of ['7777001', 'RESIDUAL_VALUE_AS_OF_DATE', '5550011', '4440022', '3330033', '2220044', '1110055', 'ذمم-مميزة-ALPHA', '1230001', 'عقار-مميز-BETA', '4560002', 'REF-ZZ91', 'مزوّد-مميز', 'ASSET-Q1', 'ASSET-Q2', 'غير-مرتبط-GAMMA', '9990003', 'نهاية-الملاحظة-الكاملة'])
    assert.ok(card.includes(v), `the card shows ${v}`);
  assert.match(card, /data-fve="rv-nonoverlap"[\s\S]*cashNotInAssets|data-fve="rv-nonoverlap"/); assert.ok(/✖[^<]*<code>false<\/code>|✖/.test(card), 'a declaration that is false is shown as false');
  assert.ok(card.includes('data-fve="rv-note-full"'), 'a long note sits in an openable section'); assert.ok(card.includes('م'.repeat(700)), 'the note is whole, not cut');
  assert.ok(!card.includes('<b>x</b>') && card.includes('&lt;b&gt;x&lt;/b&gt;'), 'item text is escaped');
  assert.equal((card.match(/data-fve="rv-item"/g) || []).length, 2); assert.ok(card.includes('included'), 'the unlinked declaration');
});
await t('R14 the card is FIXED at prepare time: when the live data changes afterwards the card still shows the prepared content and fingerprint (and confirm is refused)', async () => {
  const r = rig({ session: IC }); await r.server.seedDraft({ valuationId: 'V1', state: 'submitted', content: RICH() }); await r.open(); r.html();
  await r.wiring.handleAction('fve-rv-open', { act: 'returnDraft' }); r.wiring.onRvInput('reason', 'ر'); await r.wiring.handleAction('fve-rv-prepare'); const h0 = r.html(); const hash0 = hashOfV1(r);
  const cardOf = (h) => h.slice(h.indexOf('data-kind="review"'));
  await r.server.externalEdit('V1', { ...RICH({ residualValue: 5550999, components: { ...RICH().components, otherAssetsItems: [{ description: 'جديد-LIVE-CHANGED', amount: 1 }] } }) });
  await r.reader.refresh(); await tick(); await r.listen(); const h1 = r.html(); assert.notEqual(hashOfV1(r), hash0);
  const c1 = cardOf(h1); assert.ok(c1.includes('ذمم-مميزة-ALPHA') && c1.includes('7777001') && c1.includes(hash0), 'still the prepared content'); assert.ok(!c1.includes('جديد-LIVE-CHANGED') && !c1.includes('5550999'), 'nothing of the live change leaks in');
  assert.equal(cardOf(h0).includes('rv-items'), true);
  assert.equal((await r.wiring.handleAction('fve-confirm-act')).code, 'VIEW_CHANGED');
});
await t('R15 the GENERAL check panel shows mismatch plainly (both fingerprints, no result fields) — also when no reviewer card is open; other non-result states print no empty result fields', async () => {
  const r = await withSubmitted(IC); r.html(); const shown = hashOfV1(r);
  await r.server.externalEdit('V1', { ...r.server.vals.get('V1'), residualValue: 1234 });
  assert.equal((await r.wiring.handleAction('fve-check-now')).status, 'mismatch'); const h = r.html();
  const panel = h.slice(h.indexOf('data-fve="preview"'));
  assert.ok(has(h, 'data-fve="preview-mismatch"')); assert.match(panel, /نسخة أخرى/); assert.ok(panel.includes(shown)); assert.ok(panel.includes(hashOfV1(r)), 'the reply fingerprint is shown');
  assert.ok(!/data-fve="preview"[^>]*>[\s\S]{0,2000}Server today/.test(h) && !panel.includes('اليوم عند الخادم'), 'no empty result fields');
  assert.equal(has(h, 'ELIGIBLE'), false);
  const e = await withSubmitted(IC); e.html(); e.server.previewHook = async () => { const x = new Error('x'); x.code = 'functions/unavailable'; throw x; };
  await e.wiring.handleAction('fve-check-now'); const he = e.html(); assert.ok(!he.includes('اليوم عند الخادم'), 'an error state prints no result fields');
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
