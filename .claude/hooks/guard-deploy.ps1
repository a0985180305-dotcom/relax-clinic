# PreToolUse hook：攔截會影響「線上系統」的指令，強制改為人工確認。
# 防禦目標：弱模型在長任務中自動 push / deploy，把幻覺中的修復直接推上生產環境。
# 就算未來有人把 git push 加回自動放行白名單，這道防線依然生效。
# 注意：本檔必須是 UTF-8 with BOM，否則 PowerShell 5.1 會把中文當 Big5 讀壞。

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# stdin 必須明確以 UTF-8 解碼：本專案路徑含中文，用預設編碼(Big5)會讀成問號→誤判
$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
$raw = $reader.ReadToEnd()
try { $data = $raw | ConvertFrom-Json } catch { exit 0 }
$cmd = $data.tool_input.command
if (-not $cmd) { exit 0 }

$patterns = @(
  'git\s+push',
  'wrangler\s+(deploy|publish|secret|delete)',
  'firebase\s+deploy',
  'gh\s+pr\s+merge',
  'git\s+reset\s+--hard',
  'git\s+checkout\s+--',
  'git\s+clean'
)

foreach ($p in $patterns) {
  if ($cmd -match $p) {
    $out = @{
      hookSpecificOutput = @{
        hookEventName            = 'PreToolUse'
        permissionDecision       = 'ask'
        permissionDecisionReason = '此指令會影響線上系統或不可逆地丟棄工作成果，依 CLAUDE.md 紅線需要使用者親自確認。'
      }
    } | ConvertTo-Json -Compress -Depth 5
    Write-Output $out
    exit 0
  }
}
exit 0
