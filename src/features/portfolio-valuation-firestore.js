/* =========================================================================
   موصّل Firestore لمصدر تقييمات المحفظة (R1-C3) — اشتراك قراءة فقط، بعقد العلامات الصريح
   ---------------------------------------------------------------------------
   كل لقطة تُسلَّم للمصدر بالشكل { docs:[{id,data}], fromCache, hasPendingWrites } حيث العلامتان تُنقلان **كما هما** من snap.metadata
   (بلا تحويل بـ!! أو قيمة افتراضية): علامة غائبة تبقى undefined فيراها المصدر انتهاك عقد ويحجب. includeMetadataChanges:true ضروري ليصل
   تغيّر العلامات (cache -> server، أو انتهاء كتابة معلّقة) ولو لم تتغيّر الوثائق.
   لا كتابة ولا callables. الفلتر where('fundId','==',fundId) كما في اشتراك لوحة التقييمات.
   ========================================================================= */
export const PORTFOLIO_COLLECTION = Object.freeze({ heads: 'fundValuationHeads', valuations: 'fundValuations' });

export function snapshotForSource(snap) {
  const md = snap && snap.metadata;
  return {
    docs: snap && Array.isArray(snap.docs) ? snap.docs.map((d) => ({ id: d.id, data: d.data() })) : undefined,
    fromCache: md ? md.fromCache : undefined,
    hasPendingWrites: md ? md.hasPendingWrites : undefined,
  };
}

/** @param {{DB:{collection:Function}}} core  (أو أي كائن بـ DB متوافق مع واجهة compat) */
export function makePortfolioSubscribe(core) {
  return (source, fundId, onNext, onError) => {
    const coll = PORTFOLIO_COLLECTION[source];
    if (!coll) throw new Error(`portfolio subscribe: unknown source ${source}`);
    return core.DB.collection(coll).where('fundId', '==', fundId)
      .onSnapshot({ includeMetadataChanges: true }, (snap) => onNext(snapshotForSource(snap)), onError);
  };
}
