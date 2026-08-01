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
from workflow_platform.execution.providers import CliCommand, CodexCliProvider
from workflow_platform.api.app import app, create_app, create_runtime_app
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
        "/runs",
        json={
            "workflowVersionId": imported["workflowVersionId"],
            "title": "生产发布准备",
            "taskGoal": "验证发布流程并生成可审计报告",
            "parameters": {"dryRun": True, "region": "cn-north-1"},
            "now": NOW,
        },
    )
    runs = client.get(f"/workflow-versions/{imported['workflowVersionId']}/runs")

    assert created.status_code == 200
    assert runs.status_code == 200
    assert runs.json()[0]["context"] == {
        "taskGoal": "验证发布流程并生成可审计报告",
        "parameters": {"dryRun": True, "region": "cn-north-1"},
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
    run = client.post(
        "/runs",
        json={"workflowVersionId": saved["workflowVersionId"], "title": "扫描产物", "now": NOW},
    ).json()
    artifact = project_path / "docs" / "runs" / run["runId"] / "plan" / "plan.md"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("# 计划\n", encoding="utf-8")
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

    response = client.post(
        f"/runs/{run['runId']}/nodes/plan/artifacts/scan",
        json={"expectedRevision": started["revision"], "now": NOW},
    )

    assert response.status_code == 200
    assert response.json()["registered"] == ["plan-report"]
    assert response.json()["projection"]["nodeStates"]["plan"] == "RUNNING"

    requirements = client.get(
        f"/runs/{run['runId']}/nodes/plan/artifact-requirements"
    )

    assert requirements.status_code == 200
    assert requirements.json()["requirements"][0]["relativePath"].endswith("/plan/plan.md")
    assert requirements.json()["requirements"][0]["required"] is True
    assert len(requirements.json()["requirements"][0]["artifacts"]) == 1


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
                lambda _index: client.get(f"/runs/{run['runId']}/projection"),
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
    historical_run = client.post(
        "/runs",
        json={
            "workflowVersionId": imported["workflowVersionId"],
            "title": "归档前历史 Run",
            "now": NOW,
        },
    )

    archived = client.post(
        f"/projects/{imported['projectId']}/archive",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )
    definition = client.get(f"/workflow-versions/{imported['workflowVersionId']}")
    rejected_run = client.post(
        "/runs",
        json={
            "workflowVersionId": imported["workflowVersionId"],
            "title": "归档后不应创建",
            "now": NOW,
        },
    )
    reimported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": "2026-07-28T00:00:00Z"},
    )
    restored_run = client.post(
        "/runs",
        json={
            "workflowVersionId": reimported.json()["workflowVersionId"],
            "title": "重导入后创建",
            "now": "2026-07-28T00:00:00Z",
        },
    )
    audit = client.get("/audit-records?action=project.archived")

    assert historical_run.status_code == 200
    assert archived.status_code == 200
    assert archived.json()["projectId"] == imported["projectId"]
    assert definition.status_code == 200
    assert rejected_run.status_code == 409
    assert "PROJECT_ARCHIVED" in rejected_run.json()["detail"]
    assert reimported.status_code == 200
    assert reimported.json()["projectId"] == imported["projectId"]
    assert restored_run.status_code == 200
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
    assert client.get("/runs/run-does-not-exist").status_code == 404


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
    run = client.post(
        "/runs",
        json={
            "workflowVersionId": imported["workflowVersionId"],
            "title": "恢复诊断",
            "now": NOW,
        },
    ).json()

    diagnostics = client.get(f"/runs/{run['runId']}/recovery-diagnostics")

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
        f"/runs/{run['runId']}/terminals",
        json={
            "nodeId": "plan",
            "kind": "shell",
            "cwd": str(project_path),
            "pid": 5678,
            "now": NOW,
        },
    )
    sessions = client.get(f"/runs/{run['runId']}/terminals")

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
        f"/runs/{run['runId']}/terminals",
        json={
            "nodeId": "plan",
            "kind": "shell",
            "cwd": str(project_path),
            "pid": 5678,
            "now": NOW,
        },
    ).json()

    recorded = client.post(
        f"/runs/{run['runId']}/terminals/{session['id']}/command-decisions",
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
        f"/runs/{run['runId']}/terminals/{session['id']}/command-decisions",
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
        f"/runs/{run['runId']}/terminals",
        json={
            "nodeId": "plan",
            "kind": "shell",
            "cwd": str(project_path),
            "pid": 5678,
            "now": NOW,
        },
    ).json()

    appended = client.post(
        f"/runs/{run['runId']}/terminals/{session['id']}/output",
        json={"stream": "stdout", "data": "hello\n", "now": NOW},
    )
    output = client.get(f"/runs/{run['runId']}/terminals/{session['id']}/output?afterSequence=0")

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
        f"/runs/{run['runId']}/terminals",
        json={
            "nodeId": "plan",
            "kind": "shell",
            "cwd": str(project_path),
            "pid": 5678,
            "now": NOW,
        },
    ).json()
    client.post(
        f"/runs/{run['runId']}/terminals/{session['id']}/output",
        json={"stream": "stdout", "data": "done\n", "now": NOW},
    )

    evidence = client.post(
        f"/runs/{run['runId']}/terminals/{session['id']}/evidence",
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
    run = client.post(
        "/runs",
        json={
            "workflowVersionId": imported["workflowVersionId"],
            "title": "清理遗留 Agent",
            "now": NOW,
        },
    ).json()
    service._agent_jobs.create(
        id="job-orphan",
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
        f"/runs/{run['runId']}/recovery/cleanup-orphan-agents",
        json={"now": NOW},
    )
    jobs = client.get(f"/runs/{run['runId']}/agents")

    assert cleaned.status_code == 200
    assert cleaned.json()["cleanedJobIds"] == ["job-orphan"]
    assert jobs.json()[0]["status"] == "CANCELLED"
    assert jobs.json()[0]["error"] == "RECOVERY_ORPHANED: Runtime 执行器已不可用"


def test_runtime_api_cleans_orphan_terminal_sessions_during_recovery(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    session = client.post(
        f"/runs/{run['runId']}/terminals",
        json={
            "nodeId": "plan",
            "kind": "shell",
            "cwd": str(project_path),
            "pid": 5678,
            "now": NOW,
        },
    ).json()

    cleaned = client.post(
        f"/runs/{run['runId']}/recovery/cleanup-orphan-terminals",
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
    run = client.post(
        "/runs",
        json={
            "workflowVersionId": saved["workflowVersionId"],
            "title": "自动 Gate 验收",
            "now": NOW,
        },
    ).json()
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
    submitted = client.post(
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
    completed = client.post(
        f"/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "进入自动 Gate",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    )
    gates = client.get(f"/runs/{run['runId']}/gates")

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


def test_runtime_api_previews_registered_artifact_and_reports_integrity(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path, run = import_project_and_create_run(client, tmp_path)
    artifact_path = project_path / "docs" / "plan.md"
    artifact_path.parent.mkdir()
    artifact_path.write_text("# 计划\n\n完成产物预览。", encoding="utf-8")

    start_and_submit_plan(client, run, artifact_path)
    artifacts = client.get(f"/runs/{run['runId']}/artifacts").json()
    expected_bytes = artifact_path.read_bytes()
    expected_content = expected_bytes.decode("utf-8")

    verified = client.get(f"/runs/{run['runId']}/artifacts/{artifacts[0]['id']}/preview")
    artifact_path.write_text("# 已修改\n", encoding="utf-8")
    changed = client.get(f"/runs/{run['runId']}/artifacts/{artifacts[0]['id']}/preview")

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
        f"/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "证据审核通过",
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
            "evidence": [artifact_path.resolve().as_uri()],
            "waiverReason": None,
            "actor": VERIFIER_ACTOR,
            "expectedRevision": approved["revision"],
            "now": NOW,
        },
    )

    package = client.get(f"/runs/{run['runId']}/evidence-package")
    report = client.get(f"/runs/{run['runId']}/report")

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
        f"/runs/{run['runId']}/approvals/plan/decide",
        json={
            "decision": "approved",
            "actor": HUMAN_ACTOR,
            "comment": "进入 Gate 检查",
            "expectedRevision": submitted["revision"],
            "now": NOW,
        },
    ).json()
    client.post(
        f"/runs/{run['runId']}/gates",
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

    report = client.get(f"/runs/{run['runId']}/report")
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
    client = TestClient(
        create_app(WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider()))
    )
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


def test_runtime_api_lists_multiple_runs_for_one_workflow_version(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    project_path = copy_harness_project(tmp_path)
    imported = client.post(
        "/projects/import",
        json={"projectPath": str(project_path), "now": NOW},
    ).json()
    first = client.post(
        "/runs",
        json={
            "workflowVersionId": imported["workflowVersionId"],
            "title": "第一个并发 Run",
            "now": "2026-07-27T13:00:00Z",
        },
    ).json()
    second = client.post(
        "/runs",
        json={
            "workflowVersionId": imported["workflowVersionId"],
            "title": "第二个并发 Run",
            "now": "2026-07-27T13:01:00Z",
        },
    ).json()

    response = client.get(f"/workflow-versions/{imported['workflowVersionId']}/runs")

    assert response.status_code == 200
    assert response.json() == [
        {
            "id": second["runId"],
            "title": "第二个并发 Run",
            "context": {"taskGoal": "", "parameters": {}},
            "status": "CREATED",
            "createdAt": "2026-07-27T13:01:00Z",
            "updatedAt": "2026-07-27T13:01:00Z",
        },
        {
            "id": first["runId"],
            "title": "第一个并发 Run",
            "context": {"taskGoal": "", "parameters": {}},
            "status": "CREATED",
            "createdAt": "2026-07-27T13:00:00Z",
            "updatedAt": "2026-07-27T13:00:00Z",
        },
    ]


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


def test_runtime_api_runs_agent_job_and_returns_output_without_advancing_run(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(
        create_app(WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider()))
    )
    _project_path, run = import_project_and_create_run(client, tmp_path)

    started = client.post(
        f"/runs/{run['runId']}/agents",
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
        completed = client.get(f"/runs/{run['runId']}/agents/{job_id}")
        if completed.json()["status"] == "COMPLETED":
            break
        sleep(0.02)
    jobs = client.get(f"/runs/{run['runId']}/agents")
    output = client.get(f"/runs/{run['runId']}/agents/{job_id}/output")
    current = client.get(f"/runs/{run['runId']}")

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
        f"/runs/{run['runId']}/agents",
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
        f"/runs/{run['runId']}/agents/{job['id']}/interactive-session/start",
        json={
            "desktopSessionId": "pty-1",
            "pid": 1234,
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    accepted = client.post(
        f"/runs/{run['runId']}/agents/{job['id']}/interactive-session/input",
        json={"content": "选择 A", "actor": HUMAN_ACTOR, "now": NOW},
    )
    output = client.post(
        f"/runs/{run['runId']}/agents/{job['id']}/interactive-session/output",
        json={"events": [{"data": "已收到选择 A\r\n"}], "now": NOW},
    )
    fetched_session = client.get(
        f"/runs/{run['runId']}/agents/{job['id']}/interactive-session"
    )
    fetched_output = client.get(f"/runs/{run['runId']}/agents/{job['id']}/output")

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
        f"/runs/{run['runId']}/agents",
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
        f"/runs/{run['runId']}/agents/{job['id']}/interactive-session/start",
        json={
            "desktopSessionId": "pty-1",
            "pid": 1234,
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    finished = client.post(
        f"/runs/{run['runId']}/agents/{job['id']}/interactive-session/ended",
        json={
            "status": "FAILED",
            "summary": None,
            "error": "用户准备继续",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    continued = client.post(
        f"/runs/{run['runId']}/agents/{job['id']}/interactive-session/continue",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )
    cancel_without_actor = client.post(
        f"/runs/{run['runId']}/agents/{continued.json()['id']}/cancel",
        json={"now": NOW},
    )
    cancelled = client.post(
        f"/runs/{run['runId']}/agents/{continued.json()['id']}/cancel",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )

    assert finished.status_code == 200
    assert finished.json()["status"] == "FAILED"
    assert continued.status_code == 200
    assert continued.json()["mode"] == "interactive"
    assert continued.json()["parentJobId"] == job["id"]
    assert cancel_without_actor.status_code == 400
    assert "ACTOR_INVALID" in cancel_without_actor.json()["detail"]
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
    run = client.post(
        "/runs",
        json={
            "workflowVersionId": saved["workflowVersionId"],
            "title": "部署验收",
            "now": NOW,
        },
    ).json()

    denied = client.post(
        f"/runs/{run['runId']}/deployments",
        json={
            "nodeId": "deploy",
            "actor": AGENT_ACTOR,
            "expectedRevision": run["revision"],
            "now": NOW,
        },
    )
    started = client.post(
        f"/runs/{run['runId']}/deployments",
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
        completed = client.get(f"/runs/{run['runId']}/deployments/{deployment_id}")
        if completed.json()["status"] in {"COMPLETED", "FAILED"}:
            break
        sleep(0.02)
    output = client.get(f"/runs/{run['runId']}/deployments/{deployment_id}/output")
    artifacts = client.get(f"/runs/{run['runId']}/artifacts")
    projection = client.get(f"/runs/{run['runId']}/projection")

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

    listed = client.get(f"/runs/{run['runId']}/agent-checkpoints")
    resumed = client.post(
        f"/runs/{run['runId']}/agent-checkpoints/agent-checkpoint-interrupted/resume",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )

    assert listed.status_code == 200
    assert listed.json()[0]["status"] == "recoverable"
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "QUEUED"
    original = next(
        checkpoint
        for checkpoint in client.get(f"/runs/{run['runId']}/agent-checkpoints").json()
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
        f"/runs/{run['runId']}/agents",
        json={
            "nodeId": "missing",
            "provider": "fake",
            "prompt": "生成计划",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )

    assert response.status_code == 400
    assert "AGENT_UNKNOWN_NODE" in response.json()["detail"]


def test_runtime_api_cancel_missing_agent_job_maps_404(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    client = TestClient(create_app(WorkflowRuntimeService(db)))
    _project_path, run = import_project_and_create_run(client, tmp_path)

    response = client.post(f"/runs/{run['runId']}/agents/agent-job-missing/cancel")

    assert response.status_code == 404
