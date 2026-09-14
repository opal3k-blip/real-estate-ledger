/* Institutional Hardening 2 — governance, IC decision ledger, variance, financing/VAT transparency. */
const IC_COLLECTION='icDecisions';

let _ihCoreRef=null;
function pct(v){ if(v==null||!isFinite(v)) return '—'; const n=(v*100).toFixed(1); return (_ihCoreRef&&_ihCoreRef.LANG==='en')? n+'%' : '%'+n; }
function num(v){ return v==null||!isFinite(v)?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:0}); }

export function registerInstitutionalHardening(core){
  _ihCoreRef = core;
  core.registerDataCollection(IC_COLLECTION);
  core.registerOpportunitySchemaExtender(()=>({
    capitalAllocation:{targetEquity:null,maxAllocation:null,priority:'normal',committeeNote:''},
  }));
  core.registerWizardStepExtra(8,(d)=>`
    <div style="margin-top:14px;padding:12px;border:1px dashed var(--border);border-radius:10px;">
      <p class="step-sub" style="margin:0 0 8px;">${core.T('التحصين المالي — توزيع سحب دين الإنشاء وVAT','Financial hardening — construction draw & VAT')}</p>
      <div class="grid3">
        <div class="field span2"><label><span>${core.T('توزيع سحب الدين على سنوات الإنشاء','Debt draw profile by construction year')}</span></label>
          <input type="text" data-hardening-draw="1" value="${(d.financing.drawSchedulePct||[]).map(x=>Number(x*100).toFixed(1)).join(', ')}" placeholder="مثال: 20, 40, 40">
          <div class="hint">${core.T('اتركه فارغاً لاستخدام الرصيد الكامل. أدخل نسباً مجموعها 100% مثل 20,40,40. تُطبّق الفائدة على متوسط الرصيد السنوي.','Leave blank for legacy full-balance behavior. Enter percentages summing to 100%, e.g. 20,40,40. Interest is charged on average annual outstanding balance.')}</div>
        </div>
        <div class="field"><label><span>${core.T('نسبة استرداد VAT للمدخلات','Input VAT recovery')}</span></label><div class="suffix-wrap"><input type="number" name="vat.inputRecoveryPct" data-pct="1" value="${((d.vat.inputRecoveryPct==null?1:d.vat.inputRecoveryPct)*100).toFixed(0)}" step="1"><span class="suffix">%</span></div></div>
        <div class="field"><label><span>${core.T('تأخير استرداد VAT','VAT refund lag')}</span></label><div class="suffix-wrap"><input type="number" name="vat.refundLagYears" value="${Number(d.vat.refundLagYears||0)}" step="1"><span class="suffix">${core.T('سنة','yr')}</span></div></div>
      </div>
    </div>`);
  core.registerBeforeOpportunitySave(async(oldData,newData)=>{
    // Parse the wizard-only draw profile if present; harmless when saving from other surfaces.
    try{
      const el=document.querySelector('[data-hardening-draw="1"]');
      if(el && newData.financing){
        const vals=String(el.value||'').split(',').map(x=>parseFloat(x.trim())/100).filter(x=>isFinite(x)&&x>=0);
        newData.financing.drawSchedulePct=vals;
      }
    }catch(e){}
  });


  core.registerDetailSection((d,c)=>{
    const oppId=core.openDetailId;
    const latest=(d.ic&&d.ic.decisions&&d.ic.decisions.length)?d.ic.decisions[d.ic.decisions.length-1]:null;
    const icRows=(core.STORE?.[IC_COLLECTION]||[]).filter(x=>x.data.oppId===oppId).sort((a,b)=>String(a.data.recordedAt).localeCompare(String(b.data.recordedAt)));
    const versions=(core.STORE?.underwritingVersions||[]).filter(x=>x.data.oppId===oppId).sort((a,b)=>String(b.data.savedAt).localeCompare(String(a.data.savedAt)));
    const snap=versions[0]?.data?.metrics||null;
    const actual=d.actuals||{};
    const variance=(actual.enabled&&actual.actualEquityIRR!=null&&snap&&snap.equityIRR!=null)?actual.actualEquityIRR-snap.equityIRR:null;
    const gate=(()=>{try{return core.compute(d,'base')}catch(e){return null;}})();
    const draw=(gate&&gate.drawSchedule)||null;
    const drawText=draw?draw.map((x,i)=>`Y${i+1}: ${pct(x)}`).join(' · '):'Full balance / legacy';
    return `<div class="section">
      <h3>🏛️ ${core.T('التحصين المؤسسي — المرحلة الثانية','Institutional Hardening — Stage 2')}</h3>
      <div class="grid3">
        <div class="kpi"><div class="l">${core.T('سجل قرارات اللجنة','IC decision ledger')}</div><div class="v">${icRows.length}</div></div>
        <div class="kpi"><div class="l">${core.T('آخر قرار','Latest decision')}</div><div class="v" style="font-size:15px;">${latest?core.esc(latest.decision):'—'}</div></div>
        <div class="kpi"><div class="l">${core.T('Variance مقابل آخر Snapshot','Variance vs latest snapshot')}</div><div class="v" style="font-size:15px;">${variance==null?'—':(variance>=0?'+':'')+pct(variance)}</div></div>
      </div>
      <div style="margin-top:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;">
        <div style="padding:10px;border:1px solid var(--border);border-radius:9px;"><b>${core.T('تمويل الإنشاء — Draw Profile','Construction financing — draw profile')}</b><div class="note">${core.esc(drawText)}</div></div>
        <div style="padding:10px;border:1px solid var(--border);border-radius:9px;"><b>${core.T('VAT Input Recovery','VAT Input Recovery')}</b><div class="note">${gate&&gate.vatInputTotal!=null?num(gate.vatInputTotal)+' SAR · '+pct(gate.vatRecoveryPct):'—'}</div></div>
        <div style="padding:10px;border:1px solid var(--border);border-radius:9px;"><b>${core.T('VAT Irrecoverable','VAT غير مسترد')}</b><div class="note">${gate&&gate.vatIrrecoverableUpfront!=null?num(gate.vatIrrecoverableUpfront)+' SAR':'—'}</div></div>
      </div>
      ${icRows.length?`<div class="tablewrap" style="margin-top:12px;"><table class="db"><thead><tr><th>${core.T('التاريخ','Date')}</th><th>${core.T('القرار','Decision')}</th><th>${core.T('المنفذ','Actor')}</th><th>${core.T('تجاوز','Override')}</th></tr></thead><tbody>${icRows.map(r=>`<tr><td>${core.esc(String(r.data.recordedAt||'').slice(0,10))}</td><td>${core.esc(r.data.decision?.decision||'—')}</td><td>${core.esc(r.data.recordedBy||'—')}</td><td>${r.data.decision?.overridden?'⚠️ Yes':'No'}</td></tr>`).join('')}</tbody></table></div>`:''}
      <p class="note" style="margin-top:10px;">${core.T('هذه الطبقة تفصل سجل قرار اللجنة عن وثيقة الفرصة، وتعرض أثر الـDraw Profile والـVAT واستيعاب الفعلي مقابل آخر اكتتاب مجمّد. سجل قرارات اللجنة غير قابل للتعديل أو الحذف في Firestore.','This layer separates the IC decision ledger from the opportunity document and exposes draw-profile, VAT and actual-vs-frozen-underwriting controls. IC decision records are immutable in Firestore.')}</p>
    </div>`;
  });
}
