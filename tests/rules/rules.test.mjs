// اختبار حقيقي لقواعد Firestore (firestore.rules) عبر محاكي Firestore الفعلي (Firebase Local
// Emulator Suite) + @firebase/rules-unit-testing — لا محاكاة يدوية للمنطق، بل تنفيذ حقيقي
// لمحرك تقييم القواعد نفسه الذي يستخدمه Firebase في الإنتاج. يُشغَّل عبر:
//   npx firebase-tools emulators:exec --only firestore "node rules.test.mjs"
// يغطي بالضبط ما طلبه المستخدم: اختبار كل قاعدة ضد Analyst/Senior IC/Fund Manager/Admin كلٌ
// على حدة، بدل الاعتماد على إخفاء الأزرار في الواجهة.
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'fs';
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore';

let failures = 0;
function assert(cond, msg){ if(!cond){ console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); } }

// ملاحظة اكتُشفت عملياً عند التشغيل الحقيقي: firebase-tools يرفض أن يشير firebase.json إلى
// ملف قواعد خارج مجلد المشروع الحالي ("is outside of project directory") — فلا يمكن لـ
// firebase.json هنا الإشارة مباشرة إلى ../../firestore.rules. الحل: سكربت npm "pretest"
// (انظر package.json) ينسخ firestore.rules الحقيقي الوحيد من جذر المستودع إلى نسخة محلية هنا
// تلقائياً قبل كل تشغيل — فلا "نسخة يدوية قد تنحرف بمرور الوقت"، فقط نسخة مولَّدة طازجة دائماً.
const rules = readFileSync('./firestore.rules', 'utf8');
const testEnv = await initializeTestEnvironment({
  projectId: 'demo-test',
  firestore: { rules, host: 'localhost', port: 8180 },
});

// --- تمهيد بيانات السياق (team_members/team_roles) بصلاحية أدمن مباشرة (تتجاوز القواعد) ---
const ANALYST_OWNER = 'analyst-owner@x.com';       // محلل، صاحب الفرصة التجريبية
const ANALYST_OTHER  = 'analyst-other@x.com';      // محلل آخر، لا يملك أي فرصة
const SENIOR_IC      = 'senior-ic@x.com';          // عضو لجنة استثمار أول
const FUND_MANAGER   = 'fund-manager@x.com';       // مدير صندوق
const ADMIN          = 'opal3k@gmail.com';         // أدمن (من isAdminEmail() في القواعد نفسها)
const OUTSIDER       = 'outsider@x.com';           // بريد غير مُدرَج في team_members إطلاقاً

await testEnv.withSecurityRulesDisabled(async (ctx)=>{
  const db = ctx.firestore();
  for(const email of [ANALYST_OWNER, ANALYST_OTHER, SENIOR_IC, FUND_MANAGER]){
    await setDoc(doc(db, 'team_members', email), { expiresAt: null });
  }
  await setDoc(doc(db, 'team_roles', SENIOR_IC), { role:'senior_ic' });
  await setDoc(doc(db, 'team_roles', FUND_MANAGER), { role:'fund_manager' });
  // فرصة تجريبية أساسية يملكها ANALYST_OWNER، بالبنية الحقيقية (meta.* + ic.decisions[])
  await setDoc(doc(db, 'opportunities', 'OPP-1'), baseOpp(ANALYST_OWNER, []));
});

function baseOpp(createdBy, decisions){
  return {
    meta: { name:'برج تجريبي', city:'الرياض', oppType:'income', createdBy, updatedBy: createdBy, createdAt:'2026-01-01', updatedAt:'2026-01-01' },
    land: { area: 1000, price: 2000 },
    ic: { decisions: decisions||[] },
  };
}

function ctxFor(email){ return testEnv.authenticatedContext(email, { email }); }

// Fixture setup only: these writes do NOT test the callable or a real transition.
// Each rejected client transition leaves the old state unchanged. Seed the next
// state explicitly so subsequent tests actually exercise approved/posted records.
async function seedLedgerStatus(collection, id, status){
  await testEnv.withSecurityRulesDisabled(async ctx=>{
    const ref = doc(ctx.firestore(), collection, id);
    await updateDoc(ref, { status });
    if((await getDoc(ref)).data().status !== status) throw new Error('Ledger fixture state mismatch');
  });
}


// ==================== ١) attributionHonest + ownsOpp: تعديل عادي على فرصة ====================
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertSucceeds(updateDoc(doc(db,'opportunities','OPP-1'), { 'land.price': 2100, 'meta.updatedBy': ANALYST_OWNER, 'meta.updatedAt':'2026-09-09' }));
  assert(true, 'صاحب الفرصة (محلل) يقدر يعدّل حقولها العادية بنزاهة نِسبة صحيحة (meta.updatedBy = بريده الحقيقي)');
}
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertFails(updateDoc(doc(db,'opportunities','OPP-1'), { 'land.price': 9999, 'meta.updatedBy': 'someone-else@x.com', 'meta.updatedAt':'2026-09-09' }));
  assert(true, '🔒 attributionHonest تمنع صاحب الفرصة نفسه من تزييف meta.updatedBy ببريد شخص آخر');
}
{
  const db = ctxFor(ANALYST_OTHER).firestore();
  await assertFails(updateDoc(doc(db,'opportunities','OPP-1'), { 'land.price': 9999, 'meta.updatedBy': ANALYST_OTHER, 'meta.updatedAt':'2026-09-09' }));
  assert(true, '🔒 محلل آخر (لا يملك الفرصة، ليس عضو لجنة) لا يقدر يعدّل أي حقل عادي فيها — لا ownsOpp ولا icOnlyChange تنطبق عليه');
}

// ==================== ٢) الثغرة الأصلية المرصودة: هل يقدر عضو لجنة استثمار غير المالك يعتمد قراراً؟ ====================
{
  // إعادة الفرصة لحالتها الأساسية أولاً (أزلنا تعديلات الاختبار السابقة عبر تجاوز القواعد)
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'opportunities','OPP-1'), baseOpp(ANALYST_OWNER, []));
  });
  const db = ctxFor(SENIOR_IC).firestore();
  const newDecisions = [{ decision:'approve', reasons:['جيدة'], conditions:[], decidedBy:SENIOR_IC, decidedAt:'2026-09-09T10:00:00Z' }];
  await assertFails(setDoc(doc(db,'opportunities','OPP-1'), {
    ...baseOpp(ANALYST_OWNER, newDecisions),
    meta: { ...baseOpp(ANALYST_OWNER, newDecisions).meta, updatedBy: SENIOR_IC, updatedAt:'2026-09-09' },
  }));
  assert(true, '🔒 Senior IC لا يكتب opportunity.ic مباشرة من العميل؛ الاعتماد عبر approveOpportunity.');
}
{
  // نفس عضو اللجنة، لكن يحاول (في نفس الطلب) تغيير حقل مالي غير ic — يجب أن يُرفض بالكامل
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'opportunities','OPP-1'), baseOpp(ANALYST_OWNER, []));
  });
  const db = ctxFor(SENIOR_IC).firestore();
  const sneaky = baseOpp(ANALYST_OWNER, [{ decision:'approve', reasons:[], conditions:[], decidedBy:SENIOR_IC, decidedAt:'x' }]);
  sneaky.land.price = 1; // محاولة تغيير حقل مالي بجانب قرار اللجنة
  sneaky.meta.updatedBy = SENIOR_IC;
  await assertFails(setDoc(doc(db,'opportunities','OPP-1'), sneaky));
  assert(true, '🔒 عضو اللجنة غير المالك لا يستطيع تمرير قرار IC مع تغيير مالي من العميل.');
}
{
  // محلل عادي (غير لجنة، غير مالك) يحاول محاكاة نفس مسار "قرار لجنة" بلا أي دور — يجب أن يُرفض
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'opportunities','OPP-1'), baseOpp(ANALYST_OWNER, []));
  });
  const db = ctxFor(ANALYST_OTHER).firestore();
  const attempt = baseOpp(ANALYST_OWNER, [{ decision:'approve', reasons:[], conditions:[], decidedBy:ANALYST_OTHER, decidedAt:'x' }]);
  attempt.meta.updatedBy = ANALYST_OTHER;
  await assertFails(setDoc(doc(db,'opportunities','OPP-1'), attempt));
  assert(true, '🔒 محلل غير مالك لا يستطيع تسجيل قرار IC مباشرة من العميل أيضاً.');
}

// ==================== ٣) دفتر الصندوق (investors/funds/...) — مدير صندوق فأعلى فقط للكتابة ====================
// ملاحظة (المرحلة ٦-ب): capitalCalls/distributions لم تعد تقبل أي شكل وثيقة عشوائي عند الإنشاء —
// بوابة الاعتماد الصريحة تفرض أن تبدأ الوثيقة الجديدة بحالة 'pending'/'declared' (أو تحمل reversalOfId/
// linkedCommitmentId للاستثناءين المحسوبين). لذلك نمرر شكل وثيقة صالح لهما هنا خصيصاً، مع إبقاء الاختبار
// نفسه (رفض المحلل/عضو اللجنة، قبول مدير الصندوق، إبقاء القراءة متاحة) على حاله لبقية المجموعات.
const LEDGER_COLLECTIONS = ['investors','funds','commitments','capitalCalls','distributions','transactions'];
function ledgerValidCreateShape(coll){
  if(coll==='commitments') return { fundId:'FND-1', investorId:'INV-1', commitmentAmount:1, dateCommitted:'2026-01-01', contributionType:'cash', reversalOfId:null };
  if(coll==='capitalCalls') return { fundId:'FND-1', investorId:'INV-1', callNumber:99, callDate:'2026-01-01', amount:1, status:'pending', linkedCommitmentId:null, reversalOfId:null };
  if(coll==='distributions') return { fundId:'FND-1', investorId:'INV-1', distDate:'2026-01-01', amount:1, status:'declared', reversalOfId:null };
  return { name:'test' };
}
for(const coll of LEDGER_COLLECTIONS){
  {
    const db = ctxFor(ANALYST_OWNER).firestore();
    await assertFails(setDoc(doc(db, coll, 'X1'), ledgerValidCreateShape(coll)));
    assert(true, `🔒 محلل عادي لا يقدر يكتب في ${coll} (دفتر الصندوق) — كانت مفتوحة لأي عضو مصرَّح له قبل هذا التعديل`);
  }
  {
    const db = ctxFor(SENIOR_IC).firestore();
    await assertFails(setDoc(doc(db, coll, 'X2'), ledgerValidCreateShape(coll)));
    assert(true, `🔒 عضو لجنة استثمار أول (senior_ic) لا يقدر يكتب في ${coll} أيضاً (دون دور مدير صندوق) — الحماية على مستوى الدور لا الفرصة`);
  }
  {
    const db = ctxFor(FUND_MANAGER).firestore();
    await assertSucceeds(setDoc(doc(db, coll, 'X3'), ledgerValidCreateShape(coll)));
    assert(true, `✅ مدير صندوق (fund_manager) يقدر يكتب في ${coll} بنجاح`);
  }
  {
    const db = ctxFor(ANALYST_OWNER).firestore();
    await assertSucceeds(getDoc(doc(db, coll, 'X3')));
    assert(true, `✅ القراءة في ${coll} تبقى متاحة لأي عضو مصرَّح له (محلل عادي هنا)`);
  }
}

// ==================== ٤) سجل التدقيق (oppAuditLog) — ممنوع تماماً على العميل، حتى الأدمن ====================
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertFails(setDoc(doc(db,'oppAuditLog','A1'), { oppId:'OPP-1', changedBy:ANALYST_OWNER, action:'created' }));
  assert(true, '🔒 محلل عادي لا يقدر يكتب سجل تدقيق مباشرة من العميل');
}
{
  const db = ctxFor(FUND_MANAGER).firestore();
  await assertFails(setDoc(doc(db,'oppAuditLog','A2'), { oppId:'OPP-1', changedBy:FUND_MANAGER, action:'created' }));
  assert(true, '🔒 مدير صندوق لا يقدر يكتب سجل تدقيق مباشرة من العميل أيضاً — لا كتابة من العميل إطلاقاً بصرف النظر عن الدور');
}
{
  const db = ctxFor(ADMIN).firestore();
  await assertFails(setDoc(doc(db,'oppAuditLog','A3'), { oppId:'OPP-1', changedBy:ADMIN, action:'created' }));
  assert(true, '🔒 حتى الأدمن لا يقدر يكتب سجل تدقيق مباشرة من العميل (write: if false مطلقة، بلا استثناء أدمن) — الكتابة الحقيقية الوحيدة عبر Cloud Function بصلاحية Admin SDK التي تتجاوز هذه القاعدة تصميمياً');
}
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{ await setDoc(doc(ctx.firestore(),'oppAuditLog','A4'), { oppId:'OPP-1' }); });
  await assertSucceeds(getDoc(doc(db,'oppAuditLog','A4')));
  assert(true, '✅ القراءة في oppAuditLog تبقى متاحة لأي عضو مصرَّح له (لعرض سجل التعديلات في واجهة الفرصة)');
}

// ==================== ٥) الغرباء (بريد غير مُدرَج في team_members إطلاقاً) — لا شيء ====================
{
  const db = ctxFor(OUTSIDER).firestore();
  await assertFails(getDoc(doc(db,'opportunities','OPP-1')));
  assert(true, '🔒 بريد غير مصرَّح له إطلاقاً (ليس في team_members ولا أدمن) لا يقدر حتى يقرأ فرصة واحدة');
}

// ==================== ٦) قاعدة المقارنات (comparables) — نفس نمط دفتر الصندوق، مدير صندوق فأعلى ====================
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertFails(setDoc(doc(db,'comparables','C1'), { city:'الرياض', price:1000, landSize:500 }));
  assert(true, '🔒 محلل عادي لا يقدر يضيف مقارنة سوقية (comparables) — كانت الواجهة فقط ناقصة الفحص (P0 #5)؛ القاعدة نفسها كانت صحيحة أصلاً وتبقى كذلك');
}
{
  const db = ctxFor(FUND_MANAGER).firestore();
  await assertSucceeds(setDoc(doc(db,'comparables','C2'), { city:'الرياض', price:1000, landSize:500 }));
  assert(true, '✅ مدير صندوق يقدر يضيف مقارنة سوقية بنجاح');
}
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertSucceeds(getDoc(doc(db,'comparables','C2')));
  assert(true, '✅ القراءة في comparables تبقى متاحة لأي عضو مصرَّح له (يستخدمها في المقارنة فقط)');
}

// ==================== ٧) التسعير الموثَّق بالإصدارات (underwritingVersions) — نزاهة إنشاء + immutable بالكامل ====================
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertSucceeds(setDoc(doc(db,'underwritingVersions','UWV1'), { oppId:'OPP-1', stage:'manual', trigger:'manual', savedBy:ANALYST_OWNER, savedAt:'2026-01-01T00:00:00.000Z', metrics:{ price:2000 } }));
  assert(true, '✅ مالك الفرصة يقدر يحفظ لقطة تسعير يدوية فقط عندما savedBy يطابق بريده الحقيقي وترتبط بفرصة موجودة');
}
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertFails(setDoc(doc(db,'underwritingVersions','UWV-SPOOF'), { oppId:'OPP-1', stage:'manual', trigger:'manual', savedBy:'someone-else@x.com', savedAt:'2026-01-01T00:00:00.000Z', metrics:{ price:2000 } }));
  assert(true, '🔒 لا يمكن إنشاء لقطة underwritingVersions بهوية savedBy مزيفة');
}
{
  const db = ctxFor(ANALYST_OTHER).firestore();
  await assertFails(setDoc(doc(db,'underwritingVersions','UWV-NONOWNER'), { oppId:'OPP-1', stage:'manual', trigger:'manual', savedBy:ANALYST_OTHER, savedAt:'2026-01-01T00:00:00.000Z', metrics:{ price:2000 } }));
  assert(true, '🔒 محلل مصرح له لكنه لا يملك الفرصة لا يستطيع إنشاء لقطة يدوية لها عبر Firestore مباشرة');
}
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertFails(setDoc(doc(db,'underwritingVersions','UWV-FAKE-V4'), { oppId:'OPP-1', stage:'v4_ic_approved', trigger:'ic_decision', savedBy:ANALYST_OWNER, savedAt:'2026-01-01T00:00:00.000Z', sourceDecisionId:'ICD-NOPE', metrics:{ price:1, equityIRR:9 } }));
  assert(true, '🔒 الثغرة المغلقة: أي محلل مصرح له لا يستطيع إنشاء v4_ic_approved مصطنعة تصبح baseline للأداء الفعلي');
}
{
  const db = ctxFor(SENIOR_IC).firestore();
  await assertFails(setDoc(doc(db,'underwritingVersions','UWV-V4-NOSOURCE'), { oppId:'OPP-1', stage:'v4_ic_approved', trigger:'ic_decision', savedBy:SENIOR_IC, savedAt:'2026-01-01T00:00:00.000Z', metrics:{ price:1, equityIRR:9 } }));
  assert(true, '🔒 حتى Senior IC لا يستطيع إنشاء v4 بلا sourceDecisionId يربطها بسجل قرار IC موجود');
}
{
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'icDecisions','ICD-UWV-OK'), { oppId:'OPP-1', decision:{ decision:'approve' }, recordedAt:'2026-01-01T00:00:00.000Z', recordedBy:SENIOR_IC });
  });
  const db = ctxFor(SENIOR_IC).firestore();
  await assertSucceeds(setDoc(doc(db,'underwritingVersions','UWV-V4-OK'), { oppId:'OPP-1', stage:'v4_ic_approved', trigger:'ic_decision', savedBy:SENIOR_IC, savedAt:'2026-01-01T00:00:01.000Z', sourceDecisionId:'ICD-UWV-OK', metrics:{ price:2000, equityIRR:0.16 } }));
  assert(true, '✅ v4_ic_approved تُقبل فقط عندما تكون من Senior IC ومربوطة بسجل icDecisions صالح لنفس الفرصة ونفس المسجّل');
}
{
  const db = ctxFor(SENIOR_IC).firestore();
  await assertFails(updateDoc(doc(db,'underwritingVersions','UWV1'), { 'metrics.price': 9999 }));
  assert(true, '🔒 عضو لجنة استثمار أول لا يقدر يعدّل نسخة تسعير محفوظة سابقاً — append-only حقيقي، حتى لدور رفيع');
}
{
  const db = ctxFor(ADMIN).firestore();
  await assertFails(updateDoc(doc(db,'underwritingVersions','UWV1'), { 'metrics.price': 9999 }));
  assert(true, '🔒 حتى الأدمن لا يقدر يعدّل/يحذف نسخة تسعير محفوظة — immutable بالكامل بلا استثناء؛ التصحيح ينشئ لقطة (Snapshot) جديدة بدلاً من تعديل القديمة');
}
{
  const db = ctxFor(ADMIN).firestore();
  await assertFails(deleteDoc(doc(db,'underwritingVersions','UWV1')));
  assert(true, '🔒 حتى الأدمن لا يقدر يحذف نسخة تسعير محفوظة');
}

// ==================== ٧-ب) الأداء الفعلي المتكرر (assetActuals) — نفس نمط underwritingVersions
// بالضبط بالضبط (إضافة بطلب المستخدم بعد مراجعته لخريطة فجوات "المرحلة السابعة"): إضافة لأي
// عضو مصرَّح له، immutable بالكامل حتى للأدمن، ولا يجوز إعادة استخدام نفس id لسجل موجود ====================
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertSucceeds(setDoc(doc(db,'assetActuals','ACT1'), { oppId:'OPP-1', period:'2027 Q1', asOfDate:'2027-03-31', actualEquityIRR:0.12, actualMOIC:1.1, actualDSCR:1.3, notes:'', enteredBy:ANALYST_OWNER, enteredAt:'2027-03-31T00:00:00.000Z' }));
  assert(true, '✅ محلل عادي يقدر يضيف إدخال أداء فعلي جديد عندما enteredBy يطابق بريده الحقيقي وترتبط الوثيقة بفرصة موجودة');
}
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertFails(setDoc(doc(db,'assetActuals','ACT-SPOOF'), { oppId:'OPP-1', period:'2027 Q1', asOfDate:'2027-03-31', actualEquityIRR:0.12, enteredBy:'someone-else@x.com', enteredAt:'2027-03-31T00:00:00.000Z' }));
  assert(true, '🔒 لا يمكن إنشاء إدخال أداء فعلي بهوية enteredBy مزيفة');
}
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertFails(setDoc(doc(db,'assetActuals','ACT1'), { oppId:'OPP-1', period:'2027 Q1 (محاولة إعادة كتابة)', asOfDate:'2027-03-31', actualEquityIRR:0.99 }));
  assert(true, '🔒 لا يجوز إعادة استخدام نفس id لسجل أداء فعلي موجود بالفعل — إنشاء فقط لسجل جديد حقاً، لا استبدال لسجل قائم عبر create');
}
{
  const db = ctxFor(SENIOR_IC).firestore();
  await assertFails(updateDoc(doc(db,'assetActuals','ACT1'), { actualEquityIRR: 0.99 }));
  assert(true, '🔒 عضو لجنة استثمار أول لا يقدر يعدّل إدخال أداء فعلي محفوظاً سابقاً — append-only حقيقي، حتى لدور رفيع');
}
{
  const db = ctxFor(ADMIN).firestore();
  await assertFails(updateDoc(doc(db,'assetActuals','ACT1'), { actualEquityIRR: 0.99 }));
  assert(true, '🔒 حتى الأدمن لا يقدر يعدّل إدخال أداء فعلي محفوظ — immutable بالكامل بلا استثناء؛ التصحيح إدخال جديد بفترة/تاريخ مختلفين، لا تعديل القديم');
}
{
  const db = ctxFor(ADMIN).firestore();
  await assertFails(deleteDoc(doc(db,'assetActuals','ACT1')));
  assert(true, '🔒 حتى الأدمن لا يقدر يحذف إدخال أداء فعلي محفوظ');
}

// ==================== ٨) IC audit: server-only writes; team reads ====================
// Rules-disabled seeding represents an existing server record. This is not a
// callable integration test; approveOpportunity logic has its own Functions tests.
await testEnv.withSecurityRulesDisabled(async ctx=>{
  await setDoc(doc(ctx.firestore(),'icDecisions','ICD-1'), {
    oppId:'OPP-1', decision:{decision:'approve'}, recordedBy:SENIOR_IC,
    source:'approveOpportunity', version:2,
  });
});
for(const [role,email] of [['analyst',ANALYST_OWNER],['senior_ic',SENIOR_IC],['fund_manager',FUND_MANAGER],['admin',ADMIN]]){
  const db = ctxFor(email).firestore();
  const forgedId = `ICD-FORGED-${role}`;
  await assertFails(setDoc(doc(db,'icDecisions',forgedId), {
    oppId:'OPP-1', decision:{decision:'approve',decidedBy:email}, recordedBy:email,
    readiness:{ready:true,gates:{}}, evaluation:{engineVersion:'forged',inputHash:'forged'},
    source:'approveOpportunity', version:2,
  }));
  assert(true, `🔒 ${role}: إنشاء سجل IC مصطنع من العميل مرفوض حتى بتنسيق سجل الخادم`);
  const missing = await assertSucceeds(getDoc(doc(db,'icDecisions',forgedId)));
  assert(!missing.exists(), `${role}: لم تُنشأ وثيقة القرار المرفوضة`);
  await assertFails(updateDoc(doc(db,'icDecisions','ICD-1'), {'decision.decision':'reject'}));
  assert(true, `🔒 ${role}: تعديل سجل IC موجود مرفوض`);
  await assertFails(deleteDoc(doc(db,'icDecisions','ICD-1')));
  assert(true, `🔒 ${role}: حذف سجل IC موجود مرفوض`);
  const existing = await assertSucceeds(getDoc(doc(db,'icDecisions','ICD-1')));
  assert(existing.exists() && existing.data().decision.decision==='approve', `${role}: القراءة مسموحة وسجل الخادم محفوظ`);
  // The forged decision must not become a valid source for an approved UW version.
  await assertFails(setDoc(doc(db,'underwritingVersions',`UWV-FORGED-${role}`), {
    oppId:'OPP-1', stage:'v4_ic_approved', trigger:'ic_decision', savedBy:email,
    savedAt:'2026-09-22T00:00:00.000Z', sourceDecisionId:forgedId, metrics:{equityIRR:9},
  }));
  assert(true, `🔒 ${role}: لا يمكن إنشاء نسخة اعتماد استناداً إلى القرار المصطنع المرفوض`);
}
for(const [label,context] of [['outsider',ctxFor(OUTSIDER)],['anonymous',testEnv.unauthenticatedContext()]]){
  const db = context.firestore();
  await assertFails(getDoc(doc(db,'icDecisions','ICD-1')));
  await assertFails(setDoc(doc(db,'icDecisions',`ICD-${label}`), {oppId:'OPP-1',decision:{decision:'approve'}}));
  assert(true, `🔒 ${label}: قراءة سجل IC وإنشاؤه مرفوضان`);
}

// ==================== ٩) محرك ربط رأس المال (المرحلة الخامسة): capitalAllocation — مدير صندوق فأعلى فقط، حتى لمالك الفرصة نفسه ====================
{
  // إعادة الفرصة لحالتها الأساسية أولاً
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'opportunities','OPP-1'), baseOpp(ANALYST_OWNER, []));
  });
  const db = ctxFor(ANALYST_OWNER).firestore();
  const attempt = { ...baseOpp(ANALYST_OWNER, []), capitalAllocation:{ targetEquity:5000000, maxAllocation:null, priority:'normal', committeeNote:'' } };
  attempt.meta.updatedBy = ANALYST_OWNER;
  await assertFails(setDoc(doc(db,'opportunities','OPP-1'), attempt));
  assert(true, '🔒 مالك الفرصة نفسه (محلل) لا يقدر يعدّل capitalAllocation عبر مسار ownsOpp العادي — قرار حوكمي يخص مدير الصندوق حتى لو كانت فرصته هو');
}
{
  const db = ctxFor(FUND_MANAGER).firestore();
  const attempt = { ...baseOpp(ANALYST_OWNER, []), capitalAllocation:{ targetEquity:5000000, maxAllocation:8000000, priority:'high', committeeNote:'أولوية عالية' } };
  attempt.meta.updatedBy = FUND_MANAGER;
  await assertSucceeds(setDoc(doc(db,'opportunities','OPP-1'), attempt));
  assert(true, '✅ مدير صندوق (fund_manager)، وهو *ليس* مالك الفرصة، يقدر يخصّص رأس مال (capitalAllocation فقط) — بالضبط نفس نمط icOnlyChange لكن لمستوى مدير الصندوق');
}
{
  // مدير الصندوق يحاول (في نفس الطلب) تمرير تغيير حقل مالي آخر بجانب capitalAllocation — يجب أن يُرفض بالكامل
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'opportunities','OPP-1'), baseOpp(ANALYST_OWNER, []));
  });
  const db = ctxFor(FUND_MANAGER).firestore();
  const sneaky = { ...baseOpp(ANALYST_OWNER, []), capitalAllocation:{ targetEquity:1, maxAllocation:null, priority:'normal', committeeNote:'' } };
  sneaky.land.price = 1; // محاولة تغيير حقل مالي بجانب التخصيص
  sneaky.meta.updatedBy = FUND_MANAGER;
  await assertFails(setDoc(doc(db,'opportunities','OPP-1'), sneaky));
  assert(true, '🔒 capitalAllocationOnlyChange تمنع مدير الصندوق من تمرير أي تغيير مالي/تشغيلي آخر (land.price هنا) "مُخبَّأً" بجانب تخصيص رأس المال في نفس الطلب');
}
{
  // عضو لجنة أول (senior_ic) — دون دور مدير صندوق — يحاول نفس مسار capitalAllocation فقط
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'opportunities','OPP-1'), baseOpp(ANALYST_OWNER, []));
  });
  const db = ctxFor(SENIOR_IC).firestore();
  const attempt = { ...baseOpp(ANALYST_OWNER, []), capitalAllocation:{ targetEquity:5000000, maxAllocation:null, priority:'normal', committeeNote:'' } };
  attempt.meta.updatedBy = SENIOR_IC;
  await assertFails(setDoc(doc(db,'opportunities','OPP-1'), attempt));
  assert(true, '🔒 عضو لجنة استثمار أول (senior_ic) لا يقدر يخصّص رأس مال أيضاً (دون دور مدير صندوق) — الحماية على مستوى الدور نفسه لا مجرد "أعلى من محلل"');
}

// ==================== ١٠) دفتر الصندوق المحاسبي المُرحَّل (المرحلة السادسة، "إعادة هندسة
// كاملة" بطلب صريح من المستخدم): commitments/capitalCalls/distributions/transactions posted/
// locked/reversal — لا تعديل ولا حذف لسجل مُرحَّل مهما كان الدور، حتى مدير الصندوق نفسه ====================
{
  // commitments: مُرحَّل من لحظة الإنشاء مباشرة — لا حقل status له أصلاً
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'commitments','CMT-1'), { fundId:'FND-1', investorId:'INV-1', commitmentAmount:1000000, dateCommitted:'2026-01-01', contributionType:'cash', reversalOfId:null });
  });
  const dbFM = ctxFor(FUND_MANAGER).firestore();
  await assertFails(updateDoc(doc(dbFM,'commitments','CMT-1'), { commitmentAmount: 2000000 }));
  assert(true, '🔒 حتى مدير الصندوق لا يقدر يعدّل التزام (commitment) — مُرحَّل من لحظة إنشائه، لا نافذة تعديل بعده مهما كانت صغيرة');
  await assertFails(deleteDoc(doc(dbFM,'commitments','CMT-1')));
  assert(true, '🔒 حتى مدير الصندوق لا يقدر يحذف التزام — التصحيح الوحيد المسموح هو قيد عكسي جديد');
  await assertFails(setDoc(doc(dbFM,'commitments','CMT-1-REV'), { fundId:'FND-1', investorId:'INV-1', commitmentAmount:-1000000, dateCommitted:'2026-01-02', contributionType:'cash', notes:'تصحيح', reversalOfId:'CMT-1' }));
  assert(true, '🔒 إنشاء قيد التزام عكسي من العميل مرفوض؛ التصحيح عبر reverseTransaction.');
  await assertFails(setDoc(doc(dbFM,'commitments','CMT-NEG-NORMAL'), { fundId:'FND-1', investorId:'INV-1', commitmentAmount:-100000, dateCommitted:'2026-01-03', contributionType:'cash', reversalOfId:null }));
  assert(true, '🔒 لا يمكن إنشاء التزام سالب كسجل عادي — السالب مسموح فقط كقيد عكسي مرتبط');
}
{
  // capitalCalls: client updates are denied in every state; allowed draft deletion is separate.
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'capitalCalls','CC-1'), { fundId:'FND-1', investorId:'INV-1', callNumber:1, callDate:'2026-01-01', amount:500000, status:'pending', linkedCommitmentId:null, reversalOfId:null });
  });
  const dbFM = ctxFor(FUND_MANAGER).firestore();
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-1'), { amount: 600000 }));
  assert(true, '🔒 تعديل مبلغ نداء pending من العميل مرفوض أيضاً بعد P0.');
  // المرحلة ٦-ب: لا يمكن الترحيل المباشر pending → paid بعد الآن — يجب المرور ببوابة الاعتماد أولاً
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-1'), { status: 'paid' }));
  assert(true, '🔒 لا يمكن تخطّي بوابة الاعتماد: pending → paid مباشرة مرفوض حتى لمدير الصندوق');
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-1'), { status: 'approved', approvedBy:FUND_MANAGER, approvedAt:'2026-01-02' }));
  assert(true, '🔒 انتقال pending → approved من العميل مرفوض؛ التنفيذ عبر transitionLedgerRecord.');
  await seedLedgerStatus('capitalCalls', 'CC-1', 'approved');
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-1'), { status: 'paid' }));
  assert(true, '🔒 انتقال approved → paid من العميل مرفوض؛ التنفيذ عبر transitionLedgerRecord.');
  await seedLedgerStatus('capitalCalls', 'CC-1', 'paid');
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-1'), { amount: 700000 }));
  assert(true, '🔒 بعد الترحيل (status=="paid") لا يقدر مدير الصندوق تعديل النداء إطلاقاً، ولو لمجرد تصحيح رقم');
  await assertFails(setDoc(doc(dbFM,'capitalCalls','CC-NEG-NORMAL'), { fundId:'FND-1', investorId:'INV-1', callNumber:2, callDate:'2026-01-05', amount:-100000, status:'pending', linkedCommitmentId:null, reversalOfId:null }));
  assert(true, '🔒 لا يمكن إنشاء نداء رأس مال سالب كمسودة عادية — يجب استخدام قيد عكسي');
  await assertFails(setDoc(doc(dbFM,'capitalCalls','CC-REV-NEG'), { fundId:'FND-1', investorId:'INV-1', callNumber:3, callDate:'2026-01-06', amount:-100000, status:'paid', linkedCommitmentId:null, reversalOfId:'CC-1' }));
  assert(true, '🔒 إنشاء نداء عكسي paid من العميل مرفوض، حتى مع reversalOfId.');
  await assertFails(deleteDoc(doc(dbFM,'capitalCalls','CC-1')));
  assert(true, '🔒 ولا حذفه أيضاً — التصحيح الوحيد قيد عكسي جديد');
  await assertFails(setDoc(doc(dbFM,'capitalCalls','CC-1-REV'), { fundId:'FND-1', investorId:'INV-1', callNumber:1, callDate:'2026-01-03', amount:-700000, status:'paid', linkedCommitmentId:null, notes:'تصحيح', reversalOfId:'CC-1' }));
  assert(true, '🔒 لا يمكن إنشاء تصحيح رأسمالي مباشر؛ القيد العكسي يمر بالخادم.');
}
{
  // distributions: client updates are denied; posted fixtures below are seeded with rules disabled.
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'distributions','DST-1'), { fundId:'FND-1', investorId:'INV-1', distDate:'2026-01-01', amount:300000, type:'عائد رأس المال (Return of Capital)', status:'declared', reversalOfId:null });
  });
  const dbFM = ctxFor(FUND_MANAGER).firestore();
  await assertFails(updateDoc(doc(dbFM,'distributions','DST-1'), { amount: 350000 }));
  assert(true, '🔒 تعديل مبلغ توزيعة declared من العميل مرفوض بعد P0.');
  // المرحلة ٦-ب: لا يمكن الترحيل المباشر declared → paid بعد الآن — يجب المرور ببوابة الاعتماد أولاً
  await assertFails(updateDoc(doc(dbFM,'distributions','DST-1'), { status: 'paid' }));
  assert(true, '🔒 لا يمكن تخطّي بوابة الاعتماد: declared → paid مباشرة مرفوض حتى لمدير الصندوق');
  await assertFails(updateDoc(doc(dbFM,'distributions','DST-1'), { status: 'approved', approvedBy:FUND_MANAGER, approvedAt:'2026-01-02' }));
  assert(true, '🔒 انتقال declared → approved من العميل مرفوض؛ التنفيذ عبر الخادم.');
  await seedLedgerStatus('distributions', 'DST-1', 'approved');
  await assertFails(updateDoc(doc(dbFM,'distributions','DST-1'), { status: 'paid' }));
  assert(true, '🔒 انتقال approved → paid للتوزيعة من العميل مرفوض.');
  await seedLedgerStatus('distributions', 'DST-1', 'paid');
  await assertFails(updateDoc(doc(dbFM,'distributions','DST-1'), { amount: 400000 }));
  assert(true, '🔒 بعد الترحيل (status=="paid") التوزيعة غير قابلة للتعديل إطلاقاً');
  await assertFails(deleteDoc(doc(dbFM,'distributions','DST-1')));
  assert(true, '🔒 ولا للحذف — التصحيح الوحيد قيد عكسي جديد');
}
{
  // transactions: سجل تدقيق — append-only بالكامل، تماماً مثل oppAuditLog/icDecisions/underwritingVersions
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'transactions','TXN-1'), { type:'capitalCall', action:'create', relatedId:'CC-1', fundId:'FND-1', amount:500000, at:'2026-01-01T00:00:00.000Z', by:FUND_MANAGER, version:1 });
  });
  const dbFM = ctxFor(FUND_MANAGER).firestore();
  await assertFails(updateDoc(doc(dbFM,'transactions','TXN-1'), { amount: 999999 }));
  assert(true, '🔒 حتى مدير الصندوق لا يقدر يعدّل سجل تدقيق (transactions) — append-only بالكامل، بلا أي استثناء دور');
  await assertFails(deleteDoc(doc(dbFM,'transactions','TXN-1')));
  assert(true, '🔒 ولا يقدر يحذفه — يطابق تماماً oppAuditLog/icDecisions/underwritingVersions');
  await assertSucceeds(setDoc(doc(dbFM,'transactions','TXN-2'), { type:'assetLink', action:'create', relatedId:'OPP-1', fundId:'FND-1', amount:0, at:'2026-01-02T00:00:00.000Z', by:FUND_MANAGER, version:1 }));
  assert(true, '✅ إنشاء سجل تدقيق جديد يبقى مسموحاً كما كان (append-only يعني إضافة حرة، لا منع كتابة)');
}

// ==================== ١١) بوابة الاعتماد الصريحة والمنفصلة (المرحلة السادسة-ب، بطلب صريح
// من المستخدم: "نعم، أضف بوابة اعتماد منفصلة"): pending/declared → approved → paid/waived —
// لا يمكن تخطّي 'approved' أبداً، ولا تعديل أي حقل آخر أثناء الانتقال approved→paid/waived ====================
{
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'capitalCalls','CC-GATE-1'), { fundId:'FND-1', investorId:'INV-1', callNumber:1, callDate:'2026-01-01', amount:500000, status:'pending', linkedCommitmentId:null, reversalOfId:null, approvedBy:null, approvedAt:null });
  });
  const dbFM = ctxFor(FUND_MANAGER).firestore();
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-GATE-1'), { status:'paid' }));
  assert(true, '🔒 لا يمكن تخطّي بوابة الاعتماد: نداء "pending" لا يقدر يتحول مباشرة إلى "paid" في طلب واحد');
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-GATE-1'), { status:'waived' }));
  assert(true, '🔒 ولا مباشرة إلى "waived" أيضاً — نفس البوابة بالضبط');
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-GATE-1'), { status:'approved', approvedBy:FUND_MANAGER, approvedAt:'2026-01-02' }));
  assert(true, '🔒 حتى خطوة الاعتماد pending → approved يجب أن تمر بالخادم.');
  await seedLedgerStatus('capitalCalls', 'CC-GATE-1', 'approved');
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-GATE-1'), { status:'paid', amount:999999 }));
  assert(true, '🔒 بعد الاعتماد، أي تغيير حقل آخر (المبلغ هنا) بجانب الترحيل إلى "paid" في نفس الطلب مرفوض بالكامل — القيمة مُثبَّتة فعلاً عند الاعتماد');
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-GATE-1'), { status:'paid' }));
  assert(true, '🔒 الانتقال approved → paid مرفوض من العميل حتى دون تغيير المبلغ.');
  await seedLedgerStatus('capitalCalls', 'CC-GATE-1', 'paid');
  await assertFails(updateDoc(doc(dbFM,'capitalCalls','CC-GATE-1'), { status:'waived' }));
  assert(true, '🔒 بعد الترحيل النهائي (paid) لا رجوع ولا انتقال آخر إطلاقاً — يطابق قفل المرحلة السادسة تماماً');
}
{
  const dbFM = ctxFor(FUND_MANAGER).firestore();
  await assertFails(setDoc(doc(dbFM,'capitalCalls','CC-GATE-SKIP'), { fundId:'FND-1', investorId:'INV-1', callNumber:2, callDate:'2026-01-01', amount:100000, status:'paid', linkedCommitmentId:null, reversalOfId:null }));
  assert(true, '🔒 إنشاء نداء رأسمال جديد (يدوي عادي) مباشرة بحالة "paid" مرفوض — يجب أن يبدأ "pending" دائماً ويمر عبر البوابة');
  await assertSucceeds(setDoc(doc(dbFM,'capitalCalls','CC-GATE-PENDING-OK'), { fundId:'FND-1', investorId:'INV-1', callNumber:3, callDate:'2026-01-01', amount:100000, status:'pending', linkedCommitmentId:null, reversalOfId:null }));
  assert(true, '✅ إنشاء نداء رأسمال جديد بحالة "pending" (البداية الصحيحة) ينجح كما هو متوقَّع');
  await assertFails(setDoc(doc(dbFM,'capitalCalls','CC-GATE-REVERSAL-OK'), { fundId:'FND-1', investorId:'INV-1', callNumber:4, callDate:'2026-01-01', amount:-100000, status:'paid', linkedCommitmentId:null, reversalOfId:'CC-GATE-PENDING-OK' }));
  assert(true, '🔒 القيد العكسي ليس استثناءً لكتابة العميل؛ إنشاؤه عبر reverseTransaction.');
  await assertSucceeds(setDoc(doc(dbFM,'capitalCalls','CC-GATE-INKIND-OK'), { fundId:'FND-1', investorId:'INV-1', callNumber:5, callDate:'2026-01-01', amount:200000, status:'paid', linkedCommitmentId:'CMT-SOME', reversalOfId:null }));
  assert(true, '✅ استثناء النقل العيني التلقائي محفوظ: نداء برقم linkedCommitmentId يُنشَأ مباشرة "paid" بلا بوابة اعتماد — ناتج تنفيذي لالتزام مُرحَّل بالفعل، ليس نداءً يحتاج اعتماداً مستقلاً');
}
{
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'distributions','DST-GATE-1'), { fundId:'FND-1', investorId:'INV-1', distDate:'2026-01-01', amount:300000, type:'x', status:'declared', reversalOfId:null, approvedBy:null, approvedAt:null });
  });
  const dbFM = ctxFor(FUND_MANAGER).firestore();
  await assertFails(updateDoc(doc(dbFM,'distributions','DST-GATE-1'), { status:'paid' }));
  assert(true, '🔒 نفس البوابة على التوزيعات: "declared" لا يقدر يتحول مباشرة إلى "paid"');
  await assertFails(updateDoc(doc(dbFM,'distributions','DST-GATE-1'), { status:'approved', approvedBy:FUND_MANAGER, approvedAt:'2026-01-02' }));
  assert(true, '🔒 اعتماد التوزيعة declared → approved مرفوض من العميل.');
  await seedLedgerStatus('distributions', 'DST-GATE-1', 'approved');
  await assertFails(updateDoc(doc(dbFM,'distributions','DST-GATE-1'), { status:'paid', amount:1 }));
  assert(true, '🔒 بعد الاعتماد، لا يجوز تمرير تغيير حقل آخر بجانب الترحيل النهائي');
  await assertFails(updateDoc(doc(dbFM,'distributions','DST-GATE-1'), { status:'paid' }));
  assert(true, '🔒 ترحيل التوزيعة approved → paid مرفوض من العميل حتى دون تغيير المبلغ.');
  await seedLedgerStatus('distributions', 'DST-GATE-1', 'paid');
}

// ==================== ١٢) تكامل Monday.com — إعدادات أدمن + قائمة انتظار append-only ====================
{
  const db = ctxFor(ADMIN).firestore();
  await assertSucceeds(setDoc(doc(db,'mondayConfig','settings'), { tasksBoardId:'123', permissionsBoardId:'456', taskOwnerEmail:'saeed@opalco.sa', teamEmails:['saeed@opalco.sa'], enabled:false, updatedBy:ADMIN }));
  assert(true, '✅ الأدمن يقدر يضبط إعدادات Monday.com غير السرّية');
}
{
  const db = ctxFor(FUND_MANAGER).firestore();
  await assertFails(setDoc(doc(db,'mondayConfig','settings'), { tasksBoardId:'999', enabled:true, updatedBy:FUND_MANAGER }));
  assert(true, '🔒 مدير الصندوق لا يقدر يغيّر إعدادات Monday.com العامة — الكتابة للأدمن فقط');
}
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertSucceeds(getDoc(doc(db,'mondayConfig','settings')));
  assert(true, '✅ قراءة إعدادات Monday.com غير السرّية متاحة لأي عضو مصرّح له');
}
{
  const db = ctxFor(ANALYST_OWNER).firestore();
  await assertFails(setDoc(doc(db,'mondayTaskQueue','MND-ANALYST'), { oppId:'OPP-1', title:'x', ownerEmail:'saeed@opalco.sa', status:'pending', queuedBy:ANALYST_OWNER, queuedAt:'2026-01-01T00:00:00.000Z' }));
  assert(true, '🔒 محلل عادي لا يقدر يضيف مهمة إلى قائمة انتظار Monday — يتطلب مدير صندوق فأعلى');
}
{
  const db = ctxFor(FUND_MANAGER).firestore();
  await assertFails(setDoc(doc(db,'mondayTaskQueue','MND-SPOOF'), { oppId:'OPP-1', title:'x', ownerEmail:'saeed@opalco.sa', status:'pending', queuedBy:'someone-else@x.com', queuedAt:'2026-01-01T00:00:00.000Z' }));
  assert(true, '🔒 مدير الصندوق لا يقدر يزيّف queuedBy عند إضافة مهمة Monday');
}
{
  const db = ctxFor(FUND_MANAGER).firestore();
  await assertSucceeds(setDoc(doc(db,'mondayTaskQueue','MND-OK'), { oppId:'OPP-1', title:'x', ownerEmail:'saeed@opalco.sa', status:'pending', queuedBy:FUND_MANAGER, queuedAt:'2026-01-01T00:00:00.000Z' }));
  assert(true, '✅ مدير الصندوق يقدر يضيف مهمة pending إلى قائمة انتظار Monday');
  await assertFails(updateDoc(doc(db,'mondayTaskQueue','MND-OK'), { status:'synced' }));
  assert(true, '🔒 قائمة انتظار Monday إضافة فقط من العميل؛ تحديث حالة الإرسال يتم من Cloud Function عبر Admin SDK');
  await assertFails(deleteDoc(doc(db,'mondayTaskQueue','MND-OK')));
  assert(true, '🔒 قائمة انتظار Monday لا تُحذف من العميل');
}

// ==================== ١٣) [تغطية دائمة — طلب صريح من المستخدم ضمن P0: Trusted Transaction Layer]
// analyst direct IC mutation: التأكد من أن changesIc() تحجب حقل ic بالكامل عن مسار ownsOpp العادي،
// حتى لمالك الفرصة نفسه (لا فقط لمحلل لا يملكها كما في القسم ٢ أعلاه) ولا حتى للأدمن ====================
{
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'opportunities','OPP-1'), baseOpp(ANALYST_OWNER, []));
  });
  const db = ctxFor(ANALYST_OWNER).firestore();
  const attempt = baseOpp(ANALYST_OWNER, [{ decision:'approve', reasons:['محاولة مباشرة'], conditions:[], decidedBy:ANALYST_OWNER, decidedAt:'2026-09-09T10:00:00Z' }]);
  attempt.meta.updatedBy = ANALYST_OWNER;
  await assertFails(setDoc(doc(db,'opportunities','OPP-1'), attempt));
  assert(true, '🔒 [السيناريو المسمّى: analyst direct IC mutation] حتى مالك الفرصة نفسه (محلل) لا يقدر يعدّل حقل ic مباشرة من العميل — changesIc() تحجب الحقل بالكامل عن مسار ownsOpp؛ المسار الوحيد المتبقي هو updateIcConditionStatus عبر Cloud Function');
}
{
  // ملاحظة تصميمية مهمة تُختبَر هنا صراحة (وتُفرّق هذا القسم عن القسم ١٤ التالي): isAdminEmail()
  // هو OR-فرع مستقل تماماً بذاته في allow update لـopportunities (بلا أي AND مع !changesIc) —
  // فالأدمن *يقدر فعلاً* يعدّل ic مباشرة من العميل بتصميم متعمَّد (نفس امتياز "بلا قيد إضافي"
  // الذي يملكه على كل حقول الفرصة)، بخلاف fund.assetIds في القسم ١٤ حيث لا يوجد أي استثناء
  // أدمن إطلاقاً. هذا الفارق التصميمي بين الحقلين موثَّق في تعليق firestore.rules نفسه.
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'opportunities','OPP-1'), baseOpp(ANALYST_OWNER, []));
  });
  const db = ctxFor(ADMIN).firestore();
  const attempt = baseOpp(ANALYST_OWNER, [{ decision:'approve', reasons:[], conditions:[], decidedBy:ADMIN, decidedAt:'x' }]);
  attempt.meta.updatedBy = ADMIN;
  await assertSucceeds(setDoc(doc(db,'opportunities','OPP-1'), attempt));
  assert(true, 'ℹ️ الأدمن *يقدر* يعدّل ic مباشرة من العميل (isAdminEmail() فرع مستقل بلا قيد changesIc) — هذا بتصميم متعمَّد يطابق امتيازه العام على بقية حقول الفرصة، ويُذكَر هنا صراحة لتوثيق الفارق عن حالة fund.assetIds في القسم التالي حيث لا استثناء أدمن إطلاقاً');
}

// ==================== ١٤) [تغطية دائمة — طلب صريح من المستخدم ضمن P0: Trusted Transaction Layer]
// direct fund.assetIds mutation: التأكد من أن changesAssetIds() تحجب الحقل عن أي دور بما فيه
// الأدمن نفسه — بخلاف changesIc() التي تسمح للأدمن بمسار خاص به، فهنا لا استثناء أدمن مطلقاً ====================
{
  await testEnv.withSecurityRulesDisabled(async (ctx)=>{
    await setDoc(doc(ctx.firestore(),'funds','FND-ASSETIDS'), { name:'صندوق تجريبي', assetIds:['OPP-1'] });
  });
  const dbFM = ctxFor(FUND_MANAGER).firestore();
  await assertFails(updateDoc(doc(dbFM,'funds','FND-ASSETIDS'), { assetIds:['OPP-1','OPP-2'] }));
  assert(true, '🔒 [السيناريو المسمّى: direct fund.assetIds mutation] حتى مدير الصندوق (الذي يملك صلاحية isFundManagerOrAbove الكاملة على funds بخلاف ذلك) لا يقدر يعدّل assetIds مباشرة — المسار الوحيد هو linkAssetToFund عبر Cloud Function');
}
{
  const dbAdmin = ctxFor(ADMIN).firestore();
  await assertFails(updateDoc(doc(dbAdmin,'funds','FND-ASSETIDS'), { assetIds:['OPP-1','OPP-3'] }));
  assert(true, '🔒 حتى الأدمن لا يقدر يعدّل fund.assetIds مباشرة رغم أن isFundManagerOrAbove() تمنحه المرور دوماً (isAdminEmail() OR-فرع فيها) — لأن changesAssetIds() لا تحتوي على أي استثناء isAdminEmail() على الإطلاق، بخلاف تصميم changesIc(); هذا الفارق التصميمي المتعمَّد هو بالضبط ما يُختبر هنا');
  await assertSucceeds(updateDoc(doc(dbAdmin,'funds','FND-ASSETIDS'), { name:'صندوق تجريبي (معدّل)' }));
  assert(true, '✅ تعديل أي حقل آخر غير assetIds في نفس الوثيقة يبقى مسموحاً للأدمن — القيد ينصبّ على حقل assetIds تحديداً فقط، لا على الوثيقة كاملة');
}

console.log(failures? `\n${failures} FAILURE(S)` : '\nALL PASSED (current-rules expectations; real Firestore emulator)');
console.warn('OPEN SECURITY ITEMS: opportunity creation with IC data; documented admin IC bypass; fund creation with assetIds; ledger creation exceptions. Passing this suite is NOT full server-only certification.');
await testEnv.cleanup();
process.exit(failures?1:0);
