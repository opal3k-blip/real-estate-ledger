# Phase 3B-4A — Financing Baseline (REBUILT after cloud-workspace loss)

## لماذا "REBUILT"
نسخة سابقة من هذا المستند (وكل الكود المرتبط بها) أُنتِجت في بيئة سحابية مؤقتة
انتهت صلاحيتها قبل أن يُدفَع أي شيء إلى GitHub أو إلى جهاز المستخدم. لم يكن هناك
أي `src/domain/financial/financial-engine.js` في هذا المستودع إطلاقاً — تم
التحقق بالبحث الفعلي (`find`, `git log --all`). هذا المستند يُعيد بناء نفس
العمل، لكن هذه المرة **مباشرة ضد `src/core.js` الحقيقي في هذا المستودع**، بنفس
تقنية تحميل `vm.createContext` المُثبَتة في `tests/financial/validation-suite.cjs`.

## الملفات
- `tests/domain/capture-financing-baseline.mjs` — يُشغِّل 14 fixture عبر
  `core.compute()` الحالي بلا أي تعديل، ويكتب `financing-baseline.json`.
- `tests/domain/financing-baseline.json` — الخط الأساسي المُجمَّد (14/14).
- `tests/domain/verify-financing-baseline.mjs` — حارس: يُعيد التشغيل ويقارن
  حرفياً (`assert.deepStrictEqual` بعد تطبيع realm عبر JSON round-trip، لأن
  `core.js` يُحمَّل داخل `vm` context منفصل).

## استشهادات أسطر من `src/core.js` (كما هي اليوم)
- `seniorDebt`/`mezzDebt` تُحسَبان فقط عند `structure==='senior_mezz'`، مرة
  واحدة عند التحجيم الأولي: أسطر 1223-1230.
- `debt = totalDebtTarget` (سطر 1232) — الرقم الوحيد المُصدَّر لاحقاً؛ لا يوجد
  أي استخدام لـ`seniorDebt`/`mezzDebt` بعد هذه النقطة في أي مكان من حلقة السنوات.
- `rawDraw` (تطبيع `drawSchedulePct`): سطر 1237.
- `Kd = interestRate` (سطر 1264)، `amortType = o.financing.amortType||'interest_only'`
  (سطر 1277)، `graceYears = o.financing.graceYears||0` (سطر 1278).
- `remainingDebt` يبدأ بـ`debt` (سطر 1437)؛ `balloonBalanceAtExit` يبدأ صفراً
  (سطر 1439).
- `principalPay = Math.min(remainingDebt, debt/amortYears)` — فقط إذا
  `amortType∈{amortizing, partial_amort_balloon}` (أسطر 1474-1476) — **نفس
  الشرط والصيغة حرفياً لكلا الاسمين** — لا فرق برمجي فعلي اليوم.
- `capitalizedInterestThisYear = capitalizeInterest ? interest : 0` (سطر 1484).
- منطق البالون عند الخروج: أسطر 1507-1543 (`debtPayoff = remainingDebt +
  capitalizedInterestThisYear` ثم `balloonBalanceAtExit = debtPayoff`).
- **تحديث `remainingDebt` (سطر 1647)**:
  `remainingDebt = isLast ? 0 : Math.max(0, remainingDebt - principalPay -
  midTranchePrincipalPay + capitalizedInterestThisYear)` — **حد أدنى فقط
  (`Math.max(0, …)`), بلا أي حد أعلى (سقف/cap) بعد إضافة الفائدة المُرسمَلة**.

## الاكتشافان الحاكمان (مؤكَّدان اليوم ضد الكود الحقيقي)

### GOV-DEBT-001 — Legacy senior/mezz are sizing labels, not facility-level ledgers
مؤكَّد: `seniorDebt`/`mezzDebt` تُستخدَمان فقط لبناء `interestRate` مرجَّح واحد
عند t=0 (سطر 1227). لا وجود لأي متغيّر يتتبَّع senior أو mezz balance بشكل
منفصل بعد هذه النقطة — كل شيء (سحب/فائدة/سداد/رسملة) يعمل على `remainingDebt`
واحد مُدمَج.

**القرار (المستخدم)**: نُبقي في 3B-4B/4C دين Legacy مُدمَجاً واحداً
(`LEGACY_BLENDED_DEBT`) في Shadow Mode. `seniorDebt`/`mezzDebt` تُحفَظ فقط
كـ`legacySizing` توثيقية — لا تُستخدَم لبناء رصيد منفصل. لا تقرير يدَّعي
"Senior closing balance"/"Mezz closing balance" لأن النظام القديم لا يملك
حقيقة مرجعية لذلك. `3B-4D — True Multi-Facility Model` خطوة مستقبلية مستقلة
إن أُريد Senior/Mezz فعليين، بـGolden Master خاص بها.

### GOV-DEBT-002 — Facility cap ليس مُختبَراً بعد الرسملة (T06 مُثبَت رقمياً)
مؤكَّد بالتشغيل الفعلي على `T06-capitalized-interest` (سطر 1647 أعلاه):
`debt = 30,081,669.36` لكن `balloonBalanceAtExit = 32,488,203.29` — تجاوز فعلي
بمقدار **2,406,533.93** (بلا أي رفض أو تحذير في السلوك الحالي).

**القرار (المستخدم)**: لا نفرض الآن Hard Facility Cap. نجعل معنى الحد صريحاً
داخل عقد الـFacility: `{ principalDrawLimit: debt, limitScope:
"PRINCIPAL_DRAWS_ONLY" }` — هذا Legacy mode الحالي. مستقبلاً `limitScope =
"OUTSTANDING_BALANCE"` (principal + capitalized interest ≤ الحد) يُعرِّف
Facility commitment مختلفة فعلياً، مع `FACILITY_LIMIT_BREACH`/
`FUNDING_SHORTFALL` عند التجاوز. تحت `PRINCIPAL_DRAWS_ONLY`، تجاوز T06 هو
PASS بالتعريف — ليس تجاوزاً صامتاً، بل نتيجة معروفة لتعريف الحد الحالي.

### amortizing و partial_amort_balloon — لا فرق اقتصادي فعلي اليوم
نفس الشرط والصيغة حرفياً (أسطر 1474-1476). **القرار**: في Shadow Mode كلاهما
`canonicalLegacyBehavior: "LEGACY_PERIODIC_AMORTIZATION"`، مع الاحتفاظ بالاسم
الأصلي كـ`originalRepaymentMode` metadata فقط.

## اكتشاف جديد لم يكن مؤكَّداً في النسخة المفقودة: `contributedEquity` ≠ `equity`
**هذا تصحيح على النسخة السابقة، وليس تكراراً لها.** كان هناك افتراض ("Equity
كلها Year 0 فعلًا... بلا استثناء واحد") لم يصمد أمام الفحص الفعلي:

- `equity` (الحقل المُصدَّر) = `TPC - debt` عند t=0 فقط — تحجيم أولي.
- `equityCF.push(initialEquityOutlay)` يحدث مرة عند t=0، **لكن
  `equityCF.push(equityFlow)` يحدث أيضاً داخل حلقة السنوات لكل سنة** — أي سنة
  فيها `equityFlow<0` (عادة سنوات سداد/تشغيل بتدفق نقدي سالب) تُضيف مساهمة
  إضافية فعلية إلى `equityCF`.
- `contributedEquity = equityCF.reduce((s,cf)=> s+(cf<0?Math.abs(cf):0), 0)` —
  مجموع كل السنوات السالبة، لا سنة t=0 فقط.
- مُثبَت رقمياً في fixtures هذا الإصدار: `F04-amort-amortizing` (سداد
  amortizing على 5 سنوات تشغيل) يُظهر `equity=20,054,446` لكن
  `contributedEquity=45,082,395` (أكثر من الضعف) — لأن سداد الدين يستهلك تدفق
  المشروع النقدي ويُجبِر مساهمات إضافية من حقوق الملكية في سنوات لاحقة.

**الأثر على غزو 3B-4B**: عند بناء `EQUITY_CONTRIBUTION` events، القيمة
المرجعية للمصالحة (`Σ EQUITY_CONTRIBUTION = legacy equity`) **يجب أن تكون
`contributedEquity`، لا `equity`** — لأن `equity` وحدها لا تعكس إلا السحب
الأول. هذا يعني أن `EQUITY_CONTRIBUTION` events في 3B-4B لن تكون حدثاً واحداً
لكل الحالات دائماً؛ في الحالات التي فيها follow-on calls (كالسداد
amortizing)، يجب أن تظهر أحداث مساهمة إضافية بتواريخ تلك السنوات — **هذا لم
يكن جزءاً من التصميم المفترَض سابقاً (الذي افترض دائماً lump-sum واحد عند
t=0) ويحتاج قرارك قبل المتابعة.**

## تغطية الـfixtures (14/14)
| id | التركيز |
|---|---|
| T01-base-development | بلا drawSchedule، دين أحادي، فائدة نقدية |
| T02-construction-heavy | إنشاء 4 سنوات |
| T05-debt-draw-schedule | جدول سحب 3 سنوات [20/30/50] |
| T06-capitalized-interest | فائدة مُرسمَلة — يُثبِت GOV-DEBT-002 |
| T07-cash-interest | فائدة نقدية — نظير T06 |
| T13-landbank | بنك أراضٍ بدين فعلي (ltc=0.4) |
| T14-one-year-project | أفق سنة واحدة |
| T15-senior-mezz | senior_mezz — يُثبِت GOV-DEBT-001 |
| T18-high-leverage | ltc=0.90 |
| F01-no-debt | ltc=0 |
| F02-empty-draw-schedule-explicit | drawSchedulePct=[] |
| F03-draw-schedule-2yr | جدول سحب سنتين [30/70] |
| F04-amort-amortizing | سداد amortizing — يُثبِت اكتشاف contributedEquity |
| F05-amort-partial-balloon | سداد partial_amort_balloon + graceYears |

## ما لم يتغيَّر
لا تعديل واحد على `src/core.js`. كل الملفات الجديدة قراءة/تشغيل فقط.
`npm run test:financial` (24/24) ما زال أخضر بعد هذا العمل.
