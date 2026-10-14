/* =========================================================================
   لجنة الاستثمار — Investment Committee Workflow (Phase 1، وسّعت حوكمياً في
   المرحلة السابعة — P0 #1 و #2)
   ---------------------------------------------------------------------------
   سجل قرارات لجنة الاستثمار لكل فرصة (وقد تجتمع اللجنة أكثر من مرة على نفس
   الفرصة — Revise/Hold ثم إعادة عرض): القرار (اعتماد / اعتماد بشروط / رفض /
   مراجعة / تعليق) + الأسباب + الشروط (كل شرط: نص + مسؤول + موعد نهائي + حالة
   إنجاز يمكن تحديثها لاحقاً) + من قرَّر ومتى.
   سجل إضافة فقط (Append-only) مطابق لنمط سجل التعديلات — لا حاجة لمعرّفات
   عشوائية لأن الإدخالات لا تُنشأ إلا بعد الحفظ الفعلي (لا قيم افتراضية مسبقة)،
   فمواضع المصفوفة (index) مستقرة تماماً بخلاف حقول العناية الواجبة/المخاطر.

   إصلاح حوكمي حرج (P0 #1): "صلاحيات لجنة الاستثمار ليست محكومة فعليًا" — كان
   نموذج تسجيل القرار يظهر ويُنفَّذ لأي شخص core.canEditOpp(rec) صحيح معه (أي
   مالك/محرِّر الفرصة نفسها)، بمعنى أن المحلل الذي أنشأ الفرصة يمكنه "اعتماد"
   صفقته هو نفسه. الإصلاح: عرض/تنفيذ اتخاذ القرار مُقيَّد الآن بـ canApproveIC()
   (عضو لجنة أول فأعلى) — دور مستقل تماماً عن ownership الفرصة، مطابقةً لمصفوفة
   الصلاحيات المطلوبة (محلل: إنشاء/تعديل فرصه/رفع للجنة ✅، اعتماد ❌ — عضو لجنة
   أول/مدير صندوق: اعتماد ✅). القيد الحقيقي غير القابل للتجاوز مطبَّق أيضاً في
   firestore.rules (icOnlyChange) — راجع التعليق هناك. تبديل الشرط في الطبقتين
   (هنا + Firestore) معاً هو ما يجعل الحوكمة فعلية لا شكلية.
   تبديل تحديث حالة "الشرط" (ic-toggle-condition) عمداً بقي على canEditOpp: هذا
   تتبُّع تنفيذي (checklist) لا قرار لجنة، ومن الطبيعي أن يُحدِّثه صاحب الفرصة
   نفسه بعد استيفاء شرط اعتماد مشروط.

   إصلاح حوكمي حرج (P0 #2): "الـ IC يجب ألا يكون مجرد 'تسجيل قرار'" — أي قرار
   "اعتماد"/"اعتماد بشروط" يُقيَّد الآن ببوابة الجهوزية الحقيقية من
   ic-decision-gate.js (icReadiness — أربع بوابات: مالية/عناية واجبة/حوكمة/
   تسعير). عند عدم الجهوزية: يُحظَر الاعتماد إلا بتفعيل "تجاوز واعٍ" صريح +
   تبرير مكتوب في حقل الأسباب — ويُسجَّل ذلك في سجل القرار نفسه (overridden:
   true + أسباب عدم الجهوزية وقت القرار) حتى يبقى أثر دائم لأي اعتماد استثنائي.
   ملخص الجاهزية في أعلى القسم لا يزال يعرض جودة البيانات/العناية الواجبة
   للسياق السريع، لكن المصدر الحقيقي للحظر الآن هو icReadiness() الموحَّدة.
   لا تعديل على منطق core.js الداخلي — فقط عبر نقاط التوسّع المُصدَّرة.
   ========================================================================= */

import { dataQualityStats } from './data-quality.js';
import { documentHashHex } from '../domain/validation/document-hash.js';
import { ddStats, defaultItemsDict as ddDefaultItemsDict } from './due-diligence.js';
import { canApproveIC } from './roles-permissions.js';
import { buildUnderwritingVersionRecord } from './underwriting-versions.js?v=20260913-stage7b';
import { icReadiness } from './ic-decision-gate.js';
import { classifyOpportunity } from '../domain/validation/risk-classification.js';

const APPROVAL_DECISIONS = ['approve', 'approve_conditions'];

// Phase 2R-4E: requestId contract (client side of functions/index.js::approveOpportunity's
// idempotent replay). One in-flight/last-attempted request is tracked per opportunity:
//  - busy=true blocks a second click while the current attempt is still in flight, so a
//    double-click can never mint two different requestIds for the same decision.
//  - on a DEFINITIVE outcome (success, or a definitive rejection code) the entry is cleared —
//    the next attempt for that opportunity is a fresh decision and gets a fresh requestId.
//  - on an AMBIGUOUS outcome (network drop, timeout, deadline-exceeded, unavailable, internal,
//    or any other code not known to be definitive) the entry is KEPT with busy=false: we do not
//    know whether the server actually executed the request, so a retry of the exact same
//    payload must reuse the exact same requestId (never mint a new one), letting the server's
//    own idempotent replay recognize "the same request again" rather than risk double-execution.
//    A retry with a genuinely different payload (the user changed the decision) is not a retry
//    of that request at all, so it gets its own new requestId — reusing the old one there would
//    just be rejected by the server as already-exists for a different payload.
// إصلاح على مراجعة ثانية (بعد إصلاح بند ٢ أعلاه)، نقطتان أثبتهما المراجع باختبار حقيقي لا مصطنع:
//
// ١) "إعادة تحميل الصفحة تفقد معرّف الطلب المعلّق" — كانت pendingIcRequests في الذاكرة فقط (Map
//    عادية)؛ أي إعادة تحميل (أو إعادة تهيئة الوحدة) تُفقِدها بالكامل. إذا كان الخادم قد نفَّذ
//    الطلب الأول فعلاً لكن استجابته ضاعت (انقطاع شبكة بعد التنفيذ، قبل أن يصل الرد للعميل)، ثم
//    أعاد المستخدم تحميل الصفحة وحاول مرة أخرى، كانت المحاولة التالية تُولِّد requestId **جديداً**
//    لما يُفترض منطقياً أنه "نفس القرار المعلّق" — بالضبط الخطر الذي صُمِّم pendingIcRequests
//    لمنعه أصلاً، فقط نجا منه إعادة التحميل بلا أي حماية. الإصلاح: مرآة في localStorage (مفتاح
//    واحد يحمل كل الطلبات المعلّقة الحالية كـJSON)، تُقرأ عند تحميل الوحدة وتُكتب عند كل
//    set/delete — تنجو من إعادة تحميل الصفحة لأنها تعيش خارج ذاكرة تشغيل JS للتبويب.
// ٢) "تغيير المستخدم يعيد استخدام معرّف المستخدم السابق" — المفتاح كان oppId وحده؛ مستخدم آخر
//    (بعد تسجيل خروج/دخول، أو جلسة مختلفة) على نفس الفرصة كان يرى نفس الإدخال المعلّق (requestId
//    وsignature مستخدم آخر) ويحتمل إعادة استخدامه. هذا لا يتجاوز صلاحيات (الخادم يتحقق مستقلاً من
//    هوية ودور المتصل الحقيقي في كل الحالات عبر requireRole)، لكنه خلل حقيقي في إدارة الطلبات/
//    الجلسات. الإصلاح: المفتاح الآن "<بريد المستخدم>::<oppId>" — مستخدم مختلف = مفتاح مختلف بنيوياً،
//    لا تقاطع ممكن إطلاقاً بين مستخدمين على نفس الفرصة.
// export مباشر (بلا أي أثر جانبي خاص بهذا الاستدعاء) للثلاثة — يسمح باختبار مباشر لآلية
// الاستمرارية والمفتاح المركَّب نفسها، بدل الاعتماد على محاكاة كاملة لمسار registerICWorkflow.
const PENDING_IC_REQUESTS_STORAGE_KEY = 'reop:pendingIcRequests:v1';
export function pendingIcRequestKey(userEmail, oppId){
  return (userEmail || 'anon') + '::' + oppId;
}
export function loadPendingIcRequestsFromStorage(){
  try{
    if(typeof localStorage === 'undefined') return new Map();
    const raw = localStorage.getItem(PENDING_IC_REQUESTS_STORAGE_KEY);
    if(!raw) return new Map();
    const parsed = JSON.parse(raw);
    if(!parsed || typeof parsed !== 'object') return new Map();
    const map = new Map(Object.entries(parsed));
    // عند التحميل (أول مرة في تبويب/جلسة JS جديدة)، لا يوجد إطلاقاً أي طلب "قيد التنفيذ الآن" فعلياً
    // في هذا السياق الجديد — busy:true محفوظة من قبل إعادة التحميل تعني فقط أن الاستجابة لم تصل
    // بعد في السياق القديم، لا أن شيئاً يعمل الآن. نُعيدها busy:false دوماً عند التحميل: نتيجة
    // غامضة قابلة لإعادة المحاولة بنفس requestId، لا "مشغولة" تمنع أي محاولة جديدة إلى الأبد.
    map.forEach((entry) => { if(entry && entry.busy) entry.busy = false; });
    return map;
  }catch(e){
    return new Map(); // تخزين محظور/تالف (وضع خاص، إعدادات متصفح) — نبدأ نظيفاً، لا نكسر الواجهة
  }
}
// إصلاح على مراجعة ثالثة: كانت هذه الدالة تبتلع فشل الكتابة بصمت (بلا قيمة إرجاع)، فيستمر معالج
// القرار في إرسال الطلب للخادم حتى لو تعذّر حفظ معرّفه فعلياً. التسلسل الذي أثبته المراجع: فشل
// الكتابة → يُرسَل الطلب وتصل نتيجة غامضة → إعادة تحميل الصفحة → لا أثر لهذا الطلب في التخزين
// (لأن الكتابة فشلت أصلاً) → المحاولة التالية تُولِّد requestId **جديداً تماماً** بلا أي علم أن
// طلباً سابقاً قد يكون نفَّذه الخادم فعلاً — بالضبط خطر التكرار الذي صُمِّمت هذه الآلية كلها
// لمنعه. الإصلاح: الدالة تُعيد الآن true/false؛ false تعني "لا يجوز الاعتماد على هذا المعرّف
// كمحمي من إعادة التحميل" — والمستدعي (أدناه) يتوقف عن إرسال القرار كلياً في هذه الحالة، لا أن
// يتابع كأن شيئاً لم يحدث.
export function persistPendingIcRequests(map){
  try{
    if(typeof localStorage === 'undefined') return false;
    localStorage.setItem(PENDING_IC_REQUESTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
    return true;
  }catch(e){
    return false; // تخزين محظور/ممتلئ — فشل صريح يُعاد للمستدعي، لا نجاح متظاهر
  }
}

// إصلاح على مراجعة ثالثة: كان المعالج يحجز requestId في الذاكرة (pendingIcRequests.set) ثم يستدعي
// persistPendingIcRequests() بلا فحص نتيجتها، فيُرسِل القرار للخادم حتى لو فشل الحفظ فعلياً في
// localStorage. السيناريو الذي أثبته المراجع: فشل الكتابة → يُرسَل الطلب وتصل نتيجة غامضة → تُعاد
// تهيئة الصفحة (فيضيع requestId لأنه لم يُحفَظ فعلياً) → المحاولة التالية تستخدم معرّفاً جديداً؛ لو
// كان الخادم نفَّذ الطلب الأول فعلاً، قد يُسجَّل قرار إضافي عبر آلية الاستبدال المتماثل في الخادم.
// الإصلاح: دالة مُصدَّرة صرفة تُستخدَم في نقطة الحجز الوحيدة في المعالج (ويختبرها الاختبار مباشرة
// بلا محاكاة لمنطق المعالج نفسه) — تُرجع true فقط إذا نجح الحفظ الفعلي في localStorage؛ عند الفشل
// تتراجع عن الإدخال في الذاكرة أيضاً وتُرجع false، فيتوقف المعالج قبل استدعاء الخادم إطلاقاً.
//
// إصلاح على مراجعة رابعة: التراجع عند فشل الحفظ كان يحذف الإدخال في pendingKey **دون قيد أو شرط**.
// هذا صحيح فقط إذا لم يكن هناك إدخال سابق أصلاً (أول حجز لهذا الطلب). لكن إن كان هناك إدخال سابق
// فعلاً — طلب سابق أُرسِل ووصلت نتيجته غامضة (busy:false, requestId محفوظ من محاولة سابقة)، ثم
// المستخدم أعاد المحاولة بنفس الحمولة (نفس signature، فيُعاد استخدام requestId الأصلي نفسه)، وفشل
// الحفظ في *هذه* المحاولة بالذات — فالحذف هنا يفقد requestId الأصلي الذي قد يكون الخادم نفَّذه
// فعلاً في المحاولة الأولى، فتُولِّد المحاولة التالية (بعد عودة التخزين) معرّفاً **جديداً تماماً**
// بلا علم بالطلب الأصلي — بالضبط الثغرة التي صُمِّمت هذه الآلية كلها لمنعها. الإصلاح: نحفظ الحالة
// التي كانت موجودة قبل هذا الحجز (قد تكون undefined)، وعند فشل الحفظ نستعيدها بالضبط كما كانت —
// لا نحذف إلا إذا لم يكن هناك شيء لنستعيده أصلاً.
export function reservePendingIcRequest(pendingIcRequests, pendingKey, requestId, signature, payload){
  const previousEntry = pendingIcRequests.get(pendingKey); // الحالة قبل هذا الحجز — للاستعادة الدقيقة إن فشل الحفظ
  // 3A-3: تُحفَظ الحمولة الأصلية **كاملة** (بما فيها requestId وexpectedDocHash) لإعادة إرسالها حرفياً بعد نتيجة غامضة.
  pendingIcRequests.set(pendingKey, payload ? { requestId, signature, busy: true, payload } : { requestId, signature, busy: true });
  const persisted = persistPendingIcRequests(pendingIcRequests);
  if(!persisted){
    if(previousEntry){
      pendingIcRequests.set(pendingKey, previousEntry); // استعادة الطلب السابق (نتيجة غامضة سابقاً) كما كان بالضبط — لا حذف لمعرّفه
    }else{
      pendingIcRequests.delete(pendingKey); // لا يوجد طلب سابق لنستعيده — هذا حجز جديد بالكامل فشل حفظه
    }
    persistPendingIcRequests(pendingIcRequests); // مزامنة التخزين مع الاستعادة/الحذف أعلاه، بأفضل جهد فقط؛ نتيجته هنا غير مهمة
    return false;
  }
  return true;
}
const pendingIcRequests = loadPendingIcRequestsFromStorage(); // key: "<email>::<oppId>" -> { requestId, signature, busy }
const IC_REQUEST_DEFINITIVE_ERROR_CODES = new Set([
  'invalid-argument', 'permission-denied', 'unauthenticated', 'not-found', 'failed-precondition', 'already-exists',
]);
// إصلاح بند ٢ من مراجعة 4E: رمز الخطأ الحقيقي القادم من httpsCallable في SDK العميل يصل بصيغة
// "functions/<code>" (مثلاً "functions/permission-denied") — هذه الصيغة موثَّقة رسمياً من Firebase
// (firebase.google.com/docs/functions/callable)، وليست حالة نادرة أو بيئة محددة. المقارنة القديمة
// كانت تقارن err.code الخام مباشرة بمجموعة IC_REQUEST_DEFINITIVE_ERROR_CODES التي تحمل الأكواد
// بلا بادئة — فأي خطأ حقيقي بصيغة "functions/permission-denied" لا يطابق "permission-denied" أبداً،
// فيُعامَل الرفض النهائي كنتيجة **غامضة** خطأً (الطلب المعلّق يبقى محفوظاً بدل أن يُحذف، ويُعاد
// استخدام requestId نفسه في المحاولة التالية بدل توليد معرّف جديد لقرار يُفترض أنه رُفض نهائياً).
// الإصلاح: توحيد الرمز (إزالة بادئة "functions/" إن وُجدت) قبل أي مقارنة — يعمل مع كِلا الصيغتين.
// export مباشر (بلا أي أثر جانبي) خصيصاً ليكون قابلاً للاختبار المباشر (بند ٢ من مراجعة 4E: "اختبار
// الحالتين") دون الحاجة لمحاكاة كامل مسار registerICWorkflow/httpsCallable.
export function normalizeFunctionsErrorCode(code){
  if (typeof code !== 'string') return code;
  return code.startsWith('functions/') ? code.slice('functions/'.length) : code;
}
// 3A-3: الحمولة تشمل الآن إقرار التحذيرات المركّبة وبصمة الوثيقة التي رُوجعت — يجب أن تطابق ما يقارنه
// الخادم لاستبدال requestId (نفس المعرّف مع حمولة مختلفة يُرفض هناك).
export function icRequestPayloadSignature(oppId, decision, reasons, conditions, override, warningsAcknowledged, expectedDocHash){
  return JSON.stringify({ oppId, decision, reasons, conditions, override: !!override, warningsAcknowledged: !!warningsAcknowledged, expectedDocHash: expectedDocHash || null });
}
// 3A-3: طلب غامض معلَّق (نتيجته مجهولة: قد يكون الخادم نفّذه). السياسة: لا يُستبدل تلقائياً أبداً بطلب جديد.
//  - نفس محتوى القرار => تُعاد **الحمولة الأصلية حرفياً** (نفس requestId ونفس expectedDocHash) فيردّ الخادم الرد الأصلي أو يرفض نهائياً.
//  - محتوى مختلف أو طلب قديم بلا حمولة محفوظة => لا يُرسَل شيء، ويُطلب من المستخدم إعادة إرسال القرار نفسه أو تجاهل المعلَّق صراحةً.
//  - لا يُمحى المعلَّق إلا برد نهائي من الخادم (أو بتجاهل صريح من المستخدم).
function sameJson(a, b){ return JSON.stringify(a == null ? null : a) === JSON.stringify(b == null ? null : b); }
export function resolveAmbiguousIcRequest(entry, form){
  if(!entry || !entry.payload || typeof entry.payload !== 'object') return { action: 'block', why: 'legacy' };
  const p = entry.payload;
  const pd = p.decision && p.decision.decision;
  const same = pd === form.decision
    && sameJson(p.reasons, form.reasons)
    && sameJson(p.conditions, form.conditions)
    && !!p.override === !!form.override
    && (!p.warningsAcknowledged || !!form.warningsAcknowledged);
  return same ? { action: 'resend' } : { action: 'block', why: 'different' };
}
export function ambiguousIcRequestNotice(entry){
  if(!entry || entry.busy) return null;
  const p = entry.payload;
  return { decision: p && p.decision ? p.decision.decision : null, legacy: !p };
}

// 3A-3: رسالة واضحة (بلا أرقام) لرموز الرفض الخاصة بالخادم.
export function approvalRejectionMessage(core, err){
  const code = err && err.details && err.details.rejectionCode;
  if(code === 'DOC_CHANGED') return core.T('تغيّرت الفرصة بعد مراجعتها. أُعيد تحميل المعاينة — راجِعها ثم أعد المحاولة.','The opportunity changed after it was reviewed. The preview was reloaded — review it and try again.');
  if(code === 'INPUTS_BLOCKED') return core.T('الاعتماد محجوب: المدخلات غير صالحة أو غير مكتملة (أحمر). صحّح المدخلات أولاً.','Approval blocked: the inputs are invalid or incomplete (red). Fix the inputs first.');
  if(code === 'WARNINGS_ACK_REQUIRED') return core.T('تجتمع عدة مخاطر عالية — الاعتماد يتطلب إقراراً مكتوباً: فعّل خانة الإقرار واكتب السبب.','Several high-risk conditions apply together — approval needs a written acknowledgement: tick the acknowledgement box and write the reason.');
  return null;
}
function newIcRequestId(oppId){
  return 'ic-' + oppId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

const DECISIONS = [
  { key:'approve',            ar:'اعتماد',            en:'Approve',                 color:'#34d399' },
  { key:'approve_conditions', ar:'اعتماد بشروط',      en:'Approve with Conditions', color:'#a3e635' },
  { key:'revise',             ar:'مراجعة وإعادة عرض', en:'Revise & Resubmit',       color:'#fbbf24' },
  { key:'hold',               ar:'تعليق',              en:'Hold',                    color:'#fb923c' },
  { key:'reject',             ar:'رفض',                en:'Reject',                  color:'#f87171' },
];
const DEC_BY_KEY = Object.fromEntries(DECISIONS.map(d=>[d.key,d]));

function splitLines(text){
  return String(text||'').split('\n').map(s=>s.trim()).filter(Boolean);
}

export function registerICWorkflow(core){
  /* 3A-3: معاينة الاعتماد من الخادم. الخادم وحده يحسب بصمة الوثيقة (docHash) والحكم (أحمر/أصفر/أخضر)؛ الواجهة تعرضهما
     وتُرسل البصمة التي رأتها مع طلب الاعتماد. تُجلب المعاينة مجدداً كلما تغيّرت بيانات الفرصة في الواجهة. */
  const approvalPreviews = new Map(); // oppId -> { sig, status:'loading'|'ready'|'error', docHash, verdict, error }
  const docSig = (rec)=>{ try{ return JSON.stringify(rec.data); }catch(e){ return 'unserialisable:' + Math.random(); } };
  const serverApprovalAvailable = ()=> !core.DEMO_MODE && core.DB && typeof firebase!=='undefined' && firebase.functions;
  function ensureApprovalPreview(oppId, rec){
    const sig = docSig(rec);
    const cur = approvalPreviews.get(oppId);
    if(cur && cur.sig === sig) return cur;
    const entry = { sig, status:'loading', docHash:null, displayedHash:null, verdict:null, error:null };
    approvalPreviews.set(oppId, entry);
    // البصمة تُحسب من نسخة المستند التي تعرضها الواجهة الآن (تسلسل معياري متزامن، ثم SHA-256 القياسي من WebCrypto)،
    // وتُرسل للخادم الذي يقارنها ببصمة ما قرأه فعلاً. لا تُقبل المعاينة إلا إذا تطابقت النسختان.
    // documentHashHex يُسلسل المستند معيارياً بشكل متزامن لحظة الاستدعاء (قبل أي انتظار)، فلا سباق مع تحديثات لاحقة لـ rec.data.
    documentHashHex(rec.data).then(displayedHash=>{
      entry.displayedHash = displayedHash;
      return firebase.functions().httpsCallable('getApprovalPreview')({ oppId, displayedDocHash: displayedHash });
    }).then(resp=>{
      const data = resp && resp.data;
      if(!data || typeof data.docHash !== 'string' || !/^[0-9a-f]{64}$/.test(data.docHash) || !data.verdict) throw new Error('bad preview response');
      if(approvalPreviews.get(oppId) !== entry) return;
      if(data.displayedMatches !== true || data.docHash !== entry.displayedHash){
        // الخادم يرى نسخة مختلفة عمّا يعرضه المستخدم: لا حكم ولا بصمة تُقبل — يلزم تحديث صريح.
        entry.status = 'stale'; return;
      }
      entry.status = 'ready'; entry.docHash = data.docHash; entry.verdict = data.verdict;
    }).catch(err=>{
      if(approvalPreviews.get(oppId) !== entry) return;
      entry.status = 'error'; entry.error = (err && err.message) ? err.message : String(err);
    }).then(()=>{ if(approvalPreviews.get(oppId) === entry && core.openDetailId === oppId) core.render(); });
    return entry;
  }
  // الحكم المحلي (وضع الديمو/التشغيل المحلي حيث لا خادم) — نفس الوحدة المشتركة التي يشغّلها الخادم.
  function localVerdict(rec){
    try{
      const { ic, ...input } = JSON.parse(JSON.stringify(rec.data || {}));
      const d = core.withDefaults(input);
      return classifyOpportunity(d, core.compute(d));
    }catch(e){ return { blocked:true, color:'red', status:'ERROR', compound:{ requiresAcknowledgement:false, count:0, threshold:3 } }; }
  }

  core.registerOpportunitySchemaExtender(()=>({
    ic: { decisions: [] }, // {decision, reasons:[string], conditions:[{text,owner,dueDate,status}], decidedBy, decidedAt}
  }));

  core.registerDetailSection((d, c)=>{
    const oppId = core.openDetailId;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec) return '';
    const canEdit = core.canEditOpp(rec);
    const canApprove = canApproveIC(core);
    const decisions = (d.ic && d.ic.decisions) || [];
    const latest = decisions.length? decisions[decisions.length-1] : null;

    // ملخص جاهزية سريع (سياق فقط — الحظر الفعلي على الاعتماد يعتمد على icReadiness أدناه)
    const dq = dataQualityStats(core, d);
    const dd = ddStats((d.dd && d.dd.items) || ddDefaultItemsDict());
    const readinessOk = dq.criticalMissing.length===0 && dd.criticalPending===0;

    // بوابة الجهوزية الكاملة (المالية/DD/الحوكمة/التسعير) من ic-decision-gate.js
    const gate = icReadiness(core, d, c);
    const gateReasonsHtml = gate.reasons.length
      ? `<ul style="margin:6px 0 0; padding-inline-start:18px; font-size:11.5px;">${gate.reasons.map(r=>`<li>${core.T(r.ar,r.en)}</li>`).join('')}</ul>` : '';

    // 3A-3: الحكم (أحمر/أصفر/أخضر) — من الخادم عند وجوده، وإلا من الوحدة المشتركة محلياً.
    let preview = null, verdictView = null;
    if(canApprove){
      if(serverApprovalAvailable()){
        preview = ensureApprovalPreview(oppId, rec);
        if(preview.status==='ready') verdictView = preview.verdict;
      }else{
        const lv = localVerdict(rec);
        verdictView = { blocked: lv.blocked, color: lv.color, compound: lv.compound };
      }
    }
    const verdictBlocked = !!(verdictView && verdictView.blocked);
    const needsAck = !!(verdictView && !verdictView.blocked && verdictView.compound && verdictView.compound.requiresAcknowledgement);
    const previewNote = (preview && preview.status==='loading')
      ? `<div class="note" style="margin:0 0 10px; font-size:11.5px;">⏳ ${core.T('جارٍ تحميل معاينة الاعتماد من الخادم… (الاعتماد متاح بعد اكتمالها)','Loading the approval preview from the server… (approval is available once it finishes)')}</div>`
      : (preview && preview.status==='stale')
        ? `<div class="note" data-ic-stale="1" style="margin:0 0 10px; font-size:11.5px; color:var(--bad);">⚠️ ${core.T('النسخة المعروضة تختلف عن نسخة الخادم الحالية؛ الاعتماد متوقف حتى تحدّث المعاينة.','The displayed version differs from the server\'s current version; approval is paused until you refresh the preview.')} <button type="button" class="btn btn-sm btn-ghost" data-action="ic-refresh-preview" data-id="${oppId}" style="margin-inline-start:8px;">🔄 ${core.T('تحديث المعاينة','Refresh preview')}</button></div>`
      : (preview && preview.status==='error')
        ? `<div class="note" style="margin:0 0 10px; font-size:11.5px; color:var(--bad);">⚠️ ${core.T('تعذّر تحميل معاينة الاعتماد؛ لا يمكن الاعتماد الآن. أعد فتح الفرصة وحاول مجدداً.','Could not load the approval preview; approval is unavailable. Reopen the opportunity and try again.')}</div>`
        : '';
    const pendingEntry = canApprove && serverApprovalAvailable()
      ? ambiguousIcRequestNotice(pendingIcRequests.get(pendingIcRequestKey(core.currentUser ? core.currentUser.email : null, oppId))) : null;
    const pendingBox = pendingEntry
      ? `<div class="note" data-ic-pending="1" style="margin:0 0 10px; color:var(--bad); background:#f59e0b14; border:1px solid #f59e0b55; border-radius:8px; padding:8px 10px;">⏳ ${core.T(
          pendingEntry.legacy
            ? 'يوجد طلب اعتماد سابق غير محسوم النتيجة (قد يكون الخادم نفّذه). لا يمكن إعادة إرساله لأنه محفوظ بصيغة قديمة. اضغط «إيقاف التتبّع محليًا» بعد التحقق من سجل القرارات أعلاه (لا يُلغي الطلب على الخادم).'
            : 'يوجد طلب اعتماد سابق غير محسوم النتيجة (قد يكون الخادم نفّذه). لإعادة إرساله بنفس بياناته الأصلية حرفياً اختر القرار نفسه بنفس الأسباب والشروط ثم اضغط «تسجيل القرار». لا يُرسَل طلب جديد بدلاً منه تلقائياً. أو اضغط «إيقاف التتبّع محليًا» بعد التحقق من سجل القرارات أعلاه (لا يُلغي الطلب على الخادم).',
          pendingEntry.legacy
            ? 'A previous approval request has an unknown outcome (the server may have executed it). It cannot be re-sent because it was stored in an older format. Press "Stop tracking locally" after checking the decision history above (this does not cancel the request on the server).'
            : 'A previous approval request has an unknown outcome (the server may have executed it). To re-send it exactly as originally sent, choose the same decision with the same reasons and conditions and press "Record Decision". No new request replaces it automatically. Or press "Stop tracking locally" after checking the decision history above (this does not cancel the request on the server; the decision may already be recorded).')}
          <label style="display:block; margin-top:6px; font-size:11.5px;"><input type="checkbox" name="icDiscardAck"> ${core.T('أفهم أن هذا لا يُلغي الطلب على الخادم وأن القرار قد يكون سُجّل فعلًا','I understand this does not cancel the request on the server and the decision may already be recorded')}</label>
          <button type="button" class="btn btn-sm btn-ghost" data-action="ic-discard-pending" data-id="${oppId}" style="margin-top:6px;">⏹ ${core.T('إيقاف التتبّع محليًا','Stop tracking locally')}</button></div>`
      : '';
    const blockedBox = verdictBlocked
      ? `<div class="note" data-ic-verdict="red" style="margin:0 0 10px; color:var(--bad); background:#ef444411; border:1px solid #ef444433; border-radius:8px; padding:8px 10px;">🔴 ${core.T('الاعتماد محجوب: المدخلات غير صالحة أو غير مكتملة. صحّحها أولاً — لا يمكن تجاوز هذا الحجب.','Approval blocked: inputs are invalid or incomplete. Fix them first — this block cannot be overridden.')}</div>`
      : '';

    return `
    <div class="section">
      <h3>🏛️ ${core.T('لجنة الاستثمار','Investment Committee')} <span style="color:var(--ink-faint); font-weight:500; font-size:12px;">(IC Workflow)</span></h3>

      <div class="kv" style="margin-bottom:12px;">
        <div class="k">${core.T('جودة البيانات','Data Quality')}</div><div class="v">${dq.criticalMissing.length===0? `✅ ${core.T('مكتملة','Complete')}` : `<span style="color:var(--bad);">⚠️ ${dq.criticalMissing.length} ${core.T('مُدخل حرج مفقود','critical input(s) missing')}</span>`}</div>
        <div class="k">${core.T('العناية الواجبة','Due Diligence')}</div><div class="v">${dd.criticalPending===0? `✅ ${core.T('لا بنود حرجة معلّقة','No critical items pending')}` : `<span style="color:var(--bad);">⚠️ ${dd.criticalPending} ${core.T('بند حرج معلّق','critical item(s) pending')}</span>`} (${dd.completed}/${dd.total})</div>
        <div class="k">${core.T('الحالة الحالية','Current Decision')}</div><div class="v">${latest? `<span class="tag" style="background:${DEC_BY_KEY[latest.decision].color}22; color:${DEC_BY_KEY[latest.decision].color}; font-weight:700;">${core.T(DEC_BY_KEY[latest.decision].ar, DEC_BY_KEY[latest.decision].en)}</span>` : `<span class="tag">${core.T('لم يُتخَذ قرار بعد','No decision yet')}</span>`}</div>
      </div>
      ${!readinessOk? `<p class="note" style="color:var(--bad); margin:0 0 12px;">🚫 ${core.T('يُنصح بإكمال جودة البيانات والعناية الواجبة الحرجة قبل رفع الفرصة للجنة.','Recommended to complete critical data quality and due diligence items before IC submission.')}</p>` : ''}

      ${decisions.length? `
      <div style="display:flex; flex-direction:column; gap:10px; margin-bottom:${canEdit?'16px':'0'};">
        ${decisions.slice().reverse().map((dec, revIdx)=>{
          const idx = decisions.length-1-revIdx;
          const band = DEC_BY_KEY[dec.decision] || DEC_BY_KEY.hold;
          return `
          <div style="padding:12px; border:1px solid var(--border); border-radius:10px; ${idx===decisions.length-1?'background:var(--surface-2);':''}">
            <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px;">
              <span class="tag" style="background:${band.color}22; color:${band.color}; font-weight:700;">${core.T(band.ar,band.en)}</span>
              <span style="font-size:11px; color:var(--ink-faint);">${core.esc(dec.decidedBy||'')} · ${core.esc((dec.decidedAt||'').slice(0,16).replace('T',' '))}</span>
            </div>
            ${(dec.reasons&&dec.reasons.length)? `<ul style="margin:8px 0 0; padding-inline-start:20px;">${dec.reasons.map(r=>`<li style="font-size:12px; line-height:1.6;">${core.esc(r)}</li>`).join('')}</ul>` : ''}
            ${(dec.conditions&&dec.conditions.length)? `
            <div style="margin-top:8px;">
              <p style="font-size:11.5px; font-weight:700; margin:0 0 4px;">${core.T('الشروط','Conditions')}</p>
              <div style="display:flex; flex-direction:column; gap:4px;">
                ${dec.conditions.map((cond,ci)=>`
                <div style="display:flex; align-items:center; gap:6px; font-size:12px;" data-ic-condition="${idx}:${ci}">
                  ${canEdit && idx===decisions.length-1? `<input type="checkbox" ${cond.status==='met'?'checked':''} data-action="ic-toggle-condition" data-idx="${idx}" data-ci="${ci}" data-oppid="${oppId}">` : (cond.status==='met'? '✅' : '⬜')}
                  <span style="${cond.status==='met'?'text-decoration:line-through; color:var(--ink-faint);':''}">${core.esc(cond.text)}${cond.owner? ` — <b>${core.esc(cond.owner)}</b>`:''}${cond.dueDate? ` (${cond.dueDate})`:''}</span>
                </div>`).join('')}
              </div>
            </div>` : ''}
          </div>`;
        }).join('')}
      </div>` : ''}

      ${canApprove? `
      <div style="background:var(--surface-2); border:1px dashed var(--border); border-radius:10px; padding:12px;">
        <p class="step-sub" style="margin:0 0 4px;">${core.T('تسجيل قرار جديد للجنة الاستثمار','Record a new IC decision')}</p>
        <p class="note" style="margin:0 0 10px; font-size:11px;">${core.T('صلاحية الاعتماد تتطلب دور "عضو لجنة استثمار أول" فأعلى — مستقلة عن ملكية الفرصة.','Approval requires a Senior IC role or above — independent of who owns/edited this opportunity.')}</p>
        ${previewNote}${pendingBox}${blockedBox}
        ${!gate.ready? `<div class="note" style="margin:0 0 10px; color:var(--bad); background:#ef444411; border:1px solid #ef444433; border-radius:8px; padding:8px 10px;">
          🔴 ${core.T('بوابة الجهوزية (IC Decision Gate) غير مُستوفاة — الاعتماد أو الاعتماد بشروط يتطلب "تجاوز واعٍ" مع تبرير مكتوب أدناه.','IC Decision Gate not satisfied — approving requires an explicit override with a written justification below.')}
          ${gateReasonsHtml}
        </div>` : ''}
        <form data-ic-form="${oppId}" style="display:flex; flex-direction:column; gap:8px;">
          <select name="decision" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
            ${DECISIONS.map(dc=>`<option value="${dc.key}" style="background:var(--surface); color:var(--ink);">${core.T(dc.ar,dc.en)}</option>`).join('')}
          </select>
          <textarea name="reasons" rows="3" placeholder="${core.T('الأسباب — سطر لكل سبب','Reasons — one per line')}" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;"></textarea>
          <textarea name="conditions" rows="3" placeholder="${core.T('الشروط (اختياري) — سطر لكل شرط، مثال: تأكيد سعر الأرض ≤ ٢٠٠٠ ر.س/م²','Conditions (optional) — one per line')}" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;"></textarea>
          ${!gate.ready? `<label style="display:flex; align-items:flex-start; gap:6px; font-size:11.5px; color:var(--bad);">
            <input type="checkbox" name="override" style="margin-top:2px;">
            <span>${core.T('أؤكّد تجاوز بوابة الجهوزية عمداً وسأوضّح السبب في حقل الأسباب أعلاه (سيُسجَّل هذا التجاوز في سجل القرار).','I knowingly override the readiness gate and have explained why above (this override will be recorded on the decision).')}</span>
          </label>` : ''}
          ${needsAck? `<label data-ic-verdict="ack" style="display:flex; align-items:flex-start; gap:6px; font-size:11.5px; color:#b45309;">
            <input type="checkbox" name="ackWarnings" style="margin-top:2px;">
            <span>${core.T('تجتمع عدة مخاطر عالية (أصفر). أُقِرّ بأنني اطّلعت عليها وسأكتب مبرر قبولها في حقل الأسباب أعلاه (يُسجَّل الإقرار في سجل القرار).','Several high-risk conditions apply together (yellow). I acknowledge them and have written why they are accepted in the reasons field above (the acknowledgement is recorded on the decision).')}</span>
          </label>` : ''}
          <button type="button" class="btn btn-sm btn-primary" data-action="ic-decide" data-id="${oppId}">✅ ${core.T('تسجيل القرار','Record Decision')}</button>
        </form>
      </div>` : (canEdit? `<p class="note" style="margin-top:6px;">${core.T('يمكنك رفع الفرصة للجنة، لكن اتخاذ القرار (اعتماد/رفض/...) يتطلب دور "عضو لجنة استثمار أول" فأعلى.','You can submit this opportunity to the IC, but recording a decision requires a Senior IC role or above.')}</p>` : '')}
    </div>`;
  });

  core.registerActionHandler(async (action, el)=>{
    if(action==='ic-decide'){
      // إصلاح P0 #1: الاعتماد صلاحية دور (canApproveIC) لا صلاحية ownership
      // (canEditOpp) — محلل مالك للفرصة لا يمكنه اتخاذ قرارها حتى لو كان
      // "يُعدِّلها" بمعنى core.canEditOpp. القيد الحقيقي غير القابل للتجاوز
      // في firestore.rules (icOnlyChange) — هذا فقط يمنع المحاولة من الواجهة.
      if(!canApproveIC(core)) return true;
      const oppId = el.dataset.id;
      const form = document.querySelector(`form[data-ic-form="${oppId}"]`);
      if(!form) return true;
      const rec = core.opportunities.find(o=>o.id===oppId);
      if(!rec) return true;

      const decision = form.querySelector('[name="decision"]').value;
      const reasons = splitLines(form.querySelector('[name="reasons"]').value);
      const conditions = splitLines(form.querySelector('[name="conditions"]').value).map(text=>({ text, owner:'', dueDate:'', status:'pending' }));
      const overrideEl = form.querySelector('[name="override"]');
      const overrideChecked = !!(overrideEl && overrideEl.checked);
      const decidedBy = core.currentUser ? core.currentUser.email : (core.DEMO_MODE ? 'زائر تجريبي' : 'محلي');

      // 3A-3: طلب غامض معلَّق لهذا المستخدم/الفرصة؟ لا يُستبدل تلقائياً — إما إعادة الحمولة الأصلية حرفياً أو لا إرسال.
      let verbatimPayload = null;
      if(serverApprovalAvailable()){
        const pk0 = pendingIcRequestKey(decidedBy, oppId);
        const pend = pendingIcRequests.get(pk0);
        if(pend && pend.busy) return true;
        if(pend){
          const ackEl0 = form.querySelector('[name="ackWarnings"]');
          const res = resolveAmbiguousIcRequest(pend, { decision, reasons, conditions, override: overrideChecked, warningsAcknowledged: !!(ackEl0 && ackEl0.checked) });
          if(res.action !== 'resend'){
            alert(core.T(
              res.why === 'legacy'
                ? 'يوجد طلب اعتماد سابق غير محسوم النتيجة بصيغة قديمة لا يمكن إعادة إرسالها. تحقق من سجل القرارات ثم اضغط «إيقاف التتبّع محليًا».'
                : 'يوجد طلب اعتماد سابق غير محسوم النتيجة (قد يكون الخادم نفّذه). لم يُرسَل شيء. أعد اختيار القرار نفسه بنفس الأسباب والشروط لإعادة إرساله حرفياً، أو اضغط «إيقاف التتبّع محليًا» بعد التحقق من سجل القرارات (لا يُلغي الطلب على الخادم).',
              res.why === 'legacy'
                ? 'A previous approval request with an unknown outcome exists in an older format and cannot be re-sent. Check the decision history, then press "Stop tracking locally".'
                : 'A previous approval request has an unknown outcome (the server may have executed it). Nothing was sent. Choose the same decision with the same reasons and conditions to re-send it exactly, or press "Stop tracking locally" after checking the decision history (this does not cancel the request on the server).'));
            return true;
          }
          verbatimPayload = JSON.parse(JSON.stringify(pend.payload));
        }
      }

      const draft = core.withDefaults(rec.data);
      let overridden = false, gateReasonsAtDecision = [];
      if(APPROVAL_DECISIONS.includes(decision) && !verbatimPayload){
        // إصلاح P0 #2: اعتماد/اعتماد بشروط يتطلب بوابة جهوزية حقيقية —
        // لا "تسجيل قرار" حرّ. عدم الجهوزية بلا تجاوز صريح + تبرير مكتوب
        // يمنع الحفظ كلياً (بلا أي أثر جانبي).
        const gate = icReadiness(core, draft);
        if(!gate.ready){
          if(!overrideChecked || !reasons.length) return true;
          overridden = true;
          gateReasonsAtDecision = gate.reasons;
        }
      }

      // 3A-3: الأحمر (INVALID/INCOMPLETE) يحجب الاعتماد دائماً، والأصفر المركّب (≥ العتبة) يتطلب إقراراً مكتوباً،
      // والاعتماد مرتبط ببصمة الوثيقة التي راجعها المستخدم فعلاً. الخادم يُعيد كل هذه الفحوص ولا يثق بالواجهة.
      const ackEl = form.querySelector('[name="ackWarnings"]');
      const ackChecked = !!(ackEl && ackEl.checked);
      const approving = APPROVAL_DECISIONS.includes(decision);
      const serverPath = !!serverApprovalAvailable();
      let expectedDocHash;
      let warningsAcknowledged = false;
      if(approving && !verbatimPayload){
        let blockedNow, needsAckNow;
        if(serverPath){
          const pv = ensureApprovalPreview(oppId, rec);
          if(pv.status !== 'ready'){
            alert(pv.status === 'loading'
              ? core.T('معاينة الاعتماد قيد التحميل من الخادم. انتظر لحظات ثم أعد المحاولة.','The approval preview is still loading from the server. Wait a moment and try again.')
              : pv.status === 'stale'
              ? core.T('النسخة المعروضة تختلف عن نسخة الخادم. اضغط «تحديث المعاينة» وراجع البيانات ثم أعد المحاولة.','The displayed version differs from the server version. Press "Refresh preview", review the data, and try again.')
              : core.T('تعذّر تحميل معاينة الاعتماد؛ لا يمكن الاعتماد الآن.','Could not load the approval preview; approval is unavailable right now.'));
            return true;
          }
          // إعادة حساب بصمة النسخة المعروضة لحظة النقر: يجب أن تساوي بصمة المعاينة المقبولة، وإلا تُمنع الإرسالة.
          let clickHash = null;
          try{ clickHash = await documentHashHex(rec.data); }catch(e){ clickHash = null; }
          if(clickHash !== pv.docHash){
            approvalPreviews.delete(oppId);
            alert(core.T('تغيّرت بيانات الفرصة منذ تحميل المعاينة. لم يُرسَل شيء؛ تُحمَّل معاينة جديدة الآن — راجعها ثم أعد المحاولة.','The opportunity data changed since the preview loaded. Nothing was sent; a fresh preview is loading — review it and try again.'));
            core.render();
            return true;
          }
          blockedNow = !!pv.verdict.blocked;
          needsAckNow = !blockedNow && !!(pv.verdict.compound && pv.verdict.compound.requiresAcknowledgement);
          expectedDocHash = pv.docHash;
        }else{
          const lv = localVerdict(rec);
          blockedNow = !!lv.blocked;
          needsAckNow = !blockedNow && !!(lv.compound && lv.compound.requiresAcknowledgement);
        }
        if(blockedNow){
          alert(core.T('الاعتماد محجوب: المدخلات غير صالحة أو غير مكتملة (أحمر). صحّحها أولاً.','Approval blocked: inputs are invalid or incomplete (red). Fix them first.'));
          return true;
        }
        if(needsAckNow){
          if(!ackChecked || !reasons.length){
            alert(core.T('تجتمع عدة مخاطر عالية — الاعتماد يتطلب تفعيل خانة الإقرار وكتابة المبرر في حقل الأسباب.','Several high-risk conditions apply together — approval needs the acknowledgement box ticked and a written justification in the reasons field.'));
            return true;
          }
          warningsAcknowledged = true;
        }
      }

      // إصلاح P0 (توصية ٥ في docs/SECURITY_RULES_REVIEW.md): دالة approveOpportunity الخلفية
      // كانت مكتوبة ومُختبَرة (اختبار ٠٢٢) منذ المرحلة السابعة لكن غير مستخدَمة من أي واجهة —
      // كل الحراسات أعلاه (canApproveIC/icReadiness) كانت من جانب العميل فقط، قابلة للتجاوز
      // نظرياً من مستخدم يكتب على Firestore مباشرة. الآن، خارج وضع الديمو/التشغيل المحلي بلا
      // Firebase حقيقي (حيث لا توجد دالة خلفية أصلاً لتستدعيها)، القرار يُرسَل أولاً لدالة
      // approveOpportunity نفسها، التي تُعيد نفس فحص الجهوزية/الصلاحية داخل معاملة Firestore
      // حقيقية بصلاحيات Admin SDK وتكتب هي نفسها opportunities.ic.decisions وicDecisions معاً
      // بشكل ذرّي — فشل الخادم يمنع الحفظ كلياً بدل الاكتفاء بحظر واجهي قابل للتجاوز.
      // لا لمس لمنطق core.js الداخلي هنا: الاستدعاء عبر firebase.functions() العامة (مُهيَّأة
      // أصلاً من core.js نفسه عبر firebase.initializeApp) وليس عبر أي تعديل على core.js.
      const useServerFunction = serverPath;
      let decisionId = null;

      if(useServerFunction){
        // منع النقر المزدوج أثناء تنفيذ طلب سابق لنفس الفرصة — نقرة ثانية أثناء التنفيذ يجب ألا
        // تولّد requestId مختلفاً لنفس القرار (انظر التعليق أعلى pendingIcRequests). المفتاح الآن
        // يشمل المستخدم الفعلي (pendingIcRequestKey) — لا oppId وحده — ومحفوظ في localStorage
        // (ينجو من إعادة تحميل الصفحة)، لا في Map ذاكرة فقط.
        const pendingKey = pendingIcRequestKey(decidedBy, oppId);
        const inFlight = pendingIcRequests.get(pendingKey);
        if(inFlight && inFlight.busy) return true;

        // 3A-3: بعد نتيجة غامضة تُعاد الحمولة الأصلية حرفياً (نفس requestId ونفس expectedDocHash ونفس المحتوى)؛ لا طلب بديل تلقائياً.
        const payloadToSend = verbatimPayload || {
          oppId,
          // The server derives readiness and audit fields from its saved snapshot.
          decision: { decision },
          reasons, conditions, override: overrideChecked,
          warningsAcknowledged,
          ...(expectedDocHash ? { expectedDocHash } : {}),
          requestId: newIcRequestId(oppId),
        };
        const requestId = payloadToSend.requestId;
        const signature = icRequestPayloadSignature(oppId, payloadToSend.decision.decision, payloadToSend.reasons, payloadToSend.conditions, payloadToSend.override, payloadToSend.warningsAcknowledged, payloadToSend.expectedDocHash);

        // إصلاح على مراجعة ثالثة: لا نستدعي الخادم إطلاقاً إن تعذّر حفظ معرّف الطلب فعلياً محلياً —
        // إرسال الطلب بلا حفظ المعرّف يعيد فتح نفس الثغرة التي أُصلِحت في الجولة الثانية (ضياع
        // requestId عند إعادة التحميل بعد نتيجة غامضة، مع احتمال تسجيل قرار إضافي).
        if(!reservePendingIcRequest(pendingIcRequests, pendingKey, requestId, signature, payloadToSend)){
          alert(core.T(
            'تعذّر حفظ حالة الطلب محلياً، لذلك لم يُرسَل القرار للخادم. يرجى المحاولة مرة أخرى.',
            'Could not save the request state locally, so the decision was not sent to the server. Please try again.'
          ));
          return true;
        }

        try{
          const callable = firebase.functions().httpsCallable('approveOpportunity');
          const resp = await callable(JSON.parse(JSON.stringify(payloadToSend)));
          decisionId = resp && resp.data ? resp.data.decisionId : null;
          // نتيجة نهائية (نجاح) — أي محاولة تالية على هذه الفرصة قرار جديد بمعرّف جديد.
          pendingIcRequests.delete(pendingKey);
          persistPendingIcRequests(pendingIcRequests);
          approvalPreviews.delete(oppId); // المستند تغيّر بالقرار نفسه — معاينة جديدة للقرار التالي
        }catch(err){
          // توحيد الرمز قبل أي مقارنة (انظر تعليق normalizeFunctionsErrorCode أعلى الملف) — يطابق
          // الآن "permission-denied" و"functions/permission-denied" معاً بلا تمييز.
          const code = normalizeFunctionsErrorCode(err && err.code);
          const stillPending = pendingIcRequests.get(pendingKey);
          if(stillPending) stillPending.busy = false;
          if(code && IC_REQUEST_DEFINITIVE_ERROR_CODES.has(code)){
            // رفض نهائي (بيانات غير صالحة/صلاحية/فرصة غير موجودة/شرط غير مستوفى/تكرار بحمولة
            // مختلفة) — الخادم لم يكتب شيئاً؛ أي محاولة تالية قرار جديد بمعرّف جديد.
            pendingIcRequests.delete(pendingKey);
          }
          // سواء بقي الإدخال (غامض، busy:false) أو حُذف (رفض نهائي) — يجب أن تنعكس الحالة في
          // localStorage فوراً، لا أن تبقى محفوظة فقط في الذاكرة حتى الطلب التالي.
          persistPendingIcRequests(pendingIcRequests);
          // أي شيء آخر (انقطاع شبكة، انتهاء مهلة، الخادم غير متاح، خطأ داخلي...) نتيجة **غامضة**:
          // لا نعرف إن كان الخادم نفَّذ الطلب فعلاً أم لا. لذلك لا نولّد معرّفاً جديداً هنا مهما
          // حدث — إعادة المحاولة بنفس القرار بالضبط يجب أن تُعيد استخدام requestId نفسه (محفوظ
          // أعلاه في stillPending) حتى تتعرّف آلية الاستبدال المتماثل (idempotent replay) في
          // الخادم على الطلب كأنه نفس الطلب لا طلباً تنافسياً جديداً.
          const rejCode = err && err.details && err.details.rejectionCode;
          if(rejCode === 'DOC_CHANGED' || rejCode === 'INPUTS_BLOCKED') approvalPreviews.delete(oppId); // معاينة جديدة إجبارية
          alert((approvalRejectionMessage(core, err)) || (core.T('تعذّر اعتماد القرار عبر الخادم: ','Server could not record the decision: ') + (err && err.message ? err.message : String(err))));
          if(rejCode === 'DOC_CHANGED' || rejCode === 'INPUTS_BLOCKED') core.render();
          return true;
        }
        await core.loadAll();
        // Phase 2R-4E: سجل v4 (underwritingVersions) لم يعد يُكتَب من العميل هنا إطلاقاً — أصبح
        // يُكتَب من approveOpportunity نفسها (functions/index.js) داخل نفس المعاملة الموثوقة على
        // الخادم التي تكتب icDecisions، فتُضمَن الذرّية بينهما ومصدر بياناته الحقيقي (evaluated
        // audit) لا تخمين العميل لما حسبه الخادم.
        core.render();
        return true;
      }

      if(!core.DEMO_MODE && core.DB){
        // مشروع Firebase حقيقي (لا وضع ديمو) لكن الدالة الخلفية غير متاحة من هذا العميل (SDK
        // functions غير محمَّل، أو firebase غير معرَّف) — منذ هذه المرحلة لا يوجد مسار كتابة
        // مباشر من العميل بديل أصلاً (firestore.rules تغلق opportunities.ic وicDecisions
        // وunderwritingVersions.v4_ic_approved كلها على أي كتابة عميل)، فالمحاولة القديمة كانت
        // ستفشل بصمت نسبي (permission-denied غامض). الأوضح للمستخدم رفض صريح الآن بدل محاولة
        // محكوم عليها بالفشل.
        alert(core.T(
          'تعذّر الوصول إلى دالة اعتماد القرار على الخادم. تأكد من نشر Cloud Functions (راجع functions/README.md) ثم أعد المحاولة.',
          'Could not reach the server-side decision function. Make sure Cloud Functions is deployed (see functions/README.md) and try again.'
        ));
        return true;
      }

      // مسار احتياطي (وضع الديمو، أو تشغيل محلي بلا Firebase حقيقي أصلاً): لا دالة خلفية
      // لاستدعائها، فيبقى المسار القديم من جانب العميل فقط كما كان قبل هذا الإصلاح.
      draft.ic.decisions = (draft.ic.decisions||[]).concat([{
        decision, reasons, conditions, decidedBy, decidedAt: new Date().toISOString(),
        overridden, gateReasonsAtDecision, warningsAcknowledged,
      }]);
      draft.meta.updatedAt = core.todayStr();
      draft.meta.updatedBy = decidedBy;

      const saved = await core.persistOpportunity({ id: oppId, data: draft });
      if(saved && core.persistIfRecord){
        const latestDecision = draft.ic.decisions[draft.ic.decisions.length-1];
        const decisionRecord = { id: core.uid('ICD'), data: {
          oppId, decision: JSON.parse(JSON.stringify(draft.ic.decisions[draft.ic.decisions.length-1])),
          recordedAt: new Date().toISOString(), recordedBy: decidedBy,
          source:'opportunity.ic.decisions', version:1,
        }};
        await core.persistIfRecord('icDecisions', decisionRecord);
        if(APPROVAL_DECISIONS.includes(latestDecision.decision)){
          await core.persistIfRecord(
            'underwritingVersions',
            buildUnderwritingVersionRecord(core, oppId, draft, 'v4_ic_approved', 'ic_decision', decisionRecord.id)
          );
        }
      }
      await core.loadAll();
      core.render();
      return true;
    }
    if(action==='ic-refresh-preview'){
      if(!canApproveIC(core)) return true;
      approvalPreviews.delete(el.dataset.id);
      core.render();
      return true;
    }
    if(action==='ic-discard-pending'){
      // 3A-3: إيقاف التتبّع المحلي فقط، بقرار صريح من المستخدم (لا تلقائياً). لا يُلغي شيئاً على الخادم، وقد يكون القرار سُجّل فعلاً.
      if(!canApproveIC(core)) return true;
      const oppId0 = el.dataset.id;
      const key0 = pendingIcRequestKey(core.currentUser ? core.currentUser.email : null, oppId0);
      const ent0 = pendingIcRequests.get(key0);
      if(ent0 && ent0.busy){
        alert(core.T('الطلب قيد الإرسال الآن؛ لا يمكن إيقاف تتبّعه حتى تنتهي المحاولة.','The request is being sent right now; it cannot be dropped until the attempt finishes.'));
        return true;
      }
      const box0 = el.closest ? el.closest('[data-ic-pending]') : null;
      const ack0 = box0 && box0.querySelector ? box0.querySelector('[name="icDiscardAck"]') : null;
      if(!(ack0 && ack0.checked)){
        alert(core.T('فعّل خانة الإقرار أولاً: إيقاف التتبّع المحلي لا يُلغي الطلب على الخادم وقد يكون القرار سُجّل.','Tick the acknowledgement first: dropping local tracking does not cancel the request on the server and the decision may already be recorded.'));
        return true;
      }
      pendingIcRequests.delete(key0);
      persistPendingIcRequests(pendingIcRequests);
      approvalPreviews.delete(oppId0);
      core.render();
      return true;
    }
    if(action==='ic-toggle-condition'){
      const oppId = el.dataset.oppid;
      const idx = Number(el.dataset.idx);
      const ci = Number(el.dataset.ci);
      const rec = core.opportunities.find(o=>o.id===oppId);
      if(!rec || !core.canEditOpp(rec)) return true;

      // P0 — Trusted Transaction Layer: opportunity.ic لم يعد قابلاً للكتابة من العميل مباشرة
      // بأي مسار (لا icOnlyChange سابقاً، ولا حتى مسار "المالك العادي" ownsOpp — انظر
      // firestore.rules). updateIcConditionStatus (functions/index.js) تُطابق حرفياً نفس صلاحية
      // core.canEditOpp أعلاه (المالك أو الأدمن) لكن مُنفَّذة على الخادم بصلاحيات Admin SDK.
      const useServerFunction = !core.DEMO_MODE && core.DB && typeof firebase!=='undefined' && firebase.functions;
      if(useServerFunction){
        try{
          await firebase.functions().httpsCallable('updateIcConditionStatus')({ oppId, decisionIdx: idx, conditionIdx: ci });
        }catch(err){
          alert(core.T('تعذّر تحديث حالة الشرط عبر الخادم: ','Server could not update the condition status: ') + (err && err.message ? err.message : String(err)));
          return true;
        }
        await core.loadAll();
        core.render();
        return true;
      }

      // مسار احتياطي (وضع الديمو، أو تشغيل محلي بلا Firebase حقيقي أصلاً): لا دالة خلفية
      // لاستدعائها، فيبقى المسار القديم من جانب العميل فقط كما كان قبل هذا الإصلاح.
      const draft = core.withDefaults(rec.data);
      const dec = draft.ic.decisions && draft.ic.decisions[idx];
      if(dec && dec.conditions && dec.conditions[ci]){
        dec.conditions[ci].status = (dec.conditions[ci].status==='met') ? 'pending' : 'met';
      }
      draft.meta.updatedAt = core.todayStr();
      draft.meta.updatedBy = core.currentUser ? core.currentUser.email : (draft.meta.updatedBy||null);

      await core.persistOpportunity({ id: oppId, data: draft });
      await core.loadAll();
      core.render();
      return true;
    }
    return false;
  });
}
