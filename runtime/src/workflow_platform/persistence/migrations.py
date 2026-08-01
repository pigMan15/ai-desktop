import sqlite3


def migrate(db: sqlite3.Connection) -> None:
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
            created_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS runs (
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
