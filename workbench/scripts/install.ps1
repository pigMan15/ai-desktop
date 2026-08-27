# install.ps1 — one-shot installer for the workbench (governance plugin + UI)
# onto a deepseek-harness installation. Idempotent: safe to re-run.
#
# What it does:
#   1. builds @workflow-platform/workbench-governance (tsc -> dist)
#   2. builds @workflow-platform/workbench-ui client bundle (esbuild -> client.js)
#   3. bootstrap.ps1: creates a self-contained local DSH_HOME
#      (.workbench-poc/dsh-home), installs both plugins into the
#      workbench-poc(-web) profiles, copies model settings + credentials from
#      the real harness home.
#   4. prints how to start the web workbench and run the headless scenarios.
#
# Usage (from the workbench directory):
#   powershell -ExecutionPolicy Bypass -File scripts/install.ps1
#
# Options:
#   -DshBin       dsh CLI path (default: "dsh" on PATH, else the npx cache shim)
#   -RealDshHome  existing harness home to copy settings/credentials from
#                 (default: $env:USERPROFILE\.dsh)
#   -SkipBuild    reuse existing built artifacts
#   -SkipWeb      skip building the client bundle (headless-only install)

param(
  [string]$DshBin = "",
  [string]$RealDshHome = "",
  [switch]$SkipBuild,
  [switch]$SkipWeb
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot            # workbench/
$LocalHome = Join-Path $RepoRoot ".workbench-poc\dsh-home"

Write-Host "===== workbench installer ====="

# --- 0. locate the dsh CLI ------------------------------------------------
if ($DshBin -eq "") {
  # prefer the .cmd shim (execution-policy safe) over .ps1
  $onPath = Get-Command dsh.cmd -ErrorAction SilentlyContinue
  if (!$onPath) { $onPath = Get-Command dsh -ErrorAction SilentlyContinue }
  if ($onPath) {
    $DshBin = $onPath.Source
  } else {
    $candidates = @(
      "$env:APPDATA\npm\dsh.cmd",
      "$env:LOCALAPPDATA\npm\dsh.cmd",
      "$env:USERPROFILE\.local\bin\dsh.cmd"
    )
    $DshBin = ($candidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
  }
}
if ($DshBin -eq "" -or !(Test-Path $DshBin)) {
  Write-Host "[install] ERROR: dsh CLI not found. Install it first, e.g.:"
  Write-Host "         npm install -g @deepseek-ai/dsh"
  Write-Host "         or pass -DshBin <path to dsh.cmd>"
  exit 1
}
Write-Host "[install] dsh CLI: $DshBin"

# --- 1. real harness home (settings + credentials source) -----------------
if ($RealDshHome -eq "") { $RealDshHome = Join-Path $env:USERPROFILE ".dsh" }
if (!(Test-Path (Join-Path $RealDshHome "settings.yaml"))) {
  Write-Host "[install] WARN: $RealDshHome has no settings.yaml — the workbench will need a"
  Write-Host "         model provider. Configure deepseek-harness first (or pass -RealDshHome)."
}
Write-Host "[install] model settings source: $RealDshHome"

# --- 2. build the governance plugin (TS -> dist) --------------------------
if (!$SkipBuild) {
  Write-Host "[install] building @workflow-platform/workbench-governance ..."
  Push-Location $RepoRoot
  try { npm.cmd --workspace @workflow-platform/workbench-governance run build | Out-Null } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "governance build failed" }
  Write-Host "[install] governance build OK"
}

# --- 3. build the client bundle (esbuild) --------------------------------
if (!$SkipWeb) {
  Write-Host "[install] building @workflow-platform/workbench-ui client bundle ..."
  Push-Location (Join-Path $RepoRoot "packages\workbench-ui")
  try { node scripts/build-client.mjs | Out-Null } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "client bundle build failed" }
  Write-Host "[install] client bundle OK"
}

# --- 4. install into the local DSH_HOME -----------------------------------
Push-Location $RepoRoot
try {
  & powershell -ExecutionPolicy Bypass -File "scripts\bootstrap.ps1" -RealDshHome $RealDshHome -DshBin $DshBin | Out-Null
} finally { Pop-Location }

# --- 5. done --------------------------------------------------------------
Write-Host ""
Write-Host "===== workbench installed ====="
Write-Host "Start the web workbench:"
Write-Host ""
Write-Host "  `$env:DSH_HOME = '$LocalHome'"
Write-Host "  `$env:WORKBENCH_STORE = '$LocalHome\..\store-web'"
Write-Host "  `$env:WORKBENCH_PROJECT = '$LocalHome\..\project-web'"
Write-Host "  `$env:WORKBENCH_UI_APPROVAL = '1'"
Write-Host "  & '$DshBin' --profile workbench-poc-web --port 3090"
Write-Host ""
Write-Host "Headless scenarios (automated governance tests):"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/demo.ps1 -Scenario pause   (etc.)"
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -SkipLlm       (engine only)"
