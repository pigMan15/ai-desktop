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
    run_a = create_scoped_run(
        client,
        project_a["projectId"],
        project_a["workflowVersionId"],
        tmp_path / "project-a",
        "project-a-run",
    ).json()["projection"]
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


def test_scoped_agent_rejects_read_execution_lease(project_client) -> None:
    client, project_id, workflow_version_id, workspace = project_client
    created = client.post(
        f"/projects/{project_id}/runs",
        headers={"Idempotency-Key": "read-agent"},
        json={
            "workflowVersionId": workflow_version_id,
            "title": "Read-only Agent",
            "executionWorkspace": {"path": str(workspace), "mode": "read"},
            "actor": ACTOR,
        },
    )
    run_id = created.json()["projection"]["runId"]

    response = client.post(
        f"/projects/{project_id}/runs/{run_id}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "must not start",
            "cwd": str(workspace),
            "actor": ACTOR,
            "now": NOW,
        },
    )

    assert response.status_code == 423
    assert response.json()["code"] == "WORKSPACE_RECOVERY_REQUIRED"


def test_legacy_core_run_routes_are_absent_and_scoped_routes_work(project_client) -> None:
    client, project_id, workflow_version_id, workspace = project_client
    created = create_scoped_run(
        client, project_id, workflow_version_id, workspace, "scoped-contract"
    )
    projection = created.json()["projection"]
    run_id = projection["runId"]

    listed = client.get(f"/projects/{project_id}/runs")
    detail = client.get(f"/projects/{project_id}/runs/{run_id}")
    scoped_projection = client.get(
        f"/projects/{project_id}/runs/{run_id}/projection"
    )
    overview = client.get(f"/projects/{project_id}/runs/{run_id}/overview")
    action = client.post(
        f"/projects/{project_id}/runs/{run_id}/actions",
        json={
            "actionId": projection["allowedActions"][0]["id"],
            "expectedRevision": projection["revision"],
            "actor": ACTOR,
            "now": NOW,
        },
    )

    assert created.status_code == 201
    assert listed.status_code == 200
    assert listed.json()["items"][0]["id"] == run_id
    assert detail.status_code == 200
    assert detail.json()["id"] == run_id
    assert scoped_projection.status_code == 200
    assert scoped_projection.json()["runId"] == run_id
    assert overview.status_code == 200
    assert overview.json()["projection"]["runId"] == run_id
    assert action.status_code == 200
    assert action.json()["revision"] != projection["revision"]

    legacy_responses = [
        client.post("/runs", json={}),
        client.get(f"/workflow-versions/{workflow_version_id}/runs"),
        client.get(f"/runs/{run_id}"),
        client.get(f"/runs/{run_id}/projection"),
        client.post(f"/runs/{run_id}/transition", json={}),
    ]
    assert all(response.status_code == 404 for response in legacy_responses)


def test_maintenance_mode_blocks_all_scoped_run_starts(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    setup_client = TestClient(create_app(service))
    imported = import_project(setup_client, tmp_path, "project-maintenance")
    workspace = tmp_path / "project-maintenance"
    run_id = create_scoped_run(
        setup_client,
        imported["projectId"],
        imported["workflowVersionId"],
        workspace,
        "before-maintenance",
    ).json()["projection"]["runId"]
    setup_client.close()

    client = TestClient(create_app(service, maintenance=True))
    requests = [
        client.post(
            f"/projects/{imported['projectId']}/runs",
            headers={"Idempotency-Key": "during-maintenance"},
            json={
                "workflowVersionId": imported["workflowVersionId"],
                "title": "Blocked Run",
                "executionWorkspace": {"path": str(workspace), "mode": "write"},
                "actor": ACTOR,
                "now": NOW,
            },
        ),
        client.post(
            f"/projects/{imported['projectId']}/runs/{run_id}/agents",
            json={
                "nodeId": "plan",
                "provider": "fake",
                "prompt": "blocked",
                "cwd": str(workspace),
                "actor": ACTOR,
                "now": NOW,
            },
        ),
        client.post(
            f"/projects/{imported['projectId']}/runs/{run_id}/terminals",
            json={
                "nodeId": "plan",
                "kind": "shell",
                "cwd": str(workspace),
                "pid": 1234,
                "now": NOW,
            },
        ),
        client.post(
            f"/projects/{imported['projectId']}/runs/{run_id}/deployments",
            json={
                "nodeId": "plan",
                "actor": ACTOR,
                "expectedRevision": "0",
                "now": NOW,
            },
        ),
    ]

    assert [response.status_code for response in requests] == [503, 503, 503, 503]
    assert {
        response.json()["code"] for response in requests
    } == {"RUN_REARCHITECTURE_MAINTENANCE"}

    invalid_requests = [
        client.post(f"/projects/{imported['projectId']}/runs", json={}),
        client.post(
            f"/projects/{imported['projectId']}/runs/{run_id}/agents", json={}
        ),
        client.post(
            f"/projects/{imported['projectId']}/runs/{run_id}/terminals", json={}
        ),
        client.post(
            f"/projects/{imported['projectId']}/runs/{run_id}/deployments", json={}
        ),
    ]
    assert [response.status_code for response in invalid_requests] == [503, 503, 503, 503]
    assert {
        response.json()["code"] for response in invalid_requests
    } == {"RUN_REARCHITECTURE_MAINTENANCE"}
    client.close()
    db.close()
