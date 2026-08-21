$ErrorActionPreference = "Stop"
$Host.UI.RawUI.WindowTitle = "FramePrompt 本地视频提示词助手"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectDirectory

Clear-Host
Write-Host "========================================" -ForegroundColor DarkCyan
Write-Host "  FramePrompt 本地视频提示词助手" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor DarkCyan
Write-Host "启动后会自动打开浏览器。关闭时在本窗口按 Ctrl+C。" -ForegroundColor Gray
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "未找到 Node.js，请先安装 Node.js 22 或更高版本。" -ForegroundColor Red
  Read-Host "按回车退出"
  exit 1
}

if (-not (Test-Path -LiteralPath "node_modules")) {
  Write-Host "首次运行，正在安装依赖…" -ForegroundColor Cyan
  npm install
}

$logDirectory = Join-Path $projectDirectory "work"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$bridgeOut = Join-Path $logDirectory "codex-bridge.log"
$bridgeError = Join-Path $logDirectory "codex-bridge-error.log"

Write-Host "正在启动 Codex 本地分析服务…" -ForegroundColor Cyan
$bridgeProcess = Start-Process -FilePath "node.exe" -ArgumentList "local-codex-server.mjs" -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput $bridgeOut -RedirectStandardError $bridgeError -PassThru

try {
  $ready = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:3210/health" -TimeoutSec 1
      if ($health.ok) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) {
    $details = if (Test-Path $bridgeError) { Get-Content -Raw $bridgeError } else { "未知错误" }
    throw "Codex 本地服务启动失败：$details"
  }

  Write-Host "Codex 已就绪。网页关闭不等于服务关闭；在此窗口按 Ctrl+C 可同时关闭全部服务。" -ForegroundColor Green
  npm run dev -- --port 3010
} finally {
  if ($bridgeProcess -and -not $bridgeProcess.HasExited) {
    Stop-Process -Id $bridgeProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
