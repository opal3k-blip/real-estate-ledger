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
        try{
          const callable = firebase.functions().httpsCallable('approveOpportunity');
          const resp = await callable({
            oppId,
            // The server derives readiness and audit fields from its saved snapshot.
            decision: { decision },
            reasons, conditions, override: overrideChecked,
          });
          decisionId = resp && resp.data ? resp.data.decisionId : null;
        }catch(err){
          alert(core.T('تعذّر اعتماد القرار عبر الخادم: ','Server could not record the decision: ') + (err && err.message ? err.message : String(err)));
          return true;
        }
        await core.loadAll();
        const freshRec = core.opportunities.find(o=>o.id===oppId);
        if(freshRec && APPROVAL_DECISIONS.includes(decision) && decisionId && core.persistIfRecord){
          await core.persistIfRecord(
            'underwritingVersions',
            buildUnderwritingVersionRecord(core, oppId, core.withDefaults(freshRec.data), 'v4_ic_approved', 'ic_decision', decisionId)
          );
          await core.loadAll();
        }
        core.render();
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
