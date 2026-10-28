// R1-B2 / B2-2a — editor model (pure): number parsing, finite arithmetic at every step, form <-> content, coverage as a STATEMENT, copies.
// Run: node tests/features/fund-valuation-editor.test.mjs   (exit 0 only if all pass)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as E from '../../src/features/fund-valuation-editor.js';
import { validateValuationCandidate, FORMULA_TOLERANCE as DOMAIN_TOL } from '../../src/domain/financial/xirr/residual-valuation.js';
import { goodContent } from '../helpers/fund-valuation-server-fake.mjs';

const require = createRequire(import.meta.url);
const SERVER = require('../../functions/fund-valuations.cjs');
let passed = 0; let failed = 0;
async function t(name, fn) { try { await fn(); passed += 1; console.log(`  ✓ ${name}`); } catch (e) { failed += 1; console.error(`  ✗ ${name}`); if (!process.env.CONTINUE_ON_FAIL) throw e; console.error(`      ${String(e.message).split('\n')[0]}`); } }
const set = (f, p, v) => E.setField(f, p, v);
const proposal = (ids = ['A1', 'A2'], source = E.LINK_SOURCES.BROWSER_FUND_DATA) => E.makeLinkProposal({ fundId: 'F1', assetIds: ids, source });
/** a complete, statement-confirmed form */
function fullForm(over = {}) {
  let f = E.formFromContent(goodContent());
  f = E.confirmLinkedAssets(f, proposal());
  for (const [p, v] of Object.entries(over)) f = set(f, p, v);
  return f;
}
const codesOf = (b) => b.issues.map((i) => i.code);

console.log('— B2-2a editor —');

/* ----------------------------------------------------------------- numbers */
await t('1. parseAmount: plain decimals only; Arabic-Indic/Persian digits accepted; separators, signs, exponents, empty, NaN refused (never a silent 0)', () => {
  assert.deepEqual(E.parseAmount('1000'), { ok: true, value: 1000 });
  assert.deepEqual(E.parseAmount('١٢٣٫٥'), { ok: true, value: 123.5 });
  assert.deepEqual(E.parseAmount('۱۲۳'), { ok: true, value: 123 });
  for (const [txt, code] of [['', 'AMOUNT_EMPTY'], ['   ', 'AMOUNT_EMPTY'], ['-5', 'AMOUNT_NEGATIVE'], ['1,000', 'AMOUNT_SEPARATOR'], ['1 000', 'AMOUNT_SEPARATOR'], ['1٬000', 'AMOUNT_SEPARATOR'], ['1e5', 'AMOUNT_FORMAT'], ['NaN', 'AMOUNT_FORMAT'], ['Infinity', 'AMOUNT_FORMAT'], ['0x10', 'AMOUNT_FORMAT'], ['1.2.3', 'AMOUNT_FORMAT'], ['1234567890123456', 'AMOUNT_FORMAT'], ['1.1234567', 'AMOUNT_FORMAT'], [5, 'AMOUNT_NOT_TEXT'], [null, 'AMOUNT_NOT_TEXT']]) {
    const r = E.parseAmount(txt); assert.equal(r.ok, false, String(txt)); assert.equal(r.code, code, String(txt));
  }
});
await t('2. finite arithmetic at EVERY step: finite inputs whose sum / formula / difference overflow are reported with the step name (control 5)', () => {
  const big = 1.7e308;
  assert.equal(E.safeSum([big, big]).ok, false);
  assert.equal(E.safeSum([big, big]).code, 'NUMERIC_OVERFLOW');
  assert.equal(E.safeSum([1, NaN]).code, 'NUMBER_INVALID');
  let r = E.computeCheck({ assetsValue: big, cashRetained: big, otherAssets: 0, liabilities: 0 });
  assert.equal(r.ok, false); assert.equal(r.step, 'assets+cash');
  r = E.computeCheck({ assetsValue: 0, cashRetained: 0, otherAssets: big, liabilities: -big });
  assert.equal(r.ok, false); assert.equal(r.step, '-liabilities');
  r = E.computeCheck({ assetsValue: 1, cashRetained: 1, otherAssets: 1, liabilities: 1, residualValue: -big });
  assert.equal(r.ok, true); assert.equal(r.residualNegative, true); // -1.7e308 - 2 is still finite: not a false alarm
  r = E.computeCheck({ assetsValue: 0, cashRetained: 0, otherAssets: 0, liabilities: big, residualValue: -big });
  assert.equal(r.ok, true); // formula -big, difference 0: finite, so no false alarm
  r = E.computeCheck({ assetsValue: 0, cashRetained: 0, otherAssets: 0, liabilities: big, residualValue: big });
  assert.equal(r.ok, false); assert.equal(r.step, 'difference'); // every part is finite, only the DIFFERENCE overflows
  r = E.computeCheck({ assetsValue: 1, cashRetained: 0, otherAssets: 0, liabilities: -big, residualValue: -big });
  assert.equal(r.ok, false);
  r = E.computeCheck({ assetsValue: 1, cashRetained: 0, otherAssets: 5, liabilities: 0, otherItems: [big, big] });
  assert.equal(r.ok, false); assert.equal(r.step, 'otherItems');
  r = E.computeCheck({ assetsValue: 10, otherAssets: 0, unlinkedItems: [big, big] });
  assert.equal(r.ok, false); assert.equal(r.step, 'unlinkedItems');
});
await t('3. the item-sum DIFFERENCE can overflow even when the sum does not (itemsDifference)', () => {
  const r = E.computeCheck({ otherAssets: -1.7e308, otherItems: [1.7e308] });
  assert.equal(r.ok, false); assert.equal(r.step, 'itemsDifference');
});
await t('4. at the widest input the form allows (100 rows of 999999999999999) every step stays finite and the result is a normal issue, never a throw; a 101st row is refused', () => {
  let f = fullForm(); f = set(f, 'otherAssetsItems.0.amount', '999999999999999');
  for (let i = 1; i < 100; i += 1) { f = E.addItem(f, 'otherAssetsItems'); f = set(f, `otherAssetsItems.${i}.description`, 'x'); f = set(f, `otherAssetsItems.${i}.amount`, '999999999999999'); }
  assert.throws(() => E.addItem(f, 'otherAssetsItems'), (e) => e.clientCode === 'LIST_TOO_LONG');
  const b = E.buildContent(f);
  assert.equal(b.check.ok, true); assert.ok(Number.isFinite(b.check.itemsSum));
  assert.ok(codesOf(b).includes('OTHER_ASSETS_ITEMS_INVALID'));
});
await t('5. amountToText never invents a value: exponent forms and non-numbers are shown raw so the parser rejects them', () => {
  assert.equal(E.amountToText(1000), '1000'); assert.equal(E.amountToText(undefined), ''); assert.equal(E.amountToText(1e21), '1e+21');
  assert.equal(E.parseAmount(E.amountToText(1e21)).ok, false);
  assert.equal(E.parseAmount(E.amountToText(NaN)).ok, false);
  assert.equal(E.amountToText(1e-7), '1e-7', 'a value that would be rounded to 0 is shown raw, never silently changed');
  assert.equal(E.parseAmount(E.amountToText(1e-7)).ok, false);
  assert.equal(E.amountToText(0.000001), '0.000001'); assert.equal(E.amountToText(123456.5), '123456.5');
});

/* ----------------------------------------------------------------- form <-> content */
await t('6. residualValue is typed by the person: with equity/MOIC-like inputs absent it is never derived, never pre-filled', () => {
  const f = E.emptyForm(); assert.equal(f.residualValue, '');
  let g = set(f, 'components.assetsValue', '900'); g = set(g, 'components.cashRetained', '200'); g = set(g, 'components.otherAssets', '50'); g = set(g, 'components.liabilities', '150');
  const b = E.buildContent(g);
  assert.equal(b.content.residualValue, undefined, 'formula result is shown as a line, not written into the content');
  assert.equal(b.check.formula, 1000);
  assert.ok(codesOf(b).includes('INVALID_AMOUNT'));
});
await t('7. a full form builds exactly the server content keys; currency and basis fixed; ready === true', () => {
  const b = E.buildContent(fullForm());
  assert.deepEqual(b.errors, []); assert.deepEqual(b.issues, []); assert.equal(b.ready, true);
  assert.deepEqual(Object.keys(b.content).sort(), [...E.CONTENT_KEYS].sort());
  assert.equal(b.content.currency, 'SAR'); assert.equal(b.content.basis, 'RESIDUAL_VALUE_AS_OF_DATE');
  assert.deepEqual(b.content, { ...goodContent(), coverage: { linkedAssets: ['A1', 'A2'], unlinkedHoldings: { declared: 'none' } } });
});
await t('8. formFromContent -> buildContent round trip is lossless for a stored, confirmed document', () => {
  const c = goodContent();
  const b = E.buildContent(E.formFromContent(c), { stored: c });
  assert.deepEqual(b.content, c);
});
await t('9. clearing a stored residualValue is refused (CANNOT_CLEAR_STORED_FIELD), because the update is a top-level replace and cannot unset', () => {
  const c = goodContent(); const f = set(E.formFromContent(c), 'residualValue', '');
  const b = E.buildContent(f, { stored: c });
  assert.equal(b.canSave, false); assert.ok(b.errors.some((e) => e.code === 'CANNOT_CLEAR_STORED_FIELD'));
});
await t('10. an unparseable number blocks SAVING with a coded error; a missing number only blocks READINESS', () => {
  const b1 = E.buildContent(set(fullForm(), 'components.assetsValue', '12a'));
  assert.equal(b1.canSave, false); assert.ok(b1.errors.some((e) => e.path === 'components.assetsValue' && e.code === 'AMOUNT_FORMAT'));
  const b2 = E.buildContent(set(fullForm(), 'components.assetsValue', ''));
  assert.equal(b2.canSave, true); assert.equal(b2.ready, false);
});
await t('11. setField: whitelist only; __proto__, constructor, unknown paths and wrong value types are refused; the form is never mutated', () => {
  const f = E.emptyForm(); const snap = JSON.stringify(f);
  for (const p of ['__proto__.x', 'components.__proto__', 'constructor.prototype.y', 'foo', 'components.other', 'otherAssetsItems.0.description', 'coverage.linkedAssets', 'coverage.linkedAssets.ids']) {
    assert.throws(() => set(f, p, 'x'), (e) => ['FIELD_UNKNOWN'].includes(e.clientCode), p);
  }
  assert.throws(() => set(f, 'method', 'nonsense'), (e) => e.clientCode === 'FIELD_VALUE_INVALID');
  assert.throws(() => set(f, 'nonOverlap.cashNotInAssets', 'true'), (e) => e.clientCode === 'FIELD_VALUE_INVALID');
  assert.throws(() => set(f, 'residualValue', 5), (e) => e.clientCode === 'FIELD_VALUE_INVALID');
  assert.throws(() => set(f, 'coverage.unlinkedHoldings.declared', 'maybe'), (e) => e.clientCode === 'FIELD_VALUE_INVALID');
  assert.equal(JSON.stringify(f), snap); assert.equal(Object.prototype.polluted, undefined);
});
await t('12. rows: untouched rows are ignored; half-filled rows are coded errors; removeItem bounds-checked', () => {
  let f = fullForm(); f = E.addItem(f, 'otherAssetsItems');
  assert.equal(E.buildContent(f).canSave, true);
  f = set(f, 'otherAssetsItems.1.amount', '5');
  const b = E.buildContent(f); assert.ok(b.errors.some((e) => e.code === 'ITEM_DESCRIPTION_EMPTY' && e.path === 'otherAssetsItems.1.description'));
  assert.throws(() => E.removeItem(f, 'otherAssetsItems', 9), (e) => e.clientCode === 'FIELD_UNKNOWN');
  assert.throws(() => E.removeItem(f, 'nope', 0), (e) => e.clientCode === 'FIELD_UNKNOWN');
  assert.equal(E.removeItem(f, 'otherAssetsItems', 1).otherAssetsItems.length, 1);
});
await t('13. dirty state compares by value, ignores key order, and sees row-count changes', () => {
  const a = E.emptyForm(); const b = JSON.parse(JSON.stringify(a));
  assert.equal(E.isDirty(a, b), false);
  assert.equal(E.isDirty(E.addItem(a, 'otherAssetsItems'), b), true);
  assert.deepEqual(E.diffForms(set(a, 'methodNote', 'x'), a), ['methodNote']);
});

/* ----------------------------------------------------------------- readiness vs the domain validator (parity) */
const AS = '2026-10-11';
function domainCodes(content) {
  const cand = { valuationId: 'd1', fundId: 'F1', valuationDate: AS, status: 'draft', enteredBy: 'fm@example.com', ...JSON.parse(JSON.stringify(content)) };
  const out = validateValuationCandidate({ asOfDate: AS, scope: { snapshotDate: AS, funds: ['F1'], linksByFund: { F1: ['A1', 'A2'] } }, candidate: cand, ancestors: [], records: [], baseHeadValuationId: null });
  return { status: out.status, codes: out.issues.map((i) => i.code) };
}
await t('14. parity: a form the editor calls READY is accepted by the real domain candidate validator', () => {
  const b = E.buildContent(fullForm());
  assert.equal(b.ready, true);
  const d = domainCodes(b.content); assert.equal(d.status, 'CANDIDATE_OK', d.codes.join(','));
});
await t('15. parity: each content problem the editor reports as an issue is reported with the SAME code by the domain validator', () => {
  const cases = [
    ['residual mismatch', { residualValue: '1100' }, 'RESIDUAL_FORMULA_MISMATCH'],
    ['method other without note', { method: 'other', methodNote: '' }, 'INVALID_METHOD'],
    ['source missing', { 'source.provider': '' }, 'SOURCE_MISSING'],
    ['items do not add up', { 'otherAssetsItems.0.amount': '40' }, 'OTHER_ASSETS_ITEMS_INVALID'],
  ];
  for (const [label, over, code] of cases) {
    const b = E.buildContent(fullForm(over)); assert.ok(codesOf(b).includes(code), `${label}: editor ${codesOf(b)}`);
    const d = domainCodes(b.content); assert.ok(d.codes.includes(code), `${label}: domain ${d.codes}`);
  }
});
await t('16. tolerance: 0.01 allowed, 0.02 refused; the editor tolerance equals the domain constant and the server uses the same domain', () => {
  assert.equal(E.FORMULA_TOLERANCE, DOMAIN_TOL);
  assert.deepEqual(codesOf(E.buildContent(fullForm({ residualValue: '1000.01' }))), []);
  assert.ok(codesOf(E.buildContent(fullForm({ residualValue: '1000.02' }))).includes('RESIDUAL_FORMULA_MISMATCH'));
});
await t('16b. tolerance of the item sum: 0.01 allowed, 0.02 refused (same boundary as the domain validator)', () => {
  const at = (amt) => fullForm({ 'otherAssetsItems.0.amount': amt });
  assert.ok(!codesOf(E.buildContent(at('50.01'))).includes('OTHER_ASSETS_ITEMS_INVALID'));
  assert.ok(codesOf(E.buildContent(at('50.02'))).includes('OTHER_ASSETS_ITEMS_INVALID'));
  assert.ok(!domainCodes(E.buildContent(at('50.01')).content).codes.includes('OTHER_ASSETS_ITEMS_INVALID'));
  assert.ok(domainCodes(E.buildContent(at('50.02')).content).codes.includes('OTHER_ASSETS_ITEMS_INVALID'));
});
await t('17. distributionsPayable: undeclared and > 0 both block readiness (never defaulted to 0)', () => {
  assert.ok(codesOf(E.buildContent(fullForm({ 'components.distributionsPayable': '' }))).includes('DISTRIBUTIONS_PAYABLE_UNDECLARED'));
  assert.ok(codesOf(E.buildContent(fullForm({ 'components.distributionsPayable': '1' }))).includes('DISTRIBUTIONS_PAYABLE_UNRESOLVED'));
});
await t('18. non-overlap needs all three flags; one false blocks readiness', () => {
  assert.ok(codesOf(E.buildContent(fullForm({ 'nonOverlap.cashNotInAssets': false }))).includes('NON_OVERLAP_UNDECLARED'));
});
await t('19. parity: CONTENT_KEYS equal the server CONTENT_KEYS (a server change forces a review here)', () => {
  assert.deepEqual([...E.CONTENT_KEYS].sort(), [...SERVER.CONTENT_KEYS].sort());
});

/* ----------------------------------------------------------------- coverage is a statement, not an automatic fact (control 3) */
await t('20. a new form has NO coverage statement; buildContent emits no coverage key; readiness is blocked until she states it', () => {
  let f = E.formFromContent(goodContent(), { unconfirmCoverage: true });
  const b = E.buildContent(f);
  assert.equal(b.content.coverage, undefined);
  assert.ok(codesOf(b).includes('COVERAGE_LINKED_UNCONFIRMED')); assert.ok(codesOf(b).includes('COVERAGE_UNLINKED_UNSTATED'));
  assert.equal(E.buildContent(E.emptyForm()).content.coverage, undefined);
});
await t('21. confirming links records WHICH proposal and its source; a proposal without a named source cannot exist', () => {
  const f = E.confirmLinkedAssets(E.emptyForm(), proposal(['B', 'A'], E.LINK_SOURCES.BROWSER_FUND_DATA));
  assert.deepEqual(f.coverage.linkedAssets.ids, ['A', 'B']); assert.equal(f.coverage.linkedAssets.confirmedAgainst.source, 'BROWSER_FUND_DATA');
  assert.throws(() => E.makeLinkProposal({ fundId: 'F1', assetIds: ['A'], source: 'GUESS' }), (e) => e.clientCode === 'LINK_SOURCE_UNKNOWN');
  assert.throws(() => E.makeLinkProposal({ fundId: 'F1', assetIds: ['A'] }), (e) => e.clientCode === 'LINK_SOURCE_UNKNOWN');
  assert.throws(() => E.confirmLinkedAssets(E.emptyForm(), null), (e) => e.clientCode === 'LINK_PROPOSAL_REQUIRED');
  assert.throws(() => E.confirmLinkedAssets(E.emptyForm(), { ids: ['A'] }), (e) => e.clientCode === 'LINK_PROPOSAL_REQUIRED');
});
await t('22. the proposal object is frozen: nothing can edit the proposed ids behind the statement', () => {
  const p = proposal(); assert.throws(() => { 'use strict'; p.ids.push('X'); }); assert.throws(() => { p.source = 'x'; });
});
await t('23. unlinked holdings: unset (null) is NEVER read as "none"; "included" needs rows; rows must be finite and within assetsValue', () => {
  let f = fullForm(); f = set(f, 'coverage.unlinkedHoldings.declared', null);
  assert.ok(codesOf(E.buildContent(f)).includes('COVERAGE_UNLINKED_UNSTATED'));
  f = set(f, 'coverage.unlinkedHoldings.declared', 'included');
  assert.ok(codesOf(E.buildContent(f)).includes('COVERAGE_UNLINKED_INVALID'));
  f = E.addItem(f, 'unlinkedItems'); f = set(f, 'coverage.unlinkedHoldings.items.0.description', 'plot'); f = set(f, 'coverage.unlinkedHoldings.items.0.amount', '5000');
  assert.ok(codesOf(E.buildContent(f)).includes('UNLINKED_ITEMS_EXCEED_ASSETS'));
  f = set(f, 'coverage.unlinkedHoldings.items.0.amount', '500');
  assert.deepEqual(codesOf(E.buildContent(f)), []);
});
await t('24. reconcileCoverage compares HER statement with the server-captured links; statementStale flags a newer proposal', () => {
  const f = fullForm();
  assert.equal(E.reconcileCoverage(f, ['A1', 'A2']).status, 'MATCH');
  assert.deepEqual(E.reconcileCoverage(f, ['A1', 'A2', 'A3']), { status: 'MISSING', missing: ['A3'], extra: [] });
  assert.equal(E.reconcileCoverage(f, ['A1']).status, 'EXTRA');
  assert.equal(E.reconcileCoverage(f, ['A9']).status, 'MISSING_AND_EXTRA');
  assert.equal(E.reconcileCoverage(f, undefined).status, 'NO_SCOPE');
  assert.equal(E.reconcileCoverage(E.emptyForm(), ['A1']).status, 'UNCONFIRMED');
  assert.equal(E.isStatementStale(f, proposal()), false);
  assert.equal(E.isStatementStale(f, proposal(['A1', 'A2', 'A3'])), true);
  assert.equal(E.isStatementStale(f, proposal(['A1', 'A2'], E.LINK_SOURCES.SERVER_SCOPE_SNAPSHOT)), true, 'same ids, different source = a different basis');
  assert.equal(E.isStatementStale(E.emptyForm(), proposal()), false);
});
await t('25. clearing links removes the statement', () => {
  const f = E.clearLinkedAssets(fullForm()); assert.equal(E.buildContent(f).content.coverage.linkedAssets, undefined);
});

/* ----------------------------------------------------------------- copies */
await t('26. copy review: both content AND coverage must be acknowledged; the server cannot copy an approved version', () => {
  const r0 = E.newCopyReview({ kind: E.COPY_KINDS.SERVER_COPY, sourceId: 'V1' });
  assert.equal(E.copyReviewComplete(r0), false);
  const r1 = E.ackCopyReview(r0, 'content'); assert.equal(E.copyReviewComplete(r1), false);
  const r2 = E.ackCopyReview(r1, 'coverage'); assert.equal(E.copyReviewComplete(r2), true);
  assert.equal(E.copyReviewComplete(null), true, 'not a copy: nothing to review');
  assert.throws(() => E.ackCopyReview(r0, 'both'), (e) => e.clientCode === 'COPY_ACK_UNKNOWN');
  assert.throws(() => { r0.contentReviewed = true; }); // frozen
  assert.equal(E.canServerCopy('approved'), false); assert.equal(E.canServerCopy('rejected'), true); assert.equal(E.canServerCopy('draft'), true);
  assert.deepEqual([...E.SERVER_COPY_SOURCE_STATES].sort(), ['draft', 'rejected', 'returned', 'reviewed', 'submitted', 'withdrawn']);
  assert.throws(() => E.newCopyReview({ kind: 'magic', sourceId: 'x' }), (e) => e.clientCode === 'COPY_KIND_UNKNOWN');
});
await t('27. re-copying does not prove old coverage: a prefill from an old document arrives UNCONFIRMED, with its ids shown but not stated', () => {
  const f = E.formFromContent(goodContent(), { unconfirmCoverage: true });
  assert.equal(f.coverage.linkedAssets.confirmed, false); assert.deepEqual(f.coverage.linkedAssets.ids, ['A1', 'A2']);
  assert.equal(f.coverage.unlinkedHoldings.declared, null);
  assert.equal(E.buildContent(f).content.coverage, undefined);
});

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
