// db.js — 本地資料層（IndexedDB）
// ---------------------------------------------------------------------------
// 對應 PRD 的資料主幹：Trip → Place → Moment。
//
// 設計原則（呼應 PRD 3.2）：這一層刻意獨立、不與畫面（app.js）混在一起。
// 呼叫方永遠呼叫這裡定義的函式（db.createPlace()、db.listPlaces()…），
// 內部用瀏覽器本地的 IndexedDB。雲端同步（sync.js，接 Supabase）是加在
// 這一層之上的鏡像，畫面程式碼完全不用改。
//
// 同步用欄位：每筆資料都有
//   - updatedAt：最後修改時間（毫秒）。雙向同步以「較新者為準」。
//   - deleted  ：軟刪除標記（tombstone）。刪除不是真的移除，而是標記，
//                這樣「刪除」這件事才能同步到其他裝置。畫面上的列表會濾掉它。
// ---------------------------------------------------------------------------

const DB_NAME = 'travel-planner';
const DB_VERSION = 1;
const STORES = ['trips', 'places', 'moments'];

// ---- 分類與狀態常數（對應 PRD 二、資料模型）----------------------------------
export const CATEGORIES = ['景點', '美食', '住宿', '交通', '購物', '其他'];

// Place 狀態：候選 / 已排入 / 已造訪 / 已造訪・未規劃
export const STATUSES = ['候選', '已排入', '已造訪', '已造訪・未規劃'];

// 各類別的預設停留分鐘（PRD：estimated_stay 各類別給預設值）
export const DEFAULT_STAY = {
  景點: 90, 美食: 60, 住宿: 0, 交通: 30, 購物: 60, 其他: 45,
};

// ---- 底層：開啟資料庫、把 request 包成 Promise --------------------------------
let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains('trips')) idb.createObjectStore('trips', { keyPath: 'id' });
      if (!idb.objectStoreNames.contains('places')) {
        const s = idb.createObjectStore('places', { keyPath: 'id' });
        s.createIndex('tripId', 'tripId', { unique: false });
      }
      if (!idb.objectStoreNames.contains('moments')) {
        const s = idb.createObjectStore('moments', { keyPath: 'id' });
        s.createIndex('placeId', 'placeId', { unique: false });
        s.createIndex('tripId', 'tripId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

const reqToPromise = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

async function put(store, value) {
  const idb = await openDB();
  await reqToPromise(idb.transaction(store, 'readwrite').objectStore(store).put(value));
  return value;
}
async function get(store, id) {
  const idb = await openDB();
  return reqToPromise(idb.transaction(store, 'readonly').objectStore(store).get(id));
}
async function getAll(store) {
  const idb = await openDB();
  return reqToPromise(idb.transaction(store, 'readonly').objectStore(store).getAll());
}
async function getByIndex(store, indexName, value) {
  const idb = await openDB();
  return reqToPromise(idb.transaction(store, 'readonly').objectStore(store).index(indexName).getAll(value));
}

// crypto.randomUUID：全域唯一，本地與雲端共用同一個 id，合併時才對得起來
function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// ---- 變更通知（讓 sync.js 在本地資料變動後觸發推送）--------------------------
let _onChange = null;
export function onDbChange(fn) { _onChange = fn; }
function notify() { try { _onChange && _onChange(); } catch (_) {} }

const active = (rows) => rows.filter((r) => !r.deleted);

// ---- Trip ------------------------------------------------------------------
async function createTrip({ name, startDate = '', endDate = '', people = 1, ownerId = null }) {
  const now = Date.now();
  const trip = {
    id: newId(), name: (name || '未命名旅程').trim(),
    startDate, endDate, people: Number(people) || 1,
    ownerId,                        // 這趟的擁有者(登入者 id);列表依此過濾
    members: [],                    // 協作者的 uid 清單(擁有者不列在內)
    inviteCode: '',                 // 邀請碼(產生邀請連結時才填)
    public: false,                  // 是否開放公開分享(唯讀)
    createdAt: now, updatedAt: now, deleted: false,
  };
  await put('trips', trip); notify(); return trip;
}
// 列出「我擁有」或「我是協作成員」的旅程。未登入回傳空陣列。
async function listTrips(userId) {
  if (!userId) return [];
  return active(await getAll('trips'))
    .filter((t) => t.ownerId === userId || (t.members || []).includes(userId))
    .sort((a, b) => b.createdAt - a.createdAt);
}
async function getTrip(id) {
  const t = await get('trips', id);
  return t && !t.deleted ? t : undefined;
}
async function updateTrip(id, patch) {
  const trip = await get('trips', id);
  if (!trip) throw new Error('找不到旅程');
  const next = { ...trip, ...patch, updatedAt: Date.now() };
  await put('trips', next); notify(); return next;
}
// 刪除旅程：軟刪除，並連同底下 Place、Moment 一併軟刪除（讓刪除能同步）
async function deleteTrip(id) {
  const now = Date.now();
  const places = await getByIndex('places', 'tripId', id);
  for (const p of places) {
    const moments = await getByIndex('moments', 'placeId', p.id);
    for (const m of moments) await put('moments', { ...m, deleted: true, updatedAt: now });
    await put('places', { ...p, deleted: true, updatedAt: now });
  }
  const trip = await get('trips', id);
  if (trip) await put('trips', { ...trip, deleted: true, updatedAt: now });
  notify();
}

// ---- Place -----------------------------------------------------------------
async function createPlace(tripId, data) {
  const now = Date.now();
  const category = CATEGORIES.includes(data.category) ? data.category : '景點';
  const place = {
    id: newId(), tripId,
    name: (data.name || '').trim(), category,
    lat: data.lat ?? null, lng: data.lng ?? null,
    source: data.source || '手動輸入',
    estimatedStay: data.estimatedStay ?? DEFAULT_STAY[category] ?? 60,
    estimatedCost: data.estimatedCost ?? 0,
    openingHours: data.openingHours || '',
    referenceUrl: data.referenceUrl || '',
    notes: data.notes || '', coverImage: data.coverImage || '',
    status: STATUSES.includes(data.status) ? data.status : '候選',
    pinned: !!data.pinned,
    assignedDay: data.assignedDay ?? null, orderIndex: data.orderIndex ?? null,
    providerIds: data.providerIds || {},
    createdAt: now, updatedAt: now, deleted: false,
  };
  // 若這趟已開放公開分享,新地點也沿用公開狀態(才會出現在分享頁)
  const parent = await get('trips', tripId);
  place.public = !!parent?.public;
  await put('places', place); notify(); return place;
}

// 設定/取消整趟公開分享:連同底下地點、Moment 一起標記(供權限判斷)
async function setTripPublic(tripId, isPublic) {
  const now = Date.now();
  const flag = !!isPublic;
  const trip = await get('trips', tripId);
  if (!trip) return;
  await put('trips', { ...trip, public: flag, updatedAt: now });
  const places = await getByIndex('places', 'tripId', tripId);
  for (const p of places) {
    await put('places', { ...p, public: flag, updatedAt: now });
    const moments = await getByIndex('moments', 'placeId', p.id);
    for (const m of moments) await put('moments', { ...m, public: flag, updatedAt: now });
  }
  notify();
}
async function listPlaces(tripId) {
  return active(await getByIndex('places', 'tripId', tripId)).sort((a, b) => a.createdAt - b.createdAt);
}
async function getPlace(id) {
  const p = await get('places', id);
  return p && !p.deleted ? p : undefined;
}
async function updatePlace(id, patch) {
  const place = await get('places', id);
  if (!place) throw new Error('找不到地點');
  const next = { ...place, ...patch, updatedAt: Date.now() };
  await put('places', next); notify(); return next;
}
async function deletePlace(id) {
  const now = Date.now();
  const moments = await getByIndex('moments', 'placeId', id);
  for (const m of moments) await put('moments', { ...m, deleted: true, updatedAt: now });
  const place = await get('places', id);
  if (place) await put('places', { ...place, deleted: true, updatedAt: now });
  notify();
}

// ---- 一次性資料轉換 --------------------------------------------------------
// 舊資料把分類「餐廳」改名為「美食」。可重複執行(改完就沒有符合的,等於空跑)。
async function migrateCategories() {
  const places = await getAll('places');
  let changed = 0;
  for (const p of places) {
    if (p.category === '餐廳') {
      await put('places', { ...p, category: '美食', updatedAt: Date.now() });
      changed++;
    }
  }
  if (changed) notify();
  return changed;
}

// 一次性修復:把「沒有擁有者」的本地行程認領為目前使用者(不動 updatedAt,
// 避免誤推翻雲端)。用於修復「登入把關」更新後,舊行程因缺 ownerId 而被過濾消失。
async function claimOwnerlessTrips(userId) {
  if (!userId) return 0;
  const trips = await getAll('trips');
  let n = 0;
  for (const t of trips) {
    if (!t.ownerId && !t.deleted) { await put('trips', { ...t, ownerId: userId }); n++; }
  }
  if (n) notify();
  return n;
}

// ---- 給 sync.js 用的原始存取（含 tombstone，不改動 updatedAt）----------------
const sync = {
  stores: STORES,
  async allRaw(store) { return getAll(store); },        // 全部，包含已刪除
  async putRaw(store, rec) { return put(store, rec); }, // 原樣寫入（雲端→本地）
};

// ---- 對外 API --------------------------------------------------------------
export const db = {
  createTrip, listTrips, getTrip, updateTrip, deleteTrip, setTripPublic,
  createPlace, listPlaces, getPlace, updatePlace, deletePlace,
  migrateCategories, claimOwnerlessTrips,
  _sync: sync,
};
