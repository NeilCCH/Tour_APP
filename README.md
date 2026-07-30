# 旅遊規劃 App（Tour_APP）

把一趟旅遊當成一個專案的生命週期來做:**行前規劃 → 旅途記錄 → 旅遊書整理**,
三個階段共用同一份資料主幹(`Trip → Place → Moment`),所以最後的遊記可以自動生成。

這是一個 **PWA(網頁 App)**:免上架,用 Safari 打開網址就能「加入主畫面」變成一顆 App 圖示,
資料存在手機本地(離線也能用)。

---

## 目前進度

**第一步 — 資料主幹 + 手動輸入**
- 建立 / 編輯 / 刪除「旅程 Trip」
- 在旅程底下手動新增「地點 Place」,依狀態(候選／已排入／已造訪／已造訪・未規劃)分組顯示
- 分類、預估停留與花費、營業時間、參考連結、備註、釘選錨點
- 資料存在瀏覽器本地(IndexedDB),**完全離線可用**

**第二步 — 雲端同步(Supabase)**
- 登入帳號後,資料雙向同步到 Supabase,**換手機不會不見**、可多裝置
- 本地優先:離線照常使用,連線後在背景同步(以 `updatedAt` 較新者為準)
- 一次性設定見下方「Supabase 設定」

**第三步 — 排行程**
- 旅程頁分「清單 / 行程」兩個分頁
- 把候選地點排進 Day 1 / Day 2…,同一天內用 ▲▼ 調順序
- 每天顯示站數、停留與花費加總,過滿會提示
- 有設起訖日就自動帶出每天日期;沒設可手動「＋ 加一天」
- 排入自動把「候選」轉「已排入」;移回候選池則轉回

### 後續步驟(往上疊,不打掉重練)

4. 地圖顯示 + Google 地圖分享連結匯入
5. 自動分天建議 + 真實路線/交通時間(PRD 4.2 / 4.3)
6. 旅途記錄(拍照歸位、記花費)
7. 旅遊書自動組裝 + AI 草稿

## Supabase 設定(第二步,一次性)

1. `supabase-schema.sql` 的內容 → 貼到 Supabase 主控台 **SQL Editor** → Run(建表 + 安全規則)
2.(建議)**Authentication → Sign In / Providers → Email** → 關掉 **Confirm email**,註冊後即可直接登入
3. 連線用的 URL 與公開金鑰放在 `supabase-config.js`(可公開,靠 RLS 保護)
4. App 右上角「登入」→ 註冊/登入後就會開始同步

---

## 檔案結構

| 檔案 | 作用 |
|---|---|
| `index.html` | App 外殼 |
| `app.js` | 畫面與互動邏輯 |
| `db.js` | 本地資料層(IndexedDB)。**日後接雲端只改這一層,畫面不用動** |
| `styles.css` | 樣式(支援淺色/深色、iPhone 安全區域) |
| `manifest.webmanifest` | PWA 設定(名稱、圖示) |
| `sw.js` | Service Worker(離線快取)。改版後把裡面的 `tour-v1` 版本號 +1 |
| `icon-*.png` / `icon.svg` | App 圖示 |

**無需 build**:純靜態檔案,commit 上 GitHub 就能部署,不用 Node 打包工具。

---

## 在自己的 Mac 上測試

因為用到 Service Worker,必須透過本機伺服器開啟(直接雙擊 HTML 不行):

```bash
cd Tour_APP
python3 -m http.server 8080
```

然後瀏覽器開 `http://localhost:8080`。

> 想在 iPhone 上測本機版:手機與 Mac 連同一個 Wi-Fi,開 `http://<你的Mac區網IP>:8080`。
> 但 iOS 的「加入主畫面 / 離線」功能需要 HTTPS,建議直接用下面的 GitHub Pages 網址測。

## 部署到 GitHub Pages(正式測試路徑)

1. 這個 repo 的 **Settings → Pages**
2. **Source** 選 **Deploy from a branch**,分支選 **`main`**、資料夾選 **`/ (root)`**,存檔
3. 等一兩分鐘,網址會是 `https://neilcch.github.io/Tour_APP/`

## 加到 iPhone 主畫面

用 **Safari** 開上面的網址 → 底部「分享」→「加入主畫面」→ 完成,就會有一顆行李箱圖示。
