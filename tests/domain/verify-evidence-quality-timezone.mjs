/* Review comment #2: evidenceQuality must not depend on the runtime time zone.
   Policy: date-only evidence dates are midnight in Riyadh (UTC+3). Each case runs in a fresh child process with a different TZ (the zone is fixed when the process starts). */
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = pathToFileURL(path.join(ROOT, 'src/domain/evidence/evidence-engine.js')).href;
const ZONES = ['UTC', 'Asia/Riyadh', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'];
// Policy: a date-only evidence date is midnight at Riyadh (UTC+3). Evidence dated 2024-10-27 starts at 2024-10-26T21:00Z and is
// first stale (age >= 731 days, i.e. ageDays > 730) at 2026-10-27T21:00:00Z = 2026-10-28 00:00 in Riyadh.
const CASES = [
  { label: '2026-10-27T20:59:59Z (23:59:59 Riyadh on the 27th)', nowMs: Date.UTC(2026, 9, 27, 20, 59, 59), stale: 0 },
  { label: '2026-10-27T21:00:00Z (00:00:00 Riyadh on the 28th)', nowMs: Date.UTC(2026, 9, 27, 21, 0, 0), stale: 1 },
  { label: '2026-10-27T21:00:01Z', nowMs: Date.UTC(2026, 9, 27, 21, 0, 1), stale: 1 },
  { label: '2026-10-27T22:00:00Z (01:00 Riyadh on the 28th)', nowMs: Date.UTC(2026, 9, 27, 22, 0, 0), stale: 1 },
  { label: '2026-10-26T12:00:00Z', nowMs: Date.UTC(2026, 9, 26, 12, 0, 0), stale: 0 },
];
const child = `
import { evidenceQuality, KEY_FIELDS } from ${JSON.stringify(ENGINE)};
const f = KEY_FIELDS.find(k => k.critical);
const mk = date => ({ meta:{ oppType: f.appliesTo || 'development' }, evidence:{ [f.path]:{ source:'s', tier:'tier1', confidence:'high', verifiedBy:'x', date } } });
const out = {};
for (const nowMs of ${JSON.stringify(CASES.map(c => c.nowMs))}) out[nowMs] = evidenceQuality(mk('2024-10-27'), nowMs).stale.length;
out.shapes = ['2024-02-30','2024-13-01','2024-1-5','not-a-date','2024-10-27T10:00:00','2024-00-10','2024-10-32'].map(d => evidenceQuality(mk(d), Date.UTC(2030,0,1)).stale.length);
console.log(JSON.stringify(out));
`;
const results = {};
for (const tz of ZONES) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  assert.equal(r.status, 0, `child failed in ${tz}: ${r.stderr}`);
  results[tz] = JSON.parse(r.stdout.trim().split('\n').pop());
}
for (const tz of ZONES) {
  for (const c of CASES) assert.equal(results[tz][c.nowMs], c.stale, `${tz} @ ${c.label}: expected stale=${c.stale}`);
  // Same accepted shapes as the previous parser: day overflow rolls over (counted), everything malformed is never stale.
  assert.deepEqual(results[tz].shapes, [1, 0, 0, 0, 0, 0, 0], `${tz}: accepted/rejected date shapes unchanged`);
}
// Years 0000-0099: Date.UTC() would read them as 1900-1999, the previous parser read them literally. Compare, in an Asia/Riyadh process
// (where the previous local-midnight parse equals Riyadh midnight, the adopted policy), against the previous expression at 'now' values chosen so
// that a 1900s misreading changes the classification.
const yearChild = `
import { evidenceQuality, KEY_FIELDS } from ${JSON.stringify(ENGINE)};
const f = KEY_FIELDS.find(k => k.critical);
const mk = date => ({ meta:{ oppType: f.appliesTo || 'development' }, evidence:{ [f.path]:{ source:'s', tier:'tier1', confidence:'high', verifiedBy:'x', date } } });
const out = [];
for (const now of [Date.UTC(1901, 0, 1), Date.UTC(1951, 0, 1), Date.UTC(2030, 0, 1)]) for (const d of ['0000-01-01','0001-06-15','0050-01-01','0099-12-31','0100-01-01','1899-12-31','1970-01-01','2024-10-27','9999-12-31']) {
  const oldMs = new Date(d + 'T00:00:00').getTime();
  const age = Math.floor((now - oldMs) / 86400000);
  out.push([d + '@' + new Date(now).getUTCFullYear(), (isFinite(age) && age > 730) ? 1 : 0, evidenceQuality(mk(d), now).stale.length]);
}
console.log(JSON.stringify(out));
`;
const yr = spawnSync(process.execPath, ['--input-type=module', '-e', yearChild], { env: { ...process.env, TZ: 'Asia/Riyadh' }, encoding: 'utf8' });
assert.equal(yr.status, 0, yr.stderr);
for (const [d, oldStale, newStale] of JSON.parse(yr.stdout.trim().split('\n').pop())) assert.equal(newStale, oldStale, `year edge ${d}: new parser must classify exactly like the previous one`);
console.log(`PASS verify-evidence-quality-timezone: identical staleness (Riyadh-midnight policy) in ${ZONES.length} time zones across ${CASES.length} boundary instants; accepted date shapes and years 0000-0099 unchanged.`);
