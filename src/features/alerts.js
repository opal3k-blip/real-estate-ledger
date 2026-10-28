/* =========================================================================
   التنبيهات والمهام — Alerts & Tasks (Phase 3، النظام الخامس)
   ---------------------------------------------------------------------------
   يجمع تنبيهات تلقائية من كل الأنظمة القائمة فعلياً عبر قراءات مباشرة لبيانات
   كل فرصة (pipeline.*، ic.decisions، negotiation.*) + استيراد ddStats الجاهز
   من due-diligence.js (بلا أي تكرار لمنطقه)، بالإضافة لمقارنات مباشرة على
   compute() (DSCR/IRR دون الحد الأدنى المعتمد لكل فرصة). يُصدِّر computeAlerts()
   ليُستهلَك من لوحة القيادة (Command Center) ومن أي مكان آخر لاحقاً — حساب
   واحد لا يتكرر. لا تعديل على منطق core.js الداخلي.
   ========================================================================= */

import { ddStats, defaultItemsDict } from './due-diligence.js';

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function computeAlerts(core){
  const alerts = [];
  const today = core.todayStr();
  core.opportunities.forEach(rec=>{
    const d = core.withDefaults(rec.data);
    const name = d.meta.name || rec.id;
    let c; try{ c = core.compute(rec.data); }catch(e){ c = null; }
    // 3A-2c: فرصة محجوبة (مدخلات غير صالحة/ناقصة) → تنبيه واحد بلا أي رقم، ولا تُحتسب مؤشراتها في تنبيهات DSCR/IRR
    const _blk = (c && typeof core.oppMetricGuard==='function') ? core.oppMetricGuard(rec, c) : null;
    if(_blk){
      alerts.push({ severity:'high', oppId:rec.id, name, kind: core.T('مدخلات','Inputs'),
        message: core.T('مدخلات غير صالحة أو ناقصة — نتائج هذه الفرصة محجوبة وغير معتمدة حتى تصحيحها','Invalid or incomplete inputs — this opportunity\'s results are withheld and not approved until corrected') });
      c = null;
    }

    // DD حرجة معلّقة
    const dd = ddStats((d.dd && d.dd.items) || defaultItemsDict());
    if(dd.criticalPending>0){
      alerts.push({ severity:'high', oppId:rec.id, name, kind: core.T('عناية واجبة','Due Diligence'),
        message: core.T(`${dd.criticalPending} بند حرج معلّق في العناية الواجبة`, `${dd.criticalPending} critical DD item(s) pending`) });
    }

    // DSCR/IRR دون الحد الأدنى
    if(c){
      if(d.criteria.dscrMin!=null && c.dscrMin!=null && isFinite(c.dscrMin) && c.dscrMin < d.criteria.dscrMin){
        alerts.push({ severity:'high', oppId:rec.id, name, kind:'DSCR',
          message: core.T(`DSCR الأدنى ${c.dscrMin.toFixed(2)}× دون الحد الأدنى المعتمد ${d.criteria.dscrMin.toFixed(2)}×`, `Minimum DSCR ${c.dscrMin.toFixed(2)}× below approved minimum ${d.criteria.dscrMin.toFixed(2)}×`) });
      }
      if(d.criteria.irrMin!=null && isFinite(c.equityIRR) && c.equityIRR < d.criteria.irrMin){
        alerts.push({ severity:'medium', oppId:rec.id, name, kind:'Equity IRR',
          message: core.T(`Equity IRR ${core.fmtPct(c.equityIRR)} دون الحد الأدنى المعتمد ${core.fmtPct(d.criteria.irrMin)}`, `Equity IRR ${core.fmtPct(c.equityIRR)} below approved minimum ${core.fmtPct(d.criteria.irrMin)}`) });
      }
    }

    // الإجراء التالي في خط الأنابيب متأخر
    const p = d.pipeline;
    if(p && p.nextActionDeadline && p.nextActionDeadline < today && p.stage!=='archived' && p.stage!=='exit'){
      alerts.push({ severity:'medium', oppId:rec.id, name, kind: core.T('خط الأنابيب','Pipeline'),
        message: core.T(`إجراء متأخر: "${p.nextAction||'—'}" (كان مستحقاً ${p.nextActionDeadline})`, `Overdue action: "${p.nextAction||'—'}" (was due ${p.nextActionDeadline})`) });
    }

    // فرصة في مراجعة لجنة الاستثمار بلا قرار مسجَّل بعد
    const decisions = (d.ic && d.ic.decisions) || [];
    const latest = decisions.length? decisions[decisions.length-1] : null;
    if(p && p.stage==='ic_review' && !decisions.length){
      alerts.push({ severity:'medium', oppId:rec.id, name, kind: core.T('لجنة الاستثمار','Investment Committee'),
        message: core.T('في مرحلة مراجعة اللجنة بلا قرار مسجَّل بعد','In IC review stage with no decision recorded yet') });
    }
    if(latest && (latest.decision==='hold' || latest.decision==='revise')){
      alerts.push({ severity:'low', oppId:rec.id, name, kind: core.T('لجنة الاستثمار','Investment Committee'),
        message: core.T(`آخر قرار: ${latest.decision==='hold'?'تعليق':'مراجعة وإعادة عرض'} — بانتظار متابعة`, `Latest decision: ${latest.decision} — awaiting follow-up`) });
    }

    // التفاوض يقترب من سعر الانسحاب أو تجاوزه
    const neg = d.negotiation;
    if(neg && neg.walkAwayPrice>0 && d.land.price>0){
      if(d.land.price >= neg.walkAwayPrice){
        alerts.push({ severity:'high', oppId:rec.id, name, kind: core.T('التفاوض','Negotiation'),
          message: core.T('سعر الأرض الحالي عند/فوق سعر الانسحاب المحدَّد','Current land price is at/above the set walk-away price') });
      } else if(d.land.price >= neg.walkAwayPrice*0.95){
        alerts.push({ severity:'low', oppId:rec.id, name, kind: core.T('التفاوض','Negotiation'),
          message: core.T('سعر الأرض الحالي يقترب من سعر الانسحاب (خلال ٥٪)','Current land price is within 5% of the walk-away price') });
      }
    }
  });

  alerts.sort((a,b)=> SEVERITY_ORDER[a.severity]-SEVERITY_ORDER[b.severity]);
  return alerts;
}

export function registerAlerts(core){
  // القسم داخل كل فرصة: أي تنبيهات خاصة بها فقط
  core.registerDetailSection((d)=>{
    const oppId = core.openDetailId;
    const all = computeAlerts(core);
    const mine = all.filter(a=>a.oppId===oppId);
    if(!mine.length) return '';
    return `
    <div class="section">
      <h3>🔔 ${core.T('تنبيهات هذه الفرصة','Alerts for this Opportunity')}</h3>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${mine.map(a=>`<div style="padding:8px 10px; border-radius:8px; font-size:12px; background:${a.severity==='high'?'var(--bad-soft, rgba(239,68,68,.1))':a.severity==='medium'?'var(--warn-soft, rgba(245,158,11,.1))':'var(--surface-2)'}; border:1px solid ${a.severity==='high'?'var(--bad)':a.severity==='medium'?'#f59e0b':'var(--border)'};">
          <b>${a.severity==='high'?'🔴':a.severity==='medium'?'🟡':'⚪'} ${core.esc(a.kind)}</b> — ${core.esc(a.message)}
        </div>`).join('')}
      </div>
    </div>`;
  });
}

export { computeAlerts };
