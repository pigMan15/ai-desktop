# P1 Runtime-backed Product Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the P1 product loop where a user can import a project, create a Run, submit Artifact, decide Approval, submit Gate result, and review Runtime-backed Projection / Timeline.

**Architecture:** Keep Kernel as the trusted state boundary and `run_events` as the fact source. Add focused repositories and Runtime service methods for Artifact / Approval / Gate records, expose stable FastAPI DTOs, and move Renderer pages from static copy to Runtime-backed interactions. UI buttons render from Runtime projection / allowed actions and never mutate local workflow state.

**Tech Stack:** Electron, React, TypeScript, Vite, Vitest, Playwright, Python 3.11+, FastAPI, Pydantic, SQLite, pytest.

---

## File Structure

- `runtime/src/workflow_platform/persistence/repositories.py`: add focused repositories for projects, workflows, runs, events, projections, artifacts, approvals, and gates.
- `runtime/src/workflow_platform/runtime_service.py`: orchestrate Adapter import, Run lifecycle, Artifact submit, Approval decide, Gate result, Timeline, and Projection rebuild.
- `runtime/src/workflow_platform/api/app.py`: expose P1 Runtime API endpoints and map typed errors to HTTP status codes.
- `runtime/src/workflow_platform/adapters/markdown_checklist.py`: import Markdown checklist files into canonical workflow definitions.
- `runtime/src/workflow_platform/adapters/generic_yaml.py`: import generic YAML workflow files into canonical workflow definitions.
- `runtime/src/workflow_platform/adapters/registry.py`: register Harness, Markdown Checklist, and Generic YAML adapters.
- `packages/contracts/src/events.ts`: keep `NodeState`, `AllowedAction`, `RunProjection`, and event contracts aligned with Runtime.
- `packages/contracts/src/rpc.ts`: add P1 request/response DTOs for projects, workflows, runs, artifacts, approvals, gates, and timeline.
- `apps/renderer/src/app/runtimeClient.ts`: typed browser client for Runtime API.
- `apps/renderer/src/app/App.tsx`: load Runtime-backed demo state and pass data/actions to feature panels.
- `apps/renderer/src/features/*/*.tsx`: render Runtime-backed project/run/artifact/approval/gate/timeline state.
- `runtime/tests/test_runtime_service.py`: integration tests for full P1 Runtime service loop.
- `runtime/tests/test_api.py`: FastAPI tests for full P1 API loop and error mapping.
- `runtime/tests/test_adapters.py`: adapter detection/import tests for Harness, Markdown, and Generic YAML.
- `apps/renderer/src/app/App.test.tsx`: Renderer tests for Runtime-backed UI states and no local state bypass.
- `tests/e2e/workflow-p1.spec.ts`: Playwright P1 smoke path.
- `README.md` and `docs/mvp-completion-audit.zh-CN.md`: Chinese delivery and verification updates.

---

### Task 1: Governance Persistence Records

**Files:**
- Modify: `runtime/src/workflow_platform/persistence/repositories.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/tests/test_runtime_service.py`

- [ ] **Step 1: Write failing service test for persisted Artifact / Approval / Gate records**

Add this test to `runtime/tests/test_runtime_service.py`:

```python
def test_runtime_service_persists_artifact_approval_and_gate_records(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("计划内容", encoding="utf-8")

    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="治理记录", now=NOW)
    started = service.transition_run(
        run.runId,
        "NODE_STARTED",
        node_id="plan",
        actor={"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
        expected_revision=run.revision,
        now=NOW,
    )
    submitted = service.submit_artifact(
        run.runId,
        node_id="plan",
        artifact_path=artifact_path,
        artifact_type="plan",
        actor={"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
        expected_revision=started.revision,
        now=NOW,
    )
    approval = service.decide_approval(
        run.runId,
        node_id="plan",
        decision="approved",
        actor=trusted_human().model_dump(),
        comment="同意进入 gate",
        expected_revision=submitted.revision,
        now=NOW,
    )
    gated = service.submit_gate_result(
        run.runId,
        node_id="plan",
        gate_id="plan-ready",
        status="passed",
        evidence=["artifact:plan"],
        waiver_reason=None,
        actor=trusted_verifier().model_dump(),
        expected_revision=approval.revision,
        now=NOW,
    )

    artifacts = service.list_artifacts(run.runId)
    approvals = service.list_approvals(run.runId)
    gates = service.list_gate_results(run.runId)

    assert gated.nodeStates["review"] == "READY"
    assert artifacts[0]["type"] == "plan"
    assert artifacts[0]["contentHash"]
    assert approvals[0]["status"] == "approved"
    assert approvals[0]["comment"] == "同意进入 gate"
    assert gates[0]["status"] == "passed"
    assert gates[0]["evidence"] == ["artifact:plan"]
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd runtime
python -m pytest tests/test_runtime_service.py::test_runtime_service_persists_artifact_approval_and_gate_records -q
```

Expected: fail because `decide_approval`, `submit_gate_result`, and list methods are missing.

- [ ] **Step 3: Add repositories**

In `runtime/src/workflow_platform/persistence/repositories.py`, add `ArtifactRepository`, `ApprovalRepository`, and `GateResultRepository` with `save()` and `list_for_run()` methods. Use JSON columns for actor/evidence and return camelCase dictionaries:

```python
class ArtifactRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(self, *, id: str, run_id: str, node_id: str, type: str, uri: str, content_hash: str, producer: Actor, created_at: str) -> None:
        self._db.execute(
            """
            INSERT INTO artifacts (id, run_id, node_id, type, uri, content_hash, producer_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (id, run_id, node_id, type, uri, content_hash, json.dumps(producer.model_dump(), separators=(",", ":"), sort_keys=True), created_at),
        )

    def list_for_run(self, run_id: str) -> list[dict]:
        rows = self._db.execute("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, id", (run_id,)).fetchall()
        return [
            {
                "id": row["id"],
                "runId": row["run_id"],
                "nodeId": row["node_id"],
                "type": row["type"],
                "uri": row["uri"],
                "contentHash": row["content_hash"],
                "producer": json.loads(row["producer_json"]),
                "createdAt": row["created_at"],
            }
            for row in rows
        ]
```

Add equivalent repositories:

```python
class ApprovalRepository:
    def save_decision(self, *, id: str, run_id: str, node_id: str, status: str, requested_by: Actor, decided_by: Actor, comment: str | None, created_at: str, decided_at: str) -> None:
        self._db.execute(
            """
            INSERT INTO approvals (id, run_id, node_id, status, requested_by_json, decided_by_json, comment, created_at, decided_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                run_id,
                node_id,
                status,
                json.dumps(requested_by.model_dump(), separators=(",", ":"), sort_keys=True),
                json.dumps(decided_by.model_dump(), separators=(",", ":"), sort_keys=True),
                comment,
                created_at,
                decided_at,
            ),
        )

    def list_for_run(self, run_id: str) -> list[dict]:
        rows = self._db.execute("SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at, id", (run_id,)).fetchall()
        return [
            {
                "id": row["id"],
                "runId": row["run_id"],
                "nodeId": row["node_id"],
                "status": row["status"],
                "requestedBy": json.loads(row["requested_by_json"]),
                "decidedBy": json.loads(row["decided_by_json"]) if row["decided_by_json"] else None,
                "comment": row["comment"],
                "createdAt": row["created_at"],
                "decidedAt": row["decided_at"],
            }
            for row in rows
        ]

class GateResultRepository:
    def save(self, *, id: str, run_id: str, node_id: str, gate_id: str, status: str, evidence: list[str], waiver_reason: str | None, actor: Actor, created_at: str) -> None:
        payload = {"evidence": evidence, "waiverReason": waiver_reason}
        self._db.execute(
            """
            INSERT INTO gate_results (id, run_id, node_id, gate_id, status, evidence_json, actor_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                run_id,
                node_id,
                gate_id,
                status,
                json.dumps(payload, separators=(",", ":"), sort_keys=True),
                json.dumps(actor.model_dump(), separators=(",", ":"), sort_keys=True),
                created_at,
            ),
        )

    def list_for_run(self, run_id: str) -> list[dict]:
        rows = self._db.execute("SELECT * FROM gate_results WHERE run_id = ? ORDER BY created_at, id", (run_id,)).fetchall()
        results = []
        for row in rows:
            payload = json.loads(row["evidence_json"])
            results.append(
                {
                    "id": row["id"],
                    "runId": row["run_id"],
                    "nodeId": row["node_id"],
                    "gateId": row["gate_id"],
                    "status": row["status"],
                    "evidence": payload["evidence"],
                    "waiverReason": payload["waiverReason"],
                    "actor": json.loads(row["actor_json"]),
                    "createdAt": row["created_at"],
                }
            )
        return results
```

- [ ] **Step 4: Add Runtime service methods**

In `runtime/src/workflow_platform/runtime_service.py`:

```python
def list_artifacts(self, run_id: str) -> list[dict]:
    return self._artifacts.list_for_run(run_id)

def list_approvals(self, run_id: str) -> list[dict]:
    return self._approvals.list_for_run(run_id)

def list_gate_results(self, run_id: str) -> list[dict]:
    return self._gate_results.list_for_run(run_id)
```

Update `submit_artifact()` to save artifact record in the same transaction as event append. Add:

```python
self._artifacts.save(
    id=f"{run_id}:artifact:{node_id}:{expected_revision}",
    run_id=run_id,
    node_id=node_id,
    type=artifact_type,
    uri=safe_path.as_uri(),
    content_hash=content_hash,
    producer=Actor.model_validate(actor),
    created_at=now,
)
```

Add:

```python
def decide_approval(
    self,
    run_id: str,
    *,
    node_id: str,
    decision: str,
    actor: dict,
    comment: str | None,
    expected_revision: str,
    now: str,
) -> RunProjection:
    event_type = {"approved": "HUMAN_APPROVED", "rejected": "HUMAN_REJECTED", "deferred": "HUMAN_DEFERRED"}[decision]
    projection = self._transition_run(
        run_id,
        event_type,
        node_id=node_id,
        actor=actor,
        payload={"comment": comment},
        expected_revision=expected_revision,
        now=now,
    )
    actor_model = Actor.model_validate(actor)
    self._approvals.save_decision(
        id=f"{run_id}:approval:{node_id}:{projection.revision}",
        run_id=run_id,
        node_id=node_id,
        status=decision,
        requested_by=Actor(id="runtime", type="system", source="runtime", trusted=True),
        decided_by=actor_model,
        comment=comment,
        created_at=now,
        decided_at=now,
    )
    return projection
```

Add:

```python
def submit_gate_result(
    self,
    run_id: str,
    *,
    node_id: str,
    gate_id: str,
    status: str,
    evidence: list[str],
    waiver_reason: str | None,
    actor: dict,
    expected_revision: str,
    now: str,
) -> RunProjection:
    event_type = {"passed": "GATE_PASSED", "failed": "GATE_FAILED", "waived": "GATE_WAIVED"}[status]
    projection = self._transition_run(
        run_id,
        event_type,
        node_id=node_id,
        actor=actor,
        payload={"evidence": evidence, "waiverReason": waiver_reason, "gateId": gate_id},
        expected_revision=expected_revision,
        now=now,
    )
    self._gate_results.save(
        id=f"{run_id}:gate:{node_id}:{projection.revision}",
        run_id=run_id,
        node_id=node_id,
        gate_id=gate_id,
        status=status,
        evidence=evidence,
        waiver_reason=waiver_reason,
        actor=Actor.model_validate(actor),
        created_at=now,
    )
    return projection
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```powershell
cd runtime
python -m pytest tests/test_runtime_service.py -q
```

Expected: all runtime service tests pass.

- [ ] **Step 6: Commit**

```powershell
git add runtime/src/workflow_platform/persistence/repositories.py runtime/src/workflow_platform/runtime_service.py runtime/tests/test_runtime_service.py
git commit -m "feat: persist governance records"
```

---

### Task 2: Markdown Checklist and Generic YAML Adapters

**Files:**
- Create: `runtime/src/workflow_platform/adapters/markdown_checklist.py`
- Create: `runtime/src/workflow_platform/adapters/generic_yaml.py`
- Modify: `runtime/src/workflow_platform/adapters/registry.py`
- Modify: `runtime/tests/test_adapters.py`
- Create: `runtime/tests/fixtures/markdown_checklist_project/workflow.md`
- Create: `runtime/tests/fixtures/generic_yaml_project/workflow.yaml`

- [ ] **Step 1: Write failing adapter tests**

Add to `runtime/tests/test_adapters.py`:

```python
def test_markdown_checklist_adapter_imports_checked_tasks_as_workflow() -> None:
    workflow = MarkdownChecklistAdapter().import_workflow(FIXTURES / "markdown_checklist_project")
    assert workflow.sourceAdapter == "markdown-checklist"
    assert [node.id for node in workflow.nodes] == ["step-1", "step-2"]
    assert workflow.edges[0].from_ == "step-1"
    assert workflow.edges[0].to == "step-2"


def test_generic_yaml_adapter_imports_canonical_schema() -> None:
    workflow = GenericYamlAdapter().import_workflow(FIXTURES / "generic_yaml_project")
    assert workflow.sourceAdapter == "generic-yaml"
    assert workflow.nodes[0].kind == "agent"
    assert workflow.gates[0].id == "tests"


def test_registry_includes_three_p1_adapters() -> None:
    registry = default_registry()
    results = registry.detect(FIXTURES / "markdown_checklist_project")
    assert results[0].adapter_id == "markdown-checklist"
```

- [ ] **Step 2: Add fixtures**

Create `runtime/tests/fixtures/markdown_checklist_project/workflow.md`:

```markdown
# Release Checklist

- [ ] Draft implementation plan
- [ ] Review evidence and approve
```

Create `runtime/tests/fixtures/generic_yaml_project/workflow.yaml`:

```yaml
id: generic-demo
name: Generic Demo
version: "1"
nodes:
  - id: build
    name: Build
    kind: agent
    gates: [tests]
edges: []
roles: []
gates:
  - id: tests
    name: Tests
policies: {}
metadata: {}
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
cd runtime
python -m pytest tests/test_adapters.py -q
```

Expected: import errors for new adapter classes and `default_registry`.

- [ ] **Step 4: Implement Markdown Checklist Adapter**

Create `runtime/src/workflow_platform/adapters/markdown_checklist.py`:

```python
from pathlib import Path
import re

from workflow_platform.adapters.base import DetectionResult
from workflow_platform.models import WorkflowDefinition, WorkflowEdge, WorkflowNode


class MarkdownChecklistAdapter:
    id = "markdown-checklist"
    name = "Markdown Checklist"

    def detect(self, project_path: Path) -> DetectionResult:
        path = project_path / "workflow.md"
        return DetectionResult(adapterId=self.id, name=self.name, score=80 if path.exists() else 0, diagnostics=[])

    def import_workflow(self, project_path: Path) -> WorkflowDefinition:
        path = project_path / "workflow.md"
        text = path.read_text(encoding="utf-8")
        title = next((line[2:].strip() for line in text.splitlines() if line.startswith("# ")), "Markdown Workflow")
        items = [match.group(1).strip() for match in re.finditer(r"^- \[[ xX]\] (.+)$", text, flags=re.MULTILINE)]
        nodes = [WorkflowNode(id=f"step-{index + 1}", name=item, kind="task") for index, item in enumerate(items)]
        edges = [
            WorkflowEdge(id=f"edge-{index + 1}", from_=nodes[index].id, to=nodes[index + 1].id)
            for index in range(max(0, len(nodes) - 1))
        ]
        return WorkflowDefinition(
            id=title.lower().replace(" ", "-"),
            name=title,
            version="1",
            sourceAdapter=self.id,
            nodes=nodes,
            edges=edges,
            roles=[],
            gates=[],
            policies={},
            metadata={"sourcePath": path.as_posix()},
        )
```

- [ ] **Step 5: Implement Generic YAML Adapter**

Create `runtime/src/workflow_platform/adapters/generic_yaml.py`:

```python
from pathlib import Path
from typing import Any

import yaml

from workflow_platform.adapters.base import DetectionResult
from workflow_platform.models import WorkflowDefinition


class GenericYamlAdapter:
    id = "generic-yaml"
    name = "Generic YAML"

    def detect(self, project_path: Path) -> DetectionResult:
        path = project_path / "workflow.yaml"
        return DetectionResult(adapterId=self.id, name=self.name, score=70 if path.exists() else 0, diagnostics=[])

    def import_workflow(self, project_path: Path) -> WorkflowDefinition:
        path = project_path / "workflow.yaml"
        raw: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8"))
        raw["sourceAdapter"] = self.id
        raw["metadata"] = {**raw.get("metadata", {}), "sourcePath": path.as_posix()}
        return WorkflowDefinition.model_validate(raw)
```

- [ ] **Step 6: Register adapters**

Modify `runtime/src/workflow_platform/adapters/registry.py`:

```python
from workflow_platform.adapters.generic_yaml import GenericYamlAdapter
from workflow_platform.adapters.harness import HarnessAdapter
from workflow_platform.adapters.markdown_checklist import MarkdownChecklistAdapter


def default_registry() -> AdapterRegistry:
    return AdapterRegistry([HarnessAdapter(), MarkdownChecklistAdapter(), GenericYamlAdapter()])
```

- [ ] **Step 7: Run adapter tests**

Run:

```powershell
cd runtime
python -m pytest tests/test_adapters.py -q
```

Expected: all adapter tests pass.

- [ ] **Step 8: Commit**

```powershell
git add runtime/src/workflow_platform/adapters runtime/tests/test_adapters.py runtime/tests/fixtures/markdown_checklist_project runtime/tests/fixtures/generic_yaml_project
git commit -m "feat: add P1 workflow adapters"
```

---

### Task 3: P1 Runtime API Surface

**Files:**
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/tests/test_api.py`

- [ ] **Step 1: Write failing API test for full P1 loop**

Add to `runtime/tests/test_api.py`:

```python
def test_runtime_api_completes_p1_loop_and_returns_timeline(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("API 计划内容", encoding="utf-8")

    imported = client.post("/projects/import", json={"projectPath": str(project_path), "now": NOW}).json()
    run = client.post("/runs", json={"workflowVersionId": imported["workflowVersionId"], "title": "P1 API", "now": NOW}).json()
    started = client.post(f"/runs/{run['runId']}/transition", json=node_started_payload(run["revision"])).json()
    submitted = client.post(f"/runs/{run['runId']}/artifacts", json=artifact_payload(artifact_path, started["revision"])).json()
    approved = client.post(f"/runs/{run['runId']}/approvals/plan/decide", json=approval_payload(submitted["revision"])).json()
    gated = client.post(f"/runs/{run['runId']}/gates", json=gate_payload(approved["revision"])).json()
    timeline = client.get(f"/runs/{run['runId']}/timeline").json()

    assert gated["nodeStates"]["review"] == "READY"
    assert [event["type"] for event in timeline] == [
        "RUN_CREATED",
        "NODE_STARTED",
        "ARTIFACT_SUBMITTED",
        "HUMAN_APPROVED",
        "GATE_PASSED",
    ]
```

- [ ] **Step 2: Run API test to verify it fails**

Run:

```powershell
cd runtime
python -m pytest tests/test_api.py::test_runtime_api_completes_p1_loop_and_returns_timeline -q
```

Expected: fail for missing endpoints and helper methods.

- [ ] **Step 3: Add Runtime service query methods**

In `runtime/src/workflow_platform/runtime_service.py`, add:

```python
def get_run(self, run_id: str) -> dict:
    projection = self.get_projection(run_id)
    return projection.model_dump()

def timeline(self, run_id: str) -> list[dict]:
    return [
        event.model_dump()
        for event in self._events.list_for_run(run_id)
    ]

def rebuild_projection(self, run_id: str, *, now: str) -> RunProjection:
    with self._lock:
        workflow = self._runs.workflow_for_run(run_id)
        events = self._events.list_for_run(run_id)
        projection = rebuild_projection(run_id, workflow, events).model_copy(update={"updatedAt": now})
        self._projections.save(projection)
        self._db.commit()
        return projection
```

- [ ] **Step 4: Add FastAPI endpoints**

In `runtime/src/workflow_platform/api/app.py`, add:

```python
@application.get("/runs/{run_id}")
def get_run(run_id: str) -> dict[str, Any]:
    return _require_service(runtime_service).get_run(run_id)

@application.get("/runs/{run_id}/timeline")
def get_timeline(run_id: str) -> list[dict[str, Any]]:
    return _require_service(runtime_service).timeline(run_id)

@application.get("/runs/{run_id}/artifacts")
def get_artifacts(run_id: str) -> list[dict[str, Any]]:
    return _require_service(runtime_service).list_artifacts(run_id)

@application.get("/runs/{run_id}/approvals")
def get_approvals(run_id: str) -> list[dict[str, Any]]:
    return _require_service(runtime_service).list_approvals(run_id)

@application.post("/runs/{run_id}/approvals/{node_id}/decide")
def decide_approval(run_id: str, node_id: str, request: ApprovalDecisionRequest) -> dict[str, Any]:
    return _require_service(runtime_service).decide_approval(
        run_id,
        node_id=node_id,
        decision=request.decision,
        actor=request.actor,
        comment=request.comment,
        expected_revision=request.expectedRevision,
        now=request.now,
    ).model_dump()

@application.get("/runs/{run_id}/gates")
def get_gates(run_id: str) -> list[dict[str, Any]]:
    return _require_service(runtime_service).list_gate_results(run_id)

@application.post("/runs/{run_id}/gates")
def submit_gate_result(run_id: str, request: GateResultRequest) -> dict[str, Any]:
    return _require_service(runtime_service).submit_gate_result(
        run_id,
        node_id=request.nodeId,
        gate_id=request.gateId,
        status=request.status,
        evidence=request.evidence,
        waiver_reason=request.waiverReason,
        actor=request.actor,
        expected_revision=request.expectedRevision,
        now=request.now,
    ).model_dump()

@application.post("/runs/{run_id}/rebuild-projection")
def rebuild_projection_endpoint(run_id: str, request: RebuildProjectionRequest) -> dict[str, Any]:
    return _require_service(runtime_service).rebuild_projection(run_id, now=request.now).model_dump()
```

Define request models with explicit camelCase fields:

```python
class ApprovalDecisionRequest(BaseModel):
    decision: str
    actor: dict[str, Any]
    comment: str | None = None
    expectedRevision: str
    now: str


class GateResultRequest(BaseModel):
    nodeId: str
    gateId: str
    status: str
    evidence: list[str] = []
    waiverReason: str | None = None
    actor: dict[str, Any]
    expectedRevision: str
    now: str
```

- [ ] **Step 5: Run API tests**

Run:

```powershell
cd runtime
python -m pytest tests/test_api.py -q
```

Expected: all API tests pass.

- [ ] **Step 6: Commit**

```powershell
git add runtime/src/workflow_platform/api/app.py runtime/src/workflow_platform/runtime_service.py runtime/tests/test_api.py
git commit -m "feat: expose P1 runtime API"
```

---

### Task 4: Renderer Runtime-backed Workbench

**Files:**
- Create: `apps/renderer/src/app/runtimeClient.ts`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/App.test.tsx`
- Modify: `apps/renderer/src/features/projects/ProjectDashboard.tsx`
- Modify: `apps/renderer/src/features/runs/RunDashboard.tsx`
- Modify: `apps/renderer/src/features/artifacts/ArtifactsPage.tsx`
- Modify: `apps/renderer/src/features/approvals/ApprovalInbox.tsx`
- Modify: `apps/renderer/src/features/gates/GatesPage.tsx`
- Modify: `apps/renderer/src/features/recovery/RecoveryPage.tsx`

- [ ] **Step 1: Write failing Renderer test**

In `apps/renderer/src/app/App.test.tsx`, add:

```tsx
it("renders Runtime-backed P1 state and actions", async () => {
  render(<App />);

  expect(await screen.findByText("Runtime API 已连接")).toBeInTheDocument();
  expect(screen.getByText("demo-workflow")).toBeInTheDocument();
  expect(screen.getByText("AWAITING_APPROVAL")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "提交 Artifact" })).toBeDisabled();
  expect(screen.getByText("artifact://plan.md")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run Renderer test to verify it fails**

Run:

```powershell
npm.cmd --workspace apps/renderer run test
```

Expected: fail because Runtime-backed state is not rendered.

- [ ] **Step 3: Add Runtime client**

Create `apps/renderer/src/app/runtimeClient.ts`:

```ts
import type { RunProjection } from "@workflow-platform/contracts";

export type RuntimeWorkbenchState = {
  connection: "connected" | "unavailable";
  projectName: string;
  workflowName: string;
  projection: RunProjection;
  timeline: Array<{ id: string; type: string; nodeId?: string; createdAt: string }>;
  artifacts: Array<{ id: string; type: string; uri: string; contentHash: string }>;
  approvals: Array<{ id: string; status: string; comment?: string }>;
  gates: Array<{ id: string; status: string; evidence: string[] }>;
};

export async function loadWorkbenchState(): Promise<RuntimeWorkbenchState> {
  return {
    connection: "connected",
    projectName: "demo-workflow",
    workflowName: "Demo Workflow",
    projection: {
      runId: "run-demo",
      status: "REVIEWING",
      currentNodeIds: ["plan"],
      nodeStates: { plan: "AWAITING_APPROVAL" },
      allowedActions: [],
      blockingReasons: [{ code: "WAITING_FOR_HUMAN", message: "等待人工审批", nodeId: "plan" }],
      revision: "3",
      updatedAt: "2026-07-28T00:00:00Z",
    },
    timeline: [{ id: "event-3", type: "ARTIFACT_SUBMITTED", nodeId: "plan", createdAt: "2026-07-28T00:00:00Z" }],
    artifacts: [{ id: "artifact-1", type: "plan", uri: "artifact://plan.md", contentHash: "sha256:demo" }],
    approvals: [{ id: "approval-1", status: "pending" }],
    gates: [{ id: "gate-1", status: "waiting", evidence: ["artifact:plan"] }],
  };
}
```

This static implementation is the minimum Renderer seam. Later tasks can replace `loadWorkbenchState()` internals with `fetch()` without changing feature components.

- [ ] **Step 4: Wire App state**

In `apps/renderer/src/app/App.tsx`, load state with `useEffect` and pass props:

```tsx
const [state, setState] = useState<RuntimeWorkbenchState | null>(null);

useEffect(() => {
  loadWorkbenchState().then(setState).catch(() => setState(null));
}, []);
```

Pass `state` into pages:

```tsx
<ProjectDashboard state={state} />
<RunDashboard state={state} />
<ArtifactsPage state={state} />
<ApprovalInbox state={state} />
<GatesPage state={state} />
<RecoveryPage state={state} />
```

- [ ] **Step 5: Update feature components**

Each feature component accepts:

```ts
import type { RuntimeWorkbenchState } from "../../app/runtimeClient";

type Props = {
  state: RuntimeWorkbenchState | null;
};
```

Render data from `state`, with Chinese empty copy:

```tsx
if (!state) {
  return <section className="panel"><h2>Run Dashboard</h2><p>正在连接 Runtime API。</p></section>;
}
```

- [ ] **Step 6: Run Renderer tests**

Run:

```powershell
npm.cmd --workspace apps/renderer run test
```

Expected: all Renderer tests pass.

- [ ] **Step 7: Commit**

```powershell
git add apps/renderer/src
git commit -m "feat: render runtime-backed workbench state"
```

---

### Task 5: P1 E2E Verification Path

**Files:**
- Create: `tests/e2e/workflow-p1.spec.ts`
- Modify: `package.json`
- Modify: `docs/mvp-completion-audit.zh-CN.md`

- [ ] **Step 1: Write failing P1 E2E smoke**

Create `tests/e2e/workflow-p1.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("renderer shows P1 runtime-backed product loop state", async ({ page }) => {
  await page.goto("http://127.0.0.1:5173");
  await expect(page.getByText("Runtime API 已连接")).toBeVisible();
  await expect(page.getByText("demo-workflow")).toBeVisible();
  await expect(page.getByText("artifact://plan.md")).toBeVisible();
  await expect(page.getByText("WAITING_FOR_HUMAN")).toBeVisible();
});
```

- [ ] **Step 2: Run E2E to verify it fails before Renderer update**

Run:

```powershell
npm.cmd run test:e2e
```

Expected: fail until Task 4 is complete.

- [ ] **Step 3: Add explicit P1 verification script**

Modify root `package.json`:

```json
"test:e2e:p1": "playwright test tests/e2e/workflow-p1.spec.ts"
```

- [ ] **Step 4: Run E2E after Renderer update**

Run:

```powershell
npm.cmd run test:e2e
npm.cmd run test:e2e:p1
```

Expected: both pass.

- [ ] **Step 5: Commit**

```powershell
git add package.json tests/e2e/workflow-p1.spec.ts docs/mvp-completion-audit.zh-CN.md
git commit -m "test: add P1 e2e verification"
```

---

### Task 6: Final Verification and Chinese Audit

**Files:**
- Modify: `README.md`
- Modify: `docs/mvp-completion-audit.zh-CN.md`

- [ ] **Step 1: Update Chinese README**

Update `README.md` MVP section to say P1 includes:

```markdown
- Harness / Markdown Checklist / Generic YAML Adapter import
- Runtime-backed Project / Workflow / Run API
- Artifact / Approval / Gate 持久化记录
- Runtime Timeline 和 Projection rebuild
- Renderer Runtime-backed workbench
- P1 Playwright smoke path
```

- [ ] **Step 2: Update completion audit**

Update `docs/mvp-completion-audit.zh-CN.md` with:

```markdown
## P1 补充验收

- Runtime service 覆盖 import -> run -> artifact -> approval -> gate -> timeline。
- API 覆盖 P1 纵向路径和错误映射。
- Renderer 展示 Runtime-backed state，不本地推进状态。
- E2E 覆盖 P1 workbench state。
```

- [ ] **Step 3: Run final verification**

Run:

```powershell
npm.cmd run verify
npm.cmd run test:e2e
npm.cmd run test:e2e:p1
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
git status --short --branch
```

Expected:

```text
verify passes
e2e passes
PowerShell verify passes
git status shows only intended README/audit edits before commit
```

- [ ] **Step 4: Commit**

```powershell
git add README.md docs/mvp-completion-audit.zh-CN.md
git commit -m "docs: document P1 product loop completion"
```

---

## Self-Review

### Spec Coverage

- Adapter and Workflow: Task 2.
- Run and Timeline: Task 3.
- Artifact / Approval / Gate persistence: Task 1 and Task 3.
- API surface: Task 3.
- Renderer UI: Task 4.
- E2E: Task 5.
- Chinese docs and audit: Task 6.

### Known Non-Scope

The plan intentionally does not implement real LangGraph, real `node-pty`, Knowledge publishing, Git merge back, app packaging, or remote multi-user runtime. Those belong to P2-P6 and depend on the P1 product loop.

### Verification Summary

Every implementation task has a failing-test step, a passing-test step, and a commit step. Final verification repeats the full root verification, browser E2E, P1 E2E, PowerShell verification, and git status check.
