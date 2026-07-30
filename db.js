// db.js — 本地資料層（IndexedDB）
// ---------------------------------------------------------------------------
// 對應 PRD 的資料主幹：Trip → Place → Moment。
//
// 設計原則（呼應 PRD 3.2）：這一層刻意獨立、不與畫面（app.js）混在一起。
// 呼叫方永遠呼叫這裡定義的函式（db.createPlace()、db.listPlaces()…），
// 內部現在用瀏覽器本地的 IndexedDB。第二步要接你現成的 Firebase 雲端同步時，
// 只需要在這一層加一層 adapter，畫面程式碼完全不用改。
//
// 「第一步：本地優先」→「第二步：本地 + Firebase 同步」就是靠這層隔離達成的。
// ---------------------------------------------------------------------------

const DB_NAME = 'travel-planner';
const DB_VERSION = 1;

// ---- 分類與狀態常數（對應 PRD 二、資料模型）----------------------------------
export const CATEGORIES = ['景點', '餐廳', '住宿', '交通', '購物', '其他'];

// Place 狀態：候選 / 已排入 / 已造訪 / 已造訪・未規劃
export const STATUSES = ['候選', '已排入', '已造訪', '已造訪・未規劃'];

// 各類別的預設停留分鐘（PRD：estimated_stay 各類別給預設值）
export const DEFAULT_STAY = {
  景點: 90,
  餐廳: 60,
  住宿: 0,
  交通: 30,
  購物: 60,
  其他: 45,
};

// ---- 底層：開啟資料庫、把 request 包成 Promise --------------------------------
let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;

      // Trip：一趟旅程的容器
      if (!idb.objectStoreNames.contains('trips')) {
        idb.createObjectStore('trips', { keyPath: 'id' });
      }

      // Place：地點（候選／已排入／已造訪／已造訪・未規劃）
      if (!idb.objectStoreNames.contains('places')) {
        const s = idb.createObjectStore('places', { keyPath: 'id' });
        s.createIndex('tripId', 'tripId', { unique: false });
      }

      // Moment：掛在 Place 底下的當下捕捉（photo / expense / note）
      // 第一步先建好 store，實際輸入介面在後續步驟做。
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

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function put(store, value) {
  const idb = await openDB();
  const t = idb.transaction(store, 'readwrite');
  await reqToPromise(t.objectStore(store).put(value));
  return value;
}

async function get(store, id) {
  const idb = await openDB();
  const t = idb.transaction(store, 'readonly');
  return reqToPromise(t.objectStore(store).get(id));
}

async function getAll(store) {
  const idb = await openDB();
  const t = idb.transaction(store, 'readonly');
  return reqToPromise(t.objectStore(store).getAll());
}

async function getByIndex(store, indexName, value) {
  const idb = await openDB();
  const t = idb.transaction(store, 'readonly');
  return reqToPromise(t.objectStore(store).index(indexName).getAll(value));
}

async function del(store, id) {
  const idb = await openDB();
  const t = idb.transaction(store, 'readwrite');
  await reqToPromise(t.objectStore(store).delete(id));
}

// 產生唯一 id（crypto.randomUUID 現代瀏覽器都支援；備援用時間戳＋亂數）
function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- Trip ------------------------------------------------------------------
async function createTrip({ name, startDate = '', endDate = '', people = 1 }) {
  const trip = {
    id: newId(),
    name: (name || '未命名旅程').trim(),
    startDate,
    endDate,
    people: Number(people) || 1,
    createdAt: Date.now(),
  };
  return put('trips', trip);
}

async function listTrips() {
  const trips = await getAll('trips');
  return trips.sort((a, b) => b.createdAt - a.createdAt);
}

async function getTrip(id) {
  return get('trips', id);
}

async function updateTrip(id, patch) {
  const trip = await get('trips', id);
  if (!trip) throw new Error('找不到旅程');
  return put('trips', { ...trip, ...patch });
}

// 刪除旅程：連同底下的 Place、Moment 一併刪除（cascade），避免孤兒資料
async function deleteTrip(id) {
  const places = await getByIndex('places', 'tripId', id);
  for (const p of places) await deletePlace(p.id);
  await del('trips', id);
}

// ---- Place -----------------------------------------------------------------
async function createPlace(tripId, data) {
  const category = CATEGORIES.includes(data.category) ? data.category : '景點';
  const place = {
    id: newId(),
    tripId,
    name: (data.name || '').trim(),
    category,
    // 座標（PRD：provider-agnostic，是這筆資料的事實依據）
    lat: data.lat ?? null,
    lng: data.lng ?? null,
    // 建立來源：分享連結／地圖點選／手動輸入
    source: data.source || '手動輸入',
    estimatedStay: data.estimatedStay ?? DEFAULT_STAY[category] ?? 60,
    estimatedCost: data.estimatedCost ?? 0,
    openingHours: data.openingHours || '',
    referenceUrl: data.referenceUrl || '',
    notes: data.notes || '',
    coverImage: data.coverImage || '',
    status: STATUSES.includes(data.status) ? data.status : '候選',
    pinned: !!data.pinned,
    // 排程層（PRD：獨立於 Place 本體，不存實際抵達／離開時間，每次即時重算）
    assignedDay: data.assignedDay ?? null,
    orderIndex: data.orderIndex ?? null,
    // 服務商專屬 ID（Google Place ID 等）視為附加、非主鍵
    providerIds: data.providerIds || {},
    createdAt: Date.now(),
  };
  return put('places', place);
}

async function listPlaces(tripId) {
  const places = await getByIndex('places', 'tripId', tripId);
  return places.sort((a, b) => a.createdAt - b.createdAt);
}

async function getPlace(id) {
  return get('places', id);
}

async function updatePlace(id, patch) {
  const place = await get('places', id);
  if (!place) throw new Error('找不到地點');
  return put('places', { ...place, ...patch });
}

async function deletePlace(id) {
  const moments = await getByIndex('moments', 'placeId', id);
  for (const m of moments) await del('moments', m.id);
  await del('places', id);
}

// ---- 對外 API --------------------------------------------------------------
export const db = {
  createTrip, listTrips, getTrip, updateTrip, deleteTrip,
  createPlace, listPlaces, getPlace, updatePlace, deletePlace,
};
