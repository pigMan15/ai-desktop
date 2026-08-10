"""Knowledge change set service (document sections 7, 9, 10, 27.3-27.5, 31.2).

Owns the change set state machine, review binding, baseline invalidation,
atomic apply with rollback and the scoped Git operations.
"""
from __future__ import annotations

import json
import re
import shutil
import sqlite3
from pathlib import Path
from threading import RLock
from uuid import uuid4

from workflow_platform.artifacts.service import hash_artifact, validate_safe_path
from workflow_platform.governance.actors import require_trusted_human
from workflow_platform.governance.audit import AuditLog
from workflow_platform.knowledge.agent_runner import KnowledgeAgentRunner
from workflow_platform.knowledge.git_gateway import (
    KnowledgeGitGateway,
    validate_repository_relative_path,
)
from workflow_platform.knowledge.proposal import (
    KnowledgeProposalError,
    attach_before_hashes,
    classify_risk,
    generate_unified_diff,
    parse_proposal,
    read_change_content,
    run_builtin_validations,
)
from workflow_platform.knowledge.prompts import build_change_set_prompt
from workflow_platform.persistence.knowledge_repositories import (
    KnowledgeApprovalRepository,
    KnowledgeChangeSetArtifactRepository,
    KnowledgeChangeSetRepository,
    KnowledgeFileChangeRepository,
    KnowledgeGitOperationRepository,
    KnowledgeRepositoryRepository,
    KnowledgeRuleSnapshotRepository,
    KnowledgeValidationRepository,
)
from workflow_platform.persistence.repositories import ArtifactRepository, RunRepository
from workflow_platform.runtime_errors import RuntimeContractError

MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
MAX_TARGET_TOTAL_BYTES = 20 * 1024 * 1024


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _file_uri_to_path(uri: str) -> Path:
    from urllib.parse import unquote, urlparse

    parsed = urlparse(uri)
    if parsed.scheme != "file":
        raise RuntimeContractError("KNOWLEDGE_INPUT_INVALID", "Artifact URI 不是 file URI", status=400)
    path_text = unquote(parsed.path)
    if len(path_text) >= 3 and path_text[0] == "/" and path_text[2] == ":":
        path_text = path_text[1:]
    return Path(path_text)


def _next_revision(revision: str) -> str:
    try:
        return str(int(revision) + 1)
    except ValueError:
        return f"{revision}.1"


class KnowledgeChangeSetService:
    def __init__(
        self,
        *,
        db: sqlite3.Connection,
        lock: RLock,
        audit: AuditLog,
        agent_runner: KnowledgeAgentRunner,
        jobs_root: Path,
        artifacts_repository: ArtifactRepository,
        runs_repository: RunRepository,
        gateway: KnowledgeGitGateway | None = None,
    ) -> None:
        self._db = db
        self._lock = lock
        self._audit = audit
        self._runner = agent_runner
        self._jobs_root = jobs_root
        self._artifacts = artifacts_repository
        self._runs = runs_repository
        self._gateway = gateway or KnowledgeGitGateway()
        self._repositories = KnowledgeRepositoryRepository(db)
        self._snapshots = KnowledgeRuleSnapshotRepository(db)
        self._change_sets = KnowledgeChangeSetRepository(db)
        self._change_set_artifacts = KnowledgeChangeSetArtifactRepository(db)
        self._file_changes = KnowledgeFileChangeRepository(db)
        self._validations = KnowledgeValidationRepository(db)
        self._approvals = KnowledgeApprovalRepository(db)
        self._git_operations = KnowledgeGitOperationRepository(db)
        self._rollback_failed = False

    # -- create -------------------------------------------------------------

    def create(
        self,
        *,
        project_id: str,
        run_id: str,
        repository_id: str,
        artifact_ids: list[str],
        provider: str,
        mode: str,
        actor: dict,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="创建知识变更集")
        if not artifact_ids:
            raise RuntimeContractError("KNOWLEDGE_INPUT_INVALID", "必须选择至少一个 Artifact", status=400)
        if mode not in {"preview", "risk-based"}:
            raise RuntimeContractError("KNOWLEDGE_INPUT_INVALID", f"mode 无效: {mode}", status=400)
        if provider not in {"codex", "claude", "fake"}:
            raise RuntimeContractError("KNOWLEDGE_INPUT_INVALID", f"provider 无效: {provider}", status=400)

        with self._lock, self._db:
            run = self._require_run(project_id, run_id)
            repository = self._repositories.get(repository_id)
            if repository is None or repository["status"] != "ACTIVE":
                raise RuntimeContractError(
                    "KNOWLEDGE_RULES_NOT_CONFIRMED", "目标知识库未激活或没有已确认规则", status=409
                )
            snapshot_id = repository["activeRuleSnapshotId"]
            snapshot = self._snapshots.get(snapshot_id) if snapshot_id else None
            if snapshot is None or snapshot["status"] != "CONFIRMED":
                raise RuntimeContractError(
                    "KNOWLEDGE_RULES_NOT_CONFIRMED", "目标知识库缺少已确认规则快照", status=409
                )

            repository_root = Path(repository["rootPath"])
            inspection = self._gateway.inspect(repository_root)
            if inspection.conflict:
                raise RuntimeContractError(
                    "KNOWLEDGE_GIT_CONFLICT", "目标仓库存在未解决冲突，禁止创建变更集", status=409
                )

            execution_workspace = self._runs.execution_workspace_for_run(run_id)
            artifact_snapshots = self._validate_artifacts(
                run_id, artifact_ids, execution_workspace, now
            )

            change_set_id = f"knowledge-change-set-{uuid4()}"
            self._change_sets.create(
                id=change_set_id,
                project_id=project_id,
                run_id=run_id,
                repository_id=repository_id,
                rule_snapshot_id=snapshot["id"],
                provider=provider,
                mode=mode,
                base_head_commit=inspection.headCommit,
                base_worktree_fingerprint=inspection.worktreeFingerprint,
                status="DRAFT",
                revision="1",
                created_at=now,
                updated_at=now,
            )
            self._change_set_artifacts.create_many(change_set_id, artifact_snapshots)
            self._audit.record(
                actor=actor,
                action="knowledge.change_set.created",
                resource=f"run:{run_id}",
                detail={"changeSetId": change_set_id, "repositoryId": repository_id},
                created_at=now,
            )
            self._db.commit()

        self._build_analysis_copy(
            change_set_id,
            repository_root,
            snapshot,
            artifact_snapshots,
            run_id,
            execution_workspace,
            now,
        )
        return self.get(project_id, run_id, change_set_id)

    def _require_run(self, project_id: str, run_id: str) -> dict:
        run = self._runs.get(project_id, run_id)
        if run is None:
            raise RuntimeContractError(
                "KNOWLEDGE_CHANGE_SET_NOT_FOUND_IN_RUN", "Run 不在项目中", status=404
            )
        return run

    def _validate_artifacts(
        self, run_id: str, artifact_ids: list[str], execution_workspace: str, now: str
    ) -> list[dict]:
        snapshots: list[dict] = []
        for artifact_id in artifact_ids:
            artifact = self._artifacts.get_for_run(run_id, artifact_id)
            if artifact is None:
                raise RuntimeContractError(
                    "KNOWLEDGE_CHANGE_SET_NOT_FOUND_IN_RUN",
                    f"Artifact 不在该 Run 中: {artifact_id}",
                    status=404,
                )
            if artifact["status"] != "verified":
                raise RuntimeContractError(
                    "KNOWLEDGE_INPUT_INVALID",
                    f"Artifact 状态不是 verified: {artifact_id}",
                    status=409,
                )
            path = validate_safe_path(execution_workspace, _file_uri_to_path(artifact["uri"]))
            if not path.is_file():
                raise RuntimeContractError(
                    "KNOWLEDGE_INPUT_INVALID",
                    f"Artifact 文件不存在或不可读: {artifact_id}",
                    status=409,
                )
            stat = path.stat()
            if stat.st_size > MAX_ARTIFACT_BYTES:
                raise RuntimeContractError(
                    "KNOWLEDGE_INPUT_LIMIT_EXCEEDED",
                    f"Artifact 超过 10 MiB 上限: {artifact_id}",
                    status=413,
                )
            current_hash = hash_artifact(path)
            if artifact["contentHash"] and current_hash != artifact["contentHash"]:
                raise RuntimeContractError(
                    "KNOWLEDGE_BASELINE_CHANGED",
                    f"Artifact 内容哈希已变化: {artifact_id}",
                    status=409,
                )
            snapshots.append(
                {
                    "artifactId": artifact["id"],
                    "runId": run_id,
                    "nodeId": artifact["nodeId"],
                    "workflowVersionId": artifact.get("workflowVersionId"),
                    "type": artifact["type"],
                    "uri": artifact["uri"],
                    "contentHash": current_hash,
                    "status": "verified",
                    "_path": str(path),
                }
            )
        return snapshots

    def _build_analysis_copy(
        self,
        change_set_id: str,
        repository_root: Path,
        snapshot: dict,
        artifact_snapshots: list[dict],
        run_id: str,
        execution_workspace: str,
        now: str,
    ) -> Path:
        analysis_root = self._jobs_root / change_set_id
        input_root = analysis_root / "input"
        (input_root / "artifacts").mkdir(parents=True, exist_ok=True)
        (input_root / "rules").mkdir(parents=True, exist_ok=True)
        (input_root / "target").mkdir(parents=True, exist_ok=True)
        (analysis_root / "output").mkdir(parents=True, exist_ok=True)
        (analysis_root / "logs").mkdir(parents=True, exist_ok=True)

        manifest_entries: list[dict] = []
        # artifacts
        for artifact in artifact_snapshots:
            source = Path(artifact.pop("_path"))
            ext = source.suffix or ".md"
            safe_id = re.sub(r"[^A-Za-z0-9._-]", "_", artifact["artifactId"])
            destination = input_root / "artifacts" / f"{safe_id}{ext}"
            shutil.copy2(source, destination)
            manifest_entries.append(
                {
                    "path": destination.relative_to(analysis_root).as_posix(),
                    "source": "artifact",
                    "artifactId": artifact["artifactId"],
                    "sizeBytes": source.stat().st_size,
                    "sha256": artifact["contentHash"],
                }
            )
        # rules
        for rule_file in snapshot.get("discoveredFiles") or []:
            source = repository_root / rule_file["path"]
            if not source.is_file():
                continue
            destination = input_root / "rules" / rule_file["path"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            manifest_entries.append(
                {
                    "path": destination.relative_to(analysis_root).as_posix(),
                    "source": "rule-snapshot",
                    "sizeBytes": source.stat().st_size,
                    "sha256": rule_file["hash"],
                }
            )
        # targets: existing files under writable paths (bounded)
        self._copy_target_files(repository_root, snapshot, input_root, manifest_entries)
        manifest = {
            "kind": "change-set-generation",
            "changeSetId": change_set_id,
            "runId": run_id,
            "createdAt": now,
            "repositoryRoot": str(repository_root),
            "entries": manifest_entries,
        }
        (input_root / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return analysis_root

    # -- generation ---------------------------------------------------------

    def start_generation(
        self,
        project_id: str,
        run_id: str,
        change_set_id: str,
        *,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="生成知识变更集")
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            self._require_revision(change_set, expected_revision)
            if change_set["status"] != "DRAFT":
                raise RuntimeContractError(
                    "INVALID_TRANSITION",
                    f"只有 DRAFT 状态可以开始生成（当前 {change_set['status']}）",
                    status=409,
                )
            repository = self._repositories.get(change_set["repositoryId"])
            snapshot = self._snapshots.get(change_set["ruleSnapshotId"])
            if repository is None or snapshot is None:
                raise RuntimeContractError("KNOWLEDGE_RULES_NOT_CONFIRMED", "仓库或规则快照缺失", status=409)

            job_id = f"knowledge-job-{uuid4()}"
            analysis_root = self._jobs_root / change_set_id
            prompt = build_change_set_prompt(
                manifest=self._read_analysis_manifest(analysis_root),
                snapshot_summary=self._snapshot_summary(snapshot),
                artifact_summaries=self._artifact_summaries(change_set_id),
                existing_knowledge_summaries=[],
                delivery="path",
            )
            self._change_sets.set_agent_job(change_set_id, agent_job_id=job_id, updated_at=now)
            self._change_sets.update_status(change_set_id, status="GENERATING", updated_at=now)
            self._db.commit()

        queued = self._runner.start_change_set_generation(
            job_id=job_id,
            project_id=project_id,
            run_id=run_id,
            change_set_id=change_set_id,
            provider=change_set["provider"],
            analysis_root=analysis_root,
            prompt=prompt,
            now=now,
        )
        return {"jobId": job_id, "changeSetId": change_set_id, "status": queued["status"]}

    # -- read ---------------------------------------------------------------

    def get(self, project_id: str, run_id: str, change_set_id: str) -> dict:
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            self._check_baseline(change_set)
            return self._detail(change_set)

    def list_for_run(
        self, project_id: str, run_id: str, *, cursor: str | None, limit: int
    ) -> dict:
        self._require_run(project_id, run_id)
        limit = min(max(limit, 1), 100)
        before: tuple[str, str] | None = None
        if cursor:
            try:
                parts = cursor.split(":", 1)
                before = (parts[0], parts[1])
            except (IndexError, ValueError):
                before = None
        with self._lock, self._db:
            rows = self._change_sets.list_for_run(run_id, limit=limit, before=before)
        has_more = len(rows) > limit
        items = rows[:limit]
        next_cursor = None
        if has_more and items:
            last = items[-1]
            next_cursor = f"{last['updatedAt']}:{last['id']}"
        summaries = [
            {
                "id": item["id"],
                "repositoryId": item["repositoryId"],
                "runId": item["runId"],
                "status": item["status"],
                "riskLevel": item["riskLevel"],
                "revision": item["revision"],
                "createdAt": item["createdAt"],
                "updatedAt": item["updatedAt"],
            }
            for item in items
        ]
        return {"items": summaries, "nextCursor": next_cursor}

    def list_output(
        self,
        project_id: str,
        run_id: str,
        change_set_id: str,
        *,
        after_sequence: int,
    ) -> list[dict]:
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            job_id = change_set.get("agentJobId")
            if not job_id:
                return []
            job = self._runner_job(change_set, job_id)
            if job is None:
                raise RuntimeContractError(
                    "KNOWLEDGE_AGENT_JOB_LOST", "生成任务已不存在", status=409
                )
            return self._output_events(job_id, after_sequence)

    # -- review / apply / abandon -------------------------------------------

    def approve(
        self,
        project_id: str,
        run_id: str,
        change_set_id: str,
        *,
        comment: str,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="审核知识变更集")
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            self._require_revision(change_set, expected_revision)
            self._check_baseline(change_set)
            if change_set["status"] != "AWAITING_APPROVAL":
                raise RuntimeContractError(
                    "INVALID_TRANSITION",
                    f"只有 AWAITING_APPROVAL 可以审核（当前 {change_set['status']}）",
                    status=409,
                )
            approval_id = f"knowledge-approval-{uuid4()}"
            binding = self._approval_binding(change_set)
            self._approvals.create(
                id=approval_id,
                change_set_id=change_set_id,
                decision="approved",
                actor=actor,
                comment=comment,
                artifact_hashes=binding["artifactHashes"],
                rule_snapshot_hash=binding["ruleSnapshotHash"],
                target_hashes=binding["targetHashes"],
                base_head_commit=binding["baseHeadCommit"],
                unified_diff_hash=binding["unifiedDiffHash"],
                created_at=now,
            )
            self._change_sets.set_approval(change_set_id, approval_id=approval_id, updated_at=now)
            self._change_sets.update_status(change_set_id, status="APPROVED", updated_at=now)
            self._change_sets.update_revision(
                change_set_id, revision=_next_revision(change_set["revision"]), updated_at=now
            )
            self._audit.record(
                actor=actor,
                action="knowledge.change_set.approved",
                resource=f"run:{run_id}",
                detail={"changeSetId": change_set_id, "approvalId": approval_id},
                created_at=now,
            )
            self._db.commit()
            return self._detail(self._require_change_set(project_id, run_id, change_set_id))

    def reject(
        self,
        project_id: str,
        run_id: str,
        change_set_id: str,
        *,
        comment: str,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="拒绝知识变更集")
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            self._require_revision(change_set, expected_revision)
            if change_set["status"] != "AWAITING_APPROVAL":
                raise RuntimeContractError(
                    "INVALID_TRANSITION",
                    f"只有 AWAITING_APPROVAL 可以拒绝（当前 {change_set['status']}）",
                    status=409,
                )
            self._approvals.create(
                id=f"knowledge-approval-{uuid4()}",
                change_set_id=change_set_id,
                decision="rejected",
                actor=actor,
                comment=comment,
                artifact_hashes=[],
                rule_snapshot_hash="",
                target_hashes=[],
                base_head_commit=change_set["baseHeadCommit"],
                unified_diff_hash="",
                created_at=now,
            )
            self._change_sets.update_status(change_set_id, status="ABANDONED", updated_at=now)
            self._change_sets.update_revision(
                change_set_id, revision=_next_revision(change_set["revision"]), updated_at=now
            )
            self._audit.record(
                actor=actor,
                action="knowledge.change_set.rejected",
                resource=f"run:{run_id}",
                detail={"changeSetId": change_set_id},
                created_at=now,
            )
            self._db.commit()
            return self._detail(self._require_change_set(project_id, run_id, change_set_id))

    def abandon(
        self,
        project_id: str,
        run_id: str,
        change_set_id: str,
        *,
        reason: str,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="放弃知识变更集")
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            self._require_revision(change_set, expected_revision)
            if change_set["status"] in {"COMMITTED", "ABANDONED"}:
                raise RuntimeContractError(
                    "INVALID_TRANSITION",
                    f"终态不可放弃（当前 {change_set['status']}）",
                    status=409,
                )
            self._change_sets.update_status(change_set_id, status="ABANDONED", updated_at=now)
            self._change_sets.update_revision(
                change_set_id, revision=_next_revision(change_set["revision"]), updated_at=now
            )
            self._audit.record(
                actor=actor,
                action="knowledge.change_set.abandoned",
                resource=f"run:{run_id}",
                detail={"changeSetId": change_set_id, "reason": reason},
                created_at=now,
            )
            self._db.commit()
            return self._detail(self._require_change_set(project_id, run_id, change_set_id))

    # -- completion callback ------------------------------------------------

    def _on_job_completed(self, job_id: str, result, analysis_root: Path) -> None:
        from workflow_platform.execution.cli import CliExecutionResult

        with self._lock, self._db:
            job = self._runner_job_by_id(job_id)
            if job is None or job["purpose"] != "knowledge-change-set-generation":
                return
            change_set_id = job["ownerId"]
            change_set = self._change_sets.get(change_set_id)
            if change_set is None or change_set["status"] != "GENERATING":
                return
            if result.status != "COMPLETED":
                self._change_sets.update_status(change_set_id, status="FAILED", updated_at=_now())
                self._audit.record(
                    actor=_system_actor(),
                    action="knowledge.change_set.generation_failed",
                    resource=f"run:{change_set['runId']}",
                    detail={"changeSetId": change_set_id, "error": result.error},
                    created_at=_now(),
                )
                self._db.commit()
                return
            try:
                proposal_file = analysis_root / "output" / "proposal.json"
                payload = json.loads(proposal_file.read_text(encoding="utf-8"))
                proposal = parse_proposal(payload, analysis_root, now=_now())
                repository = self._repositories.get(change_set["repositoryId"])
                snapshot = self._snapshots.get(change_set["ruleSnapshotId"])
                if repository is None or snapshot is None:
                    raise RuntimeContractError("KNOWLEDGE_RULES_NOT_CONFIRMED", "仓库或规则快照缺失", status=409)
                attach_before_hashes(proposal, Path(repository["rootPath"]))
                artifact_hashes = {
                    item["artifactId"]: item["contentHash"]
                    for item in self._change_set_artifacts.list_for_change_set(change_set_id)
                }
                validations = run_builtin_validations(
                    proposal=proposal,
                    snapshot=snapshot,
                    artifact_hashes=artifact_hashes,
                    repository_root=Path(repository["rootPath"]),
                    now=_now(),
                )
                risk_level, risk_reasons = classify_risk(
                    changes=proposal["changes"],
                    snapshot=snapshot,
                    validation_results=validations,
                )
                self._change_sets.delete_file_changes(change_set_id)
                self._change_sets.delete_validations(change_set_id)
                for index, change in enumerate(proposal["changes"]):
                    self._file_changes.create(
                        id=f"{change_set_id}:file-change:{index}",
                        change_set_id=change_set_id,
                        relative_path=change["path"],
                        operation=change["operation"],
                        category=change["category"],
                        reason=change["reason"],
                        source_artifact_ids=change["sourceArtifactIds"],
                        before_hash=change.get("beforeHash"),
                        proposed_content_uri=change["contentUri"],
                        proposed_hash=change["proposedHash"],
                        warnings=change["warnings"],
                    )
                for validation in validations:
                    self._validations.create(
                        id=f"{change_set_id}:validation:{uuid4()}",
                        change_set_id=change_set_id,
                        validator_id=validation["validatorId"],
                        validator_type=validation["validatorType"],
                        status=validation["status"],
                        summary=validation["summary"],
                        evidence_uri=validation["evidenceUri"],
                        evidence_hash=validation["evidenceHash"],
                        created_at=_now(),
                    )
                diff = generate_unified_diff(
                    repository_root=Path(repository["rootPath"]),
                    changes=proposal["changes"],
                )
                diff_uri = analysis_root / "output" / "unified.diff"
                diff_uri.write_text(diff, encoding="utf-8")
                import hashlib

                self._change_sets.set_unified_diff(
                    change_set_id,
                    unified_diff_uri=str(diff_uri),
                    unified_diff_hash=hashlib.sha256(diff.encode("utf-8")).hexdigest(),
                    updated_at=_now(),
                )
                self._change_sets.set_risk(
                    change_set_id, risk_level=risk_level, risk_reasons=risk_reasons, updated_at=_now()
                )
                if risk_level == "BLOCKED":
                    self._change_sets.update_status(change_set_id, status="BLOCKED", updated_at=_now())
                elif risk_level in {"MEDIUM", "HIGH"}:
                    self._change_sets.update_status(change_set_id, status="AWAITING_APPROVAL", updated_at=_now())
                elif risk_level == "LOW" and repository["autoApplyLowRisk"] and change_set["mode"] == "risk-based":
                    self._change_sets.update_status(change_set_id, status="READY_TO_APPLY", updated_at=_now())
                else:
                    self._change_sets.update_status(change_set_id, status="READY_TO_APPLY", updated_at=_now())
                self._change_sets.update_revision(
                    change_set_id, revision=_next_revision(change_set["revision"]), updated_at=_now()
                )
                self._audit.record(
                    actor=_system_actor(),
                    action="knowledge.change_set.generated",
                    resource=f"run:{change_set['runId']}",
                    detail={"changeSetId": change_set_id, "riskLevel": risk_level},
                    created_at=_now(),
                )
                self._db.commit()
            except KnowledgeProposalError as error:
                self._change_sets.update_status(change_set_id, status="BLOCKED", updated_at=_now())
                self._audit.record(
                    actor=_system_actor(),
                    action="knowledge.change_set.generation_blocked",
                    resource=f"run:{change_set['runId']}",
                    detail={"changeSetId": change_set_id, "code": error.code},
                    created_at=_now(),
                )
                self._db.commit()
            except Exception:
                self._db.rollback()
                with self._lock:
                    self._change_sets.update_status(change_set_id, status="FAILED", updated_at=_now())
                    self._db.commit()

    # -- atomic apply -------------------------------------------------------

    def apply(
        self,
        project_id: str,
        run_id: str,
        change_set_id: str,
        *,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="应用知识变更集")
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            self._require_revision(change_set, expected_revision)
            if change_set["status"] not in {"READY_TO_APPLY", "APPROVED"}:
                raise RuntimeContractError(
                    "INVALID_TRANSITION",
                    f"只有 READY_TO_APPLY 或 APPROVED 可以应用（当前 {change_set['status']}）",
                    status=409,
                )
            self._check_baseline(change_set)
            approval = self._approvals.get_for_change_set(change_set_id)
            if approval is not None and approval["invalidatedAt"]:
                raise RuntimeContractError(
                    "KNOWLEDGE_APPROVAL_INVALIDATED", "审核已失效，请重新审核", status=409
                )
            repository = self._repositories.get(change_set["repositoryId"])
            if repository is None or repository["status"] != "ACTIVE":
                raise RuntimeContractError("KNOWLEDGE_RULES_NOT_CONFIRMED", "仓库未激活", status=409)
            inspection = self._gateway.inspect(Path(repository["rootPath"]))
            if inspection.conflict:
                raise RuntimeContractError("KNOWLEDGE_GIT_CONFLICT", "仓库存在未解决冲突", status=409)
            self._change_sets.update_status(change_set_id, status="APPLYING", updated_at=now)
            applying_revision = _next_revision(change_set["revision"])
            self._change_sets.update_revision(
                change_set_id, revision=applying_revision, updated_at=now
            )
            self._db.commit()

        repository_root = Path(repository["rootPath"])
        file_changes = self._file_changes.list_for_change_set(change_set_id)
        snapshot = self._snapshots.get(change_set["ruleSnapshotId"])
        overlay_root = self._jobs_root / "overlays" / change_set_id
        if overlay_root.exists():
            shutil.rmtree(overlay_root)
        try:
            self._materialize_overlay(repository_root, overlay_root, file_changes)
            if snapshot is not None:
                self._run_overlay_validations(overlay_root, snapshot)
            backup_root = self._jobs_root / "backups" / change_set_id
            self._replace_files_atomically(repository_root, overlay_root, file_changes, backup_root)
            self._verify_written_hashes(repository_root, file_changes)
            with self._lock, self._db:
                self._change_sets.set_applied(change_set_id, applied_at=now, updated_at=now)
                self._change_sets.update_status(change_set_id, status="APPLIED", updated_at=now)
                self._change_sets.update_revision(
                    change_set_id,
                    revision=_next_revision(applying_revision),
                    updated_at=now,
                )
                self._audit.record(
                    actor=actor,
                    action="knowledge.change_set.applied",
                    resource=f"run:{run_id}",
                    detail={"changeSetId": change_set_id},
                    created_at=now,
                )
                self._db.commit()
        except Exception as error:
            try:
                self._rollback_replaced_files(repository_root, file_changes, overlay_root, backup_root)
                rollback_ok = True
            except Exception:
                rollback_ok = False
            with self._lock, self._db:
                self._change_sets.update_status(change_set_id, status="FAILED", updated_at=now)
                self._change_sets.update_revision(
                    change_set_id,
                    revision=_next_revision(applying_revision),
                    updated_at=now,
                )
                self._audit.record(
                    actor=actor,
                    action="knowledge.change_set.apply_failed",
                    resource=f"run:{run_id}",
                    detail={"changeSetId": change_set_id, "error": str(error)[:300]},
                    created_at=now,
                )
                self._db.commit()
            raise RuntimeContractError(
                "KNOWLEDGE_APPLY_ROLLBACK_FAILED" if not rollback_ok else "KNOWLEDGE_APPLY_FAILED",
                f"应用失败已回滚: {error}",
                status=500,
            ) from error
        return self.get(project_id, run_id, change_set_id)

    def _materialize_overlay(
        self, repository_root: Path, overlay_root: Path, file_changes: list[dict]
    ) -> None:
        # Copy the whole working tree (without .git) so repository validation
        # commands see the real context, then apply proposed content.
        overlay_root.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            repository_root,
            overlay_root,
            ignore=shutil.ignore_patterns(".git"),
        )
        for change in file_changes:
            destination = overlay_root / change["path"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            content_uri = change.get("proposedContentUri") or change.get("contentUri")
            if not content_uri:
                raise RuntimeContractError(
                    "KNOWLEDGE_AGENT_OUTPUT_INVALID",
                    f"文件变更缺少内容引用: {change['path']}",
                    status=422,
                )
            destination.write_text(
                Path(content_uri).read_text(encoding="utf-8"), encoding="utf-8", newline="\n"
            )

    def _run_overlay_validations(self, overlay_root: Path, snapshot: dict) -> None:
        import os
        import shlex
        import subprocess

        commands = snapshot.get("validationCommands") or []
        minimal_env = {
            "PATH": os.environ.get("PATH", ""),
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
            "TEMP": os.environ.get("TEMP", ""),
            "TMP": os.environ.get("TMP", ""),
        }
        for command in commands:
            argv = shlex.split(command)
            if not argv:
                continue
            try:
                subprocess.run(
                    argv,
                    cwd=str(overlay_root),
                    shell=False,
                    env=minimal_env,
                    check=True,
                    capture_output=True,
                    timeout=60,
                )
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                raise RuntimeContractError(
                    "KNOWLEDGE_VALIDATION_FAILED",
                    f"仓库校验命令失败: {command}",
                    status=422,
                ) from error

    def _replace_files_atomically(
        self,
        repository_root: Path,
        overlay_root: Path,
        file_changes: list[dict],
        backup_root: Path,
    ) -> None:
        self._rollback_failed = False
        if backup_root.exists():
            shutil.rmtree(backup_root)
        backup_root.mkdir(parents=True, exist_ok=True)
        for change in file_changes:
            target = repository_root / change["path"]
            source = overlay_root / change["path"]
            if target.exists():
                backup = backup_root / change["path"]
                backup.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    def _verify_written_hashes(self, repository_root: Path, file_changes: list[dict]) -> None:
        for change in file_changes:
            target = repository_root / change["path"]
            if not target.is_file():
                raise RuntimeContractError(
                    "KNOWLEDGE_APPLY_ROLLBACK_FAILED",
                    f"应用后文件不存在: {change['path']}",
                    status=500,
                )
            current = hash_artifact(target)
            if current != change["proposedHash"]:
                raise RuntimeContractError(
                    "KNOWLEDGE_APPLY_ROLLBACK_FAILED",
                    f"应用后哈希与提案不一致: {change['path']}",
                    status=500,
                )

    def _rollback_replaced_files(
        self,
        repository_root: Path,
        file_changes: list[dict],
        overlay_root: Path,
        backup_root: Path,
    ) -> None:
        for change in file_changes:
            target = repository_root / change["path"]
            backup = backup_root / change["path"]
            if backup.exists():
                shutil.copy2(backup, target)
            else:
                target.unlink(missing_ok=True)
        shutil.rmtree(overlay_root, ignore_errors=True)

    # -- scoped git ---------------------------------------------------------

    def git_diff(
        self, project_id: str, run_id: str, change_set_id: str, *, staged: bool
    ) -> dict:
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            repository = self._repositories.get(change_set["repositoryId"])
            if repository is None:
                raise RuntimeContractError("KNOWLEDGE_REPOSITORY_NOT_FOUND", "仓库不存在", status=404)
            paths = [
                change["path"]
                for change in self._file_changes.list_for_change_set(change_set_id)
            ]
        diff = self._gateway.diff(Path(repository["rootPath"]), staged=staged, paths=paths or None)
        return {"diff": diff}

    def git_stage(
        self,
        project_id: str,
        run_id: str,
        change_set_id: str,
        *,
        paths: list[str],
        actor: dict,
        expected_revision: str,
        expected_repository_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="暂存知识变更集")
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            self._require_revision(change_set, expected_revision)
            repository = self._require_repository_revision(change_set, expected_repository_revision)
            if change_set["status"] not in {"APPLIED", "PARTIALLY_STAGED", "STAGED"}:
                raise RuntimeContractError(
                    "KNOWLEDGE_CHANGE_SET_NOT_APPLIED",
                    "只有已应用的变更集可以暂存",
                    status=409,
                )
            allowed = {
                change["path"]
                for change in self._file_changes.list_for_change_set(change_set_id)
            }
            for path in paths:
                if path not in allowed:
                    raise RuntimeContractError(
                        "KNOWLEDGE_CHANGE_SET_NOT_APPLIED",
                        f"路径不属于该变更集: {path}",
                        status=409,
                    )
            inspection = self._gateway.stage(Path(repository["rootPath"]), paths)
            status = self._recompute_staged_status(change_set_id, inspection, repository["rootPath"])
            self._change_sets.update_status(change_set_id, status=status, updated_at=now)
            self._change_sets.update_revision(
                change_set_id, revision=_next_revision(change_set["revision"]), updated_at=now
            )
            self._repositories.update_revision(
                repository["id"],
                revision=_next_revision(repository["revision"]),
                updated_at=now,
            )
            self._git_operations.create(
                id=f"knowledge-git-op-{uuid4()}",
                repository_id=repository["id"],
                change_set_id=change_set_id,
                operation="stage",
                paths=paths,
                commit_hash=None,
                actor=actor,
                detail={"runId": run_id},
                created_at=now,
            )
            self._audit.record(
                actor=actor,
                action="knowledge.change_set.staged",
                resource=f"run:{run_id}",
                detail={"changeSetId": change_set_id, "paths": paths},
                created_at=now,
            )
            self._db.commit()
            return self._detail(self._require_change_set(project_id, run_id, change_set_id))

    def git_unstage(
        self,
        project_id: str,
        run_id: str,
        change_set_id: str,
        *,
        paths: list[str],
        actor: dict,
        expected_revision: str,
        expected_repository_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="取消暂存知识变更集")
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            self._require_revision(change_set, expected_revision)
            repository = self._require_repository_revision(change_set, expected_repository_revision)
            if change_set["status"] not in {"PARTIALLY_STAGED", "STAGED", "APPLIED"}:
                raise RuntimeContractError(
                    "KNOWLEDGE_CHANGE_SET_NOT_APPLIED", "没有可取消暂存的文件", status=409
                )
            inspection = self._gateway.unstage(Path(repository["rootPath"]), paths)
            status = self._recompute_staged_status(change_set_id, inspection, repository["rootPath"])
            self._change_sets.update_status(change_set_id, status=status, updated_at=now)
            self._change_sets.update_revision(
                change_set_id, revision=_next_revision(change_set["revision"]), updated_at=now
            )
            self._repositories.update_revision(
                repository["id"],
                revision=_next_revision(repository["revision"]),
                updated_at=now,
            )
            self._git_operations.create(
                id=f"knowledge-git-op-{uuid4()}",
                repository_id=repository["id"],
                change_set_id=change_set_id,
                operation="unstage",
                paths=paths,
                commit_hash=None,
                actor=actor,
                detail={"runId": run_id},
                created_at=now,
            )
            self._audit.record(
                actor=actor,
                action="knowledge.change_set.unstaged",
                resource=f"run:{run_id}",
                detail={"changeSetId": change_set_id, "paths": paths},
                created_at=now,
            )
            self._db.commit()
            return self._detail(self._require_change_set(project_id, run_id, change_set_id))

    def git_commit(
        self,
        project_id: str,
        run_id: str,
        change_set_id: str,
        *,
        title: str,
        body: str,
        paths: list[str],
        actor: dict,
        expected_revision: str,
        expected_repository_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="提交知识变更集")
        with self._lock, self._db:
            change_set = self._require_change_set(project_id, run_id, change_set_id)
            self._require_revision(change_set, expected_revision)
            repository = self._require_repository_revision(change_set, expected_repository_revision)
            if change_set["status"] not in {"PARTIALLY_STAGED", "STAGED", "APPLIED"}:
                raise RuntimeContractError(
                    "KNOWLEDGE_CHANGE_SET_NOT_APPLIED", "没有可提交的已应用文件", status=409
                )
            allowed = {
                change["path"]
                for change in self._file_changes.list_for_change_set(change_set_id)
            }
            for path in paths:
                if path not in allowed:
                    raise RuntimeContractError(
                        "KNOWLEDGE_CHANGE_SET_NOT_APPLIED",
                        f"路径不属于该变更集: {path}",
                        status=409,
                    )
            tracked_body = f"{body}\n\nKnowledge change set: {change_set_id}\nRun: {run_id}\nProject: {project_id}"
            commit = self._gateway.commit(
                Path(repository["rootPath"]),
                title=title,
                body=tracked_body,
                paths=paths,
            )
            self._change_sets.set_committed(change_set_id, committed_hash=commit.commitHash, updated_at=now)
            self._change_sets.update_status(change_set_id, status="COMMITTED", updated_at=now)
            self._change_sets.update_revision(
                change_set_id, revision=_next_revision(change_set["revision"]), updated_at=now
            )
            self._repositories.update_revision(
                repository["id"],
                revision=_next_revision(repository["revision"]),
                updated_at=now,
            )
            self._git_operations.create(
                id=f"knowledge-git-op-{uuid4()}",
                repository_id=repository["id"],
                change_set_id=change_set_id,
                operation="commit",
                paths=paths,
                commit_hash=commit.commitHash,
                actor=actor,
                detail={"runId": run_id, "branch": commit.branch},
                created_at=now,
            )
            self._audit.record(
                actor=actor,
                action="knowledge.change_set.committed",
                resource=f"run:{run_id}",
                detail={"changeSetId": change_set_id, "commitHash": commit.commitHash},
                created_at=now,
            )
            self._db.commit()
            return {
                "commitHash": commit.commitHash,
                "branch": commit.branch,
                "committedPaths": commit.committedPaths,
            }

    def _recompute_staged_status(
        self, change_set_id: str, inspection, repository_root: str
    ) -> str:
        applied_paths = {
            change["path"]
            for change in self._file_changes.list_for_change_set(change_set_id)
        }
        staged = set(inspection.stagedPaths)
        applied_staged = applied_paths & staged
        if not applied_staged:
            return "APPLIED"
        if applied_staged == applied_paths:
            return "STAGED"
        return "PARTIALLY_STAGED"

    # -- helpers ------------------------------------------------------------

    def _require_change_set(self, project_id: str, run_id: str, change_set_id: str) -> dict:
        change_set = self._change_sets.get_for_run(run_id, change_set_id)
        if change_set is None or change_set["projectId"] != project_id:
            raise RuntimeContractError(
                "KNOWLEDGE_CHANGE_SET_NOT_FOUND_IN_RUN",
                "变更集不在该项目或 Run 中",
                status=404,
            )
        return change_set

    def _require_revision(self, change_set: dict, expected_revision: str) -> None:
        if change_set["revision"] != expected_revision:
            raise RuntimeContractError(
                "KNOWLEDGE_REVISION_CONFLICT",
                "变更集 revision 已变化，请刷新后重试",
                status=409,
                details={"expected": expected_revision, "actual": change_set["revision"]},
            )

    def _require_repository_revision(
        self, change_set: dict, expected_repository_revision: str
    ) -> dict:
        repository = self._repositories.get(change_set["repositoryId"])
        if repository is None:
            raise RuntimeContractError("KNOWLEDGE_REPOSITORY_NOT_FOUND", "仓库不存在", status=404)
        if repository["revision"] != expected_repository_revision:
            raise RuntimeContractError(
                "KNOWLEDGE_REVISION_CONFLICT",
                "仓库 revision 已变化，请刷新后重试",
                status=409,
                details={
                    "expected": expected_repository_revision,
                    "actual": repository["revision"],
                },
            )
        return repository

    def _runner_job(self, change_set: dict, job_id: str) -> dict | None:
        job = self._runner_job_by_id(job_id)
        if job is None:
            return None
        if job["purpose"] != "knowledge-change-set-generation" or job["ownerId"] != change_set["id"]:
            return None
        return job

    def _runner_job_by_id(self, job_id: str) -> dict | None:
        return self._agent_jobs_repository().get(job_id)

    def _output_events(self, job_id: str, after_sequence: int) -> list[dict]:
        return self._agent_jobs_repository().list_output(job_id, after_sequence=after_sequence)

    def _agent_jobs_repository(self):
        from workflow_platform.persistence.repositories import AgentJobRepository

        return AgentJobRepository(self._db)

    def _approval_binding(self, change_set: dict) -> dict:
        artifacts = self._change_set_artifacts.list_for_change_set(change_set["id"])
        snapshot = self._snapshots.get(change_set["ruleSnapshotId"])
        file_changes = self._file_changes.list_for_change_set(change_set["id"])
        import hashlib

        diff_hash = change_set.get("unifiedDiffHash") or "" 
        return {
            "artifactHashes": [item["contentHash"] for item in artifacts],
            "ruleSnapshotHash": snapshot["contentHash"] if snapshot else "",
            "targetHashes": [
                hashlib.sha256(
                    Path(change["proposedContentUri"]).read_bytes()
                ).hexdigest()
                for change in file_changes
            ],
            "baseHeadCommit": change_set["baseHeadCommit"],
            "unifiedDiffHash": diff_hash,
        }

    def _detail(self, change_set: dict) -> dict:
        change_set_id = change_set["id"]
        repository = self._repositories.get(change_set["repositoryId"])
        snapshot = self._snapshots.get(change_set["ruleSnapshotId"])
        file_changes = self._file_changes.list_for_change_set(change_set_id)
        validations = self._validations.list_for_change_set(change_set_id)
        artifacts = self._change_set_artifacts.list_for_change_set(change_set_id)
        approval = None
        if change_set.get("approvalId"):
            approval = self._approvals.get(change_set["approvalId"])
        job_id = change_set.get("agentJobId")
        output: list[dict] = []
        if job_id:
            job = self._runner_job(change_set, job_id)
            if job is not None:
                output = self._output_events(job_id, 0)
        return {
            **change_set,
            "sourceArtifacts": [
                {
                    "artifactId": item["artifactId"],
                    "projectId": change_set["projectId"],
                    "runId": item["runId"],
                    "nodeId": item["nodeId"],
                    "workflowVersionId": item["workflowVersionId"],
                    "type": item["type"],
                    "uri": item["uri"],
                    "contentHash": item["contentHash"],
                    "status": item["status"],
                }
                for item in artifacts
            ],
            "fileChanges": file_changes,
            "validationResults": validations,
            "unifiedDiff": self._read_diff_file(change_set.get("unifiedDiffUri")),
            "repository": {
                "id": repository["id"],
                "name": repository["name"],
                "rootPath": repository["rootPath"],
            }
            if repository
            else None,
            "ruleSnapshot": snapshot,
            "output": output,
            "approval": approval,
            "allowedActions": self._allowed_actions(change_set),
        }

    def _read_diff_file(self, uri: str | None) -> str | None:
        if not uri:
            return None
        try:
            return Path(uri).read_text(encoding="utf-8")
        except OSError:
            return None

    def _allowed_actions(self, change_set: dict) -> list[str]:
        status = change_set["status"]
        if status == "DRAFT":
            return ["generate", "abandon"]
        if status == "READY_TO_APPLY":
            return ["apply", "abandon"]
        if status == "AWAITING_APPROVAL":
            return ["approve", "reject", "abandon"]
        if status == "APPROVED":
            return ["apply", "abandon"]
        if status in {"APPLIED", "PARTIALLY_STAGED", "STAGED"}:
            return ["stage", "unstage", "commit", "abandon"]
        if status in {"GENERATING", "APPLYING"}:
            return []
        if status == "BLOCKED":
            return ["abandon"]
        if status == "STALE":
            return ["abandon"]
        return []

    def _check_baseline(self, change_set: dict) -> None:
        """Light baseline check; marks STALE inside the current transaction."""
        repository = self._repositories.get(change_set["repositoryId"])
        if repository is None:
            return
        root = Path(repository["rootPath"])
        try:
            inspection = self._gateway.inspect(root)
        except Exception:
            return
        applied_family = {
            "APPLIED",
            "PARTIALLY_STAGED",
            "STAGED",
            "COMMITTED",
        }
        changed: list[str] = []
        if inspection.headCommit != change_set["baseHeadCommit"]:
            changed.append("head")
        if (
            change_set["status"] not in applied_family
            and inspection.worktreeFingerprint != change_set["baseWorkingTreeFingerprint"]
        ):
            changed.append("worktree")
        if change_set["status"] not in applied_family:
            for change in self._file_changes.list_for_change_set(change_set["id"]):
                if change["operation"] != "UPDATE":
                    continue
                path = root / change["path"]
                if path.is_file() and change.get("beforeHash") and hash_artifact(path) != change["beforeHash"]:
                    changed.append(change["path"])
        snapshot = self._snapshots.get(change_set["ruleSnapshotId"])
        if snapshot is not None:
            for rule_file in snapshot.get("discoveredFiles") or []:
                path = root / rule_file["path"]
                if path.is_file() and hash_artifact(path) != rule_file["hash"]:
                    changed.append(f"rule:{rule_file['path']}")
        if changed:
            now = _now()
            self._change_sets.mark_stale(change_set["id"], updated_at=now)
            approval = self._approvals.get_for_change_set(change_set["id"])
            if approval is not None and not approval["invalidatedAt"]:
                self._approvals.invalidate(approval["id"], invalidated_at=now, reason="基线变化")
            self._audit.record(
                actor=_system_actor(),
                action="knowledge.change_set.invalidated",
                resource=f"run:{change_set['runId']}",
                detail={"changeSetId": change_set["id"], "changed": changed},
                created_at=now,
            )
            self._db.commit()

    def _snapshot_summary(self, snapshot: dict) -> dict:
        return {
            "id": snapshot["id"],
            "summary": snapshot["summary"],
            "writablePaths": snapshot["writablePaths"],
            "protectedPaths": snapshot["protectedPaths"],
            "indexFiles": snapshot["indexFiles"],
            "routingFiles": snapshot["routingFiles"],
            "templateFiles": snapshot["templateFiles"],
            "validationCommands": snapshot["validationCommands"],
        }

    def _artifact_summaries(self, change_set_id: str) -> list[dict]:
        return [
            {
                "artifactId": item["artifactId"],
                "type": item["type"],
                "path": f"input/artifacts/{re.sub(r'[^A-Za-z0-9._-]', '_', item['artifactId'])}",
                "contentHash": item["contentHash"],
                "summary": None,
            }
            for item in self._change_set_artifacts.list_for_change_set(change_set_id)
        ]

    def _copy_target_files(
        self,
        repository_root: Path,
        snapshot: dict,
        input_root: Path,
        manifest_entries: list[dict],
    ) -> None:
        import os

        import fnmatch

        writable = snapshot.get("writablePaths") or []
        target_root = input_root / "target"
        target_root.mkdir(parents=True, exist_ok=True)
        count = 0
        total_bytes = 0
        for current, dirs, files in os.walk(repository_root):
            current_path = Path(current)
            if current_path != repository_root:
                depth = len(current_path.relative_to(repository_root).parts)
                if depth >= 4:
                    dirs[:] = []
            dirs[:] = [d for d in dirs if d not in {".git", "node_modules", ".venv", "__pycache__"}]
            for file_name in files:
                if count >= 100:
                    return
                relative = (
                    current_path.relative_to(repository_root).as_posix() + "/" + file_name
                    if current_path != repository_root
                    else file_name
                )
                if not any(fnmatch.fnmatch(relative, pattern) for pattern in writable):
                    continue
                source = current_path / file_name
                stat = source.stat()
                if stat.st_size > 2 * 1024 * 1024:
                    continue
                total_bytes += stat.st_size
                if total_bytes > MAX_TARGET_TOTAL_BYTES:
                    return
                destination = target_root / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                manifest_entries.append(
                    {
                        "path": destination.relative_to(self._jobs_root).as_posix(),
                        "source": "target-file",
                        "sizeBytes": stat.st_size,
                        "sha256": hash_artifact(source),
                    }
                )
                count += 1

    def _read_analysis_manifest(self, analysis_root: Path) -> dict | None:
        manifest_path = analysis_root / "input" / "manifest.json"
        if not manifest_path.exists():
            return None
        try:
            return json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None


def _system_actor() -> dict:
    return {"id": "runtime", "type": "system", "source": "runtime", "trusted": True}
