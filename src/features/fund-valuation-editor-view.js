/* =========================================================================
   R1-B2 / B2-2b-b1 — عرض محرّر تقييم القيمة المتبقية (HTML نقي).
   renderEditor(model, ctx) → نص HTML. لا حالة ولا DOM ولا Firebase ولا استدعاء لأي إجراء. كل قيمة قادمة من البيانات أو من النموذج تمرّ عبر esc().
   model = { state (actions.getState()), ui (حالة الواجهة المحلية: تأكيدات/تجهيز/نتيجة)، reader { read, selectedDate, copySource }، pinnedDate, now،
             pendingAll (كل الطلبات المعلّقة للمستخدم)، refresh { allowed, reason } }.
   الحقول تحمل data-fve-path (للمعالج) وdata-fvp-field (لحافظ التركيز). لا قيم افتراضية تُقدَّم كحقائق: التغطية لا تُعتمد آليًا، والمصدر موسوم.
   ========================================================================= */
import { MESSAGES } from './fund-valuation-model.js';
import { METHODS, COMPONENT_KEYS, NON_OVERLAP_KEYS, canServerCopy } from './fund-valuation-editor.js';

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export function esc(v) { return String(v == null ? '' : v).replace(/[&<>"'`]/g, (c) => ESC_MAP[c]); }
const FIELD = 'data-fvp-field';
const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—');
const clip = (v, n = 300) => { const s = String(v == null ? '' : v); return s.length > n ? `${s.slice(0, n)}…` : s; };

const LOCAL = {
  AWAITING_VIEW: ['بانتظار ظهور أثر الطلب السابق في العرض', 'Waiting for the previous request to show in the view'],
  VIEW_NOT_CONFIRMED: ['العرض غير مؤكَّد من الخادم الآن', 'The view is not confirmed by the server right now'],
  NO_SESSION: ['لا جلسة صالحة', 'No valid session'], NO_CONTEXT: ['لا سياق صندوق/تاريخ', 'No fund/date context'],
  DRAFT_DOC_MISSING: ['وثيقة المسودة غير متاحة في العرض', 'The draft document is not in the view'],
  UNSAVED_EDITS: ['توجد تعديلات غير محفوظة — احفظ أولًا', 'There are unsaved edits — save first'],
  COPY_REVIEW_REQUIRED: ['مراجعة النسخة (المحتوى والتغطية) مطلوبة أولًا', 'The copy review (content and coverage) is required first'],
  EDITOR_ERRORS: ['في النموذج قيم لا يمكن إرسالها', 'The form has values that cannot be sent'],
  CONFLICT_UNRESOLVED: ['تعارض غير محسوم', 'Unresolved conflict'], DRAFT_GONE: ['المسودة لم تعد في العرض', 'The draft is no longer in the view'],
  UNSENT_INPUT: ['لديك إدخال غير مرسل — لا يُستبدل بنسخة', 'You have unsent input — it is not replaced by a copy'],
  LINK_PROPOSAL_REQUIRED: ['لا اقتراح روابط للتأكيد', 'No proposed links to confirm'],
  NOT_PREPARED: ['انتهى التجهيز — أعد المحاولة', 'The preparation expired — try again'],
  VIEW_CHANGED: ['تغيّر العرض بعد التجهيز — راجع ثم أعد', 'The view changed after preparing — review and retry'],
  SAVE_FIRST: ['احفظ التغطية أولًا', 'Save the coverage first'], COVERAGE_NOT_CONFIRMED: ['أكّد التغطية أولًا', 'Confirm the coverage first'],
  NUMBER_INVALID: ['رقم غير صالح', 'Invalid number'], AMOUNT_EMPTY: ['المبلغ مطلوب', 'Amount required'], ITEM_DESCRIPTION_EMPTY: ['الوصف مطلوب', 'Description required'],
  CANNOT_CLEAR_STORED_FIELD: ['لا يمكن مسح قيمة محفوظة', 'A stored value cannot be cleared'],
  IN_FLIGHT: ['قراءة من الخادم جارية', 'A server read is in progress'],
  NOT_PREPARED: ['انتهى التجهيز — أعد المحاولة', 'The preparation expired — try again'],
};
const REVIEWER_ACTS = ['review', 'returnDraft', 'reject', 'approve'];
const REVIEWER_ROLES = ['senior_ic', 'admin'];
const ACT_LABEL = { review: ['مراجعة', 'Review'], returnDraft: ['إرجاع', 'Return'], reject: ['رفض', 'Reject'], approve: ['اعتماد', 'Approve'] };
const ACT_NEEDS_REASON = { review: false, returnDraft: true, reject: true, approve: false };
function reasonOf(code, lang) {
  const i = lang === 'en' ? 1 : 0;
  if (code && Object.prototype.hasOwnProperty.call(LOCAL, code)) return LOCAL[code][i];
  if (code && Object.prototype.hasOwnProperty.call(MESSAGES, code)) return MESSAGES[code][i];
  return code || '';
}
const why = (code, lang) => `${esc(reasonOf(code, lang))}${code ? ` <code>${esc(code)}</code>` : ''}`;

function block(cls, title, body, extra = '') {
  return `<div class="fve-block fve-${cls}" ${extra} style="margin:10px 0; padding:10px 12px; border:1px solid var(--border); border-radius:8px;">${title ? `<p class="step-sub" style="margin:0 0 6px; font-weight:700;">${title}</p>` : ''}${body}</div>`;
}
const btn = (action, label, { allowed = true, why: w = '', primary = false, attrs = '' } = {}) =>
  `<button type="button" class="btn btn-sm ${primary ? 'btn-primary' : 'btn-ghost'}" data-action="${esc(action)}" ${attrs} ${allowed ? '' : `disabled aria-disabled="true" title="${esc(w)}"`}>${label}</button>`;

function errFor(editor, path) {
  const e = (editor.errors || []).filter((x) => x.path === path);
  return e.length ? `<span class="note fve-err" style="color:var(--bad);">${e.map((x) => esc(reasonOf(x.code, 'ar')) + ' ').join('')}</span>` : '';
}
function textInput(editor, path, label, value, { multiline = false, ltr = true, ph = '' } = {}) {
  const common = `data-fve-path="${esc(path)}" ${FIELD}="${esc(path)}" aria-label="${esc(label)}" autocomplete="off"`;
  const control = multiline
    ? `<textarea ${common} rows="3" maxlength="500" style="width:100%;">${esc(value)}</textarea>`
    : `<input type="text" ${common} value="${esc(value)}" ${ltr ? 'dir="ltr" inputmode="decimal"' : ''} maxlength="500" placeholder="${esc(ph)}">`;
  return `<div class="field"><label><span>${esc(label)}</span>${control}</label>${errFor(editor, path)}</div>`;
}
function itemRows(editor, list, rows, path, T) {
  const body = rows.map((r, i) => `<div class="fve-row" style="display:flex; gap:6px; align-items:flex-start; margin:4px 0;">`
    + `<input type="text" data-fve-path="${esc(path)}.${i}.description" ${FIELD}="${esc(path)}.${i}.description" value="${esc(r.description)}" aria-label="${esc(T('وصف البند', 'Item description'))}" maxlength="500" autocomplete="off" style="flex:2;">`
    + `<input type="text" dir="ltr" inputmode="decimal" data-fve-path="${esc(path)}.${i}.amount" ${FIELD}="${esc(path)}.${i}.amount" value="${esc(r.amount)}" aria-label="${esc(T('مبلغ البند', 'Item amount'))}" maxlength="500" autocomplete="off" style="flex:1;">`
    + btn('fve-remove-item', '✕', { attrs: `data-list="${esc(list)}" data-index="${i}"` })
    + `</div>${errFor(editor, `${path}.${i}.description`)}${errFor(editor, `${path}.${i}.amount`)}`).join('');
  return `<div data-fvp-scroll="items-${esc(list)}">${body}</div>${btn('fve-add-item', T('+ إضافة بند', '+ Add item'), { attrs: `data-list="${esc(list)}"` })}`;
}

function renderFormula(ed, T) {
  const c = ed.check || {};
  if (!c.ok) return `<p class="note">${T('تعذّر حساب الصيغة', 'Formula could not be computed')}: <code>${esc(c.code)}</code> <code>${esc(c.step)}</code></p>`;
  if (c.formula === null) return `<p class="note">${T('الصيغة: الأصول + النقد المحتجز + أصول أخرى − الالتزامات (تظهر حين تكتمل الأرقام).', 'Formula: assets + cash retained + other assets − liabilities (shown when the numbers are complete).')}</p>`;
  const flags = [];
  if (c.residualMatches === false) flags.push(T('القيمة المتبقية المدخلة لا تطابق الصيغة', 'The stated residual value does not match the formula'));
  if (c.residualNegative === true) flags.push(T('قيمة سالبة', 'Negative value'));
  if (c.itemsMatch === false) flags.push(T('مجموع البنود لا يطابق «أصول أخرى»', 'Items do not add up to “other assets”'));
  if (c.unlinkedWithinAssets === false) flags.push(T('بنود غير مرتبطة تتجاوز قيمة الأصول', 'Unlinked items exceed assets value'));
  return `<p class="note" style="margin:6px 0;" data-fve="formula">${T('الصيغة (للقراءة فقط — القيمة المتبقية تُكتب يدويًا ولا تُشتق)', 'Formula (read only — the residual value is typed, never derived)')}: <b dir="ltr">${fmt(c.formula)}</b>`
    + (c.diff !== null ? ` · ${T('الفرق', 'difference')}: <b dir="ltr">${fmt(c.diff)}</b>` : '') + (flags.length ? ` · <b style="color:var(--bad);">${flags.map(esc).join(' · ')}</b>` : '') + '</p>';
}

function renderCoverage(ed, T) {
  const cv = ed.coverage || {}; const f = ed.form; const la = f.coverage.linkedAssets; const uh = f.coverage.unlinkedHoldings;
  const srcLabel = (s) => (s === 'SERVER_SCOPE_SNAPSHOT' ? T('لقطة الخادم المخزّنة مع المسودة', 'server snapshot stored with the draft') : T('بيانات الصندوق في هذا المتصفح (قد يلتقط الخادم روابط مختلفة)', 'fund data in this browser (the server may capture different links)'));
  let out = '';
  out += `<p class="step-sub" style="margin:4px 0;">${T('التغطية — إقرارك أنت، لا يُعتمد آليًا', 'Coverage — your statement, never automatic')}</p>`;
  out += cv.proposal ? `<p class="note">${T('اقتراح الأصول المرتبطة', 'Proposed linked assets')} (${srcLabel(cv.proposal.source)}): <code dir="ltr">${cv.proposal.ids.map(esc).join(', ') || '—'}</code></p>`
    : `<p class="note">${T('لا اقتراح روابط متاح.', 'No link proposal available.')}</p>`;
  out += `<p class="note" data-fve="statement">${la.confirmed ? `${T('إقرارك الحالي', 'Your current statement')}: <code dir="ltr">${la.ids.map(esc).join(', ') || '—'}</code>` : `<b>${T('لم تُقرّ بعد بالأصول المغطاة.', 'You have not yet stated the covered assets.')}</b>`}</p>`;
  if (cv.statementStale) out += `<p class="note" style="color:var(--bad);">⚠️ ${T('تغيّر الاقتراح بعد إقرارك — راجع الإقرار.', 'The proposal changed after your statement — review it.')}</p>`;
  const rs = cv.reconcile && cv.reconcile.status;
  if (rs && rs !== 'UNCONFIRMED' && rs !== 'NO_SCOPE' && rs !== 'MATCH') out += `<p class="note" style="color:var(--bad);">⚠️ ${esc(rs)}: ${T('ناقص', 'missing')} <code dir="ltr">${(cv.reconcile.missing || []).map(esc).join(', ')}</code> ${T('زائد', 'extra')} <code dir="ltr">${(cv.reconcile.extra || []).map(esc).join(', ')}</code></p>`;
  if (cv.proposalIsOnlyBrowserData) out += `<p class="note">${T('المصدر بيانات متصفح فقط؛ الخادم هو المرجع عند الحفظ.', 'Source is browser data only; the server is the authority when saving.')}</p>`;
  out += `<div>${btn('fve-confirm-links', T('أقرّ بهذه الأصول', 'State these assets'), { allowed: !!cv.proposal, why: reasonOf('LINK_PROPOSAL_REQUIRED', 'ar') })} ${btn('fve-clear-links', T('امسح الإقرار', 'Clear statement'), { allowed: la.confirmed })}</div>`;
  out += `<fieldset style="margin:8px 0; border:1px solid var(--border);"><legend class="note">${T('أصول غير مرتبطة', 'Unlinked holdings')}</legend>`
    + ['none', 'included'].map((v) => `<label style="margin-inline-end:12px;"><input type="radio" name="fve-unlinked" data-fve-path="coverage.unlinkedHoldings.declared" ${FIELD}="coverage.unlinkedHoldings.declared:${v}" value="${v}" ${uh.declared === v ? 'checked' : ''}> ${v === 'none' ? T('لا يوجد', 'None') : T('يوجد (مُدرجة في الأصول)', 'Exist (included in assets)')}</label>`).join('')
    + (uh.declared === null ? `<p class="note">${T('لم تُذكر بعد — لا تُقرأ «لا يوجد».', 'Not stated — not read as “none”.')}</p>` : '')
    + (uh.declared === 'included' ? itemRows(ed, 'unlinkedItems', uh.items, 'coverage.unlinkedHoldings.items', T) : '') + '</fieldset>';
  return out;
}

function renderCopyReview(ed, T) {
  const r = ed.copyReview; if (!r) return '';
  return block('copy', `📋 ${T('هذه نسخة جديدة — راجع المحتوى والتغطية', 'This is a new copy — review the content and coverage')}`,
    `<p class="note">${T('المحتوى والتغطية لا يُعدّان صحيحين لمجرد النسخ.', 'Content and coverage are not considered right merely because they were copied.')}</p>`
    + `<div>${btn('fve-ack-copy', r.contentReviewed ? '✔ ' + T('راجعت المحتوى', 'Content reviewed') : T('راجعت المحتوى', 'I reviewed the content'), { allowed: !r.contentReviewed, attrs: 'data-which="content"' })} `
    + `${btn('fve-ack-copy', r.coverageReviewed ? '✔ ' + T('راجعت التغطية', 'Coverage reviewed') : T('راجعت التغطية', 'I reviewed the coverage'), { allowed: !r.coverageReviewed, attrs: 'data-which="coverage"' })}</div>`);
}

/** the conflicting values side by side: base (when she started) / yours / the server's now. Every cell is escaped text. */
function conflictTable(rows, T) {
  if (!rows.length) return '';
  const cell = (col, v) => `<td data-col="${col}" dir="auto" style="padding:3px 8px; border-top:1px solid var(--border);">${v === null || v === undefined ? '—' : esc(v)}</td>`;
  const body = rows.map((r) => `<tr data-fve-conflict-row="${esc(r.path)}" data-overlap="${r.overlapping ? 'true' : 'false'}"${r.overlapping ? ' style="background:var(--warn-bg, rgba(255,180,0,.12));"' : ''}>`
    + `<td dir="ltr" style="padding:3px 8px; border-top:1px solid var(--border);"><code>${esc(r.path)}</code>${r.overlapping ? ` <b>${T('تداخل', 'both changed')}</b>` : ''}</td>`
    + cell('base', r.base) + cell('mine', r.mine) + cell('server', r.server) + '</tr>').join('');
  return `<table data-fve="conflict-values" style="width:100%; border-collapse:collapse; margin:6px 0;"><thead><tr><th>${T('الحقل', 'Field')}</th><th>${T('الأساس (عند بدء التحرير)', 'Base (when you started)')}</th><th>${T('قيمتك', 'Yours')}</th><th>${T('قيمة الخادم الآن', 'Server now')}</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderConflict(ed, T) {
  const c = ed.conflict; let out = '';
  if (ed.serverChanged) out += `<p class="note" style="color:var(--bad);" data-fve="server-changed">⚠️ ${T('تغيّرت نسخة المسودة على الخادم أثناء تحريرك. لن يُستبدل إدخالك؛ سيُعرض التعارض عند الحفظ.', 'The draft changed on the server while you were editing. Your input is not replaced; the conflict is shown when you save.')}</p>`;
  if (ed.goneFromView) out += `<p class="note" style="color:var(--bad);" data-fve="gone">⚠️ ${T('المسودة لم تعد ظاهرة في العرض — لا حفظ حتى تعود أو تتأكد.', 'The draft is no longer in the view — no saving until it returns or is confirmed.')}</p>`;
  if (ed.blockedByActive) out += `<p class="note" style="color:var(--bad);" data-fve="active-exists">⚠️ ${T('توجد مسودة جارية لهذا التاريخ — لا إنشاء جديد.', 'An active draft exists for this date — no new one can be created.')} <code>${esc(ed.blockedByActive.draftId)}</code></p>`;
  if (c) out += block('conflict', `⚠️ ${T('تعارض: تغيّرت المسودة على الخادم', 'Conflict: the draft changed on the server')}`,
    `<p class="note">${T('غيّرتَ', 'You changed')}: <code>${c.changedByMe.map(esc).join(', ') || '—'}</code><br>${T('تغيّر على الخادم', 'Changed on the server')}: <code>${c.changedOnServer.map(esc).join(', ') || '—'}</code><br>${T('متداخل', 'Overlapping')}: <code>${c.overlapping.map(esc).join(', ') || '—'}</code></p>`
    + conflictTable(c.rows || [], T)
    + `<p class="note">${T('لا دمج ولا إرسال تلقائي: «أعد تطبيق» يبقي قيمك في الحقول التي غيّرتها ويأخذ قيم الخادم في الباقي، ولا يُرسل شيء حتى تحفظ بنفسك.', 'Nothing is merged or sent automatically: “re-apply” keeps your values in the fields you changed and takes the server values elsewhere; nothing is sent until you save yourself.')}</p>`
    + `<div>${btn('fve-resolve', T('أعد تطبيق تعديلاتي فوق نسخة الخادم (لا إرسال)', 'Re-apply my changes over the server version (nothing sent)'), { attrs: 'data-choice="reapply"' })} ${btn('fve-resolve', T('تجاهل تعديلاتي', 'Discard my changes'), { attrs: 'data-choice="discard-mine"' })}</div>`, 'data-fve="conflict"');
  return out;
}

function renderStatusBanners(st, ui, model, T, lang) {
  let out = '';
  for (const b of st.banners || []) {
    if (b.kind === 'awaiting_view') {
      const txt = b.phase === 'stalled' ? T('نجح الطلب لكن العرض لم يعكسه بعد (تأخر). لن يُرسل شيء جديد من العرض القديم.', 'The request succeeded but the view has not reflected it yet (late). Nothing new is sent from the old view.')
        : b.phase === 'delayed' ? T('نجح الطلب؛ العرض متأخر — يُطلب تحديث من الخادم.', 'The request succeeded; the view is late — a server refresh is requested.')
          : T('نجح الطلب؛ بانتظار ظهور أثره في عرض مؤكَّد من الخادم.', 'The request succeeded; waiting for a server-confirmed view to show it.');
      out += `<p class="note fve-banner" data-fve="awaiting" data-phase="${esc(b.phase)}">⏳ ${txt}</p>`;
    } else if (b.kind === 'view_overtaken') {
      out += `<p class="note fve-banner" style="color:var(--bad);" data-fve="overtaken">⚠️ ${T('تجاوزَ الخادمُ هذا الطلب: قراءة مؤكَّدة بعد الرد لا تُظهر أثره. راجع الحالة قبل أي إجراء.', 'The server moved past this request: a confirmed read after the reply does not show its effect. Review the state before acting.')}</p>`;
    }
  }
  const o = st.outcome;
  if (o && !['reflected', 'success_waiting_view', 'view_overtaken'].includes(o.status)) {
    const code = o.code || o.reason;
    out += `<p class="note fve-banner" data-fve="outcome" data-status="${esc(o.status)}">${o.status === 'no_effect' ? '✖' : 'ℹ️'} ${T('نتيجة آخر إجراء', 'Last action result')}: ${esc(o.status)} ${code ? why(code, lang) : ''}</p>`;
  } else if (o && o.status === 'reflected') out += `<p class="note fve-banner" data-fve="reflected">✅ ${T('ظهر أثر الإجراء في العرض المؤكَّد.', 'The action is reflected in the confirmed view.')}</p>`;
  if ((st.unsentElsewhere || []).length) out += `<p class="note fve-banner" data-fve="unsent-elsewhere">📝 ${T('لديك إدخال غير مرسل في تاريخ/صندوق آخر', 'You have unsent input for another date/fund')}: ${st.unsentElsewhere.map((u) => `<code>${esc(u.fundId)} / ${esc(u.valuationDate)}</code>`).join(' ')}</p>`;
  return out;
}

function renderPending(model, T, lang) {
  const list = model.pendingAll || []; if (!list.length) return '';
  const rows = list.map((e) => {
    let d = e.scope; try { d = JSON.parse(e.scope).slice(1).join(' / '); } catch (x) { /* raw */ }
    const risk = model.ui.discarding === e.scope;
    const pl = e.payload && typeof e.payload === 'object' ? e.payload : null;   // the ORIGINAL payload: a retry sends exactly this, whatever is typed now
    return `<li data-fve-pending="${esc(e.scope)}"><b>${esc(e.action)}</b> <code>${esc(d)}</code> — ${esc(e.status)}${pl && pl.reason ? ` <span class="note" data-fve="pending-reason" dir="auto">${T('السبب المرسل', 'Sent reason')}: ${esc(clip(pl.reason, 200))}</span>` : ''}${pl && pl.expectedContentHash ? ` <code dir="ltr" data-fve="pending-hash">${esc(String(pl.expectedContentHash).slice(0, 12))}…</code>` : ''}${e.lastOutcome && e.lastOutcome.code ? ` <code>${esc(e.lastOutcome.code)}</code>` : ''}`
      + ` ${btn('fve-retry-pending', T('أعد المحاولة بنفس المعرّف', 'Retry with the same id'), { attrs: `data-scope="${esc(e.scope)}"` })}`
      + (risk ? ` <label class="note"><input type="checkbox" data-fve-ack="risk"> ${T('أُقرّ بأن الطلب قد يكون نُفّذ على الخادم', 'I acknowledge the request may have been executed on the server')}</label> ${btn('fve-discard-confirm', T('تجاهل نهائيًا', 'Discard for good'), { attrs: `data-scope="${esc(e.scope)}"` })} ${btn('fve-discard-cancel', T('تراجع', 'Back'))}`
        : ` ${btn('fve-discard-pending', T('تجاهل…', 'Discard…'), { attrs: `data-scope="${esc(e.scope)}"` })}`)
      + '</li>';
  }).join('');
  return block('pending', `⏳ ${T('طلبات معلّقة/غامضة — لم تُحسم بعد', 'Pending / ambiguous requests — not settled yet')}`, `<p class="note">${T('لا يُستدل على نتيجتها من السجل. أعد إرسال الطلب الأصلي بمعرّفه أو تجاهله بإقرار.', 'Their outcome is never inferred from the log. Re-send the original request by its id, or discard with an acknowledgement.')}</p><ul style="margin:0; padding-inline-start:18px;">${rows}</ul>`, 'data-fve="pending"');
}

function renderDay(st, ed, model, T) {
  if (!ed) return '';
  const frozen = ed.frozen;
  if (!frozen) return '';
  const ui = model.ui;
  const head = frozen === 'crossed' ? T(`هذا المحرّر لتاريخ ${model.scopeDate} وانتهى يومه: لا يمكن الحفظ أو الإرسال.`, `This editor is for ${model.scopeDate} and its day has ended: saving and submitting are not possible.`)
    : T(`هذا المحرّر لتاريخ ${model.scopeDate} (لم يحن بعد): لا يمكن الحفظ أو الإرسال.`, `This editor is for ${model.scopeDate} (not yet due): saving and submitting are not possible.`);
  let body = `<p class="note" style="margin:0 0 6px;"><b>${esc(head)}</b> ${T('إدخالك ما زال ظاهرًا ولن يُحذف.', 'Your input is still shown and will not be deleted.')}</p>`;
  if (ui.confirm && ui.confirm.kind === 'move-day') {
    body += `<p class="note">${T('سيُنشأ محرّر جديد لتاريخ', 'A new editor will be created for')} <b>${esc(st.today)}</b> ${T('بنسخة من الحقول المدخلة. لن تُنقل التغطية ولا مراجعة النسخة (عليك إقرارها من جديد)، ولن يُرسل شيء تلقائيًا، ولن يُحذف أي طلب سابق غامض. يبقى إدخالك القديم حتى ينجح المحرّر الجديد.', 'with a copy of the typed fields. Coverage and copy review are NOT carried over (state them again), nothing is sent automatically, and no earlier ambiguous request is dropped. Your old input stays until the new editor starts.')}</p>`
      + `${btn('fve-move-day-confirm', T('نعم، انقل إلى اليوم الجديد', 'Yes, move to the new day'), { primary: true })} ${btn('fve-move-day-cancel', T('تراجع', 'Back'))}`;
  } else if (ui.confirm && ui.confirm.kind === 'ignore-input') {
    body += `<p class="note">${T('سيُحذف إدخال هذا المحرّر غير المحفوظ نهائيًا.', 'The unsaved input of this editor will be deleted for good.')}</p>${btn('fve-ignore-confirm', T('نعم، تجاهل الإدخال', 'Yes, discard the input'), { primary: true })} ${btn('fve-ignore-cancel', T('تراجع', 'Back'))}`;
  } else {
    body += `${btn('fve-move-day', T('انقل إلى اليوم الجديد…', 'Move to the new day…'), { allowed: frozen === 'crossed' })} ${btn('fve-ignore', T('تجاهل الإدخال…', 'Discard the input…'))}`;
  }
  return block('day', '📅', body, 'data-fve="day-warning" role="alert"');
}

function renderPrepared(model, T, lang) {
  const p = model.ui.prepared; if (!p) return '';
  if (REVIEWER_ACTS.includes(p.action)) return '';   // the reviewer section shows its own confirmation card
  const s = p.summary || {};
  return block('prepared', `${p.action === 'submit' ? T('تأكيد الإرسال', 'Confirm submit') : T('تأكيد السحب', 'Confirm withdraw')}`,
    `<div class="kv"><div class="k">${T('المعرّف', 'Id')}</div><div class="v"><code>${esc(s.valuationId)}</code></div><div class="k">${T('التاريخ', 'Date')}</div><div class="v">${esc(s.valuationDate)}</div><div class="k">${T('الحالة', 'State')}</div><div class="v">${esc(s.state)}</div></div>`
    + `<p class="note">${T('تنبيه: الإرسال والسحب لا يحملان بصمة المحتوى على الخادم؛ هذا الفحص مجاملة ولا يمنع سباقًا على الخادم.', 'Note: submit and withdraw carry no content fingerprint on the server; this check is a courtesy and does not prevent a race on the server.')}</p>`
    + `${btn('fve-confirm-act', p.action === 'submit' ? T('أرسل', 'Submit') : T('اسحب', 'Withdraw'), { primary: true, attrs: `data-token="${esc(p.token)}"` })} ${btn('fve-cancel-prepare', T('إلغاء', 'Cancel'))}`, 'data-fve="prepared"');
}

/* ---------------- reviewer section (B2-3b): review / return / reject / approve ----------------
   Everything shown on the confirmation card comes from the PREPARED record (summary), never from the live view or the form: what is shown is what will be sent. */
/** Everything below is read from the PREPARED copy of the stored content (the one the fingerprint belongs to), never from the live view; every text goes through esc().
    A value is shown as text whatever its shape (an object is listed key by key, never "[object Object]"). */
const textOf = (v) => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v === '' ? '—' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch (e) { return '—'; }
};
const kvRow = (label, valueHtml) => `<div class="k" style="min-width:0;">${label}</div><div class="v" style="min-width:0; overflow-wrap:anywhere; word-break:break-word; text-align:start; direction:inherit; font-weight:400;">${valueHtml}</div>`;
const bdi = (v) => `<span dir="auto">${esc(textOf(v))}</span>`;
function contentRows(c, T) {
  if (!c || typeof c !== 'object') return '';
  const comp = c.components && typeof c.components === 'object' ? c.components : {};
  const NAMES = { assetsValue: T('قيمة الأصول', 'Assets value'), cashRetained: T('النقد المحتجز', 'Cash retained'), otherAssets: T('أصول أخرى', 'Other assets'), liabilities: T('الالتزامات', 'Liabilities'), distributionsPayable: T('توزيعات مستحقة غير مدفوعة', 'Distributions payable') };
  const scalar = Object.keys(comp).filter((k) => k !== 'otherAssetsItems');
  const items = Array.isArray(comp.otherAssetsItems) ? comp.otherAssetsItems : [];
  const itemsHtml = items.length ? `<ul data-fve="rv-items" style="margin:0; padding-inline-start:18px;">${items.map((it, i) => `<li data-fve="rv-item"><span dir="auto">${esc(textOf(it && it.description))}</span> — <b dir="ltr">${esc(textOf(it && it.amount))}</b></li>`).join('')}</ul>` : '—';
  const cov = c.coverage && typeof c.coverage === 'object' ? c.coverage : {}; const uh = cov.unlinkedHoldings && typeof cov.unlinkedHoldings === 'object' ? cov.unlinkedHoldings : {};
  const linked = Array.isArray(cov.linkedAssets) ? cov.linkedAssets : [];
  const uhItems = Array.isArray(uh.items) ? uh.items : [];
  const no = c.nonOverlap && typeof c.nonOverlap === 'object' ? c.nonOverlap : {};
  const NO_NAMES = { cashNotInAssets: T('النقد المحتجز غير داخل في قيمة الأصول', 'Cash retained is not inside the assets value'), otherAssetsNotInAssets: T('الأصول الأخرى غير داخلة في قيمة الأصول', 'Other assets are not inside the assets value'), assetsStatedGrossOfLiabilities: T('قيمة الأصول مذكورة إجمالية قبل الالتزامات', 'Assets value is stated gross of liabilities') };
  const note = textOf(c.methodNote);
  const noteHtml = note.length > 300 ? `<details data-fve="rv-note-full"><summary>${esc(note.slice(0, 120))}… <b>${T('(اقرأ الملاحظة كاملة)', '(read the full note)')}</b></summary><div dir="auto" style="white-space:pre-wrap; overflow-wrap:anywhere;">${esc(note)}</div></details>` : `<div dir="auto" style="white-space:pre-wrap; overflow-wrap:anywhere;" data-fve="rv-note">${esc(note)}</div>`;
  return `<div class="kv" data-fve="rv-content" style="display:grid; grid-template-columns:minmax(110px,max-content) minmax(0,1fr); gap:4px 12px; align-items:start;">`
    + kvRow(T('القيمة المتبقية', 'Residual value'), `<b dir="ltr" data-fve="rv-residual">${esc(textOf(c.residualValue))}</b> ${esc(textOf(c.currency))}`)
    + kvRow(T('الأساس', 'Basis'), `<span dir="ltr" data-fve="rv-basis">${esc(textOf(c.basis))}</span>`)
    + kvRow(T('المكوّنات', 'Components'), `<span data-fve="rv-components">${scalar.length ? scalar.map((k) => `${esc(NAMES[k] || k)}=<b dir="ltr">${esc(textOf(comp[k]))}</b>`).join(' · ') : '—'}</span>`)
    + kvRow(T('بنود «أصول أخرى»', '“Other assets” items'), itemsHtml)
    + kvRow(T('الطريقة', 'Method'), bdi(c.method)) + kvRow(T('ملاحظة الطريقة', 'Method note'), noteHtml)
    + kvRow(T('المصدر', 'Source'), `<span dir="auto" data-fve="rv-source">${esc(textOf(c.source && c.source.ref))} · ${esc(textOf(c.source && c.source.provider))}</span>`)
    + kvRow(T('إقرارات عدم التداخل', 'Non-overlap declarations'), `<ul data-fve="rv-nonoverlap" style="margin:0; padding-inline-start:18px;">${Object.keys(no).length ? Object.keys(no).map((k) => `<li>${no[k] === true ? '✔' : '✖'} ${esc(NO_NAMES[k] || k)} <code>${esc(textOf(no[k]))}</code></li>`).join('') : '<li>—</li>'}</ul>`)
    + kvRow(T('الأصول المرتبطة المغطّاة', 'Covered linked assets'), `<code dir="ltr" data-fve="rv-linked">${linked.length ? linked.map((x) => esc(textOf(x))).join(', ') : '—'}</code>`)
    + kvRow(T('أصول غير مرتبطة', 'Unlinked holdings'), `<span data-fve="rv-unlinked"><b>${esc(textOf(uh.declared))}</b>${uhItems.length ? `<ul style="margin:0; padding-inline-start:18px;">${uhItems.map((it) => `<li><span dir="auto">${esc(textOf(it && it.description))}</span> — <b dir="ltr">${esc(textOf(it && it.amount))}</b></li>`).join('')}</ul>` : ''}</span>`)
    + '</div>';
}
function renderReviewNotice(model, T, lang) {
  const n = model.ui && model.ui.notice; if (!n || !(String(n.action).startsWith('fve-rv') || (n.action === 'fve-confirm-act' && n.rv))) return '';
  return `<p class="note fve-banner" style="color:var(--bad);" data-fve="rv-notice" data-status="${esc(n.status)}">ℹ️ ${esc(n.status)} ${n.code ? why(n.code, lang) : ''}</p>`;
}
function renderReviewPrepared(model, T, lang) {
  const p = model.ui.prepared; const s = p.summary || {}; const act = p.action; const [ar, en] = ACT_LABEL[act];
  const pv = s.preview; let pvHtml = '';
  if (pv) {
    if (pv.status === 'done') pvHtml = `<p class="note" data-fve="rv-preview" data-status="done">🔎 ${T('فحص النسخة المخزّنة (مطابق لما يظهر)', 'Check of the stored version (matches what is shown)')}: ${pv.candidate ? esc(pv.candidate.status) + ' ' + (pv.candidate.reasonCodes || []).map((c) => `<code>${esc(c)}</code>`).join(' ') : '—'}</p>`;
    else if (pv.status === 'mismatch') pvHtml = `<p class="note" style="color:var(--bad);" data-fve="rv-preview" data-status="mismatch">⚠️ ${T('ردّ الفحص يخص نسخة أخرى غير المعروضة: لا يُعدّ فحصًا لهذا المحتوى ولا نتيجة له هنا. الخادم يتحقق من البصمة عند التنفيذ.', 'The check reply is about another version than the one shown: it is not a check of this content and no result is shown. The server verifies the fingerprint when it executes.')}</p>`;
    else if (pv.status === 'outdated') pvHtml = `<p class="note" data-fve="rv-preview" data-status="outdated">⚠️ ${T('الفحص قديم بعد تغيّر النسخة.', 'The check is outdated after the version changed.')}</p>`;
    else pvHtml = `<p class="note" data-fve="rv-preview" data-status="${esc(pv.status)}">🔎 ${esc(pv.status)}</p>`;
  } else pvHtml = `<p class="note" data-fve="rv-preview" data-status="none">${T('لم يُجرَ فحص للنسخة المخزّنة (اختياري).', 'No check of the stored version was made (optional).')}</p>`;
  const bound = !(p.limits && p.limits.notBoundToContent);
  const head = s.head ? `<div class="k">${T('الرأس الساري', 'Effective head')}</div><div class="v" style="min-width:0; overflow-wrap:anywhere; word-break:break-word; text-align:start; direction:inherit; font-weight:400;"><code>${esc(s.head.headId || '—')}</code> v${esc(s.head.version)} ${s.head.suspended ? `<b style="color:var(--bad);">${T('معلّق', 'suspended')}</b>` : ''}</div>` : '';
  const ackRow = act === 'approve' ? `<div class="k">${T('إقرار اعتماد بديل لنسخة معلّقة', 'Acknowledgement (replacing a suspended version)')}</div><div class="v" data-fve="rv-ack">${s.acknowledgeSuspended ? '✔ ' + T('نعم — سيُرسل', 'yes — will be sent') : T('لا يُرسل', 'not sent')}</div>` : '';
  const reasonRow = (act === 'review') ? '' : `<div class="k">${T('السبب (كما سيُرسل)', 'Reason (as it will be sent)')}</div><div class="v" style="min-width:0; overflow-wrap:anywhere; word-break:break-word; text-align:start; direction:inherit; font-weight:400; white-space:pre-wrap;" dir="auto" data-fve="rv-reason">${s.reason ? esc(s.reason) : '—'}</div>`;
  return block('prepared', `${T(`تأكيد: ${ar}`, `Confirm: ${en}`)}`,
    `<div class="kv" style="display:grid; grid-template-columns:minmax(110px,max-content) minmax(0,1fr); gap:4px 12px; align-items:start;"><div class="k">${T('المعرّف', 'Id')}</div><div class="v" style="min-width:0; overflow-wrap:anywhere; word-break:break-word; text-align:start; direction:inherit; font-weight:400;"><code>${esc(s.valuationId)}</code></div><div class="k">${T('التاريخ', 'Date')}</div><div class="v" style="min-width:0; overflow-wrap:anywhere; word-break:break-word; text-align:start; direction:inherit; font-weight:400;">${esc(s.valuationDate)}</div>`
    + `<div class="k">${T('الحالة', 'State')}</div><div class="v" style="min-width:0; overflow-wrap:anywhere; word-break:break-word; text-align:start; direction:inherit; font-weight:400;">${esc(s.state)} · rev ${esc(s.rev)}</div>`
    + `<div class="k">${T('البصمة', 'Fingerprint')}</div><div class="v" style="min-width:0; overflow-wrap:anywhere; word-break:break-word; text-align:start; direction:inherit; font-weight:400;" dir="ltr" data-fve="rv-hash"><code>${esc(s.contentHash)}</code> ${bound ? `<span class="note">${T('(يُرسل مع الطلب ويقيّد التنفيذ)', '(sent with the request; the server binds to it)')}</span>` : ''}</div>`
    + head + reasonRow + ackRow + '</div>' + contentRows(s.content, T) + pvHtml
    + (bound ? '' : `<p class="note" data-fve="rv-unbound">${T('تنبيه: هذا الإجراء لا يحمل بصمة المحتوى على الخادم؛ هذا الفحص مجاملة ولا يمنع سباقًا على الخادم.', 'Note: this action carries no content fingerprint on the server; this check is a courtesy and does not prevent a race on the server.')}</p>`)
    + `${btn('fve-confirm-act', T(ar, en), { primary: true, attrs: `data-token="${esc(p.token)}"` })} ${btn('fve-rv-edit', T('عدّل', 'Edit'))} ${btn('fve-rv-cancel', T('إلغاء', 'Cancel'))}`, 'data-fve="prepared" data-kind="review"');
}
function renderReviewer(st, model, T, lang) {
  if (!st.session || !REVIEWER_ROLES.includes(st.session.role) || !model.reader || !model.reader.hasDraft) return '';
  const rv = model.ui.rv; const rvInfo = st.review;
  const av = (a) => (st.available && st.available[a]) || { allowed: false, reason: 'NO_CONTEXT' };
  let body = `<div class="fve-actions" style="display:flex; flex-wrap:wrap; gap:6px; margin:8px 0;">`
    + REVIEWER_ACTS.map((a) => btn('fve-rv-open', T(`${ACT_LABEL[a][0]}…`, `${ACT_LABEL[a][1]}…`), { allowed: av(a).allowed, why: reasonOf(av(a).reason, lang), attrs: `data-act="${a}"` })).join('') + '</div>';
  if (rvInfo) body += `<p class="note" data-fve="rv-target">${T('التقييم الظاهر', 'Shown valuation')}: <code>${esc(rvInfo.valuationId)}</code> · ${esc(rvInfo.state)} · rev ${esc(rvInfo.rev)} · <code dir="ltr">${esc(rvInfo.contentHash)}</code></p>`;
  body += renderReviewNotice(model, T, lang);
  if (rv && model.ui.prepared && REVIEWER_ACTS.includes(model.ui.prepared.action)) body += renderReviewPrepared(model, T, lang);
  else if (rv) {
    const act = rv.act; const [ar, en] = ACT_LABEL[act]; const head = rvInfo && rvInfo.head;
    const suspended = act === 'approve' && head && head.ok && head.suspended;
    const reasonShown = act !== 'review';
    const required = ACT_NEEDS_REASON[act] || suspended;
    body += `<section data-fvp-section="reviewer" tabindex="-1" data-fve="rv-form" data-act="${esc(act)}">`
      + `<p class="step-sub" style="margin:4px 0;">${T(`${ar}: عن التقييم`, `${en}: valuation`)} <code>${esc(rvInfo && rvInfo.valuationId)}</code></p>`
      + (act === 'approve' && head && !head.ok ? `<p class="note" style="color:var(--bad);" data-fve="rv-head-unknown">⚠️ ${esc(reasonOf(head.reason, lang))} <code>${esc(head.reason)}</code></p>` : '')
      + (suspended ? `<p class="note" style="color:var(--bad);" data-fve="rv-suspended">⚠️ ${T('النسخة السارية معلّقة: الاعتماد البديل يتطلب إقرارًا وسببًا.', 'The effective version is suspended: approving a replacement needs an acknowledgement and a reason.')} <code>${esc(head.headId)}</code> v${esc(head.version)}</p>` : '')
      + (reasonShown ? `<div class="field"><label><span>${T('السبب', 'Reason')} ${required ? T('(إلزامي، حتى 1000 حرف)', '(required, up to 1000 characters)') : T('(اختياري)', '(optional)')}</span><textarea data-fve-rv="reason" ${FIELD}="rv.reason" rows="3" maxlength="1000" autocomplete="off" style="width:100%;" aria-label="${esc(T('السبب', 'Reason'))}">${esc(rv.reason)}</textarea></label></div>` : `<p class="note">${T('المراجعة لا تحمل سببًا.', 'A review carries no reason.')}</p>`)
      + (suspended ? `<label style="display:block;"><input type="checkbox" data-fve-rv="ack" ${FIELD}="rv.ack" ${rv.ack ? 'checked' : ''}> ${T('أُقرّ باعتماد بديل لنسخة معلّقة', 'I acknowledge approving a replacement of a suspended version')}</label>` : '')
      + `<div>${btn('fve-rv-prepare', T('جهّز التأكيد', 'Prepare confirmation'), { primary: true })} ${btn('fve-rv-cancel', T('إلغاء', 'Cancel'))}</div></section>`;
  }
  return block('reviewer', `🧑‍⚖️ ${T('إجراءات المراجعة', 'Review actions')}`, body, 'data-fve="reviewer"');
}

function renderPreview(st, T) {
  const p = st.preview; if (!p) return '';
  if (p.status === 'loading') return block('preview', `🔎 ${T('فحص النسخة المخزّنة', 'Checking the stored version')}`, `<p class="note">⏳ ${T('جارٍ الفحص…', 'Checking…')}</p>`, 'data-fve="preview"');
  const warn = p.unsavedEditsNotChecked ? `<p class="note" style="color:var(--bad);" data-fve="preview-unsaved">⚠️ ${T('الفحص يخص النسخة المخزّنة على الخادم فقط؛ تعديلاتك غير المحفوظة لم تُفحص.', 'The check covers the version STORED on the server only; your unsaved edits were not checked.')}</p>` : '';
  const head = `<p class="note">${T('فحص النسخة المخزّنة', 'Check of the stored version')} <code>${esc(p.storedContentHash)}</code></p>`;
  if (p.status === 'error') return block('preview', '🔎', head + `<p class="note">⛔ ${esc(p.error && p.error.message)}</p>` + warn, 'data-fve="preview"');
  if (p.status === 'outdated') return block('preview', '🔎', head + `<p class="note">⚠️ ${T('تغيّرت النسخة المخزّنة بعد الفحص — النتيجة قديمة.', 'The stored version changed after the check — the result is outdated.')}</p>` + warn, 'data-fve="preview"');
  if (p.status === 'mismatch') {
    const m = p.mismatch || {};
    return block('preview', '🔎', head + `<p class="note" style="color:var(--bad);" data-fve="preview-mismatch">⚠️ ${T('ردّ الفحص يخص نسخة أخرى غير المعروضة: لا يُعدّ فحصًا لهذا المحتوى ولا نتيجة له هنا. الخادم يتحقق من البصمة عند التنفيذ.', 'The check reply is about another version than the one shown: it is not a check of this content and no result is shown. The server verifies the fingerprint when it executes.')}</p>`
      + `<div class="kv"><div class="k">${T('البصمة المعروضة', 'Shown fingerprint')}</div><div class="v" dir="ltr"><code>${esc(textOf(m.shown))}</code></div><div class="k">${T('بصمة الرد', 'Reply fingerprint')}</div><div class="v" dir="ltr"><code>${esc(textOf(m.replied))}</code></div></div>` + warn, 'data-fve="preview" data-status="mismatch"');
  }
  if (p.status !== 'done' || !p.reply) return block('preview', '🔎', head + `<p class="note" data-fve="preview-other" data-status="${esc(p.status)}">${esc(p.status)}</p>` + warn, 'data-fve="preview"');   // no result fields for a state that has no result
  const r = p.reply || {}; const cand = r.candidate;
  return block('preview', '🔎', head + `<div class="kv"><div class="k">${T('اليوم عند الخادم', 'Server today')}</div><div class="v">${esc(r.today)}</div><div class="k">${T('التاريخ سليم', 'Date ok')}</div><div class="v">${esc(r.dateOk)}</div><div class="k">${T('قديمة (أساس الرأس)', 'Stale (head base)')}</div><div class="v">${esc(r.stale)}</div><div class="k">${T('تغيّر النطاق', 'Scope changed')}</div><div class="v">${esc(r.scopeChanged)}</div>`
    + (cand ? `<div class="k">${T('نتيجة المرشّح', 'Candidate')}</div><div class="v">${esc(cand.status)} ${(cand.reasonCodes || []).map((c) => `<code>${esc(c)}</code>`).join(' ')}</div>` : '') + '</div>' + warn, 'data-fve="preview"');
}

function renderIssues(ed, T, lang) {
  const parts = [];
  if ((ed.errors || []).length) parts.push(`<p class="note" style="color:var(--bad);" data-fve="errors"><b>${T('قيم لا يمكن إرسالها', 'Values that cannot be sent')}</b>: ${ed.errors.map((e) => `<code>${esc(e.path)}</code> ${why(e.code, lang)}`).join(' · ')}</p>`);
  if ((ed.issues || []).length) parts.push(`<details data-fve="issues"><summary class="note">${T('ما ينقص للإرسال', 'What is missing before submit')} (${esc(ed.issues.length)})</summary><ul style="margin:4px 0; padding-inline-start:18px;">${ed.issues.map((i) => `<li class="note"><code>${esc(i.code)}</code>${i.path ? ` <code>${esc(i.path)}</code>` : ''}${i.detail ? ` ${esc(clip(i.detail, 120))}` : ''}</li>`).join('')}</ul></details>`);
  else parts.push(`<p class="note" data-fve="ready">✅ ${T('المحتوى مكتمل شكليًا. الخادم هو الحَكَم.', 'The content is formally complete. The server decides.')}</p>`);
  return parts.join('');
}

function renderForm(st, ed, model, T, lang) {
  const f = ed.form; const saveKey = ed.mode === 'create' ? 'createDraft' : 'updateDraft'; const av = (st.available && st.available[saveKey]) || { allowed: false, reason: 'NO_CONTEXT' };
  const dayWhy = ed.frozen === 'crossed' ? 'DATE_CROSSED' : ed.frozen === 'future' ? 'DATE_IN_FUTURE' : ed.frozen ? 'DATE_INVALID' : '';   // availability is computed for today; THIS editor's own day decides here
  const saveOk = av.allowed && !dayWhy && !ed.conflict && !ed.goneFromView && (ed.errors || []).length === 0;
  const saveWhy = dayWhy || (!av.allowed ? av.reason : ed.conflict ? 'CONFLICT_UNRESOLVED' : ed.goneFromView ? 'DRAFT_GONE' : (ed.errors || []).length ? 'EDITOR_ERRORS' : '');
  const submit = (st.available && st.available.submit) || { allowed: false, reason: 'NO_CONTEXT' }; const wd = (st.available && st.available.withdraw) || { allowed: false, reason: 'NO_CONTEXT' };
  const comp = COMPONENT_KEYS.map((k) => textInput(ed, `components.${k}`, { assetsValue: T('قيمة الأصول', 'Assets value'), cashRetained: T('النقد المحتجز', 'Cash retained'), otherAssets: T('أصول أخرى', 'Other assets'), liabilities: T('الالتزامات', 'Liabilities'), distributionsPayable: T('توزيعات مستحقة غير مدفوعة', 'Distributions payable') }[k], f.components[k])).join('');
  const formHtml = `<form data-fve="form" onsubmit="return false" autocomplete="off">`
    + `<p class="note">${T('العملة', 'Currency')}: <b>SAR</b> · ${T('الأساس', 'Basis')}: <b>RESIDUAL_VALUE_AS_OF_DATE</b> (${T('ثابتان', 'fixed')})</p>`
    + comp
    + `<p class="step-sub" style="margin:6px 0 2px;">${T('بنود «أصول أخرى»', '“Other assets” items')}</p>${itemRows(ed, 'otherAssetsItems', f.otherAssetsItems, 'otherAssetsItems', T)}`
    + textInput(ed, 'residualValue', T('القيمة المتبقية (تُكتب يدويًا)', 'Residual value (typed)'), f.residualValue) + renderFormula(ed, T)
    + `<div class="field"><label><span>${T('الطريقة', 'Method')}</span><select data-fve-path="method" ${FIELD}="method"><option value="">—</option>${METHODS.map((m) => `<option value="${esc(m)}" ${f.method === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>${errFor(ed, 'method')}</div>`
    + textInput(ed, 'methodNote', T('ملاحظة الطريقة', 'Method note'), f.methodNote, { multiline: true, ltr: false })
    + textInput(ed, 'source.ref', T('مرجع المصدر', 'Source reference'), f.source.ref, { ltr: false }) + textInput(ed, 'source.provider', T('مزوّد المصدر', 'Source provider'), f.source.provider, { ltr: false })
    + `<fieldset style="margin:8px 0; border:1px solid var(--border);"><legend class="note">${T('عدم التداخل (إقرارات)', 'Non-overlap (declarations)')}</legend>${NON_OVERLAP_KEYS.map((k) => `<label style="display:block;"><input type="checkbox" data-fve-path="nonOverlap.${k}" ${FIELD}="nonOverlap.${k}" ${f.nonOverlap[k] ? 'checked' : ''}> ${esc({ cashNotInAssets: T('النقد المحتجز غير داخل في قيمة الأصول', 'Cash retained is not inside the assets value'), otherAssetsNotInAssets: T('الأصول الأخرى غير داخلة في قيمة الأصول', 'Other assets are not inside the assets value'), assetsStatedGrossOfLiabilities: T('قيمة الأصول مذكورة إجمالية قبل الالتزامات', 'Assets value is stated gross of liabilities') }[k])}</label>`).join('')}</fieldset>`
    + renderCoverage(ed, T) + '</form>';
  const buttons = `<div class="fve-actions" style="display:flex; flex-wrap:wrap; gap:6px; margin:8px 0;">`
    + btn('fve-save', ed.mode === 'create' ? T('احفظ كمسودة جديدة', 'Save as a new draft') : T('احفظ التعديلات', 'Save changes'), { allowed: saveOk, why: reasonOf(saveWhy, lang), primary: true })
    + btn('fve-prepare', T('إرسال…', 'Submit…'), { allowed: submit.allowed, why: reasonOf(submit.reason, lang), attrs: 'data-act="submit"' })
    + btn('fve-prepare', T('سحب…', 'Withdraw…'), { allowed: wd.allowed, why: reasonOf(wd.reason, lang), attrs: 'data-act="withdraw"' })
    + btn('fve-check-now', T('افحص الآن (النسخة المخزّنة)', 'Check now (stored version)'), { allowed: model.checkAllowed, why: reasonOf(model.checkWhy, lang) })
    + btn('fve-close', T('أغلق المحرّر', 'Close editor'))
    + `</div><p class="note">${ed.dirty ? `✏️ ${T('تعديلات غير محفوظة', 'Unsaved edits')}: ${esc(ed.dirtyPaths.length)}` : T('لا تعديلات غير محفوظة.', 'No unsaved edits.')}</p>`;
  const closing = model.ui.confirm && model.ui.confirm.kind === 'close'
    ? block('close', '', `<p class="note">${T('سيُحذف إدخالك غير المحفوظ. متابعة؟', 'Your unsaved input will be deleted. Continue?')}</p>${btn('fve-close-confirm', T('نعم، أغلق وتجاهل', 'Yes, close and discard'), { primary: true })} ${btn('fve-close-cancel', T('تراجع', 'Back'))}`, 'data-fve="close-confirm"') : '';
  const discarding = model.ui.confirm && model.ui.confirm.kind === 'discard-mine'
    ? block('close', '', `<p class="note">${T('سيُحذف إدخالك غير المحفوظ ويُحمَّل ما على الخادم. متابعة؟', 'Your unsaved input will be deleted and the server version loaded. Continue?')}</p>${btn('fve-resolve-confirm', T('نعم، تجاهل تعديلاتي', 'Yes, discard my changes'), { primary: true })} ${btn('fve-resolve-cancel', T('تراجع', 'Back'))}`, 'data-fve="discard-confirm"') : '';
  return renderCopyReview(ed, T) + renderConflict(ed, T) + closing + discarding + `<section data-fvp-section="editor" tabindex="-1" id="fve-editor" data-fve="editor" data-mode="${esc(ed.mode)}">${formHtml}</section>` + renderIssues(ed, T, lang) + buttons;
}

/** @returns {string} HTML ('' when there is nothing to show: no session / no read role) */
export function renderEditor(model, ctx = {}) {
  const T = typeof ctx.T === 'function' ? ctx.T : (ar) => ar;
  const lang = T('ar', 'en') === 'en' ? 'en' : 'ar';
  const st = model && model.state; if (!st || !st.session) return '';
  model.ui = model.ui || {};
  const ed = st.editor; const scopeDate = st.scope ? st.scope.valuationDate : null;
  model.scopeDate = scopeDate;
  const writer = ['fund_manager', 'admin'].includes(st.session.role);
  let body = '';
  const pinnedNote = model.pinnedDate && model.reader && model.reader.selectedDate && model.pinnedDate !== model.reader.selectedDate
    ? `<p class="note" data-fve="pinned">📌 ${T(`المحرّر مثبَّت على تاريخ ${model.pinnedDate} ولا يتبع التاريخ المعروض أعلاه (${model.reader.selectedDate}).`, `The editor is pinned to ${model.pinnedDate} and does not follow the date shown above (${model.reader.selectedDate}).`)}</p>` : '';
  const readBar = `<p class="note" data-fve="readbar">${model.reader && model.reader.read && model.reader.read.confirmed ? '🟢' : '🟡'} ${T('قراءة الخادم', 'Server read')}: ${model.reader && model.reader.read && model.reader.read.confirmed ? T('مؤكَّدة', 'confirmed') : T('غير مؤكَّدة', 'not confirmed')}${model.reader && model.reader.read && model.reader.read.inFlight > 0 ? ` · ⏳ ${T('جارية', 'in progress')}` : ''} ${btn('fve-refresh', T('تحقق من الخادم الآن', 'Check the server now'), { allowed: !!(model.refresh && model.refresh.allowed), why: reasonOf(model.refresh && model.refresh.reason, lang) })}</p>`;
  body += readBar + pinnedNote + renderStatusBanners(st, model.ui, model, T, lang) + renderPending(model, T, lang) + renderDay(st, ed, model, T);
  if (!writer) body += `<p class="note" data-fve="read-only">🔒 ${REVIEWER_ROLES.includes(st.session.role) ? T('دورك لا يكتب المسودات؛ إجراءات المراجعة متاحة أدناه بحسب حالة التقييم.', 'Your role does not write drafts; review actions are below, by valuation state.') : T('دورك يقرأ التقييمات فقط؛ لا إجراءات كتابة.', 'Your role only reads valuations; no write actions.')}</p>`;
  if (!ed) {
    const create = (st.available && st.available.createDraft) || { allowed: false, reason: 'NO_CONTEXT' };
    const copy = model.reader && model.reader.copySource;
    body += `<div class="fve-actions" style="display:flex; flex-wrap:wrap; gap:6px; margin:8px 0;">`
      + btn('fve-create', T('مسودة جديدة (اليوم)', 'New draft (today)'), { allowed: writer && create.allowed, why: reasonOf(writer ? create.reason : 'ROLE_NOT_ALLOWED', lang), primary: true })
      + (model.reader && model.reader.hasDraft ? btn('fve-open-draft', T('افتح المسودة الجارية للتحرير', 'Open the current draft for editing'), { allowed: writer }) : '')
      + (copy && canServerCopy(copy.state) ? btn('fve-copy', T('انسخ كمسودة جديدة لليوم', 'Copy as a new draft for today'), { allowed: writer && create.allowed, why: reasonOf(create.reason, lang), attrs: `data-source-id="${esc(copy.id)}" data-source-state="${esc(copy.state)}"` }) : '')
      + (model.reader && model.reader.hasDraft ? btn('fve-check-now', T('افحص الآن (النسخة المخزّنة)', 'Check now (stored version)'), { allowed: model.checkAllowed, why: reasonOf(model.checkWhy, lang) }) : '')
      + '</div>' + renderPrepared(model, T, lang) + renderReviewer(st, model, T, lang) + renderPreview(st, T);
  } else body += renderPrepared(model, T, lang) + renderReviewer(st, model, T, lang) + renderPreview(st, T) + renderForm(st, ed, model, T, lang);
  return `<div class="panel fve" data-fve="root" data-scope-date="${esc(scopeDate)}" style="margin-top:14px;"><div class="panel-head"><h3 style="font-size:14px;">✏️ ${T('محرّر تقييم القيمة المتبقية', 'Residual valuation editor')}${scopeDate ? ` <span class="note">${esc(scopeDate)}</span>` : ''}</h3></div>${body}</div>`;
}
