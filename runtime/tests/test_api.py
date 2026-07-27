from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from workflow_platform.api.app import app, create_app
from workflow_platform.main import health, run
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService


FIXTURES = __import__("pathlib").Path(__file__).parent / "fixtures"
NOW = "2026-07-27T13:00:00Z"
AGENT_ACTOR = {"id": "agent-1", "type": "agent", "source": "agent", "trusted": False}
HUMAN_ACTOR = {"id": "human-1", "type": "human", "source": "runtime", "trusted": True}
UNTRUSTED_HUMAN_ACTOR = {
    "id": "human-2",
    "type": "human",
    "source": "runtime",
    "trusted": False,
}
VERIFIER_ACTOR = {"id": "verifier-1", "type": "verifier", "source": "runtime", "trusted": True}


def copy_harness_project(tmp_path):
    project_path = tmp_path / "harness_project"
    workflow_dir = project_path / ".harness"
    workflow_dir.mkdir(parents=True)
    workflow_text = (FIXTURES / "harness_project" / ".harness" / "workflow.yaml").read_text(
        encoding="utf-8"
    )
    (workflow_dir / "workflow.yaml").write_text(workflow_text, encoding="utf-8")
    return project_path


def import_project_and_create_run(client: TestClient, tmp_path, *, title: str = "P1 API"):
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    run = client.post(
        "/runs",
        json={
            "workflowVersionId": imported["workflowVersionId"],
            "title": title,
            "now": NOW,
        },
    ).json()
    return project_path, run


def start_and_submit_plan(client: TestClient, run: dict, artifact_path) -> dict:
    started = client.post(
        f"/runs/{run['runId']}/transition",
        json={
            "eventType": "NODE_STARTED",
            "nodeId": "plan",
            "actor": AGENT_ACTOR,
            "expectedRevision": run["revision"],
            "now": NOW,
        },
    ).json()
    return client.post(
        f"/runs/{run['runId']}/artifacts",
        json={
            "nodeId": "plan",
            "artifactPath": str(artifact_path),
            "artifactType": "plan",
            "actor": AGENT_ACTOR,
            "expectedRevision": started["revision"],
            "now": NOW,
        },
    ).json()


def test_create_app_returns_fastapi_app() -> None:
    assert isinstance(create_app(), FastAPI)


def test_health_endpoint_returns_health_result() -> None:
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == health()


def test_module_app_is_created_app() -> None:
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200


def test_run_starts_uvicorn_with_runtime_app(monkeypatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_run(app_path: str, **kwargs: object) -> None:
        calls.append({"app_path": app_path, **kwargs})

    monkeypatch.setattr("uvicorn.run", fake_run)

    run()

    assert calls == [
        {
            "app_path": "workflow_platform.api.app:app",
            "host": "127.0.0.1",
            "port": 8765,
            "reload": False,
        }
    ]


def test_runtime_api_imports_project_creates_run_and_transitions(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    artifact_path = project_path / "api-plan.md"
    artifact_path.write_text("API 计划内容", encoding="utf-8")

    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": "2026-07-27T13:00:00Z"},
    )
    run = client.post(
        "/runs",
        json={
            "workflowVersionId": imported.json()["workflowVersionId"],
            "title": "API 纵向验证",
            "now": "2026-07-27T13:00:00Z",
        },
    )
    started = client.post(
        f"/runs/{run.json()['runId']}/transition",
        json={
            "eventType": "NODE_STARTED",
            "nodeId": "plan",
            "actor": {"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
            "expectedRevision": run.json()["revision"],
            "now": "2026-07-27T13:00:00Z",
        },
    )
    submitted = client.post(
        f"/runs/{run.json()['runId']}/artifacts",
        json={
            "nodeId": "plan",
            "artifactPath": str(artifact_path),
            "artifactType": "plan",
            "actor": {"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
            "expectedRevision": started.json()["revision"],
            "now": "2026-07-27T13:00:00Z",
        },
    )

    assert imported.status_code == 200
    assert run.status_code == 200
    assert started.status_code == 200
    assert submitted.status_code == 200
    assert submitted.json()["status"] == "REVIEWING"
    assert submitted.json()["nodeStates"]["plan"] == "AWAITING_APPROVAL"


def test_runtime_api_rejects_direct_artifact_transition_and_maps_conflicts(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)

    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": "2026-07-27T13:00:00Z"},
    )
    run_payload = {
        "workflowVersionId": imported.json()["workflowVersionId"],
        "title": "重复 Run",
        "now": "2026-07-27T13:00:00Z",
    }
    run = client.post("/runs", json=run_payload)
    duplicate_run = client.post("/runs", json=run_payload)
    started = client.post(
        f"/runs/{run.json()['runId']}/transition",
        json={
            "eventType": "NODE_STARTED",
            "nodeId": "plan",
            "actor": {"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
            "expectedRevision": run.json()["revision"],
            "now": "2026-07-27T13:00:00Z",
        },
    )
    direct_artifact = client.post(
        f"/runs/{run.json()['runId']}/transition",
        json={
            "eventType": "ARTIFACT_SUBMITTED",
            "nodeId": "plan",
            "actor": {"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
            "payload": {"artifactUri": "file:///unsafe.md", "artifactType": "plan"},
            "expectedRevision": started.json()["revision"],
            "now": "2026-07-27T13:00:00Z",
        },
    )
    missing_artifact = client.post(
        f"/runs/{run.json()['runId']}/artifacts",
        json={
            "nodeId": "plan",
            "artifactPath": str(project_path / "missing.md"),
            "artifactType": "plan",
            "actor": {"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
            "expectedRevision": started.json()["revision"],
            "now": "2026-07-27T13:00:00Z",
        },
    )

    assert duplicate_run.status_code == 409
    assert direct_artifact.status_code == 400
    assert "artifacts endpoint" in direct_artifact.json()["detail"]
    assert missing_artifact.status_code == 404


def test_runtime_api_completes_p1_loop_and_returns_timeline(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("API 计划内容", encoding="utf-8")

    submitted = start_and_submit_plan(client, run, artifact_path)
    approved = client.post(
        f"/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "计划通过",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    ).json()
    gated = client.post(
        f"/runs/{run['runId']}/gates",
        json={
            "nodeId": "plan",
            "gateId": "plan-ready",
            "status": "passed",
            "evidence": ["file://plan.md#ready"],
            "waiverReason": None,
            "actor": VERIFIER_ACTOR,
            "expectedRevision": approved["revision"],
            "now": NOW,
        },
    ).json()
    timeline = client.get(f"/runs/{run['runId']}/timeline").json()

    assert gated["nodeStates"]["review"] == "READY"
    assert [event["type"] for event in timeline] == [
        "RUN_CREATED",
        "NODE_STARTED",
        "ARTIFACT_SUBMITTED",
        "HUMAN_APPROVED",
        "GATE_PASSED",
    ]


def test_runtime_api_returns_persisted_side_records(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("API 计划内容", encoding="utf-8")

    submitted = start_and_submit_plan(client, run, artifact_path)
    approved = client.post(
        f"/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "批准进入门禁",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    ).json()
    client.post(
        f"/runs/{run['runId']}/gates",
        json={
            "nodeId": "plan",
            "gateId": "plan-ready",
            "status": "passed",
            "evidence": ["ci://gate/plan-ready"],
            "waiverReason": None,
            "actor": VERIFIER_ACTOR,
            "expectedRevision": approved["revision"],
            "now": NOW,
        },
    )

    artifacts = client.get(f"/runs/{run['runId']}/artifacts").json()
    approvals = client.get(f"/runs/{run['runId']}/approvals").json()
    gates = client.get(f"/runs/{run['runId']}/gates").json()

    assert artifacts[0]["nodeId"] == "plan"
    assert artifacts[0]["type"] == "plan"
    assert artifacts[0]["uri"] == artifact_path.resolve().as_uri()
    assert approvals[0]["status"] == "approved"
    assert approvals[0]["comment"] == "批准进入门禁"
    assert approvals[0]["decidedBy"] == HUMAN_ACTOR
    assert gates[0]["gateId"] == "plan-ready"
    assert gates[0]["status"] == "passed"
    assert gates[0]["evidence"] == ["ci://gate/plan-ready"]


def test_runtime_api_get_run_and_rebuild_projection_match_current_events(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("API 计划内容", encoding="utf-8")

    submitted = start_and_submit_plan(client, run, artifact_path)

    current = client.get(f"/runs/{run['runId']}").json()
    rebuilt = client.post(
        f"/runs/{run['runId']}/rebuild-projection",
        json={"now": "2026-07-27T13:05:00Z"},
    ).json()

    assert current == submitted
    assert rebuilt == submitted


def test_runtime_api_maps_p1_error_statuses(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("API 计划内容", encoding="utf-8")

    submitted = start_and_submit_plan(client, run, artifact_path)
    denied = client.post(
        f"/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": UNTRUSTED_HUMAN_ACTOR,
            "comment": "未授权审批",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    )
    conflict = client.post(
        f"/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "旧版本审批",
            "expectedRevision": run["revision"],
            "now": NOW,
        },
    )
    missing_run = client.get("/runs/run-missing")
    validation_error = client.post(
        f"/runs/{run['runId']}/gates",
        json={
            "nodeId": "plan",
            "gateId": "plan-ready",
            "status": "passed",
            "evidence": [],
            "waiverReason": None,
            "actor": VERIFIER_ACTOR,
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    )

    assert denied.status_code == 403
    assert conflict.status_code == 409
    assert missing_run.status_code == 404
    assert validation_error.status_code == 400
