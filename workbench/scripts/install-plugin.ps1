# install-plugin.ps1 — install the workbench as DSH PLUGINS (tarball method)
# into a profile, then wire the two packages into dsh.profile.bundles so they
# auto-mount (bundle form, no manual patch edits).
#
# Prerequisites:
#   - the tarballs exist (run `npm run pack:plugins` from the workbench root)
#   - the target profile exists (boot it once, e.g. `dsh --profile web --port 3090`)
#   - npm available (used with --legacy-peer-deps to avoid duplicate
#     @deepseek-ai instances inside the profile)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/install-plugin.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install-plugin.ps1 -Profile web -Port 3090

param(
  [string]$Profile = "web",
  [int]$Port = 3090,
  [string]$DshHome = "",
  [string]$TarballsDir = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot                 # workbench/
if ($TarballsDir -eq "") { $TarballsDir = Join-Path $RepoRoot "release-plugin" }
if ($DshHome -eq "") { $DshHome = Join-Path $env:USERPROFILE ".dsh" }

$governanceTgz = Get-ChildItem (Join-Path $TarballsDir "workflow-platform-workbench-governance-*.tgz") | Select-Object -First 1
$uiTgz = Get-ChildItem (Join-Path $TarballsDir "workflow-platform-workbench-ui-*.tgz") | Select-Object -First 1
if (!$governanceTgz -or !$uiTgz) {
  Write-Host "[plugin] ERROR: tarballs not found in $TarballsDir — run: npm run pack:plugins"
  exit 1
}

$profileDir = Join-Path $DshHome "profiles\$Profile"
if (!(Test-Path (Join-Path $profileDir "package.json"))) {
  Write-Host "[plugin] ERROR: profile '$Profile' not found at $profileDir"
  Write-Host "         boot it once first, e.g.: dsh --profile $Profile --port $Port"
  exit 1
}
Write-Host "[plugin] profile: $profileDir"

# --- 1. install both tarballs into the profile ----------------------------
# NOTE: must be ONE npm install command — npm treats --no-save packages as
# transient, so a second --no-save install would prune the first one.
Push-Location $profileDir
try {
  npm.cmd install $governanceTgz.FullName $uiTgz.FullName --no-save --legacy-peer-deps | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "tarball install failed" }
} finally { Pop-Location }
Write-Host "[plugin] tarballs installed into the profile"

# --- 2. wire the packages into dsh.profile.bundles ------------------------
$manifestPath = Join-Path $profileDir "package.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
if (!$manifest.dsh) { $manifest | Add-Member -NotePropertyName dsh -NotePropertyValue ([PSCustomObject]@{}) }
if (!$manifest.dsh.profile) { $manifest.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([PSCustomObject]@{}) }
$bundles = @($manifest.dsh.profile.bundles)
foreach ($pkg in @("@workflow-platform/workbench-governance", "@workflow-platform/workbench-ui")) {
  if ($bundles -notcontains $pkg) { $bundles += $pkg }
}
$manifest.dsh.profile.bundles = $bundles
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), $utf8NoBom)
Write-Host "[plugin] bundles now: $($bundles -join ', ')"

# --- 3. done --------------------------------------------------------------
Write-Host ""
Write-Host "===== workbench installed as plugins into profile '$Profile' ====="
Write-Host "Start the web workbench:"
Write-Host ""
Write-Host "  `$env:DSH_HOME = '$DshHome'"
Write-Host "  `$env:WORKBENCH_STORE = '$RepoRoot\.workbench-poc\store-web'"
Write-Host "  `$env:WORKBENCH_PROJECT = '$RepoRoot\.workbench-poc\project-web'"
Write-Host "  `$env:WORKBENCH_UI_APPROVAL = '1'"
Write-Host "  dsh --profile $Profile --port $Port"
