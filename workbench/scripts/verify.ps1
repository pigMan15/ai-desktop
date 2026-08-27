# verify.ps1 — local CI for the DSH workbench governance plugin.
# Chains: TS build -> bootstrap (install into local DSH_HOME) -> deterministic
# engine test -> all LLM demo scenarios (pause / approve / reject / missing /
# template / template-io / template-file / evidence / inbox).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/verify.ps1            # everything
#   powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -SkipLlm   # engine only (fast, no LLM)
#   powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -SkipBuild # reuse existing dist

param(
  [switch]$SkipBuild,
  [switch]$SkipLlm,
  [string]$RealDshHome = "C:\Users\15330\.dsh",
  [string]$DshBin = "dsh.cmd"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot   # workbench/

$failed = $false
function Step([string]$name, [scriptblock]$body) {
  Write-Host ""
  Write-Host "===== $name ====="
  try {
    & $body
    Write-Host "[verify] ok: $name"
  } catch {
    Write-Host "[verify] FAIL: $name — $($_.Exception.Message)"
    $script:failed = $true
  }
}

Step "build workbench-governance (TS)" {
  if ($SkipBuild) { Write-Host "(skipped by -SkipBuild)"; return }
  Push-Location $RepoRoot
  try { npm.cmd --workspace @workflow-platform/workbench-governance run build | Out-Null } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "tsc build failed (exit $LASTEXITCODE)" }
}

Step "bootstrap local DSH_HOME" {
  Push-Location $RepoRoot
  try { & powershell -ExecutionPolicy Bypass -File "scripts\bootstrap.ps1" -RealDshHome $RealDshHome | Out-Null } finally { Pop-Location }
}

Step "deterministic engine test (no LLM)" {
  Push-Location $RepoRoot
  try { node "scripts\store-test.mjs" | Out-Null } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { throw "store test failed (exit $LASTEXITCODE)" }
}

if (!$SkipLlm) {
  foreach ($scenario in @("pause", "approve", "reject", "missing", "template", "template-io", "template-file", "evidence", "inbox")) {
    Step "LLM scenario: $scenario" {
      Push-Location $RepoRoot
      try { & powershell -ExecutionPolicy Bypass -File "scripts\demo.ps1" -Scenario $scenario -DshBin $DshBin | Out-Null } finally { Pop-Location }
      if ($LASTEXITCODE -ne 0) { throw "scenario $scenario failed (exit $LASTEXITCODE)" }
    }
  }
} else {
  Write-Host ""
  Write-Host "(LLM scenarios skipped by -SkipLlm)"
}

Write-Host ""
if ($failed) {
  Write-Host "[verify] FAILED"
  exit 1
}
Write-Host "[verify] ALL PASSED"
exit 0
