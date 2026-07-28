from workflow_platform.governance.audit import AuditLog
from workflow_platform.knowledge.service import LocalKnowledgeService


def test_audit_log_is_append_only_and_filters_by_actor() -> None:
    audit = AuditLog()
    audit.record(actor_id="human-1", action="approval.decide", resource="run-1", detail={"decision": "approved"})
    audit.record(actor_id="agent-1", action="agent.start", resource="run-1", detail={})

    records = audit.list(actor_id="human-1")

    assert len(records) == 1
    assert records[0]["action"] == "approval.decide"
    assert records[0]["detail"]["decision"] == "approved"


def test_local_knowledge_requires_review_before_publication_and_supports_search() -> None:
    knowledge = LocalKnowledgeService()
    candidate = knowledge.create_candidate(
        title="终端验证规范",
        content="终端输出必须作为证据保存，不能自动通过 gate。",
        source="run-1",
    )

    try:
        knowledge.publish(candidate["id"])
    except ValueError as error:
        assert str(error) == "Knowledge candidate must be approved before publication"
    else:
        raise AssertionError("expected approval requirement")

    knowledge.review(candidate["id"], reviewer="human-1", decision="approved")
    published = knowledge.publish(candidate["id"])

    assert published["status"] == "published"
    assert [item["title"] for item in knowledge.search("gate")] == ["终端验证规范"]
