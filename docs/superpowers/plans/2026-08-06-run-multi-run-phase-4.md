# Cross-Module Run Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Run-owned secondary API and Renderer page project-scoped, URL-authoritative, isolated from global Run state, and able to navigate back to the same Run.

**Architecture:** Runtime validates `projectId -> runId -> childId` before all reads and writes and exposes Run-owned resources only below `/projects/{projectId}/runs/{runId}`. Renderer parses a strict `RunContext`, uses encoded route builders and scoped clients, and gives every secondary page abortable generation-checked state. The project page consumes bounded Run summaries for activity and recent Runs without loading row details.

**Tech Stack:** Python 3, FastAPI, SQLite repositories, pytest, TypeScript, React 18, Vitest, Testing Library, Vite, Playwright

---

## File Map

- `runtime/src/workflow_platform/runtime_service.py`: shared project/Run and Run/child ownership checks plus scoped domain operations.
- `runtime/src/workflow_platform/api/app.py`: project-prefixed child routes and deletion of migrated unscoped routes.
- `runtime/tests/test_runtime_service.py`: service-level cross-project, cross-Run, archive, revision, actor, and lease coverage.
- `runtime/tests/test_api.py`: exact scoped HTTP contracts, error envelopes, and absence of unscoped writable routes.
- `apps/renderer/src/app/routes.ts`: strict `RunContext` parsing and encoded route builders.
- `apps/renderer/src/app/routes.test.ts`: valid, encoded, malformed, and incomplete route cases.
- `apps/renderer/src/app/runtimeClient.ts`: project-scoped child transport methods with abort propagation.
- `apps/renderer/src/app/runtimeClient.test.ts`: exact URL/body/signal tests and proof that old paths are unused.
- `apps/renderer/src/features/runs/scopedPageModel.ts`: common pure async state and generation reducer.
- `apps/renderer/src/features/runs/scopedPageModel.test.ts`: stale-response, retained-data, not-found, maintenance, and archive transitions.
- Existing secondary feature modules: page-specific loading, actions, read-only state, and same-Run return links.
- `apps/renderer/src/features/deployments/DeploymentPage.tsx`: isolated deployment list and incremental output surface.
- `apps/renderer/src/features/deployments/DeploymentPage.test.tsx`: deployment context, output, cancellation, and stale-result tests.
- `apps/renderer/src/features/runs/RunDetailPage.tsx`: scoped route links including canonical Agent terminal links.
- `apps/renderer/src/features/projects/ProjectDashboard.tsx`: active count, recent Runs, Run-list link, and worktree guidance.
- `apps/renderer/src/app/App.tsx`: route composition only; removal of migrated global Run state, polling, and handlers.
- `apps/renderer/src/app/App.test.tsx`: direct-route integration and zero global/unscoped fallback assertions.
- `apps/renderer/src/app/styles.css`: compact responsive secondary-page and project overview layout.
- `tests/e2e/run-multi-run-phase4.spec.ts`: terminal and artifact same-Run round trips and responsive geometry.

## 4A: Scoped Foundation

### Task 1: Strict Renderer Run Context Routes

**Files:**
- Modify: `apps/renderer/src/app/routes.ts`
- Modify: `apps/renderer/src/app/routes.test.ts`

- [ ] **Step 1: Write failing route contract tests**

Add cases that require complete context and round-trip encoded identifiers:

```ts
it("round-trips the canonical agent terminal route", () => {
  const hash = buildAgentTerminalHash("run /上海", "job ?7");
  expect(hash).toBe("#/runs/run%20%2F%E4%B8%8A%E6%B5%B7/terminal/job%20%3F7");
  expect(parseScopedRunRoute(hash, "project-1")).toEqual({
    mode: "terminal",
    context: { projectId: "project-1", runId: "run /上海", jobId: "job ?7" },
  });
});

it("rejects incomplete and malformed secondary context", () => {
  expect(parseScopedRunRoute("#/artifacts?projectId=p", "p")).toEqual({ mode: "invalid" });
  expect(parseScopedRunRoute("#/runs/%E0%A4%A/terminal/job", "p")).toEqual({ mode: "invalid" });
  expect(parseScopedRunRoute("#/audit?projectId=other&runId=r", "p")).toEqual({ mode: "invalid" });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd --workspace apps/renderer test -- routes.test.ts`

Expected: FAIL because `buildAgentTerminalHash` and `parseScopedRunRoute` do not exist.

- [ ] **Step 3: Implement strict parsing and builders**

Add the discriminated route and central builders:

```ts
export type RunContext = { projectId: string; runId: string; jobId?: string };
export type ScopedRunRoute =
  | { mode: "terminal"; context: RunContext & { jobId: string } }
  | { mode: "artifacts" | "gates" | "approvals" | "deployment" | "audit" | "recovery"; context: RunContext }
  | { mode: "invalid" }
  | { mode: "none" };

export const buildRunDetailHash = (runId: string) => `#/runs/${encodeURIComponent(runId)}`;
export const buildAgentTerminalHash = (runId: string, jobId: string) =>
  `#/runs/${encodeURIComponent(runId)}/terminal/${encodeURIComponent(jobId)}`;

export function buildRunModuleHash(
  module: Exclude<ScopedRunRoute["mode"], "terminal" | "invalid" | "none">,
  context: RunContext,
) {
  const query = new URLSearchParams({ projectId: context.projectId, runId: context.runId });
  return `#/${module}?${query.toString()}`;
}
```

`parseScopedRunRoute` must catch `decodeURIComponent` failures, reject blank identifiers, reject a query `projectId` that differs from the active project, and never synthesize values.

- [ ] **Step 4: Run route and navigation tests**

Run: `npm.cmd --workspace apps/renderer test -- routes.test.ts navigation.test.tsx`

Expected: PASS with no route fallback regressions.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- apps/renderer/src/app/routes.ts apps/renderer/src/app/routes.test.ts
git commit -m "feat: define scoped run child routes"
```

### Task 2: Runtime Scoped Ownership for Agents, Terminals, and Deployments

**Files:**
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `runtime/src/workflow_platform/governance/audit.py`
- Modify: `runtime/src/workflow_platform/persistence/repositories.py`
- Modify: `runtime/tests/test_runtime_service.py`
- Modify: `runtime/tests/test_api.py`

- [ ] **Step 1: Write failing service and API ownership tests**

Create project A/Run A and project B/Run B, then assert both Run and child ownership:

```python
def test_scoped_agent_terminal_and_deployment_reads_hide_cross_project_children(runtime):
    project_a, run_a = create_scoped_run(runtime, "project-a")
    project_b, run_b = create_scoped_run(runtime, "project-b")
    job_b = create_agent_job(runtime, run_b)

    with pytest.raises(RuntimeContractError) as cross_project:
        runtime.get_scoped_agent_job(project_a, run_b, job_b["id"])
    assert cross_project.value.code == "RUN_NOT_FOUND_IN_PROJECT"

    with pytest.raises(KeyError):
        runtime.get_scoped_agent_job(project_a, run_a, job_b["id"])
```

API tests must cover list/get/output/cancel/checkpoints/interactive Agent operations, terminal list/output/stop/evidence, and deployment list/get/output/cancel under the project prefix.

- [ ] **Step 2: Run the focused tests and verify RED**

Run from `runtime`: `python -m pytest tests/test_runtime_service.py tests/test_api.py -k "scoped and (agent or terminal or deployment)" -q --basetemp=.pytest-phase4-task2-red`

Expected: FAIL because scoped read/follow-up methods and routes are missing.

- [ ] **Step 3: Implement service guards and scoped methods**

Use one ownership entry point and child checks:

```python
from collections.abc import Callable

def _require_scoped_child(
    self,
    project_id: str,
    run_id: str,
    child_id: str,
    load: Callable[[str], dict | None],
    *,
    kind: str,
) -> dict:
    self.get_scoped_run(project_id, run_id)
    child = load(child_id)
    if child is None or child.get("runId") != run_id:
        raise KeyError(f"{kind} not found: {child_id}")
    return child

def get_scoped_agent_job(self, project_id: str, run_id: str, job_id: str) -> dict:
    return self._require_scoped_child(
        project_id, run_id, job_id, self._agent_jobs.get, kind="Agent job"
    )
```

Scoped list methods call `get_scoped_run` before repository access. Scoped output methods call their scoped parent getter before reading output. Mutation methods accept required `project_id` and invoke scoped lookup plus existing actor/lease/lifecycle rules.

- [ ] **Step 4: Add every project-prefixed route in this resource group**

Use encoded FastAPI path parameters through the existing request models:

```python
@application.get("/projects/{project_id}/runs/{run_id}/agents/{job_id}/output")
def list_project_agent_output(
    project_id: str, run_id: str, job_id: str, afterSequence: int = 0
) -> list[dict[str, Any]]:
    return _require_service(runtime_service).list_scoped_agent_output(
        project_id, run_id, job_id, after_sequence=afterSequence
    )
```

Register explicit project-prefixed handlers for Agent list/get/output/cancel/checkpoint/interactive-session operations, terminal list/output/stop/command-decision/evidence operations, and deployment list/get/output/cancel operations. Each handler passes both path IDs into its scoped service method and translates `RuntimeContractError`, `KeyError`, and `ValueError` through the existing typed error helpers.

- [ ] **Step 5: Run the focused Runtime tests**

Run from `runtime`: `python -m pytest tests/test_runtime_service.py tests/test_api.py -k "scoped and (agent or terminal or deployment)" -q --basetemp=.pytest-phase4-task2-green`

Expected: PASS, including cross-project and cross-Run child cases.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- runtime/src/workflow_platform/runtime_service.py runtime/src/workflow_platform/api/app.py runtime/tests/test_runtime_service.py runtime/tests/test_api.py
git commit -m "feat: scope execution child resources"
```

### Task 3: Runtime Scoped Artifacts, Governance, Audit, and Recovery

**Files:**
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `runtime/tests/test_runtime_service.py`
- Modify: `runtime/tests/test_api.py`

- [ ] **Step 1: Write failing resource-matrix tests**

Parameterize read isolation and add explicit write cases:

```python
@pytest.mark.parametrize("resource_path", [
    "artifacts", "gates", "approvals", "timeline", "audit-records", "recovery-diagnostics",
])
def test_run_child_reads_require_project_ownership(client, seeded_runs, resource_path):
    project_a, _, run_b = seeded_runs
    response = client.get(f"/projects/{project_a}/runs/{run_b}/{resource_path}")
    assert response.status_code == 404
    assert response.json()["code"] == "RUN_NOT_FOUND_IN_PROJECT"
```

Add cross-Run artifact IDs, archived write rejection, gate verifier actor, approval actor/revision, and recovery child ownership tests.

- [ ] **Step 2: Run the focused tests and verify RED**

Run from `runtime`: `python -m pytest tests/test_runtime_service.py tests/test_api.py -k "scoped and (artifact or gate or approval or audit or recovery or timeline)" -q --basetemp=.pytest-phase4-task3-red`

Expected: FAIL on missing project-prefixed resource routes.

- [ ] **Step 3: Add scoped service methods and API routes**

The audit query must prove Run attribution in SQL instead of trusting an arbitrary client resource filter or filtering a truncated global result:

```python
def list_scoped_audit_records(
    self, project_id: str, run_id: str, *, action: str | None = None, limit: int = 100
) -> list[dict]:
    self.get_scoped_run(project_id, run_id)
    return self._audit.list(action=action, run_id=run_id, limit=limit)
```

Extend `AuditLog.list` and `AuditRecordRepository.list` with an internal `run_id` argument. The repository adds this bounded condition and values:

```python
if run_id:
    conditions.append("(resource = ? OR json_extract(detail_json, '$.runId') = ?)")
    values.extend((f"run:{run_id}", run_id))
```

All Run-owned audit writers in the migrated operations must include `detail["runId"]`. Artifact, gate, approval, timeline/report/evidence, and recovery methods begin with `get_scoped_run`; child IDs are checked beneath the Run. Writes retain expected revision, trusted actor, allowed action, archive, and lease checks.

- [ ] **Step 4: Remove migrated unscoped writable routes and compatibility reads**

Delete handlers below `/runs/{run_id}/...` for migrated resources. Assert their absence:

```python
def test_unscoped_run_child_writes_are_not_registered(client):
    assert client.post("/runs/run-1/gates", json={}).status_code == 404
    assert client.post("/runs/run-1/approvals/node-1/decide", json={}).status_code == 404
    assert client.post("/runs/run-1/rebuild-projection", json={}).status_code == 404
```

Legacy transition and node-completion writes must not remain as alternate authorization paths once scoped actions cover them.

- [ ] **Step 5: Run focused and relevant Runtime suites**

Run from `runtime`: `python -m pytest tests/test_runtime_service.py tests/test_api.py tests/test_governance.py tests/test_terminal_sessions.py -q --basetemp=.pytest-phase4-task3-green`

Expected: PASS with no old-route expectations remaining.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- runtime/src/workflow_platform/runtime_service.py runtime/src/workflow_platform/api/app.py runtime/src/workflow_platform/governance/audit.py runtime/src/workflow_platform/persistence/repositories.py runtime/tests/test_runtime_service.py runtime/tests/test_api.py
git commit -m "feat: scope run governance and recovery api"
```

### Task 4: Scoped Renderer Runtime Client

**Files:**
- Modify: `apps/renderer/src/app/runtimeClient.ts`
- Modify: `apps/renderer/src/app/runtimeClient.test.ts`

- [ ] **Step 1: Write failing client URL, body, and abort tests**

```ts
it("encodes scoped child paths and forwards AbortSignal", async () => {
  const signal = new AbortController().signal;
  await client.listAgentOutput("project /一", "run ?2", "job #3", 7, signal);
  expect(fetch).toHaveBeenCalledWith(
    expect.stringContaining(
      "/projects/project%20%2F%E4%B8%80/runs/run%20%3F2/agents/job%20%233/output?afterSequence=7",
    ),
    expect.objectContaining({ signal }),
  );
});
```

Cover every resource family, exact actor/revision bodies, and report/evidence return types.

- [ ] **Step 2: Run focused client tests and verify RED**

Run: `npm.cmd --workspace apps/renderer test -- runtimeClient.test.ts`

Expected: FAIL because methods do not take `projectId` or request options.

- [ ] **Step 3: Add a scoped prefix helper and migrate methods**

```ts
const scopedRunPath = (projectId: string, runId: string) =>
  `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`;

listAgentOutput: (
  projectId: string,
  runId: string,
  jobId: string,
  afterSequence = 0,
  signal?: AbortSignal,
) => request<AgentOutputSummary[]>(
  apiBaseUrl,
  `${scopedRunPath(projectId, runId)}/agents/${encodeURIComponent(jobId)}/output?afterSequence=${afterSequence}`,
  { method: "GET", signal },
),
```

All Run child identifiers use `encodeURIComponent`. Extend the shared request helper without changing existing body semantics. Remove client methods that target deleted unscoped routes.

- [ ] **Step 4: Run client and TypeScript tests**

Run: `npm.cmd --workspace apps/renderer test -- runtimeClient.test.ts`

Expected: PASS and no fetch expectation contains an unscoped writable Run child path.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- apps/renderer/src/app/runtimeClient.ts apps/renderer/src/app/runtimeClient.test.ts
git commit -m "feat: add scoped run child client"
```

## 4B: Secondary Page Migration

### Task 5: Common Isolated Page State

**Files:**
- Create: `apps/renderer/src/features/runs/scopedPageModel.ts`
- Create: `apps/renderer/src/features/runs/scopedPageModel.test.ts`

- [ ] **Step 1: Write reducer tests for context replacement and stale responses**

```ts
it("rejects a response from the previous Run generation", () => {
  const loadingB = reduceScopedPage(readyA, {
    type: "load-started", contextKey: "project:run-b", generation: 2, retainData: false,
  });
  const stale = reduceScopedPage(loadingB, {
    type: "load-succeeded", contextKey: "project:run-a", generation: 1, data: ["A"], at: NOW,
  });
  expect(stale).toBe(loadingB);
});

it("retains trusted data when a refresh fails", () => {
  const failed = reduceScopedPage(refreshing, {
    type: "load-failed", contextKey: KEY, generation: 3, error: networkError,
  });
  expect(failed.data).toEqual(existingData);
  expect(failed.phase).toBe("ready");
  expect(failed.stale).toBe(true);
});
```

- [ ] **Step 2: Run the reducer test and verify RED**

Run: `npm.cmd --workspace apps/renderer test -- scopedPageModel.test.ts`

Expected: FAIL because the model file does not exist.

- [ ] **Step 3: Implement the pure state model**

```ts
export type ScopedPageState<T> = {
  data: T | null;
  phase: "loading" | "ready" | "refreshing" | "acting" | "not-found" | "maintenance" | "error";
  error: RuntimeClientError | null;
  contextKey: string;
  generation: number;
  lastRefreshedAt: string | null;
  stale: boolean;
  readOnly: boolean;
};

export const scopedContextKey = ({ projectId, runId, jobId }: RunContext) =>
  [projectId, runId, jobId ?? ""].join(":");
```

The reducer ignores mismatched context/generation, clears data on context replacement, retains data only for same-context refresh failure, maps 404 to `not-found`, 503 to `maintenance`, and archive errors to `readOnly` plus a refresh request.

- [ ] **Step 4: Run the model test**

Run: `npm.cmd --workspace apps/renderer test -- scopedPageModel.test.ts`

Expected: PASS for all transition cases.

- [ ] **Step 5: Commit Task 5**

```powershell
git add -- apps/renderer/src/features/runs/scopedPageModel.ts apps/renderer/src/features/runs/scopedPageModel.test.ts
git commit -m "feat: add isolated scoped page state"
```

### Task 6: Canonical Agent Terminal and Deployment Pages

**Files:**
- Modify: `apps/renderer/src/features/terminal/TerminalPage.tsx`
- Modify: `apps/renderer/src/features/terminal/TerminalPage.test.tsx`
- Create: `apps/renderer/src/features/deployments/DeploymentPage.tsx`
- Create: `apps/renderer/src/features/deployments/DeploymentPage.test.tsx`

- [ ] **Step 1: Write failing terminal context and cancellation tests**

Render with `{ projectId, runId, jobId }`, scoped loaders, and a return callback. Assert initial calls include all IDs, an unknown job displays not found without selecting another job, unmount aborts the request, hidden documents pause polling, and the return link targets the exact Run.

```tsx
render(<TerminalPage context={context} loadJob={loadJob} loadOutput={loadOutput} />);
await waitFor(() => expect(loadJob).toHaveBeenCalledWith(context, expect.any(AbortSignal)));
expect(screen.getByRole("link", { name: /返回 Run/ })).toHaveAttribute("href", "#/runs/run-1");
```

- [ ] **Step 2: Write failing deployment isolation tests**

Assert scoped list/output requests, sequence cursor append, cross-context stale rejection, cancel refresh, archived read-only behavior, and same-Run return link.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm.cmd --workspace apps/renderer test -- TerminalPage.test.tsx DeploymentPage.test.tsx`

Expected: FAIL on the new props and missing Deployment page.

- [ ] **Step 4: Implement page-owned scoped state**

Terminal loads exactly `jobId` before binding desktop operations. Its effect follows this lifecycle:

```ts
useEffect(() => {
  const controller = new AbortController();
  const generation = nextGeneration.current++;
  dispatch({ type: "load-started", contextKey, generation, retainData: false });
  void loadJob(context, controller.signal)
    .then((job) => dispatch({ type: "load-succeeded", contextKey, generation, data: job, at: now() }))
    .catch((error) => {
      if (!controller.signal.aborted) dispatch({ type: "load-failed", contextKey, generation, error });
    });
  return () => controller.abort();
}, [contextKey, loadJob]);
```

Deployment owns its list, selected deployment, output sequence, polling timer, and cancellation. Both pages render explicit loading/not-found/maintenance/error states and hide writes when `readOnly`.

- [ ] **Step 5: Run focused page tests**

Run: `npm.cmd --workspace apps/renderer test -- TerminalPage.test.tsx DeploymentPage.test.tsx`

Expected: PASS with fake timers drained and no stale state updates.

- [ ] **Step 6: Commit Task 6**

```powershell
git add -- apps/renderer/src/features/terminal apps/renderer/src/features/deployments
git commit -m "feat: isolate scoped execution pages"
```

### Task 7: Scoped Artifact Page

**Files:**
- Modify: `apps/renderer/src/features/artifacts/ArtifactsPage.tsx`
- Modify: `apps/renderer/src/features/artifacts/ArtifactsPage.test.tsx`

- [ ] **Step 1: Write failing page-owned state tests**

Cover scoped initial load, preview and consumer stale-response rejection, archived read-only controls, revision conflict refresh with form retention, retained data on refresh failure, and return navigation.

```tsx
render(<ArtifactsPage context={context} client={scopedClient} />);
await waitFor(() => expect(scopedClient.listArtifacts).toHaveBeenCalledWith(context, expect.any(AbortSignal)));
fireEvent.click(screen.getByRole("button", { name: /预览 artifact-a/ }));
rerender(<ArtifactsPage context={otherContext} client={scopedClient} />);
resolveOldPreview(oldPreview);
expect(screen.queryByText(oldPreview.content)).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the artifact test and verify RED**

Run: `npm.cmd --workspace apps/renderer test -- ArtifactsPage.test.tsx`

Expected: FAIL because artifacts and callbacks are still supplied by `App` global state.

- [ ] **Step 3: Move transport and async ownership into the page**

Replace `state`, `artifacts`, `runs`, and preview callbacks with `context`, typed scoped client functions, actor, and `now`. Keep comparison as local presentation state. Load overview only for projection/revision-bound controls; after a write, replace returned projection and refresh inventory.

- [ ] **Step 4: Run artifact and model tests**

Run: `npm.cmd --workspace apps/renderer test -- ArtifactsPage.test.tsx artifactDiff.test.ts scopedPageModel.test.ts`

Expected: PASS with no dependency on a global active Run.

- [ ] **Step 5: Commit Task 7**

```powershell
git add -- apps/renderer/src/features/artifacts/ArtifactsPage.tsx apps/renderer/src/features/artifacts/ArtifactsPage.test.tsx
git commit -m "feat: isolate scoped artifact state"
```

### Task 8: Scoped Gate and Approval Pages

**Files:**
- Modify: `apps/renderer/src/features/gates/GatesPage.tsx`
- Modify: `apps/renderer/src/features/gates/GatesPage.test.tsx`
- Modify: `apps/renderer/src/features/approvals/ApprovalInbox.tsx`
- Modify: `apps/renderer/src/features/approvals/ApprovalInbox.test.tsx`

- [ ] **Step 1: Write failing scoped authorization tests**

For each page, assert its own overview/list load, `allowedActions`-only controls, exact action ID submission, trusted injected actor, archive read-only behavior, conflict refresh, cancellation, and same-Run return.

```tsx
expect(screen.queryByRole("button", { name: "批准" })).not.toBeInTheDocument();
resolveOverview(withAllowedAction("approve:node-1"));
fireEvent.click(await screen.findByRole("button", { name: "批准" }));
expect(executeAction).toHaveBeenCalledWith(
  context, expect.objectContaining({ actionId: "approve:node-1", expectedRevision: "7" }), expect.any(AbortSignal),
);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd --workspace apps/renderer test -- GatesPage.test.tsx ApprovalInbox.test.tsx`

Expected: FAIL because both components consume `RuntimeWorkbenchState`.

- [ ] **Step 3: Implement isolated controllers**

Replace `state` with page-owned `{ overview, records }`. Match controls by action ID/event presentation but never construct availability. Gate waiver sends only the action ID, expected revision, trusted verifier actor, and reason payload; it never accepts `gateId` from the page. Approval sends the authorized action ID and local comment. Refresh both overview and records after success or conflict.

- [ ] **Step 4: Run focused tests**

Run: `npm.cmd --workspace apps/renderer test -- GatesPage.test.tsx ApprovalInbox.test.tsx scopedPageModel.test.ts`

Expected: PASS and archived pages expose no mutation buttons.

- [ ] **Step 5: Commit Task 8**

```powershell
git add -- apps/renderer/src/features/gates apps/renderer/src/features/approvals
git commit -m "feat: isolate scoped governance pages"
```

### Task 9: Scoped Audit and Recovery Pages

**Files:**
- Modify: `apps/renderer/src/features/audit/AuditPage.tsx`
- Modify: `apps/renderer/src/features/audit/AuditPage.test.tsx`
- Modify: `apps/renderer/src/features/recovery/RecoveryPage.tsx`
- Modify: `apps/renderer/src/features/recovery/RecoveryPage.test.tsx`

- [ ] **Step 1: Write failing scoped audit/recovery tests**

Audit asserts every filter reload carries the same context and late results from an old filter or Run are ignored. Recovery asserts diagnostics load, scoped rebuild/cleanup/checkpoint operations, refresh after success, trusted actor transport, archived read-only state, and same-Run return.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd --workspace apps/renderer test -- AuditPage.test.tsx RecoveryPage.test.tsx`

Expected: FAIL because audit receives a global record collection and recovery receives global projection/diagnostics.

- [ ] **Step 3: Implement page-owned loaders and actions**

Use separate generations for audit list/filter and recovery diagnostics. Recovery state uses the URL Run ID for identity, not `projection.runId`. Successful actions refresh diagnostics and overview; a refresh failure retains the last trusted diagnostics.

```ts
const returnHref = buildRunDetailHash(context.runId);
const canMutate = state.phase === "ready" && !state.readOnly;
```

- [ ] **Step 4: Run focused tests**

Run: `npm.cmd --workspace apps/renderer test -- AuditPage.test.tsx RecoveryPage.test.tsx scopedPageModel.test.ts`

Expected: PASS with no global Run state props.

- [ ] **Step 5: Commit Task 9**

```powershell
git add -- apps/renderer/src/features/audit apps/renderer/src/features/recovery
git commit -m "feat: isolate scoped audit and recovery"
```

### Task 10: App Composition and Legacy State Removal

**Files:**
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/App.test.tsx`
- Modify: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Modify: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`

- [ ] **Step 1: Write failing direct-route integration tests**

Start App at every scoped hash and assert the page receives URL context. For malformed/missing context, assert explicit invalid-link UI and zero Run child requests. For Run A then Run B, resolve A late and assert B remains visible. Assert no calls target `/runs/{runId}/...` child routes.

- [ ] **Step 2: Write failing detail-link tests**

Assert all secondary links encode `projectId/runId`, Agent jobs link to `#/runs/:runId/terminal/:jobId`, and return links identify the same Run.

- [ ] **Step 3: Run integration tests and verify RED**

Run: `npm.cmd --workspace apps/renderer test -- App.test.tsx RunDetailPage.test.tsx`

Expected: FAIL because App still derives terminal and secondary state from global projection and Phase 3 links lack canonical `jobId`.

- [ ] **Step 4: Replace global orchestration with scoped composition**

Parse once and render by discriminant:

```tsx
const scopedRoute = parseScopedRunRoute(window.location.hash, projectId);

if (scopedRoute.mode === "invalid") {
  return <InvalidRunContext onReturn={() => { window.location.hash = "#/runs"; }} />;
}

if (scopedRoute.mode === "artifacts") {
  return <ArtifactsPage key={scopedContextKey(scopedRoute.context)} context={scopedRoute.context} client={client} />;
}
```

Delete migrated `useState` collections, effects, and handlers for global Agent output, terminal sessions, deployments, artifacts, approvals, gates, audit, and recovery. Keep only unrelated compatibility state until its owning phase removes it. Update Run detail link builders and show canonical terminal links for concrete Agent jobs; do not create a jobless terminal URL.

Delete `restoreWorkbenchState`'s Run child fan-out and its callers. Workspace restoration may restore API URL/project identity and then let the active URL-owned page load its own data; it must not call `getProjection`, `getTimeline`, `listArtifacts`, `listApprovals`, `listGates`, or `listAgentJobs` from a saved `runId`.

- [ ] **Step 5: Run App, route, and secondary-page tests**

Run: `npm.cmd --workspace apps/renderer test -- App.test.tsx RunDetailPage.test.tsx routes.test.ts TerminalPage.test.tsx ArtifactsPage.test.tsx GatesPage.test.tsx ApprovalInbox.test.tsx AuditPage.test.tsx RecoveryPage.test.tsx DeploymentPage.test.tsx`

Expected: PASS with no act warnings caused by leaked polling timers.

- [ ] **Step 6: Commit Task 10**

```powershell
git add -- apps/renderer/src/app/App.tsx apps/renderer/src/app/App.test.tsx apps/renderer/src/features/runs/RunDetailPage.tsx apps/renderer/src/features/runs/RunDetailPage.test.tsx
git commit -m "feat: route child pages through run context"
```

## 4C: Project Overview and End-to-End Closure

### Task 11: Project Run Overview

**Files:**
- Modify: `apps/renderer/src/features/projects/ProjectDashboard.tsx`
- Modify: `apps/renderer/src/features/projects/ProjectDashboard.test.tsx`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/App.test.tsx`
- Modify: `apps/renderer/src/app/styles.css`

- [ ] **Step 1: Write failing summary-only project tests**

Assert exact active count across multiple cursor pages, recent order, bounded project list requests, Run-list link, Run detail links, archive read-only state, and worktree guidance. Assert no projection/artifact/terminal/Agent request occurs per recent row.

```tsx
expect(screen.getByText("2 个活动 Run")).toBeInTheDocument();
expect(screen.getAllByRole("link", { name: /查看 Run/ })[0]).toHaveAttribute("href", "#/runs/run-new");
expect(client.loadRunOverview).not.toHaveBeenCalled();
expect(client.listProjectRuns).toHaveBeenCalledWith(
  "project-1",
  expect.objectContaining({ status: ["CREATED", "IN_PROGRESS", "REVIEWING", "BLOCKED", "PAUSED"], limit: 100 }),
  expect.any(AbortSignal),
);
```

- [ ] **Step 2: Run project tests and verify RED**

Run: `npm.cmd --workspace apps/renderer test -- ProjectDashboard.test.tsx App.test.tsx`

Expected: FAIL because the project page still displays a single global projection status.

- [ ] **Step 3: Implement bounded summary loading and layout**

App makes one bounded recent query and follows opaque cursors for bounded active-status pages until `nextCursor` is null. It injects `recentRuns` and the exact accumulated `activeRunCount`; it never parses or constructs a cursor. ProjectDashboard renders an unframed compact list. The worktree guidance links to the existing Git workspace controls and does not add Phase 5 ranking logic.

- [ ] **Step 4: Run project and list tests**

Run: `npm.cmd --workspace apps/renderer test -- ProjectDashboard.test.tsx App.test.tsx RunListPage.test.tsx`

Expected: PASS; test spies show one recent query plus the required active cursor pages and zero per-row detail calls.

- [ ] **Step 5: Commit Task 11**

```powershell
git add -- apps/renderer/src/features/projects/ProjectDashboard.tsx apps/renderer/src/features/projects/ProjectDashboard.test.tsx apps/renderer/src/app/App.tsx apps/renderer/src/app/App.test.tsx apps/renderer/src/app/styles.css
git commit -m "feat: add project run overview"
```

### Task 12: Phase 4 E2E, Removal Audit, and Full Verification

**Files:**
- Create: `tests/e2e/run-multi-run-phase4.spec.ts`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Modify: `apps/renderer/src/features/terminal/TerminalPage.tsx`
- Modify: `apps/renderer/src/features/artifacts/ArtifactsPage.tsx`
- Modify: `apps/renderer/src/app/styles.css`

- [ ] **Step 1: Write failing terminal and artifact round-trip E2E tests**

Seed two projects and Runs. Navigate Run A detail -> Agent terminal -> Run A detail and Run B detail -> artifacts -> Run B detail. Assert the URL and visible Run title never cross. Add desktop and narrow viewport overflow checks.

```ts
await page.getByRole("link", { name: /Agent terminal/ }).click();
await expect(page).toHaveURL(/#\/runs\/run-a\/terminal\/job-a$/);
await page.getByRole("link", { name: /返回 Run/ }).click();
await expect(page).toHaveURL(/#\/runs\/run-a$/);
```

- [ ] **Step 2: Run E2E and verify RED**

Run: `npx playwright test tests/e2e/run-multi-run-phase4.spec.ts`

Expected: FAIL until the new fixture/API/navigation path is wired end to end.

- [ ] **Step 3: Complete the tested navigation and geometry integration**

Use `buildAgentTerminalHash`, `buildRunModuleHash`, and `buildRunDetailHash` in RunDetailPage, TerminalPage, and ArtifactsPage. App must render the strict parsed route without reading saved/global projection state. Add stable responsive constraints to the affected selectors:

```css
.scoped-run-page {
  min-width: 0;
  overflow-x: clip;
}

.scoped-run-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

@media (max-width: 720px) {
  .scoped-run-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

The E2E setup creates its projects, Runs, Agent job, and artifact through scoped Runtime API requests, then uses returned IDs. It must not depend on a persisted Run from another test.

- [ ] **Step 4: Run the E2E test again**

Run: `npx playwright test tests/e2e/run-multi-run-phase4.spec.ts`

Expected: PASS at configured desktop and narrow viewports with no horizontal overflow or overlapping controls.

- [ ] **Step 5: Audit removal and source-contract coverage**

Run:

```powershell
rg -n '@application\.(get|post|put|patch|delete)\("/runs/\{run_id\}/(agents|terminals|deployments|artifacts|approvals|gates|timeline|report|evidence-package|recovery|rebuild-projection|nodes)' runtime/src/workflow_platform/api/app.py
rg -n '`/runs/\$\{runId\}/(agents|terminals|deployments|artifacts|approvals|gates|timeline|report|evidence-package|recovery|rebuild-projection|nodes)' apps/renderer/src/app/runtimeClient.ts
rg -n 'state\?\.projection|activeRunId|artifactInventory|terminalSessions|recoveryDiagnostics|auditRecords' apps/renderer/src/features/terminal apps/renderer/src/features/artifacts apps/renderer/src/features/gates apps/renderer/src/features/approvals apps/renderer/src/features/audit apps/renderer/src/features/recovery apps/renderer/src/features/deployments apps/renderer/src/app/App.tsx
```

Expected: the first two searches return no migrated unscoped routes; the third returns no Run selection or migrated child collection used by scoped pages. Review every Phase 4 design completion criterion against a test or search result.

- [ ] **Step 6: Run full Runtime verification**

Run from `runtime`: `python -m pytest -q --basetemp=.pytest-phase4-final`

Expected: all Runtime tests PASS; only documented pre-existing warnings are permitted.

- [ ] **Step 7: Run full Renderer verification and production build**

Run: `npm.cmd --workspace apps/renderer test`

Expected: all Renderer tests PASS.

Run: `npm.cmd --workspace apps/renderer run build`

Expected: TypeScript and Vite build PASS; the pre-existing chunk-size warning may remain.

- [ ] **Step 8: Request final code review and resolve findings**

Use `superpowers:requesting-code-review`. Resolve all Critical and Important findings with a fresh red/green test and an independent fix commit. Re-run Steps 5-7 after the last fix.

- [ ] **Step 9: Commit the E2E and any verified integration corrections**

```powershell
git add -- tests/e2e/run-multi-run-phase4.spec.ts
git commit -m "test: verify scoped run child navigation"
```

Do not stage `docs/run-multi-run-rearchitecture.zh-CN.md` or any pytest temporary directory.

## Phase 4 Exit Gate

Phase 4 may be declared complete only when:

- all Tasks 1-12 have independent commits;
- every design completion criterion has direct evidence;
- unscoped writable Run child routes and migrated reads are absent;
- Runtime full suite, Renderer full suite, production build, and Phase 4 E2E pass from fresh commands;
- final review has no open Critical or Important findings;
- the source requirements document remains untracked and pytest temporary directories remain untouched.
