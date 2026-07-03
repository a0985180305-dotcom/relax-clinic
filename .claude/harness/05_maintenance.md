# 05｜知識迭代與反思協議（Harness 的自我更新規則）

> 用途：定義未來的模型如何「安全地」更新這套 harness，防止制度被無聲改壞，也防止制度膨脹到沒人讀。

## 分權表：什麼可以自己改，什麼必須先問使用者

| 區域 | 內容 | 權限 |
|---|---|---|
| 🟢 綠區（可自行更新，改完必 commit） | 本檔「踩坑紀錄」區新增條目；`04_templates.md` **新增**模板或欄位；`03_rubrics.md` **新增**正反例；`01_diagnostics.md` 補充新實測現象 | 模型自主，但改前先 commit 還原點、改後 read-back 確認 |
| 🟡 黃區（必須先取得使用者當回合同意） | `CLAUDE.md` 任何修改；兩支 hooks（guard-deploy.ps1／verify-write.ps1）；`02_orchestration.md` 升降級規則；`.claude/settings*.json` 權限；**刪除或放寬**任何既有規則、紅線、禁令 | 提案→使用者說好→才動手 |
| 🔴 紅區（永遠禁止） | 刪除 hooks、刪除 harness 檔案、把 `git push` 加回自動放行、關閉落檔驗證 | 使用者親自操作才算數 |

判斷原則：**「加一條教訓」是綠區，「改變制度怎麼運作」是黃區，「讓制度失效」是紅區。** 拿不準就當黃區。

## 修改程序（綠區黃區通用）

1. `git commit` 現狀（還原點）
2. 修改（只用 Edit/Write 工具）
3. Read-back：重新讀取改過的段落，確認無截斷、無亂碼
4. `git commit` 新版，訊息寫明「改了哪條規則、為什麼」

## 踩坑紀錄的寫入格式（固定三段式，每則 ≤10 行）

```
### 〔日期〕〔一句話標題〕
- Context：什麼情境下發生
- Error：錯誤現象原文（關鍵行，非全文）
- Solution：怎麼解的＋防再犯的規則一句話
```

## 精簡觸發條件（防制度膨脹腐化）

- 觸發點：本檔「踩坑紀錄」超過 **150 行**（約 5000 tokens），或 CLAUDE.md 超過 **120 行**。
- 動作（屬綠區）：把同類個案**合併抽象成一條原則**，刪除個案細節（git 歷史裡都還在，不會真的遺失）；抽象後的原則若屬通用禁令，提案（黃區）併入 `01_diagnostics.md`。
- 精簡的驗收：精簡後任何一條原則，都要能回答「它防的是哪類坑」；答不出來的條目就是廢話，刪。

---

## 踩坑紀錄

### 2026-07-03 PowerShell 5.1 吃掉無 BOM 的中文 .ps1
- Context：建立 hook 腳本後首次實測
- Error：`The string is missing the terminator`——中文註解被當 Big5 解碼，整支腳本語法爆炸
- Solution：所有 `.ps1` 一律存成 UTF-8 **with BOM**（用 `[IO.File]::WriteAllText($p,$c,[Text.UTF8Encoding]::new($true))` 轉）。規則：新增/修改 .ps1 後必須重測一次。

### 2026-07-03 中文專案路徑讓 hook stdin 讀成問號
- Context：verify-write hook 收到含「經絡調理客戶紀錄表」的檔案路徑
- Error：路徑變 `?????????` → Test-Path 失敗 → 每次改檔都誤報「假性完成」
- Solution：hook 讀 stdin 改用 `StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)` 明確以 UTF-8 解碼，不用 `[Console]::In`。

### 2026-07-03 PS 5.1 把 node 的 stderr 包成 NativeCommandError 噪音
- Context：hook 內跑 `node --check file 2>&1`
- Error：正常的語法錯誤輸出被包上 PowerShell ErrorRecord 外衣，訊息難讀
- Solution：改成 `cmd /c "node --check `"$f`" 2>&1"` 讓 cmd 處理重導向。另：booking-worker.js 是 ESM，`node --check` 前要先複製成 `.mjs`。
