from __future__ import annotations

import json
import sqlite3
from typing import Any


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


class KnowledgeRepositoryRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        name: str,
        root_path: str,
        canonical_root_path: str,
        repository_identity: str,
        current_branch: str | None,
        head_commit: str,
        auto_apply_low_risk: bool,
        status: str,
        revision: str,
        created_at: str,
        updated_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO knowledge_repositories (
                id, name, root_path, canonical_root_path, repository_identity,
                current_branch, head_commit, auto_apply_low_risk, status,
                active_rule_snapshot_id, revision, created_at, updated_at, removed_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
            """,
            (
                id,
                name,
                root_path,
                canonical_root_path,
                repository_identity,
                current_branch,
                head_commit,
                1 if auto_apply_low_risk else 0,
                status,
                revision,
                created_at,
                updated_at,
            ),
        )

    def get(self, id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM knowledge_repositories WHERE id = ?", (id,)
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def get_by_canonical_root(self, canonical_root_path: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM knowledge_repositories WHERE canonical_root_path = ?",
            (canonical_root_path,),
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def list(self, *, include_removed: bool = False) -> list[dict]:
        sql = "SELECT * FROM knowledge_repositories"
        if not include_removed:
            sql += " WHERE status <> 'REMOVED'"
        sql += " ORDER BY updated_at DESC, id DESC"
        return [self._row_to_dict(row) for row in self._db.execute(sql).fetchall()]

    def update_revision(self, id: str, *, revision: str, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_repositories SET revision = ?, updated_at = ? WHERE id = ?",
            (revision, updated_at, id),
        )

    def update_head(
        self, id: str, *, head_commit: str, current_branch: str | None, updated_at: str
    ) -> None:
        self._db.execute(
            """
            UPDATE knowledge_repositories
            SET head_commit = ?, current_branch = ?, updated_at = ?
            WHERE id = ?
            """,
            (head_commit, current_branch, updated_at, id),
        )

    def set_status(self, id: str, *, status: str, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_repositories SET status = ?, updated_at = ? WHERE id = ?",
            (status, updated_at, id),
        )

    def set_active_snapshot(self, id: str, *, snapshot_id: str, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_repositories SET active_rule_snapshot_id = ?, updated_at = ? WHERE id = ?",
            (snapshot_id, updated_at, id),
        )

    def clear_active_snapshot(self, id: str, *, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_repositories SET active_rule_snapshot_id = NULL, updated_at = ? WHERE id = ?",
            (updated_at, id),
        )

    def update_settings(self, id: str, *, auto_apply_low_risk: bool, updated_at: str) -> None:
        self._db.execute(
            """
            UPDATE knowledge_repositories
            SET auto_apply_low_risk = ?, updated_at = ?
            WHERE id = ?
            """,
            (1 if auto_apply_low_risk else 0, updated_at, id),
        )

    def mark_removed(self, id: str, *, removed_at: str, updated_at: str) -> None:
        self._db.execute(
            """
            UPDATE knowledge_repositories
            SET status = 'REMOVED', removed_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (removed_at, updated_at, id),
        )

    def restore_removed(
        self, id: str, *, status: str, revision: str, updated_at: str
    ) -> None:
        self._db.execute(
            """
            UPDATE knowledge_repositories
            SET status = ?, revision = ?, removed_at = NULL, updated_at = ?
            WHERE id = ?
            """,
            (status, revision, updated_at, id),
        )

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "name": row["name"],
            "rootPath": row["root_path"],
            "canonicalRootPath": row["canonical_root_path"],
            "repositoryIdentity": row["repository_identity"],
            "currentBranch": row["current_branch"],
            "headCommit": row["head_commit"],
            "defaultWritePolicy": "risk-based",
            "autoApplyLowRisk": bool(row["auto_apply_low_risk"]),
            "status": row["status"],
            "activeRuleSnapshotId": row["active_rule_snapshot_id"],
            "revision": row["revision"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }


class KnowledgeRuleSnapshotRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        repository_id: str,
        head_commit: str,
        writable_paths: list[str],
        protected_paths: list[str],
        index_files: list[str],
        routing_files: list[str],
        template_files: list[str],
        validation_commands: list[str],
        summary: str,
        open_questions: list[str],
        source: str,
        content_hash: str,
        revision: str,
        created_at: str,
        updated_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO knowledge_rule_snapshots (
                id, repository_id, head_commit,
                writable_paths_json, protected_paths_json, index_files_json,
                routing_files_json, template_files_json, validation_commands_json,
                summary, open_questions_json, source, content_hash, status,
                revision, confirmed_by_json, confirmed_at, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, NULL, NULL, ?, ?)
            """,
            (
                id,
                repository_id,
                head_commit,
                _json_dumps(writable_paths),
                _json_dumps(protected_paths),
                _json_dumps(index_files),
                _json_dumps(routing_files),
                _json_dumps(template_files),
                _json_dumps(validation_commands),
                summary,
                _json_dumps(open_questions),
                source,
                content_hash,
                revision,
                created_at,
                updated_at,
            ),
        )

    def get(self, id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM knowledge_rule_snapshots WHERE id = ?", (id,)
        ).fetchone()
        if row is None:
            return None
        result = self._row_to_dict(row)
        result["discoveredFiles"] = [
            self._rule_file_row_to_dict(f)
            for f in self._db.execute(
                "SELECT * FROM knowledge_rule_files WHERE snapshot_id = ? ORDER BY relative_path",
                (id,),
            ).fetchall()
        ]
        return result

    def list_for_repository(self, repository_id: str, *, limit: int = 20) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM knowledge_rule_snapshots
            WHERE repository_id = ?
            ORDER BY updated_at DESC, id DESC
            LIMIT ?
            """,
            (repository_id, limit),
        ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def mark_confirmed(
        self,
        id: str,
        *,
        confirmed_by: dict,
        confirmed_at: str,
        status: str,
        updated_at: str,
    ) -> None:
        self._db.execute(
            """
            UPDATE knowledge_rule_snapshots
            SET status = ?, confirmed_by_json = ?, confirmed_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, _json_dumps(confirmed_by), confirmed_at, updated_at, id),
        )

    def mark_superseded(self, id: str, *, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_rule_snapshots SET status = 'SUPERSEDED', updated_at = ? WHERE id = ?",
            (updated_at, id),
        )

    def mark_stale(self, id: str, *, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_rule_snapshots SET status = 'STALE', updated_at = ? WHERE id = ?",
            (updated_at, id),
        )

    def update_revision(self, id: str, *, revision: str, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_rule_snapshots SET revision = ?, updated_at = ? WHERE id = ?",
            (revision, updated_at, id),
        )

    def create_rule_files(self, snapshot_id: str, files: list[dict]) -> None:
        for file in files:
            self._db.execute(
                """
                INSERT INTO knowledge_rule_files (
                    id, snapshot_id, relative_path, category, content_hash,
                    size_bytes, purpose
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    file["id"],
                    snapshot_id,
                    file["relativePath"],
                    file["category"],
                    file["contentHash"],
                    file["sizeBytes"],
                    file["purpose"],
                ),
            )

    def list_rule_files(self, snapshot_id: str) -> list[dict]:
        rows = self._db.execute(
            "SELECT * FROM knowledge_rule_files WHERE snapshot_id = ? ORDER BY relative_path",
            (snapshot_id,),
        ).fetchall()
        return [self._rule_file_row_to_dict(row) for row in rows]

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "repositoryId": row["repository_id"],
            "revision": row["revision"],
            "headCommit": row["head_commit"],
            "writablePaths": json.loads(row["writable_paths_json"]),
            "protectedPaths": json.loads(row["protected_paths_json"]),
            "indexFiles": json.loads(row["index_files_json"]),
            "routingFiles": json.loads(row["routing_files_json"]),
            "templateFiles": json.loads(row["template_files_json"]),
            "validationCommands": json.loads(row["validation_commands_json"]),
            "summary": row["summary"],
            "openQuestions": json.loads(row["open_questions_json"]),
            "source": row["source"],
            "contentHash": row["content_hash"],
            "status": row["status"],
            "confirmedBy": json.loads(row["confirmed_by_json"]) if row["confirmed_by_json"] else None,
            "confirmedAt": row["confirmed_at"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _rule_file_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "path": row["relative_path"],
            "category": row["category"],
            "hash": row["content_hash"],
            "sizeBytes": row["size_bytes"],
            "purpose": row["purpose"],
        }


class KnowledgeChangeSetRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        project_id: str,
        run_id: str,
        repository_id: str,
        rule_snapshot_id: str,
        provider: str,
        mode: str,
        base_head_commit: str,
        base_worktree_fingerprint: str,
        status: str,
        revision: str,
        created_at: str,
        updated_at: str,
        supersedes_change_set_id: str | None = None,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO knowledge_change_sets (
                id, supersedes_change_set_id, project_id, run_id, repository_id,
                rule_snapshot_id, provider, mode, base_head_commit,
                base_worktree_fingerprint, plan_json, unified_diff_uri,
                unified_diff_hash, risk_level, risk_reasons_json, status,
                agent_job_id, approval_id, committed_hash, revision, applied_at,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '[]', ?, NULL, NULL, NULL, ?, NULL, ?, ?)
            """,
            (
                id,
                supersedes_change_set_id,
                project_id,
                run_id,
                repository_id,
                rule_snapshot_id,
                provider,
                mode,
                base_head_commit,
                base_worktree_fingerprint,
                status,
                revision,
                created_at,
                updated_at,
            ),
        )

    def get(self, id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM knowledge_change_sets WHERE id = ?", (id,)
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def get_for_run(self, run_id: str, change_set_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM knowledge_change_sets WHERE id = ? AND run_id = ?",
            (change_set_id, run_id),
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def list_for_run(
        self, run_id: str, *, limit: int = 20, before: tuple[str, str] | None = None
    ) -> list[dict]:
        sql = "SELECT * FROM knowledge_change_sets WHERE run_id = ?"
        params: list[Any] = [run_id]
        if before is not None:
            sql += " AND (updated_at < ? OR (updated_at = ? AND id < ?))"
            params.extend([before[0], before[0], before[1]])
        sql += " ORDER BY updated_at DESC, id DESC LIMIT ?"
        params.append(limit + 1)
        rows = self._db.execute(sql, params).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def update_status(self, id: str, *, status: str, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_change_sets SET status = ?, updated_at = ? WHERE id = ?",
            (status, updated_at, id),
        )

    def update_revision(self, id: str, *, revision: str, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_change_sets SET revision = ?, updated_at = ? WHERE id = ?",
            (revision, updated_at, id),
        )

    def set_agent_job(self, id: str, *, agent_job_id: str, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_change_sets SET agent_job_id = ?, updated_at = ? WHERE id = ?",
            (agent_job_id, updated_at, id),
        )

    def set_approval(self, id: str, *, approval_id: str, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_change_sets SET approval_id = ?, updated_at = ? WHERE id = ?",
            (approval_id, updated_at, id),
        )

    def set_applied(self, id: str, *, applied_at: str, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_change_sets SET applied_at = ?, updated_at = ? WHERE id = ?",
            (applied_at, updated_at, id),
        )

    def set_committed(self, id: str, *, committed_hash: str, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_change_sets SET committed_hash = ?, updated_at = ? WHERE id = ?",
            (committed_hash, updated_at, id),
        )

    def set_plan(self, id: str, *, plan: dict | None, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_change_sets SET plan_json = ?, updated_at = ? WHERE id = ?",
            (_json_dumps(plan) if plan is not None else None, updated_at, id),
        )

    def set_unified_diff(
        self, id: str, *, unified_diff_uri: str | None, unified_diff_hash: str | None, updated_at: str
    ) -> None:
        self._db.execute(
            """
            UPDATE knowledge_change_sets
            SET unified_diff_uri = ?, unified_diff_hash = ?, updated_at = ?
            WHERE id = ?
            """,
            (unified_diff_uri, unified_diff_hash, updated_at, id),
        )

    def set_risk(
        self, id: str, *, risk_level: str | None, risk_reasons: list[str], updated_at: str
    ) -> None:
        self._db.execute(
            """
            UPDATE knowledge_change_sets
            SET risk_level = ?, risk_reasons_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (risk_level, _json_dumps(risk_reasons), updated_at, id),
        )

    def mark_stale(self, id: str, *, updated_at: str) -> None:
        self._db.execute(
            "UPDATE knowledge_change_sets SET status = 'STALE', updated_at = ? WHERE id = ?",
            (updated_at, id),
        )

    def delete_file_changes(self, change_set_id: str) -> None:
        self._db.execute(
            "DELETE FROM knowledge_file_changes WHERE change_set_id = ?", (change_set_id,)
        )

    def delete_validations(self, change_set_id: str) -> None:
        self._db.execute(
            "DELETE FROM knowledge_change_set_validations WHERE change_set_id = ?",
            (change_set_id,),
        )

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "supersedesChangeSetId": row["supersedes_change_set_id"],
            "projectId": row["project_id"],
            "runId": row["run_id"],
            "repositoryId": row["repository_id"],
            "ruleSnapshotId": row["rule_snapshot_id"],
            "provider": row["provider"],
            "mode": row["mode"],
            "baseHeadCommit": row["base_head_commit"],
            "baseWorkingTreeFingerprint": row["base_worktree_fingerprint"],
            "plan": json.loads(row["plan_json"]) if row["plan_json"] else None,
            "unifiedDiffUri": row["unified_diff_uri"],
            "unifiedDiffHash": row["unified_diff_hash"],
            "riskLevel": row["risk_level"],
            "riskReasons": json.loads(row["risk_reasons_json"]),
            "status": row["status"],
            "agentJobId": row["agent_job_id"],
            "approvalId": row["approval_id"],
            "committedHash": row["committed_hash"],
            "revision": row["revision"],
            "appliedAt": row["applied_at"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }


class KnowledgeChangeSetArtifactRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create_many(self, change_set_id: str, artifacts: list[dict]) -> None:
        for artifact in artifacts:
            self._db.execute(
                """
                INSERT INTO knowledge_change_set_artifacts (
                    change_set_id, artifact_id, run_id, node_id, workflow_version_id,
                    artifact_type, uri, content_hash, artifact_status
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified')
                """,
                (
                    change_set_id,
                    artifact["artifactId"],
                    artifact["runId"],
                    artifact["nodeId"],
                    artifact.get("workflowVersionId"),
                    artifact["type"],
                    artifact["uri"],
                    artifact["contentHash"],
                ),
            )

    def list_for_change_set(self, change_set_id: str) -> list[dict]:
        rows = self._db.execute(
            "SELECT * FROM knowledge_change_set_artifacts WHERE change_set_id = ? ORDER BY artifact_id",
            (change_set_id,),
        ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "artifactId": row["artifact_id"],
            "projectId": row["run_id"],
            "runId": row["run_id"],
            "nodeId": row["node_id"],
            "workflowVersionId": row["workflow_version_id"],
            "type": row["artifact_type"],
            "uri": row["uri"],
            "contentHash": row["content_hash"],
            "status": row["artifact_status"],
        }


class KnowledgeFileChangeRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        change_set_id: str,
        relative_path: str,
        operation: str,
        category: str,
        reason: str,
        source_artifact_ids: list[str],
        before_hash: str | None,
        proposed_content_uri: str,
        proposed_hash: str,
        warnings: list[str],
    ) -> None:
        self._db.execute(
            """
            INSERT INTO knowledge_file_changes (
                id, change_set_id, relative_path, operation, category, reason,
                source_artifact_ids_json, before_hash, proposed_content_uri,
                proposed_hash, warnings_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                change_set_id,
                relative_path,
                operation,
                category,
                reason,
                _json_dumps(source_artifact_ids),
                before_hash,
                proposed_content_uri,
                proposed_hash,
                _json_dumps(warnings),
            ),
        )

    def get(self, change_set_id: str, relative_path: str) -> dict | None:
        row = self._db.execute(
            """
            SELECT * FROM knowledge_file_changes
            WHERE change_set_id = ? AND relative_path = ?
            """,
            (change_set_id, relative_path),
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def list_for_change_set(self, change_set_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM knowledge_file_changes
            WHERE change_set_id = ? ORDER BY relative_path
            """,
            (change_set_id,),
        ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "path": row["relative_path"],
            "operation": row["operation"],
            "category": row["category"],
            "reason": row["reason"],
            "sourceArtifactIds": json.loads(row["source_artifact_ids_json"]),
            "beforeHash": row["before_hash"],
            "proposedContentUri": row["proposed_content_uri"],
            "proposedHash": row["proposed_hash"],
            "warnings": json.loads(row["warnings_json"]),
        }


class KnowledgeValidationRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        change_set_id: str,
        validator_id: str,
        validator_type: str,
        status: str,
        summary: str,
        evidence_uri: str | None,
        evidence_hash: str | None,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO knowledge_change_set_validations (
                id, change_set_id, validator_id, validator_type, status,
                summary, evidence_uri, evidence_hash, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                change_set_id,
                validator_id,
                validator_type,
                status,
                summary,
                evidence_uri,
                evidence_hash,
                created_at,
            ),
        )

    def list_for_change_set(self, change_set_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM knowledge_change_set_validations
            WHERE change_set_id = ? ORDER BY created_at, id
            """,
            (change_set_id,),
        ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "validatorId": row["validator_id"],
            "validatorType": row["validator_type"],
            "status": row["status"],
            "summary": row["summary"],
            "evidenceUri": row["evidence_uri"],
            "evidenceHash": row["evidence_hash"],
            "createdAt": row["created_at"],
        }


class KnowledgeApprovalRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        change_set_id: str,
        decision: str,
        actor: dict,
        comment: str,
        artifact_hashes: list[str],
        rule_snapshot_hash: str,
        target_hashes: list[str],
        base_head_commit: str,
        unified_diff_hash: str,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO knowledge_change_set_approvals (
                id, change_set_id, decision, actor_json, comment,
                artifact_hashes_json, rule_snapshot_hash, target_hashes_json,
                base_head_commit, unified_diff_hash, invalidated_at,
                invalidation_reason, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
            """,
            (
                id,
                change_set_id,
                decision,
                _json_dumps(actor),
                comment,
                _json_dumps(artifact_hashes),
                rule_snapshot_hash,
                _json_dumps(target_hashes),
                base_head_commit,
                unified_diff_hash,
                created_at,
            ),
        )

    def get(self, id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM knowledge_change_set_approvals WHERE id = ?", (id,)
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def get_for_change_set(self, change_set_id: str) -> dict | None:
        row = self._db.execute(
            """
            SELECT * FROM knowledge_change_set_approvals
            WHERE change_set_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
            """,
            (change_set_id,),
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def invalidate(
        self, id: str, *, invalidated_at: str, reason: str | None = None
    ) -> None:
        self._db.execute(
            """
            UPDATE knowledge_change_set_approvals
            SET invalidated_at = ?, invalidation_reason = ?
            WHERE id = ?
            """,
            (invalidated_at, reason, id),
        )

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "decision": row["decision"],
            "actor": json.loads(row["actor_json"]),
            "comment": row["comment"],
            "artifactHashes": json.loads(row["artifact_hashes_json"]),
            "ruleSnapshotHash": row["rule_snapshot_hash"],
            "targetHashes": json.loads(row["target_hashes_json"]),
            "baseHeadCommit": row["base_head_commit"],
            "unifiedDiffHash": row["unified_diff_hash"],
            "invalidatedAt": row["invalidated_at"],
        }


class KnowledgeGitOperationRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        repository_id: str,
        change_set_id: str | None,
        operation: str,
        paths: list[str],
        commit_hash: str | None,
        actor: dict,
        detail: dict,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO knowledge_git_operations (
                id, repository_id, change_set_id, operation, paths_json,
                commit_hash, actor_json, detail_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                repository_id,
                change_set_id,
                operation,
                _json_dumps(paths),
                commit_hash,
                _json_dumps(actor),
                _json_dumps(detail),
                created_at,
            ),
        )

    def list_for_repository(self, repository_id: str, *, limit: int = 50) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM knowledge_git_operations
            WHERE repository_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
            """,
            (repository_id, limit),
        ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "repositoryId": row["repository_id"],
            "changeSetId": row["change_set_id"],
            "operation": row["operation"],
            "paths": json.loads(row["paths_json"]),
            "commitHash": row["commit_hash"],
            "actor": json.loads(row["actor_json"]),
            "detail": json.loads(row["detail_json"]),
            "createdAt": row["created_at"],
        }


class KnowledgeIdempotencyRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def claim(
        self,
        *,
        scope_key: str,
        idempotency_key: str,
        request_hash: str,
        now: str,
    ) -> dict:
        row = self._db.execute(
            """
            SELECT * FROM knowledge_idempotency_keys
            WHERE scope_key = ? AND idempotency_key = ?
            """,
            (scope_key, idempotency_key),
        ).fetchone()
        if row is None:
            self._db.execute(
                """
                INSERT INTO knowledge_idempotency_keys (
                    scope_key, idempotency_key, request_hash, response_json,
                    status_code, created_at
                )
                VALUES (?, ?, ?, '{}', 0, ?)
                """,
                (scope_key, idempotency_key, request_hash, now),
            )
            return {"outcome": "created", "response": None, "statusCode": None}
        if row["request_hash"] != request_hash:
            raise ValueError("IDEMPOTENCY_KEY_REUSED")
        if _older_than_24h(row["created_at"], now):
            self._db.execute(
                """
                UPDATE knowledge_idempotency_keys
                SET request_hash = ?, response_json = '{}', status_code = 0, created_at = ?
                WHERE scope_key = ? AND idempotency_key = ?
                """,
                (request_hash, now, scope_key, idempotency_key),
            )
            return {"outcome": "created", "response": None, "statusCode": None}
        return {
            "outcome": "replayed",
            "response": json.loads(row["response_json"]) if row["response_json"] else None,
            "statusCode": row["status_code"],
        }

    def store_response(
        self,
        *,
        scope_key: str,
        idempotency_key: str,
        response: dict,
        status_code: int,
    ) -> None:
        self._db.execute(
            """
            UPDATE knowledge_idempotency_keys
            SET response_json = ?, status_code = ?
            WHERE scope_key = ? AND idempotency_key = ?
            """,
            (_json_dumps(response), status_code, scope_key, idempotency_key),
        )


def _older_than_24h(created_at: str, now: str) -> bool:
    from datetime import datetime

    def parse(value: str) -> datetime:
        normalized = value.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized)

    return (parse(now) - parse(created_at)).total_seconds() > 24 * 60 * 60
