from pathlib import Path

import pytest

from workflow_platform.models import Actor, RunProjection
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService


FIXTURES = Path(__file__).parent / "fixtures"
NOW = "2026-07-27T13:00:00Z"


def copy_harness_project(tmp_path: Path) -> Path:
    project_path = tmp_path / "harness_project"
    workflow_dir = project_path / ".harness"
    workflow_dir.mkdir(parents=True)
    workflow_text = (FIXTURES / "harness_project" / ".harness" / "workflow.yaml").read_text(
        encoding="utf-8"
    )
    (workflow_dir / "workflow.yaml").write_text(workflow_text, encoding="utf-8")
    return project_path


def trusted_human() -> Actor:
    return Actor(id="human-1", type="human", source="renderer", trusted=True)


def trusted_verifier() -> Actor:
    return Actor(id="verifier-1", type="verifier", source="runtime", trusted=True)


def create_submitted_run(
    tmp_path: Path,
) -> tuple[WorkflowRuntimeService, RunProjection, RunProjection]:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("璁″垝鍐呭", encoding="utf-8")

    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="娌荤悊璐熷悜璺緞", now=NOW)
    started = service.transition_run(
        run.runId,
        "NODE_STARTED",
        node_id="plan",
        actor={"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
        expected_revision=run.revision,
        now=NOW,
    )
    submitted = service.submit_artifact(
        run.runId,
        node_id="plan",
        artifact_path=artifact_path,
        artifact_type="plan",
        actor={"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
        expected_revision=started.revision,
        now=NOW,
    )
    return service, run, submitted


def test_runtime_service_imports_project_and_advances_run_through_persistence(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("计划内容", encoding="utf-8")

    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="验证 Demo Run", now=NOW)
    started = service.transition_run(
        run.runId,
        "NODE_STARTED",
        node_id="plan",
        actor={"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
        expected_revision="1",
        now=NOW,
    )
    submitted = service.submit_artifact(
        run.runId,
        node_id="plan",
        artifact_path=artifact_path,
        artifact_type="plan",
        actor={"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
        expected_revision=started.revision,
        now=NOW,
    )
    approved = service.decide_approval(
        run.runId,
        node_id="plan",
        decision="approved",
        actor=trusted_human().model_dump(),
        comment=None,
        expected_revision=submitted.revision,
        now=NOW,
    )
    advanced = service.submit_gate_result(
        run.runId,
        node_id="plan",
        gate_id="plan-ready",
        status="passed",
        evidence=["artifact:plan"],
        waiver_reason=None,
        actor=trusted_verifier().model_dump(),
        expected_revision=approved.revision,
        now=NOW,
    )

    persisted = service.get_projection(run.runId)
    rows = db.execute(
        "SELECT sequence, type, revision FROM run_events WHERE run_id = ? ORDER BY sequence",
        (run.runId,),
    ).fetchall()

    assert project["adapterId"] == "harness"
    assert run.status == "CREATED"
    assert advanced.status == "IN_PROGRESS"
    assert advanced.nodeStates["plan"] == "PASSED"
    assert advanced.nodeStates["review"] == "READY"
    assert persisted == advanced
    assert [(row["sequence"], row["type"], row["revision"]) for row in rows] == [
        (1, "RUN_CREATED", "1"),
        (2, "NODE_STARTED", "2"),
        (3, "ARTIFACT_SUBMITTED", "3"),
        (4, "HUMAN_APPROVED", "4"),
        (5, "GATE_PASSED", "5"),
    ]


def test_runtime_service_persists_artifact_approval_and_gate_records(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    artifact_path = project_path / "plan.md"
    artifact_path.write_text("计划内容", encoding="utf-8")

    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="治理记录", now=NOW)
    started = service.transition_run(
        run.runId,
        "NODE_STARTED",
        node_id="plan",
        actor={"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
        expected_revision=run.revision,
        now=NOW,
    )
    submitted = service.submit_artifact(
        run.runId,
        node_id="plan",
        artifact_path=artifact_path,
        artifact_type="plan",
        actor={"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
        expected_revision=started.revision,
        now=NOW,
    )
    approval = service.decide_approval(
        run.runId,
        node_id="plan",
        decision="approved",
        actor=trusted_human().model_dump(),
        comment="同意进入 gate",
        expected_revision=submitted.revision,
        now=NOW,
    )
    gated = service.submit_gate_result(
        run.runId,
        node_id="plan",
        gate_id="plan-ready",
        status="passed",
        evidence=["artifact:plan"],
        waiver_reason=None,
        actor=trusted_verifier().model_dump(),
        expected_revision=approval.revision,
        now=NOW,
    )

    artifacts = service.list_artifacts(run.runId)
    approvals = service.list_approvals(run.runId)
    gates = service.list_gate_results(run.runId)

    assert gated.nodeStates["review"] == "READY"
    assert artifacts[0]["type"] == "plan"
    assert artifacts[0]["contentHash"]
    assert approvals[0]["status"] == "approved"
    assert approvals[0]["comment"] == "同意进入 gate"
    assert gates[0]["status"] == "passed"
    assert gates[0]["evidence"] == ["artifact:plan"]


def test_runtime_service_rejects_generic_human_approval_without_writing_record(tmp_path) -> None:
    service, run, submitted = create_submitted_run(tmp_path)

    with pytest.raises(ValueError, match="typed governance service methods"):
        service.transition_run(
            run.runId,
            "HUMAN_APPROVED",
            node_id="plan",
            actor=trusted_human().model_dump(),
            expected_revision=submitted.revision,
            now=NOW,
        )

    assert service.list_approvals(run.runId) == []


def test_runtime_service_rejects_generic_gate_pass_without_writing_record(tmp_path) -> None:
    service, run, submitted = create_submitted_run(tmp_path)
    approval = service.decide_approval(
        run.runId,
        node_id="plan",
        decision="approved",
        actor=trusted_human().model_dump(),
        comment=None,
        expected_revision=submitted.revision,
        now=NOW,
    )

    with pytest.raises(ValueError, match="typed governance service methods"):
        service.transition_run(
            run.runId,
            "GATE_PASSED",
            node_id="plan",
            actor=trusted_verifier().model_dump(),
            payload={"evidence": ["artifact:plan"], "gateId": "plan-ready"},
            expected_revision=approval.revision,
            now=NOW,
        )

    assert service.list_gate_results(run.runId) == []


def test_runtime_service_rejects_gate_waiver_reason_for_passed_status_without_writing_record(
    tmp_path,
) -> None:
    service, run, submitted = create_submitted_run(tmp_path)
    approval = service.decide_approval(
        run.runId,
        node_id="plan",
        decision="approved",
        actor=trusted_human().model_dump(),
        comment=None,
        expected_revision=submitted.revision,
        now=NOW,
    )

    with pytest.raises(ValueError, match="gate waiver"):
        service.submit_gate_result(
            run.runId,
            node_id="plan",
            gate_id="plan-ready",
            status="passed",
            evidence=[],
            waiver_reason="temporary",
            actor=trusted_verifier().model_dump(),
            expected_revision=approval.revision,
            now=NOW,
        )

    assert service.list_gate_results(run.runId) == []


def test_runtime_service_rejects_empty_gate_waiver_reason_for_passed_status_without_writing_record(
    tmp_path,
) -> None:
    service, run, submitted = create_submitted_run(tmp_path)
    approval = service.decide_approval(
        run.runId,
        node_id="plan",
        decision="approved",
        actor=trusted_human().model_dump(),
        comment=None,
        expected_revision=submitted.revision,
        now=NOW,
    )

    with pytest.raises(ValueError, match="INVALID_TRANSITION"):
        service.submit_gate_result(
            run.runId,
            node_id="plan",
            gate_id="plan-ready",
            status="passed",
            evidence=["artifact:plan"],
            waiver_reason="",
            actor=trusted_verifier().model_dump(),
            expected_revision=approval.revision,
            now=NOW,
        )

    assert service.list_gate_results(run.runId) == []


def test_runtime_service_rejects_deferred_approval_without_writing_record(tmp_path) -> None:
    service, run, submitted = create_submitted_run(tmp_path)

    with pytest.raises(ValueError, match="deferred approvals"):
        service.decide_approval(
            run.runId,
            node_id="plan",
            decision="deferred",
            actor=trusted_human().model_dump(),
            comment=None,
            expected_revision=submitted.revision,
            now=NOW,
        )

    assert service.list_approvals(run.runId) == []


def test_runtime_service_persists_rejected_artifact_approval_record(tmp_path) -> None:
    service, run, submitted = create_submitted_run(tmp_path)

    assert submitted.status == "REVIEWING"
    assert submitted.nodeStates["plan"] == "AWAITING_APPROVAL"

    rejected = service.decide_approval(
        run.runId,
        node_id="plan",
        decision="rejected",
        actor=trusted_human().model_dump(),
        comment="needs revision",
        expected_revision=submitted.revision,
        now=NOW,
    )

    approvals = service.list_approvals(run.runId)

    assert rejected.status == "BLOCKED"
    assert rejected.nodeStates["plan"] == "BLOCKED"
    assert approvals[0]["status"] == "rejected"


def test_runtime_service_rejects_waived_gate_without_writing_record(tmp_path) -> None:
    service, run, submitted = create_submitted_run(tmp_path)
    approval = service.decide_approval(
        run.runId,
        node_id="plan",
        decision="approved",
        actor=trusted_human().model_dump(),
        comment=None,
        expected_revision=submitted.revision,
        now=NOW,
    )

    with pytest.raises(ValueError, match="gate waiver"):
        service.submit_gate_result(
            run.runId,
            node_id="plan",
            gate_id="plan-ready",
            status="waived",
            evidence=[],
            waiver_reason=None,
            actor=trusted_verifier().model_dump(),
            expected_revision=approval.revision,
            now=NOW,
        )

    assert service.list_gate_results(run.runId) == []


def test_runtime_service_persists_failed_gate_result_record(tmp_path) -> None:
    service, run, submitted = create_submitted_run(tmp_path)
    approval = service.decide_approval(
        run.runId,
        node_id="plan",
        decision="approved",
        actor=trusted_human().model_dump(),
        comment=None,
        expected_revision=submitted.revision,
        now=NOW,
    )

    assert approval.status == "REVIEWING"
    assert approval.nodeStates["plan"] == "AWAITING_GATE"

    failed = service.submit_gate_result(
        run.runId,
        node_id="plan",
        gate_id="plan-ready",
        status="failed",
        evidence=["artifact:plan"],
        waiver_reason=None,
        actor=trusted_verifier().model_dump(),
        expected_revision=approval.revision,
        now=NOW,
    )

    gates = service.list_gate_results(run.runId)

    assert failed.status == "BLOCKED"
    assert failed.nodeStates["plan"] == "BLOCKED"
    assert gates[0]["status"] == "failed"


def test_runtime_service_rejects_stale_revision_without_writing_event(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="冲突测试", now=NOW)

    with pytest.raises(ValueError, match="REVISION_CONFLICT"):
        service.transition_run(
            run.runId,
            "NODE_STARTED",
            node_id="plan",
            actor={"id": "agent-1", "type": "agent", "source": "agent", "trusted": False},
            expected_revision="0",
            now=NOW,
        )

    count = db.execute("SELECT COUNT(*) FROM run_events WHERE run_id = ?", (run.runId,)).fetchone()[0]
    assert count == 1


def test_runtime_service_reimport_keeps_workflow_version_available(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)

    first = service.import_project(project_path, now=NOW)
    second = service.import_project(project_path, now=NOW)
    run = service.create_run(second["workflowVersionId"], title="重复导入后创建", now=NOW)

    assert second["projectId"] == first["projectId"]
    assert second["workflowVersionId"] == first["workflowVersionId"]
    assert run.revision == "1"
