from workflow_platform.governance.audit import AuditLog
from workflow_platform.knowledge.service import LocalKnowledgeService
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate


NOW = "2026-07-28T10:00:00Z"
HUMAN = {"id": "human-1", "type": "human", "source": "runtime", "trusted": True}
SYSTEM = {"id": "system-1", "type": "system", "source": "runtime", "trusted": True}


def test_audit_log_persists_and_filters_by_actor(tmp_path) -> None:
    db = connect(tmp_path / "governance.db")
    migrate(db)
    audit = AuditLog(db)
    audit.record(
        actor=HUMAN,
        action="approval.decide",
        resource="run:run-1",
        detail={"decision": "approved"},
        created_at=NOW,
    )
    audit.record(
        actor=SYSTEM,
        action="knowledge.candidate.created",
        resource="knowledge-candidate:candidate-1",
        detail={},
        created_at=NOW,
    )

    records = audit.list(actor_id="human-1")

    assert len(records) == 1
    assert records[0]["action"] == "approval.decide"
    assert records[0]["detail"]["decision"] == "approved"


def test_local_knowledge_requires_review_before_publication_and_supports_search(tmp_path) -> None:
    db = connect(tmp_path / "knowledge.db")
    migrate(db)
    knowledge = LocalKnowledgeService(db, AuditLog(db))
    candidate = knowledge.create_candidate(
        title="终端验证规范",
        content="终端输出必须作为证据保存，不能自动通过 Gate。",
        source="run-1",
        actor=SYSTEM,
        now=NOW,
    )

    try:
        knowledge.publish_candidate(candidate["id"], actor=HUMAN, now=NOW)
    except ValueError as error:
        assert str(error) == "KNOWLEDGE_CANDIDATE_NOT_APPROVED: 知识候选尚未通过审核。"
    else:
        raise AssertionError("expected approval requirement")

    knowledge.review_candidate(
        candidate["id"],
        actor=HUMAN,
        decision="approved",
        comment="已审核。",
        now=NOW,
    )
    published = knowledge.publish_candidate(candidate["id"], actor=HUMAN, now=NOW)

    assert published["status"] == "published"
    assert [item["title"] for item in knowledge.search("gate")] == ["终端验证规范"]
