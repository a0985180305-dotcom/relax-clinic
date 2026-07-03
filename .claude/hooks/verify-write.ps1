# PostToolUse hook：Write/Edit 之後自動驗證「檔案真的落地」＋ JS 語法檢查。
# 防禦目標：假性完成——模型回報「已寫入」但檔案根本不存在，或寫出語法壞掉的 JS。
# exit 2 = 把 stderr 訊息塞回給模型，強迫它先修好才能繼續。
# 注意：本檔必須是 UTF-8 with BOM，否則 PowerShell 5.1 會把中文當 Big5 讀壞。

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# stdin 必須明確以 UTF-8 解碼：本專案路徑含中文，用預設編碼(Big5)會讀成問號→誤報
$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$raw = $reader.ReadToEnd()
try { $data = $raw | ConvertFrom-Json } catch { exit 0 }
$file = $data.tool_input.file_path
if (-not $file) { exit 0 }

# 第一關：檔案必須真的存在
if (-not (Test-Path -LiteralPath $file)) {
  [Console]::Error.WriteLine("[HOOK fake-completion] $file was NOT actually written to disk. Do not report done; rewrite with the Write/Edit tool and confirm success.")
  exit 2
}

# 第二關：JS 檔跑語法檢查（本專案 JS 是 ES module，需複製成 .mjs 檢查）
if ($file -match '\.(js|mjs)$') {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    $env:Path += ';C:\Program Files\nodejs'
  }
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $tmp = Join-Path $env:TEMP ('hook_check_' + [IO.Path]::GetFileNameWithoutExtension($file) + '.mjs')
    Copy-Item -LiteralPath $file -Destination $tmp -Force
    # 用 cmd /c 執行避免 PowerShell 5.1 把 node 的 stderr 包成 NativeCommandError 噪音
    $result = cmd /c "node --check `"$tmp`" 2>&1"
    $code = $LASTEXITCODE
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) {
      $msg = ($result | Out-String).Trim()
      [Console]::Error.WriteLine("[HOOK syntax-check FAILED] $file has a syntax error. Fix it before reporting done:`n$msg")
      exit 2
    }
  }
}
exit 0
