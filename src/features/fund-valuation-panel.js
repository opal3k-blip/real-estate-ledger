/* =========================================================================
   لوحة تقييم القيمة المتبقية للصندوق (R1-B2 / B2-1) — قراءة فقط
   ---------------------------------------------------------------------------
   renderPanel(view, ctx): دالة نقية تحوّل حالة القارئ إلى نص HTML. لا حالة ولا DOM ولا Firebase.
   registerFundValuationPanel(core, deps): التوصيل الفعلي بـcore.js عبر ثلاثة خطافات + معالج إجراءات.

   - كل نص قادم من البيانات (المصدر، الطريقة، الأسباب، معرّفات الأشخاص، المعرّفات…) يمرّ عبر esc() قبل الإدراج.
   - لا أزرار إنشاء/تعديل/تقديم/سحب/مراجعة/اعتماد/تعليق إطلاقًا. الإجراءات الوحيدة: اختيار تاريخ، طيّ/فتح السجل،
     «عرض الكل»، «إعادة المحاولة».
   - لا تُعرض قيمة بوصفها معتمدة سارية إلا حين: اتسق الرأس مع وثيقة المعتمد (تحقق مكتمل لهذه البيانات بالذات)
     والأهلية ELIGIBLE. التعليق/عدم الاتساق/غياب الوثيقة/التحقق الجاري ⇒ لا قيمة، ولا رجوع لإصدار أقدم.
   - «لا تُستخدم بعد في حساب أي معدل»: لا ربط بأي معدل ولا تفعيل لـNet XIRR.
   ========================================================================= */
import { MESSAGES, describeError } from './fund-valuation-model.js';
import { createFundValuationReader } from './fund-valuation-reader.js';
import { getUserRole } from './roles-permissions.js';
import { createEditorWiring } from './fund-valuation-editor-wiring.js';
import { editorAvailable, makeEditorProdDeps } from './fund-valuation-editor-prod.js';

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export function esc(v) { return String(v == null ? '' : v).replace(/[&<>"'`]/g, (c) => ESC_MAP[c]); }
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const clip = (v, n = 500) => { const s = String(v == null ? '' : v); return s.length > n ? `${s.slice(0, n)}…` : s; };

const STATE_LABEL = {
  draft: ['مسودة', 'Draft'], submitted: ['مُقدَّم', 'Submitted'], reviewed: ['تمت مراجعته', 'Reviewed'], returned: ['مُعاد', 'Returned'],
  rejected: ['مرفوض', 'Rejected'], withdrawn: ['مسحوب', 'Withdrawn'], approved: ['معتمد', 'Approved'],
};
const LOCAL_REASONS = {
  HEAD_DOC_MISSING: ['وثيقة المعتمد التي يشير إليها الرأس غير متاحة في اللقطة الحالية', 'The approved document the head points to is not in the current snapshot'],
};

export function fmtAmount(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
}

function reasonText(reason, lang) {
  const i = lang === 'en' ? 1 : 0;
  if (reason && Object.prototype.hasOwnProperty.call(LOCAL_REASONS, reason)) return LOCAL_REASONS[reason][i];
  if (reason && Object.prototype.hasOwnProperty.call(MESSAGES, reason)) return MESSAGES[reason][i];
  return reason || '';
}

function block(cls, icon, title, body) {
  return `<div class="fvp-block fvp-${cls}" style="margin:10px 0; padding:10px 12px; border:1px solid var(--border); border-radius:8px;">`
    + `<p class="step-sub" style="margin:0 0 6px; font-weight:700;">${icon} ${title}</p>${body}</div>`;
}

function kv(rows) {
  return `<div class="kv">${rows.map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>`;
}

function stateLabel(state, T) {
  const l = STATE_LABEL[state];
  return l ? T(l[0], l[1]) : esc(state);
}

function renderApproved(view, T, lang) {
  const a = view.approved;
  const common = (extra = []) => kv([
    [T('تاريخ التقييم', 'Valuation date'), esc(a.valuationDate)],
    [T('النسخة', 'Version'), esc(a.version)],
    [T('معرّف المعتمد', 'Approved id'), `<code>${esc(a.headId)}</code>`],
    ...extra,
  ]);
  switch (a.kind) {
    case 'verifying':
      return block('verifying', '⏳', T('المعتمد الساري', 'Effective approved valuation'),
        `<p class="note" style="margin:0;">${T('جارٍ التحقق من اتساق الرأس مع وثيقة المعتمد — لا تُعرض القيمة حتى يكتمل التحقق لهذه البيانات.', 'Checking head consistency with the approved document — the value is not shown until the check completes for this data.')}</p>`);
    case 'inconsistent':
      return block('inconsistent', '⚠️', T('المعتمد الساري', 'Effective approved valuation'),
        `<p class="note" style="margin:0 0 6px;"><b>${T('حالة غير متسقة/غير قابلة للتحقق — لا تُعرض القيمة، ولا يُستعاض عنها بإصدار أقدم.', 'Inconsistent / unverifiable — the value is not shown and no older version is substituted.')}</b></p>`
        + `<p class="note" style="margin:0 0 6px;">${esc(reasonText(a.reason, lang))} <code>${esc(a.reason)}</code></p>`
        + (a.headId ? common() : ''));
    case 'suspended': {
      const e = a.eligibility || {};
      return block('suspended', '⛔', T('المعتمد الساري', 'Effective approved valuation'),
        `<p class="note" style="margin:0 0 6px;"><b>${T('هذا الإصدار معلّق: لا يُعدّ سارياً ولا تُعرض قيمته بوصفها معتمدة سارية.', 'This version is suspended: it is not in force and its value is not shown as an effective approved value.')}</b></p>`
        + common([
          [T('عُلّق بواسطة', 'Suspended by'), esc(e.changedBy)],
          [T('وقت التعليق', 'Suspended at'), esc(e.changedAt)],
          [T('السبب', 'Reason'), esc(clip(e.reason))],
          [T('اعتمده', 'Approved by'), esc(a.approvedBy)],
        ]));
    }
    case 'eligibility-unknown':
      return block('unknown', '⚠️', T('المعتمد الساري', 'Effective approved valuation'),
        `<p class="note" style="margin:0 0 6px;"><b>${T('أهلية هذا الإصدار غير محددة — لا تُعرض القيمة بوصفها سارية.', 'The eligibility of this version is not defined — the value is not shown as effective.')}</b></p>${common()}`);
    case 'effective': {
      const d = a.doc || {};
      const c = d.components && typeof d.components === 'object' ? d.components : {};
      const cur = esc(d.currency);
      const items = Array.isArray(c.otherAssetsItems) ? c.otherAssetsItems : [];
      const src = d.source && typeof d.source === 'object' ? d.source : {};
      const linked = d.coverage && Array.isArray(d.coverage.linkedAssets) ? d.coverage.linkedAssets.length : null;
      const staleNote = view.stale ? `<p class="note" style="margin:0 0 6px;">⚠️ ${T('آخر قيمة مؤكدة من الخادم — قد لا تكون محدّثة الآن.', 'Last value confirmed by the server — it may not be current.')}</p>` : '';
      return block('effective', '✅', T('المعتمد الساري', 'Effective approved valuation'),
        staleNote
        + `<p style="margin:0 0 6px; font-size:18px; font-weight:700;">${fmtAmount(d.residualValue)} ${cur}</p>`
        + kv([
          [T('تاريخ التقييم', 'Valuation date'), esc(a.valuationDate)],
          [T('الأساس', 'Basis'), esc(d.basis)],
          [T('قيمة الأصول', 'Assets value'), `${fmtAmount(c.assetsValue)} ${cur}`],
          [T('النقد المحتجز', 'Cash retained'), `${fmtAmount(c.cashRetained)} ${cur}`],
          [T('أصول أخرى', 'Other assets'), `${fmtAmount(c.otherAssets)} ${cur}`],
          [T('الالتزامات', 'Liabilities'), `${fmtAmount(c.liabilities)} ${cur}`],
          [T('توزيعات مستحقة غير مدفوعة', 'Distributions payable'), `${fmtAmount(c.distributionsPayable)} ${cur}`],
          [T('الطريقة', 'Method'), esc(d.method)],
          [T('ملاحظة الطريقة', 'Method note'), esc(clip(d.methodNote))],
          [T('المصدر', 'Source'), `${esc(src.provider)} / ${esc(src.ref)}`],
          [T('الأصول المغطاة', 'Covered assets'), linked == null ? '—' : esc(linked)],
          [T('أعدّه', 'Entered by'), esc(d.enteredBy)],
          [T('اعتمده', 'Approved by'), esc(d.approvedBy)],
          [T('وقت الاعتماد', 'Approved at'), esc(d.approvedAt)],
          [T('النسخة', 'Version'), esc(a.version)],
          [T('الأهلية', 'Eligibility'), `${esc(a.eligibility && a.eligibility.state)} (${esc(a.eligibility && a.eligibility.reasonCode)})`],
        ])
        + (items.length ? `<p class="note" style="margin:6px 0 2px;">${T('بنود الأصول الأخرى', 'Other-assets items')}:</p><ul style="margin:0; padding-inline-start:18px;">${items.map((i) => `<li>${esc(i && i.description)} — ${fmtAmount(i && i.amount)} ${cur}</li>`).join('')}</ul>` : '')
        + `<p class="note" style="margin:8px 0 0;">${T('اتساق الرأس مع وثيقة المعتمد المخزنة تحقق لهذه البيانات؛ هذا فحص اتساق فقط وليس إثباتاً لصحة التقييم المالي.', 'Head consistency with the stored approved document was verified for this data; this is a consistency check only, not proof that the valuation is financially correct.')}</p>`);
    }
    default:
      return block('none', 'ℹ️', T('المعتمد الساري', 'Effective approved valuation'),
        `<p class="note" style="margin:0;">${T('لا يوجد تقييم معتمد ساريٍ لهذا التاريخ.', 'There is no effective approved valuation for this date.')}</p>`);
  }
}

function renderDraftLike(view, T) {
  let out = '';
  if (view.draft) {
    if (view.draft.missing) {
      out += block('draft', '📝', T('المسودة الجارية', 'Current draft'), `<p class="note" style="margin:0;">${T('المسودة الجارية غير متاحة في اللقطة الحالية.', 'The current draft is not in the current snapshot.')} <code>${esc(view.draft.id)}</code></p>`);
    } else {
      const d = view.draft.doc;
      out += block('draft', '📝', T('المسودة الجارية (غير معتمدة)', 'Current draft (not approved)'), kv([
        [T('الحالة', 'State'), stateLabel(d.state, T)],
        [T('القيمة المقترحة — غير معتمدة', 'Proposed value — not approved'), `${fmtAmount(d.residualValue)} ${esc(d.currency)}`],
        [T('أعدّها', 'Entered by'), esc(d.enteredBy)],
        [T('آخر تحديث', 'Updated at'), esc(d.updatedAt)],
        [T('المعرّف', 'Id'), `<code>${esc(view.draft.id)}</code>`],
      ]));
    }
  }
  if (view.latestValuation) {
    const d = view.latestValuation.doc;
    out += block('latest', '🗂️', T('أحدث تقييم لهذا التاريخ (لا يوجد رأس معتمد)', 'Latest valuation for this date (no approved head)'), kv([
      [T('الحالة', 'State'), stateLabel(d.state, T)],
      [T('القيمة — غير معتمدة', 'Value — not approved'), `${fmtAmount(d.residualValue)} ${esc(d.currency)}`],
      [T('أعدّه', 'Entered by'), esc(d.enteredBy)],
      [T('آخر تحديث', 'Updated at'), esc(d.updatedAt)],
      [T('المعرّف', 'Id'), `<code>${esc(view.latestValuation.id)}</code>`],
    ]));
  }
  return out;
}

function renderLog(view, T) {
  const ev = view.events;
  const head = `<button class="btn btn-sm btn-ghost" data-action="fvp-toggle-log">${ev.open ? '▾' : '▸'} ${T('سجل الأحداث', 'Event log')} (${esc(ev.total)})</button>`;
  if (!ev.open) return `<div style="margin:10px 0;">${head}</div>`;
  const rows = ev.rows.map((e) => `<tr><td>${esc(e.at)}</td><td>${esc(e.type || e.action)}</td><td>${esc(e.valuationDate)}</td><td>${esc(e.actor)} <span class="note">${esc(e.role)}</span></td><td>${esc(clip(e.reason))}</td></tr>`).join('');
  const more = ev.total > ev.shown || ev.showAll
    ? `<button class="btn btn-sm btn-ghost" data-action="fvp-toggle-all">${ev.showAll ? T('عرض آخر 50 فقط', 'Show only the latest 50') : T('عرض الكل', 'Show all')}</button>` : '';
  return `<div style="margin:10px 0;">${head}`
    + `<p class="note" style="margin:6px 0;">${T(`يُعرض ${ev.shown} من ${ev.total} حدثاً. الحدّ للعرض فقط؛ الاستعلام يجلب كل أحداث هذا الصندوق.`, `Showing ${ev.shown} of ${ev.total} events. The limit is for display only; the query loads all events of this fund.`)}</p>`
    + (ev.total === 0 ? `<p class="note">${T('لا أحداث.', 'No events.')}</p>`
      : `<div class="tablewrap"><table class="db"><thead><tr><th>${T('الوقت', 'Time')}</th><th>${T('الحدث', 'Event')}</th><th>${T('تاريخ التقييم', 'Valuation date')}</th><th>${T('المنفِّذ', 'Actor')}</th><th>${T('السبب', 'Reason')}</th></tr></thead><tbody>${rows}</tbody></table></div>`)
    + more + '</div>';
}

function renderDatePicker(view, T) {
  const sel = view.selectedDate;
  const how = { user: T('اختيارك', 'your choice'), 'default-head': T('افتراضي: أحدث رأس معتمد (حتى لو كان معلّقاً)', 'default: latest approved head (even if suspended)'),
    'default-valuation': T('افتراضي: لا يوجد رأس معتمد — أحدث تقييم', 'default: no approved head — latest valuation'),
    'default-draft-head': T('افتراضي: لا معتمد ولا تقييم متاح — أحدث رأس', 'default: no approved valuation and none available — latest head') }[view.selection] || '';
  const buttons = view.dates.filter((d) => DAY_RE.test(d)).map((d) => `<button class="btn btn-sm ${d === sel ? 'btn-primary' : 'btn-ghost'}" data-action="fvp-select-date" data-date="${esc(d)}" aria-pressed="${d === sel ? 'true' : 'false'}">${esc(d)}</button>`).join(' ');
  return `<p class="step-sub" style="margin:0 0 4px;">${T('التاريخ المعروض', 'Displayed date')}: <b>${esc(sel)}</b> <span class="note">(${how})</span></p><div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px;">${buttons}</div>`;
}

/** @param {object} view  getView() من القارئ  @param {{T:Function}} ctx */
export function renderPanel(view, ctx = {}) {
  const T = typeof ctx.T === 'function' ? ctx.T : (ar) => ar;
  const lang = T('ar', 'en') === 'en' ? 'en' : 'ar';
  if (!view || ['unresolved', 'forbidden', 'idle'].includes(view.status)) return '';
  const title = `<div class="panel-head"><h3 style="font-size:14px;">📑 ${T('تقييم القيمة المتبقية للصندوق (قراءة فقط)', 'Fund residual valuation (read only)')}</h3></div>`
    + `<p class="note" style="margin:0 0 8px;">${T('لا تُستخدم بعد في حساب أي معدل.', 'Not yet used in the calculation of any rate.')}</p>`;
  let body = '';
  switch (view.status) {
    case 'denied':
      body = `<p class="note">🔒 ${T('لا تملك صلاحية قراءة تقييمات هذا الصندوق. أُوقفت كل الاشتراكات.', 'You do not have permission to read this fund\'s valuations. All subscriptions were stopped.')}</p><button class="btn btn-sm btn-ghost" data-action="fvp-retry">${T('إعادة المحاولة', 'Retry')}</button>`;
      break;
    case 'loading':
      body = `<p class="note">⏳ ${T('جارٍ التحميل من الخادم…', 'Loading from the server…')}</p>`;
      break;
    case 'error': {
      const msgs = view.errors.map((e) => {
        const m = describeError({ code: e.code, details: e.reason ? { reason: e.reason } : undefined }, lang);
        return `<li>${esc(e.source)}: ${esc(m.message)}${e.code ? ` <code>${esc(e.code)}</code>` : ''}</li>`;
      }).join('');
      body = `<p class="note">⛔ ${T('تعذّر تحميل التقييمات.', 'The valuations could not be loaded.')}</p><ul style="margin:0 0 6px; padding-inline-start:18px;">${msgs}</ul><button class="btn btn-sm btn-ghost" data-action="fvp-retry">${T('إعادة المحاولة', 'Retry')}</button>`;
      break;
    }
    case 'empty':
      // عند فقد التأكيد لا نُقرّ بغياب التقييمات: تحذير + إعادة محاولة بدل الجملة الجازمة.
      body = (view.stale
        ? `<p class="note">⚠️ ${T('انقطع التأكيد من الخادم — قد لا تكون محدّثة؛ لا يمكن الجزم الآن بعدم وجود تقييم.', 'Server confirmation was lost — this may not be current; the absence of a valuation cannot be confirmed right now.')} <button class="btn btn-sm btn-ghost" data-action="fvp-retry">${T('إعادة المحاولة', 'Retry')}</button></p>`
        : `<p class="note">ℹ️ ${T('لا يوجد تقييم قيمة متبقية لهذا الصندوق بعد.', 'This fund has no residual valuation yet.')}</p>`) + renderLog(view, T);
      break;
    case 'ready': {
      const stale = view.stale ? `<p class="note" style="margin:0 0 6px;">⚠️ ${T('انقطع التأكيد من الخادم لأحد المصادر — ما يُعرض قد لا يكون محدّثاً.', 'Server confirmation was lost for a source — what is shown may not be current.')} <button class="btn btn-sm btn-ghost" data-action="fvp-retry">${T('إعادة المحاولة', 'Retry')}</button></p>` : '';
      body = stale + renderDatePicker(view, T) + renderApproved(view, T, lang) + renderDraftLike(view, T) + renderLog(view, T)
        + (view.excluded ? `<p class="note">${T(`استُبعدت ${view.excluded} وثيقة لعدم اتساق معرّفها أو تاريخها.`, `${view.excluded} document(s) were excluded because their id or date was inconsistent.`)}</p>` : '');
      break;
    }
    default:
      return '';
  }
  return `<div class="panel fvp" data-fvp="root" style="margin-top:14px;">${title}${body}</div>`;
}

/* ------------------------------------------------------------------ التوصيل ------------------------------------------------------------------ */
const COLLECTION = Object.freeze({ heads: 'fundValuationHeads', valuations: 'fundValuations', events: 'fundValuationEvents' });

/** اشتراك Firestore بفلتر fundId وبتحديثات metadata (ليصل تأكيد الخادم ولو لم يتغيّر المحتوى). */
export function makeFirestoreSubscribe(core) {
  return (source, fundId, onNext, onError) => core.DB.collection(COLLECTION[source]).where('fundId', '==', fundId)
    .onSnapshot({ includeMetadataChanges: true },
      (snap) => onNext({ docs: snap.docs.map((d) => ({ id: d.id, data: d.data() })), fromCache: !!(snap.metadata && snap.metadata.fromCache) }),
      onError);
}

/** قراءة صريحة من الخادم (get بـsource:'server'، بلا مستمع): تفشل عند انقطاع الاتصال بدل أن تُجيب من الذاكرة؛ تُستعمل فقط لإثبات الترتيب (reader.refresh). قراءة فقط، بالفلتر نفسه (fundId). */
export function makeFirestoreFetchOnce(core) {
  return (source, fundId) => core.DB.collection(COLLECTION[source]).where('fundId', '==', fundId)
    .get({ source: 'server' })
    .then((snap) => ({ docs: snap.docs.map((d) => ({ id: d.id, data: d.data() })), fromCache: !!(snap.metadata && snap.metadata.fromCache) }));
}

/** الجلسة: لا دور محسوم قبل تأكيد الخادم لـteam_roles (أو أن البريد أدمن مثبّت). */
export function makeSession(core) {
  return () => {
    const u = core.currentUser;
    const email = u && u.email ? String(u.email).toLowerCase() : null;
    if (!core.DB || !u || !email || core.accessDenied) return { uid: null, email: null, role: null, roleResolved: false };
    const adminEmail = Array.isArray(core.ADMIN_EMAILS) && core.ADMIN_EMAILS.includes(email);
    const resolved = adminEmail || core.isIfCollectionServerConfirmed('team_roles');
    return { uid: u.uid, email, role: getUserRole(core), roleResolved: !!resolved };
  };
}

export function registerFundValuationPanel(core, deps = {}) {
  const editorRef = { current: null };
  const reader = deps.reader || createFundValuationReader({
    subscribe: deps.subscribe || makeFirestoreSubscribe(core),
    fetchOnce: deps.fetchOnce || makeFirestoreFetchOnce(core),
    getSession: deps.getSession || makeSession(core),
    verify: deps.verify,
    onChange: () => { if (editorRef.current) editorRef.current.onReaderChange(); core.render(); },   // a refusal from the server hides the editor at once, then the page renders
  });
  // R1-B2 / B2-2b-b1: the editor (inputs, actions) sits under the read-only panel. It is off when a test injects its own reader without editor deps.
  const editorOn = deps.editor === false ? false : !!deps.editorDeps || (!deps.reader && !deps.subscribe && editorAvailable());
  let editor = null;
  if (editorOn) {
    const ed = { ...makeEditorProdDeps(core), ...(deps.editorDeps || {}) };
    editor = createEditorWiring({
      reader, T: core.T, requestRender: () => core.render(), getSession: deps.getSession || makeSession(core),
      call: ed.call, storage: ed.storage, locks: ed.locks, getFundAssetIds: ed.getFundAssetIds, doc: ed.doc, win: ed.win, genId: ed.genId, now: ed.now, setTimer: ed.setTimer, clearTimer: ed.clearTimer,
    });
    editorRef.current = editor;
    editor.attachDom();
    // a composition in an editor field holds the render (when core.js offers the gate); everything else (session, permission, leaving the view) is never held
    if (typeof core.registerRenderGate === 'function') {
      core.registerRenderGate(() => editor.holdsRender());
      const gdoc = (deps.editorDeps && deps.editorDeps.doc) || (typeof document !== 'undefined' ? document : null);
      if (gdoc) for (const evn of ['compositionend', 'keyup']) gdoc.addEventListener(evn, () => setTimeout(() => { if (typeof core.flushDeferredRender === 'function') core.flushDeferredRender(); }, 0), true);
    }
  }
  let shownThisPass = false;
  core.registerFundDetailSection((fundId) => {
    reader.open(fundId);
    shownThisPass = true;
    return renderPanel(reader.getView(), { T: core.T }) + (editor ? editor.renderSlot() : '');
  });
  // نهاية كل رسم: إن لم يُرسم القسم في هذه الجولة (أُغلق الصندوق/غادر المستخدم العرض/شاشة دخول…) تُوقَف المستمعات.
  core.registerRenderEnd(() => {
    if (shownThisPass) reader.sync(); else reader.close();
    if (editor && editor.keeper) { if (shownThisPass) editor.keeper.afterRender(); else editor.keeper.clear(); }   // leaving the view forgets focus; nothing is re-seated into a page she left
    shownThisPass = false;
  });
  core.registerSessionTeardown(() => { if (editor) editor.teardown(); reader.reset(); shownThisPass = false; });
  core.registerActionHandler((action, el) => {
    if (editor && editor.actionHandler(action, el)) return true;
    switch (action) {
      case 'fvp-select-date': reader.selectDate(el && el.dataset ? el.dataset.date : undefined); return true;
      case 'fvp-toggle-log': reader.toggleLog(); return true;
      case 'fvp-toggle-all': reader.toggleShowAll(); return true;
      case 'fvp-retry': reader.retry(); return true;
      default: return false;
    }
  });
  if (editor) reader.editor = editor;
  return reader;
}
