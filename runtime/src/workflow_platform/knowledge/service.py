from __future__ import annotations

import sqlite3
import re
from threading import RLock
from typing import Literal
from uuid import uuid4

from workflow_platform.governance.actors import require_trusted_actor, require_trusted_human
from workflow_platform.governance.audit import AuditLog
from workflow_platform.persistence.repositories import KnowledgeRepository


class LocalKnowledgeService:
    def __init__(
        self,
        db: sqlite3.Connection,
        audit_log: AuditLog,
        *,
        lock: RLock | None = None,
    ) -> None:
        self._db = db
        self._repository = KnowledgeRepository(db)
        self._audit_log = audit_log
        self._lock = lock or RLock()

    def create_candidate(
        self,
        *,
        title: str,
        content: str,
        source: str,
        actor: dict,
        now: str,
    ) -> dict:
        actor_model = require_trusted_actor(actor)
        title = _required_text(title, "标题")
        content = _required_text(content, "内容")
        source = _required_text(source, "来源")
        candidate_id = f"knowledge-candidate-{uuid4()}"
        with self._write_transaction():
            candidate = self._repository.create_candidate(
                id=candidate_id,
                title=title,
                content=content,
                source=source,
                actor=actor_model,
                created_at=now,
            )
            self._audit_log.record(
                actor=actor_model,
                action="knowledge.candidate.created",
                resource=f"knowledge-candidate:{candidate_id}",
                detail={"title": title, "source": source},
                created_at=now,
            )
            return candidate

    def list_candidates(self, *, status: str | None = None) -> list[dict]:
        if status is not None and status not in {"pending", "approved", "rejected"}:
            raise ValueError("KNOWLEDGE_STATUS_INVALID: 知识候选状态筛选无效。")
        return self._repository.list_candidates(status=status)

    def review(
        self,
        candidate_id: str,
        *,
        reviewer: str,
        decision: Literal["approved", "rejected"],
    ) -> dict:
        raise ValueError("KNOWLEDGE_LEGACY_API_UNSUPPORTED: 请通过受信人工操作者审核知识候选。")

    def review_candidate(
        self,
        candidate_id: str,
        *,
        decision: Literal["approved", "rejected"],
        actor: dict,
        comment: str | None,
        now: str,
    ) -> dict:
        reviewer = require_trusted_human(actor, operation="审核知识候选")
        if decision not in {"approved", "rejected"}:
            raise ValueError("KNOWLEDGE_REVIEW_INVALID: 审核决定只能是 approved 或 rejected。")
        comment = comment.strip() if comment else None
        with self._write_transaction():
            candidate = self._require_candidate(candidate_id)
            if candidate["status"] != "pending":
                raise ValueError("KNOWLEDGE_REVIEW_CONFLICT: 知识候选已审核，不能重复审核。")
            reviewed = self._repository.review_candidate(
                candidate_id,
                decision=decision,
                reviewer=reviewer,
                comment=comment,
                reviewed_at=now,
            )
            self._audit_log.record(
                actor=reviewer,
                action="knowledge.candidate.reviewed",
                resource=f"knowledge-candidate:{candidate_id}",
                detail={"decision": decision, "comment": comment},
                created_at=now,
            )
            return reviewed

    def publish_candidate(
        self,
        candidate_id: str,
        *,
        actor: dict,
        now: str,
        content_override: str | None = None,
    ) -> dict:
        publisher = require_trusted_human(actor, operation="发布知识候选")
        if content_override is not None:
            content_override = _required_text(content_override, "合成内容")
        with self._write_transaction():
            candidate = self._require_candidate(candidate_id)
            if candidate["status"] != "approved":
                raise ValueError("KNOWLEDGE_CANDIDATE_NOT_APPROVED: 知识候选尚未通过审核。")
            if self._repository.has_publication(candidate_id):
                raise ValueError("KNOWLEDGE_ALREADY_PUBLISHED: 知识候选已经发布。")
            document = self._repository.create_document(
                id=f"knowledge-document-{uuid4()}",
                candidate=candidate,
                publisher=publisher,
                published_at=now,
                content=content_override,
            )
            self._repository.create_publication(
                id=f"knowledge-publication-{uuid4()}",
                candidate_id=candidate_id,
                document_id=document["id"],
                publisher=publisher,
                published_at=now,
            )
            self._repository.mark_published(candidate_id, published_at=now)
            self._audit_log.record(
                actor=publisher,
                action="knowledge.candidate.published",
                resource=f"knowledge-candidate:{candidate_id}",
                detail={"documentId": document["id"]},
                created_at=now,
            )
            return document

    def get_candidate(self, candidate_id: str) -> dict:
        return self._require_candidate(candidate_id)

    def search(self, query: str) -> list[dict]:
        query = _required_text(query, "搜索关键词")
        return self._repository.search_documents(query)

    def list_documents(self) -> list[dict]:
        return self._repository.list_documents()

    def replay_document(self, document_id: str) -> dict:
        document = self._repository.get_document(document_id)
        if document is None:
            raise KeyError(f"KNOWLEDGE_DOCUMENT_NOT_FOUND: 未找到知识文档 {document_id}。")
        candidate = self._repository.get_candidate(document["candidateId"])
        if candidate is None:
            raise RuntimeError("KNOWLEDGE_REPLAY_INVALID: 已发布知识缺少来源候选。")
        audit_records = self._audit_log.list(
            resource=f"knowledge-candidate:{candidate['id']}",
            limit=200,
        )
        audit_records.extend(
            self._audit_log.list(
                resource=f"knowledge-document:{document_id}",
                limit=200,
            ),
        )
        return {
            "document": document,
            "candidate": candidate,
            "auditRecords": audit_records,
        }

    def export_document(self, document_id: str) -> dict:
        replay = self.replay_document(document_id)
        document = replay["document"]
        candidate = replay["candidate"]
        lines = [
            f"# {document['title']}",
            "",
            f"- 文档标识：{document['id']}",
            f"- 来源：{document['source']}",
            f"- 发布时间：{document['publishedAt']}",
            f"- 审核意见：{candidate.get('reviewComment') or '无'}",
            "",
            "## 知识内容",
            "",
            document["content"],
            "",
        ]
        return {
            "fileName": f"{document['id']}.md",
            "mediaType": "text/markdown",
            "content": "\n".join(lines),
        }

    def record_git_publication(
        self,
        document_id: str,
        *,
        branch: str,
        relative_path: str,
        commit_hash: str,
        actor: dict,
        now: str,
    ) -> dict:
        publisher = require_trusted_human(actor, operation="记录知识 Git 发布")
        document = self._repository.get_document(document_id)
        if document is None:
            raise KeyError(f"KNOWLEDGE_DOCUMENT_NOT_FOUND: 未找到知识文档 {document_id}。")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", branch):
            raise ValueError("KNOWLEDGE_GIT_BRANCH_INVALID: Git 分支名称无效。")
        expected_relative_path = f".workflow-platform/knowledge/{document_id}.md"
        if relative_path != expected_relative_path:
            raise ValueError("KNOWLEDGE_GIT_PATH_INVALID: 知识 Git 路径不受支持。")
        if not re.fullmatch(r"[0-9a-fA-F]{7,64}", commit_hash):
            raise ValueError("KNOWLEDGE_GIT_COMMIT_INVALID: Git 提交哈希无效。")
        with self._write_transaction():
            publication = self._repository.record_git_publication(
                id=f"knowledge-git-publication-{uuid4()}",
                document_id=document_id,
                branch=branch,
                relative_path=relative_path,
                commit_hash=commit_hash,
                pushed_at=now,
            )
            self._audit_log.record(
                actor=publisher,
                action="knowledge.document.git_published",
                resource=f"knowledge-document:{document_id}",
                detail={
                    "branch": branch,
                    "relativePath": relative_path,
                    "commitHash": commit_hash,
                },
                created_at=now,
            )
        return {"documentId": document_id, **publication}

    def _require_candidate(self, candidate_id: str) -> dict:
        candidate = self._repository.get_candidate(candidate_id)
        if candidate is None:
            raise KeyError(f"KNOWLEDGE_CANDIDATE_NOT_FOUND: 未找到知识候选 {candidate_id}。")
        return candidate

    def _write_transaction(self):
        return _KnowledgeTransaction(self._db, self._lock)


class _KnowledgeTransaction:
    def __init__(self, db: sqlite3.Connection, lock: RLock) -> None:
        self._db = db
        self._lock = lock

    def __enter__(self) -> None:
        self._lock.acquire()
        self._db.execute("BEGIN IMMEDIATE")

    def __exit__(self, exception_type, _exception, _traceback) -> None:
        try:
            if exception_type is None:
                self._db.commit()
            elif self._db.in_transaction:
                self._db.rollback()
        finally:
            self._lock.release()


def _required_text(value: str, name: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"KNOWLEDGE_INPUT_INVALID: {name}不能为空。")
    return normalized
