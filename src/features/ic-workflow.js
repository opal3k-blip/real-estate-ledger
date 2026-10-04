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
import { ddStats, defaultItemsDict as ddDefaultItemsDict } from './due-diligence.js';
import { canApproveIC } from './roles-permissions.js';
import { buildUnderwritingVersionRecord } from './underwriting-versions.js?v=20260913-stage7b';
import { icReadiness } from './ic-decision-gate.js';

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
export function reservePendingIcRequest(pendingIcRequests, pendingKey, requestId, signature){
  const previousEntry = pendingIcRequests.get(pendingKey); // الحالة قبل هذا الحجز — للاستعادة الدقيقة إن فشل الحفظ
  pendingIcRequests.set(pendingKey, { requestId, signature, busy: true });
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
function icRequestPayloadSignature(oppId, decision, reasons, conditions, override){
  return JSON.stringify({ oppId, decision, reasons, conditions, override: !!override });
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

      const draft = core.withDefaults(rec.data);
      let overridden = false, gateReasonsAtDecision = [];
      if(APPROVAL_DECISIONS.includes(decision)){
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
      const useServerFunction = !core.DEMO_MODE && core.DB && typeof firebase!=='undefined' && firebase.functions;
      let decisionId = null;

      if(useServerFunction){
        // منع النقر المزدوج أثناء تنفيذ طلب سابق لنفس الفرصة — نقرة ثانية أثناء التنفيذ يجب ألا
        // تولّد requestId مختلفاً لنفس القرار (انظر التعليق أعلى pendingIcRequests). المفتاح الآن
        // يشمل المستخدم الفعلي (pendingIcRequestKey) — لا oppId وحده — ومحفوظ في localStorage
        // (ينجو من إعادة تحميل الصفحة)، لا في Map ذاكرة فقط.
        const pendingKey = pendingIcRequestKey(decidedBy, oppId);
        const inFlight = pendingIcRequests.get(pendingKey);
        if(inFlight && inFlight.busy) return true;

        const signature = icRequestPayloadSignature(oppId, decision, reasons, conditions, overrideChecked);
        const requestId = (inFlight && inFlight.signature === signature)
          ? inFlight.requestId // إعادة إرسال الطلب نفسه بالضبط بعد نتيجة غامضة سابقاً — نفس المعرّف
          : newIcRequestId(oppId); // قرار جديد فعلاً (أول مرة، أو تغيّرت حمولته) — معرّف جديد

        // إصلاح على مراجعة ثالثة: لا نستدعي الخادم إطلاقاً إن تعذّر حفظ معرّف الطلب فعلياً محلياً —
        // إرسال الطلب بلا حفظ المعرّف يعيد فتح نفس الثغرة التي أُصلِحت في الجولة الثانية (ضياع
        // requestId عند إعادة التحميل بعد نتيجة غامضة، مع احتمال تسجيل قرار إضافي).
        if(!reservePendingIcRequest(pendingIcRequests, pendingKey, requestId, signature)){
          alert(core.T(
            'تعذّر حفظ حالة الطلب محلياً، لذلك لم يُرسَل القرار للخادم. يرجى المحاولة مرة أخرى.',
            'Could not save the request state locally, so the decision was not sent to the server. Please try again.'
          ));
          return true;
        }

        try{
          const callable = firebase.functions().httpsCallable('approveOpportunity');
          const resp = await callable({
            oppId,
            // The server derives readiness and audit fields from its saved snapshot.
            decision: { decision },
            reasons, conditions, override: overrideChecked,
            requestId,
          });
          decisionId = resp && resp.data ? resp.data.decisionId : null;
          // نتيجة نهائية (نجاح) — أي محاولة تالية على هذه الفرصة قرار جديد بمعرّف جديد.
          pendingIcRequests.delete(pendingKey);
          persistPendingIcRequests(pendingIcRequests);
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
          alert(core.T('تعذّر اعتماد القرار عبر الخادم: ','Server could not record the decision: ') + (err && err.message ? err.message : String(err)));
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
        overridden, gateReasonsAtDecision,
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
