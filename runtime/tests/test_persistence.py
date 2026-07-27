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

EXPECTED_COLUMNS = {
    "projects": [
        ("id", "TEXT", False, True),
        ("name", "TEXT", True, False),
        ("root_path", "TEXT", True, False),
        ("active_protocol", "TEXT", False, False),
        ("created_at", "TEXT", True, False),
        ("updated_at", "TEXT", True, False),
    ],
    "workflow_versions": [
        ("id", "TEXT", False, True),
        ("project_id", "TEXT", True, False),
        ("adapter_id", "TEXT", True, False),
        ("name", "TEXT", True, False),
        ("version", "TEXT", True, False),
        ("definition_json", "TEXT", True, False),
        ("content_hash", "TEXT", True, False),
        ("created_at", "TEXT", True, False),
    ],
    "runs": [
        ("id", "TEXT", False, True),
        ("project_id", "TEXT", True, False),
        ("workflow_version_id", "TEXT", True, False),
        ("title", "TEXT", True, False),
        ("status", "TEXT", True, False),
        ("context_json", "TEXT", True, False),
        ("created_at", "TEXT", True, False),
        ("updated_at", "TEXT", True, False),
    ],
    "run_events": [
        ("id", "TEXT", False, True),
        ("run_id", "TEXT", True, False),
        ("sequence", "INTEGER", True, False),
        ("type", "TEXT", True, False),
        ("node_id", "TEXT", False, False),
        ("actor_json", "TEXT", True, False),
        ("payload_json", "TEXT", True, False),
        ("revision", "TEXT", True, False),
        ("created_at", "TEXT", True, False),
    ],
    "run_projections": [
        ("run_id", "TEXT", False, True),
        ("status", "TEXT", True, False),
        ("current_node_ids_json", "TEXT", True, False),
        ("node_states_json", "TEXT", True, False),
        ("allowed_actions_json", "TEXT", True, False),
        ("blocking_reasons_json", "TEXT", True, False),
        ("revision", "TEXT", True, False),
        ("updated_at", "TEXT", True, False),
    ],
    "artifacts": [
        ("id", "TEXT", False, True),
        ("run_id", "TEXT", True, False),
        ("node_id", "TEXT", True, False),
        ("type", "TEXT", True, False),
        ("uri", "TEXT", True, False),
        ("content_hash", "TEXT", True, False),
        ("producer_json", "TEXT", True, False),
        ("created_at", "TEXT", True, False),
    ],
    "approvals": [
        ("id", "TEXT", False, True),
        ("run_id", "TEXT", True, False),
        ("node_id", "TEXT", True, False),
        ("status", "TEXT", True, False),
        ("requested_by_json", "TEXT", True, False),
        ("decided_by_json", "TEXT", False, False),
        ("comment", "TEXT", False, False),
        ("created_at", "TEXT", True, False),
        ("decided_at", "TEXT", False, False),
    ],
    "gate_results": [
        ("id", "TEXT", False, True),
        ("run_id", "TEXT", True, False),
        ("node_id", "TEXT", True, False),
        ("gate_id", "TEXT", True, False),
        ("status", "TEXT", True, False),
        ("evidence_json", "TEXT", True, False),
        ("actor_json", "TEXT", True, False),
        ("created_at", "TEXT", True, False),
    ],
    "terminal_sessions": [
        ("id", "TEXT", False, True),
        ("project_id", "TEXT", True, False),
        ("run_id", "TEXT", True, False),
        ("node_id", "TEXT", False, False),
        ("kind", "TEXT", True, False),
        ("status", "TEXT", True, False),
        ("cwd", "TEXT", True, False),
        ("pid", "INTEGER", False, False),
        ("created_at", "TEXT", True, False),
        ("updated_at", "TEXT", True, False),
    ],
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


def table_columns(db: sqlite3.Connection, table_name: str) -> list[tuple[str, str, bool, bool]]:
    rows = db.execute(f"PRAGMA table_info({table_name})").fetchall()
    return [
        (row["name"], row["type"], bool(row["notnull"]), bool(row["pk"]))
        for row in rows
    ]


def unique_index_columns(db: sqlite3.Connection, table_name: str) -> list[tuple[str, ...]]:
    unique_columns = []
    for index in db.execute(f"PRAGMA index_list({table_name})").fetchall():
        if not index["unique"]:
            continue
        columns = db.execute(f"PRAGMA index_info({index['name']})").fetchall()
        unique_columns.append(tuple(column["name"] for column in columns))
    return unique_columns


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


def test_migrate_creates_plan_columns_for_core_tables() -> None:
    db = connect(fresh_db_path("columns"))

    migrate(db)

    for table_name, expected_columns in EXPECTED_COLUMNS.items():
        assert table_columns(db, table_name) == expected_columns


def test_run_events_has_unique_run_sequence_index() -> None:
    db = connect(fresh_db_path("run_events_unique"))

    migrate(db)

    assert ("run_id", "sequence") in unique_index_columns(db, "run_events")


def test_workflow_version_repository_round_trips_definition_json_aliases() -> None:
    db = connect(fresh_db_path("workflow_versions"))
    migrate(db)
    repository = WorkflowVersionRepository(db)
    definition = workflow_definition()

    repository.save(
        definition,
        id="workflow-version-1",
        project_id="project-1",
        content_hash="sha256:workflow-1",
        created_at="2026-07-27T13:00:00Z",
    )
    saved = db.execute(
        """
        SELECT *
        FROM workflow_versions
        WHERE id = ?
        """,
        ("workflow-version-1",),
    ).fetchone()
    saved_payload = json.loads(saved["definition_json"])
    loaded = repository.get("workflow-version-1")

    assert saved["project_id"] == "project-1"
    assert saved["adapter_id"] == definition.sourceAdapter
    assert saved["name"] == definition.name
    assert saved["version"] == definition.version
    assert saved["content_hash"] == "sha256:workflow-1"
    assert saved["created_at"] == "2026-07-27T13:00:00Z"
    assert saved_payload["edges"][0]["from"] == "task-1"
    assert "from_" not in saved_payload["edges"][0]
    assert loaded == definition
