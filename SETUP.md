# 線上預約系統 — 設定與部署指南

這份指南帶你把「LINE 預約 + 方案點數」系統上線。多數是在各家 console 點選操作，照步驟做即可。
遇到金鑰、網址需要填回程式的地方，下面都會標清楚「填到哪個檔案的哪一行」。

涉及檔案：
- `booking-worker.js`：後端 API 閘道（部署到 Cloudflare Workers）
- `booking.html`：客戶端 LIFF 頁（部署到 Cloudflare Pages / 任何 HTTPS 空間）
- `index.html`：現有後台（會再擴充預約/方案/扣次功能）
- `firestore.rules`：資料庫安全規則
- `wrangler.toml`：Worker 部署設定

---

## Step 1 — Firebase 服務帳號（給 Worker 用）

1. 進 https://console.firebase.google.com/ → 專案 `relax-clinic`。
2. 左上齒輪 **專案設定 → 服務帳戶**。
3. 按 **產生新的私密金鑰** → 下載一個 JSON 檔（請妥善保管，等同密碼）。
4. 打開 JSON，等等會用到其中兩個欄位：
   - `client_email`
   - `private_key`（一長串 `-----BEGIN PRIVATE KEY-----…`）

## Step 2 — 套用 Firestore 安全規則

1. Firebase Console → **Firestore Database → 規則**。
2. 把 `firestore.rules` 的內容整段貼上 → **發布**。
   （這會擋掉任何未登入的直接存取；客戶端走 Worker 不受影響。）

## Step 3 — LINE：建立 Messaging API channel

1. 進 https://developers.line.biz/console/ 用你的 LINE 帳號登入。
2. 選到你官方帳號所屬的 **Provider**（沒有就新建一個）。
3. 若官方帳號尚未連到 Messaging API：在 **LINE Official Account Manager → 設定 → Messaging API** 啟用，會自動建立對應 channel。
4. 回到 developers console 開啟該 **Messaging API channel**：
   - **Basic settings** 頁 → 記下 **Channel ID**（純數字）→ 這是 `LINE_CHANNEL_ID`。
   - **Messaging API** 頁 → 最下方 **Channel access token (long-lived)** → 按 **Issue** 產生 → 這是 `LINE_CHANNEL_ACCESS_TOKEN`。

> id token 驗證使用 `LINE_CHANNEL_ID`。若之後 LIFF 用的是另一個「LINE Login channel」，請改填那個 channel 的 ID（兩者需與 LIFF 所屬 channel 一致）。

## Step 4 — 部署 Worker（booking-worker.js）

需要電腦端 Node.js。打開終端機：

```bash
npm i -g wrangler
wrangler login                       # 開瀏覽器登入 Cloudflare

# 在本資料夾執行，逐一輸入機密（執行後貼上值，Enter）
wrangler secret put FIREBASE_CLIENT_EMAIL        # 貼 Step1 的 client_email
wrangler secret put FIREBASE_PRIVATE_KEY         # 貼 Step1 的 private_key（整段，含 BEGIN/END）
wrangler secret put LINE_CHANNEL_ID              # 貼 Step3 的 Channel ID
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN    # 貼 Step3 的 access token
wrangler secret put THERAPIST_SHARED_SECRET      # 自訂一串亂碼（例如用密碼產生器產 32 字）

wrangler deploy
```

部署成功會顯示網址，例如 `https://booking-api.<你的帳號>.workers.dev`。
**記下這個網址**，下一步要填。

## Step 5 — 部署客戶端頁（booking.html）

最簡單用 **Cloudflare Pages**（免費、HTTPS）：
1. Cloudflare Dashboard → **Workers & Pages → Create → Pages → Upload assets**。
2. 上傳 `booking.html`（可連同其他檔），取得網址，例如 `https://relax-clinic.pages.dev/booking.html`。
   - 或你現有放 `index.html` 的空間（GitHub Pages 等）也可以，同網域即可。
3. 回填設定：
   - `booking.html` 第 ~165 行 `WORKER_URL` ← 改成 Step4 的 Worker 網址。
   - `wrangler.toml` 的 `ALLOWED_ORIGIN` ← 改成這個 Pages 網域（例如 `https://relax-clinic.pages.dev`），再 `wrangler deploy` 一次。

## Step 6 — 建立 LIFF app

1. developers console → 你的 channel（建議用 **LINE Login channel**；若只有 Messaging channel，在同 Provider 新增一個 LINE Login channel）→ **LIFF** 分頁 → **Add**。
2. 設定：
   - Endpoint URL：Step5 的 `https://…/booking.html`
   - Size：**Full**
   - Scopes：勾 `profile`、`openid`
3. 建立後得到 **LIFF ID**（像 `1660xxxxxx-xxxxxxxx`）。
4. 回填：`booking.html` 第 ~164 行 `LIFF_ID` ← 填這個值，重新上傳 booking.html。
5. 確認 `LINE_CHANNEL_ID`（Step3）與此 LIFF 所屬 channel 一致；若用 LINE Login channel，請把 Worker 的 `LINE_CHANNEL_ID` 改成 Login channel 的 Channel ID。

## Step 7 — 圖文選單加「線上預約」

1. **LINE Official Account Manager → 主頁 → 圖文選單**。
2. 新增一格 → 動作選 **連結** → 網址填 LIFF 網址：
   `https://liff.line.me/<你的 LIFF ID>`
3. 套用後，客戶在對話視窗點該格即可開啟預約系統。

## Step 8 — 後台 index.html 設定

`index.html` 擴充版會用到 Worker 推播。需在後台程式頂部設定：
- Worker 網址（同 Step4）
- `THERAPIST_SHARED_SECRET`（同 Step4 自訂的那串）

（這部分會在 index.html 擴充時一併標示位置。）

---

## 上線前自我檢查

- [ ] Firestore 規則已發布
- [ ] Worker 已部署、5 個 secret 都設好
- [ ] booking.html 的 `LIFF_ID`、`WORKER_URL` 已填、已上傳
- [ ] `ALLOWED_ORIGIN` 已設為 Pages 網域並重新 deploy
- [ ] LIFF Endpoint 指向 booking.html、Scopes 含 openid
- [ ] 圖文選單可開啟頁面
- [ ] 後台已設定班表（Step：班表設定）、已能為客戶建立方案

## 成本提醒
- Firebase / Cloudflare：此用量在免費額度內。
- **LINE 主動推播有每月額度**（免費方案約 200 則/月）。「完成扣次通知」「預約被拒通知」屬主動推播會計入；若每月通知量會超過，需升級 LINE 方案。行前提醒預設關閉，需要再開。
