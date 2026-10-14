// R1-B2 / B2-2b-b0 — the READ CONTRACT of the reader: reads STARTED (issued) are one number, the read that PRODUCED the data on screen (epoch) is another.
// Logic only: fake listener + controllable fetchOnce; no DOM, no Firebase, no browser.
import assert from 'node:assert/strict';
import { createFundValuationReader } from '../../src/features/fund-valuation-reader.js';
import { makeFakeSubscribe, sessionBox, approvedPair, draftDoc, headOnlyDraft, tick, SESSION_FM } from '../helpers/fund-valuation-fakes.mjs';

let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); if (!process.env.CONTINUE_ON_FAIL) throw e; console.error(`      ${String(e.stack).split('\n').slice(0, 3).join(' | ')}`); } }

/** fetchOnce whose every call waits for the test: `calls` records them, `settle(i, value | Error)` completes one. */
function makeFetch() {
  const calls = [];
  const fetchOnce = (source, fundId) => new Promise((resolve, reject) => { calls.push({ source, fundId, resolve, reject }); });
  const settle = (i, v) => { const c = calls[i]; if (v instanceof Error) c.reject(v); else c.resolve(v); };
  /** the two gets of the k-th refresh (k from 0) */
  const settleRead = (k, { heads = [], valuations = [], fromCache = false } = {}) => { settle(2 * k, { docs: heads, fromCache }); settle(2 * k + 1, { docs: valuations, fromCache }); };
  return { fetchOnce, calls, settle, settleRead };
}
function mk({ session, withFetch = true } = {}) {
  const fake = makeFakeSubscribe(); const box = sessionBox(session || SESSION_FM); const f = makeFetch(); let changes = 0;
  const r = createFundValuationReader({ subscribe: fake.subscribe, getSession: box.get, onChange: () => { changes += 1; }, fetchOnce: withFetch ? f.fetchOnce : undefined });
  return { fake, box, f, r, changes: () => changes };
}
const draftPair = (over = {}) => ({ head: headOnlyDraft({ date: '2026-10-02', activeDraftId: 'D1' }), doc: draftDoc({ valuationId: 'D1', date: '2026-10-02', over }) });
async function open(m, payload) { m.r.open('F1'); m.fake.emitAll('F1', payload || {}); await tick(); }
const read = (m) => m.r.getView().read;
const settled = async (p) => { const v = await p; await tick(); return v; };

console.log('— B2-2b/b0 read contract —');

await t('1. initial: nothing issued, no epoch, not confirmed; listener data (even confirmed) proves nothing about order', async () => {
  const m = mk(); const p = draftPair(); await open(m, { heads: [p.head], valuations: [p.doc] });
  assert.equal(m.r.getView().status, 'ready');
  assert.deepEqual(read(m), { issued: 0, epoch: null, confirmed: false, fundId: 'F1', inFlight: 0, lastResult: null });
});
await t('2. refresh() takes its number NOW and never merges with a read in flight; each read is two gets (heads, valuations)', async () => {
  const m = mk(); await open(m, {});
  const a = m.r.refresh(); assert.equal(read(m).issued, 1); assert.equal(read(m).inFlight, 1);
  const b = m.r.refresh(); assert.equal(read(m).issued, 2); assert.equal(read(m).inFlight, 2);
  assert.deepEqual(m.f.calls.map((c) => c.source), ['heads', 'valuations', 'heads', 'valuations']);
  m.f.settleRead(0); m.f.settleRead(1); const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.issued, 1); assert.equal(rb.issued, 2);
});
await t('3. an applied read gives the docs ITS number; issued does not move when it completes', async () => {
  const m = mk(); await open(m, {}); const p = draftPair();
  const pr = m.r.refresh(); m.f.settleRead(0, { heads: [p.head], valuations: [p.doc] }); const res = await settled(pr);
  assert.equal(res.status, 'applied'); assert.equal(res.issued, 1);
  assert.deepEqual(read(m), { issued: 1, epoch: 1, confirmed: true, fundId: 'F1', inFlight: 0, lastResult: { n: 1, ok: true, reason: null } });
  assert.equal(m.r.getView().draft.doc.valuationId, 'D1');
});
await t('4. a listener snapshot after a read WIPES the epoch (listener data proves no order) but not the issued mark', async () => {
  const m = mk(); await open(m, {}); const p = draftPair();
  const pr = m.r.refresh(); m.f.settleRead(0, { heads: [p.head], valuations: [p.doc] }); await settled(pr);
  assert.equal(read(m).epoch, 1);
  m.fake.emit('valuations', 'F1', [p.doc]); await tick();
  assert.equal(read(m).epoch, null); assert.equal(read(m).confirmed, false); assert.equal(read(m).issued, 1);
  m.fake.emit('heads', 'F1', [p.head]); await tick(); assert.equal(read(m).epoch, null);
});
await t('5. out of order: the older read arrives after the newer one was applied: DROPPED (no regression, epoch stays)', async () => {
  const m = mk(); await open(m, {}); const newer = draftPair({ methodNote: 'newer' }); const older = draftPair({ methodNote: 'older' });
  const a = m.r.refresh(); const b = m.r.refresh();
  m.f.settleRead(1, { heads: [newer.head], valuations: [newer.doc] }); assert.equal((await settled(b)).status, 'applied');
  m.f.settleRead(0, { heads: [older.head], valuations: [older.doc] }); const ra = await settled(a);
  assert.equal(ra.status, 'dropped'); assert.equal(ra.reason, 'SUPERSEDED_BY_NEWER_ISSUE');
  assert.equal(m.r.getView().draft.doc.methodNote, 'newer'); assert.equal(read(m).epoch, 2);
});
await t('6. a read in flight ACROSS a listener snapshot is superseded: dropped, no stamp', async () => {
  const m = mk(); await open(m, {}); const p = draftPair();
  const pr = m.r.refresh(); m.fake.emit('valuations', 'F1', []); await tick();
  m.f.settleRead(0, { heads: [p.head], valuations: [p.doc] }); const res = await settled(pr);
  assert.equal(res.status, 'dropped'); assert.equal(res.reason, 'SUPERSEDED_BY_LISTENER'); assert.equal(read(m).epoch, null); assert.equal(m.r.getView().draft, null);
});
await t('7. a read answered from cache is not a server read: not applied, no stamp', async () => {
  const m = mk(); await open(m, {}); const p = draftPair();
  const pr = m.r.refresh(); m.f.settleRead(0, { heads: [p.head], valuations: [p.doc], fromCache: true }); const res = await settled(pr);
  assert.equal(res.status, 'not_confirmed'); assert.equal(read(m).epoch, null); assert.equal(m.r.getView().draft, null); assert.equal(read(m).lastResult.reason, 'FROM_CACHE');
});
await t('8. offline / transient failure: what is shown stays, gains no stamp, is marked stale (not a valid confirmation); the number was spent', async () => {
  const m = mk(); const p = draftPair(); await open(m, { heads: [p.head], valuations: [p.doc] });
  const pr = m.r.refresh(); m.f.settle(0, Object.assign(new Error('offline'), { code: 'unavailable' })); m.f.settle(1, { docs: [], fromCache: false }); const res = await settled(pr);
  assert.equal(res.status, 'failed'); assert.equal(res.code, 'unavailable');
  assert.equal(m.r.getView().status, 'ready'); assert.equal(m.r.getView().draft.doc.valuationId, 'D1'); assert.equal(m.r.getView().stale, true, 'the refresh could not confirm: shown, but marked stale');
  assert.equal(read(m).issued, 1); assert.equal(read(m).epoch, null); assert.equal(read(m).lastResult.reason, 'READ_FAILED'); assert.equal(read(m).confirmed, false);
});
await t('9. permission-denied on a read is NOT a connection failure: everything on screen is cleared at once and the listeners stop', async () => {
  const m = mk(); const p = draftPair(); await open(m, { heads: [p.head], valuations: [p.doc] });
  assert.equal(m.fake.live().length, 3);
  const pr = m.r.refresh(); m.f.settle(0, { docs: [], fromCache: false }); m.f.settle(1, Object.assign(new Error('no'), { code: 'permission-denied' })); const res = await settled(pr);
  assert.equal(res.status, 'denied'); assert.equal(m.r.getView().status, 'denied'); assert.equal(m.fake.live().length, 0); assert.equal(m.r.stats().heldDocs, 0);
  assert.equal(m.r.contextFor('2026-10-02').status, 'denied'); assert.equal(m.r.contextFor('2026-10-02').draft, null); assert.equal(read(m).confirmed, false);
});
await t('10. fetchOnce that throws synchronously: the number is still spent, nothing crashes, nothing applied', async () => {
  const fake = makeFakeSubscribe(); const box = sessionBox();
  const r = createFundValuationReader({ subscribe: fake.subscribe, getSession: box.get, fetchOnce: () => { throw new Error('boom'); } });
  r.open('F1'); fake.emitAll('F1', {}); await tick();
  const res = await r.refresh(); assert.equal(res.status, 'failed'); assert.equal(r.getView().read.issued, 1); assert.equal(r.getView().read.epoch, null); assert.equal(r.getView().read.inFlight, 0);
});
await t('11. the session changes while a read is in flight: the reply is dropped and nothing of the old session appears', async () => {
  const m = mk(); await open(m, {}); const p = draftPair();
  const pr = m.r.refresh(); m.box.set({ uid: 'u9', email: 'other@example.com' }); m.r.sync();
  m.f.settleRead(0, { heads: [p.head], valuations: [p.doc] }); const res = await settled(pr);
  assert.equal(res.status, 'dropped'); assert.equal(res.reason, 'CONTEXT_CHANGED');
  assert.equal(m.r.getView().draft, null); assert.equal(read(m).epoch, null);
  // logout: reset clears, and an in-flight read arriving afterwards finds nothing to apply to
  const m2 = mk(); await open(m2, {}); const pr2 = m2.r.refresh(); m2.r.reset(); m2.f.settleRead(0, { heads: [p.head], valuations: [p.doc] });
  assert.equal((await settled(pr2)).status, 'dropped'); assert.equal(m2.r.stats().heldDocs, 0);
});
await t('12. heads and valuations are two gets, not an atomic snapshot: a head naming a draft that the valuations lack is NOT applied (inconsistent)', async () => {
  const m = mk(); await open(m, {}); const p = draftPair();
  const pr = m.r.refresh(); m.f.settleRead(0, { heads: [p.head], valuations: [] }); const res = await settled(pr);
  assert.equal(res.status, 'inconsistent'); assert.equal(res.reason, 'HEAD_DRAFT_MISSING');
  assert.equal(read(m).epoch, null); assert.equal(read(m).confirmed, false); assert.equal(m.r.getView().draft, null); assert.equal(read(m).lastResult.reason, 'HEAD_DRAFT_MISSING');
});
await t('12b. an active draft that no head names, a draft in another state/date, an approved head without its document: all inconsistent', async () => {
  const p = draftPair(); const ap = await approvedPair({});
  const cases = [
    [[], [p.doc], 'ACTIVE_DOC_WITHOUT_POINTER'],
    [[p.head], [draftPair({ state: 'rejected' }).doc], 'HEAD_DRAFT_MISSING'],
    [[headOnlyDraft({ date: '2026-10-03', activeDraftId: 'D1' })], [p.doc], 'HEAD_DRAFT_MISSING'],
    [[ap.head], [], 'HEAD_DOC_MISSING'],
  ];
  for (const [heads, valuations, reason] of cases) {
    const m = mk(); await open(m, {}); const pr = m.r.refresh(); m.f.settleRead(0, { heads, valuations }); const res = await settled(pr);
    assert.equal(res.reason, reason, reason); assert.equal(read(m).epoch, null);
  }
  const m = mk(); await open(m, {}); const pr = m.r.refresh(); m.f.settleRead(0, { heads: [p.head, ap.head], valuations: [p.doc, ap.doc] }); assert.equal((await settled(pr)).status, 'applied');
});
await t('13. withdrawn / rejected documents without a head pointer are consistent (an empty slot is a legitimate read)', async () => {
  const m = mk(); await open(m, {}); const gone = draftPair({}); gone.doc.data.state = 'withdrawn';
  const pr = m.r.refresh(); m.f.settleRead(0, { heads: [], valuations: [gone.doc] }); assert.equal((await settled(pr)).status, 'applied');
  assert.equal(read(m).epoch, 1); assert.equal(m.r.contextFor('2026-10-02').draft, null);
});
await t('14. no fetchOnce, no readable role, denied, no open fund: refresh issues NOTHING', async () => {
  const m = mk({ withFetch: false }); await open(m, {}); assert.equal((await m.r.refresh()).status, 'unavailable'); assert.equal(read(m).issued, 0);
  const m2 = mk({ session: { uid: 'u', email: 'a@x.com', role: 'analyst', roleResolved: true } }); m2.r.open('F1'); assert.equal((await m2.r.refresh()).status, 'unavailable'); assert.equal(m2.f.calls.length, 0);
  const m3 = mk(); assert.equal((await m3.r.refresh()).status, 'unavailable'); assert.equal(m3.f.calls.length, 0);
  const m4 = mk(); await open(m4, {}); m4.fake.fail('heads', 'F1', Object.assign(new Error('no'), { code: 'permission-denied' })); await tick();
  assert.equal((await m4.r.refresh()).status, 'unavailable'); assert.equal(m4.f.calls.length, 0);
});
await t('14b. the role loses read permission while a read is possible: after the session is re-read, refresh issues NOTHING and nothing stays on screen', async () => {
  const m = mk(); await open(m, {}); assert.equal(m.r.getView().status !== 'forbidden', true);
  m.box.set({ role: 'analyst' }); m.r.sync(); await tick();
  const before = m.f.calls.length; const res = await m.r.refresh(); assert.equal(res.status, 'unavailable'); assert.equal(m.f.calls.length, before);
  assert.equal(m.r.stats().live, 0); assert.equal(m.r.stats().heldDocs, 0);
});
await t('15. confirmed needs BOTH sources fresh: after a read, a source that falls back to cache makes the marker unconfirmed (epoch kept as information)', async () => {
  const m = mk(); await open(m, {}); const p = draftPair(); const pr = m.r.refresh(); m.f.settleRead(0, { heads: [p.head], valuations: [p.doc] }); await settled(pr);
  assert.equal(read(m).confirmed, true);
  m.fake.emit('heads', 'F1', [], true); await tick(); assert.equal(read(m).confirmed, false); assert.equal(m.r.getView().stale, true);
});
await t('16. numbers are never reused: a session end and a new open continue the count; a read from before the reset cannot be mistaken for a new one', async () => {
  const m = mk(); await open(m, {}); void m.r.refresh(); void m.r.refresh(); assert.equal(read(m).issued, 2);
  m.r.reset(); m.r.open('F1'); m.fake.emitAll('F1', {}); await tick();
  assert.equal(read(m).issued, 2); void m.r.refresh(); assert.equal(read(m).issued, 3);
});
await t('17. contextFor(date): the editor\'s date, not the panel\'s; it does not move the panel and does not change the read marker', async () => {
  const m = mk(); const p1 = draftPair(); const p2 = draftPair(); p2.head = headOnlyDraft({ date: '2026-10-05', activeDraftId: 'D5' }); p2.doc = draftDoc({ valuationId: 'D5', date: '2026-10-05' });
  await open(m, { heads: [p1.head, p2.head], valuations: [p1.doc, p2.doc] });
  const before = m.r.getView(); assert.equal(before.selectedDate, '2026-10-05');
  const c = m.r.contextFor('2026-10-02');
  assert.equal(c.valuationDate, '2026-10-02'); assert.equal(c.fundId, 'F1'); assert.equal(c.draft.id, 'D1'); assert.equal(c.status, 'ready'); assert.equal(c.read.valuationDate, '2026-10-02'); assert.equal(c.read.issued, 0);
  assert.equal(m.r.getView().selectedDate, '2026-10-05'); assert.equal(m.r.contextFor('2026-10-05').draft.id, 'D5');
  assert.equal(m.r.contextFor('2026-10-09').draft, null, 'a date with nothing');
  for (const bad of [null, undefined, '', '2026-13-40', 20261002]) assert.equal(m.r.contextFor(bad), null);
  c.draft.doc.methodNote = 'mutated'; assert.notEqual(m.r.contextFor('2026-10-02').draft.doc.methodNote, 'mutated', 'independent copy');
});
await t('18. contextFor with nothing open / loading: null / loading status, never a confirmed look', async () => {
  const m = mk(); assert.equal(m.r.contextFor('2026-10-02'), null);
  m.r.open('F1'); await tick(); const c = m.r.contextFor('2026-10-02'); assert.equal(c.status, 'loading'); assert.equal(c.draft, null); assert.equal(c.read.confirmed, false);
});
await t('19. the reader still has no write path: refresh only calls fetchOnce for heads and valuations of the open fund', async () => {
  const m = mk(); await open(m, {}); void m.r.refresh(); void m.r.refresh();
  assert.ok(m.f.calls.every((c) => (c.source === 'heads' || c.source === 'valuations') && c.fundId === 'F1'));
});

/* ---- review round 2 (fixes 1-3) ---- */
const denied = () => Object.assign(new Error('no'), { code: 'permission-denied' });
const unavailable = () => Object.assign(new Error('offline'), { code: 'unavailable' });
const gone = (m) => { assert.equal(m.r.getView().status, 'denied'); assert.equal(m.fake.live().length, 0); assert.equal(m.r.stats().heldDocs, 0); assert.equal(m.r.getView().draft, null); assert.equal(read(m).confirmed, false); };
await t('20. permission-denied is never hidden behind another failure: heads fail `unavailable`, THEN valuations are denied', async () => {
  const m = mk(); const p = draftPair(); await open(m, { heads: [p.head], valuations: [p.doc] });
  const pr = m.r.refresh(); m.f.settle(0, unavailable()); m.f.settle(1, denied()); const res = await settled(pr);
  assert.equal(res.status, 'denied'); gone(m);
});
await t('20b. ... and the other order: denied first, then `unavailable`', async () => {
  const m = mk(); const p = draftPair(); await open(m, { heads: [p.head], valuations: [p.doc] });
  const pr = m.r.refresh(); m.f.settle(1, denied()); m.f.settle(0, unavailable()); const res = await settled(pr);
  assert.equal(res.status, 'denied'); gone(m);
});
await t('20c. the denial clears everything AT ONCE, even if the other get never answers', async () => {
  const m = mk(); const p = draftPair(); await open(m, { heads: [p.head], valuations: [p.doc] });
  void m.r.refresh(); m.f.settle(1, denied()); await tick(); gone(m);                       // call 0 is still pending
});
await t('20d. a denial that belongs to an OLD session / generation clears nothing of the new one', async () => {
  const m = mk(); const p = draftPair(); await open(m, { heads: [p.head], valuations: [p.doc] });
  void m.r.refresh(); m.r.reset(); m.r.open('F1'); m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc] }); await tick();
  m.f.settle(0, unavailable()); m.f.settle(1, denied()); await tick();
  assert.equal(m.r.getView().status, 'ready'); assert.equal(m.r.getView().draft.doc.valuationId, 'D1'); assert.equal(m.fake.live().length, 3);
});
await t('21. ONLY the latest ISSUED read may apply: an older read that finishes while a newer one is pending is dropped', async () => {
  const m = mk(); await open(m, {}); const p1 = draftPair({ methodNote: 'one' }); const p2 = draftPair({ methodNote: 'two' });
  const a = m.r.refresh(); const b = m.r.refresh();
  m.f.settleRead(0, { heads: [p1.head], valuations: [p1.doc] }); const ra = await settled(a);
  assert.equal(ra.status, 'dropped'); assert.equal(ra.reason, 'SUPERSEDED_BY_NEWER_ISSUE'); assert.equal(read(m).epoch, null); assert.equal(m.r.getView().draft, null);
  assert.equal(read(m).issued, 2); assert.equal(read(m).confirmed, false);
  m.f.settleRead(1, { heads: [p2.head], valuations: [p2.doc] }); assert.equal((await settled(b)).status, 'applied'); assert.equal(read(m).epoch, 2); assert.equal(m.r.getView().draft.doc.methodNote, 'two');
});
await t('21b. a newer read that FAILS leaves the older (superseded) result dropped too: nothing applies from either', async () => {
  const m = mk(); await open(m, {}); const p1 = draftPair();
  const a = m.r.refresh(); const b = m.r.refresh(); m.f.settle(2, unavailable()); m.f.settle(3, unavailable()); assert.equal((await settled(b)).status, 'failed');
  m.f.settleRead(0, { heads: [p1.head], valuations: [p1.doc] }); assert.equal((await settled(a)).status, 'dropped'); assert.equal(read(m).epoch, null);
});
async function confirmed(m) { const p = draftPair(); const pr = m.r.refresh(); m.f.settleRead(m.f.calls.length / 2 - 1, { heads: [p.head], valuations: [p.doc] }); await settled(pr); assert.equal(read(m).confirmed, true); assert.equal(m.r.getView().stale, false); return p; }
await t('22. after a successful read, a FAILED refresh keeps the data on screen but drops the confirmation (confirmed=false, stale=true)', async () => {
  const m = mk(); await open(m, {}); await confirmed(m);
  const pr = m.r.refresh(); m.f.settle(2, unavailable()); m.f.settle(3, unavailable()); assert.equal((await settled(pr)).status, 'failed');
  assert.equal(m.r.getView().draft.doc.valuationId, 'D1', 'still shown'); assert.equal(m.r.getView().stale, true); assert.equal(read(m).confirmed, false);
  assert.equal(m.r.contextFor('2026-10-02').stale, true); assert.equal(read(m).lastResult.reason, 'READ_FAILED');
});
await t('22b. ... an INCONSISTENT pair after a successful read does the same (the failure is recorded, the old data is no longer a confirmation)', async () => {
  const m = mk(); await open(m, {}); const p = await confirmed(m);
  const pr = m.r.refresh(); m.f.settleRead(1, { heads: [p.head], valuations: [] }); assert.equal((await settled(pr)).status, 'inconsistent');
  assert.equal(m.r.getView().draft.doc.valuationId, 'D1'); assert.equal(m.r.getView().stale, true); assert.equal(read(m).confirmed, false); assert.equal(read(m).lastResult.reason, 'HEAD_DRAFT_MISSING');
});
await t('22c. ... and so does a read answered from cache', async () => {
  const m = mk(); await open(m, {}); const p = await confirmed(m);
  const pr = m.r.refresh(); m.f.settleRead(1, { heads: [p.head], valuations: [p.doc], fromCache: true }); assert.equal((await settled(pr)).status, 'not_confirmed');
  assert.equal(m.r.getView().stale, true); assert.equal(read(m).confirmed, false);
});
await t('22d. the next SUCCESSFUL read restores the confirmation; a server snapshot from the listener does too (it is fresh server data)', async () => {
  const m = mk(); await open(m, {}); const p = await confirmed(m);
  let pr = m.r.refresh(); m.f.settle(2, unavailable()); m.f.settle(3, unavailable()); await settled(pr); assert.equal(read(m).confirmed, false);
  pr = m.r.refresh(); m.f.settleRead(2, { heads: [p.head], valuations: [p.doc] }); await settled(pr); assert.equal(read(m).confirmed, true); assert.equal(m.r.getView().stale, false);
  pr = m.r.refresh(); m.f.settle(6, unavailable()); m.f.settle(7, unavailable()); await settled(pr); assert.equal(m.r.getView().stale, true);
  m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc] }); await tick(); assert.equal(m.r.getView().stale, false);
});
await t('22e. a DROPPED read (superseded by a listener or by a newer read) is not a failure: it does not mark anything stale', async () => {
  const m = mk(); await open(m, {}); const p = await confirmed(m);
  const a = m.r.refresh(); const b = m.r.refresh(); m.f.settleRead(1, { heads: [p.head], valuations: [p.doc] }); await settled(a); assert.equal(m.r.getView().stale, false); assert.equal(read(m).confirmed, true);
  void b;
});

await t('23. the confirmation drops AT ONCE when ONE get of the current read fails, without waiting for the other (second get stays pending)', async () => {
  const m = mk(); await open(m, {}); await confirmed(m);
  const pr = m.r.refresh(); m.f.settle(2, unavailable()); await tick();                    // call 3 is still pending
  assert.equal(read(m).confirmed, false); assert.equal(m.r.getView().stale, true); assert.equal(m.r.getView().draft.doc.valuationId, 'D1', 'data kept for display');
  assert.equal(m.r.contextFor('2026-10-02').stale, true); assert.equal(read(m).inFlight, 1, 'the read is still in flight'); assert.equal(read(m).lastResult.reason, 'READ_FAILED');
  m.f.settle(3, { docs: [], fromCache: false }); const res = await settled(pr);                 // the late answer is handled, changes nothing
  assert.equal(res.status, 'failed'); assert.equal(read(m).confirmed, false); assert.equal(read(m).inFlight, 0);
});
await t('23b. ... in either order (valuations fails first, heads pending)', async () => {
  const m = mk(); await open(m, {}); await confirmed(m);
  void m.r.refresh(); m.f.settle(3, unavailable()); await tick();
  assert.equal(read(m).confirmed, false); assert.equal(m.r.getView().stale, true);
});
await t('23c. a failing get of an OLDER read does not unconfirm while a NEWER read was issued (the newer one decides)', async () => {
  const m = mk(); await open(m, {}); await confirmed(m);
  void m.r.refresh(); void m.r.refresh();                                                       // calls 2,3 (old) and 4,5 (latest)
  m.f.settle(2, unavailable()); await tick();
  assert.equal(read(m).confirmed, true); assert.equal(m.r.getView().stale, false);
});
await t('23d. a failure that belongs to an OLD session touches nothing of the new one', async () => {
  const m = mk(); const p = draftPair(); await open(m, { heads: [p.head], valuations: [p.doc] });
  void m.r.refresh(); m.r.reset(); m.r.open('F1'); m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc] }); await tick();
  const pr2 = m.r.refresh(); m.f.settleRead(1, { heads: [p.head], valuations: [p.doc] }); await settled(pr2); assert.equal(read(m).confirmed, true);
  m.f.settle(0, unavailable()); await tick();
  assert.equal(read(m).confirmed, true); assert.equal(m.r.getView().stale, false); assert.equal(read(m).lastResult.ok, true);
});
await t('23g. a failing get of a read from an OLD session whose number equals the high-water mark still touches nothing of the new session', async () => {
  const m = mk(); const p = draftPair(); await open(m, { heads: [p.head], valuations: [p.doc] });
  void m.r.refresh(); m.r.reset(); m.r.open('F1'); m.fake.emitAll('F1', { heads: [p.head], valuations: [p.doc] }); await tick();   // the new session issued nothing: readSeq is still the old read's number
  assert.equal(m.r.getView().stale, false); m.f.settle(0, unavailable()); await tick();
  assert.equal(m.r.getView().stale, false); assert.equal(m.r.getView().status, 'ready'); assert.equal(read(m).lastResult, null);
});
await t('23e. inFlight is PER CONTEXT: after reset + a new session an old pending read does not count, and its late settle does not change the count', async () => {
  const m = mk(); await open(m, {});
  void m.r.refresh(); assert.equal(read(m).inFlight, 1);
  m.r.reset(); m.r.open('F1'); await tick(); assert.equal(read(m).inFlight, 0, 'new context starts at 0');
  const pr = m.r.refresh(); assert.equal(read(m).inFlight, 1, 'only the new read');
  m.f.settleRead(0); await tick(); assert.equal(read(m).inFlight, 1, 'old read settling does not decrement the new context');
  m.f.settleRead(1); await settled(pr); assert.equal(read(m).inFlight, 0);
});
await t('23f. inFlight is per context also across close() + open() of the same fund (refresh button must not stay disabled)', async () => {
  const m = mk(); await open(m, {});
  void m.r.refresh(); void m.r.refresh(); assert.equal(read(m).inFlight, 2);
  m.r.close(); m.r.open('F1'); await tick(); assert.equal(read(m).inFlight, 0);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
