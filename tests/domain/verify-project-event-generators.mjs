import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { generateLegacyProjectCostEvents } from '../../src/domain/financial/dated/legacy-project-events.js';
import { FINANCIAL_EVENT_TYPES } from '../../src/domain/financial/dated/financial-event.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.join(__dirname,'..','..');
let code=fs.readFileSync(path.join(ROOT,'src/core.js'),'utf8').replace(/export\s*\{/,'globalThis.__C = {');
const ctx={console,setTimeout,clearTimeout,localStorage:{getItem(){return null},setItem(){}},document:{documentElement:{lang:'ar'},querySelector(){return null},addEventListener(){},getElementById(){return null},querySelectorAll(){return[]},body:{},createElement(){return{}}},window:{},Notification:undefined,navigator:{},URL,FileReader:function(){},Intl,Math,JSON,Date,parseFloat,parseInt,isFinite,Number,String,Array,Object};ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx,{timeout:20000});
const C=ctx.__C;
const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'financing-baseline.json'),'utf8'));

let count=0;
for(const [id,f] of Object.entries(baseline.fixtures)){
  const input=JSON.parse(JSON.stringify(f.input));
  const c=C.compute(input,f.scenarioKey||'base');
  const r=generateLegacyProjectCostEvents(c,{acquisitionDate:'2026-01-01',scope:`fixture-${id}`});
  assert(Math.abs(r.reconciliation.delta)<1e-6,`${id}: t0 project cost decomposition must match TPC excluding VAT`);
  assert(r.events.every(e=>e.date==='2026-01-01'),`${id}: legacy costs must remain at t0; do not invent spend curve`);
  assert(!r.events.some(e=>e.type===FINANCIAL_EVENT_TYPES.EQUITY_CONTRIBUTION||e.type===FINANCIAL_EVENT_TYPES.DEBT_DRAW),`${id}: project-side generator must not add financing events`);
  count++;
}
console.log(`PASS verify-project-event-generators: ${count}/${count} fixtures; t0 legacy project cost decomposition reconciles without invented spend curve.`);
