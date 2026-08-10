import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from uuid import uuid4


RUN_STATE_TABLES_CHILD_FIRST = (
    "deployment_output_events",
    "deployments",
    "agent_output_events",
    "agent_input_events",
    "agent_sessions",
    "agent_checkpoints",
    "agent_jobs",
    "terminal_output_events",
    "terminal_sessions",
    "gate_results",
    "approvals",
    "artifact_consumers",
    "artifacts",
    "run_projections",
    "run_events",
    "run_idempotency_keys",
    "run_workspace_leases",
    "runs",
)


def _table_exists(db: sqlite3.Connection, table_name: str) -> bool:
    return (
        db.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        is not None
    )


def _legacy_run_schema(db: sqlite3.Connection) -> bool:
    columns = {row["name"] for row in db.execute("PRAGMA table_info(runs)")}
    return bool(columns) and "workflow_snapshot_json" not in columns


def _clear_legacy_run_state(db: sqlite3.Connection) -> None:
    db.commit()
    db.execute("PRAGMA foreign_keys = OFF")
    try:
        if _table_exists(db, "audit_records"):
            db.execute("DROP TRIGGER IF EXISTS audit_records_no_delete")
            db.execute("DELETE FROM audit_records WHERE resource LIKE 'run:%'")
        for table_name in RUN_STATE_TABLES_CHILD_FIRST:
            db.execute(f'DROP TABLE IF EXISTS "{table_name}"')
        db.commit()
    except Exception:
        db.rollback()
        db.execute("PRAGMA foreign_keys = ON")
        raise


def migrate(db: sqlite3.Connection) -> None:
    rebuilding_run_state = _legacy_run_schema(db)
    if rebuilding_run_state:
        _clear_legacy_run_state(db)
    try:
        _migrate_schema(db)
        if rebuilding_run_state:
            violations = db.execute("PRAGMA foreign_key_check").fetchall()
            if violations:
                raise sqlite3.IntegrityError(
                    f"foreign key violations after run-state rebuild: {violations!r}"
                )
    finally:
        if rebuilding_run_state:
            db.execute("PRAGMA foreign_keys = ON")


def _migrate_schema(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            root_path TEXT NOT NULL,
            active_protocol TEXT,
            archived_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS workflow_versions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            adapter_id TEXT NOT NULL,
            name TEXT NOT NULL,
            version TEXT NOT NULL,
            definition_json TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            workflow_asset_id TEXT NOT NULL REFERENCES workflow_assets(id),
            created_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            workflow_version_id TEXT NOT NULL,
            workflow_snapshot_json TEXT NOT NULL DEFAULT '{}',
            title TEXT NOT NULL,
            context_json TEXT NOT NULL,
            execution_workspace TEXT NOT NULL DEFAULT '',
            workspace_mode TEXT NOT NULL DEFAULT 'write'
                CHECK (workspace_mode IN ('write', 'read')),
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions(id) ON DELETE RESTRICT
        );

        CREATE TABLE IF NOT EXISTS run_workspace_leases (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
            workspace_path TEXT NOT NULL,
            mode TEXT NOT NULL CHECK (mode IN ('write', 'read')),
            status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
            acquired_at TEXT NOT NULL,
            last_verified_at TEXT NOT NULL,
            released_at TEXT,
            release_reason TEXT
        );

        CREATE TABLE IF NOT EXISTS run_idempotency_keys (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            idempotency_key TEXT NOT NULL,
            run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
            request_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(project_id, idempotency_key)
        );

        CREATE TABLE IF NOT EXISTS run_events (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            type TEXT NOT NULL,
            node_id TEXT,
            actor_json TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            revision TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
            UNIQUE(run_id, sequence)
        );

        CREATE TABLE IF NOT EXISTS run_projections (
            run_id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            current_node_ids_json TEXT NOT NULL,
            node_states_json TEXT NOT NULL,
            allowed_actions_json TEXT NOT NULL,
            blocking_reasons_json TEXT NOT NULL,
            revision TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            type TEXT NOT NULL,
            uri TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            producer_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS approvals (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            status TEXT NOT NULL,
            requested_by_json TEXT NOT NULL,
            decided_by_json TEXT,
            comment TEXT,
            created_at TEXT NOT NULL,
            decided_at TEXT,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS gate_results (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            gate_id TEXT NOT NULL,
            status TEXT NOT NULL,
            evidence_json TEXT NOT NULL,
            actor_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS terminal_sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            node_id TEXT,
            kind TEXT NOT NULL,
            status TEXT NOT NULL,
            cwd TEXT NOT NULL,
            pid INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS terminal_output_events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            stream TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES terminal_sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, sequence)
        );

        CREATE TABLE IF NOT EXISTS agent_jobs (
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
            updated_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_output_events (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (job_id) REFERENCES agent_jobs(id) ON DELETE CASCADE,
            UNIQUE(job_id, sequence)
        );

        CREATE TABLE IF NOT EXISTS agent_checkpoints (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            job_id TEXT NOT NULL,
            parent_checkpoint_id TEXT,
            node_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            prompt TEXT NOT NULL,
            allowed_tools_json TEXT NOT NULL,
            timeout_seconds REAL NOT NULL,
            max_output_bytes INTEGER NOT NULL,
            status TEXT NOT NULL,
            recovery_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
            FOREIGN KEY (job_id) REFERENCES agent_jobs(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_checkpoint_id) REFERENCES agent_checkpoints(id)
        );

        CREATE TABLE IF NOT EXISTS deployments (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            command_json TEXT NOT NULL,
            cwd TEXT NOT NULL,
            status TEXT NOT NULL,
            pid INTEGER,
            summary TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS deployment_output_events (
            id TEXT PRIMARY KEY,
            deployment_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            data TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE,
            UNIQUE(deployment_id, sequence)
        );

        CREATE TABLE IF NOT EXISTS audit_records (
            id TEXT PRIMARY KEY,
            actor_id TEXT NOT NULL,
            actor_json TEXT NOT NULL,
            action TEXT NOT NULL,
            resource TEXT NOT NULL,
            detail_json TEXT NOT NULL,
            previous_hash TEXT,
            record_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_candidates (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            created_by_json TEXT NOT NULL,
            reviewer_json TEXT,
            review_comment TEXT,
            created_at TEXT NOT NULL,
            reviewed_at TEXT,
            published_at TEXT
        );

        CREATE TABLE IF NOT EXISTS knowledge_documents (
            id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            source TEXT NOT NULL,
            status TEXT NOT NULL,
            published_by_json TEXT NOT NULL,
            published_at TEXT NOT NULL,
            FOREIGN KEY (candidate_id) REFERENCES knowledge_candidates(id)
        );

        CREATE TABLE IF NOT EXISTS knowledge_publications (
            id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL UNIQUE,
            document_id TEXT NOT NULL UNIQUE,
            published_by_json TEXT NOT NULL,
            published_at TEXT NOT NULL,
            FOREIGN KEY (candidate_id) REFERENCES knowledge_candidates(id),
            FOREIGN KEY (document_id) REFERENCES knowledge_documents(id)
        );

        CREATE TABLE IF NOT EXISTS knowledge_git_publications (
            id TEXT PRIMARY KEY,
            document_id TEXT NOT NULL,
            branch TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            commit_hash TEXT NOT NULL,
            pushed_at TEXT NOT NULL,
            FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS knowledge_syntheses (
            id TEXT PRIMARY KEY,
            candidate_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            prompt TEXT NOT NULL,
            summary TEXT,
            error TEXT,
            feedback TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (candidate_id) REFERENCES knowledge_candidates(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS knowledge_synthesis_output_events (
            id TEXT PRIMARY KEY,
            synthesis_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (synthesis_id) REFERENCES knowledge_syntheses(id) ON DELETE CASCADE,
            UNIQUE(synthesis_id, sequence)
        );

        CREATE INDEX IF NOT EXISTS idx_agent_jobs_run_id
            ON agent_jobs(run_id);

        CREATE INDEX IF NOT EXISTS runs_project_updated_idx
            ON runs(project_id, updated_at DESC);

        CREATE INDEX IF NOT EXISTS runs_project_status_updated_idx
            ON runs(project_id, status, updated_at DESC);

        CREATE INDEX IF NOT EXISTS runs_project_workflow_updated_idx
            ON runs(project_id, workflow_version_id, updated_at DESC);

        CREATE UNIQUE INDEX IF NOT EXISTS run_workspace_active_write_unique
            ON run_workspace_leases(project_id, workspace_path)
            WHERE mode = 'write' AND status = 'active';

        CREATE INDEX IF NOT EXISTS run_workspace_lease_project_status_idx
            ON run_workspace_leases(project_id, status, workspace_path);

        CREATE INDEX IF NOT EXISTS idx_terminal_output_events_session_sequence
            ON terminal_output_events(session_id, sequence);

        CREATE INDEX IF NOT EXISTS idx_agent_output_events_job_sequence
            ON agent_output_events(job_id, sequence);

        CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_run_status
            ON agent_checkpoints(run_id, status, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_deployments_run_id
            ON deployments(run_id, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_deployment_output_events_deployment_sequence
            ON deployment_output_events(deployment_id, sequence);

        CREATE INDEX IF NOT EXISTS idx_audit_records_actor_created
            ON audit_records(actor_id, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_audit_records_action_created
            ON audit_records(action, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_audit_records_resource_created
            ON audit_records(resource, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_knowledge_candidates_status_created
            ON knowledge_candidates(status, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_knowledge_documents_published
            ON knowledge_documents(published_at, id);

        CREATE INDEX IF NOT EXISTS idx_knowledge_git_publications_document_pushed
            ON knowledge_git_publications(document_id, pushed_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_knowledge_syntheses_candidate_updated
            ON knowledge_syntheses(candidate_id, updated_at DESC, id DESC);

        CREATE INDEX IF NOT EXISTS idx_knowledge_synthesis_output_sequence
            ON knowledge_synthesis_output_events(synthesis_id, sequence);

        CREATE TRIGGER IF NOT EXISTS audit_records_no_update
        BEFORE UPDATE ON audit_records
        BEGIN
            SELECT RAISE(ABORT, '审计记录禁止修改');
        END;

        CREATE TRIGGER IF NOT EXISTS audit_records_no_delete
        BEFORE DELETE ON audit_records
        BEGIN
            SELECT RAISE(ABORT, '审计记录禁止删除');
        END;
        """
    )
    project_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(projects)").fetchall()
    }
    if "archived_at" not in project_columns:
        db.execute("ALTER TABLE projects ADD COLUMN archived_at TEXT")
    if "max_active_runs" not in project_columns:
        db.execute("ALTER TABLE projects ADD COLUMN max_active_runs INTEGER NOT NULL DEFAULT 3")
    if "max_active_agents" not in project_columns:
        db.execute("ALTER TABLE projects ADD COLUMN max_active_agents INTEGER NOT NULL DEFAULT 2")

    workflow_version_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(workflow_versions)").fetchall()
    }
    if "workflow_asset_id" not in workflow_version_columns:
        db.execute("ALTER TABLE workflow_versions ADD COLUMN workflow_asset_id TEXT")

    artifact_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(artifacts)").fetchall()
    }
    artifact_column_definitions = {
        "artifact_spec_id": "TEXT",
        "workflow_version_id": "TEXT",
        "source_agent_job_id": "TEXT",
        "template_path": "TEXT",
        "relative_path": "TEXT",
        "file_size": "INTEGER",
        "media_type": "TEXT",
        "status": "TEXT NOT NULL DEFAULT 'verified'",
        "supersedes_artifact_id": "TEXT",
        "verified_at": "TEXT",
    }
    for column, definition in artifact_column_definitions.items():
        if column not in artifact_columns:
            db.execute(f"ALTER TABLE artifacts ADD COLUMN {column} {definition}")
    db.execute("UPDATE artifacts SET producer_json = '{}' WHERE producer_json IS NULL OR producer_json = ''")
    db.execute("UPDATE artifacts SET status = 'verified' WHERE status IS NULL")
    for table_name in ("approvals", "gate_results"):
        columns = {row["name"] for row in db.execute(f"PRAGMA table_info({table_name})").fetchall()}
        if "artifact_hashes_json" not in columns:
            db.execute(f"ALTER TABLE {table_name} ADD COLUMN artifact_hashes_json TEXT NOT NULL DEFAULT '[]'")
        if "invalidated_at" not in columns:
            db.execute(f"ALTER TABLE {table_name} ADD COLUMN invalidated_at TEXT")
        if "invalidation_reason" not in columns:
            db.execute(f"ALTER TABLE {table_name} ADD COLUMN invalidation_reason TEXT")
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS workflow_assets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_builtin INTEGER NOT NULL DEFAULT 0,
            archived_at TEXT,
            created_by_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            current_workflow_version_id TEXT,
            FOREIGN KEY (current_workflow_version_id) REFERENCES workflow_versions(id)
        );

        CREATE TABLE IF NOT EXISTS project_workflow_bindings (
            project_id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL,
            workflow_version_id TEXT NOT NULL,
            actor_json TEXT NOT NULL,
            bound_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (workflow_id) REFERENCES workflow_assets(id),
            FOREIGN KEY (workflow_version_id) REFERENCES workflow_versions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_workflow_assets_active_updated
            ON workflow_assets(archived_at, updated_at DESC, id);
        CREATE INDEX IF NOT EXISTS idx_project_workflow_bindings_workflow
            ON project_workflow_bindings(workflow_id, workflow_version_id);

        CREATE TABLE IF NOT EXISTS role_assets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_builtin INTEGER NOT NULL DEFAULT 0,
            archived_at TEXT,
            created_by_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            current_role_version_id TEXT
        );

        CREATE TABLE IF NOT EXISTS role_versions (
            id TEXT PRIMARY KEY,
            role_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            definition_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (role_id) REFERENCES role_assets(id) ON DELETE CASCADE,
            UNIQUE(role_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_role_assets_active_updated
            ON role_assets(archived_at, updated_at DESC, id);
        CREATE INDEX IF NOT EXISTS idx_role_versions_role_version
            ON role_versions(role_id, version DESC);

        CREATE TABLE IF NOT EXISTS artifact_consumers (
            id TEXT PRIMARY KEY,
            artifact_id TEXT NOT NULL,
            consumer_run_id TEXT NOT NULL,
            consumer_node_id TEXT NOT NULL,
            agent_job_id TEXT,
            context_created_at TEXT NOT NULL,
            FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_artifacts_run_node_spec_status
            ON artifacts(run_id, node_id, artifact_spec_id, status, created_at, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_spec_hash
            ON artifacts(run_id, node_id, artifact_spec_id, content_hash)
            WHERE artifact_spec_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_artifact_consumers_artifact
            ON artifact_consumers(artifact_id, context_created_at, id);
        """
    )

    # Existing workflow versions predate workflow assets. Give each project its
    # own asset, except the shared library project whose assets are global.
    db.execute(
        """
        INSERT OR IGNORE INTO workflow_assets (
            id, name, is_builtin, archived_at, created_by_json,
            created_at, updated_at, current_workflow_version_id
        )
        SELECT workflow_asset_id, name, 0, NULL, '{}', created_at, created_at, id
        FROM (
            SELECT
                CASE WHEN project_id = 'project-workflow-library' THEN json_extract(definition_json, '$.id')
                     ELSE 'workflow-asset:' || project_id || ':' || json_extract(definition_json, '$.id') END AS workflow_asset_id,
                name, created_at, id,
                ROW_NUMBER() OVER (
                    PARTITION BY project_id, json_extract(definition_json, '$.id')
                    ORDER BY created_at DESC, rowid DESC
                ) AS version_rank
            FROM workflow_versions
            WHERE json_extract(definition_json, '$.id') IS NOT NULL
        )
        WHERE version_rank = 1
        """
    )
    db.execute(
        """
        UPDATE workflow_versions
        SET workflow_asset_id = CASE WHEN project_id = 'project-workflow-library' THEN json_extract(definition_json, '$.id')
                                     ELSE 'workflow-asset:' || project_id || ':' || json_extract(definition_json, '$.id') END
        WHERE workflow_asset_id IS NULL
        """
    )
    db.execute(
        """
        UPDATE workflow_assets
        SET current_workflow_version_id = (
            SELECT versions.id FROM workflow_versions AS versions
            WHERE versions.workflow_asset_id = workflow_assets.id
            ORDER BY versions.created_at DESC, versions.rowid DESC LIMIT 1
        )
        WHERE EXISTS (SELECT 1 FROM workflow_versions AS versions WHERE versions.workflow_asset_id = workflow_assets.id)
        """
    )
    db.execute(
        """
        UPDATE project_workflow_bindings
        SET workflow_id = versions.workflow_asset_id
        FROM workflow_versions AS versions
        WHERE project_workflow_bindings.workflow_version_id = versions.id
          AND project_workflow_bindings.workflow_id <> versions.workflow_asset_id
        """
    )
    db.execute(
        """
        INSERT INTO project_workflow_bindings (project_id, workflow_id, workflow_version_id, actor_json, bound_at)
        SELECT project_id, workflow_asset_id, id,
               '{"id":"migration","type":"system","source":"runtime","trusted":true}', created_at
        FROM (
            SELECT versions.*, ROW_NUMBER() OVER (
                PARTITION BY project_id ORDER BY created_at DESC, rowid DESC
            ) AS project_rank
            FROM workflow_versions AS versions
            WHERE project_id <> 'project-workflow-library'
        )
        WHERE project_rank = 1
        ON CONFLICT(project_id) DO NOTHING
        """
    )
    db.executescript(
        """
        CREATE TRIGGER IF NOT EXISTS workflow_versions_asset_id_immutable
        BEFORE UPDATE OF workflow_asset_id ON workflow_versions
        WHEN OLD.workflow_asset_id IS NOT NULL
         AND NEW.workflow_asset_id IS NOT OLD.workflow_asset_id
        BEGIN
            SELECT RAISE(ABORT, 'WORKFLOW_VERSION_ASSET_IMMUTABLE');
        END;
        CREATE TRIGGER IF NOT EXISTS workflow_versions_asset_id_required_insert
        BEFORE INSERT ON workflow_versions
        WHEN NEW.workflow_asset_id IS NULL
        BEGIN
            SELECT RAISE(ABORT, 'WORKFLOW_VERSION_ASSET_REQUIRED');
        END;
        CREATE TRIGGER IF NOT EXISTS workflow_versions_asset_id_required_update
        BEFORE UPDATE OF workflow_asset_id ON workflow_versions
        WHEN NEW.workflow_asset_id IS NULL
        BEGIN
            SELECT RAISE(ABORT, 'WORKFLOW_VERSION_ASSET_REQUIRED');
        END;
        """
    )

    agent_job_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(agent_jobs)").fetchall()
    }
    if "mode" not in agent_job_columns:
        db.execute(
            "ALTER TABLE agent_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'automatic'"
        )
    if "session_id" not in agent_job_columns:
        db.execute("ALTER TABLE agent_jobs ADD COLUMN session_id TEXT")
    if "parent_job_id" not in agent_job_columns:
        db.execute("ALTER TABLE agent_jobs ADD COLUMN parent_job_id TEXT")

    _upgrade_agent_jobs_for_knowledge(db)
    _migrate_knowledge_schema(db)

    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS agent_sessions (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            job_id TEXT NOT NULL UNIQUE,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            desktop_session_id TEXT,
            pid INTEGER,
            cwd TEXT NOT NULL,
            max_output_bytes INTEGER NOT NULL DEFAULT 1000000,
            recovery_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            ended_at TEXT,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
            FOREIGN KEY (job_id) REFERENCES agent_jobs(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_input_events (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
            UNIQUE(session_id, sequence)
        );

        CREATE INDEX IF NOT EXISTS idx_agent_sessions_run_status
            ON agent_sessions(run_id, status, created_at, id);

        CREATE INDEX IF NOT EXISTS idx_agent_input_events_session_sequence
            ON agent_input_events(session_id, sequence);
        """
    )
    agent_session_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(agent_sessions)").fetchall()
    }
    if "max_output_bytes" not in agent_session_columns:
        db.execute(
            "ALTER TABLE agent_sessions ADD COLUMN max_output_bytes INTEGER NOT NULL DEFAULT 1000000"
        )
    db.commit()


def _record_migration_audit(
    db: sqlite3.Connection, action: str, detail: dict
) -> None:
    """Append an audit record directly during migration recovery.

    Uses the same record hash algorithm as AuditLog so the chain stays valid.
    """
    previous = db.execute(
        "SELECT record_hash FROM audit_records ORDER BY created_at DESC, rowid DESC LIMIT 1"
    ).fetchone()
    previous_hash = previous[0] if previous else None
    actor = {
        "id": "migration",
        "type": "system",
        "source": "runtime",
        "trusted": True,
    }
    created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    record = {
        "id": str(uuid4()),
        "actor": actor,
        "action": action,
        "resource": "knowledge:migration:agent_jobs",
        "detail": dict(detail),
        "previousHash": previous_hash,
        "createdAt": created_at,
    }
    content = json.dumps(record, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    record_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    db.execute(
        """
        INSERT INTO audit_records (
            id, actor_id, actor_json, action, resource, detail_json,
            previous_hash, record_hash, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record["id"],
            actor["id"],
            json.dumps(actor, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
            action,
            record["resource"],
            json.dumps(dict(detail), ensure_ascii=False, separators=(",", ":"), sort_keys=True),
            previous_hash,
            record_hash,
            created_at,
        ),
    )


def _upgrade_agent_jobs_for_knowledge(db: sqlite3.Connection) -> None:
    """Rebuild agent_jobs as a multi-owner job table (document section 25).

    The existing table declares run_id/node_id NOT NULL, so knowledge jobs cannot
    be expressed with ALTER TABLE. The rebuild runs inside a controlled window
    (foreign keys disabled) and restores the original table from a backup on any
    failure, leaving no intermediate agent_jobs_v2-only state.
    """
    agent_job_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(agent_jobs)").fetchall()
    }
    if "purpose" in agent_job_columns:
        return

    db.commit()
    db.execute("PRAGMA foreign_keys = OFF")
    try:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS agent_jobs_backup AS SELECT * FROM agent_jobs;
            CREATE INDEX IF NOT EXISTS idx_agent_jobs_backup_run_id
                ON agent_jobs_backup(run_id);
            """
        )
        source_count = db.execute("SELECT COUNT(*) FROM agent_jobs").fetchone()[0]
        backup_count = db.execute("SELECT COUNT(*) FROM agent_jobs_backup").fetchone()[0]
        if source_count != backup_count:
            raise sqlite3.IntegrityError("agent_jobs backup row count mismatch")

        db.executescript(
            """
            CREATE TABLE agent_jobs_v2 (
                id TEXT PRIMARY KEY,
                project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
                run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
                node_id TEXT,
                purpose TEXT NOT NULL CHECK (purpose IN (
                    'workflow-node',
                    'knowledge-rule-discovery',
                    'knowledge-change-set-generation'
                )),
                owner_id TEXT,
                provider TEXT NOT NULL,
                status TEXT NOT NULL,
                command_json TEXT NOT NULL,
                cwd TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'automatic',
                session_id TEXT,
                parent_job_id TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                pid INTEGER,
                summary TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                CHECK (
                    (purpose = 'workflow-node' AND project_id IS NOT NULL AND run_id IS NOT NULL AND node_id IS NOT NULL)
                    OR
                    (purpose = 'knowledge-rule-discovery' AND project_id IS NULL AND run_id IS NULL AND node_id IS NULL AND owner_id IS NOT NULL)
                    OR
                    (purpose = 'knowledge-change-set-generation' AND project_id IS NOT NULL AND run_id IS NOT NULL AND node_id IS NULL AND owner_id IS NOT NULL)
                )
            );
            """
        )
        db.execute(
            """
            INSERT INTO agent_jobs_v2 (
                id, project_id, run_id, node_id, purpose, owner_id, provider, status,
                command_json, cwd, mode, session_id, parent_job_id, metadata_json,
                pid, summary, error, created_at, updated_at
            )
            SELECT
                jobs.id, runs.project_id, jobs.run_id, jobs.node_id, 'workflow-node', NULL,
                jobs.provider, jobs.status, jobs.command_json, jobs.cwd, jobs.mode,
                jobs.session_id, jobs.parent_job_id, '{}', jobs.pid, jobs.summary, jobs.error,
                jobs.created_at, jobs.updated_at
            FROM agent_jobs AS jobs
            JOIN runs ON runs.id = jobs.run_id
            """
        )
        copied = db.execute("SELECT COUNT(*) FROM agent_jobs_v2").fetchone()[0]
        if copied != source_count:
            raise sqlite3.IntegrityError("agent_jobs copy row count mismatch")

        db.executescript(
            """
            DROP TABLE agent_jobs;
            ALTER TABLE agent_jobs_v2 RENAME TO agent_jobs;
            CREATE INDEX IF NOT EXISTS idx_agent_jobs_run_id
                ON agent_jobs(run_id);
            CREATE INDEX IF NOT EXISTS idx_agent_jobs_purpose_owner_updated
                ON agent_jobs(purpose, owner_id, updated_at DESC, id DESC);
            """
        )
        violations = db.execute("PRAGMA foreign_key_check").fetchall()
        if violations:
            raise sqlite3.IntegrityError(
                f"agent_jobs rebuild foreign key violations: {violations!r}"
            )
        db.commit()
        db.execute("DROP TABLE IF EXISTS agent_jobs_backup")
        db.commit()
    except Exception:
        db.rollback()
        try:
            db.executescript(
                """
                DROP TABLE IF EXISTS agent_jobs_v2;
                DROP TABLE IF EXISTS agent_jobs;
                ALTER TABLE agent_jobs_backup RENAME TO agent_jobs;
                """
            )
            try:
                _record_migration_audit(
                    db,
                    "knowledge.migration.agent_jobs_restored",
                    {"reason": "agent_jobs rebuild failed; restored backup"},
                )
            except Exception:
                pass
            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.execute("PRAGMA foreign_keys = ON")
        raise
    else:
        db.execute("PRAGMA foreign_keys = ON")


def _migrate_knowledge_schema(db: sqlite3.Connection) -> None:
    """Create knowledge repository tables and indexes (document section 25).

    Knowledge tables intentionally never join RUN_STATE_TABLES_CHILD_FIRST so a
    legacy Run schema rebuild cannot delete user bindings, snapshots or history.
    """
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS knowledge_repositories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            root_path TEXT NOT NULL,
            canonical_root_path TEXT NOT NULL UNIQUE,
            repository_identity TEXT NOT NULL,
            current_branch TEXT,
            head_commit TEXT NOT NULL,
            auto_apply_low_risk INTEGER NOT NULL DEFAULT 0 CHECK (auto_apply_low_risk IN (0, 1)),
            status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RULES_PENDING', 'BLOCKED', 'REMOVED')),
            active_rule_snapshot_id TEXT,
            revision TEXT NOT NULL DEFAULT '1',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            removed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS knowledge_rule_snapshots (
            id TEXT PRIMARY KEY,
            repository_id TEXT NOT NULL REFERENCES knowledge_repositories(id) ON DELETE CASCADE,
            head_commit TEXT NOT NULL,
            writable_paths_json TEXT NOT NULL,
            protected_paths_json TEXT NOT NULL,
            index_files_json TEXT NOT NULL,
            routing_files_json TEXT NOT NULL,
            template_files_json TEXT NOT NULL,
            validation_commands_json TEXT NOT NULL,
            summary TEXT NOT NULL,
            open_questions_json TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('manifest', 'agent-discovery', 'hybrid')),
            content_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'CONFIRMED', 'SUPERSEDED', 'STALE')),
            revision TEXT NOT NULL DEFAULT '1',
            confirmed_by_json TEXT,
            confirmed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_rule_files (
            id TEXT PRIMARY KEY,
            snapshot_id TEXT NOT NULL REFERENCES knowledge_rule_snapshots(id) ON DELETE CASCADE,
            relative_path TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('RULE', 'INDEX', 'ROUTING', 'TEMPLATE', 'REFERENCE')),
            content_hash TEXT NOT NULL,
            size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
            purpose TEXT NOT NULL,
            UNIQUE(snapshot_id, relative_path)
        );

        CREATE TABLE IF NOT EXISTS knowledge_change_sets (
            id TEXT PRIMARY KEY,
            supersedes_change_set_id TEXT REFERENCES knowledge_change_sets(id),
            project_id TEXT NOT NULL REFERENCES projects(id),
            run_id TEXT NOT NULL,
            repository_id TEXT NOT NULL REFERENCES knowledge_repositories(id),
            rule_snapshot_id TEXT NOT NULL REFERENCES knowledge_rule_snapshots(id),
            provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'fake')),
            mode TEXT NOT NULL CHECK (mode IN ('preview', 'risk-based')),
            base_head_commit TEXT NOT NULL,
            base_worktree_fingerprint TEXT NOT NULL,
            plan_json TEXT,
            unified_diff_uri TEXT,
            unified_diff_hash TEXT,
            risk_level TEXT CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'BLOCKED')),
            risk_reasons_json TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL,
            agent_job_id TEXT,
            approval_id TEXT,
            committed_hash TEXT,
            revision TEXT NOT NULL DEFAULT '1',
            applied_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_change_set_artifacts (
            change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id) ON DELETE CASCADE,
            artifact_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            workflow_version_id TEXT,
            artifact_type TEXT NOT NULL,
            uri TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            artifact_status TEXT NOT NULL CHECK (artifact_status = 'verified'),
            PRIMARY KEY(change_set_id, artifact_id)
        );

        CREATE TABLE IF NOT EXISTS knowledge_file_changes (
            id TEXT PRIMARY KEY,
            change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id) ON DELETE CASCADE,
            relative_path TEXT NOT NULL,
            operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE')),
            category TEXT NOT NULL CHECK (category IN ('KNOWLEDGE', 'INDEX', 'ROUTING', 'RULE', 'TEMPLATE')),
            reason TEXT NOT NULL,
            source_artifact_ids_json TEXT NOT NULL,
            before_hash TEXT,
            proposed_content_uri TEXT NOT NULL,
            proposed_hash TEXT NOT NULL,
            warnings_json TEXT NOT NULL DEFAULT '[]',
            UNIQUE(change_set_id, relative_path)
        );

        CREATE TABLE IF NOT EXISTS knowledge_change_set_validations (
            id TEXT PRIMARY KEY,
            change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id) ON DELETE CASCADE,
            validator_id TEXT NOT NULL,
            validator_type TEXT NOT NULL CHECK (validator_type IN ('builtin', 'repository-command')),
            status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'SKIPPED')),
            summary TEXT NOT NULL,
            evidence_uri TEXT,
            evidence_hash TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_change_set_approvals (
            id TEXT PRIMARY KEY,
            change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id) ON DELETE CASCADE,
            decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
            actor_json TEXT NOT NULL,
            comment TEXT NOT NULL,
            artifact_hashes_json TEXT NOT NULL,
            rule_snapshot_hash TEXT NOT NULL,
            target_hashes_json TEXT NOT NULL,
            base_head_commit TEXT NOT NULL,
            unified_diff_hash TEXT NOT NULL,
            invalidated_at TEXT,
            invalidation_reason TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_git_operations (
            id TEXT PRIMARY KEY,
            repository_id TEXT NOT NULL REFERENCES knowledge_repositories(id),
            change_set_id TEXT REFERENCES knowledge_change_sets(id),
            operation TEXT NOT NULL CHECK (operation IN ('stage', 'unstage', 'commit', 'external-commit-detected')),
            paths_json TEXT NOT NULL,
            commit_hash TEXT,
            actor_json TEXT NOT NULL,
            detail_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS knowledge_idempotency_keys (
            scope_key TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            response_json TEXT NOT NULL,
            status_code INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY(scope_key, idempotency_key)
        );

        CREATE INDEX IF NOT EXISTS idx_knowledge_rule_snapshots_repository_updated
            ON knowledge_rule_snapshots(repository_id, updated_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_knowledge_change_sets_repository_updated
            ON knowledge_change_sets(repository_id, updated_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_knowledge_change_sets_project_run_updated
            ON knowledge_change_sets(project_id, run_id, updated_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_knowledge_file_changes_change_set
            ON knowledge_file_changes(change_set_id, relative_path);
        CREATE INDEX IF NOT EXISTS idx_knowledge_git_operations_repository_created
            ON knowledge_git_operations(repository_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_knowledge_idempotency_created
            ON knowledge_idempotency_keys(created_at, scope_key);

        CREATE TABLE IF NOT EXISTS agent_permission_requests (
            id TEXT PRIMARY KEY,
            job_id TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
            run_id TEXT NOT NULL,
            permission_type TEXT NOT NULL,
            target TEXT NOT NULL,
            details_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('PENDING','ALLOWED','DENIED','EXPIRED')),
            decided_by_json TEXT,
            decided_at TEXT,
            decision_reason TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_permission_requests_job_status
            ON agent_permission_requests(job_id, status, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_agent_permission_requests_run_status
            ON agent_permission_requests(run_id, status, created_at, id);
        """
    )
