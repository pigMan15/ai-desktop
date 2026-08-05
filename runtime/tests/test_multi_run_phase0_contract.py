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
