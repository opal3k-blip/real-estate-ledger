// R1-B2 / B2-4c — MANUAL ACCEPTANCE KIT (page side) for the ELIGIBILITY section (suspend / reinstate the effective head) and its overlap with the reviewer section. Loaded by b2-4c-acceptance-server.mjs after the real index.html
// (real core.js, real panel, reader, actions orchestrator, request runner, focus keeper, render gate). Faked: Firebase (stub), the Firestore listener and explicit server read (in-page),
// the callables (the in-page fake server "خادم مزيّف" of the unit tests; NOT the Firebase emulator, NOT a real server). Adds a checklist overlay, persona switches, seeders, fault injection,
// a server-call LOG (so a retry can be compared with the original request) and an EVENT RECORDER whose JSON she can export and send back. The overlay lives outside #app.
import { documentHashHex } from '/src/domain/validation/document-hash.js';
const CORE_URL = '/src/core.js?v=20261011-b2-1-fund-valuation-panel';
const clone = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = '2026-10-11';

async function waitFor(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (e) { /* keep waiting */ } await sleep(50); } throw new Error('timeout'); }

/** distinctive content: items, basis, coverage, non-overlap, a long Arabic note — so every section of the card can be recognised by eye */
const RICH = () => ({
  currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE', residualValue: 7777001,
  components: { assetsValue: 5550011, cashRetained: 4440022, otherAssets: 3330033, liabilities: 2220044, distributionsPayable: 1110055,
    otherAssetsItems: [{ description: 'ذمم مدينة — بند أول', amount: 1230001 }, { description: 'عقار مُستحوَذ عليه — بند ثانٍ', amount: 4560002 }] },
  method: 'appraisal', methodNote: ('ملاحظة الطريقة: تقييم خارجي معتمد استند إلى مقارنات السوق وتدفقات الإيجار المخصومة. ').repeat(9) + 'نهاية الملاحظة الكاملة.', source: { ref: 'REF-ZZ91', provider: 'مزوّد التقييم المستقل' },
  nonOverlap: { cashNotInAssets: true, otherAssetsNotInAssets: true, assetsStatedGrossOfLiabilities: false },
  coverage: { linkedAssets: ['A1', 'A2'], unlinkedHoldings: { declared: 'included', items: [{ description: 'حصة غير مرتبطة', amount: 9990003 }] } },
});

async function boot() {
  await waitFor(() => typeof window.__authCb === 'function'); await sleep(300);
  const core = await import(CORE_URL); const P = await import('/src/features/fund-valuation-panel.js?real=1'); const S = await import('/tests/helpers/fund-valuation-server-fake.mjs'); const F = await import('/tests/helpers/fund-valuation-fakes.mjs');
  const clock = { now: new Date('2026-10-11T10:00:00Z') }; const srv = S.makeServer({ clock });
  const USERS = { ic: S.IC, ic2: S.IC2, admin: S.ADMIN, fm: S.FM, fm2: S.FM2 };
  const box = { s: { ...USERS.ic } };
  const fake = F.makeFakeSubscribe(); const net = { calls: [], auto: true };
  /* heads: the reader verifies an approved head by its fingerprint, so every head the fake server holds is published with a REAL one */
  const headHashes = new Map();
  async function ensureHashes() {
    for (const [k, h] of srv.heads) {
      if (!h.headId) continue; const d = srv.vals.get(h.headId); if (!d) continue; const key = [k, h.headId, h.version, d.contentHash, d.approvedBy].join('|');
      if (!headHashes.has(key)) headHashes.set(key, await documentHashHex({ valuationId: h.headId, version: h.version, contentHash: d.contentHash, approvedBy: d.approvedBy }));
    }
  }
  const slotParts = (k) => { const m = String(k).match(/^(.*)::(\d{4}-\d{2}-\d{2})$/); return m ? { fundId: m[1], valuationDate: m[2] } : null; };
  const snapshot = () => {
    const heads = new Map(); const valuations = [];
    for (const d of srv.vals.values()) valuations.push({ id: d.valuationId, data: clone(d) });
    for (const [k, h] of srv.heads) {
      const p = slotParts(k); if (!p) continue; const d = srv.vals.get(h.headId); const key = [k, h.headId, h.version, d && d.contentHash, d && d.approvedBy].join('|');
      heads.set(k, { id: `${p.fundId}__${p.valuationDate}`, data: { fundId: p.fundId, valuationDate: p.valuationDate, headId: h.headId, version: h.version, headHash: headHashes.get(key) || null, eligibility: h.eligibility ? { ...h.eligibility, changedAt: '2026-10-10T08:00:00.000Z', reasonCode: h.eligibility.state === 'SUSPENDED' ? 'SUSPENDED' : 'APPROVED', reason: null } : null, activeDraftId: null, rev: 1 } });
    }
    for (const d of srv.vals.values()) {
      if (srv.slotId(d.fundId, d.valuationDate) !== d.valuationId) continue; const k = `${d.fundId}::${d.valuationDate}`; const cur = heads.get(k);
      if (cur) cur.data.activeDraftId = d.valuationId; else heads.set(k, { id: `${d.fundId}__${d.valuationDate}`, data: { fundId: d.fundId, valuationDate: d.valuationDate, headId: null, version: 0, headHash: null, eligibility: null, activeDraftId: d.valuationId, rev: 1 } });
    }
    return { heads: [...heads.values()], valuations };
  };
  const fetchOnce = (source) => new Promise((resolve) => { const c = { source, resolve, at: snapshot(), done: false }; net.calls.push(c); if (net.auto) { c.done = true; resolve({ docs: c.at[source], fromCache: false }); } });
  net.releaseAll = () => { for (const c of net.calls) if (!c.done) { c.done = true; c.resolve({ docs: snapshot()[c.source], fromCache: false }); } };
  const listen = () => { const s = snapshot(); fake.emit('heads', 'F1', s.heads); fake.emit('valuations', 'F1', s.valuations); fake.emit('events', 'F1', []); };
  const storage = S.makeStorage(); const store = storage.m;   // same in-memory storage the unit tests use (it has length/key, which the pending-request store lists by)
  let seq = 0; const log = [];
  /** the server-call log: what the page SENT (callable, requestId, reason, fingerprint) and what came back. "samePayload" compares a call with the earlier call of the same requestId. */
  const call = async (callable, payload, { user }) => {
    const entry = { n: log.length + 1, at: new Date().toISOString().slice(11, 19), user, callable, requestId: payload && payload.requestId || null, valuationId: payload && payload.valuationId || null, reason: payload && payload.reason !== undefined ? payload.reason : null, ack: payload && payload.acknowledgeSuspended === true, expectedContentHash: payload && payload.expectedContentHash || null, payload: clone(payload || {}), outcome: 'pending' };
    const prev = entry.requestId ? log.find((e) => e.requestId === entry.requestId) : null; entry.samePayloadAsFirst = prev ? JSON.stringify(prev.payload) === JSON.stringify(entry.payload) : null;
    log.push(entry);
    try { const r = await srv.handle(user, callable, payload); entry.outcome = 'ok'; await ensureHashes(); return r; }
    catch (e) { entry.outcome = 'error: ' + (e.reason || e.code || e.message); await ensureHashes(); throw e; }
  };
  const reader = P.registerFundValuationPanel(core, {
    subscribe: fake.subscribe, fetchOnce, getSession: () => (box.s ? { ...box.s } : { uid: null, email: null, role: null, roleResolved: false }),
    editorDeps: { call, storage, locks: new S.FakeLocks(), getFundAssetIds: () => ['A1', 'A2'], doc: document, win: window, now: () => clock.now, genId: () => 'req_' + String(++seq).padStart(6, '0') },
  });
  let renders = 0; core.registerRenderEnd(() => { renders += 1; });
  const H = { core, reader, wiring: reader.editor, box, clock, srv, net, fake, listen, store, USERS, snapshot, log, ensureHashes, renderCount: () => renders };
  window.__acc = H;
  window.__authCb({ uid: USERS.ic.uid, email: USERS.ic.email });
  /** after a sign-in change the host app drops the open fund; put the tester back on the same fund page as the new user */
  H.reopen = () => { core.STORE.funds = [{ id: 'F1', data: Object.assign(core.blankFund ? core.blankFund() : {}, { name: 'F One (test fund)', assetIds: ['A1', 'A2'] }) }]; core.setCoreState({ fundsViewOpen: true, fundsSubTab: 'funds', openFundId: 'F1', render: true }); H.listen(); };
  H.reopen();
  return H;
}

/* ---------------------------------- recorder ---------------------------------- */
/* ---------------------------------- recorder ---------------------------------- */
function makeRecorder(H) {
  const ev = []; const t0 = performance.now(); let lastRenders = 0; let cur = null; const counters = { compositions: 0, rendersDuringComposition: 0, interruptingRenders: 0, clearingRenders: 0, abandonedCompositions: 0, cancelledByClear: 0, cancelledByReplace: 0, lateEndsIgnored: 0, longestCompositionMs: 0, inputs: 0, focusLossWhileTyping: 0 };   // rendersDuringComposition = interruptingRenders + clearingRenders, counted AT THE MOMENT each render lands (not when the composition ends)
  const cancelled = [];   // compositions whose node left the page before any compositionend: kept as explicit records, never left in the active slot
  const field = (el) => (el && el.getAttribute ? (el.getAttribute('data-fvp-field') || el.id || el.tagName) : null);
  const add = (type, extra = {}) => { if (ev.length < 6000) ev.push({ t: Math.round(performance.now() - t0), type, field: field(document.activeElement), renders: H.renderCount(), ...extra }); };
  for (const n of ['compositionstart', 'compositionupdate', 'compositionend']) window.addEventListener(n, (e) => {
    if (!e.target.closest || !e.target.closest('#app')) return;
    let own;
    if (n === 'compositionend' && (!cur || e.target !== cur.el)) { counters.lateEndsIgnored += 1; add('compositionend-IGNORED (not the active composition\'s node)', { which: field(e.target) }); return; }   // an end belongs to ITS node: it can never close another composition
    if (n === 'compositionupdate' && cur && e.target !== cur.el) return;
    if (n === 'compositionstart') { if (cur) { counters.abandonedCompositions += 1; add('composition-abandoned', { which: cur.field }); } counters.compositions += 1; cur = { at: performance.now(), el: e.target, field: field(e.target), interrupting: 0, clearing: 0 }; }
    if (n === 'compositionend' && cur) { counters.longestCompositionMs = Math.max(counters.longestCompositionMs, Math.round(performance.now() - cur.at)); own = { interrupting: cur.interrupting, clearing: cur.clearing }; cur = null; }
    add(n, { data: e.data, holds: H.wiring ? H.wiring.holdsRender() : null, rendersInThisComposition: own });
  }, true);
  window.addEventListener('input', (e) => { if (e.target.closest && e.target.closest('#app')) { counters.inputs += 1; add('input', { inputType: e.inputType, composing: e.isComposing, len: (e.target.value || '').length, caret: e.target.selectionStart }); } }, true);
  window.addEventListener('focusout', (e) => { if (e.target.closest && e.target.closest('#app') && e.target.isConnected === false) { counters.focusLossWhileTyping += 1; add('focus-node-removed', { which: field(e.target) }); } }, true);
  document.addEventListener('visibilitychange', () => add('visibility', { v: document.visibilityState }));
  window.addEventListener('blur', () => add('window-blur')); window.addEventListener('focus', () => add('window-focus'));
  // Counted the moment the render lands. A render that happens because the editor is GONE (session cleared: permission/role/user) is a NECESSARY clear; any other render while a composition is open INTERRUPTS allowed input (a failure of the hold).
  H.core.registerRenderEnd(() => {
    const n = H.renderCount(); const fresh = n - lastRenders; lastRenders = n;
    if (!(fresh > 0 && cur)) return;
    const gone = cur;
    const editorGone = !document.querySelector('[data-fve="root"]'); const kind = editorGone ? 'clearing' : 'interrupting';
    counters.rendersDuringComposition += fresh; if (editorGone) { counters.clearingRenders += fresh; cur.clearing += fresh; } else { counters.interruptingRenders += fresh; cur.interrupting += fresh; }
    add(editorGone ? 'RENDER-DURING-COMPOSITION (clearing: editor removed - expected)' : 'RENDER-DURING-COMPOSITION (INTERRUPTING - the hold failed)', { n, kind, compositionNodeStillInPage: !!(cur.el && cur.el.isConnected), compositionField: cur.field });
    // Lifecycle: the node of the open composition is no longer in the page (a removed node never sends compositionend). Keep an explicit CANCELLED record and take it out of the active slot,
    // so the NEW editor's renders are never charged to it; a late end from the old node is caught by its own one-shot listener (a detached node's events do not reach window).
    if (!gone.el.isConnected) {
      const reason = editorGone ? 'editor-cleared' : 'node-replaced'; if (editorGone) counters.cancelledByClear += 1; else counters.cancelledByReplace += 1;
      const rec = { reason, field: gone.field, ageMs: Math.round(performance.now() - gone.at), interruptingRenders: gone.interrupting, clearingRenders: gone.clearing }; if (cancelled.length < 50) cancelled.push(rec);
      add(editorGone ? 'composition-cancelled-by-clear' : 'composition-cancelled-node-replaced', rec);
      const late = () => { counters.lateEndsIgnored += 1; add('compositionend-IGNORED (late end from a cancelled node)', { which: gone.field }); }; try { gone.el.addEventListener('compositionend', late, { once: true }); } catch (e) { /* ignore */ }
      cur = null;
    }
  });
  const open = () => (cur ? { field: cur.field, ageMs: Math.round(performance.now() - cur.at), nodeStillInPage: !!(cur.el && cur.el.isConnected), interruptingRenders: cur.interrupting, clearingRenders: cur.clearing } : null);   // a composition that has not ended (a removed node never sends compositionend)
  return { ev, counters, open, cancelled: () => cancelled.slice(), mark: (type, extra) => add(type, extra) };
}

/* ---------------------------------- overlay ---------------------------------- */
const SCENARIOS = [
  { id: 'E1', title: 'تعليق الأهلية: النموذج ← البطاقة ← التأكيد', steps: 'اضغط «تجهيز: رأس معتمد سارٍ» ثم (كمراجع IC) «تعليق…» واكتب سببًا عربيًا، «جهّز التأكيد»، واقرأ البطاقة، ثم «أكّد».', expect: 'لا إرسال قبل التأكيد (سجل الخادم فارغ). البطاقة تعرض: معرّف الرأس والنسخة، الحالة الآن (سارية) والحالة بعد التنفيذ (معلّقة)، السبب، وعبارة «أهلية فقط — لا تفعيل حساب أو معدّل قبل R1-C»، وحدّ الخادم (expectedHeadId). بعد التأكيد: استدعاء واحد في السجل بالسبب نفسه، ويختفي النموذج، ثم تصير الحالة «معلّقة».' },
  { id: 'E2', title: 'إعادة الأهلية: من علّق لا يعيد، وآخر يعيد', steps: 'اضغط «تجهيز: رأس معلّق بواسطة IC». (أ) كـ IC: انظر زر «إعادة الأهلية…». (ب) بدّل إلى IC2: «إعادة الأهلية…» ← سبب ← جهّز ← أكّد.', expect: '(أ) الزر معطّل وسببه ظاهر نصًّا في الصفحة (من علّق النسخة لا يعيد أهليتها). (ب) البطاقة تعرض من علّق ومتى، وبعد التأكيد تصير الحالة «سارية».' },
  { id: 'E3', title: 'فصل المهام: مساهم النسخة ومعتمدها', steps: 'اضغط «تجهيز: رأس معلّق (IC2 مساهم فيه)». كـ IC2 انظر زر الإعادة، ثم بدّل إلى «مدير النظام».', expect: 'لـ IC2 الزر معطّل بسبب ظاهر (مساهم النسخة أو معتمدها لا يعيد أهليتها). لمدير النظام (ليس مساهمًا ولا من علّق) الزر متاح.' },
  { id: 'E4', title: 'طلب غامض وإعادة المحاولة بالطلب نفسه', steps: 'رأس سارٍ، IC: «تعليق…» ← سبب مميّز ← جهّز. اضغط «إسقاط الرد مرة واحدة» ثم «أكّد». ثم أعد المحاولة من لوحة الطلبات المعلّقة.', expect: 'حالة «طلب غامض» مع بقاء الأزرار معطّلة بسبب ظاهر (طلب معلّق). إعادة المحاولة تُرسل المعرّف والحمولة نفسيهما (عمود «same» = نعم)، والأثر على الخادم مرة واحدة.' },
  { id: 'E5', title: 'تغيّر الرأس أو الأهلية أثناء النموذج والبطاقة', steps: 'رأس سارٍ، IC: «تعليق…» ← سبب ← جهّز. اضغط «مستخدم آخر يعلّق الرأس». ثم كرّر وفي المرة الثانية اضغط «رأس جديد H1 يحلّ محل H0» وهو في مرحلة النموذج وبعد البطاقة.', expect: 'عند تحرّك حالة الرأس تحت بطاقة: تختفي البطاقة وتظهر عبارة تغيّر العرض ويبقى السبب المكتوب، ولا يُرسل شيء. عند تغيّر معرّف الرأس: يختفي النموذج والبطاقة والسبب.' },
  { id: 'E6', title: 'تداخل قسمي الإرجاع والأهلية', steps: 'اضغط «تجهيز: رأس سارٍ + مسودة مُقدَّمة». كـ IC: افتح «إرجاع…» واكتب سببًا، ثم افتح «تعليق…» واكتب سببًا وجهّزه. اكتب في حقل سبب الإرجاع. ثم اضغط «جهّز» الإرجاع. جرّب «عدّل» و«إلغاء» في كل قسم.', expect: 'حقل سبب الإرجاع يبقى ظاهرًا وقابلًا للكتابة (ما تكتبه يظهر ويُحفظ). تجهيز الإرجاع أثناء بطاقة الأهلية يُرفض بعبارة ظاهرة (بطاقة تأكيد معلّقة في قسم آخر) دون فقدان أي سبب. «عدّل/إلغاء» في قسم لا يمس بطاقة القسم الآخر.' },
  { id: 'E7', title: 'الكتابة والـIME في سبب الأهلية تحت عاصفة الرسم', steps: 'رأس سارٍ، IC: «تعليق…». شغّل «عاصفة الرسم». اكتب سببًا عربيًا من عدة أسطر، ثم ابدأ تركيب IME حقيقي (ياباني/صيني أو Win+H) واتركه 5 ثوانٍ ثم ثبّته.', expect: 'لا ضياع نص، ولا قفز للمؤشر أو التمرير، والعدّاد «رسم يقطع تركيباً» = 0.' },
  { id: 'E8', title: 'المسح عند تبديل الجلسة أو فقدان الوصول', steps: 'رأس سارٍ، IC: «تعليق…» واكتب سببًا. (أ) «مراجع IC2». (ب) أعد الكتابة ثم «رفض الخادم للقراءة». (ج) أعد ثم «الدور غير محسوم». (د) افتح النموذج، اضبط «تبديل إلى IC2 بعد المهلة» وابدأ تركيبًا.', expect: 'في كل حالة يختفي القسم والنموذج والسبب فورًا، ولا يعود النص بعد انتهاء الرد المتأخر أو التركيب. نموذج المستخدم الجديد يبدأ فارغًا.' },
  { id: 'E9', title: 'قراءة القسم في Chrome ثم Edge', steps: 'افتح E1 وE2 في Chrome ثم في Edge (تضييق النافذة أيضًا).', expect: 'أسباب التعطيل ظاهرة كنص، البطاقة مقروءة كاملة، لا نص مقصوص ولا تداخل بين القسمين.' },
];

function buildOverlay(H, R) {
  const state = { storm: null, armed: null, delaySec: 10, results: Object.fromEntries(SCENARIOS.map((s) => [s.id, { status: 'pending', note: '' }])), persona: 'ic' };
  const css = document.createElement('style');
  css.textContent = '#acc{position:fixed;inset-block:0;inset-inline-end:0;z-index:99999;width:430px;max-width:92vw;overflow:auto;box-sizing:border-box;background:#fffbe6;color:#222;border:2px solid #b8860b;font:13px/1.5 system-ui,sans-serif;padding:8px;direction:rtl}#acc button{margin:2px;padding:3px 7px;font:12px system-ui;cursor:pointer}#acc .sc{border-top:1px solid #d9c27a;margin-top:6px;padding-top:6px}#acc textarea{width:100%;box-sizing:border-box;height:34px;font:12px system-ui}#acc .ok{color:#0a6b2a;font-weight:700}#acc .no{color:#b00020;font-weight:700}#acc table{border-collapse:collapse;width:100%;font-size:11px;direction:ltr}#acc td,#acc th{border:1px solid #d9c27a;padding:1px 3px;text-align:left;word-break:break-all}#acc .calls{max-height:150px;overflow:auto}';
  css.textContent += ' html.acc-open body{margin-inline-end:440px} html.acc-mini #acc{width:auto;inset-block:auto;inset-block-end:8px;inset-inline-end:8px;border-radius:8px}';
  document.head.appendChild(css); document.documentElement.classList.add('acc-open');
  const box = document.createElement('div'); box.id = 'acc'; box.setAttribute('data-acc', 'root'); document.body.appendChild(box);
  let mini = false;
  const btn = (label, id) => `<button type="button" data-acc="${id}">${label}</button>`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const PERS = [['fm', 'مدير صندوق FM'], ['ic', 'مراجع IC'], ['ic2', 'مراجع IC2'], ['admin', 'مدير النظام']];
  function callsTable() {
    const rows = H.log.slice(-8).map((e) => `<tr><td>${e.n}</td><td>${esc(e.user.split('@')[0])}</td><td>${esc(e.callable)}</td><td>${esc((e.requestId || '').slice(-6))}</td><td>${esc((e.reason || '').toString().slice(0, 26))}</td><td>${e.ack ? 'ack' : ''}</td><td>${esc((e.expectedContentHash || '').slice(0, 6))}</td><td>${e.samePayloadAsFirst === null ? '' : e.samePayloadAsFirst ? 'نعم' : '<b class="no">لا</b>'}</td><td>${esc(e.outcome)}</td></tr>`).join('');
    return `<div class="calls"><table><tr><th>#</th><th>user</th><th>callable</th><th>req</th><th>reason</th><th>ack</th><th>hash</th><th>same</th><th>out</th></tr>${rows}</table></div>`;
  }
  function paint() {
    document.documentElement.classList.toggle('acc-open', !mini); document.documentElement.classList.toggle('acc-mini', mini);
    if (mini) { box.innerHTML = btn('إظهار قائمة القبول', 'toggle-mini'); return; }
    const c = R.counters; const who = H.box.s ? H.box.s.email : '—';
    box.innerHTML = `<b>اختبار قبول B2-4c — بيئة تجريبية (خادم وهمي، لا Firebase)</b> ${btn('إخفاء', 'toggle-mini')}<br>
      <small>المستخدم الحالي: <b>${esc(who)}</b> · تركيبات ${c.compositions} · رسم يقطع تركيباً <b class="${c.interruptingRenders ? 'no' : 'ok'}">${c.interruptingRenders}</b> · رسم مسح ضروري ${c.clearingRenders}${R.open() ? ' · <b class="no">تركيب مفتوح الآن</b>' : ''}</small>
      <div><small>المستخدم:</small> ${PERS.map(([k, l]) => btn(l, 'as:' + k)).join('')}</div>
      <div><small>تجهيز البيانات (أعد تحميل الصفحة بين السيناريوهات):</small><br>${btn('تجهيز: رأس معتمد سارٍ', 'seed:head')} ${btn('تجهيز: رأس معلّق بواسطة IC', 'seed:susp')} ${btn('تجهيز: رأس معلّق (IC2 مساهم فيه)', 'seed:suspC')} ${btn('تجهيز: رأس سارٍ + مسودة مُقدَّمة', 'seed:both')}</div>
      <div>${btn(state.storm ? '■ إيقاف عاصفة الرسم' : '▶ عاصفة الرسم (كل 200ms)', 'storm')} ${btn('رفض الخادم للقراءة', 'deny')} ${btn('الدور غير محسوم', 'unres')} ${btn('الدور محسوم', 'res')}</div>
      <div><small>إجراء مؤجّل (اضبطه <b>قبل</b> بدء التركيب):</small> المهلة <input type="number" min="3" max="60" value="${state.delaySec}" data-acc-delay style="width:50px"> ث ${btn('رفض بعد المهلة', 'arm:deny')} ${btn('تبديل إلى IC2 بعد المهلة', 'arm:switch')} ${btn('إلغاء المؤجّل', 'arm:cancel')} ${state.armed ? `<b class="no">مؤجّل: ${state.armed.action}</b>` : ''}</div>
      <div>${btn('إسقاط الرد مرة واحدة', 'drop')} ${btn('تأخير ردود الخادم (8 ث)', 'delay')} ${btn('مستخدم آخر يعلّق الرأس', 'ext-suspend')} ${btn('رأس جديد H1 يحلّ محل H0', 'ext-newhead')} ${btn('إبطاء قراءات الخادم', 'slow')} ${btn('إتمام القراءات', 'release')} ${btn('إعادة تحميل الصفحة', 'reload')}</div>
      <div><b>سجل استدعاءات الخادم</b> (آخر 8)${callsTable()}</div>
      ${SCENARIOS.map((s) => { const r = state.results[s.id]; return `<div class="sc"><b>${s.id}. ${s.title}</b><br><small>الخطوات: ${s.steps}</small><br><small>المتوقع: ${s.expect}</small><br>
        ${btn('نجح', 'ok:' + s.id)} ${btn('فشل', 'no:' + s.id)} ${btn('تخطّي', 'skip:' + s.id)} <span class="${r.status === 'ok' ? 'ok' : r.status === 'no' ? 'no' : ''}">${{ pending: 'لم يُجرَّب', ok: 'نجح', no: 'فشل', skip: 'تُخطّي' }[r.status]}</span>
        <textarea data-acc-note="${s.id}" placeholder="ملاحظة (اختياري)">${esc(r.note)}</textarea></div>`; }).join('')}
      <div class="sc">${btn('تصدير السجل (ملف JSON)', 'export')} ${btn('نسخ السجل إلى الحافظة', 'copy')} <small id="acc-msg"></small></div>`;
  }
  const msg = (t) => { const m = box.querySelector('#acc-msg'); if (m) m.textContent = t; };
  function envInfo() {
    const nav = navigator; const uad = nav.userAgentData ? { platform: nav.userAgentData.platform, brands: nav.userAgentData.brands } : null;
    return { userAgent: nav.userAgent, platform: nav.platform, uaData: uad, language: nav.language, languages: nav.languages, dpr: window.devicePixelRatio, screen: [screen.width, screen.height], viewport: [innerWidth, innerHeight], touch: nav.maxTouchPoints };
  }
  function exportData() { return { kit: 'b2-4c', exportedAt: new Date().toISOString(), env: envInfo(), results: state.results, counters: R.counters, openComposition: R.open(), cancelledCompositions: R.cancelled(), armed: state.armed ? { action: state.armed.action } : null, serverCalls: H.log, events: R.ev }; }
  const seedBase = async (st) => {
    if (H.srv.vals.has('V1')) { msg('توجد مسودة بالفعل؛ أعد تحميل الصفحة أولاً'); return null; }
    const d = await H.srv.seedDraft({ valuationId: 'V1', valuationDate: DAY, state: st, enteredBy: 'fm@example.com', content: RICH() });
    if (st === 'reviewed') d.review = { reviewedBy: 'ic@example.com', reviewedContentHash: d.contentHash };
    return d;
  };
  const seedHeadDoc = async ({ susp = false, contributors = ['fm@example.com'], headId = 'H0', version = 1 } = {}) => {
    H.srv.seedHead({ valuationDate: DAY, headId, version, suspended: susp ? { by: 'ic@example.com' } : null, rev: 1, changedAt: '2026-10-11T08:00:00.000Z', headDoc: { contributors, approvedBy: 'boss@example.com' } });
    const d = H.srv.vals.get(headId); d.contentHash = 'a'.repeat(64); d.approvedAt = '2026-10-11T07:00:00.000Z'; d.updatedAt = d.approvedAt;
    return d;
  };
  const finishSeed = async (t) => { await H.ensureHashes(); H.listen(); H.reader.sync(); H.core.render(); R.mark('SEED ' + t); msg('تم: ' + t); };
  const actions = {
    'toggle-mini': () => { mini = !mini; },
    storm: () => { if (state.storm) { clearInterval(state.storm); state.storm = null; R.mark('storm-off'); } else { state.storm = setInterval(() => H.core.render(), 200); R.mark('storm-on'); } },
    deny: () => { R.mark('ACTION deny'); H.fake.fail('heads', 'F1', Object.assign(new Error('no'), { code: 'permission-denied' })); },
    unres: () => { R.mark('ACTION role-unresolved'); H.box.s = { ...H.box.s, roleResolved: false }; H.core.render(); },
    res: () => { R.mark('ACTION role-resolved'); H.box.s = { ...H.box.s, roleResolved: true }; H.reader.sync(); H.listen(); H.core.render(); },
    switch: () => { R.mark('ACTION user-switch -> ic2'); H.box.s = { ...H.USERS.ic2 }; window.__authCb({ uid: H.USERS.ic2.uid, email: H.USERS.ic2.email }); setTimeout(() => H.reopen(), 400); },
    drop: () => { H.srv.dropReplyOnce = true; R.mark('ACTION drop-next-reply'); msg('سيُسقَط رد الاستدعاء القادم'); },
    delay: () => { H.srv.delay = H.srv.delay ? 0 : 8000; R.mark('ACTION server-delay ' + H.srv.delay); msg(H.srv.delay ? 'الردود متأخرة 8 ث' : 'التأخير مُلغى'); },
    'ext-suspend': async () => {   // another person suspends the SAME head (the eligibility changes under an open form/card)
      R.mark('ACTION other-user-suspends'); try { await H.srv.handle('ic2@example.com', 'suspendValuationEligibility', { requestId: 'ext-' + Date.now(), fundId: 'F1', valuationDate: DAY, expectedHeadId: 'H0', reason: 'تعليق من مستخدم آخر' }); H.listen(); try { await H.reader.refresh(); } catch (e) { /* the listener alone also moves it */ } msg('علّق IC2 الرأس H0'); } catch (e) { msg('تعذّر: ' + (e.reason || e.message)); }
    },
    'ext-newhead': async () => {   // a NEW effective head replaces H0
      R.mark('ACTION new-head-H1'); await seedHeadDoc({ headId: 'H1', version: 2 }); await H.ensureHashes(); H.listen(); try { await H.reader.refresh(); } catch (e) { /* ignore */ } msg('الرأس الساري الآن H1 (نسخة 2)');
    },
    slow: () => { H.net.auto = false; R.mark('ACTION reads-held'); },
    release: () => { H.net.auto = true; H.net.releaseAll(); R.mark('ACTION reads-released'); },
    arm: (which) => {
      if (state.armed) { clearTimeout(state.armed.timer); R.mark('ARMED-CANCEL ' + state.armed.action); state.armed = null; }
      if (which === 'cancel') return;
      const sec = Math.min(60, Math.max(3, Number(state.delaySec) || 10));
      state.armed = { action: which === 'unres' ? 'deny' : which, timer: setTimeout(() => { R.mark('ARMED-FIRE ' + which, { compositionOpen: R.open() }); state.armed = null; actions[which](); paint(); }, sec * 1000) };
      R.mark('ARMED ' + which, { afterSec: sec });
    },
    reload: () => { location.reload(); },
    export: () => { const blob = new Blob([JSON.stringify(exportData(), null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'b2-4c-acceptance-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; document.body.appendChild(a); a.click(); a.remove(); msg('نُزّل الملف'); },
    copy: async () => { try { await navigator.clipboard.writeText(JSON.stringify(exportData())); msg('نُسخ'); } catch (e) { msg('تعذّر النسخ، استعمل التصدير'); } },
  };
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-acc]'); if (!b) return; const id = b.getAttribute('data-acc');
    const m = id.match(/^(ok|no|skip):(E\d+)$/); if (m) { state.results[m[2]].status = m[1]; R.mark('RESULT ' + m[2] + ' ' + m[1]); paint(); return; }
    const am = id.match(/^arm:(deny|switch|cancel)$/); if (am) { actions.arm(am[1]); paint(); return; }
    const pm = id.match(/^as:(fm|ic|ic2|admin)$/); if (pm) { R.mark('ACTION persona ' + pm[1]); H.box.s = { ...H.USERS[pm[1]] }; window.__authCb({ uid: H.USERS[pm[1]].uid, email: H.USERS[pm[1]].email }); setTimeout(() => H.reopen(), 400); paint(); return; }
    const sm = id.match(/^seed:(head|susp|suspC|both)$/);
    if (sm) { (async () => { const k = sm[1]; if (H.srv.vals.has('V1') || H.srv.vals.has('H0')) return msg('أعد تحميل الصفحة أولاً');
      if (k === 'head') await seedHeadDoc(); else if (k === 'susp') await seedHeadDoc({ susp: true }); else if (k === 'suspC') await seedHeadDoc({ susp: true, contributors: ['fm@example.com', 'ic2@example.com'] }); else { await seedHeadDoc(); await seedBase('submitted'); }
      await finishSeed({ head: 'رأس معتمد سارٍ', susp: 'رأس معلّق بواسطة IC', suspC: 'رأس معلّق (IC2 مساهم)', both: 'رأس سارٍ + مسودة مُقدَّمة' }[k]); paint(); })(); return; }
    if (actions[id]) { Promise.resolve(actions[id]()).then(() => { if (id !== 'export' && id !== 'copy') paint(); }); }
  });
  box.addEventListener('input', (e) => { if (e.target.getAttribute && e.target.hasAttribute('data-acc-delay')) { state.delaySec = Number(e.target.value) || 10; return; } const id = e.target.getAttribute && e.target.getAttribute('data-acc-note'); if (id) state.results[id].note = e.target.value; });
  setInterval(() => { if (!box.matches(':focus-within') || mini) { const a = document.activeElement; if (!(a && a.tagName === 'TEXTAREA' && box.contains(a))) paint(); } }, 1500);
  paint();
  return { state, paint, exportData, actions };
}

try {
  const H = await boot(); await sleep(300);
  const R = makeRecorder(H); const O = buildOverlay(H, R); window.__accKit = { H, R, O };
} catch (e) { const d = document.createElement('div'); d.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#fdd;padding:10px;z-index:99999;font:14px sans-serif'; d.textContent = 'Acceptance kit failed to start: ' + e.message; document.body.appendChild(d); console.error(e); }
