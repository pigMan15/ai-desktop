import json
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from workflow_platform.api.app import create_app
from workflow_platform.execution.providers import CliCommand, CodexCliProvider
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService

NOW = "2026-08-10T00:00:00Z"
TRUSTED = {"id": "user-1", "type": "human", "source": "renderer", "trusted": True}
FIXTURES = Path(__file__).parent / "fixtures"
FAKE_CLI = FIXTURES / "fake_cli.py"


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=str(repo), shell=False, check=True, capture_output=True, text=True
    )
    return result.stdout.strip()


def _make_knowledge_repo(tmp_path: Path, name: str = "kb") -> Path:
    repo = tmp_path / name
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "KNOWLEDGE-RULES.md").write_text("# 知识规则\n", encoding="utf-8")
    (repo / "INDEX.md").write_text("# 索引\n", encoding="utf-8")
    (repo / "candidate").mkdir()
    (repo / "main").mkdir()
    (repo / ".ai-workflow").mkdir()
    (repo / ".ai-workflow" / "knowledge-repo.yaml").write_text(
        "version: 1\nrules:\n  - KNOWLEDGE-RULES.md\nindexes:\n  - INDEX.md\n"
        "writablePaths:\n  - candidate/**\n  - main/**\nprotectedPaths:\n  - .git/**\n"
        "validation:\n  commands: []\n",
        encoding="utf-8",
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "init")
    return repo


class KnowledgeFakeProvider:
    id = "fake"

    def __init__(self, mode: str = "knowledge-valid-low") -> None:
        self._mode = mode

    def build_command(self, *, cwd: Path, prompt: str, allowed_tools: list[str]) -> CliCommand:
        mode = "knowledge-rule-discovery" if "rule-discovery.json" in prompt else self._mode
        return CliCommand(
            executable=sys.executable,
            args=[str(FAKE_CLI), mode],
            cwd=cwd,
        )

    def parse_line(self, line: str) -> dict:
        return CodexCliProvider(platform="linux").parse_line(line)


def _make_client(tmp_path: Path, provider_mode: str = "knowledge-valid-low") -> tuple[TestClient, WorkflowRuntimeService]:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(
        db,
        agent_provider_factory=lambda _provider: KnowledgeFakeProvider(provider_mode),
    )
    return TestClient(create_app(service)), service


def _copy_harness_project(tmp_path: Path) -> Path:
    project_path = tmp_path / "harness_project"
    workflow_dir = project_path / ".harness"
    workflow_dir.mkdir(parents=True)
    workflow_text = (FIXTURES / "harness_project" / ".harness" / "workflow.yaml").read_text(
        encoding="utf-8"
    )
    (workflow_dir / "workflow.yaml").write_text(workflow_text, encoding="utf-8")
    return project_path


def _import_project_and_create_run(client: TestClient, tmp_path: Path) -> tuple[Path, dict]:
    project_path = _copy_harness_project(tmp_path)
    imported = client.post("/projects/import", json={"projectPath": str(project_path), "now": NOW}).json()
    created = client.post(
        f"/projects/{imported['projectId']}/runs",
        headers={"Idempotency-Key": "knowledge-api-run"},
        json={
            "workflowVersionId": imported["workflowVersionId"],
            "title": "Knowledge API Run",
            "taskGoal": "knowledge test",
            "parameters": {},
            "executionWorkspace": {"path": str(project_path), "mode": "write"},
            "actor": TRUSTED,
            "now": NOW,
        },
    )
    assert created.status_code == 201, created.text
    projection = created.json()["projection"]
    projection["projectId"] = imported["projectId"]
    return project_path, projection


AGENT_ACTOR = {"id": "agent-1", "type": "agent", "source": "agent", "trusted": True}


def _execute_action(client: TestClient, run: dict, event_type: str, node_id: str) -> dict:
    action = next(
        candidate
        for candidate in run["allowedActions"]
        if candidate["eventType"] == event_type and candidate.get("nodeId") == node_id
    )
    response = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/actions",
        json={
            "actionId": action["id"],
            "expectedRevision": run["revision"],
            "actor": AGENT_ACTOR,
            "payload": None,
            "now": NOW,
        },
    )
    assert response.status_code == 200, response.text
    return {**response.json()["projection"], "projectId": run["projectId"]}


def _submit_artifact(client: TestClient, run: dict, artifact_path: Path) -> dict:
    started = _execute_action(client, run, "NODE_STARTED", "plan")
    response = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts",
        json={
            "nodeId": "plan",
            "artifactPath": str(artifact_path),
            "artifactType": "markdown",
            "actor": AGENT_ACTOR,
            "expectedRevision": started["revision"],
            "now": NOW,
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    result = payload.get("projection") or payload
    result["projectId"] = run["projectId"]
    artifacts = client.get(
        f"/projects/{run['projectId']}/runs/{run['runId']}/artifacts"
    ).json()
    artifact_id = artifacts[0]["id"] if isinstance(artifacts, list) else artifacts["items"][0]["id"]
    return result, artifact_id


def _wait_job(client: TestClient, url: str, timeout: float = 15.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = client.get(url)
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in {"COMPLETED", "FAILED", "CANCELLED"}:
            return job
        time.sleep(0.1)
    raise AssertionError(f"job did not finish: {url}")


def _activate_repository(client: TestClient, tmp_path: Path, name: str = "kb") -> tuple[str, dict]:
    repo = _make_knowledge_repo(tmp_path, name)
    imported = client.post(
        "/knowledge-repositories/import",
        json={"name": name, "rootPath": str(repo), "autoApplyLowRisk": False, "actor": TRUSTED, "now": NOW},
    )
    assert imported.status_code == 201, imported.text
    repository = imported.json()
    repository_id = repository["id"]
    discovered = client.post(
        f"/knowledge-repositories/{repository_id}/discover-rules",
        json={"provider": "fake", "actor": TRUSTED, "expectedRevision": repository["revision"], "now": NOW},
    )
    assert discovered.status_code == 202, discovered.text
    job_id = discovered.json()["jobId"]
    job = _wait_job(client, f"/knowledge-repositories/{repository_id}/rule-discovery-jobs/{job_id}")
    assert job["status"] == "COMPLETED", job
    deadline = time.time() + 10
    snapshots = []
    while time.time() < deadline:
        snapshots = client.get(f"/knowledge-repositories/{repository_id}/rule-snapshots").json()["items"]
        if snapshots:
            break
        time.sleep(0.1)
    if not snapshots:
        latest = client.get(f"/knowledge-repositories/{repository_id}/rule-discovery-jobs/{job_id}").json()
        raise AssertionError(f"no proposed snapshot; job={latest}")
    confirmed = client.post(
        f"/knowledge-repositories/{repository_id}/rule-snapshots/{snapshots[0]['id']}/confirm",
        json={
            "writablePaths": ["candidate/**", "main/**", "*.md"],
            "protectedPaths": [".git/**", ".ai-workflow/**"],
            "indexFiles": ["INDEX.md"],
            "routingFiles": [],
            "templateFiles": [],
            "validationCommands": [],
            "summary": "rules",
            "openQuestions": [],
            "actor": TRUSTED,
            "expectedRevision": repository["revision"],
            "now": NOW,
        },
    )
    assert confirmed.status_code == 200, confirmed.text
    return repository_id, confirmed.json()


def test_import_rejects_non_git_and_duplicate(tmp_path: Path) -> None:
    client, _service = _make_client(tmp_path)
    not_git = tmp_path / "not-git"
    not_git.mkdir()
    response = client.post(
        "/knowledge-repositories/import",
        json={"name": "x", "rootPath": str(not_git), "autoApplyLowRisk": False, "actor": TRUSTED, "now": NOW},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "KNOWLEDGE_REPOSITORY_NOT_GIT"

    repo = _make_knowledge_repo(tmp_path, "dup")
    first = client.post(
        "/knowledge-repositories/import",
        json={"name": "dup", "rootPath": str(repo), "autoApplyLowRisk": False, "actor": TRUSTED, "now": NOW},
    )
    assert first.status_code == 201
    second = client.post(
        "/knowledge-repositories/import",
        json={"name": "dup2", "rootPath": str(repo), "autoApplyLowRisk": False, "actor": TRUSTED, "now": NOW},
    )
    assert second.status_code == 409
    assert second.json()["code"] == "KNOWLEDGE_REPOSITORY_DUPLICATE"


def test_rule_discovery_confirm_and_settings(tmp_path: Path) -> None:
    client, _service = _make_client(tmp_path)
    repository_id, confirmed = _activate_repository(client, tmp_path)
    assert confirmed["status"] == "ACTIVE"
    assert confirmed["activeRuleSnapshot"] is not None
    assert "confirm-rules" not in confirmed["allowedActions"]

    settings = client.post(
        f"/knowledge-repositories/{repository_id}/settings",
        json={"autoApplyLowRisk": True, "actor": TRUSTED, "expectedRevision": confirmed["revision"], "now": NOW},
    )
    assert settings.status_code == 200
    assert settings.json()["autoApplyLowRisk"] is True


def test_change_set_low_flow_apply_stage_commit(tmp_path: Path) -> None:
    client, _service = _make_client(tmp_path, provider_mode="knowledge-valid-low")
    repository_id, repository = _activate_repository(client, tmp_path)
    project_path, run = _import_project_and_create_run(client, tmp_path)
    artifact_file = project_path / "plan.md"
    artifact_file.write_text("# Plan\n", encoding="utf-8")
    run, artifact_id = _submit_artifact(client, run, artifact_file)

    created = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets",
        json={
            "repositoryId": repository_id,
            "artifactIds": [artifact_id],
            "provider": "fake",
            "mode": "preview",
            "actor": TRUSTED,
            "now": NOW,
        },
    )
    assert created.status_code == 201, created.text
    change_set = created.json()
    change_set_id = change_set["id"]
    assert change_set["status"] == "DRAFT"

    generated = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}/generate",
        json={"actor": TRUSTED, "expectedRevision": change_set["revision"], "now": NOW},
    )
    assert generated.status_code == 202, generated.text
    detail = _wait_change_set_status(
        client,
        run,
        change_set_id,
        {"READY_TO_APPLY", "BLOCKED", "FAILED", "AWAITING_APPROVAL"},
    )
    assert detail["status"] == "READY_TO_APPLY", detail["status"]
    assert detail["riskLevel"] == "LOW"
    assert len(detail["fileChanges"]) == 1
    assert detail["fileChanges"][0]["path"] == "candidate/generated.md"

    applied = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}/apply",
        json={"actor": TRUSTED, "expectedRevision": detail["revision"], "now": NOW},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "APPLIED"

    staged = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}/git/stage",
        json={
            "paths": ["candidate/generated.md"],
            "actor": TRUSTED,
            "expectedRevision": applied.json()["revision"],
            "expectedRepositoryRevision": repository["revision"],
            "now": NOW,
        },
    )
    assert staged.status_code == 200, staged.text
    assert staged.json()["status"] == "STAGED"

    repo_latest = client.get(f"/knowledge-repositories/{repository_id}").json()
    committed = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}/git/commit",
        json={
            "title": "knowledge: add generated candidate",
            "body": "from artifact",
            "paths": ["candidate/generated.md"],
            "actor": TRUSTED,
            "expectedRevision": staged.json()["revision"],
            "expectedRepositoryRevision": repo_latest["revision"],
            "now": NOW,
        },
    )
    assert committed.status_code == 200, committed.text
    assert committed.json()["commitHash"]
    final = client.get(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}"
    ).json()
    assert final["status"] == "COMMITTED"


def test_change_set_high_requires_approval_then_apply(tmp_path: Path) -> None:
    client, _service = _make_client(tmp_path, provider_mode="knowledge-valid-high")
    repository_id, repository = _activate_repository(client, tmp_path)
    project_path, run = _import_project_and_create_run(client, tmp_path)
    artifact_file = project_path / "plan.md"
    artifact_file.write_text("# Plan\n", encoding="utf-8")
    run, artifact_id = _submit_artifact(client, run, artifact_file)

    created = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets",
        json={
            "repositoryId": repository_id,
            "artifactIds": [artifact_id],
            "provider": "fake",
            "mode": "preview",
            "actor": TRUSTED,
            "now": NOW,
        },
    )
    assert created.status_code == 201, created.text
    change_set_id = created.json()["id"]
    generated = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}/generate",
        json={"actor": TRUSTED, "expectedRevision": created.json()["revision"], "now": NOW},
    )
    assert generated.status_code == 202, generated.text
    detail = _wait_change_set_status(
        client, run, change_set_id, {"AWAITING_APPROVAL", "BLOCKED", "READY_TO_APPLY"}
    )
    assert detail["status"] == "AWAITING_APPROVAL", detail["status"]
    assert detail["riskLevel"] == "HIGH"

    approved = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}/approve",
        json={"comment": "已核对索引变更", "actor": TRUSTED, "expectedRevision": detail["revision"], "now": NOW},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "APPROVED"

    applied = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}/apply",
        json={"actor": TRUSTED, "expectedRevision": approved.json()["revision"], "now": NOW},
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "APPLIED"


def test_change_set_invalid_outside_path_blocks(tmp_path: Path) -> None:
    client, _service = _make_client(tmp_path, provider_mode="knowledge-invalid-outside")
    repository_id, _repository = _activate_repository(client, tmp_path)
    project_path, run = _import_project_and_create_run(client, tmp_path)
    artifact_file = project_path / "plan.md"
    artifact_file.write_text("# Plan\n", encoding="utf-8")
    run, artifact_id = _submit_artifact(client, run, artifact_file)

    created = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets",
        json={
            "repositoryId": repository_id,
            "artifactIds": [artifact_id],
            "provider": "fake",
            "mode": "preview",
            "actor": TRUSTED,
            "now": NOW,
        },
    )
    assert created.status_code == 201, created.text
    change_set_id = created.json()["id"]
    generated = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}/generate",
        json={"actor": TRUSTED, "expectedRevision": created.json()["revision"], "now": NOW},
    )
    assert generated.status_code == 202, generated.text
    detail = _wait_change_set_status(
        client, run, change_set_id, {"BLOCKED", "FAILED", "AWAITING_APPROVAL", "READY_TO_APPLY"}
    )
    assert detail["status"] == "BLOCKED", detail["status"]


def test_change_set_revision_conflict_and_scope_404(tmp_path: Path) -> None:
    client, _service = _make_client(tmp_path)
    repository_id, _repository = _activate_repository(client, tmp_path)
    project_path, run = _import_project_and_create_run(client, tmp_path)
    artifact_file = project_path / "plan.md"
    artifact_file.write_text("# Plan\n", encoding="utf-8")
    run, artifact_id = _submit_artifact(client, run, artifact_file)

    created = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets",
        json={
            "repositoryId": repository_id,
            "artifactIds": [artifact_id],
            "provider": "fake",
            "mode": "preview",
            "actor": TRUSTED,
            "now": NOW,
        },
    )
    change_set_id = created.json()["id"]
    conflict = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}/generate",
        json={"actor": TRUSTED, "expectedRevision": "999", "now": NOW},
    )
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "KNOWLEDGE_REVISION_CONFLICT"

    missing = client.get(
        f"/projects/{run['projectId']}/runs/other-run/knowledge-change-sets/{change_set_id}"
    )
    assert missing.status_code == 404
    assert missing.json()["code"] == "KNOWLEDGE_CHANGE_SET_NOT_FOUND_IN_RUN"


def _wait_change_set_status(
    client: TestClient, run: dict, change_set_id: str, targets: set[str], timeout: float = 20.0
) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        detail = client.get(
            f"/projects/{run['projectId']}/runs/{run['runId']}/knowledge-change-sets/{change_set_id}"
        ).json()
        if detail["status"] in targets:
            return detail
        time.sleep(0.1)
    raise AssertionError(f"change set did not reach {targets}: {detail['status']}")
