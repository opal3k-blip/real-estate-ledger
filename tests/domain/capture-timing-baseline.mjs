import coreVmSource from '../helpers/core-vm-source.cjs';
/* Phase 3B-1 recovery — freeze the current annual timing semantics of src/core.js.
   This creates a deterministic artifact used by verify-timing-baseline.mjs. */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import vm from 'vm';
import { buildTimingFixtures } from './timing-fixtures.mjs';
import { buildLegacyAnnualTimeline } from '../../src/domain/financial/dated/timeline.js';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.join(__dirname,'..','..');
const ACQUISITION_DATE='2026-01-01';

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

function timingFacts(c){
  const timeline=buildLegacyAnnualTimeline({acquisitionDate:ACQUISITION_DATE,totalYears:c.totalYears});
  return {
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
    pnlRows:c.pnlRows.map(r=>({
      yr:r.yr,phase:r.phase,isExitYear:r.isExitYear,
      interestExpense:r.interestExpense,principalPayment:r.principalPayment,
      debtPayoffAtExit:r.debtPayoffAtExit,exitValue:r.exitValue,
    })),
  };
}

const C=loadCore();
const fixtures=buildTimingFixtures(C);
const out={schemaVersion:'3B1-RECOVERY-V1',acquisitionDate:ACQUISITION_DATE,fixtureCount:fixtures.length,fixtures:{}};
for(const f of fixtures){
  const c=C.compute(f.input,f.scenarioKey);
  out.fixtures[f.id]={label:f.label,datedCoverage:f.datedCoverage,timing:timingFacts(c)};
}
const outPath=path.join(__dirname,'timing-baseline.json');
fs.writeFileSync(outPath,JSON.stringify(out,null,2)+'\n');
console.log(`Timing baseline written: ${path.relative(ROOT,outPath)} (${fixtures.length} fixtures)`);
