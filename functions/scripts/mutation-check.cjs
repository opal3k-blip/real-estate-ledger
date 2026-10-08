'use strict';
/* Phase 3A-3 — mutation check for the server-side enforcement.
   Copies the relevant part of the repository to a temp directory, applies ONE deliberate defect at a time
   (a "mutant"), rebuilds the generated bundle when a shared module was changed, and runs the fast server
   suites. A mutant is KILLED when at least one test fails. Any SURVIVING mutant means a guard exists that no
   test would miss if it were removed, so the script exits non-zero.
   Usage: node functions/scripts/mutation-check.cjs [--only M3,M7] [--verbose] */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? new Set(args[onlyArg + 1].split(',')) : null;

const ENGINE = 'src/domain/validation/input-validation-engine.js';
const RISK = 'src/domain/validation/risk-classification.js';
const INDEX = 'functions/index.js';
const TRUSTED = 'functions/trusted-ic.cjs';
const BUILD = 'functions/scripts/build-domain.cjs';

const T_FAST = ['trusted-ic.test.cjs', 'server-validation-enforcement.test.cjs'];
const T_PARITY = ['validation-parity.test.cjs'];
const T_GUARD = ['deploy-guard.test.cjs'];
const T_PROP = ['validation-parity.property.test.cjs'];
const T_CLIENT = ['tests/features/ic-workflow-approval.test.mjs'];
const T_CLIENT_HASH = ['tests/features/document-hash-parity.test.mjs'];
const CLIENT = 'src/features/ic-workflow.js';

/* find must occur EXACTLY once in the file; the check fails loudly otherwise (a stale mutant is a bug). */
const MUTANTS = [
  { id: 'M1', name: 'remove the strict top-level whitelist', file: INDEX, rebuild: false, tests: T_FAST,
    find: "const extra = unexpectedKeys(obj, allowed);\n  if (extra.length) {", replace: "const extra = [];\n  if (extra.length) {" },
  { id: 'M2', name: 'skip the docHash comparison', file: INDEX, rebuild: false, tests: T_FAST,
    find: 'if (approving && expectedDocHash !== currentDocHash) {', replace: 'if (false) {' },
  { id: 'M3', name: 'remove the blocked (red) gate', file: INDEX, rebuild: false, tests: T_FAST,
    find: 'if (approving && verdict.blocked) {', replace: 'if (false) {' },
  { id: 'M4', name: 'remove the compound acknowledgement', file: INDEX, rebuild: false, tests: T_FAST,
    find: 'if (approving && verdict.compound.requiresAcknowledgement && !warningsAck) {', replace: 'if (false) {' },
  { id: 'M5', name: 'acknowledgement is always considered given', file: INDEX, rebuild: false, tests: T_FAST,
    find: 'verdict.compound.requiresAcknowledgement && warningsAcknowledged === true && cleanReasons.length > 0;', replace: 'verdict.compound.requiresAcknowledgement;' },
  { id: 'M6', name: 'acknowledgement needs no written reason', file: INDEX, rebuild: false, tests: T_FAST,
    find: 'verdict.compound.requiresAcknowledgement && warningsAcknowledged === true && cleanReasons.length > 0;', replace: 'verdict.compound.requiresAcknowledgement && warningsAcknowledged === true;' },
  { id: 'M7', name: 'hash ignores the decision history (ic)', file: TRUSTED, rebuild: false, tests: T_FAST,
    find: 'return hash(JSON.stringify(omitCanonicalPaths(canonicalDocValue(doc), volatilePaths)));',
    replace: 'return hash(JSON.stringify(omitCanonicalPaths(canonicalDocValue(Object.fromEntries(Object.entries(doc).filter(([k]) => k !== \'ic\'))), volatilePaths)));' },
  { id: 'M8', name: 'hash ignores meta', file: TRUSTED, rebuild: false, tests: T_FAST,
    find: 'return hash(JSON.stringify(omitCanonicalPaths(canonicalDocValue(doc), volatilePaths)));',
    replace: 'return hash(JSON.stringify(omitCanonicalPaths(canonicalDocValue(Object.fromEntries(Object.entries(doc).filter(([k]) => k !== \'meta\'))), volatilePaths)));' },
  { id: 'M9', name: 'hash does not distinguish NaN/Infinity', file: 'functions/generated/document-canonical.cjs', rebuild: false, tests: T_FAST,
    find: "return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : { $number: String(v) };", replace: 'return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : null;' },
  { id: 'M10', name: 'stored-document unsafe-key check removed', file: TRUSTED, rebuild: false, tests: T_FAST,
    find: "if (UNSAFE_KEYS.has(key)) throw rejection('UNSAFE_KEY', 'Unsafe opportunity key', { path: where() });", replace: '' },
  { id: 'M11', name: 'request unsafe-key check removed', file: INDEX, rebuild: false, tests: T_FAST,
    find: "if (key === '__proto__' || key === 'prototype' || key === 'constructor') {", replace: 'if (false) {' },
  { id: 'M12', name: 'work-bound (horizon) check removed', file: TRUSTED, rebuild: false, tests: T_FAST,
    find: "if (v != null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100)) {", replace: 'if (false) {' },
  { id: 'M13', name: 'expectedDocHash no longer required for approvals', file: INDEX, rebuild: false, tests: T_FAST,
    find: 'if (APPROVAL_DECISIONS.has(decision.decision) && expectedDocHash === undefined) {', replace: 'if (false) {' },
  { id: 'M14', name: 'requestId replay ignores warningsAcknowledged', file: INDEX, rebuild: false, tests: T_FAST,
    find: '&& a.expectedDocHash === b.expectedDocHash', replace: '&& true' },
  { id: 'M15', name: 'numeric text back to a warning (not blocking)', file: ENGINE, rebuild: true, tests: T_FAST.concat(T_PARITY),
    find: "out.push(issue('NUMERIC_STRING', SEVERITY.BLOCKING,", replace: "out.push(issue('NUMERIC_STRING', SEVERITY.WARNING," },
  { id: 'M16', name: 'ABOVE_MAX check removed', file: ENGINE, rebuild: true, tests: T_FAST,
    find: 'if (rule.max !== undefined && v > rule.max) {', replace: 'if (false) {' },
  { id: 'M17', name: 'lower bound for signed fields removed', file: ENGINE, rebuild: true, tests: T_FAST,
    find: 'if (rule.lo !== undefined && v < rule.lo) {', replace: 'if (false) {' },
  { id: 'M18', name: 'BELOW_MIN check removed', file: ENGINE, rebuild: true, tests: T_FAST,
    find: 'if (rule.min !== undefined && v > 0 && v < rule.min) {', replace: 'if (false) {' },
  { id: 'M19', name: 'compound threshold set to 99', file: RISK, rebuild: true, tests: T_FAST,
    find: 'export const COMPOUND_WARNING_THRESHOLD = 2;', replace: 'export const COMPOUND_WARNING_THRESHOLD = 99;' },
  { id: 'M20', name: 'INCOMPLETE no longer blocks', file: RISK, rebuild: true, tests: T_FAST,
    find: " || status === STATUS.INCOMPLETE;", replace: ';' },
  { id: 'M21', name: 'INVALID no longer blocks', file: RISK, rebuild: true, tests: T_FAST,
    find: " || status === STATUS.INVALID ||", replace: " ||" },
  { id: 'M22', name: 'LTC removed from the high-risk paths', file: RISK, rebuild: true, tests: T_FAST.concat(T_PARITY),
    find: "'financing.ltc', 'financing.saibor',", replace: "'financing.saibor'," },
  { id: 'M23', name: 'debt shortfall never counted as a reason', file: RISK, rebuild: true, tests: T_FAST,
    find: 'if (riskShort.length) {', replace: 'if (false) {' },
  { id: 'M24', name: 'blocked status gives yellow instead of red', file: RISK, rebuild: true, tests: T_FAST,
    find: 'const color = blocked ? COLOR.RED', replace: 'const color = false ? COLOR.RED' },
  { id: 'M25', name: 'requiresAcknowledgement ignores the threshold', file: RISK, rebuild: true, tests: T_FAST,
    find: 'requiresAcknowledgement: !blocked && count >= COMPOUND_WARNING_THRESHOLD', replace: 'requiresAcknowledgement: false' },
  { id: 'M26', name: 'build gate: extra files in generated/ not detected', file: BUILD, rebuild: false, tests: T_GUARD,
    find: 'if (extra.length) throw', replace: 'if (false) throw' },
  { id: 'M27', name: 'build gate: stale bundle not detected', file: BUILD, rebuild: false, tests: T_GUARD,
    find: "if (!fs.existsSync(dest) || fs.readFileSync(dest, 'utf8').replace(/\\r\\n/g, '\\n') !== contents) {", replace: 'if (false) {' },
  { id: 'M28', name: 'firebase.json predeploy removed', file: 'firebase.json', rebuild: false, tests: T_GUARD,
    find: '"predeploy"', replace: '"predeploy_disabled"' },
  { id: 'M29', name: 'CI domain check removed', file: '.github/workflows/ci.yml', rebuild: false, tests: T_GUARD,
    find: 'run: npm --prefix functions run check:domain', replace: 'run: echo skipped' },
  { id: 'M31', name: 'client: red verdict no longer stops approval', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'if(blockedNow){', replace: 'if(false){' },
  { id: 'M32', name: 'client: expectedDocHash not sent', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: '...(expectedDocHash ? { expectedDocHash } : {}),', replace: '' },
  { id: 'M33', name: 'client: acknowledgement not required', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'if(!ackChecked || !reasons.length){', replace: 'if(false){' },
  { id: 'M34', name: 'client: stale preview reused after the document changed', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'if(cur && cur.sig === sig) return cur;', replace: 'if(cur) return cur;' },
  { id: 'M35', name: 'client: demo path ignores the shared classification', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'blockedNow = !!lv.blocked;', replace: 'blockedNow = false;' },
  { id: 'M36', name: 'divergence: server-only copy stops counting debt shortfalls (property parity must notice)', file: 'functions/generated/src/domain/validation/risk-classification.js', rebuild: false, tests: T_PROP,
    find: 'if (riskShort.length) {', replace: 'if (false) {' },
  { id: 'M37', name: 'divergence: client-only source drops ABOVE_MAX (property parity must notice)', file: ENGINE, rebuild: false, tests: T_PROP,
    find: 'if (rule.max !== undefined && v > rule.max) {', replace: 'if (false) {' },
  { id: 'M38', name: 'emergency gate skips the drift check (lint) as well', file: 'functions/scripts/predeploy.cjs', rebuild: false, tests: T_GUARD,
    find: "const steps = emergency ? [['run', 'lint']] : [['run', 'lint'], ['test']];", replace: "const steps = emergency ? [] : [['run', 'lint'], ['test']];" },
  { id: 'M39', name: 'emergency needs no reason', file: 'functions/scripts/predeploy.cjs', rebuild: false, tests: T_GUARD,
    find: 'const MIN_REASON = 10;', replace: 'const MIN_REASON = 0;' },
  { id: 'M40', name: 'emergency deploy leaves no audit line', file: 'functions/scripts/predeploy.cjs', rebuild: false, tests: T_GUARD,
    find: "if (emergency) writeAudit('passed: lint + check:domain (tests skipped)');", replace: '' },
  { id: 'M41', name: 'normal deploy no longer runs the test suite', file: 'functions/scripts/predeploy.cjs', rebuild: false, tests: T_GUARD,
    find: ": [['run', 'lint'], ['test']];", replace: ": [['run', 'lint']];" },
  { id: 'M42', name: 'rejection log leaks the caller email', file: INDEX, rebuild: false, tests: T_FAST,
    find: "oppId: typeof data.oppId === 'string' ? data.oppId.slice(0, 80) : null,", replace: "oppId: typeof data.oppId === 'string' ? data.oppId.slice(0, 80) : null, who: request && request.auth && request.auth.token && request.auth.token.email," },
  { id: 'M43', name: 'rejections are no longer logged', file: INDEX, rebuild: false, tests: T_FAST,
    find: "catch (error) { logApprovalRejection('approveOpportunity', request, error); throw error; }", replace: "catch (error) { throw error; }" },
  { id: 'M30', name: 'npm predeploy no longer runs the gate script', file: 'functions/package.json', rebuild: false, tests: T_GUARD,
    find: '"predeploy": "node scripts/predeploy.cjs"', replace: '"predeploy": "echo skip"' },
  { id: 'M44', name: 'client: the pending request does not keep its full original payload', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'pendingIcRequests.set(pendingKey, payload ? { requestId, signature, busy: true, payload } : { requestId, signature, busy: true });', replace: 'pendingIcRequests.set(pendingKey, { requestId, signature, busy: true });' },
  { id: 'M45', name: 'client: a pending request is re-sent even though the decision content changed', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: "return same ? { action: 'resend' } : { action: 'block', why: 'different' };", replace: "return { action: 'resend' };" },
  { id: 'M46', name: 'client: a pending request is silently replaced by a NEW request', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'verbatimPayload = JSON.parse(JSON.stringify(pend.payload));', replace: 'verbatimPayload = null;' },
  { id: 'M47', name: 'client: a legacy pending entry (no payload) is not blocked', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: "if(!entry || !entry.payload || typeof entry.payload !== 'object') return { action: 'block', why: 'legacy' };", replace: "if(!entry) return { action: 'block', why: 'legacy' };\n  if(!entry.payload) return { action: 'resend' };" },
  { id: 'M48', name: 'client: the explicit stop-tracking does nothing', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: '      pendingIcRequests.delete(key0);\n', replace: '' },
  { id: 'M49', name: 'client: the re-sent request uses the NEW preview hash instead of the original', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'verbatimPayload = JSON.parse(JSON.stringify(pend.payload));', replace: 'verbatimPayload = JSON.parse(JSON.stringify(pend.payload)); { const pv = approvalPreviews.get(oppId); if(pv && pv.docHash) verbatimPayload.expectedDocHash = pv.docHash; }' },
  { id: 'M50', name: 'client: the preview request does not send the displayed hash', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: "({ oppId, displayedDocHash: displayedHash })", replace: "({ oppId })" },
  { id: 'M51', name: 'client: accepts the preview without the server confirming displayedMatches', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'if(data.displayedMatches !== true || data.docHash !== entry.displayedHash){', replace: 'if(data.docHash !== entry.displayedHash){' },
  { id: 'M52', name: 'client: accepts a preview whose docHash differs from the displayed hash', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'if(data.displayedMatches !== true || data.docHash !== entry.displayedHash){', replace: 'if(data.displayedMatches !== true){' },
  { id: 'M53', name: 'client: no hash recomputation at click time', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'if(clickHash !== pv.docHash){', replace: 'if(false){' },
  { id: 'M54', name: 'client: stop-tracking is allowed while the request is being sent', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'if(ent0 && ent0.busy){', replace: 'if(false){' },
  { id: 'M55', name: 'client: stop-tracking needs no acknowledgement', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: 'if(!(ack0 && ack0.checked)){', replace: 'if(false){' },
  { id: 'M56', name: 'client: a stale preview is not refused at approval time', file: CLIENT, rebuild: false, tests: T_CLIENT,
    find: "entry.status = 'stale'; return;", replace: "entry.status = 'ready'; entry.docHash = data.docHash; entry.verdict = data.verdict; return;" },
  { id: 'M57', name: 'server: displayedMatches is always true', file: INDEX, rebuild: false, tests: T_FAST,
    find: 'displayedDocHash === undefined ? null : displayedDocHash === evaluated.docHash,', replace: 'displayedDocHash === undefined ? null : true,' },
  { id: 'M58', name: 'server: displayedMatches is inverted', file: INDEX, rebuild: false, tests: T_FAST,
    find: 'displayedDocHash === undefined ? null : displayedDocHash === evaluated.docHash,', replace: 'displayedDocHash === undefined ? null : displayedDocHash !== evaluated.docHash,' },
  { id: 'M59', name: 'server: displayedDocHash format is not validated', file: INDEX, rebuild: false, tests: T_FAST,
    find: "if (displayedDocHash !== undefined && (typeof displayedDocHash !== 'string' || !/^[0-9a-f]{64}$/.test(displayedDocHash))) {", replace: 'if (false) {' },
  { id: 'M60', name: 'client hash: object keys are not sorted', file: 'src/domain/validation/document-canonical.js', rebuild: false, tests: T_CLIENT_HASH,
    find: 'for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[escapeKey(k)]', replace: 'for (const k of Object.keys(v)) if (v[k] !== undefined) out[escapeKey(k)]' },
  { id: 'M61', name: 'client hash: NaN / Infinity are not distinguished', file: 'src/domain/validation/document-canonical.js', rebuild: false, tests: T_CLIENT_HASH,
    find: "return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : { $number: String(v) };", replace: 'return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : null;' },
  { id: 'M62', name: 'client hash: Firestore Timestamp is not canonicalised', file: 'src/domain/validation/document-canonical.js', rebuild: false, tests: T_CLIENT_HASH,
    find: "if (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number' && typeof v.toMillis === 'function') return { $ts: [v.seconds, v.nanoseconds] };", replace: '' },
  { id: 'M63', name: 'client hash: fails open without WebCrypto', file: 'src/domain/validation/document-hash.js', rebuild: false, tests: T_CLIENT_HASH,
    find: "if (!subtle || typeof subtle.digest !== 'function') { const e = new Error('WebCrypto SHA-256 unavailable'); e.rejectionCode = 'NO_WEBCRYPTO'; throw e; }", replace: "if (!subtle || typeof subtle.digest !== 'function') return 'f'.repeat(64);" },
  { id: 'M64', name: 'client hash: plain keys starting with $ are not escaped (marker look-alikes collide)', file: 'src/domain/validation/document-canonical.js', rebuild: false, tests: T_CLIENT_HASH,
    find: "const escapeKey = (k) => (k.charCodeAt(0) === 36 ? '$' + k : k);", replace: 'const escapeKey = (k) => k;' },
  { id: 'M65', name: 'client hash: plain maps shaped like a Timestamp/Reference are treated as such', file: 'src/domain/validation/document-canonical.js', rebuild: false, tests: T_CLIENT_HASH,
    find: 'if (isPlainObject(v)) {', replace: 'if (false) {' },
  { id: 'M66', name: 'server hash: plain keys starting with $ are not escaped', file: 'functions/generated/document-canonical.cjs', rebuild: false, tests: T_FAST,
    find: "const escapeKey = (k) => (k.charCodeAt(0) === 36 ? '$' + k : k);", replace: 'const escapeKey = (k) => k;' },
  { id: 'M67', name: 'server hash: plain maps shaped like a Timestamp/Reference are treated as such', file: 'functions/generated/document-canonical.cjs', rebuild: false, tests: T_FAST,
    find: 'if (isPlainObject(v)) {', replace: 'if (false) {' },
  { id: 'M68', name: 'server hash: volatile paths go through a lossy JSON round trip of the raw document again', file: TRUSTED, rebuild: false, tests: T_FAST,
    find: 'return hash(JSON.stringify(omitCanonicalPaths(canonicalDocValue(doc), volatilePaths)));',
    replace: 'return hash(JSON.stringify(omitCanonicalPaths(canonicalDocValue(JSON.parse(JSON.stringify(doc, (k, val) => (typeof val === \'number\' && !Number.isFinite(val) ? { $number: String(val) } : val)))), volatilePaths)));' },
  { id: 'M69', name: 'build: the server copy is no longer derived from the shared source', file: BUILD, rebuild: true, tests: T_FAST,
    find: ".replace(/^export function /gm, 'function ')", replace: ".replace(/^export function /gm, 'function ').replace('const escapeKey = (k) => (k.charCodeAt(0) === 36 ? \\'$\\' + k : k);', 'const escapeKey = (k) => k;')" },
];

function copyTree(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name, from)) continue;
    const s = path.join(from, e.name); const d = path.join(to, e.name);
    if (e.isDirectory()) copyTree(s, d, skip); else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
function run(cmd, argv, cwd, extraEnv) {
  return spawnSync(cmd, argv, { cwd, encoding: 'utf8', timeout: 240000, env: { ...process.env, NODE_NO_WARNINGS: '1', ...(extraEnv || {}) } });
}

const results = [];
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `mut-${m.id}-`));
  try {
    for (const dir of ['src', 'tests/domain', 'tests/features', 'functions', '.github']) {
      copyTree(path.join(root, dir), path.join(tmp, dir), (n) => n === 'node_modules');
    }
    for (const f of ['firebase.json', 'package.json']) fs.copyFileSync(path.join(root, f), path.join(tmp, f));
    fs.symlinkSync(path.join(root, 'functions/node_modules'), path.join(tmp, 'functions/node_modules'), 'dir');
    const target = path.join(tmp, m.file);
    const original = fs.readFileSync(target, 'utf8');
    const count = original.split(m.find).length - 1;
    if (count !== 1) { results.push({ m, status: 'BROKEN', note: `pattern occurs ${count}x (must be exactly 1)` }); continue; }
    fs.writeFileSync(target, original.replace(m.find, () => m.replace));
    if (m.rebuild) {
      const b = run('node', ['functions/scripts/build-domain.cjs'], tmp);
      if (b.status !== 0) { results.push({ m, status: 'BROKEN', note: 'rebuild failed: ' + (b.stderr || '').slice(0, 200) }); continue; }
    }
    let killedBy = null;
    for (const t of m.tests) {
      const env = t.includes('property') ? { PARITY_SEED: '12345', PARITY_RUNS: '600' } : undefined; // deterministic for the mutation run
      const r = t.startsWith('tests/') ? run('node', [t], tmp) : run('node', [`test/${t}`], path.join(tmp, 'functions'), env);
      if (r.status !== 0) { killedBy = t; if (verbose) console.log((r.stdout + r.stderr).slice(-600)); break; }
    }
    results.push({ m, status: killedBy ? 'KILLED' : 'SURVIVED', note: killedBy || '' });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const last = results[results.length - 1];
  console.log(`${last.status.padEnd(8)} ${m.id.padEnd(4)} ${m.name}${last.note ? '  <- ' + last.note : ''}`);
}

const killed = results.filter(r => r.status === 'KILLED').length;
const bad = results.filter(r => r.status !== 'KILLED');
console.log(`\nMutation score: ${killed}/${results.length} killed`);
if (bad.length) { console.log('NOT killed: ' + bad.map(r => `${r.m.id}(${r.status})`).join(', ')); process.exit(1); }
