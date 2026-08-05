# Run Multi-Run Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the compatibility Run dashboard at `#/runs/:runId` with an isolated project-scoped detail page driven by the immutable Run overview and Runtime-authorized actions.

**Architecture:** The Runtime returns one canonical `RunOverview` containing metadata, immutable workflow snapshot, projection, workspace lease, and activity. `RunDetailPage` owns a reducer-backed request/action lifecycle and reuses the existing progress graph and guidance presentation. `App` provides only project/route context and stable scoped transport callbacks; no legacy global projection or unscoped Run request participates in the detail route.

**Tech Stack:** TypeScript contracts, Python 3.11, FastAPI, SQLite, React 18, Vitest, Testing Library, native Fetch, existing React Flow and CSS design language.

---

## File Map

- Modify `packages/contracts/src/rpc.ts`, `contracts.test.ts`, and `contracts.typecheck.ts`: define canonical Run record, overview, activity, and action response shapes.
- Modify `runtime/src/workflow_platform/runtime_service.py`, `api/app.py`, and focused Runtime tests: complete overview aggregation and action response envelope.
- Modify `apps/renderer/src/app/runtimeClient.ts` and `runtimeClient.test.ts`: add scoped overview/action methods with cancellation and exact request bodies.
- Create `apps/renderer/src/features/runs/runDetailModel.ts` and `runDetailModel.test.ts`: pure detail load, refresh, action, error, and selection transitions.
- Create `apps/renderer/src/features/runs/RunDetailPage.tsx` and `RunDetailPage.test.tsx`: first-screen detail UI, polling, actions, and contextual secondary links.
- Modify `apps/renderer/src/features/runs/runWorkbenchModel.ts` and its test: expose edge-condition-aware successor presentation and preserve action IDs.
- Modify `apps/renderer/src/app/App.tsx`, `App.test.tsx`, and `styles.css`: replace compatibility dashboard routing and suppress legacy detail effects.

### Task 1: Canonical Run Overview Contract

**Files:**
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/contracts.test.ts`
- Modify: `packages/contracts/src/contracts.typecheck.ts`

- [ ] **Step 1: Write failing contract tests**

Import `RunRecord`, `RunActivitySummary`, and `RunOverview`. Construct an overview whose workflow snapshot has a different name from the current editable workflow fixture and assert all fields remain available:

```ts
const overview: RunOverview = {
  run: {
    id: "run-1",
    projectId: "project-1",
    workflowVersionId: "version-1",
    workflowSnapshot: workflow,
    title: "Release",
    context: { taskGoal: "Ship", parameters: { dryRun: true } },
    executionWorkspace: "G:\\Project\\release",
    workspaceMode: "write",
    status: "IN_PROGRESS",
    createdAt: "2026-08-06T00:00:00Z",
    updatedAt: "2026-08-06T00:01:00Z",
  },
  projection,
  workflow,
  workspace: lease,
  activity: { activeAgentCount: 1, activeDeploymentCount: 0, lastEventAt: "2026-08-06T00:01:00Z" },
};
expect(overview.workflow).toBe(overview.run.workflowSnapshot);
```

Add `@ts-expect-error` cases for a missing `workflow`, non-numeric activity counts, and an action response without `emittedEvents`.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd --workspace packages/contracts test`

Expected: FAIL because the overview types are absent.

- [ ] **Step 3: Implement the shared types**

Add to `rpc.ts` after `WorkspaceLease`:

```ts
export type RunRecord = {
  id: string;
  projectId: string;
  workflowVersionId: string;
  workflowSnapshot: WorkflowDefinition;
  title: string;
  context: { taskGoal?: string; parameters?: Record<string, unknown> };
  executionWorkspace: string;
  workspaceMode: WorkspaceMode;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
};

export type RunActivitySummary = {
  activeAgentCount: number;
  activeDeploymentCount: number;
  lastEventAt: string | null;
};

export type RunOverview = {
  run: RunRecord;
  projection: RunProjection;
  workflow: WorkflowDefinition;
  workspace: WorkspaceLease | null;
  activity: RunActivitySummary;
};
```

Keep `ExecuteRunActionResponse = { projection, emittedEvents }` as the one public action response.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd --workspace packages/contracts test`

Expected: all contract tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/contracts/src/rpc.ts packages/contracts/src/contracts.test.ts packages/contracts/src/contracts.typecheck.ts
git commit -m "feat: define scoped run overview contract"
```

### Task 2: Runtime Overview and Action Envelope

**Files:**
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `runtime/tests/test_runtime_service.py`
- Modify: `runtime/tests/test_api.py`
- Modify: `runtime/tests/test_multi_run_phase0_contract.py`

- [ ] **Step 1: Write failing service and API tests**

Create a scoped Run. Use `AgentJobRepository.create(..., status="RUNNING")` and `DeploymentRepository.create(...)` against the same test database to add one active job and one queued deployment for that Run. The Run creation event supplies `lastEventAt`. Assert:

```py
overview = service.get_scoped_overview(project_id, run_id)
assert overview["run"]["id"] == run_id
assert overview["workflow"] == overview["run"]["workflowSnapshot"]
assert overview["workspace"]["runId"] == run_id
assert overview["activity"] == {
    "activeAgentCount": 1,
    "activeDeploymentCount": 1,
    "lastEventAt": NOW,
}
```

At the API layer assert `POST /projects/{project}/runs/{run}/actions` returns exactly `projection` plus `emittedEvents`, and the first emitted event revision equals the replacement projection revision. Retain cross-project 404 and revision-conflict no-write assertions.

- [ ] **Step 2: Verify RED**

Run from `runtime`: `python -m pytest tests/test_runtime_service.py tests/test_api.py tests/test_multi_run_phase0_contract.py -k "overview or scoped_action" -q`

Expected: FAIL because overview lacks workflow/activity and action returns a bare projection.

- [ ] **Step 3: Complete overview aggregation**

In `get_scoped_overview`, use `run["workflowSnapshot"]` directly. Count active jobs with statuses `QUEUED` or `RUNNING`; count deployments with statuses `QUEUED` or `RUNNING`; read the last Run event from `RunEventRepository.list_for_run(run_id)`:

```py
events = self._events.list_for_run(run_id)
activity = {
    "activeAgentCount": sum(job["status"] in {"QUEUED", "RUNNING"} for job in self._agent_jobs.list_for_run(run_id)),
    "activeDeploymentCount": sum(item["status"] in {"QUEUED", "RUNNING"} for item in self._deployments.list_for_run(run_id)),
    "lastEventAt": events[-1].createdAt if events else None,
}
return {
    "run": run,
    "projection": projection.model_dump(),
    "workflow": run["workflowSnapshot"],
    "workspace": lease,
    "activity": activity,
}
```

- [ ] **Step 4: Return the canonical action envelope**

Capture the current revision before transition, call `execute_scoped_action`, then return only events emitted after that revision:

```py
previous_revision = request.expectedRevision
projection = service.execute_scoped_action(...)
emitted = [event.model_dump() for event in service.list_events(run_id) if int(event.revision) > int(previous_revision)]
return {"projection": projection.model_dump(), "emittedEvents": emitted}
```

After `execute_scoped_action` has validated project ownership and completed, use the existing `service.timeline(run_id)` result and select events whose numeric revision is greater than `previous_revision`.

- [ ] **Step 5: Verify GREEN and broader Runtime API**

Run from `runtime`: `python -m pytest tests/test_runtime_service.py tests/test_api.py tests/test_multi_run_phase0_contract.py -q`

Expected: selected Runtime suites PASS.

- [ ] **Step 6: Commit**

```powershell
git add runtime/src/workflow_platform/runtime_service.py runtime/src/workflow_platform/api/app.py runtime/tests/test_runtime_service.py runtime/tests/test_api.py runtime/tests/test_multi_run_phase0_contract.py
git commit -m "feat: complete scoped run overview api"
```

### Task 3: Scoped Renderer Detail Client

**Files:**
- Modify: `apps/renderer/src/app/runtimeClient.ts`
- Modify: `apps/renderer/src/app/runtimeClient.test.ts`

- [ ] **Step 1: Write failing client tests**

Assert exact encoded URLs and bodies for both browser Fetch and Desktop bridge:

```ts
await client.getProjectRunOverview("project/a", "run/one", signal);
expect(requestPath).toBe("/projects/project%2Fa/runs/run%2Fone/overview");

await client.executeProjectRunAction("project/a", "run/one", {
  actionId: "complete:plan",
  expectedRevision: "7",
  actor,
  payload: { artifactPath: "docs/plan.md" },
}, signal);
```

Assert method `POST`, no idempotency header, exact JSON body, abort propagation for browser Fetch, and preservation of `RUN_NOT_FOUND_IN_PROJECT`, `REVISION_CONFLICT`, `RUN_ARCHIVED`, and maintenance envelopes.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd --workspace apps/renderer test -- src/app/runtimeClient.test.ts`

Expected: FAIL because scoped detail methods are absent.

- [ ] **Step 3: Implement scoped detail methods**

Import `ExecuteRunActionRequest`, `ExecuteRunActionResponse`, and `RunOverview`, then add:

```ts
getProjectRunOverview: (projectId: string, runId: string, signal?: AbortSignal) =>
  request<RunOverview>(apiBaseUrl,
    `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/overview`,
    { method: "GET", signal }),

executeProjectRunAction: (
  projectId: string,
  runId: string,
  body: ExecuteRunActionRequest,
  signal?: AbortSignal,
) => request<ExecuteRunActionResponse>(apiBaseUrl,
  `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/actions`,
  { method: "POST", body, signal }),
```

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd --workspace apps/renderer test -- src/app/runtimeClient.test.ts`

Expected: all client tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/renderer/src/app/runtimeClient.ts apps/renderer/src/app/runtimeClient.test.ts
git commit -m "feat: add scoped run detail client"
```

### Task 4: Pure Run Detail State

**Files:**
- Create: `apps/renderer/src/features/runs/runDetailModel.ts`
- Create: `apps/renderer/src/features/runs/runDetailModel.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Cover initial request/success, refresh retaining overview, refresh failure retention, action start/success replacing projection, revision conflict retaining data with error, not-found, maintenance, selected-node changes, selected-node reset when a new overview no longer contains it, and stale generation identity:

```ts
expect(runDetailReducer(state, {
  type: "request-succeeded",
  kind: "refresh",
  generation: state.generation - 1,
  overview,
  refreshedAt: NOW,
})).toBe(state);
```

- [ ] **Step 2: Verify RED**

Run: `npm.cmd --workspace apps/renderer test -- src/features/runs/runDetailModel.test.ts`

Expected: FAIL because the model does not exist.

- [ ] **Step 3: Implement the reducer**

Export:

```ts
export type RunDetailPhase = "loading" | "ready" | "refreshing" | "acting" | "not-found" | "maintenance" | "error";
export type RunDetailState = {
  overview: RunOverview | null;
  phase: RunDetailPhase;
  selectedNodeId: string | null;
  lastRefreshedAt: string | null;
  error: RuntimeClientError | null;
  generation: number;
};
export function createRunDetailState(): RunDetailState;
export function runDetailReducer(state: RunDetailState, action: RunDetailAction): RunDetailState;
export function detailPollInterval(status: RunStatus | undefined): 2000 | 10000;
```

Map 404 `RUN_NOT_FOUND_IN_PROJECT` to `not-found`, 503 maintenance to `maintenance` only without cached overview, and all cached refresh failures back to `ready` while retaining error/time/data.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd --workspace apps/renderer test -- src/features/runs/runDetailModel.test.ts`

Expected: all reducer tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/renderer/src/features/runs/runDetailModel.ts apps/renderer/src/features/runs/runDetailModel.test.ts
git commit -m "feat: add isolated run detail state"
```

### Task 5: Project-Scoped Run Detail Page

**Files:**
- Create: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Create: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`
- Modify: `apps/renderer/src/features/runs/runWorkbenchModel.ts`
- Modify: `apps/renderer/src/features/runs/runWorkbenchModel.test.ts`
- Modify: `apps/renderer/src/app/styles.css`

- [ ] **Step 1: Write failing first-screen tests**

Render with an injected `loadOverview` and assert this visible order and content:

```ts
expect(screen.getByRole("link", { name: "返回 Run 列表" })).toHaveAttribute("href", "#/runs");
expect(screen.getByRole("heading", { name: "Release candidate" })).toBeInTheDocument();
expect(screen.getByLabelText("运行进度图")).toBeInTheDocument();
expect(screen.getByRole("region", { name: "当前工作环节" })).toHaveTextContent("plan");
expect(screen.getByRole("region", { name: "下一工作环节" })).toHaveTextContent("2 个候选后续环节");
expect(screen.getByRole("region", { name: "Runtime 授权操作" })).toBeInTheDocument();
```

Assert node kind/role/goal/input/artifact/completion/all blockers/workspace/activity, one successor with condition, multiple successors, no successor, immutable workflow name/version, metadata parameters, and explicit secondary links containing encoded `projectId` and `runId` query parameters.

- [ ] **Step 2: Write failing action and lifecycle tests**

Assert only supplied `allowedActions` render. Clicking a low-risk action calls `executeAction` exactly once with its `id`, current revision, actor, and payload. Medium/high-risk actions require a confirmation control before submission. Assert successful response projection replaces the displayed revision/status and triggers one overview refresh.

With fake timers and controllable promises cover 2-second active polling, 10-second terminal polling, hidden pause, focus/visible refresh, request abort on unmount, stale Run/project response rejection, retained overview after refresh error, not-found return action, maintenance manual refresh, and revision-conflict refresh message.

- [ ] **Step 3: Verify RED**

Run: `npm.cmd --workspace apps/renderer test -- src/features/runs/RunDetailPage.test.tsx src/features/runs/runWorkbenchModel.test.ts`

Expected: FAIL because `RunDetailPage` is absent and successor presentation is incomplete.

- [ ] **Step 4: Implement the page transport lifecycle**

Use injected props:

```ts
type RunDetailPageProps = {
  projectId: string;
  runId: string;
  projectName: string;
  actor: Actor;
  loadOverview(signal: AbortSignal): Promise<RunOverview>;
  executeAction(request: ExecuteRunActionRequest, signal: AbortSignal): Promise<ExecuteRunActionResponse>;
  onReturnToList(): void;
};
```

Use `useReducer(runDetailReducer)`, one generation ref, one abort controller, stable callbacks, visibility/focus listeners, and a timeout rescheduled from `detailPollInterval(state.overview?.projection.status)` after each completed request. Do not overlap requests.

- [ ] **Step 5: Implement first-screen content and actions**

Reuse `RunProgressMap`. Derive current/next nodes from workflow edges only. Render every `projection.blockingReasons` matching the selected/current node. Render an action button for every and only every `allowedAction`; use the action ID in the request. For confirmation use native `<details>` plus a distinct `确认执行 <label>` button so no modal dependency is introduced.

Secondary links use:

```ts
const context = `projectId=${encodeURIComponent(projectId)}&runId=${encodeURIComponent(runId)}`;
```

and target `#/artifacts?${context}`, `#/terminal?${context}`, `#/gates?${context}`, `#/approvals?${context}`, `#/audit?${context}`, and `#/recovery?${context}`. Deployment/timeline remain local detail sections until Phase 4 routes exist.

- [ ] **Step 6: Add responsive styles**

Use an unframed page, stable `minmax(0, 1fr)` tracks, a two-column scheduling band above 980px, one column below, 5-6px radii, no nested cards, and existing color tokens. Ensure action labels never wrap incoherently and the graph has a fixed responsive height.

- [ ] **Step 7: Verify GREEN and build**

Run: `npm.cmd --workspace apps/renderer test -- src/features/runs/RunDetailPage.test.tsx src/features/runs/runWorkbenchModel.test.ts src/features/runs/RunProgressMap.test.tsx`

Run: `npm.cmd --workspace apps/renderer run build`

Expected: tests and build PASS without act warnings.

- [ ] **Step 8: Commit**

```powershell
git add apps/renderer/src/features/runs/RunDetailPage.tsx apps/renderer/src/features/runs/RunDetailPage.test.tsx apps/renderer/src/features/runs/runWorkbenchModel.ts apps/renderer/src/features/runs/runWorkbenchModel.test.ts apps/renderer/src/app/styles.css
git commit -m "feat: add project scoped run detail page"
```

### Task 6: App Detail Route Integration

**Files:**
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/App.test.tsx`

- [ ] **Step 1: Write failing App integration tests**

For `#/runs/run%2Fone` with saved `saved-run`, assert only:

```ts
expect(calls).toContain("/projects/project-1/runs/run%2Fone/overview");
expect(calls.some((path) => path.startsWith("/runs/"))).toBe(false);
expect(calls.some((path) => path.includes("/workflow-versions/") && path.endsWith("/runs"))).toBe(false);
```

Assert the page renders the URL Run, action POST targets the scoped path with exact action ID/revision, navigating list -> detail remounts isolated detail state, and a 404 displays the return-to-list state without falling back to the saved/global projection.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd --workspace apps/renderer test -- src/app/App.test.tsx`

Expected: FAIL because App still renders `RunDashboard` and starts legacy effects.

- [ ] **Step 3: Integrate stable scoped callbacks**

Memoize callbacks from `apiBaseUrl`, `projectId`, and `routeRunId`:

```ts
const loadRunOverview = useCallback((signal: AbortSignal) =>
  createRuntimeClient(apiBaseUrl).getProjectRunOverview(projectId, routeRunId!, signal),
  [apiBaseUrl, projectId, routeRunId]);
```

Render `RunDetailPage key={`${projectId}:${routeRunId}`}` with a stable execute callback and the canonical Renderer actor.

- [ ] **Step 4: Suppress compatibility effects on Run details**

Change initial restore so every valid Run route (`list`, `new`, or `detail`) calls only `loadWorkbenchState`; let `RunDetailPage` own URL detail loading. Gate workflow-version list, projection, timeline, artifacts, approvals, gates, Agent output, terminal, recovery, and deployment effects so none run while `currentRoute === "runs"`. Remove the `handleSelectRun(routeRunId)` effect and do not pass `RunDashboard` on the detail route.

- [ ] **Step 5: Verify GREEN and focused Phase 3 suite**

Run: `npm.cmd --workspace apps/renderer test -- src/app/App.test.tsx`

Run: `npm.cmd --workspace apps/renderer test -- src/app/runtimeClient.test.ts src/features/runs/runDetailModel.test.ts src/features/runs/runWorkbenchModel.test.ts src/features/runs/RunProgressMap.test.tsx src/features/runs/RunDetailPage.test.tsx src/app/App.test.tsx`

Expected: all App and Phase 3 tests PASS with zero legacy detail calls.

- [ ] **Step 6: Commit**

```powershell
git add apps/renderer/src/app/App.tsx apps/renderer/src/app/App.test.tsx
git commit -m "feat: route run details through scoped state"
```

### Task 7: Phase 3 Verification

**Files:**
- No production changes expected. Fix only demonstrated regressions, with a failing test first.

- [ ] **Step 1: Run full contracts and Runtime tests**

Run: `npm.cmd --workspace packages/contracts test`

Run from `runtime`: `python -m pytest -q`

Expected: all contracts and Runtime tests PASS.

- [ ] **Step 2: Run Renderer/Desktop and root tests/builds**

Run: `npm.cmd --workspace apps/renderer test`

Run: `npm.cmd --workspace apps/renderer run build`

Run: `npm.cmd --workspace apps/desktop test`

Run: `npm.cmd --workspace apps/desktop run build`

Run: `npm.cmd test`

Run: `npm.cmd run build`

Expected: all tests/builds PASS; the existing Renderer chunk-size warning is the only accepted warning.

- [ ] **Step 3: Browser visual verification**

Run the local Renderer and Runtime. Inspect `#/runs/:runId` at 1440x900 and 390x844. Confirm nonblank progress graph, current/action/next regions visible in source order, no horizontal overflow, no overlapping text, action confirmation usable, and secondary links retain context.

- [ ] **Step 4: Verify source integrity and scope**

Run: `git diff --check`

Run: `git status --short`

Run: `git log --oneline -12`

Run: `rg -n "listRunsForWorkflowVersion|/runs/\$\{|getProjection\(|restoreWorkbenchState" apps/renderer/src/app/App.tsx apps/renderer/src/features/runs/RunDetailPage.tsx`

Expected: no whitespace errors; only `docs/run-multi-run-rearchitecture.zh-CN.md` remains untracked; no Run detail route uses legacy list/detail restoration; each task has an independent commit.

- [ ] **Step 5: Final specification review**

Review the Phase 3 commit range against `docs/superpowers/specs/2026-08-06-run-multi-run-phase-3-design.md` and source sections 6, 18.1-18.3, 19, 21.1-21.3, and 22.1. Confirm no global projection dependency, no editable workflow definition in the detail graph, no inferred actions, no Phase 4 API migration hidden in scope, and no unresolved critical/important issue.
