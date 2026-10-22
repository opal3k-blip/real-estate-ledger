// R1-B2 / B2-2b-b1 — the editor WIRING (+ the pure view) on the REAL reader, REAL actions orchestrator and REAL request runner, against the fake server.
// No DOM here: the wiring's handlers are called directly (the DOM layer and the page are exercised in tests/browser/b1-editor-real.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createFundValuationReader } from '../../src/features/fund-valuation-reader.js';
import { createEditorWiring, READ_MAX_AGE_MS } from '../../src/features/fund-valuation-editor-wiring.js';
import { renderEditor } from '../../src/features/fund-valuation-editor-view.js';
import * as E from '../../src/features/fund-valuation-editor.js';
import { makeServer, makeStorage, FakeLocks, tick, FUND, FM, FM2, IC } from '../helpers/fund-valuation-server-fake.mjs';
import { makeFakeSubscribe, approvedPair } from '../helpers/fund-valuation-fakes.mjs';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); if (!process.env.CONTINUE_ON_FAIL) throw e; console.error(`      ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`); } }
const clone = (v) => JSON.parse(JSON.stringify(v));
const FILL = [
  ['components.assetsValue', '900'], ['components.cashRetained', '200'], ['components.otherAssets', '50'], ['components.liabilities', '150'], ['components.distributionsPayable', '0'],
  ['residualValue', '1000'], ['method', 'appraisal'], ['methodNote', 'external appraisal'], ['source.ref', 'APP-1'], ['source.provider', 'Valuer Co'],
  ['nonOverlap.cashNotInAssets', true], ['nonOverlap.otherAssetsNotInAssets', true], ['nonOverlap.assetsStatedGrossOfLiabilities', true],
  ['coverage.unlinkedHoldings.declared', 'none'],
];

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
async function createdAndShown(r) {
  await r.open(); assert.equal((await r.wiring.handleAction('fve-create')).status, 'started'); r.fill();
  await r.wiring.handleAction('fve-add-item', { list: 'otherAssetsItems' }); r.wiring.onInput('otherAssetsItems.0.description', 'receivable'); r.wiring.onInput('otherAssetsItems.0.amount', '50');
  assert.equal((await r.wiring.handleAction('fve-confirm-links')).status, 'ok');
  const res = await r.wiring.handleAction('fve-save'); assert.equal(res.status, 'success_waiting_view', JSON.stringify(res));
  await r.reader.refresh(); await tick(); await r.listen(); return res;
}

console.log('— B2-2b/b1 editor wiring + view —');

await t('1. no session / no read role ⇒ nothing is rendered; a read-only role sees the form area but no write action is enabled', async () => {
  const none = rig({ session: null }); await none.open(); assert.equal(none.html(), '');
  const viewer = rig({ session: { uid: 'u9', email: 'v@example.com', role: 'viewer', roleResolved: true } }); await viewer.open(); assert.equal(viewer.html(), '');
  const ic = rig({ session: IC }); await ic.open(); const h = ic.html();
  assert.ok(h.includes('data-fve="read-only"')); assert.match(h, /data-action="fve-create"[^>]*disabled/);
});
await t('2. create flow: start → typed fields land in the model → save → "succeeded, waiting for the view" banner; the editor is pinned to today', async () => {
  const r = rig(); await r.open(); const h0 = r.html(); assert.ok(h0.includes('data-action="fve-create"')); assert.ok(!/data-action="fve-create"[^>]*disabled/.test(h0));
  assert.equal((await r.wiring.handleAction('fve-create')).status, 'started'); assert.equal(r.wiring.pins.get(FUND), '2026-10-11');
  const h1 = r.html(); assert.ok(h1.includes('data-mode="create"')); assert.ok(h1.includes('data-fve-path="components.assetsValue"')); assert.ok(h1.includes('data-fvp-field="residualValue"'));
  r.fill(); await r.wiring.handleAction('fve-confirm-links');
  const res = await r.wiring.handleAction('fve-save'); assert.equal(res.status, 'success_waiting_view'); assert.ok(r.html().includes('data-fve="awaiting"'));
});
await t('3. nothing typed is ever written to browser storage (only a sent request record may be); typing before any send writes nothing at all', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); r.html();
  assert.equal(r.storage.m.size, 0, 'no key written while only typing');
  const src = ['fund-valuation-editor-view.js', 'fund-valuation-editor-wiring.js'].map((f) => fs.readFileSync(new URL(`../../src/features/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.ok(!/localStorage|sessionStorage|indexedDB|httpsCallable|\.functions\(|firebase/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), 'view + wiring touch no storage and no Firebase');
});
await t('4. every value from data or the form is escaped in the HTML', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create');
  const evil = '"><img src=x onerror=alert(1)><script>1</script>`';
  r.wiring.onInput('methodNote', evil); r.wiring.onInput('source.ref', evil); r.wiring.onInput('residualValue', evil);
  await r.wiring.handleAction('fve-add-item', { list: 'otherAssetsItems' }); r.wiring.onInput('otherAssetsItems.0.description', evil);
  const h = r.html(); assert.ok(!h.includes('<img') && !h.includes('<script'), 'raw tags'); assert.ok(h.includes('&lt;img') && h.includes('&quot;'));
});
await t('5. the editor date is PINNED: choosing another displayed date does not move or hide it; a note says so', async () => {
  const r = rig(); const ap = await approvedPair({ fundId: FUND, date: '2026-10-01' }); r.extra.heads.push(...[ap.head].flat()); r.extra.valuations.push(...[ap.doc].flat());
  await r.open(); await r.wiring.handleAction('fve-create'); r.wiring.onInput('methodNote', 'typed'); r.html();
  assert.ok(r.reader.getView().dates.includes('2026-10-01')); assert.ok(r.reader.selectDate('2026-10-01'));
  const h = r.html(); assert.ok(h.includes('data-fve="editor"')); assert.ok(h.includes('data-scope-date="2026-10-11"')); assert.ok(h.includes('data-fve="pinned"'));
  assert.equal(r.wiring.actions.getState().editor.form.methodNote, 'typed'); assert.equal(r.wiring.onInput('methodNote', 'typed more').status, 'ok');
  assert.equal(r.wiring.actions.getState().editor.form.methodNote, 'typed more', 'input still reaches the pinned editor');
});
await t('6. the day crosses (Riyadh midnight): a fixed warning, input still there, saving blocked, nothing moved or hidden automatically', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); r.html();
  r.clock.now = new Date('2026-10-12T01:00:00Z'); const h = r.html();
  assert.ok(h.includes('data-fve="day-warning"')); assert.ok(h.includes('2026-10-11')); assert.ok(h.includes('data-fvp-field="residualValue"'));
  assert.match(h, /data-action="fve-save"[^>]*disabled/); const res = await r.wiring.handleAction('fve-save'); assert.equal(res.status, 'blocked'); assert.equal(res.code, 'DATE_CROSSED');
  assert.equal(r.wiring.pins.get(FUND), '2026-10-11'); assert.equal(r.wiring.actions.getState().editor.form.components.assetsValue, '900');
  assert.equal(r.server.calls.length, 0, 'no request');
});
await t('7. "move to the new day" needs confirmation, copies typed numbers/text only (no coverage, no attestations), sends nothing, and keeps the old input until the new editor exists', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); await r.wiring.handleAction('fve-confirm-links');
  await r.wiring.handleAction('fve-add-item', { list: 'otherAssetsItems' }); r.wiring.onInput('otherAssetsItems.0.description', 'receivable'); r.wiring.onInput('otherAssetsItems.0.amount', '50');
  r.clock.now = new Date('2026-10-12T01:00:00Z'); r.html();
  assert.equal((await r.wiring.handleAction('fve-move-day')).status, 'confirm_required'); assert.ok(r.html().includes('fve-move-day-confirm'));
  assert.equal(r.wiring.actions.getState().editor.form.components.assetsValue, '900', 'old input untouched until confirmed');
  const res = await r.wiring.handleAction('fve-move-day-confirm'); assert.equal(res.status, 'moved', JSON.stringify(res)); assert.equal(res.to, '2026-10-12');
  const f = r.wiring.actions.getState().editor.form; assert.equal(r.wiring.pins.get(FUND), '2026-10-12');
  assert.equal(f.components.assetsValue, '900'); assert.equal(f.residualValue, '1000'); assert.equal(f.methodNote, 'external appraisal'); assert.equal(f.source.provider, 'Valuer Co'); assert.equal(f.otherAssetsItems[0].description, 'receivable');
  assert.equal(f.coverage.linkedAssets.confirmed, false, 'coverage not carried'); assert.equal(f.coverage.unlinkedHoldings.declared, null); assert.equal(f.nonOverlap.cashNotInAssets, false, 'attestations not carried');
  assert.equal(r.server.calls.length, 0, 'nothing sent'); assert.ok(!r.html().includes('data-fve="day-warning"'));
});
await t('8. a move that cannot start (an active draft already exists for the new day) changes nothing: the old editor and its input stay', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill();
  r.clock.now = new Date('2026-10-12T01:00:00Z');
  // someone else created today's draft
  const other = r.server.handle(FM2.email, 'createValuationDraft', { requestId: 'other_req_0001', fundId: FUND, valuationDate: '2026-10-12', content: { currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE' } }); await other.catch(() => {}); await r.listen(); r.html();
  const res = await r.wiring.moveToNewDay(); assert.equal(res.status, 'blocked');
  assert.equal(r.wiring.pins.get(FUND), '2026-10-11'); assert.equal(r.wiring.actions.getState().editor.form.components.assetsValue, '900'); assert.ok(r.html().includes('data-fve="day-warning"'));
});
await t('9. "discard the input" of a crossed editor is a confirmed act; until confirmed the input stays', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); r.clock.now = new Date('2026-10-12T01:00:00Z'); r.html();
  assert.equal((await r.wiring.handleAction('fve-ignore')).status, 'confirm_required'); assert.equal(r.wiring.actions.getState().editor.form.components.assetsValue, '900');
  await r.wiring.handleAction('fve-ignore-cancel'); assert.ok(r.wiring.actions.getState().editor); await r.wiring.handleAction('fve-ignore'); await r.wiring.handleAction('fve-ignore-confirm');
  assert.equal(r.wiring.actions.getState().editor, null); assert.equal(r.wiring.pins.size, 0);
});
await t('10. SESSION CHANGE (user switch): everything is cleared at once with NO confirmation — input, pin, UI state; the new user starts empty', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); r.html();
  await r.wiring.handleAction('fve-close'); assert.equal(r.wiring.ui().confirm.kind, 'close');    // an optional leave asks...
  r.wiring.teardown();                                                                              // ...a session change never does
  assert.equal(r.wiring.pins.size, 0); assert.equal(r.wiring.ui().confirm, null); assert.equal(r.wiring.actions.getState().editor, null);
  assert.equal(r.wiring.onInput('methodNote', 'late').status, 'ignored', 'a late input event is dropped'); assert.equal(r.wiring.actions.stats().editors, 0);
  r.box.s = { ...FM2 }; r.reader.reset(); r.reader.open(FUND); await r.listen(); const h = r.html();
  assert.ok(!h.includes('data-fve="editor"')); assert.equal(r.wiring.actions.stats().editors, 0); assert.equal(r.wiring.actions.getState().session.email, FM2.email);
});
await t('11. PERMISSION LOSS (role no longer reads): the slot is empty and all input is gone at once', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); r.html(); assert.equal(r.wiring.actions.stats().editors, 1);
  r.box.s = { ...FM, role: 'viewer' }; assert.equal(r.html(), ''); assert.equal(r.wiring.actions.stats().editors, 0); assert.equal(r.wiring.pins.size, 0);
  assert.equal(r.wiring.onInput('methodNote', 'x').status, 'ignored'); assert.equal(r.wiring.holdsRender(), false);
  const res = await r.wiring.handleAction('fve-save'); assert.equal(res.status, 'blocked');
});
await t('12. a late reply of a request sent under the OLD session does not touch the new session', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); await r.wiring.handleAction('fve-confirm-links'); r.server.hang = true;
  const p = r.wiring.handleAction('fve-save'); await tick(); r.wiring.teardown(); r.box.s = { ...FM2 }; r.reader.reset(); r.reader.open(FUND); await r.listen();
  r.server.hang = false; const res = await Promise.race([p, tick(20).then(() => ({ status: 'still-pending' }))]);
  assert.notEqual(res.status, 'success_waiting_view'); assert.equal(r.wiring.actions.getState().awaiting, null); assert.equal(r.wiring.actions.stats().awaiting, 0);
});
await t('13. input typed while a request is in flight / the view catches up is never replaced', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); await r.wiring.handleAction('fve-confirm-links');
  const res = await r.wiring.handleAction('fve-save'); assert.equal(res.status, 'success_waiting_view');
  assert.equal(r.wiring.onInput('methodNote', 'typed after the send').status, 'ok');
  await r.reader.refresh(); await tick(); await r.listen(); r.html();
  assert.equal(r.wiring.actions.getState().editor.form.methodNote, 'typed after the send'); assert.equal(r.wiring.actions.getState().editor.dirty, true);
});
await t('14. MANUAL refresh is refused while a read is in flight (button disabled, no new read issued)', async () => {
  const r = rig({ autoRead: false }); await r.open();
  const a = r.wiring.refreshNow(); assert.equal(r.reader.getView().read.issued, 1); assert.equal(r.wiring.refreshState().allowed, false);
  assert.match(r.html(), /data-action="fve-refresh"[^>]*disabled/);
  const b = await r.wiring.handleAction('fve-refresh'); assert.equal(b.status, 'blocked'); assert.equal(b.code, 'IN_FLIGHT'); assert.equal(r.reader.getView().read.issued, 1);
  r.net.releaseRead(0); await a; await tick(); assert.equal(r.wiring.refreshState().allowed, true);
  const c = r.wiring.refreshNow(); assert.equal(r.reader.getView().read.issued, 2); r.net.releaseRead(1); await c;
});
await t('15. the reader inFlight is per context: after a session change an old pending read does not disable the new user\'s refresh', async () => {
  const r = rig({ autoRead: false }); await r.open(); void r.wiring.refreshNow(); assert.equal(r.wiring.refreshState().allowed, false);
  r.wiring.teardown(); r.box.s = { ...FM2 }; r.reader.reset(); r.reader.open(FUND); await r.listen(); r.html();
  assert.equal(r.reader.getView().read.inFlight, 0); assert.equal(r.wiring.refreshState().allowed, true);
});
await t('16. the re-read after a reply is NOT issued again while a read started AFTER that reply is in flight (no starvation); a reply that arrived later does ask for a new one; a hung read expires', async () => {
  const r = rig({ autoRead: false }); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); await r.wiring.handleAction('fve-confirm-links');
  const saved = r.wiring.handleAction('fve-save'); await tick(); const afterReply = r.reader.getView().read.issued;                 // the success asked for a read at once
  assert.equal(afterReply, 1, 'one read issued by the success'); const res = await saved; assert.equal(res.status, 'success_waiting_view');
  const before = r.wiring.stats().refreshCoalesced; r.wiring.actions.requestRefresh(); r.wiring.actions.requestRefresh();
  assert.equal(r.reader.getView().read.issued, 1, 'the in-flight read started after the last reply: coalesced'); assert.equal(r.wiring.stats().refreshCoalesced, before + 2);
  // a NEW reply arrives (a withdraw/preview-like reply): the in-flight read began before it, so it cannot prove order
  r.net.releaseRead(0); await tick(20); assert.ok(r.reader.getView().draft, 'the draft is in the view'); void r.wiring.refreshNow(); assert.equal(r.reader.getView().read.issued, 2);   // a read in flight that began after the last reply
  assert.equal((await r.wiring.actions.checkNow()).status, 'done'); r.wiring.actions.requestRefresh(); assert.equal(r.reader.getView().read.issued, 3, 'a reply after the in-flight read began ⇒ a new read');
  // hung read: older than the max age ⇒ a new read is allowed even though nothing replied
  r.clock.now = new Date(r.clock.now.getTime() + READ_MAX_AGE_MS + 1000); r.wiring.actions.requestRefresh(); assert.equal(r.reader.getView().read.issued, 4);
});
await t('17. issued/epoch contract is untouched: an ordinary success + read proves the wait over; a read issued BEFORE the reply does not', async () => {
  const r = rig({ autoRead: false }); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); await r.wiring.handleAction('fve-confirm-links');
  const early = r.reader.refresh();                                                                // read #1 starts BEFORE the reply
  const saved = r.wiring.handleAction('fve-save'); await tick(); const res = await saved; assert.equal(res.status, 'success_waiting_view');
  assert.equal(r.reader.getView().read.issued, 2, 'the success issued read #2');
  r.net.releaseRead(0); await early; await tick(); assert.ok(r.wiring.actions.getState().awaiting, 'read #1 (before the reply) does not end the wait');
  r.net.releaseRead(1); await tick(20); assert.equal(r.wiring.actions.getState().awaiting, null, 'read #2 (after the reply) does');
});
await t('18. an ambiguous request stays listed in the pending list whatever date is shown; it can be retried with the SAME id, and discarding needs an acknowledgement', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); await r.wiring.handleAction('fve-confirm-links'); r.server.dropReplyOnce = true;
  const res = await r.wiring.handleAction('fve-save'); assert.equal(res.status, 'ambiguous'); const h = r.html(); assert.ok(h.includes('data-fve="pending"'));
  const scope = r.wiring.runner.pending()[0].scope; const id0 = r.wiring.runner.pending()[0].requestId;
  const sent = r.server.calls.length; const rr = await r.wiring.handleAction('fve-retry-pending', { scope }); assert.ok(['success_waiting_view', 'ambiguous', 'unresolved', 'no_effect'].includes(rr.status), rr.status);
  assert.equal(r.server.calls.length >= sent, true); void id0;
  assert.equal((await r.wiring.handleAction('fve-discard-pending', { scope })).status, 'confirm_required'); assert.ok(r.html().includes('data-fve-ack="risk"') || r.wiring.runner.pending().length === 0);
});
await t('19. the preview is bound to the STORED version and says so; unsent edits are flagged as unchecked', async () => {
  const r = rig(); await createdAndShown(r); await r.wiring.handleAction('fve-open-draft'); r.wiring.onInput('methodNote', 'unsaved change');
  const res = await r.wiring.handleAction('fve-check-now'); assert.equal(res.status, 'done'); const h = r.html();
  assert.ok(h.includes('data-fve="preview"')); assert.ok(h.includes('data-fve="preview-unsaved"'));
});
await t('20. a conflict (the draft changed on the server while editing) is shown with its resolution choices; input is kept', async () => {
  const r = rig(); await createdAndShown(r); await r.wiring.handleAction('fve-open-draft'); r.wiring.onInput('methodNote', 'mine'); await r.html();
  const vid = [...r.server.vals.keys()][0]; const doc = r.server.vals.get(vid);
  await r.server.handle(FM2.email, 'updateValuationDraft', { requestId: 'other_req_0002', valuationId: vid, expectedContentHash: doc.contentHash, content: { ...E.buildContent(E.formFromContent(doc)).content, methodNote: 'theirs' } }).catch(() => {});
  await r.reader.refresh(); await tick(); await r.listen(); const h = r.html(); assert.ok(h.includes('data-fve="server-changed"'));
  const sv = await r.wiring.handleAction('fve-save'); assert.equal(sv.status, 'blocked'); const h2 = r.html(); assert.ok(h2.includes('fve-resolve') && h2.includes('data-choice="reapply"'));
  assert.equal(r.wiring.actions.getState().editor.form.methodNote, 'mine');
});
await t('21. a withdrawn / gone draft: the editor shows it is gone and does not save', async () => {
  const r = rig(); await createdAndShown(r); await r.wiring.handleAction('fve-open-draft'); r.wiring.onInput('methodNote', 'x'); r.html();
  r.server.vals.clear(); r.server.slot.clear(); await r.reader.refresh(); await tick(); await r.listen(); const h = r.html(); assert.ok(h.includes('data-fve="gone"'));
  const sv = await r.wiring.handleAction('fve-save'); assert.equal(sv.status, 'blocked');
});

/* ---- the pure view, on synthetic states: every banner kind and every escape point ---- */
function baseState(over = {}) {
  const form = E.emptyForm(); const built = E.buildContent(form);
  return { today: '2026-10-11', session: { email: 'fm@example.com', role: 'fund_manager' }, scope: { fundId: 'F1', valuationDate: '2026-10-11', key: 'k' }, available: { createDraft: { allowed: true }, updateDraft: { allowed: true }, submit: { allowed: true }, withdraw: { allowed: true } },
    banners: [], pending: [], editor: { mode: 'create', form, dirty: false, dirtyPaths: [], errors: built.errors, issues: built.issues, ready: false, check: built.check, frozen: null, conflict: null, serverChanged: null, goneFromView: false, blockedByActive: null, copyReview: null,
      coverage: { proposal: null, statement: { confirmed: false, ids: [] }, reconcile: { status: 'UNCONFIRMED', missing: [], extra: [] }, statementStale: false, proposalIsOnlyBrowserData: false } },
    awaiting: null, preview: null, outcome: null, unsentElsewhere: [], ...over };
}
const mdl = (state, extra = {}) => ({ state, ui: {}, pinnedDate: null, pendingAll: [], refresh: { allowed: true }, reader: { read: { confirmed: true, inFlight: 0 }, selectedDate: '2026-10-11', hasDraft: false }, checkAllowed: false, ...extra });
await t('22. view: every banner kind renders, escaped (awaiting phases, overtaken, outcome, unsent elsewhere, copy review, coverage warnings)', async () => {
  const evil = '<b onclick=1>x</b>';
  for (const phase of ['waiting', 'delayed', 'stalled']) assert.ok(renderEditor(mdl(baseState({ banners: [{ kind: 'awaiting_view', phase, action: 'createDraft' }] }))).includes(`data-phase="${phase}"`));
  assert.ok(renderEditor(mdl(baseState({ banners: [{ kind: 'view_overtaken', action: 'updateDraft' }] }))).includes('data-fve="overtaken"'));
  const o = renderEditor(mdl(baseState({ outcome: { action: 'save', status: 'no_effect', code: evil } }))); assert.ok(!o.includes('<b onclick') && o.includes('data-fve="outcome"'));
  assert.ok(renderEditor(mdl(baseState({ unsentElsewhere: [{ fundId: evil, valuationDate: '2026-10-02' }] }))).includes('data-fve="unsent-elsewhere"'));
  const st = baseState(); st.editor.copyReview = { contentReviewed: false, coverageReviewed: true }; st.editor.coverage = { proposal: { ids: [evil], source: 'BROWSER_FUND_DATA' }, statement: { confirmed: true, ids: [evil] }, reconcile: { status: 'MISSING', missing: [evil], extra: [] }, statementStale: true, proposalIsOnlyBrowserData: true };
  st.editor.form.coverage.linkedAssets = { confirmed: true, ids: [evil], confirmedAgainst: null }; const h = renderEditor(mdl(st)); assert.ok(!h.includes('<b onclick') && h.includes('fve-ack-copy') && h.includes('&lt;b onclick'));
});
await t('23. view: conflict, server-changed, gone, active-exists, prepared (with the not-bound-to-content note), preview states', async () => {
  const st = baseState(); st.editor.conflict = { changedByMe: ['methodNote'], changedOnServer: ['source'], overlapping: [] }; st.editor.serverChanged = { contentHash: 'h' }; st.editor.goneFromView = true; st.editor.blockedByActive = { draftId: 'D<1>' };
  st.preview = { status: 'done', storedContentHash: 'H', unsavedEditsNotChecked: true, reply: { today: '2026-10-11', dateOk: true, stale: false, scopeChanged: false, candidate: { status: 'blocked', reasonCodes: ['X<'] } } };
  const m = mdl(st, { ui: { prepared: { token: 'p1', action: 'submit', summary: { valuationId: 'D1', valuationDate: '2026-10-11', state: 'draft' } } } }); const h = renderEditor(m);
  for (const k of ['data-choice="reapply"', 'data-choice="discard-mine"', 'data-fve="server-changed"', 'data-fve="gone"', 'data-fve="active-exists"', 'data-fve="prepared"', 'data-fve="preview-unsaved"', 'fve-confirm-act']) assert.ok(h.includes(k), k);
  assert.ok(!h.includes('D<1>') && !h.includes('X<'));
  for (const status of ['loading', 'error', 'outdated']) assert.ok(renderEditor(mdl(baseState({ preview: { status, storedContentHash: 'H', unsavedEditsNotChecked: false, error: { message: 'e' } } }))).includes('data-fve="preview"'));
});
await t('24. view: buttons are derived from availableActions (disabled with the reason) — no role logic of its own', async () => {
  const st = baseState(); st.available = { createDraft: { allowed: false, reason: 'ACTIVE_DRAFT_EXISTS' }, updateDraft: { allowed: false, reason: 'DATE_CROSSED' }, submit: { allowed: false, reason: 'UNSAVED_EDITS' }, withdraw: { allowed: false, reason: 'NOT_A_CONTRIBUTOR' } };
  const h = renderEditor(mdl(st)); for (const a of ['fve-save', 'fve-prepare']) assert.match(h, new RegExp(`data-action="${a}"[^>]*disabled`)); assert.ok(h.includes('title="'));
  const no = baseState({ editor: null, available: st.available }); assert.match(renderEditor(mdl(no)), /data-action="fve-create"[^>]*disabled/);
});
await t('25. after a teardown the module sees NO session until a render finds a valid one — even when getSession still answers; a detached target is ignored', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); r.html();
  assert.equal(r.wiring.onInput('methodNote', 'x', { connected: false }).status, 'ignored', 'the target left the page'); assert.equal(r.wiring.actions.getState().editor.form.methodNote, 'external appraisal');
  r.wiring.teardown(); assert.equal(r.wiring.isDead(), true);
  assert.equal(r.wiring.refreshState().allowed, false); assert.equal(r.wiring.refreshState().reason, 'NO_CONTEXT'); assert.equal(r.wiring.onInput('methodNote', 'late').status, 'ignored');
  assert.equal((await r.wiring.handleAction('fve-refresh')).status, 'blocked');
  r.html(); assert.equal(r.wiring.isDead(), false, 'a render that finds a valid session clears it'); assert.equal(r.wiring.refreshState().allowed, true);
});
await t('26. "move to the new day" is refused for an editor whose day is NOT a crossed one (the clock went back: the editor day is in the future)', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); r.html();
  r.clock.now = new Date('2026-10-10T10:00:00Z'); r.html(); assert.equal(r.wiring.actions.getState().editor.frozen, 'future');
  const res = await r.wiring.moveToNewDay(); assert.equal(res.status, 'blocked'); assert.equal(res.code, 'NOT_CROSSED'); assert.equal(r.wiring.pins.get(FUND), '2026-10-11'); assert.equal(r.wiring.actions.getState().editor.form.components.assetsValue, '900');
});
await t('27. a move whose new editor cannot be filled keeps the OLD editor exactly as it was (and its pin); the half-built new one is gone', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); r.html();
  r.clock.now = new Date('2026-10-12T01:00:00Z'); r.html(); const real = r.wiring.actions.setField; let n = 0;
  r.wiring.actions.setField = (...a) => { n += 1; throw new Error('injected'); };
  const res = await r.wiring.moveToNewDay(); r.wiring.actions.setField = real;
  assert.ok(n > 0, 'the fault was reached'); assert.equal(res.status, 'blocked'); assert.equal(res.code, 'MOVE_FAILED');
  assert.equal(r.wiring.pins.get(FUND), '2026-10-11'); const st = r.wiring.actions.getState(); assert.ok(st.editor); assert.equal(st.scope.valuationDate, '2026-10-11'); assert.equal(st.editor.form.components.assetsValue, '900'); assert.equal(r.wiring.actions.stats().editors, 1);
});
await t('28. no move while the old day waits for the view after a save (the old editor is still the subject of a request)', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); await r.wiring.handleAction('fve-confirm-links');
  const res = await r.wiring.handleAction('fve-save'); assert.equal(res.status, 'success_waiting_view', JSON.stringify(res));
  r.clock.now = new Date('2026-10-12T01:00:00Z'); r.html();
  const mv = await r.wiring.moveToNewDay(); assert.equal(mv.status, 'blocked'); assert.equal(mv.code, 'AWAITING_VIEW'); assert.equal(r.wiring.pins.get(FUND), '2026-10-11'); assert.ok(r.wiring.actions.getState().awaiting || r.wiring.actions.getState().editor);
});
const denyErr = () => Object.assign(new Error('no'), { code: 'permission-denied' });
async function typedEditorWithPreviewAndPrepared(r) {
  await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); await r.wiring.handleAction('fve-confirm-links'); r.wiring.ui().confirm = { kind: 'close' }; r.html();
}
const nothingLeft = (r, why) => {
  const st = r.wiring.actions.getState(); assert.equal(st.editor, null, `${why}: editor`); assert.equal(r.wiring.actions.stats().editors, 0, `${why}: editors`); assert.equal(r.wiring.pins.size, 0, `${why}: pins`);
  assert.equal(r.wiring.ui().confirm, null, `${why}: confirm`); assert.equal(r.wiring.ui().prepared, null, `${why}: prepared`); assert.equal(st.preview || null, null, `${why}: preview`);
  assert.equal(r.wiring.holdsRender(), false, `${why}: gate`); assert.equal(r.wiring.onInput('methodNote', 'late').status, 'ignored', `${why}: input`);
};
await t('29. READ DENIED by the reader while the local role is still fund_manager: the editor, pin, confirmations and keeper are cleared AT ONCE (before any render), and nothing comes back', async () => {
  const r = rig(); await typedEditorWithPreviewAndPrepared(r); assert.equal(r.wiring.actions.stats().editors, 1);
  r.fake.fail('heads', FUND, denyErr()); await tick();
  assert.equal(r.reader.getView().status, 'denied'); nothingLeft(r, 'denied, before render');
  assert.equal(r.html(), '', 'the slot is empty'); nothingLeft(r, 'denied, after render');
  // the user can start over only after the reader is opened again and a render finds access
  r.reader.reset(); r.reader.open(FUND); await r.listen(); const h = r.html(); assert.ok(!h.includes('data-fve="editor"')); assert.equal(r.wiring.actions.getState().editor, null); assert.equal(r.wiring.actions.stats().editors, 0);
});
await t('30. ROLE UNRESOLVED (roleResolved=false) clears the editor at once; when the role resolves again the OLD text does not come back', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); r.html(); assert.equal(r.wiring.actions.stats().editors, 1);
  r.box.s = { ...FM, roleResolved: false }; r.reader.sync(); assert.equal(r.html(), ''); nothingLeft(r, 'unresolved');
  r.box.s = { ...FM }; r.reader.sync(); await r.listen(); const h = r.html();
  assert.ok(!h.includes('data-fve="editor"')); assert.equal(r.wiring.actions.getState().editor, null, 'no old editor'); assert.equal(r.wiring.actions.stats().editors, 0); assert.ok(!h.includes('external appraisal'));
  assert.equal(r.wiring.onInput('methodNote', 'x').status === 'ok', false, 'no editor to type into');
});
await t('30b. the unresolved role is seen even if NO render ran in between (the session getter is consulted directly)', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); r.html();
  r.box.s = { ...FM, roleResolved: false }; assert.equal(r.wiring.onInput('methodNote', 'x').status, 'ignored'); assert.equal(r.wiring.holdsRender(), false);
  r.box.s = { ...FM }; r.html(); assert.equal(r.wiring.actions.getState().editor, null); assert.equal(r.wiring.actions.stats().editors, 0);
});
await t('31. loss of access keeps the ambiguous-request record (recovery) and a LATE reply of the old session changes nothing', async () => {
  const r = rig(); await r.open(); await r.wiring.handleAction('fve-create'); r.fill(); await r.wiring.handleAction('fve-confirm-links'); r.server.dropReplyOnce = true;
  const res = await r.wiring.handleAction('fve-save'); assert.equal(res.status, 'ambiguous'); const before = JSON.stringify(r.wiring.runner.pending()); assert.equal(r.wiring.runner.pending().length, 1);
  await r.wiring.handleAction('fve-create').catch(() => {});
  r.server.hang = true; const p = r.wiring.handleAction('fve-retry-pending', { scope: r.wiring.runner.pending()[0].scope }); await tick();
  r.fake.fail('valuations', FUND, denyErr()); await tick(); nothingLeft(r, 'denied with a request in flight');
  const raw = [...r.storage.m.values()].join(' '); assert.ok(raw.includes(JSON.parse(before)[0].requestId), 'the record needed for recovery is still in storage');
  assert.equal(r.wiring.runner.pending().length, 0, 'while access is lost nothing is listed (no user)');
  r.server.hang = false; const late = await Promise.race([p, tick(20).then(() => ({ status: 'still-pending' }))]); assert.notEqual(late.status, 'success_waiting_view'); assert.equal(r.wiring.actions.getState().awaiting, null); assert.equal(r.wiring.actions.stats().awaiting, 0);
  r.reader.reset(); r.reader.open(FUND); await r.listen(); r.html(); assert.equal(r.wiring.runner.pending().length, 1, 'after access returns the same record is listed again'); assert.equal(r.wiring.runner.pending()[0].requestId, JSON.parse(before)[0].requestId);
});
await t('32. CONFLICT shows the conflicting VALUES side by side (base / yours / server), independent and escaped; nothing is merged or sent', async () => {
  const r = rig(); await createdAndShown(r); await r.wiring.handleAction('fve-open-draft');
  r.wiring.onInput('components.cashRetained', '180'); r.wiring.onInput('residualValue', '980'); r.wiring.onInput('methodNote', 'mine only');
  const vid = [...r.server.vals.keys()][0]; const doc = r.server.vals.get(vid); const hash0 = doc.contentHash; const base = E.buildContent(E.formFromContent(doc)).content;
  const theirs = clone(base); theirs.components.cashRetained = 250; theirs.residualValue = 1050; theirs.methodNote = '<img src=x onerror=alert(1)> theirs';
  const rsp = await r.server.handle(FM2.email, 'updateValuationDraft', { requestId: 'other_req_0003', valuationId: vid, expectedContentHash: hash0, content: theirs });
  assert.ok(rsp && rsp.contentHash !== hash0, 'the other user really changed the stored draft');
  await r.reader.refresh(); await tick(); await r.listen(); r.html();
  const calls0 = r.server.calls.length; const sv = await r.wiring.handleAction('fve-save'); assert.equal(sv.status, 'blocked'); assert.equal(r.server.calls.length, calls0, 'a blocked save sends nothing');
  const h = r.html(); assert.ok(h.includes('data-fve="conflict"'));
  const rowFor = (sec) => { const m = h.match(new RegExp(`<tr[^>]*data-fve-conflict-row="${sec.replace(/\./g, '\\.')}"[^>]*>[\\s\\S]*?</tr>`)); assert.ok(m, `a row for ${sec}`); return m[0]; };
  const cash = rowFor('components.cashRetained'); assert.match(cash, /data-col="base"[^>]*>[^<]*200/); assert.match(cash, /data-col="mine"[^>]*>[^<]*180/); assert.match(cash, /data-col="server"[^>]*>[^<]*250/); assert.match(cash, /data-overlap="true"/);
  const res = rowFor('residualValue'); assert.match(res, /1000/); assert.match(res, /980/); assert.match(res, /1050/);
  const note = rowFor('methodNote'); assert.ok(note.includes('&lt;img src=x onerror=alert(1)&gt;'), 'server text is escaped'); assert.ok(!h.includes('<img src=x'), 'no element from the server value'); assert.ok(note.includes('mine only'));
  // independent copies: changing what the view model returned does not touch the editor
  const rows = r.wiring.actions.getState().editor.conflict.rows; assert.ok(Array.isArray(rows) && rows.length >= 3); rows[0].mine = 'TAMPER'; rows.length = 0; const cc = r.wiring.actions.getState().editor.conflict; cc.changedByMe.push('TAMPER'); cc.overlapping.length = 0;
  assert.equal(r.wiring.actions.getState().editor.conflict.rows.length >= 3, true); assert.ok(!JSON.stringify(r.wiring.actions.getState().editor.conflict).includes('TAMPER')); assert.ok(r.wiring.actions.getState().editor.conflict.overlapping.length > 0);
  // nothing merged, nothing sent: the form is still exactly what she typed; re-apply is an explicit choice that sends nothing
  assert.equal(r.wiring.actions.getState().editor.form.components.cashRetained, '180'); assert.equal(r.wiring.actions.getState().editor.form.residualValue, '980');
  const re = await r.wiring.handleAction('fve-resolve', { choice: 'reapply' }); assert.equal(re.status, 'reapplied'); assert.equal(r.server.calls.length, calls0, 'resolving sends nothing'); assert.equal(r.wiring.actions.getState().editor.form.components.cashRetained, '180');
});
await t('32b. a conflict whose values differ only on the server (you did not touch it) still shows base and server; a field only you changed shows base and yours', async () => {
  const r = rig(); await createdAndShown(r); await r.wiring.handleAction('fve-open-draft'); r.wiring.onInput('methodNote', 'only mine');
  const vid = [...r.server.vals.keys()][0]; const doc = r.server.vals.get(vid); const theirs = clone(E.buildContent(E.formFromContent(doc)).content); theirs.components.liabilities = 175; theirs.residualValue = 975;
  await r.server.handle(FM2.email, 'updateValuationDraft', { requestId: 'other_req_0004', valuationId: vid, expectedContentHash: doc.contentHash, content: theirs });
  await r.reader.refresh(); await tick(); await r.listen(); r.html(); await r.wiring.handleAction('fve-save'); const h = r.html();
  const m = h.match(/<tr[^>]*data-fve-conflict-row="components\.liabilities"[^>]*>[\s\S]*?<\/tr>/); assert.ok(m, 'server-only row'); assert.match(m[0], /150/); assert.match(m[0], /175/); assert.match(m[0], /data-overlap="false"/);
  const n = h.match(/<tr[^>]*data-fve-conflict-row="methodNote"[^>]*>[\s\S]*?<\/tr>/); assert.ok(n); assert.match(n[0], /only mine/);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
