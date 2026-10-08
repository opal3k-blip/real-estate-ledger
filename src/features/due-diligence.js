/* =========================================================================
   العناية الواجبة — Due Diligence Checklist (Phase 1، النظام الثالث)
   ---------------------------------------------------------------------------
   قائمة تحقق مؤسسية عبر ١٠ فئات (قانونية/فنية/تخطيطية/تقييم/سوق/مالية/ضريبية/
   بيئية/تمويلية/تجارية)، كل بند: الحالة (معلّق/قيد التنفيذ/مكتمل/استثناء) +
   المستند + المراجع + التاريخ + الملاحظة (Finding) + الخطورة + الإجراء المطلوب.
   نسبة إنجاز إجمالية + راية "N بند حرج معلّق" على مستوى الفرصة.
   ---------------------------------------------------------------------------
   ملاحظة تصميم مهمة: كل بند له مفتاح ثابت (key) بدل معرّف عشوائي (uid) — لأن
   blankOpportunity() يُعاد توليدها في كل استدعاء لـwithDefaults() (انظر التعليق
   في core.js عند schema extenders)، فأي معرّف عشوائي كان سيتغيّر بين كل عرض
   وآخر لفرصة لم تُحفَظ بعد، فيكسر مطابقة data-id عند أول تفاعل. المفتاح الثابت
   يتجنّب هذه المشكلة تماماً، ويضمن أيضاً أن أي بند افتراضي جديد يُضاف لاحقاً في
   DEFAULT_DD_ITEMS يندمج تلقائياً في الفرص القديمة عبر withDefaults() (لأن
   dd.items قاموس/Object وليس مصفوفة — يُدمَج حقلاً حقلاً لا يُستبدَل بالكامل).

   Phase 2R-4B — Client Cutover: تعريفات البيانات الحتمية (DD_CATEGORIES،
   DEFAULT_DD_ITEMS، defaultItemsDict، ddStats) أصبحت مُستورَدة من
   src/domain/due-diligence/dd-engine.js (الجهة الرسمية الوحيدة لها، بعد
   إثبات تطابقها Shadow-Mode في Phase 2R-4A — 17/17). هذا الملف يحتفظ فقط
   بمنطق العرض/التسجيل (UI) وثوابت العرض المحلية (STATUSES/SEVERITIES) التي
   لا علاقة لها بالحساب. لا تعديل على منطق core.js الداخلي — فقط عبر نقاط
   التوسّع المُصدَّرة.
   ========================================================================= */
import { DD_CATEGORIES, DEFAULT_DD_ITEMS, defaultItemsDict, ddStats } from '../domain/due-diligence/dd-engine.js';

const STATUSES = [
  { key:'pending',     ar:'معلّق',        en:'Pending',     color:'#94a3b8' },
  { key:'in_progress', ar:'قيد التنفيذ',  en:'In Progress', color:'#60a5fa' },
  { key:'completed',   ar:'مكتمل',        en:'Completed',   color:'#34d399' },
  { key:'exception',   ar:'استثناء',      en:'Exception',   color:'#f87171' },
];
const STATUS_BY_KEY = Object.fromEntries(STATUSES.map(s=>[s.key,s]));

const SEVERITIES = [
  { key:'low',      ar:'منخفضة', en:'Low',      color:'#34d399' },
  { key:'medium',   ar:'متوسطة', en:'Medium',   color:'#fbbf24' },
  { key:'high',     ar:'عالية',  en:'High',     color:'#fb923c' },
  { key:'critical', ar:'حرجة',   en:'Critical', color:'#f87171' },
];
const SEV_BY_KEY = Object.fromEntries(SEVERITIES.map(s=>[s.key,s]));

export { ddStats, defaultItemsDict, DD_CATEGORIES, DEFAULT_DD_ITEMS };

export function registerDueDiligence(core){
  core.registerOpportunitySchemaExtender(()=>({
    dd: { items: defaultItemsDict() },
  }));

  core.registerDetailSection((d, c)=>{
    const oppId = core.openDetailId;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec) return '';
    const items = (d.dd && d.dd.items) || defaultItemsDict();
    const stats = ddStats(items);
    const canEdit = core.canEditOpp(rec);
    const pctStr = core.LANG==='en' ? (stats.pct*100).toFixed(0)+'%' : '%'+(stats.pct*100).toFixed(0);

    const rowsForCategory = (catKey)=> DEFAULT_DD_ITEMS.filter(it=>it.category===catKey).map(it=>{
      const v = items[it.key] || {};
      const st = STATUS_BY_KEY[v.status] || STATUS_BY_KEY.pending;
      const sv = SEV_BY_KEY[v.severity] || SEV_BY_KEY.medium;
      if(!canEdit){
        return `<tr>
          <td style="font-size:12px;">${core.T(it.ar, it.en)}</td>
          <td><span class="tag" style="background:${st.color}22; color:${st.color}; font-weight:700; font-size:10.5px;">${core.T(st.ar,st.en)}</span></td>
          <td><span class="tag" style="background:${sv.color}22; color:${sv.color}; font-size:10.5px;">${core.T(sv.ar,sv.en)}</span></td>
          <td style="font-size:11.5px;">${core.esc(v.finding||'—')}</td>
        </tr>`;
      }
      return `<tr data-dd-item="${it.key}">
        <td style="font-size:12px; min-width:170px;">${core.T(it.ar, it.en)}</td>
        <td><select name="status" style="padding:5px 7px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--ink); font-size:11px; font-family:inherit;">
          ${STATUSES.map(s=>`<option value="${s.key}" ${s.key===v.status?'selected':''}>${core.T(s.ar,s.en)}</option>`).join('')}
        </select></td>
        <td><select name="severity" style="padding:5px 7px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--ink); font-size:11px; font-family:inherit;">
          ${SEVERITIES.map(s=>`<option value="${s.key}" ${s.key===v.severity?'selected':''}>${core.T(s.ar,s.en)}</option>`).join('')}
        </select></td>
        <td><input type="text" name="reviewer" value="${core.esc(v.reviewer||'')}" placeholder="${core.T('المراجع','Reviewer')}" style="width:100px; padding:5px 7px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--ink); font-size:11px; font-family:inherit;"></td>
        <td><input type="date" name="date" value="${core.esc(v.date||'')}" style="padding:5px 6px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--ink); font-size:11px; font-family:inherit;"></td>
        <td><input type="text" name="document" value="${core.esc(v.document||'')}" placeholder="${core.T('اسم المستند','Document name')}" style="width:120px; padding:5px 7px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--ink); font-size:11px; font-family:inherit;"></td>
        <td><input type="text" name="finding" value="${core.esc(v.finding||'')}" placeholder="${core.T('الملاحظة','Finding')}" style="width:140px; padding:5px 7px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--ink); font-size:11px; font-family:inherit;"></td>
        <td><input type="text" name="requiredAction" value="${core.esc(v.requiredAction||'')}" placeholder="${core.T('الإجراء المطلوب','Required action')}" style="width:140px; padding:5px 7px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--ink); font-size:11px; font-family:inherit;"></td>
      </tr>`;
    }).join('');

    return `
    <div class="section">
      <h3>📋 ${core.T('العناية الواجبة','Due Diligence')} <span style="color:var(--ink-faint); font-weight:500; font-size:12px;">(Due Diligence Checklist)</span></h3>
      <div class="kv" style="margin-bottom:12px;">
        <div class="k">${core.T('نسبة الإنجاز','Completion')}</div><div class="v"><b>${pctStr}</b> (${stats.completed}/${stats.total})</div>
        <div class="k">${core.T('البنود الحرجة المعلّقة','Critical Items Pending')}</div><div class="v">${stats.criticalPending>0? `<span style="color:var(--bad); font-weight:700;">⚠️ ${stats.criticalPending}</span>` : `<span style="color:var(--good);">✅ 0</span>`}</div>
      </div>
      <div style="height:8px; background:var(--surface-2); border-radius:5px; overflow:hidden; margin-bottom:14px;">
        <div style="height:100%; width:${(stats.pct*100).toFixed(1)}%; background:${stats.criticalPending>0?'var(--bad)':'var(--good)'};"></div>
      </div>
      ${stats.criticalPending>0? `<p class="note" style="color:var(--bad); margin:0 0 12px;">🚫 ${core.T('لا يُنصح برفع هذه الفرصة للجنة الاستثمار حتى معالجة كل البنود الحرجة المعلّقة.','Not recommended for IC submission until all critical pending items are resolved.')}</p>` : ''}
      ${DD_CATEGORIES.map(cat=>`
        <div style="margin-bottom:16px;">
          <p style="font-weight:700; font-size:12.5px; margin:0 0 6px;">${core.T(cat.ar, cat.en)}</p>
          <div class="tablewrap"><table class="db" style="font-size:11px;">
            <thead><tr>
              <th>${core.T('البند','Item')}</th><th>${core.T('الحالة','Status')}</th><th>${core.T('الخطورة','Severity')}</th>
              ${canEdit? `<th>${core.T('المراجع','Reviewer')}</th><th>${core.T('التاريخ','Date')}</th><th>${core.T('المستند','Document')}</th>` : ''}
              <th>${core.T('الملاحظة','Finding')}</th>
              ${canEdit? `<th>${core.T('الإجراء المطلوب','Required Action')}</th>` : ''}
            </tr></thead>
            <tbody>${rowsForCategory(cat.key)}</tbody>
          </table></div>
        </div>
      `).join('')}
      ${canEdit? `<button type="button" class="btn btn-sm btn-primary" data-action="dd-save" data-id="${oppId}">💾 ${core.T('حفظ قائمة العناية الواجبة','Save Due Diligence Checklist')}</button>` : ''}
    </div>`;
  });

  core.registerActionHandler(async (action, el)=>{
    if(action!=='dd-save') return false;
    const oppId = el.dataset.id;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec || !core.canEditOpp(rec)) return true;

    const draft = core.withDefaults(rec.data);
    const items = draft.dd.items || (draft.dd.items = defaultItemsDict());
    document.querySelectorAll('tr[data-dd-item]').forEach(row=>{
      const key = row.dataset.ddItem;
      if(!items[key]) items[key] = { status:'pending', document:'', reviewer:'', date:'', finding:'', severity:'medium', requiredAction:'' };
      const get = (name)=>{ const inp = row.querySelector(`[name="${name}"]`); return inp ? inp.value : undefined; };
      items[key].status = get('status') ?? items[key].status;
      items[key].severity = get('severity') ?? items[key].severity;
      items[key].reviewer = (get('reviewer') ?? items[key].reviewer ?? '').trim();
      items[key].date = get('date') ?? items[key].date;
      items[key].document = (get('document') ?? items[key].document ?? '').trim();
      items[key].finding = (get('finding') ?? items[key].finding ?? '').trim();
      items[key].requiredAction = (get('requiredAction') ?? items[key].requiredAction ?? '').trim();
    });
    draft.meta.updatedAt = core.todayStr();
    draft.meta.updatedBy = core.currentUser ? core.currentUser.email : (draft.meta.updatedBy||null);

    await core.persistOpportunity({ id: oppId, data: draft });
    core.clearUnsavedEdits();
    await core.loadAll();
    core.render();
    return true;
  });
}
