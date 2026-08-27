# demo.ps1 — run one governance PoC scenario against the local headless profile
# and assert the event stream + projection.
#
# Scenarios:
#   pause   — approval-required 'plan' with NO human decision and artifacts
#             present; must return AWAITING_APPROVAL and NOT complete the node.
#   approve — decision pre-approves 'plan'; plan -> verify (auto) -> ship pause;
#             afterwards the demo mutates plan.md and proves drift detection.
#   reject  — decision pre-rejects 'plan'; node stays blocked (REJECTED).
#   missing — 'plan' artifact (artifacts/plan.md) is ABSENT; the artifact gate
#             must return AWAITING_ARTIFACT before any approval is considered.
#   template / template-io / template-file — runtime template management.
#   evidence — tamper-evident evidence package export.
#   inbox    — approval inbox lists blocked runs + pending template changes.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/demo.ps1 -Scenario pause

param(
  [ValidateSet("pause", "approve", "reject", "missing", "template", "template-io", "template-file", "evidence", "inbox")]
  [string]$Scenario = "pause",
  [string]$DshBin = "dsh.cmd"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LocalHome = Join-Path $RepoRoot ".workbench-poc\dsh-home"
$StoreDir = Join-Path $RepoRoot ".workbench-poc\store"
$ProjectDir = Join-Path $RepoRoot ".workbench-poc\project"
$LogDir = Join-Path $RepoRoot ".workbench-poc\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (!(Test-Path (Join-Path $LocalHome "profiles\workbench-poc"))) {
  throw "profile not bootstrapped yet — run scripts/bootstrap.ps1 first"
}

# --- reset store + project so every run is deterministic -------------------
if (Test-Path $StoreDir) { Remove-Item $StoreDir -Recurse -Force }
if (Test-Path $ProjectDir) { Remove-Item $ProjectDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $StoreDir "decisions") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectDir "artifacts") | Out-Null

# --- project fixture: the node deliverables -------------------------------
# Windows PowerShell 5.1's Set-Content -Encoding UTF8 writes a BOM, which
# would corrupt JSON.parse — use .NET WriteAllText with a BOM-less encoding.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $ProjectDir "artifacts\plan.md"), "# plan v1`n", $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $ProjectDir "artifacts\verify.md"), "# verify v1`n", $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $ProjectDir "artifacts\ship.json"), '{"ship":"v1"}' + "`n", $utf8NoBom)
if ($Scenario -eq "template-file") {
  # Project-file workflow templates (.workbench-templates/*.json), mirroring
  # ai-desktop's adapter idea: workflows live with the project as files.
  New-Item -ItemType Directory -Force -Path (Join-Path $ProjectDir ".workbench-templates") | Out-Null
  [System.IO.File]::WriteAllText(
    (Join-Path $ProjectDir ".workbench-templates\qa-file.json"),
    '{"schema":"workbench-template/v1","name":"qa-file","version":1,"firstNode":"check","nodes":[{"id":"check","requiresApproval":true,"artifacts":[{"id":"report","path":"artifacts/qa-check.md","required":true}]},{"id":"deploy","requiresApproval":false,"artifacts":[{"id":"manifest","path":"artifacts/qa-deploy.json","required":true}]}]}',
    $utf8NoBom)
  Write-Host "[demo] wrote project template: .workbench-templates/qa-file.json"
}
if ($Scenario -eq "missing") {
  Remove-Item (Join-Path $ProjectDir "artifacts\plan.md") -Force
  Write-Host "[demo] REMOVED plan artifact (missing scenario)"
}

# --- optional trusted-human decision files --------------------------------
if ($Scenario -eq "approve" -or $Scenario -eq "evidence") {
  [System.IO.File]::WriteAllText(
    (Join-Path $StoreDir "decisions\poc.plan.json"),
    '{"decision":"approve","actor":"trusted-human","note":"PoC demo: pre-approved plan"}',
    $utf8NoBom)
  Write-Host "[demo] wrote decision: poc.plan.json = approve"
}
if ($Scenario -eq "reject") {
  [System.IO.File]::WriteAllText(
    (Join-Path $StoreDir "decisions\poc.plan.json"),
    '{"decision":"reject","actor":"trusted-human","note":"PoC demo: rejected plan"}',
    $utf8NoBom)
  Write-Host "[demo] wrote decision: poc.plan.json = reject"
}
if ($Scenario -eq "template") {
  # Template saves are gated by the same approval seam: workflow="__templates__",
  # nodeId=template name -> decisions/__templates__.<name>.json
  [System.IO.File]::WriteAllText(
    (Join-Path $StoreDir "decisions\__templates__.qa.json"),
    '{"decision":"approve","actor":"trusted-human","note":"PoC demo: approve qa template"}',
    $utf8NoBom)
  Write-Host "[demo] wrote decision: __templates__.qa.json = approve"
}
if ($Scenario -eq "template-io") {
  [System.IO.File]::WriteAllText(
    (Join-Path $StoreDir "decisions\__templates__.poc-v2.json"),
    '{"decision":"approve","actor":"trusted-human","note":"PoC demo: approve poc-v2 import"}',
    $utf8NoBom)
  Write-Host "[demo] wrote decision: __templates__.poc-v2.json = approve"
}
if ($Scenario -eq "template-file") {
  # The project-file sync gate uses workflow="__templates__", nodeId="__sync__".
  [System.IO.File]::WriteAllText(
    (Join-Path $StoreDir "decisions\__templates__.__sync__.json"),
    '{"decision":"approve","actor":"trusted-human","note":"PoC demo: approve project template sync"}',
    $utf8NoBom)
  Write-Host "[demo] wrote decision: __templates__.__sync__.json = approve"
}

# --- task prompt for the fresh headless agent ----------------------------
# The workflow definition is ADMIN-DEFINED: workflow_start('poc') loads the
# built-in template (plan -> verify -> ship; plan and ship require approval;
# each node declares a required artifact). Every prompt tells the agent to
# keep going — the governance gates, not the model, decide where it pauses.
switch ($Scenario) {
  "pause" {
    $task = "You are running a governance plugin demo. Execute the steps below IN ORDER and DO NOT STOP or wait between them; there is no human waiting and no further instruction will come. 1) Call workflow_start with workflow='poc'. 2) Immediately call workflow_advance with the returned runId and nodeId='plan'. 3) workflow_advance for 'plan' should return AWAITING_APPROVAL because the artifacts exist but no human decision has been recorded. 4) Call workflow_audit with the runId and STOP. Do not retry workflow_advance and do not attempt to complete the node any other way."
  }
  "approve" {
    $task = "You are running a governance plugin demo. Execute the steps below IN ORDER and DO NOT STOP or wait between them; there is no human waiting and no further instruction will come. 1) Call workflow_start with workflow='poc'. 2) Call workflow_advance with the returned runId and nodeId='plan' — a trusted-human decision file has already been recorded as APPROVE, so this should approve plan and advance to 'verify'. 3) Call workflow_advance on nodeId='verify' (no approval required) — it should advance to 'ship'. 4) Call workflow_advance on nodeId='ship' — no decision file exists for 'ship', so it should return AWAITING_APPROVAL. 5) Call workflow_audit and STOP."
  }
  "reject" {
    $task = "You are running a governance plugin demo. Execute the steps below IN ORDER and DO NOT STOP or wait between them; there is no human waiting and no further instruction will come. 1) Call workflow_start with workflow='poc'. 2) Call workflow_advance with the returned runId and nodeId='plan' — a trusted-human decision file has already been recorded as REJECT, so this should return REJECTED and the node must stay blocked. 3) Call workflow_audit and STOP. Do not retry workflow_advance."
  }
  "missing" {
    $task = "You are running a governance plugin demo. Execute the steps below IN ORDER and DO NOT STOP or wait between them; there is no human waiting and no further instruction will come. 1) Call workflow_start with workflow='poc'. 2) Immediately call workflow_advance with the returned runId and nodeId='plan'. 3) workflow_advance for 'plan' should return AWAITING_ARTIFACT because the required artifact artifacts/plan.md is missing — the node must NOT be completed and NO approval question may be considered. 4) Call workflow_audit with the runId and STOP. Do not retry workflow_advance and do not create the artifact yourself."
  }
  "template" {
    $task = "You are running a governance plugin demo. Execute the steps below IN ORDER and DO NOT STOP or wait between them; there is no human waiting and no further instruction will come. 1) Call workflow_template_save with name='qa', firstNode='check', nodes=[{id:'check',requiresApproval:true,artifacts:[{id:'report',path:'artifacts/qa-check.md',required:true}]},{id:'deploy',requiresApproval:false,artifacts:[{id:'manifest',path:'artifacts/qa-deploy.json',required:true}]}] — a trusted-human decision file has already been recorded as APPROVE, so this should SAVE the template. 2) Call workflow_template_list — it should include both 'poc' and 'qa'. 3) Call workflow_start with workflow='qa' — the run should start at node 'check'. 4) Call workflow_audit with the runId and STOP."
  }
  "template-io" {
    $task = "You are running a governance plugin demo. Execute the steps below IN ORDER and DO NOT STOP or wait between them; there is no human waiting and no further instruction will come. 1) Call workflow_template_export with name='poc' and remember the returned document object EXACTLY as-is. 2) Call workflow_template_import with name='poc-v2' and document = the ENTIRE document object from step 1 passed VERBATIM (do not add, remove or rename any field) — a trusted-human decision file has already been recorded as APPROVE, so this should return IMPORTED. 3) Call workflow_template_list — it should include 'poc', 'poc-v2' (and any others). 4) Call workflow_start with workflow='poc-v2' — the run should start at node 'plan'. 5) Call workflow_audit with the runId and STOP."
  }
  "template-file" {
    $task = "You are running a governance plugin demo. Execute the steps below IN ORDER and DO NOT STOP or wait between them; there is no human waiting and no further instruction will come. 1) Call workflow_template_sync_project — the project contains a .workbench-templates/qa-file.json file, and a trusted-human decision file has already been recorded as APPROVE, so this should return SYNCED and import the 'qa-file' template. 2) Call workflow_template_list — it should include 'qa-file'. 3) Call workflow_start with workflow='qa-file' — the run should start at node 'check'. 4) Call workflow_audit with the runId and STOP."
  }
  "evidence" {
    $task = "You are running a governance plugin demo. Execute the steps below IN ORDER and DO NOT STOP or wait between them; there is no human waiting and no further instruction will come. 1) Call workflow_start with workflow='poc'. 2) Call workflow_advance on nodeId='plan' — a trusted-human decision file has already been recorded as APPROVE, so plan should be approved and completed and the run advances to 'verify'. 3) Call workflow_advance on nodeId='verify' (no approval required) — advances to 'ship'. 4) Call workflow_advance on nodeId='ship' — no decision file exists, so it returns AWAITING_APPROVAL. 5) Call workflow_evidence_export with the runId — it should write a tamper-evident evidence package into the project and return its path and packageHash. 6) Call workflow_audit and STOP."
  }
  "inbox" {
    $task = "You are running a governance plugin demo. Execute the steps below IN ORDER and DO NOT STOP or wait between them; there is no human waiting and no further instruction will come. 1) Call workflow_start with workflow='poc'. 2) Call workflow_advance on nodeId='plan' — no decision file exists, so it returns AWAITING_APPROVAL. 3) Call workflow_template_save with name='inbox-tpl', firstNode='check', nodes=[{id:'check',requiresApproval:true,artifacts:[{id:'report',path:'artifacts/qa-check.md',required:true}]}] — no decision file exists, so it returns AWAITING_APPROVAL and the template is NOT saved. 4) Call workflow_approval_inbox — it should list the blocked run (blockedBy approval at node plan) AND the pending template change 'inbox-tpl'. 5) STOP."
  }
}

# --- run headless ---------------------------------------------------------
$env:DSH_HOME = $LocalHome
$env:WORKBENCH_STORE = $StoreDir
$env:WORKBENCH_PROJECT = $ProjectDir
$env:NODE_NO_WARNINGS = "1"   # suppress node:sqlite experimental warning on stderr
$logFile = Join-Path $LogDir "$Scenario.log"
Write-Host "[demo] scenario=$Scenario running headless (this takes 1-3 min) ..."
Write-Host "[demo] task: $task"
# PowerShell 5.1 treats native stderr lines as terminating errors when
# $ErrorActionPreference=Stop and 2>&1 is redirected — relax it for the call.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$output = & $DshBin --profile workbench-poc $task 2>&1
$exit = $LASTEXITCODE
$ErrorActionPreference = $previousEap
$output | Set-Content -Path $logFile -Encoding UTF8
Write-Host "[demo] headless exit=$exit — full output in $logFile"
Write-Host "----- agent output -----"
$output | ForEach-Object { Write-Host $_ }
Write-Host "----- end agent output -----"

# --- assertions (read the SQLite event store via dump-store.mjs) ---------
$dump = node "$RepoRoot\scripts\dump-store.mjs" 2>$null | ConvertFrom-Json
if (!$dump -or !$dump.runs -or $dump.runs.Count -eq 0) {
  Write-Error "no runs in the event store — plugin or agent failure"; exit 1
}
$run = $dump.runs[0]
$allEntries = @($run.events)
$state = [PSCustomObject]@{ current = $run.current; status = $run.status }

Write-Host "[demo] runId=$($run.runId) state.current=$($state.current) state.status=$($state.status)"
Write-Host "[demo] event stream:"
$allEntries | ForEach-Object { Write-Host ("  seq={0} actor={1} action={2} node={3}" -f $_.seq, $_.actor, $_.action, $_.nodeId) }

$actions = @($allEntries | ForEach-Object { "$($_.action)@$($_.nodeId)" })
function Assert-Has([string]$pattern, [string]$label) {
  if (($actions | Where-Object { $_ -like $pattern }).Count -eq 0) {
    Write-Error "[assert] FAIL: expected $label ($pattern) not found"; exit 1
  }
  Write-Host "[assert] ok: $label"
}
function Assert-Not([string]$pattern, [string]$label) {
  if (($actions | Where-Object { $_ -like $pattern }).Count -gt 0) {
    Write-Error "[assert] FAIL: unexpected $label ($pattern) present"; exit 1
  }
  Write-Host "[assert] ok: $label absent"
}

switch ($Scenario) {
  "pause" {
    Assert-Has "run.started@" "run started"
    Assert-Has "advance.attempted@plan" "agent attempted plan advance"
    Assert-Has "approval.pending@plan" "plan approval pending"
    Assert-Not "node.completed*" "no node completed"
    Assert-Not "node.approved*" "no approval forged"
    Assert-Not "artifact.missing@plan" "artifacts present (no missing gate)"
    if ($state.current -ne "plan" -or $state.status -ne "RUNNING") {
      Write-Error "[assert] FAIL: expected state current=plan RUNNING, got $($state.current) $($state.status)"; exit 1
    }
    Write-Host "[assert] ok: state remains current=plan RUNNING (paused at approval gate)"
  }
  "approve" {
    Assert-Has "run.started@" "run started"
    Assert-Has "node.approved@plan" "plan approved by trusted human"
    Assert-Has "node.completed@plan" "plan completed after approval"
    Assert-Has "node.completed@verify" "verify completed (no approval needed)"
    Assert-Has "approval.pending@ship" "ship approval pending (paused again)"
    Assert-Has "artifact.registered@plan" "plan artifacts registered"
    Assert-Not "node.completed@ship" "ship NOT completed"
    if ($state.current -ne "ship" -or $state.status -ne "RUNNING") {
      Write-Error "[assert] FAIL: expected state current=ship RUNNING, got $($state.current) $($state.status)"; exit 1
    }
    Write-Host "[assert] ok: state advanced to current=ship RUNNING (paused at second gate)"

    # Drift: mutate plan.md AFTER plan was approved+completed; the recorded
    # hash snapshot must now report drifted (stale evidence).
    [System.IO.File]::AppendAllText((Join-Path $ProjectDir "artifacts\plan.md"), "# mutated after completion`n", $utf8NoBom)
    $check = node "$RepoRoot\scripts\check-artifacts.mjs" $run.runId "plan" 2>$null | ConvertFrom-Json
    if (!$check) { Write-Error "[assert] FAIL: check-artifacts returned nothing"; exit 1 }
    $planDoc = $check.artifacts | Where-Object { $_.artifact -eq "plan-doc" } | Select-Object -First 1
    Write-Host "[demo] post-completion check: artifact=$($planDoc.artifact) drift=$($planDoc.drift) sha=$($planDoc.sha256.Substring(0,8))... recorded=$($planDoc.recordedSha256.Substring(0,8))..."
    if ($planDoc.drift -ne "drifted") {
      Write-Error "[assert] FAIL: expected drift=drifted after mutating plan.md, got $($planDoc.drift)"; exit 1
    }
    Write-Host "[assert] ok: content change after completion detected (drift=drifted) — stale approval/evidence invalidated"
  }
  "reject" {
    Assert-Has "run.started@" "run started"
    Assert-Has "node.rejected@plan" "plan rejected by trusted human"
    Assert-Has "advance.attempted@plan" "agent attempted plan advance"
    Assert-Not "node.completed*" "no node completed"
    Assert-Not "node.approved*" "no approval forged"
    if ($state.current -ne "plan" -or $state.status -ne "RUNNING") {
      Write-Error "[assert] FAIL: expected state current=plan RUNNING, got $($state.current) $($state.status)"; exit 1
    }
    Write-Host "[assert] ok: state remains current=plan RUNNING (blocked after rejection)"
  }
  "missing" {
    Assert-Has "run.started@" "run started"
    Assert-Has "advance.attempted@plan" "agent attempted plan advance"
    Assert-Has "artifact.missing@plan" "plan artifact gate blocked (AWAITING_ARTIFACT)"
    Assert-Not "node.completed*" "no node completed"
    Assert-Not "approval.pending@plan" "approval not even considered"
    Assert-Not "artifact.registered@plan" "no artifact registered"
    if ($state.current -ne "plan" -or $state.status -ne "RUNNING") {
      Write-Error "[assert] FAIL: expected state current=plan RUNNING, got $($state.current) $($state.status)"; exit 1
    }
    Write-Host "[assert] ok: state remains current=plan RUNNING (blocked at artifact gate)"
  }
  "template" {
    # The saved 'qa' template must exist in the runtime store with an audit trail
    # showing the trusted-human approval, and a run must have started on it.
    $qa = $dump.templates | Where-Object { $_.name -eq "qa" } | Select-Object -First 1
    if (!$qa) { Write-Error "[assert] FAIL: template 'qa' not found in runtime store"; exit 1 }
    Write-Host "[assert] ok: template qa saved (version=$($qa.version), nodes=$($qa.nodeIds -join ','))"
    $qaAuditActions = @($qa.audit | ForEach-Object { $_.action })
    if ($qaAuditActions -notcontains "template.created" -and $qaAuditActions -notcontains "template.updated") {
      Write-Error "[assert] FAIL: template qa audit has no template.created/updated"; exit 1
    }
    Write-Host "[assert] ok: template qa audit records the save ($($qaAuditActions -join ','))"
    if (($dump.templates | Where-Object { $_.name -eq "poc" }).Count -eq 0) {
      Write-Error "[assert] FAIL: seeded template 'poc' missing from list"; exit 1
    }
    Write-Host "[assert] ok: seeded template poc still listed"
    Assert-Has "run.started@" "run started on qa"
    if ($run.workflow -ne "qa" -or $state.current -ne "check" -or $state.status -ne "RUNNING") {
      Write-Error "[assert] FAIL: expected run on qa at check RUNNING, got workflow=$($run.workflow) current=$($state.current) status=$($state.status)"; exit 1
    }
    Write-Host "[assert] ok: run started on runtime-managed template qa at current=check RUNNING"
  }
  "template-io" {
    $pocV2 = $dump.templates | Where-Object { $_.name -eq "poc-v2" } | Select-Object -First 1
    if (!$pocV2) { Write-Error "[assert] FAIL: template 'poc-v2' not found in runtime store"; exit 1 }
    Write-Host "[assert] ok: imported template poc-v2 present (version=$($pocV2.version), nodes=$($pocV2.nodeIds -join ','))"
    $ioAuditActions = @($pocV2.audit | ForEach-Object { $_.action })
    if ($ioAuditActions -notcontains "template.imported") {
      Write-Error "[assert] FAIL: poc-v2 audit has no template.imported ($($ioAuditActions -join ','))"; exit 1
    }
    Write-Host "[assert] ok: poc-v2 audit records the gated import ($($ioAuditActions -join ','))"
    Assert-Has "run.started@" "run started on poc-v2"
    if ($run.workflow -ne "poc-v2" -or $state.current -ne "plan" -or $state.status -ne "RUNNING") {
      Write-Error "[assert] FAIL: expected run on poc-v2 at plan RUNNING, got workflow=$($run.workflow) current=$($state.current) status=$($state.status)"; exit 1
    }
    Write-Host "[assert] ok: run started on imported template poc-v2 at current=plan RUNNING"
  }
  "template-file" {
    $qaFile = $dump.templates | Where-Object { $_.name -eq "qa-file" } | Select-Object -First 1
    if (!$qaFile) { Write-Error "[assert] FAIL: template 'qa-file' not synced into the runtime store"; exit 1 }
    Write-Host "[assert] ok: project template qa-file synced (version=$($qaFile.version), nodes=$($qaFile.nodeIds -join ','))"
    $syncAudit = @($qaFile.audit | ForEach-Object { $_.action })
    if ($syncAudit -notcontains "template.synced") {
      Write-Error "[assert] FAIL: qa-file audit has no template.synced ($($syncAudit -join ','))"; exit 1
    }
    Write-Host "[assert] ok: qa-file audit records the gated sync ($($syncAudit -join ','))"
    Assert-Has "run.started@" "run started on qa-file"
    if ($run.workflow -ne "qa-file" -or $state.current -ne "check" -or $state.status -ne "RUNNING") {
      Write-Error "[assert] FAIL: expected run on qa-file at check RUNNING, got workflow=$($run.workflow) current=$($state.current) status=$($state.status)"; exit 1
    }
    Write-Host "[assert] ok: run started on project-synced template qa-file at current=check RUNNING"
  }
  "evidence" {
    Assert-Has "node.completed@plan" "plan completed"
    Assert-Has "node.completed@verify" "verify completed"
    Assert-Has "approval.pending@ship" "ship approval pending"
    Assert-Has "evidence.exported@" "evidence exported event"
    $evidenceFile = Join-Path $ProjectDir ".workbench-evidence\$($run.runId).json"
    if (!(Test-Path $evidenceFile)) {
      Write-Error "[assert] FAIL: evidence file not written: $evidenceFile"; exit 1
    }
    Write-Host "[assert] ok: evidence file written into project"
    $evidence = Get-Content $evidenceFile -Raw | ConvertFrom-Json
    if ($evidence.schema -ne "workbench-evidence/v1") {
      Write-Error "[assert] FAIL: evidence schema mismatch ($($evidence.schema))"; exit 1
    }
    if ($evidence.events.Count -ne $evidence.hashChain.Count) {
      Write-Error "[assert] FAIL: hash chain does not cover every event ($($evidence.events.Count) vs $($evidence.hashChain.Count))"; exit 1
    }
    if ($evidence.packageHash.Length -ne 64) {
      Write-Error "[assert] FAIL: packageHash not sha256"; exit 1
    }
    if ($evidence.artifacts.Count -lt 3) {
      Write-Error "[assert] FAIL: evidence missing registered artifacts ($($evidence.artifacts.Count))"; exit 1
    }
    Write-Host "[assert] ok: evidence package valid (events=$($evidence.events.Count), artifacts=$($evidence.artifacts.Count), hashChain=$($evidence.hashChain.Count), packageHash=$($evidence.packageHash.Substring(0,12))…)"
  }
  "inbox" {
    # The run must be blocked at approval on plan, and the template change pending.
    $inboxRun = $dump.inbox.runs | Where-Object { $_.runId -eq $run.runId } | Select-Object -First 1
    if (!$inboxRun -or $inboxRun.blockedBy -ne "approval" -or $inboxRun.nodeId -ne "plan") {
      Write-Error "[assert] FAIL: inbox does not list the blocked run ($($inboxRun | ConvertTo-Json -Compress))"; exit 1
    }
    Write-Host "[assert] ok: inbox lists the run blocked at approval on plan"
    $inboxTpl = $dump.inbox.templates | Where-Object { $_.subject -eq "inbox-tpl" } | Select-Object -First 1
    if (!$inboxTpl -or $inboxTpl.action -ne "template.save.pending") {
      Write-Error "[assert] FAIL: inbox does not list the pending template change"; exit 1
    }
    Write-Host "[assert] ok: inbox lists the pending template change (inbox-tpl)"
    $savedTpl = $dump.templates | Where-Object { $_.name -eq "inbox-tpl" } | Select-Object -First 1
    if ($savedTpl) { Write-Error "[assert] FAIL: inbox-tpl must NOT be saved without approval"; exit 1 }
    Write-Host "[assert] ok: unapproved template was NOT saved"
  }
}

Write-Host "[demo] SCENARIO $Scenario PASSED"
exit 0
