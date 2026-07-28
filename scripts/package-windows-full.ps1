$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$output = Join-Path $root "release-full"
$zipPath = Join-Path $output "AI Workflow Platform 0.1.0-win-unpacked.zip"

Push-Location $root
try {
  npm.cmd run build
  npm.cmd run build:runtime:exe

  if (Test-Path -LiteralPath $output) {
    try {
      Remove-Item -LiteralPath $output -Recurse -Force -ErrorAction Stop
    } catch {
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $output = Join-Path $root "release-full-$stamp"
      $zipPath = Join-Path $output "AI Workflow Platform 0.1.0-win-unpacked.zip"
    }
  }

  $env:PACKAGE_OUTPUT_DIR = $output
  npm.cmd --workspace "@workflow-platform/desktop" run package:win:dir

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -LiteralPath (Join-Path $output "win-unpacked") -DestinationPath $zipPath -Force
  Write-Host "完整免安装包已生成：$zipPath"
} finally {
  Remove-Item Env:\PACKAGE_OUTPUT_DIR -ErrorAction SilentlyContinue
  Pop-Location
}
