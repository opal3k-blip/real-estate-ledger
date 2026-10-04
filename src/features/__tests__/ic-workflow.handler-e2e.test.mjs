/* =========================================================================
   اختبار فعلي end-to-end للمعالج الحقيقي registerICWorkflow('ic-decide') — ليس اختباراً لدالة
   مساعدة منفردة (reservePendingIcRequest) كما في ic-workflow.pending-requests.test.mjs، بل
   استدعاء حقيقي لمعالج action الذي تستدعيه الواجهة فعلياً، مع رصد مباشر لعدد ومحتوى استدعاءات
   httpsCallable('approveOpportunity') عبر firebase.functions() مُزيَّف بالكامل (لا تعديل على
   ic-workflow.js نفسه؛ فقط عناصر عامة (global.document/global.firebase/global.localStorage)
   يتوقعها الكود الحقيقي عند useServerFunction===true).

   أربع سيناريوهات طلبها صريحاً: (أ) فشل حفظ طلب جديد يمنع الإرسال فعلياً (لا استدعاء خادم على
   الإطلاق)، (ب) "إعادة تحميل الصفحة" (إعادة استيراد الموديول فعلياً بـcache-busting query، لأن
   pendingIcRequests ثابت على مستوى الموديول يُحمَّل مرة واحدة عند أول استيراد) تحفظ نفس
   requestId، (ج) تغيير المستخدم على نفس الفرصة يُنتج طلبين مستقلّين تماماً بلا تداخل، (د) طلب
   سابق نتيجته غامضة ← إعادة محاولة يفشل حفظها محلياً (لا استدعاء خادم ثانٍ) ← عودة التخزين
   تُعيد استخدام requestId الأصلي نفسه عند إرسال الخادم الفعلي.
   ========================================================================= */
import assert from 'node:assert/strict';

let failures = 0;
function check(cond, label){
  if(cond){ console.log('✅ ' + label); }
  else { failures++; console.log('❌ ' + label); }
}

// ---- localStorage مُصطنَع حقيقي (نفس نمط ic-workflow.pending-requests.test.mjs) ----
function makeFakeStorage(){
  const data = new Map();
  let failRead = false, failWrite = false;
  return {
    getItem(k){ if(failRead) throw new Error('simulated read failure'); return data.has(k) ? data.get(k) : null; },
    setItem(k, v){ if(failWrite) throw new Error('simulated write failure (quota)'); data.set(k, v); },
    removeItem(k){ data.delete(k); },
    _setFailRead(v){ failRead = v; },
    _setFailWrite(v){ failWrite = v; },
    _raw(){ return data; },
  };
}

const storage = makeFakeStorage();
global.localStorage = storage;
global.window = global.window || {};
global.window.localStorage = storage;

// ---- document مُصطنَع: يعيد عنصر form حسب data-ic-form، بحقول ثابتة حسب ما يُمرَّر ----
let currentFormValues = null; // { decision, reasons, conditions, override }
global.document = {
  querySelector(sel){
    const m = /form\[data-ic-form="([^"]+)"\]/.exec(sel);
    if(!m) return null;
    if(!currentFormValues) return null;
    const v = currentFormValues;
    return {
      querySelector(innerSel){
        if(innerSel === '[name="decision"]') return { value: v.decision };
        if(innerSel === '[name="reasons"]') return { value: v.reasons || '' };
        if(innerSel === '[name="conditions"]') return { value: v.conditions || '' };
        if(innerSel === '[name="override"]') return v.override ? { checked: true } : null;
        return null;
      },
    };
  },
};

// ---- firebase مُصطنَع: httpsCallable('approveOpportunity') قابلة للتحكّم بالكامل لكل سيناريو ----
const callLog = []; // { requestId, oppId, decision }
let nextCallableBehavior = null; // function(args) -> throws or returns {data:{...}}
global.firebase = {
  functions(){
    return {
      httpsCallable(name){
        return async (args) => {
          callLog.push({ name, ...args });
          if(typeof nextCallableBehavior !== 'function'){
            throw new Error('test setup error: nextCallableBehavior not set for call #' + callLog.length);
          }
          return nextCallableBehavior(args);
        };
      },
    };
  },
};

global.alert = (msg) => { global.__lastAlert = msg; };

// ---- core مُصطنَع أدنى ما يكفي لتشغيل registerICWorkflow حقيقياً ----
function makeFakeCore(oppId, oppData, userEmail){
  let actionHandler = null;
  const core = {
    DEMO_MODE: false,
    DB: { fake: true }, // أي قيمة صِدقية — فقط useServerFunction يتحقق من truthiness
    // أدمن عمداً (لا سجل دور فعلي في STORE) — فقط لضمان canApproveIC (roleAtLeast senior_ic)
    // صحيحة في هذا الاختبار؛ لا علاقة لهذا بما يُختبَر فعلياً (مسار الخادم/requestId).
    ADMIN_EMAILS: userEmail ? [userEmail.toLowerCase()] : [],
    currentUser: userEmail ? { email: userEmail } : null,
    opportunities: [{ id: oppId, data: oppData }],
    openDetailId: oppId,
    STORE: {},
    T: (ar, en) => ar,
    esc: (s) => s,
    uid: (p) => p + '-' + Math.random().toString(36).slice(2),
    todayStr: () => '2026-10-04',
    withDefaults(data){ return { ...data, ic: (data.ic || { decisions: [] }), meta: data.meta || {} }; },
    canEditOpp(){ return true; },
    registerOpportunitySchemaExtender(){},
    registerDetailSection(){},
    registerActionHandler(fn){ actionHandler = fn; },
    loadAll: async () => {},
    render(){},
    getHandler(){ return actionHandler; },
  };
  return core;
}

const OPP_ID = 'OPP-E2E-1';
const oppData = { ic: { decisions: [] }, meta: {} };

async function run(){
  // استيراد أول (محاكاة أول تحميل للصفحة) — fresh query لضمان عدم تلوّث من أي استيراد سابق
  const mod1 = await import('../ic-workflow.js?e2e1=' + Date.now());
  const core = makeFakeCore(OPP_ID, oppData, 'senior-a@example.com');
  mod1.registerICWorkflow(core);
  const handler = core.getHandler();
  assert.equal(typeof handler, 'function', 'registerActionHandler لم يُستدعَ');

  const el = { dataset: { id: OPP_ID } };

  // ===================== (أ) فشل حفظ طلب جديد يمنع الإرسال فعلياً =====================
  storage._setFailWrite(true);
  currentFormValues = { decision: 'reject', reasons: 'سبب ١\nسبب ٢', conditions: '', override: false };
  callLog.length = 0;
  global.__lastAlert = null;
  nextCallableBehavior = () => { throw new Error('يجب ألا يُستدعى هذا إطلاقاً'); };
  await handler('ic-decide', el);
  check(callLog.length === 0, '(أ) فشل حفظ طلب جديد: لم يُستدعَ httpsCallable إطلاقاً');
  check(!!global.__lastAlert, '(أ) ظهر تنبيه واضح للمستخدم بفشل الحفظ المحلي');
  storage._setFailWrite(false);

  // ===================== (ب) نتيجة غامضة، ثم "إعادة تحميل" تحفظ نفس requestId =====================
  currentFormValues = { decision: 'reject', reasons: 'سبب للرفض الأول', conditions: '', override: false };
  callLog.length = 0;
  nextCallableBehavior = () => { throw Object.assign(new Error('unavailable'), { code: 'unavailable' }); // غامض: ليس في قائمة الرموز النهائية
  };
  await handler('ic-decide', el);
  check(callLog.length === 1, '(ب) الاستدعاء الأول وصل فعلاً إلى httpsCallable');
  const firstRequestId = callLog[0].requestId;
  check(!!firstRequestId, '(ب) requestId أُرسِل فعلاً مع الاستدعاء الأول');

  // "إعادة تحميل الصفحة" فعلية: استيراد جديد تماماً للموديول (pendingIcRequests يُحمَّل من
  // localStorage نفسه من جديد عند top-level) — لا فقط استدعاء دالة تحميل منفردة.
  const mod2 = await import('../ic-workflow.js?e2e2=' + Date.now());
  const core2 = makeFakeCore(OPP_ID, oppData, 'senior-a@example.com'); // نفس المستخدم بعد "إعادة التحميل"
  mod2.registerICWorkflow(core2);
  const handler2 = core2.getHandler();

  currentFormValues = { decision: 'reject', reasons: 'سبب للرفض الأول', conditions: '', override: false }; // نفس الحمولة بالضبط
  callLog.length = 0;
  nextCallableBehavior = (args) => ({ data: { decisionId: 'ICD-FROM-RETRY', versionId: null } }); // الآن تنجح
  await handler2('ic-decide', el);
  check(callLog.length === 1, '(ب) بعد "إعادة التحميل"، إعادة المحاولة بنفس الحمولة أرسلت استدعاءً واحداً فقط');
  check(callLog[0].requestId === firstRequestId, '(ب) requestId بعد "إعادة التحميل" هو نفسه المُرسَل قبلها بالضبط (لم يتغيّر)');

  // ===================== (ج) تغيير المستخدم على نفس الفرصة يعزل الطلبات =====================
  const mod3 = await import('../ic-workflow.js?e2e3=' + Date.now());
  const core3 = makeFakeCore(OPP_ID, oppData, 'senior-a@example.com');
  mod3.registerICWorkflow(core3);
  const handlerA = core3.getHandler();

  currentFormValues = { decision: 'reject', reasons: 'طلب مستخدم أ', conditions: '', override: false };
  callLog.length = 0;
  nextCallableBehavior = () => { throw Object.assign(new Error('deadline-exceeded'), { code: 'deadline-exceeded' }); }; // غامض — يبقى محفوظاً
  await handlerA('ic-decide', el);
  const userARequestId = callLog[0] && callLog[0].requestId;
  check(!!userARequestId, '(ج) المستخدم أ حصل على requestId خاص به');

  const core3b = makeFakeCore(OPP_ID, oppData, 'fund-manager-b@example.com'); // نفس الموديول (mod3) لكن core منفصل لمستخدم آخر
  mod3.registerICWorkflow(core3b);
  const handlerB = core3b.getHandler();

  currentFormValues = { decision: 'reject', reasons: 'طلب مستخدم ب — مختلف تماماً', conditions: '', override: false };
  callLog.length = 0;
  nextCallableBehavior = (args) => ({ data: { decisionId: 'ICD-USER-B', versionId: null } });
  await handlerB('ic-decide', el);
  const userBRequestId = callLog[0] && callLog[0].requestId;
  check(!!userBRequestId, '(ج) المستخدم ب حصل على requestId خاص به أيضاً');
  check(userBRequestId !== userARequestId, '(ج) معرّف المستخدم ب مختلف تماماً عن معرّف المستخدم أ — لا تسرّب بينهما');

  // ===== (ج-٢) الأهم: نفس الحمولة بالحرف الواحد لمستخدمين مختلفين على نفس الفرصة =====
  // (ج-١) أعلاه تستخدم حمولتين مختلفتين، فلا تثبت شيئاً عن توقيع الحمولة نفسه. العزل الحقيقي يجب أن
  // يعتمد على pendingIcRequestKey(userEmail, oppId) — أي المستخدم جزء من المفتاح، لا الحمولة وحدها.
  // هنا نرسل القرار نفسه بالحرف الواحد (decision/reasons/conditions/override) من مستخدمين مختلفين
  // تماماً ونتحقق أن كلاً منهما حصل على requestId مستقل، رغم أن توقيع الحمولة (icRequestPayloadSignature)
  // سيكون مطابقاً تماماً للاثنين.
  const core3c = makeFakeCore(OPP_ID, oppData, 'senior-c1@example.com');
  mod3.registerICWorkflow(core3c);
  const handlerC1 = core3c.getHandler();
  const core3d = makeFakeCore(OPP_ID, oppData, 'senior-c2@example.com');
  mod3.registerICWorkflow(core3d);
  const handlerC2 = core3d.getHandler();

  const identicalPayload = { decision: 'reject', reasons: 'حمولة متطابقة بالحرف الواحد لمستخدمين مختلفين', conditions: '', override: false };

  currentFormValues = identicalPayload;
  callLog.length = 0;
  nextCallableBehavior = () => { throw Object.assign(new Error('deadline-exceeded'), { code: 'deadline-exceeded' }); }; // غامض — يبقى محفوظاً لفحص التخزين الفعلي بعدها
  await handlerC1('ic-decide', el);
  const c1RequestId = callLog[0] && callLog[0].requestId;
  check(!!c1RequestId, '(ج-٢) المستخدم C1 (حمولة متطابقة) حصل على requestId خاص به');

  currentFormValues = identicalPayload; // نفس الكائن بالضبط — حمولة متطابقة تماماً، لا فرق ولو حرف واحد
  callLog.length = 0;
  nextCallableBehavior = () => { throw Object.assign(new Error('deadline-exceeded'), { code: 'deadline-exceeded' }); };
  await handlerC2('ic-decide', el);
  const c2RequestId = callLog[0] && callLog[0].requestId;
  check(!!c2RequestId, '(ج-٢) المستخدم C2 (نفس الحمولة بالحرف الواحد) حصل أيضاً على requestId خاص به');
  check(!!c1RequestId && !!c2RequestId && c1RequestId !== c2RequestId,
    '(ج-٢) حتى بحمولة متطابقة بالحرف الواحد، معرّفا الطلبين مختلفان تماماً — العزل فعلياً مبني على المستخدم (pendingIcRequestKey) لا على توقيع الحمولة وحده');

  // فحص تخزين حقيقي فعلي (لا check(true) صوري كما كان سابقاً): نقرأ localStorage المُصطنَع نفسه
  // تحت المفتاح الحقيقي الذي يستخدمه الكود (reop:pendingIcRequests:v1)، ونؤكد وجود مُدخَلين منفصلين
  // تماماً بمفتاحين مركّبين مختلفين (بريد::رقم الفرصة)، كل منهما بمعرّفه وتوقيعه الصحيحين فعلاً —
  // لا افتراضاً من قيم callLog فقط.
  const PENDING_IC_REQUESTS_STORAGE_KEY = 'reop:pendingIcRequests:v1';
  const rawPersisted = storage._raw().get(PENDING_IC_REQUESTS_STORAGE_KEY);
  check(!!rawPersisted, '(ج-٢) التخزين الفعلي يحتوي مفتاح reop:pendingIcRequests:v1 بعد طلبي C1/C2');

  let persistedMap = {};
  try{ persistedMap = rawPersisted ? JSON.parse(rawPersisted) : {}; }catch(e){ persistedMap = {}; }
  const c1Key = 'senior-c1@example.com::' + OPP_ID;
  const c2Key = 'senior-c2@example.com::' + OPP_ID;
  const c1Entry = persistedMap[c1Key];
  const c2Entry = persistedMap[c2Key];
  check(!!c1Entry && !!c2Entry, '(ج-٢) التخزين الفعلي (لا الذاكرة فقط) يحتوي مُدخَلين منفصلين تماماً، أحدهما لكل مستخدم');
  check(!!c1Entry && c1Entry.requestId === c1RequestId, '(ج-٢) مُدخَل C1 في التخزين الفعلي يحمل requestId الصحيح له بالضبط');
  check(!!c2Entry && c2Entry.requestId === c2RequestId, '(ج-٢) مُدخَل C2 في التخزين الفعلي يحمل requestId الصحيح له بالضبط');
  check(!!c1Entry && !!c2Entry && c1Entry.requestId !== c2Entry.requestId,
    '(ج-٢) معرّفا المُدخلين المحفوظين في التخزين الفعلي مختلفان تماماً — لم يطغَ أحدهما على الآخر رغم الحمولة المتطابقة');
  // توقيع الحمولة الحقيقي (icRequestPayloadSignature في ic-workflow.js) لا يأخذ reasons/conditions
  // كنصّ خام من الحقل — بل بعد splitLines() المحلية في ic-workflow.js (غير مُصدَّرة، فنُعيد إنتاج
  // منطقها هنا بالحرف الواحد لمطابقة ما يُحسب فعلياً داخل المعالج الحقيقي، لا ما افترضناه):
  const splitLinesLikeRealCode = (text) => String(text||'').split('\n').map(s=>s.trim()).filter(Boolean);
  const expectedReasons = splitLinesLikeRealCode(identicalPayload.reasons);
  const expectedConditions = splitLinesLikeRealCode(identicalPayload.conditions).map(text=>({ text, owner:'', dueDate:'', status:'pending' }));
  const expectedSignature = JSON.stringify({ oppId: OPP_ID, decision: identicalPayload.decision, reasons: expectedReasons, conditions: expectedConditions, override: !!identicalPayload.override });
  check(!!c1Entry && c1Entry.signature === expectedSignature, '(ج-٢) توقيع الحمولة المحفوظ لـC1 في التخزين الفعلي مطابق تماماً لما أُرسِل');
  check(!!c2Entry && c2Entry.signature === expectedSignature, '(ج-٢) توقيع الحمولة المحفوظ لـC2 مطابق أيضاً (نفس التوقيع بالحرف الواحد، لكن تحت مفتاح مركّب مختلف تماماً)');

  // تأكيد إضافي أن طلب (ج-١) (المستخدم أ) السابق ما زال محفوظاً أيضاً في نفس التخزين الفعلي، لم
  // يُحذَف أو يُستبدَل خطأً بسبب تدخل مستخدمين آخرين على نفس الفرصة بعده.
  const userAKey = 'senior-a@example.com::' + OPP_ID;
  const userAEntry = persistedMap[userAKey];
  check(!!userAEntry && userAEntry.requestId === userARequestId,
    '(ج-٢) طلب المستخدم أ من (ج-١) ما زال محفوظاً في التخزين الفعلي بنفس requestId، لم يُطغَ عليه رغم كل التدخلات اللاحقة');

  // ===================== (د) غامضة ← فشل حفظ إعادة المحاولة ← عودة التخزين تُعيد نفس المعرّف =====================
  const mod4 = await import('../ic-workflow.js?e2e4=' + Date.now());
  const core4 = makeFakeCore(OPP_ID, oppData, 'senior-d@example.com');
  mod4.registerICWorkflow(core4);
  const handlerD = core4.getHandler();

  currentFormValues = { decision: 'reject', reasons: 'سيناريو (د) — المحاولة الأولى', conditions: '', override: false };
  callLog.length = 0;
  nextCallableBehavior = () => { throw Object.assign(new Error('internal'), { code: 'internal' }); }; // غامض
  await handlerD('ic-decide', el);
  const dOriginalRequestId = callLog[0] && callLog[0].requestId;
  check(!!dOriginalRequestId, '(د) المحاولة الأولى (غامضة) أرسلت requestId أصلياً');

  // إعادة محاولة بنفس الحمولة بالضبط، لكن حفظ المحاولة الثانية يفشل محلياً
  storage._setFailWrite(true);
  callLog.length = 0;
  global.__lastAlert = null;
  nextCallableBehavior = () => { throw new Error('يجب ألا يُستدعى — الحفظ فشل قبل الوصول للخادم'); };
  await handlerD('ic-decide', el); // نفس currentFormValues بالضبط
  check(callLog.length === 0, '(د) فشل حفظ إعادة المحاولة: لا استدعاء ثانٍ للخادم إطلاقاً');
  check(!!global.__lastAlert, '(د) ظهر تنبيه بفشل حفظ إعادة المحاولة');
  storage._setFailWrite(false);

  // التخزين يعود للعمل؛ المحاولة التالية (نفس الحمولة) يجب أن تستخدم نفس requestId الأصلي
  callLog.length = 0;
  nextCallableBehavior = (args) => ({ data: { decisionId: 'ICD-D-FINAL', versionId: null } });
  await handlerD('ic-decide', el);
  check(callLog.length === 1, '(د) بعد عودة التخزين، المحاولة التالية وصلت فعلاً إلى الخادم');
  check(callLog[0] && callLog[0].requestId === dOriginalRequestId, '(د) ...وبنفس requestId الأصلي بالضبط — لا معرّف جديد رغم فشل الحفظ بينهما');

  console.log(failures ? `\n== النتيجة: ${failures} فشل ==` : '\n== النتيجة: 0 فشل — المعالج الحقيقي registerICWorkflow نفسه (لا دالة مساعدة منفردة) تحقَّق end-to-end عبر إعادة استيراد حقيقية للموديول ومراقبة مباشرة لعدد ومحتوى استدعاءات httpsCallable ==');
  process.exit(failures ? 1 : 0);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
