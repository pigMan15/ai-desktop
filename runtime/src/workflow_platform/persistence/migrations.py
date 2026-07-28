import sqlite3


def migrate(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            root_path TEXT NOT NULL,
            active_protocol TEXT,
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

        CREATE INDEX IF NOT EXISTS idx_agent_jobs_run_id
            ON agent_jobs(run_id);

        CREATE INDEX IF NOT EXISTS idx_agent_output_events_job_sequence
            ON agent_output_events(job_id, sequence);
        """
    )
    db.commit()
