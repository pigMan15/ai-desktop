"""Knowledge repository service (document sections 5.1, 6, 27.1-27.2, 27.6, 31.1).

Owns repository import/removal, rule discovery jobs, snapshot confirmation,
settings and read-only repository Git status/diff.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from threading import RLock
from uuid import uuid4

from workflow_platform.governance.actors import require_trusted_human
from workflow_platform.governance.audit import AuditLog
from workflow_platform.knowledge.agent_runner import KnowledgeAgentRunner
from workflow_platform.knowledge.git_gateway import (
    KnowledgeGitError,
    KnowledgeGitGateway,
    repository_identity,
    validate_repository_relative_path,
)
from workflow_platform.knowledge.proposal import (
    KnowledgeProposalError,
    is_protected,
    is_writable,
    validate_rule_discovery_output,
)
from workflow_platform.knowledge.prompts import build_rule_discovery_prompt
from workflow_platform.knowledge.rule_discovery import (
    KnowledgeRuleDiscoveryError,
    build_rule_discovery_analysis,
    deterministic_scan,
    parse_knowledge_repo_manifest,
    reread_rule_files,
    snapshot_content_hash,
)
from workflow_platform.persistence.knowledge_repositories import (
    KnowledgeChangeSetRepository,
    KnowledgeRepositoryRepository,
    KnowledgeRuleSnapshotRepository,
)
from workflow_platform.runtime_errors import RuntimeContractError


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _next_revision(revision: str) -> str:
    try:
        return str(int(revision) + 1)
    except ValueError:
        return f"{revision}.1"


class KnowledgeRepositoryService:
    def __init__(
        self,
        *,
        db: sqlite3.Connection,
        lock: RLock,
        audit: AuditLog,
        agent_runner: KnowledgeAgentRunner,
        jobs_root: Path,
        gateway: KnowledgeGitGateway | None = None,
    ) -> None:
        self._db = db
        self._lock = lock
        self._audit = audit
        self._runner = agent_runner
        self._jobs_root = jobs_root
        self._gateway = gateway or KnowledgeGitGateway()
        self._repositories = KnowledgeRepositoryRepository(db)
        self._snapshots = KnowledgeRuleSnapshotRepository(db)
        self._change_sets = KnowledgeChangeSetRepository(db)

    # -- import / remove ----------------------------------------------------

    def import_repository(
        self, *, name: str, root_path: str, auto_apply_low_risk: bool, actor: dict, now: str
    ) -> dict:
        require_trusted_human(actor, operation="导入本地知识库")
        if not name or not name.strip():
            raise RuntimeContractError("KNOWLEDGE_INPUT_INVALID", "仓库名称不能为空", status=400)
        root = Path(root_path).resolve()
        if not root.is_dir():
            raise RuntimeContractError("KNOWLEDGE_INPUT_INVALID", "目录不存在", status=400)
        try:
            inspection = self._gateway.inspect(root)
        except Exception as error:
            raise RuntimeContractError(
                "KNOWLEDGE_REPOSITORY_NOT_GIT",
                f"目录不是有效的 Git 工作树: {error}",
                status=400,
            ) from error
        canonical = str(Path(inspection.rootPath).resolve())
        if canonical != str(root):
            raise RuntimeContractError(
                "KNOWLEDGE_REPOSITORY_NOT_GIT", "导入路径必须是 Git 工作树根目录", status=400
            )
        identity = repository_identity(canonical, inspection.commonDir)
        repository_id = f"knowledge-repository-{uuid4()}"

        with self._lock, self._db:
            existing = self._repositories.get_by_canonical_root(canonical)
            if existing is not None and existing["status"] != "REMOVED":
                raise RuntimeContractError(
                    "KNOWLEDGE_REPOSITORY_DUPLICATE",
                    "该目录已绑定知识库",
                    status=409,
                    details={"repositoryId": existing["id"]},
                )
            if existing is not None:
                repository_id = existing["id"]
                self._repositories.restore_removed(
                    repository_id,
                    status="RULES_PENDING",
                    revision=_next_revision(existing["revision"]),
                    updated_at=now,
                )
                self._repositories.update_head(
                    repository_id,
                    head_commit=inspection.headCommit,
                    current_branch=inspection.branch,
                    updated_at=now,
                )
                self._repositories.update_settings(
                    repository_id, auto_apply_low_risk=auto_apply_low_risk, updated_at=now
                )
                for snapshot in self._snapshots.list_for_repository(repository_id, limit=100):
                    if snapshot["status"] == "CONFIRMED":
                        self._snapshots.mark_stale(snapshot["id"], updated_at=now)
            else:
                self._repositories.create(
                    id=repository_id,
                    name=name,
                    root_path=canonical,
                    canonical_root_path=canonical,
                    repository_identity=identity,
                    current_branch=inspection.branch,
                    head_commit=inspection.headCommit,
                    auto_apply_low_risk=auto_apply_low_risk,
                    status="RULES_PENDING",
                    revision="1",
                    created_at=now,
                    updated_at=now,
                )
            self._audit.record(
                actor=actor,
                action="knowledge.repository.imported",
                resource=f"knowledge-repository:{repository_id}",
                detail={"canonicalRootPath": canonical},
                created_at=now,
            )
            self._db.commit()
        return self._detail(repository_id)

    def remove_repository(
        self, repository_id: str, *, actor: dict, expected_revision: str, now: str
    ) -> dict:
        require_trusted_human(actor, operation="移除知识库绑定")
        with self._lock, self._db:
            repository = self._require_repository(repository_id)
            self._require_revision(repository, expected_revision)
            active = self._runner.active_count("knowledge-rule-discovery")
            if active > 0:
                raise RuntimeContractError(
                    "KNOWLEDGE_REPOSITORY_BUSY", "存在运行中的规则发现任务，禁止移除", status=423
                )
            self._repositories.mark_removed(
                repository_id, removed_at=now, updated_at=now
            )
            self._repositories.update_revision(
                repository_id, revision=_next_revision(repository["revision"]), updated_at=now
            )
            self._audit.record(
                actor=actor,
                action="knowledge.repository.removed",
                resource=f"knowledge-repository:{repository_id}",
                detail={},
                created_at=now,
            )
            self._db.commit()
        return self._detail(repository_id)

    # -- rule discovery -----------------------------------------------------

    def discover_rules(
        self,
        repository_id: str,
        *,
        provider: str,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="发现知识库规则")
        if provider not in {"codex", "claude", "fake"}:
            raise RuntimeContractError("KNOWLEDGE_INPUT_INVALID", f"provider 无效: {provider}", status=400)
        with self._lock, self._db:
            repository = self._require_repository(repository_id)
            self._require_revision(repository, expected_revision)
            if repository["status"] == "REMOVED":
                raise RuntimeContractError("KNOWLEDGE_REPOSITORY_DUPLICATE", "仓库已移除", status=409)
            root = Path(repository["rootPath"])
        manifest: dict | None = None
        manifest_path = root / ".ai-workflow" / "knowledge-repo.yaml"
        if manifest_path.is_file():
            try:
                manifest = parse_knowledge_repo_manifest(
                    manifest_path.read_text(encoding="utf-8"), root
                )
            except KnowledgeRuleDiscoveryError as error:
                raise RuntimeContractError(error.code, error.message, status=error.status) from error

        scan = deterministic_scan(root, manifest)
        job_id = f"knowledge-job-{uuid4()}"
        analysis_root = self._jobs_root / job_id
        build_rule_discovery_analysis(analysis_root, root, scan, now=now)
        prompt = build_rule_discovery_prompt(
            manifest=manifest,
            scan_summary={"count": scan["count"], "files": scan["files"]},
            delivery="path",
        )
        queued = self._runner.start_rule_discovery(
            job_id=job_id,
            repository_id=repository_id,
            provider=provider,
            analysis_root=analysis_root,
            prompt=prompt,
            now=now,
        )
        return {
            "jobId": queued["jobId"],
            "repositoryId": repository_id,
            "status": queued["status"],
        }

    def get_rule_discovery_job(self, repository_id: str, job_id: str) -> dict:
        with self._lock, self._db:
            job = self._require_rule_discovery_job(repository_id, job_id)
            return self._rule_discovery_job_detail(job)

    def list_rule_discovery_output(
        self, repository_id: str, job_id: str, *, after_sequence: int
    ) -> list[dict]:
        with self._lock, self._db:
            self._require_rule_discovery_job(repository_id, job_id)
            from workflow_platform.persistence.repositories import AgentJobRepository

            return AgentJobRepository(self._db).list_output(job_id, after_sequence=after_sequence)

    def cancel_rule_discovery(
        self,
        repository_id: str,
        job_id: str,
        *,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="取消规则发现")
        with self._lock, self._db:
            repository = self._require_repository(repository_id)
            self._require_revision(repository, expected_revision)
            job = self._require_rule_discovery_job(repository_id, job_id)
        self._runner.cancel(job_id, actor=actor, now=now)
        return self._rule_discovery_job_detail(job)

    def confirm_rule_snapshot(
        self,
        repository_id: str,
        snapshot_id: str,
        *,
        payload: dict,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="确认知识库规则快照")
        with self._lock, self._db:
            repository = self._require_repository(repository_id)
            self._require_revision(repository, expected_revision)
            snapshot = self._snapshots.get(snapshot_id)
            if snapshot is None or snapshot["repositoryId"] != repository_id:
                raise RuntimeContractError("KNOWLEDGE_RULES_NOT_CONFIRMED", "快照不存在", status=404)
            if snapshot["status"] != "PROPOSED":
                raise RuntimeContractError(
                    "KNOWLEDGE_RULES_NOT_CONFIRMED",
                    f"只有 PROPOSED 快照可以确认（当前 {snapshot['status']}）",
                    status=409,
                )
            open_questions = payload.get("openQuestions") or []
            if open_questions:
                raise RuntimeContractError(
                    "KNOWLEDGE_RULES_NOT_CONFIRMED", "存在未确定项，禁止确认", status=409
                )
            root = Path(repository["rootPath"])
            writable = [p for p in payload.get("writablePaths") or [] if isinstance(p, str)]
            protected = [p for p in payload.get("protectedPaths") or [] if isinstance(p, str)]
            index_files = [p for p in payload.get("indexFiles") or [] if isinstance(p, str)]
            routing_files = [p for p in payload.get("routingFiles") or [] if isinstance(p, str)]
            template_files = [p for p in payload.get("templateFiles") or [] if isinstance(p, str)]
            validation_commands = [
                p for p in payload.get("validationCommands") or [] if isinstance(p, str)
            ]
            summary = str(payload.get("summary") or "")
            discovered = snapshot.get("discoveredFiles") or []
            refreshed = reread_rule_files(root, discovered)
            rule_files = [
                {
                    "id": f"{snapshot_id}:rule-file:{index}",
                    "relativePath": entry["path"],
                    "category": entry["category"],
                    "contentHash": entry.get("sha256") or entry["hash"],
                    "sizeBytes": entry.get("sizeBytes") or 0,
                    "purpose": entry.get("purpose", ""),
                }
                for index, entry in enumerate(refreshed)
                if entry.get("status") not in {"missing", "unreadable"}
            ]
            finalized_snapshot = {
                "repositoryId": repository_id,
                "headCommit": snapshot["headCommit"],
                "discoveredFiles": [
                    {
                        "path": entry["path"],
                        "category": entry["category"],
                        "hash": entry.get("sha256") or entry["hash"],
                        "sizeBytes": entry.get("sizeBytes") or 0,
                        "purpose": entry.get("purpose", ""),
                    }
                    for entry in refreshed
                    if entry.get("status") not in {"missing", "unreadable"}
                ],
                "writablePaths": writable,
                "protectedPaths": protected,
                "indexFiles": index_files,
                "routingFiles": routing_files,
                "templateFiles": template_files,
                "validationCommands": validation_commands,
                "summary": summary,
                "openQuestions": [],
                "source": snapshot["source"],
                "status": "CONFIRMED",
            }
            content_hash = snapshot_content_hash(finalized_snapshot)
            for old_snapshot in self._snapshots.list_for_repository(repository_id, limit=100):
                if old_snapshot["status"] == "CONFIRMED":
                    self._snapshots.mark_superseded(old_snapshot["id"], updated_at=now)
            self._snapshots.update_revision(
                snapshot_id, revision=_next_revision(snapshot["revision"]), updated_at=now
            )
            self._snapshots.update_confirmed_content(
                snapshot_id,
                writable_paths=writable,
                protected_paths=protected,
                index_files=index_files,
                routing_files=routing_files,
                template_files=template_files,
                validation_commands=validation_commands,
                summary=summary,
                content_hash=content_hash,
                updated_at=now,
            )
            self._snapshots.mark_confirmed(
                snapshot_id,
                confirmed_by=actor,
                confirmed_at=now,
                status="CONFIRMED",
                updated_at=now,
            )
            self._snapshots.delete_rule_files(snapshot_id)
            self._snapshots.create_rule_files(snapshot_id, rule_files)
            self._repositories.set_active_snapshot(repository_id, snapshot_id=snapshot_id, updated_at=now)
            self._repositories.set_status(repository_id, status="ACTIVE", updated_at=now)
            self._repositories.update_revision(
                repository_id, revision=_next_revision(repository["revision"]), updated_at=now
            )
            self._audit.record(
                actor=actor,
                action="knowledge.repository.rules_confirmed",
                resource=f"knowledge-repository:{repository_id}",
                detail={"snapshotId": snapshot_id, "contentHash": content_hash},
                created_at=now,
            )
            self._db.commit()
        return self._detail(repository_id)

    # -- settings / read-only git -------------------------------------------

    def update_settings(
        self, repository_id: str, *, auto_apply_low_risk: bool, actor: dict, expected_revision: str, now: str
    ) -> dict:
        require_trusted_human(actor, operation="更新知识库设置")
        with self._lock, self._db:
            repository = self._require_repository(repository_id)
            self._require_revision(repository, expected_revision)
            self._repositories.update_settings(
                repository_id, auto_apply_low_risk=auto_apply_low_risk, updated_at=now
            )
            self._repositories.update_revision(
                repository_id, revision=_next_revision(repository["revision"]), updated_at=now
            )
            self._audit.record(
                actor=actor,
                action="knowledge.repository.settings_updated",
                resource=f"knowledge-repository:{repository_id}",
                detail={"autoApplyLowRisk": auto_apply_low_risk},
                created_at=now,
            )
            self._db.commit()
        return self._detail(repository_id)

    def git_status(self, repository_id: str) -> dict:
        with self._lock:
            repository = self._require_repository(repository_id)
        inspection = self._gateway.inspect(Path(repository["rootPath"]))
        return self._git_status_dict(inspection)

    def git_diff(self, repository_id: str, *, staged: bool) -> dict:
        with self._lock:
            repository = self._require_repository(repository_id)
        diff = self._gateway.diff(Path(repository["rootPath"]), staged=staged)
        return {"diff": diff}

    # -- candidate promotion ------------------------------------------------

    def list_candidate_knowledge(self, repository_id: str) -> dict:
        with self._lock:
            repository = self._require_repository(repository_id)
        root = Path(repository["rootPath"])
        candidate_root = root / "candidate"
        items: list[dict] = []
        if candidate_root.is_dir():
            for path in sorted(candidate_root.rglob("*.md")):
                if not path.is_file():
                    continue
                relative = path.relative_to(root).as_posix()
                items.append(
                    {
                        "path": relative,
                        "title": _frontmatter_title(path),
                        "sizeBytes": path.stat().st_size,
                    }
                )
        return {"items": items}

    def promote_candidate_knowledge(
        self,
        repository_id: str,
        *,
        path: str,
        target_path: str,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="转正候选知识")
        with self._lock, self._db:
            repository = self._require_repository(repository_id)
            self._require_revision(repository, expected_revision)
            if repository["status"] != "ACTIVE":
                raise RuntimeContractError("KNOWLEDGE_RULES_NOT_CONFIRMED", "仓库未激活，无法转正", status=409)
            try:
                source = validate_repository_relative_path(path)
                target = validate_repository_relative_path(target_path)
            except KnowledgeGitError as error:
                raise RuntimeContractError("KNOWLEDGE_INPUT_INVALID", error.message, status=400) from error
            if source == target:
                raise RuntimeContractError("KNOWLEDGE_PROMOTE_INVALID", "源与目标路径相同", status=400)
            if not source.startswith("candidate/"):
                raise RuntimeContractError("KNOWLEDGE_PROMOTE_INVALID", "只能转正 candidate/** 下的知识", status=400)
            root = Path(repository["rootPath"])
            source_path = root / source
            target_path_resolved = root / target
            if not source_path.is_file():
                raise RuntimeContractError("KNOWLEDGE_PROMOTE_INVALID", f"候选知识不存在: {source}", status=404)
            if target_path_resolved.exists():
                raise RuntimeContractError("KNOWLEDGE_PROMOTE_INVALID", f"目标已存在: {target}", status=409)
            snapshot = (
                self._snapshots.get(repository["activeRuleSnapshotId"])
                if repository["activeRuleSnapshotId"]
                else None
            )
            if snapshot is not None:
                writable = snapshot.get("writablePaths") or []
                protected = snapshot.get("protectedPaths") or []
                if not is_writable(target, writable):
                    raise RuntimeContractError("KNOWLEDGE_PROMOTE_INVALID", f"目标不在可写目录: {target}", status=400)
                if is_protected(target, protected):
                    raise RuntimeContractError("KNOWLEDGE_PROMOTE_INVALID", f"目标是受保护路径: {target}", status=400)
            original = source_path.read_text(encoding="utf-8")
            promoted = _promote_frontmatter_status(original)
            target_path_resolved.parent.mkdir(parents=True, exist_ok=True)
            target_path_resolved.write_text(promoted, encoding="utf-8", newline="\n")
            source_path.unlink()
            index_updated = False
            index_path = root / "INDEX.md"
            original_index: str | None = None
            if index_path.is_file():
                index_text = index_path.read_text(encoding="utf-8")
                original_index = index_text
                updated = index_text.replace(f"]({source})", f"]({target})")
                if updated != index_text:
                    index_path.write_text(updated, encoding="utf-8", newline="\n")
                    index_updated = True
            commit_paths = [target, source]
            if index_updated:
                commit_paths.append("INDEX.md")
            self._gateway.stage(root, commit_paths)
            try:
                commit = self._gateway.commit(
                    root,
                    title=f"promote: {Path(target).name} from candidate",
                    body="",
                    paths=commit_paths,
                )
            except KnowledgeGitError as error:
                target_path_resolved.unlink(missing_ok=True)
                source_path.parent.mkdir(parents=True, exist_ok=True)
                source_path.write_text(original, encoding="utf-8", newline="\n")
                if index_updated and original_index is not None:
                    index_path.write_text(original_index, encoding="utf-8", newline="\n")
                raise RuntimeContractError(
                    "KNOWLEDGE_PROMOTE_GIT_FAILED", f"提交失败，已回滚: {error.message}", status=500
                ) from error
            self._repositories.update_revision(
                repository_id,
                revision=_next_revision(repository["revision"]),
                updated_at=now,
            )
            self._audit.record(
                actor=actor,
                action="knowledge.repository.knowledge_promoted",
                resource=f"knowledge-repository:{repository_id}",
                detail={
                    "source": source,
                    "target": target,
                    "indexUpdated": index_updated,
                    "commitHash": commit.commitHash,
                },
                created_at=now,
            )
            self._db.commit()
        return self._detail(repository_id)

    # -- examples -----------------------------------------------------------

    def list_examples(self) -> list[dict]:
        from workflow_platform.examples import knowledge as knowledge_examples

        return knowledge_examples.list_examples()

    def initialize_example(
        self,
        *,
        example_id: str,
        mode: str,
        target_path: str,
        initialize_git: bool,
        actor: dict,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="初始化知识库示例")
        from workflow_platform.examples import knowledge as knowledge_examples

        try:
            return knowledge_examples.initialize(
                example_id,
                mode=mode,
                target_path=target_path,
                initialize_git=initialize_git,
                now=now,
            )
        except ValueError as error:
            raise RuntimeContractError("KNOWLEDGE_INPUT_INVALID", str(error), status=400) from error

    # -- completion callback ------------------------------------------------

    def _on_job_completed(self, job_id: str, result, analysis_root: Path) -> None:
        with self._lock, self._db:
            from workflow_platform.persistence.repositories import AgentJobRepository

            job = AgentJobRepository(self._db).get(job_id)
            if job is None or job["purpose"] != "knowledge-rule-discovery":
                return
            repository_id = job["ownerId"]
            repository = self._repositories.get(repository_id)
            if repository is None or repository["status"] == "REMOVED":
                return
            if result.status != "COMPLETED":
                self._audit.record(
                    actor=_system_actor(),
                    action="knowledge.repository.rule_discovery_failed",
                    resource=f"knowledge-repository:{repository_id}",
                    detail={"jobId": job_id, "error": result.error},
                    created_at=_now(),
                )
                self._db.commit()
                return
            try:
                payload = json.loads(
                    (analysis_root / "output" / "rule-discovery.json").read_text(encoding="utf-8")
                )
                normalized = validate_rule_discovery_output(payload)
            except (OSError, json.JSONDecodeError, KnowledgeProposalError) as error:
                from workflow_platform.persistence.repositories import AgentJobRepository

                AgentJobRepository(self._db).finish(
                    id=job_id,
                    status="FAILED",
                    summary=None,
                    error="KNOWLEDGE_AGENT_OUTPUT_MISSING: 规则发现未生成有效输出文件",
                    updated_at=_now(),
                )
                self._audit.record(
                    actor=_system_actor(),
                    action="knowledge.repository.rule_discovery_blocked",
                    resource=f"knowledge-repository:{repository_id}",
                    detail={"jobId": job_id, "error": str(error)[:300]},
                    created_at=_now(),
                )
                self._db.commit()
                return

            root = Path(repository["rootPath"])
            snapshot_id = f"knowledge-rule-snapshot-{uuid4()}"
            discovered_files = self._collect_rule_files(root, normalized, snapshot_id)
            self._snapshots.create(
                id=snapshot_id,
                repository_id=repository_id,
                head_commit=self._gateway.inspect(root).headCommit,
                writable_paths=normalized["suggestedWritablePaths"],
                protected_paths=normalized["suggestedProtectedPaths"],
                index_files=normalized["indexFiles"],
                routing_files=normalized["routingFiles"],
                template_files=normalized["templateFiles"],
                validation_commands=normalized["suggestedValidationCommands"],
                summary=normalized["summary"],
                open_questions=normalized["openQuestions"],
                source="agent-discovery",
                content_hash="",
                revision="1",
                created_at=_now(),
                updated_at=_now(),
            )
            self._snapshots.create_rule_files(snapshot_id, discovered_files)
            content_hash = snapshot_content_hash(
                {
                    "repositoryId": repository_id,
                    "discoveredFiles": discovered_files,
                    "writablePaths": normalized["suggestedWritablePaths"],
                    "protectedPaths": normalized["suggestedProtectedPaths"],
                    "indexFiles": normalized["indexFiles"],
                    "routingFiles": normalized["routingFiles"],
                    "templateFiles": normalized["templateFiles"],
                    "validationCommands": normalized["suggestedValidationCommands"],
                    "summary": normalized["summary"],
                    "openQuestions": normalized["openQuestions"],
                    "source": "agent-discovery",
                }
            )
            self._snapshots.update_revision(snapshot_id, revision="2", updated_at=_now())
            self._snapshots.update_content_hash(
                snapshot_id, content_hash=content_hash, updated_at=_now()
            )
            self._snapshots.mark_confirmed(
                snapshot_id,
                confirmed_by={},
                confirmed_at=None,
                status="PROPOSED",
                updated_at=_now(),
            )
            self._audit.record(
                actor=_system_actor(),
                action="knowledge.repository.rule_discovery_completed",
                resource=f"knowledge-repository:{repository_id}",
                detail={"snapshotId": snapshot_id, "contentHash": content_hash},
                created_at=_now(),
            )
            self._db.commit()

    def _collect_rule_files(self, root: Path, normalized: dict, snapshot_id: str) -> list[dict]:
        import hashlib

        files: list[dict] = []
        for index, entry in enumerate(normalized["ruleFiles"]):
            path = root / entry["path"]
            if not path.is_file():
                continue
            content = path.read_bytes()
            files.append(
                {
                    "id": f"{snapshot_id}:rule-file:{index}",
                    "relativePath": entry["path"],
                    "category": entry["category"],
                    "contentHash": hashlib.sha256(content).hexdigest(),
                    "sizeBytes": len(content),
                    "purpose": entry.get("purpose", ""),
                }
            )
        return files

    # -- helpers ------------------------------------------------------------

    def _require_repository(self, repository_id: str) -> dict:
        repository = self._repositories.get(repository_id)
        if repository is None:
            raise RuntimeContractError("KNOWLEDGE_REPOSITORY_NOT_FOUND", "知识库不存在", status=404)
        return repository

    def _require_revision(self, repository: dict, expected_revision: str) -> None:
        if repository["revision"] != expected_revision:
            raise RuntimeContractError(
                "KNOWLEDGE_REVISION_CONFLICT",
                "仓库 revision 已变化，请刷新后重试",
                status=409,
                details={"expected": expected_revision, "actual": repository["revision"]},
            )

    def _require_rule_discovery_job(self, repository_id: str, job_id: str) -> dict:
        from workflow_platform.persistence.repositories import AgentJobRepository

        job = AgentJobRepository(self._db).get(job_id)
        if (
            job is None
            or job["purpose"] != "knowledge-rule-discovery"
            or job["ownerId"] != repository_id
        ):
            raise RuntimeContractError("KNOWLEDGE_AGENT_JOB_LOST", "规则发现任务不存在", status=404)
        return job

    def _rule_discovery_job_detail(self, job: dict) -> dict:
        return {
            "id": job["id"],
            "projectId": job["projectId"],
            "runId": job["runId"],
            "nodeId": job["nodeId"],
            "purpose": job["purpose"],
            "ownerId": job["ownerId"],
            "provider": job["provider"],
            "status": job["status"],
            "summary": job["summary"],
            "error": job["error"],
            "createdAt": job["createdAt"],
            "updatedAt": job["updatedAt"],
            "result": None,
        }

    def _detail(self, repository_id: str) -> dict:
        repository = self._require_repository(repository_id)
        try:
            inspection = self._gateway.inspect(Path(repository["rootPath"]))
            git_status = self._git_status_dict(inspection)
        except Exception:
            git_status = {
                "rootPath": repository["rootPath"],
                "commonDir": "",
                "branch": None,
                "headCommit": repository["headCommit"],
                "dirty": True,
                "conflict": False,
                "worktreeFingerprint": "",
                "stagedPaths": [],
                "unstagedPaths": [],
            }
        active_snapshot = None
        if repository["activeRuleSnapshotId"]:
            active_snapshot = self._snapshots.get(repository["activeRuleSnapshotId"])
        recent = self._change_sets.list_for_repository(repository_id, limit=5)
        recent_change_sets = [
            {
                "id": item["id"],
                "projectId": item["projectId"],
                "repositoryId": item["repositoryId"],
                "runId": item["runId"],
                "status": item["status"],
                "riskLevel": item["riskLevel"],
                "revision": item["revision"],
                "createdAt": item["createdAt"],
                "updatedAt": item["updatedAt"],
            }
            for item in recent
        ]
        return {
            **repository,
            "gitStatus": git_status,
            "activeRuleSnapshot": active_snapshot,
            "recentChangeSets": recent_change_sets[:5],
            "allowedActions": self._repository_allowed_actions(repository),
        }

    def _git_status_dict(self, inspection) -> dict:
        return {
            "rootPath": inspection.rootPath,
            "commonDir": inspection.commonDir,
            "branch": inspection.branch,
            "headCommit": inspection.headCommit,
            "dirty": inspection.dirty,
            "conflict": inspection.conflict,
            "worktreeFingerprint": inspection.worktreeFingerprint,
            "stagedPaths": inspection.stagedPaths,
            "unstagedPaths": inspection.unstagedPaths,
        }

    def _repository_allowed_actions(self, repository: dict) -> list[str]:
        if repository["status"] == "REMOVED":
            return []
        actions = ["discover-rules", "update-settings", "remove-repository"]
        if repository["status"] == "RULES_PENDING":
            actions.append("confirm-rules")
        return actions


def _frontmatter_title(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")[:4000]
    except OSError:
        return ""
    if not text.startswith("---"):
        return ""
    end = text.find("\n---", 3)
    if end == -1:
        return ""
    for line in text[3:end].splitlines():
        stripped = line.strip()
        if stripped.startswith("title:"):
            return stripped.split(":", 1)[1].strip().strip('"').strip("'")
    return ""


def _promote_frontmatter_status(content: str) -> str:
    import re

    return re.sub(r"(?m)^status:\s*candidate\s*$", "status: confirmed", content, count=1)


def _system_actor() -> dict:
    return {"id": "runtime", "type": "system", "source": "runtime", "trusted": True}
