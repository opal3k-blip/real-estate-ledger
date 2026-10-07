/* Phase 3A-3 — dry-run report (read-only). Shows what the canonical server/client classification
   would say about a set of opportunities BEFORE the new limits are relied on.
   Usage:
     node scripts/validation-dry-run.mjs                      # the 34 reference fixtures
     node scripts/validation-dry-run.mjs export.json [more]   # your own export
   Accepted shapes: [ {data:{...}} | {...} ], { id: {data|input|d|...} }, or Firestore-export style
   { opportunities: [...] }. Nothing is written anywhere. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadCore } = await import(path.join(root, 'tests/domain/core-vm-harness.mjs'));
const { classifyOpportunity, COMPOUND_WARNING_THRESHOLD } = await import(path.join(root, 'src/domain/validation/risk-classification.js'));

const NEW_RULE_CODES = new Set(['ABOVE_MAX', 'BELOW_MIN', 'NUMERIC_STRING']);
const C = loadCore(['opportunities']);

function pick(v) { return v && (v.input || v.d || v.data || v); }
function load(files) {
  const out = [];
  if (!files.length) {
    for (const f of ['tests/domain/financial-golden-master.json', 'tests/domain/financing-baseline.json']) {
      const j = JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')).fixtures;
      for (const [k, v] of Object.entries(j)) out.push([k, pick(v)]);
    }
    return out;
  }
  for (const f of files) {
    let j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (j && !Array.isArray(j) && Array.isArray(j.opportunities)) j = j.opportunities;
    if (Array.isArray(j)) j.forEach((v, i) => out.push([(v && (v.id || (v.meta && v.meta.id))) || `${path.basename(f)}#${i}`, pick(v)]));
    else Object.entries(j).forEach(([k, v]) => out.push([k, pick(v)]));
  }
  return out;
}

const rows = load(process.argv.slice(2)).map(([id, input]) => {
  let cls;
  try {
    const d = C.withDefaults(JSON.parse(JSON.stringify(input)));
    cls = classifyOpportunity(d, C.compute(d));
  } catch (e) { cls = { status: 'ERROR', color: 'red', blocked: true, error: String(e.message || e), issueCodes: [], highRisk: { reasons: [] }, compound: { count: 0 } }; }
  return { id, cls };
});

const by = (f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
console.log(`Opportunities: ${rows.length}`);
console.log('By status :', JSON.stringify(by((r) => r.cls.status)));
console.log('By colour :', JSON.stringify(by((r) => r.cls.color)));
console.log('Blocked   :', rows.filter((r) => r.cls.blocked).map((r) => r.id).join(', ') || 'none');
const newly = rows.filter((r) => r.cls.issueCodes.some((i) => NEW_RULE_CODES.has(i.code)));
console.log('Hit by 3A-3 limits (ABOVE_MAX / BELOW_MIN / NUMERIC_STRING):', newly.length ? newly.map((r) => `${r.id}[${r.cls.issueCodes.filter((i) => NEW_RULE_CODES.has(i.code)).map((i) => i.path + ':' + i.code).join(',')}]`).join('; ') : 'none');
console.log(`\nCompound financial high-risk reasons per opportunity (threshold now ${COMPOUND_WARNING_THRESHOLD}):`);
const dist = by((r) => r.cls.compound.count);
console.log('  count -> opportunities :', JSON.stringify(dist));
for (const th of [1, 2, 3, 4]) {
  const hit = rows.filter((r) => !r.cls.blocked && r.cls.highRisk.reasons.length >= th);
  console.log(`  threshold >= ${th}: ${hit.length} need acknowledgement${hit.length ? ' -> ' + hit.map((r) => r.id).join(', ') : ''}`);
}
const withReasons = rows.filter((r) => r.cls.highRisk.reasons.length);
console.log('\nHigh-risk reasons (not blocked or blocked):');
withReasons.forEach((r) => console.log(`  ${r.id} [${r.cls.color}] ${r.cls.highRisk.reasons.map((x) => x.code + (x.path && x.path !== 'debtService' ? ':' + x.path : '')).join(' + ')}`));
