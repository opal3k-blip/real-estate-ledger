/* =========================================================================
   التسعير الموثَّق بالإصدارات — Versioned Underwriting (المرحلة السابعة،
   P0 #7 — "أهم إضافة استراتيجية")
   ---------------------------------------------------------------------------
   "هل تغيرت الصفقة أم تغيّر افتراضنا؟" — لا جواب لهذا السؤال بلا لقطات مؤرَّخة
   للأرقام الرئيسية عند لحظات حاسمة: عند كل قرار لجنة استثمار جديد (تلقائياً)،
   أو يدوياً في أي وقت (مثلاً بعد نتيجة عناية واجبة، أو عرض بائع مضاد). كل نسخة
   (Version) تُخزَّن *كأرقام ثابتة وقت الحفظ*، لا كصيغة تُعاد حسابها لاحقاً —
   لأن الغاية بالتحديد هي كشف تغيّر الافتراضات نفسها (Benchmark/معدل الرسملة/
   السايبور...) بمرور الزمن، فإعادة حساب النسخ القديمة بافتراضات اليوم يُبطل
   الغاية كلياً.

   مجموعة Firestore مستقلة ومسطَّحة (underwritingVersions، بحقل oppId — نفس
   نمط oppAuditLog بالضبط لا subcollection) — append-only بتصميم firestore.rules
   مع قيود نزاهة إنشاء: اللقطة اليدوية يكتبها مالك الفرصة/الأدمن فقط، ولقطة
   v4_ic_approved لا تُقبل إلا من Senior IC/Admin ومربوطة بسجل icDecisions
   موجود فعلاً؛ update/delete ممنوعان بالكامل.

   ---------------------------------------------------------------------------
   إضافة "المرحلة السابعة — الأداء الفعلي المتكرر + نسخ الأطروحة" (بطلب
   المستخدم صريحاً، بعد مراجعته لخريطة الفجوات الحقيقية في هذا الملف تحديداً):

   ١) الأداء الفعلي المتكرر (assetActuals): الحقل القديم d.actuals كان "لقطة
      واحدة قابلة للاستبدال" — لا سجل تاريخي، لا Immutability، يخالف تماماً
      المبدأ المحاسبي المُطبَّق في كل مكان آخر بالمشروع (المرحلة ٦/٦-ب: كل
      حقيقة مالية مُسجَّلة سجل ثابت append-only، لا تُستبدَل). الحل: مجموعة
      Firestore جديدة (assetActuals) — append-only بالضبط بنفس نمط
      underwritingVersions (create فقط، لا تعديل ولا حذف، id لا يتكرر، وenteredBy
      يطابق المستخدم المصادَق عليه) — كل إدخال "فعلي" لفترة جديدة سجل ثابت مستقل، فتُبنى سلسلة زمنية حقيقية
      (Timeline) بدل لقطة واحدة تُمحى بالحفظ التالي. الحقل القديم d.actuals لم
      يُحذَف (تفادياً لأي فقد بيانات لمن استخدمه قبل هذا التعديل) ويظهر تلقائياً
      كأول صف "لقطة قديمة (نظام سابق)" فقط للقراءة في الجدول الجديد.
   ٢) نسخ الأطروحة الاستثمارية (thesisSnapshot): حقل نصي جديد d.thesis (يكتبه
      المحلل يدوياً، بمعزل تام عن السرد الآلي المتجدد في ai-analyst.js الذي لا
      يُحفَظ تاريخياً أصلاً) يُلقَط الآن *مع* كل لقطة رقمية موجودة أصلاً في
      underwritingVersions (نفس لحظة الالتقاط تماماً: قرار لجنة أو لقطة يدوية)
      — فيصبح بإمكاننا نرى النص الذي برَّر الأرقام في تلك اللحظة بالضبط، لا
      فقط الأرقام بمفردها. لا حاجة لمجموعة Firestore جديدة لهذا الجزء: نفس
      سجل underwritingVersions يحمل الآن حقلاً إضافياً thesisSnapshot، مع قيود
      Firestore على نزاهة إنشاء السجل وربطه بالفرصة/قرار اللجنة المناسب.

   حقل actuals القديم (عبر registerOpportunitySchemaExtender) — يبقى كما هو
   تماماً (توافق خلفي)، فقط لا يظهر نموذج إدخال جديد له بعد الآن.
   لا تعديل على core.js — فقط عبر نقاط التوسّع المُصدَّرة.
   ========================================================================= */

// Phase 2R-4E: buildUnderwritingVersionRecord() below is no longer what writes the
// v4_ic_approved stage against a real Firebase backend. That write now happens exclusively
// inside functions/index.js::approveOpportunity, in the same trusted server transaction as the
// icDecisions record, using the server's own recomputed metrics/inputHash/engineVersion (never a
// client-side recompute) — see ic-workflow.js's ic-decide handler, which no longer calls this
// function for that path. buildUnderwritingVersionRecord() remains in use for exactly two cases,
// both intentionally client-authored: the 'manual' stage (uw-save-manual below, always a client
// write, gated by firestore.rules' isAdminEmail()/ownsOpp() branch, unchanged by this phase), and
// the narrow demo/local-only fallback in ic-workflow.js (no real Firebase project to call a
// Cloud Function against at all).
const UW_COLLECTION = 'underwritingVersions';
const ACTUALS_COLLECTION = 'assetActuals';

const STAGE_LABELS = {
  v1_asking:        { ar:'v1 — عند العرض الأولي',        en:'v1 — Initial Ask' },
  v2_post_dd:        { ar:'v2 — بعد العناية الواجبة',      en:'v2 — Post-DD' },
  v3_term_sheet:     { ar:'v3 — بعد Term Sheet',           en:'v3 — Post Term Sheet' },
  v4_ic_approved:    { ar:'v4 — معتمَدة من اللجنة',        en:'v4 — IC-Approved' },
  manual:            { ar:'لقطة يدوية',                    en:'Manual Snapshot' },
};

function snapshotMetrics(core, d){
  let c; try{ c = core.compute(d); }catch(e){ c = {}; }
  /* 3A-2c: لقطة تسعير لفرصة محجوبة (INVALID/INCOMPLETE) لا تحفظ أي مؤشر ربحية محسوب — تُحفظ فارغة ومعلَّمة. */
  const _blk = typeof core.metricGuard==='function' ? core.metricGuard(d, c) : null;
  if(_blk){
    return { oppType: d.meta.oppType, price: (d.land && d.land.price!=null) ? d.land.price : null,
      equityIRR: null, projectIRR: null, MOIC: null, dscrMin: null, blocked: true, blockedStatus: _blk.status };
  }
  return {
    oppType: d.meta.oppType,
    price: (d.land && d.land.price!=null) ? d.land.price : null,
    equityIRR: isFinite(c.equityIRR) ? c.equityIRR : null,
    projectIRR: isFinite(c.projectIRR) ? c.projectIRR : null,
    MOIC: isFinite(c.MOIC) ? c.MOIC : null,
    dscrMin: (c.dscrMin!=null && isFinite(c.dscrMin)) ? c.dscrMin : null,
  };
}

export function buildUnderwritingVersionRecord(core, oppId, d, stage, trigger, sourceDecisionId){
  return { id: core.uid('UWV'), data: {
    oppId,
    stage,
    label: STAGE_LABELS[stage] ? STAGE_LABELS[stage].ar : stage,
    savedAt: new Date().toISOString(),
    savedBy: core.currentUser ? core.currentUser.email : (core.DEMO_MODE ? 'زائر تجريبي' : 'محلي'),
    trigger,
    sourceDecisionId: sourceDecisionId || null,
    metrics: snapshotMetrics(core, d),
    thesisSnapshot: (d.thesis||'').trim(),
  }};
}

function fmtMetric(core, key, v){
  if(v==null) return '—';
  if(key==='price') return core.fmtSAR(v);
  if(key==='equityIRR' || key==='projectIRR') return core.fmtPct(v);
  if(key==='MOIC') return v.toFixed(2)+'×';
  if(key==='dscrMin') return v.toFixed(2)+'×';
  return String(v);
}

// أقرب لقطة "معتمَدة من اللجنة" (v4) — الأساس المؤسسي الصحيح لمقارنة الفعلي
// عليه (لا "الحالي المُعاد حسابه حياً"، الذي يتحرك كل ما عُدِّلت افتراضات
// الاكتتاب، فيُبطل عملياً سؤال "هل تغيّرت الصفقة أم تغيّر افتراضنا؟"). لو لا
// توجد نسخة v4 بعد، نستخدم أقدم لقطة متاحة كأساس مؤقت أفضل من لا شيء.
function resolveBaseline(versions){
  const v4s = versions.filter(v=>v.data.stage==='v4_ic_approved');
  if(v4s.length) return v4s[v4s.length-1];
  return versions.length ? versions[0] : null;
}

export function registerUnderwritingVersions(core){
  core.registerDataCollection(UW_COLLECTION);
  core.registerDataCollection(ACTUALS_COLLECTION);

  core.registerOpportunitySchemaExtender(()=>({
    actuals: { enabled:false, asOfDate:'', actualPrice:null, actualEquityIRR:null, actualMOIC:null, notes:'' },
    thesis: '',
  }));

  core.registerDetailSection((d, c)=>{
    const oppId = core.openDetailId;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec) return '';
    const canEdit = core.canEditOpp(rec);
    const versions = (core.STORE[UW_COLLECTION]||[]).filter(v=>v.data.oppId===oppId).slice().sort((a,b)=> (a.data.savedAt<b.data.savedAt)?-1:1);
    const current = snapshotMetrics(core, d);
    const actuals = d.actuals || {};

    const metricKeys = [
      { key:'price',      ar:'سعر متر الأرض',        en:'Land price/m²' },
      { key:'equityIRR',  ar:'Equity IRR',            en:'Equity IRR' },
      { key:'MOIC',       ar:'MOIC',                  en:'MOIC' },
      { key:'dscrMin',    ar:'DSCR (أدنى)',           en:'DSCR (min)' },
    ];

    const timelineRows = versions.map(v=>`<tr>
      <td style="font-size:12px; font-weight:600;">${core.T(STAGE_LABELS[v.data.stage]? STAGE_LABELS[v.data.stage].ar : v.data.label, STAGE_LABELS[v.data.stage]? STAGE_LABELS[v.data.stage].en : v.data.label)}</td>
      ${metricKeys.map(m=>`<td class="num">${fmtMetric(core, m.key, v.data.metrics[m.key])}</td>`).join('')}
      <td class="mono" style="font-size:11px;">${core.esc((v.data.savedAt||'').slice(0,10))}</td>
      <td style="font-size:10.5px; color:var(--ink-faint);">${v.data.trigger==='ic_decision'? '🏛️ IC' : '📌 '+core.T('يدوي','manual')}</td>
    </tr>`).join('');
    const currentRow = `<tr style="background:var(--surface-2);">
      <td style="font-size:12px; font-weight:700;">${core.T('الحالي (حيّ)','Current (live)')}</td>
      ${metricKeys.map(m=>`<td class="num" style="font-weight:700;">${fmtMetric(core, m.key, current[m.key])}</td>`).join('')}
      <td colspan="2" style="font-size:10.5px; color:var(--ink-faint);">${core.T('يُعاد حسابه حياً من بيانات الفرصة الآن','recomputed live from current data')}</td>
    </tr>`;

    // ---------------- نسخ الأطروحة الاستثمارية (thesisSnapshot) ----------------
    const liveThesis = (d.thesis||'').trim();
    const thesisVersions = versions.filter(v=> v.data.thesisSnapshot!=null);
    const thesisHistoryHtml = thesisVersions.length ? `
      <div style="margin-top:10px; display:flex; flex-direction:column; gap:8px;">
        ${thesisVersions.map(v=>{
          const txt = (v.data.thesisSnapshot||'').trim();
          const changed = txt !== liveThesis;
          return `<div style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2);">
            <div style="display:flex; justify-content:space-between; gap:8px; font-size:11px; color:var(--ink-faint); margin-bottom:4px;">
              <span>${core.T(STAGE_LABELS[v.data.stage]? STAGE_LABELS[v.data.stage].ar : v.data.label, STAGE_LABELS[v.data.stage]? STAGE_LABELS[v.data.stage].en : v.data.label)} — ${core.esc((v.data.savedAt||'').slice(0,10))}</span>
              ${changed? `<span style="color:var(--bad); font-weight:600;">🔄 ${core.T('تغيّرت الأطروحة منذ هذه اللقطة','Thesis has changed since this snapshot')}</span>` : `<span style="color:var(--good);">= ${core.T('مطابقة للأطروحة الحالية','matches current thesis')}</span>`}
            </div>
            <p style="margin:0; font-size:12.5px; white-space:pre-wrap;">${txt? core.esc(txt) : `<span class="note">${core.T('(فارغة وقت هذه اللقطة)','(empty at this snapshot)')}</span>`}</p>
          </div>`;
        }).join('')}
      </div>` : `<p class="note" style="margin-top:8px;">${core.T('لا توجد لقطات أطروحة محفوظة بعد — تُلقَط تلقائياً مع كل لقطة رقمية جديدة (اعتماد لجنة أو حفظ يدوي) بمجرد كتابة الأطروحة أدناه.','No thesis snapshots saved yet — one is captured automatically alongside every new numeric snapshot (IC approval or manual save) once you write the thesis below.')}</p>`;

    const thesisSectionHtml = `
      <div style="margin-top:16px; padding:12px; border:1px dashed var(--border); border-radius:10px;">
        <p class="step-sub" style="margin:0 0 8px;">🎯 ${core.T('الأطروحة الاستثمارية (نصية، مُنسَخة تاريخياً)','Investment Thesis (text, versioned historically)')}</p>
        <p class="note" style="margin:0 0 8px;">${core.T('لماذا أعجبتنا هذه الصفقة؟ ما زال هذا صحيحاً؟ — نص يكتبه المحلل يدوياً (بمعزل عن السرد الآلي المتجدد)، يُحفَظ كنسخة ثابتة مع كل لقطة تسعير جديدة.','Why did we like this deal? Is that still true? — analyst-written text (separate from the auto-regenerated narrative), frozen into a snapshot alongside every new pricing version.')}</p>
        ${canEdit ? `
        <textarea data-thesis-input="${oppId}" rows="4" placeholder="${core.T('اكتب الأطروحة الاستثمارية هنا...','Write the investment thesis here...')}" style="width:100%; padding:9px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px; resize:vertical;">${core.esc(liveThesis)}</textarea>
        <button type="button" class="btn btn-sm btn-primary" style="margin-top:8px;" data-action="thesis-save" data-id="${oppId}">💾 ${core.T('حفظ الأطروحة','Save Thesis')}</button>
        ` : `<p style="margin:0; font-size:12.5px; white-space:pre-wrap;">${liveThesis? core.esc(liveThesis) : `<span class="note">${core.T('لم تُكتَب أطروحة بعد.','No thesis written yet.')}</span>`}</p>`}
        <p class="step-sub" style="margin:14px 0 0;">${core.T('السجل التاريخي','History')}</p>
        ${thesisHistoryHtml}
      </div>`;

    // ---------------- الأداء الفعلي المتكرر (assetActuals) ----------------
    const baseline = resolveBaseline(versions);
    const baselineMetrics = baseline ? baseline.data.metrics : null;
    const actualEntries = (core.STORE[ACTUALS_COLLECTION]||[]).filter(a=>a.data.oppId===oppId).slice().sort((a,b)=> (a.data.asOfDate||'')<(b.data.asOfDate||'')?-1:1);

    function varianceCell(actualVal, baseVal, isRatio){
      if(actualVal==null || baseVal==null) return '—';
      const delta = actualVal - baseVal;
      const color = delta>=0 ? 'var(--good)' : 'var(--bad)';
      const txt = isRatio ? `${delta>=0?'+':''}${(delta*100).toFixed(1)} ${core.T('نقطة','pts')}` : `${delta>=0?'+':''}${delta.toFixed(2)}×`;
      return `<span style="color:${color}; font-weight:600;">${txt}</span>`;
    }

    // الصف "القديم" (d.actuals) — للقراءة فقط، توافقاً خلفياً مع من استخدم النموذج
    // السابق قبل هذا التعديل، بلا فقد بيانات ولا نموذج إدخال جديد له.
    const legacyRow = (actuals.enabled) ? `<tr style="opacity:0.75;">
      <td style="font-size:12px;">${core.T('لقطة قديمة (نظام سابق)','Legacy snapshot (previous system)')}</td>
      <td class="mono" style="font-size:11px;">${core.esc(actuals.asOfDate||'—')}</td>
      <td class="num">${fmtMetric(core,'equityIRR', actuals.actualEquityIRR)}</td>
      <td class="num">${baselineMetrics? varianceCell(actuals.actualEquityIRR, baselineMetrics.equityIRR, true) : '—'}</td>
      <td class="num">${fmtMetric(core,'MOIC', actuals.actualMOIC)}</td>
      <td class="num">${baselineMetrics? varianceCell(actuals.actualMOIC, baselineMetrics.MOIC, false) : '—'}</td>
      <td class="num">—</td><td class="num">—</td>
      <td style="font-size:11px;">${core.esc(actuals.notes||'')}</td>
    </tr>` : '';

    const actualRows = actualEntries.map(a=>`<tr>
      <td style="font-size:12px; font-weight:600;">${core.esc(a.data.period||'—')}</td>
      <td class="mono" style="font-size:11px;">${core.esc((a.data.asOfDate||'').slice(0,10))}</td>
      <td class="num">${fmtMetric(core,'equityIRR', a.data.actualEquityIRR)}</td>
      <td class="num">${baselineMetrics? varianceCell(a.data.actualEquityIRR, baselineMetrics.equityIRR, true) : '—'}</td>
      <td class="num">${fmtMetric(core,'MOIC', a.data.actualMOIC)}</td>
      <td class="num">${baselineMetrics? varianceCell(a.data.actualMOIC, baselineMetrics.MOIC, false) : '—'}</td>
      <td class="num">${fmtMetric(core,'dscrMin', a.data.actualDSCR)}</td>
      <td class="num">${baselineMetrics? varianceCell(a.data.actualDSCR, baselineMetrics.dscrMin, false) : '—'}</td>
      <td style="font-size:11px;">${core.esc(a.data.notes||'')}</td>
    </tr>`).join('');

    const actualsTableHtml = (legacyRow || actualRows) ? `
      <div class="tablewrap" style="margin-top:10px;"><table class="db" style="font-size:11.5px;">
        <thead><tr>
          <th>${core.T('الفترة','Period')}</th><th>${core.T('التاريخ','Date')}</th>
          <th>Equity IRR ${core.T('فعلي','actual')}</th><th>${core.T('الفرق عن الأساس','Δ vs. baseline')}</th>
          <th>MOIC ${core.T('فعلي','actual')}</th><th>${core.T('الفرق عن الأساس','Δ vs. baseline')}</th>
          <th>DSCR ${core.T('فعلي','actual')}</th><th>${core.T('الفرق عن الأساس','Δ vs. baseline')}</th>
          <th>${core.T('ملاحظات','Notes')}</th>
        </tr></thead>
        <tbody>${legacyRow}${actualRows}</tbody>
      </table></div>` : `<p class="note" style="margin-top:8px;">${core.T('لا توجد إدخالات أداء فعلي بعد.','No actual-performance entries yet.')}</p>`;

    const actualsFormHtml = canEdit ? `
      <form data-actual-input="${oppId}" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px,1fr)); gap:8px; margin-top:12px;">
        <input type="text" name="period" placeholder="${core.T('الفترة (مثال: 2027 ربع 1)','Period (e.g. 2027 Q1)')}" style="padding:7px 9px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12px;">
        <input type="date" name="asOfDate" style="padding:7px 9px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12px;">
        <input type="number" name="actualEquityIRR" placeholder="${core.T('Equity IRR الفعلي (%)','Actual Equity IRR (%)')}" step="0.1" style="padding:7px 9px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12px;">
        <input type="number" name="actualMOIC" placeholder="${core.T('MOIC الفعلي (تراكمي)','Actual MOIC (to date)')}" step="0.01" style="padding:7px 9px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12px;">
        <input type="number" name="actualDSCR" placeholder="${core.T('DSCR الفعلي','Actual DSCR')}" step="0.01" style="padding:7px 9px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12px;">
        <input type="text" name="notes" placeholder="${core.T('ملاحظات','Notes')}" style="padding:7px 9px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12px;">
      </form>
      <button type="button" class="btn btn-sm btn-primary" style="margin-top:8px;" data-action="actual-add" data-id="${oppId}">➕ ${core.T('إضافة إدخال أداء فعلي جديد (سجل ثابت لا يُعدَّل)','Add new actual-performance entry (immutable record)')}</button>` : '';

    const actualsSectionHtml = `
      <div style="margin-top:16px; padding:12px; border:1px dashed var(--border); border-radius:10px;">
        <p class="step-sub" style="margin:0 0 8px;">📈 ${core.T('الأداء الفعلي عبر الزمن (بعد الإغلاق/التنفيذ)','Post-Investment Performance Over Time')}</p>
        <p class="note" style="margin:0 0 8px;">${baselineMetrics? core.T('كل إدخال يُقارَن بآخر لقطة معتمَدة من اللجنة (v4) — أو أقدم لقطة متاحة إن لم توجد بعد — لا بالحالي المُعاد حسابه حياً (الذي يتحرك مع أي تعديل على الاكتتاب).','Every entry is compared against the latest IC-approved (v4) snapshot — or the earliest available one if no v4 exists yet — never against the live-recomputed current figures (which move with any underwriting edit).') : core.T('لا توجد لقطة تسعير محفوظة بعد لاستخدامها كأساس للمقارنة — سيظهر الفرق بمجرد حفظ أول لقطة (تلقائياً عند اعتماد اللجنة، أو يدوياً أعلاه).','No saved pricing snapshot yet to compare against — variance will appear once a first snapshot exists (automatically on IC approval, or manually above).')}</p>
        ${actualsTableHtml}
        ${actualsFormHtml}
      </div>`;

    return `
    <div class="section">
      <h3>📌 ${core.T('التسعير الموثَّق بالإصدارات','Versioned Underwriting')} <span style="color:var(--ink-faint); font-weight:500; font-size:12px;">(v1→v4 + Actual)</span></h3>
      <p class="note" style="margin:0 0 10px;">${core.T('لقطة أرقام ثابتة (لا تُعاد حسابها لاحقاً) عند كل اعتماد من اللجنة — لمعرفة "هل تغيّرت الصفقة أم تغيّر افتراضنا؟"','Frozen snapshots (never recomputed later) taken at every IC approval — to answer "did the deal change, or did our assumption change?"')}</p>
      ${versions.length===0? `<p class="note">${core.T('لا توجد نسخ محفوظة بعد — تُحفَظ تلقائياً عند أول قرار اعتماد من اللجنة، أو يدوياً بالزر أدناه.','No versions saved yet — a version is captured automatically on the first IC approval, or manually below.')}</p>` : `
      <div class="tablewrap"><table class="db" style="font-size:11.5px;">
        <thead><tr><th>${core.T('المرحلة','Stage')}</th>${metricKeys.map(m=>`<th>${core.T(m.ar,m.en)}</th>`).join('')}<th>${core.T('التاريخ','Date')}</th><th>${core.T('السبب','Trigger')}</th></tr></thead>
        <tbody>${timelineRows}${currentRow}</tbody>
      </table></div>`}
      ${canEdit? `<button type="button" class="btn btn-sm btn-ghost" style="margin-top:10px;" data-action="uw-save-manual" data-id="${oppId}">📌 ${core.T('حفظ لقطة يدوية الآن','Save Manual Snapshot Now')}</button>` : ''}
      ${thesisSectionHtml}
      ${actualsSectionHtml}
    </div>`;
  });

  core.registerActionHandler(async (action, el)=>{
    if(action==='uw-save-manual'){
      const oppId = el.dataset.id;
      const rec = core.opportunities.find(o=>o.id===oppId);
      if(!rec || !core.canEditOpp(rec)) return true;
      const draft = core.withDefaults(rec.data);
      const versionRec = buildUnderwritingVersionRecord(core, oppId, draft, 'manual', 'manual');
      await core.persistIfRecord(UW_COLLECTION, versionRec);
      core.render();
      return true;
    }
    if(action==='uw-save-actuals'){
      // مُبقًى حرفياً بلا تغيير (توافق خلفي) — لا نموذج جديد يستدعيه بعد الآن،
      // انظر التعليق في رأس الملف.
      const oppId = el.dataset.id;
      const form = document.querySelector(`form[data-uw-actuals="${oppId}"]`);
      if(!form) return true;
      const rec = core.opportunities.find(o=>o.id===oppId);
      if(!rec || !core.canEditOpp(rec)) return true;

      const draft = core.withDefaults(rec.data);
      const get = (name)=>{ const inp=form.querySelector(`[name="${name}"]`); return inp?inp.value:''; };
      const enabled = !!(form.querySelector('[name="enabled"]')||{}).checked;
      const irrPct = get('actualEquityIRR');
      draft.actuals = {
        enabled,
        asOfDate: get('asOfDate') || core.todayStr(),
        actualPrice: get('actualPrice')===''? null : Number(get('actualPrice')),
        actualEquityIRR: irrPct===''? null : Number(irrPct)/100,
        actualMOIC: get('actualMOIC')===''? null : Number(get('actualMOIC')),
        notes: get('notes').trim(),
      };
      draft.meta.updatedAt = core.todayStr();
      draft.meta.updatedBy = core.currentUser ? core.currentUser.email : (draft.meta.updatedBy||null);

      await core.persistOpportunity({ id: oppId, data: draft });
      await core.loadAll();
      core.render();
      return true;
    }
    if(action==='thesis-save'){
      const oppId = el.dataset.id;
      const input = document.querySelector(`[data-thesis-input="${oppId}"]`);
      if(!input) return true;
      const rec = core.opportunities.find(o=>o.id===oppId);
      if(!rec || !core.canEditOpp(rec)) return true;
      const draft = core.withDefaults(rec.data);
      draft.thesis = input.value;
      draft.meta.updatedAt = core.todayStr();
      draft.meta.updatedBy = core.currentUser ? core.currentUser.email : (draft.meta.updatedBy||null);
      await core.persistOpportunity({ id: oppId, data: draft });
      await core.loadAll();
      core.render();
      return true;
    }
    if(action==='actual-add'){
      const oppId = el.dataset.id;
      const form = document.querySelector(`form[data-actual-input="${oppId}"]`);
      if(!form) return true;
      const rec = core.opportunities.find(o=>o.id===oppId);
      if(!rec || !core.canEditOpp(rec)) return true;
      const get = (name)=>{ const inp=form.querySelector(`[name="${name}"]`); return inp?inp.value.trim():''; };
      const period = get('period');
      const asOfDate = get('asOfDate');
      if(!period || !asOfDate){
        alert(core.T('الفترة والتاريخ مطلوبان.','Period and date are required.'));
        return true;
      }
      const irrPct = get('actualEquityIRR');
      const actualRec = { id: core.uid('ACT'), data: {
        oppId, period, asOfDate,
        actualEquityIRR: irrPct===''? null : Number(irrPct)/100,
        actualMOIC: get('actualMOIC')===''? null : Number(get('actualMOIC')),
        actualDSCR: get('actualDSCR')===''? null : Number(get('actualDSCR')),
        notes: get('notes'),
        enteredBy: core.currentUser ? core.currentUser.email : (core.DEMO_MODE ? 'زائر تجريبي' : 'محلي'),
        enteredAt: new Date().toISOString(),
      }};
      await core.persistIfRecord(ACTUALS_COLLECTION, actualRec);
      core.render();
      return true;
    }
    return false;
  });
}
