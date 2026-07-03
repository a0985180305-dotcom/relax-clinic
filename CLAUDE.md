# 經絡調理診所｜LINE 預約 + 方案點數系統

一律用繁體中文白話回應。使用者是調理師、**非工程背景**：先講結論、一步步帶、每步說清楚要點哪裡。

## 系統全貌（30 秒）

雙調理師（鈞 glan／萱 xuan），Firebase 專案 `relax-clinic`：
- `index.html` ＝ 後台（客戶紀錄／方案／班表／預約管理），調理師登入用
- `booking.html` ＝ 客戶端 LINE 預約頁（LIFF）
- `booking-worker.js` ＝ Cloudflare Worker API 閘道：客戶端只跟它對話，它驗 LINE 身分後代讀寫 Firestore，病歷不出後台

## ⚠️ 事實來源對照表（改任何檔之前必讀）

**本機檔案 ≠ 線上狀態。** 每個檔案對應一個正在服務真實客戶的線上系統：

| 本機檔案 | 對應線上系統 | 如何上線 | 誰能執行上線 |
|---|---|---|---|
| index.html | 後台 https://a0985180305-dotcom.github.io/relax-clinic/ | `git push`（**推上去立即生效**） | 使用者當回合確認後 |
| booking.html | 客戶端 …/relax-clinic/booking.html | `git push`（同上） | 使用者當回合確認後 |
| booking-worker.js | Worker https://booking-api.a0985180305.workers.dev | 使用者親手 `wrangler deploy` | **只有使用者** |
| wrangler.toml | Worker 設定 | 隨 wrangler deploy | **只有使用者** |
| firestore.rules | Firebase Console 安全規則 | 使用者手動貼進 Console 發布 | **只有使用者** |

## 🚫 紅線（違反任何一條＝任務失敗）

1. 未經使用者「本回合明確說好」，不得 `git push`、`wrangler deploy`，不得改 Firestore rules 或 LINE 設定。
2. 永遠不得回報「已部署／已上線」。你沒有部署能力；你的職責是把指令準備成複製貼上交給使用者。
3. 修改任何已上線驗證過的檔案之前，先 `git add`＋`git commit` 建還原點（本機 commit 不影響線上，放心做）。
4. 不得呼叫 Gmail／Google 日曆／Drive／Notion／computer-use 等 MCP，除非使用者當回合明白要求。
5. 客戶病歷與個資不得貼進 log、外部服務、或提交進 git（本 repo 是**公開的**）。
6. 程式碼中不得出現任何密鑰。機密只在：Cloudflare Worker secrets、Firestore `config/app` 的 pushSecret。
7. 不得刪除、繞過或弱化 `.claude/` 下的 hooks 與本 harness；修改規則見 `05_maintenance.md` 的分權表。

## 🧭 開工導航（按情境讀對應檔，不必全讀）

| 情境 | 必讀 |
|---|---|
| 動手寫碼前（一律） | `.claude/harness/01_diagnostics.md` — 三大痛點與禁令 |
| 要派 subagent／卡關要升級 | `.claude/harness/02_orchestration.md` |
| 判斷「該停手？算完成？該問人？」 | `.claude/harness/03_rubrics.md` |
| 派工直接照抄模板 | `.claude/harness/04_templates.md` |
| 想改 harness 本身／踩到新坑要記錄 | `.claude/harness/05_maintenance.md` |
| 新 session 接手、不知從何開始 | `.claude/harness/06_manifesto.md`，再看專案根目錄的 `SETUP.md` |

## ⚠️ 環境陷阱（實證，詳見 01_diagnostics）

- 沙箱 overlay：shell 安裝／全域寫入**不落使用者真機**；部署一律備妥指令由使用者執行。
- 改專案檔只用 Edit/Write 工具（hooks 會驗證落地）；禁止 shell 重導向寫檔。
- Node 在 `C:\Program Files\nodejs`，PATH 沒刷新時先 `$env:Path += ';C:\Program Files\nodejs'`。
- `.ps1` 檔必須 UTF-8 with BOM；本專案路徑含中文，編碼相關操作見 `05_maintenance.md` 踩坑紀錄。

## ✅ 完工三層驗收（詳細判準：03_rubrics R2）

- **B 自動**：hooks 驗落檔＋JS 語法，報錯＝沒完成。
- **A 必做**：影響線上行為的改動，回報必附「使用者 3 步驗證清單」（手機／瀏覽器可操作）。
- **C 大改**：新功能／架構調整／動 Worker 核心邏輯 → 先寫計畫，使用者同意才動工。

## 關鍵常數（皆非機密）

- Firebase 專案：`relax-clinic`
- Worker URL：`https://booking-api.a0985180305.workers.dev`
- LIFF ID：`2010520705-60EHkpbz`（入口 https://liff.line.me/2010520705-60EHkpbz）
- LINE Login channel（LIFF 所屬、id token 的 aud）：`2010520705`
- LINE Messaging channel（推播用）：`2010520076`，官方帳號 @741cforc「神庭&神藏｜361經絡調理」
- 業務規則：買10送2 效期1月／買20送6 效期1.5月／買30送10 效期2月；**調理完成才扣點**；預約送出即成立但調理師可拒絕
