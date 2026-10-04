#!/usr/bin/env node
'use strict';
/* =========================================================================
   إصلاح تعارض توثَّق مسبقاً في functions/test/load-index-with-fakes.js وفي
   docs/PHASE_2R_4E_HANDOFF.md: firebase-tools@15.x يستدعي أربعة مسارات فرعية من
   stream-json بأسماء الملفات القديمة (capitalized، من قبل الإصدار 3.x):

     stream-json/filters/Pick
     stream-json/filters/Filter
     stream-json/streamers/StreamArray
     stream-json/streamers/StreamObject

   لكن stream-json@3.6.0 (المُثبَّت هنا عمداً عبر overrides في package.json — تثبيت أمني
   لإصدار أحدث من الإصدار الذي يتوقعه firebase-tools تلقائياً، وليس شيئاً نريد التراجع عنه)
   أعاد تسمية هذه الملفات بحروف صغيرة (pick.js/filter.js/stream-array.js/stream-object.js)
   وأضاف حقل "exports" بلا امتداد ولا حساسية case، فيفشل require() القديم بـ"Cannot find
   module .../stream-json/src/filters/Pick" — يمنع تشغيل أي شيء عبر `firebase
   emulators:exec` في هذا المستودع تماماً (كان محظوراً بالكامل قبل هذا الإصلاح).

   الحل هنا محلي بحت ولا يغيّر إصدار stream-json المثبَّت فعلياً (overrides تبقى كما هي، لا
   تراجع أمني): أربع ملفات "شِيم" (shim) رفيعة جداً، كل واحد سطر واحد يعيد التصدير من
   الملف الحقيقي بالاسم الصحيح الجديد. هذا السكربت يُنشئها تلقائياً بعد كل npm install
   (postinstall في package.json) — بما فيه أول تشغيل على أي جهاز آخر — حتى لا يُفقَد
   الإصلاح عند حذف node_modules أو تثبيته من جديد. آمن بالتكرار (idempotent): يتحقق دائماً
   من الملف الحقيقي أولاً، ولا يفعل شيئاً إن كان stream-json غير مثبَّت أصلاً (مثلاً لو شُغِّل
   هذا السكربت خطأً من مجلد آخر).
   ========================================================================= */
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'node_modules', 'stream-json', 'src');

// { الاسم القديم (بلا امتداد، كما يستدعيه firebase-tools) -> الملف الحقيقي الحالي }
const SHIMS = {
  'filters/Pick': 'pick.js',
  'filters/Filter': 'filter.js',
  'streamers/StreamArray': 'stream-array.js',
  'streamers/StreamObject': 'stream-object.js',
};

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    // stream-json غير مثبَّت في هذا node_modules (مثلاً postinstall شُغِّل بمعزل عن السياق
    // المتوقَّع) — لا شيء لإصلاحه، ننهي بصمت وبنجاح، لا نفشل تثبيت الحزم لأجل هذا.
    return;
  }
  let created = 0, skippedExisting = 0, skippedMissingReal = 0;
  for (const [legacyRel, realFile] of Object.entries(SHIMS)) {
    const legacyPath = path.join(SRC_DIR, legacyRel);
    const realPath = path.join(path.dirname(legacyPath), realFile);
    if (!fs.existsSync(realPath)) { skippedMissingReal++; continue; }
    if (fs.existsSync(legacyPath)) { skippedExisting++; continue; }
    fs.writeFileSync(legacyPath, `module.exports = require('./${realFile}');\n`);
    created++;
  }
  if (created) console.log(`[fix-stream-json-legacy-paths] created ${created} legacy-path shim(s) for firebase-tools compatibility.`);
  if (skippedMissingReal) console.log(`[fix-stream-json-legacy-paths] ${skippedMissingReal} shim(s) skipped — real target file not found (stream-json layout may have changed; re-check this script).`);
}

main();
