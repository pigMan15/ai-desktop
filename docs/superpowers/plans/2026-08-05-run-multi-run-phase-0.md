# Run Multi-Run Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the shared multi-Run contracts and executable phase-0 regression baselines without changing persistence, Runtime routes, or Renderer behavior.

**Architecture:** TypeScript contracts remain the canonical Renderer boundary and Python Pydantic models mirror the same value shapes for later Runtime work. Missing phase-1/2 behavior is recorded with strict expected-failure tests, while contract and existing single-Run regression tests remain green.

**Tech Stack:** TypeScript 5.5, Node contract tests, Python 3.11, Pydantic, pytest, React 18, Vitest.

---

## File Map

- Modify `packages/contracts/src/events.ts`: export the canonical `RunStatus` type.
- Modify `packages/contracts/src/rpc.ts`: define summary, lease, scoped request, response, and error contracts.
- Modify `packages/contracts/src/errors.ts`: add the final multi-Run error codes.
- Modify `packages/contracts/src/contracts.test.ts`: exercise runtime values and representative contract shapes.
- Modify `packages/contracts/src/contracts.typecheck.ts`: reject invalid lease, request, and summary values at compile time.
- Modify `runtime/src/workflow_platform/models.py`: mirror TypeScript summary, lease, request, and error models.
- Modify `runtime/tests/test_models.py`: validate the Python contract shapes and literal restrictions.
- Create `runtime/tests/test_multi_run_phase0_contract.py`: record strict expected failures for project isolation, lease conflicts, and cleaned links.
- Modify `apps/renderer/src/app/routes.test.ts`: record strict expected failure for direct Run URL recognition.
- Reuse `apps/renderer/src/features/runs/RunDashboard.test.tsx` and `runWorkbenchModel.test.ts` as the existing single-Run regression baseline.

### Task 1: TypeScript Multi-Run Contracts

**Files:**
- Modify: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/errors.ts`
- Test: `packages/contracts/src/contracts.test.ts`
- Test: `packages/contracts/src/contracts.typecheck.ts`

- [ ] **Step 1: Add failing runtime contract tests**

Append imports for `CreateRunRequest`, `ExecuteRunActionRequest`, `RunListResponse`, `RunSummaryProjection`, `RuntimeError`, and `WorkspaceLease` to `contracts.test.ts`, then add:

```ts
it("accepts multi-run summary, lease, requests, and error shapes", () => {
  const summary: RunSummaryProjection = {
    id: "run-1",
    projectId: "project-1",
    workflowVersionId: "version-1",
    workflowName: "Release",
    workflowVersion: "1.0.0",
    title: "Ship release",
    status: "IN_PROGRESS",
    taskGoal: "Publish safely",
    currentNodes: [{ id: "build", name: "Build", kind: "agent", state: "RUNNING" }],
    nextNodes: [{ id: "review", name: "Review", kind: "approval" }],
    progress: { total: 2, passed: 0, running: 1, blocked: 0, pending: 1 },
    blocker: null,
    workspace: { path: "C:/repo/run-1", label: "run-1", leaseMode: "write", leaseStatus: "active" },
    activeAgentCount: 1,
    activeDeploymentCount: 0,
    createdAt: "2026-08-05T00:00:00Z",
    updatedAt: "2026-08-05T00:01:00Z",
  };
  const lease: WorkspaceLease = {
    id: "lease-1",
    projectId: "project-1",
    runId: "run-1",
    workspacePath: "C:/repo/run-1",
    mode: "write",
    status: "active",
    acquiredAt: "2026-08-05T00:00:00Z",
    lastVerifiedAt: "2026-08-05T00:01:00Z",
    releasedAt: null,
    releaseReason: null,
  };
  const create: CreateRunRequest = {
    workflowVersionId: "version-1",
    title: "Ship release",
    taskGoal: "Publish safely",
    parameters: { dryRun: true },
    executionWorkspace: { path: "C:/repo/run-1", mode: "write" },
    actor: { id: "user-1", type: "human", source: "renderer", trusted: true },
  };
  const action: ExecuteRunActionRequest = {
    actionId: "complete:build",
    expectedRevision: "rev-1",
    actor: create.actor,
  };
  const page: RunListResponse = { items: [summary], nextCursor: null };
  const error: RuntimeError = {
    code: "WORKSPACE_LEASE_CONFLICT",
    message: "Workspace is already leased",
    correlationId: "correlation-1",
  };

  expect({ lease: lease.status, action: action.actionId, count: page.items.length, code: error.code })
    .toEqual({ lease: "active", action: "complete:build", count: 1, code: "WORKSPACE_LEASE_CONFLICT" });
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npm --workspace packages/contracts test`

Expected: TypeScript compilation fails because the six new contract types are not exported.

- [ ] **Step 3: Add compile-time negative cases**

Append to `contracts.typecheck.ts`:

```ts
import type { CreateRunRequest, RunSummaryProjection, WorkspaceLease } from "./index.js";

// @ts-expect-error WorkspaceLease mode is restricted to read or write.
const invalidLease: WorkspaceLease = { mode: "exclusive" };

// @ts-expect-error CreateRunRequest requires an execution workspace.
const invalidCreateRun: CreateRunRequest = {
  workflowVersionId: "version-1",
  title: "Missing workspace",
  actor: { id: "user-1", type: "human", source: "renderer", trusted: true },
};

// @ts-expect-error RunSummaryProjection uses canonical Run statuses.
const invalidSummary: RunSummaryProjection = { status: "RUNNING" };

void invalidLease;
void invalidCreateRun;
void invalidSummary;
```

- [ ] **Step 4: Implement the minimal TypeScript contracts**

In `events.ts`, extract and use the canonical type:

```ts
export type RunStatus = "CREATED" | "IN_PROGRESS" | "REVIEWING" | "BLOCKED" | "PAUSED" | "DONE" | "ARCHIVED";

export type RunProjection = {
  runId: string;
  status: RunStatus;
  currentNodeIds: string[];
  nodeStates: Record<string, NodeState>;
  allowedActions: AllowedAction[];
  blockingReasons: Array<{ code: string; message: string; nodeId?: string }>;
  revision: string;
  updatedAt: string;
};
```

Replace `rpc.ts` imports with `Actor`, `NodeState`, `RunEvent`, `RunProjection`, and `RunStatus`, then append:

```ts
export type WorkspaceMode = "write" | "read";
export type WorkspaceLeaseStatus = "active" | "released" | "expired";

export type WorkspaceLease = {
  id: string;
  projectId: string;
  runId: string;
  workspacePath: string;
  mode: WorkspaceMode;
  status: WorkspaceLeaseStatus;
  acquiredAt: string;
  lastVerifiedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
};

export type RunSummaryProjection = {
  id: string;
  projectId: string;
  workflowVersionId: string;
  workflowName: string;
  workflowVersion: string;
  title: string;
  status: RunStatus;
  taskGoal: string | null;
  currentNodes: Array<{ id: string; name: string; kind: string; state: NodeState }>;
  nextNodes: Array<{ id: string; name: string; kind: string; condition?: string }>;
  progress: { total: number; passed: number; running: number; blocked: number; pending: number };
  blocker: { code: string; message: string; nodeId?: string } | null;
  workspace: { path: string; label: string; leaseMode: WorkspaceMode; leaseStatus: WorkspaceLeaseStatus } | null;
  activeAgentCount: number;
  activeDeploymentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type RunListQuery = {
  status?: RunStatus[];
  workflowVersionId?: string;
  workspacePath?: string;
  q?: string;
  cursor?: string;
  limit?: number;
};

export type RunListResponse = { items: RunSummaryProjection[]; nextCursor: string | null };

export type CreateRunRequest = {
  workflowVersionId: string;
  title: string;
  taskGoal?: string;
  parameters?: Record<string, unknown>;
  executionWorkspace: { path: string; mode: WorkspaceMode };
  actor: Actor;
};

export type ExecuteRunActionRequest = {
  actionId: string;
  expectedRevision: string;
  actor: Actor;
  payload?: Record<string, unknown>;
};

export type ExecuteRunActionResponse = { projection: RunProjection; emittedEvents: RunEvent[] };

export type RuntimeError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId: string;
};
```

Append these values to `ERROR_CODES` in `errors.ts`:

```ts
"INVALID_REQUEST",
"RUN_NOT_FOUND_IN_PROJECT",
"WORKSPACE_LEASE_CONFLICT",
"PROJECT_ARCHIVED",
"RUN_ARCHIVED",
"WORKSPACE_RECOVERY_REQUIRED",
"RUN_REARCHITECTURE_MAINTENANCE",
```

- [ ] **Step 5: Run TypeScript contract verification and verify GREEN**

Run: `npm --workspace packages/contracts test`

Expected: all contract tests print `PASS` and the command exits 0.

- [ ] **Step 6: Commit the TypeScript contracts**

```bash
git add packages/contracts/src/events.ts packages/contracts/src/rpc.ts packages/contracts/src/errors.ts packages/contracts/src/contracts.test.ts packages/contracts/src/contracts.typecheck.ts
git commit -m "feat: define multi-run contracts"
```

### Task 2: Python Contract Mirrors

**Files:**
- Modify: `runtime/src/workflow_platform/models.py`
- Test: `runtime/tests/test_models.py`

- [ ] **Step 1: Write failing Python model tests**

Import `CreateRunRequest`, `ExecuteRunActionRequest`, `RunSummaryProjection`, `RuntimeError`, and `WorkspaceLease` in `test_models.py`, then add:

```py
def test_multi_run_models_validate_scoped_contracts() -> None:
    lease = WorkspaceLease(
        id="lease-1", projectId="project-1", runId="run-1", workspacePath="C:/repo/run-1",
        mode="write", status="active", acquiredAt="2026-08-05T00:00:00Z",
        lastVerifiedAt="2026-08-05T00:01:00Z", releasedAt=None, releaseReason=None,
    )
    summary = RunSummaryProjection(
        id="run-1", projectId="project-1", workflowVersionId="version-1", workflowName="Release",
        workflowVersion="1.0.0", title="Ship release", status="IN_PROGRESS", taskGoal="Publish safely",
        currentNodes=[{"id": "build", "name": "Build", "kind": "agent", "state": "RUNNING"}],
        nextNodes=[{"id": "review", "name": "Review", "kind": "approval"}],
        progress={"total": 2, "passed": 0, "running": 1, "blocked": 0, "pending": 1},
        blocker=None,
        workspace={"path": "C:/repo/run-1", "label": "run-1", "leaseMode": "write", "leaseStatus": "active"},
        activeAgentCount=1, activeDeploymentCount=0,
        createdAt="2026-08-05T00:00:00Z", updatedAt="2026-08-05T00:01:00Z",
    )
    request = CreateRunRequest(
        workflowVersionId="version-1", title="Ship release", executionWorkspace={"path": lease.workspacePath, "mode": "write"},
        actor=Actor(id="user-1", type="human", source="renderer", trusted=True),
    )
    action = ExecuteRunActionRequest(actionId="complete:build", expectedRevision="rev-1", actor=request.actor)
    error = RuntimeError(code="WORKSPACE_LEASE_CONFLICT", message="Workspace is already leased", correlationId="c-1")

    assert summary.currentNodes[0].state == "RUNNING"
    assert action.actionId == "complete:build"
    assert error.code == "WORKSPACE_LEASE_CONFLICT"


def test_workspace_lease_rejects_unknown_mode_and_status() -> None:
    with pytest.raises(ValidationError):
        WorkspaceLease(
            id="lease-1", projectId="project-1", runId="run-1", workspacePath="C:/repo/run-1",
            mode="exclusive", status="unknown", acquiredAt="2026-08-05T00:00:00Z",
            lastVerifiedAt="2026-08-05T00:00:00Z", releasedAt=None, releaseReason=None,
        )
```

- [ ] **Step 2: Run the Python model tests and verify RED**

Run: `python -m pytest runtime/tests/test_models.py -q`

Expected: collection fails because the new models are not defined.

- [ ] **Step 3: Implement the Pydantic mirror models**

Add these definitions after `RunProjection` in `models.py`:

```py
WorkspaceMode = Literal["write", "read"]
WorkspaceLeaseStatus = Literal["active", "released", "expired"]


class WorkspaceLease(CanonicalModel):
    id: str
    projectId: str
    runId: str
    workspacePath: str
    mode: WorkspaceMode
    status: WorkspaceLeaseStatus
    acquiredAt: str
    lastVerifiedAt: str
    releasedAt: str | None
    releaseReason: str | None


class RunSummaryNode(CanonicalModel):
    id: str
    name: str
    kind: str
    state: NodeState


class RunSummaryNextNode(CanonicalModel):
    id: str
    name: str
    kind: str
    condition: str | None = None


class RunProgress(CanonicalModel):
    total: int
    passed: int
    running: int
    blocked: int
    pending: int


class RunWorkspaceSummary(CanonicalModel):
    path: str
    label: str
    leaseMode: WorkspaceMode
    leaseStatus: WorkspaceLeaseStatus


class RunSummaryProjection(CanonicalModel):
    id: str
    projectId: str
    workflowVersionId: str
    workflowName: str
    workflowVersion: str
    title: str
    status: RunStatus
    taskGoal: str | None
    currentNodes: list[RunSummaryNode]
    nextNodes: list[RunSummaryNextNode]
    progress: RunProgress
    blocker: BlockingReason | None
    workspace: RunWorkspaceSummary | None
    activeAgentCount: int
    activeDeploymentCount: int
    createdAt: str
    updatedAt: str


class ExecutionWorkspace(CanonicalModel):
    path: str
    mode: WorkspaceMode


class CreateRunRequest(CanonicalModel):
    workflowVersionId: str
    title: str = Field(min_length=1, max_length=120)
    taskGoal: str | None = None
    parameters: dict[str, Any] | None = None
    executionWorkspace: ExecutionWorkspace
    actor: Actor


class ExecuteRunActionRequest(CanonicalModel):
    actionId: str
    expectedRevision: str
    actor: Actor
    payload: dict[str, Any] | None = None


class RuntimeError(CanonicalModel):
    code: str
    message: str
    details: dict[str, Any] | None = None
    correlationId: str
```

- [ ] **Step 4: Run Python model tests and verify GREEN**

Run: `python -m pytest runtime/tests/test_models.py -q`

Expected: all model tests pass.

- [ ] **Step 5: Commit the Python mirrors**

```bash
git add runtime/src/workflow_platform/models.py runtime/tests/test_models.py
git commit -m "feat: mirror multi-run runtime contracts"
```

### Task 3: Runtime Expected-Failure Baselines

**Files:**
- Create: `runtime/tests/test_multi_run_phase0_contract.py`

- [ ] **Step 1: Add executable future-behavior tests without expected-failure markers**

Create the file with these imports, helpers, fixtures, and tests:

```py
from pathlib import Path
import shutil

import pytest
from fastapi.testclient import TestClient

from workflow_platform.api.app import create_app
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService


FIXTURE_WORKFLOW = Path(__file__).parent / "fixtures" / "harness_project" / ".harness" / "workflow.yaml"
NOW = "2026-08-05T00:00:00Z"
ACTOR = {"id": "human-1", "type": "human", "source": "renderer", "trusted": True}


def import_project(client: TestClient, root: Path, name: str) -> dict:
    project_path = root / name
    workflow_dir = project_path / ".harness"
    workflow_dir.mkdir(parents=True)
    shutil.copyfile(FIXTURE_WORKFLOW, workflow_dir / "workflow.yaml")
    response = client.post("/projects/import", json={"projectPath": str(project_path), "now": NOW})
    assert response.status_code == 200
    return response.json()


def create_legacy_run(client: TestClient, imported: dict) -> dict:
    response = client.post(
        "/runs",
        json={
            "projectId": imported["projectId"],
            "workflowVersionId": imported["workflowVersionId"],
            "title": "Phase 0 baseline",
            "now": NOW,
        },
    )
    assert response.status_code == 200
    return response.json()


def create_scoped_run(
    client: TestClient,
    project_id: str,
    workflow_version_id: str,
    workspace: Path,
    idempotency_key: str,
):
    return client.post(
        f"/projects/{project_id}/runs",
        headers={"Idempotency-Key": idempotency_key},
        json={
            "workflowVersionId": workflow_version_id,
            "title": "Phase 0 scoped Run",
            "executionWorkspace": {"path": str(workspace), "mode": "write"},
            "actor": ACTOR,
        },
    )


@pytest.fixture
def project_client(tmp_path):
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    imported = import_project(client, tmp_path, "project-a")
    workspace = tmp_path / "project-a"
    yield client, imported["projectId"], imported["workflowVersionId"], workspace
    client.close()
    db.close()


@pytest.fixture
def two_projects_client(tmp_path):
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_a = import_project(client, tmp_path, "project-a")
    project_b = import_project(client, tmp_path, "project-b")
    run_a = create_legacy_run(client, project_a)
    yield client, project_a["projectId"], project_b["projectId"], run_a["runId"]
    client.close()
    db.close()


def test_project_scoped_run_lookup_hides_run_owned_by_another_project(two_projects_client) -> None:
    client, _project_a, project_b, run_a = two_projects_client
    response = client.get(f"/projects/{project_b}/runs/{run_a}/overview")
    assert response.status_code == 404
    assert response.json()["code"] == "RUN_NOT_FOUND_IN_PROJECT"


def test_second_write_run_for_same_normalized_workspace_is_rejected(project_client) -> None:
    client, project_id, workflow_version_id, workspace = project_client
    first = create_scoped_run(client, project_id, workflow_version_id, workspace, "key-1")
    second = create_scoped_run(client, project_id, workflow_version_id, workspace, "key-2")
    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json()["code"] == "WORKSPACE_LEASE_CONFLICT"


def test_cleaned_run_link_returns_controlled_not_found(project_client) -> None:
    client, project_id, _workflow_version_id, _workspace = project_client
    response = client.get(f"/projects/{project_id}/runs/run-from-old-version/overview")
    assert response.status_code == 404
    assert response.json()["code"] == "RUN_NOT_FOUND_IN_PROJECT"
    assert response.json()["correlationId"]
```

- [ ] **Step 2: Run the future-behavior tests and verify RED**

Run: `python -m pytest runtime/tests/test_multi_run_phase0_contract.py -q`

Expected: all three tests fail with current `404` route absence or current unscoped behavior. Confirm failures are behavioral assertions, not fixture/import errors.

- [ ] **Step 3: Mark the phase-1 tests as strict expected failures**

Decorate each test with:

```py
@pytest.mark.xfail(strict=True, reason="phase 1 project-scoped Runtime API and workspace leases are not implemented")
```

This keeps phase 0 green while making an unexpected pass fail the suite; phase 1 removes each marker as its implementation lands.

- [ ] **Step 4: Verify the Runtime baseline suite**

Run: `python -m pytest runtime/tests/test_multi_run_phase0_contract.py runtime/tests/test_models.py -q`

Expected: model tests pass and exactly three tests report `xfailed`.

- [ ] **Step 5: Commit the Runtime baselines**

```bash
git add runtime/tests/test_multi_run_phase0_contract.py
git commit -m "test: record multi-run runtime baselines"
```

### Task 4: Renderer Direct-Link and Single-Run Baselines

**Files:**
- Modify: `apps/renderer/src/app/routes.test.ts`
- Verify: `apps/renderer/src/features/runs/RunDashboard.test.tsx`
- Verify: `apps/renderer/src/features/runs/runWorkbenchModel.test.ts`

- [ ] **Step 1: Add the direct Run route as a failing test**

Append to the existing `normalizeRoute` suite:

```ts
it("recognizes a direct Run detail URL within the runs section", () => {
  expect(normalizeRoute("#/runs/run-1")).toBe("runs");
});
```

- [ ] **Step 2: Run the route test and verify RED**

Run: `npm --workspace apps/renderer test -- src/app/routes.test.ts`

Expected: the new test fails because `normalizeRoute("#/runs/run-1")` currently returns `projects`.

- [ ] **Step 3: Convert it to a strict phase-2 expected failure**

Change `it(` to:

```ts
it.fails("recognizes a direct Run detail URL within the runs section", () => {
  expect(normalizeRoute("#/runs/run-1")).toBe("runs");
});
```

Phase 2 removes `.fails` when the scoped Run list/detail routing is implemented.

- [ ] **Step 4: Verify route and single-Run regression baselines**

Run: `npm --workspace apps/renderer test -- src/app/routes.test.ts src/features/runs/runWorkbenchModel.test.ts src/features/runs/RunDashboard.test.tsx`

Expected: all tests pass, including the expected-failure route test. The workbench tests continue to cover progress, current/next nodes, and Runtime-authorized actions.

- [ ] **Step 5: Commit the Renderer baseline**

```bash
git add apps/renderer/src/app/routes.test.ts
git commit -m "test: record scoped run route baseline"
```

### Task 5: Phase 0 Verification

**Files:**
- Verify all files changed in Tasks 1-4.

- [ ] **Step 1: Run contract verification**

Run: `npm --workspace packages/contracts test`

Expected: exit 0 with all contract cases printing `PASS`.

- [ ] **Step 2: Run Renderer verification**

Run: `npm --workspace apps/renderer test -- src/app/routes.test.ts src/features/runs/runWorkbenchModel.test.ts src/features/runs/RunDashboard.test.tsx`

Expected: exit 0.

- [ ] **Step 3: Run Runtime verification**

Run: `python -m pytest runtime/tests/test_models.py runtime/tests/test_multi_run_phase0_contract.py -q`

Expected: exit 0 with exactly three strict expected failures.

- [ ] **Step 4: Run the complete existing unit suites**

Run: `npm test`

Expected: contracts, Renderer, and Desktop tests exit 0.

Run: `npm run test:runtime`

Expected: Runtime suite exits 0; phase-0 future behavior remains reported as exactly three `xfailed` tests.

- [ ] **Step 5: Confirm the stage boundary**

Run: `git diff --name-only 272f942..HEAD`

Expected: only the contract/model/test files listed in this plan changed. In particular, `migrations.py`, `repositories.py`, `runtime_service.py`, `api/app.py`, and Renderer production route/page files remain unchanged.
