import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCore, ROOT } from './core-vm-harness.mjs';
import { buildTimingFixtures } from './timing-fixtures.mjs';
import { deepSafe, projectFinancialResult } from './financial-golden-projection.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const C = loadCore();
const fixtures = buildTimingFixtures(C);

const baseline = {
  schemaVersion: 'PHASE_2R1_FINANCIAL_GOLDEN_MASTER_V1',
  authoritativeSource: 'src/core.js',
  note: 'Recovery baseline. Freezes current canonical legacy economics before shared-engine extraction; not claimed identical to lost historical Phase 2 commits.',
  fixtureCount: fixtures.length,
  fixtures: {}
};

for(const f of fixtures){
  const result = C.compute(f.input, f.scenarioKey);
  baseline.fixtures[f.id] = {
    label: f.label,
    datedCoverage: f.datedCoverage,
    scenarioKey: f.scenarioKey,
    input: deepSafe(f.input),
    expected: projectFinancialResult(result)
  };
}

const outPath = path.join(__dirname, 'financial-golden-master.json');
fs.writeFileSync(outPath, JSON.stringify(baseline, null, 2) + '\n');
console.log(`Financial Golden Master written: ${path.relative(ROOT, outPath)} (${fixtures.length} fixtures)`);
