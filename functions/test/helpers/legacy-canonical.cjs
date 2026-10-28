'use strict';
/* TEST-ONLY frozen reference: the document canonicalisation used BEFORE the 3A-3 type-ambiguity fix (verbatim logic of
   the previous canonicalDocValue/documentHash). It exists solely to prove (a) which documents keep the same hash after
   the change and (b) which documents change; it must never be imported by production code. */
const crypto = require('node:crypto');
function legacyCanonicalDocValue(v, depth = 0, seen = new Set()) {
  if (depth > 60) throw new Error('too deep');
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : { $number: String(v) };
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'bigint') return { $bigint: String(v) };
  if (t === 'function' || t === 'symbol') throw new Error('unsupported');
  if (v instanceof Date) return { $date: Number.isNaN(v.getTime()) ? 'invalid' : v.toISOString() };
  if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('base64') };
  if (seen.has(v)) throw new Error('cyclic');
  seen.add(v);
  try {
    if (Array.isArray(v)) return v.map(x => legacyCanonicalDocValue(x === undefined ? null : x, depth + 1, seen));
    if (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number' && typeof v.toMillis === 'function') return { $ts: [v.seconds, v.nanoseconds] };
    if (typeof v.path === 'string' && typeof v.id === 'string' && v.firestore) return { $ref: v.path };
    if (typeof v.toJSON === 'function') return legacyCanonicalDocValue(v.toJSON(), depth + 1, seen);
    const out = Object.create(null);
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = legacyCanonicalDocValue(v[k], depth + 1, seen);
    return out;
  } finally { seen.delete(v); }
}
const legacyDocumentHash = (doc) => crypto.createHash('sha256').update(JSON.stringify(legacyCanonicalDocValue(doc))).digest('hex');
module.exports = { legacyCanonicalDocValue, legacyDocumentHash };
