/* =========================================================================
   مصدر قراءة مستقل لدفتر الصناديق (R1-C3 — إغلاق فجوة تأكيد الدفتر)
   ---------------------------------------------------------------------------
   يقرأ funds وcapitalCalls وdistributions باشتراكات خاصة به (قراءة فقط، includeMetadataChanges:true) ولا يعتمد على
   core.STORE ولا على isIfCollectionServerConfirmed (علم «تأكدت مرة» الذي لا يرجع إلى false) — ولا يغيّر معناه لأي مستهلك.
   التأكيد هنا حالة **راهنة** لكل مجموعة، ومرتبطة بالوثائق المحتجزة نفسها:
     - الوثائق لا تُحتجز إلا من لقطة (fromCache === false && hasPendingWrites === false) بقيمتين منطقيتين صريحتين.
     - لقطة fromCache:true أو hasPendingWrites:true ⇒ تُسقَط الوثائق المحتجزة فورًا (لا «مؤكدة سابقًا») وتُحجب المدخلات.
     - علم غائب/غير منطقي، لقطة غير كائن، docs ليست مصفوفة ⇒ انتهاك عقد: تُسقَط الوثائق وتُحجب المدخلات.
     - خطأ مستمع ⇒ تُسقَط الوثائق ويُحجب (READ_ERROR)، ورفض صلاحية ⇒ PERMISSION_DENIED وإيقاف كل الاشتراكات.
     - العودة إلى الجاهزية لا تتم إلا بلقطة مؤكدة جديدة لكل مجموعة؛ ومصدر التقييمات يُعيد القراءة والتحقق بجيل جديد.
   الجلسة: تغيّر مفتاح الجلسة (أو عدم حسم الدور) يُسقط كل شيء ويعيد البدء. الوقت غير مستعمل هنا.
   ========================================================================= */
import { sessionKey, deepClone } from './fund-valuation-model.js';

export const LEDGER_COLLECTIONS = Object.freeze(['funds', 'capitalCalls', 'distributions']);
const DENIED_CODES = new Set(['permission-denied', 'firestore/permission-denied']);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** subscribe(collection, onNext, onError) -> unsubscribe ; snapshot = { docs:[{id,data}], fromCache, hasPendingWrites } */
export function createLedgerSource({ subscribe, getSession, onChange = () => {} } = {}) {
  if (typeof subscribe !== 'function' || typeof getSession !== 'function') throw new Error('portfolio-ledger-source: subscribe and getSession are required');
  let running = false; let gen = 0; let curKey; let unsubs = []; let queued = false; let denied = false;
  let colls = new Map();   // name -> { docs, state: 'waiting'|'confirmed'|'unconfirmed'|'contract'|'error' }
  const stats = { subscribed: 0, unsubscribed: 0, confirmedSnapshots: 0, dropped: 0 };

  function notify() {
    if (queued) return; queued = true;
    queueMicrotask(() => { queued = false; try { onChange(); } catch (e) { /* ignore */ } });
  }
  function teardown() {
    const u = unsubs; unsubs = [];
    for (const f of u) { try { f(); } catch (e) { /* ignore */ } }
    colls = new Map(); denied = false;
  }
  function drop(c) { if (c.docs.length) stats.dropped += 1; c.docs = []; }

  function sync() {
    if (!running) return;
    let sess; try { sess = getSession(); } catch (e) { sess = null; }
    const key = sess && sess.roleResolved === true ? sessionKey(sess) : null;
    if (key === curKey) return;
    gen += 1; teardown(); curKey = key;
    if (key !== null) startReads(gen);
    notify();
  }

  function startReads(myGen) {
    for (const name of LEDGER_COLLECTIONS) {
      colls.set(name, { docs: [], state: 'waiting' });
      const live = () => myGen === gen && !denied;
      try {
        const u = subscribe(name, (snap) => { if (live()) onSnapshot(name, snap); }, (err) => { if (live()) onFail(name, err); });
        stats.subscribed += 1; let done = false;
        unsubs.push(() => { if (done) return; done = true; stats.unsubscribed += 1; if (typeof u === 'function') u(); });
      } catch (e) { onFail(name, e); }
    }
  }

  function onSnapshot(name, snap) {
    const c = colls.get(name); if (!c) return;
    const valid = isPlain(snap) && typeof snap.fromCache === 'boolean' && typeof snap.hasPendingWrites === 'boolean' && Array.isArray(snap.docs);
    if (!valid) { drop(c); c.state = 'contract'; }
    else if (snap.fromCache === true || snap.hasPendingWrites === true) { drop(c); c.state = 'unconfirmed'; }
    else {
      c.docs = snap.docs.filter((x) => x && x.id != null).map((x) => ({ id: String(x.id), data: deepClone(x.data || {}) }));
      c.state = 'confirmed'; stats.confirmedSnapshots += 1;
    }
    notify();
  }

  function onFail(name, err) {
    const code = err && typeof err.code === 'string' ? err.code : null;
    if (code && DENIED_CODES.has(code)) {
      const u = unsubs; unsubs = []; for (const f of u) { try { f(); } catch (e) { /* ignore */ } }
      for (const c of colls.values()) drop(c);
      denied = true; notify(); return;
    }
    const c = colls.get(name) || { docs: [], state: 'error' }; colls.set(name, c);
    drop(c); c.state = 'error'; notify();
  }

  /** The CURRENT ledger or the reason there is none. Never a remembered confirmation. */
  function getLedger() {
    if (!running) return { ok: false, reason: 'LEDGER_STOPPED' };
    sync();
    if (curKey === null || curKey === undefined) return { ok: false, reason: 'NO_READ_ACCESS' };
    if (denied) return { ok: false, reason: 'PERMISSION_DENIED' };
    const states = LEDGER_COLLECTIONS.map((n) => [n, colls.get(n)]);
    const bad = (st) => states.find(([, c]) => !c || c.state === st);
    let b;
    if ((b = states.find(([, c]) => c && c.state === 'error'))) return { ok: false, reason: `READ_ERROR:ledger:${b[0]}` };
    if ((b = bad('contract')) && b[1]) return { ok: false, reason: `INPUTS_LEDGER_CONFIRMATION_UNAVAILABLE:${b[0]}` };
    if ((b = states.find(([, c]) => !c || c.state !== 'confirmed'))) return { ok: false, reason: `INPUTS_LEDGER_NOT_SERVER_CONFIRMED:${b[0]}` };
    return { ok: true, funds: colls.get('funds').docs, capitalCalls: colls.get('capitalCalls').docs, distributions: colls.get('distributions').docs };
  }

  function start() { if (running) { sync(); return; } running = true; curKey = undefined; sync(); }
  function stop() { running = false; gen += 1; teardown(); curKey = undefined; notify(); }
  function recover() { if (!running) return false; gen += 1; teardown(); curKey = undefined; sync(); return true; }

  return { start, stop, recover, sync, getLedger,
    stats: () => ({ ...stats, live: stats.subscribed - stats.unsubscribed, running, heldDocs: [...colls.values()].reduce((n, c) => n + c.docs.length, 0) }) };
}

/** Real Firestore: whole-collection listeners (same shape core uses), flags passed through raw. A missing DB throws on use => the source reports READ_ERROR (blocked). */
export function makeLedgerSubscribe(core) {
  return (name, onNext, onError) => {
    if (!LEDGER_COLLECTIONS.includes(name)) throw new Error(`ledger subscribe: unknown collection ${name}`);
    if (!core || !core.DB) throw new Error('ledger subscribe: no database');
    return core.DB.collection(name).onSnapshot({ includeMetadataChanges: true }, (snap) => {
      const md = snap && snap.metadata;
      onNext({ docs: snap && Array.isArray(snap.docs) ? snap.docs.map((d) => ({ id: d.id, data: d.data() })) : undefined,
        fromCache: md ? md.fromCache : undefined, hasPendingWrites: md ? md.hasPendingWrites : undefined });
    }, onError);
  };
}
