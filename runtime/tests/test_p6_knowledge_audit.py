from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from workflow_platform.api.app import create_app
from workflow_platform.governance.audit import AuditLog
from workflow_platform.models import Actor
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService


NOW = "2026-07-28T10:00:00Z"
TRUSTED_HUMAN = {
    "id": "human-p6",
    "type": "human",
    "source": "runtime",
    "trusted": True,
}
TRUSTED_SYSTEM = {
    "id": "runtime-p6",
    "type": "system",
    "source": "runtime",
    "trusted": True,
}
UNTRUSTED_HUMAN = {
    "id": "human-untrusted",
    "type": "human",
    "source": "renderer",
    "trusted": False,
}


def make_service(tmp_path) -> WorkflowRuntimeService:
    db = connect(tmp_path / "p6-runtime.db")
    migrate(db)
    return WorkflowRuntimeService(db)


def test_knowledge_candidate_is_persisted_and_creation_is_audited(tmp_path) -> None:
    service = make_service(tmp_path)

    candidate = service.create_knowledge_candidate(
        title="发布前验证清单",
        content="发布前必须执行完整测试并保留结果。",
        source="run:run-123",
        actor=TRUSTED_SYSTEM,
        now=NOW,
    )

    assert candidate["status"] == "pending"
    assert candidate["createdBy"] == TRUSTED_SYSTEM
    assert service.list_knowledge_candidates() == [candidate]
    reopened_db = connect(tmp_path / "p6-runtime.db")
    migrate(reopened_db)
    reopened_service = WorkflowRuntimeService(reopened_db)
    assert reopened_service.list_knowledge_candidates() == [candidate]

    audit = service.list_audit_records(action="knowledge.candidate.created")
    assert len(audit) == 1
    assert audit[0]["actor"] == TRUSTED_SYSTEM
    assert audit[0]["resource"] == f"knowledge-candidate:{candidate['id']}"
    assert audit[0]["detail"]["title"] == "发布前验证清单"
    assert audit[0]["previousHash"] is None
    assert audit[0]["recordHash"]


def test_knowledge_review_publish_search_and_audit_chain(tmp_path) -> None:
    service = make_service(tmp_path)
    candidate = service.create_knowledge_candidate(
        title="Gate 证据规范",
        content="每个 Gate 决策都必须关联可复核证据。",
        source="run:run-456",
        actor=TRUSTED_SYSTEM,
        now=NOW,
    )

    with pytest.raises(ValueError, match="KNOWLEDGE_CANDIDATE_NOT_APPROVED: 知识候选尚未通过审核"):
        service.publish_knowledge_candidate(candidate["id"], actor=TRUSTED_HUMAN, now=NOW)

    reviewed = service.review_knowledge_candidate(
        candidate["id"],
        decision="approved",
        actor=TRUSTED_HUMAN,
        comment="内容已核验。",
        now=NOW,
    )
    published = service.publish_knowledge_candidate(
        candidate["id"],
        actor=TRUSTED_HUMAN,
        now=NOW,
    )

    assert reviewed["status"] == "approved"
    assert reviewed["reviewedBy"] == TRUSTED_HUMAN
    assert published["candidateId"] == candidate["id"]
    assert published["status"] == "published"
    assert service.search_knowledge("gate") == [published]

    audit = service.list_audit_records()
    assert [record["action"] for record in audit] == [
        "knowledge.candidate.created",
        "knowledge.candidate.reviewed",
        "knowledge.candidate.published",
    ]
    assert audit[1]["previousHash"] == audit[0]["recordHash"]
    assert audit[2]["previousHash"] == audit[1]["recordHash"]


def test_knowledge_writes_require_trusted_authorized_actors(tmp_path) -> None:
    service = make_service(tmp_path)

    with pytest.raises(ValueError, match="ACTOR_NOT_TRUSTED: 当前操作需要可信操作者"):
        service.create_knowledge_candidate(
            title="不可信候选",
            content="此写入应被拒绝。",
            source="run:run-789",
            actor=UNTRUSTED_HUMAN,
            now=NOW,
        )

    candidate = service.create_knowledge_candidate(
        title="人工审核权限",
        content="审核必须由可信人工操作者完成。",
        source="run:run-789",
        actor=TRUSTED_SYSTEM,
        now=NOW,
    )

    with pytest.raises(ValueError, match="ACTOR_PERMISSION_DENIED: 只有可信人工操作者可以审核知识候选"):
        service.review_knowledge_candidate(
            candidate["id"],
            decision="approved",
            actor=TRUSTED_SYSTEM,
            comment=None,
            now=NOW,
        )


def test_audit_write_revalidates_actor_models(tmp_path) -> None:
    db = connect(tmp_path / "audit.db")
    migrate(db)
    audit = AuditLog(db)

    with pytest.raises(ValueError, match="ACTOR_NOT_TRUSTED: 当前操作需要可信操作者"):
        audit.record(
            actor=Actor.model_validate(UNTRUSTED_HUMAN),
            action="knowledge.candidate.created",
            resource="knowledge-candidate:candidate-untrusted",
            detail={},
            created_at=NOW,
        )


def test_audit_records_are_append_only_at_sqlite_layer(tmp_path) -> None:
    service = make_service(tmp_path)
    candidate = service.create_knowledge_candidate(
        title="审计不可篡改",
        content="审计记录必须禁止更新和删除。",
        source="run:run-999",
        actor=TRUSTED_SYSTEM,
        now=NOW,
    )

    record = service.list_audit_records()[0]
    with pytest.raises(sqlite3.IntegrityError, match="审计记录禁止修改"):
        service._db.execute(
            "UPDATE audit_records SET action = ? WHERE id = ?",
            ("tampered", record["id"]),
        )
    with pytest.raises(sqlite3.IntegrityError, match="审计记录禁止删除"):
        service._db.execute("DELETE FROM audit_records WHERE id = ?", (record["id"],))

    assert service.list_knowledge_candidates()[0]["id"] == candidate["id"]


def test_knowledge_and_audit_api_complete_closed_loop_with_chinese_errors(tmp_path) -> None:
    client = TestClient(create_app(make_service(tmp_path)))

    denied = client.post(
        "/knowledge/candidates",
        json={
            "title": "无权限候选",
            "content": "此请求应被拒绝。",
            "source": "run:run-api",
            "actor": UNTRUSTED_HUMAN,
            "now": NOW,
        },
    )
    created = client.post(
        "/knowledge/candidates",
        json={
            "title": "API 知识发布",
            "content": "发布前需由人工审核，Gate 证据可被检索。",
            "source": "run:run-api",
            "actor": TRUSTED_SYSTEM,
            "now": NOW,
        },
    )
    candidate_id = created.json()["id"]
    listed = client.get("/knowledge/candidates", params={"status": "pending"})
    reviewed = client.post(
        f"/knowledge/candidates/{candidate_id}/review",
        json={
            "decision": "approved",
            "actor": TRUSTED_HUMAN,
            "comment": "人工复核通过。",
            "now": NOW,
        },
    )
    published = client.post(
        f"/knowledge/candidates/{candidate_id}/publish",
        json={"actor": TRUSTED_HUMAN, "now": NOW},
    )
    searched = client.get("/knowledge/search", params={"query": "gate"})
    audit = client.get("/audit-records", params={"action": "knowledge.candidate.published"})

    assert denied.status_code == 403
    assert denied.json()["detail"] == "ACTOR_NOT_TRUSTED: 当前操作需要可信操作者。"
    assert created.status_code == 200
    assert listed.json()[0]["id"] == candidate_id
    assert reviewed.json()["status"] == "approved"
    assert published.json()["status"] == "published"
    assert searched.json()[0]["candidateId"] == candidate_id
    assert audit.json()[0]["actor"] == TRUSTED_HUMAN
