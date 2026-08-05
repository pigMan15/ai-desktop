import os
from pathlib import Path
import sqlite3

import pytest

from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.persistence.repositories import WorkspaceLeaseRepository
from workflow_platform.workspaces import normalize_workspace_path


@pytest.fixture
def lease_db(tmp_path: Path) -> sqlite3.Connection:
    db = connect(tmp_path / "workspace-leases.db")
    migrate(db)
    now = "2026-08-05T01:00:00Z"
    db.execute(
        """
        INSERT INTO projects (
            id, name, root_path, active_protocol, created_at, updated_at
        ) VALUES ('project-1', 'Demo project', ?, NULL, ?, ?)
        """,
        (str(tmp_path), now, now),
    )
    db.execute(
        """
        INSERT INTO workflow_assets (
            id, name, is_builtin, created_by_json, created_at, updated_at
        ) VALUES ('workflow-1', 'Demo workflow', 0, '{}', ?, ?)
        """,
        (now, now),
    )
    db.execute(
        """
        INSERT INTO workflow_versions (
            id, project_id, adapter_id, name, version, definition_json,
            content_hash, workflow_asset_id, created_at
        ) VALUES ('workflow-version-1', 'project-1', 'fixture', 'Demo workflow',
                  '1', '{}', 'sha256:workflow-1', 'workflow-1', ?)
        """,
        (now,),
    )
    for run_id in ("run-1", "run-2", "run-3"):
        db.execute(
            """
            INSERT INTO runs (
                id, project_id, workflow_version_id, title, context_json,
                status, created_at, updated_at
            ) VALUES (?, 'project-1', 'workflow-version-1', ?, '{}',
                      'CREATED', ?, ?)
            """,
            (run_id, run_id, now, now),
        )
    db.commit()
    yield db
    db.close()


def test_normalize_workspace_path_resolves_and_normalizes(tmp_path: Path) -> None:
    workspace = tmp_path / "Workspace"
    workspace.mkdir()

    assert normalize_workspace_path(str(workspace) + os.sep) == os.path.normcase(
        str(workspace.resolve())
    )


@pytest.mark.parametrize("invalid_kind", ["missing", "file"])
def test_normalize_workspace_path_rejects_non_directory(
    tmp_path: Path, invalid_kind: str
) -> None:
    path = tmp_path / invalid_kind
    if invalid_kind == "file":
        path.write_text("not a directory", encoding="utf-8")

    with pytest.raises(ValueError, match="^EXECUTION_WORKSPACE_INVALID:"):
        normalize_workspace_path(path)


def test_workspace_read_leases_can_share_a_path(
    lease_db: sqlite3.Connection,
) -> None:
    repository = WorkspaceLeaseRepository(lease_db)

    repository.acquire(
        id="lease-1",
        project_id="project-1",
        run_id="run-1",
        workspace_path="G:/Project/demo",
        mode="read",
        acquired_at="2026-08-05T01:01:00Z",
    )
    repository.acquire(
        id="lease-2",
        project_id="project-1",
        run_id="run-2",
        workspace_path="G:/Project/demo",
        mode="read",
        acquired_at="2026-08-05T01:02:00Z",
    )

    assert [
        lease["runId"]
        for lease in repository.active_for_path("project-1", "G:/Project/demo")
    ] == ["run-1", "run-2"]
    assert [
        lease["id"] for lease in repository.list_for_project("project-1")
    ] == ["lease-1", "lease-2"]


def test_workspace_second_active_write_lease_conflicts(
    lease_db: sqlite3.Connection,
) -> None:
    repository = WorkspaceLeaseRepository(lease_db)
    repository.acquire(
        id="lease-1",
        project_id="project-1",
        run_id="run-1",
        workspace_path="G:/Project/demo",
        mode="write",
        acquired_at="2026-08-05T01:01:00Z",
    )

    with pytest.raises(ValueError, match="^WORKSPACE_LEASE_CONFLICT$"):
        repository.acquire(
            id="lease-2",
            project_id="project-1",
            run_id="run-2",
            workspace_path="G:/Project/demo",
            mode="write",
            acquired_at="2026-08-05T01:02:00Z",
        )


def test_workspace_lease_verify_updates_last_verified_at(
    lease_db: sqlite3.Connection,
) -> None:
    repository = WorkspaceLeaseRepository(lease_db)
    repository.acquire(
        id="lease-1",
        project_id="project-1",
        run_id="run-1",
        workspace_path="G:/Project/demo",
        mode="write",
        acquired_at="2026-08-05T01:01:00Z",
    )

    repository.verify("run-1", verified_at="2026-08-05T01:05:00Z")

    assert repository.get_for_run("run-1")["lastVerifiedAt"] == "2026-08-05T01:05:00Z"


def test_workspace_lease_allows_active_released_transition(
    lease_db: sqlite3.Connection,
) -> None:
    repository = WorkspaceLeaseRepository(lease_db)
    repository.acquire(
        id="lease-1",
        project_id="project-1",
        run_id="run-1",
        workspace_path="G:/Project/demo",
        mode="write",
        acquired_at="2026-08-05T01:01:00Z",
    )

    repository.transition(
        "run-1",
        status="released",
        reason="run completed",
        transitioned_at="2026-08-05T01:10:00Z",
    )

    assert repository.get_for_run("run-1") == {
        "id": "lease-1",
        "projectId": "project-1",
        "runId": "run-1",
        "workspacePath": "G:/Project/demo",
        "mode": "write",
        "status": "released",
        "acquiredAt": "2026-08-05T01:01:00Z",
        "lastVerifiedAt": "2026-08-05T01:01:00Z",
        "releasedAt": "2026-08-05T01:10:00Z",
        "releaseReason": "run completed",
    }


def test_workspace_lease_allows_active_expired_released_transitions(
    lease_db: sqlite3.Connection,
) -> None:
    repository = WorkspaceLeaseRepository(lease_db)
    repository.acquire(
        id="lease-1",
        project_id="project-1",
        run_id="run-1",
        workspace_path="G:/Project/demo",
        mode="write",
        acquired_at="2026-08-05T01:01:00Z",
    )

    repository.transition(
        "run-1",
        status="expired",
        reason="administrator confirmed process exit",
        transitioned_at="2026-08-05T01:10:00Z",
    )
    repository.transition(
        "run-1",
        status="released",
        reason="recovery cleanup completed",
        transitioned_at="2026-08-05T01:11:00Z",
    )

    lease = repository.get_for_run("run-1")
    assert lease["status"] == "released"
    assert lease["releasedAt"] == "2026-08-05T01:11:00Z"
    assert lease["releaseReason"] == "recovery cleanup completed"


def test_workspace_lease_rejects_invalid_transition(
    lease_db: sqlite3.Connection,
) -> None:
    repository = WorkspaceLeaseRepository(lease_db)
    repository.acquire(
        id="lease-1",
        project_id="project-1",
        run_id="run-1",
        workspace_path="G:/Project/demo",
        mode="write",
        acquired_at="2026-08-05T01:01:00Z",
    )
    repository.transition(
        "run-1",
        status="released",
        reason="run completed",
        transitioned_at="2026-08-05T01:10:00Z",
    )

    with pytest.raises(ValueError, match="^WORKSPACE_LEASE_TRANSITION_INVALID$"):
        repository.transition(
            "run-1",
            status="active",
            reason="cannot reactivate",
            transitioned_at="2026-08-05T01:11:00Z",
        )


def test_workspace_lease_terminal_transition_requires_reason(
    lease_db: sqlite3.Connection,
) -> None:
    repository = WorkspaceLeaseRepository(lease_db)
    repository.acquire(
        id="lease-1",
        project_id="project-1",
        run_id="run-1",
        workspace_path="G:/Project/demo",
        mode="write",
        acquired_at="2026-08-05T01:01:00Z",
    )

    with pytest.raises(ValueError, match="^WORKSPACE_LEASE_RELEASE_REASON_REQUIRED$"):
        repository.transition(
            "run-1",
            status="released",
            reason=" ",
            transitioned_at="2026-08-05T01:10:00Z",
        )
