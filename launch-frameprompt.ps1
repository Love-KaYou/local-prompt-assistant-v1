$ErrorActionPreference = "SilentlyContinue"
$Host.UI.RawUI.WindowTitle = "FramePrompt 启动器"
$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$appUrl = "http://localhost:3010/"

try {
  $existing = Invoke-WebRequest -Uri $appUrl -UseBasicParsing -TimeoutSec 2
  if ($existing.StatusCode -eq 200) {
    Start-Process $appUrl
    exit 0
  }
} catch {}

$startScript = Join-Path $projectDirectory "start-local.ps1"
Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoExit",
  "-NoLogo",
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", "`"$startScript`""
) -WorkingDirectory $projectDirectory

for ($attempt = 0; $attempt -lt 120; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $response = Invoke-WebRequest -Uri $appUrl -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -eq 200) {
      Start-Process $appUrl
      exit 0
    }
  } catch {}
}

Add-Type -AssemblyName PresentationFramework
[System.Windows.MessageBox]::Show("FramePrompt 启动超时，请查看 PowerShell 窗口中的错误信息。", "FramePrompt") | Out-Null
