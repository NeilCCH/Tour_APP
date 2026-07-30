// app.js — 旅遊規劃 App 的畫面與互動
// ---------------------------------------------------------------------------
// 第一步（現在）：資料主幹 + 手動輸入。
//   - 建立/管理「旅程 Trip」
//   - 在旅程底下手動新增「地點 Place」，依狀態分組顯示
//   - 資料存在手機本地（IndexedDB，見 db.js），完全離線可用
//
// 後續步驟會往上疊：地圖顯示 → 分享連結匯入 → 拖拉排行程 → 旅途記錄 → 遊記生成。
// 每一步都是往上加，不會打掉重練。
// ---------------------------------------------------------------------------

import { db, CATEGORIES, STATUSES, DEFAULT_STAY } from './db.js';
import { geocode, legModes, orderFromStart, nearestOrder, kmeansDays, orderClusters } from './geo.js';

const app = document.getElementById('app');
const header = document.getElementById('header');

// ---- 小工具 ----------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDateRange(a, b) {
  if (!a && !b) return '尚未設定日期';
  if (a && b) return `${a} → ${b}`;
  return a || b;
}

function stayText(min) {
  if (!min) return null;
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h} 小時${m ? ` ${m} 分` : ''}` : `${m} 分`;
}

function setHeader(title, showBack) {
  header.classList.toggle('has-back', !!showBack);
  header.querySelector('h1').textContent = title;
}

// ---- 路由 ------------------------------------------------------------------
function parseRoute() {
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/^\/trip\/(.+)$/);
  if (m) return { view: 'trip', tripId: m[1] };
  return { view: 'home' };
}

async function render() {
  const r = parseRoute();
  if (r.view === 'trip') {
    const trip = await db.getTrip(r.tripId);
    if (!trip) { location.hash = ''; return; }
    await renderTrip(trip);
  } else {
    await renderHome();
  }
}

// ---- 首頁：旅程列表 --------------------------------------------------------
async function renderHome() {
  setHeader('我的旅程', false);
  const trips = await db.listTrips();

  if (trips.length === 0) {
    app.innerHTML = `
      <div class="empty">
        <div class="big">🧳</div>
        <p>還沒有旅程。<br>點右下角的 <b>＋</b> 建立第一趟旅程。</p>
      </div>`;
  } else {
    // 每趟旅程附帶地點數量
    const counts = await Promise.all(trips.map((t) => db.listPlaces(t.id).then((p) => p.length)));
    app.innerHTML = trips.map((t, i) => `
      <div class="card" data-trip="${esc(t.id)}">
        <h3>${esc(t.name)}</h3>
        <div class="meta">${esc(fmtDateRange(t.startDate, t.endDate))} ・ ${t.people} 人 ・ ${counts[i]} 個地點</div>
      </div>`).join('');
    app.querySelectorAll('[data-trip]').forEach((c) =>
      c.addEventListener('click', () => { location.hash = `#/trip/${c.dataset.trip}`; }));
  }

  setFab(() => openTripSheet());
}

// ---- 旅程頁：清單 / 行程 兩個分頁 ------------------------------------------
let tripTab = 'list'; // 'list' 依狀態分組的清單 ・ 'plan' 依天數排的行程

// 這趟有幾天:有起訖日就照日期算,否則用 trip.dayCount / 已用到的最大天數
function tripDayCount(trip, places) {
  if (trip.startDate && trip.endDate) {
    const d = Math.round((new Date(trip.endDate) - new Date(trip.startDate)) / 86400000) + 1;
    if (d >= 1 && d <= 60) return d;
  }
  const maxDay = places.reduce((m, p) => Math.max(m, p.assignedDay || 0), 0);
  return Math.max(1, trip.dayCount || maxDay || 1);
}

function dayDateLabel(startDate, day) {
  const d = new Date(startDate); d.setDate(d.getDate() + (day - 1));
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}（${wd}）`;
}

function placeMetaBits(p) {
  const bits = [];
  const st = stayText(p.estimatedStay); if (st) bits.push(`⏱ ${st}`);
  if (p.estimatedCost) bits.push(`💰 ${p.estimatedCost}`);
  return bits;
}

// 「清單」分頁:依狀態分組（原本的樣子）
function listBody(places) {
  let body = '';
  for (const status of STATUSES) {
    const group = places.filter((p) => p.status === status);
    if (group.length === 0) continue;
    body += `<div class="section-title"><span class="dot st-${esc(status)}"></span> ${esc(status)}（${group.length}）</div>`;
    body += group.map((p) => {
      const bits = placeMetaBits(p);
      if (p.openingHours) bits.push(`🕒 ${esc(p.openingHours)}`);
      return `
        <div class="card" data-place="${esc(p.id)}">
          <h3>${p.pinned ? '<span class="pin-badge">📌</span>' : ''}${esc(p.name)}
            <span class="tag cat">${esc(p.category)}</span></h3>
          ${bits.length ? `<div class="meta">${bits.join(' ・ ')}</div>` : ''}
          ${p.notes ? `<div class="meta">${esc(p.notes)}</div>` : ''}
        </div>`;
    }).join('');
  }
  return body;
}

const hasCoord = (p) => p && p.lat != null && p.lng != null;

// 所有被設為某天「出發/回程」錨點的地點 id
function anchorIdSet(trip) {
  const s = new Set();
  for (const m of [trip.dayStart, trip.dayEnd]) {
    if (m) for (const k of Object.keys(m)) if (m[k]) s.add(m[k]);
  }
  return s;
}

// 兩點之間的多模式交通估時（兩點都已定位才顯示）
function legHtml(a, b) {
  if (!(hasCoord(a) && hasCoord(b))) return '';
  const { km, modes } = legModes(a, b);
  const kmTxt = km < 1 ? '<1 公里' : `約 ${km.toFixed(1)} 公里`;
  const ms = modes.map((m) => `${m.icon}${m.minutes}`).join(' ');
  return `<div class="leg">↓ ${kmTxt} ｜ ${ms} 分（估）</div>`;
}

function sightCard(p, i, n) {
  const bits = placeMetaBits(p);
  return `
    <div class="card itin" data-move="${esc(p.id)}">
      <div class="itin-main">
        <h3>${p.pinned ? '<span class="pin-badge">📌</span>' : ''}${esc(p.name)}
          <span class="tag cat">${esc(p.category)}</span></h3>
        ${bits.length ? `<div class="meta">${bits.join(' ・ ')}</div>` : ''}
      </div>
      <div class="reorder">
        <button data-up="${esc(p.id)}" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button data-down="${esc(p.id)}" ${i === n - 1 ? 'disabled' : ''}>▼</button>
      </div>
    </div>`;
}

function anchorRow(role, p) {
  const warn = hasCoord(p) ? '' : ' <span class="warn">未定位</span>';
  return `<div class="card anchor" data-move="${esc(p.id)}">🏨 ${role}・${esc(p.name)}${warn}</div>`;
}

// 「行程」分頁:每天 出發點 → 景點(就近) → 回程點,底下候選池
function planBody(trip, places, dayCount) {
  const datesFixed = !!(trip.startDate && trip.endDate);
  const byId = new Map(places.map((p) => [p.id, p]));
  const anchors = anchorIdSet(trip);
  let body = `<button class="btn primary" id="suggest" style="margin-bottom:12px">✨ 建議安排</button>`;

  for (let day = 1; day <= dayCount; day++) {
    const startP = trip.dayStart?.[day] ? byId.get(trip.dayStart[day]) : null;
    const endP = trip.dayEnd?.[day] ? byId.get(trip.dayEnd[day]) : null;
    const sights = places.filter((p) => p.assignedDay === day && !anchors.has(p.id))
      .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
    const date = datesFixed ? ` ・ ${dayDateLabel(trip.startDate, day)}` : '';
    body += `<div class="section-title">Day ${day}${date}</div>`;

    const chain = [];
    if (startP) chain.push(['出發', startP]);
    sights.forEach((p) => chain.push(['sight', p]));
    if (endP) chain.push(['回程', endP]);

    if (chain.length === 0) {
      body += `<div class="day-empty">尚未安排 — 從下方候選池點地點排進來</div>`;
    } else {
      chain.forEach(([kind, p], idx) => {
        if (idx > 0) body += legHtml(chain[idx - 1][1], p);
        if (kind === 'sight') body += sightCard(p, sights.indexOf(p), sights.length);
        else body += anchorRow(kind, p);
      });
      if (sights.length) {
        const stay = sights.reduce((s, p) => s + (p.estimatedStay || 0), 0);
        const cost = sights.reduce((s, p) => s + (p.estimatedCost || 0), 0);
        const full = stay > 600 ? ' ・ <span class="warn">這天有點滿</span>' : '';
        body += `<div class="day-sum">共 ${sights.length} 站 ・ ⏱ ${stayText(stay) || '0 分'} ・ 💰 ${cost}${full}</div>`;
      }
    }
  }
  if (!datesFixed) body += `<button class="btn ghost" id="add-day" style="margin:4px 0 8px">＋ 加一天</button>`;

  const pool = places.filter((p) => !p.assignedDay && !anchors.has(p.id)).sort((a, b) => a.createdAt - b.createdAt);
  body += `<div class="section-title">候選池（${pool.length}）</div>`;
  if (pool.length === 0) {
    body += `<div class="day-empty">沒有待排的地點</div>`;
  } else {
    body += pool.map((p) => {
      const hint = p.category === '住宿' ? '點一下 → 設為某天的出發/回程點' : '點一下 → 排進某一天';
      return `
        <div class="card" data-move="${esc(p.id)}">
          <h3>${p.pinned ? '<span class="pin-badge">📌</span>' : ''}${esc(p.name)}
            <span class="tag cat">${esc(p.category)}</span></h3>
          <div class="meta">${hint}</div>
        </div>`;
    }).join('');
  }
  return body;
}

async function renderTrip(trip) {
  setHeader(trip.name, true);
  const places = await db.listPlaces(trip.id);
  const dayCount = tripDayCount(trip, places);

  const head = `
    <div class="card" data-edit-trip style="cursor:default">
      <div class="meta" style="font-size:15px">
        📅 ${esc(fmtDateRange(trip.startDate, trip.endDate))}<br>
        👥 ${trip.people} 人 ・ 📍 ${places.length} 個地點
        <button class="btn ghost" style="width:auto;padding:6px 0;margin-top:6px" data-edit-trip-btn>編輯旅程資訊</button>
      </div>
    </div>`;

  let body;
  if (places.length === 0) {
    body = `
      <div class="empty">
        <div class="big">📍</div>
        <p>這趟旅程還沒有地點。<br>點右下角的 <b>＋</b> 手動新增第一個地點。</p>
      </div>`;
    app.innerHTML = head + body;
  } else {
    const tabs = `
      <div class="tabs">
        <button class="tab ${tripTab === 'list' ? 'on' : ''}" data-tab="list">清單</button>
        <button class="tab ${tripTab === 'plan' ? 'on' : ''}" data-tab="plan">行程</button>
      </div>`;
    body = tripTab === 'plan' ? planBody(trip, places, dayCount) : listBody(places);
    app.innerHTML = head + tabs + body;
  }

  // 分頁切換
  app.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => { tripTab = b.dataset.tab; render(); }));
  app.querySelector('[data-edit-trip-btn]')?.addEventListener('click', () => openTripSheet(trip));

  // 清單卡片 → 編輯
  app.querySelectorAll('[data-place]').forEach((c) => {
    const p = places.find((x) => x.id === c.dataset.place);
    c.addEventListener('click', () => openPlaceSheet(trip.id, p));
  });

  // 行程卡片 → 開排程選單；上下箭頭 → 調順序
  app.querySelectorAll('[data-move]').forEach((c) => {
    const p = places.find((x) => x.id === c.dataset.move);
    c.addEventListener('click', (e) => {
      if (e.target.closest('[data-up],[data-down]')) return;
      openMoveSheet(trip, places, p, dayCount);
    });
  });
  app.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation(); reorder(places, places.find((x) => x.id === b.dataset.up), -1);
  }));
  app.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation(); reorder(places, places.find((x) => x.id === b.dataset.down), 1);
  }));
  app.querySelector('#add-day')?.addEventListener('click', async () => {
    await db.updateTrip(trip.id, { dayCount: dayCount + 1 }); render();
  });
  app.querySelector('#suggest')?.addEventListener('click', () => suggestArrange(trip, places, dayCount));

  setFab(() => openPlaceSheet(trip.id));
}

// 建議安排:把「已定位」的地點依距離分成 dayCount 天,每天就近排序（PRD 4.2）
// 建議安排:兩種方式。預設「只優化每天順序」——不把地點跨日移動。
function suggestArrange(trip, places, dayCount) {
  openSheet(`
    <h2>✨ 建議安排</h2>
    <p class="meta" style="margin-bottom:14px">選一種方式（都只影響已定位的景點）:</p>
    <div class="btn-row">
      <button class="btn primary" id="s-order">只優化每天順序
        <br><span style="font-weight:400;font-size:12.5px;opacity:.85">保留你分好的天,只把每天景點依距離就近重排（有出發點就從那裡起算）</span></button>
      <button class="btn ghost" id="s-recluster">跨日重新分配
        <br><span style="font-size:12.5px;opacity:.8">把所有已定位景點依距離重新分到各天（會改動你目前的分天）</span></button>
      <button class="btn ghost" id="s-cancel">取消</button>
    </div>
  `, (sheet, close) => {
    sheet.querySelector('#s-cancel').onclick = close;
    sheet.querySelector('#s-order').onclick = async () => { close(); await suggestOrderOnly(trip, places, dayCount); };
    sheet.querySelector('#s-recluster').onclick = async () => {
      close();
      if (!confirm('這會把所有已定位景點依距離「重新分到各天」,覆蓋你目前的分天安排。要繼續嗎?')) return;
      await suggestRecluster(trip, places, dayCount);
    };
  });
}

// 只優化每天順序:各天景點依距離就近重排,有出發點就從出發點起算。不跨日移動。
async function suggestOrderOnly(trip, places, dayCount) {
  const anchors = anchorIdSet(trip);
  const byId = new Map(places.map((p) => [p.id, p]));
  let touched = 0;
  for (let day = 1; day <= dayCount; day++) {
    const startP = trip.dayStart?.[day] ? byId.get(trip.dayStart[day]) : null;
    const startCoord = hasCoord(startP) ? { lat: startP.lat, lng: startP.lng } : null;
    const sights = places.filter((p) => p.assignedDay === day && !anchors.has(p.id));
    const located = sights.filter(hasCoord);
    const unlocated = sights.filter((p) => !hasCoord(p));
    if (located.length < 1) continue;
    const ordered = orderFromStart(located.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng })), startCoord);
    const ids = [...ordered.map((o) => o.id), ...unlocated.map((u) => u.id)];
    for (let i = 0; i < ids.length; i++) { await db.updatePlace(ids[i], { orderIndex: i + 1 }); touched++; }
  }
  if (!touched) alert('沒有可排序的已定位景點。請先幫景點定位,並把景點排進某天。');
  render();
}

// 跨日重新分配:所有已定位景點依距離分成各天,每天再從出發點就近排序。
async function suggestRecluster(trip, places, dayCount) {
  const anchors = anchorIdSet(trip);
  const byId = new Map(places.map((p) => [p.id, p]));
  const located = places.filter((p) => !anchors.has(p.id) && hasCoord(p));
  if (located.length < 2) { alert('至少要有 2 個已定位的景點才能重新分配。'); return; }
  const clusters = orderClusters(kmeansDays(
    located.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng })), dayCount));
  for (let d = 0; d < clusters.length; d++) {
    const day = d + 1;
    const startP = trip.dayStart?.[day] ? byId.get(trip.dayStart[day]) : null;
    const startCoord = hasCoord(startP) ? { lat: startP.lat, lng: startP.lng } : null;
    const ordered = orderFromStart(clusters[d], startCoord);
    for (let i = 0; i < ordered.length; i++) {
      const place = byId.get(ordered[i].id);
      const patch = { assignedDay: day, orderIndex: i + 1 };
      if (place.status === '候選') patch.status = '已排入';
      await db.updatePlace(ordered[i].id, patch);
    }
  }
  render();
}

// ---- 排程操作 --------------------------------------------------------------
// 排進某天:設 assignedDay、排到當天最後,並把「候選」自動轉「已排入」
async function assignToDay(trip, places, place, day) {
  const group = places.filter((p) => p.assignedDay === day);
  const patch = {
    assignedDay: day,
    orderIndex: group.reduce((m, p) => Math.max(m, p.orderIndex ?? 0), 0) + 1,
  };
  if (place.status === '候選') patch.status = '已排入';
  await db.updatePlace(place.id, patch);
  render();
}
// 移回候選池:清掉天數,並把「已排入」自動轉回「候選」（已造訪等狀態不動）
async function moveToPool(place) {
  const patch = { assignedDay: null, orderIndex: null };
  if (place.status === '已排入') patch.status = '候選';
  await db.updatePlace(place.id, patch);
  render();
}
// 同一天內上/下移
async function reorder(places, place, dir) {
  if (!place) return;
  const group = places.filter((p) => p.assignedDay === place.assignedDay)
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  const idx = group.findIndex((p) => p.id === place.id);
  const swap = idx + dir;
  if (swap < 0 || swap >= group.length) return;
  const a = group[idx], b = group[swap];
  const ao = a.orderIndex ?? idx, bo = b.orderIndex ?? swap;
  await db.updatePlace(a.id, { orderIndex: bo });
  await db.updatePlace(b.id, { orderIndex: ao });
  render();
}

function openMoveSheet(trip, places, place, dayCount) {
  if (place.category === '住宿') return openAnchorSheet(trip, place, dayCount);
  const cur = place.assignedDay || 0;
  const chips = [`<div class="chip ${cur === 0 ? 'on' : ''}" data-day="0">候選池</div>`];
  for (let d = 1; d <= dayCount; d++) {
    chips.push(`<div class="chip ${cur === d ? 'on' : ''}" data-day="${d}">Day ${d}</div>`);
  }
  openSheet(`
    <h2>${esc(place.name)}</h2>
    <label class="field"><span class="lab">排到哪一天</span>
      <div class="chips" id="m-days">${chips.join('')}</div></label>
    <div class="btn-row">
      <button class="btn ghost" id="m-edit">編輯地點內容</button>
      <button class="btn ghost" id="m-cancel">關閉</button>
    </div>
  `, (sheet, close) => {
    sheet.querySelector('#m-days').addEventListener('click', async (e) => {
      const chip = e.target.closest('.chip'); if (!chip) return;
      const day = Number(chip.dataset.day);
      close();
      if (day === 0) await moveToPool(place);
      else await assignToDay(trip, places, place, day);
    });
    sheet.querySelector('#m-edit').onclick = () => { close(); openPlaceSheet(trip.id, place); };
    sheet.querySelector('#m-cancel').onclick = close;
  });
}

// 住宿:設為某幾天的「出發點 / 回程點」。
// 便利:設某天「回程」會自動把隔天「出發」也設成同一間(睡哪就從哪出發);
// 「連住整趟」一鍵把每晚都設成這間。
function openAnchorSheet(trip, place, dayCount) {
  const dayStart = { ...(trip.dayStart || {}) };
  const dayEnd = { ...(trip.dayEnd || {}) };
  const gridHtml = () => {
    let r = '';
    for (let d = 1; d <= dayCount; d++) {
      r += `<div class="anchor-day"><span>Day ${d}</span>
        <button class="chip ${dayStart[d] === place.id ? 'on' : ''}" data-role="start" data-day="${d}">出發</button>
        <button class="chip ${dayEnd[d] === place.id ? 'on' : ''}" data-role="end" data-day="${d}">回程</button></div>`;
    }
    return r;
  };
  const save = () => db.updateTrip(trip.id, { dayStart, dayEnd });

  openSheet(`
    <h2>🏨 ${esc(place.name)}</h2>
    <p class="meta" style="margin-bottom:10px">設為哪幾天的出發點 / 回程點。設「回程」會自動把隔天「出發」也設成這間。${hasCoord(place) ? '' : '<b class="warn"> 此地點尚未定位,交通估算會缺這段。</b>'}</p>
    <button class="btn ghost" id="a-all" style="margin-bottom:8px">🔗 連住整趟（每晚都住這裡）</button>
    <div class="anchor-grid" id="anchor-grid">${gridHtml()}</div>
    <div class="btn-row">
      <button class="btn ghost" id="a-clear">清除此住宿的所有設定</button>
      <button class="btn ghost" id="m-edit">編輯地點內容</button>
      <button class="btn ghost" id="m-close">關閉</button>
    </div>
  `, (sheet, close) => {
    const grid = sheet.querySelector('#anchor-grid');
    const redraw = async () => { grid.innerHTML = gridHtml(); await save(); render(); };

    grid.addEventListener('click', async (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      const day = Number(b.dataset.day), role = b.dataset.role;
      const map = role === 'start' ? dayStart : dayEnd;
      const on = map[day] !== place.id;
      if (on) map[day] = place.id; else delete map[day];
      // 自動串連:回程 → 次日出發同一間;取消回程則一併取消次日出發
      if (role === 'end' && day + 1 <= dayCount) {
        if (on) dayStart[day + 1] = place.id;
        else if (dayStart[day + 1] === place.id) delete dayStart[day + 1];
      }
      await redraw();
    });

    sheet.querySelector('#a-all').onclick = async () => {
      for (let d = 1; d <= dayCount; d++) {
        if (d < dayCount) dayEnd[d] = place.id;   // 每晚(最後一天不設回程)
        if (d > 1) dayStart[d] = place.id;        // 隔天出發(第一天不動)
      }
      await redraw();
    };
    sheet.querySelector('#a-clear').onclick = async () => {
      for (let d = 1; d <= dayCount; d++) {
        if (dayStart[d] === place.id) delete dayStart[d];
        if (dayEnd[d] === place.id) delete dayEnd[d];
      }
      await redraw();
    };
    sheet.querySelector('#m-edit').onclick = () => { close(); openPlaceSheet(trip.id, place); };
    sheet.querySelector('#m-close').onclick = () => { close(); render(); };
  });
}

// ---- 浮動新增鈕 ------------------------------------------------------------
let fab = null;
function setFab(handler) {
  if (!fab) {
    fab = document.createElement('button');
    fab.className = 'fab';
    fab.setAttribute('aria-label', '新增');
    fab.textContent = '＋';
    document.body.appendChild(fab);
  }
  fab.onclick = handler;
}

// ---- 底部彈出表單（sheet）--------------------------------------------------
function openSheet(innerHTML, onMount) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet"><div class="grabber"></div>${innerHTML}</div>`;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('show'));

  const close = () => {
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.remove(), 250);
  };
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  onMount(backdrop.querySelector('.sheet'), close);
}

// ---- 旅程表單 --------------------------------------------------------------
function openTripSheet(trip = null) {
  const editing = !!trip;
  openSheet(`
    <h2>${editing ? '編輯旅程' : '新增旅程'}</h2>
    <label class="field"><span class="lab">旅程名稱</span>
      <input id="f-name" placeholder="例如：關西五日" value="${esc(trip?.name || '')}"></label>
    <div class="row2">
      <label class="field"><span class="lab">出發日</span>
        <input id="f-start" type="date" value="${esc(trip?.startDate || '')}"></label>
      <label class="field"><span class="lab">回程日</span>
        <input id="f-end" type="date" value="${esc(trip?.endDate || '')}"></label>
    </div>
    <label class="field"><span class="lab">人數</span>
      <input id="f-people" type="number" min="1" inputmode="numeric" value="${esc(trip?.people || 1)}"></label>
    <div class="btn-row">
      <button class="btn primary" id="f-save">${editing ? '儲存' : '建立旅程'}</button>
      ${editing ? '<button class="btn danger" id="f-del">刪除這趟旅程</button>' : ''}
      <button class="btn ghost" id="f-cancel">取消</button>
    </div>
  `, (sheet, close) => {
    sheet.querySelector('#f-cancel').onclick = close;
    sheet.querySelector('#f-save').onclick = async () => {
      const data = {
        name: sheet.querySelector('#f-name').value.trim(),
        startDate: sheet.querySelector('#f-start').value,
        endDate: sheet.querySelector('#f-end').value,
        people: sheet.querySelector('#f-people').value,
      };
      if (!data.name) { sheet.querySelector('#f-name').focus(); return; }
      if (editing) await db.updateTrip(trip.id, data);
      else { const t = await db.createTrip(data); location.hash = `#/trip/${t.id}`; }
      close(); render();
    };
    if (editing) sheet.querySelector('#f-del').onclick = async () => {
      if (!confirm(`確定刪除「${trip.name}」？底下所有地點與記錄都會一起刪除，無法復原。`)) return;
      await db.deleteTrip(trip.id);
      close(); location.hash = '';
    };
  });
}

// ---- 地點表單 --------------------------------------------------------------
function openPlaceSheet(tripId, place = null) {
  const editing = !!place;
  const cat = place?.category || '景點';
  const status = place?.status || '候選';

  openSheet(`
    <h2>${editing ? '編輯地點' : '新增地點'}</h2>
    <label class="field"><span class="lab">地點名稱</span>
      <input id="f-name" placeholder="例如：清水寺" value="${esc(place?.name || '')}"></label>

    <label class="field"><span class="lab">位置（給「建議安排」用）</span>
      <div style="display:flex;gap:8px;align-items:center">
        <button type="button" class="chip" id="f-locate">📍 用名稱定位</button>
        <span class="meta" id="f-loc" style="flex:1;min-width:0"></span>
      </div></label>

    <label class="field"><span class="lab">分類</span>
      <div class="chips" id="f-cat">
        ${CATEGORIES.map((c) => `<div class="chip ${c === cat ? 'on' : ''}" data-v="${esc(c)}">${esc(c)}</div>`).join('')}
      </div></label>

    <label class="field"><span class="lab">狀態</span>
      <div class="chips" id="f-status">
        ${STATUSES.map((s) => `<div class="chip ${s === status ? 'on' : ''}" data-v="${esc(s)}">${esc(s)}</div>`).join('')}
      </div></label>

    <div class="row2">
      <label class="field"><span class="lab">預估停留（分鐘）</span>
        <input id="f-stay" type="number" min="0" inputmode="numeric"
          placeholder="${DEFAULT_STAY[cat] ?? 60}" value="${place?.estimatedStay ?? ''}"></label>
      <label class="field"><span class="lab">預估花費</span>
        <input id="f-cost" type="number" min="0" inputmode="numeric" value="${place?.estimatedCost || ''}"></label>
    </div>

    <label class="field"><span class="lab">營業時間（選填）</span>
      <input id="f-hours" placeholder="例如：09:00–17:00" value="${esc(place?.openingHours || '')}"></label>
    <label class="field"><span class="lab">參考連結（選填）</span>
      <input id="f-url" type="url" placeholder="貼上 Google 地圖分享連結" value="${esc(place?.referenceUrl || '')}"></label>
    <label class="field"><span class="lab">備註（選填）</span>
      <textarea id="f-notes" placeholder="想吃的、想看的、注意事項…">${esc(place?.notes || '')}</textarea></label>

    <div class="toggle-row">
      <div><b>釘選為固定錨點</b><div class="desc">訂位餐廳、演出、機票等時間固定的點</div></div>
      <div class="chip ${place?.pinned ? 'on' : ''}" id="f-pin">📌 ${place?.pinned ? '已釘選' : '未釘選'}</div>
    </div>

    <div class="btn-row">
      <button class="btn primary" id="f-save">${editing ? '儲存' : '新增地點'}</button>
      ${editing ? '<button class="btn danger" id="f-del">刪除這個地點</button>' : ''}
      <button class="btn ghost" id="f-cancel">取消</button>
    </div>
  `, (sheet, close) => {
    // 單選 chips（分類、狀態）
    const bindSingle = (id) => {
      const box = sheet.querySelector(id);
      box.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip'); if (!chip) return;
        box.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
        chip.classList.add('on');
        // 切換分類時，若停留欄空白，更新 placeholder 為該分類預設值
        if (id === '#f-cat') sheet.querySelector('#f-stay').placeholder = DEFAULT_STAY[chip.dataset.v] ?? 60;
      });
    };
    bindSingle('#f-cat'); bindSingle('#f-status');

    // 定位（用名稱查座標,給「建議安排」用）
    let coords = (place && place.lat != null && place.lng != null) ? { lat: place.lat, lng: place.lng } : null;
    const locEl = sheet.querySelector('#f-loc');
    if (coords) locEl.textContent = `已定位 ✓ (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`;
    sheet.querySelector('#f-locate').onclick = async () => {
      const q = sheet.querySelector('#f-name').value.trim();
      if (!q) { locEl.textContent = '請先輸入地點名稱'; return; }
      locEl.textContent = '查詢中…（免費服務,約 1 秒）';
      try {
        const r = await geocode(q);
        if (!r) { coords = null; locEl.textContent = '找不到,試更完整的名稱(例如「清水寺 京都」)'; return; }
        coords = { lat: r.lat, lng: r.lng };
        locEl.textContent = '已定位 ✓ ' + r.label.split(',').slice(0, 3).join(',');
      } catch (e) { locEl.textContent = '定位失敗:' + (e.message || e); }
    };

    // 釘選開關
    const pinChip = sheet.querySelector('#f-pin');
    let pinned = !!place?.pinned;
    pinChip.onclick = () => {
      pinned = !pinned;
      pinChip.classList.toggle('on', pinned);
      pinChip.textContent = `📌 ${pinned ? '已釘選' : '未釘選'}`;
    };

    sheet.querySelector('#f-cancel').onclick = close;
    sheet.querySelector('#f-save').onclick = async () => {
      const name = sheet.querySelector('#f-name').value.trim();
      if (!name) { sheet.querySelector('#f-name').focus(); return; }
      const selCat = sheet.querySelector('#f-cat .chip.on')?.dataset.v || '景點';
      const stayRaw = sheet.querySelector('#f-stay').value;
      const data = {
        name,
        category: selCat,
        status: sheet.querySelector('#f-status .chip.on')?.dataset.v || '候選',
        estimatedStay: stayRaw === '' ? (DEFAULT_STAY[selCat] ?? 60) : Number(stayRaw),
        estimatedCost: Number(sheet.querySelector('#f-cost').value) || 0,
        openingHours: sheet.querySelector('#f-hours').value.trim(),
        referenceUrl: sheet.querySelector('#f-url').value.trim(),
        notes: sheet.querySelector('#f-notes').value.trim(),
        pinned,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
      };
      if (editing) await db.updatePlace(place.id, data);
      else await db.createPlace(tripId, data);
      close(); render();
    };
    if (editing) sheet.querySelector('#f-del').onclick = async () => {
      if (!confirm(`確定刪除「${place.name}」？`)) return;
      await db.deletePlace(place.id);
      close(); render();
    };
  });
}

// ---- 離線狀態 --------------------------------------------------------------
function updateOnline() { document.body.classList.toggle('offline', !navigator.onLine); }
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
updateOnline();

// ---- 帳號 / 雲端同步（Supabase）-------------------------------------------
// sync.js 是「動態載入」的:萬一離線或 CDN 被擋,載入失敗也只是沒有雲端,
// App 仍能純本地運作。
let cloud = null;         // sync.js 模組（null = 純本地）
let cloudUser = null;     // 目前登入者
let cloudState = 'idle';  // idle | syncing | synced | error

const acctBtn = document.createElement('button');
acctBtn.className = 'acct';
acctBtn.addEventListener('click', openAuthSheet);
header.appendChild(acctBtn);

function updateAcct() {
  if (!cloud) { acctBtn.textContent = '☁︎'; return; }
  if (!cloudUser) { acctBtn.textContent = '登入'; return; }
  acctBtn.textContent = { syncing: '⟳ 同步中', synced: '✓ 已同步', error: '⚠ 未同步' }[cloudState] || '☁︎ 已登入';
}

async function initCloud() {
  updateAcct();
  try {
    cloud = await import('./sync.js');
  } catch (e) {
    console.warn('雲端模組載入失敗,以純本地模式運作', e);
    cloud = null; updateAcct(); return;
  }
  cloud.onStatus((s) => {
    if (s === 'syncing') cloudState = 'syncing';
    else if (s === 'synced') { cloudState = 'synced'; render(); }
    else if (s && s.startsWith('error')) cloudState = 'error';
    updateAcct();
  });
  cloudUser = await cloud.initAuth((user) => { cloudUser = user; updateAcct(); render(); });
  updateAcct();
}

function openAuthSheet() {
  if (!cloud) { alert('雲端功能載入失敗（可能離線或被網路阻擋）。App 仍可離線使用,資料存在本機。'); return; }

  if (cloudUser) {
    const stTxt = { syncing: '同步中…', synced: '已同步 ✓', error: '上次同步失敗 ⚠' }[cloudState] || '—';
    openSheet(`
      <h2>雲端帳號</h2>
      <p class="meta" style="margin-bottom:16px">已登入:<b>${esc(cloudUser.email || '')}</b><br>狀態:${stTxt}</p>
      <div class="btn-row">
        <button class="btn primary" id="a-sync">立即同步</button>
        <button class="btn danger" id="a-out">登出</button>
        <button class="btn ghost" id="a-cancel">關閉</button>
      </div>`, (sheet, close) => {
      sheet.querySelector('#a-cancel').onclick = close;
      sheet.querySelector('#a-sync').onclick = () => { cloud.fullSync().catch(() => {}); close(); };
      sheet.querySelector('#a-out').onclick = async () => {
        await cloud.signOut(); cloudUser = null; updateAcct(); close(); render();
      };
    });
    return;
  }

  openSheet(`
    <h2>登入雲端</h2>
    <p class="meta" style="margin-bottom:16px">登入後,資料會備份到雲端,換手機也不會不見。</p>
    <label class="field"><span class="lab">Email</span>
      <input id="a-email" type="email" autocomplete="username" placeholder="you@example.com"></label>
    <label class="field"><span class="lab">密碼</span>
      <input id="a-pass" type="password" autocomplete="current-password" placeholder="至少 6 碼"></label>
    <div id="a-msg" class="meta" style="min-height:18px"></div>
    <div class="btn-row">
      <button class="btn primary" id="a-login">登入</button>
      <button class="btn ghost" id="a-signup">第一次使用,註冊新帳號</button>
      <button class="btn ghost" id="a-cancel">取消</button>
    </div>`, (sheet, close) => {
    const msg = sheet.querySelector('#a-msg');
    const vals = () => [sheet.querySelector('#a-email').value.trim(), sheet.querySelector('#a-pass').value];
    const fail = (t) => { msg.style.color = 'var(--danger)'; msg.textContent = t; };
    sheet.querySelector('#a-cancel').onclick = close;
    sheet.querySelector('#a-login').onclick = async () => {
      const [email, pass] = vals();
      msg.style.color = 'var(--text-dim)'; msg.textContent = '登入中…';
      const { error } = await cloud.signIn(email, pass);
      if (error) return fail('登入失敗:' + error.message);
      close();
    };
    sheet.querySelector('#a-signup').onclick = async () => {
      const [email, pass] = vals();
      if (!email || pass.length < 6) return fail('請輸入 Email 和至少 6 碼密碼');
      msg.style.color = 'var(--text-dim)'; msg.textContent = '註冊中…';
      const { data, error } = await cloud.signUp(email, pass);
      if (error) return fail('註冊失敗:' + error.message);
      if (data.session) close();  // 已直接登入（未開啟 Email 驗證時）
      else { msg.style.color = 'var(--accent)'; msg.textContent = '註冊成功!請收 Email 確認信、點連結後再回來登入。'; }
    };
  });
}

// ---- 啟動 ------------------------------------------------------------------
window.addEventListener('hashchange', render);
header.querySelector('.back').addEventListener('click', () => { location.hash = ''; });
render();
initCloud();

// 註冊 Service Worker（讓 App 可離線、可加入主畫面）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
