import sqlite3
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from workflow_platform.api.app import create_app
from workflow_platform.persistence.migrations import migrate
from workflow_platform.persistence.repositories import AgentJobRepository, ProjectRepository
from workflow_platform.runtime_service import WorkflowRuntimeService
from workflow_platform.runtime_errors import RuntimeContractError


@pytest.fixture
def project_repo() -> tuple[sqlite3.Connection, ProjectRepository]:
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    migrate(db)
    now = "2026-08-06T00:00:00Z"
    db.execute(
        """
        INSERT INTO projects (id, name, root_path, active_protocol, created_at, updated_at)
        VALUES ('project-1', 'Demo', 'G:/demo', NULL, ?, ?)
        """,
        (now, now),
    )
    return db, ProjectRepository(db)


def test_project_concurrency_defaults_and_updates(project_repo) -> None:
    _db, projects = project_repo
    assert projects.concurrency("project-1") == {
        "maxActiveRuns": 3,
        "maxActiveAgents": 2,
    }

    updated = projects.update_concurrency(
        "project-1",
        max_active_runs=5,
        max_active_agents=4,
        now="2026-08-06T01:00:00Z",
    )
    assert updated == {"maxActiveRuns": 5, "maxActiveAgents": 4}


@pytest.mark.parametrize("max_runs,max_agents", [(0, 2), (11, 2), (3, 0), (3, 11)])
def test_project_concurrency_rejects_values_outside_one_to_ten(
    project_repo, max_runs: int, max_agents: int
) -> None:
    _db, projects = project_repo
    with pytest.raises(ValueError, match="PROJECT_CONCURRENCY_INVALID"):
        projects.update_concurrency(
            "project-1",
            max_active_runs=max_runs,
            max_active_agents=max_agents,
            now="2026-08-06T01:00:00Z",
        )


def test_project_concurrency_and_workspace_routes(project_repo) -> None:
    db, _projects = project_repo
    client = TestClient(create_app(WorkflowRuntimeService(db)))

    assert client.get("/projects/project-1/concurrency").json() == {
        "maxActiveRuns": 3,
        "maxActiveAgents": 2,
    }
    updated = client.put(
        "/projects/project-1/concurrency",
        json={
            "maxActiveRuns": 6,
            "maxActiveAgents": 5,
            "actor": {"id": "operator", "type": "human", "source": "runtime", "trusted": True},
            "now": "2026-08-06T01:00:00Z",
        },
    )
    assert updated.status_code == 200
    assert updated.json() == {"maxActiveRuns": 6, "maxActiveAgents": 5}

    workspaces = client.get("/projects/project-1/workspaces")
    assert workspaces.status_code == 200
    assert workspaces.json() == [{
        "path": "G:/demo",
        "label": "demo",
        "occupiedByRunId": None,
        "leaseMode": None,
        "leaseStatus": None,
        "recommended": True,
    }]


def test_runtime_rejects_a_fourth_active_run_at_the_default_limit() -> None:
    db = sqlite3.connect(":memory:", check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    migrate(db)
    now = "2026-08-06T00:00:00Z"
    root = str(Path.cwd())
    workflow = {
        "id": "workflow-1",
        "name": "Concurrency workflow",
        "version": "1",
        "sourceAdapter": "generic-yaml",
        "nodes": [{"id": "plan", "name": "Plan", "kind": "task"}],
        "edges": [],
        "roles": [],
        "gates": [],
        "policies": {},
        "metadata": {},
    }
    db.execute(
        "INSERT INTO projects (id, name, root_path, active_protocol, created_at, updated_at) VALUES ('project-1','Demo',?,NULL,?,?)",
        (root, now, now),
    )
    db.execute(
        "INSERT INTO workflow_assets (id,name,is_builtin,created_by_json,created_at,updated_at) VALUES ('workflow-1','Demo',0,'{}',?,?)",
        (now, now),
    )
    db.execute(
        """
        INSERT INTO workflow_versions
        (id,project_id,adapter_id,name,version,definition_json,content_hash,workflow_asset_id,created_at)
        VALUES ('workflow-version-1','project-1','generic-yaml','Demo','1',?,'hash','workflow-1',?)
        """,
        (json.dumps(workflow), now),
    )
    db.execute(
        "INSERT INTO project_workflow_bindings (project_id,workflow_id,workflow_version_id,actor_json,bound_at) VALUES ('project-1','workflow-1','workflow-version-1','{}',?)",
        (now,),
    )
    db.commit()
    service = WorkflowRuntimeService(db)
    actor = {"id": "operator", "type": "human", "source": "runtime", "trusted": True}

    for index in range(3):
        service.create_run(
            "project-1",
            "workflow-version-1",
            title=f"Run {index}",
            execution_workspace=root,
            workspace_mode="read",
            actor=actor,
            now=f"2026-08-06T00:00:0{index}Z",
        )

    with pytest.raises(RuntimeContractError) as rejected:
        service.create_run(
            "project-1",
            "workflow-version-1",
            title="Run 4",
            execution_workspace=root,
            workspace_mode="read",
            actor=actor,
            now="2026-08-06T00:00:04Z",
        )
    assert rejected.value.code == "RUN_CONCURRENCY_LIMIT"
    assert db.execute("SELECT COUNT(*) AS count FROM runs").fetchone()["count"] == 3

    run_id = db.execute("SELECT id FROM runs ORDER BY created_at LIMIT 1").fetchone()["id"]
    jobs = AgentJobRepository(db)
    for index in range(2):
        jobs.create(
            id=f"job-{index}",
            run_id=run_id,
            node_id="plan",
            provider="fake",
            status="RUNNING",
            command=["fake"],
            cwd=root,
            created_at=now,
        )
    with pytest.raises(RuntimeContractError) as agent_rejected:
        service._assert_agent_concurrency("project-1", run_id)
    assert agent_rejected.value.code == "AGENT_CONCURRENCY_LIMIT"
