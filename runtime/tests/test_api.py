from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import pytest
import sys
from threading import Lock
from time import sleep
import yaml

from workflow_platform.adapters.generic_yaml import GenericYamlAdapter
from workflow_platform.artifacts.service import hash_artifact
from workflow_platform.execution.providers import CliCommand, CodexCliProvider
from workflow_platform.api.app import app, create_app, create_runtime_app
from workflow_platform.main import health, run
from workflow_platform.models import Actor
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
FAKE_CLI = FIXTURES / "fake_cli.py"


class FakeProvider:
    id = "fake"

    def build_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        allowed_tools: list[str],
    ) -> CliCommand:
        return CliCommand(
            executable=sys.executable,
            args=[str(FAKE_CLI), "complete"],
            cwd=cwd,
        )

    def parse_line(self, line: str) -> dict:
        return CodexCliProvider(platform="linux").parse_line(line)


def copy_harness_project(tmp_path):
    project_path = tmp_path / "harness_project"
    workflow_dir = project_path / ".harness"
    workflow_dir.mkdir(parents=True)
    workflow_text = (FIXTURES / "harness_project" / ".harness" / "workflow.yaml").read_text(
        encoding="utf-8"
    )
    (workflow_dir / "workflow.yaml").write_text(workflow_text, encoding="utf-8")
    return project_path


def post_scoped_run(
    client: TestClient,
    *,
    project_id: str,
    workflow_version_id: str,
    workspace: Path,
    title: str,
    idempotency_key: str,
    task_goal: str | None = None,
    parameters: dict | None = None,
    now: str = NOW,
):
    return client.post(
        f"/projects/{project_id}/runs",
        headers={"Idempotency-Key": idempotency_key},
        json={
            "workflowVersionId": workflow_version_id,
            "title": title,
            "taskGoal": task_goal,
            "parameters": parameters or {},
            "executionWorkspace": {"path": str(workspace), "mode": "write"},
            "actor": HUMAN_ACTOR,
            "now": now,
        },
    )


def scoped_projection(response, project_id: str) -> dict:
    return {**response.json()["projection"], "projectId": project_id}


def import_project_and_create_run(client: TestClient, tmp_path, *, title: str = "P1 API"):
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    created = post_scoped_run(
        client,
        project_id=imported["projectId"],
        workflow_version_id=imported["workflowVersionId"],
        workspace=project_path,
        title=title,
        idempotency_key=f"test-run-{title}",
    )
    assert created.status_code == 201
    run = scoped_projection(created, imported["projectId"])
    return project_path, run


def execute_scoped_action(
    client: TestClient,
    run: dict,
    *,
    event_type: str,
    node_id: str | None,
    actor: dict,
    expected_revision: str,
    payload: dict | None = None,
) -> dict:
    action = next(
        candidate
        for candidate in run["allowedActions"]
        if candidate["eventType"] == event_type and candidate.get("nodeId") == node_id
    )
    response = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/actions",
        json={
            "actionId": action["id"],
            "expectedRevision": expected_revision,
            "actor": actor,
            "payload": payload,
            "now": NOW,
        },
    )
    assert response.status_code == 200
    return {**response.json()["projection"], "projectId": run["projectId"]}


def test_runtime_api_removes_unscoped_run_child_routes_and_returns_typed_scoped_errors(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    _project_path, run = import_project_and_create_run(client, tmp_path)

    assert client.get(f"/runs/{run['runId']}/artifacts").status_code == 404
    response = client.get(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents/missing/output"
    )
    assert response.status_code == 404
    assert response.json()["code"] == "RESOURCE_NOT_FOUND"


def test_runtime_api_scoped_action_returns_projection_and_emitted_events(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    _project_path, run = import_project_and_create_run(client, tmp_path)
    action = next(
        candidate
        for candidate in run["allowedActions"]
        if candidate["eventType"] == "NODE_STARTED" and candidate.get("nodeId") == "plan"
    )

    response = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/actions",
        json={
            "actionId": action["id"],
            "expectedRevision": run["revision"],
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )

    assert response.status_code == 200
    assert set(response.json()) == {"projection", "emittedEvents"}
    assert len(response.json()["emittedEvents"]) == 1
    emitted_event = response.json()["emittedEvents"][0]
    assert emitted_event["revision"] == response.json()["projection"]["revision"]
    assert emitted_event["type"] == action["eventType"]


def test_runtime_api_scoped_action_does_not_include_a_later_transition(
    tmp_path, monkeypatch
) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    client = TestClient(create_app(service))
    _project_path, run = import_project_and_create_run(client, tmp_path)
    original_timeline = service.timeline

    def timeline_after_pause(run_id: str) -> list[dict]:
        current = service.get_projection(run_id)
        pause = next(
            action for action in current.allowedActions if action.eventType == "RUN_PAUSED"
        )
        service.execute_scoped_action(
            run["projectId"],
            run_id,
            action_id=pause.id,
            expected_revision=current.revision,
            actor=HUMAN_ACTOR,
            payload=None,
            now="2026-07-27T13:01:00Z",
        )
        return original_timeline(run_id)

    monkeypatch.setattr(service, "timeline", timeline_after_pause)
    action = next(
        candidate
        for candidate in run["allowedActions"]
        if candidate["eventType"] == "NODE_STARTED"
    )

    response = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/actions",
        json={
            "actionId": action["id"],
            "expectedRevision": run["revision"],
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )

    assert response.status_code == 200
    assert len(response.json()["emittedEvents"]) == 1
    assert response.json()["emittedEvents"][0]["revision"] == response.json()["projection"]["revision"]


def test_runtime_api_scoped_artifact_action_uses_typed_artifact_service(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    started = execute_scoped_action(
        client,
        run,
        event_type="NODE_STARTED",
        node_id="plan",
        actor=AGENT_ACTOR,
        expected_revision=run["revision"],
    )
    artifact_path = project_path / "scoped-plan.md"
    artifact_path.write_text("Scoped plan", encoding="utf-8")
    action = next(
        candidate
        for candidate in started["allowedActions"]
        if candidate["eventType"] == "ARTIFACT_SUBMITTED"
    )

    response = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/actions",
        json={
            "actionId": action["id"],
            "expectedRevision": started["revision"],
            "actor": AGENT_ACTOR,
            "payload": {
                "artifactPath": str(artifact_path),
                "artifactType": "plan",
            },
            "now": NOW,
        },
    )

    assert response.status_code == 200
    assert response.json()["emittedEvents"][0]["type"] == "ARTIFACT_SUBMITTED"
    artifacts = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts").json()
    assert artifacts[0]["uri"] == artifact_path.resolve().as_uri()
    approval_action = next(
        candidate
        for candidate in response.json()["projection"]["allowedActions"]
        if candidate["eventType"] == "HUMAN_APPROVED"
    )
    approved = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/actions",
        json={
            "actionId": approval_action["id"],
            "expectedRevision": response.json()["projection"]["revision"],
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )

    assert approved.status_code == 200
    assert approved.json()["emittedEvents"][0]["type"] == "HUMAN_APPROVED"
    assert client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/approvals").json()[0]["status"] == "approved"
    gate_action = next(
        candidate
        for candidate in approved.json()["projection"]["allowedActions"]
        if candidate["eventType"] == "GATE_PASSED"
    )
    spoofed_gate = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/actions",
        json={
            "actionId": gate_action["id"],
            "expectedRevision": approved.json()["projection"]["revision"],
            "actor": VERIFIER_ACTOR,
            "payload": {
                "gateId": "spoofed-gate",
                "evidenceUri": artifact_path.resolve().as_uri(),
            },
            "now": NOW,
        },
    )

    assert spoofed_gate.status_code == 400
    assert client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/gates").json() == []
    gated = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/actions",
        json={
            "actionId": gate_action["id"],
            "expectedRevision": approved.json()["projection"]["revision"],
            "actor": VERIFIER_ACTOR,
            "payload": {"evidenceUri": artifact_path.resolve().as_uri()},
            "now": NOW,
        },
    )

    assert gated.status_code == 200
    assert gated.json()["emittedEvents"][0]["type"] == "GATE_PASSED"
    assert client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/gates").json()[0]["status"] == "passed"


def test_runtime_api_persists_run_objective_and_parameters(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()

    created = client.post(
        f"/projects/{imported['projectId']}/runs",
        headers={"Idempotency-Key": "run-objective-and-parameters"},
        json={
            "workflowVersionId": imported["workflowVersionId"],
            "title": "生产发布准备",
            "taskGoal": "验证发布流程并生成可审计报告",
            "parameters": {"dryRun": True, "region": "cn-north-1"},
            "executionWorkspace": {"path": str(project_path), "mode": "write"},
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    run_id = created.json()["projection"]["runId"]
    detail = client.get(f"/projects/{imported['projectId']}/runs/{run_id}")

    assert created.status_code == 201
    assert detail.status_code == 200
    assert detail.json()["context"]["taskGoal"] == "验证发布流程并生成可审计报告"
    assert detail.json()["context"]["parameters"] == {
        "dryRun": True,
        "region": "cn-north-1",
    }


def test_runtime_api_scans_declared_node_artifacts(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    definition = client.get(f"/workflow-versions/{imported['workflowVersionId']}").json()
    plan_node = next(node for node in definition["nodes"] if node["id"] == "plan")
    plan_node["artifacts"] = {
        "outputs": [
            {
                "id": "plan-report",
                "name": "计划报告",
                "type": "plan",
                "required": True,
                "path": "docs/runs/{{runId}}/{{nodeId}}/plan.md",
            }
        ]
    }
    saved = client.post(
        f"/workflow-versions/{imported['workflowVersionId']}/save",
        json={"definition": definition, "actor": HUMAN_ACTOR, "now": NOW},
    ).json()
    run_response = client.post(
        f"/projects/{imported['projectId']}/runs",
        headers={"Idempotency-Key": "scan-node-artifacts"},
        json={
            "workflowVersionId": saved["workflowVersionId"],
            "title": "扫描产物",
            "executionWorkspace": {"path": str(project_path), "mode": "write"},
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    assert run_response.status_code == 201
    run = {**run_response.json()["projection"], "projectId": imported["projectId"]}
    artifact = project_path / "docs" / "runs" / run["runId"] / "plan" / "plan.md"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("# 计划\n", encoding="utf-8")
    started = execute_scoped_action(
        client,
        run,
        event_type="NODE_STARTED",
        node_id="plan",
        actor=AGENT_ACTOR,
        expected_revision=run["revision"],
    )

    response = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/nodes/plan/artifacts/scan",
        json={"expectedRevision": started["revision"], "now": NOW},
    )

    assert response.status_code == 200
    assert response.json()["registered"] == ["plan-report"]
    assert response.json()["projection"]["nodeStates"]["plan"] == "RUNNING"

    requirements = client.get(
        f"/projects/{run['projectId']}/runs/{run['runId']}/nodes/plan/artifact-requirements"
    )

    assert requirements.status_code == 200
    assert requirements.json()["requirements"][0]["relativePath"].endswith("/plan/plan.md")
    assert requirements.json()["requirements"][0]["required"] is True
    assert len(requirements.json()["requirements"][0]["artifacts"]) == 1


def start_and_submit_plan(client: TestClient, run: dict, artifact_path) -> dict:
    started = execute_scoped_action(
        client,
        run,
        event_type="NODE_STARTED",
        node_id="plan",
        actor=AGENT_ACTOR,
        expected_revision=run["revision"],
    )
    return client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts",
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


def test_runtime_api_serializes_concurrent_database_requests(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    client = TestClient(create_app(service))
    _project_path, run = import_project_and_create_run(client, tmp_path)
    original_get_projection = service.get_projection
    counter_lock = Lock()
    active_requests = 0
    maximum_active_requests = 0

    def delayed_get_projection(run_id: str):
        nonlocal active_requests, maximum_active_requests
        with counter_lock:
            active_requests += 1
            maximum_active_requests = max(maximum_active_requests, active_requests)
        try:
            sleep(0.02)
            return original_get_projection(run_id)
        finally:
            with counter_lock:
                active_requests -= 1

    service.get_projection = delayed_get_projection  # type: ignore[method-assign]

    with ThreadPoolExecutor(max_workers=6) as executor:
        responses = list(
            executor.map(
                lambda _index: client.get(
                    f"/projects/{run['projectId']}/runs/{run['runId']}/projection"
                ),
                range(6),
            )
        )

    assert [response.status_code for response in responses] == [200] * 6
    assert maximum_active_requests == 1


def test_runtime_api_rejects_requests_without_configured_local_token() -> None:
    client = TestClient(
        create_app(
            cli_diagnostics=lambda provider: {
                "id": provider,
                "available": True,
                "reason": None,
                "executable": provider,
                "version": "test",
            },
            local_token="local-test-token",
        )
    )

    assert client.get("/health").status_code == 200
    assert client.get("/agents/providers").status_code == 401
    assert client.get(
        "/agents/providers",
        headers={"X-Workflow-Platform-Token": "wrong-token"},
    ).status_code == 401
    assert client.get(
        "/agents/providers",
        headers={"X-Workflow-Platform-Token": "local-test-token"},
    ).status_code == 200


def test_runtime_api_exports_redacted_diagnostic_support_bundle() -> None:
    client = TestClient(
        create_app(
            cli_diagnostics=lambda provider: {
                "id": provider,
                "executable": f"{provider}.cmd",
                "available": provider == "codex",
                "path": "C:\\Tools\\codex.cmd" if provider == "codex" else None,
                "version": "1.2.3" if provider == "codex" else None,
                "message": "token=sk-live-diagnostic-secret",
            },
        )
    )

    response = client.get("/diagnostics/support-bundle")

    assert response.status_code == 200
    payload = response.json()
    assert payload["fileName"] == "workflow-platform-diagnostics.json"
    assert payload["mediaType"] == "application/json"
    assert "Runtime 诊断支持包" in payload["content"]
    assert "sk-live-diagnostic-secret" not in payload["content"]
    assert "[REDACTED]" in payload["content"]
    assert "请安装 Claude Code CLI 并完成认证" in payload["content"]


def test_health_endpoint_returns_health_result() -> None:
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == health()


def test_runtime_api_lists_cli_provider_diagnostics() -> None:
    diagnostics = {
        "codex": {
            "id": "codex",
            "executable": "codex.cmd",
            "available": True,
            "path": "C:\\Tools\\codex.cmd",
            "version": "1.0.0",
            "message": "已检测到 Codex CLI。",
        },
        "claude": {
            "id": "claude",
            "executable": "claude.cmd",
            "available": False,
            "path": None,
            "version": None,
            "message": "未找到 claude.cmd，请安装 Claude Code CLI 并确保其位于 PATH 中。",
        },
    }
    client = TestClient(create_app(cli_diagnostics=lambda provider: diagnostics[provider]))

    response = client.get("/agents/providers")

    assert response.status_code == 200
    assert response.json() == [diagnostics["codex"], diagnostics["claude"]]


@pytest.mark.parametrize("origin", ["http://127.0.0.1:5173", "http://127.0.0.1:5174"])
def test_runtime_api_allows_local_renderer_cors(origin: str) -> None:
    client = TestClient(create_app())

    response = client.options(
        "/health",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == origin


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
            "app_path": "workflow_platform.api.app:create_runtime_app",
            "host": "127.0.0.1",
            "port": 8765,
            "reload": False,
            "factory": True,
        }
    ]


def test_runtime_app_factory_configures_service(tmp_path) -> None:
    client = TestClient(create_runtime_app(tmp_path / "runtime.db"))
    project_path = copy_harness_project(tmp_path)

    response = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    )

    assert response.status_code == 200
    assert response.json()["workflowVersionId"].startswith("workflow-version-")


def test_runtime_api_manages_workflow_library_templates_and_project_bindings(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = tmp_path / "empty-project"
    project_path.mkdir()
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()

    assert imported["workflowBindingStatus"] == "unbound"
    assert imported["workflowVersionId"] is None

    definition = yaml.safe_load(
        (FIXTURES / "harness_project" / ".harness" / "workflow.yaml").read_text(encoding="utf-8")
    )
    definition["sourceAdapter"] = "workflow-library"
    definition["metadata"] = {}
    template = client.post(
        "/workflows",
        json={"definition": definition, "isBuiltin": True, "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert template.status_code == 200, template.text
    template_id = template.json()["workflowId"]
    assert post_scoped_run(
        client,
        project_id="project-missing",
        workflow_version_id=template.json()["workflowVersionId"],
        workspace=project_path,
        title="missing project",
        idempotency_key="missing-project",
    ).status_code == 404
    assert post_scoped_run(
        client,
        project_id=imported["projectId"],
        workflow_version_id=template.json()["workflowVersionId"],
        workspace=project_path,
        title="unbound",
        idempotency_key="unbound-project",
    ).status_code == 400
    assert client.get("/workflows").json()[0]["isBuiltin"] is True
    assert client.post(
        f"/workflow-versions/{template.json()['workflowVersionId']}/save",
        json={"definition": definition, "actor": HUMAN_ACTOR, "now": "2026-08-04T00:01:00Z"},
    ).status_code == 400

    copied = client.post(
        f"/workflows/{template_id}/copy",
        json={"name": "项目实施流程", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert copied.status_code == 200
    assert copied.json()["isBuiltin"] is False
    assert copied.json()["workflowId"] != template_id

    bound = client.post(
        f"/projects/{imported['projectId']}/workflow-binding",
        json={
            "workflowId": copied.json()["workflowId"],
            "workflowVersionId": copied.json()["workflowVersionId"],
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    assert bound.status_code == 200
    assert bound.json()["workflowBindingStatus"] == "bound"
    assert client.get(f"/projects/{imported['projectId']}/workflow-binding").json()["workflowId"] == copied.json()["workflowId"]
    assert post_scoped_run(
        client,
        project_id=imported["projectId"],
        workflow_version_id=copied.json()["workflowVersionId"],
        workspace=project_path,
        title="bound default",
        idempotency_key="bound-default",
    ).status_code == 201
    assert post_scoped_run(
        client,
        project_id=imported["projectId"],
        workflow_version_id=template.json()["workflowVersionId"],
        workspace=project_path / "cross-asset",
        title="cross asset",
        idempotency_key="cross-asset",
    ).status_code == 400


def test_runtime_api_returns_workflow_definition_and_compile_diagnostics(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)

    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    definition = client.get(f"/workflow-versions/{imported['workflowVersionId']}")
    compiled = client.post(f"/workflow-versions/{imported['workflowVersionId']}/compile")

    assert definition.status_code == 200
    assert definition.json()["id"] == "demo-workflow"
    assert definition.json()["nodes"][0]["id"] == "plan"
    assert compiled.status_code == 200
    assert compiled.json()["graphSpec"]["nodes"][0] == {
        "id": definition.json()["nodes"][0]["id"],
        "label": definition.json()["nodes"][0]["name"],
        "kind": definition.json()["nodes"][0]["kind"],
    }
    assert compiled.json()["diagnostics"] == []


def test_runtime_api_workflow_export_supports_canonical_json_and_generic_yaml(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(copy_harness_project(tmp_path)), "now": NOW},
    ).json()

    canonical = client.get(
        f"/workflow-versions/{imported['workflowVersionId']}/export",
        params={"format": "canonical-json"},
    )
    generic_yaml = client.get(
        f"/workflow-versions/{imported['workflowVersionId']}/export",
        params={"format": "generic-yaml"},
    )
    invalid = client.get(
        f"/workflow-versions/{imported['workflowVersionId']}/export",
        params={"format": "unsupported"},
    )

    assert canonical.status_code == 200
    assert canonical.json()["mediaType"] == "application/json"
    assert canonical.json()["fileName"].endswith(".json")
    assert json.loads(canonical.json()["content"])["id"] == "demo-workflow"
    assert generic_yaml.status_code == 200
    assert generic_yaml.json()["mediaType"] == "application/x-yaml"
    assert generic_yaml.json()["fileName"].endswith(".yaml")
    assert yaml.safe_load(generic_yaml.json()["content"])["id"] == "demo-workflow"
    assert invalid.status_code == 400
    assert "WORKFLOW_EXPORT_FORMAT_INVALID" in invalid.json()["detail"]

    generic_project = tmp_path / "generic_export"
    generic_project.mkdir()
    (generic_project / "workflow.yaml").write_text(
        generic_yaml.json()["content"],
        encoding="utf-8",
    )
    reimported = GenericYamlAdapter().import_workflow(generic_project)

    assert reimported.id == "demo-workflow"
    assert reimported.sourceAdapter == "generic-yaml"


def test_runtime_api_project_archive_and_reimport_reactivates_it(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    (project_path / "historical").mkdir()
    (project_path / "archived").mkdir()
    historical_run = post_scoped_run(
        client,
        project_id=imported["projectId"],
        workflow_version_id=imported["workflowVersionId"],
        workspace=project_path / "historical",
        title="归档前历史 Run",
        idempotency_key="historical-run",
    )

    archived = client.post(
        f"/projects/{imported['projectId']}/archive",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )
    definition = client.get(f"/workflow-versions/{imported['workflowVersionId']}")
    rejected_run = post_scoped_run(
        client,
        project_id=imported["projectId"],
        workflow_version_id=imported["workflowVersionId"],
        workspace=project_path / "archived",
        title="归档后不应创建",
        idempotency_key="archived-run",
    )
    reimported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": "2026-07-28T00:00:00Z"},
    )
    restored_run = post_scoped_run(
        client,
        project_id=reimported.json()["projectId"],
        workflow_version_id=reimported.json()["workflowVersionId"],
        workspace=project_path,
        title="重导入后创建",
        idempotency_key="restored-run",
        now="2026-07-28T00:00:00Z",
    )
    audit = client.get("/audit-records?action=project.archived")

    assert historical_run.status_code == 201
    assert archived.status_code == 200
    assert archived.json()["projectId"] == imported["projectId"]
    assert definition.status_code == 200
    assert rejected_run.status_code == 409
    assert rejected_run.json()["code"] == "PROJECT_ARCHIVED"
    assert reimported.status_code == 200
    assert reimported.json()["projectId"] == imported["projectId"]
    assert restored_run.status_code == 201
    assert audit.json()[0]["resource"] == f"project:{imported['projectId']}"


def test_runtime_api_saves_an_immutable_workflow_version_with_audit_record(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    definition = client.get(f"/workflow-versions/{imported['workflowVersionId']}").json()
    definition["nodes"][0]["name"] = "更新后的计划"

    saved = client.post(
        f"/workflow-versions/{imported['workflowVersionId']}/save",
        json={"definition": definition, "actor": HUMAN_ACTOR, "now": NOW},
    )
    original = client.get(f"/workflow-versions/{imported['workflowVersionId']}")
    audit = client.get("/audit-records?action=workflow.version.created")

    assert saved.status_code == 200
    assert saved.json()["workflowVersionId"] != imported["workflowVersionId"]
    assert saved.json()["definition"]["nodes"][0]["name"] == "更新后的计划"
    assert original.json()["nodes"][0]["name"] != "更新后的计划"
    assert audit.json()[0]["resource"] == f"workflow-version:{saved.json()['workflowVersionId']}"


def test_runtime_api_simulates_a_workflow_version_without_creating_a_run(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()

    simulation = client.post(f"/workflow-versions/{imported['workflowVersionId']}/simulate")

    assert simulation.status_code == 200
    assert simulation.json()["status"] == "ready"
    assert simulation.json()["steps"][0] == {"nodeId": "plan", "state": "READY"}
    assert client.get(
        f"/projects/{imported['projectId']}/runs/run-does-not-exist"
    ).status_code == 404


def test_runtime_api_lists_workflow_version_history_and_semantic_diff(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    original_definition = client.get(
        f"/workflow-versions/{imported['workflowVersionId']}"
    ).json()
    updated_definition = {
        **original_definition,
        "nodes": [
            {
                **original_definition["nodes"][0],
                "name": "更新后的计划",
                "description": "通过版本比较确认变更",
            },
            *original_definition["nodes"][1:],
        ],
    }
    saved = client.post(
        f"/workflow-versions/{imported['workflowVersionId']}/save",
        json={"definition": updated_definition, "actor": HUMAN_ACTOR, "now": NOW},
    ).json()

    history = client.get(f"/workflow-versions/{saved['workflowVersionId']}/history")
    diff = client.get(
        f"/workflow-versions/{saved['workflowVersionId']}/diff",
        params={"against": imported["workflowVersionId"]},
    )

    assert history.status_code == 200
    assert [entry["id"] for entry in history.json()] == [
        imported["workflowVersionId"],
        saved["workflowVersionId"],
    ]
    assert history.json()[1]["version"] == saved["definition"]["version"]
    assert history.json()[0]["nodeCount"] == len(original_definition["nodes"])
    assert history.json()[0]["edgeCount"] == len(original_definition["edges"])
    assert history.json()[0]["nodeSummary"]
    assert diff.status_code == 200
    assert diff.json()["fromVersionId"] == imported["workflowVersionId"]
    assert diff.json()["toVersionId"] == saved["workflowVersionId"]
    assert diff.json()["changedNodes"] == [
        {
                "id": "plan",
                "changes": {
                    "description": {
                        "from": original_definition["nodes"][0]["description"],
                        "to": "通过版本比较确认变更",
                    },
                "name": {"from": original_definition["nodes"][0]["name"], "to": "更新后的计划"},
            },
        }
    ]


def test_runtime_api_returns_recovery_diagnostics_for_a_run(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    run = scoped_projection(
        post_scoped_run(
            client,
            project_id=imported["projectId"],
            workflow_version_id=imported["workflowVersionId"],
            workspace=project_path,
            title="恢复诊断",
            idempotency_key="recovery-diagnostics",
        ),
        imported["projectId"],
    )

    diagnostics = client.get(f"/projects/{imported['projectId']}/runs/{run['runId']}/recovery-diagnostics")

    assert diagnostics.status_code == 200
    assert diagnostics.json()["runId"] == run["runId"]
    assert diagnostics.json()["eventCount"] == 1
    assert diagnostics.json()["projectionStatus"] == "CREATED"
    assert diagnostics.json()["orphanAgentJobIds"] == []
    assert diagnostics.json()["rebuildAvailable"] is True


def test_runtime_api_registers_and_lists_run_bound_terminal_sessions(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)

    created = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/terminals",
        json={
            "nodeId": "plan",
            "kind": "shell",
            "cwd": str(project_path),
            "pid": 5678,
            "now": NOW,
        },
    )
    sessions = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/terminals")

    assert created.status_code == 200
    assert created.json()["runId"] == run["runId"]
    assert created.json()["nodeId"] == "plan"
    assert created.json()["status"] == "running"
    assert sessions.status_code == 200
    assert sessions.json() == [created.json()]


def test_runtime_api_records_terminal_command_decision_for_trusted_human(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    session = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/terminals",
        json={
            "nodeId": "plan",
            "kind": "shell",
            "cwd": str(project_path),
            "pid": 5678,
            "now": NOW,
        },
    ).json()

    recorded = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/terminals/{session['id']}/command-decisions",
        json={
            "decision": "rejected",
            "riskLevel": "high",
            "commandSummary": "git reset --hard",
            "impact": "丢弃项目内未提交变更。",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    denied = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/terminals/{session['id']}/command-decisions",
        json={
            "decision": "approved",
            "riskLevel": "high",
            "commandSummary": "git reset --hard",
            "impact": "丢弃项目内未提交变更。",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )

    assert recorded.status_code == 200
    assert recorded.json()["action"] == "terminal.command.rejected"
    assert denied.status_code == 403


def test_runtime_api_appends_and_reads_terminal_scrollback(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    session = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/terminals",
        json={
            "nodeId": "plan",
            "kind": "shell",
            "cwd": str(project_path),
            "pid": 5678,
            "now": NOW,
        },
    ).json()

    appended = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/terminals/{session['id']}/output",
        json={"stream": "stdout", "data": "hello\n", "now": NOW},
    )
    output = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/terminals/{session['id']}/output?afterSequence=0")

    assert appended.status_code == 200
    assert output.status_code == 200
    assert output.json() == [
        {
            "id": f"{session['id']}:output:1",
            "sessionId": session["id"],
            "sequence": 1,
            "stream": "stdout",
            "data": "hello\n",
            "createdAt": NOW,
        }
    ]


def test_runtime_api_exports_terminal_scrollback_as_human_evidence(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    session = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/terminals",
        json={
            "nodeId": "plan",
            "kind": "shell",
            "cwd": str(project_path),
            "pid": 5678,
            "now": NOW,
        },
    ).json()
    client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/terminals/{session['id']}/output",
        json={"stream": "stdout", "data": "done\n", "now": NOW},
    )

    evidence = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/terminals/{session['id']}/evidence",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )

    assert evidence.status_code == 200
    assert evidence.json()["type"] == "evidence"
    assert evidence.json()["nodeId"] == "plan"
    assert evidence.json()["uri"].endswith(f".workflow-platform/evidence/{session['id']}-1-1.log")


def test_runtime_api_cleans_orphan_agent_jobs_during_recovery(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    client = TestClient(create_app(service))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    run = scoped_projection(
        post_scoped_run(
            client,
            project_id=imported["projectId"],
            workflow_version_id=imported["workflowVersionId"],
            workspace=project_path,
            title="清理遗留 Agent",
            idempotency_key="cleanup-orphan-agent",
        ),
        imported["projectId"],
    )
    service._agent_jobs.create(
        id="job-orphan",
        project_id=imported["projectId"],
        run_id=run["runId"],
        node_id="plan",
        provider="fake",
        status="RUNNING",
        command=["fake-cli"],
        cwd=str(project_path),
        created_at=NOW,
    )
    db.commit()

    cleaned = client.post(
        f"/projects/{imported['projectId']}/runs/{run['runId']}/recovery/cleanup-orphan-agents",
        json={"now": NOW},
    )
    jobs = client.get(f"/projects/{imported['projectId']}/runs/{run['runId']}/agents")

    assert cleaned.status_code == 200
    assert cleaned.json()["cleanedJobIds"] == ["job-orphan"]
    assert jobs.json()[0]["status"] == "CANCELLED"
    assert jobs.json()[0]["error"] == "RECOVERY_ORPHANED: Runtime 执行器已不可用"


def test_runtime_api_cleans_orphan_terminal_sessions_during_recovery(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    project_id = run["projectId"]
    session = client.post(
        f"/projects/{project_id}/runs/{run['runId']}/terminals",
        json={
            "nodeId": "plan",
            "kind": "shell",
            "cwd": str(project_path),
            "pid": 5678,
            "now": NOW,
        },
    ).json()

    cleaned = client.post(
        f"/projects/{project_id}/runs/{run['runId']}/recovery/cleanup-orphan-terminals",
        json={"now": NOW},
    )

    assert cleaned.status_code == 200
    assert cleaned.json() == {"runId": run["runId"], "cleanedSessionIds": [session["id"]]}


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
    run_response = post_scoped_run(
        client,
        project_id=imported.json()["projectId"],
        workflow_version_id=imported.json()["workflowVersionId"],
        workspace=project_path,
        title="API 纵向验证",
        idempotency_key="vertical-api",
    )
    run = scoped_projection(run_response, imported.json()["projectId"])
    started = execute_scoped_action(
        client,
        run,
        event_type="NODE_STARTED",
        node_id="plan",
        actor=AGENT_ACTOR,
        expected_revision=run["revision"],
    )
    submitted = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts",
        json={
            "nodeId": "plan",
            "artifactPath": str(artifact_path),
            "artifactType": "plan",
            "actor": {"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
            "expectedRevision": started["revision"],
            "now": "2026-07-27T13:00:00Z",
        },
    )

    assert imported.status_code == 200
    assert run_response.status_code == 201
    assert submitted.status_code == 200
    assert submitted.json()["status"] == "REVIEWING"
    assert submitted.json()["nodeStates"]["plan"] == "AWAITING_APPROVAL"


def test_runtime_api_rejects_unknown_scoped_action_and_maps_conflicts(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)

    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": "2026-07-27T13:00:00Z"},
    )
    run_response = post_scoped_run(
        client,
        project_id=imported.json()["projectId"],
        workflow_version_id=imported.json()["workflowVersionId"],
        workspace=project_path,
        title="重复 Run",
        idempotency_key="duplicate-run",
    )
    run = scoped_projection(run_response, imported.json()["projectId"])
    (project_path / "duplicate").mkdir()
    duplicate_run = post_scoped_run(
        client,
        project_id=imported.json()["projectId"],
        workflow_version_id=imported.json()["workflowVersionId"],
        workspace=project_path / "duplicate",
        title="不同请求",
        idempotency_key="duplicate-run",
    )
    started = execute_scoped_action(
        client,
        run,
        event_type="NODE_STARTED",
        node_id="plan",
        actor=AGENT_ACTOR,
        expected_revision=run["revision"],
    )
    direct_artifact = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/actions",
        json={
            "actionId": "submit-artifact-directly",
            "actor": AGENT_ACTOR,
            "payload": {"artifactUri": "file:///unsafe.md", "artifactType": "plan"},
            "expectedRevision": started["revision"],
            "now": "2026-07-27T13:00:00Z",
        },
    )
    missing_artifact = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts",
        json={
            "nodeId": "plan",
            "artifactPath": str(project_path / "missing.md"),
            "artifactType": "plan",
            "actor": {"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
            "expectedRevision": started["revision"],
            "now": "2026-07-27T13:00:00Z",
        },
    )

    assert duplicate_run.status_code == 400
    assert direct_artifact.status_code == 409
    assert direct_artifact.json()["code"] == "INVALID_REQUEST"
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
        f"/projects/{run['projectId']}/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "计划通过",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    ).json()
    gated = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/gates",
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
    timeline = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/timeline").json()

    assert gated["nodeStates"]["review"] == "READY"
    assert [event["type"] for event in timeline] == [
        "RUN_CREATED",
        "NODE_STARTED",
        "ARTIFACT_SUBMITTED",
        "HUMAN_APPROVED",
        "GATE_PASSED",
    ]


def test_runtime_api_automatically_passes_configured_gate_with_artifact_evidence(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("自动 Gate 的证据", encoding="utf-8")
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    definition = client.get(f"/workflow-versions/{imported['workflowVersionId']}").json()
    definition["gates"][0]["metadata"] = {
        "automatic": {"requiredArtifactTypes": ["plan"]},
    }
    saved = client.post(
        f"/workflow-versions/{imported['workflowVersionId']}/save",
        json={"definition": definition, "actor": HUMAN_ACTOR, "now": NOW},
    ).json()
    run = scoped_projection(
        post_scoped_run(
            client,
            project_id=imported["projectId"],
            workflow_version_id=saved["workflowVersionId"],
            workspace=project_path,
            title="自动 Gate 验收",
            idempotency_key="automatic-gate",
        ),
        imported["projectId"],
    )
    started = execute_scoped_action(
        client,
        run,
        event_type="NODE_STARTED",
        node_id="plan",
        actor=AGENT_ACTOR,
        expected_revision=run["revision"],
    )
    submitted = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts",
        json={
            "nodeId": "plan",
            "artifactPath": str(artifact_path),
            "artifactType": "plan",
            "actor": AGENT_ACTOR,
            "expectedRevision": started["revision"],
            "now": NOW,
        },
    ).json()
    completed = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "进入自动 Gate",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    )
    gates = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/gates")

    assert completed.status_code == 200
    assert completed.json()["nodeStates"]["plan"] == "PASSED"
    assert completed.json()["nodeStates"]["review"] == "READY"
    assert len(gates.json()) == 1
    gate = gates.json()[0]
    assert gate["id"] == f"{run['runId']}:gate:plan:plan-ready:5"
    assert gate["runId"] == run["runId"]
    assert gate["nodeId"] == "plan"
    assert gate["gateId"] == "plan-ready"
    assert gate["status"] == "passed"
    assert gate["evidence"] == [artifact_path.resolve().as_uri()]
    assert gate["waiverReason"] is None
    assert gate["failureReason"] is None
    assert gate["actor"] == {
        "id": "runtime-auto-gate",
        "type": "system",
        "source": "runtime",
        "trusted": True,
    }
    assert gate["createdAt"] == NOW


def test_runtime_api_returns_persisted_side_records(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("API 计划内容", encoding="utf-8")

    submitted = start_and_submit_plan(client, run, artifact_path)
    approved = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "批准进入门禁",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    ).json()
    client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/gates",
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

    artifacts = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts").json()
    approvals = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/approvals").json()
    gates = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/gates").json()

    assert artifacts[0]["nodeId"] == "plan"
    assert artifacts[0]["type"] == "plan"
    assert artifacts[0]["uri"] == artifact_path.resolve().as_uri()
    assert approvals[0]["status"] == "approved"
    assert approvals[0]["comment"] == "批准进入门禁"
    assert approvals[0]["decidedBy"] == HUMAN_ACTOR
    assert gates[0]["gateId"] == "plan-ready"
    assert gates[0]["status"] == "passed"
    assert gates[0]["evidence"] == ["ci://gate/plan-ready"]


def test_runtime_api_previews_registered_artifact_and_reports_integrity(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "docs" / "plan.md"
    artifact_path.parent.mkdir()
    artifact_path.write_text("# 计划\n\n完成产物预览。", encoding="utf-8")

    start_and_submit_plan(client, run, artifact_path)
    artifacts = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts").json()
    expected_bytes = artifact_path.read_bytes()
    expected_content = expected_bytes.decode("utf-8")

    verified = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts/{artifacts[0]['id']}/preview")
    artifact_path.write_text("# 已修改\n", encoding="utf-8")
    changed = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts/{artifacts[0]['id']}/preview")

    assert verified.status_code == 200
    assert verified.json() == {
        "id": artifacts[0]["id"],
        "uri": artifact_path.resolve().as_uri(),
        "contentHash": artifacts[0]["contentHash"],
        "currentHash": artifacts[0]["contentHash"],
        "integrity": "verified",
        "mediaType": "text/markdown",
        "sizeBytes": len(expected_bytes),
        "truncated": False,
        "content": expected_content,
    }
    assert changed.status_code == 200
    assert changed.json()["integrity"] == "changed"
    assert changed.json()["content"] == artifact_path.read_bytes().decode("utf-8")


def test_runtime_api_generates_run_evidence_package_and_chinese_markdown_report(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "docs" / "plan.md"
    artifact_path.parent.mkdir()
    artifact_path.write_text("# 计划\n\n可审计产物。", encoding="utf-8")

    submitted = start_and_submit_plan(client, run, artifact_path)
    approved = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "证据审核通过",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    ).json()
    client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/gates",
        json={
            "nodeId": "plan",
            "gateId": "plan-ready",
            "status": "passed",
            "evidence": [artifact_path.resolve().as_uri()],
            "waiverReason": None,
            "actor": VERIFIER_ACTOR,
            "expectedRevision": approved["revision"],
            "now": NOW,
        },
    )

    package = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/evidence-package")
    report = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/report")

    assert package.status_code == 200
    assert package.json()["runId"] == run["runId"]
    assert package.json()["projection"]["status"] == "IN_PROGRESS"
    assert len(package.json()["artifacts"][0]["contentHash"]) == 64
    assert package.json()["approvals"][0]["comment"] == "证据审核通过"
    assert package.json()["gates"][0]["evidence"] == [artifact_path.resolve().as_uri()]
    assert [event["type"] for event in package.json()["timeline"]] == [
        "RUN_CREATED",
        "NODE_STARTED",
        "ARTIFACT_SUBMITTED",
        "HUMAN_APPROVED",
        "GATE_PASSED",
    ]
    assert report.status_code == 200
    assert report.json()["mediaType"] == "text/markdown"
    assert f"# Run 证据报告：{run['runId']}" in report.json()["content"]
    assert "证据审核通过" in report.json()["content"]


def test_runtime_api_run_report_includes_failed_gate_review_details(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "docs" / "plan.md"
    artifact_path.parent.mkdir()
    artifact_path.write_text("# 计划\n\n缺少回归测试 Evidence。", encoding="utf-8")

    submitted = start_and_submit_plan(client, run, artifact_path)
    approved = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "进入 Gate 检查",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    ).json()
    client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/gates",
        json={
            "nodeId": "plan",
            "gateId": "plan-ready",
            "status": "failed",
            "evidence": [artifact_path.resolve().as_uri()],
            "waiverReason": None,
            "failureReason": "缺少回归测试 Evidence",
            "actor": VERIFIER_ACTOR,
            "expectedRevision": approved["revision"],
            "now": NOW,
        },
    )

    report = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/report")
    content = report.json()["content"]

    assert report.status_code == 200
    assert "`plan-ready`：failed" in content
    assert "失败原因：缺少回归测试 Evidence" in content
    assert f"证据：{artifact_path.resolve().as_uri()}" in content
    assert f"执行者：{VERIFIER_ACTOR['id']}" in content
    assert f"提交时间：{NOW}" in content


def test_runtime_api_replays_a_published_knowledge_document_with_audit_history(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    created = client.post(
        "/knowledge/candidates",
        json={
            "title": "产物归档规范",
            "content": "所有产物必须保留内容哈希。",
            "source": "run:run-archive",
            "actor": {
                "id": "knowledge-system",
                "type": "system",
                "source": "runtime",
                "trusted": True,
            },
            "now": NOW,
        },
    ).json()
    client.post(
        f"/knowledge/candidates/{created['id']}/review",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "内容可复用",
            "now": NOW,
        },
    )
    published = client.post(
        f"/knowledge/candidates/{created['id']}/publish",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    ).json()

    documents = client.get("/knowledge/documents")
    replay = client.get(f"/knowledge/documents/{published['id']}/replay")

    assert documents.status_code == 200
    assert documents.json()[0]["id"] == published["id"]
    assert replay.status_code == 200
    assert replay.json()["document"]["id"] == published["id"]
    assert replay.json()["candidate"]["id"] == created["id"]
    assert replay.json()["candidate"]["reviewComment"] == "内容可复用"
    assert [record["action"] for record in replay.json()["auditRecords"]] == [
        "knowledge.candidate.created",
        "knowledge.candidate.reviewed",
        "knowledge.candidate.published",
    ]


def test_runtime_api_exports_a_published_knowledge_document_as_markdown(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    created = client.post(
        "/knowledge/candidates",
        json={
            "title": "产物归档规范",
            "content": "所有产物必须保留内容哈希。",
            "source": "run:run-archive",
            "actor": {
                "id": "knowledge-system",
                "type": "system",
                "source": "runtime",
                "trusted": True,
            },
            "now": NOW,
        },
    ).json()
    client.post(
        f"/knowledge/candidates/{created['id']}/review",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "内容可复用",
            "now": NOW,
        },
    )
    published = client.post(
        f"/knowledge/candidates/{created['id']}/publish",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    ).json()

    response = client.get(f"/knowledge/documents/{published['id']}/export")

    assert response.status_code == 200
    assert response.json()["fileName"] == f"{published['id']}.md"
    assert response.json()["mediaType"] == "text/markdown"
    assert "# 产物归档规范" in response.json()["content"]
    assert "来源：run:run-archive" in response.json()["content"]
    assert "审核意见：内容可复用" in response.json()["content"]
    assert "所有产物必须保留内容哈希。" in response.json()["content"]


def test_runtime_api_records_audited_knowledge_git_publication(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    created = client.post(
        "/knowledge/candidates",
        json={
            "title": "产物归档规范",
            "content": "所有产物必须保留内容哈希。",
            "source": "run:run-archive",
            "actor": {
                "id": "knowledge-system",
                "type": "system",
                "source": "runtime",
                "trusted": True,
            },
            "now": NOW,
        },
    ).json()
    client.post(
        f"/knowledge/candidates/{created['id']}/review",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "内容可复用",
            "now": NOW,
        },
    )
    published = client.post(
        f"/knowledge/candidates/{created['id']}/publish",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    ).json()

    response = client.post(
        f"/knowledge/documents/{published['id']}/git-publications",
        json={
            "branch": "main",
            "relativePath": f".workflow-platform/knowledge/{published['id']}.md",
            "commitHash": "abc1234",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    replay = client.get(f"/knowledge/documents/{published['id']}/replay")

    assert response.status_code == 200
    assert response.json() == {
        "documentId": published["id"],
        "branch": "main",
        "relativePath": f".workflow-platform/knowledge/{published['id']}.md",
        "commitHash": "abc1234",
        "pushedAt": NOW,
    }
    assert client.get("/knowledge/documents").json()[0]["gitPublicationCount"] == 1
    assert client.get("/knowledge/documents").json()[0]["latestGitPublication"] == {
        "branch": "main",
        "relativePath": f".workflow-platform/knowledge/{published['id']}.md",
        "commitHash": "abc1234",
        "pushedAt": NOW,
    }
    assert replay.status_code == 200
    assert replay.json()["auditRecords"][-1]["action"] == "knowledge.document.git_published"
    assert replay.json()["auditRecords"][-1]["resource"] == f"knowledge-document:{published['id']}"


def test_runtime_api_synthesizes_approved_knowledge_with_cli_progress_feedback_and_publish(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    client = TestClient(create_app(service))
    _project_path, run = import_project_and_create_run(client, tmp_path)
    candidate = client.post(
        "/knowledge/candidates",
        json={
            "title": "部署验收规则",
            "content": "部署前必须完成 Gate 审核并保留回滚证据。",
            "source": f"run:{run['runId']}",
            "actor": {
                "id": "knowledge-system",
                "type": "system",
                "source": "runtime",
                "trusted": True,
            },
            "now": NOW,
        },
    ).json()
    client.post(
        f"/knowledge/candidates/{candidate['id']}/review",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "可进入知识合成。",
            "now": NOW,
        },
    )

    started = client.post(
        f"/knowledge/candidates/{candidate['id']}/syntheses",
        json={"provider": "fake", "actor": HUMAN_ACTOR, "now": NOW},
    )
    synthesis_id = started.json()["id"]
    completed = started.json()
    for _ in range(20):
        completed = client.get("/knowledge/syntheses").json()[0]
        if completed["status"] in {"COMPLETED", "FAILED"}:
            break
        sleep(0.05)
    feedback = client.post(
        f"/knowledge/syntheses/{synthesis_id}/feedback",
        json={"feedback": "保留 Gate 和回滚证据的措辞。", "actor": HUMAN_ACTOR, "now": NOW},
    )
    published = client.post(
        f"/knowledge/syntheses/{synthesis_id}/publish",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )
    output = client.get(f"/knowledge/syntheses/{synthesis_id}/output")

    assert started.status_code == 200
    assert completed["status"] == "COMPLETED"
    assert completed["summary"] == "fake-cli: completed"
    assert completed["error"] is None
    assert output.json()[-1]["payload"]["text"] == "fake-cli: completed"
    assert feedback.status_code == 200
    assert feedback.json()["feedback"] == "保留 Gate 和回滚证据的措辞。"
    assert published.status_code == 200
    assert published.json()["content"] == "fake-cli: completed"


def test_runtime_api_extracts_verified_artifacts_to_repeatable_knowledge_syntheses(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    client = TestClient(create_app(service))
    project_path, run = import_project_and_create_run(client, tmp_path)
    first_path = project_path / "first.md"
    second_path = project_path / "second.md"
    first_path.write_text("# First artifact\n\nReusable deployment guidance.", encoding="utf-8")
    second_path.write_text("# Second artifact\n\nVerification checklist.", encoding="utf-8")
    first = start_and_submit_plan(client, run, first_path)
    service._artifacts.save(
        id=f"{run['runId']}:artifact:report:1",
        run_id=run["runId"],
        node_id="plan",
        type="report",
        uri=second_path.as_uri(),
        content_hash=hash_artifact(second_path),
        producer=Actor.model_validate(AGENT_ACTOR),
        created_at=NOW,
    )
    db.commit()
    artifacts = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts").json()

    extracted = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts/knowledge-syntheses",
        json={
            "artifactIds": [artifact["id"] for artifact in artifacts],
            "provider": "fake",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    extracted_again = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts/knowledge-syntheses",
        json={
            "artifactIds": [artifacts[0]["id"]],
            "provider": "fake",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )

    assert extracted.status_code == 200
    assert len(extracted.json()["items"]) == 2
    assert all(item["status"] == "QUEUED" for item in extracted.json()["items"])
    assert extracted_again.status_code == 200
    candidates = client.get("/knowledge/candidates").json()
    assert len(candidates) == 3
    assert sum(candidate["source"] == f"run:{run['runId']}:artifact:{artifacts[0]['id']}" for candidate in candidates) == 2


def test_runtime_api_get_run_and_rebuild_projection_match_current_events(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("API 计划内容", encoding="utf-8")

    submitted = start_and_submit_plan(client, run, artifact_path)

    current = client.get(
        f"/projects/{run['projectId']}/runs/{run['runId']}/projection"
    ).json()
    rebuilt = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/rebuild-projection",
        json={"now": "2026-07-27T13:05:00Z"},
    ).json()

    assert current == submitted
    assert rebuilt == submitted


def test_runtime_api_lists_multiple_runs_for_one_workflow_version(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    (project_path / "first").mkdir()
    (project_path / "second").mkdir()
    first = scoped_projection(
        post_scoped_run(
            client,
            project_id=imported["projectId"],
            workflow_version_id=imported["workflowVersionId"],
            workspace=project_path / "first",
            title="第一个并发 Run",
            idempotency_key="first-concurrent-run",
            now="2026-07-27T13:00:00Z",
        ),
        imported["projectId"],
    )
    second = scoped_projection(
        post_scoped_run(
            client,
            project_id=imported["projectId"],
            workflow_version_id=imported["workflowVersionId"],
            workspace=project_path / "second",
            title="第二个并发 Run",
            idempotency_key="second-concurrent-run",
            now="2026-07-27T13:01:00Z",
        ),
        imported["projectId"],
    )

    response = client.get(f"/projects/{imported['projectId']}/runs")

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == [
        second["runId"],
        first["runId"],
    ]
    assert [item["title"] for item in response.json()["items"]] == [
        "第二个并发 Run",
        "第一个并发 Run",
    ]


def test_runtime_api_lists_runs_from_previous_versions_of_the_same_workflow(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    run = scoped_projection(
        post_scoped_run(
            client,
            project_id=imported["projectId"],
            workflow_version_id=imported["workflowVersionId"],
            workspace=project_path,
            title="已完成的历史 Run",
            idempotency_key="historical-version-run",
            now="2026-07-27T13:00:00Z",
        ),
        imported["projectId"],
    )
    definition = client.get(f"/workflow-versions/{imported['workflowVersionId']}").json()
    definition["nodes"][0]["name"] = "保存后的工作流版本"
    saved = client.post(
        f"/workflow-versions/{imported['workflowVersionId']}/save",
        json={"definition": definition, "actor": HUMAN_ACTOR, "now": "2026-07-27T13:01:00Z"},
    ).json()

    response = client.get(f"/projects/{imported['projectId']}/runs")

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == [run["runId"]]
    assert response.json()["items"][0]["title"] == "已完成的历史 Run"


def test_runtime_api_maps_p1_error_statuses(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("API 计划内容", encoding="utf-8")

    submitted = start_and_submit_plan(client, run, artifact_path)
    denied = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": UNTRUSTED_HUMAN_ACTOR,
            "comment": "未授权审批",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    )
    conflict = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "旧版本审批",
            "expectedRevision": run["revision"],
            "now": NOW,
        },
    )
    missing_run = client.get(
        f"/projects/{run['projectId']}/runs/run-missing"
    )
    validation_error = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/gates",
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


def test_runtime_api_runs_agent_job_and_returns_output_without_advancing_run(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(
        create_app(WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider()))
    )
    _project_path, run = import_project_and_create_run(client, tmp_path)

    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "生成计划",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    job_id = started.json()["id"]
    completed = started
    for _ in range(100):
        completed = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}")
        if completed.json()["status"] == "COMPLETED":
            break
        sleep(0.02)
    jobs = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/agents")
    output = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}/output")
    current = client.get(
        f"/projects/{run['projectId']}/runs/{run['runId']}/projection"
    )

    assert started.status_code == 200
    assert started.json()["status"] == "QUEUED"
    assert completed.json()["status"] == "COMPLETED"
    assert jobs.json()[0]["id"] == job_id
    assert output.json()[-1]["payload"]["text"] == "fake-cli: completed"
    assert current.json()["revision"] == run["revision"]


def test_runtime_api_persists_interactive_agent_input_and_output(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(
        create_app(WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider()))
    )
    _project_path, run = import_project_and_create_run(client, tmp_path)

    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "请询问用户",
            "mode": "interactive",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    job = started.json()
    session_started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job['id']}/interactive-session/start",
        json={
            "desktopSessionId": "pty-1",
            "pid": 1234,
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    accepted = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job['id']}/interactive-session/input",
        json={"content": "选择 A", "actor": HUMAN_ACTOR, "now": NOW},
    )
    output = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job['id']}/interactive-session/output",
        json={"events": [{"data": "已收到选择 A\r\n"}], "now": NOW},
    )
    fetched_session = client.get(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job['id']}/interactive-session"
    )
    fetched_output = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job['id']}/output")

    assert started.status_code == 200
    assert job["mode"] == "interactive"
    assert job["status"] == "QUEUED"
    assert session_started.status_code == 200
    assert session_started.json()["status"] == "RUNNING"
    assert accepted.status_code == 200
    assert accepted.json()["kind"] == "human_input"
    assert output.status_code == 200
    assert output.json()[0]["kind"] == "terminal_raw"
    assert fetched_session.status_code == 200
    assert fetched_session.json()["desktopSessionId"] == "pty-1"
    assert fetched_output.json()[-1]["payload"]["text"] == "已收到选择 A\r\n"


def test_runtime_api_finishes_continues_and_cancels_interactive_agent(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(
        create_app(WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider()))
    )
    _project_path, run = import_project_and_create_run(client, tmp_path)

    job = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "请确认目标分支",
            "mode": "interactive",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    ).json()
    client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job['id']}/interactive-session/start",
        json={
            "desktopSessionId": "pty-1",
            "pid": 1234,
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    finished = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job['id']}/interactive-session/ended",
        json={
            "status": "FAILED",
            "summary": None,
            "error": "用户准备继续",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    continued = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job['id']}/interactive-session/continue",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )
    cancel_without_actor = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{continued.json()['id']}/cancel",
        json={"now": NOW},
    )
    cancelled = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{continued.json()['id']}/cancel",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )

    assert finished.status_code == 200
    assert finished.json()["status"] == "FAILED"
    assert continued.status_code == 200
    assert continued.json()["mode"] == "interactive"
    assert continued.json()["parentJobId"] == job["id"]
    assert cancel_without_actor.status_code == 400
    assert cancel_without_actor.json()["code"] == "ACTOR_INVALID"
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "CANCELLED"


def test_runtime_api_runs_a_governed_deploy_command_and_records_log_artifact(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    definition = client.get(f"/workflow-versions/{imported['workflowVersionId']}").json()
    definition["nodes"] = [
        {
            "id": "deploy",
            "name": "部署",
            "kind": "deploy",
            "metadata": {
                "deploy": {
                    "command": [sys.executable, str(FAKE_CLI), "complete"],
                    "timeoutSeconds": 30,
                }
            },
        }
    ]
    definition["edges"] = []
    definition["gates"] = []
    saved = client.post(
        f"/workflow-versions/{imported['workflowVersionId']}/save",
        json={"definition": definition, "actor": HUMAN_ACTOR, "now": NOW},
    ).json()
    run = scoped_projection(
        post_scoped_run(
            client,
            project_id=imported["projectId"],
            workflow_version_id=saved["workflowVersionId"],
            workspace=project_path,
            title="部署验收",
            idempotency_key="deployment-run",
        ),
        imported["projectId"],
    )

    denied = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/deployments",
        json={
            "nodeId": "deploy",
            "actor": AGENT_ACTOR,
            "expectedRevision": run["revision"],
            "now": NOW,
        },
    )
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/deployments",
        json={
            "nodeId": "deploy",
            "actor": HUMAN_ACTOR,
            "expectedRevision": run["revision"],
            "now": NOW,
        },
    )
    deployment_id = started.json()["id"]
    completed = started
    for _ in range(100):
        completed = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/deployments/{deployment_id}")
        if completed.json()["status"] in {"COMPLETED", "FAILED"}:
            break
        sleep(0.02)
    output = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/deployments/{deployment_id}/output")
    artifacts = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts")
    projection = client.get(
        f"/projects/{run['projectId']}/runs/{run['runId']}/projection"
    )

    assert denied.status_code == 403
    assert started.status_code == 200
    assert completed.json()["status"] == "COMPLETED"
    assert completed.json()["summary"] == "fake-cli: completed"
    assert output.json()[-1]["data"].strip().endswith("fake-cli: completed\"}")
    assert artifacts.json()[0]["type"] == "deploy-log"
    assert projection.json()["status"] == "DONE"
    assert projection.json()["nodeStates"]["deploy"] == "PASSED"


def test_runtime_api_lists_and_resumes_recoverable_agent_checkpoints(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    client = TestClient(create_app(service))
    _project_path, run = import_project_and_create_run(client, tmp_path)
    service._agent_jobs.create(
        id="agent-job-interrupted",
        project_id=run["projectId"],
        run_id=run["runId"],
        node_id="plan",
        provider="fake",
        status="CANCELLED",
        command=[sys.executable, str(FAKE_CLI), "complete"],
        cwd=str(tmp_path),
        created_at=NOW,
    )
    service._agent_checkpoints.create(
        id="agent-checkpoint-interrupted",
        run_id=run["runId"],
        job_id="agent-job-interrupted",
        parent_checkpoint_id=None,
        node_id="plan",
        provider="fake",
        prompt="恢复这个 Agent 请求",
        allowed_tools=["read"],
        timeout_seconds=60,
        max_output_bytes=1000,
        status="recoverable",
        created_at=NOW,
    )
    db.commit()

    listed = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/agent-checkpoints")
    resumed = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agent-checkpoints/agent-checkpoint-interrupted/resume",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )

    assert listed.status_code == 200
    assert listed.json()[0]["status"] == "recoverable"
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "QUEUED"
    original = next(
        checkpoint
        for checkpoint in client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/agent-checkpoints").json()
        if checkpoint["id"] == "agent-checkpoint-interrupted"
    )
    assert original["status"] == "resumed"


def test_runtime_api_rejects_agent_job_for_unknown_node(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(
        create_app(WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider()))
    )
    _project_path, run = import_project_and_create_run(client, tmp_path)

    response = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "missing",
            "provider": "fake",
            "prompt": "生成计划",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )

    assert response.status_code == 400
    assert response.json()["code"] == "AGENT_UNKNOWN_NODE"


def test_runtime_api_cancel_missing_agent_job_maps_404(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    _project_path, run = import_project_and_create_run(client, tmp_path)

    response = client.post(f"/projects/{run['projectId']}/runs/{run['runId']}/agents/agent-job-missing/cancel")

    assert response.status_code == 404


def test_runtime_api_acp_transport_unsupported_provider_returns_422(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(
        create_app(WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider()))
    )
    _project_path, run = import_project_and_create_run(client, tmp_path)
    response = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "codex",
            "prompt": "x",
            "transport": "acp",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert response.status_code == 422
    assert response.json()["code"] == "AGENT_ACP_UNAVAILABLE"


def test_runtime_api_acp_transport_fake_completes_with_output(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(
        create_app(WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider()))
    )
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "hello acp",
            "transport": "acp",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert started.status_code == 200
    job_id = started.json()["id"]
    completed = started
    for _ in range(200):
        completed = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}")
        if completed.json()["status"] in {"COMPLETED", "FAILED", "CANCELLED"}:
            break
        sleep(0.02)
    assert completed.json()["status"] == "COMPLETED", completed.json()
    assert completed.json().get("metadata", {}).get("transport") == "acp"
    output = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}/output")
    kinds = [item["kind"] for item in output.json()]
    assert "acp.message" in kinds
