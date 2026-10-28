'use strict';
// Review comment #1 (trusted-ic.cjs): what the domain-bundle check does and does NOT guarantee.
//   Guaranteed (integrity / drift): every module the IC decision path executes must be listed in the manifest with a
//   matching hash, and the manifest's engineVersion must match its own table. Deleting an entry (even with
//   engineVersion recomputed) is refused; document-canonical.cjs (which computes documentHash) is verified before use.
//   NOT guaranteed (authenticity): someone who can rewrite the deployed bundle can rewrite a file AND its manifest hash.
//   That needs an anchor outside the bundle; see the last test, which pins today's limit so it cannot be forgotten.
// TRUSTED_IC_FILE lets the same tests run against another copy of trusted-ic.cjs (e.g. the pre-fix file).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const SRC_FN = path.join(__dirname, '..');
const TRUSTED = process.env.TRUSTED_IC_FILE ? path.resolve(process.env.TRUSTED_IC_FILE) : path.join(SRC_FN, 'trusted-ic.cjs');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
let passed = 0;
let failed = 0;

function freshCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trusted-ic-bundle-'));
  fs.copyFileSync(TRUSTED, path.join(dir, 'trusted-ic.cjs'));
  fs.cpSync(path.join(SRC_FN, 'generated'), path.join(dir, 'generated'), { recursive: true });
  return dir;
}
const manifestPath = dir => path.join(dir, 'generated', 'manifest.json');
const readManifest = dir => JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
function writeManifest(dir, m) {
  m.engineVersion = hash(JSON.stringify(m.files));
  fs.writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2) + '\n');
}
function appendTo(dir, rel, text) { fs.appendFileSync(path.join(dir, 'generated', rel), text); }
function rehash(dir, rel) {
  const m = readManifest(dir);
  m.files[rel] = hash(fs.readFileSync(path.join(dir, 'generated', rel), 'utf8').replace(/\r\n/g, '\n'));
  writeManifest(dir, m);
}
async function test(name, fn) {
  const dir = freshCopy();
  delete globalThis.__TAMPER;
  try { await fn(dir); passed++; console.log(`OK ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split('\n')[0]}`); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const load = dir => require(path.join(dir, 'trusted-ic.cjs'));
const IC_ENGINE = 'src/domain/ic/ic-readiness-engine.js';

(async () => {
  await test('clean bundle loads and hashes a document', async dir => {
    const t = load(dir);
    await t.loadEngine();
    assert.match(t.documentHash({ a: 1 }), /^[0-9a-f]{64}$/);
  });

  await test('editing a listed module without touching the manifest is refused', async dir => {
    appendTo(dir, IC_ENGINE, '\nglobalThis.__TAMPER = true;\n');
    await assert.rejects(load(dir).loadEngine(), /integrity failure/);
    assert.equal(globalThis.__TAMPER, undefined, 'tampered module must not have executed');
  });

  await test('removing a module from the manifest (engineVersion recomputed) is refused, tampered code never runs', async dir => {
    appendTo(dir, IC_ENGINE, '\nglobalThis.__TAMPER = true;\n');
    const m = readManifest(dir); delete m.files[IC_ENGINE]; writeManifest(dir, m);
    await assert.rejects(load(dir).loadEngine(), /missing required module/i);
    assert.equal(globalThis.__TAMPER, undefined, 'tampered module must not have executed');
  });

  await test('removing document-canonical.cjs from the manifest is refused before documentHash can use it', async dir => {
    appendTo(dir, 'document-canonical.cjs', '\nglobalThis.__TAMPER = true;\n');
    const m = readManifest(dir); delete m.files['document-canonical.cjs']; writeManifest(dir, m);
    assert.throws(() => load(dir).documentHash({ a: 1 }), /missing required module/i);
    assert.equal(globalThis.__TAMPER, undefined, 'tampered canonicalisation must not have executed');
  });

  await test('document-canonical.cjs edited without touching the manifest is refused (it computes documentHash)', async dir => {
    appendTo(dir, 'document-canonical.cjs', '\nglobalThis.__TAMPER = true;\n');
    assert.throws(() => load(dir).documentHash({ a: 1 }), /integrity failure/);
    assert.equal(globalThis.__TAMPER, undefined, 'tampered canonicalisation must not have executed');
  });

  await test('a manifest whose engineVersion does not match its own table is refused', async dir => {
    const m = readManifest(dir); m.engineVersion = '0'.repeat(64);
    fs.writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2));
    await assert.rejects(load(dir).loadEngine(), /Invalid domain manifest/);
  });

  await test('REQUIRED_BUNDLE_FILES stays equal to the manifest build-domain produces (drift guard)', async dir => {
    const t = load(dir);
    assert.ok(Array.isArray(t.REQUIRED_BUNDLE_FILES), 'trusted-ic.cjs must export its fixed list of required modules');
    assert.deepEqual([...t.REQUIRED_BUNDLE_FILES].sort(), Object.keys(readManifest(dir).files).sort());
  });

  // DOCUMENTED LIMIT (integrity, not authenticity): a forger who also rewrites the file's manifest hash passes. If the
  // owner decides authenticity is required, add an anchor OUTSIDE generated/ (see the report) and flip this assertion.
  await test('LIMIT: a self-consistently forged file + manifest is NOT detected (no external anchor)', async dir => {
    appendTo(dir, IC_ENGINE, '\nglobalThis.__TAMPER = true;\n');
    rehash(dir, IC_ENGINE);
    await load(dir).loadEngine();
    assert.equal(globalThis.__TAMPER, true, 'documented limit: forged bundle executes');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
