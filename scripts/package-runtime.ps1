$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$runtimeRoot = Join-Path $root "runtime"
$entry = Join-Path $runtimeRoot "src\workflow_platform\packaged_runtime.py"

Push-Location $runtimeRoot
try {
  python -m PyInstaller --version | Out-Null
  python -m PyInstaller `
    --noconfirm `
    --clean `
    --name workflow-runtime `
    --collect-submodules workflow_platform `
    --collect-data workflow_platform `
    --paths src `
    $entry
} catch {
  Write-Error "Runtime 打包失败。请先运行：python -m pip install pyinstaller"
  throw
} finally {
  Pop-Location
}
