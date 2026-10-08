'use strict';
// Deployment contains only functions/. Copy canonical source; never maintain parallel economics.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const out = path.resolve(__dirname, '../generated');
const files = [
  'src/domain/financial/financial-context.js',
  'src/domain/financial/financial-engine.js',
  'src/domain/financial/max-acquisition-price.js',
  'src/domain/ic/ic-readiness-engine.js',
  'src/domain/due-diligence/dd-engine.js',
  'src/domain/data-quality/data-quality-engine.js',
  'src/domain/evidence/evidence-engine.js',
  'src/domain/planning/planning-engine.js',
  'src/features/ic-decision-gate.js',
  // 3A-3: the SAME validation + classification code the browser runs. One source, no second implementation.
  'src/domain/validation/input-validation-engine.js',
  'src/domain/validation/debt-coverage.js',
  'src/domain/validation/risk-classification.js',
  'src/domain/validation/document-canonical.js',
];
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const payload = { 'package.json': '{"type":"module","private":true}\n' };
for (const file of files) payload[file] = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
// 3A-3: the server's document canonicalisation is DERIVED from the same source file the browser imports (CommonJS form,
// needed because documentHash is synchronous and Cloud Functions runs Node 20). Pure text transform; drift fails --check.
payload['document-canonical.cjs'] = "'use strict';\n// GENERATED from src/domain/validation/document-canonical.js by functions/scripts/build-domain.cjs — do not edit.\n"
  + payload['src/domain/validation/document-canonical.js'].replace(/^export function /gm, 'function ')
  + '\nmodule.exports = { canonicalDocValue, canonicalDocJson, omitCanonicalPaths };\n';
const hashes = Object.fromEntries(Object.keys(payload).sort().map(f => [f, hash(payload[f])]));
payload['manifest.json'] = JSON.stringify({ schema: 1, engineVersion: hash(JSON.stringify(hashes)), files: hashes }, null, 2) + '\n';
const checking = process.argv.includes('--check');
// A leftover/unknown file under generated/ is also drift (it could be imported by mistake or hide a stale module).
function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]);
}
if (checking) {
  const extra = listFiles(out).filter(f => !(f in payload));
  if (extra.length) throw new Error(`Unexpected file(s) in generated bundle: ${extra.join(', ')}. Run npm --prefix functions run build:domain.`);
}
for (const [file, contents] of Object.entries(payload)) {
  const dest = path.join(out, file);
  if (checking) {
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n') !== contents) {
      throw new Error(`Stale domain bundle: ${file}. Run npm --prefix functions run build:domain.`);
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contents);
  }
}
console.log(`Canonical domain bundle ${process.argv.includes('--check') ? 'verified' : 'built'}: ${hashes[files[0]].slice(0, 12)}`);
