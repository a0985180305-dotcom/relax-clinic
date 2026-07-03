# 經絡調理診所｜LINE 預約 + 方案點數系統

一律用繁體中文、白話回應。使用者是診所調理師，**非工程背景**：一步步帶、每步說清楚要點哪裡、先講結論再講細節。

## 系統全貌（30 秒版）

雙調理師（鈞 glan／萱 xuan）的診所系統，Firebase 專案 `relax-clinic`：
- **後台**（index.html）：調理師登入管理客戶紀錄、方案、班表、預約
- **客戶端**（booking.html）：客戶從 LINE 打開的預約頁（LIFF）
- **API 閘道**（booking-worker.js）：Cloudflare Worker，客戶端只跟它對話，它驗 LINE 身分後代讀寫 Firestore，病歷不出後台

## ⚠️ 事實來源對照表（改任何檔之前必讀）

**本機檔案 ≠ 線上狀態。** 每個檔案對應一個正在服務真實客戶的線上系統：

| 本機檔案 | 對應線上系統 | 如何上線 | 誰能執行上線 |
|---|---|---|---|
| index.html | 後台 https://a0985180305-dotcom.github.io/relax-clinic/ | `git push`（推上去**立即生效**） | 使用者當回合確認後 |
| booking.html | 客戶端 https://a0985180305-dotcom.github.io/relax-clinic/booking.html | `git push`（同上） | 使用者當回合確認後 |
| booking-worker.js | Worker https://booking-api.a0985180305.workers.dev | 使用者親手在自己的 PowerShell 跑 `wrangler deploy` | **只有使用者** |
| wrangler.toml | Worker 設定 | 隨 wrangler deploy | **只有使用者** |
| firestore.rules | Firebase Console 的安全規則 | 使用者手動貼進 Console 按發布 | **只有使用者** |
| SETUP.md | （純文件，無線上對應） | — | — |

## 🚫 紅線（違反任何一條 = 任務失敗）

1. **未經使用者「本回合明確說好」，不得執行 `git push`、`wrangler deploy`，不得改 Firestore rules 或 LINE 設定。** push 一次等於直接改到客戶正在用的網頁。
2. **永遠不得回報「已部署」「已上線」。** 你沒有部署能力：wrangler、Firebase Console、LINE Console 都只能由使用者親手操作。你的職責是把指令或步驟準備成「複製貼上就能用」交給使用者。
3. **修改任何已上線驗證過的檔案之前，先 `git add` + `git commit` 建還原點。** 本機 commit 不會影響線上，放心做。
4. 本專案任務**不得呼叫** Gmail、Google 日曆、Google Drive、Notion、computer-use 等 MCP 工具，除非使用者當回合明白要求。
5. **客戶病歷與個資不得**貼進 log、外部服務、或提交進 git（本 repo 是公開的）。
6. 程式碼中不得出現任何密鑰。機密只存在兩處：Cloudflare Worker secrets、Firestore `config/app` 的 pushSecret。

## ⚠️ 本機環境陷阱（已實證，不是猜測）

- **沙箱 overlay**：你的 shell 跑在與使用者真機分離的空間。「安裝」（如 `npm i -g`）看似成功但**不會落到使用者真機**。所以部署類操作一律準備成指令清單讓使用者自己貼。
- Node 在 `C:\Program Files\nodejs`，但 PATH 可能沒刷新，先跑 `$env:Path += ';C:\Program Files\nodejs'`。
- booking-worker.js 是 ES module，`node --check` 直接檢查會誤報；要先複製成 `.mjs` 再檢查（hooks 已自動處理）。
- 專案的 Write/Edit 會真的落檔，且 hooks 會自動驗證；shell 的重導向寫檔（`>`、`Out-File`）不保證，**改檔一律用 Edit/Write 工具**。

## 工具紀律（防連環錯誤）

- 同一個工具**連續失敗 2 次就必須停**：換方法、或直接把錯誤白話說明給使用者，禁止盲目重試第 3 次。
- 本專案日常只需要：Read / Edit / Write / Glob / Grep / Bash / PowerShell，加上 Chrome MCP（驗證線上網頁用）。
- 長任務進行中若對架構沒把握：**重讀本檔與 SETUP.md**，不要憑記憶改碼。已上線測通的功能（見 git log）不要「順手重構」。

## ✅ 完工回報協議（沒有證據 = 沒有完成）

回報「完成」前必須通過對應層級，禁止說「應該可以了」：

- **B 層（自動，永遠生效）**：hooks 會驗證檔案真的落地、JS 語法通過。hook 報錯就是沒完成，先修好。
- **A 層（影響線上行為的改動必做）**：回報時必附「使用者驗證 3 步驟」——用手機或瀏覽器就能操作的白話清單，例如「1. 手機打開預約頁 2. 點鈞的班表 3. 應該看到○○」。
- **C 層（大改動必做）**：新功能、架構調整、動到 booking-worker.js 核心邏輯——先寫計畫（要改哪些檔、為什麼、怎麼驗證），等使用者確認後才動工。

## 關鍵常數（皆非機密，密鑰不在此）

- Firebase 專案：`relax-clinic`
- Worker URL：`https://booking-api.a0985180305.workers.dev`
- LIFF ID：`2010520705-60EHkpbz`（入口 https://liff.line.me/2010520705-60EHkpbz）
- LINE Login channel（LIFF 所屬、id token 的 aud）：`2010520705`
- LINE Messaging channel（推播用）：`2010520076`，官方帳號 @741cforc「神庭&神藏｜361經絡調理」
- 業務規則：買10送2 效期1月／買20送6 效期1.5月／買30送10 效期2月；調理**完成才扣點**；預約送出即成立但調理師可拒絕
