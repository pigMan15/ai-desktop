# DSH Workbench

English version. 中文文档：[README.md](README.md)

The DSH Workbench is a governed AI engineering workflow workspace built on [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). Its DSH host and browser plugins provide event-sourced Runs, approval, artifact and Evidence governance, runtime workflow templates, and a React Flow visual editor.

## Acceptance

On 2026-08-14, two complete `poc` Runs were verified in the DSH Web interface. Both approval paths were exercised: `ui-human` through the GUI approval card and `trusted-human` through the headless decision file. Evidence export persisted 13 events, 3 artifacts, and a 13-entry hash chain. The Agent paused at approval points and resumed only after human approval, with the full process auditable.

## Structure

```text
workbench/
├── packages/
│   ├── workbench-governance/     # Host plugin: workflow_* tools, SQLite event store, HTTP endpoints
│   └── workbench-ui/             # Browser plugin: TSX, esbuild, and React Flow UI
├── profile/ + profile-web/       # Headless and Web profile templates
├── scripts/                      # Bootstrap, install, demo, verify, dump, and check scripts
├── .github/workflows/workbench.yml  # CI: automatic engine tests and manual LLM scenarios
└── DEPLOY.md                     # Deployment and migration guide
```

## Installation

### A. Install from Source

Prerequisites are Node 22+, the `dsh` CLI, and a configured model in `~/.dsh`.

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

### B. Publish as DSH Plugins

```powershell
npm run pack:plugins
dsh plugin --profile <web-profile> add @workflow-platform/workbench-governance @workflow-platform/workbench-ui
```

Packages declaring `dsh.bundle` are automatically added to `dsh.profile.bundles` by the official command.

### C. One-Step Local Installation

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

## Use the Workbench

```powershell
# Web workbench with approval cards, React Flow editor, and live panels
$env:DSH_HOME = "$PWD\.workbench-poc\dsh-home"
$env:WORKBENCH_STORE = "$PWD\.workbench-poc\store-web"
$env:WORKBENCH_PROJECT = "$PWD\.workbench-poc\project-web"
$env:WORKBENCH_UI_APPROVAL = "1"
$env:WORKBENCH_DEFAULT_WORKFLOW = "poc"
dsh --profile workbench-poc-web --port 3090

# Headless engine verification
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1 -Scenario pause
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -SkipLlm
```

## Capabilities

- **Event-sourced Runs:** SQLite event streams and projections that can be replayed for recovery.
- **Governance:** SHA-256 artifact versions and project boundaries, approval gates, Evidence anchoring, drift detection, tamper-evident Evidence packages, and an approval inbox.
- **Templates:** Runtime and project-file templates in `.workbench-templates/*.json`, human-gated save/import/sync operations, default workflow binding through `WORKBENCH_DEFAULT_WORKFLOW`, and built-in `sdlc`, `hotfix`, `spike`, and `poc` workflows.
- **Role library:** Versioned node contract templates with descriptions, inputs, outputs, content templates, upstream validation, role snapshots in Evidence, trusted-human changes, and project files in `.workbench-roles/*.json`.
- **Session isolation:** When `projectDir` is omitted, `workflow_start` derives a separate project directory under `<WORKBENCH_PROJECT>/sessions/<sessionId>` while governance data remains globally manageable.
- **Tools:** Run start/advance/audit/check, Run listing, Evidence export, approval inbox, editor, template save/list/export/import/sync, and role save/list/export/import/sync.
- **UI:** Tool cards, approval inbox cards, engine-driven Run maps, a React Flow editor, live panels, workflow template editing and JSON import/export, role editing and JSON import/export, and node role binding.
- **Engineering:** TypeScript monorepo, engine tests, local verification scripts, and GitHub Actions CI.

## Verification Status

The headless LLM scenarios and Web UI approval-card acceptance flow have been verified. Engine tests, packaging checks, and CI configuration are included in this repository. See [DEPLOY.md](DEPLOY.md) and the scripts for operational details.
