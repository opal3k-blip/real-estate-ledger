'use strict';
/* `npm run deploy:emergency` — hotfix deploy with a governed, recorded exception.
   Usage (bash):        EMERGENCY_REASON="why this cannot wait" npm run deploy:emergency
   Usage (PowerShell):  $env:EMERGENCY_REASON="why this cannot wait"; npm run deploy:emergency
   The gate (scripts/predeploy.cjs, called by firebase.json) then runs lint + check:domain only, skips the long test
   suite, and records an audit line in functions/emergency-deploys.log. The domain-bundle drift check is never skipped. */
const { spawnSync } = require('node:child_process');
const reason = String(process.env.EMERGENCY_REASON || '').trim();
if (reason.length < 10) {
  console.error('deploy:emergency needs EMERGENCY_REASON set to a clear reason (at least 10 characters).');
  process.exit(1);
}
const r = spawnSync('firebase', ['deploy', '--only', 'functions'], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status === null ? 1 : r.status);
