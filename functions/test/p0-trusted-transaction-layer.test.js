/* =========================================================================
   اختبارات وظيفية دائمة — P0: Trusted Transaction Layer (functions/index.js)
   ---------------------------------------------------------------------------
   تُشغَّل بـ: node functions/test/p0-trusted-transaction-layer.test.js
   (أو npm run test:p0 من داخل functions/ — انظر package.json)

   السياق: هذه الدوال (updateIcConditionStatus، transitionLedgerRecord، reverseTransaction،
   requireAuthorized، وتضييقات approveOpportunity/linkAssetToFund/postCapitalCall) هي طبقة الثقة
   الوحيدة لمعاملات دفتر الصندوق (capital calls/distributions/commitments) وقرارات لجنة الاستثمار
   بعد إغلاق كل مسارات الكتابة المباشرة من العميل في firestore.rules. أي رجوع في هذا المنطق
   (تخفيف شرط، نسيان requireAuthorized في دالة جديدة، كسر تسلسل الحالة) يُعيد فتح ثغرة حوكمية
   حقيقية بصمت — لذلك هذه الاختبارات دائمة، لا اختبار استكشافي لمرة واحدة.

   ⚠️ لا تختبر هذه الملفات قواعد firestore.rules نفسها (analyst المباشر على opportunity.ic، أو
   fund.assetIds المباشر) — تلك تحتاج Firestore Emulator حقيقياً ومكانها الصحيح tests/rules/
   rules.test.mjs (أُضيفت هناك حالات "P0 — Trusted Transaction Layer" مقابلة). هذا الملف يختبر فقط
   منطق دوال functions/index.js نفسها بمحاكاة Firestore في الذاكرة (functions/test/fakes/).
   ========================================================================= */
const assert = require('assert');
const { loadIndexWithFakes } = require('./load-index-with-fakes');
const { fns, db, HttpsError } = loadIndexWithFakes();

let passed = 0;
let failed = 0;
const failures = [];

function ok(name) { passed++; console.log('  ✓', name); }
function bad(name, err) {
  failed++;
  failures.push({ name, err });
  console.log('  ✗', name, '-', (err && err.message) || err);
}

async function test(name, fn) {
  try { await fn(); ok(name); }
  catch (e) { bad(name, e); }
}

async function expectThrow(fn, codeOrMsgSubstr, label) {
  try {
    await fn();
    throw new Error(`${label}: expected throw, got none`);
  } catch (e) {
    if (e instanceof HttpsError || (e && e.code)) {
      if (codeOrMsgSubstr && e.code !== codeOrMsgSubstr && !(e.message || '').includes(codeOrMsgSubstr)) {
        throw new Error(`${label}: threw but wrong code/message: ${e.code} / ${e.message}`);
      }
      return;
    }
    throw new Error(`${label}: threw non-HttpsError: ${e.message}`);
  }
}

function req(email, data) { return { auth: { token: { email } }, data }; }

const ADMIN = 'opal3k@gmail.com';
const FM = 'fm@example.com';        // fund_manager
const SENIOR_IC = 'ic@example.com'; // senior_ic
const ANALYST = 'analyst@example.com';
const EXPIRED = 'expired@example.com';

function seedTeam() {
  db.__reset();
  db.__seed('team_roles', FM, { role: 'fund_manager' });
  db.__seed('team_roles', SENIOR_IC, { role: 'senior_ic' });
  db.__seed('team_roles', ANALYST, { role: 'analyst' });
  db.__seed('team_roles', EXPIRED, { role: 'fund_manager' });
  db.__seed('team_members', FM, { expiresAt: null });
  db.__seed('team_members', SENIOR_IC, { expiresAt: null });
  db.__seed('team_members', ANALYST, { expiresAt: null });
  // عضو منتهي الصلاحية: موجود في team_members (بعكس عضو أُزيل بالكامل) لكن expiresAt في الماضي.
  db.__seed('team_members', EXPIRED, { expiresAt: { toMillis: () => Date.now() - 86400000 } });
}

function seedOpp(id, owner) {
  db.__seed('opportunities', id, {
    meta: { createdBy: owner },
    ic: { decisions: [{ decision: 'approve_conditions', conditions: [{ text: 'شرط 1', status: 'pending' }] }] },
  });
}

(async () => {
  console.log('\n== requireAuthorized() — انتهاء صلاحية العضوية (اكتشاف إضافي خارج نطاق الطلب الأصلي) ==');
  await test('fund_manager نشط يقدر يستدعي postCapitalCall', async () => {
    seedTeam();
    db.__seed('commitments', 'CMT1', { fundId: 'F1', investorId: 'INV1', commitmentAmount: 1000, reversalOfId: null });
    const resp = await fns.postCapitalCall(req(FM, { fundId: 'F1', investorId: 'INV1', callDate: '2026-01-01', amount: 100, status: 'pending' }));
    assert.ok(resp.id);
  });
  await test('[السيناريو المسمّى: expired team member] عضو منتهي الصلاحية يُرفَض رغم بقائه في team_roles', async () => {
    seedTeam();
    await expectThrow(() => fns.postCapitalCall(req(EXPIRED, { fundId: 'F1', investorId: 'INV1', callDate: '2026-01-01', amount: 100, status: 'pending' })), 'permission-denied', 'expired member call');
  });
  await test('عضو غير موجود إطلاقاً في team_members يُرفَض', async () => {
    seedTeam();
    await expectThrow(() => fns.postCapitalCall(req('ghost@example.com', { fundId: 'F1', investorId: 'INV1', callDate: '2026-01-01', amount: 100, status: 'pending' })), 'permission-denied', 'ghost member call');
  });
  await test('الأدمن يتجاوز فحص team_members دائماً', async () => {
    seedTeam();
    const resp = await fns.postCapitalCall(req(ADMIN, { fundId: 'F1', investorId: 'INV1', callDate: '2026-01-01', amount: 100, status: 'pending' }));
    assert.ok(resp.id);
  });

  console.log('\n== postCapitalCall — رفض القيود العكسية + سقف الالتزام ==');
  await test('postCapitalCall يرفض أي طلب بحقل reversalOfId — يجب استخدام reverseTransaction', async () => {
    seedTeam();
    await expectThrow(() => fns.postCapitalCall(req(FM, { fundId: 'F1', investorId: 'INV1', callDate: '2026-01-01', amount: -100, status: 'paid', reversalOfId: 'CC_X' })), 'invalid-argument', 'reversal via postCapitalCall');
  });
  await test('postCapitalCall يرفض نداء paid يتجاوز الالتزام', async () => {
    seedTeam();
    db.__seed('commitments', 'CMT1', { fundId: 'F1', investorId: 'INV1', commitmentAmount: 500 });
    await expectThrow(() => fns.postCapitalCall(req(FM, { fundId: 'F1', investorId: 'INV1', callDate: '2026-01-01', amount: 600, status: 'paid' })), 'failed-precondition', 'over-commitment paid call');
  });

  console.log('\n== updateIcConditionStatus — [السيناريو المسمّى: owner/admin condition update] ==');
  await test('المالك يقدر يبدّل حالة شرط (تبديل ذهاباً وإياباً)', async () => {
    seedTeam();
    seedOpp('OPP1', ANALYST);
    await fns.updateIcConditionStatus(req(ANALYST, { oppId: 'OPP1', decisionIdx: 0, conditionIdx: 0 }));
    assert.strictEqual(db.__get('opportunities', 'OPP1').ic.decisions[0].conditions[0].status, 'met');
    await fns.updateIcConditionStatus(req(ANALYST, { oppId: 'OPP1', decisionIdx: 0, conditionIdx: 0 }));
    assert.strictEqual(db.__get('opportunities', 'OPP1').ic.decisions[0].conditions[0].status, 'pending');
  });
  await test('الأدمن يقدر يبدّل شرط فرصة لا يملكها', async () => {
    seedTeam();
    seedOpp('OPP2', ANALYST);
    await fns.updateIcConditionStatus(req(ADMIN, { oppId: 'OPP2', decisionIdx: 0, conditionIdx: 0 }));
    assert.strictEqual(db.__get('opportunities', 'OPP2').ic.decisions[0].conditions[0].status, 'met');
  });
  await test('عضو لجنة استثمار (senior_ic) لا يملك الفرصة يُرفَض — نفس canEditOpp تماماً، ليس دور اللجنة', async () => {
    seedTeam();
    seedOpp('OPP3', ANALYST);
    await expectThrow(() => fns.updateIcConditionStatus(req(SENIOR_IC, { oppId: 'OPP3', decisionIdx: 0, conditionIdx: 0 })), 'permission-denied', 'non-owner senior_ic toggle');
  });
  await test('فرصة بلا مالك مسجَّل (createdBy=null) — أي عضو مصرَّح له يقدر يبدّل (يطابق ownsOpp)', async () => {
    seedTeam();
    seedOpp('OPP4', null);
    await fns.updateIcConditionStatus(req(ANALYST, { oppId: 'OPP4', decisionIdx: 0, conditionIdx: 0 }));
    assert.strictEqual(db.__get('opportunities', 'OPP4').ic.decisions[0].conditions[0].status, 'met');
  });

  console.log('\n== transitionLedgerRecord — دورة الحياة الكاملة ==');
  await test('pending -> approved -> paid (مسار سليم كامل، ويُسجَّل في transactions دون تكرار)', async () => {
    seedTeam();
    db.__seed('commitments', 'CMT1', { fundId: 'F1', investorId: 'INV1', commitmentAmount: 1000 });
    db.__seed('capitalCalls', 'CC1', { fundId: 'F1', investorId: 'INV1', amount: 400, status: 'pending' });
    await fns.transitionLedgerRecord(req(FM, { kind: 'capitalCall', id: 'CC1', toStatus: 'approved' }));
    assert.strictEqual(db.__get('capitalCalls', 'CC1').status, 'approved');
    await fns.transitionLedgerRecord(req(FM, { kind: 'capitalCall', id: 'CC1', toStatus: 'paid' }));
    assert.strictEqual(db.__get('capitalCalls', 'CC1').status, 'paid');
    assert.strictEqual(Object.keys(db.__all('transactions')).length, 2, 'معاملتان فقط: اعتماد + ترحيل');
  });
  await test('لا يمكن القفز من pending مباشرة إلى paid (تخطي بوابة الاعتماد)', async () => {
    seedTeam();
    db.__seed('capitalCalls', 'CC2', { fundId: 'F1', investorId: 'INV1', amount: 100, status: 'pending' });
    await expectThrow(() => fns.transitionLedgerRecord(req(FM, { kind: 'capitalCall', id: 'CC2', toStatus: 'paid' })), 'failed-precondition', 'skip approval gate');
  });
  await test('approved -> waived مسموح لـcapitalCall فقط', async () => {
    seedTeam();
    db.__seed('capitalCalls', 'CC3', { fundId: 'F1', investorId: 'INV1', amount: 100, status: 'approved' });
    await fns.transitionLedgerRecord(req(FM, { kind: 'capitalCall', id: 'CC3', toStatus: 'waived' }));
    assert.strictEqual(db.__get('capitalCalls', 'CC3').status, 'waived');
  });
  await test('distribution لا يمكن أن تُعلَّم waived (لا مقابل لها في DISTRIBUTION_STATUS)', async () => {
    seedTeam();
    db.__seed('distributions', 'D1', { fundId: 'F1', investorId: 'INV1', amount: 100, status: 'approved' });
    await expectThrow(() => fns.transitionLedgerRecord(req(FM, { kind: 'distribution', id: 'D1', toStatus: 'waived' })), 'failed-precondition', 'distribution waived rejected');
  });
  await test('[السيناريو المسمّى: over-call at paid transition] إعادة التحقق اللحظية من السقف عند لحظة الترحيل، بعد تعديل الالتزام لاحقاً للاعتماد', async () => {
    seedTeam();
    // التزام أصلي 1000، نداء 800 اعتُمِد بشكل سليم (كان يوجد هامش وقتها).
    db.__seed('commitments', 'CMT1', { fundId: 'F1', investorId: 'INV1', commitmentAmount: 1000 });
    db.__seed('capitalCalls', 'CC4', { fundId: 'F1', investorId: 'INV1', amount: 800, status: 'approved' });
    // بين الاعتماد والترحيل، قيد عكسي يخفّض الالتزام الفعلي إلى 300 (1000 - 700).
    db.__seed('commitments', 'CMT1_REV', { fundId: 'F1', investorId: 'INV1', commitmentAmount: -700, reversalOfId: 'CMT1' });
    await expectThrow(
      () => fns.transitionLedgerRecord(req(FM, { kind: 'capitalCall', id: 'CC4', toStatus: 'paid' })),
      'failed-precondition',
      'commitment reduced after approval, must re-block at payment time'
    );
    assert.strictEqual(db.__get('capitalCalls', 'CC4').status, 'approved', 'status يجب ألا يتغيّر عند فشل التحقق');
  });
  await test('غير مدير صندوق (محلل) لا يستطيع استدعاء transitionLedgerRecord', async () => {
    seedTeam();
    db.__seed('capitalCalls', 'CC5', { fundId: 'F1', investorId: 'INV1', amount: 100, status: 'pending' });
    await expectThrow(() => fns.transitionLedgerRecord(req(ANALYST, { kind: 'capitalCall', id: 'CC5', toStatus: 'approved' })), 'permission-denied', 'analyst cannot transition');
  });

  console.log('\n== reverseTransaction — كل الفحوصات المطلوبة صراحةً ==');
  await test('عكس نداء رأس مال مُرحَّل (paid) — سجل جديد بمبلغ معكوس بالضبط، مُشتقّ من الأصل لا من العميل', async () => {
    seedTeam();
    db.__seed('capitalCalls', 'CC10', { fundId: 'F1', investorId: 'INV1', amount: 250, status: 'paid', notes: 'أصل' });
    const resp = await fns.reverseTransaction(req(FM, { kind: 'capitalCall', id: 'CC10', notes: 'تصحيح خطأ إدخال' }));
    assert.ok(resp.id && resp.id !== 'CC10');
    const rev = db.__get('capitalCalls', resp.id);
    assert.strictEqual(rev.amount, -250);
    assert.strictEqual(rev.reversalOfId, 'CC10');
    assert.strictEqual(rev.fundId, 'F1');
    assert.strictEqual(rev.investorId, 'INV1');
    assert.strictEqual(rev.status, 'paid', 'القيد العكسي يُرحَّل فوراً بنفس حالة الأصل');
  });
  await test('[السيناريو المسمّى: double reversal] لا عكس مزدوج — عكس نفس السجل مرة ثانية يُرفَض', async () => {
    seedTeam();
    db.__seed('capitalCalls', 'CC11', { fundId: 'F1', investorId: 'INV1', amount: 100, status: 'paid' });
    await fns.reverseTransaction(req(FM, { kind: 'capitalCall', id: 'CC11' }));
    await expectThrow(() => fns.reverseTransaction(req(FM, { kind: 'capitalCall', id: 'CC11' })), 'failed-precondition', 'double reversal blocked');
  });
  await test('[السيناريو المسمّى: reversal-of-reversal] لا يمكن عكس قيد هو نفسه عكسي بالفعل', async () => {
    seedTeam();
    db.__seed('capitalCalls', 'CC12', { fundId: 'F1', investorId: 'INV1', amount: 100, status: 'paid' });
    const rev = await fns.reverseTransaction(req(FM, { kind: 'capitalCall', id: 'CC12' }));
    await expectThrow(() => fns.reverseTransaction(req(FM, { kind: 'capitalCall', id: rev.id })), 'failed-precondition', 'cannot reverse a reversal');
  });
  await test('[السيناريو المسمّى: reversal of unposted record] لا يمكن عكس سجل لم يُرحَّل بعد (status: pending)', async () => {
    seedTeam();
    db.__seed('capitalCalls', 'CC13', { fundId: 'F1', investorId: 'INV1', amount: 100, status: 'pending' });
    await expectThrow(() => fns.reverseTransaction(req(FM, { kind: 'capitalCall', id: 'CC13' })), 'failed-precondition', 'cannot reverse unposted record');
  });
  await test('عكس نداء تلقائي مرتبط بمساهمة عينية (linkedCommitmentId) مسموح لأنه مُرحَّل فعلياً، ولا يُعاد ربطه', async () => {
    seedTeam();
    db.__seed('capitalCalls', 'CC14', { fundId: 'F1', investorId: 'INV1', amount: 500, status: 'paid', linkedCommitmentId: 'CMT9' });
    const resp = await fns.reverseTransaction(req(FM, { kind: 'capitalCall', id: 'CC14' }));
    assert.strictEqual(db.__get('capitalCalls', resp.id).linkedCommitmentId, null);
  });
  await test('عكس سجل غير موجود يُرفَض (not-found)', async () => {
    seedTeam();
    await expectThrow(() => fns.reverseTransaction(req(FM, { kind: 'capitalCall', id: 'NOPE' })), 'not-found', 'reverse missing record');
  });
  await test('عكس التزام (commitment) — مُرحَّل من الإنشاء دائماً، لا يحتاج status', async () => {
    seedTeam();
    db.__seed('commitments', 'CMT20', { fundId: 'F1', investorId: 'INV1', commitmentAmount: 1000 });
    const resp = await fns.reverseTransaction(req(FM, { kind: 'commitment', id: 'CMT20', notes: 'خطأ في المبلغ' }));
    assert.strictEqual(db.__get('commitments', resp.id).commitmentAmount, -1000);
  });
  await test('عكس توزيعة (distribution) مُرحَّلة (paid)', async () => {
    seedTeam();
    db.__seed('distributions', 'D20', { fundId: 'F1', investorId: 'INV1', amount: 300, status: 'paid' });
    const resp = await fns.reverseTransaction(req(FM, { kind: 'distribution', id: 'D20' }));
    assert.strictEqual(db.__get('distributions', resp.id).amount, -300);
  });
  await test('غير مدير صندوق لا يستطيع استدعاء reverseTransaction', async () => {
    seedTeam();
    db.__seed('capitalCalls', 'CC15', { fundId: 'F1', investorId: 'INV1', amount: 100, status: 'paid' });
    await expectThrow(() => fns.reverseTransaction(req(ANALYST, { kind: 'capitalCall', id: 'CC15' })), 'permission-denied', 'analyst cannot reverse');
  });

  console.log('\n== تحقق ارتدادي (regression) على approveOpportunity وlinkAssetToFund ==');
  await test('approveOpportunity لا تزال تعمل كما كانت (لم تُكسَر بإضافة requireAuthorized)', async () => {
    seedTeam();
    seedOpp('OPP10', ANALYST);
    const resp = await fns.approveOpportunity(req(SENIOR_IC, {
      oppId: 'OPP10',
      decision: { decision: 'approve' },
      readiness: { ready: true, gates: {} },
      reasons: [], conditions: [],
    }));
    assert.ok(resp.decisionId);
  });
  await test('linkAssetToFund لا تزال تعمل كما كانت', async () => {
    seedTeam();
    db.__seed('funds', 'FND1', { assetIds: [] });
    db.__seed('opportunities', 'OPP11', {
      meta: { createdBy: ANALYST },
      ic: { decisions: [{ decision: 'approve' }] },
      capitalAllocation: { targetEquity: 100, maxAllocation: 200 },
    });
    db.__seed('capitalCalls', 'CC_SEED', { fundId: 'FND1', investorId: 'INV1', amount: 500, status: 'paid' });
    const resp = await fns.linkAssetToFund(req(FM, { fundId: 'FND1', oppId: 'OPP11' }));
    assert.strictEqual(resp.ok, true);
    assert.deepStrictEqual(db.__get('funds', 'FND1').assetIds, ['OPP11']);
  });

  console.log(`\nالنتيجة: ${passed} نجح، ${failed} فشل`);
  if (failed > 0) {
    console.log('\nتفاصيل الفشل:');
    failures.forEach((f) => console.log(' -', f.name, ':', (f.err && f.err.stack) || f.err));
    process.exit(1);
  }
})();
