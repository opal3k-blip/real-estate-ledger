/* =========================================================================
   Phase 2R-4D4-C — land-first regression tests for the Capital Allocation
   Engine's asset-link guard (src/features/capital-allocation-engine.js).
   ---------------------------------------------------------------------------
   This test targets ONLY registerCapitalAllocationEngine's registerAssetLinkGuard
   closure, invoked directly through a minimal fake `core` (no DOM, no Firestore,
   no bundler). It is NOT a fakes-based Functions test and NOT a Firestore
   Rules/concurrency certification — see functions/test/load-index-with-fakes.js
   and tests/rules/rules.test.mjs for those, and tests/domain for the compute()
   golden-master financial engine tests. Scope here is narrow and specific:
   prove that this one client-side gate no longer treats an executed in-kind
   (land) contribution's value as spendable cash available to allocate to an
   UNRELATED asset in the same fund — the "land-first" requirement raised
   during Phase 2R-4D4-C review (in-kind contribution value must never become
   generally spendable cash) — including the two-asset interaction and
   server/UI parity gaps found during that review's follow-up verification.

   Run directly: node tests/features/capital-allocation-engine.landfirst.test.mjs
   Exits 0 on all assertions passing, non-zero otherwise (assertion message on
   stderr, Node's default uncaught-exception reporting).
   ========================================================================= */
import assert from 'node:assert/strict';
import { registerCapitalAllocationEngine } from '../../src/features/capital-allocation-engine.js';

function makeCore({ opportunities, capitalCalls, fundLedgerSummaryImpl }) {
  let capturedGuard = null;
  const core = {
    opportunities,
    STORE: { capitalCalls },
    withDefaults: (d) => d,
    T: (ar, en) => en, // English branch is enough to assert on
    n: (v, fallback = 0) => { const x = Number(v); return Number.isFinite(x) ? x : fallback; },
    fmtSAR: (v) => `SAR ${v}`,
    fundLedgerSummary: fundLedgerSummaryImpl,
    // Required at registration time; unused by the asset-link guard path itself.
    registerAssetLinkGuard: (fn) => { capturedGuard = fn; },
    registerDetailSection: () => {},
    registerActionHandler: () => {},
  };
  registerCapitalAllocationEngine(core);
  return (fund, oppId) => capturedGuard(fund, oppId);
}

function opp(id, targetEquity, maxAllocation = null) {
  return { id, data: { capitalAllocation: { targetEquity, maxAllocation }, ic: { decisions: [{ decision: 'approve' }] } } };
}
function callInKind(fundId, inKindAssetId, amount, status = 'paid') {
  return { data: { fundId, inKindAssetId, status, amount } };
}

// --- original single-asset regression (unchanged intent) ---------------------------------
{
  // Fund has SAR 500,000 paid-in TOTAL (summary.paidIn), but SAR 400,000 of that is an executed
  // in-kind (land) contribution earmarked to a DIFFERENT asset (not OPP-TARGET) — so genuine cash
  // actually available (summary.cashPaidIn) is only SAR 100,000, no distributions paid, nothing
  // allocated elsewhere. Requesting a SAR 300,000 target equity allocation for OPP-TARGET must be
  // BLOCKED: it fits under paidIn (500k) but not under the real cash figure (100k).
  const guard = makeCore({
    opportunities: [opp('OPP-TARGET', 300000)],
    capitalCalls: [],
    fundLedgerSummaryImpl: () => ({ paidIn: 500000, cashPaidIn: 100000, distPaid: 0 }),
  });
  const result = await guard({ id: 'FND1', data: { assetIds: [] } }, 'OPP-TARGET');
  assert.equal(result.blocked, true,
    'REGRESSION: in-kind (land) value counted as deployable cash for an unrelated asset — land-first violated');
  assert.match(String(result.reason), /deployable cash is only SAR 100000/,
    `blocked reason should cite the real cash-only figure (100000), got: ${result.reason}`);
}
{
  // Sanity/no-false-positive check: the same request against a fund with SAR 300,000 of GENUINE
  // cash (no in-kind at all) must be allowed — the fix must not over-block real cash.
  const guard = makeCore({
    opportunities: [opp('OPP-TARGET', 300000)],
    capitalCalls: [],
    fundLedgerSummaryImpl: () => ({ paidIn: 300000, cashPaidIn: 300000, distPaid: 0 }),
  });
  const result = await guard({ id: 'FND1', data: { assetIds: [] } }, 'OPP-TARGET');
  assert.equal(result.blocked, false, `unexpected block with sufficient genuine cash: ${result.reason}`);
}

// --- two-asset land-first (mirrors functions/index.js's allocatedElsewhereTx fix) -----------
{
  // OPPLA is fully covered by its own executed in-kind earmark (250000); OPPLB needs 50000 and
  // there is a genuine, untouched 100000 cash pool. Before this fix, allocatedElsewhereInFund
  // summed OPPLA's FULL targetEquity (250000) against the shared cash pool once OPPLA was linked,
  // wrongly blocking OPPLB even though its 50000 fits easily inside the real 100000 cash on hand.
  const oppLA = opp('OPPLA', 250000, 300000);
  const oppLB = opp('OPPLB', 50000, 100000);
  const calls = [callInKind('FND1', 'OPPLA', 250000)];
  const summary = () => ({ paidIn: 250000, cashPaidIn: 100000, distPaid: 0 });

  const guardWithLAOnly = makeCore({ opportunities: [oppLA, oppLB], capitalCalls: calls, fundLedgerSummaryImpl: summary });
  // OPPLA itself must be linkable (its own earmark covers its own target).
  const resultLA = await guardWithLAOnly({ id: 'FND1', data: { assetIds: [] } }, 'OPPLA');
  assert.equal(resultLA.blocked, false, `OPPLA (fully land-funded) should be linkable on its own: ${resultLA.reason}`);
  // Once OPPLA is linked, OPPLB must still see the untouched 100000 real cash.
  const resultLB = await guardWithLAOnly({ id: 'FND1', data: { assetIds: ['OPPLA'] } }, 'OPPLB');
  assert.equal(resultLB.blocked, false,
    `REGRESSION: a fully land-funded, already-linked asset (OPPLA) blocked a genuinely cash-funded asset (OPPLB) that fits inside real cash: ${resultLB.reason}`);
}
{
  // Mixed-financed asset: targetEquity 200000, of which 120000 is executed in-kind coverage — only
  // its 80000 cash portion should be deducted from the shared pool when evaluating a DIFFERENT
  // asset. Cash pool is 100000, so exactly 20000 must remain for another asset — no more, no less.
  const oppMixed = opp('OPPMIXED', 200000, 250000);
  const oppOther = opp('OPPOTHER', 20000, 30000);
  const calls = [callInKind('FND1', 'OPPMIXED', 120000)];
  const summary = () => ({ paidIn: 100000, cashPaidIn: 100000, distPaid: 0 });
  const guard = makeCore({ opportunities: [oppMixed, oppOther], capitalCalls: calls, fundLedgerSummaryImpl: summary });

  const fundWithMixedLinked = { id: 'FND1', data: { assetIds: ['OPPMIXED'] } };
  const resultAt20000 = await guard(fundWithMixedLinked, 'OPPOTHER');
  assert.equal(resultAt20000.blocked, false,
    `exactly 20000 real cash should remain after OPPMIXED consumed only its 80000 cash portion (not its full 200000 target): ${resultAt20000.reason}`);
}
{
  // Same mixed-financed setup, but the other asset asks for one riyal more than the real
  // remainder (20001) — must be blocked. Proves the deduction is exactly 80000, not 0.
  const oppMixed = opp('OPPMIXED', 200000, 250000);
  const oppOther = opp('OPPOTHER2', 20001, 30000);
  const calls = [callInKind('FND1', 'OPPMIXED', 120000)];
  const summary = () => ({ paidIn: 100000, cashPaidIn: 100000, distPaid: 0 });
  const guard = makeCore({ opportunities: [oppMixed, oppOther], capitalCalls: calls, fundLedgerSummaryImpl: summary });
  const result = await guard({ id: 'FND1', data: { assetIds: ['OPPMIXED'] } }, 'OPPOTHER2');
  assert.equal(result.blocked, true,
    `REGRESSION: requesting 1 riyal more than the real 20000 remainder was allowed — mixed asset's cash portion under-deducted`);
}
{
  // Excess in-kind coverage (150000 in-kind against a 100000 target) must not manufacture spare
  // cash for a different asset — the shortfall must be floored at zero, never subtracted as a
  // negative (which would otherwise inflate the shared pool).
  const oppOver = opp('OPPOVER', 100000, 200000);
  const oppCash = opp('OPPCASH', 1, 10);
  const calls = [callInKind('FND1', 'OPPOVER', 150000)];
  const summary = () => ({ paidIn: 0, cashPaidIn: 0, distPaid: 0 });
  const guard = makeCore({ opportunities: [oppOver, oppCash], capitalCalls: calls, fundLedgerSummaryImpl: summary });
  const result = await guard({ id: 'FND1', data: { assetIds: ['OPPOVER'] } }, 'OPPCASH');
  assert.equal(result.blocked, true,
    `REGRESSION: excess in-kind coverage on OPPOVER manufactured spare cash for OPPCASH despite zero real cash in the fund: ${result.reason}`);
}
{
  // Server/UI parity: functions/index.js's linkAssetToFund lets an asset's OWN executed, eligible
  // in-kind earmark satisfy its own target equity without needing (or being treated as) general
  // cash. Before this fix the UI guard lacked this exception entirely, so a legitimate, fully
  // land-funded asset link was blocked in the UI pre-check even though the server would allow it.
  const oppLand = opp('OPPLANDONLY', 250000, 300000);
  const calls = [callInKind('FND1', 'OPPLANDONLY', 250000)];
  const summary = () => ({ paidIn: 250000, cashPaidIn: 0, distPaid: 0 }); // zero real cash in the fund
  const guard = makeCore({ opportunities: [oppLand], capitalCalls: calls, fundLedgerSummaryImpl: summary });
  const result = await guard({ id: 'FND1', data: { assetIds: [] } }, 'OPPLANDONLY');
  assert.equal(result.blocked, false,
    `REGRESSION (server/UI parity): a fully land-funded asset with zero fund cash was blocked in the UI guard even though functions/index.js's linkAssetToFund would allow it via its own earmarkedForThisAsset exception: ${result.reason}`);
}

console.log('OK: capital-allocation-engine.js land-first guard tests passed (9 assertions across 7 scenarios).');
process.exit(0);
