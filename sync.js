// sync.js — 雲端同步（Supabase）
// ---------------------------------------------------------------------------
// 本地優先 + 雲端鏡像:App 照樣讀寫本地 IndexedDB(db.js),登入後這裡在背景
// 跟 Supabase 雙向同步。合併規則:同一筆資料以 updatedAt 較新者為準(單人用
// 衝突極少)。刪除是 tombstone(deleted=true),所以也會正確同步到別的裝置。
//
// 這個檔案是「動態載入」的(見 app.js):萬一 CDN 連不到或離線,載入失敗也
// 只是沒有雲端,App 仍能純本地運作。
// ---------------------------------------------------------------------------

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';
import { db, onDbChange } from './db.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

// ---- 狀態回報(讓畫面顯示「同步中/已同步/錯誤」)-----------------------------
let statusCb = null;
export function onStatus(fn) { statusCb = fn; }
function setStatus(s) { try { statusCb && statusCb(s); } catch (_) {} }

// ---- 帳號 ------------------------------------------------------------------
export async function currentUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user || null;
}
// ---- 公開分享:不需登入,靠 RLS 的「公開可讀」規則取得唯讀資料 ----------------
export async function fetchPublicTrip(id) {
  const { data, error } = await supabase.from('trips').select('id,data').eq('id', id).maybeSingle();
  if (error || !data) return null;
  return { ...(data.data || {}), id: data.id };
}
export async function fetchPublicPlaces(tripId) {
  const { data, error } = await supabase.from('places').select('id,data').filter('data->>tripId', 'eq', tripId);
  if (error || !data) return [];
  return data.map((r) => ({ ...(r.data || {}), id: r.id })).filter((p) => !p.deleted);
}

export const signUp = (email, password) => supabase.auth.signUp({ email, password });
export const signIn = (email, password) => supabase.auth.signInWithPassword({ email, password });
export const signOut = () => supabase.auth.signOut();

// ---- 雲端 <-> 本地 資料形狀轉換 ----------------------------------------------
// 雲端每張表欄位:id(uuid) / user_id / data(jsonb=整筆本地物件) / updated_at / deleted
// 拉回時用雲端權威的 user_id 蓋上 ownerId,確保資料正確歸屬到擁有者
const fromCloud = (c) => ({ ...(c.data || {}), id: c.id, updatedAt: Number(c.updated_at) || 0, deleted: !!c.deleted, ownerId: c.user_id });
const toCloud = (l) => ({ id: l.id, data: l, updated_at: l.updatedAt || 0, deleted: !!l.deleted });
// 註:upsert 時不帶 user_id,交給資料表預設值 auth.uid() 自動填入(RLS 保護)。

async function syncTable(table) {
  const { data: cloudRows, error } = await supabase.from(table).select('id,data,updated_at,deleted,user_id');
  if (error) throw error;

  const localRows = await db._sync.allRaw(table);
  const cloudMap = new Map(cloudRows.map((r) => [r.id, r]));
  const localMap = new Map(localRows.map((r) => [r.id, r]));
  const ids = new Set([...cloudMap.keys(), ...localMap.keys()]);

  const toPush = [];
  for (const id of ids) {
    const c = cloudMap.get(id);
    const l = localMap.get(id);
    if (c && l) {
      const cu = Number(c.updated_at) || 0;
      const lu = l.updatedAt || 0;
      if (cu > lu) await db._sync.putRaw(table, fromCloud(c));   // 雲端較新 → 蓋回本地
      else if (lu > cu) toPush.push(toCloud(l));                 // 本地較新 → 推上雲端
    } else if (c && !l) {
      await db._sync.putRaw(table, fromCloud(c));                // 只有雲端有 → 拉下來
    } else if (l && !c) {
      toPush.push(toCloud(l));                                   // 只有本地有 → 推上去
    }
  }

  if (toPush.length) {
    const { error: upErr } = await supabase.from(table).upsert(toPush);
    if (upErr) throw upErr;
  }
  return { pulled: cloudRows.length, pushed: toPush.length };
}

// ---- 整體同步 --------------------------------------------------------------
let syncing = false;
export async function fullSync() {
  const user = await currentUser();
  if (!user || syncing) return;
  syncing = true; setStatus('syncing');
  try {
    for (const table of db._sync.stores) await syncTable(table);
    setStatus('synced');
  } catch (e) {
    console.error('雲端同步失敗:', e);
    setStatus('error:' + (e?.message || e));
    throw e;
  } finally {
    syncing = false;
  }
}

// 本地資料一有變動,稍等一下再推(避免連續輸入時狂打 API)
let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { fullSync().catch(() => {}); }, 1500);
}

// ---- 初始化(app.js 啟動時呼叫)---------------------------------------------
export async function initAuth(onAuthChange) {
  onDbChange(schedulePush);                        // 本地變動 → 排程推送
  supabase.auth.onAuthStateChange((_event, session) => {
    onAuthChange(session?.user || null);
    if (session?.user) fullSync().catch(() => {}); // 登入後立刻同步
  });
  window.addEventListener('online', () => { fullSync().catch(() => {}); }); // 恢復連線 → 同步
  return currentUser();
}
