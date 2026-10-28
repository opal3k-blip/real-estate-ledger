/* =========================================================================
   Phase 2R-4D4-C (الجولة الرابعة من المراجعة) — تصنيف السجلات العينية القديمة
   ضمن fundLedgerSummary (src/core.js).
   ---------------------------------------------------------------------------
   يختبر هذا الملف الدالة الحقيقية fundLedgerSummary نفسها (لا تقليداً/fake لها، خلافاً لملف
   capital-allocation-engine.landfirst.test.mjs المجاور الذي يُلقِّم fundLedgerSummary وهمية) --
   مُحمَّلة عبر tests/domain/core-vm-harness.mjs (نفس آلية تحميل src/core.js في VM بمحاكيات
   document/window المستخدَمة أصلاً من اختبارات tests/domain/verify-*.mjs).

   الهدف: cashPaidIn (السيولة النقدية الحقيقية القابلة للنشر، لا paidIn الخام الذي يشمل العيني لأغراض
   DPI/PIC) يجب أن تستبعد نداء رأس المال العيني القديم (سابق لمرحلة 2R-4D4-B: linkedCommitmentId فقط
   بلا inKindAssetId) وعكسه أيضاً -- توحيداً تاماً مع نفس المنطق في functions/index.js
   (isInKindCapitalCallRecord)، لا مجرد نتيجة مشابهة صدفة.

   Run directly: node tests/features/fund-ledger-inkind-classification.test.mjs
   Exits 0 on all assertions passing, non-zero otherwise.
   ========================================================================= */
import assert from 'node:assert/strict';
import { loadCore } from '../domain/core-vm-harness.mjs';

const C = loadCore();

function resetStore(){
  C.STORE.investors = [];
  C.STORE.funds = [];
  C.STORE.commitments = [];
  C.STORE.capitalCalls = [];
  C.STORE.distributions = [];
  C.STORE.transactions = [];
}
function cc(id, data){ return { id, data }; }

// --- (أ) سجل عيني قديم لا يمنح سيولة نقدية -------------------------------------------------
{
  resetStore();
  C.STORE.funds = [{ id: 'FNDLEG1', data: { assetIds: [] } }];
  C.STORE.capitalCalls = [
    // شكل قديم حقيقي: linkedCommitmentId فقط، بلا inKindAssetId إطلاقاً.
    cc('CC-LEGACY-OLD1', { fundId: 'FNDLEG1', investorId: 'INV1', status: 'paid', amount: 200000, linkedCommitmentId: 'CMTLEG1' }),
    cc('CC-CASH-LEG1', { fundId: 'FNDLEG1', investorId: 'INV2', status: 'paid', amount: 100000 }),
  ];
  const s = C.fundLedgerSummary('FNDLEG1');
  assert.equal(s.cashPaidIn, 100000, 'REGRESSION: سجل عيني قديم (linkedCommitmentId بلا inKindAssetId) احتُسِب ضمن cashPaidIn');
  assert.equal(s.paidIn, 300000, 'paidIn الخام يجب أن يبقى شاملاً (300000) لأغراض DPI/PIC — غير مُغيَّر بهذا الإصلاح');
  console.log('  ✓ (أ) سجل عيني قديم لا يمنح سيولة نقدية — cashPaidIn=100000، paidIn=300000');
}

// --- (ب) عكس السجل العيني القديم لا يغيّر السيولة النقدية -----------------------------------
{
  resetStore();
  C.STORE.funds = [{ id: 'FNDLEG2', data: { assetIds: [] } }];
  C.STORE.capitalCalls = [
    cc('CC-LEGACY-OLD2', { fundId: 'FNDLEG2', investorId: 'INV1', status: 'paid', amount: 200000, linkedCommitmentId: 'CMTLEG2' }),
    cc('CC-CASH-LEG2', { fundId: 'FNDLEG2', investorId: 'INV2', status: 'paid', amount: 100000 }),
  ];
  const before = C.fundLedgerSummary('FNDLEG2');
  // عكس مطابق تماماً لسلوك reverseTransaction الحقيقي: linkedCommitmentId يُصفَّر صراحة، ولا يوجد
  // inKindAssetId ليُبقيه — السجل الأصلي القديم لم يحمله أصلاً.
  C.STORE.capitalCalls.push(cc('CC-LEGACY-OLD2-REV', { fundId: 'FNDLEG2', investorId: 'INV1', status: 'paid', amount: -200000, reversalOfId: 'CC-LEGACY-OLD2', linkedCommitmentId: null }));
  const after = C.fundLedgerSummary('FNDLEG2');
  assert.equal(before.cashPaidIn, 100000);
  assert.equal(after.cashPaidIn, 100000, 'REGRESSION: عكس سجل عيني قديم غيَّر cashPaidIn (يجب أن يبقى 100000 قبل العكس وبعده تماماً)');
  console.log('  ✓ (ب) عكس السجل العيني القديم لا يغيّر السيولة النقدية — cashPaidIn=100000 قبل وبعد العكس');
}

// --- (ج) مساهمة نقدية مستقلة من نفس المستثمر تبقى محسوبة -----------------------------------
{
  resetStore();
  C.STORE.funds = [{ id: 'FNDLEG3', data: { assetIds: [] } }];
  C.STORE.capitalCalls = [
    // نفس المستثمر INV1 له سجل عيني قديم مستبعَد ونداء نقدي مستقل منفصل — التصنيف على مستوى كل سجل
    // بعينه، لا على مستوى المستثمر.
    cc('CC-LEGACY-OLD3', { fundId: 'FNDLEG3', investorId: 'INV1', status: 'paid', amount: 300000, linkedCommitmentId: 'CMTLEG3' }),
    cc('CC-CASH-INV1-LEG3', { fundId: 'FNDLEG3', investorId: 'INV1', status: 'paid', amount: 50000 }),
  ];
  const s = C.fundLedgerSummary('FNDLEG3');
  assert.equal(s.cashPaidIn, 50000, 'REGRESSION: مساهمة نقدية مستقلة من نفس مستثمر السجل العيني القديم لم تُحتسَب ضمن cashPaidIn');
  console.log('  ✓ (ج) مساهمة نقدية مستقلة من نفس المستثمر تبقى محسوبة — cashPaidIn=50000');
}

console.log('\nكل اختبارات تصنيف العيني القديم في fundLedgerSummary نجحت.');
