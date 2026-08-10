from pathlib import Path
import shutil
import subprocess
import sys
from time import sleep

from fastapi.testclient import TestClient

from workflow_platform.api.app import create_app
from workflow_platform.execution.providers import CliCommand, CodexCliProvider
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService


NOW = "2026-08-06T00:00:00Z"
ACTOR = {"id": "human-1", "type": "human", "source": "renderer", "trusted": True}
FIXTURE_WORKFLOW = Path(__file__).parent / "fixtures" / "harness_project" / ".harness" / "workflow.yaml"


class WritingProvider:
    id = "fake"

    def build_command(self, *, cwd: Path, prompt: str, allowed_tools: list[str]) -> CliCommand:
        return CliCommand(
            executable=sys.executable,
            args=["-c", "from pathlib import Path; Path('agent-marker.txt').write_text('ok', encoding='utf-8'); print('done')"],
            cwd=cwd,
        )

    def parse_line(self, line: str) -> dict:
        return CodexCliProvider(platform="linux").parse_line(line)


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)


def create_run(client: TestClient, project: dict, workspace: str, key: str):
    return client.post(
        f"/projects/{project['projectId']}/runs",
        headers={"Idempotency-Key": key},
        json={
            "workflowVersionId": project["workflowVersionId"],
            "title": key,
            "executionWorkspace": {"path": workspace, "mode": "write"},
            "actor": ACTOR,
            "now": NOW,
        },
    )


def test_two_worktrees_run_in_parallel_and_archive_blocks_writes(tmp_path) -> None:
    project_root = tmp_path / "project"
    workflow_dir = project_root / ".harness"
    workflow_dir.mkdir(parents=True)
    shutil.copyfile(FIXTURE_WORKFLOW, workflow_dir / "workflow.yaml")
    git(project_root, "init")
    git(project_root, "config", "user.email", "runtime@example.invalid")
    git(project_root, "config", "user.name", "Runtime Test")
    git(project_root, "add", ".")
    git(project_root, "commit", "-m", "fixture")

    db = connect(tmp_path / "runtime.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: WritingProvider())
    client = TestClient(create_app(service))
    project = client.post("/projects/import", json={"projectPath": str(project_root), "now": NOW}).json()

    worktrees = []
    for index in (1, 2):
        response = client.post(
            f"/projects/{project['projectId']}/worktrees",
            json={"name": f"run-{index}", "branchName": f"run/{index}", "baseRef": "HEAD"},
        )
        assert response.status_code == 201, response.text
        worktrees.append(response.json())

    first = create_run(client, project, worktrees[0]["path"], "parallel-1")
    second = create_run(client, project, worktrees[1]["path"], "parallel-2")
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["projection"]["runId"] != second.json()["projection"]["runId"]

    first_run_id = first.json()["projection"]["runId"]
    job = service.start_agent_job(
        first_run_id,
        project_id=project["projectId"],
        node_id="plan",
        provider="fake",
        prompt="write marker",
        cwd=worktrees[0]["path"],
        actor={"id": "agent-1", "type": "agent", "source": "runtime", "trusted": False},
        now=NOW,
    )
    for _ in range(100):
        if service.get_agent_job(first_run_id, job["id"])["status"] == "COMPLETED":
            break
        sleep(0.02)
    assert (Path(worktrees[0]["path"]) / "agent-marker.txt").read_text(encoding="utf-8") == "ok"
    assert not (Path(worktrees[1]["path"]) / "agent-marker.txt").exists()

    conflict = create_run(client, project, worktrees[0]["path"], "parallel-conflict")
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "WORKSPACE_LEASE_CONFLICT"

    archived = client.post(
        f"/projects/{project['projectId']}/archive",
        json={"actor": ACTOR, "now": "2026-08-06T01:00:00Z"},
    )
    assert archived.status_code == 200

    projection = first.json()["projection"]
    rejected = client.post(
        f"/projects/{project['projectId']}/runs/{projection['runId']}/actions",
        json={
            "actionId": projection["allowedActions"][0]["id"],
            "expectedRevision": projection["revision"],
            "actor": ACTOR,
            "now": "2026-08-06T01:00:01Z",
        },
    )
    assert rejected.status_code == 409
    assert rejected.json()["code"] == "PROJECT_ARCHIVED"

    client.close()
    db.close()
