/* =========================================================================
   Phase 3A-1 — Universal Input Validation Engine (SHADOW / READ-ONLY)
   ---------------------------------------------------------------------------
   Pure domain module. No imports, no DOM, no Firestore, no clock, no I/O.
   It NEVER mutates its input and NEVER changes what core.compute() returns.

   Why it exists (verified 2026-10-06 against src/core.js @ 87d4042):
   the engine silently accepts economically impossible inputs and returns
   plausible-looking numbers with no warning, e.g.
     land.price = -5000            -> Equity IRR +146.7%   (sane base: -16.6%)
     development.efficiency = 3.5  -> Equity IRR +182.6%
     strategy.salePct = 7          -> Equity IRR +285%
     financing.ltc = 1.8           -> Equity IRR 19.9%, MOIC 0
     financing.ltc = 1             -> Equity IRR 77,880,506 (zero equity)
     land.area = 0 / land.far = 0  -> NaN IRR with no message
     economics.carry = 1           -> non-finite waterfall figures

   Severity model (every issue carries exactly one):
     BLOCKING   value is impossible (negative where only >= 0 is meaningful,
                a fraction outside its legal range, non-finite / non-numeric)
                or proven to make the engine emit NaN / meaningless numbers.
     INCOMPLETE a required input is still at its blank default and the engine
                is proven to return NaN without it (not a user error yet).
     WARNING    legal but unusual value that deserves a human look.

   Units note: percentages in this codebase are stored as FRACTIONS
   (0.6 means 60%). The most common data-entry error is typing 60 instead of
   0.6; the range rules below catch it and say so in the hint.

   Phase 3A-1 is shadow mode: it reports, it does not block saving, approval
   or calculation. Enforcement is a separate, later package (3A-2).
   ========================================================================= */

export const SEVERITY = Object.freeze({
  BLOCKING: 'BLOCKING',
  INCOMPLETE: 'INCOMPLETE',
  WARNING: 'WARNING',
});

export const STATUS = Object.freeze({
  INVALID: 'INVALID',       // at least one BLOCKING issue
  INCOMPLETE: 'INCOMPLETE', // no BLOCKING, at least one INCOMPLETE
  WARNINGS: 'WARNINGS',     // only WARNING issues
  OK: 'OK',
});

/* ---------- rule tables --------------------------------------------------
   path        dot path into the opportunity object
   kind        'signed'   -> finite number, may be negative; bounded by lo (BELOW_LOWER_BOUND) and max
               'nonneg'   -> must be a finite number >= 0
               'fraction' -> finite number in [0, 1]
               'fraction_lt1' -> finite number in [0, 1)   (1 makes the engine divide by zero)
               'positive' -> finite number > 0
   min / max  HARD sanity bounds (3A-3) that raise BLOCKING: max stops absurd or overflow-scale
              values (e.g. 1e308), min stops a positive-but-meaningless value (e.g. Number.EPSILON
              for an area). Values are never clamped or rounded; they are rejected.
   warnAbove / warnBelow  soft bounds that raise WARNING (only when valid)
   label       Arabic / English field name for messages
   ------------------------------------------------------------------------- */
const R = (path, kind, ar, en, extra) => Object.assign({ path, kind, ar, en }, extra || {});

export const FIELD_RULES = Object.freeze([
  // land
  R('land.area', 'nonneg', 'مساحة الأرض', 'Land area', { min: 1, max: 1e8 }),
  R('land.price', 'nonneg', 'سعر الأرض', 'Land price', { max: 1e12 }),
  R('land.far', 'nonneg', 'معامل البناء (FAR)', 'Floor area ratio (FAR)', { warnAbove: 20, max: 100 }),
  R('land.bar', 'fraction', 'نسبة التغطية (BAR)', 'Building coverage (BAR)', { warnAbove: 0.9 }),
  R('land.floorsAllowed', 'nonneg', 'عدد الأدوار المسموح', 'Floors allowed', { warnAbove: 150, max: 500 }),
  R('land.basements', 'nonneg', 'عدد البدرومات', 'Basements', { warnAbove: 8, max: 20 }),
  R('land.floorHeight', 'nonneg', 'ارتفاع الدور', 'Floor height', { warnAbove: 8, max: 50 }),
  // development
  R('development.salePrice', 'nonneg', 'سعر البيع', 'Sale price', { max: 1e6 }),
  R('development.buildCost', 'nonneg', 'تكلفة البناء', 'Build cost', { warnAbove: 40000, max: 1e6 }),
  R('development.constructionYears', 'nonneg', 'مدة الإنشاء (سنوات)', 'Construction years', { warnAbove: 10, max: 100 }),
  R('development.operationYears', 'nonneg', 'مدة التشغيل (سنوات)', 'Operation years', { warnAbove: 50, max: 100 }),
  R('development.exitCapRate', 'fraction', 'معدل الرسملة عند الخروج', 'Exit cap rate', { warnAbove: 0.2 }),
  R('development.efficiency', 'fraction', 'كفاءة التخطيط', 'Efficiency', { warnAbove: 0.95 }),
  R('development.contingency', 'fraction', 'احتياطي الطوارئ', 'Contingency', { warnAbove: 0.3 }),
  R('development.infraCostPerSqm', 'nonneg', 'تكلفة البنية التحتية للمتر', 'Infrastructure cost per sqm', { max: 1e6 }),
  // strategy
  R('strategy.salePct', 'fraction', 'نسبة البيع', 'Sale share'),
  // income
  R('income.rent', 'nonneg', 'الإيجار', 'Rent', { max: 1e8 }),
  R('income.occupancy', 'fraction', 'الإشغال', 'Occupancy'),
  R('income.opex', 'fraction', 'نسبة المصاريف التشغيلية', 'Opex ratio', { warnAbove: 0.6 }),
  // financing
  R('financing.ltc', 'fraction_lt1', 'نسبة التمويل إلى التكلفة (LTC)', 'Loan-to-cost (LTC)', { warnAbove: 0.85 }),
  R('financing.saibor', 'nonneg', 'سايبور', 'SAIBOR', { warnAbove: 0.2, max: 1 }),
  R('financing.margin', 'nonneg', 'هامش التمويل', 'Financing margin', { warnAbove: 0.1, max: 1 }),
  R('financing.tenor', 'nonneg', 'مدة التمويل', 'Debt tenor', { warnAbove: 40, max: 100 }),
  R('financing.seniorPct', 'fraction', 'نسبة الدين الأول', 'Senior share'),
  R('financing.graceYears', 'nonneg', 'فترة السماح', 'Grace years', { max: 100 }),
  R('financing.amortYears', 'nonneg', 'مدة الإطفاء', 'Amortisation years', { max: 100 }),
  // exit costs / fees (all stored as fractions of the relevant base)
  R('exitCosts.broker', 'fraction', 'عمولة الوساطة عند الخروج', 'Exit broker cost'),
  R('exitCosts.legal', 'fraction', 'التكاليف القانونية عند الخروج', 'Exit legal cost'),
  R('exitCosts.rett', 'fraction', 'ضريبة التصرفات العقارية', 'RETT'),
  R('exitCosts.exitFee', 'fraction', 'رسوم الخروج', 'Exit fee'),
  R('fees.mgmt', 'fraction', 'رسوم الإدارة', 'Management fee', { warnAbove: 0.05 }),
  R('fees.acquisition', 'fraction', 'رسوم الاستحواذ', 'Acquisition fee', { warnAbove: 0.05 }),
  R('fees.disposition', 'fraction', 'رسوم التخارج', 'Disposition fee', { warnAbove: 0.05 }),
  R('fees.assetMgmt', 'fraction', 'رسوم إدارة الأصل', 'Asset management fee', { warnAbove: 0.05 }),
  R('fees.propMgmt', 'fraction', 'رسوم إدارة العقار', 'Property management fee', { warnAbove: 0.15 }),
  R('fees.regAuditCustodian', 'nonneg', 'رسوم التنظيم والتدقيق والحفظ', 'Reg/audit/custody fees', { max: 1e10 }),
  // economics
  R('economics.hurdle', 'fraction', 'العائد التفضيلي (Hurdle)', 'Hurdle', { warnAbove: 0.25 }),
  R('economics.carry', 'fraction_lt1', 'الحافز (Carry)', 'Carry', { warnAbove: 0.4 }),
  /* IC criteria (3A-3). These are the thresholds the readiness gate compares results against. A forged
     or mistyped threshold (DSCR floor of -5, "pre-sold 500%") silently makes a gate meaningless, so they
     are validated like any other input. 'signed' kind = may be negative (a return floor of -100% = "no
     floor"), bounded by lo/max. */
  R('criteria.irrMin', 'signed', 'الحد الأدنى المطلوب لعائد الملكية (IRR)', 'Required minimum equity IRR', { lo: -1, max: 10 }),
  R('criteria.projIrrMin', 'signed', 'الحد الأدنى المطلوب لعائد المشروع (IRR)', 'Required minimum project IRR', { lo: -1, max: 10 }),
  R('criteria.moicMin', 'nonneg', 'الحد الأدنى المطلوب لمضاعف رأس المال (MOIC)', 'Required minimum MOIC', { max: 100 }),
  R('criteria.dscrMin', 'nonneg', 'الحد الأدنى المطلوب لتغطية خدمة الدين (DSCR)', 'Required minimum DSCR', { max: 100, warnBelow: 1 }),
  R('criteria.yocMin', 'fraction', 'الحد الأدنى المطلوب للعائد على التكلفة', 'Required minimum yield on cost'),
  R('criteria.preLeasingMin', 'fraction', 'الحد الأدنى المطلوب للتأجير المسبق', 'Required minimum pre-leasing'),
  R('criteria.preSaleMin', 'fraction', 'الحد الأدنى المطلوب للبيع المسبق', 'Required minimum pre-sales'),
  R('criteria.preLeasingActual', 'fraction', 'نسبة التأجير المسبق الفعلية', 'Actual pre-leasing'),
  R('criteria.preSaleActual', 'fraction', 'نسبة البيع المسبق الفعلية', 'Actual pre-sales'),
]);

/* Scenario multipliers must be strictly positive; deltas are free-form numbers. */
const SCENARIO_MULT_FIELDS = ['rentMult', 'salePriceMult', 'costMult'];
const SCENARIO_DELTA_FIELDS = ['capRateDelta', 'rateDelta'];

function getPath(obj, path) {
  let x = obj;
  for (const k of path.split('.')) {
    if (x === null || x === undefined || typeof x !== 'object') return undefined;
    x = x[k];
  }
  return x;
}

function issue(code, severity, path, value, messageAr, messageEn, hintAr, hintEn) {
  const i = { code, severity, path, value: safeValue(value), messageAr, messageEn };
  if (hintAr) i.hintAr = hintAr;
  if (hintEn) i.hintEn = hintEn;
  return i;
}

function safeValue(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'string') return v.length > 40 ? v.slice(0, 40) + '…' : v;
  if (v === null || v === undefined || typeof v === 'boolean') return v === undefined ? null : v;
  return '[' + typeof v + ']';
}

/* Returns { value, stringNumeric } or { invalid:true }.
   null / undefined are NOT validated (absent field = nothing to judge here;
   the data-quality engine owns completeness). */
function coerce(v) {
  if (v === null || v === undefined) return { absent: true };
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v } : { invalid: true };
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return { absent: true };
    const n = Number(t);
    return Number.isFinite(n) ? { value: n, stringNumeric: true } : { invalid: true };
  }
  return { invalid: true };
}

function checkField(d, rule, out) {
  const raw = getPath(d, rule.path);
  const c = coerce(raw);
  if (c.absent) return;
  if (c.invalid) {
    out.push(issue('NOT_A_FINITE_NUMBER', SEVERITY.BLOCKING, rule.path, raw,
      `${rule.ar}: القيمة ليست رقمًا صالحًا.`,
      `${rule.en}: value is not a valid finite number.`));
    return;
  }
  const v = c.value;
  if (c.stringNumeric) {
    /* 3A-3: was a WARNING. Measured on the 34 reference fixtures: a numeric string silently CHANGES
       the headline metrics for 6 fields (construction/operation years, contingency, SAIBOR, margin,
       grace years) because the engine concatenates with '+'. Text where a number is required is
       therefore rejected, never coerced. */
    out.push(issue('NUMERIC_STRING', SEVERITY.BLOCKING, rule.path, raw,
      `${rule.ar}: القيمة نص وليست رقمًا — أدخلها كرقم.`,
      `${rule.en}: value is text, not a number — enter it as a number.`));
    return;
  }
  let bad = false;
  let code = null;
  if (v < 0 && rule.kind !== 'signed') { bad = true; code = 'NEGATIVE_NOT_ALLOWED'; }
  else if (rule.kind === 'fraction' && v > 1) { bad = true; code = 'FRACTION_ABOVE_ONE'; }
  else if (rule.kind === 'fraction_lt1' && v >= 1) { bad = true; code = 'FRACTION_AT_OR_ABOVE_ONE'; }
  else if (rule.kind === 'positive' && v <= 0) { bad = true; code = 'MUST_BE_POSITIVE'; }
  if (bad) {
    const looksLikePercent = v > 1 && v <= 100 && (rule.kind === 'fraction' || rule.kind === 'fraction_lt1');
    const asFraction = looksLikePercent ? Number((v / 100).toPrecision(12)) : null;
    const hintAr = looksLikePercent ? `هل أدخلت ${v} بدلًا من ${asFraction}؟ النسب تُخزَّن ككسور (0.6 = 60%).` : undefined;
    const hintEn = looksLikePercent ? `Did you enter ${v} instead of ${asFraction}? Percentages are stored as fractions (0.6 = 60%).` : undefined;
    let ar; let en;
    if (code === 'NEGATIVE_NOT_ALLOWED') {
      ar = `${rule.ar}: قيمة سالبة غير مقبولة اقتصاديًا.`; en = `${rule.en}: a negative value is not economically valid.`;
    } else if (code === 'FRACTION_AT_OR_ABOVE_ONE') {
      ar = `${rule.ar}: يجب أن تكون أقل من 1 (100%) وإلا ينهار الحساب.`; en = `${rule.en}: must be below 1 (100%) or the calculation breaks down.`;
    } else if (code === 'FRACTION_ABOVE_ONE') {
      ar = `${rule.ar}: لا يمكن أن تتجاوز 1 (100%).`; en = `${rule.en}: cannot exceed 1 (100%).`;
    } else {
      ar = `${rule.ar}: يجب أن تكون أكبر من صفر.`; en = `${rule.en}: must be greater than zero.`;
    }
    out.push(issue(code, SEVERITY.BLOCKING, rule.path, raw, ar, en, hintAr, hintEn));
    return;
  }
  if (rule.lo !== undefined && v < rule.lo) {
    out.push(issue('BELOW_LOWER_BOUND', SEVERITY.BLOCKING, rule.path, raw,
      `${rule.ar}: القيمة أقل من الحد الأدنى المقبول (${rule.lo}).`,
      `${rule.en}: value is below the lowest accepted (${rule.lo}).`));
    return;
  }
  if (rule.max !== undefined && v > rule.max) {
    out.push(issue('ABOVE_MAX', SEVERITY.BLOCKING, rule.path, raw,
      `${rule.ar}: القيمة تتجاوز الحد الأقصى المقبول (${rule.max}).`,
      `${rule.en}: value exceeds the maximum accepted (${rule.max}).`));
    return;
  }
  if (rule.min !== undefined && v > 0 && v < rule.min) {
    out.push(issue('BELOW_MIN', SEVERITY.BLOCKING, rule.path, raw,
      `${rule.ar}: القيمة أقل من الحد الأدنى ذي المعنى (${rule.min}).`,
      `${rule.en}: value is below the smallest meaningful amount (${rule.min}).`));
    return;
  }
  if (rule.warnAbove !== undefined && v > rule.warnAbove) {
    out.push(issue('UNUSUALLY_HIGH', SEVERITY.WARNING, rule.path, raw,
      `${rule.ar}: قيمة مرتفعة بشكل غير معتاد (${v}) — تأكد من صحتها.`,
      `${rule.en}: unusually high value (${v}) — please confirm.`));
  }
  if (rule.warnBelow !== undefined && v < rule.warnBelow) {
    out.push(issue('UNUSUALLY_LOW', SEVERITY.WARNING, rule.path, raw,
      `${rule.ar}: قيمة منخفضة بشكل غير معتاد (${v}) — تأكد من صحتها.`,
      `${rule.en}: unusually low value (${v}) — please confirm.`));
  }
}

function numOrNull(d, path) {
  const c = coerce(getPath(d, path));
  return c.value === undefined ? null : c.value;
}

function checkCrossField(d, out) {
  const type = getPath(d, 'meta.oppType');
  const area = numOrNull(d, 'land.area');
  const far = numOrNull(d, 'land.far');
  const salePrice = numOrNull(d, 'development.salePrice');
  const salePct = numOrNull(d, 'strategy.salePct');

  // Proven NaN triggers (probe 2026-10-06): land.area = 0 -> NaN for every
  // opportunity type; land.far = 0 -> NaN for development and income.
  if (area === 0) {
    out.push(issue('REQUIRED_INPUT_MISSING', SEVERITY.INCOMPLETE, 'land.area', 0,
      'مساحة الأرض غير مُدخلة (صفر): أدخل مساحة الأرض لتتمكّن المنصة من احتساب العوائد.',
      'Land area is not entered (zero): enter the land area so returns can be calculated.'));
  }
  if (far === 0 && (type === 'development' || type === 'income')) {
    out.push(issue('REQUIRED_INPUT_MISSING', SEVERITY.INCOMPLETE, 'land.far', 0,
      'معامل البناء (FAR) غير مُدخل (صفر): أدخله لتتمكّن المنصة من احتساب العوائد لهذا النوع من الفرص.',
      'Floor-area ratio (FAR) is not entered (zero): enter it so returns can be calculated for this opportunity type.'));
  }
  // development + sale share > 0 + sale price = 0 -> NaN (proven)
  if (type === 'development' && salePrice === 0 && salePct !== null && salePct > 0) {
    out.push(issue('REQUIRED_INPUT_MISSING', SEVERITY.INCOMPLETE, 'development.salePrice', 0,
      'سعر البيع غير مُدخل (صفر) مع وجود نسبة بيع: أدخل سعر البيع لتتمكّن المنصة من احتساب العوائد.',
      'Sale price is not entered (zero) although a sale share is set: enter the sale price so returns can be calculated.'));
  }

  // exit costs as a whole
  const exitSum = ['exitCosts.broker', 'exitCosts.legal', 'exitCosts.rett', 'exitCosts.exitFee', 'fees.disposition']
    .map((p) => numOrNull(d, p)).filter((x) => x !== null && x >= 0).reduce((a, b) => a + b, 0);
  if (exitSum >= 1) {
    out.push(issue('EXIT_COSTS_TOTAL_AT_OR_ABOVE_ONE', SEVERITY.BLOCKING, 'exitCosts.*', exitSum,
      'مجموع تكاليف الخروج يساوي أو يتجاوز 100% من قيمة البيع.',
      'Total exit costs equal or exceed 100% of the sale value.'));
  } else if (exitSum > 0.15) {
    out.push(issue('EXIT_COSTS_TOTAL_HIGH', SEVERITY.WARNING, 'exitCosts.*', exitSum,
      `مجموع تكاليف الخروج مرتفع (${(exitSum * 100).toFixed(1)}%).`,
      `Total exit costs are high (${(exitSum * 100).toFixed(1)}%).`));
  }

  // economics shares
  const lp = numOrNull(d, 'economics.lpShare');
  const gp = numOrNull(d, 'economics.gpShare');
  const dv = numOrNull(d, 'economics.devShare');
  [['economics.lpShare', lp], ['economics.gpShare', gp], ['economics.devShare', dv]].forEach(([p, v]) => {
    if (v !== null && (v < 0 || v > 1)) {
      out.push(issue(v < 0 ? 'NEGATIVE_NOT_ALLOWED' : 'FRACTION_ABOVE_ONE', SEVERITY.BLOCKING, p, v,
        'حصة في هيكل الملكية خارج النطاق 0–1.', 'Ownership share outside the 0–1 range.'));
    }
  });

  // scenarios
  const sc = getPath(d, 'scenarios');
  if (sc && typeof sc === 'object') {
    Object.keys(sc).forEach((key) => {
      const s = sc[key];
      if (!s || typeof s !== 'object') return;
      SCENARIO_MULT_FIELDS.forEach((f) => {
        const c = coerce(s[f]);
        if (c.absent) return;
        const p = `scenarios.${key}.${f}`;
        if (c.invalid || c.value <= 0) {
          out.push(issue(c.invalid ? 'NOT_A_FINITE_NUMBER' : 'MUST_BE_POSITIVE', SEVERITY.BLOCKING, p, s[f],
            'مضاعف السيناريو يجب أن يكون رقمًا أكبر من صفر.', 'Scenario multiplier must be a number greater than zero.'));
        } else if (c.value < 0.3 || c.value > 3) {
          out.push(issue('UNUSUALLY_EXTREME', SEVERITY.WARNING, p, s[f],
            `مضاعف السيناريو متطرف (${c.value}).`, `Scenario multiplier is extreme (${c.value}).`));
        }
      });
      SCENARIO_DELTA_FIELDS.forEach((f) => {
        const c = coerce(s[f]);
        if (c.absent) return;
        if (c.invalid) {
          out.push(issue('NOT_A_FINITE_NUMBER', SEVERITY.BLOCKING, `scenarios.${key}.${f}`, s[f],
            'قيمة تغيّر السيناريو ليست رقمًا صالحًا.', 'Scenario delta is not a valid number.'));
        }
      });
    });
  }

  // draw schedule
  const ds = getPath(d, 'financing.drawSchedulePct');
  if (Array.isArray(ds) && ds.length) {
    let bad = false;
    let sum = 0;
    ds.forEach((x) => {
      const c = coerce(x);
      if (c.invalid || c.absent || c.value < 0 || c.value > 1) bad = true; else sum += c.value;
    });
    if (bad) {
      out.push(issue('DRAW_SCHEDULE_ENTRY_INVALID', SEVERITY.BLOCKING, 'financing.drawSchedulePct', null,
        'جدول السحب يحتوي قيمة غير صالحة (يجب أن تكون كل شريحة بين 0 و1).',
        'Draw schedule has an invalid entry (each tranche must be between 0 and 1).'));
    } else if (sum > 1 + 1e-9) {
      out.push(issue('DRAW_SCHEDULE_SUM_ABOVE_ONE', SEVERITY.BLOCKING, 'financing.drawSchedulePct', sum,
        `مجموع جدول السحب ${sum.toFixed(4)} يتجاوز 1 (100%).`,
        `Draw schedule sums to ${sum.toFixed(4)}, above 1 (100%).`));
    } else if (Math.abs(sum - 1) > 1e-6) {
      out.push(issue('DRAW_SCHEDULE_SUM_NOT_ONE', SEVERITY.WARNING, 'financing.drawSchedulePct', sum,
        `مجموع جدول السحب ${sum.toFixed(4)} لا يساوي 1.`,
        `Draw schedule sums to ${sum.toFixed(4)}, not 1.`));
    }
  }
}

function finish(blocking, incomplete, warnings, checked) {
  const status = blocking.length ? STATUS.INVALID
    : incomplete.length ? STATUS.INCOMPLETE
      : warnings.length ? STATUS.WARNINGS : STATUS.OK;
  return { status, blocking, incomplete, warnings, checked };
}

/**
 * Validate the raw inputs of an opportunity. Pure; never throws for bad data
 * (a non-object input is reported as a BLOCKING issue).
 */
export function validateOpportunityInputs(d) {
  if (d === null || typeof d !== 'object' || Array.isArray(d)) {
    return finish([issue('INPUT_NOT_AN_OBJECT', SEVERITY.BLOCKING, '', d,
      'بيانات الفرصة ليست كائنًا صالحًا.', 'Opportunity data is not a valid object.')], [], [], 0);
  }
  const all = [];
  FIELD_RULES.forEach((r) => checkField(d, r, all));
  checkCrossField(d, all);
  return finish(
    all.filter((i) => i.severity === SEVERITY.BLOCKING),
    all.filter((i) => i.severity === SEVERITY.INCOMPLETE),
    all.filter((i) => i.severity === SEVERITY.WARNING),
    FIELD_RULES.length,
  );
}

const OUTPUT_LABELS = {
  equityIRR: ['العائد على حقوق الملكية (IRR)', 'Equity IRR'],
  projectIRR: ['عائد المشروع (IRR)', 'Project IRR'],
  MOIC: ['مضاعف رأس المال (MOIC)', 'Equity multiple (MOIC)'],
  npv: ['صافي القيمة الحالية (NPV)', 'Net present value (NPV)'],
};
const HEADLINE_OUTPUT_KEYS = ['equityIRR', 'projectIRR', 'MOIC', 'npv'];

/**
 * Validate the OUTPUT of core.compute(): any non-finite headline metric
 * (NaN / Infinity) is reported, and so is an implausible Equity IRR
 * (above 10x per year or below -100%), which in practice means zero equity or
 * a broken input rather than a real return.
 */
export function validateComputationOutputs(c) {
  if (c === null || typeof c !== 'object') {
    return finish([issue('OUTPUT_NOT_AN_OBJECT', SEVERITY.BLOCKING, '', c,
      'نتيجة الحساب غير صالحة.', 'Computation result is not valid.')], [], [], 0);
  }
  const blocking = [];
  const warnings = [];
  let checked = 0;
  HEADLINE_OUTPUT_KEYS.forEach((k) => {
    if (!(k in c)) return;
    checked += 1;
    const v = c[k];
    if (typeof v === 'number' && !Number.isFinite(v)) {
      blocking.push(issue('OUTPUT_NOT_FINITE', SEVERITY.BLOCKING, `result.${k}`, v,
        `تعذّر احتساب ${(OUTPUT_LABELS[k] || [k])[0]} بسبب المدخلات الحالية — راجع المدخلات.`,
        `${(OUTPUT_LABELS[k] || [null, k])[1]} could not be calculated from the current inputs — review the inputs.`));
    }
  });
  if (typeof c.equityIRR === 'number' && Number.isFinite(c.equityIRR)) {
    if (c.equityIRR > 10 || c.equityIRR < -1) {
      blocking.push(issue('OUTPUT_IMPLAUSIBLE_IRR', SEVERITY.BLOCKING, 'result.equityIRR', c.equityIRR,
        `العائد على حقوق الملكية (${(c.equityIRR * 100).toFixed(0)}%) غير معقول — غالبًا حقوق ملكية صفرية أو مدخل خاطئ.`,
        `Equity IRR (${(c.equityIRR * 100).toFixed(0)}%) is implausible — usually zero equity or a wrong input.`));
    } else if (c.equityIRR > 1) {
      warnings.push(issue('OUTPUT_VERY_HIGH_IRR', SEVERITY.WARNING, 'result.equityIRR', c.equityIRR,
        `العائد على حقوق الملكية مرتفع جدًا (${(c.equityIRR * 100).toFixed(0)}%) — راجع الافتراضات.`,
        `Equity IRR is very high (${(c.equityIRR * 100).toFixed(0)}%) — review the assumptions.`));
    }
  }
  return finish(blocking, [], warnings, checked);
}

/** Convenience: merge input and output validation into one report. */
export function validateOpportunity(d, c) {
  const a = validateOpportunityInputs(d);
  if (c === undefined) return a;
  const b = validateComputationOutputs(c);
  // A non-finite output that is already explained by a missing required input is a
  // consequence of INCOMPLETE data, not a separate user error: report it as INCOMPLETE so
  // the status stays "incomplete" instead of "invalid". With no such explanation (no
  // INCOMPLETE input issue) an unexplained NaN stays BLOCKING — it signals a real defect.
  const explained = a.incomplete.length > 0;
  const outBlocking = [];
  const outIncomplete = b.incomplete.slice();
  b.blocking.forEach((i) => {
    if (explained && i.code === 'OUTPUT_NOT_FINITE') outIncomplete.push(Object.assign({}, i, { severity: SEVERITY.INCOMPLETE }));
    else outBlocking.push(i);
  });
  return finish(
    a.blocking.concat(outBlocking),
    a.incomplete.concat(outIncomplete),
    a.warnings.concat(b.warnings),
    a.checked + b.checked,
  );
}
