/* Firestore Admin SDK مُزيَّفة — للاختبار البنيوي فقط، بلا شبكة أو مشروع Firebase حقيقي.
   تدعم فقط ما يستخدمه functions/index.js فعلياً: collection().doc()/doc(id).get()/.add(),
   where(field,'==',v) متسلسلة + limit(n)، ومعاملة (transaction) بسيطة (tx.get/set/update) بلا
   عزل حقيقي بين معاملات متزامنة — كافٍ لاختبار المنطق البنيوي أحادي الخيط هنا؛ ليست بديلاً لاختبار
   تزامن حقيقي (ذلك يبقى دور tests/rules، الذي يشغّل Firestore Emulator الحقيقي).
   لا تُستخدم إلا عبر functions/test/p0-trusted-transaction-layer.test.js (وأي اختبار مستقبلي
   مشابه) الذي يعترض require('firebase-admin/firestore') بـModule._resolveFilename قبل تحميل
   functions/index.js — لا علاقة لهذا الملف بالنشر الفعلي إطلاقاً. */
let AUTO_ID = 1;
function nextId(prefix) { return `${prefix || 'AUTO'}${AUTO_ID++}`; }

function applyDotted(target, patch) {
  for (const key of Object.keys(patch)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let obj = target;
      for (let i = 0; i < parts.length - 1; i++) {
        if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] == null) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = patch[key];
    } else {
      target[key] = patch[key];
    }
  }
  return target;
}

class FakeSnap {
  constructor(id, data) {
    this.id = id;
    this._data = data;
    this.exists = data != null;
  }
  // لا JSON round-trip هنا عمداً: يُفقد أي دالة على القيمة (مثل Timestamp.toMillis() الحقيقية)،
  // وهذا بالضبط ما يحتاجه اختبار انتهاء صلاحية العضوية (expiresAt.toMillis()). نُعيد المرجع
  // مباشرة؛ كافٍ هنا لأن functions/index.js لا يُعدِّل نتيجة data() في مكانها أبداً — يبني كائنات
  // جديدة دوماً عبر slice()/Object.assign قبل أي تعديل.
  data() { return this._data; }
}

class FakeQuerySnap {
  constructor(docs) { this.docs = docs; this.empty = docs.length === 0; this.size = docs.length; }
  forEach(fn) { this.docs.forEach(fn); }
}

class FakeDocRef {
  constructor(store, coll, id) { this.store = store; this.coll = coll; this.id = id; }
  async get() {
    const data = (this.store[this.coll] || {})[this.id];
    return new FakeSnap(this.id, data);
  }
}

class FakeQuery {
  constructor(store, coll, filters) { this.store = store; this.coll = coll; this.filters = filters || []; this._limit = null; }
  where(field, op, value) {
    if (op !== '==') throw new Error('fake firestore only supports == in tests');
    return new FakeQuery(this.store, this.coll, this.filters.concat([{ field, value }]));
  }
  limit(n) { const q = new FakeQuery(this.store, this.coll, this.filters); q._limit = n; return q; }
  async get() {
    const collData = this.store[this.coll] || {};
    let entries = Object.keys(collData).map((id) => ({ id, data: collData[id] }));
    entries = entries.filter((e) => this.filters.every((f) => e.data && e.data[f.field] === f.value));
    if (this._limit != null) entries = entries.slice(0, this._limit);
    return new FakeQuerySnap(entries.map((e) => new FakeSnap(e.id, e.data)));
  }
}

class FakeCollectionRef {
  constructor(store, name) { this.store = store; this.name = name; if (!store[name]) store[name] = {}; }
  doc(id) { return new FakeDocRef(this.store, this.name, id || nextId(this.name.toUpperCase())); }
  async add(data) {
    const ref = this.doc();
    if (!this.store[this.name]) this.store[this.name] = {};
    this.store[this.name][ref.id] = JSON.parse(JSON.stringify(data));
    return ref;
  }
  where(field, op, value) { return new FakeQuery(this.store, this.name, []).where(field, op, value); }
}

class FakeTransaction {
  constructor(store) { this.store = store; }
  async get(refOrQuery) {
    if (refOrQuery instanceof FakeQuery) return refOrQuery.get();
    return refOrQuery.get();
  }
  set(ref, data) {
    if (!this.store[ref.coll]) this.store[ref.coll] = {};
    this.store[ref.coll][ref.id] = JSON.parse(JSON.stringify(data));
  }
  update(ref, patch) {
    if (!this.store[ref.coll] || !this.store[ref.coll][ref.id]) throw new Error('update on missing doc: ' + ref.coll + '/' + ref.id);
    applyDotted(this.store[ref.coll][ref.id], JSON.parse(JSON.stringify(patch)));
  }
}

class FakeFirestore {
  constructor() { this.store = {}; }
  collection(name) { return new FakeCollectionRef(this.store, name); }
  async runTransaction(fn) {
    const tx = new FakeTransaction(this.store);
    return fn(tx);
  }
  // أدوات اختبار فقط — ليست جزءاً من Firestore الحقيقية.
  __seed(coll, id, data) { if (!this.store[coll]) this.store[coll] = {}; this.store[coll][id] = data; }
  __get(coll, id) { return (this.store[coll] || {})[id]; }
  __all(coll) { return this.store[coll] || {}; }
  __reset() { this.store = {}; }
}

const singleton = new FakeFirestore();
function getFirestore() { return singleton; }
const FieldValue = { serverTimestamp: () => '__SERVER_TIMESTAMP__' };

module.exports = { getFirestore, FieldValue, __singleton: singleton };
