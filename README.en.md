# AI Workflow Platform

English version. 中文文档：[README.md](README.md)

AI Workflow Platform is a local desktop AI engineering workflow application. It covers the full loop from importing a project, normalizing workflows, and creating Runs to advancing nodes, invoking Codex or Claude Code CLI, handling approvals and Gates, archiving evidence, and packaging a delivery.

The current release includes the Runtime API, an Electron desktop runtime, independent page routing, governed terminals, interactive Agent sessions, live logs, Windows EXE packaging, and the DSH Workbench.

Direct model chat supports OpenAI-compatible `/chat/completions` endpoints, SSE streaming, reasoning content, and multi-turn conversations. Codex Agents support app-server sessions, command execution, and human approval. High-risk operations are recorded by the desktop application and Runtime audit trail.

## Requirements

- Windows 10/11.
- Node.js and npm available in PowerShell as `node -v` and `npm.cmd -v`.
- Python 3.11+ for the Runtime service and Runtime EXE packaging.
- Optional: Codex CLI, with `codex.cmd` available on `PATH` and logged in.
- Optional: Claude Code CLI, with `claude.cmd` available on `PATH` and logged in.
- Optional: PyInstaller for full Runtime EXE packaging. Install it with `python -m pip install pyinstaller` if needed.

## Development Commands

```powershell
npm install
npm.cmd run test
npm.cmd run test:runtime
npm.cmd run verify
npm.cmd run test:e2e
```

The unified PowerShell verification script can also be run directly:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
```

## Start the Desktop Application

Run the development application with:

```powershell
npm.cmd run dev
```

This starts the Vite renderer and lets Electron manage the Runtime automatically. Do not start a separate `uvicorn` process during development, because the application may connect to an outdated Runtime process. Configure the project path and workflow from the setup or Settings page. A saved workspace session restores the previous project, workflow version, and Run automatically.

## Run Workflow

1. Open the Run page.
2. Select or create a Run.
3. Select a target node such as `plan`, `verify`, or `deploy`.
4. Advance ordinary nodes with their available action.
5. Enter the AI task in the Agent prompt.
6. Select `Codex`, `Claude Code`, or the test-only `Fake` provider.
7. Select an Agent mode.
8. Start the Agent.

## Artifact-Driven Workflows

Workflow administrators define an artifact contract for each node: artifact ID, name, type, fixed project path, optional template, description, and required status. They can also configure Agent templates, upstream context, type filters, summary limits, and advancement behavior. Runtime rejects invalid paths, duplicate IDs, unknown template variables, and unsafe automatic advancement settings.

After a Run starts, the executor does not need to enter standard artifact paths or types manually. Runtime assembles the node's expected files and paths together with approved upstream artifact paths, hashes, and summaries into an `effectivePrompt`. The Run page shows the artifact contract and a preflight context preview.

When an Agent finishes, or when the user requests another artifact scan, Runtime validates the declared paths, checks the project boundary, computes hashes, and records versions:

- Missing required artifacts keep the node in `AWAITING_ARTIFACT` and block advancement.
- Missing optional artifacts do not block advancement.
- Scanning unchanged content does not create duplicate versions. Changed files create new versions while preserving previous versions for comparison and Evidence.
- Temporary artifacts from failed Agents are marked as pending confirmation. They affect node state only after a trusted human confirms them as official artifacts.
- Downstream Agents read only official artifacts from upstream nodes in `PASSED` state.

Approvals and Gates are bound to the hash set of the official artifacts at that point in time. If a later scan detects changed content, Runtime invalidates the old approval or Gate, records an audit event, and returns the node to the appropriate approval or Gate state.

Agent modes:

- `Interactive terminal`: the default mode. The desktop application creates a governed PTY, starts `codex.cmd` or `claude.cmd`, and displays output in the Agent interactive terminal on the Run page.
- `Automatic execution`: intended for short tasks without human follow-up. Runtime executes the provider command and records output in the Agent log.

## Reply to an Agent

In interactive terminal mode, reply directly in the Agent interactive terminal when the Agent asks a question, requests confirmation, or presents a choice. Do not cancel the existing Agent and create a replacement.

You can enter ordinary text or a CLI option, interrupt with Ctrl+C, cancel the Agent from the Run page, continue a historical interactive session, and inspect the persisted transcript after refreshing the page. Input is written to the real CLI first and then recorded in the Runtime audit chain; output is incrementally transcribed by sequence number.

## Direct Model Chat

Configure the model vendor, OpenAI-compatible API URL, model name, and API key on the Settings page to use direct chat. The default System Prompt asks for concise Chinese responses. Override the System Prompt for English or bilingual output. Direct chat does not start a local CLI, request tool permissions, or modify project files.

## Codex App-Server Chat

Codex Agents can use app-server sessions for conversational work. When the model requests command execution or another governed permission, the application displays an approval request. Approvals, denials, command output, and session state are written to the Runtime audit trail. Streaming messages, reasoning content, and follow-up user replies remain in the same Agent session.

## Terminals

The Terminal page supports:

- `Shell`: a governed system shell.
- `Codex`: an interactive Codex CLI terminal.
- `Claude`: an interactive Claude Code CLI terminal.

Choose the terminal type, working directory, and dimensions, then create the terminal. Shell commands with high-risk patterns require Chinese human confirmation before being written to the PTY. Terminal output supports search, copy, paste, clear, jump-to-latest, resizing, Ctrl+C, stopping the session, Evidence export, historical output, and creating a new terminal from a previous session.

## Live Logs and Encoding

Run pages, deployment output, Agent output, and terminal pages use bounded, scrollable xterm-style log areas. Logs support ANSI output, Chinese text, incremental updates, and scrolling. Codex, Claude, and Shell subprocess output is decoded in UTF-8 and GB18030 order to reduce common Windows encoding issues.

## Codex CLI and Claude Code CLI

Check the CLI installation with:

```powershell
where.exe codex
where.exe claude
codex --version
claude --version
```

If a command is unavailable, add its `.cmd` entry to the user or system `PATH` and restart the desktop application. Runtime checks `codex.cmd` and `claude.cmd` first and does not depend on PowerShell `.ps1` shims.

Login state is managed by each CLI. This application does not store plaintext Codex or Claude Code credentials, login tokens, or secrets in its database, logs, audit records, or Evidence packages.

## Package Windows EXE

Build the complete Windows package with:

```powershell
npm.cmd run package:win:full
```

The command builds contracts, renderer, desktop, and the Python Runtime EXE, then creates an unpacked ZIP and an NSIS installer.

Other packaging commands:

```powershell
npm.cmd run build:runtime:exe
npm.cmd run package:win:installer
npm.cmd run test:package-script
npm.cmd run test:e2e:packaged
npm.cmd run test:e2e:installed
```

If the packaged EXE opens to a blank page, check that `apps/renderer/dist/index.html` exists, Electron loads `file:` resources, the Runtime EXE is present in the package, and Windows security software is not blocking Electron or Runtime child processes.

## Verification

The default verification command is:

```powershell
npm.cmd run verify
```

It runs contracts, renderer, desktop, and Runtime tests without browser E2E. Run browser E2E separately with `npm.cmd run test:e2e`.

## Current Scope

The current release covers project import, adapter detection, canonical workflow storage, event-sourced Runs, Runtime-backed Project/Workflow/Run APIs, independent page routing, Run lifecycle controls, artifacts, approvals, Gates, Evidence, Codex/Claude/Fake providers, automatic and interactive Agents, governed Shell/Codex/Claude terminals, dangerous Shell command approval, live deployment output, Runtime diagnostics and recovery, Windows Runtime EXE packaging, and the DSH Workbench.

The detailed acceptance checklist is available at [docs/remaining-work-and-acceptance.zh-CN.md](docs/remaining-work-and-acceptance.zh-CN.md).
