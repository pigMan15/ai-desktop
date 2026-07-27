import json
from pathlib import Path
import sqlite3

from workflow_platform.models import WorkflowDefinition, WorkflowEdge, WorkflowNode
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.persistence.repositories import WorkflowVersionRepository


CORE_TABLES = {
    "projects",
    "workflow_versions",
    "runs",
    "run_events",
    "run_projections",
    "artifacts",
    "approvals",
    "gate_results",
    "terminal_sessions",
}


def fresh_db_path(name: str) -> Path:
    path = Path(__file__).with_name(f"{name}.db")
    for candidate in (
        path,
        path.with_name(f"{path.name}-shm"),
        path.with_name(f"{path.name}-wal"),
    ):
        if candidate.exists():
            candidate.unlink()
    return path


def workflow_definition() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="workflow-1",
        name="Demo workflow",
        version="1",
        sourceAdapter="fixture",
        nodes=[WorkflowNode(id="task-1", name="Implement", kind="task")],
        edges=[WorkflowEdge(id="edge-1", from_="task-1", to="task-2")],
        roles=[],
        gates=[],
        policies={},
        metadata={"source": "test"},
    )


def table_names(db: sqlite3.Connection) -> set[str]:
    rows = db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {row["name"] for row in rows}


def test_connect_enables_row_factory_wal_and_foreign_keys() -> None:
    db = connect(fresh_db_path("connect"))

    row = db.execute("SELECT 1 AS value").fetchone()

    assert row["value"] == 1
    assert db.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1


def test_migrate_creates_core_tables_and_is_idempotent() -> None:
    db = connect(fresh_db_path("migrate"))

    migrate(db)
    migrate(db)

    assert CORE_TABLES <= table_names(db)


def test_workflow_version_repository_round_trips_definition_json_aliases() -> None:
    db = connect(fresh_db_path("workflow_versions"))
    migrate(db)
    repository = WorkflowVersionRepository(db)
    definition = workflow_definition()

    repository.save(definition)
    saved = db.execute(
        "SELECT definition_json FROM workflow_versions WHERE workflow_id = ? AND version = ?",
        (definition.id, definition.version),
    ).fetchone()
    saved_payload = json.loads(saved["definition_json"])
    loaded = repository.get(definition.id, definition.version)

    assert saved_payload["edges"][0]["from"] == "task-1"
    assert "from_" not in saved_payload["edges"][0]
    assert loaded == definition
