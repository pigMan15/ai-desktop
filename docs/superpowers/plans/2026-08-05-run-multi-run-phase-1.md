# Run Multi-Run Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy Runtime Run storage and core API with project-scoped Runs, immutable workflow snapshots, atomic workspace leases, and consistent error envelopes.

**Architecture:** SQLite remains the source of truth. A destructive one-time run-state migration preserves static project/workflow/role configuration, then service-level `BEGIN IMMEDIATE` transactions create the Run, lease, first event, and projection atomically. New API routes scope every core Run operation by `projectId + runId`; Agent and deployment starts revalidate that scope and the active lease immediately before execution.

**Tech Stack:** Python 3.11+, SQLite, FastAPI, Pydantic, pytest, TypeScript contracts from phase 0.

---

## File Map

- Modify `runtime/src/workflow_platform/persistence/migrations.py`: rebuild run-state tables and indexes once when the legacy `runs` shape is detected.
- Modify `runtime/src/workflow_platform/persistence/repositories.py`: add scoped Run queries, idempotency records, lease persistence, summaries, and lifecycle transitions.
- Create `runtime/src/workflow_platform/workspaces.py`: normalize and validate execution workspace paths.
- Create `runtime/src/workflow_platform/runtime_errors.py`: carry HTTP-independent Runtime error codes, details, and status.
- Modify `runtime/src/workflow_platform/runtime_service.py`: atomic scoped creation, summaries, overview, release, and execution guards.
- Modify `runtime/src/workflow_platform/api/app.py`: final project-scoped core endpoints and error envelope mapping.
- Modify `runtime/tests/test_persistence.py`: migration, indexes, lease uniqueness, rollback, and scoped repository tests.
- Create `runtime/tests/test_workspace_leases.py`: path normalization and lease lifecycle unit tests.
- Modify `runtime/tests/test_runtime_service.py`: atomic creation, idempotency, execution guard, and release tests.
- Modify `runtime/tests/test_api.py`: list/filter/page/create/overview/error API tests.
- Modify `runtime/tests/test_multi_run_phase0_contract.py`: remove strict `xfail` markers as behavior becomes implemented.

### Task 1: Destructive Run-State Schema Migration

**Files:**
- Modify: `runtime/src/workflow_platform/persistence/migrations.py`
- Test: `runtime/tests/test_persistence.py`

- [ ] **Step 1: Write failing migration tests**

Add tests that create a legacy database, insert a project, workflow asset/version/binding, role asset/version, Run, event, projection, artifact, approval, gate result, Agent job/session, terminal, deployment and Run audit record, then call `migrate(db)`. Assert static rows remain, every run-state table is empty, and `runs` has these exact columns:

```py
assert table_columns(db, "runs") == [
    ("id", "TEXT", False, True),
    ("project_id", "TEXT", True, False),
    ("workflow_version_id", "TEXT", True, False),
    ("workflow_snapshot_json", "TEXT", True, False),
    ("title", "TEXT", True, False),
    ("context_json", "TEXT", True, False),
    ("execution_workspace", "TEXT", True, False),
    ("workspace_mode", "TEXT", True, False),
    ("status", "TEXT", True, False),
    ("created_at", "TEXT", True, False),
    ("updated_at", "TEXT", True, False),
]
```

Also assert `PRAGMA foreign_key_list(runs)` reports `RESTRICT` for `workflow_version_id`, and the three required Run indexes plus `run_workspace_active_write_unique` exist.

- [ ] **Step 2: Verify RED**

Run: `python -m pytest tests/test_persistence.py -k "run_rearchitecture or workspace_lease_schema" -q`

Expected: assertions fail because the legacy schema lacks snapshot/workspace columns and the lease table.

- [ ] **Step 3: Implement the migration boundary**

Add constants and a shape detector:

```py
RUN_STATE_TABLES_CHILD_FIRST = (
    "deployment_output_events", "deployments", "agent_output_events", "agent_input_events",
    "agent_sessions", "agent_checkpoints", "agent_jobs", "terminal_output_events",
    "terminal_sessions", "gate_results", "approvals", "artifact_consumers", "artifacts",
    "run_projections", "run_events", "run_idempotency_keys", "run_workspace_leases", "runs",
)


def _legacy_run_schema(db: sqlite3.Connection) -> bool:
    columns = {row["name"] for row in db.execute("PRAGMA table_info(runs)")}
    return bool(columns) and "workflow_snapshot_json" not in columns
```

When legacy shape is detected, disable foreign keys before the rebuild transaction, delete Run-owned audit rows, drop only the child-first runtime tables, recreate the final schema, commit, and re-enable foreign keys. Fresh databases create the final schema directly. Define `runs` constraints and indexes exactly as sections 17.2-17.3, plus:

```sql
CREATE TABLE run_idempotency_keys (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, idempotency_key)
);
```

- [ ] **Step 4: Verify GREEN and foreign-key health**

Run: `python -m pytest tests/test_persistence.py -k "run_rearchitecture or workspace_lease_schema or foreign_keys" -q`

Expected: all selected tests pass and `PRAGMA foreign_key_check` returns no rows.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/workflow_platform/persistence/migrations.py runtime/tests/test_persistence.py
git commit -m "feat: rebuild multi-run persistence schema"
```

### Task 2: Workspace Normalization and Lease Repository

**Files:**
- Create: `runtime/src/workflow_platform/workspaces.py`
- Modify: `runtime/src/workflow_platform/persistence/repositories.py`
- Create: `runtime/tests/test_workspace_leases.py`
- Test: `runtime/tests/test_persistence.py`

- [ ] **Step 1: Write failing normalization and lifecycle tests**

Cover absolute resolution, trailing separator removal, Windows case normalization through `os.path.normcase`, two read leases coexisting, second active write lease raising a conflict, and transitions `active -> released`, `active -> expired`, `expired -> released`. Assert `released -> active` raises `ValueError("WORKSPACE_LEASE_TRANSITION_INVALID")`.

```py
def test_normalize_workspace_path_resolves_and_normalizes(tmp_path: Path) -> None:
    workspace = tmp_path / "Workspace"
    workspace.mkdir()
    assert normalize_workspace_path(str(workspace) + os.sep) == os.path.normcase(str(workspace.resolve()))
```

- [ ] **Step 2: Verify RED**

Run: `python -m pytest tests/test_workspace_leases.py tests/test_persistence.py -k "workspace" -q`

Expected: import or attribute failures for the new normalization function and repository.

- [ ] **Step 3: Implement path normalization**

Create:

```py
from pathlib import Path
import os


def normalize_workspace_path(value: str | Path) -> str:
    path = Path(value).expanduser().resolve(strict=True)
    if not path.is_dir():
        raise ValueError("EXECUTION_WORKSPACE_INVALID: execution workspace must be a directory")
    return os.path.normcase(os.path.normpath(str(path)))
```

- [ ] **Step 4: Implement `WorkspaceLeaseRepository`**

Add methods `acquire`, `get_for_run`, `active_for_path`, `verify`, `transition`, and `list_for_project`. `acquire` inserts the already-normalized path and translates the partial-index `sqlite3.IntegrityError` into `ValueError("WORKSPACE_LEASE_CONFLICT")`. `transition` uses a fixed transition map and requires a non-empty reason for `expired` or `released`.

```py
LEASE_TRANSITIONS = {
    "active": {"released", "expired"},
    "expired": {"released"},
    "released": set(),
}
```

- [ ] **Step 5: Verify GREEN**

Run: `python -m pytest tests/test_workspace_leases.py tests/test_persistence.py -k "workspace" -q`

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add runtime/src/workflow_platform/workspaces.py runtime/src/workflow_platform/persistence/repositories.py runtime/tests/test_workspace_leases.py runtime/tests/test_persistence.py
git commit -m "feat: add workspace lease repository"
```

### Task 3: Scoped Run Repository and Summary Projection

**Files:**
- Modify: `runtime/src/workflow_platform/persistence/repositories.py`
- Test: `runtime/tests/test_persistence.py`

- [ ] **Step 1: Write failing scoped repository tests**

Create two projects from the same fixture definition and Runs in separate workspaces. Assert `get(project_a, run_b)` returns `None`; list filters by repeated statuses, version, workspace and case-insensitive title query; ordering is `updated_at DESC, id DESC`; cursor returns the next page without duplicates; and each summary contains current/next nodes, progress, first blocker, workspace and activity counts.

- [ ] **Step 2: Verify RED**

Run: `python -m pytest tests/test_persistence.py -k "scoped_run or run_summary" -q`

Expected: failures because scoped repository methods do not exist.

- [ ] **Step 3: Replace legacy Run repository writes and reads**

Change `RunRepository.save` to accept `workflow_snapshot`, `execution_workspace`, and `workspace_mode`; serialize the snapshot at creation. Add `get(project_id, run_id)`, `workflow_for_run(project_id, run_id)`, and `list_summaries(project_id, *, statuses, workflow_version_id, workspace_path, query, cursor, limit)`. The first two queries must contain both `WHERE project_id = ? AND id = ?`; the workflow method deserializes `runs.workflow_snapshot_json` and never joins the mutable current workflow version.

`list_summaries` uses one CTE-based SQL query joining projection, lease and aggregate activity counts. Its cursor predicate is `(updated_at < ?) OR (updated_at = ? AND runs.id < ?)`. Encode the cursor as URL-safe base64 JSON containing only `updatedAt` and `id`; reject malformed cursors with `ValueError("INVALID_REQUEST: invalid cursor")`.

- [ ] **Step 4: Verify GREEN**

Run: `python -m pytest tests/test_persistence.py -k "scoped_run or run_summary" -q`

Expected: all selected tests pass and query tracing shows one summary query per page.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/workflow_platform/persistence/repositories.py runtime/tests/test_persistence.py
git commit -m "feat: add project-scoped run summaries"
```

### Task 4: Atomic and Idempotent Run Creation

**Files:**
- Create: `runtime/src/workflow_platform/runtime_errors.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Test: `runtime/tests/test_runtime_service.py`

- [ ] **Step 1: Write failing atomicity tests**

Test that two service instances with separate SQLite connections concurrently create write Runs for the same normalized path and exactly one succeeds; an injected failure after lease insertion leaves neither Run nor lease; the same `(projectId, Idempotency-Key)` within 24 hours returns the original Run; the same key with a different request hash within 24 hours returns `INVALID_REQUEST`; after 24 hours the expired key is replaced and may create a new Run; and title length outside 1-120 is rejected before transaction writes.

- [ ] **Step 2: Verify RED**

Run: `python -m pytest tests/test_runtime_service.py -k "atomic_run or idempotent_run or lease_conflict" -q`

Expected: failures because scoped creation and idempotency are absent.

- [ ] **Step 3: Define structured service errors**

Create:

```py
class RuntimeContractError(Exception):
    def __init__(self, code: str, message: str, *, status: int, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details
```

- [ ] **Step 4: Implement atomic creation**

Change `create_run` to require `project_id`, `workflow_version_id`, `title`, `execution_workspace`, `workspace_mode`, `actor`, `idempotency_key`, and `now`. Inside one `BEGIN IMMEDIATE`: validate project/binding/version, compile and snapshot the workflow, normalize the path, resolve or delete the expired idempotency row using parsed UTC timestamps, insert Run, acquire lease, append `RUN_CREATED`, save projection, store idempotency record, and commit. Catch all exceptions, roll back when `db.in_transaction`, and translate lease uniqueness into `RuntimeContractError("WORKSPACE_LEASE_CONFLICT", "Workspace is already leased", status=409, details={"workspacePath": path, "occupyingRunId": run_id})`.

- [ ] **Step 5: Verify GREEN**

Run: `python -m pytest tests/test_runtime_service.py -k "atomic_run or idempotent_run or lease_conflict" -q`

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add runtime/src/workflow_platform/runtime_errors.py runtime/src/workflow_platform/runtime_service.py runtime/tests/test_runtime_service.py
git commit -m "feat: create scoped runs atomically"
```

### Task 5: Project-Scoped Core Runtime API

**Files:**
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/tests/test_api.py`
- Modify: `runtime/tests/test_multi_run_phase0_contract.py`

- [ ] **Step 1: Write failing API tests**

Cover `POST /projects/{projectId}/runs` with `Idempotency-Key` and `201 Location`; list filters and opaque cursor; detail, projection and overview; missing/cross-project Run error envelope; `limit=101`; lease conflict; action revision conflict; maintenance-mode `503 RUN_REARCHITECTURE_MAINTENANCE`; terminal Run release; and release rejection while an Agent, terminal or deployment is active. Update the three phase-0 tests by removing `xfail` decorators.

- [ ] **Step 2: Verify RED**

Run: `python -m pytest tests/test_multi_run_phase0_contract.py tests/test_api.py -k "project_scoped or scoped_run or workspace_lease or cleaned_run" -q`

Expected: route 404s and legacy error bodies cause failures.

- [ ] **Step 3: Add the Runtime error handler**

Register one FastAPI handler for `RuntimeContractError`:

```py
@application.exception_handler(RuntimeContractError)
async def runtime_contract_error_handler(request: Request, error: RuntimeContractError) -> JSONResponse:
    correlation_id = request.headers.get("X-Correlation-Id") or str(uuid4())
    return JSONResponse(
        status_code=error.status,
        content={"code": error.code, "message": error.message, "details": error.details, "correlationId": correlation_id},
    )
```

Omit `details` from the dictionary when it is `None`.

- [ ] **Step 4: Implement core scoped endpoints**

Add `GET/POST /projects/{project_id}/runs`, `GET /projects/{project_id}/runs/{run_id}`, `/projection`, `/overview`, `POST /actions`, and `POST /workspace/release`. List defaults to 20 and caps at 100. Create returns `{run, projection, workspace}`, status 201, and a project-scoped `Location`. Actions accept only `actionId`, `expectedRevision`, `actor`, and optional `payload`; resolve the action from current `allowedActions` before emitting an event.

`create_app` accepts `maintenance: bool = False`; while true, the new Run, Agent, terminal and deployment routes raise `RuntimeContractError("RUN_REARCHITECTURE_MAINTENANCE", "Runtime migration is in progress", status=503)`. `release_workspace` permits `DONE` or `ARCHIVED` Runs only after repository counts confirm no active Agent session/job, terminal or deployment, then performs `active -> released` in a transaction with a recorded reason.

- [ ] **Step 5: Remove superseded core routes**

Remove `POST /runs`, `GET /workflow-versions/{workflow_version_id}/runs`, `GET /runs/{run_id}`, `GET /runs/{run_id}/projection`, and `POST /runs/{run_id}/transition`. Update existing Runtime API tests and internal helpers to call the scoped routes; do not add redirect or compatibility handlers.

- [ ] **Step 6: Verify GREEN**

Run: `python -m pytest tests/test_multi_run_phase0_contract.py tests/test_api.py -q`

Expected: all API tests pass and the former three `xfail` cases are ordinary passing tests.

- [ ] **Step 7: Commit**

```bash
git add runtime/src/workflow_platform/api/app.py runtime/src/workflow_platform/runtime_service.py runtime/tests/test_api.py runtime/tests/test_multi_run_phase0_contract.py
git commit -m "feat: expose project-scoped run API"
```

### Task 6: Lease Checks for Agent and Deployment Starts

**Files:**
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/src/workflow_platform/api/app.py`
- Test: `runtime/tests/test_runtime_service.py`
- Test: `runtime/tests/test_api.py`

- [ ] **Step 1: Write failing execution guard tests**

Test cross-project start rejection, released/expired/missing write lease rejection, read lease rejection for normal Agent and deployment jobs, CWD mismatch rejection, archived project/Run rejection, and successful start only when the normalized CWD equals the Run workspace and the write lease is active.

- [ ] **Step 2: Verify RED**

Run: `python -m pytest tests/test_runtime_service.py tests/test_api.py -k "execution_lease or scoped_agent or scoped_deployment" -q`

Expected: current start methods accept only `runId` and do not enforce lease status.

- [ ] **Step 3: Implement a shared execution guard**

Add:

```py
def _require_execution_lease(self, project_id: str, run_id: str, *, write_required: bool) -> dict:
    run = self._require_scoped_run(project_id, run_id)
    lease = self._workspace_leases.get_for_run(run_id)
    if lease is None or lease["status"] != "active":
        raise RuntimeContractError("WORKSPACE_RECOVERY_REQUIRED", "Workspace lease is not active", status=423)
    if write_required and lease["mode"] != "write":
        raise RuntimeContractError("WORKSPACE_RECOVERY_REQUIRED", "Write execution requires a write lease", status=423)
    return {"run": run, "lease": lease}
```

Call it immediately before Agent command construction and before deployment transition. Require project-scoped start routes and reject any caller-supplied CWD unequal to the normalized `execution_workspace`.

- [ ] **Step 4: Verify GREEN**

Run: `python -m pytest tests/test_runtime_service.py tests/test_api.py -k "execution_lease or scoped_agent or scoped_deployment" -q`

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add runtime/src/workflow_platform/runtime_service.py runtime/src/workflow_platform/api/app.py runtime/tests/test_runtime_service.py runtime/tests/test_api.py
git commit -m "feat: enforce leases before run execution"
```

### Task 7: Phase 1 Verification

**Files:**
- Verify all files changed in Tasks 1-6.

- [ ] **Step 1: Run focused Runtime suites**

Run: `python -m pytest tests/test_workspace_leases.py tests/test_persistence.py tests/test_runtime_service.py tests/test_api.py tests/test_multi_run_phase0_contract.py -q`

Expected: all tests pass with zero `xfailed` phase-0 Runtime cases.

- [ ] **Step 2: Run the complete Runtime suite**

Run: `python -m pytest`

Expected: all Runtime tests pass; only the pre-existing Starlette/httpx deprecation warning may remain.

- [ ] **Step 3: Run workspace-wide tests**

Run: `npm.cmd test`

Expected: contracts, Renderer and Desktop suites exit 0. Renderer's phase-2 direct-route `it.fails` remains until phase 2.

- [ ] **Step 4: Check migration and change boundaries**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `git status --short`

Expected: only the user's untracked `docs/run-multi-run-rearchitecture.zh-CN.md` remains; no generated databases, test output, or cache directories are staged.
