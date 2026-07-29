$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$output = Join-Path $root "release-full"
$zipPath = Join-Path $output "AI Workflow Platform 0.1.0-win-unpacked.zip"
$configuredBuilderMirror = -not [string]::IsNullOrWhiteSpace($env:ELECTRON_BUILDER_BINARIES_MIRROR)
if (-not $configuredBuilderMirror) {
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://mirrors.huaweicloud.com/electron-builder-binaries/"
}

Push-Location $root
try {
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    throw "Renderer/Desktop build failed with exit code $LASTEXITCODE."
  }
  npm.cmd run build:runtime:exe
  if ($LASTEXITCODE -ne 0) {
    throw "Runtime build failed with exit code $LASTEXITCODE."
  }

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
  if ($LASTEXITCODE -ne 0) {
    throw "Electron unpacked package failed with exit code $LASTEXITCODE."
  }

  $unpacked = Join-Path $output "win-unpacked"
  $desktopExe = Join-Path $unpacked "AI Workflow Platform.exe"
  $runtimeExe = Join-Path $unpacked "resources\runtime\workflow-runtime.exe"
  if (-not (Test-Path -LiteralPath $desktopExe)) {
    throw "Packaged desktop executable was not found: $desktopExe"
  }
  if (-not (Test-Path -LiteralPath $runtimeExe)) {
    throw "Bundled Runtime executable was not found: $runtimeExe"
  }

  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  Compress-Archive -LiteralPath $unpacked -DestinationPath $zipPath -Force
  Write-Host "完整免安装包已生成：$zipPath"

  npm.cmd --workspace "@workflow-platform/desktop" run package:win
  if ($LASTEXITCODE -ne 0) {
    throw "NSIS installer build failed after the verified unpacked package was generated."
  }

  $installer = Get-ChildItem -LiteralPath $output -File -Filter "*.exe" |
    Where-Object { $_.FullName -ne $desktopExe } |
    Select-Object -First 1
  if ($null -eq $installer) {
    throw "NSIS installer executable was not found in: $output"
  }
  Write-Host "NSIS 安装器已生成：$($installer.FullName)"
} finally {
  Remove-Item Env:\PACKAGE_OUTPUT_DIR -ErrorAction SilentlyContinue
  if (-not $configuredBuilderMirror) {
    Remove-Item Env:\ELECTRON_BUILDER_BINARIES_MIRROR -ErrorAction SilentlyContinue
  }
  Pop-Location
}
