# 01｜Harness 漏水診斷書

> 用途：記錄本環境「實測確認」的三大物理痛點與阻斷方案，供其他 harness 檔案引用。
> 診斷者：Claude Fable 5（2026-07-03），基於實際盤點與 hook 實測，非理論推演。
> 位置說明：本套 harness 位於 `.claude/harness/`（Claude Code 讀得到的目錄），入口路由在專案根目錄 `CLAUDE.md`。

## 痛點 1：工具面過大 → 工具調用崩潰（最常引發工具錯誤）

**物理現象**
- 本機掛載 100+ 個 deferred MCP 工具（Gmail／Notion／日曆／Drive／桌面控制…），與本專案 99% 無關。
- Deferred 工具「只有名字、沒有參數表」。長 context 下弱模型的典型死法：直接調用未載入的工具吃 `InputValidationError` → 腦補參數重試 → 連環報錯。每輪浪費數千 tokens，且錯誤訊息塞滿 context，加速痛點 2 的記憶迷航。

**阻斷方案**
1. 白名單紀律（CLAUDE.md 紅線 4）：本專案日常只用 Read／Edit／Write／Glob／Grep／Bash／PowerShell ＋ Chrome MCP（驗證網頁用）。
2. 調用前檢查：工具不在已載入清單 → 必須先 `ToolSearch` 用 `select:工具名` 載入 schema，才准調用。
3. 兩振出局（**工具層**）：同一工具、同一種錯誤出現第 2 次 → 停手，依 `03_rubrics.md` R1 換路徑。禁止第 3 次盲試。任務層重試上限與升降級，統一以 `02_orchestration.md`「名詞定義」為準。

**殘餘風險（誠實標註）**：連接器因使用者日常需要而保留，以上是行為守則、不是硬體隔離。違反時 context 裡的連環錯誤訊息本身就是「你正在違規」的訊號——看到就停。

## 痛點 2：巨型單檔＋整檔重讀 → 最浪費 Token、記憶迷航主因

**物理現象**
- `index.html` ≈ 87KB（單檔 App：HTML＋CSS＋JS 全在一個檔），`booking-worker.js` ≈ 21KB。
- 弱模型習慣「整檔 Read 再想」，反覆重讀把 context 撐爆 → 記憶解體 → 憑殘存印象「重寫」已上線驗證過的區段 → 這就是語意迷航亂改代碼的標準路徑。

**阻斷方案**
1. 禁整檔讀：超過 300 行的檔案，禁止不帶 offset/limit 的 Read。先 Grep 函式名或字串錨點拿行號，再 Read 錨點 ±80 行。
2. 只做局部 Edit：禁止「重寫整個檔案／整組函式」。要動的行以外一律不碰。
3. 通盤掃描外包：需要全局理解時派 Explore subagent 去讀，主對話只收結論（見 `02_orchestration.md`）。
4. 「順手整理代碼」＝重構＝必走 C 層：先寫計畫，經使用者同意才動工。

## 痛點 3：本機≠線上＋沙箱 overlay → 假性完成溫床（最容易失焦）

**物理現象（全部實測證實）**
- Shell 的「安裝／全域寫入」不會落到使用者真機（`npm i -g` 假成功）。
- 部署動作（wrangler、Firebase Console、LINE Console）只有使用者本人能執行。
- 弱模型看到指令輸出「成功」就回報「已部署上線」，實際線上絲毫未變 → 之後的 session 基於幻覺狀態除錯，整段工作報廢。

**阻斷方案（已生效）**
1. `verify-write.ps1` hook：每次 Write/Edit 後自動驗證檔案落地＋JS 語法。hook 報錯＝沒完成。
2. `guard-deploy.ps1` hook：`git push`／`wrangler deploy` 等指令強制跳人工確認。
3. 查證線上狀態的唯一合法方法（不准憑記憶）：① GitHub Pages 頁面 → WebFetch 打 `https://a0985180305-dotcom.github.io/relax-clinic/`（此網域已在權限白名單）；② Worker 端點 → Bash `curl https://booking-api.a0985180305.workers.dev/`（**會跳權限確認框，這是正常防線、不是工具壞掉**，等使用者按同意即可）；③ 只有需要「登入後的畫面」才用 Chrome MCP。
4. 回報措辭鐵則：只能說「檔案已改好＋部署指令已備好，請使用者執行」，永遠不能說「已部署」。
5. 改檔一律用 Edit/Write 工具，禁止用 shell 重導向（`>`、`Out-File`、`Set-Content`）寫專案檔——那會繞過 verify hook，且在沙箱下不保證落地。

## ⚖️ 本套 Harness 的能力極限（誠實條款）

1. **Hooks 只攔得住列舉過的指令。** 未列入的危險指令不會被攔。發現漏網之魚 → 依 `05_maintenance.md` 流程補進 guard-deploy.ps1（黃區，需使用者同意）。
2. **CLAUDE.md 與本檔是機率性防禦**：弱模型可能讀了不遵守。hooks 是唯一硬防線，其餘靠檢核表＋隔離驗證逼近。
3. **品味與商業決策是弱模型的天花板**：UI 美感、對客戶的文案語氣、方案定價、品牌措辭——拆解與隔離驗證都救不了這類問題。標準應對：**產出 2–3 個具體選項（能附截圖就附），交使用者選，禁止自行拍板**。詳見 `03_rubrics.md` R4。
4. **不確定就查，查不到就標註**：用 WebSearch／WebFetch 查官方文件；查不到的寫明「未查證」，禁止編造 API 形狀、LINE 政策、Firebase 行為。
