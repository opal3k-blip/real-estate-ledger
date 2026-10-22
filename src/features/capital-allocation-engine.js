/* =========================================================================
   محرك ربط رأس المال — Capital Allocation Linking Engine (المرحلة الخامسة)
   ---------------------------------------------------------------------------
   الفجوة التي رصدتها المرحلة الرابعة (Full Institutional Validation، بالتحقق الحي لا
   بالافتراض): الحلقة "IC → Conditions → Allocation → Fund Ledger → Reporting" كانت ثلاثة
   نماذج بيانات منفصلة تماماً بلا أي رابط فعلي بينها:
     • capitalAllocation (targetEquity/maxAllocation/priority/committeeNote) — حقل مخطط
       أضافته institutional-hardening.js (المرحلة الثانية) "لمحرك تخصيص مستقبلي"، لكن بلا أي
       واجهة تحرير في أي مكان وبلا أي كود يقرأه سوى هذا الملف الآن.
     • ربط فرصة كأصل لصندوق (fund.data.assetIds، عبر زر if-toggle-asset المدمج في core.js)
       كان مفتوحاً بلا أي شرط — يقدر أي مدير صندوق يربط أي فرصة (حتى لو لم تُعتمَد من اللجنة
       بعد، أو اعتماد بشروط لم تُستوفَ) بصندوقه، فتدخل في حساب RVPI/TVPI فوراً.
     • دفتر الصندوق (commitments/capitalCalls) لا علاقة له بأي مما سبق — يدخله مدير الصندوق
       يدوياً بمعزل تام عن قرار اللجنة.

   هذا الملف يبني الحلقة الفعلية بلا لمس منطق core.js الداخلي (نقطتا التوسّع الوحيدتان
   المُضافتان لـcore.js — registerAssetLinkGuard وتعليق منطق if-toggle-asset بها — عامّتان
   ومُعاد استخدامهما، لا منطق حجب مكتوب داخل core.js نفسه):

     ١) واجهة تحرير فعلية لـcapitalAllocation (كانت معدومة تماماً) — لمدير الصندوق فأعلى فقط
        (نفس مستوى الحماية في firestore.rules أدناه)، مع قسم تفصيلي يعرض حالة اعتماد اللجنة
        وحالة الربط بأي صندوق.
     ٢) بوابة ربط حقيقية (registerAssetLinkGuard) تُستشار قبل أي ربط فرصة↔صندوق: تمنع الربط
        إلا إذا (أ) قرار اللجنة "اعتماد" أو "اعتماد بشروط" مع استيفاء كل الشروط، (ب) تخصيص رأس
        مال مُحدَّد (targetEquity > 0)، (ج) رأس المال المطلوب + المخصَّص فعلاً لأصول أخرى في نفس
        الصندوق لا يتجاوز رأس المال المسدَّد فعلياً (paidIn) للصندوق — حارس سعة رأسمالية حقيقي،
        لا مجرد واجهة تجميلية.
     ٣) عند نجاح الربط: core.js نفسه (لا هذا الملف) يسجّل حركة تدقيق (assetLink) في مجموعة
        transactions المُصدَّرة أصلاً في تقرير سجل التدقيق (Excel) — هذا يُغلق "Allocation →
        Reporting" دون أي تعديل على منطق التصدير نفسه.

   ما تعمّدنا عدم بنائه هنا (نطاق مُعلَن، لا نقص غير موثَّق): إعادة بناء دفتر الصندوق نفسه إلى
   سجل محاسبي posted/locked/reversal حقيقي — تلك فجوة منفصلة وأعمق وثّقها تقرير المرحلة الثانية
   ("Fund ledger still requires a full posted/locked/reversal accounting subledger") ولم يطلبها
   هذا التكليف؛ الربط هنا يستهلك commitments/capitalCalls كما هي دون تغيير سلوكها.
   ========================================================================= */
import { canManageLibraries } from './roles-permissions.js';

const PRIORITY_OPTIONS = [['⚪ منخفضة','low'],['🔵 عادية','normal'],['🟡 مرتفعة','high'],['🔴 عاجلة','urgent']];
const PRIORITY_LABEL = Object.fromEntries(PRIORITY_OPTIONS.map(([l,v])=>[v,l]));

/* حالة اعتماد اللجنة بالنسبة لهذه الفرصة — يقرأ فقط d.ic.decisions (لا يُعدِّل شيئاً).
   يُرجع {approved, reason:{ar,en}}. "اعتماد بشروط" لا يُعتبَر approved إلا إذا كل شرط status
   فيه 'met' — بالضبط الانتقال المفقود "Conditions → Allocation" الذي رصدته المرحلة الرابعة. */
function icApprovalStatus(d){
  const decisions = (d.ic && d.ic.decisions) || [];
  const latest = decisions.length? decisions[decisions.length-1] : null;
  if(!latest) return { approved:false, reason:{ ar:'لا يوجد قرار لجنة استثمار بعد.', en:'No IC decision recorded yet.' } };
  if(latest.decision==='reject' || latest.decision==='hold') return { approved:false, reason:{ ar:'آخر قرار للجنة ليس اعتماداً.', en:'Latest IC decision is not an approval.' } };
  if(latest.decision==='approve') return { approved:true, reason:null };
  if(latest.decision==='approve_conditions'){
    const conds = latest.conditions||[];
    const pending = conds.filter(c=>c.status!=='met');
    if(pending.length===0) return { approved:true, reason:null };
    return { approved:false, reason:{
      ar:`${pending.length} شرط لم يُستوفَ بعد من "اعتماد بشروط" (${pending.map(c=>c.text).join(' · ')}).`,
      en:`${pending.length} condition(s) from "Approve with Conditions" are still pending (${pending.map(c=>c.text).join(' · ')}).`,
    } };
  }
  return { approved:false, reason:{ ar:'حالة قرار اللجنة غير معروفة.', en:'Unrecognized IC decision state.' } };
}

/* رأس المال المخصَّص فعلياً بالفعل لأصول أخرى (غير هذه الفرصة) داخل نفس الصندوق —
   مجموع capitalAllocation.targetEquity لكل فرصة مربوطة حالياً في fund.data.assetIds. */
// المساهمة العينية المُنفَّذة والمخصَّصة صراحةً لأصل بعينه — نظير earmarkedInKindForAssetTx في
// functions/index.js، بنفس الحقول (fundId/inKindAssetId/status) ونفس منطق الجمع (نداء عكسي بنفس
// inKindAssetId ومبلغ سالب يُصفِّر التغطية تلقائياً عبر الجمع الجبري، دون أي فلترة خاصة بالعكس).
function earmarkedInKindForAsset(core, fundId, oppId){
  return (core.STORE && core.STORE.capitalCalls || []).reduce((sum,cc)=>{
    const d = cc.data||{};
    if(d.fundId===fundId && d.inKindAssetId===oppId && d.status==='paid') return sum + core.n(d.amount);
    return sum;
  }, 0);
}

/* رأس المال المخصَّص فعلياً بالفعل لأصول أخرى (غير هذه الفرصة) داخل نفس الصندوق —
   مجموع capitalAllocation.targetEquity لكل فرصة مربوطة حالياً في fund.data.assetIds. */
function allocatedElsewhereInFund(core, fund, excludeOppId){
  const ids = (fund.data.assetIds||[]).filter(id=>id!==excludeOppId);
  return ids.reduce((sum,id)=>{
    const rec = core.opportunities.find(o=>o.id===id);
    const targetEquity = rec && rec.data.capitalAllocation ? core.n(rec.data.capitalAllocation.targetEquity) : 0;
    // Phase 2R-4D4-C (land-first, two-asset correction — يطابق إصلاح allocatedElsewhereTx في
    // functions/index.js): يُخصَم من مجمع النقد المشترك الجزء النقدي فقط من تخصيص هذا الأصل
    // الآخر (التخصيص المستهدف ناقص تغطيته العينية المنفَّذة والمؤهَّلة، محصوراً بصفر) — تغطيته
    // العينية/الأرض لم تستهلك نقداً قط ويجب ألا تُخصَم من النقد مرتين عند تقييم أصل مختلف.
    const inKind = earmarkedInKindForAsset(core, fund.id, id);
    return sum + Math.max(0, targetEquity - inKind);
  }, 0);
}

function deployableCashForFund(core, fund, excludeOppId){
  // Phase 2R-4D4-C (land-first correction): كان هذا يستخدم summary.paidIn (يشمل نداءات
  // رأس مال مرتبطة بمساهمة عينية/أرض عبر linkedCommitmentId) — يعني عملياً أن قيمة الأرض
  // كانت تُحتسَب كنقد قابل للتخصيص لأصل *آخر* غير الذي أُنشئت له، وهو بالضبط ما يمنعه مبدأ
  // "الأرض أولًا": مساهمة عينية لا تصبح نقداً عاماً قابلاً للإنفاق. الإصلاح: استخدام
  // summary.cashPaidIn (نفس الاستبعاد المطبَّق فعلياً في src/core.js's fundLedgerSummary
  // لحساب deployableCash على مستوى الصندوق، وفي functions/index.js's linkAssetToFund على
  // مستوى الخادم) بدل summary.paidIn. هذا الملف كُتب (المرحلة الخامسة) قبل إدخال التمييز
  // نقدي/عيني (المرحلة 2R-4D4-B) ولم يُحدَّث معه — الفجوة لم تكن مقصودة.
  const summary = core.fundLedgerSummary(fund.id);
  const allocated = allocatedElsewhereInFund(core, fund, excludeOppId);
  // Phase 2R-4D4-C (توافق الخادم/الواجهة): يطابق functions/index.js's linkAssetToFund تماماً —
  // التغطية العينية المنفَّذة والمؤهَّلة الخاصة بهذا الأصل نفسه تُغطّي تخصيصه المستهدف دون أن
  // تُعامَل كنقد عام أو تحتاجه. قبل هذا لم تكن بوابة الواجهة تطبّق هذا الاستثناء إطلاقاً (فقط
  // الخادم كان يطبّقه) — ما يعني حجب رابط أصل مموَّل عينياً بالكامل في الواجهة رغم أن الخادم كان
  // سيسمح به فعلاً.
  const earmarkedForThisAsset = earmarkedInKindForAsset(core, fund.id, excludeOppId);
  return Math.max(0, core.n(summary.cashPaidIn) - core.n(summary.distPaid) - allocated) + earmarkedForThisAsset;
}

export function registerCapitalAllocationEngine(core){
  core.registerAssetLinkGuard((fund, oppId)=>{
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec) return { blocked:true, reason: core.T('الفرصة غير موجودة.','Opportunity not found.') };
    const d = core.withDefaults(rec.data);

    const ic = icApprovalStatus(d);
    if(!ic.approved){
      return { blocked:true, reason: core.T(`🔒 لا يمكن ربط هذه الفرصة بالصندوق قبل اعتماد اللجنة: ${ic.reason.ar}`,`🔒 Cannot link this opportunity before IC approval: ${ic.reason.en}`) };
    }

    const targetEquity = core.n(d.capitalAllocation && d.capitalAllocation.targetEquity);
    if(!(targetEquity > 0)){
      return { blocked:true, reason: core.T('🔒 حدِّد "تخصيص رأس المال المستهدف" لهذه الفرصة أولاً (قسم محرك ربط رأس المال) قبل ربطها بأي صندوق.','🔒 Set a "Target Equity Allocation" for this opportunity first (Capital Allocation Engine section) before linking it to any fund.') };
    }
    const maxAllocation = core.n(d.capitalAllocation && d.capitalAllocation.maxAllocation);
    if(maxAllocation>0 && targetEquity > maxAllocation + 1e-6){
      return { blocked:true, reason: core.T(
        `🔒 التخصيص المستهدف ${core.fmtSAR(targetEquity)} يتجاوز الحد الأقصى المعتمد ${core.fmtSAR(maxAllocation)} لهذه الفرصة.`,
        `🔒 Target allocation ${core.fmtSAR(targetEquity)} exceeds the approved maximum allocation ${core.fmtSAR(maxAllocation)} for this opportunity.`
      ) };
    }

    const summary = core.fundLedgerSummary(fund.id);
    const avail = deployableCashForFund(core, fund, oppId);
    if(targetEquity > avail + 1e-6){
      const already = allocatedElsewhereInFund(core, fund, oppId);
      const paidIn = core.n(summary.paidIn);
      const distPaid = core.n(summary.distPaid);
      return { blocked:true, reason: core.T(
        `🔒 سعة الصندوق غير كافية: رأس المال المسدَّد ${core.fmtSAR(paidIn)}، التوزيعات المدفوعة ${core.fmtSAR(distPaid)}، والمخصص لأصول أخرى ${core.fmtSAR(already)}؛ النقد القابل للتخصيص ${core.fmtSAR(avail)} فقط — أقل من ${core.fmtSAR(targetEquity)}.`,
        `🔒 Insufficient fund capacity: paid-in ${core.fmtSAR(paidIn)}, paid distributions ${core.fmtSAR(distPaid)}, allocated to other assets ${core.fmtSAR(already)}; deployable cash is only ${core.fmtSAR(avail)} — below ${core.fmtSAR(targetEquity)}.`
      ) };
    }
    return { blocked:false };
  });

  core.registerDetailSection((d,c)=>{
    const oppId = core.openDetailId;
    const canManage = canManageLibraries(core); // مدير صندوق فأعلى — نفس مستوى capitalAllocationOnlyChange في firestore.rules
    const alloc = d.capitalAllocation || { targetEquity:null, maxAllocation:null, priority:'normal', committeeNote:'' };
    const ic = icApprovalStatus(d);
    const linkedFunds = (core.STORE?.funds||[]).filter(f=>(f.data.assetIds||[]).includes(oppId));

    const readOnlyRow = (label,labelEn,val)=>`<div class="k">${core.T(label,labelEn)}</div><div class="v">${val}</div>`;

    const form = canManage ? `
      <form data-cae-form="${oppId}" style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px; margin-top:10px;">
        <div class="field"><label><span>${core.T('تخصيص رأس المال المستهدف','Target Equity Allocation')}</span></label><input type="number" name="targetEquity" value="${alloc.targetEquity==null?'':alloc.targetEquity}" placeholder="SAR"></div>
        <div class="field"><label><span>${core.T('الحد الأقصى للتخصيص','Max Allocation')}</span></label><input type="number" name="maxAllocation" value="${alloc.maxAllocation==null?'':alloc.maxAllocation}" placeholder="SAR"></div>
        <div class="field"><label><span>${core.T('الأولوية','Priority')}</span></label>
          <select name="priority">${PRIORITY_OPTIONS.map(([l,v])=>`<option value="${v}" ${alloc.priority===v?'selected':''}>${l}</option>`).join('')}</select>
        </div>
        <div class="field span2"><label><span>${core.T('ملاحظة اللجنة/مدير الصندوق','Committee/Fund Manager Note')}</span></label><textarea name="committeeNote" rows="2">${core.esc(alloc.committeeNote||'')}</textarea></div>
        <div style="grid-column:1/-1;"><button type="button" class="btn btn-primary btn-sm" data-action="cae-save" data-id="${oppId}">💾 ${core.T('حفظ التخصيص','Save Allocation')}</button></div>
      </form>` : '';

    return `<div class="section">
      <h3>🔗 ${core.T('محرك ربط رأس المال — المرحلة الخامسة','Capital Allocation Linking Engine — Stage 5')}</h3>
      <div class="kv">
        ${readOnlyRow('حالة اعتماد اللجنة','IC Approval Status', ic.approved? `✅ ${core.T('مُعتمَدة — يمكن التخصيص/الربط','Approved — eligible for allocation/linking')}` : `<span style="color:var(--bad);">🔴 ${core.esc(core.T(ic.reason.ar, ic.reason.en))}</span>`)}
        ${readOnlyRow('تخصيص رأس المال المستهدف','Target Equity Allocation', alloc.targetEquity? core.fmtSAR(alloc.targetEquity) : '—')}
        ${readOnlyRow('الحد الأقصى للتخصيص','Max Allocation', alloc.maxAllocation? core.fmtSAR(alloc.maxAllocation) : '—')}
        ${readOnlyRow('الأولوية','Priority', PRIORITY_LABEL[alloc.priority]||alloc.priority||'—')}
        ${readOnlyRow('الربط بصندوق','Fund Linkage', linkedFunds.length? linkedFunds.map(f=>core.esc(f.data.name||f.id)).join(' · ') : core.T('غير مربوطة بأي صندوق بعد','Not linked to any fund yet'))}
      </div>
      ${alloc.committeeNote? `<p class="note" style="margin-top:6px;">📝 ${core.esc(alloc.committeeNote)}</p>` : ''}
      ${form}
      ${!canManage? `<p class="note" style="margin-top:10px;">${core.T('تخصيص رأس المال قرار مدير الصندوق فأعلى — لا يملكه مالك الفرصة نفسه (مفروض أيضاً في Firestore Rules، لا الواجهة فقط).','Capital allocation is a Fund Manager+ decision — not available to the opportunity owner themselves (enforced in Firestore Rules, not just the UI).') }</p>` : ''}
      <p class="note" style="margin-top:6px;">${core.T('الربط الفعلي بصندوق يتم من صفحة الصندوق نفسه (زر "ربط كأصل") — بوابة الأهلية أعلاه (اعتماد اللجنة + سعة رأسمالية كافية) تُطبَّق تلقائياً هناك، لا حاجة لتكرارها هنا.','Actually linking to a fund happens from the fund\'s own page ("link as asset"). The eligibility gate above (IC approval + sufficient fund capacity) is enforced automatically there — no need to repeat it here.')}</p>
    </div>`;
  });

  core.registerActionHandler(async (action, el)=>{
    if(action!=='cae-save') return false;
    if(!canManageLibraries(core)) return true; // صامت — الحماية الحقيقية في Firestore Rules، هذا فقط يمنع محاولة الواجهة
    const oppId = el.dataset.id;
    const form = document.querySelector(`form[data-cae-form="${oppId}"]`);
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!form || !rec) return true;

    const draft = core.withDefaults(rec.data);
    draft.capitalAllocation = {
      targetEquity: core.n(form.querySelector('[name="targetEquity"]').value, null),
      maxAllocation: core.n(form.querySelector('[name="maxAllocation"]').value, null),
      priority: form.querySelector('[name="priority"]').value,
      committeeNote: form.querySelector('[name="committeeNote"]').value,
    };
    const actor = core.currentUser ? core.currentUser.email : (core.DEMO_MODE ? 'زائر تجريبي' : 'محلي');
    draft.meta.updatedAt = core.todayStr();
    draft.meta.updatedBy = actor;

    await core.persistOpportunity({ id: oppId, data: draft });
    await core.loadAll();
    core.render();
    return true;
  });
}
