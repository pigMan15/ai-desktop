from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from shutil import copytree
import sys
from threading import Lock
from time import monotonic, sleep

import pytest

from workflow_platform.execution.providers import CliCommand, CodexCliProvider
from workflow_platform.models import Actor, RunProjection
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService


FIXTURES = Path(__file__).parent / "fixtures"
NOW = "2026-07-27T13:00:00Z"
AGENT_ACTOR = {"id": "agent-1", "type": "agent", "source": "agent", "trusted": False}
FAKE_CLI = FIXTURES / "fake_cli.py"


class FakeProvider:
    id = "fake"

    def build_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        allowed_tools: list[str],
    ) -> CliCommand:
        return CliCommand(
            executable=sys.executable,
            args=[str(FAKE_CLI), "complete"],
            cwd=cwd,
        )

    def parse_line(self, line: str) -> dict:
        return CodexCliProvider(platform="linux").parse_line(line)


class SlowProvider(FakeProvider):
    def build_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        allowed_tools: list[str],
    ) -> CliCommand:
        return CliCommand(
            executable=sys.executable,
            args=[str(FAKE_CLI), "sleep"],
            cwd=cwd,
        )


class RejectConcurrentConnection:
    def __init__(self, connection) -> None:
        self._connection = connection
        self._lock = Lock()

    def execute(self, *args, **kwargs):
        if not self._lock.acquire(blocking=False):
            raise RuntimeError("CONCURRENT_SQLITE_ACCESS")
        try:
            sleep(0.01)
            return self._connection.execute(*args, **kwargs)
        finally:
            self._lock.release()

    def __getattr__(self, name: str):
        return getattr(self._connection, name)


def copy_harness_project(tmp_path: Path) -> Path:
    project_path = tmp_path / "harness_project"
    workflow_dir = project_path / ".harness"
    workflow_dir.mkdir(parents=True)
    workflow_text = (FIXTURES / "harness_project" / ".harness" / "workflow.yaml").read_text(
        encoding="utf-8"
    )
    (workflow_dir / "workflow.yaml").write_text(workflow_text, encoding="utf-8")
    return project_path


def copy_fixture_project(tmp_path: Path, fixture_name: str) -> Path:
    project_path = tmp_path / fixture_name
    copytree(FIXTURES / fixture_name, project_path)
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


def test_runtime_service_serializes_concurrent_run_reads(tmp_path) -> None:
    service, run, _ = create_submitted_run(tmp_path)
    guarded_db = RejectConcurrentConnection(service._db)
    repositories = [
        service,
        service._runs,
        service._events,
        service._projections,
        service._artifacts,
        service._approvals,
        service._gate_results,
        service._terminals,
        service._agent_jobs,
        service._agent_checkpoints,
    ]
    for repository in repositories:
        repository._db = guarded_db

    readers = [
        lambda: service.timeline(run.runId),
        lambda: service.list_artifacts(run.runId),
        lambda: service.list_approvals(run.runId),
        lambda: service.list_gate_results(run.runId),
        lambda: service.list_agent_jobs(run.runId),
        lambda: service.get_recovery_diagnostics(run.runId),
    ]
    with ThreadPoolExecutor(max_workers=len(readers)) as executor:
        futures = [executor.submit(reader) for reader in readers]
        results = [future.result() for future in futures]

    assert len(results) == len(readers)


def test_runtime_service_registers_and_lists_run_bound_terminal_sessions(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="终端绑定", now=NOW)

    session = service.register_terminal_session(
        run.runId,
        node_id="plan",
        kind="codex",
        cwd=project_path,
        pid=4321,
        now="2026-07-28T02:00:00Z",
    )

    assert session["runId"] == run.runId
    assert session["nodeId"] == "plan"
    assert session["kind"] == "codex"
    assert session["status"] == "running"
    assert session["pid"] == 4321
    assert service.list_terminal_sessions(run.runId) == [session]


def test_runtime_service_marks_run_bound_terminal_session_stopped(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="终端停止", now=NOW)
    session = service.register_terminal_session(
        run.runId,
        node_id="plan",
        kind="shell",
        cwd=project_path,
        pid=8765,
        now="2026-07-28T02:00:00Z",
    )

    stopped = service.stop_terminal_session(
        run.runId,
        session["id"],
        now="2026-07-28T02:01:00Z",
    )

    assert stopped["status"] == "stopped"
    assert stopped["pid"] is None
    assert stopped["updatedAt"] == "2026-07-28T02:01:00Z"


def test_runtime_service_records_trusted_human_terminal_command_decision(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="终端命令审批", now=NOW)
    session = service.register_terminal_session(
        run.runId,
        node_id="plan",
        kind="shell",
        cwd=project_path,
        pid=8765,
        now="2026-07-28T02:00:00Z",
    )

    record = service.record_terminal_command_decision(
        run.runId,
        session["id"],
        decision="approved",
        risk_level="high",
        command_summary="del .\\build API_KEY=sk-super-secret-value",
        impact="删除项目内构建目录。",
        actor=trusted_human().model_dump(),
        now="2026-07-28T02:01:00Z",
    )

    assert record["action"] == "terminal.command.approved"
    assert record["resource"] == f"terminal:{session['id']}"
    assert record["detail"] == {
        "runId": run.runId,
        "sessionId": session["id"],
        "riskLevel": "high",
        "commandSummary": "del .\\build API_KEY=[REDACTED]",
        "impact": "删除项目内构建目录。",
    }
    with pytest.raises(ValueError, match="只有可信人工操作者"):
        service.record_terminal_command_decision(
            run.runId,
            session["id"],
            decision="approved",
            risk_level="high",
            command_summary="del .\\build",
            impact="删除项目内构建目录。",
            actor=trusted_verifier().model_dump(),
            now="2026-07-28T02:02:00Z",
        )


def test_runtime_service_reports_running_terminal_sessions_for_recovery(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="终端恢复", now=NOW)
    session = service.register_terminal_session(
        run.runId,
        node_id="plan",
        kind="shell",
        cwd=project_path,
        pid=8765,
        now="2026-07-28T02:00:00Z",
    )

    diagnostics = service.get_recovery_diagnostics(run.runId)

    assert diagnostics["orphanTerminalSessionIds"] == [session["id"]]


def test_runtime_service_cleans_orphan_terminal_sessions_during_recovery(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="终端清理", now=NOW)
    session = service.register_terminal_session(
        run.runId,
        node_id="plan",
        kind="shell",
        cwd=project_path,
        pid=8765,
        now="2026-07-28T02:00:00Z",
    )

    cleaned = service.cleanup_orphan_terminal_sessions(run.runId, now="2026-07-28T02:01:00Z")

    assert cleaned == {"runId": run.runId, "cleanedSessionIds": [session["id"]]}
    assert service.list_terminal_sessions(run.runId)[0]["status"] == "stopped"
    assert service.list_terminal_sessions(run.runId)[0]["pid"] is None


def test_runtime_service_persists_run_bound_terminal_output_with_cursor(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="终端输出", now=NOW)
    session = service.register_terminal_session(
        run.runId,
        node_id="plan",
        kind="shell",
        cwd=project_path,
        pid=8765,
        now="2026-07-28T02:00:00Z",
    )

    service.append_terminal_output(
        run.runId,
        session["id"],
        stream="stdout",
        data="正在执行\n",
        now="2026-07-28T02:00:01Z",
    )
    service.append_terminal_output(
        run.runId,
        session["id"],
        stream="stderr",
        data="warning\n",
        now="2026-07-28T02:00:02Z",
    )

    assert service.list_terminal_output(run.runId, session["id"], after_sequence=1) == [
        {
            "id": f"{session['id']}:output:2",
            "sessionId": session["id"],
            "sequence": 2,
            "stream": "stderr",
            "data": "warning\n",
            "createdAt": "2026-07-28T02:00:02Z",
        }
    ]


def test_runtime_service_redacts_terminal_output_before_persisting(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="终端脱敏", now=NOW)
    session = service.register_terminal_session(
        run.runId,
        node_id="plan",
        kind="shell",
        cwd=project_path,
        pid=8765,
        now="2026-07-28T02:00:00Z",
    )

    service.append_terminal_output(
        run.runId,
        session["id"],
        stream="stdout",
        data="OPENAI_API_KEY=sk-live-secret\n",
        now="2026-07-28T02:00:01Z",
    )

    assert service.list_terminal_output(run.runId, session["id"]) == [
        {
            "id": f"{session['id']}:output:1",
            "sessionId": session["id"],
            "sequence": 1,
            "stream": "stdout",
            "data": "OPENAI_API_KEY=[REDACTED]\n",
            "createdAt": "2026-07-28T02:00:01Z",
        }
    ]


def test_runtime_service_exports_terminal_output_as_audited_evidence(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="终端证据", now=NOW)
    session = service.register_terminal_session(
        run.runId,
        node_id="plan",
        kind="shell",
        cwd=project_path,
        pid=8765,
        now="2026-07-28T02:00:00Z",
    )
    service.append_terminal_output(
        run.runId,
        session["id"],
        stream="stdout",
        data="OPENAI_API_KEY=sk-live-secret\n完成\n",
        now="2026-07-28T02:00:01Z",
    )

    evidence = service.export_terminal_output_as_evidence(
        run.runId,
        session["id"],
        actor=trusted_human().model_dump(),
        now="2026-07-28T02:00:02Z",
    )

    evidence_path = project_path / ".workflow-platform" / "evidence" / f"{session['id']}-1-1.log"
    assert evidence["type"] == "evidence"
    assert evidence["nodeId"] == "plan"
    assert evidence["uri"] == evidence_path.resolve().as_uri()
    assert evidence_path.read_text(encoding="utf-8") == "OPENAI_API_KEY=[REDACTED]\n完成\n"
    assert service.list_artifacts(run.runId) == [evidence]


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


@pytest.mark.parametrize(
    ("fixture_name", "adapter_id"),
    [
        ("markdown_checklist_project", "markdown-checklist"),
        ("generic_yaml_project", "generic-yaml"),
    ],
)
def test_runtime_service_imports_project_through_detected_adapter(
    tmp_path: Path,
    fixture_name: str,
    adapter_id: str,
) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_fixture_project(tmp_path, fixture_name)

    project = service.import_project(project_path, now=NOW)

    assert project["adapterId"] == adapter_id
    assert project["score"] > 0
    assert project["workflowVersionId"]


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


def test_runtime_service_records_authorized_gate_waiver_with_reason(
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

    projection = service.submit_gate_result(
        run.runId,
        node_id="plan",
        gate_id="plan-ready",
        status="waived",
        evidence=[],
        waiver_reason="temporary exception approved by verifier",
        actor=trusted_verifier().model_dump(),
        expected_revision=approval.revision,
        now=NOW,
    )

    assert projection.status == "IN_PROGRESS"
    assert projection.nodeStates["plan"] == "PASSED"
    assert service.list_gate_results(run.runId) == [
        {
            "id": f"{run.runId}:gate:plan:plan-ready:5",
            "runId": run.runId,
            "nodeId": "plan",
            "gateId": "plan-ready",
            "status": "waived",
            "evidence": [],
            "waiverReason": "temporary exception approved by verifier",
            "failureReason": None,
            "actor": trusted_verifier().model_dump(),
            "createdAt": NOW,
        }
    ]


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


@pytest.mark.parametrize("status", ["passed", "failed"])
def test_runtime_service_rejects_blank_only_gate_evidence_without_writing_record(
    tmp_path,
    status: str,
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

    with pytest.raises(ValueError, match="MISSING_EVIDENCE|INVALID_TRANSITION"):
        service.submit_gate_result(
            run.runId,
            node_id="plan",
            gate_id="plan-ready",
            status=status,
            evidence=["", "   "],
            waiver_reason=None,
            actor=trusted_verifier().model_dump(),
            expected_revision=approval.revision,
            now=NOW,
        )

    assert service.list_gate_results(run.runId) == []


def test_runtime_service_defers_approval_without_advancing_the_node(tmp_path) -> None:
    service, run, submitted = create_submitted_run(tmp_path)

    deferred = service.decide_approval(
        run.runId,
        node_id="plan",
        decision="deferred",
        actor=trusted_human().model_dump(),
        comment="等待安全团队补充证据",
        expected_revision=submitted.revision,
        now=NOW,
    )

    assert deferred.status == "REVIEWING"
    assert deferred.nodeStates["plan"] == "AWAITING_APPROVAL"
    assert {action.eventType for action in deferred.allowedActions} == {
        "HUMAN_APPROVED",
        "HUMAN_REJECTED",
        "HUMAN_DEFERRED",
        "RUN_PAUSED",
    }
    assert service.list_approvals(run.runId)[0]["status"] == "deferred"
    assert service.list_approvals(run.runId)[0]["comment"] == "等待安全团队补充证据"


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

    with pytest.raises(ValueError, match="Gate waivers"):
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
        failure_reason="计划产物缺少必需的回归测试证据",
        actor=trusted_verifier().model_dump(),
        expected_revision=approval.revision,
        now=NOW,
    )

    gates = service.list_gate_results(run.runId)

    assert failed.status == "BLOCKED"
    assert failed.nodeStates["plan"] == "BLOCKED"
    assert gates[0]["status"] == "failed"
    assert gates[0]["failureReason"] == "计划产物缺少必需的回归测试证据"


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


def test_runtime_service_starts_agent_for_existing_run_node_without_advancing_projection(
    tmp_path,
) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="Agent Run", now=NOW)

    job = service.start_agent_job(
        run.runId,
        node_id="plan",
        provider="fake",
        prompt="生成实现计划",
        actor=AGENT_ACTOR,
        now=NOW,
    )
    completed = job
    for _ in range(100):
        completed = service.get_agent_job(run.runId, job["id"])
        if completed["status"] == "COMPLETED":
            break
        sleep(0.02)
    output = service.list_agent_output(job["id"], after_sequence=0)
    current = service.get_projection(run.runId)

    assert job["runId"] == run.runId
    assert job["nodeId"] == "plan"
    assert job["provider"] == "fake"
    assert job["status"] == "QUEUED"
    assert completed["status"] == "COMPLETED"
    assert output[-1]["kind"] == "final"
    assert output[-1]["payload"]["text"] == "fake-cli: completed"
    assert current.revision == run.revision
    assert current.nodeStates == run.nodeStates


def test_runtime_service_starts_agent_in_background_and_allows_cancellation(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: SlowProvider())
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="后台 Agent Run", now=NOW)

    started_at = monotonic()
    job = service.start_agent_job(
        run.runId,
        node_id="plan",
        provider="fake",
        prompt="执行一个可中断任务",
        actor=AGENT_ACTOR,
        now=NOW,
    )

    assert monotonic() - started_at < 0.5
    assert job["status"] == "QUEUED"

    for _ in range(50):
        if service.list_agent_output(job["id"], after_sequence=0):
            break
        sleep(0.02)
    service.cancel_agent_job(run.runId, job["id"])

    final = service.get_agent_job(run.runId, job["id"])
    for _ in range(100):
        final = service.get_agent_job(run.runId, job["id"])
        if final["status"] == "CANCELLED":
            break
        sleep(0.02)

    assert final["status"] == "CANCELLED"
    assert "AGENT_CANCELLED" in (final["error"] or "")


def test_runtime_service_persists_and_resumes_recoverable_agent_checkpoints(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: SlowProvider())
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="Checkpoint Run", now=NOW)

    job = service.start_agent_job(
        run.runId,
        node_id="plan",
        provider="fake",
        prompt="保存后恢复这个 Agent 任务",
        actor=AGENT_ACTOR,
        now=NOW,
        allowed_tools=["read"],
        timeout_seconds=45,
    )
    service.cancel_agent_job(run.runId, job["id"])

    for _ in range(100):
        cancelled = service.get_agent_job(run.runId, job["id"])
        if cancelled["status"] == "CANCELLED":
            break
        sleep(0.02)

    checkpoints = service.list_agent_checkpoints(run.runId)
    checkpoint = checkpoints[0]

    assert checkpoint["status"] == "recoverable"
    assert checkpoint["provider"] == "fake"
    assert checkpoint["prompt"] == "保存后恢复这个 Agent 任务"
    assert checkpoint["allowedTools"] == ["read"]
    assert checkpoint["timeoutSeconds"] == 45
    assert service.get_recovery_diagnostics(run.runId)["recoverableAgentCheckpointIds"] == [
        checkpoint["id"]
    ]

    resumed = service.resume_agent_checkpoint(
        run.runId,
        checkpoint["id"],
        actor={"id": "human-1", "type": "human", "source": "runtime", "trusted": True},
        now=NOW,
    )

    assert resumed["status"] == "QUEUED"
    assert resumed["nodeId"] == "plan"
    resumed_checkpoint = next(
        candidate
        for candidate in service.list_agent_checkpoints(run.runId)
        if candidate["id"] == checkpoint["id"]
    )
    assert resumed_checkpoint["status"] == "resumed"


def test_runtime_service_discards_recoverable_agent_checkpoint_with_human_audit(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="Discard Checkpoint Run", now=NOW)
    service._agent_jobs.create(
        id="agent-job-discard",
        run_id=run.runId,
        node_id="plan",
        provider="fake",
        status="CANCELLED",
        command=["fake"],
        cwd=str(tmp_path),
        created_at=NOW,
    )
    service._agent_checkpoints.create(
        id="agent-checkpoint-discard",
        run_id=run.runId,
        job_id="agent-job-discard",
        parent_checkpoint_id=None,
        node_id="plan",
        provider="fake",
        prompt="不要恢复这个请求",
        allowed_tools=[],
        timeout_seconds=60,
        max_output_bytes=1000,
        status="recoverable",
        created_at=NOW,
    )
    db.commit()

    discarded = service.discard_agent_checkpoint(
        run.runId,
        "agent-checkpoint-discard",
        actor={"id": "human-1", "type": "human", "source": "runtime", "trusted": True},
        now=NOW,
    )

    assert discarded["status"] == "discarded"
    assert service.get_recovery_diagnostics(run.runId)["recoverableAgentCheckpointIds"] == []
    assert service.list_audit_records(action="agent.checkpoint.discarded")[0]["actor"]["type"] == "human"


def test_runtime_service_rejects_agent_for_unknown_node(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="Agent Run", now=NOW)

    with pytest.raises(ValueError, match="AGENT_UNKNOWN_NODE"):
        service.start_agent_job(
            run.runId,
            node_id="missing",
            provider="fake",
            prompt="x",
            actor=AGENT_ACTOR,
            now=NOW,
        )
