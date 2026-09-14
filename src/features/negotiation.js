/* =========================================================================
   التفاوض — Negotiation Tracker (Phase 2، النظام الثاني)
   ---------------------------------------------------------------------------
   خمسة أسعار مرجعية دائماً ظاهرة معاً: سعر طلب البائع (Asking) / السعر
   المُدخَل حالياً في التسعير (Underwritten = land.price) / السعر المستهدف
   (Target، تقدير المحلل) / الحد الأقصى (Maximum، من max-acquisition-price.js)
   / سعر الانسحاب (Walk-away — افتراضياً = الحد الأقصى، قابل للتخصيص يدوياً
   لو أراد المحلل هامش أمان إضافي). سجل جولات تفاوض (عرض/عرض مضاد/نهائي) مع
   إعادة حساب فورية للعائد المتوقع عند كل سعر مسجَّل (Automatic Feasibility
   Recalculation) عبر core.compute() نفسه.
   لا تعديل على منطق core.js الداخلي — فقط عبر نقاط التوسّع المُصدَّرة.
   ========================================================================= */

import { maxAcquisitionPrice } from './max-acquisition-price.js';

const ROUND_STATUSES = [
  { key:'offer',    ar:'عرض',        en:'Offer' },
  { key:'counter',  ar:'عرض مضاد',   en:'Counter-offer' },
  { key:'final',    ar:'عرض نهائي',  en:'Final Offer' },
  { key:'accepted', ar:'مقبول',      en:'Accepted' },
  { key:'rejected', ar:'مرفوض',      en:'Rejected' },
];
const STATUS_BY_KEY = Object.fromEntries(ROUND_STATUSES.map(s=>[s.key,s]));
const PARTIES = [
  { key:'us',     ar:'نحن',    en:'Us' },
  { key:'seller', ar:'البائع', en:'Seller' },
];

function irrAt(core, d, price){
  const trial = JSON.parse(JSON.stringify(d));
  trial.land.price = price;
  try{ return core.compute(trial).equityIRR; }catch(e){ return null; }
}

export function registerNegotiation(core){
  core.registerOpportunitySchemaExtender(()=>({
    negotiation: { askingPrice: null, targetPrice: null, walkAwayPrice: null, history: [] },
  }));

  core.registerDetailSection((d, c)=>{
    const oppId = core.openDetailId;
    const rec = core.opportunities.find(o=>o.id===oppId);
    if(!rec) return '';
    const canEdit = core.canEditOpp(rec);
    const neg = d.negotiation || { askingPrice:null, targetPrice:null, walkAwayPrice:null, history:[] };
    const targetIRR = d.criteria.irrMin || 0.15;
    const mapRes = maxAcquisitionPrice(core, d, targetIRR);
    const walkAway = neg.walkAwayPrice!=null ? neg.walkAwayPrice : mapRes.maxPrice;

    const priceRow = (label, val, opts)=>{
      opts = opts||{};
      const priceHtml = `<div class="k">${label}</div><div class="v">${val==null? '—' : `${core.fmtSAR(val)}/م²`}</div>`;
      const irrHtml = (val!=null && opts.irr!=null)? `<div class="k">Equity IRR (${label})</div><div class="v">${core.fmtPct(opts.irr)}</div>` : '';
      return priceHtml + irrHtml;
    };

    return `
    <div class="section">
      <h3>🤝 ${core.T('التفاوض','Negotiation')} <span style="color:var(--ink-faint); font-weight:500; font-size:12px;">(Negotiation Tracker)</span></h3>
      <div class="kv" style="margin-bottom:12px;">
        ${priceRow(core.T('سعر طلب البائع','Seller Asking Price'), neg.askingPrice, { irr: neg.askingPrice!=null? irrAt(core,d,neg.askingPrice): null })}
        ${priceRow(core.T('السعر المُدخَل حالياً','Currently Underwritten'), d.land.price, { irr: c.equityIRR })}
        ${priceRow(core.T('السعر المستهدف','Target Price'), neg.targetPrice, { irr: neg.targetPrice!=null? irrAt(core,d,neg.targetPrice): null })}
        ${priceRow(core.T('الحد الأقصى المسموح به','Maximum Acquisition Price'), mapRes.infeasible? null : mapRes.maxPrice, { irr: mapRes.infeasible? null : targetIRR })}
        <div class="k">${core.T('سعر الانسحاب','Walk-away Price')}</div><div class="v"><b style="color:var(--bad);">${walkAway==null?'—':core.fmtSAR(walkAway)+'/م²'}</b>${neg.walkAwayPrice==null? ` <span style="color:var(--ink-faint); font-size:11px;">(${core.T('افتراضي = الحد الأقصى','default = Maximum')})</span>` : ''}</div>
      </div>

      ${neg.history.length? `
      <div class="tablewrap" style="margin-bottom:12px;"><table class="db" style="font-size:11.5px;">
        <thead><tr><th>${core.T('التاريخ','Date')}</th><th>${core.T('الطرف','Party')}</th><th>${core.T('السعر','Price')}</th><th>${core.T('الحالة','Status')}</th><th>${core.T('الشروط','Terms')}</th><th>Equity IRR ${core.T('عند هذا السعر','at this price')}</th></tr></thead>
        <tbody>
          ${neg.history.map(h=>{
            const st = STATUS_BY_KEY[h.status]||STATUS_BY_KEY.offer;
            const party = PARTIES.find(p=>p.key===h.party) || PARTIES[0];
            const irr = h.price!=null? irrAt(core,d,h.price) : null;
            return `<tr>
              <td class="mono">${core.esc(h.date||'')}</td>
              <td>${core.T(party.ar,party.en)}</td>
              <td class="num">${core.fmtSAR(h.price)}/م²</td>
              <td><span class="tag" style="font-size:10px;">${core.T(st.ar,st.en)}</span></td>
              <td style="font-size:11px;">${core.esc(h.terms||'—')}</td>
              <td class="num" style="color:${irr!=null && irr>=targetIRR?'var(--good)':'var(--bad)'};">${irr!=null? core.fmtPct(irr) : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>` : ''}

      ${canEdit? `
      <div style="background:var(--surface-2); border:1px dashed var(--border); border-radius:10px; padding:12px;">
        <p class="step-sub" style="margin:0 0 10px;">${core.T('تحديث الأسعار المرجعية','Update reference prices')}</p>
        <form data-neg-prices-form="${oppId}" style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
          <input type="number" name="askingPrice" placeholder="${core.T('سعر طلب البائع','Asking price')}" value="${neg.askingPrice!=null?neg.askingPrice:''}" style="flex:1; min-width:120px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
          <input type="number" name="targetPrice" placeholder="${core.T('السعر المستهدف','Target price')}" value="${neg.targetPrice!=null?neg.targetPrice:''}" style="flex:1; min-width:120px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
          <input type="number" name="walkAwayPrice" placeholder="${core.T('سعر الانسحاب (اختياري)','Walk-away (optional)')}" value="${neg.walkAwayPrice!=null?neg.walkAwayPrice:''}" style="flex:1; min-width:120px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
          <button type="button" class="btn btn-sm" data-action="neg-save-prices" data-id="${oppId}">💾 ${core.T('حفظ','Save')}</button>
        </form>
        <p class="step-sub" style="margin:0 0 10px;">${core.T('تسجيل جولة تفاوض جديدة','Record a new negotiation round')}</p>
        <form data-neg-round-form="${oppId}" style="display:flex; gap:8px; flex-wrap:wrap;">
          <input type="date" name="date" value="${core.todayStr()}" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
          <select name="party" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
            ${PARTIES.map(p=>`<option value="${p.key}">${core.T(p.ar,p.en)}</option>`).join('')}
          </select>
          <input type="number" name="price" placeholder="${core.T('السعر/م²','Price/m²')}" style="min-width:110px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
          <select name="status" style="padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
            ${ROUND_STATUSES.map(s=>`<option value="${s.key}">${core.T(s.ar,s.en)}</option>`).join('')}
          </select>
          <input type="text" name="terms" placeholder="${core.T('شروط إضافية (اختياري)','Additional terms (optional)')}" style="flex:1; min-width:150px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--ink); font-family:inherit; font-size:12.5px;">
          <button type="button" class="btn btn-sm btn-primary" data-action="neg-add-round" data-id="${oppId}">➕ ${core.T('إضافة','Add')}</button>
        </form>
      </div>` : ''}
    </div>`;
  });

  core.registerActionHandler(async (action, el)=>{
    if(action==='neg-save-prices'){
      const oppId = el.dataset.id;
      const form = document.querySelector(`form[data-neg-prices-form="${oppId}"]`);
      const rec = core.opportunities.find(o=>o.id===oppId);
      if(!form || !rec || !core.canEditOpp(rec)) return true;
      const num = (name)=>{ const v = form.querySelector(`[name="${name}"]`).value; return v===''? null : Number(v); };

      const draft = core.withDefaults(rec.data);
      draft.negotiation.askingPrice = num('askingPrice');
      draft.negotiation.targetPrice = num('targetPrice');
      draft.negotiation.walkAwayPrice = num('walkAwayPrice');
      draft.meta.updatedAt = core.todayStr();
      draft.meta.updatedBy = core.currentUser ? core.currentUser.email : (draft.meta.updatedBy||null);

      await core.persistOpportunity({ id: oppId, data: draft });
      await core.loadAll();
      core.render();
      return true;
    }
    if(action==='neg-add-round'){
      const oppId = el.dataset.id;
      const form = document.querySelector(`form[data-neg-round-form="${oppId}"]`);
      const rec = core.opportunities.find(o=>o.id===oppId);
      if(!form || !rec || !core.canEditOpp(rec)) return true;
      const price = Number(form.querySelector('[name="price"]').value);
      if(!price || price<=0) return true;

      const draft = core.withDefaults(rec.data);
      draft.negotiation.history = (draft.negotiation.history||[]).concat([{
        date: form.querySelector('[name="date"]').value || core.todayStr(),
        party: form.querySelector('[name="party"]').value,
        price,
        status: form.querySelector('[name="status"]').value,
        terms: form.querySelector('[name="terms"]').value.trim(),
      }]);
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
