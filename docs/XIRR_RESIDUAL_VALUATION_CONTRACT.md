# XIRR-R1A — residual valuation data contract (indicative)

Module: `src/domain/financial/xirr/residual-valuation.js` (`selectResidualValuation`). Verification: `src/domain/financial/xirr/verify-residual-valuation.mjs`.
Scope of R1-A: **pure contract + validator + selector only.** No Firestore, no UI, no rate enabling; `portfolio.js` and `command-center.js` are untouched, so the UI still shows no Net XIRR rate (`NAV_BASIS_UNRESOLVED`, see `XIRR_PORTFOLIO_COMPUTATION_CONTRACT.md` §6). Storage, permissions, approval and the UI are R1-B, after review of this contract. Who may prepare and approve is a **proposal only** (§9).

## 1. What the validator does and does not establish
It checks that the supplied valuation records, coverage statements, scope snapshot and ledger records are **complete and consistent with each other** (arithmetic, dates, version chains, coverage, declared amounts).
It does **not** establish that a valuation or its amounts are correct, that a source is genuine, that an approval actually took place, that the scope snapshot truly reflects the state on its date (no clock is used; only the explicit dates are compared), or that the non-overlap declarations are true. Every result — computed or blocked — carries `warnings[]` with `VALUATION_NOT_VERIFIED_BY_VALIDATOR`, `APPROVAL_NOT_VERIFIED_BY_VALIDATOR` and `COVERAGE_SNAPSHOT_AUTHENTICITY_NOT_VERIFIED`.

## 2. Input
`{ asOfDate, scope:{snapshotDate, funds[], linksByFund{}}, valuations[], records[] }`
- `asOfDate`: real ISO date. **Every valuation must carry exactly this `valuationDate`** (no older, no newer) and the scope snapshot must carry the same `snapshotDate`; one common date for all funds.
- `scope`: the portfolio fund set and the asset ids linked to each fund **as of the snapshot date**. The only source of links in the data model is the current `assetIds`; a historical link source is an R1-B decision, so a snapshot is accepted only when its date equals the valuation date.
- `valuations`: **all approved versions of every fund/date (complete version chains are a precondition of the input)**, plus any drafts.
- `records`: ledger records in the XIRR-P shape (`kind`, `id`, `fundId`, `date`, `status`); only `capitalCall` / `distribution` are read.

## 3. Valuation record (one per fund per version)
`valuationId`, `fundId`, `valuationDate`, `currency` (`'SAR'`), `basis` (`'RESIDUAL_VALUE_AS_OF_DATE'`), `components`, `residualValue`, `method` (`appraisal | nav_statement | cost_basis | other`; `other` requires `methodNote`), `source {ref, provider}` (both required), `nonOverlap`, `coverage`, `version`, `supersedes`, `status` (`draft | approved`), `enteredBy`, `approvedBy`.
Amounts are finite numbers; strings, NaN, Infinity, negatives and missing values are rejected — never coerced, never defaulted to 0.

### Components (mutually exclusive — each amount appears in exactly one)
| component | contents | excludes |
|---|---|---|
| `assetsValue` | independently valued holdings still owned at the date: linked assets plus the declared unlinked holdings, stated **gross** of liabilities | cash, receivables |
| `cashRetained` | cash and cash equivalents only | |
| `otherAssets` | other non-cash, non-holding assets (e.g. receivables), itemised in `otherAssetsItems[{description, amount}]` that must add up to the component | |
| `liabilities` | obligations to third parties | unpaid distributions (blocked, §4), uncalled commitments, investor capital |
`residualValue = assetsValue + cashRetained + otherAssets − liabilities`, stated explicitly and equal to the formula within 0.01 SAR; a negative residual is blocked. `nonOverlap` must declare `cashNotInAssets`, `otherAssetsNotInAssets` and `assetsStatedGrossOfLiabilities` all `true` (declared, not verifiable). `assetsValue` is never derived from underwriting equity × MOIC or any projection (the module does not read them).
- Distributions already **paid** are in the Net XIRR flows: they are neither subtracted from nor added to the residual value.
- Unpaid capital calls and uncalled commitments are not part of the residual.
- In-kind: R1-A decides nothing. In-kind capital calls stay refused by XIRR-P (`IN_KIND_VALUE_BASIS_UNRESOLVED`), so no rate appears even with a valid valuation.

## 4. Unpaid distributions — temporary block
`components.distributionsPayable` is a **required explicit amount** (finite ≥ 0). Missing ⇒ `DISTRIBUTIONS_PAYABLE_UNDECLARED`; positive ⇒ `DISTRIBUTIONS_PAYABLE_UNRESOLVED` (detail `declared-positive-amount`); zero is not sufficient when the ledger shows an unresolved case.
Ledger rule, matched to the code (distribution statuses are `declared → approved → paid`; `waived` exists for capital calls only; `reverseTransaction` accepts only a posted = paid distribution):
- any distribution of a scope fund with status `declared` or `approved` ⇒ `DISTRIBUTIONS_PAYABLE_UNRESOLVED` (detail `ledger-shows-unpaid-distribution`). **Its `distDate` — past or future — is not evidence that it was not yet declared**: the model has no declaration date, so due-ness at the valuation date cannot be determined and the result is blocked rather than assuming absence. An unpaid original and an unpaid "reversal" are not treated as a cancelled pair (no legitimate unpaid pair exists in the code, so the XIRR-P pair rule, which requires a `paid` original, is not reused);
- status missing or not in `{declared, approved, paid}` (including `waived`) ⇒ `DISTRIBUTION_STATUS_UNKNOWN`;
- missing / non-real date on any distribution of a scope fund ⇒ `DISTRIBUTION_DATE_INVALID`;
- **funds outside the scope get the same treatment, date-independently:** an unpaid (`declared` / `approved`) or unknown-status distribution of a fund that is not in `scope.funds` blocks with `COVERAGE_FUND_MISSING` (coverage gap) together with `DISTRIBUTIONS_PAYABLE_UNRESOLVED` / `DISTRIBUTION_STATUS_UNKNOWN` (due-ness not settled); a future `distDate` does not exempt it. Only a `paid` record, or a non-distribution record, dated after the valuation date in an out-of-scope fund is left alone;
- `paid` distributions never block and never change the residual.
This is a temporary block; relaxing it needs a declared-date field or an explicit payable policy (R1-B / later decision).

## 4b. Finite arithmetic
Every computed quantity must be finite: each step of the residual formula, the sum of `otherAssetsItems`, the sum of unlinked-holding items, and the **portfolio total of residual values**. A non-finite step or total ⇒ `NUMERIC_OVERFLOW` (ids name the record, or `portfolio` for the total), `complete=false`, `value=null`, `perFund=[]` — never a success and never a downstream `Infinity`. An overflowing intermediate step is refused even when the exact result would be representable (conservative; no scaling is attempted).

## 5. Coverage statement (never implied)
- `coverage.linkedAssets`: must equal, as a set, the snapshot's `linksByFund[fundId]` (`COVERAGE_ASSET_MISSING`, `COVERAGE_ASSET_UNKNOWN`, `COVERAGE_ASSET_DUPLICATE`).
- `coverage.unlinkedHoldings`: required. `{declared:'none'}` (no items) or `{declared:'included', items:[{description, amount}]}` with Σ items ≤ `assetsValue` (items are part of `assetsValue`, not an addition). Absent / other ⇒ `COVERAGE_UNLINKED_UNSTATED`; malformed ⇒ `COVERAGE_UNLINKED_INVALID`; excess ⇒ `UNLINKED_ITEMS_EXCEED_ASSETS`.
- Portfolio: every scope fund needs exactly one effective valuation (`COVERAGE_FUND_MISSING`; `VALUATION_DATE_MISMATCH` when only other dates exist); a valuation for a fund outside the scope ⇒ `COVERAGE_FUND_UNKNOWN`; a fund that has ledger records dated ≤ `asOfDate` (or undated) but is outside the scope ⇒ `COVERAGE_FUND_MISSING`. Any gap blocks the **whole** result: no partial-portfolio value.

## 6. Versions
The chain is evaluated over **approved** versions only; drafts are outside it (as record or as predecessor), so a draft correction never overrides an approved version.
- `version` is a positive integer; v1 has `supersedes = null`; version n+1 supersedes version n of the same fund and date; each version has at most one successor; the effective valuation is the single head.
- Missing predecessor ⇒ `VERSION_CHAIN_INCOMPLETE` (the input does not contain the whole chain; this does not claim the original data is corrupt). Predecessor present but not approved ⇒ `VERSION_PREDECESSOR_NOT_APPROVED`.
- Two heads, version gap, self-supersede, predecessor of another fund/date, duplicate `valuationId`, two successors ⇒ `AMBIGUOUS_VALUATION_VERSIONS`.
- Approval data (values only): an approved version needs `approvedBy` and `enteredBy`, and they must differ (`APPROVAL_DATA_INVALID`). Superseded versions are kept for audit and never summed.

## 7. Output (ready to map to `nav`, NOT wired in R1-A)
```
{ status: 'OK'|'BLOCKED'|'INVALID_INPUT',
  value: number|null,            // Σ residualValue over all scope funds; null when blocked
  complete: boolean,
  basis: 'RESIDUAL_VALUE_AS_OF_DATE', source: 'FUND_VALUATIONS_APPROVED', valuationDate: asOfDate,
  perFund: [{fundId, valuationId, version, residualValue, components, method, sourceRef, provider}],  // [] when blocked
  issues: [{code, ids[], detail?}],   // ids are kind-qualified: fund:X, fundValuation:Y, asset:A, distribution:Z
  reasonCodes: [...], warnings: [{code, message}] }
```
`computePortfolioNetXirr` forwards only `value / complete / basis / source / valuationDate / issues` of its `nav` input and does not return `perFund` or the selector's `warnings`. R1-A therefore tests the integration through an **explicit test-only wrapper** that maps the output to `nav` and keeps `perFund` and `warnings` next to the result; the production module and UI are unchanged. Carrying `perFund` / `warnings` into the production result and views is R1-B.

## 8. Declared limits that stay visible
Flow dates remain ledger record dates (`callDate` / `distDate`), not proven payment or settlement dates; the indicator is indicative and conditioned on record dates and is not described as a return based on actual payment dates. In-kind calls stay blocked. Cash-refund / reversal meaning is as implemented in XIRR-P.

## 9. R1-B (later) and proposed permissions (not approved)
Storage (`fundValuations`, append-only), Firestore rules, approval function, entry/approval UI, wiring into `netXirrInput`. Proposal only until approved explicitly: preparer = fund manager; approver = a different person with senior IC or above; no self-approval, including admin; `approved` only through a server function.
