# مراجعة Security Rules والصلاحيات

## ملخص تنفيذي

**تصنيف كل ادعاء في هذه الوثيقة** (أُضيف بعد مراجعة خارجية رابعة، لمنع الخلط بين ما تحقَّق فعلياً من
الكود/الاختبارات وما هو مخطَّط أو غير مؤكَّد):
- **[منفّذ محليًا، متحقَّق]** — موجود في الكود الفعلي (`firestore.rules`/`functions/index.js`/العميل)
  **و**تم تشغيله فعلياً وتأكيد نتيجته (تشغيل حقيقي، لا افتراض).
- **[منفّذ محليًا]** — موجود في الكود الفعلي، لكن لم يُشغَّل/يُعاد تأكيده في هذه الجلسة بالذات.
- **[مخطط]** — غير موجود بعد في الكود؛ نية أو توصية فقط.
- **[غير متحقق منه]** — لا يمكن تأكيده من هذه البيئة السحابية (مثل حالة النشر الفعلي على مشروع
  Firebase الحقيقي)، بصرف النظر عن صحته أو خطئه في الواقع.

قواعد Firestore المحلية (`firestore.rules`) تحمي القاعدة **كملف**؛ **[غير متحقق منه]** أن هذا هو
بالضبط ما هو **منشور فعلياً** على مشروع Firebase الحقيقي — ذلك يحتاج Firebase Console أو Management
API ببيانات اعتماد حقيقية، غير متاح من هذه البيئة. آخر اختبار محلي فعلي عبر Firestore Emulator (نُفِّذ
على جهاز المستخدم فعلياً بتاريخ 2026-10-04، عبر `npm --prefix tests/rules test`، لا افتراضاً) انتهى
بنتيجة:

```text
ALL PASSED (212 تأكيداً assertion، 0 فشل؛ Firestore Emulator حقيقي لا محاكاة/mock)
```
**[منفّذ محليًا، متحقَّق]**

هذه المراجعة تحول القواعد إلى مصفوفة صلاحيات واضحة يمكن مراجعتها من الفريق الفني والمحللين.

## الأدوار

| الدور | المصدر | المعنى |
|---|---|---|
| Admin | البريد داخل `isAdminEmail()` | صلاحية كاملة تقريباً وإدارة الفريق والإعدادات |
| Allowlisted member | وثيقة `team_members/{email}` | مستخدم مصرح له ضمن مدة الوصول |
| Senior IC | `team_roles/{email}.role == senior_ic` | تسجيل قرارات لجنة الاستثمار |
| Fund Manager | `team_roles/{email}.role == fund_manager` | إدارة الصناديق، المستثمرين، رأس المال، المكتبات المرجعية |
| Owner Analyst | `opportunities/{id}.meta.createdBy` | مالك فرصة محددة، يحق له تعديلها دون لمس حقول حوكمة رأس المال |

## مصفوفة Collections

| Collection | Read | Create | Update | Delete | ملاحظة حوكمة |
|---|---|---|---|---|---|
| `opportunities` | Authorized | Authorized + attribution honest | Admin (دائماً)، أو owner لفرصته بلا لمس capitalAllocation، أو Fund Manager فأعلى لـ`capitalAllocation` فقط — **والثلاثة بلا استثناء ممنوعون من لمس `ic`** (`preservesIc()` إلزامي قبل أي من الفروع الثلاثة، لا بعدها؛ **لا يوجد مسار عميل مباشر لـ`ic` حتى لـAdmin**) | Admin أو owner (وبشرط إضافي: `emptyClientIc()` — لا حذف لفرصة عليها أي قرار IC فعلي) | حماية `meta.updatedBy`؛ تصحيح 2026-10-04: الصيغة السابقة هنا كانت تذكر خطأً أن "Senior IC" يحدّث `ic` مباشرة — هذا **لم يعد صحيحاً منذ P0 (Trusted Transaction Layer)**؛ القرار نفسه (اعتماد/رفض/تعليق) يصل حصراً عبر `approveOpportunity` (Admin SDK)، لا عبر أي تحديث مباشر للوثيقة من أي عميل. **[منفّذ محليًا، متحقَّق: `preservesIc()`/`emptyClientIc()` في `firestore.rules`، مقروءة مباشرة من الكود بتاريخ 2026-10-04؛ ومؤكَّدة ضمن 212/212 اختباراً حقيقياً في `tests/rules/rules.test.mjs`]** |
| `team_members` | Admin | Admin | Admin | Admin | بوابة الدخول الأساسية |
| `team_roles` | Authorized | Admin | Admin | Admin | تعيين الأدوار لا يتم من المستخدمين |
| `settings` | Authorized | Admin | Admin | Admin | إعدادات branding |
| `mondayConfig` | Authorized | Admin | Admin | Admin | لا يحتوي secrets |
| `mondayTaskQueue` | Authorized | Fund Manager فقط، status=`pending`, `queuedBy` مطابق | ممنوع | ممنوع | التحديث يتم من Cloud Function |
| `presence` | Authorized | المستخدم لوثيقته فقط | المستخدم لوثيقته فقط | المستخدم لوثيقته فقط | حضور لحظي |
| `investors` | Authorized | Fund Manager | Fund Manager | Fund Manager | دفتر المستثمرين |
| `funds` | Authorized | Fund Manager، فقط بلا أصول مرتبطة (`assetIds` فارغة) | Fund Manager، ممنوع لمس `assetIds` | **ممنوع تماماً من أي عميل** (Phase 2R-4D4-C) — المسار الوحيد `archiveOrDeleteFund` (Cloud Function، Admin SDK، يفحص كل السجلات المحاسبية المرتبطة قبل الحذف الفعلي) | دفتر الصناديق؛ الربط الفعلي بأصل عبر `linkAssetToFund` فقط. **[منفّذ محليًا، متحقَّق: 60/60 اختباراً حقيقياً نجحت في `functions/test/p0-trusted-transaction-layer.test.js` بتشغيل فعلي بتاريخ 2026-10-04، بما فيها archiveOrDeleteFund وlinkAssetToFund]** |
| `commitments` | Authorized | Fund Manager؛ المبلغ موجب إلا لو `reversalOfId` موجود | ممنوع | ممنوع | append-only، لا التزامات سالبة عادية |
| `capitalCalls` | Authorized | Fund Manager بشروط status/reversal؛ المبلغ موجب إلا لو قيد عكسي | **ممنوع تماماً من أي عميل، بلا استثناء** (`allow update: if false` بالكامل في `firestore.rules`) | فقط draft `pending` | قفل محاسبي بعد الاعتماد/الترحيل؛ تصحيح 2026-10-04: الصيغة السابقة ("Fund Manager عبر transitions") كانت مضلِّلة — كل انتقال حالة لاحق (pending/declared→approved→paid/waived) يتم **حصراً** عبر `transitionLedgerRecord` (Cloud Function، Admin SDK، يتجاوز هذه القاعدة تماماً)، لا عبر أي تحديث مباشر من العميل مهما كان دوره. **[منفّذ محليًا، متحقَّق: مقروء مباشرة من `firestore.rules` بتاريخ 2026-10-04]** |
| `distributions` | Authorized | Fund Manager بشروط؛ المبلغ موجب إلا لو قيد عكسي | **ممنوع تماماً من أي عميل، بلا استثناء** (`allow update: if false` بالكامل) | فقط draft `declared` | قفل محاسبي بعد الاعتماد/الترحيل؛ نفس تصحيح `capitalCalls` أعلاه — الانتقال حصراً عبر `transitionLedgerRecord` (Admin SDK). **[منفّذ محليًا، متحقَّق: مقروء مباشرة من `firestore.rules` بتاريخ 2026-10-04]** |
| `transactions` | Authorized | Fund Manager | ممنوع | ممنوع | سجل append-only |
| `comparables` | Authorized | Fund Manager | Fund Manager | Fund Manager | مكتبة مرجعية |
| `benchmarks` | Authorized | Fund Manager | Fund Manager | Fund Manager | مكتبة مرجعية |
| `spaceEffOverrides` | Authorized | Fund Manager | Fund Manager | Fund Manager | تجاوزات مكتبة الكفاءة |
| `fundFeeOverrides` | Authorized | Fund Manager | Fund Manager | Fund Manager | تجاوزات رسوم الصندوق |
| `saudiRegOverrides` | Authorized | Fund Manager | Fund Manager | Fund Manager | تجاوزات الأنظمة السعودية |
| `oppAuditLog` | Authorized | ممنوع من العميل | ممنوع | ممنوع | يكتب فقط عبر Cloud Functions Admin SDK |
| `underwritingVersions` | Authorized | عبر `underwritingVersionCreateAllowed()` | ممنوع | ممنوع | يمنع `v4_ic_approved` المزيفة — مغلقة تماماً أمام كتابة العميل منذ Phase 2R-4E؛ المسار الوحيد المتبقي لكتابة v4 هو `approveOpportunity` عبر Admin SDK ضمن نفس معاملة اعتماد القرار. **[منفّذ محليًا، متحقَّق: تشغيل فعلي 2026-10-04 على Firestore Emulator حقيقي — رُفضت كل محاولات v4_ic_approved من العميل (senior_ic/fund_manager/admin)، ونجحت فقط عبر الدالة؛ ولم تتأثر اللقطة اليدوية manual]** |
| `assetActuals` | Authorized | Authorized + فرصة موجودة + `enteredBy` مطابق | ممنوع | ممنوع | سجل أداء فعلي append-only |
| `icDecisions` | Authorized | **ممنوع تماماً من أي عميل (بما فيه Senior IC وAdmin)** | ممنوع | ممنوع | قرارات لجنة استثمار append-only؛ تُكتَب فقط من `approveOpportunity` عبر Admin SDK ضمن نفس معاملة الاعتماد. تصحيح 2026-10-04: الصيغة السابقة هنا ("Senior IC أو Admin" للإنشاء) كانت خطأً — `firestore.rules` يقول `allow create, update, delete: if false` بلا أي استثناء لدور. **[منفّذ محليًا، متحقَّق: مقروء مباشرة من `firestore.rules` بتاريخ 2026-10-04، ومؤكَّد صريحاً باختبار "a client-side setDoc must now fail for every role, admin included" في `tests/rules/rules.test.mjs`، ضمن 212/212 اختباراً حقيقياً]** |
| `assetLinkRequests` | **ممنوع تماماً من أي عميل، بما فيه Admin** | ممنوع | ممنوع | ممنوع | بوكيينج (bookkeeping) داخلي لإعادة تشغيل `linkAssetToFund` بأمان (idempotent replay)، تكتبه وتقرؤه فقط Admin SDK ضمن نفس المعاملة |
| `icDecisionRequests` | **ممنوع تماماً من أي عميل، بما فيه Admin** | ممنوع | ممنوع | ممنوع | نفس الفكرة أعلاه، لكن لـ`approveOpportunity` (Phase 2R-4E). **[منفّذ محليًا، متحقَّق: تأكَّد بتشغيل فعلي على Firestore Emulator حقيقي بتاريخ 2026-10-04 — رُفضت قراءة/كتابة/تعديل/حذف لكل الأدوار بما فيها Admin وSenior IC، تماماً مثل `assetLinkRequests`]** |

> **تحديث (راجَعتُه مجدداً بتاريخ 2026-10-04 عبر `grep` مباشر على الكود الحقيقي، لا على افتراض
> الجلسة السابقة):** توصية ٥ أدناه — نقل `approveOpportunity`/`linkAssetToFund`/`postCapitalCall` إلى
> واجهة العميل — **[منفّذ محليًا، متحقَّق]**: الثلاثة (بالإضافة إلى `archiveOrDeleteFund`،
> `transitionLedgerRecord`، `reverseTransaction`) موصولة فعلاً عبر
> `firebase.functions().httpsCallable(...)` — خمسة منها في `src/core.js` (تصحيح لصياغة سابقة: ليست
> كلها في `core.js`)، والسادسة (`approveOpportunity`) في `src/features/ic-workflow.js`. الدوال الست
> نفسها مُصدَّرة فعلاً في `functions/index.js` (`exports.approveOpportunity`, `linkAssetToFund`,
> `archiveOrDeleteFund`, `postCapitalCall`, `transitionLedgerRecord`, `reverseTransaction`) — تحقَّق
> مباشرة من نص الكود، لا افتراضاً. ما يبقى **[غير متحقق منه]** من هذه البيئة السحابية هو **النشر
> الفعلي** لهذه الدوال على مشروع Firebase الحقيقي (يتطلب Firebase Console أو بيانات اعتماد إدارية
> حقيقية) — ليس وجودها في الكود ولا ربطها بالواجهة، فكلاهما **[منفّذ محليًا، متحقَّق]** الآن.

## قواعد حرجة يجب عدم التراجع عنها

| القاعدة | السبب |
|---|---|
| `oppAuditLog allow write: if false` | يمنع العميل من تزوير سجل التدقيق |
| `underwritingVersionCreateAllowed()` | يمنع baseline مزيف للأداء الفعلي |
| `recordedBy/savedBy/enteredBy` تطابق المستخدم | يمنع انتحال الهوية |
| قفل `transactions`, `icDecisions`, `assetActuals` | يحافظ على التاريخ المؤسسي |
| بوابة `capitalCalls` و`distributions` | تمنع تجاوز اعتماد رأس المال |
| منع القيود السالبة العادية | يجعل التصحيحات قابلة للتتبع فقط عبر `reversalOfId` |

## اختبارات مطلوبة في CI

> **[منفّذ محليًا، متحقَّق بعد مراجعة فعلية لـ`.github/workflows/ci.yml` بتاريخ 2026-10-04]**: خطوة
> CI لتشغيل هذه الاختبارات **موجودة فعلاً** في المستودع (job باسم "Regression, rules, and functions"،
> يضبط Java 21 وNode 20 ثم يشغّل `npm run test:rules`/`test:functions`/`test:financial`/... عبر
> `package.json` في الجذر). البنود النصية أدناه (تأكيدات داخل `tests/rules/rules.test.mjs`) نفسها
> تحقَّقت فعلياً بتشغيل يدوي حقيقي على جهاز المستخدم بتاريخ 2026-10-04 (`npm --prefix tests/rules
> test` → ALL PASSED، 212 تأكيداً، 0 فشل) **[منفّذ محليًا، متحقَّق]**. ما يبقى **[غير متحقق منه]** من
> هذه البيئة: نتيجة آخر تشغيل فعلي لهذا الـpipeline على GitHub Actions نفسه (ينجح محلياً هنا، لكن
> سجل التشغيل الحقيقي على GitHub غير متاح من هذه البيئة).

- تشغيل `npm --prefix tests/rules test`.
- رفض analyst لإنشاء `mondayTaskQueue`.
- رفض `v4_ic_approved` بدون `sourceDecisionId`.
- رفض إنشاء v4 من أي عميل حتى مع مرجع قرار صحيح؛ وإنشاؤها من الخادم داخل معاملة الاعتماد، مع بقاء إنشاء اللقطة اليدوية مسموحًا وفق القواعد.
- رفض تعديل `oppAuditLog` من أي عميل.
- رفض update/delete للسجلات append-only.
- رفض الالتزامات/النداءات/التوزيعات السالبة إذا لم تكن قيوداً عكسية.

## توصيات إضافية

1. إضافة مراجعة دورية شهرية للقواعد قبل أي نشر.
2. عدم نسخ قواعد من Firebase Console إلى المشروع يدوياً؛ المصدر الوحيد هو `firestore.rules`.
3. إضافة اختبارات لكل Collection جديد قبل نشره.
4. نشر Cloud Functions حتى يكتمل سجل التدقيق الحقيقي.
5. ~~العمليات الحساسة الجديدة يجب نقل واجهتها تدريجياً إلى Cloud Functions~~ — **[منفّذ محليًا، متحقَّق بتاريخ 2026-10-04]**: `approveOpportunity`, `linkAssetToFund`, و`postCapitalCall` (و`archiveOrDeleteFund`, `transitionLedgerRecord`, `reverseTransaction`) مُنفَّذة ومربوطة بالواجهة فعلاً، لا توصية معلَّقة بعد الآن (انظر التحديث أعلى مصفوفة Collections). المتبقي **[غير متحقق منه]**: النشر الفعلي على مشروع Firebase الحقيقي فقط.
