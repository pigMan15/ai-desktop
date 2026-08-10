import json
from pathlib import Path
import sqlite3

import pytest

from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.persistence.repositories import AgentJobRepository, ProjectRepository, RunRepository
from workflow_platform.persistence.knowledge_repositories import (
    KnowledgeApprovalRepository,
    KnowledgeChangeSetArtifactRepository,
    KnowledgeChangeSetRepository,
    KnowledgeFileChangeRepository,
    KnowledgeGitOperationRepository,
    KnowledgeIdempotencyRepository,
    KnowledgeRepositoryRepository,
    KnowledgeRuleSnapshotRepository,
    KnowledgeValidationRepository,
)

KNOWLEDGE_TABLES = {
    "knowledge_repositories",
    "knowledge_rule_snapshots",
    "knowledge_rule_files",
    "knowledge_change_sets",
    "knowledge_change_set_artifacts",
    "knowledge_file_changes",
    "knowledge_change_set_validations",
    "knowledge_change_set_approvals",
    "knowledge_git_operations",
    "knowledge_idempotency_keys",
}


def _insert_run(db, now="2026-08-10T00:00:00Z"):
    if db.execute("SELECT 1 FROM runs WHERE id = 'run-1'").fetchone() is not None:
        return
    ProjectRepository(db).save(
        id="project-1", name="p", root_path=Path("C:/p"), active_protocol=None, now=now
    )
    db.execute(
        "INSERT INTO workflow_assets (id, name, is_builtin, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
        ("workflow-asset-1", "wf", now, now),
    )
    db.execute(
        """
        INSERT INTO workflow_versions (
            id, project_id, adapter_id, name, version, definition_json,
            content_hash, workflow_asset_id, created_at
        )
        VALUES (?, ?, 'fixture', 'wf', '1', '{}', 'hash', 'workflow-asset-1', ?)
        """,
        ("workflow-version-1", "project-1", now),
    )
    RunRepository(db).save(
        id="run-1",
        project_id="project-1",
        workflow_version_id="workflow-version-1",
        workflow_snapshot={},
        title="run",
        status="IN_PROGRESS",
        context={},
        now=now,
        execution_workspace="C:/p",
        workspace_mode="write",
    )
    db.commit()


@pytest.fixture
def db(tmp_path):
    connection = connect(tmp_path / "runtime.db")
    migrate(connection)
    yield connection
    connection.close()


def _table_names(db):
    rows = db.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).fetchall()
    return {row["name"] for row in rows}


def _agent_job_columns(db):
    return {
        row["name"]
        for row in db.execute("PRAGMA table_info(agent_jobs)").fetchall()
    }


def test_migrate_creates_knowledge_tables(db):
    tables = _table_names(db)
    assert KNOWLEDGE_TABLES <= tables
    columns = _agent_job_columns(db)
    assert {
        "purpose",
        "owner_id",
        "project_id",
        "metadata_json",
    } <= columns


def test_agent_jobs_upgrade_preserves_existing_rows(db):
    now = "2026-08-10T00:00:00Z"
    _insert_run(db)
    jobs = AgentJobRepository(db)
    jobs.create(
        id="job-1",
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        provider="codex",
        status="COMPLETED",
        command=["codex", "exec"],
        cwd="C:/p",
        created_at=now,
    )
    # Simulate the pre-knowledge schema by dropping and recreating agent_jobs.
    db.commit()
    db.execute("PRAGMA foreign_keys = OFF")
    db.executescript(
        """
        DROP TABLE agent_jobs;
        CREATE TABLE agent_jobs (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            command_json TEXT NOT NULL,
            cwd TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'automatic',
            session_id TEXT,
            parent_job_id TEXT,
            pid INTEGER,
            summary TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        );
        """
    )
    db.execute(
        """
        INSERT INTO agent_jobs (
            id, run_id, node_id, provider, status, command_json, cwd, mode,
            pid, summary, error, created_at, updated_at
        )
        VALUES ('job-1', 'run-1', 'node-1', 'codex', 'COMPLETED',
                '["codex", "exec"]', 'C:/p', 'automatic', NULL, NULL, NULL, ?, ?)
        """,
        (now, now),
    )
    db.commit()
    db.execute("PRAGMA foreign_keys = ON")

    migrate(db)

    assert "purpose" in _agent_job_columns(db)
    job = AgentJobRepository(db).get("job-1")
    assert job is not None
    assert job["purpose"] == "workflow-node"
    assert job["projectId"] == "project-1"
    assert job["runId"] == "run-1"
    assert job["nodeId"] == "node-1"
    assert job["status"] == "COMPLETED"
    assert job["metadata"] == {}


def test_agent_jobs_upgrade_restores_backup_on_failure(db):
    now = "2026-08-10T00:00:00Z"
    _insert_run(db)
    db.commit()
    db.execute("PRAGMA foreign_keys = OFF")
    db.executescript(
        """
        DROP TABLE agent_jobs;
        CREATE TABLE agent_jobs (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            command_json TEXT NOT NULL,
            cwd TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'automatic',
            session_id TEXT,
            parent_job_id TEXT,
            pid INTEGER,
            summary TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
        );
        """
    )
    # Insert one valid job and one orphan job whose run does not exist.
    db.execute(
        """
        INSERT INTO agent_jobs (
            id, run_id, node_id, provider, status, command_json, cwd, mode,
            pid, summary, error, created_at, updated_at
        )
        VALUES ('job-1', 'run-1', 'node-1', 'codex', 'COMPLETED',
                '["codex", "exec"]', 'C:/p', 'automatic', NULL, NULL, NULL, ?, ?),
               ('job-orphan', 'run-missing', 'node-1', 'codex', 'RUNNING',
                '["codex", "exec"]', 'C:/p', 'automatic', NULL, NULL, NULL, ?, ?)
        """,
        (now, now, now, now),
    )
    db.commit()
    db.execute("PRAGMA foreign_keys = ON")

    with pytest.raises(sqlite3.IntegrityError):
        migrate(db)

    # Original table restored (no purpose column), rows intact.
    assert "purpose" not in _agent_job_columns(db)
    rows = db.execute("SELECT id FROM agent_jobs ORDER BY id").fetchall()
    assert [r["id"] for r in rows] == ["job-1", "job-orphan"]
    audit = db.execute(
        "SELECT action FROM audit_records WHERE action = 'knowledge.migration.agent_jobs_restored'"
    ).fetchone()
    assert audit is not None


def test_knowledge_tables_survive_legacy_run_rebuild(db):
    now = "2026-08-10T00:00:00Z"
    repos = KnowledgeRepositoryRepository(db)
    repos.create(
        id="repo-1",
        name="kb",
        root_path="C:/kb",
        canonical_root_path="C:/kb",
        repository_identity="identity",
        current_branch="main",
        head_commit="abc",
        auto_apply_low_risk=False,
        status="ACTIVE",
        revision="1",
        created_at=now,
        updated_at=now,
    )
    # Force legacy run schema so the next migrate clears run state only.
    db.execute("ALTER TABLE runs DROP COLUMN workflow_snapshot_json")
    db.commit()

    migrate(db)

    assert repos.get("repo-1") is not None
    tables = _table_names(db)
    assert KNOWLEDGE_TABLES <= tables


def _create_repository(db, id="repo-1", canonical="C:/kb", now="2026-08-10T00:00:00Z"):
    if KnowledgeRepositoryRepository(db).get_by_canonical_root(canonical) is not None:
        return
    KnowledgeRepositoryRepository(db).create(
        id=id,
        name="kb",
        root_path=canonical,
        canonical_root_path=canonical,
        repository_identity="identity-" + id,
        current_branch="main",
        head_commit="abc",
        auto_apply_low_risk=False,
        status="RULES_PENDING",
        revision="1",
        created_at=now,
        updated_at=now,
    )
    return id


def test_knowledge_repository_repository_crud(db):
    repo = KnowledgeRepositoryRepository(db)
    _create_repository(db)
    record = repo.get("repo-1")
    assert record is not None
    assert record["canonicalRootPath"] == "C:/kb"
    assert record["status"] == "RULES_PENDING"
    assert record["autoApplyLowRisk"] is False

    repo.update_revision("repo-1", revision="2", updated_at="2026-08-10T00:01:00Z")
    assert repo.get("repo-1")["revision"] == "2"

    repo.set_status("repo-1", status="ACTIVE", updated_at="2026-08-10T00:01:00Z")
    repo.set_active_snapshot("repo-1", snapshot_id="snap-1", updated_at="2026-08-10T00:01:00Z")
    record = repo.get("repo-1")
    assert record["status"] == "ACTIVE"
    assert record["activeRuleSnapshotId"] == "snap-1"

    repo.update_settings("repo-1", auto_apply_low_risk=True, updated_at="2026-08-10T00:02:00Z")
    assert repo.get("repo-1")["autoApplyLowRisk"] is True

    repo.mark_removed("repo-1", removed_at="2026-08-10T00:03:00Z", updated_at="2026-08-10T00:03:00Z")
    assert repo.get("repo-1")["status"] == "REMOVED"
    assert [r["id"] for r in repo.list()] == []

    repo.restore_removed("repo-1", status="RULES_PENDING", revision="3", updated_at="2026-08-10T00:04:00Z")
    assert repo.get("repo-1")["status"] == "RULES_PENDING"
    assert repo.get("repo-1")["revision"] == "3"


def test_knowledge_repository_duplicate_canonical_rejected(db):
    _create_repository(db)
    with pytest.raises(sqlite3.IntegrityError):
        KnowledgeRepositoryRepository(db).create(
            id="repo-2",
            name="kb",
            root_path="C:/kb",
            canonical_root_path="C:/kb",
            repository_identity="identity-repo-2",
            current_branch="main",
            head_commit="abc",
            auto_apply_low_risk=False,
            status="RULES_PENDING",
            revision="1",
            created_at="2026-08-10T00:00:00Z",
            updated_at="2026-08-10T00:00:00Z",
        )


def test_rule_snapshot_with_files(db):
    _create_repository(db)
    snapshots = KnowledgeRuleSnapshotRepository(db)
    snapshots.create(
        id="snap-1",
        repository_id="repo-1",
        head_commit="abc",
        writable_paths=["main/**", "candidate/**"],
        protected_paths=[".git/**"],
        index_files=["INDEX.md"],
        routing_files=["ROUTING.md"],
        template_files=["template/application.md"],
        validation_commands=[],
        summary="rules",
        open_questions=[],
        source="manifest",
        content_hash="hash-1",
        revision="1",
        created_at="2026-08-10T00:00:00Z",
        updated_at="2026-08-10T00:00:00Z",
    )
    snapshots.create_rule_files(
        "snap-1",
        [
            {
                "id": "rule-file-1",
                "relativePath": "INDEX.md",
                "category": "INDEX",
                "contentHash": "abc",
                "sizeBytes": 10,
                "purpose": "index",
            }
        ],
    )
    snapshot = snapshots.get("snap-1")
    assert snapshot["source"] == "manifest"
    assert snapshot["status"] == "PROPOSED"
    assert snapshot["writablePaths"] == ["main/**", "candidate/**"]
    assert snapshot["discoveredFiles"] == [
        {
            "path": "INDEX.md",
            "category": "INDEX",
            "hash": "abc",
            "sizeBytes": 10,
            "purpose": "index",
        }
    ]

    snapshots.mark_confirmed(
        "snap-1",
        confirmed_by={"id": "user-1", "type": "human", "source": "renderer", "trusted": True},
        confirmed_at="2026-08-10T00:01:00Z",
        status="CONFIRMED",
        updated_at="2026-08-10T00:01:00Z",
    )
    assert snapshots.get("snap-1")["status"] == "CONFIRMED"


def _create_change_set(db, id="cs-1", run_id="run-1", now="2026-08-10T00:00:00Z"):
    _insert_run(db, now=now)
    _create_repository(db, now=now)
    snapshots = KnowledgeRuleSnapshotRepository(db)
    if snapshots.get("snap-1") is None:
        snapshots.create(
            id="snap-1",
            repository_id="repo-1",
            head_commit="abc",
            writable_paths=["candidate/**"],
            protected_paths=[".git/**"],
            index_files=["INDEX.md"],
            routing_files=[],
            template_files=[],
            validation_commands=[],
            summary="rules",
            open_questions=[],
            source="manifest",
            content_hash="hash-1",
            revision="1",
            created_at=now,
            updated_at=now,
        )
    KnowledgeChangeSetRepository(db).create(
        id=id,
        project_id="project-1",
        run_id=run_id,
        repository_id="repo-1",
        rule_snapshot_id="snap-1",
        provider="fake",
        mode="preview",
        base_head_commit="abc",
        base_worktree_fingerprint="fingerprint",
        status="DRAFT",
        revision="1",
        created_at=now,
        updated_at=now,
    )
    return id


def test_change_set_crud_and_run_scope(db):
    change_sets = KnowledgeChangeSetRepository(db)
    _create_change_set(db)

    record = change_sets.get("cs-1")
    assert record["status"] == "DRAFT"
    assert record["runId"] == "run-1"
    assert change_sets.get_for_run("run-1", "cs-1") is not None
    assert change_sets.get_for_run("run-2", "cs-1") is None

    now = "2026-08-10T00:01:00Z"
    change_sets.update_status("cs-1", status="GENERATING", updated_at=now)
    change_sets.set_agent_job("cs-1", agent_job_id="job-1", updated_at=now)
    change_sets.set_risk("cs-1", risk_level="LOW", risk_reasons=["create"], updated_at=now)
    change_sets.set_applied("cs-1", applied_at=now, updated_at=now)
    change_sets.set_committed("cs-1", committed_hash="deadbeef", updated_at=now)

    record = change_sets.get("cs-1")
    assert record["status"] == "GENERATING"
    assert record["agentJobId"] == "job-1"
    assert record["riskLevel"] == "LOW"
    assert record["appliedAt"] == now
    assert record["committedHash"] == "deadbeef"


def test_change_set_list_ordering_and_pagination(db):
    change_sets = KnowledgeChangeSetRepository(db)
    _create_change_set(db, id="cs-1", now="2026-08-10T00:00:00Z")
    _create_change_set(db, id="cs-2", now="2026-08-10T00:01:00Z")
    items = change_sets.list_for_run("run-1", limit=20)
    assert [item["id"] for item in items] == ["cs-2", "cs-1"]
    items = change_sets.list_for_run("run-1", limit=1)
    assert len(items) == 2  # limit + 1 so caller can compute next cursor
    assert items[0]["id"] == "cs-2"


def test_cascade_deletes(db):
    _create_change_set(db)
    change_sets = KnowledgeChangeSetRepository(db)
    file_changes = KnowledgeFileChangeRepository(db)
    validations = KnowledgeValidationRepository(db)
    approvals = KnowledgeApprovalRepository(db)
    artifacts = KnowledgeChangeSetArtifactRepository(db)

    file_changes.create(
        id="fc-1",
        change_set_id="cs-1",
        relative_path="candidate/new.md",
        operation="CREATE",
        category="KNOWLEDGE",
        reason="new knowledge",
        source_artifact_ids=["artifact-1"],
        before_hash=None,
        proposed_content_uri="file:///tmp/proposal.json",
        proposed_hash="hash",
        warnings=[],
    )
    validations.create(
        id="val-1",
        change_set_id="cs-1",
        validator_id="builtin",
        validator_type="builtin",
        status="PASSED",
        summary="ok",
        evidence_uri=None,
        evidence_hash=None,
        created_at="2026-08-10T00:00:00Z",
    )
    approvals.create(
        id="appr-1",
        change_set_id="cs-1",
        decision="approved",
        actor={"id": "user-1", "type": "human", "source": "renderer", "trusted": True},
        comment="ok",
        artifact_hashes=["h1"],
        rule_snapshot_hash="rh",
        target_hashes=["th"],
        base_head_commit="abc",
        unified_diff_hash="diff",
        created_at="2026-08-10T00:00:00Z",
    )
    artifacts.create_many(
        "cs-1",
        [
            {
                "artifactId": "artifact-1",
                "runId": "run-1",
                "nodeId": "node-1",
                "workflowVersionId": "wv-1",
                "type": "markdown",
                "uri": "file:///C:/p/out.md",
                "contentHash": "h1",
            }
        ],
    )
    change_sets.delete_file_changes("cs-1")
    change_sets.delete_validations("cs-1")
    assert file_changes.list_for_change_set("cs-1") == []
    assert validations.list_for_change_set("cs-1") == []


def test_idempotency_claim_replay_and_conflict(db):
    repo = KnowledgeIdempotencyRepository(db)
    now = "2026-08-10T00:00:00Z"
    scope = "knowledge-repositories"
    key = "key-1"

    first = repo.claim(scope_key=scope, idempotency_key=key, request_hash="hash-1", now=now)
    assert first["outcome"] == "created"

    repo.store_response(
        scope_key=scope, idempotency_key=key, response={"id": "repo-1"}, status_code=201
    )
    replay = repo.claim(scope_key=scope, idempotency_key=key, request_hash="hash-1", now=now)
    assert replay["outcome"] == "replayed"
    assert replay["response"] == {"id": "repo-1"}
    assert replay["statusCode"] == 201

    with pytest.raises(ValueError) as exc:
        repo.claim(scope_key=scope, idempotency_key=key, request_hash="hash-2", now=now)
    assert "IDEMPOTENCY_KEY_REUSED" in str(exc.value)


def test_agent_job_repository_purpose_queries(db):
    now = "2026-08-10T00:00:00Z"
    _insert_run(db)
    jobs = AgentJobRepository(db)
    jobs.create(
        id="job-rule-1",
        run_id=None,
        node_id=None,
        provider="fake",
        status="RUNNING",
        command=["fake", "run"],
        cwd="C:/jobs/1",
        created_at=now,
        purpose="knowledge-rule-discovery",
        owner_id="repo-1",
        metadata={"repositoryId": "repo-1"},
    )
    jobs.create(
        id="job-gen-1",
        project_id="project-1",
        run_id="run-1",
        node_id=None,
        provider="fake",
        status="QUEUED",
        command=["fake", "run"],
        cwd="C:/jobs/2",
        created_at=now,
        purpose="knowledge-change-set-generation",
        owner_id="cs-1",
        metadata={"changeSetId": "cs-1"},
    )

    owned = jobs.get_owned("job-rule-1", purpose="knowledge-rule-discovery", owner_id="repo-1")
    assert owned is not None
    assert owned["projectId"] is None
    assert owned["runId"] is None
    assert owned["metadata"] == {"repositoryId": "repo-1"}

    assert jobs.get_owned("job-rule-1", purpose="knowledge-rule-discovery", owner_id="other") is None
    assert len(jobs.list_active_by_purpose_owner(purpose="knowledge-rule-discovery", owner_id="repo-1")) == 1
    assert jobs.count_active_by_purpose("knowledge-rule-discovery") == 1
    assert jobs.count_active_by_purpose("knowledge-change-set-generation") == 1
