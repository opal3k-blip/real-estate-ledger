/* XIRR-R1B2 / B2-0 — fund residual-valuation UI model (pure: no DOM, no Firebase, no XIRR import).
   Contract: docs/XIRR_RESIDUAL_VALUATION_UI_CONTRACT.md
   The SERVER is the authority for authorization and validation (functions/fund-valuations.cjs). Everything here is user
   experience: hiding buttons, building payloads exactly as the server's allow-list expects, describing server refusals,
   and detecting that what the user saw is no longer what the server holds. Nothing here is a security control. */
import { documentHashHex } from '../domain/validation/document-hash.js';

/* ---------- roles: explicit literal lists, written by hand (NOT hierarchical, NOT roles-permissions.js) ---------- */
export const READ_ROLES = Object.freeze(['fund_manager', 'senior_ic', 'admin']);
export const ACTION_ROLES = Object.freeze({
  createDraft: Object.freeze(['fund_manager', 'admin']),
  updateDraft: Object.freeze(['fund_manager', 'admin']),
  submit: Object.freeze(['fund_manager', 'admin']),
  withdraw: Object.freeze(['fund_manager', 'admin']),
  review: Object.freeze(['senior_ic', 'admin']),
  returnDraft: Object.freeze(['senior_ic', 'admin']),
  reject: Object.freeze(['senior_ic', 'admin']),
  approve: Object.freeze(['senior_ic', 'admin']),
  suspend: Object.freeze(['senior_ic', 'admin']),
  reinstate: Object.freeze(['senior_ic', 'admin']),
  preview: Object.freeze(['fund_manager', 'senior_ic', 'admin']),
});
export const ACTIONS = Object.freeze(Object.keys(ACTION_ROLES));
export function roleCanDo(action, role) {
  return Object.prototype.hasOwnProperty.call(ACTION_ROLES, action) && ACTION_ROLES[action].includes(role);
}
export function canRead(role) { return READ_ROLES.includes(role); }

/* ---------- callables and payload spec (mirror of ALLOWED_KEYS on the server; parity-tested) ---------- */
export const CALLABLES = Object.freeze({
  createDraft: 'createValuationDraft', updateDraft: 'updateValuationDraft', submit: 'submitValuation',
  review: 'reviewValuation', returnDraft: 'returnValuation', reject: 'rejectValuation', withdraw: 'withdrawValuation',
  approve: 'approveValuation', suspend: 'suspendValuationEligibility', reinstate: 'reinstateValuationEligibility',
  preview: 'getValuationPreview',
});
export const PAYLOAD_SPEC = Object.freeze({
  createDraft: { required: ['requestId', 'fundId', 'valuationDate'], optional: ['content', 'copyFromValuationId'] },
  updateDraft: { required: ['requestId', 'valuationId', 'expectedContentHash', 'content'], optional: [] },
  submit: { required: ['requestId', 'valuationId'], optional: [] },
  review: { required: ['requestId', 'valuationId', 'expectedContentHash'], optional: [] },
  returnDraft: { required: ['requestId', 'valuationId', 'reason'], optional: [] },
  reject: { required: ['requestId', 'valuationId', 'reason'], optional: [] },
  withdraw: { required: ['requestId', 'valuationId'], optional: [] },
  approve: { required: ['requestId', 'valuationId', 'expectedContentHash'], optional: ['acknowledgeSuspended', 'reason'] },
  suspend: { required: ['requestId', 'fundId', 'valuationDate', 'expectedHeadId', 'reason'], optional: [] },
  reinstate: { required: ['requestId', 'fundId', 'valuationDate', 'expectedHeadId', 'reason'], optional: [] },
  preview: { required: ['valuationId'], optional: [] },
});
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_REASON = 1000;

/** Independent deep copy (structuredClone, JSON fallback). Used so a payload can never share nested objects with the caller. */
export function deepClone(v) {
  if (v === undefined) return undefined;
  try { return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); } catch (e) { throw bad('PAYLOAD_INVALID', 'value cannot be copied (functions or cycles are not allowed)'); }
}
function bad(code, message) { const e = new Error(message || code); e.clientCode = code; return e; }
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

/** Builds the payload of ONE callable from the given fields. Only keys the server accepts are ever emitted; a field the
    server would reject with PAYLOAD_UNKNOWN_FIELD is refused here (throws clientCode PAYLOAD_UNKNOWN_FIELD). Optional
    fields that are undefined are omitted; acknowledgeSuspended is emitted only when exactly true. */
export function buildPayload(action, fields) {
  const spec = PAYLOAD_SPEC[action];
  if (!spec) throw bad('ACTION_UNKNOWN', `Unknown action: ${action}`);
  if (!isPlain(fields)) throw bad('PAYLOAD_INVALID', 'fields must be an object');
  fields = deepClone(fields); // from here on nothing aliases the caller's objects
  const all = [...spec.required, ...spec.optional];
  const unknown = Object.keys(fields).filter((k) => fields[k] !== undefined && !all.includes(k));
  if (unknown.length) throw bad('PAYLOAD_UNKNOWN_FIELD', `Unknown field(s) for ${action}: ${unknown.join(', ')}`);
  const out = {};
  for (const k of spec.required) {
    if (fields[k] === undefined || fields[k] === null) {
      if (action === 'createDraft' && k === 'content') continue;
      throw bad('PAYLOAD_MISSING', `${action}: ${k} is required`);
    }
    out[k] = fields[k];
  }
  for (const k of spec.optional) if (fields[k] !== undefined && fields[k] !== null) out[k] = fields[k];
  if (action === 'approve') {
    if (fields.acknowledgeSuspended !== undefined && typeof fields.acknowledgeSuspended !== 'boolean') throw bad('ACK_INVALID', 'acknowledgeSuspended must be boolean');
    if (fields.acknowledgeSuspended !== true) delete out.acknowledgeSuspended;
  }
  if (action === 'createDraft' && out.content === undefined && out.copyFromValuationId === undefined) throw bad('PAYLOAD_MISSING', 'createDraft: content or copyFromValuationId is required');
  if (out.requestId !== undefined && !REQUEST_ID_RE.test(out.requestId)) throw bad('REQUEST_ID_INVALID', 'requestId must be 8-64 characters of A-Z a-z 0-9 _ -');
  for (const k of ['fundId', 'valuationId', 'expectedHeadId', 'copyFromValuationId']) {
    if (out[k] !== undefined && (typeof out[k] !== 'string' || !ID_RE.test(out[k]) || out[k].includes('__'))) throw bad('ID_INVALID', `${k} is invalid`);
  }
  if (out.expectedContentHash !== undefined && !HASH_RE.test(out.expectedContentHash)) throw bad('HASH_INVALID', 'expectedContentHash must be a 64-character hex digest');
  if (out.valuationDate !== undefined && classifyDate(out.valuationDate, '1970-01-01') === 'invalid') throw bad('DATE_INVALID', 'valuationDate must be a real calendar date');
  if (out.reason !== undefined && (!isStr(out.reason) || out.reason.length > MAX_REASON)) throw bad('REASON_REQUIRED', `reason must be 1-${MAX_REASON} characters`);
  if (out.content !== undefined && !isPlain(out.content)) throw bad('CONTENT_INVALID', 'content must be an object');
  return out;
}

/* ---------- dates (Asia/Riyadh is fixed UTC+3, no DST) ---------- */
export function riyadhDay(now) {
  const ms = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(ms)) throw new Error('riyadhDay: invalid instant');
  return new Date(ms + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
export function isRealIsoDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** 'today' | 'crossed' (before today) | 'future' | 'invalid'. Three different situations, three different messages. */
export function classifyDate(valuationDate, today) {
  if (!isRealIsoDay(valuationDate) || !isRealIsoDay(today)) return 'invalid';
  if (valuationDate === today) return 'today';
  return valuationDate < today ? 'crossed' : 'future';
}
const DATE_REASON = { crossed: 'DATE_CROSSED', future: 'DATE_IN_FUTURE', invalid: 'DATE_INVALID' };

/* ---------- which actions the UI offers (hints only; the server decides) ---------- */
const ACTIVE = ['draft', 'returned', 'submitted', 'reviewed'];
const DAY_CHECKED = new Set(['updateDraft', 'submit', 'review', 'approve']); // the server's requireDay actions
const REVIEWER_PERSON = new Set(['review', 'returnDraft', 'reject', 'approve']);
const lc = (s) => (typeof s === 'string' ? s.toLowerCase() : '');
const isContributor = (v, email) => Array.isArray(v && v.contributors) && v.contributors.includes(lc(email));

const yes = () => ({ allowed: true, reason: null });
const no = (reason) => ({ allowed: false, reason });

/** @param {{role:string,email:string,today:string,valuation?:object,head?:object,headValuation?:object,stale?:boolean}} c
    valuation: a draft-lifecycle document; head: the head document of its (fund,date); headValuation: the approved document the head names;
    stale: the viewer knows the draft's base head/scope changed (allows re-submitting a submitted/reviewed draft). */
export function availableActions(c) {
  const out = {};
  const { role, email, today, valuation: v, head, headValuation, stale } = c || {};
  for (const a of ACTIONS) out[a] = no('NO_TARGET');
  const roleGate = (a) => (roleCanDo(a, role) ? null : 'ROLE_NOT_ALLOWED');

  if (v) {
    const dateKind = classifyDate(v.valuationDate, today);
    for (const a of ['updateDraft', 'submit', 'withdraw', 'review', 'returnDraft', 'reject', 'approve']) {
      let r = roleGate(a);
      if (!r && DAY_CHECKED.has(a) && dateKind !== 'today') r = DATE_REASON[dateKind];
      if (!r && (a === 'submit' || a === 'withdraw') && !isContributor(v, email)) r = 'NOT_A_CONTRIBUTOR';
      if (!r && REVIEWER_PERSON.has(a) && isContributor(v, email)) r = a === 'approve' ? 'CONTRIBUTOR_CANNOT_APPROVE' : 'CONTRIBUTOR_CANNOT_REVIEW';
      if (!r && a === 'approve' && lc(v.enteredBy) === lc(email)) r = 'CONTRIBUTOR_CANNOT_APPROVE';
      if (!r) {
        const s = v.state;
        const okState = a === 'updateDraft' ? ['draft', 'returned'].includes(s)
          : a === 'submit' ? (['draft', 'returned'].includes(s) || (['submitted', 'reviewed'].includes(s) && stale === true))
          : a === 'withdraw' ? ACTIVE.includes(s)
          : a === 'review' ? s === 'submitted'
          : a === 'returnDraft' ? ['submitted', 'reviewed'].includes(s)
          : a === 'reject' ? ['submitted', 'reviewed', 'returned'].includes(s) // NOT draft
          : s === 'reviewed';
        if (!okState) r = (a === 'submit' && ['submitted', 'reviewed'].includes(s)) ? 'ALREADY_SUBMITTED' : 'INVALID_STATE';
      }
      out[a] = r ? no(r) : yes();
    }
  }
  if (head && head.headId) {
    const susp = head.eligibility && head.eligibility.state === 'SUSPENDED';
    let r = roleGate('suspend');
    if (!r && susp) r = 'ALREADY_SUSPENDED';
    out.suspend = r ? no(r) : yes();
    r = roleGate('reinstate');
    if (!r && !susp) r = 'NOT_SUSPENDED';
    if (!r && head.eligibility && lc(head.eligibility.changedBy) === lc(email)) r = 'SUSPENDER_CANNOT_RESTORE';
    if (!r && headValuation && (isContributor(headValuation, email) || lc(headValuation.approvedBy) === lc(email))) r = 'CONTRIBUTOR_CANNOT_REINSTATE';
    out.reinstate = r ? no(r) : yes();
  } else {
    out.suspend = no('NO_HEAD'); out.reinstate = no('NO_HEAD');
  }
  // creation: today only (B1), one active draft per (fund, date)
  {
    const dateKind = classifyDate(c && c.createDate !== undefined ? c.createDate : today, today);
    let r = roleGate('createDraft');
    if (!r && dateKind !== 'today') r = DATE_REASON[dateKind];
    if (!r && head && head.activeDraftId) r = 'ACTIVE_DRAFT_EXISTS';
    out.createDraft = r ? no(r) : yes();
  }
  { const r = roleGate('preview'); out.preview = r ? no(r) : yes(); }
  return out;
}

/* ---------- what the user saw vs what the server holds now ---------- */
const SNAP_KEYS = ['fundId', 'valuationDate', 'valuationId', 'contentHash', 'scopeHash', 'baseHeadId', 'rev', 'state', 'headId', 'headHash', 'eligibilityState', 'today'];
export function snapshotOf({ valuation, head, today } = {}) {
  const v = valuation || {}; const h = head || {};
  return {
    fundId: v.fundId ?? h.fundId ?? null, valuationDate: v.valuationDate ?? h.valuationDate ?? null,
    valuationId: v.valuationId ?? null, contentHash: v.contentHash ?? null, scopeHash: v.scopeHash ?? null,
    baseHeadId: v.baseHeadId ?? null, rev: v.rev ?? null, state: v.state ?? null,
    headId: h.headId ?? null, headHash: h.headHash ?? null,
    eligibilityState: (h.eligibility && h.eligibility.state) || null, today: today ?? null,
  };
}
export function diffSnapshots(a, b) { return SNAP_KEYS.filter((k) => (a ? a[k] : null) !== (b ? b[k] : null)); }
/** Which fields each action is BOUND to by the server (see contract §3). Actions with an empty list are NOT bound server-side. */
export const SERVER_BINDING = Object.freeze({
  createDraft: [], updateDraft: ['contentHash'], submit: [], review: ['contentHash'], returnDraft: [], reject: [], withdraw: [],
  approve: ['contentHash'], suspend: ['headId'], reinstate: ['headId'], preview: [],
});
/** UI-side check only: any change in what was viewed disables the action; for actions without a server binding this is
    a courtesy, NOT a guarantee (contract §6.1). */
export function bindingStatus(viewed, current) {
  const changed = diffSnapshots(viewed, current);
  return { same: changed.length === 0, changed };
}

/* ---------- headHash consistency (consistency check only; NOT proof of the valuation's financial correctness) ---------- */
export async function verifyHeadConsistency(head, approvedDoc, hashFn = documentHashHex) {
  try {
    if (!head || !head.headId || typeof head.headHash !== 'string') return { ok: false, reason: 'HEAD_INCOMPLETE' };
    if (!approvedDoc || approvedDoc.state !== 'approved') return { ok: false, reason: 'HEAD_DOC_NOT_APPROVED' };
    if (approvedDoc.valuationId !== head.headId) return { ok: false, reason: 'HEAD_DOC_MISMATCH' };
    if (approvedDoc.version !== head.version) return { ok: false, reason: 'HEAD_VERSION_MISMATCH' };
    const h = await hashFn({ valuationId: approvedDoc.valuationId, version: approvedDoc.version, contentHash: approvedDoc.contentHash, approvedBy: approvedDoc.approvedBy });
    return h === head.headHash ? { ok: true, reason: null } : { ok: false, reason: 'HEAD_HASH_MISMATCH' };
  } catch (e) {
    return { ok: false, reason: 'HEAD_UNVERIFIABLE' }; // e.g. no WebCrypto: fail closed
  }
}

/* ---------- errors ---------- */
export function normalizeFunctionsErrorCode(code) {
  if (typeof code !== 'string') return null;
  return code.startsWith('functions/') ? code.slice('functions/'.length) : code;
}
/** Messages for EVERY reason code the server can emit (extracted from the source by the test) plus client-only codes. */
export const MESSAGES = Object.freeze({
  ACK_INVALID: ['قيمة الإقرار غير صالحة', 'The acknowledgement value is invalid'],
  ACTIVE_DRAFT_EXISTS: ['توجد مسودة نشطة لهذا الصندوق والتاريخ', 'An active draft already exists for this fund and date'],
  ALREADY_APPROVED: ['هذا التقييم معتمد بالفعل', 'This valuation is already approved'],
  ALREADY_SUBMITTED: ['التقييم مقدَّم بالفعل ولم تتغير أساساته', 'The valuation is already submitted and its basis is unchanged'],
  ALREADY_SUSPENDED: ['النسخة السارية معلّقة بالفعل', 'The effective version is already suspended'],
  APPROVAL_VALIDATION_FAILED: ['فشل التحقق عند الاعتماد', 'Validation failed at approval'],
  CONTENT_CHANGED: ['تغيّر المحتوى منذ فتحته؛ راجع الفروق', 'The content changed since you opened it; review the differences'],
  CONTENT_HASH_MISMATCH: ['بصمة المحتوى لا تطابق المخزَّن', 'The content fingerprint does not match the stored one'],
  CONTENT_INVALID: ['المحتوى غير صالح', 'The content is invalid'],
  CONTENT_TOO_LARGE: ['المحتوى كبير جدًا', 'The content is too large'],
  CONTENT_UNKNOWN_FIELD: ['المحتوى يحوي حقلًا غير معروف', 'The content contains an unknown field'],
  CONTENT_UNSAFE: ['بنية المحتوى غير آمنة', 'The content structure is unsafe'],
  CONTRIBUTOR_CANNOT_APPROVE: ['المساهم أو المُعِدّ لا يعتمد هذا التقييم (الأدمن غير مستثنى)', 'A contributor or the preparer may not approve (admin is not exempt)'],
  CONTRIBUTOR_CANNOT_REINSTATE: ['مساهم النسخة أو معتمدها لا يعيد أهليتها', 'A contributor or the approver of the version may not reinstate it'],
  CONTRIBUTOR_CANNOT_REVIEW: ['مساهم المسودة لا يراجعها ولا يرفضها ولا يعيدها', 'A contributor of the draft may not review, return or reject it'],
  COPY_SOURCE_MISMATCH: ['مصدر النسخ لا يخص هذا الصندوق', 'The copy source does not belong to this fund'],
  COPY_SOURCE_STATE: ['حالة مصدر النسخ لا تسمح بالنسخ', 'The copy source state does not allow copying'],
  DATE_CROSSED: ['عبر اليوم: تاريخ هذا التقييم أقدم من يوم الرياض الحالي. اسحبه أو ارفضه وأنشئ مسودة اليوم', 'The day has passed: this valuation is dated before today (Riyadh). Withdraw or reject it and create a draft for today'],
  DATE_IN_FUTURE: ['تاريخ مستقبلي: لا يجوز تأريخ التقييم بعد اليوم (الرياض)', 'Future date: a valuation cannot be dated after today (Riyadh)'],
  DATE_INVALID: ['تاريخ غير صالح', 'Invalid date'],
  FUND_NOT_FOUND: ['الصندوق غير موجود', 'Fund not found'],
  HASH_INVALID: ['البصمة غير صالحة', 'The fingerprint is invalid'],
  HEAD_POINTER_INCONSISTENT: ['مؤشر الرأس غير متسق مع السلسلة المعتمدة', 'The head pointer is inconsistent with the approved chain'],
  ID_INVALID: ['المعرّف غير صالح', 'The identifier is invalid'],
  INVALID_STATE: ['حالة التقييم الحالية لا تسمح بهذا الإجراء', 'The current valuation state does not allow this action'],
  MEMBERSHIP_EXPIRED: ['انتهت عضويتك في الفريق', 'Your team membership has expired'],
  MEMBERSHIP_REQUIRED: ['لست عضوًا مخوَّلًا في الفريق', 'You are not an authorized team member'],
  NOT_A_CONTRIBUTOR: ['المساهم في المسودة وحده يقدّمها أو يسحبها', 'Only a contributor of the draft may submit or withdraw it'],
  NOT_SUSPENDED: ['النسخة السارية غير معلّقة', 'The effective version is not suspended'],
  NO_HEAD: ['لا يوجد تقييم معتمد لهذا الصندوق والتاريخ', 'There is no approved valuation for this fund and date'],
  PAYLOAD_INVALID: ['حمولة الطلب غير صالحة', 'The request payload is invalid'],
  PAYLOAD_UNKNOWN_FIELD: ['الطلب يحوي حقلًا غير مسموح', 'The request contains a disallowed field'],
  REASON_REQUIRED: ['السبب إلزامي (حتى 1000 حرف)', 'A reason is required (up to 1000 characters)'],
  REQUEST_ID_INVALID: ['معرّف الطلب غير صالح', 'The request id is invalid'],
  REQUEST_ID_REUSED: ['معرّف الطلب استُخدم لطلب مختلف', 'The request id was already used for a different request'],
  REVIEW_NOT_CURRENT: ['المراجعة المسجّلة لا تغطي المحتوى أو الأساس أو النطاق الحاليّ', 'The recorded review does not cover the current content, base or scope'],
  ROLE_NOT_ALLOWED: ['دورك الحالي لا يسمح بهذا الإجراء', 'Your current role does not allow this action'],
  SCOPE_CHANGED: ['تغيّر نطاق الصندوق أو الأصول؛ يلزم إعادة التقديم', 'The fund/asset scope changed; re-submission is required'],
  SLOT_INCONSISTENT: ['خانة المسودة غير متسقة', 'The draft slot is inconsistent'],
  STALE_HEAD: ['تغيّر الرأس الساري منذ عرضك أو منذ بناء المسودة', 'The effective head changed since you viewed it or since the draft was based on it'],
  SUSPENDED_ACK_REQUIRED: ['النسخة السارية معلّقة: الاعتماد البديل يتطلب إقرارًا وسببًا', 'The effective version is suspended: approving a replacement needs an acknowledgement and a reason'],
  SUSPENDER_CANNOT_RESTORE: ['من علّق النسخة لا يعيد أهليتها', 'The person who suspended the version may not restore it'],
  VALIDATION_FAILED: ['فشل التحقق من المحتوى', 'Content validation failed'],
  VALUATION_NOT_FOUND: ['التقييم غير موجود', 'Valuation not found'],
  // client-only codes
  LOCKED_OTHER_TAB: ['إجراء آخر لهذا الصندوق والتاريخ قيد التنفيذ في تبويب آخر؛ لم يُرسل شيء', 'Another action for this fund and date is running in another tab; nothing was sent'],
  PENDING_EXISTS: ['يوجد طلب غير محسوم لهذا الصندوق والتاريخ؛ أعد المحاولة أو تجاهله أولًا', 'An unresolved request exists for this fund and date; retry or discard it first'],
  UNRESOLVED_PERMISSION: ['لم يُحسم: صلاحيتك الآن لا تسمح بتأكيد نتيجة طلبك السابق', 'Unresolved: your current permissions do not allow confirming the outcome of your earlier request'],
  PENDING_CORRUPT: ['سجل طلب معلّق تالف؛ لا يمكن إعادته، يمكن تجاهله بإقرار', 'A pending request record is corrupt; it cannot be retried, only discarded with acknowledgement'],
  SIGNATURE_MISMATCH: ['الطلب المخزَّن لا يطابق توقيعه؛ لم يُرسل', 'The stored request does not match its signature; nothing was sent'],
  ACK_REQUIRED: ['التجاهل يتطلب إقرارًا بأن الأثر قد يكون موجودًا', 'Discarding requires acknowledging that the effect may already exist'],
  SESSION_CHANGED: ['تبدّلت الجلسة أثناء التنفيذ؛ لم يُرسل شيء', 'The session changed while preparing; nothing was sent'],
  STORAGE_UNREADABLE: ['تعذّرت قراءة الطلبات المعلّقة؛ لا يمكن معرفة إن كان هناك طلب سابق، فتُحجب الإجراءات المعدِّلة', 'Pending requests could not be read, so an earlier request cannot be ruled out; modifying actions are blocked'],
  STORAGE_UNAVAILABLE: ['التخزين المشترك بين التبويبات غير متاح للقراءة والكتابة؛ الإجراءات المعدِّلة معطّلة والعرض مستمر', 'Shared storage is not readable/writable; modifying actions are disabled, viewing continues'],
  STORAGE_WRITE_FAILED: ['تعذّر حفظ الطلب قبل إرساله؛ لم يُرسل شيء', 'The request could not be saved before sending; nothing was sent'],
  NO_RELIABLE_LOCK: ['لا يتوفر قفل موثوق بين التبويبات (Web Locks)؛ الإجراءات المعدِّلة معطّلة والعرض مستمر', 'No reliable cross-tab lock (Web Locks) is available; modifying actions are disabled, viewing continues'],
  NO_SESSION: ['لا توجد جلسة مستخدم صالحة', 'There is no valid user session'],
  SCOPE_MISMATCH: ['نطاق الطلب لا يطابق الصندوق/التاريخ في الحمولة', 'The request scope does not match the fund/date in the payload'],
  PREVIEW_NOT_QUEUED: ['المعاينة قراءة فقط ولا تُحفظ كطلب', 'Preview is read-only and is not stored as a request'],
  NETWORK_AMBIGUOUS: ['لم يصل رد الخادم؛ نتيجة الطلب غير معروفة', 'No response from the server; the outcome is unknown'],
  HEAD_INCOMPLETE: ['وثيقة الرأس ناقصة', 'The head document is incomplete'],
  HEAD_DOC_NOT_APPROVED: ['وثيقة الرأس ليست معتمدة', 'The head document is not approved'],
  HEAD_DOC_MISMATCH: ['وثيقة الرأس لا تخص المعتمد المسمّى', 'The head document is not the named approved valuation'],
  HEAD_VERSION_MISMATCH: ['نسخة الرأس لا تطابق وثيقة المعتمد', 'The head version does not match the approved document'],
  HEAD_HASH_MISMATCH: ['حالة غير متسقة: بصمة الرأس لا تطابق وثيقة المعتمد — لا تُعرض القيمة', 'Inconsistent: the head fingerprint does not match the approved document — value not shown'],
  HEAD_UNVERIFIABLE: ['غير قابل للتحقق (WebCrypto غير متاح) — لا تُعرض القيمة', 'Unverifiable (WebCrypto unavailable) — value not shown'],
  PAYLOAD_MISSING: ['حقل مطلوب ناقص', 'A required field is missing'],
  ACTION_UNKNOWN: ['إجراء غير معروف', 'Unknown action'],
  NO_TARGET: ['لا يوجد هدف لهذا الإجراء', 'No target for this action'],
});
const CODE_FALLBACK = {
  'permission-denied': ['ليست لديك صلاحية', 'Permission denied'], unauthenticated: ['يلزم تسجيل الدخول', 'Sign-in required'],
  'invalid-argument': ['مدخل غير صالح', 'Invalid input'], 'failed-precondition': ['الحالة الحالية لا تسمح', 'Precondition failed'],
  'not-found': ['غير موجود', 'Not found'], 'already-exists': ['موجود بالفعل', 'Already exists'],
  unavailable: ['الخدمة غير متاحة', 'Service unavailable'], 'deadline-exceeded': ['انتهت المهلة', 'Deadline exceeded'],
};
/** Never hides the raw reason/code. Unknown reason -> shown verbatim (no invented explanation). */
export function describeError(error, lang = 'ar') {
  const i = lang === 'en' ? 1 : 0;
  const code = normalizeFunctionsErrorCode(error && error.code);
  const d = error && error.details;
  const reason = (d && typeof d === 'object' && typeof d.reason === 'string' ? d.reason : null) || (error && typeof error.clientCode === 'string' ? error.clientCode : null);
  if (reason && Object.prototype.hasOwnProperty.call(MESSAGES, reason)) return { code, reason, known: true, message: MESSAGES[reason][i] };
  if (reason) return { code, reason, known: false, message: reason };
  if (code && CODE_FALLBACK[code]) return { code, reason: null, known: false, message: `${CODE_FALLBACK[code][i]} (${code})` };
  return { code, reason: null, known: false, message: MESSAGES.NETWORK_AMBIGUOUS[i] };
}

/* ---------- session / listener lifecycle ---------- */
/** (uid, email, read role) -> key; null when there is no read access (no listeners, nothing shown). */
export function sessionKey(s) {
  if (!s || !s.uid || !s.email || !canRead(s.role)) return null;
  return JSON.stringify([s.uid, lc(s.email), s.role]);
}
export function createGenerationGuard() {
  let g = 0;
  return {
    current: () => g,
    bump: () => (g += 1),
    isCurrent: (x) => x === g,
    /** wrap a result handler: results that arrive for an older generation are ignored */
    wrap(fn) { const mine = g; return (...a) => (mine === g ? fn(...a) : undefined); },
  };
}
/** Tracks the session key; a change (logout, user switch, lost read role) bumps the generation and runs the teardown. */
export function createSessionTracker({ guard, onReset }) {
  let key; let started = false;
  return {
    key: () => key,
    update(session) {
      const next = sessionKey(session);
      if (started && next === key) return { changed: false, key, generation: guard.current() };
      const hadKey = started && key != null;
      key = next; started = true;
      if (hadKey || next === null) { guard.bump(); if (typeof onReset === 'function') onReset({ reason: next === null ? 'NO_READ_ACCESS' : 'SESSION_CHANGED' }); }
      return { changed: true, key, generation: guard.current() };
    },
  };
}
