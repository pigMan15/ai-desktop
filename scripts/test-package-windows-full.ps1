$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$scriptPath = Join-Path $root "scripts\package-windows-full.ps1"
$content = Get-Content -LiteralPath $scriptPath -Raw

$firstInstallerCheck = $content.IndexOf('if ($null -eq $installer)')
$installerAssignment = $content.IndexOf('$installer = Get-ChildItem')

if ($firstInstallerCheck -lt 0) {
  throw "The Windows packaging script must verify the NSIS installer output."
}
if ($installerAssignment -lt 0) {
  throw "The Windows packaging script must discover the NSIS installer output."
}
if ($firstInstallerCheck -lt $installerAssignment) {
  throw "The Windows packaging script checks `$installer before it discovers the NSIS installer."
}

if ($content -notmatch '\$env:ELECTRON_BUILDER_BINARIES_MIRROR') {
  throw "The Windows packaging script must configure an electron-builder binary mirror when none is supplied."
}
if ($content -notmatch 'mirrors\.huaweicloud\.com/electron-builder-binaries') {
  throw "The Windows packaging script must use the approved HTTPS electron-builder binary mirror."
}
