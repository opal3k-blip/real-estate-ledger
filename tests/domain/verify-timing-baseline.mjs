import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import { buildTimingFixtures } from './timing-fixtures.mjs';
import { buildLegacyAnnualTimeline } from '../../src/domain/financial/dated/timeline.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.join(__dirname,'..','..');
const expected=JSON.parse(fs.readFileSync(path.join(__dirname,'timing-baseline.json'),'utf8'));

function loadCore(){
  let code=fs.readFileSync(path.join(ROOT,'src/core.js'),'utf8');
  code=code.replace(/export\s*\{/,'globalThis.__C = {');
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

function timingFacts(c){
  const timeline=buildLegacyAnnualTimeline({acquisitionDate:expected.acquisitionDate,totalYears:c.totalYears});
  const facts={
    totalYears:c.totalYears,
    constructionYears:c.constructionYears,
    operationYears:c.operationYears,
    holdStrategy:c.holdStrategy,
    isOffPlanSale:c.isOffPlanSale,
    isSubdivisionPhased:c.isSubdivisionPhased,
    isPhasedSaleMode:c.isPhasedSaleMode,
    drawSchedule:c.drawSchedule,
    vatWorkingCapitalRefundLagYears:c.vatWorkingCapitalRefundLagYears,
    directSaleDeferredYear:c.directSaleDeferredYear,
    directSaleDeferredAmt:c.directSaleDeferredAmt,
    timeline:{t0:timeline.t0,yearEnds:[...timeline.yearEnds],yearMidpoints:[...timeline.yearMidpoints]},
    offPlanSchedule:c.offPlanSchedule,
    absorptionSchedule:c.absorptionSchedule,
    projectCF:c.projectCF,
    equityCF:c.equityCF,
    pnlRows:c.pnlRows.map(r=>({yr:r.yr,phase:r.phase,isExitYear:r.isExitYear,interestExpense:r.interestExpense,principalPayment:r.principalPayment,debtPayoffAtExit:r.debtPayoffAtExit,exitValue:r.exitValue})),
  };
  // core.js is executed in a vm realm; normalize prototypes before literal comparison.
  return JSON.parse(JSON.stringify(facts));
}

assert.equal(expected.schemaVersion,'3B1-RECOVERY-V1');
const C=loadCore();
const fixtures=buildTimingFixtures(C);
assert.equal(fixtures.length,20);
assert.equal(expected.fixtureCount,20);
let pass=0;
for(const f of fixtures){
  const frozen=expected.fixtures[f.id];
  assert(frozen,`${f.id}: missing frozen baseline`);
  assert.equal(frozen.label,f.label,`${f.id}: label drift`);
  assert.equal(frozen.datedCoverage,f.datedCoverage,`${f.id}: coverage classification drift`);
  assert.notEqual(f.datedCoverage,'BASELINE_ONLY',`${f.id}: Phase 3B closure cannot retain BASELINE_ONLY fixtures`);
  const actual=timingFacts(C.compute(f.input,f.scenarioKey));
  assert.deepEqual(actual,frozen.timing,`${f.id}: timing baseline drift`);
  const cashHorizon=Math.max(actual.totalYears,actual.directSaleDeferredYear??actual.totalYears);
  assert.equal(actual.projectCF.length,cashHorizon+1,`${f.id}: projectCF horizon mismatch`);
  assert.equal(actual.equityCF.length,cashHorizon+1,`${f.id}: equityCF horizon mismatch`);
  assert.equal(actual.pnlRows.length,actual.totalYears,`${f.id}: pnl horizon mismatch`);
  assert.equal(actual.timeline.yearEnds.length,actual.totalYears,`${f.id}: dated timeline horizon mismatch`);
  pass++;
  console.log(`OK  ${f.id}: timing matches frozen recovery baseline.`);
}
console.log(`\n${pass}/${fixtures.length} fixtures: Phase 3B-1 recovery timing baseline matches current core.js exactly.`);
