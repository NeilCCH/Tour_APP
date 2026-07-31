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

// 加入協作:憑邀請碼把自己加進該行程的 members(由後端 RPC 安全處理)
export async function joinTrip(tripId, code) {
  return supabase.rpc('join_trip', { p_trip_id: tripId, p_code: code });
}

// ---- 使用者暱稱 profiles(供顯示「Neo,您好」與 email 邀請查詢)------------------
export async function saveProfile(nickname) {
  const user = await currentUser(); if (!user) return;
  return supabase.from('profiles').upsert({ id: user.id, email: user.email, nickname, updated_at: Date.now() });
}
export async function getMyProfile() {
  const user = await currentUser(); if (!user) return null;
  const { data } = await supabase.from('profiles').select('nickname,email').eq('id', user.id).maybeSingle();
  return data || null;
}
export async function findProfileByEmail(email) {
  const { data } = await supabase.from('profiles').select('id,nickname,email').eq('email', email).maybeSingle();
  return data || null;
}
export async function getProfiles(ids) {
  if (!ids || !ids.length) return [];
  const { data } = await supabase.from('profiles').select('id,nickname,email').in('id', ids);
  return data || [];
}

// ---- Email 邀請 + 通知 + 接受 + 協作者管理 ----------------------------------
export async function createInvite(tripId, tripName, inviterName, inviteeId) {
  return supabase.from('invitations').insert({
    trip_id: tripId, trip_name: tripName, inviter_name: inviterName,
    invitee_id: inviteeId, status: 'pending', created_at: Date.now(),
  });
}
export async function listMyInvites() {
  const user = await currentUser(); if (!user) return [];
  const { data } = await supabase.from('invitations').select('*')
    .eq('invitee_id', user.id).eq('status', 'pending');
  return data || [];
}
export async function acceptInvite(id) { return supabase.rpc('accept_invite', { p_invite: id }); }
export async function declineInvite(id) { return supabase.from('invitations').update({ status: 'declined' }).eq('id', id); }
export async function removeMember(tripId, memberId) { return supabase.rpc('remove_member', { p_trip: tripId, p_member: memberId }); }

export const signUp = (email, password) => supabase.auth.signUp({ email, password });
export const signIn = (email, password) => supabase.auth.signInWithPassword({ email, password });
export const signOut = () => supabase.auth.signOut();

// ---- 雲端 <-> 本地 資料形狀轉換 ----------------------------------------------
// 雲端每張表欄位:id(uuid) / user_id / data(jsonb=整筆本地物件) / updated_at / deleted
// 拉回時用雲端權威的 user_id 蓋上 ownerId,確保資料正確歸屬到擁有者
const fromCloud = (c) => ({ ...(c.data || {}), id: c.id, updatedAt: Number(c.updated_at) || 0, deleted: !!c.deleted, ownerId: c.user_id });
const toCloud = (l) => ({ id: l.id, data: l, updated_at: l.updatedAt || 0, deleted: !!l.deleted });

// 欄位級合併:逐欄位取「修改時間(fts)較新」的一方(沒有 fts 就退回整筆 updatedAt)。
// 這樣兩人改同一筆的不同欄位都能保留,只有同一欄同時改才需取捨。
function fieldMerge(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete('fts'); keys.delete('updatedAt');
  const out = {}, fts = {};
  for (const k of keys) {
    if (k === 'id' || k === 'createdAt') { out[k] = a[k] ?? b[k]; continue; }
    if (k === 'ownerId') { out[k] = b.ownerId ?? a.ownerId; continue; } // 擁有者以雲端為權威
    const at = (a.fts && a.fts[k] != null) ? a.fts[k] : (a.updatedAt || 0);
    const bt = (b.fts && b.fts[k] != null) ? b.fts[k] : (b.updatedAt || 0);
    out[k] = bt > at ? b[k] : a[k];
    fts[k] = Math.max(at, bt);
  }
  out.fts = fts;
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  return out;
}
// 比較兩筆「值」是否相同(忽略 fts / updatedAt,避免無意義的來回推送)
function sameData(x, y) {
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  keys.delete('fts'); keys.delete('updatedAt');
  for (const k of keys) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) return false;
  return true;
}
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
      const r = fromCloud(c);              // 雲端記錄(已含權威 ownerId)
      const merged = fieldMerge(l, r);     // 逐欄位合併
      if (!sameData(merged, l)) await db._sync.putRaw(table, merged); // 本地有變 → 寫回
      if (!sameData(merged, r)) toPush.push(toCloud(merged));         // 雲端有差 → 推上去
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

// 本地資料一有變動,稍等一下再推(避免連續輸入時狂打 API),推完廣播通知協作者
let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => { await fullSync().catch(() => {}); broadcastChanged(); }, 1200);
}

// ---- Realtime:協作即時同步 + 在線狀態 + 編輯中提示(用廣播/presence,免資料庫設定)----
let tripChannel = null;
export function joinTripChannel(tripId, me, handlers) {
  leaveTripChannel();
  const ch = supabase.channel('trip:' + tripId, { config: { presence: { key: me.id } } });
  ch.on('broadcast', { event: 'changed' }, () => { if (handlers.onChanged) handlers.onChanged(); })
    .on('broadcast', { event: 'editing' }, ({ payload }) => { if (handlers.onEditing) handlers.onEditing(payload); })
    .on('presence', { event: 'sync' }, () => { if (handlers.onPresence) handlers.onPresence(ch.presenceState()); })
    .subscribe((status) => { if (status === 'SUBSCRIBED') ch.track({ id: me.id, nickname: me.nickname }); });
  tripChannel = ch;
}
export function leaveTripChannel() {
  if (tripChannel) { try { supabase.removeChannel(tripChannel); } catch (_) {} tripChannel = null; }
}
export function broadcastChanged() {
  if (tripChannel) tripChannel.send({ type: 'broadcast', event: 'changed', payload: {} });
}
export function broadcastEditing(id, placeId, nickname) {
  if (tripChannel) tripChannel.send({ type: 'broadcast', event: 'editing', payload: { id, placeId, nickname } });
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
