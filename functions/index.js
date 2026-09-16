/* =========================================================================
   Cloud Function — سجل التدقيق غير القابل للتلاعب (Immutable Audit Trail)
   المرحلة السابعة، P0 #3: "الـ Audit Trail ليس Immutable بالكامل"
   ---------------------------------------------------------------------------
   السياق: كانت firestore.rules تسمح لأي عميل مصرَّح له بالكتابة المباشرة على
   مجموعة oppAuditLog (allow read, create: if isAuthorized()) — أي أن العميل
   (حتى لو مطابقاً لعمليته الحقيقية) هو من يكتب "دليل" سلوكه بنفسه، وهذا يُبطل
   قيمة السجل كإثبات موثوق. القاعدة الآن (../../firestore.rules):

       match /oppAuditLog/{id} {
         allow read: if isAuthorized();
         allow write: if false;   // لا كتابة عميل نهائياً — ولا حتى الأدمن
       }

   الكتابة الوحيدة المسموحة هي من هذه الدالة، التي تعمل بصلاحيات Admin SDK —
   والتي تتجاوز Security Rules تماماً بتصميم Firebase نفسه (هذا ليس التفافاً
   حول الحماية، بل هو "الخادم الموثوق" الذي تتحدث عنه الحوكمة: User →
   Application → Server Function → Immutable Audit Event). أي تعديل على وثيقة
   فرصة عبر أي طريق (الواجهة، سكربت لاحق، استيراد بيانات) سيُنتج سجل تدقيق
   تلقائياً — العميل لا يتحكم بذلك ولا يمكنه منعه أو تزييفه.

   ---------------------------------------------------------------------------
   ⚠️ نشر هذه الدالة يتطلب:
     ١. مشروع Firebase على خطة Blaze (الدفع بحسب الاستخدام) — Cloud Functions
        من الجيل الثاني (v2، onDocumentWritten) لا تعمل على خطة Spark المجانية.
        التكلفة المتوقعة لحجم استخدام معتاد لصندوق عقاري (عشرات-مئات الفرص،
        تعديلات يومية محدودة) ضئيلة جداً (ضِمن الحد المجاني لـ Blaze نفسه في
        الغالب: أول مليونَي استدعاء شهرياً مجانية).
     ٢. تسجيل الدخول عبر Firebase CLI (firebase login) وربط المشروع الصحيح
        (firebase use real-estate-ledger-f85a6 — أو أي مشروع آخر لديك بحسب
        .firebaserc).
     ٣. من داخل مجلد functions/: npm install، ثم من جذر المستودع:
        firebase deploy --only functions
     لا يمكنني (Claude) نشر هذه الدالة نيابةً عنك على مشروع Firebase الحقيقي —
     الكود مكتمل ومُختبَر بنيوياً هنا، لكن النشر الفعلي يتطلب صلاحياتك أنت على
     حسابك السحابي. راجع README.md في هذا المجلد لخطوات مفصَّلة.
   ========================================================================= */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();
const db = getFirestore();

const AUDIT_COLLECTION = 'oppAuditLog';
const APPROVAL_DECISIONS = new Set(['approve', 'approve_conditions']);

// نفس FIELD_LABELS بالضبط من src/features/audit-trail.js — أي إضافة/تعديل
// هناك يجب أن يُنسَخ هنا أيضاً (بيئتان منفصلتان: المتصفح ES module هنا Node
// CommonJS، لا استيراد مشترك ممكن بين bundle العميل ودالة الخادم بلا أداة
// بناء إضافية — النسخ المتعمَّد هنا أبسط وأوضح من تعقيد مشاركة كود لملف واحد
// صغير نسبياً).
const FIELD_LABELS = {
  'meta.name': 'اسم الفرصة', 'meta.city': 'المدينة', 'meta.neighborhood': 'الحي', 'meta.tier': 'الفئة',
  'meta.oppType': 'نوع الفرصة', 'meta.useType': 'نوع الاستخدام', 'meta.analyst': 'المحلل المسؤول',
  'land.area': 'مساحة الأرض', 'land.price': 'سعر متر الأرض', 'land.far': 'معامل البناء (FAR)', 'land.bar': 'نسبة البناء (BAR)',
  'strategy.exitStrategy': 'استراتيجية الخروج', 'strategy.salePct': 'نسبة البيع',
  'income.rent': 'الإيجار السنوي/م²', 'income.occupancy': 'نسبة الإشغال', 'income.opex': 'نسبة المصاريف التشغيلية',
  'development.salePrice': 'سعر البيع المتوقع/م²', 'development.buildCost': 'تكلفة البناء/م²',
  'development.constructionYears': 'مدة الإنشاء (سنوات)', 'development.exitCapRate': 'معدل رسملة الخروج',
  'landbank.appreciation': 'معدل نمو قيمة الأرض', 'landbank.holdingYears': 'مدة الاحتفاظ',
  'financing.ltc': 'نسبة التمويل إلى التكلفة (LTC)', 'financing.saibor': 'السايبور', 'financing.margin': 'هامش البنك',
  'financing.shariahStructure': 'الهيكل الشرعي للتمويل',
  'criteria.irrMin': 'الحد الأدنى لـ Equity IRR', 'criteria.moicMin': 'الحد الأدنى لـ MOIC',
  'subscription.minInvestment': 'الحد الأدنى للاستثمار', 'economics.hurdle': 'العائد التفضيلي (Hurdle)', 'economics.carry': 'حصة الأرباح (Carry)',
};
// نفس IGNORE_PATHS بالضبط من audit-trail.js.
const IGNORE_PATHS = new Set(['meta.updatedAt', 'meta.updatedBy', 'meta.createdAt', 'meta.createdBy', 'id', 'audit.changeReason']);

function fieldLabel(path) { return FIELD_LABELS[path] || path; }
function isPlainObject(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

/* نفس منطق deepDiff بالضبط من audit-trail.js — أي تعديل على قواعد الفرق نفسها
   (حقول تُتجاهَل، طريقة مقارنة المصفوفات...) يجب أن يُطبَّق في الملفين معاً. */
function deepDiff(oldObj, newObj, prefix, out) {
  out = out || [];
  const keys = new Set([...(oldObj ? Object.keys(oldObj) : []), ...(newObj ? Object.keys(newObj) : [])]);
  for (const k of keys) {
    const path = prefix ? prefix + '.' + k : k;
    if (IGNORE_PATHS.has(path)) continue;
    const ov = oldObj ? oldObj[k] : undefined;
    const nv = newObj ? newObj[k] : undefined;
    if (isPlainObject(ov) || isPlainObject(nv)) {
      deepDiff(isPlainObject(ov) ? ov : {}, isPlainObject(nv) ? nv : {}, path, out);
      continue;
    }
    const ovs = Array.isArray(ov) ? JSON.stringify(ov) : ov;
    const nvs = Array.isArray(nv) ? JSON.stringify(nv) : nv;
    if (ovs !== nvs) {
      out.push({ path, before: ov === undefined ? null : ov, after: nv === undefined ? null : nv });
    }
  }
  return out;
}

/* من قام بالتغيير فعلياً؟ نعتمد على meta.updatedBy/createdBy في المستند نفسه —
   وهذا الحقل محمي الآن في firestore.rules بقاعدة attributionHonest() التي
   تفرض أن يطابق دائماً بريد المستخدم المصادَق عليه فعلياً (request.auth.token.
   email) وقت الكتابة، فلا يمكن لعميل تزييف هوية "مَن غيَّر ماذا" في المستند —
   وهذا بالضبط ما يجعل الاعتماد على هذا الحقل هنا (من دالة خادم موثوقة) آمناً. */
function actorFromData(data, isCreate) {
  const meta = (data && data.meta) || {};
  return (isCreate ? meta.createdBy : meta.updatedBy) || meta.updatedBy || meta.createdBy || 'unknown';
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function roleRank(role) {
  return { analyst: 1, senior_ic: 2, fund_manager: 3, admin: 4 }[role] || 0;
}

function requireEmail(request) {
  const email = request.auth && request.auth.token && request.auth.token.email;
  if (!email) throw new HttpsError('unauthenticated', 'Authentication required.');
  return String(email).toLowerCase();
}

// نفس بريدَي الأدمن بالضبط من isAdminEmail() في firestore.rules — يجب أن يتطابق التعريفان دائماً
// (تكرار متعمَّد: بيئتان منفصلتان بلا استيراد مشترك ممكن، كما في FIELD_LABELS أعلاه).
const ADMIN_EMAILS = new Set(['opal3k@gmail.com', 'ggocss@gmail.com']);
function isAdminEmail(email) {
  return ADMIN_EMAILS.has(email);
}

async function roleForEmail(email) {
  if (isAdminEmail(email)) return 'admin';
  const snap = await db.collection('team_roles').doc(email).get();
  return snap.exists ? ((snap.data() || {}).role || 'analyst') : 'analyst';
}

/* =========================================================================
   P0 — Trusted Transaction Layer، إغلاق إضافي مكتشَف أثناء هذه المرحلة (لم يطلبه
   المستخدم صراحةً، لكنه بنفس روح "لا ثقة بالعميل" التي تحكم هذه المرحلة كاملة):
   requireRole() كانت تتحقق من الدور (team_roles) فقط، بلا أي تحقق من أن البريد
   لا يزال ضمن قائمة الفريق المصرَّح لها أصلاً (team_members) ولم تنتهِ مدة وصوله
   (expiresAt) — بعكس isAllowlisted() في firestore.rules التي تفرض الشرطين معاً.
   عضو فريق أُزيل من team_members، أو انتهت مدة عضويته، كان يبقى قادراً تقنياً على
   استدعاء أي من دوال هذا الملف طالما بقي مستنداً في team_roles (الذي لا يُحذَف
   تلقائياً عند إزالة العضو من team_members). requireAuthorized() هنا تُطابق منطق
   isAllowlisted() تماماً (الأدمن دائماً مُستثنى، كما في القواعد). */
async function requireAuthorized(email) {
  if (isAdminEmail(email)) return;
  const snap = await db.collection('team_members').doc(email).get();
  if (!snap.exists) throw new HttpsError('permission-denied', 'Not an authorized team member.');
  const expiresAt = (snap.data() || {}).expiresAt;
  if (expiresAt) {
    const expiryMs = typeof expiresAt.toMillis === 'function' ? expiresAt.toMillis() : new Date(expiresAt).getTime();
    if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
      throw new HttpsError('permission-denied', 'Team access has expired.');
    }
  }
}

async function requireRole(email, minRole) {
  await requireAuthorized(email);
  const role = await roleForEmail(email);
  if (roleRank(role) < roleRank(minRole)) {
    throw new HttpsError('permission-denied', `Requires ${minRole} role.`);
  }
  return role;
}

function basicReadinessOk(readiness) {
  if (!readiness || readiness.ready !== true) return false;
  const gates = readiness.gates || {};
  return Object.keys(gates).every((k) => !gates[k] || gates[k].ok !== false);
}

function decisionConditionsMet(decision) {
  if (!decision || decision.decision !== 'approve_conditions') return true;
  const conditions = Array.isArray(decision.conditions) ? decision.conditions : [];
  return conditions.length > 0 && conditions.every((c) => c && c.status === 'met');
}

function assertLedgerAmount(data, fieldName) {
  const amount = n(data && data[fieldName]);
  if ((data && data.reversalOfId) ? amount >= 0 : amount < 0) {
    throw new HttpsError('failed-precondition', 'Negative ledger entries must be linked reversals only.');
  }
}

async function committedForInvestorTx(tx, fundId, investorId) {
  const snap = await tx.get(db.collection('commitments').where('fundId', '==', fundId).where('investorId', '==', investorId));
  let total = 0;
  snap.forEach((doc) => { total += n((doc.data() || {}).commitmentAmount); });
  return total;
}

async function paidCallsForInvestorTx(tx, fundId, investorId) {
  const snap = await tx.get(db.collection('capitalCalls').where('fundId', '==', fundId).where('investorId', '==', investorId).where('status', '==', 'paid'));
  let total = 0;
  snap.forEach((doc) => { total += n((doc.data() || {}).amount); });
  return total;
}

async function allocatedElsewhereTx(tx, fund, excludeOppId) {
  const ids = (fund.assetIds || []).filter((id) => id !== excludeOppId);
  let total = 0;
  for (const id of ids) {
    const oppSnap = await tx.get(db.collection('opportunities').doc(id));
    if (!oppSnap.exists) continue;
    const alloc = ((oppSnap.data() || {}).capitalAllocation) || {};
    total += n(alloc.targetEquity);
  }
  return total;
}

/* ⚠️ TEMPORARY TRUST BOUNDARY (P0 — Trusted Transaction Layer، قرار معماري صريح من المستخدم):
   `readiness` أدناه لا يزال بيانات "يُصرِّح بها العميل" (نتيجة icReadiness(core, draft) المحسوبة
   في المتصفح) لا يُعاد حسابها هنا على الخادم — basicReadinessOk() تتحقق فقط من *شكل* الكائن
   (ready===true وكل بوابة داخله ok!==false)، لا من صحة الأرقام المالية/DD/الأدلة/التخطيط/التسعير
   التي أنتجت تلك النتيجة أصلاً. هذا يعني: عميل يتلاعب بواجهته (لا بـ Firestore مباشرة — ذلك
   مقفول الآن) لا يزال يقدر نظرياً يُرسل `readiness:{ready:true, gates:{}}` مصطنعة لهذه الدالة.
   القرار الصريح لهذه المرحلة (بعد نقاش معماري كامل مع المستخدم) هو تأجيل الإصلاح الكامل لمرحلة
   منفصلة تماماً: "P0 — Shared Domain Engine Extraction" (استخراج src/domain/{financial-engine,
   ic-readiness, evidence-engine, dd-engine, planning-engine}.js من core.js لتُستهلَك حرفياً من
   المتصفح وهذه الدالة معاً، فتصبح إعادة الحساب هنا ممكنة بلا تكرار منطق) — رُفض عمداً بناء نسخة
   Node مبسَّطة/موازية الآن لهذه الحسابات (كانت ستصبح "محرك خامس متضارب"، بالضبط النمط الذي أزالته
   مراحل Canonical Metrics Consolidation السابقة). لذلك هذه الدالة تُغلق فقط مسارات الكتابة
   المباشرة على Firestore (opportunity.ic لم يعد قابلاً للكتابة من العميل إطلاقاً — انظر
   firestore.rules)، وتُبقي basicReadinessOk() كحارس شكلي مؤقت حتى إنجاز مرحلة استخراج المحرك. */
exports.approveOpportunity = onCall(async (request) => {
  const email = requireEmail(request);
  await requireRole(email, 'senior_ic');
  const { oppId, decision, readiness, reasons, conditions, override } = request.data || {};
  if (!oppId || !decision || !decision.decision) throw new HttpsError('invalid-argument', 'oppId and decision are required.');
  if (APPROVAL_DECISIONS.has(decision.decision) && !basicReadinessOk(readiness)) {
    const hasJustifiedOverride = override === true && Array.isArray(reasons) && reasons.length > 0;
    if (!hasJustifiedOverride) throw new HttpsError('failed-precondition', 'Approval requires passing IC readiness or a justified override.');
  }

  const oppRef = db.collection('opportunities').doc(oppId);
  const icRef = db.collection('icDecisions').doc();
  await db.runTransaction(async (tx) => {
    const oppSnap = await tx.get(oppRef);
    if (!oppSnap.exists) throw new HttpsError('not-found', 'Opportunity not found.');
    const opp = oppSnap.data() || {};
    const icDecision = Object.assign({}, decision, {
      reasons: Array.isArray(reasons) ? reasons : [],
      conditions: Array.isArray(conditions) ? conditions : [],
      decidedBy: email,
      decidedAt: new Date().toISOString(),
      readiness: readiness || null,
      overridden: override === true,
    });
    const ic = opp.ic || {};
    const decisions = Array.isArray(ic.decisions) ? ic.decisions.slice() : [];
    decisions.push(icDecision);
    tx.update(oppRef, {
      ic: Object.assign({}, ic, { decisions }),
      'meta.updatedBy': email,
      'meta.updatedAt': new Date().toISOString().slice(0, 10),
    });
    tx.set(icRef, {
      oppId,
      decision: icDecision,
      readiness: readiness || null,
      recordedBy: email,
      recordedAt: FieldValue.serverTimestamp(),
      source: 'approveOpportunity',
      version: 1,
    });
  });
  return { ok: true, decisionId: icRef.id };
});

/* P0 — Trusted Transaction Layer: يُبقي ميزة "تبديل حالة شرط اعتماد" (ic-toggle-condition في
   ic-workflow.js) تعمل بعد إغلاق ثغرة icOnlyChange في firestore.rules تماماً (لم يعد opportunity.ic
   قابلاً للكتابة من أي عميل مباشرة، لا بمسار icOnlyChange القديم ولا حتى بمسار "المالك العادي"
   ownsOpp — انظر التعليق الجديد في firestore.rules). تُطابق هذه الدالة *حرفياً* نفس صلاحية
   core.canEditOpp(rec) من جانب العميل (المالك أو الأدمن)، منقولة للخادم: لا نرفع صلاحية التبديل
   لتصبح دور "عضو لجنة" كما في approveOpportunity — التبديل هنا مجرد تتبّع تنفيذي لشرط سبق واعتمدته
   اللجنة فعلاً في قرار موجود، وهذا بالضبط ما كان core.canEditOpp يحرسه من قبل، فلا داعي لتضييق
   الصلاحية أو توسيعها هنا. */
exports.updateIcConditionStatus = onCall(async (request) => {
  const email = requireEmail(request);
  await requireAuthorized(email);
  const { oppId, decisionIdx, conditionIdx } = request.data || {};
  if (!oppId || decisionIdx == null || conditionIdx == null) {
    throw new HttpsError('invalid-argument', 'oppId, decisionIdx and conditionIdx are required.');
  }
  const oppRef = db.collection('opportunities').doc(oppId);
  await db.runTransaction(async (tx) => {
    const oppSnap = await tx.get(oppRef);
    if (!oppSnap.exists) throw new HttpsError('not-found', 'Opportunity not found.');
    const opp = oppSnap.data() || {};
    const owner = (opp.meta || {}).createdBy;
    const isOwner = !owner || String(owner).toLowerCase() === email;
    if (!isAdminEmail(email) && !isOwner) {
      throw new HttpsError('permission-denied', 'Only the opportunity owner or an admin can toggle IC conditions.');
    }
    const ic = opp.ic || {};
    const decisions = Array.isArray(ic.decisions) ? ic.decisions.slice() : [];
    const decision = decisions[decisionIdx];
    if (!decision || !Array.isArray(decision.conditions) || !decision.conditions[conditionIdx]) {
      throw new HttpsError('not-found', 'Condition not found.');
    }
    const conditions = decision.conditions.slice();
    const cond = Object.assign({}, conditions[conditionIdx]);
    cond.status = cond.status === 'met' ? 'pending' : 'met';
    conditions[conditionIdx] = cond;
    decisions[decisionIdx] = Object.assign({}, decision, { conditions });
    tx.update(oppRef, {
      ic: Object.assign({}, ic, { decisions }),
      'meta.updatedBy': email,
      'meta.updatedAt': new Date().toISOString().slice(0, 10),
    });
  });
  return { ok: true };
});

exports.linkAssetToFund = onCall(async (request) => {
  const email = requireEmail(request);
  await requireRole(email, 'fund_manager');
  const { fundId, oppId, unlink } = request.data || {};
  if (!fundId || !oppId) throw new HttpsError('invalid-argument', 'fundId and oppId are required.');
  const fundRef = db.collection('funds').doc(fundId);
  const oppRef = db.collection('opportunities').doc(oppId);
  await db.runTransaction(async (tx) => {
    const [fundSnap, oppSnap] = await Promise.all([tx.get(fundRef), tx.get(oppRef)]);
    if (!fundSnap.exists || !oppSnap.exists) throw new HttpsError('not-found', 'Fund or opportunity not found.');
    const fund = fundSnap.data() || {};
    const opp = oppSnap.data() || {};
    const assetIds = Array.isArray(fund.assetIds) ? fund.assetIds.slice() : [];
    const existing = assetIds.includes(oppId);
    if (unlink) {
      tx.update(fundRef, { assetIds: assetIds.filter((id) => id !== oppId), updatedAt: new Date().toISOString().slice(0, 10) });
      return;
    }
    if (existing) return;
    const decisions = (((opp.ic || {}).decisions) || []);
    const latest = decisions.length ? decisions[decisions.length - 1] : null;
    if (!latest || !APPROVAL_DECISIONS.has(latest.decision) || !decisionConditionsMet(latest)) {
      throw new HttpsError('failed-precondition', 'Asset linking requires approved IC decision with conditions met.');
    }
    const allocation = opp.capitalAllocation || {};
    const targetEquity = n(allocation.targetEquity);
    const maxAllocation = n(allocation.maxAllocation);
    if (!(targetEquity > 0)) throw new HttpsError('failed-precondition', 'Target equity allocation is required.');
    if (maxAllocation > 0 && targetEquity > maxAllocation) throw new HttpsError('failed-precondition', 'Target allocation exceeds maxAllocation.');
    const paidSnap = await tx.get(db.collection('capitalCalls').where('fundId', '==', fundId).where('status', '==', 'paid'));
    const distSnap = await tx.get(db.collection('distributions').where('fundId', '==', fundId).where('status', '==', 'paid'));
    let paidIn = 0; let distPaid = 0;
    paidSnap.forEach((doc) => { paidIn += n((doc.data() || {}).amount); });
    distSnap.forEach((doc) => { distPaid += n((doc.data() || {}).amount); });
    const allocated = await allocatedElsewhereTx(tx, fund, oppId);
    const deployable = Math.max(0, paidIn - distPaid - allocated);
    if (targetEquity > deployable) throw new HttpsError('failed-precondition', 'Insufficient deployable fund cash.');
    assetIds.push(oppId);
    tx.update(fundRef, { assetIds, updatedAt: new Date().toISOString().slice(0, 10) });
    tx.set(db.collection('transactions').doc(), { type: 'assetLink', action: 'create', relatedId: oppId, fundId, amount: targetEquity, by: email, at: FieldValue.serverTimestamp(), version: 1 });
  });
  return { ok: true };
});

exports.postCapitalCall = onCall(async (request) => {
  const email = requireEmail(request);
  await requireRole(email, 'fund_manager');
  const data = request.data || {};
  // P0 — Trusted Transaction Layer: قيود عكسية (reversalOfId) لم تعد تُنشأ عبر هذه الدالة إطلاقاً —
  // كانت (قبل هذه المرحلة) تتجاوز فحص السقف بالكامل (الشرط أدناه في المعاملة يستثنيها عمداً) بلا أي
  // تحقق بديل (لا فحص "السجل الأصل موجود؟"، ولا "لم يُعكَس من قبل؟"، ولا أن المبلغ هو فعلاً معكوس
  // الأصل بالضبط) — ثغرة حقيقية أُغلقت الآن بتحويل كل إنشاء قيد عكسي حصرياً لدالة reverseTransaction
  // المخصَّصة أدناه، التي تشتق كل الحقول من السجل الأصل نفسه بدل قبولها من العميل.
  if (data.reversalOfId) {
    throw new HttpsError('invalid-argument', 'Reversal entries must be created via reverseTransaction, not postCapitalCall.');
  }
  assertLedgerAmount(data, 'amount');
  if (!data.fundId || !data.investorId || !data.callDate) throw new HttpsError('invalid-argument', 'fundId, investorId and callDate are required.');
  // معرّف الوثيقة يُولَّد هنا مسبقاً (خارج المعاملة — doc() لا يحتاج معاملة) ليُعاد للعميل، الذي
  // يحتاجه لربط سجل التدقيق المحلي (transactions، منفصل تماماً عن oppAuditLog المُقفَل) بنفس معرّف
  // نداء رأس المال الذي أنشأه الخادم فعلياً — دون هذا، يفقد العميل القدرة على تسجيل تلك الحركة
  // بمعرّف صحيح في دفتر يومية المعاملات الخاص به.
  const ref = db.collection('capitalCalls').doc();
  await db.runTransaction(async (tx) => {
    if (data.status === 'paid') {
      const committed = await committedForInvestorTx(tx, data.fundId, data.investorId);
      const paid = await paidCallsForInvestorTx(tx, data.fundId, data.investorId);
      if (paid + n(data.amount) > committed) {
        throw new HttpsError('failed-precondition', 'Capital call exceeds investor commitment.');
      }
    }
    tx.set(ref, Object.assign({}, data, {
      status: data.status || 'pending',
      approvedBy: data.approvedBy || email,
      approvedAt: data.approvedAt || new Date().toISOString(),
      createdBy: email,
      createdAt: FieldValue.serverTimestamp(),
    }));
  });
  return { ok: true, id: ref.id };
});

/* =========================================================================
   P0 — Trusted Transaction Layer: دورة حياة نداء رأس المال/التوزيعة (pending/declared →
   approved → paid/waived) بالكامل من جانب الخادم الآن. قبل هذه المرحلة، كانت الانتقالات الثلاثة
   (if-approve/if-mark-paid/if-waive في core.js) كتابة عميل مباشرة (persistIfRecord) بلا أي
   إعادة تحقق خادمية عند لحظة الانتقال نفسها — تحديداً انتقال "الترحيل النهائي" (paid)، الذي هو
   بالضبط اللحظة التي يُفترض أن يُقفَل فيها السقف (المدفوع + هذا النداء ≤ الملتزَم به) بلا أي مجال
   للتلاعب؛ postCapitalCall كانت تتحقق من هذا السقف فقط عند *الإنشاء الأولي* (status: 'pending')،
   لا عند لحظة السداد الفعلية لاحقاً — وبين اللحظتين قد يتغيّر الملتزَم به (قيد عكسي على التزام
   المستثمر نفسه، مثلاً)، فيصبح نداء كان صحيحاً وقت إنشائه غير صحيح وقت سداده، بلا أي حارس خادمي
   يمنعه. firestore.rules الآن تمنع أي `update` مباشر من العميل على capitalCalls/distributions
   بالكامل (`allow update: if false`) — المسار الوحيد المتبقي لأي انتقال حالة هو هذه الدالة. */
const LEDGER_COLLECTIONS = { capitalCall: 'capitalCalls', distribution: 'distributions' };
const LEDGER_INITIAL_STATUS = { capitalCall: 'pending', distribution: 'declared' };

// تُطابق ledgerStatusTransitionOk() في firestore.rules بالضبط (قبل إزالتها من القاعدة نفسها الآن
// أنها لم تعد ضرورية هناك بعد قفل allow update بالكامل — المنطق نفسه ضروري هنا، مصدر الحقيقة
// الوحيد الآن). waived قاصرة على capitalCall فقط (لا مقابل لها في DISTRIBUTION_STATUS).
function ledgerTransitionAllowed(kind, before, to) {
  const initial = LEDGER_INITIAL_STATUS[kind];
  if (before === initial && to === 'approved') return true;
  if (before === 'approved' && to === 'paid') return true;
  if (before === 'approved' && to === 'waived' && kind === 'capitalCall') return true;
  return false;
}

exports.transitionLedgerRecord = onCall(async (request) => {
  const email = requireEmail(request);
  await requireRole(email, 'fund_manager');
  const { kind, id, toStatus } = request.data || {};
  const coll = LEDGER_COLLECTIONS[kind];
  if (!coll || !id || !toStatus) throw new HttpsError('invalid-argument', 'kind, id and toStatus are required.');
  if (!['approved', 'paid', 'waived'].includes(toStatus)) throw new HttpsError('invalid-argument', 'Invalid target status.');

  const ref = db.collection(coll).doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Record not found.');
    const data = snap.data() || {};
    if (!ledgerTransitionAllowed(kind, data.status, toStatus)) {
      throw new HttpsError('failed-precondition', `Cannot transition ${kind} from "${data.status}" to "${toStatus}".`);
    }
    // إعادة التحقق اللحظية من سقف الالتزام — بالضبط اللحظة التي وصفها المستخدم: "يعيد التحقق من
    // المدفوع التراكمي مقابل الالتزام (الذي ربما عُدِّل) في تلك اللحظة بالذات". نداء تلقائي مرتبط
    // بمساهمة عينية (linkedCommitmentId) لا يمر بهذه الدالة أصلاً (يُنشأ 'paid' مباشرة من if-save)
    // فلا حاجة لاستثنائه هنا.
    if (toStatus === 'paid' && kind === 'capitalCall') {
      const committed = await committedForInvestorTx(tx, data.fundId, data.investorId);
      const paid = await paidCallsForInvestorTx(tx, data.fundId, data.investorId);
      if (paid + n(data.amount) > committed) {
        throw new HttpsError('failed-precondition', 'Capital call exceeds investor commitment at payment time.');
      }
    }
    const update = { status: toStatus };
    if (toStatus === 'approved') {
      update.approvedBy = email;
      update.approvedAt = new Date().toISOString();
    }
    tx.update(ref, update);
    tx.set(db.collection('transactions').doc(), {
      type: kind,
      action: toStatus === 'approved' ? 'approve' : (toStatus === 'waived' ? 'waive' : 'post'),
      relatedId: id,
      fundId: data.fundId,
      investorId: data.investorId,
      amount: toStatus === 'waived' ? 0 : n(data.amount),
      by: email,
      at: FieldValue.serverTimestamp(),
      version: 1,
    });
  });
  return { ok: true };
});

/* =========================================================================
   P0 — Trusted Transaction Layer: reverseTransaction() — القيد العكسي الوحيد الموثوق. قبل هذه
   المرحلة كان يمكن إنشاء سجل بحقل reversalOfId مباشرة من العميل (firestore.rules كانت تتحقق فقط
   من إشارة المبلغ) بلا أي تحقق فعلي أن: السجل الأصل موجود، لم يُعكَس من قبل (لا عكس مزدوج)، نفس
   المستثمر/الصندوق/نوع السجل، والمبلغ هو فعلاً المعكوس الدقيق للأصل. الإصلاح هنا أقوى من "التحقق"
   فقط: العميل لا يرسل شيئاً سوى (النوع، معرّف السجل الأصل، سبب العكس) — كل حقل آخر (المبلغ العكسي،
   المستثمر، الصندوق) يُشتَق من السجل الأصل نفسه داخل الخادم، فلا مجال أصلاً لإرسال قيمة مزيَّفة
   لأي منها. */
const REVERSAL_COLLECTIONS = { commitment: 'commitments', capitalCall: 'capitalCalls', distribution: 'distributions' };
const REVERSAL_AMOUNT_FIELD = { commitment: 'commitmentAmount', capitalCall: 'amount', distribution: 'amount' };

// تُطابق isPostedIfRecord(kind, rec) في core.js بالضبط: لا يجوز عكس سجل لم يُرحَّل بعد (له مسار
// حذف مباشر أبسط لذلك، انظر if-delete) — commitments مُرحَّلة من الإنشاء دوماً؛ capitalCalls
// مُرحَّلة عند paid/waived أو أي نداء تلقائي مرتبط بمساهمة عينية (linkedCommitmentId)؛
// distributions فقط عند paid.
function isPostedForReversal(kind, data) {
  if (kind === 'commitment') return true;
  if (kind === 'capitalCall') return data.status === 'paid' || data.status === 'waived' || !!data.linkedCommitmentId;
  if (kind === 'distribution') return data.status === 'paid';
  return false;
}

exports.reverseTransaction = onCall(async (request) => {
  const email = requireEmail(request);
  await requireRole(email, 'fund_manager');
  const { kind, id, notes } = request.data || {};
  const coll = REVERSAL_COLLECTIONS[kind];
  const amtField = REVERSAL_AMOUNT_FIELD[kind];
  if (!coll || !id) throw new HttpsError('invalid-argument', 'kind and id are required.');

  const originalRef = db.collection(coll).doc(id);
  const newRef = db.collection(coll).doc();
  await db.runTransaction(async (tx) => {
    const origSnap = await tx.get(originalRef);
    if (!origSnap.exists) throw new HttpsError('not-found', 'Original record not found.');
    const orig = origSnap.data() || {};
    if (orig.reversalOfId) {
      throw new HttpsError('failed-precondition', 'Cannot reverse a record that is itself a reversal entry.');
    }
    if (!isPostedForReversal(kind, orig)) {
      throw new HttpsError('failed-precondition', 'Only a posted record can be reversed.');
    }
    // لا عكس مزدوج: لا سجل آخر في نفس المجموعة يشير reversalOfId إليه بالفعل.
    const existingReversal = await tx.get(db.collection(coll).where('reversalOfId', '==', id).limit(1));
    if (!existingReversal.empty) {
      throw new HttpsError('failed-precondition', 'This record has already been reversed.');
    }
    const origAmount = n(orig[amtField]);
    const reversal = Object.assign({}, orig, {
      reversalOfId: id,
      notes: (notes || '').toString(),
      [amtField]: -origAmount,
      createdBy: email,
      createdAt: FieldValue.serverTimestamp(),
    });
    delete reversal.id;
    if (kind !== 'commitment') {
      // القيد العكسي لدفعة نداء/توزيعة تلقائية يبقى قائماً بذاته — لا يُعاد ربطه بذات الالتزام
      // العيني تلقائياً (يطابق تماماً سلوك if-reverse من جانب العميل قبل هذه المرحلة).
      reversal.linkedCommitmentId = null;
      // القيد العكسي نفسه سجل مُرحَّل فوراً — نفس حالة الأصل (paid يبقى paid، waived يبقى waived).
      reversal.status = orig.status;
      reversal.approvedBy = orig.approvedBy || email;
      reversal.approvedAt = orig.approvedAt || new Date().toISOString();
    }
    tx.set(newRef, reversal);
    tx.set(db.collection('transactions').doc(), {
      type: kind,
      action: 'reverse',
      relatedId: newRef.id,
      reversalOfId: id,
      fundId: orig.fundId,
      investorId: orig.investorId,
      amount: -origAmount,
      by: email,
      at: FieldValue.serverTimestamp(),
      version: 1,
    });
  });
  return { ok: true, id: newRef.id };
});

// ⚠️ ملاحظة توافق (لا علاقة لها بمرحلة P0 هذه): هذا الـtrigger مكتوب بصيغة firebase-functions/v1
// (لا v2/onDocumentWritten كباقي هذا الملف) — تعديل محلي سابق على هذا الجهاز لأغراض توافق النشر،
// أبقيته كما هو دون لمسه فلا علاقة له بطبقة المعاملات الموثوقة نفسها.
exports.mirrorOpportunityAuditLog = require('firebase-functions/v1').firestore.document('opportunities/{oppId}').onWrite(async (change, context) => {
  const oppId = context.params.oppId;
  const beforeSnap = change.before; const afterSnap = change.after; 

  const afterExists = !!(afterSnap && afterSnap.exists);
  const beforeExists = !!(beforeSnap && beforeSnap.exists);

  if (!afterExists) {
    // حذف فرصة بالكامل — لا نُسجِّل "فرق حقول" له معنى؛ نسجّل حدث حذف مبسَّط
    // (وثيقة الفرصة نفسها اختفت، فسجل تدقيقها هنا هو الأثر الوحيد المتبقي).
    if (beforeExists) {
      await db.collection(AUDIT_COLLECTION).add({
        oppId, action: 'deleted', changes: [], reason: '',
        changedBy: actorFromData(beforeSnap.data(), false),
        changedAt: FieldValue.serverTimestamp(),
      });
    }
    return;
  }

  const newData = afterSnap.data();
  const oldData = beforeExists ? beforeSnap.data() : null;
  const reason = (newData.audit && newData.audit.changeReason) ? String(newData.audit.changeReason).trim() : '';

  if (!oldData) {
    await db.collection(AUDIT_COLLECTION).add({
      oppId, action: 'created', changes: [], reason,
      changedBy: actorFromData(newData, true),
      changedAt: FieldValue.serverTimestamp(),
    });
    return;
  }

  let diffs;
  try {
    diffs = deepDiff(oldData, newData, '', []);
  } catch (e) {
    console.error('audit diff error for', oppId, e);
    diffs = [];
  }
  if (diffs.length === 0) return; // لا تغييرات حقيقية (مثلاً كتابة متطابقة) — لا داعي لتسجيل شيء

  await db.collection(AUDIT_COLLECTION).add({
    oppId, action: 'updated', reason,
    changedBy: actorFromData(newData, false),
    changedAt: FieldValue.serverTimestamp(),
    changes: diffs.map(d => ({ field: d.path, label: fieldLabel(d.path), before: d.before, after: d.after })),
  });
});

// مُصدَّرة للاختبار البنيوي المباشر (test_functions.mjs) بلا الحاجة لمحاكي Functions كامل.
exports._internal = { deepDiff, fieldLabel, FIELD_LABELS, IGNORE_PATHS, actorFromData, basicReadinessOk, decisionConditionsMet, assertLedgerAmount, roleRank, isAdminEmail, ledgerTransitionAllowed, isPostedForReversal };

// تكامل Monday.com الخلفي الآمن: يعالج mondayTaskQueue من الخادم فقط، بعد ضبط
// MONDAY_API_TOKEN في Secret Manager. لا يوجد أي رمز API في واجهة العميل.
Object.assign(exports, require('./monday-sync'));
  
Object.assign(exports, require('./monday-webhook'));  
