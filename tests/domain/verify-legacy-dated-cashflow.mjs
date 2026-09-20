import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { buildTimingFixtures } from './timing-fixtures.mjs';
import { generateLegacyDatedCashflow } from '../../src/domain/financial/dated/legacy-dated-cashflow.js';
import { eventEffects } from '../../src/domain/financial/dated/financial-event.js';
import { legacyYearEndDate } from '../../src/domain/financial/dated/timeline.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.join(__dirname,'..','..');
let code=fs.readFileSync(path.join(ROOT,'src/core.js'),'utf8').replace(/export\s*\{/,'globalThis.__C = {');
const ctx={console,setTimeout,clearTimeout,localStorage:{getItem(){return null},setItem(){}},document:{documentElement:{lang:'ar'},querySelector(){return null},addEventListener(){},getElementById(){return null},querySelectorAll(){return[]},body:{},createElement(){return{}}},window:{},Notification:undefined,navigator:{},URL,FileReader:function(){},Intl,Math,JSON,Date,parseFloat,parseInt,isFinite,Number,String,Array,Object};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx,{timeout:20000});
const C=ctx.__C;
const acquisitionDate='2026-01-01';
const fixtures=buildTimingFixtures(C);
const near=(a,b)=>Math.abs(a-b)<=1e-6*Math.max(1,Math.abs(a),Math.abs(b));

function indexForDate(date,maxIndex){
  if(date===acquisitionDate) return 0;
  for(let i=1;i<=maxIndex;i++) if(date===legacyYearEndDate(acquisitionDate,i)) return i;
  throw new Error(`UNMAPPED_LEGACY_CASH_DATE:${date}`);
}

let pass=0;
const rows=[];
for(const f of fixtures){
  const input=JSON.parse(JSON.stringify(f.input));
  const c=C.compute(input,f.scenarioKey||'base');
  const out=generateLegacyDatedCashflow(input,c,{acquisitionDate,scope:`fixture-${f.id}`});

  const projectExpected=[...c.projectCF].map(Number);
  const projectActual=Array(projectExpected.length).fill(0);
  for(const e of out.project.events){
    const idx=indexForDate(e.date,projectExpected.length-1);
    projectActual[idx]+=eventEffects(e).projectCash;
  }
  assert.equal(projectActual.length,projectExpected.length,`${f.id}: project horizon mismatch`);
  projectExpected.forEach((v,i)=>assert(near(projectActual[i],v),`${f.id}: projectCF[${i}] mismatch actual=${projectActual[i]} expected=${v}`));

  const investorExpected=[...out.investor.series].map(Number);
  const investorActual=Array(investorExpected.length).fill(0);
  for(const e of out.investor.events){
    const idx=indexForDate(e.date,investorExpected.length-1);
    investorActual[idx]+=eventEffects(e).equityCash;
  }
  investorExpected.forEach((v,i)=>assert(near(investorActual[i],v),`${f.id}: investorCF[${i}] mismatch actual=${investorActual[i]} expected=${v}`));

  const projectDelta=projectActual.reduce((a,v,i)=>a+(v-projectExpected[i]),0);
  const investorDelta=investorActual.reduce((a,v,i)=>a+(v-investorExpected[i]),0);
  rows.push({id:f.id,projectEvents:out.project.events.length,investorEvents:out.investor.events.length,investorBasis:out.investor.basis,projectDelta,investorDelta});
  pass++;
}
console.table(rows);
console.log(`PASS verify-legacy-dated-cashflow: ${pass}/${fixtures.length} fixtures reconcile both project cash and investor cash to current core.js.`);
