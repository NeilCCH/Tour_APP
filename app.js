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

// ---- 旅程頁：地點依狀態分組 ------------------------------------------------
async function renderTrip(trip) {
  setHeader(trip.name, true);
  const places = await db.listPlaces(trip.id);

  const head = `
    <div class="card" data-edit-trip style="cursor:default">
      <div class="meta" style="font-size:15px">
        📅 ${esc(fmtDateRange(trip.startDate, trip.endDate))}<br>
        👥 ${trip.people} 人 ・ 📍 ${places.length} 個地點
        <button class="btn ghost" style="width:auto;padding:6px 0;margin-top:6px" data-edit-trip-btn>編輯旅程資訊</button>
      </div>
    </div>`;

  let body = '';
  if (places.length === 0) {
    body = `
      <div class="empty">
        <div class="big">📍</div>
        <p>這趟旅程還沒有地點。<br>點右下角的 <b>＋</b> 手動新增第一個地點。</p>
      </div>`;
  } else {
    for (const status of STATUSES) {
      const group = places.filter((p) => p.status === status);
      if (group.length === 0) continue;
      body += `<div class="section-title"><span class="dot st-${esc(status)}"></span> ${esc(status)}（${group.length}）</div>`;
      body += group.map((p) => {
        const bits = [];
        const st = stayText(p.estimatedStay); if (st) bits.push(`⏱ ${st}`);
        if (p.estimatedCost) bits.push(`💰 ${p.estimatedCost}`);
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
  }

  app.innerHTML = head + body;
  app.querySelector('[data-edit-trip-btn]')?.addEventListener('click', () => openTripSheet(trip));
  app.querySelectorAll('[data-place]').forEach((c) => {
    const p = places.find((x) => x.id === c.dataset.place);
    c.addEventListener('click', () => openPlaceSheet(trip.id, p));
  });

  setFab(() => openPlaceSheet(trip.id));
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

// ---- 啟動 ------------------------------------------------------------------
window.addEventListener('hashchange', render);
header.querySelector('.back').addEventListener('click', () => { location.hash = ''; });
render();

// 註冊 Service Worker（讓 App 可離線、可加入主畫面）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
