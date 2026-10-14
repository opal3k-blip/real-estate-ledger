/* XIRR-R1B2 / B2-2a — fund residual-valuation EDITOR model (pure: no DOM, no Firebase, no XIRR import, no storage).
   Contract: docs/XIRR_RESIDUAL_VALUATION_UI_CONTRACT.md + B2-2 scope (approved 2026-10-11).
   This module turns what a person typed into the `content` object the server accepts, and reports what the server's
   validator is going to say about it. It is user experience only: the SERVER validates (functions/fund-valuations.cjs).
   Hard rules enforced here:
   - residualValue is ALWAYS typed by the person. It is never derived, never pre-filled, never taken from equity x MOIC or
     from any return figure. A read-only formula line is shown next to it; the person decides.
   - Coverage is never an automatic statement. Proposed asset links and the person's own statement are different things.
   - Every intermediate quantity (sums of items, the formula steps, the difference) must be finite, not only the inputs. */

/* ---------- constants (mirrors of the server's lists; parity-tested against functions/fund-valuations.cjs) ---------- */
export const CONTENT_KEYS = Object.freeze(['currency', 'basis', 'components', 'residualValue', 'method', 'methodNote', 'source', 'nonOverlap', 'coverage']);
export const FIXED_CONTENT = Object.freeze({ currency: 'SAR', basis: 'RESIDUAL_VALUE_AS_OF_DATE' });
export const METHODS = Object.freeze(['appraisal', 'nav_statement', 'cost_basis', 'other']);
export const COMPONENT_KEYS = Object.freeze(['assetsValue', 'cashRetained', 'otherAssets', 'liabilities', 'distributionsPayable']);
export const NON_OVERLAP_KEYS = Object.freeze(['cashNotInAssets', 'otherAssetsNotInAssets', 'assetsStatedGrossOfLiabilities']);
export const FORMULA_TOLERANCE = 0.01; // SAR; same number the server's validator uses (parity-tested)
const MAX_TEXT = 500;
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);

function bad(code, message) { const e = new Error(message || code); e.clientCode = code; return e; }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* ---------- numbers: strict text -> number, never a silent 0 ---------- */
const AR = '٠١٢٣٤٥٦٧٨٩'; const FA = '۰۱۲۳۴۵۶۷۸۹';
export function normalizeDigits(s) {
  return String(s).replace(/[٠-٩]/g, (d) => String(AR.indexOf(d))).replace(/[۰-۹]/g, (d) => String(FA.indexOf(d))).replace(/٫/g, '.');
}
/** Plain decimal only: 1-15 integer digits, optional 1-6 decimals. No sign, no exponent, no thousands separator (ambiguous
    between locales, so refused rather than guessed), no empty string, no NaN/Infinity. */
export function parseAmount(text) {
  if (typeof text !== 'string') return { ok: false, code: 'AMOUNT_NOT_TEXT' };
  const t = normalizeDigits(text.trim());
  if (t === '') return { ok: false, code: 'AMOUNT_EMPTY' };
  if (/^[-−–]/.test(t)) return { ok: false, code: 'AMOUNT_NEGATIVE' };
  if (/[٬,\s_']/.test(t)) return { ok: false, code: 'AMOUNT_SEPARATOR' };
  if (!/^\d{1,15}(\.\d{1,6})?$/.test(t)) return { ok: false, code: 'AMOUNT_FORMAT' };
  const v = Number(t);
  if (!Number.isFinite(v)) return { ok: false, code: 'NUMERIC_OVERFLOW' };
  return { ok: true, value: v };
}
/** number -> text for loading a stored value into the form. A value that cannot be shown as a plain decimal is returned as its
    raw String() on purpose, so parseAmount rejects it and saving is blocked until the person looks at it (no silent loss). */
export function amountToText(n) {
  if (typeof n !== 'number') return n === undefined || n === null ? '' : String(n);
  if (!Number.isFinite(n)) return String(n);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  if (n >= 0 && n < 1e15) { const f = n.toFixed(6).replace(/\.?0+$/, ''); if (f !== '' && Number(f) === n) return f; } // only when the plain form is EXACTLY the same number
  return s;
}

/* ---------- finite arithmetic: every step ---------- */
export function safeSum(values) {
  let s = 0;
  for (const v of values) { if (!fin(v)) return { ok: false, code: 'NUMBER_INVALID' }; s += v; if (!Number.isFinite(s)) return { ok: false, code: 'NUMERIC_OVERFLOW' }; }
  return { ok: true, value: s };
}
/** n = { assetsValue, cashRetained, otherAssets, liabilities, residualValue, otherItems:number[], unlinkedItems:number[] } (any may be absent).
    Returns what can be said; a non-finite STEP (not only a non-finite input) makes ok:false with the name of the step. */
export function computeCheck(n) {
  const out = { ok: true, step: null, code: null, formula: null, diff: null, residualMatches: null, residualNegative: null, itemsSum: null, itemsMatch: null, unlinkedSum: null, unlinkedWithinAssets: null };
  const stop = (step, code) => { out.ok = false; out.step = step; out.code = code || 'NUMERIC_OVERFLOW'; return out; };
  const x = n || {};
  for (const k of ['assetsValue', 'cashRetained', 'otherAssets', 'liabilities', 'residualValue']) if (x[k] !== undefined && !fin(x[k])) return stop(k, 'NUMBER_INVALID');
  if (Array.isArray(x.otherItems)) {
    const s = safeSum(x.otherItems); if (!s.ok) return stop('otherItems', s.code);
    out.itemsSum = s.value;
    if (x.otherAssets !== undefined) { const d = Math.abs(s.value - x.otherAssets); if (!Number.isFinite(d)) return stop('itemsDifference'); out.itemsMatch = d <= FORMULA_TOLERANCE; }
  }
  if (Array.isArray(x.unlinkedItems)) {
    const s = safeSum(x.unlinkedItems); if (!s.ok) return stop('unlinkedItems', s.code);
    out.unlinkedSum = s.value;
    if (x.assetsValue !== undefined) { const lim = x.assetsValue + FORMULA_TOLERANCE; if (!Number.isFinite(lim)) return stop('assetsLimit'); out.unlinkedWithinAssets = s.value <= lim; }
  }
  if (['assetsValue', 'cashRetained', 'otherAssets', 'liabilities'].every((k) => x[k] !== undefined)) {
    const s1 = x.assetsValue + x.cashRetained; if (!Number.isFinite(s1)) return stop('assets+cash');
    const s2 = s1 + x.otherAssets; if (!Number.isFinite(s2)) return stop('+otherAssets');
    const f = s2 - x.liabilities; if (!Number.isFinite(f)) return stop('-liabilities');
    out.formula = f;
    if (x.residualValue !== undefined) {
      const diff = x.residualValue - f; if (!Number.isFinite(diff)) return stop('difference');
      out.diff = diff; out.residualMatches = Math.abs(diff) <= FORMULA_TOLERANCE; out.residualNegative = x.residualValue < 0 || f < 0;
    }
  }
  return out;
}

/* ---------- form state (everything is TEXT while the person types) ---------- */
export function emptyForm() {
  return {
    components: { assetsValue: '', cashRetained: '', otherAssets: '', liabilities: '', distributionsPayable: '' },
    otherAssetsItems: [],
    residualValue: '', method: '', methodNote: '',
    source: { ref: '', provider: '' },
    nonOverlap: { cashNotInAssets: false, otherAssetsNotInAssets: false, assetsStatedGrossOfLiabilities: false },
    coverage: {
      linkedAssets: { confirmed: false, ids: [], confirmedAgainst: null }, // the PERSON's statement; empty/unconfirmed until she makes it
      unlinkedHoldings: { declared: null, items: [] },                   // null = not stated; never read as 'none'
    },
  };
}
/** Stored content -> form. `unconfirmCoverage` (copies): the stored coverage is shown but is NOT the person's current statement. */
export function formFromContent(content, { unconfirmCoverage = false } = {}) {
  const f = emptyForm(); const c = isObj(content) ? content : {};
  if (isObj(c.components)) {
    for (const k of COMPONENT_KEYS) if (c.components[k] !== undefined) f.components[k] = amountToText(c.components[k]);
    if (Array.isArray(c.components.otherAssetsItems)) f.otherAssetsItems = c.components.otherAssetsItems.map((i) => ({ description: isObj(i) && typeof i.description === 'string' ? i.description : '', amount: isObj(i) ? amountToText(i.amount) : '' }));
  }
  if (c.residualValue !== undefined) f.residualValue = amountToText(c.residualValue);
  if (typeof c.method === 'string') f.method = c.method;
  if (typeof c.methodNote === 'string') f.methodNote = c.methodNote;
  if (isObj(c.source)) { if (typeof c.source.ref === 'string') f.source.ref = c.source.ref; if (typeof c.source.provider === 'string') f.source.provider = c.source.provider; }
  if (isObj(c.nonOverlap)) for (const k of NON_OVERLAP_KEYS) f.nonOverlap[k] = c.nonOverlap[k] === true;
  if (isObj(c.coverage)) {
    if (Array.isArray(c.coverage.linkedAssets)) f.coverage.linkedAssets = { confirmed: !unconfirmCoverage, ids: uniqSorted(c.coverage.linkedAssets), confirmedAgainst: null };
    const u = c.coverage.unlinkedHoldings;
    if (isObj(u) && (u.declared === 'none' || u.declared === 'included')) {
      f.coverage.unlinkedHoldings = { declared: unconfirmCoverage ? null : u.declared, items: Array.isArray(u.items) ? u.items.map((i) => ({ description: isObj(i) && typeof i.description === 'string' ? i.description : '', amount: isObj(i) ? amountToText(i.amount) : '' })) : [] };
    }
  }
  return f;
}
const uniqSorted = (a) => [...new Set((Array.isArray(a) ? a : []).filter((x) => typeof x === 'string' && x.trim() !== ''))].sort();

/* ---------- editing: only known paths, immutable updates ---------- */
const PATH_RE = [
  /^components\.(assetsValue|cashRetained|otherAssets|liabilities|distributionsPayable)$/,
  /^(residualValue|method|methodNote)$/,
  /^source\.(ref|provider)$/,
  /^nonOverlap\.(cashNotInAssets|otherAssetsNotInAssets|assetsStatedGrossOfLiabilities)$/,
  /^otherAssetsItems\.\d{1,3}\.(description|amount)$/,
  /^coverage\.unlinkedHoldings\.declared$/,
  /^coverage\.unlinkedHoldings\.items\.\d{1,3}\.(description|amount)$/,
];
export function isKnownPath(path) { return typeof path === 'string' && path.split('.').every((p) => !DANGEROUS.has(p)) && PATH_RE.some((r) => r.test(path)); }
function getParent(obj, parts) { let cur = obj; for (const p of parts.slice(0, -1)) { if (cur == null) return null; cur = cur[p]; } return cur; }
/** value: string for text fields, boolean for nonOverlap, 'none'|'included'|null for the unlinked declaration. */
export function setField(form, path, value) {
  if (!isKnownPath(path)) throw bad('FIELD_UNKNOWN', `unknown field: ${String(path).slice(0, 60)}`);
  const parts = path.split('.');
  const isBool = path.startsWith('nonOverlap.');
  if (path === 'coverage.unlinkedHoldings.declared') { if (value !== null && value !== 'none' && value !== 'included') throw bad('FIELD_VALUE_INVALID', 'declared must be none, included or null'); }
  else if (isBool) { if (typeof value !== 'boolean') throw bad('FIELD_VALUE_INVALID', 'boolean required'); }
  else if (path === 'method') { if (typeof value !== 'string' || (value !== '' && !METHODS.includes(value))) throw bad('FIELD_VALUE_INVALID', 'method must be one of the allowed values'); }
  else if (typeof value !== 'string' || value.length > MAX_TEXT) throw bad('FIELD_VALUE_INVALID', `text up to ${MAX_TEXT} characters required`);
  const next = clone(form); const parent = getParent(next, parts);
  const last = parts[parts.length - 1];
  if (parent == null || typeof parent !== 'object' || !(last in parent)) throw bad('FIELD_UNKNOWN', 'no such row');
  parent[last] = value;
  return next;
}
export function addItem(form, list) {
  const next = clone(form); const arr = list === 'otherAssetsItems' ? next.otherAssetsItems : list === 'unlinkedItems' ? next.coverage.unlinkedHoldings.items : null;
  if (!arr) throw bad('FIELD_UNKNOWN', 'unknown list');
  if (arr.length >= 100) throw bad('LIST_TOO_LONG', 'at most 100 rows');
  arr.push({ description: '', amount: '' }); return next;
}
export function removeItem(form, list, index) {
  const next = clone(form); const arr = list === 'otherAssetsItems' ? next.otherAssetsItems : list === 'unlinkedItems' ? next.coverage.unlinkedHoldings.items : null;
  if (!arr || !Number.isInteger(index) || index < 0 || index >= arr.length) throw bad('FIELD_UNKNOWN', 'no such row');
  arr.splice(index, 1); return next;
}

/* ---------- comparing forms (dirty state, conflicts) ---------- */
export function flatten(form) {
  const out = {};
  const walk = (v, p) => {
    if (Array.isArray(v)) { out[`${p}#len`] = String(v.length); v.forEach((x, i) => walk(x, `${p}.${i}`)); }
    else if (isObj(v)) for (const k of Object.keys(v).sort()) walk(v[k], p ? `${p}.${k}` : k);
    else out[p] = v === null ? 'null' : String(v);
  };
  walk(form, ''); return out;
}
export function diffForms(a, b) {
  const fa = flatten(a || emptyForm()); const fb = flatten(b || emptyForm());
  // `confirmedAgainst` is the record of WHICH proposal she confirmed (metadata); it is not part of the statement itself, so it never makes a form "dirty"
  return [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => !k.startsWith('coverage.linkedAssets.confirmedAgainst') && fa[k] !== fb[k]).sort();
}
export const isDirty = (form, baseline) => diffForms(form, baseline).length > 0;

/* ---------- coverage: proposal (suggestion) vs statement (the person) ---------- */
export const LINK_SOURCES = Object.freeze({
  BROWSER_FUND_DATA: 'BROWSER_FUND_DATA',       // the fund document held in this browser (assetIds). The server captures its own scope when the draft is created and it may differ.
  SERVER_SCOPE_SNAPSHOT: 'SERVER_SCOPE_SNAPSHOT', // scopeSnapshot.linksByFund[fund] stored with an existing draft (what the server validates against)
});
export function makeLinkProposal({ fundId, assetIds, source }) {
  if (!Object.values(LINK_SOURCES).includes(source)) throw bad('LINK_SOURCE_UNKNOWN', 'the source of proposed links must be named');
  const ids = uniqSorted(assetIds);
  return Object.freeze({ fundId: fundId ?? null, ids: Object.freeze(ids), source, sig: JSON.stringify([source, fundId ?? null, ids]) });
}
/** The person states that the listed assets are the ones covered. Always an explicit act. */
export function confirmLinkedAssets(form, proposal) {
  if (!proposal || !Array.isArray(proposal.ids) || !proposal.sig) throw bad('LINK_PROPOSAL_REQUIRED', 'no proposal to confirm');
  const next = clone(form);
  next.coverage.linkedAssets = { confirmed: true, ids: [...proposal.ids], confirmedAgainst: { sig: proposal.sig, source: proposal.source } };
  return next;
}
export function clearLinkedAssets(form) { const next = clone(form); next.coverage.linkedAssets = { confirmed: false, ids: [], confirmedAgainst: null }; return next; }
/** Compares the person's statement with the links the SERVER captured for the draft. Informational: the server decides. */
export function reconcileCoverage(form, scopeLinks) {
  const st = form && form.coverage && form.coverage.linkedAssets;
  if (!st || !st.confirmed) return { status: 'UNCONFIRMED', missing: [], extra: [] };
  if (!Array.isArray(scopeLinks)) return { status: 'NO_SCOPE', missing: [], extra: [] };
  const have = new Set(st.ids); const want = new Set(scopeLinks);
  const missing = [...want].filter((a) => !have.has(a)).sort(); const extra = [...have].filter((a) => !want.has(a)).sort();
  const status = missing.length && extra.length ? 'MISSING_AND_EXTRA' : missing.length ? 'MISSING' : extra.length ? 'EXTRA' : 'MATCH';
  return { status, missing, extra };
}
/** A statement made against a proposal is stale when a newer proposal differs (links changed since she confirmed). */
export function isStatementStale(form, currentProposal) {
  const st = form && form.coverage && form.coverage.linkedAssets;
  if (!st || !st.confirmed || !st.confirmedAgainst || !currentProposal) return false;
  return st.confirmedAgainst.sig !== currentProposal.sig;
}

/* ---------- copies: a copy is a NEW draft whose content and coverage still have to be reviewed ---------- */
export const COPY_KINDS = Object.freeze({ SERVER_COPY: 'server-copy' }); // the only copy there is: the one the server performs (a pre-fill from an approved version is deferred, not part of this package)
export function newCopyReview({ kind, sourceId, sourceState, sourceDate }) {
  if (!Object.values(COPY_KINDS).includes(kind)) throw bad('COPY_KIND_UNKNOWN', 'unknown copy kind');
  return Object.freeze({ kind, sourceId: sourceId ?? null, sourceState: sourceState ?? null, sourceDate: sourceDate ?? null, contentReviewed: false, coverageReviewed: false });
}
export function ackCopyReview(review, which) {
  if (!review) return review;
  if (which !== 'content' && which !== 'coverage') throw bad('COPY_ACK_UNKNOWN', 'content or coverage');
  return Object.freeze({ ...review, ...(which === 'content' ? { contentReviewed: true } : { coverageReviewed: true }) });
}
export const copyReviewComplete = (review) => !review || (review.contentReviewed === true && review.coverageReviewed === true);
/** What the server can copy (functions/fund-valuations.cjs createDraft): never an approved version. */
export const SERVER_COPY_SOURCE_STATES = Object.freeze(['rejected', 'withdrawn', 'draft', 'returned', 'submitted', 'reviewed']);
export const canServerCopy = (state) => SERVER_COPY_SOURCE_STATES.includes(state);

/* ---------- form -> content ---------- */
const hasText = (s) => typeof s === 'string' && s.trim() !== '';
function amountField(text, path, errors) {
  if (!hasText(text)) return undefined;
  const r = parseAmount(text);
  if (!r.ok) { errors.push({ path, code: r.code }); return undefined; }
  return r.value;
}
function rowsOf(rows, base, errors) {
  const out = []; const nums = []; let ok = true;
  (rows || []).forEach((r, i) => {
    const d = hasText(r.description); const a = hasText(r.amount);
    if (!d && !a) return;                                    // an untouched row is ignored
    if (!d) { errors.push({ path: `${base}.${i}.description`, code: 'ITEM_DESCRIPTION_EMPTY' }); ok = false; }
    const v = amountField(r.amount, `${base}.${i}.amount`, errors);
    if (!a) { errors.push({ path: `${base}.${i}.amount`, code: 'AMOUNT_EMPTY' }); ok = false; }
    if (v === undefined) ok = false;
    if (d && v !== undefined) { out.push({ description: r.description.trim(), amount: v }); nums.push(v); }
  });
  return { items: out, nums, ok };
}
/** @param form
    @param {{stored?: object|null}} opts stored = the content the server holds for this draft (so clearing a number that cannot be unset is reported)
    @returns {{content:object, errors:{path,code}[], issues:{code,path?,detail?}[], ready:boolean, canSave:boolean, check:object}}
      errors  = things that cannot be sent at all (unparseable, unknown); they block SAVING.
      issues  = what the server's validator will report on this content; they block READINESS (submit), never saving. */
export function buildContent(form, { stored = null } = {}) {
  const f = form || emptyForm(); const errors = []; const issues = []; const st = isObj(stored) ? stored : {};
  const content = { ...FIXED_CONTENT };
  const num = {}; // parsed numbers for the checks

  // components
  const comps = {};
  for (const k of COMPONENT_KEYS) { const v = amountField(f.components[k], `components.${k}`, errors); if (v !== undefined) { comps[k] = v; num[k] = v; } }
  const other = rowsOf(f.otherAssetsItems, 'otherAssetsItems', errors);
  const anyComp = Object.keys(comps).length > 0 || other.items.length > 0 || isObj(st.components);
  if (anyComp) { comps.otherAssetsItems = other.items; content.components = comps; }

  // residualValue (typed by the person; never derived)
  const rv = amountField(f.residualValue, 'residualValue', errors);
  if (rv !== undefined) { content.residualValue = rv; num.residualValue = rv; }
  else if (!hasText(f.residualValue) && st.residualValue !== undefined) errors.push({ path: 'residualValue', code: 'CANNOT_CLEAR_STORED_FIELD' });

  // method / note
  if (hasText(f.method) || st.method !== undefined) content.method = f.method || '';
  if (hasText(f.methodNote) || st.methodNote !== undefined) content.methodNote = (f.methodNote || '').trim();

  // source
  const src = {}; if (hasText(f.source.ref)) src.ref = f.source.ref.trim(); if (hasText(f.source.provider)) src.provider = f.source.provider.trim();
  if (Object.keys(src).length || isObj(st.source)) content.source = src;

  // non-overlap
  const noAny = NON_OVERLAP_KEYS.some((k) => f.nonOverlap[k] === true);
  if (noAny || isObj(st.nonOverlap)) content.nonOverlap = Object.fromEntries(NON_OVERLAP_KEYS.map((k) => [k, f.nonOverlap[k] === true]));

  // coverage (only what the person has STATED)
  const cov = {}; const la = f.coverage.linkedAssets; const uh = f.coverage.unlinkedHoldings;
  if (la && la.confirmed === true) cov.linkedAssets = uniqSorted(la.ids);
  let unl = { items: [], nums: [], ok: true };
  if (uh.declared === 'none') cov.unlinkedHoldings = { declared: 'none' };
  else if (uh.declared === 'included') { unl = rowsOf(uh.items, 'coverage.unlinkedHoldings.items', errors); cov.unlinkedHoldings = { declared: 'included', items: unl.items }; }
  if (Object.keys(cov).length || isObj(st.coverage)) content.coverage = cov;

  // ----- what the server's validator will say (readiness) -----
  for (const k of ['assetsValue', 'cashRetained', 'otherAssets', 'liabilities']) if (comps[k] === undefined) issues.push({ code: 'INVALID_AMOUNT', path: `components.${k}` });
  if (comps.distributionsPayable === undefined) issues.push({ code: 'DISTRIBUTIONS_PAYABLE_UNDECLARED', path: 'components.distributionsPayable' });
  else if (comps.distributionsPayable > 0) issues.push({ code: 'DISTRIBUTIONS_PAYABLE_UNRESOLVED', path: 'components.distributionsPayable', detail: 'declared-positive-amount' });
  if (rv === undefined) issues.push({ code: 'INVALID_AMOUNT', path: 'residualValue' });
  const check = computeCheck({ ...num, otherItems: other.ok ? other.nums : undefined, unlinkedItems: uh.declared === 'included' && unl.ok ? unl.nums : undefined });
  if (!check.ok) issues.push({ code: check.code, detail: check.step });
  else {
    if (check.itemsMatch === false) issues.push({ code: 'OTHER_ASSETS_ITEMS_INVALID', path: 'otherAssetsItems', detail: 'items do not add up to otherAssets' });
    if (check.residualMatches === false) issues.push({ code: 'RESIDUAL_FORMULA_MISMATCH', path: 'residualValue', detail: `stated ${num.residualValue}, formula ${check.formula}` });
    if (check.residualNegative === true) issues.push({ code: 'RESIDUAL_NEGATIVE', path: 'residualValue' });
    if (check.unlinkedWithinAssets === false) issues.push({ code: 'UNLINKED_ITEMS_EXCEED_ASSETS', path: 'coverage.unlinkedHoldings.items' });
  }
  if (!METHODS.includes(f.method)) issues.push({ code: 'INVALID_METHOD', path: 'method' });
  else if (f.method === 'other' && !hasText(f.methodNote)) issues.push({ code: 'INVALID_METHOD', path: 'methodNote', detail: 'method-other-requires-methodNote' });
  if (!hasText(f.source.ref) || !hasText(f.source.provider)) issues.push({ code: 'SOURCE_MISSING', path: 'source' });
  if (!NON_OVERLAP_KEYS.every((k) => f.nonOverlap[k] === true)) issues.push({ code: 'NON_OVERLAP_UNDECLARED', path: 'nonOverlap' });
  if (!la || la.confirmed !== true) issues.push({ code: 'COVERAGE_LINKED_UNCONFIRMED', path: 'coverage.linkedAssets' }); // client-only: she has not stated it
  if (uh.declared !== 'none' && uh.declared !== 'included') issues.push({ code: 'COVERAGE_UNLINKED_UNSTATED', path: 'coverage.unlinkedHoldings' });
  else if (uh.declared === 'included' && (unl.items.length === 0 || !unl.ok)) issues.push({ code: 'COVERAGE_UNLINKED_INVALID', path: 'coverage.unlinkedHoldings.items' });

  const size = JSON.stringify(content).length;
  if (size > 60000) errors.push({ path: '', code: 'CONTENT_TOO_LARGE' });
  return { content, errors, issues, ready: errors.length === 0 && issues.length === 0, canSave: errors.length === 0, check };
}
