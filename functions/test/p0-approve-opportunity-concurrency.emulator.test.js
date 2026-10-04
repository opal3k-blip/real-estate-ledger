'use strict';
/* =========================================================================
   Phase 2R-4E — بند التحقق المفتوح رقم ٦ (سُجِّل كمفتوح في docs/PHASE_2R_4E_HANDOFF.md،
   يُغلَق الآن بعد حل تعارض firebase-tools/stream-json الذي كان يمنع تشغيل أي شيء ضد
   Firestore Emulator الحقيقي في هذه البيئة).

   يشغَّل عبر:
     cd tests/rules && npm install   (مرة واحدة كافية — نفس node_modules يخدم كل الاختبارات)
     (من جذر المستودع) firebase emulators:exec --only firestore --project demo-test \
       --config tests/rules/firebase.json "node functions/test/p0-approve-opportunity-concurrency.emulator.test.js"

   بخلاف trusted-ic.test.cjs/p0-trusted-transaction-layer.test.js (fakes، بلا عزل معاملات
   حقيقي)، هذا الملف يستخدم load-index-with-real-emulator.js — firebase-admin الحقيقية
   المتصلة فعلياً بـFirestore Emulator عبر FIRESTORE_EMULATOR_HOST — فيُثبِت فعلياً (لا
   منطقياً/تسلسلياً فقط) ما طلبه المستخدم صريحاً في البند ٦:
     ١) طلبان متزامنان حقيقياً (لا أحدهما ينتظر الآخر) بنفس requestId ونفس الحمولة بالضبط
        على فرصة جديدة => قرار IC واحد فقط ونسخة v4 واحدة فقط، لا اثنان.
     ٢) طلبان متزامنان بنفس requestId لكن بحمولة مختلفة => واحد ينجح والآخر يُرفَض
        (already-exists)، لا نجاح مضاعف صامت.
     ٣) معاملة فاشلة (فرصة غير جاهزة بلا تجاوز) لا تترك أي كتابة جزئية — لا icDecisions،
        لا underwritingVersions، لا icDecisionRequests — حتى تحت Firestore حقيقي.

   هذا الملف **لا** يُشغَّل كجزء من npm test العادي (فاكيات) ولا من tests/rules/rules.test.mjs
   (تلك تختبر firestore.rules، لا منطق الدالة نفسها) — مستقل عمداً، ويحتاج الشرط أعلاه
   (FIRESTORE_EMULATOR_HOST) الذي يرفضه load-index-with-real-emulator.js صريحاً لو غاب.
   ========================================================================= */
const assert = require('node:assert/strict');
const { loadIndexAgainstRealEmulator } = require('./load-index-with-real-emulator');
const { recompute, loadEngine } = require('../trusted-ic.cjs');

const EMAIL = 'ic-concurrency@example.com';
const EMAIL2 = 'ic-concurrency-2@example.com';
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`OK ${name}`); }

async function readyFixture() {
  const engine = await loadEngine();
  const o = engine.withDefaults({});
  Object.assign(o.meta, { name: 'Ready Development (concurrency test)', city: 'Riyadh', neighborhood: 'Test', analyst: 'Analyst', oppType: 'development', tier: 'متوسط', useType: '__neutral__' });
  for (const k of ['soil', 'water', 'tower', 'topo', 'infra']) o.site[k] = 1;
  Object.assign(o.land, { area: 5000, price: 2000, far: 2, bar: 0.5, setbacks: 0.15, floorsAllowed: 10, floorHeight: 3.6 });
  Object.assign(o.development, { salePrice: 9000, buildCost: 3000, efficiency: 0.85, contingency: 0.05, constructionYears: 2, operationYears: 1, scopeType: 'both', exitCapRate: 0.08 });
  o.strategy.salePct = 1;
  Object.assign(o.financing, { ltc: 0.5, saibor: 0.05, margin: 0.02 });
  o.regulatory.offeringType = 'private';
  Object.assign(o.criteria, { irrMin: 0.05, projIrrMin: -1, moicMin: 0, dscrMin: null });
  const { defaultItemsDict } = await import('../generated/src/domain/due-diligence/dd-engine.js');
  o.dd = { items: defaultItemsDict() };
  Object.values(o.dd.items).forEach(it => { it.status = 'completed'; it.severity = 'medium'; });
  const { KEY_FIELDS } = await import('../generated/src/domain/evidence/evidence-engine.js');
  o.evidence = {};
  for (const f of KEY_FIELDS.filter(f => !f.appliesTo || f.appliesTo === 'development')) {
    o.evidence[f.path] = { source: 'test-source', tier: 'tier1', confidence: 'high', verifiedBy: EMAIL, date: '2099-01-01' };
  }
  return o;
}

async function seedTeam(db) {
  await Promise.all([
    db.collection('team_members').doc(EMAIL).set({ expiresAt: null }),
    db.collection('team_roles').doc(EMAIL).set({ role: 'senior_ic' }),
    db.collection('team_members').doc(EMAIL2).set({ expiresAt: null }),
    db.collection('team_roles').doc(EMAIL2).set({ role: 'senior_ic' }),
  ]);
}

async function seedOpp(db, id, data) {
  await db.collection('opportunities').doc(id).set(JSON.parse(JSON.stringify(data)));
}

function req(email, data) {
  return { auth: { token: { email } }, data };
}

async function collectionCount(db, name, oppId) {
  const snap = await db.collection(name).where('oppId', '==', oppId).get();
  return snap.size;
}

(async () => {
  const { fns, db } = loadIndexAgainstRealEmulator();
  const ready = await readyFixture();
  const unready = JSON.parse(JSON.stringify(ready)); unready.meta.city = '';

  await test('two genuinely concurrent identical requestId+payload calls produce exactly one decision and one v4 version', async () => {
    await seedTeam(db);
    const oppId = 'OPP-CONC-1';
    await seedOpp(db, oppId, ready);
    const requestId = 'REQ-CONCURRENT-SAME-1';
    const payload = { oppId, decision: { decision: 'approve' }, reasons: [], conditions: [], override: false, requestId };
    // كلاهما يبدأ الآن، بلا await بينهما — طلبان حقيقيان متزامنان، لا متتاليان.
    const [r1, r2] = await Promise.all([
      fns.approveOpportunity(req(EMAIL, payload)),
      fns.approveOpportunity(req(EMAIL, payload)),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.deepEqual(r2, r1, 'كلا الاستدعاءين يجب أن يعيدا نتيجة الطلب الأصلي نفسها بالضبط');
    assert.equal(await collectionCount(db, 'icDecisions', oppId), 1, 'قرار واحد بالضبط، لا اثنان');
    assert.equal(await collectionCount(db, 'underwritingVersions', oppId), 1, 'نسخة v4 واحدة بالضبط، لا اثنتان');
    const oppSnap = await db.collection('opportunities').doc(oppId).get();
    assert.equal((oppSnap.data().ic.decisions || []).length, 1, 'مصفوفة القرارات على الفرصة نفسها لا تحوي إلا قراراً واحداً');
  });

  await test('two genuinely concurrent calls with the SAME requestId but a DIFFERENT payload: exactly one succeeds, the other is rejected (never two silent successes)', async () => {
    const oppId = 'OPP-CONC-2';
    await seedOpp(db, oppId, ready);
    const requestId = 'REQ-CONCURRENT-DIFF-1';
    const payloadA = { oppId, decision: { decision: 'approve' }, reasons: [], conditions: [], override: false, requestId };
    const payloadB = { oppId, decision: { decision: 'reject' }, reasons: [], conditions: [], override: false, requestId };
    const results = await Promise.allSettled([
      fns.approveOpportunity(req(EMAIL, payloadA)),
      fns.approveOpportunity(req(EMAIL, payloadB)),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'استدعاء واحد بالضبط ينجح');
    assert.equal(rejected.length, 1, 'الآخر يُرفَض، لا ينجح صامتاً بنتيجة مختلفة');
    assert.equal(rejected[0].reason.code, 'already-exists');
    assert.equal(await collectionCount(db, 'icDecisions', oppId), 1, 'قرار واحد بالضبط نتج عن الاثنين معاً، لا اثنان');
  });

  await test('a failed transaction (unready opportunity, no override) leaves absolutely no partial write, even under the real emulator', async () => {
    const oppId = 'OPP-CONC-3';
    await seedOpp(db, oppId, unready);
    const requestId = 'REQ-FAILED-TXN-1';
    await assert.rejects(
      fns.approveOpportunity(req(EMAIL, { oppId, decision: { decision: 'approve' }, reasons: [], conditions: [], override: false, requestId })),
      e => e.code === 'failed-precondition'
    );
    assert.equal(await collectionCount(db, 'icDecisions', oppId), 0, 'لا سجل قرار على الإطلاق');
    assert.equal(await collectionCount(db, 'underwritingVersions', oppId), 0, 'لا نسخة v4 على الإطلاق');
    const reqSnap = await db.collection('icDecisionRequests').doc(requestId).get();
    assert.equal(reqSnap.exists, false, 'لا سجل طلب مخزَّن — الفشل قبل أي كتابة، لا شيء لإعادة استخدامه');
    const oppSnap = await db.collection('opportunities').doc(oppId).get();
    assert.equal(oppSnap.data().ic, undefined, 'وثيقة الفرصة نفسها لم تتغيّر إطلاقاً');
  });

  console.log(`\n${passed}/${passed} real-emulator concurrency tests passed (Phase 2R-4E, open item #6).`);
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
