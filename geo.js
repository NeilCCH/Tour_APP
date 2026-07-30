// geo.js — 地理計算 + 定位查詢
// ---------------------------------------------------------------------------
// 分兩部分:
//  1) 純數學（距離、交通估算、就近排序、依距離分天）— 不需網路,可離線算
//  2) geocode()：依名稱查座標,用免費的 OpenStreetMap Nominatim（需網路）
//
// 呼應 PRD 3.2「包一層 adapter」:未來要換成 Apple Maps / Google 只要改這一個檔。
// ---------------------------------------------------------------------------

const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;

// 兩點球面距離（公里）
export function haversine(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// 多模式交通估算（PRD 4.3：先用直線距離×係數當保底,不打真實 API）
// 回傳 { km, modes:[{icon,label,minutes}] }：步行/巴士/捷運/駕車。
// 註:這是粗估（各模式給一個平均時速,含等車/繞路的折算），之後可換真實路線 API。
export function legModes(a, b) {
  const straight = haversine(a, b);
  const roadKm = straight * 1.25;
  const mk = (icon, label, kmh, km) => ({ icon, label, minutes: Math.max(1, Math.round((km / kmh) * 60)) });
  const modes = [];
  if (roadKm < 8) modes.push(mk('🚶', '步行', 4.5, roadKm)); // 太遠就不列步行
  modes.push(mk('🚌', '巴士', 14, roadKm));
  modes.push(mk('🚇', '捷運', 32, straight * 1.15));
  modes.push(mk('🚗', '駕車', 24, roadKm));
  return { km: roadKm, modes };
}

// 從指定「出發點」開始就近串連（住宿當天出發點用）。沒給 start 就退回一般最近鄰。
export function orderFromStart(items, start) {
  if (items.length <= 1) return items.slice();
  if (!start) return nearestOrder(items);
  const remaining = items.slice();
  const ordered = [];
  let cur = start;
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(cur, remaining[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    cur = remaining[bi]; ordered.push(cur); remaining.splice(bi, 1);
  }
  return ordered;
}

// 就近排序（最近鄰):從 startId(或第一個)開始,每次接最近的下一站
export function nearestOrder(items, startId) {
  if (items.length <= 2) return items.slice();
  const remaining = items.slice();
  let start = startId ? remaining.findIndex((p) => p.id === startId) : 0;
  if (start < 0) start = 0;
  const ordered = [remaining.splice(start, 1)[0]];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(last, remaining[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    ordered.push(remaining.splice(bi, 1)[0]);
  }
  return ordered;
}

const centroidOf = (c) => ({ lat: avg(c.map((p) => p.lat)), lng: avg(c.map((p) => p.lng)) });

// 依距離分成 k 群（簡化版 k-means,farthest-first 初始化）
export function kmeansDays(items, k) {
  if (items.length === 0) return [];
  k = Math.max(1, Math.min(k, items.length));

  const centroids = [{ lat: items[0].lat, lng: items[0].lng }];
  while (centroids.length < k) {
    let best = items[0], bestD = -1;
    for (const it of items) {
      const d = Math.min(...centroids.map((c) => haversine(c, it)));
      if (d > bestD) { bestD = d; best = it; }
    }
    centroids.push({ lat: best.lat, lng: best.lng });
  }

  const assign = new Array(items.length).fill(-1);
  for (let iter = 0; iter < 30; iter++) {
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = haversine(centroids[c], items[i]);
        if (d < bd) { bd = d; bi = c; }
      }
      if (assign[i] !== bi) { assign[i] = bi; changed = true; }
    }
    for (let c = 0; c < k; c++) {
      const members = items.filter((_, i) => assign[i] === c);
      if (members.length) centroids[c] = centroidOf(members);
    }
    if (!changed) break;
  }

  const clusters = Array.from({ length: k }, () => []);
  items.forEach((it, i) => clusters[assign[i]].push(it));
  return clusters.filter((c) => c.length);
}

// 把各天的群依「就近串連」排出先後,讓連續幾天在地理上不會亂跳
export function orderClusters(clusters) {
  if (clusters.length <= 2) return clusters;
  const cs = clusters.map((c) => ({ c, ct: centroidOf(c) }));
  let start = 0;
  cs.forEach((x, i) => { if (x.ct.lng < cs[start].ct.lng) start = i; }); // 從最西邊開始
  const remaining = cs.slice();
  const ordered = [remaining.splice(start, 1)[0]];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(last.ct, remaining[i].ct);
      if (d < bd) { bd = d; bi = i; }
    }
    ordered.push(remaining.splice(bi, 1)[0]);
  }
  return ordered.map((x) => x.c);
}

// 依名稱查座標（Nominatim,免費;公用伺服器限每秒 1 次,故只在使用者手動按時呼叫）
export async function geocode(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1'
    + '&accept-language=zh-TW&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('查詢失敗（HTTP ' + res.status + '）');
  const arr = await res.json();
  if (!arr.length) return null;
  const r = arr[0];
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), label: r.display_name };
}
