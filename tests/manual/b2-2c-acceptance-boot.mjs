// R1-B2 / B2-2c — MANUAL ACCEPTANCE KIT (page side). Loaded by b2-2c-acceptance-server.mjs after the real index.html (real core.js, real panel, reader, actions, request runner,
// focus keeper, render gate). Faked: Firebase (stub), the Firestore listener and explicit server read (in-page), the callables (the in-page fake server of the unit tests).
// Adds a checklist overlay, scenario controls, and an EVENT RECORDER whose JSON she can export and send back. The overlay lives outside #app, so renders never touch it.
const CORE_URL = '/src/core.js?v=20261011-b2-1-fund-valuation-panel';
const clone = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = fn(); if (v) return v; } catch (e) { /* keep waiting */ } await sleep(50); } throw new Error('timeout'); }

async function boot() {
  await waitFor(() => typeof window.__authCb === 'function'); await sleep(300);
  const core = await import(CORE_URL); const P = await import('/src/features/fund-valuation-panel.js?real=1'); const S = await import('/tests/helpers/fund-valuation-server-fake.mjs'); const F = await import('/tests/helpers/fund-valuation-fakes.mjs');
  const clock = { now: new Date('2026-10-11T10:00:00Z') }; const srv = S.makeServer({ clock });
  const USERS = { u1: { uid: 'u1', email: 'fm@example.com', role: 'fund_manager', roleResolved: true }, u2: { uid: 'u2', email: 'fm2@example.com', role: 'fund_manager', roleResolved: true } };
  const box = { s: { ...USERS.u1 } };
  const fake = F.makeFakeSubscribe(); const net = { calls: [], auto: true };
  const snapshot = () => {
    const heads = []; const valuations = [];
    for (const d of srv.vals.values()) { valuations.push({ id: d.valuationId, data: clone(d) }); if (srv.slotId(d.fundId, d.valuationDate) === d.valuationId) heads.push({ id: `${d.fundId}__${d.valuationDate}`, data: { fundId: d.fundId, valuationDate: d.valuationDate, headId: null, version: 0, headHash: null, eligibility: null, activeDraftId: d.valuationId, rev: 1 } }); }
    return { heads, valuations };
  };
  const fetchOnce = (source) => new Promise((resolve) => { const c = { source, resolve, at: snapshot(), done: false }; net.calls.push(c); if (net.auto) { c.done = true; resolve({ docs: c.at[source], fromCache: false }); } });
  net.releaseAll = () => { for (const c of net.calls) if (!c.done) { c.done = true; c.resolve({ docs: snapshot()[c.source], fromCache: false }); } };
  const listen = () => { const s = snapshot(); fake.emit('heads', 'F1', s.heads); fake.emit('valuations', 'F1', s.valuations); fake.emit('events', 'F1', []); };
  const store = new Map(); const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
  let seq = 0;
  const reader = P.registerFundValuationPanel(core, {
    subscribe: fake.subscribe, fetchOnce, getSession: () => (box.s ? { ...box.s } : { uid: null, email: null, role: null, roleResolved: false }),
    editorDeps: { call: (callable, payload, { user }) => srv.handle(user, callable, payload), storage, locks: new S.FakeLocks(), getFundAssetIds: () => ['A1', 'A2'], doc: document, win: window, now: () => clock.now, genId: () => 'req_' + String(++seq).padStart(6, '0') },
  });
  let renders = 0; core.registerRenderEnd(() => { renders += 1; });
  const H = { core, reader, wiring: reader.editor, box, clock, srv, net, fake, listen, store, USERS, snapshot, renderCount: () => renders };
  window.__acc = H;
  window.__authCb({ uid: 'u1', email: 'fm@example.com' });
  core.STORE.funds = [{ id: 'F1', data: Object.assign(core.blankFund ? core.blankFund() : {}, { name: 'F One (test fund)', assetIds: ['A1', 'A2'] }) }];
  core.setCoreState({ fundsViewOpen: true, fundsSubTab: 'funds', openFundId: 'F1', render: true });
  listen();
  return H;
}

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
  { id: 'S1', title: 'كتابة عربية بلوحة المفاتيح الفعلية', steps: 'شغّل «عاصفة الرسم». اضغط داخل «ملاحظة الطريقة» واكتب نحو 150 حرفاً عربياً بسرعتك المعتادة (مع تفعيل اقتراحات النص في ويندوز إن كانت مفعّلة).', expect: 'لا حرف ينقص، المؤشر يبقى في الآخر، التركيز لا يُفقد، ولا وميض مزعج.' },
  { id: 'S2', title: 'تركيب IME حقيقي (ياباني/صيني/كوري من إعدادات ويندوز، أو الإملاء الصوتي Win+H، أو لوحة الإيموجي Win+.)', steps: 'مع «عاصفة الرسم» شغّالة: ابدأ تركيباً داخل «ملاحظة الطريقة» وابقَ فيه 5 ثوانٍ على الأقل قبل التثبيت، ثم ثبّته.', expect: 'السجل يُظهر compositions≥1 وinterruptingRenders=0 (وبلا «تركيب مفتوح» بعد التثبيت)، والنص بعد التثبيت سليم بلا تكرار أو ضياع.' },
  { id: 'S3', title: 'وسط حقل رقمي', steps: 'في «قيمة الأصول» اكتب 123456، حرّك المؤشر 3 مرات نحو بداية الرقم (الحقل من اليمين لليسار فمفتاح السهم الأيمن → هو الذي يتحرك نحو البداية؛ والمعيار هو الموضع لا اتجاه السهم)، ثم اكتب X (العاصفة شغّالة).', expect: 'تصير 123X456 (X بين 3 و4) والمؤشر بعد X مباشرة.' },
  { id: 'S4', title: 'قائمة وخانة بالكيبورد', steps: 'بالـTab انتقل إلى «الطريقة» (قائمة) وغيّرها بالأسهم، ثم إلى خانة إقرار عدم التداخل وبدّلها بالمسافة (العاصفة شغّالة).', expect: 'القيمة الجديدة تبقى والتركيز يبقى على نفس العنصر.' },
  { id: 'S5', title: 'تمرير الصفحة', steps: 'مرّر الصفحة حتى حقل «مزوّد التقييم» واكتب فيه (العاصفة شغّالة).', expect: 'الصفحة لا تقفز.' },
  { id: 'S6', title: 'رفض الصلاحية أثناء الكتابة أو التركيب', steps: 'للكتابة العادية: اكتب ثم اضغط «رفض الخادم للقراءة». للتركيب: اضبط «رفض بعد المهلة» (10 ث) **أولاً**، ثم ابدأ التركيب داخل الحقل وابقَ فيه حتى ينفَّذ الرفض (لا تنقر زر الرفض أثناء التركيب لأن النقر قد ينهيه).', expect: 'يختفي المحرّر وما كتبتَه فوراً (أقل من ثانية)، ولا يعود النص بإنهاء التركيب. في السجل: «رسم مسح ضروري» يزداد، و«رسم يقطع تركيباً» يبقى 0.' },
  { id: 'S7', title: 'الدور غير محسوم ثم محسوم', steps: 'اكتب نصاً، اضغط «الدور غير محسوم» ثم «الدور محسوم».', expect: 'لا محرّر ولا نص قديم بعد الحسم.' },
  { id: 'S8', title: 'تبديل المستخدم أثناء الكتابة', steps: 'اكتب نصاً ثم اضغط «تبديل المستخدم»؛ وللتركيب اضبط «تبديل مستخدم بعد المهلة» قبل بدء التركيب.', expect: 'لا أثر للنص عند المستخدم الجديد.' },
  { id: 'S9', title: 'عبور اليوم', steps: 'أنشئ مسودة واكتب أرقاماً، اضغط «عبور منتصف الليل».', expect: 'تحذير ثابت، الإدخال باقٍ، الحفظ معطّل؛ «الانتقال لليوم الجديد» بتأكيد وينسخ الأرقام والنصوص فقط.' },
  { id: 'S10', title: 'تعارض مالي', steps: 'أنشئ وفعّل المسودة (احفظ)، عدّل «النقد المحتجز» ثم اضغط «مستخدم آخر يعدّل المسودة» واحفظ.', expect: 'جدول بقيم الأساس/قيمتك/الخادم، لا دمج ولا إرسال تلقائي.' },
  { id: 'S11', title: 'زر التحديث أثناء قراءة جارية', steps: 'اضغط «إبطاء قراءات الخادم» ثم زر «تحقق من الخادم الآن» في المحرّر، ثم «إتمام القراءات».', expect: 'الزر معطّل أثناء القراءة ولا تتراكم قراءات.' },
  { id: 'S12', title: 'قائمة «الطريقة» مفتوحة أثناء عاصفة الرسم', steps: 'شغّل «عاصفة الرسم». انقر بالماوس على قائمة «الطريقة» لتنفتح وابقَ عليها نحو 5 ثوانٍ (لا تختر بعد). ثم: (أ) اختر قيمة بالنقر؛ كرّر الفتح و(ب) أغلقها بـEsc؛ كرّر الفتح و(ج) انقر خارجها. ثم افتحها بلوحة المفاتيح (Alt+↓ أو F4) واختر بالأسهم وEnter.', expect: 'القائمة تبقى مفتوحة ولا تُغلق وحدها طوال المدة؛ الاختيار يثبت (والقيمة تظهر)، والتركيز يبقى؛ بعد الإغلاق تعود الرسمات خلال أقل من ثانية. للأمان: بعد ثلاثين ثانية من الفتح بلا أي فعل تُفرج القائمة وحدها. (رفض الصلاحية/تبديل المستخدم/الدور غير المحسوم أثناء فتح القائمة لا يتأخر: اختبره بـ«رفض بعد المهلة» ثم افتح القائمة وانتظر.)' },
];

function buildOverlay(H, R) {
  const state = { storm: null, armed: null, delaySec: 10, results: Object.fromEntries(SCENARIOS.map((s) => [s.id, { status: 'pending', note: '' }])) };
  const css = document.createElement('style');
  css.textContent = '#acc{position:fixed;inset-block:0;inset-inline-end:0;z-index:99999;width:400px;max-width:92vw;overflow:auto;box-sizing:border-box;border-radius:0;background:#fffbe6;color:#222;border:2px solid #b8860b;font:13px/1.5 system-ui,sans-serif;padding:8px 10px;direction:rtl;box-shadow:0 4px 18px rgba(0,0,0,.3)} #acc button{margin:2px;padding:3px 8px;cursor:pointer} #acc .sc{border-top:1px solid #d8c36a;padding:4px 0} #acc .ok{color:#0a7a2a;font-weight:700} #acc .no{color:#b00020;font-weight:700} #acc small{color:#555} #acc textarea{width:100%;height:34px}';
  css.textContent += ' html.acc-open body{margin-inline-end:410px} html.acc-mini #acc{width:auto;inset-block:auto;inset-block-end:8px;inset-inline-end:8px;border-radius:8px}';
  document.head.appendChild(css); document.documentElement.classList.add('acc-open');
  const box = document.createElement('div'); box.id = 'acc'; box.setAttribute('data-acc', 'root'); document.body.appendChild(box);
  let open = true; let mini = false;
  const btn = (label, id) => `<button type="button" data-acc="${id}">${label}</button>`;
  function paint() {
    document.documentElement.classList.toggle('acc-open', !mini); document.documentElement.classList.toggle('acc-mini', mini);
    if (mini) { box.innerHTML = btn('إظهار قائمة القبول', 'toggle-mini'); return; }
    const c = R.counters;
    box.innerHTML = `<b>اختبار قبول B2-2c — بيئة تجريبية (خادم وهمي، لا Firebase)</b> ${btn('إخفاء', 'toggle-mini')}<br>
      <small>عدّادات: تركيبات ${c.compositions} · رسم يقطع تركيباً <b class="${c.interruptingRenders ? 'no' : 'ok'}">${c.interruptingRenders}</b> · رسم مسح ضروري ${c.clearingRenders}${R.open() ? ` · <b class="no">تركيب مفتوح الآن (${R.open().field}, ${R.open().ageMs}ms)</b>` : ''} · أطول تركيب ${c.longestCompositionMs}ms · إدخالات ${c.inputs} · رسمات ${H.renderCount()}</small><br>
      <div>${btn(state.storm ? '■ إيقاف عاصفة الرسم' : '▶ عاصفة الرسم (كل 200ms)', 'storm')} ${btn('رفض الخادم للقراءة', 'deny')} ${btn('الدور غير محسوم', 'unres')} ${btn('الدور محسوم', 'res')} ${btn('تبديل المستخدم', 'switch')}
      <div><small>إجراء مؤجّل (اضبطه <b>قبل</b> بدء التركيب، فالنقر على زر الرفض قد ينهي التركيب):</small> المهلة <input type="number" min="3" max="60" value="${state.delaySec}" data-acc-delay style="width:46px"> ث ${btn('رفض بعد المهلة', 'arm:deny')} ${btn('دور غير محسوم بعد المهلة', 'arm:unres')} ${btn('تبديل مستخدم بعد المهلة', 'arm:switch')} ${state.armed ? btn('إلغاء', 'arm:cancel') + ' <b class="no">مضبوط: ' + state.armed.action + ' بعد ' + Math.max(0, Math.round((state.armed.at - Date.now()) / 1000)) + 'ث</b>' : ''}</div>
      ${btn('عبور منتصف الليل', 'midnight')} ${btn('مستخدم آخر يعدّل المسودة', 'other')} ${btn('إبطاء قراءات الخادم', 'slow')} ${btn('إتمام القراءات', 'release')} ${btn('إعادة تحميل الصفحة (تصفير)', 'reload')}</div>
      ${SCENARIOS.map((s) => { const r = state.results[s.id]; return `<div class="sc"><b>${s.id}. ${s.title}</b><br><small>الخطوات: ${s.steps}</small><br><small>المتوقع: ${s.expect}</small><br>
        ${btn('نجح', 'ok:' + s.id)} ${btn('فشل', 'no:' + s.id)} ${btn('تخطّي', 'skip:' + s.id)} <span class="${r.status === 'ok' ? 'ok' : r.status === 'no' ? 'no' : ''}">${{ pending: 'لم يُجرَّب', ok: 'نجح', no: 'فشل', skip: 'تُخطّي' }[r.status]}</span>
        <textarea data-acc-note="${s.id}" placeholder="ملاحظة (اختياري)">${r.note.replace(/</g, '&lt;')}</textarea></div>`; }).join('')}
      <div class="sc">${btn('تصدير السجل (ملف JSON)', 'export')} ${btn('نسخ السجل إلى الحافظة', 'copy')} <small id="acc-msg"></small></div>`;
  }
  const msg = (t) => { const m = box.querySelector('#acc-msg'); if (m) m.textContent = t; };
  function envInfo() {
    const nav = navigator; const uad = nav.userAgentData ? { platform: nav.userAgentData.platform, brands: nav.userAgentData.brands } : null;
    return { userAgent: nav.userAgent, platform: nav.platform, uaData: uad, language: nav.language, languages: nav.languages, dpr: window.devicePixelRatio, screen: [screen.width, screen.height], viewport: [innerWidth, innerHeight], touch: nav.maxTouchPoints, kit: 'B2-2c acceptance kit v1', page: location.origin };
  }
  function exportData() { return { exportedAt: new Date().toISOString(), env: envInfo(), results: state.results, counters: R.counters, openComposition: R.open(), cancelledCompositions: R.cancelled(), armed: state.armed ? { action: state.armed.action, firesInMs: Math.max(0, state.armed.at - Date.now()) } : null, events: R.ev, note: 'Test data only (fake server). No real account, fund or valuation is involved.' }; }
  const actions = {
    'toggle-mini': () => { mini = !mini; },
    storm: () => { if (state.storm) { clearInterval(state.storm); state.storm = null; R.mark('storm-off'); } else { state.storm = setInterval(() => H.core.render(), 200); R.mark('storm-on'); } },
    deny: () => { R.mark('ACTION deny'); H.fake.fail('heads', 'F1', Object.assign(new Error('no'), { code: 'permission-denied' })); },
    unres: () => { R.mark('ACTION role-unresolved'); H.box.s = { ...H.box.s, roleResolved: false }; H.core.render(); },
    res: () => { R.mark('ACTION role-resolved'); H.box.s = { ...H.box.s, roleResolved: true }; H.reader.sync(); H.listen(); H.core.render(); },
    switch: () => { R.mark('ACTION user-switch'); H.box.s = { ...H.USERS.u2 }; window.__authCb({ uid: 'u2', email: 'fm2@example.com' }); },
    midnight: () => { R.mark('ACTION midnight'); H.clock.now = new Date('2026-10-12T01:00:00Z'); H.core.render(); },
    other: async () => {
      R.mark('ACTION other-user-edit'); const [vid] = [...H.srv.vals.keys()]; if (!vid) return msg('أنشئ المسودة واحفظها أولاً');
      const doc = H.srv.vals.get(vid); const hash0 = doc.contentHash; const base = JSON.parse(JSON.stringify(doc));
      const content = {}; for (const k of ['currency', 'basis', 'components', 'residualValue', 'method', 'methodNote', 'source', 'nonOverlap', 'coverage', 'otherAssetsItems']) if (base[k] !== undefined) content[k] = base[k];
      content.components = { ...(content.components || {}), cashRetained: 250 }; content.residualValue = 1050;
      try { await H.srv.handle('fm2@example.com', 'updateValuationDraft', { requestId: 'other_' + Date.now(), valuationId: vid, expectedContentHash: hash0, content }); H.listen(); msg('عدّل مستخدم آخر المسودة (النقد 250، المتبقية 1050). اضغط حفظ الآن.'); } catch (e) { msg('تعذّر: ' + (e.code || e.message)); }
    },
    slow: () => { H.net.auto = false; R.mark('ACTION reads-held'); },
    release: () => { H.net.auto = true; H.net.releaseAll(); R.mark('ACTION reads-released'); },
    arm: (which) => {
      if (state.armed) { clearTimeout(state.armed.timer); R.mark('ARMED-CANCEL ' + state.armed.action); state.armed = null; }
      if (which === 'cancel') return;
      const sec = Math.min(60, Math.max(3, Number(state.delaySec) || 10)); const at = Date.now() + sec * 1000;
      state.armed = { action: which, at, timer: setTimeout(() => { R.mark('ARMED-FIRE ' + which, { compositionOpen: R.open() }); state.armed = null; actions[which](); paint(); }, sec * 1000) };
      R.mark('ARMED ' + which, { afterSec: sec });
    },
    reload: () => { location.reload(); },
    export: () => { const blob = new Blob([JSON.stringify(exportData(), null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'b2-2c-acceptance-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; document.body.appendChild(a); a.click(); a.remove(); msg('نُزِّل الملف'); },
    copy: async () => { try { await navigator.clipboard.writeText(JSON.stringify(exportData())); msg('نُسخ'); } catch (e) { msg('تعذّر النسخ، استعمل التصدير'); } },
  };
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-acc]'); if (!b) return; const id = b.getAttribute('data-acc'); const m = id.match(/^(ok|no|skip):(S\d+)$/);
    if (m) { state.results[m[2]].status = m[1]; R.mark('RESULT ' + m[2] + ' ' + m[1]); paint(); return; }
    const am = id.match(/^arm:(deny|unres|switch|cancel)$/); if (am) { actions.arm(am[1]); paint(); return; }
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
