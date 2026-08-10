# Run Detail Agent Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the Agent launch command on the current project-scoped Run detail page after an Agent node enters `RUNNING`.

**Architecture:** `RunDetailPage` owns the compact launch form because it owns the selected node and scoped overview. `App` supplies Provider diagnostics and a scoped callback that reuses the existing Runtime and desktop-terminal orchestration. Agent creation remains separate from workflow transition `allowedActions`.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, existing Runtime HTTP client and Electron terminal bridge.

---

### Task 1: Add The Failing Run Detail Regression Test

**Files:**
- Test: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`

- [ ] Add a test rendering the existing `implement` Agent node in `RUNNING` state with an `onStartAgent` spy and available Codex Provider diagnostics.
- [ ] Assert that `Agent 提示词`, `Agent 模式`, and `启动 Agent` are visible; enter `继续开发`, select interactive mode, click launch, and assert the callback receives `{ nodeId: "implement", provider: "codex", prompt: "继续开发", mode: "interactive", allowedTools: [], cwd: "G:\\project\\release" }`.
- [ ] Run `npm.cmd --workspace apps/renderer test -- --run src/features/runs/RunDetailPage.test.tsx` and confirm it fails because `启动 Agent` is absent.

### Task 2: Render And Validate The Scoped Agent Launch Form

**Files:**
- Modify: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Test: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`

- [ ] Add `providerDiagnostics?: AgentProviderDiagnostic[]` and `onStartAgent?(request: RunAgentStartRequest): Promise<AgentJobSummary>` props. Define `RunAgentStartRequest` with `nodeId`, `provider`, `prompt`, `mode`, `allowedTools`, and `cwd`.
- [ ] Derive the selected role from `selectedNode.agent?.roleId ?? selectedNode.role`, use its Provider and allowed tools as defaults, and keep form state scoped to the selected node.
- [ ] Render the form only for `selectedNode.kind === "agent"` and `projection.nodeStates[selectedNode.id] === "RUNNING"`. Disable launch for read-only/archived Runs, unavailable Provider, blank prompt, or an in-flight launch.
- [ ] On success, reload `loadAgentJobs` and render the returned job's existing terminal link. On failure, show an inline error without discarding the overview.
- [ ] Add tests proving `READY` Agent nodes and `RUNNING` non-Agent nodes do not render the launch form, and archived Runs cannot submit it.
- [ ] Re-run the focused test and confirm all `RunDetailPage` cases pass.

### Task 3: Wire App To The Existing Scoped Agent Runtime Flow

**Files:**
- Modify: `apps/renderer/src/app/App.tsx`
- Test: `apps/renderer/src/app/App.test.tsx`

- [ ] Refactor the unused legacy `handleStartAgent` into `handleStartScopedAgent(runId, request)` so it never reads the old global projection to select a Run.
- [ ] Keep existing behavior: call `client.startAgentJob(projectId, runId, ...)`; use the Run execution workspace; create and record the desktop interactive terminal for Codex/Claude when available; otherwise use automatic mode; update operation status; return the created job; rethrow failures after reporting them.
- [ ] Pass `providerDiagnostics` and a callback bound to `runRoute.runId` into `RunDetailPage`.
- [ ] Add an App integration assertion that the detail route supplies the launch operation to the running Agent node and sends the request to `/projects/{projectId}/runs/{runId}/agents`.
- [ ] Run the focused App and Run detail tests and confirm they pass.

### Task 4: Regression Verification

**Files:**
- Verify: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Verify: `apps/renderer/src/app/App.tsx`

- [ ] Run `npm.cmd --workspace apps/renderer test` and confirm all Renderer tests pass.
- [ ] Run `npm.cmd --workspace apps/renderer run build` and confirm TypeScript and Vite production build pass.
- [ ] Run `git diff --check` and inspect `git diff -- apps/renderer/src/features/runs/RunDetailPage.tsx apps/renderer/src/features/runs/RunDetailPage.test.tsx apps/renderer/src/app/App.tsx apps/renderer/src/app/App.test.tsx`.
- [ ] Do not stage or commit; report the exact verification counts and any existing build warnings.
