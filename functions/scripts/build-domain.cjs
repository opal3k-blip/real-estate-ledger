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
];
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const payload = { 'package.json': '{"type":"module","private":true}\n' };
for (const file of files) payload[file] = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const hashes = Object.fromEntries(Object.keys(payload).sort().map(f => [f, hash(payload[f])]));
payload['manifest.json'] = JSON.stringify({ schema: 1, engineVersion: hash(JSON.stringify(hashes)), files: hashes }, null, 2) + '\n';
for (const [file, contents] of Object.entries(payload)) {
  const dest = path.join(out, file);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n') !== contents) {
      throw new Error(`Stale domain bundle: ${file}. Run npm --prefix functions run build:domain.`);
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, contents);
  }
}
console.log(`Canonical domain bundle ${process.argv.includes('--check') ? 'verified' : 'built'}: ${hashes[files[0]].slice(0, 12)}`);
