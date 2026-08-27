# bootstrap.ps1 — set up a self-contained local DSH_HOME for the workbench.
#
# What it does:
#   1. Creates <workbench>/.workbench-poc/dsh-home as a LOCAL DSH_HOME
#      (never touches the real ~/.dsh), so the workbench is fully
#      self-contained and deletable.
#   2. Copies settings.yaml and .credentials.yaml from the real home so the
#      profile can use the same agent-default-model and provider credentials.
#      NOTE: the credentials copy is gitignored (.workbench-poc/); delete it
#      when the workbench is retired.
#   3. Installs the governance plugin + browser UI into the profile
#      node_modules (the profile bundle loader resolves them from there;
#      @deepseek-ai/* imports resolve through the auto-healed
#      profiles/node_modules fallback).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
#         (optionally: -RealDshHome <path> -DshBin <path>)

param(
  [string]$RealDshHome = "C:\Users\15330\.dsh",
  [string]$DshBin = "dsh.cmd"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot          # workbench/
$LocalHome = Join-Path $RepoRoot ".workbench-poc\dsh-home"
$ProfilesDir = Join-Path $LocalHome "profiles"
$StoreDir = Join-Path $RepoRoot ".workbench-poc\store"

Write-Host "[bootstrap] local DSH_HOME: $LocalHome"

# --- 1. skeleton ---------------------------------------------------------
foreach ($dir in @($LocalHome, $ProfilesDir, $StoreDir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

# --- 2. settings + credentials ------------------------------------------
foreach ($file in @("settings.yaml", ".credentials.yaml")) {
  $src = Join-Path $RealDshHome $file
  if (!(Test-Path $src)) { throw "missing $src — cannot bootstrap without the real home's $file" }
  Copy-Item $src (Join-Path $LocalHome $file) -Force
  Write-Host "[bootstrap] copied $file"
}

# --- 3. profiles (headless + web) ---------------------------------------
foreach ($profile in @("workbench-poc", "workbench-poc-web")) {
  $profileDir = Join-Path $ProfilesDir $profile
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  $tpl = Join-Path $RepoRoot ($(if ($profile -eq "workbench-poc") { "profile" } else { "profile-web" }))
  Copy-Item (Join-Path $tpl "package.json")    (Join-Path $profileDir "package.json")    -Force
  Copy-Item (Join-Path $tpl "cordis.patch.yml") (Join-Path $profileDir "cordis.patch.yml") -Force

  # --- 4. plugin into profile node_modules ------------------------------
  # Built to packages/workbench-governance/dist by
  # `npm --workspace @workflow-platform/workbench-governance run build`.
  $pluginSource = Join-Path $RepoRoot "packages\workbench-governance\dist"
  if (!(Test-Path (Join-Path $pluginSource "index.js"))) {
    throw "packages/workbench-governance/dist missing — run: npm.cmd --workspace @workflow-platform/workbench-governance run build"
  }
  $pluginTarget = Join-Path $profileDir "node_modules\@workflow-platform\workbench-governance"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $pluginTarget) | Out-Null
  if (Test-Path $pluginTarget) { Remove-Item $pluginTarget -Recurse -Force }
  Copy-Item $pluginSource $pluginTarget -Recurse -Force
  # Write an explicit package.json so the loader resolves the entry without
  # relying on Node's directory->index.js fallback.
  [System.IO.File]::WriteAllText(
    (Join-Path $pluginTarget "package.json"),
    '{"name":"@workflow-platform/workbench-governance","private":true,"type":"module","main":"index.js","exports":{".":{"default":"./index.js"},"./store":{"default":"./store.js"},"./package.json":"./package.json"}}',
    (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "[bootstrap] installed plugin -> $pluginTarget"

  # --- 4b. workbench browser UI (web profile only) ----------------------
  if ($profile -eq "workbench-poc-web") {
    $uiSource = Join-Path $RepoRoot "packages\workbench-ui"
    $uiTarget = Join-Path $profileDir "node_modules\@workflow-platform\workbench-ui"
    New-Item -ItemType Directory -Force -Path $uiTarget | Out-Null
    Copy-Item (Join-Path $uiSource "package.json") (Join-Path $uiTarget "package.json") -Force
    Copy-Item (Join-Path $uiSource "index.js") (Join-Path $uiTarget "index.js") -Force
    Copy-Item (Join-Path $uiSource "client.js") (Join-Path $uiTarget "client.js") -Force
    Write-Host "[bootstrap] installed workbench-ui -> $uiTarget"
  }
}

# --- 5. verify the composed tree (no LLM, no boot) -----------------------
Write-Host "[bootstrap] verifying composition with --dump-config ..."
$env:DSH_HOME = $LocalHome
& $DshBin --profile workbench-poc --dump-config 2>&1 | Select-String -Pattern "governance-poc|workbench" | Select-Object -First 10
if ($LASTEXITCODE -ne 0) {
  Write-Host "[bootstrap] WARN: --dump-config exited $LASTEXITCODE (see output above)"
}
Write-Host "[bootstrap] done. Run: powershell -ExecutionPolicy Bypass -File scripts/demo.ps1 -Scenario pause"
