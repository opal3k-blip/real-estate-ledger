'use strict';
/* Deployment gate (runs from firebase.json -> predeploy, for EVERY `firebase deploy`).
   Normal mode : lint (syntax + domain-bundle drift check) and the whole server test suite.
   Emergency   : only when EMERGENCY_REASON is set (>= 10 characters). Skips the long test suite, NEVER the lint /
                 `check:domain` drift check, and appends one audit line (JSON) to functions/emergency-deploys.log with
                 time, operator, host, git commit, bundle version and the reason. A failed lint refuses the deploy
                 (and that refusal is logged too).
   `--plan` prints what would run without running or logging anything (used by the tests). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MIN_REASON = 10;
const reason = String(process.env.EMERGENCY_REASON || '').trim();
const emergency = reason.length > 0;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const steps = emergency ? [['run', 'lint']] : [['run', 'lint'], ['test']];

if (process.argv.includes('--plan')) {
  console.log(JSON.stringify({ mode: emergency ? 'emergency' : 'normal', reasonOk: !emergency || reason.length >= MIN_REASON, steps: steps.map(s => `npm ${s.join(' ')}`) }));
  process.exit(emergency && reason.length < MIN_REASON ? 1 : 0);
}
if (emergency && reason.length < MIN_REASON) {
  console.error(`EMERGENCY_REASON must state the reason in at least ${MIN_REASON} characters.`);
  process.exit(1);
}

function auditLine(gate) {
  let gitHead = null; let engineVersion = null; let operator = null;
  try { gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).stdout.trim() || null; } catch (e) { /* not a git checkout */ }
  try { engineVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '../generated/manifest.json'), 'utf8')).engineVersion; } catch (e) { /* missing bundle: lint already refuses */ }
  try { operator = os.userInfo().username; } catch (e) { operator = null; }
  return JSON.stringify({ event: 'EMERGENCY_DEPLOY', at: new Date().toISOString(), gate, operator, host: os.hostname(), gitHead, engineVersion, reason });
}
function writeAudit(gate) {
  const line = auditLine(gate);
  const file = process.env.EMERGENCY_LOG_FILE || path.join(__dirname, '../emergency-deploys.log');
  try { fs.appendFileSync(file, line + '\n'); } catch (e) { console.error('WARNING: could not write the emergency audit file: ' + e.message); }
  console.error('[AUDIT] ' + line);
}

for (const args of steps) {
  const r = spawnSync(npm, args, { cwd: path.join(__dirname, '..'), stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    if (emergency) writeAudit('refused: ' + args.join(' ') + ' failed');
    process.exit(r.status || 1);
  }
}
if (emergency) writeAudit('passed: lint + check:domain (tests skipped)');
