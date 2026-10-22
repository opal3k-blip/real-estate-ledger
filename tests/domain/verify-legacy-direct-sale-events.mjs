import coreVmSource from '../helpers/core-vm-source.cjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import { buildTimingFixtures } from './timing-fixtures.mjs';
import {
  FINANCIAL_EVENT_TYPES,
  eventEffects,
} from '../../src/domain/financial/dated/financial-event.js';
import { generateLegacyDirectSaleTimingEvents } from '../../src/domain/financial/dated/legacy-direct-sale-events.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.join(__dirname,'..','..');
const ACQUISITION_DATE='2026-01-01';
const TOL=1e-7;
function near(a,b,tol=TOL){ return Math.abs(a-b)<=tol*Math.max(1,Math.abs(a),Math.abs(b)); }

function loadCore(){
  let code=coreVmSource.buildCoreVmSource();
  const ctx={
    console,setTimeout,clearTimeout,
    localStorage:{getItem(){return null;},setItem(){}},
    document:{documentElement:{lang:'ar'},querySelector(){return null;},addEventListener(){},getElementById(){return null;},querySelectorAll(){return [];},body:{},createElement(){return {};}},
    window:{},Notification:undefined,navigator:{},URL,FileReader:function(){},Intl,Math,JSON,Date,parseFloat,parseInt,isFinite,Number,String,Array,Object,
  };
  ctx.window=ctx;
  vm.createContext(ctx);
  vm.runInContext(code,ctx,{timeout:20000});
  return ctx.__C;
}

function clone(v){ return JSON.parse(JSON.stringify(v)); }
function cashAt(arr,year){ return Number(arr?.[year]||0); }
function eventCashByYear(events,totalYears,deferredYear){
  const out={};
  for(let y=0;y<=Math.max(totalYears,deferredYear||0);y++) out[y]={project:0,equity:0};
  for(const e of events){
    const year=Math.round(Number(e.metadata?.legacyYear));
    const fx=eventEffects(e);
    out[year]??={project:0,equity:0};
    out[year].project+=fx.projectCash;
    out[year].equity+=fx.equityCash;
  }
  return out;
}

const C=loadCore();
const fixture=buildTimingFixtures(C).find(x=>x.id==='T19-direct-sale-bank-lag2');
assert(fixture,'missing T19 direct-sale timing fixture');
const split=C.compute(fixture.input,fixture.scenarioKey);
assert.equal(split.isDirectSaleSplit,true);
assert.equal(split.directSaleDeferredYear,split.totalYears+2);
assert(split.directSaleDeferredAmt>0);

const controlInput=clone(fixture.input);
controlInput.strategy.directSale.bankFinancedPct=0;
const control=C.compute(controlInput,fixture.scenarioKey);
assert.equal(control.isDirectSaleSplit,false);

const shadow=generateLegacyDirectSaleTimingEvents(fixture.input,split,{acquisitionDate:ACQUISITION_DATE});
assert.equal(shadow.events.length,2);
assert.equal(shadow.events[0].type,FINANCIAL_EVENT_TYPES.DIRECT_SALE_DEFERRAL);
assert.equal(shadow.events[1].type,FINANCIAL_EVENT_TYPES.DIRECT_SALE_COLLECTION);
assert(near(shadow.events[0].amount,split.directSaleDeferredAmt));
assert(near(shadow.events[1].amount,split.directSaleDeferredAmt));
assert.equal(shadow.reconciliation.findings.length,0);
assert(near(shadow.reconciliation.projectTimingNet,0));
assert(near(shadow.reconciliation.equityTimingNet,0));

const byYear=eventCashByYear(shadow.events,split.totalYears,split.directSaleDeferredYear);
for(let y=0;y<=split.directSaleDeferredYear;y++){
  const projectDelta=cashAt(split.projectCF,y)-cashAt(control.projectCF,y);
  const equityDelta=cashAt(split.equityCF,y)-cashAt(control.equityCF,y);
  assert(near(byYear[y]?.project||0,projectDelta),`project timing delta mismatch in year ${y}`);
  assert(near(byYear[y]?.equity||0,equityDelta),`equity timing delta mismatch in year ${y}`);
}

// Zero-lag mode creates a same-date deferral/collection pair and therefore has
// no net annual timing effect, exactly matching current core.js semantics.
const zeroLagInput=clone(fixture.input);
zeroLagInput.strategy.directSale.collectionLagYears=0;
const zeroLag=C.compute(zeroLagInput,fixture.scenarioKey);
assert.equal(zeroLag.isDirectSaleSplit,true);
assert.equal(zeroLag.directSaleDeferredYear,zeroLag.totalYears);
const zeroShadow=generateLegacyDirectSaleTimingEvents(zeroLagInput,zeroLag,{acquisitionDate:ACQUISITION_DATE,scope:'legacy-direct-sale-zero-lag'});
assert.equal(zeroShadow.events.length,2);
assert.equal(zeroShadow.events[0].date,zeroShadow.events[1].date);
assert(near(zeroShadow.reconciliation.projectTimingNet,0));
assert(near(zeroShadow.reconciliation.equityTimingNet,0));

console.table([{
  id:fixture.id,
  terminalYear:split.totalYears,
  deferredYear:split.directSaleDeferredYear,
  bankFinancedPct:fixture.input.strategy.directSale.bankFinancedPct,
  deferredAmount:split.directSaleDeferredAmt,
}]);
console.log('PASS verify-legacy-direct-sale-events: deferred buyer-bank collection timing reconciles to current core.js, including zero-lag neutrality.');
