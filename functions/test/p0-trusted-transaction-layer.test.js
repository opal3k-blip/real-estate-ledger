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

// Phase 2R-4D4-C (third review round): linkAssetToFund now requires expectedVersion+requestId on
// every call (see functions/index.js -- assetLinkEventCountTx / assetLinkRequestPayloadsMatch).
// withLinkDefaults() supplies both automatically for the ~30 pre-existing scenarios below that were
// written before this requirement and are not themselves testing the version/replay machinery --
// each just wants "the current, correct version" and "a requestId nobody else is using".
//
// expectedVersion is derived here by counting matching type:'assetLink' transactions in the SAME
// fake db the assertions below already read via db.__all('transactions') -- this is deliberately the
// exact same computation as the server's own assetLinkEventCountTx (count of prior assetLink events
// for this exact (fundId, oppId) pair), not a separately-tracked counter that could drift from it.
// Because it re-reads the db fresh on every call, it stays correct across any number of prior
// events for that pair, seeded or executed earlier in the same test, historical or not.
//
// IMPORTANT (per explicit user instruction): this auto-detection must NEVER be used for the
// stale-request/version-conflict/replay tests below -- those must pass expectedVersion (and, where
// relevant, requestId) explicitly and deliberately, including intentionally-wrong/outdated values,
// exactly what a test helper that always "helpfully" computes the current correct version could
// never exercise. Call withLinkDefaults() only for scenarios that want to succeed (or fail for a
// business reason unrelated to versioning) against whatever the current true state already is.
let __testRequestIdSeq = 0;
function withLinkDefaults(fundId, oppId, extra) {
  extra = extra || {};
  const out = Object.assign({ fundId, oppId }, extra);
  if (!('expectedVersion' in out)) {
    const priorAssetLinkEvents = Object.values(db.__all('transactions'))
      .filter((t) => t.fundId === fundId && t.relatedId === oppId && t.type === 'assetLink').length;
    out.expectedVersion = priorAssetLinkEvents;
  }
  if (!('requestId' in out)) {
    out.requestId = 'test-req-' + (++__testRequestIdSeq) + '-' + fundId + '-' + oppId;
  }
  return out;
}

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
  await test('approveOpportunity rejects fabricated client readiness for an incomplete saved opportunity', async () => {
    seedTeam();
    seedOpp('OPP10', ANALYST);
    await expectThrow(() => fns.approveOpportunity(req(SENIOR_IC, {
      oppId: 'OPP10',
      decision: { decision: 'approve' },
      readiness: { ready: true, gates: {} },
      reasons: [], conditions: [],
      requestId: 'test-req-approve-fabricated',
    })), 'failed-precondition', 'fabricated readiness');
    assert.strictEqual(Object.keys(db.__all('icDecisions')).length, 0);
    assert.strictEqual(Object.keys(db.__all('underwritingVersions')).length, 0);
    assert.strictEqual(Object.keys(db.__all('icDecisionRequests')).length, 0);
  });
  // Phase 2R-4E: approveOpportunity now requires requestId, and only an APPROVAL decision
  // (approve/approve_conditions) writes a v4 underwritingVersions doc -- reject/hold/revise
  // still record the decision (and the request result) but must not produce a v4 version.
  await test('approveOpportunity requires a requestId', async () => {
    seedTeam();
    seedOpp('OPP12', ANALYST);
    await expectThrow(() => fns.approveOpportunity(req(SENIOR_IC, {
      oppId: 'OPP12',
      decision: { decision: 'reject' },
    })), 'invalid-argument', 'missing requestId');
    assert.strictEqual(Object.keys(db.__all('icDecisions')).length, 0);
  });
  await test('approveOpportunity reject decision is recorded but writes no v4 underwritingVersions doc', async () => {
    seedTeam();
    seedOpp('OPP13', ANALYST);
    const resp = await fns.approveOpportunity(req(SENIOR_IC, {
      oppId: 'OPP13',
      decision: { decision: 'reject' },
      reasons: [], conditions: [],
      requestId: 'test-req-approve-reject-opp13',
    }));
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(resp.versionId, null);
    assert.strictEqual(Object.keys(db.__all('icDecisions')).length, 1);
    assert.strictEqual(Object.keys(db.__all('underwritingVersions')).length, 0);
    assert.strictEqual(Object.keys(db.__all('icDecisionRequests')).length, 1);
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
    const resp = await fns.linkAssetToFund(req(FM, withLinkDefaults('FND1', 'OPP11')));
    assert.strictEqual(resp.ok, true);
    assert.deepStrictEqual(db.__get('funds', 'FND1').assetIds, ['OPP11']);
  });

  console.log('\n== Phase 2R-4D4-C: linkAssetToFund unlink guard (in-kind earmark) ==');
  await test('[السيناريو المسمّى: blocked unlink] فك ربط أصل عليه مساهمة عينية منفَّذة (paid, inKindAssetId) مرفوض لغير الأدمن', async () => {
    seedTeam();
    db.__seed('funds', 'FNDU1', { assetIds: ['OPPU1'] });
    db.__seed('opportunities', 'OPPU1', {});
    db.__seed('capitalCalls', 'CC-EXEC-CMTU1', { fundId: 'FNDU1', inKindAssetId: 'OPPU1', status: 'paid', amount: 300000 });
    await expectThrow(() => fns.linkAssetToFund(req(FM, withLinkDefaults('FNDU1', 'OPPU1', { unlink: true }))), 'failed-precondition', 'blocked unlink with earmarked in-kind');
    assert.deepStrictEqual(db.__get('funds', 'FNDU1').assetIds, ['OPPU1'], 'الربط يجب ألا يتغيّر عند الرفض');
  });
  await test('[السيناريو المسمّى: admin override unlink] الأدمن بسبب تصحيح موثَّق يقدر يفك ربط أصل عليه مساهمة عينية منفَّذة', async () => {
    seedTeam();
    db.__seed('funds', 'FNDU2', { assetIds: ['OPPU2'] });
    db.__seed('opportunities', 'OPPU2', {});
    db.__seed('capitalCalls', 'CC-EXEC-CMTU2', { fundId: 'FNDU2', inKindAssetId: 'OPPU2', status: 'paid', amount: 300000 });
    await fns.linkAssetToFund(req(ADMIN, withLinkDefaults('FNDU2', 'OPPU2', { unlink: true, correctionReason: 'تصحيح: الأرض بيعت خارج الصندوق' })));
    assert.deepStrictEqual(db.__get('funds', 'FNDU2').assetIds, []);
    const txns = Object.values(db.__all('transactions'));
    const ov = txns.find((t) => t.relatedId === 'OPPU2' && t.action === 'unlink-override');
    assert.ok(ov, 'يجب تسجيل معاملة unlink-override');
    assert.strictEqual(ov.correctionReason, 'تصحيح: الأرض بيعت خارج الصندوق');
  });
  await test('الأدمن بلا سبب تصحيح موثَّق (فراغ فقط) يبقى محظوراً — لا يكفي أن يكون أدمن دون سبب', async () => {
    seedTeam();
    db.__seed('funds', 'FNDU3', { assetIds: ['OPPU3'] });
    db.__seed('opportunities', 'OPPU3', {});
    db.__seed('capitalCalls', 'CC-EXEC-CMTU3', { fundId: 'FNDU3', inKindAssetId: 'OPPU3', status: 'paid', amount: 100000 });
    await expectThrow(() => fns.linkAssetToFund(req(ADMIN, withLinkDefaults('FNDU3', 'OPPU3', { unlink: true, correctionReason: '   ' }))), 'failed-precondition', 'admin without documented reason still blocked');
    assert.deepStrictEqual(db.__get('funds', 'FNDU3').assetIds, ['OPPU3']);
  });
  await test('مدير صندوق (غير أدمن) بسبب تصحيح مذكور يبقى محظوراً — التجاوز حصري للأدمن', async () => {
    seedTeam();
    db.__seed('funds', 'FNDU4', { assetIds: ['OPPU4'] });
    db.__seed('opportunities', 'OPPU4', {});
    db.__seed('capitalCalls', 'CC-EXEC-CMTU4', { fundId: 'FNDU4', inKindAssetId: 'OPPU4', status: 'paid', amount: 100000 });
    await expectThrow(() => fns.linkAssetToFund(req(FM, withLinkDefaults('FNDU4', 'OPPU4', { unlink: true, correctionReason: 'سبب ما' }))), 'failed-precondition', 'non-admin with reason still blocked');
    assert.deepStrictEqual(db.__get('funds', 'FNDU4').assetIds, ['OPPU4']);
  });
  await test('فك ربط عادي (بلا مساهمة عينية منفَّذة) مسموح، ويُسجَّل الآن كمعاملة unlink (إغلاق عدم تناظر التدقيق بين الربط وفكه)', async () => {
    seedTeam();
    db.__seed('funds', 'FNDU5', { assetIds: ['OPPU5'] });
    db.__seed('opportunities', 'OPPU5', {});
    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDU5', 'OPPU5', { unlink: true })));
    assert.deepStrictEqual(db.__get('funds', 'FNDU5').assetIds, []);
    const txns = Object.values(db.__all('transactions'));
    const un = txns.find((t) => t.relatedId === 'OPPU5' && t.action === 'unlink');
    assert.ok(un, 'يجب تسجيل معاملة unlink حتى بلا مساهمة عينية');
  });
  await test('[مُعدَّل عمداً هذه المرحلة -- انظر التعليق] طلب "فك" جديد (لا إعادة إرسال) على أصل غير مرتبط أصلاً، بنسخة متطابقة (0)، يُرفَض الآن بوضوح بدل أن يكون no-op صامتاً', async () => {
    // قبل هذه المرحلة، كان الحارس القديم القائم على الحالة فقط (if(unlink && !existing) return;) يجعل
    // أي طلب "فك" على أصل غير مرتبط أصلاً no-op صامتاً بلا تمييز بين "نقرة مزدوجة حقيقية لنفس الطلب
    // الذي نجح للتو" و"طلب فك طازج خاطئ لا معنى له" -- كلاهما كان يُعامَل بنفس اللامبالاة. الآن، بعد
    // اعتماد expectedVersion+requestId (راجع تعليق linkAssetToFund في functions/index.js): إعادة إرسال
    // نفس الطلب فعلاً (نفس requestId) تُعالَج عبر ذاكرة الطلبات (assetLinkRequests) قبل الوصول لهذا
    // الفحص إطلاقاً -- مُختبَر أعلاه صراحة في اختبار FNDL5. أما طلب "فك" *جديد* (requestId مختلف) على
    // أصل النسخة المتوقَّعة له تطابق الحالية (0) فعلاً لكنه غير مرتبط أصلاً، فهو تناقض منطقي بحت: لا
    // معنى لبناء طلب فك ضد نسخة تعني "لم يحدث أي ربط/فك إطلاقاً لهذا الزوج قط" -- عميل سليم لا يعرض زر
    // "فك ربط" أصلاً لأصل غير مرتبط. لذلك يُرفَض الآن صراحةً (failed-precondition، "inconsistent state،
    // refusing to guess") بدل الصمت، وهذا تشديد مقصود لا انحداراً: يكشف عميلاً فيه خلل بدل أن يبتلعه.
    seedTeam();
    db.__seed('funds', 'FNDU6', { assetIds: [] });
    db.__seed('opportunities', 'OPPU6', {});
    await expectThrow(
      () => fns.linkAssetToFund(req(FM, withLinkDefaults('FNDU6', 'OPPU6', { unlink: true }))),
      'failed-precondition',
      'REGRESSION: طلب فك جديد متناقض منطقياً (نسخة=0 مع عدم وجود ربط أصلاً) مرّ دون رفض -- عاد التساهل الصامت القديم'
    );
    assert.deepStrictEqual(db.__get('funds', 'FNDU6').assetIds, [], 'الرفض يجب ألا يُغيّر شيئاً');
    assert.strictEqual(Object.keys(db.__all('transactions')).length, 0, 'لا معاملة تُسجَّل لطلب مرفوض');
  });

  console.log('\n== Phase 2R-4D4-C: linkAssetToFund — استثناء "الأرض أولاً" (مساهمة عينية مخصَّصة) ==');
  await test('[السيناريو المسمّى: land-first bootstrap] ربط أصل بمساهمة عينية مخصَّصة له فقط — تُحتسَب ضمن السيولة القابلة للنشر لهذا الربط تحديداً', async () => {
    seedTeam();
    db.__seed('funds', 'FNDB1', { assetIds: [] });
    db.__seed('opportunities', 'OPPB1', {
      meta: { createdBy: ANALYST },
      ic: { decisions: [{ decision: 'approve' }] },
      capitalAllocation: { targetEquity: 250000, maxAllocation: 300000 },
    });
    db.__seed('capitalCalls', 'CC-EXEC-CMTB1', { fundId: 'FNDB1', inKindAssetId: 'OPPB1', linkedCommitmentId: 'CMTB1', status: 'paid', amount: 250000 });
    const resp = await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDB1', 'OPPB1')));
    assert.strictEqual(resp.ok, true);
    assert.deepStrictEqual(db.__get('funds', 'FNDB1').assetIds, ['OPPB1']);
  });
  await test('مساهمة عينية مخصَّصة لأصل آخر لا تُحتسَب ضمن سيولة أصل مختلف — يُرفَض لعدم كفاية السيولة', async () => {
    seedTeam();
    db.__seed('funds', 'FNDB2', { assetIds: [] });
    db.__seed('opportunities', 'OPPB2', {
      meta: { createdBy: ANALYST },
      ic: { decisions: [{ decision: 'approve' }] },
      capitalAllocation: { targetEquity: 250000, maxAllocation: 300000 },
    });
    db.__seed('capitalCalls', 'CC-EXEC-CMTB2', { fundId: 'FNDB2', inKindAssetId: 'OPPB2-OTHER', linkedCommitmentId: 'CMTB2', status: 'paid', amount: 250000 });
    await expectThrow(() => fns.linkAssetToFund(req(FM, withLinkDefaults('FNDB2', 'OPPB2'))), 'failed-precondition', 'in-kind earmarked to a different asset must not count here');
  });

  console.log('\n== Phase 2R-4D4-C (تصحيح): "الأرض أولًا" عبر أصلين -- فصل التغطية العينية عن النقد، وترتيب معاملات assetLink ==');
  await test('[السيناريو المسمّى: land-first two-asset، ترتيب أ) عيني ثم نقدي] أصل ممول عينياً بالكامل لا يستهلك نقد أصل آخر ممول نقدياً حقيقياً', async () => {
    seedTeam();
    db.__seed('funds', 'FNDL1', { assetIds: [] });
    db.__seed('opportunities', 'OPPLA', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 250000, maxAllocation: 300000 } });
    db.__seed('opportunities', 'OPPLB', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 50000, maxAllocation: 100000 } });
    db.__seed('commitments', 'CMTLA', { fundId: 'FNDL1', investorId: 'INV1', commitmentAmount: 250000, contributionType: 'in_kind' });
    db.__seed('capitalCalls', 'CC-EXEC-CMTLA', { fundId: 'FNDL1', inKindAssetId: 'OPPLA', linkedCommitmentId: 'CMTLA', status: 'paid', amount: 250000 });
    db.__seed('capitalCalls', 'CC-CASH-L1', { fundId: 'FNDL1', investorId: 'INV2', status: 'paid', amount: 100000 });
    const respA = await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL1', 'OPPLA')));
    assert.strictEqual(respA.ok, true, 'OPPLA (عيني بالكامل) يجب أن يُربَط بنجاح');
    // قبل الإصلاح: allocatedElsewhereTx كان يخصم كامل تخصيص OPPLA (250000) من النقد المشترك، فيصفّر
    // سيولة OPPLB رغم وجود 100000 نقداً حقيقياً لم تمسّه OPPLA إطلاقاً -- هذا هو الخلل المُصلَح هنا.
    const respB = await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL1', 'OPPLB')));
    assert.strictEqual(respB.ok, true, 'REGRESSION: OPPLB (نقدي حقيقي 50000 من أصل 100000 متاح) رُفض رغم توفر النقد -- الأرض حُسبت كأنها استهلكت نقداً لم تلمسه');
    assert.deepStrictEqual(db.__get('funds', 'FNDL1').assetIds, ['OPPLA', 'OPPLB']);
  });
  await test('[نفس السيناريو، ترتيب ب) نقدي ثم عيني] لا يتغيّر بترتيب الربط', async () => {
    seedTeam();
    db.__seed('funds', 'FNDL1B', { assetIds: [] });
    db.__seed('opportunities', 'OPPLA2', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 250000, maxAllocation: 300000 } });
    db.__seed('opportunities', 'OPPLB2', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 50000, maxAllocation: 100000 } });
    db.__seed('commitments', 'CMTLA2', { fundId: 'FNDL1B', investorId: 'INV1', commitmentAmount: 250000, contributionType: 'in_kind' });
    db.__seed('capitalCalls', 'CC-EXEC-CMTLA2', { fundId: 'FNDL1B', inKindAssetId: 'OPPLA2', linkedCommitmentId: 'CMTLA2', status: 'paid', amount: 250000 });
    db.__seed('capitalCalls', 'CC-CASH-L1B', { fundId: 'FNDL1B', investorId: 'INV2', status: 'paid', amount: 100000 });
    const respB = await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL1B', 'OPPLB2')));
    assert.strictEqual(respB.ok, true);
    const respA = await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL1B', 'OPPLA2')));
    assert.strictEqual(respA.ok, true);
    assert.deepStrictEqual(db.__get('funds', 'FNDL1B').assetIds, ['OPPLB2', 'OPPLA2']);
  });
  await test('أصل مختلط التمويل (عيني جزئي + نقد) يستهلك من مجمع النقد المشترك جزءه النقدي فقط -- ليس تخصيصه الكامل ولا صفراً', async () => {
    seedTeam();
    db.__seed('funds', 'FNDL2', { assetIds: [] });
    // OPPMIXED: تخصيص مستهدف 200000، منه 120000 مغطاة عينياً (منفَّذة) -- الباقي 80000 يجب أن يُسحَب
    // من النقد الحقيقي. رأس مال الصندوق النقدي = 100000 (فائض 20000 عن حاجة OPPMIXED).
    db.__seed('opportunities', 'OPPMIXED', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 200000, maxAllocation: 250000 } });
    db.__seed('commitments', 'CMTMIX', { fundId: 'FNDL2', investorId: 'INV1', commitmentAmount: 120000, contributionType: 'in_kind' });
    db.__seed('capitalCalls', 'CC-EXEC-CMTMIX', { fundId: 'FNDL2', inKindAssetId: 'OPPMIXED', linkedCommitmentId: 'CMTMIX', status: 'paid', amount: 120000 });
    db.__seed('capitalCalls', 'CC-CASH-L2', { fundId: 'FNDL2', investorId: 'INV2', status: 'paid', amount: 100000 });
    const respMixed = await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL2', 'OPPMIXED')));
    assert.strictEqual(respMixed.ok, true, 'OPPMIXED (200000 مستهدف، 120000 عيني + 80000 نقد متاح) يجب أن يُربَط');
    // المتبقي الحقيقي = 100000 - 80000(المستهلَك فعلاً من OPPMIXED) = 20000 بالضبط.
    db.__seed('opportunities', 'OPPCASH2A', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 20000, maxAllocation: 30000 } });
    const okAt20000 = await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL2', 'OPPCASH2A')));
    assert.strictEqual(okAt20000.ok, true, 'يجب توفّر 20000 نقداً بالضبط بعد استهلاك OPPMIXED لجزئه النقدي (80000) فقط، لا كامل تخصيصه (200000)');
  });
  await test('نفس أصل التمويل المختلط -- طلب أكثر من الباقي الحقيقي (20001) يُرفَض، ما يُثبت أن المخصوم هو 80000 بالضبط لا 0 ولا 200000', async () => {
    seedTeam();
    db.__seed('funds', 'FNDL2B', { assetIds: [] });
    db.__seed('opportunities', 'OPPMIXEDB', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 200000, maxAllocation: 250000 } });
    db.__seed('commitments', 'CMTMIXB', { fundId: 'FNDL2B', investorId: 'INV1', commitmentAmount: 120000, contributionType: 'in_kind' });
    db.__seed('capitalCalls', 'CC-EXEC-CMTMIXB', { fundId: 'FNDL2B', inKindAssetId: 'OPPMIXEDB', linkedCommitmentId: 'CMTMIXB', status: 'paid', amount: 120000 });
    db.__seed('capitalCalls', 'CC-CASH-L2B', { fundId: 'FNDL2B', investorId: 'INV2', status: 'paid', amount: 100000 });
    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL2B', 'OPPMIXEDB')));
    db.__seed('opportunities', 'OPPCASH2B', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 20001, maxAllocation: 30000 } });
    await expectThrow(() => fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL2B', 'OPPCASH2B'))), 'failed-precondition', 'only 20000 real cash should remain after the mixed asset consumed its 80000 cash portion');
  });
  await test('تغطية عينية زائدة عن تخصيص الأصل المستهدف لا تُنتج نقداً إضافياً لأصل آخر', async () => {
    seedTeam();
    db.__seed('funds', 'FNDL3', { assetIds: [] });
    // OPPOVER: مستهدف 100000 لكن مغطى عينياً بـ150000 (زيادة 50000) -- الصندوق بلا أي نقد حقيقي إطلاقاً.
    db.__seed('opportunities', 'OPPOVER', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 100000, maxAllocation: 200000 } });
    db.__seed('commitments', 'CMTOVER', { fundId: 'FNDL3', investorId: 'INV1', commitmentAmount: 150000, contributionType: 'in_kind' });
    db.__seed('capitalCalls', 'CC-EXEC-CMTOVER', { fundId: 'FNDL3', inKindAssetId: 'OPPOVER', linkedCommitmentId: 'CMTOVER', status: 'paid', amount: 150000 });
    const respOver = await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL3', 'OPPOVER')));
    assert.strictEqual(respOver.ok, true, 'OPPOVER (100000 مستهدف مغطى بـ150000 عينياً) يجب أن يُربَط اعتماداً على تغطيته الذاتية فقط');
    db.__seed('opportunities', 'OPPCASH3', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 1, maxAllocation: 10 } });
    await expectThrow(() => fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL3', 'OPPCASH3'))), 'failed-precondition', 'REGRESSION: excess in-kind coverage on OPPOVER manufactured spare cash for a different asset despite zero real cash in the fund');
  });
  await test('التزام عيني غير مُنفَّذ (pending) لا يمنح أي تغطية -- الربط يُرفَض دون نقد حقيقي', async () => {
    seedTeam();
    db.__seed('funds', 'FNDL4A', { assetIds: [] });
    db.__seed('opportunities', 'OPPPEND', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 999999, maxAllocation: 1000000 } });
    db.__seed('commitments', 'CMTPEND', { fundId: 'FNDL4A', investorId: 'INV1', commitmentAmount: 999999, contributionType: 'in_kind' });
    // status: 'pending' -- لم يُنفَّذ فعلياً بعد (بخلاف كل حالات هذا الملف الأخرى وهي 'paid').
    db.__seed('capitalCalls', 'CC-EXEC-CMTPEND', { fundId: 'FNDL4A', inKindAssetId: 'OPPPEND', linkedCommitmentId: 'CMTPEND', status: 'pending', amount: 999999 });
    await expectThrow(() => fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL4A', 'OPPPEND'))), 'failed-precondition', 'an unexecuted (pending) in-kind commitment must not count as coverage');
  });
  await test('مساهمة عينية منفَّذة ثم معكوسة بالكامل تُصفَّر أثرها -- لا تمنح تغطية لأصل آخر', async () => {
    seedTeam();
    db.__seed('funds', 'FNDL4B', { assetIds: [] });
    db.__seed('opportunities', 'OPPREV', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 200000, maxAllocation: 300000 } });
    db.__seed('commitments', 'CMTREV', { fundId: 'FNDL4B', investorId: 'INV1', commitmentAmount: 200000, contributionType: 'in_kind' });
    db.__seed('capitalCalls', 'CC-EXEC-CMTREV', { fundId: 'FNDL4B', inKindAssetId: 'OPPREV', linkedCommitmentId: 'CMTREV', status: 'paid', amount: 200000 });
    // عكس reverseTransaction الحقيقي: نفس inKindAssetId، status paid، مبلغ سالب، بلا linkedCommitmentId
    // (يطابق تماماً سلوك exports.reverseTransaction في functions/index.js).
    db.__seed('capitalCalls', 'CC-REV-CMTREV', { fundId: 'FNDL4B', inKindAssetId: 'OPPREV', reversalOfId: 'CC-EXEC-CMTREV', status: 'paid', amount: -200000, linkedCommitmentId: null });
    await expectThrow(() => fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL4B', 'OPPREV'))), 'failed-precondition', 'a fully reversed in-kind contribution must net to zero coverage, not still count as 200000');
  });

  console.log('\n== Phase 2R-4D4-C (الجولة الرابعة من المراجعة): تصنيف السجلات العينية القديمة (linkedCommitmentId بلا inKindAssetId) وعكوسها ضمن السيولة القابلة للنشر ==');
  await test('[السيناريو المسمّى: legacy in-kind grants no cash] سجل عيني قديم (سابق لمرحلة 2R-4D4-B، linkedCommitmentId فقط بلا inKindAssetId) لا يمنح أي سيولة نقدية قابلة للنشر -- ربط أصل يتجاوز النقد الحقيقي يُرفَض رغم أن المجموع الظاهري (عيني + نقد) يكفيه', async () => {
    seedTeam();
    db.__seed('funds', 'FNDLEG1', { assetIds: [] });
    db.__seed('opportunities', 'OPPLEG1', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 150000, maxAllocation: 200000 } });
    // شكل قديم حقيقي (ما قبل حقل inKindAssetId): linkedCommitmentId هو العلامة الوحيدة على أنه عيني،
    // لا حقل inKindAssetId إطلاقاً في هذا السجل -- تماماً تصنيف 'missingAssetLink' في
    // functions/scripts/legacy-inkind-audit.cjs.
    db.__seed('capitalCalls', 'CC-LEGACY-OLD1', { fundId: 'FNDLEG1', investorId: 'INV1', status: 'paid', amount: 200000, linkedCommitmentId: 'CMTLEG1' });
    db.__seed('capitalCalls', 'CC-CASH-LEG1', { fundId: 'FNDLEG1', investorId: 'INV2', status: 'paid', amount: 100000 });
    // النقد الحقيقي = 100000 فقط (السجل العيني القديم 200000 مستبعَد بالكامل) -- 150000 المطلوبة
    // تتجاوز هذا النقد الحقيقي، رغم أن المجموع الخام (300000) يكفيها بسهولة. قبل هذا الإصلاح: كان
    // التصنيف يعتمد على inKindAssetId وحده، فكان هذا السجل القديم (بلا inKindAssetId) يُحتسَب نقداً
    // خطأً، وكان الربط سينجح خطأً.
    await expectThrow(
      () => fns.linkAssetToFund(req(FM, withLinkDefaults('FNDLEG1', 'OPPLEG1'))),
      'failed-precondition',
      'REGRESSION: سجل عيني قديم (linkedCommitmentId بلا inKindAssetId) احتُسِب كنقد قابل للنشر'
    );
  });
  await test('[السيناريو المسمّى: legacy in-kind reversal does not change cash] عكس سجل عيني قديم لا يغيّر السيولة النقدية -- يبقى النقد الحقيقي كما هو تماماً بوجود العكس أو بدونه', async () => {
    seedTeam();
    db.__seed('funds', 'FNDLEG2', { assetIds: [] });
    db.__seed('opportunities', 'OPPLEG2', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 100000, maxAllocation: 150000 } });
    db.__seed('capitalCalls', 'CC-LEGACY-OLD2', { fundId: 'FNDLEG2', investorId: 'INV1', status: 'paid', amount: 200000, linkedCommitmentId: 'CMTLEG2' });
    // عكس مطابق تماماً لسلوك reverseTransaction الحقيقي على سجل قديم: linkedCommitmentId يُصفَّر
    // صراحة (كما تفعل reverseTransaction لكل عكس غير commitment)، ولا يوجد inKindAssetId ليُبقيه --
    // السجل الأصلي لم يحمله أصلاً. بلا هذا الإصلاح، هذا العكس (بلا أي علامة مباشرة إطلاقاً) كان
    // سيُحتسَب نقداً سالباً وهمياً، مخفِّضاً النقد الحقيقي الظاهري دون أي سبب حقيقي.
    db.__seed('capitalCalls', 'CC-LEGACY-OLD2-REV', { fundId: 'FNDLEG2', investorId: 'INV1', status: 'paid', amount: -200000, reversalOfId: 'CC-LEGACY-OLD2', linkedCommitmentId: null });
    db.__seed('capitalCalls', 'CC-CASH-LEG2', { fundId: 'FNDLEG2', investorId: 'INV2', status: 'paid', amount: 100000 });
    // النقد الحقيقي = 100000 بالضبط (السجل القديم وعكسه مستبعَدان كلاهما) -- طلب 100000 بالضبط يجب
    // أن ينجح. لو احتُسِب العكس خطأً كنقد سالب (-200000)، لكان الناتج -100000 (يُصفَّر إلى 0) فيُرفَض
    // الطلب رغم توفّر 100000 حقيقية بالفعل.
    const resp = await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDLEG2', 'OPPLEG2')));
    assert.strictEqual(resp.ok, true, 'REGRESSION: عكس سجل عيني قديم غيّر السيولة النقدية الحقيقية (100000) بدل تركها كما هي');
    assert.deepStrictEqual(db.__get('funds', 'FNDLEG2').assetIds, ['OPPLEG2']);
  });
  await test('[السيناريو المسمّى: independent cash from same investor still counted] مساهمة نقدية مستقلة من نفس مستثمر السجل العيني القديم تبقى محسوبة كاملة ضمن النقد الحقيقي', async () => {
    seedTeam();
    db.__seed('funds', 'FNDLEG3', { assetIds: [] });
    db.__seed('opportunities', 'OPPLEG3', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 50000, maxAllocation: 100000 } });
    // نفس المستثمر INV1 له سجل عيني قديم مستبعَد (300000) ونداء نقدي مستقل منفصل (50000) -- التصنيف
    // على مستوى كل سجل بعينه لا على مستوى المستثمر، فاستبعاد أحدهما يجب ألا يمسّ الآخر إطلاقاً.
    db.__seed('capitalCalls', 'CC-LEGACY-OLD3', { fundId: 'FNDLEG3', investorId: 'INV1', status: 'paid', amount: 300000, linkedCommitmentId: 'CMTLEG3' });
    db.__seed('capitalCalls', 'CC-CASH-INV1-LEG3', { fundId: 'FNDLEG3', investorId: 'INV1', status: 'paid', amount: 50000 });
    const resp = await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDLEG3', 'OPPLEG3')));
    assert.strictEqual(resp.ok, true, 'REGRESSION: مساهمة نقدية مستقلة من نفس مستثمر السجل العيني القديم لم تُحتسَب');
    assert.deepStrictEqual(db.__get('funds', 'FNDLEG3').assetIds, ['OPPLEG3']);
  });

  console.log('\n== Phase 2R-4D4-C (assetLink hardening): معرّفات متسلسلة، منع التكرار عند إعادة الطلب، وتسلسل ربط/فك/إعادة ربط صحيح ==');
  await test('ربط ثم إعادة نفس طلب الربط بالضبط (نفس requestId ونفس expectedVersion -- نقرة مزدوجة حقيقية) تُعيد النتيجة المحفوظة دون معاملة إضافية؛ فك ثم إعادته كذلك؛ ثم إعادة ربط شرعية (requestId ونسخة جديدان) تحصل على تسلسل جديد', async () => {
    seedTeam();
    db.__seed('funds', 'FNDL5', { assetIds: [] });
    db.__seed('opportunities', 'OPPL5', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 1000, maxAllocation: 2000 } });
    db.__seed('capitalCalls', 'CC-CASH-L5', { fundId: 'FNDL5', investorId: 'INV1', status: 'paid', amount: 1000 });

    const txnsOfFund = () => Object.entries(db.__all('transactions')).filter(([, t]) => t.fundId === 'FNDL5' && t.type === 'assetLink');

    // Phase 2R-4D4-C (third review round): "نقرة مزدوجة" حقيقية تعني أن العميل بنى الحمولة (بما فيها
    // requestId وexpectedVersion) مرة واحدة قبل إرسال أي من الطلبين -- فكلاهما يحملان القيمتين
    // نفسيهما بالضبط. لهذا نُثبِّت الحمولة هنا صراحةً بدل استدعاء withLinkDefaults() مرتين (كل استدعاء
    // له كان سيحسب expectedVersion/requestId مختلفين لأن الأول ينجح بينهما ويُغيّر الحالة)، تماماً كما
    // يوجّه توضيح المستخدم: مساعد الاختبار لا يجب أن "يحدّث" النسخة تلقائياً هنا.
    const linkPayload = withLinkDefaults('FNDL5', 'OPPL5');
    await fns.linkAssetToFund(req(FM, linkPayload));
    assert.deepStrictEqual(db.__get('funds', 'FNDL5').assetIds, ['OPPL5']);
    let txns = txnsOfFund();
    assert.strictEqual(txns.length, 1, 'ربط ناجح واحد يجب أن يُنتج معاملة assetLink واحدة بالضبط');
    assert.strictEqual(txns[0][0], 'assetLink-FNDL5-OPPL5-1', 'المعرّف الحتمي الأول يجب أن يحمل التسلسل 1');
    assert.strictEqual(txns[0][1].action, 'create');

    // إعادة إرسال الحمولة نفسها بالضبط (نفس requestId + نفس expectedVersion) -- طلب "نُفِّذ سابقًا ثم
    // أُعيد": يجب أن تُعاد نتيجته المحفوظة (نفس newVersion) دون أي تغيير في الحالة الحالية ودون قراءة/
    // كتابة جديدة على منطق العمل (assetIds يبقى كما هو، ولا معاملة ثانية).
    const replay = await fns.linkAssetToFund(req(FM, linkPayload));
    assert.strictEqual(replay.newVersion, 1, 'إعادة الإرسال يجب أن تُعيد نتيجة الطلب الأصلي المحفوظة بالضبط (newVersion=1)، لا نتيجة جديدة');
    assert.deepStrictEqual(db.__get('funds', 'FNDL5').assetIds, ['OPPL5']);
    txns = txnsOfFund();
    assert.strictEqual(txns.length, 1, 'REGRESSION: إعادة إرسال نفس الطلب (نفس requestId) أنتجت معاملة مكرَّرة بدل إعادة النتيجة المحفوظة فقط');

    const unlinkPayload = withLinkDefaults('FNDL5', 'OPPL5', { unlink: true });
    await fns.linkAssetToFund(req(FM, unlinkPayload));
    assert.deepStrictEqual(db.__get('funds', 'FNDL5').assetIds, []);
    txns = txnsOfFund();
    assert.strictEqual(txns.length, 2, 'فك ربط ناجح يجب أن يُضيف معاملة assetLink ثانية');
    const unlinkTxn = txns.find(([id]) => id === 'assetLink-FNDL5-OPPL5-2');
    assert.ok(unlinkTxn, 'المعرّف الحتمي الثاني يجب أن يحمل التسلسل 2 (تسلسل عام لكل أحداث هذا الأصل، لا معرّف ثابت على الأصل وحده)');
    assert.strictEqual(unlinkTxn[1].action, 'unlink');

    // إعادة إرسال طلب الفك نفسه بالضبط (نفس requestId + نفس expectedVersion) -- نفس منطق إعادة
    // الإرسال أعلاه: نتيجة محفوظة تُعاد، لا معاملة ثالثة.
    const unlinkReplay = await fns.linkAssetToFund(req(FM, unlinkPayload));
    assert.strictEqual(unlinkReplay.newVersion, 2, 'إعادة إرسال طلب الفك يجب أن تُعيد نتيجته المحفوظة بالضبط (newVersion=2)');
    txns = txnsOfFund();
    assert.strictEqual(txns.length, 2, 'REGRESSION: إعادة إرسال طلب الفك (نفس requestId) أنتجت معاملة إضافية بدل إعادة النتيجة المحفوظة');

    // إعادة ربط شرعية بعد فك حقيقي -- requestId وexpectedVersion جديدان (يُستنتَجان تلقائياً هنا من
    // الحالة الراهنة الصحيحة، لأن هذا فعلاً طلب جديد لا إعادة إرسال) -- يجب أن تنجح وتحصل على تسلسل
    // جديد (3)، لا أن تُحجَب بمعرّف ثابت أو بنسخة قديمة.
    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDL5', 'OPPL5')));
    assert.deepStrictEqual(db.__get('funds', 'FNDL5').assetIds, ['OPPL5']);
    txns = txnsOfFund();
    assert.strictEqual(txns.length, 3, 'إعادة ربط شرعية بعد فك حقيقي يجب أن تُضيف معاملة ثالثة');
    const relinkTxn = txns.find(([id]) => id === 'assetLink-FNDL5-OPPL5-3');
    assert.ok(relinkTxn, 'REGRESSION: معرّف ثابت على الأصل وحده كان سيمنع تسجيل هذا الحدث اللاحق (إعادة الربط)');
    assert.strictEqual(relinkTxn[1].action, 'create');
  });

  await test('[السيناريو المسمّى: replay of an already-executed request after later real events] ربط ← فك ناجح ← إعادة ربط ناجحة ← إعادة إرسال طلب الفك نفسه (نفس requestId ونفس الحمولة) المنفَّذ فعلياً سابقاً -- يختلف عن اختبار "طلب قديم لم يُنفَّذ أصلاً" (FNDSTALE أعلاه) لأن هذا الطلب نجح فعلياً وله نتيجة محفوظة، لا مجرَّد نسخة قديمة لم تُنفَّذ بعد قط', async () => {
    seedTeam();
    db.__seed('funds', 'FNDREPLAY', { assetIds: [] });
    db.__seed('opportunities', 'OPPREPLAY', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 500, maxAllocation: 1000 } });
    db.__seed('capitalCalls', 'CC-CASH-REPLAY', { fundId: 'FNDREPLAY', investorId: 'INV1', status: 'paid', amount: 500 });

    // (1) ربط حقيقي -- النسخة تصبح 1.
    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDREPLAY', 'OPPREPLAY')));
    assert.deepStrictEqual(db.__get('funds', 'FNDREPLAY').assetIds, ['OPPREPLAY']);

    // (2) فك حقيقي ناجح -- النسخة تصبح 2. نُثبِّت حمولة هذا الطلب بالضبط (requestId وexpectedVersion
    // المُستخدَمان هنا فعلياً) لإعادة إرسالها لاحقاً حرفياً، تماماً كما يفعل متصفح أعاد نفس النقرة.
    const executedUnlinkPayload = withLinkDefaults('FNDREPLAY', 'OPPREPLAY', { unlink: true });
    const firstUnlinkResp = await fns.linkAssetToFund(req(FM, executedUnlinkPayload));
    assert.strictEqual(firstUnlinkResp.newVersion, 2);
    assert.deepStrictEqual(db.__get('funds', 'FNDREPLAY').assetIds, []);

    // (3) إعادة ربط حقيقية لاحقة ناجحة -- النسخة تصبح 3 (requestId ونسخة جديدان، مُستنتَجان تلقائياً
    // هنا لأن هذا فعلاً طلب جديد لا إعادة إرسال).
    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDREPLAY', 'OPPREPLAY')));
    assert.deepStrictEqual(db.__get('funds', 'FNDREPLAY').assetIds, ['OPPREPLAY'], 'الحالة الفعلية بعد الأحداث الثلاثة: مربوط من جديد (النسخة الحالية = 3)');
    const txnsBeforeReplay = Object.entries(db.__all('transactions')).filter(([, t]) => t.fundId === 'FNDREPLAY' && t.type === 'assetLink');
    assert.strictEqual(txnsBeforeReplay.length, 3, 'ثلاثة أحداث حقيقية يجب أن تُنتج ثلاث معاملات assetLink بالضبط قبل إعادة الإرسال أدناه');

    // (4) إعادة إرسال طلب الفك من الخطوة (2) بالضبط -- نفس requestId ونفس الحمولة حرفياً (expectedVersion
    // فيه = 1، متجاوَز تماماً الآن بعد الأحداث الحقيقية اللاحقة). خلافاً لاختبار FNDSTALE أعلاه (طلب
    // بنسخة قديمة لم يُنفَّذ قط من قبل، يُرفَض بـaborted)، هذا الطلب بعينه (requestId) قد نُفِّذ فعلياً
    // ونجح في الخطوة (2) وله نتيجة محفوظة في assetLinkRequests -- فحص linkAssetToFund الأول (مطابقة
    // requestId + الحمولة) يجب أن يُعيد تلك النتيجة المحفوظة فوراً، دون حتى الوصول لفحص النسخة الحالية،
    // ودون أي قراءة/كتابة جديدة على منطق العمل.
    const replayResp = await fns.linkAssetToFund(req(FM, executedUnlinkPayload));
    assert.strictEqual(replayResp.newVersion, 2, 'REGRESSION: إعادة إرسال طلب فك مُنفَّذ سابقاً بعد أحداث لاحقة يجب أن تُعيد نتيجته المحفوظة الأصلية (newVersion=2)، لا نتيجة جديدة ولا رفضاً');
    assert.deepStrictEqual(db.__get('funds', 'FNDREPLAY').assetIds, ['OPPREPLAY'], 'REGRESSION: إعادة إرسال طلب الفك القديم المنفَّذ سابقاً غيَّرت الحالة الحالية -- كان يجب أن يبقى الأصل مربوطاً (نتيجة الخطوة 3) دون أي أثر لإعادة الإرسال هذه');
    const txnsAfterReplay = Object.entries(db.__all('transactions')).filter(([, t]) => t.fundId === 'FNDREPLAY' && t.type === 'assetLink');
    assert.strictEqual(txnsAfterReplay.length, 3, 'REGRESSION: إعادة إرسال طلب مُنفَّذ سابقاً أنشأت سجل تدقيق إضافياً بدل الاكتفاء بإعادة النتيجة المحفوظة');
  });

  await test('نفس الأصل يُربط بصندوقين مختلفين على التوالي (بعد فك حقيقي) -- معرّفا المعاملتين لا يتصادمان ولا يُتلِف أحدهما الآخر', async () => {
    seedTeam();
    db.__seed('funds', 'FNDXA', { assetIds: [] });
    db.__seed('funds', 'FNDXB', { assetIds: [] });
    db.__seed('opportunities', 'OPPX', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 500, maxAllocation: 1000 } });
    db.__seed('capitalCalls', 'CC-CASH-XA', { fundId: 'FNDXA', investorId: 'INV1', status: 'paid', amount: 500 });
    db.__seed('capitalCalls', 'CC-CASH-XB', { fundId: 'FNDXB', investorId: 'INV1', status: 'paid', amount: 500 });

    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDXA', 'OPPX')));
    const originalA = db.__get('transactions', 'assetLink-FNDXA-OPPX-1');
    assert.ok(originalA, 'REGRESSION: سجل صندوق A لم يُكتب بالمعرّف المتوقَّع الذي يتضمّن fundId');
    assert.strictEqual(originalA.fundId, 'FNDXA');

    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDXA', 'OPPX', { unlink: true })));

    // نفس الأصل يُربط الآن بصندوق مختلف تماماً -- عدّاد التسلسل لصندوق B يبدأ من 1 مستقلاً عن صندوق A
    // (نطاق الاستعلام في nextAssetLinkSeqTx مُقيَّد بـfundId)، فلولا تضمين fundId داخل نص المعرّف نفسه
    // (لا الاكتفاء بتقييد عدّاد التسلسل به) لتصادم assetLink-OPPX-1 الجديد لصندوق B مع سجل صندوق A
    // القديم بنفس المعرّف تماماً، و tx.set() بلا merge كان سيستبدله بالكامل صامتاً.
    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDXB', 'OPPX')));
    const stillA = db.__get('transactions', 'assetLink-FNDXA-OPPX-1');
    assert.ok(stillA, 'REGRESSION: سجل صندوق A الأصلي اختفى عند ربط نفس الأصل بصندوق آخر لاحقاً');
    assert.strictEqual(stillA.fundId, 'FNDXA', 'REGRESSION: سجل صندوق A استُبدل ببيانات صندوق B -- تصادم معرّفات فعلي');
    const originalB = db.__get('transactions', 'assetLink-FNDXB-OPPX-1');
    assert.ok(originalB, 'صندوق B يجب أن يحصل على سجله المستقل الخاص به');
    assert.strictEqual(originalB.fundId, 'FNDXB');
  });

  await test('[مُصلَح -- كان قيداً معمارياً موثَّقاً سابقاً] طلب "فك" قديم يحمل نسخة متجاوزة (وصل بعد فك حقيقي ثم إعادة ربط لاحقة) يُرفَض بوضوح (aborted)، ولا يُنفَّذ بحسب الحالة الراهنة كما كان يحدث قبل هذا الإصلاح', async () => {
    seedTeam();
    db.__seed('funds', 'FNDSTALE', { assetIds: [] });
    db.__seed('opportunities', 'OPPSTALE', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 500, maxAllocation: 1000 } });
    db.__seed('capitalCalls', 'CC-CASH-STALE', { fundId: 'FNDSTALE', investorId: 'INV1', status: 'paid', amount: 500 });

    // الحدث (1): ربط حقيقي -- النسخة تصبح 1. طلب "الفك" أدناه بُني هنا في الأصل (تخيّل متصفحاً رأى
    // هذه الحالة تحديداً) حاملاً expectedVersion=1، لكنه تأخّر في الشبكة ولم يصل الخادم بعد.
    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDSTALE', 'OPPSTALE')));
    const staleUnlinkRequestId = 'stale-unlink-req-1';
    const staleUnlinkPayload = { fundId: 'FNDSTALE', oppId: 'OPPSTALE', unlink: true, expectedVersion: 1, requestId: staleUnlinkRequestId };

    // في هذه الأثناء، حدثان حقيقيان آخران يصلان ويُنفَّذان فعلياً قبل الطلب المتأخر: فك (2) ثم إعادة
    // ربط حقيقية (3) -- بنسخ ومعرّفات مُستنتَجة هنا تلقائياً (لا يدوياً) لأنهما فعلاً طلبان جديدان،
    // لا إعادة إرسال؛ withLinkDefaults تحسب النسخة الصحيحة الحالية في كل مرة، لا نسخة ثابتة مفترَضة.
    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDSTALE', 'OPPSTALE', { unlink: true })));
    await fns.linkAssetToFund(req(FM, withLinkDefaults('FNDSTALE', 'OPPSTALE')));
    assert.deepStrictEqual(db.__get('funds', 'FNDSTALE').assetIds, ['OPPSTALE'], 'الحالة الفعلية بعد الأحداث الثلاثة الحقيقية يجب أن تكون: مربوط (النسخة الحالية = 3)');

    // يصل الآن الطلب المتأخر أعلاه أخيراً، حاملاً expectedVersion=1 -- صحيح حين بُني، متجاوَز الآن
    // (النسخة الفعلية = 3). الإصلاح المعتمَد في هذه المرحلة: يُرفَض بوضوح (HttpsError('aborted', ...))
    // بدل أن يُنفَّذ بحسب الحالة الراهنة (existing==true) كما كان يحدث في نسخة هذا الاختبار السابقة على
    // الإصلاح -- ما كان سيُلغي إعادة الربط الحقيقية الأحدث صامتاً ودون أي أثر.
    await expectThrow(
      () => fns.linkAssetToFund(req(FM, staleUnlinkPayload)),
      'aborted',
      'REGRESSION: طلب فك قديم بنسخة متجاوزة نُفِّذ فعلياً بدل أن يُرفَض -- عودة إلى القيد المعماري ما قبل الإصلاح'
    );
    assert.deepStrictEqual(db.__get('funds', 'FNDSTALE').assetIds, ['OPPSTALE'], 'رفض الطلب القديم يجب ألا يُغيّر الحالة الحالية إطلاقاً');

    // طلب لاحق بنفس requestId لكن بالنسخة الحالية الصحيحة (3) ينجح طبيعياً بعد ذلك -- يثبت أن الرفض
    // أعلاه لم يُخزَّن كـ"نتيجة منفَّذة" لهذا requestId (الرفض يحدث قبل أي كتابة على assetLinkRequests
    // في functions/index.js)، فلا حبس دائم لهذا المعرّف.
    await fns.linkAssetToFund(req(FM, { fundId: 'FNDSTALE', oppId: 'OPPSTALE', unlink: true, expectedVersion: 3, requestId: staleUnlinkRequestId }));
    assert.deepStrictEqual(db.__get('funds', 'FNDSTALE').assetIds, [], 'إعادة استخدام نفس requestId لاحقاً بنسخة صحيحة يجب أن ينجح فعلياً -- الرفض السابق لم يُخزَّن كنتيجة "منفَّذة" تحبس هذا المعرّف');
  });

  await test('طلبان "متنافسان" يحملان نفس expectedVersion القديم (محاكاة سباق) -- الأول ينجح، الثاني يُرفَض بوضوح (aborted)، ثم طلب صحيح لاحق بالنسخة الجديدة ينجح طبيعياً (لا حبس دائم). ملاحظة صريحة: هذا يُثبت منطق الرفض بالتسلسل فقط -- fakes هنا (runTransaction بلا عزل حقيقي بين معاملات متزامنة، انظر رأس هذا الملف) لا تستطيع محاكاة تعارض متزامن حقيقي؛ ذلك يحتاج Firestore حقيقياً عبر tests/rules/rules.test.mjs أو مكافئه', async () => {
    seedTeam();
    db.__seed('funds', 'FNDRACE', { assetIds: [] });
    db.__seed('opportunities', 'OPPRACE', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 500, maxAllocation: 1000 } });
    db.__seed('capitalCalls', 'CC-CASH-RACE', { fundId: 'FNDRACE', investorId: 'INV1', status: 'paid', amount: 500 });

    // مستخدِمان مختلفان يريان كلاهما الحالة نفسها (غير مربوط، النسخة=0) ويحاولان الربط في اللحظة
    // نفسها تقريباً -- لكل منهما requestId خاص به (مرتبط بهويته)، وكلاهما يحملان expectedVersion=0
    // بالتساوي (عمداً غير مُستنتَجَين تلقائياً هنا، حتى لا يُخفي withLinkDefaults() تعارضهما).
    const reqUser1 = { fundId: 'FNDRACE', oppId: 'OPPRACE', expectedVersion: 0, requestId: 'race-user1-link' };
    const reqUser2 = { fundId: 'FNDRACE', oppId: 'OPPRACE', expectedVersion: 0, requestId: 'race-user2-link' };

    const winner = await fns.linkAssetToFund(req(FM, reqUser1));
    assert.strictEqual(winner.newVersion, 1, 'الطلب الأول يجب أن ينجح وينقل النسخة إلى 1');

    await expectThrow(
      () => fns.linkAssetToFund(req(ADMIN, reqUser2)),
      'aborted',
      'REGRESSION: الطلب الثاني بنفس النسخة القديمة (0) بعد نجاح الأول ونقل النسخة إلى 1 يجب أن يُرفَض، لا أن ينجح مرة ثانية أو يُصمِت'
    );
    assert.deepStrictEqual(db.__get('funds', 'FNDRACE').assetIds, ['OPPRACE'], 'رفض الطلب الثاني يجب ألا يُغيّر الحالة التي حقّقها الفائز');

    const followUp = await fns.linkAssetToFund(req(FM, { fundId: 'FNDRACE', oppId: 'OPPRACE', unlink: true, expectedVersion: 1, requestId: 'race-followup-unlink' }));
    assert.strictEqual(followUp.newVersion, 2, 'طلب صحيح لاحق بالنسخة الجديدة يجب أن ينجح طبيعياً بعد رفض المتنافس -- لا حبس دائم للأصل');
    assert.deepStrictEqual(db.__get('funds', 'FNDRACE').assetIds, [], 'الطلب اللاحق الصحيح يجب أن يُنفَّذ فعلياً');
  });

  await test('عميل قديم لا يُرسل expectedVersion إطلاقاً (أو يُرسل قيمة غير صحيحة)، أو لا يُرسل requestId، يُرفَض فوراً بـinvalid-argument -- غياب النسخة لا يعني تجاوز الحماية بصمت', async () => {
    seedTeam();
    db.__seed('funds', 'FNDOLD', { assetIds: [] });
    db.__seed('opportunities', 'OPPOLD', { meta: { createdBy: ANALYST }, ic: { decisions: [{ decision: 'approve' }] }, capitalAllocation: { targetEquity: 500, maxAllocation: 1000 } });
    db.__seed('capitalCalls', 'CC-CASH-OLD', { fundId: 'FNDOLD', investorId: 'INV1', status: 'paid', amount: 500 });

    await expectThrow(
      () => fns.linkAssetToFund(req(FM, { fundId: 'FNDOLD', oppId: 'OPPOLD', requestId: 'old-client-no-version' })),
      'invalid-argument',
      'REGRESSION: طلب بلا expectedVersion إطلاقاً مرّ دون رفض -- عميل قديم غير محدَّث يمكنه تجاوز الحماية'
    );
    await expectThrow(
      () => fns.linkAssetToFund(req(FM, { fundId: 'FNDOLD', oppId: 'OPPOLD', expectedVersion: -1, requestId: 'bad-version-negative' })),
      'invalid-argument',
      'REGRESSION: expectedVersion سالب لم يُرفَض'
    );
    await expectThrow(
      () => fns.linkAssetToFund(req(FM, { fundId: 'FNDOLD', oppId: 'OPPOLD', expectedVersion: '0', requestId: 'bad-version-string' })),
      'invalid-argument',
      'REGRESSION: expectedVersion كنص ("0") بدل رقم صحيح لم يُرفَض'
    );
    await expectThrow(
      () => fns.linkAssetToFund(req(FM, { fundId: 'FNDOLD', oppId: 'OPPOLD', expectedVersion: 0 })),
      'invalid-argument',
      'REGRESSION: طلب بلا requestId إطلاقاً مرّ دون رفض'
    );
    assert.deepStrictEqual(db.__get('funds', 'FNDOLD').assetIds, [], 'كل المحاولات أعلاه رُفضت قبل أي تنفيذ -- لا شيء تغيَّر');
  });

  await test('إعادة استخدام requestId نفسه بسبب تصحيح (correctionReason) مختلف يُرفَض بوضوح (already-exists) -- لا يُعاد تنفيذه ولا تُعاد له نتيجة الطلب الأول (لسبب مختلف) بصمت', async () => {
    seedTeam();
    db.__seed('funds', 'FNDREASON', { assetIds: ['OPPREASON'] });
    db.__seed('opportunities', 'OPPREASON', { meta: { createdBy: ANALYST } });
    db.__seed('capitalCalls', 'CC-EXEC-CMTREASON', { fundId: 'FNDREASON', inKindAssetId: 'OPPREASON', linkedCommitmentId: 'CMTREASON', status: 'paid', amount: 100000 });

    const sharedRequestId = 'admin-override-req-1';
    await fns.linkAssetToFund(req(ADMIN, { fundId: 'FNDREASON', oppId: 'OPPREASON', unlink: true, correctionReason: 'السبب الأول: بيع خارج الصندوق', expectedVersion: 0, requestId: sharedRequestId }));
    assert.deepStrictEqual(db.__get('funds', 'FNDREASON').assetIds, [], 'التجاوز الأول بسببه الموثَّق يجب أن ينجح');

    // إعادة استخدام نفس requestId، لكن بمعطيات مختلفة فعلياً (سبب تصحيح مختلف) -- هذا ليس "إعادة
    // إرسال" للطلب نفسه، بل محاولة انتحال هوية طلب سابق بمعطيات جديدة. assetLinkRequestPayloadsMatch
    // تقارن correctionReason كاملاً (لا فقط أي بصمة/hash مُشتقّة منه على العميل)، فيُرفَض صراحةً --
    // لا تُعاد نتيجة الطلب الأول (لسبب مختلف تماماً) بصمت، ولا يُعاد تنفيذه من جديد.
    await expectThrow(
      () => fns.linkAssetToFund(req(ADMIN, { fundId: 'FNDREASON', oppId: 'OPPREASON', unlink: true, correctionReason: 'سبب مختلف تماماً', expectedVersion: 0, requestId: sharedRequestId })),
      'already-exists',
      'REGRESSION: نفس requestId بسبب تصحيح مختلف مرّ دون رفض (إما أعاد نتيجة السبب الأول خطأً أو نُفِّذ من جديد)'
    );
  });

  console.log('\n== Phase 2R-4D4-C: archiveOrDeleteFund — أرشفة مقابل حذف فعلي ==');
  await test('صندوق بلا أي تاريخ (assetIds/commitments/capitalCalls/distributions/transactions) يُحذَف فعلياً', async () => {
    seedTeam();
    db.__seed('funds', 'FNDD1', { assetIds: [], name: 'صندوق فارغ' });
    const resp = await fns.archiveOrDeleteFund(req(FM, { fundId: 'FNDD1' }));
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(db.__get('funds', 'FNDD1'), undefined, 'يجب حذف وثيقة الصندوق فعلياً');
    const txns = Object.values(db.__all('transactions'));
    assert.ok(txns.find((t) => t.relatedId === 'FNDD1' && t.action === 'delete'), 'يجب تسجيل معاملة حذف');
  });
  await test('صندوق له تاريخ (حتى لو التزام واحد فقط، بلا أصول مرتبطة) يُؤرشَف لا يُحذَف', async () => {
    seedTeam();
    db.__seed('funds', 'FNDD2', { assetIds: [] });
    db.__seed('commitments', 'CMTD2', { fundId: 'FNDD2', investorId: 'INV1', commitmentAmount: 1000 });
    const resp = await fns.archiveOrDeleteFund(req(FM, { fundId: 'FNDD2' }));
    assert.strictEqual(resp.ok, true);
    const fund = db.__get('funds', 'FNDD2');
    assert.strictEqual(fund.status, 'archived');
    assert.ok(fund.archivedAt && fund.archivedBy === FM);
    const txns = Object.values(db.__all('transactions'));
    assert.ok(txns.find((t) => t.relatedId === 'FNDD2' && t.action === 'archive'), 'يجب تسجيل معاملة أرشفة');
  });
  await test('تاريخ عبر transactions فقط (بلا التزامات/نداءات/توزيعات/أصول) يكفي لمنع الحذف الفعلي', async () => {
    seedTeam();
    db.__seed('funds', 'FNDD3', { assetIds: [] });
    db.__seed('transactions', 'TXND3', { fundId: 'FNDD3', type: 'note', action: 'create' });
    const resp = await fns.archiveOrDeleteFund(req(FM, { fundId: 'FNDD3' }));
    assert.strictEqual(resp.ok, true);
    assert.strictEqual(db.__get('funds', 'FNDD3').status, 'archived');
  });
  await test('صندوق مؤرشف مسبقاً لا يمكن أرشفته أو حذفه مرة أخرى', async () => {
    seedTeam();
    db.__seed('funds', 'FNDD4', { assetIds: [], status: 'archived' });
    await expectThrow(() => fns.archiveOrDeleteFund(req(FM, { fundId: 'FNDD4' })), 'failed-precondition', 'already archived fund');
  });
  await test('صندوق غير موجود يُرفَض بـ not-found', async () => {
    seedTeam();
    await expectThrow(() => fns.archiveOrDeleteFund(req(FM, { fundId: 'NOPE' })), 'not-found', 'archiveOrDeleteFund missing fund');
  });
  await test('غير مدير صندوق (محلل) لا يستطيع استدعاء archiveOrDeleteFund', async () => {
    seedTeam();
    db.__seed('funds', 'FNDD5', { assetIds: [] });
    await expectThrow(() => fns.archiveOrDeleteFund(req(ANALYST, { fundId: 'FNDD5' })), 'permission-denied', 'analyst cannot archive/delete fund');
  });

  console.log(`\nالنتيجة: ${passed} نجح، ${failed} فشل`);
  if (failed > 0) {
    console.log('\nتفاصيل الفشل:');
    failures.forEach((f) => console.log(' -', f.name, ':', (f.err && f.err.stack) || f.err));
    process.exit(1);
  }
})();
