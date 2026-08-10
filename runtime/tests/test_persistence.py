import json
from pathlib import Path
import sqlite3

import pytest

from workflow_platform.models import (
    AgentJob,
    AgentSession,
    AgentOutputEvent,
    WorkflowDefinition,
    WorkflowEdge,
    WorkflowNode,
)
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.persistence.repositories import (
    AgentJobRepository,
    RunRepository,
    TerminalSessionRepository,
    WorkflowVersionRepository,
)


CORE_TABLES = {
    "projects",
    "workflow_versions",
    "runs",
    "run_events",
    "run_projections",
    "run_workspace_leases",
    "run_idempotency_keys",
    "artifacts",
    "approvals",
    "gate_results",
    "terminal_sessions",
    "agent_jobs",
    "agent_output_events",
    "agent_sessions",
    "agent_input_events",
}

EXPECTED_COLUMNS = {
    "projects": [
        ("id", "TEXT", False, True),
        ("name", "TEXT", True, False),
        ("root_path", "TEXT", True, False),
        ("active_protocol", "TEXT", False, False),
        ("archived_at", "TEXT", False, False),
        ("created_at", "TEXT", True, False),
        ("updated_at", "TEXT", True, False),
        ("max_active_runs", "INTEGER", True, False),
        ("max_active_agents", "INTEGER", True, False),
    ],
    "workflow_versions": [
        ("id", "TEXT", False, True),
        ("project_id", "TEXT", True, False),
        ("adapter_id", "TEXT", True, False),
        ("name", "TEXT", True, False),
        ("version", "TEXT", True, False),
        ("definition_json", "TEXT", True, False),
        ("content_hash", "TEXT", True, False),
        ("workflow_asset_id", "TEXT", True, False),
        ("created_at", "TEXT", True, False),
    ],
    "runs": [
        ("id", "TEXT", False, True),
        ("project_id", "TEXT", True, False),
        ("workflow_version_id", "TEXT", True, False),
        ("workflow_snapshot_json", "TEXT", True, False),
        ("title", "TEXT", True, False),
        ("context_json", "TEXT", True, False),
        ("execution_workspace", "TEXT", True, False),
        ("workspace_mode", "TEXT", True, False),
        ("status", "TEXT", True, False),
        ("created_at", "TEXT", True, False),
        ("updated_at", "TEXT", True, False),
    ],
    "run_workspace_leases": [
        ("id", "TEXT", False, True),
        ("project_id", "TEXT", True, False),
        ("run_id", "TEXT", True, False),
        ("workspace_path", "TEXT", True, False),
        ("mode", "TEXT", True, False),
        ("status", "TEXT", True, False),
        ("acquired_at", "TEXT", True, False),
        ("last_verified_at", "TEXT", True, False),
        ("released_at", "TEXT", False, False),
        ("release_reason", "TEXT", False, False),
    ],
    "run_idempotency_keys": [
        ("project_id", "TEXT", True, True),
        ("idempotency_key", "TEXT", True, True),
        ("run_id", "TEXT", True, False),
        ("request_hash", "TEXT", True, False),
        ("created_at", "TEXT", True, False),
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
        ("artifact_spec_id", "TEXT", False, False),
        ("workflow_version_id", "TEXT", False, False),
        ("source_agent_job_id", "TEXT", False, False),
        ("template_path", "TEXT", False, False),
        ("relative_path", "TEXT", False, False),
        ("file_size", "INTEGER", False, False),
        ("media_type", "TEXT", False, False),
        ("status", "TEXT", True, False),
        ("supersedes_artifact_id", "TEXT", False, False),
        ("verified_at", "TEXT", False, False),
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
        ("artifact_hashes_json", "TEXT", True, False),
        ("invalidated_at", "TEXT", False, False),
        ("invalidation_reason", "TEXT", False, False),
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
        ("artifact_hashes_json", "TEXT", True, False),
        ("invalidated_at", "TEXT", False, False),
        ("invalidation_reason", "TEXT", False, False),
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
    "agent_jobs": [
        ("id", "TEXT", False, True),
        ("project_id", "TEXT", False, False),
        ("run_id", "TEXT", False, False),
        ("node_id", "TEXT", False, False),
        ("purpose", "TEXT", True, False),
        ("owner_id", "TEXT", False, False),
        ("provider", "TEXT", True, False),
        ("status", "TEXT", True, False),
        ("command_json", "TEXT", True, False),
        ("cwd", "TEXT", True, False),
        ("mode", "TEXT", True, False),
        ("session_id", "TEXT", False, False),
        ("parent_job_id", "TEXT", False, False),
        ("metadata_json", "TEXT", True, False),
        ("pid", "INTEGER", False, False),
        ("summary", "TEXT", False, False),
        ("error", "TEXT", False, False),
        ("created_at", "TEXT", True, False),
        ("updated_at", "TEXT", True, False),
    ],
    "agent_output_events": [
        ("id", "TEXT", False, True),
        ("job_id", "TEXT", True, False),
        ("sequence", "INTEGER", True, False),
        ("kind", "TEXT", True, False),
        ("payload_json", "TEXT", True, False),
        ("created_at", "TEXT", True, False),
    ],
    "agent_sessions": [
        ("id", "TEXT", False, True),
        ("run_id", "TEXT", True, False),
        ("job_id", "TEXT", True, False),
        ("provider", "TEXT", True, False),
        ("status", "TEXT", True, False),
        ("desktop_session_id", "TEXT", False, False),
        ("pid", "INTEGER", False, False),
        ("cwd", "TEXT", True, False),
        ("max_output_bytes", "INTEGER", True, False),
        ("recovery_reason", "TEXT", False, False),
        ("created_at", "TEXT", True, False),
        ("updated_at", "TEXT", True, False),
        ("ended_at", "TEXT", False, False),
    ],
    "agent_input_events": [
        ("id", "TEXT", False, True),
        ("session_id", "TEXT", True, False),
        ("sequence", "INTEGER", True, False),
        ("kind", "TEXT", True, False),
        ("content", "TEXT", True, False),
        ("created_at", "TEXT", True, False),
    ],
}

EXPECTED_FOREIGN_KEYS = {
    "workflow_versions": [("project_id", "projects", "id")],
    "runs": [
        ("project_id", "projects", "id"),
        ("workflow_version_id", "workflow_versions", "id"),
    ],
    "run_events": [("run_id", "runs", "id")],
    "run_projections": [("run_id", "runs", "id")],
    "run_workspace_leases": [
        ("project_id", "projects", "id"),
        ("run_id", "runs", "id"),
    ],
    "run_idempotency_keys": [
        ("project_id", "projects", "id"),
        ("run_id", "runs", "id"),
    ],
    "artifacts": [("run_id", "runs", "id")],
    "approvals": [("run_id", "runs", "id")],
    "gate_results": [("run_id", "runs", "id")],
    "terminal_sessions": [
        ("project_id", "projects", "id"),
        ("run_id", "runs", "id"),
    ],
    "agent_jobs": [("run_id", "runs", "id")],
    "agent_output_events": [("job_id", "agent_jobs", "id")],
    "agent_sessions": [
        ("run_id", "runs", "id"),
        ("job_id", "agent_jobs", "id"),
    ],
    "agent_input_events": [("session_id", "agent_sessions", "id")],
}


def fresh_db_path(name: str) -> Path:
    path = Path(__file__).with_name(f"{name}.db")
    for candidate in (
        path,
        path.with_name(f"{path.name}-shm"),
        path.with_name(f"{path.name}-wal"),
        path.with_name(f"{path.name}-journal"),
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


def index_names(db: sqlite3.Connection, table_name: str) -> set[str]:
    return {
        row["name"]
        for row in db.execute(f"PRAGMA index_list({table_name})").fetchall()
    }


def foreign_keys(db: sqlite3.Connection, table_name: str) -> list[tuple[str, str, str]]:
    rows = db.execute(f"PRAGMA foreign_key_list({table_name})").fetchall()
    return [(row["from"], row["table"], row["to"]) for row in rows]


def insert_project(db: sqlite3.Connection) -> None:
    db.execute(
        """
        INSERT INTO projects (
            id,
            name,
            root_path,
            active_protocol,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            "project-1",
            "Demo project",
            "G:/Project/demo",
            None,
            "2026-07-27T13:00:00Z",
            "2026-07-27T13:00:00Z",
        ),
    )
    db.commit()


def insert_run(db: sqlite3.Connection) -> None:
    insert_project(db)
    insert_workflow_asset(db)
    db.execute(
        """
        INSERT INTO workflow_versions (
            id,
            project_id,
            adapter_id,
            name,
            version,
            definition_json,
            content_hash,
            workflow_asset_id,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "workflow-version-1",
            "project-1",
            "fixture",
            "Demo workflow",
            "1",
            "{}",
            "sha256:workflow-1",
            "workflow-asset-1",
            "2026-07-27T13:00:00Z",
        ),
    )
    db.execute(
        """
        INSERT INTO runs (
            id,
            project_id,
            workflow_version_id,
            title,
            status,
            context_json,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "run-1",
            "project-1",
            "workflow-version-1",
            "Demo run",
            "CREATED",
            "{}",
            "2026-07-27T13:00:00Z",
            "2026-07-27T13:00:00Z",
        ),
    )
    db.commit()


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


def test_run_rearchitecture_migration_preserves_static_data_and_clears_run_state() -> None:
    db = connect(fresh_db_path("run_rearchitecture"))
    migrate(db)
    downgrade_runs_to_legacy_schema(db)
    insert_project(db)
    db.execute(
        """
        INSERT INTO workflow_assets (
            id, name, is_builtin, archived_at, created_by_json,
            created_at, updated_at, current_workflow_version_id
        ) VALUES ('workflow-asset-1', 'Demo workflow', 0, NULL, '{}',
                  '2026-07-27T13:00:00Z', '2026-07-27T13:00:00Z', NULL)
        """
    )
    db.commit()
    insert_legacy_run_state(db)

    migrate(db)

    assert table_columns(db, "runs") == EXPECTED_COLUMNS["runs"]
    assert db.execute("SELECT id FROM projects").fetchall()[0]["id"] == "project-1"
    assert db.execute("SELECT id FROM workflow_assets").fetchall()[0]["id"] == "workflow-asset-1"
    assert db.execute("SELECT id FROM workflow_versions").fetchall()[0]["id"] == "workflow-version-1"
    assert db.execute("SELECT project_id FROM project_workflow_bindings").fetchall()[0]["project_id"] == "project-1"
    assert db.execute("SELECT id FROM role_assets").fetchall()[0]["id"] == "role-1"
    assert db.execute("SELECT id FROM role_versions").fetchall()[0]["id"] == "role-version-1"

    run_state_tables = {
        "runs",
        "run_events",
        "run_projections",
        "run_workspace_leases",
        "run_idempotency_keys",
        "artifacts",
        "artifact_consumers",
        "approvals",
        "gate_results",
        "terminal_sessions",
        "terminal_output_events",
        "agent_jobs",
        "agent_sessions",
        "agent_input_events",
        "agent_output_events",
        "agent_checkpoints",
        "deployments",
        "deployment_output_events",
    }
    assert all(
        db.execute(f"SELECT COUNT(*) FROM {table_name}").fetchone()[0] == 0
        for table_name in run_state_tables
    )
    assert [
        row["id"] for row in db.execute("SELECT id FROM audit_records ORDER BY id")
    ] == ["audit-project-1"]
    assert db.execute("PRAGMA foreign_key_check").fetchall() == []


def test_migrate_adds_project_archive_column_to_existing_database() -> None:
    db = connect(fresh_db_path("project_archive_migration"))
    db.execute(
        """
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            root_path TEXT NOT NULL,
            active_protocol TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    db.commit()


def downgrade_runs_to_legacy_schema(db: sqlite3.Connection) -> None:
    columns = {row["name"] for row in db.execute("PRAGMA table_info(runs)")}
    if "workflow_snapshot_json" not in columns:
        return

    db.commit()
    db.execute("PRAGMA foreign_keys = OFF")
    db.executescript(
        """
        CREATE TABLE legacy_runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            workflow_version_id TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            context_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions(id) ON DELETE CASCADE
        );
        DROP TABLE runs;
        ALTER TABLE legacy_runs RENAME TO runs;
        """
    )
    db.execute("PRAGMA foreign_keys = ON")


def insert_legacy_run_state(db: sqlite3.Connection) -> None:
    timestamp = "2026-07-27T13:00:00Z"
    db.execute(
        """
        INSERT INTO workflow_versions (
            id, project_id, adapter_id, name, version, definition_json,
            content_hash, workflow_asset_id, created_at
        ) VALUES ('workflow-version-1', 'project-1', 'fixture', 'Demo workflow',
                  '1', '{}', 'sha256:workflow-1', 'workflow-asset-1', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO project_workflow_bindings (
            project_id, workflow_id, workflow_version_id, actor_json, bound_at
        ) VALUES ('project-1', 'workflow-asset-1', 'workflow-version-1', '{}', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO role_assets (
            id, name, is_builtin, created_by_json, created_at, updated_at,
            current_role_version_id
        ) VALUES ('role-1', 'Developer', 0, '{}', ?, ?, 'role-version-1')
        """,
        (timestamp, timestamp),
    )
    db.execute(
        """
        INSERT INTO role_versions (id, role_id, version, definition_json, created_at)
        VALUES ('role-version-1', 'role-1', 1, '{}', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO runs (
            id, project_id, workflow_version_id, title, status, context_json,
            created_at, updated_at
        ) VALUES ('run-1', 'project-1', 'workflow-version-1', 'Legacy run',
                  'RUNNING', '{}', ?, ?)
        """,
        (timestamp, timestamp),
    )
    db.execute(
        """
        INSERT INTO run_events (
            id, run_id, sequence, type, actor_json, payload_json, revision, created_at
        ) VALUES ('event-1', 'run-1', 1, 'RUN_CREATED', '{}', '{}', 'rev-1', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO run_projections (
            run_id, status, current_node_ids_json, node_states_json,
            allowed_actions_json, blocking_reasons_json, revision, updated_at
        ) VALUES ('run-1', 'RUNNING', '[]', '{}', '[]', '[]', 'rev-1', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO artifacts (
            id, run_id, node_id, type, uri, content_hash, producer_json, created_at
        ) VALUES ('artifact-1', 'run-1', 'task-1', 'report', 'file:///report.md',
                  'sha256:artifact-1', '{}', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO artifact_consumers (
            id, artifact_id, consumer_run_id, consumer_node_id, context_created_at
        ) VALUES ('consumer-1', 'artifact-1', 'run-1', 'task-2', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO approvals (
            id, run_id, node_id, status, requested_by_json, created_at
        ) VALUES ('approval-1', 'run-1', 'task-1', 'PENDING', '{}', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO gate_results (
            id, run_id, node_id, gate_id, status, evidence_json, actor_json, created_at
        ) VALUES ('gate-result-1', 'run-1', 'task-1', 'gate-1', 'PASSED', '[]', '{}', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO terminal_sessions (
            id, project_id, run_id, kind, status, cwd, created_at, updated_at
        ) VALUES ('terminal-1', 'project-1', 'run-1', 'shell', 'running',
                  'G:/Project/demo', ?, ?)
        """,
        (timestamp, timestamp),
    )
    db.execute(
        """
        INSERT INTO terminal_output_events (
            id, session_id, sequence, stream, data, created_at
        ) VALUES ('terminal-output-1', 'terminal-1', 1, 'stdout', 'running', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO agent_jobs (
            id, project_id, run_id, node_id, purpose, provider, status, command_json, cwd,
            created_at, updated_at
        ) VALUES ('agent-job-1', 'project-1', 'run-1', 'task-1', 'workflow-node', 'fixture', 'RUNNING', '[]',
                  'G:/Project/demo', ?, ?)
        """,
        (timestamp, timestamp),
    )
    db.execute(
        """
        INSERT INTO agent_output_events (
            id, job_id, sequence, kind, payload_json, created_at
        ) VALUES ('agent-output-1', 'agent-job-1', 1, 'message', '{}', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO agent_checkpoints (
            id, run_id, job_id, node_id, provider, prompt, allowed_tools_json,
            timeout_seconds, max_output_bytes, status, created_at, updated_at
        ) VALUES ('checkpoint-1', 'run-1', 'agent-job-1', 'task-1', 'fixture',
                  'continue', '[]', 30, 1000, 'RUNNING', ?, ?)
        """,
        (timestamp, timestamp),
    )
    db.execute(
        """
        INSERT INTO agent_sessions (
            id, run_id, job_id, provider, status, cwd, created_at, updated_at
        ) VALUES ('agent-session-1', 'run-1', 'agent-job-1', 'fixture', 'RUNNING',
                  'G:/Project/demo', ?, ?)
        """,
        (timestamp, timestamp),
    )
    db.execute(
        """
        INSERT INTO agent_input_events (id, session_id, sequence, kind, content, created_at)
        VALUES ('agent-input-1', 'agent-session-1', 1, 'stdin', 'continue', ?)
        """,
        (timestamp,),
    )
    db.execute(
        """
        INSERT INTO deployments (
            id, run_id, node_id, command_json, cwd, status, created_at, updated_at
        ) VALUES ('deployment-1', 'run-1', 'task-1', '[]', 'G:/Project/demo',
                  'RUNNING', ?, ?)
        """,
        (timestamp, timestamp),
    )
    db.execute(
        """
        INSERT INTO deployment_output_events (
            id, deployment_id, sequence, data, created_at
        ) VALUES ('deployment-output-1', 'deployment-1', 1, 'deploying', ?)
        """,
        (timestamp,),
    )
    for record_id, resource in (
        ("audit-run-1", "run:run-1"),
        ("audit-project-1", "project:project-1"),
    ):
        db.execute(
            """
            INSERT INTO audit_records (
                id, actor_id, actor_json, action, resource, detail_json,
                record_hash, created_at
            ) VALUES (?, 'actor-1', '{}', 'test', ?, '{}', ?, ?)
            """,
            (record_id, resource, f"hash:{record_id}", timestamp),
        )
    db.commit()


def insert_workflow_asset(db: sqlite3.Connection, asset_id: str = "workflow-asset-1") -> None:
    db.execute(
        """
        INSERT OR IGNORE INTO workflow_assets (
            id, name, is_builtin, archived_at, created_by_json,
            created_at, updated_at, current_workflow_version_id
        ) VALUES (?, ?, 0, NULL, '{}', ?, ?, NULL)
        """,
        (asset_id, "Demo workflow", "2026-07-27T13:00:00Z", "2026-07-27T13:00:00Z"),
    )
    db.commit()

    migrate(db)

    assert ("archived_at", "TEXT", False, False) in table_columns(db, "projects")


def test_migrate_normalizes_missing_legacy_artifact_producer_metadata() -> None:
    db = connect(fresh_db_path("legacy_artifact_producer"))
    db.execute(
        """
        CREATE TABLE artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            type TEXT NOT NULL,
            uri TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            producer_json TEXT,
            created_at TEXT NOT NULL
        )
        """
    )
    db.execute(
        """
        INSERT INTO artifacts (id, run_id, node_id, type, uri, content_hash, producer_json, created_at)
        VALUES ('legacy-artifact', 'legacy-run', 'legacy-node', 'report', 'file:///legacy.md', 'legacy-hash', NULL, '2026-07-30T00:00:00Z')
        """
    )
    db.commit()

    migrate(db)

    assert db.execute(
        "SELECT producer_json FROM artifacts WHERE id = 'legacy-artifact'"
    ).fetchone()["producer_json"] == "{}"


def test_migrate_adds_interactive_agent_columns_and_tables_to_existing_database() -> None:
    db = connect(fresh_db_path("interactive_agent_migration"))
    db.execute(
        """
        CREATE TABLE agent_jobs (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            command_json TEXT NOT NULL,
            cwd TEXT NOT NULL,
            pid INTEGER,
            summary TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    db.commit()

    migrate(db)
    migrate(db)

    assert {"mode", "session_id", "parent_job_id"} <= {
        row["name"] for row in db.execute("PRAGMA table_info(agent_jobs)").fetchall()
    }
    assert {"id", "run_id", "job_id", "provider", "status", "cwd", "max_output_bytes"} <= {
        row["name"] for row in db.execute("PRAGMA table_info(agent_sessions)").fetchall()
    }
    assert {"id", "session_id", "sequence", "kind", "content"} <= {
        row["name"] for row in db.execute("PRAGMA table_info(agent_input_events)").fetchall()
    }
    assert db.execute(
        """
        SELECT dflt_value
        FROM pragma_table_info('agent_jobs')
        WHERE name = 'mode'
        """
    ).fetchone()["dflt_value"] == "'automatic'"
    assert "idx_agent_sessions_run_status" in index_names(db, "agent_sessions")
    assert "idx_agent_input_events_session_sequence" in index_names(
        db, "agent_input_events"
    )


def test_run_events_has_unique_run_sequence_index() -> None:
    db = connect(fresh_db_path("run_events_unique"))

    migrate(db)

    assert ("run_id", "sequence") in unique_index_columns(db, "run_events")


def test_multi_run_schema_has_required_indexes_and_restricted_version_delete() -> None:
    db = connect(fresh_db_path("multi_run_schema"))

    migrate(db)

    assert {
        "runs_project_updated_idx",
        "runs_project_status_updated_idx",
        "runs_project_workflow_updated_idx",
    } <= index_names(db, "runs")
    assert {
        "run_workspace_active_write_unique",
        "run_workspace_lease_project_status_idx",
    } <= index_names(db, "run_workspace_leases")
    version_fk = next(
        row
        for row in db.execute("PRAGMA foreign_key_list(runs)").fetchall()
        if row["from"] == "workflow_version_id"
    )
    assert version_fk["on_delete"] == "RESTRICT"


def test_agent_output_events_has_unique_job_sequence_index() -> None:
    db = connect(fresh_db_path("agent_output_unique"))

    migrate(db)

    assert ("job_id", "sequence") in unique_index_columns(db, "agent_output_events")


def test_agent_input_events_has_unique_session_sequence_index() -> None:
    db = connect(fresh_db_path("agent_input_unique"))

    migrate(db)

    assert ("session_id", "sequence") in unique_index_columns(
        db, "agent_input_events"
    )


def test_migrate_adds_foreign_keys_for_relationship_columns() -> None:
    db = connect(fresh_db_path("foreign_keys"))

    migrate(db)

    for table_name, expected_foreign_keys in EXPECTED_FOREIGN_KEYS.items():
        assert set(expected_foreign_keys) <= set(foreign_keys(db, table_name))


def test_foreign_keys_reject_orphan_workflow_version_and_run_children() -> None:
    db = connect(fresh_db_path("orphan_foreign_keys"))

    migrate(db)

    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """
            INSERT INTO workflow_versions (
                id,
                project_id,
                adapter_id,
                name,
                version,
                definition_json,
                content_hash,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "workflow-version-1",
                "missing-project",
                "fixture",
                "Demo workflow",
                "1",
                "{}",
                "sha256:workflow-1",
                "2026-07-27T13:00:00Z",
            ),
        )


def insert_scoped_run_repository_fixture(db: sqlite3.Connection) -> WorkflowDefinition:
    migrate(db)
    workflow = WorkflowDefinition(
        id="workflow-summary",
        name="Release workflow",
        version="2.0.0",
        sourceAdapter="fixture",
        nodes=[
            WorkflowNode(id="build", name="Build", kind="agent"),
            WorkflowNode(id="review", name="Review", kind="approval"),
            WorkflowNode(id="deploy", name="Deploy", kind="deploy"),
        ],
        edges=[
            WorkflowEdge(id="edge-build-review", from_="build", to="review", condition="built"),
            WorkflowEdge(id="edge-review-deploy", from_="review", to="deploy"),
        ],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )
    snapshot_json = json.dumps(workflow.model_dump(by_alias=True), separators=(",", ":"))
    for project_id in ("project-a", "project-b"):
        db.execute(
            """
            INSERT INTO projects (
                id, name, root_path, active_protocol, created_at, updated_at
            ) VALUES (?, ?, ?, NULL, '2026-08-05T01:00:00Z', '2026-08-05T01:00:00Z')
            """,
            (project_id, project_id, f"G:/Project/{project_id}"),
        )
        db.execute(
            """
            INSERT INTO workflow_assets (
                id, name, is_builtin, created_by_json, created_at, updated_at
            ) VALUES (?, 'Release workflow', 0, '{}',
                      '2026-08-05T01:00:00Z', '2026-08-05T01:00:00Z')
            """,
            (f"workflow-{project_id}",),
        )
        db.execute(
            """
            INSERT INTO workflow_versions (
                id, project_id, adapter_id, name, version, definition_json,
                content_hash, workflow_asset_id, created_at
            ) VALUES (?, ?, 'fixture', 'Release workflow', '2.0.0', ?, ?, ?,
                      '2026-08-05T01:00:00Z')
            """,
            (
                f"version-{project_id}",
                project_id,
                snapshot_json,
                f"sha256:{project_id}",
                f"workflow-{project_id}",
            ),
        )

    runs = (
        ("run-a1", "project-a", "Alpha release", "C:/Work/Alpha-1", "IN_PROGRESS", "2026-08-05T03:00:00Z"),
        ("run-a2", "project-a", "Beta release", "C:/Work/Beta", "CREATED", "2026-08-05T02:00:00Z"),
        ("run-a3", "project-a", "Alpha recovery", "C:/Work/Alpha-3", "BLOCKED", "2026-08-05T03:00:00Z"),
        ("run-b1", "project-b", "Other project", "C:/Work/Other", "CREATED", "2026-08-05T04:00:00Z"),
    )
    for run_id, project_id, title, workspace, status, updated_at in runs:
        version_id = f"version-{project_id}"
        db.execute(
            """
            INSERT INTO runs (
                id, project_id, workflow_version_id, workflow_snapshot_json,
                title, context_json, execution_workspace, workspace_mode,
                status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'write', ?,
                      '2026-08-05T01:00:00Z', ?)
            """,
            (
                run_id,
                project_id,
                version_id,
                snapshot_json,
                title,
                json.dumps({"taskGoal": f"Goal for {run_id}"}),
                workspace,
                status,
                updated_at,
            ),
        )
        db.execute(
            """
            INSERT INTO run_workspace_leases (
                id, project_id, run_id, workspace_path, mode, status,
                acquired_at, last_verified_at
            ) VALUES (?, ?, ?, ?, 'write', 'active',
                      '2026-08-05T01:00:00Z', '2026-08-05T01:00:00Z')
            """,
            (f"lease-{run_id}", project_id, run_id, workspace),
        )

    projections = {
        "run-a1": ("IN_PROGRESS", ["build"], {"build": "RUNNING", "review": "PENDING", "deploy": "PENDING"}, []),
        "run-a2": ("CREATED", ["build"], {"build": "READY", "review": "PENDING", "deploy": "PENDING"}, []),
        "run-a3": (
            "BLOCKED",
            ["review"],
            {"build": "PASSED", "review": "BLOCKED", "deploy": "PENDING"},
            [{"code": "APPROVAL_REJECTED", "message": "Review rejected", "nodeId": "review"}],
        ),
        "run-b1": ("CREATED", ["build"], {"build": "READY", "review": "PENDING", "deploy": "PENDING"}, []),
    }
    for run_id, (status, current_nodes, node_states, blockers) in projections.items():
        updated_at = next(row[5] for row in runs if row[0] == run_id)
        db.execute(
            """
            INSERT INTO run_projections (
                run_id, status, current_node_ids_json, node_states_json,
                allowed_actions_json, blocking_reasons_json, revision, updated_at
            ) VALUES (?, ?, ?, ?, '[]', ?, ?, ?)
            """,
            (
                run_id,
                status,
                json.dumps(current_nodes),
                json.dumps(node_states),
                json.dumps(blockers),
                f"revision-{run_id}",
                updated_at,
            ),
        )

    for job_id, status in (("agent-active", "RUNNING"), ("agent-done", "COMPLETED")):
        db.execute(
            """
            INSERT INTO agent_jobs (
                id, project_id, run_id, node_id, purpose, provider, status, command_json, cwd,
                created_at, updated_at
            ) VALUES (?, 'project-a', 'run-a3', 'review', 'workflow-node', 'fake', ?, '[]', 'C:/Work/Alpha-3',
                      '2026-08-05T02:00:00Z', '2026-08-05T02:00:00Z')
            """,
            (job_id, status),
        )
    for deployment_id, status in (("deployment-active", "RUNNING"), ("deployment-done", "COMPLETED")):
        db.execute(
            """
            INSERT INTO deployments (
                id, run_id, node_id, command_json, cwd, status, created_at, updated_at
            ) VALUES (?, 'run-a3', 'deploy', '[]', 'C:/Work/Alpha-3', ?,
                      '2026-08-05T02:00:00Z', '2026-08-05T02:00:00Z')
            """,
            (deployment_id, status),
        )
    db.commit()
    return workflow


def test_scoped_run_repository_uses_snapshot_and_hides_cross_project_run() -> None:
    db = connect(fresh_db_path("scoped_run"))
    workflow = insert_scoped_run_repository_fixture(db)
    repository = RunRepository(db)

    repository.save(
        id="run-a4",
        project_id="project-a",
        workflow_version_id="version-project-a",
        workflow_snapshot=workflow,
        title="Explicit snapshot",
        status="CREATED",
        context={"taskGoal": "Use immutable inputs"},
        execution_workspace="C:/Work/Explicit",
        workspace_mode="read",
        now="2026-08-05T05:00:00Z",
    )

    assert repository.get("project-a", "run-b1") is None
    assert repository.get("project-a", "run-a1")["executionWorkspace"] == "C:/Work/Alpha-1"
    assert repository.get("project-a", "run-a4")["workspaceMode"] == "read"
    assert repository.get("project-a", "run-a4")["workflowSnapshot"]["name"] == "Release workflow"

    changed_workflow = workflow.model_copy(update={"name": "Mutable name changed"})
    db.execute(
        "UPDATE workflow_versions SET definition_json = ? WHERE id = 'version-project-a'",
        (json.dumps(changed_workflow.model_dump(by_alias=True)),),
    )

    assert repository.workflow_for_run("project-a", "run-a1").name == "Release workflow"
    with pytest.raises(KeyError, match="Run not found"):
        repository.workflow_for_run("project-a", "run-b1")


def test_run_summary_filters_orders_pages_and_aggregates_in_one_query() -> None:
    db = connect(fresh_db_path("run_summary"))
    insert_scoped_run_repository_fixture(db)
    repository = RunRepository(db)
    statements: list[str] = []
    db.set_trace_callback(statements.append)

    first_page = repository.list_summaries(
        "project-a",
        statuses=[],
        workflow_version_id=None,
        workspace_path=None,
        query=None,
        cursor=None,
        limit=2,
    )

    assert [item["id"] for item in first_page["items"]] == ["run-a3", "run-a1"]
    assert first_page["nextCursor"] is not None
    assert sum("WITH run_summaries" in statement for statement in statements) == 1

    blocked = first_page["items"][0]
    assert blocked["currentNodes"] == [
        {"id": "review", "name": "Review", "kind": "approval", "state": "BLOCKED"}
    ]
    assert blocked["nextNodes"] == [
        {"id": "deploy", "name": "Deploy", "kind": "deploy", "condition": None}
    ]
    assert blocked["progress"] == {
        "total": 3,
        "passed": 1,
        "running": 0,
        "blocked": 1,
        "pending": 1,
    }
    assert blocked["blocker"] == {
        "code": "APPROVAL_REJECTED",
        "message": "Review rejected",
        "nodeId": "review",
    }
    assert blocked["workspace"] == {
        "path": "C:/Work/Alpha-3",
        "label": "Alpha-3",
        "leaseMode": "write",
        "leaseStatus": "active",
    }
    assert blocked["activeAgentCount"] == 1
    assert blocked["activeDeploymentCount"] == 1

    second_page = repository.list_summaries(
        "project-a",
        statuses=[],
        workflow_version_id=None,
        workspace_path=None,
        query=None,
        cursor=first_page["nextCursor"],
        limit=2,
    )
    assert [item["id"] for item in second_page["items"]] == ["run-a2"]
    assert second_page["nextCursor"] is None

    filtered = repository.list_summaries(
        "project-a",
        statuses=["BLOCKED", "CREATED"],
        workflow_version_id="version-project-a",
        workspace_path=None,
        query="release",
        cursor=None,
        limit=10,
    )
    assert [item["id"] for item in filtered["items"]] == ["run-a2"]
    workspace_filtered = repository.list_summaries(
        "project-a",
        statuses=[],
        workflow_version_id=None,
        workspace_path="C:/Work/Alpha-3",
        query="ALPHA",
        cursor=None,
        limit=10,
    )
    assert [item["id"] for item in workspace_filtered["items"]] == ["run-a3"]

    with pytest.raises(ValueError, match="^INVALID_REQUEST: invalid cursor$"):
        repository.list_summaries(
            "project-a",
            statuses=[],
            workflow_version_id=None,
            workspace_path=None,
            query=None,
            cursor="not-a-cursor",
            limit=2,
        )

    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """
            INSERT INTO run_events (
                id,
                run_id,
                sequence,
                type,
                actor_json,
                payload_json,
                revision,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "event-1",
                "missing-run",
                1,
                "RUN_CREATED",
                "{}",
                "{}",
                "rev-1",
                "2026-07-27T13:00:00Z",
            ),
        )

    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """
            INSERT INTO run_projections (
                run_id,
                status,
                current_node_ids_json,
                node_states_json,
                allowed_actions_json,
                blocking_reasons_json,
                revision,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "missing-run",
                "CREATED",
                "[]",
                "{}",
                "[]",
                "[]",
                "rev-1",
                "2026-07-27T13:00:00Z",
            ),
        )


def test_workflow_version_repository_round_trips_definition_json_aliases() -> None:
    db = connect(fresh_db_path("workflow_versions"))
    migrate(db)
    insert_project(db)
    insert_workflow_asset(db)
    repository = WorkflowVersionRepository(db)
    definition = workflow_definition()

    repository.save(
        definition,
        id="workflow-version-1",
        project_id="project-1",
        content_hash="sha256:workflow-1",
        workflow_asset_id="workflow-asset-1",
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


def test_workflow_version_repository_allows_only_idempotent_duplicate_id_retry() -> None:
    db = connect(fresh_db_path("workflow_versions_duplicate"))
    migrate(db)
    insert_project(db)
    insert_workflow_asset(db)
    repository = WorkflowVersionRepository(db)
    definition = workflow_definition()

    repository.save(
        definition,
        id="workflow-version-1",
        project_id="project-1",
        content_hash="sha256:workflow-1",
        workflow_asset_id="workflow-asset-1",
        created_at="2026-07-27T13:00:00Z",
    )

    repository.save(
        definition,
        id="workflow-version-1",
        project_id="project-1",
        content_hash="sha256:workflow-1",
        workflow_asset_id="workflow-asset-1",
        created_at="2026-07-27T14:00:00Z",
    )
    updated = workflow_definition().model_copy(update={"name": "Updated workflow"})
    with pytest.raises(ValueError, match="WORKFLOW_VERSION_IMMUTABLE"):
        repository.save(
            updated,
            id="workflow-version-1",
            project_id="project-1",
            content_hash="sha256:workflow-2",
            workflow_asset_id="workflow-asset-1",
            created_at="2026-07-27T14:00:00Z",
        )
    row = db.execute(
        "SELECT name, content_hash FROM workflow_versions WHERE id = ?",
        ("workflow-version-1",),
    ).fetchone()

    assert row["name"] == definition.name
    assert row["content_hash"] == "sha256:workflow-1"


def test_agent_job_models_accept_camel_case_alias_payloads() -> None:
    job = AgentJob.model_validate(
        {
            "id": "agent-job-1",
            "runId": "run-1",
            "nodeId": "implement",
            "provider": "fake",
            "status": "QUEUED",
            "command": ["fake-agent", "run"],
            "cwd": "C:/project",
            "pid": None,
            "summary": None,
            "error": None,
            "mode": "interactive",
            "sessionId": "agent-session-1",
            "parentJobId": "agent-job-0",
            "createdAt": "2026-07-27T13:00:00Z",
            "updatedAt": "2026-07-27T13:00:00Z",
        }
    )
    event = AgentOutputEvent.model_validate(
        {
            "id": "agent-output-1",
            "jobId": "agent-job-1",
            "sequence": 1,
            "kind": "message",
            "payload": {"text": "planning"},
            "createdAt": "2026-07-27T13:00:00Z",
        }
    )

    assert job.model_dump(by_alias=True)["runId"] == "run-1"
    assert job.provider == "fake"
    assert job.model_dump(by_alias=True)["mode"] == "interactive"
    assert job.model_dump(by_alias=True)["sessionId"] == "agent-session-1"
    assert job.model_dump(by_alias=True)["parentJobId"] == "agent-job-0"
    assert event.model_dump(by_alias=True)["jobId"] == "agent-job-1"


def test_agent_session_model_accepts_camel_case_alias_payloads() -> None:
    session = AgentSession.model_validate(
        {
            "id": "agent-session-1",
            "runId": "run-1",
            "jobId": "agent-job-1",
            "provider": "codex",
            "status": "RUNNING",
            "desktopSessionId": "pty-1",
            "pid": 1234,
            "cwd": "C:/project",
            "maxOutputBytes": 1000000,
            "recoveryReason": None,
            "createdAt": "2026-07-29T13:00:00Z",
            "updatedAt": "2026-07-29T13:00:00Z",
            "endedAt": None,
        }
    )

    assert session.model_dump(by_alias=True)["desktopSessionId"] == "pty-1"
    assert session.status == "RUNNING"


def test_agent_job_repository_round_trips_job_and_output() -> None:
    db = connect(fresh_db_path("agent_job_round_trip"))
    migrate(db)
    insert_run(db)
    repository = AgentJobRepository(db)

    repository.create(
        id="agent-job-1",
        project_id="project-1",
        run_id="run-1",
        node_id="implement",
        provider="codex",
        status="QUEUED",
        command=["codex.cmd", "exec", "--json"],
        cwd="C:/project",
        created_at="2026-07-27T13:00:00Z",
    )
    repository.set_running(
        id="agent-job-1",
        pid=1234,
        updated_at="2026-07-27T13:01:00Z",
    )
    repository.append_output(
        id="agent-output-1",
        job_id="agent-job-1",
        sequence=1,
        kind="message",
        payload={"text": "planning"},
        created_at="2026-07-27T13:01:01Z",
    )
    repository.finish(
        id="agent-job-1",
        status="COMPLETED",
        summary="done",
        error=None,
        updated_at="2026-07-27T13:02:00Z",
    )

    assert repository.get("agent-job-1") == {
        "id": "agent-job-1",
        "projectId": "project-1",
        "runId": "run-1",
        "nodeId": "implement",
        "purpose": "workflow-node",
        "ownerId": None,
        "provider": "codex",
        "status": "COMPLETED",
        "mode": "automatic",
        "command": ["codex.cmd", "exec", "--json"],
        "cwd": "C:/project",
        "pid": 1234,
        "sessionId": None,
        "parentJobId": None,
        "metadata": {},
        "summary": "done",
        "error": None,
        "createdAt": "2026-07-27T13:00:00Z",
        "updatedAt": "2026-07-27T13:02:00Z",
    }
    assert repository.list_output("agent-job-1", after_sequence=0) == [
        {
            "id": "agent-output-1",
            "jobId": "agent-job-1",
            "sequence": 1,
            "kind": "message",
            "payload": {"text": "planning"},
            "createdAt": "2026-07-27T13:01:01Z",
        }
    ]


def test_agent_job_repository_lists_run_jobs_in_creation_order() -> None:
    db = connect(fresh_db_path("agent_job_list_for_run"))
    migrate(db)
    insert_run(db)
    repository = AgentJobRepository(db)

    repository.create(
        id="agent-job-2",
        project_id="project-1",
        run_id="run-1",
        node_id="test",
        provider="claude",
        status="QUEUED",
        command=["claude.cmd", "-p", "test"],
        cwd="C:/project",
        created_at="2026-07-27T13:02:00Z",
    )
    repository.create(
        id="agent-job-1",
        project_id="project-1",
        run_id="run-1",
        node_id="implement",
        provider="fake",
        status="QUEUED",
        command=["fake-agent", "run"],
        cwd="C:/project",
        created_at="2026-07-27T13:01:00Z",
    )

    assert [job["id"] for job in repository.list_for_run("run-1")] == [
        "agent-job-1",
        "agent-job-2",
    ]


def test_agent_job_repository_lists_output_after_sequence_cursor() -> None:
    db = connect(fresh_db_path("agent_output_cursor"))
    migrate(db)
    insert_run(db)
    repository = AgentJobRepository(db)
    repository.create(
        id="agent-job-1",
        project_id="project-1",
        run_id="run-1",
        node_id="implement",
        provider="fake",
        status="RUNNING",
        command=["fake-agent", "run"],
        cwd="C:/project",
        created_at="2026-07-27T13:00:00Z",
    )

    for sequence in (1, 2, 3):
        repository.append_output(
            id=f"agent-output-{sequence}",
            job_id="agent-job-1",
            sequence=sequence,
            kind="message",
            payload={"sequence": sequence},
            created_at=f"2026-07-27T13:00:0{sequence}Z",
        )

    sequences = [
        event["sequence"]
        for event in repository.list_output("agent-job-1", after_sequence=1)
    ]
    assert sequences == [
        2,
        3,
    ]


def test_terminal_session_repository_persists_run_bound_session_metadata() -> None:
    db = connect(fresh_db_path("terminal_session_repository"))
    migrate(db)
    insert_run(db)
    repository = TerminalSessionRepository(db)

    repository.save(
        id="terminal-1",
        project_id="project-1",
        run_id="run-1",
        node_id="implement",
        kind="codex",
        status="running",
        cwd="C:/project",
        pid=1234,
        created_at="2026-07-28T01:00:00Z",
        updated_at="2026-07-28T01:01:00Z",
    )

    assert repository.list_for_run("run-1") == [
        {
            "id": "terminal-1",
            "projectId": "project-1",
            "runId": "run-1",
            "nodeId": "implement",
            "kind": "codex",
            "status": "running",
            "cwd": "C:/project",
            "pid": 1234,
            "createdAt": "2026-07-28T01:00:00Z",
            "updatedAt": "2026-07-28T01:01:00Z",
        }
    ]


def test_terminal_session_repository_persists_scrollback_with_sequence_cursor() -> None:
    db = connect(fresh_db_path("terminal_scrollback_repository"))
    migrate(db)
    insert_run(db)
    repository = TerminalSessionRepository(db)
    repository.save(
        id="terminal-1",
        project_id="project-1",
        run_id="run-1",
        node_id="implement",
        kind="shell",
        status="running",
        cwd="C:/project",
        pid=1234,
        created_at="2026-07-28T01:00:00Z",
        updated_at="2026-07-28T01:00:00Z",
    )

    repository.append_output(
        id="terminal-output-1",
        session_id="terminal-1",
        sequence=1,
        stream="stdout",
        data="正在执行\n",
        created_at="2026-07-28T01:00:01Z",
    )
    repository.append_output(
        id="terminal-output-2",
        session_id="terminal-1",
        sequence=2,
        stream="stderr",
        data="warning\n",
        created_at="2026-07-28T01:00:02Z",
    )

    assert repository.list_output("terminal-1", after_sequence=1) == [
        {
            "id": "terminal-output-2",
            "sessionId": "terminal-1",
            "sequence": 2,
            "stream": "stderr",
            "data": "warning\n",
            "createdAt": "2026-07-28T01:00:02Z",
        }
    ]
