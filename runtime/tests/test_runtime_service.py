from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
from shutil import copytree, rmtree
import sys
from threading import Event, Lock, Thread, current_thread
from time import monotonic, sleep

import pytest

from workflow_platform.execution.providers import CliCommand, CodexCliProvider
from workflow_platform.models import Actor, Role, RunProjection, WorkflowDefinition, WorkflowNode
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.persistence.repositories import (
    AgentJobRepository,
    DeploymentRepository,
)
from workflow_platform.runtime_errors import RuntimeContractError
from workflow_platform.runtime_service import (
    WorkflowRuntimeService,
    _build_effective_agent_prompt,
    _knowledge_synthesis_prompt,
)


FIXTURES = Path(__file__).parent / "fixtures"
NOW = "2026-07-27T13:00:00Z"
AGENT_ACTOR = {"id": "agent-1", "type": "agent", "source": "agent", "trusted": False}
FAKE_CLI = FIXTURES / "fake_cli.py"


def test_knowledge_synthesis_prompt_requires_a_reusable_knowledge_entry() -> None:
    prompt = _knowledge_synthesis_prompt(
        {
            "title": "登录页实施报告",
            "source": "run:run-123",
            "content": "修复了登录页文案，并通过了自动化测试。",
        }
    )

    assert "不要复述原始产物" in prompt
    assert "## 可复用结论" in prompt
    assert "## 适用条件" in prompt
    assert "## 实施步骤" in prompt
    assert "## 验证清单" in prompt
    assert "## 风险与边界" in prompt
    assert "## 来源证据" in prompt


def test_effective_agent_prompt_includes_bound_role_before_node_prompt() -> None:
    workflow = WorkflowDefinition(
        id="workflow-1",
        name="Prompt workflow",
        version="v1",
        sourceAdapter="fixture",
        nodes=[
            WorkflowNode(
                id="agent-1",
                name="Implement",
                kind="agent",
                agent={"roleId": "engineer", "promptTemplate": "实现并验证变更。"},
            )
        ],
        edges=[],
        roles=[
            Role(
                id="engineer",
                name="实现工程师",
                description="负责交付可维护的代码。",
                instructions="只修改任务范围内的文件，并运行相关测试。",
            )
        ],
        gates=[],
        policies={},
        metadata={},
    )

    prompt, artifacts = _build_effective_agent_prompt(
        workflow=workflow,
        run_id="run-1",
        node_id="agent-1",
        user_prompt="修复登录流程。",
        node_states={},
        artifacts=[],
        project_root=Path.cwd(),
        now=NOW,
    )

    assert prompt == (
        "角色定义：\n"
        "角色名：实现工程师\n"
        "说明：负责交付可维护的代码。\n"
        "职责与边界：只修改任务范围内的文件，并运行相关测试。\n\n"
        "节点执行要求：\n实现并验证变更。\n\n"
        "用户任务：\n修复登录流程。"
    )
    assert artifacts == []


def test_effective_agent_prompt_without_role_id_preserves_existing_format() -> None:
    workflow = WorkflowDefinition(
        id="workflow-1",
        name="Prompt workflow",
        version="v1",
        sourceAdapter="fixture",
        nodes=[
            WorkflowNode(
                id="agent-1",
                name="Implement",
                kind="agent",
                agent={"promptTemplate": "实现并验证变更。"},
            )
        ],
        edges=[],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )

    prompt, artifacts = _build_effective_agent_prompt(
        workflow=workflow,
        run_id="run-1",
        node_id="agent-1",
        user_prompt="修复登录流程。",
        node_states={},
        artifacts=[],
        project_root=Path.cwd(),
        now=NOW,
    )

    assert prompt == "节点执行要求：\n实现并验证变更。\n\n用户任务：\n修复登录流程。"
    assert artifacts == []


def test_effective_agent_prompt_uses_agent_role_id_not_business_node_role() -> None:
    workflow = WorkflowDefinition(
        id="workflow-1",
        name="Prompt workflow",
        version="v1",
        sourceAdapter="fixture",
        nodes=[
            WorkflowNode(
                id="agent-1",
                name="Implement",
                kind="agent",
                role="business-role",
                agent={"roleId": "engineer"},
            )
        ],
        edges=[],
        roles=[
            Role(
                id="business-role",
                name="业务审批角色",
                instructions="此业务角色定义不得出现在执行提示中。",
            ),
            Role(
                id="engineer",
                name="实现工程师",
                instructions="交付并验证任务范围内的代码。",
            ),
        ],
        gates=[],
        policies={},
        metadata={},
    )

    prompt, artifacts = _build_effective_agent_prompt(
        workflow=workflow,
        run_id="run-1",
        node_id="agent-1",
        user_prompt="",
        node_states={},
        artifacts=[],
        project_root=Path.cwd(),
        now=NOW,
    )

    assert "角色名：实现工程师" in prompt
    assert "交付并验证任务范围内的代码。" in prompt
    assert "业务审批角色" not in prompt
    assert "此业务角色定义不得出现在执行提示中。" not in prompt
    assert artifacts == []


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


def test_import_project_without_workflow_succeeds_without_a_default_workflow(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = tmp_path / "empty_project"
    project_path.mkdir()

    imported = service.import_project(project_path, now=NOW)
    assert imported["workflowBindingStatus"] == "unbound"
    assert imported["workflowVersionId"] is None
    assert imported["workflowId"] is None
    assert imported["createdDefaultWorkflow"] is False
    assert service.get_project_workflow_binding(imported["projectId"]) is None
    assert not (project_path / "workflow.yaml").exists()
    assert not (project_path / ".harness").exists()


def test_runs_use_the_requested_project_binding_and_reject_versions_from_another_project(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    imported_one = service.import_project(copy_harness_project(tmp_path / "one"), now=NOW)
    imported_two = service.import_project(copy_harness_project(tmp_path / "two"), now=NOW)
    definition = service.get_workflow_definition(imported_one["workflowVersionId"])
    library = service.create_workflow(
        definition=definition,
        is_builtin=True,
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    for imported in (imported_one, imported_two):
        service.bind_project_workflow(
            imported["projectId"],
            workflow_id=library["workflowId"],
            workflow_version_id=library["workflowVersionId"],
            actor=trusted_human().model_dump(),
            now=NOW,
        )


def test_scoped_run_children_reject_a_run_owned_by_another_project(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    imported_one = service.import_project(copy_harness_project(tmp_path / "one"), now=NOW)
    imported_two = service.import_project(copy_harness_project(tmp_path / "two"), now=NOW)
    run_one = service.create_run(imported_one["projectId"], title="one", now=NOW)

    run_id = run_one.runId
    project_one = imported_one["projectId"]
    project_two = imported_two["projectId"]

    assert service.get_scoped_run(project_one, run_id)["id"] == run_id
    assert service.list_scoped_timeline(project_one, run_id)[0]["runId"] == run_id
    assert service.list_scoped_agent_jobs(project_one, run_id) == []

    for operation in (
        lambda: service.get_scoped_run(project_two, run_id),
        lambda: service.get_scoped_projection(project_two, run_id),
        lambda: service.list_scoped_timeline(project_two, run_id),
        lambda: service.list_scoped_agent_jobs(project_two, run_id),
        lambda: service.get_scoped_recovery_diagnostics(project_two, run_id),
    ):
        with pytest.raises(RuntimeContractError) as error:
            operation()
        assert error.value.code == "RUN_NOT_FOUND_IN_PROJECT"

    run_two = service.create_run(imported_two["projectId"], title="two", now="2026-08-04T00:01:00Z")
    rows = db.execute("SELECT id, project_id FROM runs ORDER BY created_at").fetchall()

    assert [row["project_id"] for row in rows] == [imported_one["projectId"], imported_two["projectId"]]
    assert run_one.runId != run_two.runId
    with pytest.raises(ValueError, match="PROJECT_WORKFLOW_BINDING_MISMATCH"):
        service.create_run(
            imported_one["projectId"],
            imported_two["workflowVersionId"],
            title="cross-project",
            now="2026-08-04T00:02:00Z",
        )


def test_scoped_overview_includes_snapshot_workspace_and_active_run_activity(
    tmp_path: Path,
) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path / "project")
    imported = service.import_project(project_path, now=NOW)
    projection = service.create_run(
        imported["projectId"],
        imported["workflowVersionId"],
        title="Overview run",
        execution_workspace=str(project_path),
        workspace_mode="write",
        actor=trusted_human(),
        idempotency_key="overview-run",
        now=NOW,
    )
    AgentJobRepository(db).create(
        id="job-running",
        run_id=projection.runId,
        node_id="plan",
        provider="fake",
        status="RUNNING",
        command=["fake"],
        cwd=str(project_path),
        created_at=NOW,
    )
    DeploymentRepository(db).create(
        id="deployment-queued",
        run_id=projection.runId,
        node_id="deploy",
        command=["fake"],
        cwd=str(project_path),
        created_at=NOW,
    )

    overview = service.get_scoped_overview(imported["projectId"], projection.runId)

    assert overview["run"]["id"] == projection.runId
    assert overview["workflow"] == overview["run"]["workflowSnapshot"]
    assert overview["workspace"]["runId"] == projection.runId
    assert overview["activity"] == {
        "activeAgentCount": 1,
        "activeDeploymentCount": 1,
        "lastEventAt": NOW,
    }


def test_scoped_projection_and_overview_hide_actions_for_an_archived_project(
    tmp_path: Path,
) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path / "project")
    imported = service.import_project(project_path, now=NOW)
    projection = service.create_run(
        imported["projectId"],
        imported["workflowVersionId"],
        title="Archived project run",
        execution_workspace=str(project_path),
        workspace_mode="write",
        actor=trusted_human(),
        idempotency_key="archived-project-overview",
        now=NOW,
    )
    assert projection.allowedActions
    service.archive_project(
        imported["projectId"],
        actor=trusted_human().model_dump(),
        now="2026-08-06T00:01:00Z",
    )

    scoped_projection = service.get_scoped_projection(
        imported["projectId"], projection.runId
    )
    overview = service.get_scoped_overview(imported["projectId"], projection.runId)

    assert scoped_projection.allowedActions == []
    assert overview["projection"]["allowedActions"] == []


def test_scoped_overview_is_a_consistent_snapshot_during_a_transition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path / "project")
    imported = service.import_project(project_path, now=NOW)
    projection = service.create_run(
        imported["projectId"],
        imported["workflowVersionId"],
        title="Concurrent overview",
        execution_workspace=str(project_path),
        workspace_mode="write",
        actor=trusted_human(),
        idempotency_key="concurrent-overview",
        now=NOW,
    )
    action = next(
        candidate
        for candidate in projection.allowedActions
        if candidate.eventType == "NODE_STARTED"
    )
    original_list_for_run = service._events.list_for_run
    caller = current_thread()
    transition_finished = Event()
    transition_thread: list[Thread] = []
    triggered = False

    def start_interleaving_transition(run_id: str):
        nonlocal triggered
        if current_thread() is caller and not triggered:
            triggered = True

            def execute() -> None:
                service.execute_scoped_action(
                    imported["projectId"],
                    run_id,
                    action_id=action.id,
                    expected_revision=projection.revision,
                    actor=AGENT_ACTOR,
                    payload=None,
                    now="2026-07-27T13:01:00Z",
                )
                transition_finished.set()

            worker = Thread(target=execute)
            transition_thread.append(worker)
            worker.start()
            transition_finished.wait(timeout=2)
        return original_list_for_run(run_id)

    monkeypatch.setattr(service._events, "list_for_run", start_interleaving_transition)

    overview = service.get_scoped_overview(imported["projectId"], projection.runId)
    transition_thread[0].join(timeout=2)

    assert not transition_thread[0].is_alive()
    assert overview["activity"]["lastEventAt"] == overview["projection"]["updatedAt"]


def test_atomic_run_creation_allows_only_one_write_lease(tmp_path: Path) -> None:
    db_path = tmp_path / "workflow.db"
    setup_db = connect(db_path)
    migrate(setup_db)
    setup_service = WorkflowRuntimeService(setup_db)
    project_path = copy_harness_project(tmp_path / "project")
    imported = setup_service.import_project(project_path, now=NOW)
    setup_db.close()

    services = [WorkflowRuntimeService(connect(db_path)) for _ in range(2)]

    def create(index: int) -> RunProjection:
        return services[index].create_run(
            imported["projectId"],
            imported["workflowVersionId"],
            title=f"Concurrent run {index}",
            execution_workspace=str(project_path),
            workspace_mode="write",
            actor=trusted_human(),
            idempotency_key=f"concurrent-{index}",
            now=f"2026-08-05T0{index + 1}:00:00Z",
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(create, index) for index in range(2)]
        outcomes = []
        for future in futures:
            try:
                outcomes.append(future.result())
            except RuntimeContractError as error:
                outcomes.append(error)

    assert sum(isinstance(outcome, RunProjection) for outcome in outcomes) == 1
    conflicts = [outcome for outcome in outcomes if isinstance(outcome, RuntimeContractError)]
    assert len(conflicts) == 1
    assert conflicts[0].code == "WORKSPACE_LEASE_CONFLICT"
    verification_db = connect(db_path)
    assert verification_db.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 1
    assert verification_db.execute("SELECT COUNT(*) FROM run_workspace_leases").fetchone()[0] == 1
    for service in services:
        service._db.close()
    verification_db.close()


def test_atomic_run_creation_rolls_back_after_lease_failure_point(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path / "project")
    imported = service.import_project(project_path, now=NOW)

    def fail_event_append(*_args, **_kwargs) -> None:
        raise RuntimeError("INJECTED_EVENT_FAILURE")

    monkeypatch.setattr(service._events, "append", fail_event_append)
    with pytest.raises(RuntimeError, match="INJECTED_EVENT_FAILURE"):
        service.create_run(
            imported["projectId"],
            imported["workflowVersionId"],
            title="Rollback run",
            execution_workspace=str(project_path),
            workspace_mode="write",
            actor=trusted_human(),
            idempotency_key="rollback-key",
            now="2026-08-05T01:00:00Z",
        )

    assert db.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM run_workspace_leases").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM run_idempotency_keys").fetchone()[0] == 0


def test_idempotent_run_creation_reuses_rejects_and_expires_keys(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path / "project")
    imported = service.import_project(project_path, now=NOW)
    request = {
        "project_id": imported["projectId"],
        "workflow_version_id": imported["workflowVersionId"],
        "title": "Idempotent run",
        "execution_workspace": str(project_path),
        "workspace_mode": "write",
        "actor": trusted_human(),
        "idempotency_key": "idempotent-key",
    }

    first = service.create_run(**request, now="2026-08-05T01:00:00Z")
    retried = service.create_run(**request, now="2026-08-05T02:00:00Z")

    assert retried.runId == first.runId
    assert db.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 1
    with pytest.raises(RuntimeContractError) as mismatch:
        service.create_run(
            **{**request, "title": "Different request"},
            now="2026-08-05T03:00:00Z",
        )
    assert mismatch.value.code == "INVALID_REQUEST"

    service._workspace_leases.transition(
        first.runId,
        status="released",
        reason="test completed",
        transitioned_at="2026-08-05T03:30:00Z",
    )
    db.commit()
    replacement = service.create_run(**request, now="2026-08-06T02:00:01Z")

    assert replacement.runId != first.runId
    assert db.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 2
    key_row = db.execute(
        "SELECT run_id FROM run_idempotency_keys WHERE project_id = ? AND idempotency_key = ?",
        (imported["projectId"], "idempotent-key"),
    ).fetchone()
    assert key_row["run_id"] == replacement.runId


@pytest.mark.parametrize("title", ["", "x" * 121])
def test_atomic_run_creation_rejects_invalid_title_before_writes(
    tmp_path: Path, title: str
) -> None:
    db = connect(tmp_path / f"workflow-{len(title)}.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path / f"project-{len(title)}")
    imported = service.import_project(project_path, now=NOW)

    with pytest.raises(RuntimeContractError) as invalid:
        service.create_run(
            imported["projectId"],
            imported["workflowVersionId"],
            title=title,
            execution_workspace=str(project_path),
            workspace_mode="write",
            actor=trusted_human(),
            idempotency_key=f"title-{len(title)}",
            now="2026-08-05T01:00:00Z",
        )

    assert invalid.value.code == "INVALID_REQUEST"
    assert db.execute("SELECT COUNT(*) FROM runs").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM run_workspace_leases").fetchone()[0] == 0


def test_execution_lease_rejects_cross_project_released_and_read_leases(
    tmp_path: Path,
) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_a_path = copy_harness_project(tmp_path / "a")
    project_b_path = copy_harness_project(tmp_path / "b")
    project_a = service.import_project(project_a_path, now=NOW)
    project_b = service.import_project(project_b_path, now=NOW)
    write_run = service.create_run(
        project_a["projectId"],
        title="Write lease",
        execution_workspace=str(project_a_path),
        workspace_mode="write",
        actor=trusted_human(),
        idempotency_key="write-lease",
        now="2026-08-05T01:00:00Z",
    )

    with pytest.raises(RuntimeContractError) as cross_project:
        service._require_execution_lease(
            project_b["projectId"], write_run.runId, write_required=True
        )
    assert cross_project.value.code == "RUN_NOT_FOUND_IN_PROJECT"

    service._workspace_leases.transition(
        write_run.runId,
        status="released",
        reason="test release",
        transitioned_at="2026-08-05T01:01:00Z",
    )
    db.commit()
    with pytest.raises(RuntimeContractError) as released:
        service._require_execution_lease(
            project_a["projectId"], write_run.runId, write_required=True
        )
    assert released.value.code == "WORKSPACE_RECOVERY_REQUIRED"

    read_workspace = project_a_path / "read-workspace"
    read_workspace.mkdir()
    read_run = service.create_run(
        project_a["projectId"],
        title="Read lease",
        execution_workspace=str(read_workspace),
        workspace_mode="read",
        actor=trusted_human(),
        idempotency_key="read-lease",
        now="2026-08-05T01:02:00Z",
    )
    with pytest.raises(RuntimeContractError) as read_only:
        service._require_execution_lease(
            project_a["projectId"], read_run.runId, write_required=True
        )
    assert read_only.value.code == "WORKSPACE_RECOVERY_REQUIRED"

    service._workspace_leases.transition(
        read_run.runId,
        status="expired",
        reason="recovery required",
        transitioned_at="2026-08-05T01:03:00Z",
    )
    db.commit()
    with pytest.raises(RuntimeContractError) as expired:
        service._require_execution_lease(
            project_a["projectId"], read_run.runId, write_required=False
        )
    assert expired.value.code == "WORKSPACE_RECOVERY_REQUIRED"
    db.execute("DELETE FROM run_workspace_leases WHERE run_id = ?", (read_run.runId,))
    db.commit()
    with pytest.raises(RuntimeContractError) as missing:
        service._require_execution_lease(
            project_a["projectId"], read_run.runId, write_required=False
        )
    assert missing.value.code == "WORKSPACE_RECOVERY_REQUIRED"

    archived_workspace = project_b_path / "archived-workspace"
    archived_workspace.mkdir()
    archived_project_run = service.create_run(
        project_b["projectId"],
        title="Archived project",
        execution_workspace=str(archived_workspace),
        workspace_mode="write",
        actor=trusted_human(),
        idempotency_key="archived-project",
        now="2026-08-05T01:04:00Z",
    )
    service.archive_project(
        project_b["projectId"], actor=trusted_human().model_dump(), now="2026-08-05T01:05:00Z"
    )
    with pytest.raises(RuntimeContractError) as archived_project:
        service._require_execution_lease(
            project_b["projectId"], archived_project_run.runId, write_required=True
        )
    assert archived_project.value.code == "PROJECT_ARCHIVED"

    archived_run_workspace = project_a_path / "archived-run-workspace"
    archived_run_workspace.mkdir()
    archived_run = service.create_run(
        project_a["projectId"],
        title="Archived Run",
        execution_workspace=str(archived_run_workspace),
        workspace_mode="write",
        actor=trusted_human(),
        idempotency_key="archived-run",
        now="2026-08-05T01:06:00Z",
    )
    db.execute(
        "UPDATE run_projections SET status = 'ARCHIVED' WHERE run_id = ?",
        (archived_run.runId,),
    )
    db.commit()
    with pytest.raises(RuntimeContractError) as archived_run_error:
        service._require_execution_lease(
            project_a["projectId"], archived_run.runId, write_required=True
        )
    assert archived_run_error.value.code == "RUN_ARCHIVED"


def test_scoped_agent_execution_lease_requires_exact_run_workspace(
    tmp_path: Path,
) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    run = service.create_run(
        project["projectId"],
        title="Scoped agent",
        execution_workspace=str(project_path),
        workspace_mode="write",
        actor=trusted_human(),
        idempotency_key="scoped-agent",
        now="2026-08-05T01:00:00Z",
    )
    mismatched_cwd = project_path / "other"
    mismatched_cwd.mkdir()

    with pytest.raises(RuntimeContractError) as mismatch:
        service.start_agent_job(
            run.runId,
            project_id=project["projectId"],
            node_id="plan",
            provider="fake",
            prompt="test",
            cwd=str(mismatched_cwd),
            actor=AGENT_ACTOR,
            now="2026-08-05T01:01:00Z",
        )
    assert mismatch.value.code == "EXECUTION_WORKSPACE_MISMATCH"

    job = service.start_agent_job(
        run.runId,
        project_id=project["projectId"],
        node_id="plan",
        provider="fake",
        prompt="test",
        cwd=str(project_path),
        actor=AGENT_ACTOR,
        now="2026-08-05T01:02:00Z",
    )
    assert os.path.normcase(job["cwd"]) == os.path.normcase(str(project_path.resolve()))


def test_migration_backfills_project_scoped_assets_and_bindings(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    imported = service.import_project(copy_harness_project(tmp_path / "legacy"), now=NOW)

    db.execute("PRAGMA foreign_keys = OFF")
    db.execute("DROP TABLE project_workflow_bindings")
    db.execute("DROP TABLE workflow_assets")
    db.commit()
    db.execute("PRAGMA foreign_keys = ON")
    migrate(db)

    binding = service.get_project_workflow_binding(imported["projectId"])
    run = service.create_run(imported["projectId"], title="legacy migration", now=NOW)

    assert binding is not None
    assert binding["workflowVersionId"] == imported["workflowVersionId"]
    assert run.status == "CREATED"


def test_migration_binds_the_latest_version_when_a_legacy_project_has_multiple_workflows(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    imported = service.import_project(copy_harness_project(tmp_path / "legacy-multiple"), now=NOW)
    first = service.get_workflow_definition(imported["workflowVersionId"])
    second = WorkflowDefinition.model_validate({**first, "id": "legacy-second", "name": "Second workflow"})
    second_version_id = "workflow-version-legacy-second"
    second_asset_id = f"workflow-asset:{imported['projectId']}:legacy-second"
    service._workflow_assets.save(
        id=second_asset_id,
        name=second.name,
        is_builtin=False,
        actor=trusted_human().model_dump(),
        now="2026-07-28T00:00:00Z",
        workflow_version_id=None,
    )
    service._workflow_versions.save(
        second,
        id=second_version_id,
        project_id=imported["projectId"],
        content_hash="legacy-second",
        workflow_asset_id=second_asset_id,
        created_at="2026-07-28T00:00:00Z",
    )
    db.execute("DROP TABLE project_workflow_bindings")
    db.commit()

    migrate(db)

    binding = service.get_project_workflow_binding(imported["projectId"])
    assert binding is not None
    assert binding["workflowVersionId"] == second_version_id
    assert binding["workflowId"] == second_asset_id


def test_workflow_version_id_cannot_mutate_its_asset_ownership(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    imported = service.import_project(copy_harness_project(tmp_path / "immutable-version"), now=NOW)
    version_id = imported["workflowVersionId"]
    metadata = service._workflow_versions.metadata(version_id)
    definition = service._workflow_versions.get(version_id)

    assert metadata is not None and definition is not None
    service._workflow_versions.save(
        definition,
        id=version_id,
        project_id=metadata["project_id"],
        content_hash=metadata["content_hash"],
        workflow_asset_id=metadata["workflow_asset_id"],
        created_at=metadata["created_at"],
        adapter_id=metadata["adapter_id"],
    )
    with pytest.raises(ValueError, match="WORKFLOW_VERSION_IMMUTABLE"):
        service._workflow_versions.save(
            definition,
            id=version_id,
            project_id=metadata["project_id"],
            content_hash="different-content",
            workflow_asset_id="workflow-asset:other:workflow",
            created_at=metadata["created_at"],
            adapter_id=metadata["adapter_id"],
        )


def test_binding_rejects_an_archived_project_inside_the_binding_transaction(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project = service.import_project(copy_harness_project(tmp_path / "binding-archive"), now=NOW)
    service.archive_project(project["projectId"], actor=trusted_human().model_dump(), now=NOW)

    with pytest.raises(ValueError, match="PROJECT_ARCHIVED"):
        service.bind_project_workflow(
            project["projectId"],
            workflow_id=project["workflowId"],
            workflow_version_id=project["workflowVersionId"],
            actor=trusted_human().model_dump(),
            now="2026-08-05T00:00:00Z",
        )


def test_archived_project_rejects_transitions_for_existing_runs(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project = service.import_project(copy_harness_project(tmp_path / "archived-run"), now=NOW)
    run = service.create_run(project["projectId"], title="Existing run", now=NOW)
    service.archive_project(project["projectId"], actor=trusted_human().model_dump(), now="2026-08-05T00:00:00Z")

    with pytest.raises(ValueError, match="PROJECT_ARCHIVED"):
        service.transition_run(
            run.runId,
            "NODE_STARTED",
            node_id="plan",
            actor=trusted_human().model_dump(),
            expected_revision=run.revision,
            now="2026-08-05T00:01:00Z",
        )


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
    gates = service.list_gate_results(run.runId)
    assert len(gates) == 1
    assert gates[0]["id"] == f"{run.runId}:gate:plan:plan-ready:5"
    assert gates[0]["status"] == "waived"
    assert gates[0]["waiverReason"] == "temporary exception approved by verifier"
    assert gates[0]["artifactHashes"]
    assert gates[0]["invalidatedAt"] is None


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


def test_runtime_service_starts_an_agent_in_a_project_worktree(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    run = service.create_run(project["workflowVersionId"], title="Worktree Agent Run", now=NOW)
    worktree = project_path / ".workflow-platform" / "worktrees" / "dev"
    worktree.mkdir(parents=True)

    job = service.start_agent_job(
        run.runId,
        node_id="plan",
        provider="fake",
        prompt="在 dev worktree 中实现变更",
        actor=AGENT_ACTOR,
        cwd=str(worktree),
        now=NOW,
    )

    assert job["cwd"] == str(worktree.resolve())


def test_runtime_service_rejects_saving_workflow_versions_with_compiler_diagnostics(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    definition = service.get_workflow_definition(project["workflowVersionId"])
    definition["edges"].append(
        {
            "id": "cycle",
            "from": "review",
            "to": "plan",
        }
    )

    with pytest.raises(ValueError, match="WORKFLOW_DIAGNOSTICS_ERROR"):
        service.save_workflow_version(
            project["workflowVersionId"],
            definition=definition,
            actor=trusted_human().model_dump(),
            now=NOW,
        )


def test_runtime_service_scans_declared_artifacts_idempotently() -> None:
    workspace = Path(__file__).parent / ".artifact_scan_runtime"
    rmtree(workspace, ignore_errors=True)
    workspace.mkdir(parents=True)
    try:
        _assert_runtime_service_scans_declared_artifacts_idempotently(workspace)
    finally:
        rmtree(workspace, ignore_errors=True)


def _assert_runtime_service_scans_declared_artifacts_idempotently(workspace: Path) -> None:
    db = connect(workspace / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(workspace)
    project = service.import_project(project_path, now=NOW)
    definition = service.get_workflow_definition(project["workflowVersionId"])
    plan_node = next(node for node in definition["nodes"] if node["id"] == "plan")
    plan_node["artifacts"] = {
        "outputs": [
            {
                "id": "plan-report",
                "name": "计划报告",
                "type": "plan",
                "required": True,
                "path": "docs/runs/{{runId}}/{{nodeId}}/plan.md",
            }
        ]
    }
    saved = service.save_workflow_version(
        project["workflowVersionId"],
        definition=definition,
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    run = service.create_run(saved["workflowVersionId"], title="扫描产物", now=NOW)
    target = project_path / "docs" / "runs" / run.runId / "plan" / "plan.md"
    target.parent.mkdir(parents=True)
    target.write_text("# 计划\n", encoding="utf-8")
    started = service.transition_run(
        run.runId,
        "NODE_STARTED",
        node_id="plan",
        actor=AGENT_ACTOR,
        expected_revision=run.revision,
        now=NOW,
    )

    first = service.scan_node_artifacts(
        run.runId,
        node_id="plan",
        expected_revision=started.revision,
        now=NOW,
    )
    second = service.scan_node_artifacts(
        run.runId,
        node_id="plan",
        expected_revision=first["projection"].revision,
        now=NOW,
    )

    assert first["registered"] == ["plan-report"]
    assert second["unchanged"] == ["plan-report"]
    assert len(service.list_artifacts(run.runId)) == 1
    assert service.timeline(run.runId)[-1]["payload"]["artifactSpecId"] == "plan-report"

    target.write_text("# 计划\n\n已更新。\n", encoding="utf-8")
    changed = service.scan_node_artifacts(
        run.runId,
        node_id="plan",
        expected_revision=second["projection"].revision,
        now="2026-07-28T13:00:00Z",
    )
    artifacts = service.list_artifacts(run.runId)

    assert changed["registered"] == ["plan-report"]
    assert len(artifacts) == 2
    assert artifacts[0]["status"] == "invalidated"
    assert artifacts[1]["status"] == "verified"
    assert artifacts[1]["supersedesArtifactId"] == artifacts[0]["id"]


def test_runtime_service_keeps_provisional_artifact_out_of_transition_until_confirmed(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db)
    project_path = copy_harness_project(tmp_path)
    project = service.import_project(project_path, now=NOW)
    definition = service.get_workflow_definition(project["workflowVersionId"])
    plan_node = next(node for node in definition["nodes"] if node["id"] == "plan")
    plan_node["artifacts"] = {
        "outputs": [{
            "id": "plan-report",
            "name": "计划报告",
            "type": "plan",
            "required": True,
            "path": "docs/runs/{{runId}}/{{nodeId}}/plan.md",
        }]
    }
    saved = service.save_workflow_version(
        project["workflowVersionId"], definition=definition, actor=trusted_human().model_dump(), now=NOW
    )
    run = service.create_run(saved["workflowVersionId"], title="确认临时产物", now=NOW)
    target = project_path / "docs" / "runs" / run.runId / "plan" / "plan.md"
    target.parent.mkdir(parents=True)
    target.write_text("等待人工确认", encoding="utf-8")
    started = service.transition_run(
        run.runId, "NODE_STARTED", node_id="plan", actor=AGENT_ACTOR,
        expected_revision=run.revision, now=NOW,
    )

    provisional = service.submit_artifact(
        run.runId, node_id="plan", artifact_path=target, artifact_type="plan",
        artifact_status="provisional", actor=AGENT_ACTOR,
        expected_revision=started.revision, now=NOW,
    )

    assert provisional.revision == started.revision
    assert service.timeline(run.runId)[-1]["type"] == "NODE_STARTED"
    artifact = service.list_artifacts(run.runId)[0]
    assert artifact["status"] == "provisional"

    confirmed = service.confirm_artifact(
        run.runId, node_id="plan", artifact_id=artifact["id"],
        actor=trusted_human().model_dump(), expected_revision=started.revision, now=NOW,
    )

    assert confirmed["artifact"]["status"] == "verified"
    assert confirmed["projection"].revision != started.revision
    assert service.timeline(run.runId)[-1]["type"] == "ARTIFACT_SUBMITTED"


def test_runtime_service_injects_passed_upstream_artifacts_into_agent_prompt() -> None:
    class RecordingProvider(FakeProvider):
        def __init__(self) -> None:
            self.prompts: list[str] = []

        def build_command(self, *, cwd: Path, prompt: str, allowed_tools: list[str]) -> CliCommand:
            self.prompts.append(prompt)
            return super().build_command(cwd=cwd, prompt=prompt, allowed_tools=allowed_tools)

    workspace = Path(__file__).parent / ".agent_prompt_runtime"
    rmtree(workspace, ignore_errors=True)
    workspace.mkdir(parents=True)
    try:
        db = connect(workspace / "workflow.db")
        migrate(db)
        provider = RecordingProvider()
        service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: provider)
        project_path = copy_harness_project(workspace)
        project = service.import_project(project_path, now=NOW)
        definition = service.get_workflow_definition(project["workflowVersionId"])
        plan_node = next(node for node in definition["nodes"] if node["id"] == "plan")
        review_node = next(node for node in definition["nodes"] if node["id"] == "review")
        plan_node["artifacts"] = {
            "outputs": [
                {
                    "id": "plan-report",
                    "name": "计划报告",
                    "type": "plan",
                    "required": True,
                    "path": "docs/runs/{{runId}}/{{nodeId}}/plan.md",
                }
            ]
        }
        review_node["kind"] = "agent"
        review_node["agent"] = {
            "promptTemplate": "审阅上游计划。",
            "context": {
                "upstream": "direct",
                "delivery": "summary",
                "artifactTypes": ["plan"],
                "maxArtifacts": 4,
                "summaryCharsPerArtifact": 1000,
                "maxTotalChars": 4000,
            },
        }
        saved = service.save_workflow_version(
            project["workflowVersionId"],
            definition=definition,
            actor=trusted_human().model_dump(),
            now=NOW,
        )
        run = service.create_run(saved["workflowVersionId"], title="上下文注入", now=NOW)
        target = project_path / "docs" / "runs" / run.runId / "plan" / "plan.md"
        target.parent.mkdir(parents=True)
        target.write_text("上游计划正文", encoding="utf-8")
        started = service.transition_run(run.runId, "NODE_STARTED", node_id="plan", actor=AGENT_ACTOR, expected_revision=run.revision, now=NOW)
        scanned = service.scan_node_artifacts(run.runId, node_id="plan", expected_revision=started.revision, now=NOW)
        completed = service.transition_run(
            run.runId,
            "NODE_COMPLETED",
            node_id="plan",
            actor={"id": "executor", "type": "executor", "source": "runtime", "trusted": True},
            expected_revision=scanned["projection"].revision,
            now=NOW,
        )
        passed = service.submit_gate_result(
            run.runId,
            node_id="plan",
            gate_id="plan-ready",
            status="passed",
            evidence=[target.as_uri()],
            waiver_reason=None,
            actor={"id": "verifier", "type": "verifier", "source": "runtime", "trusted": True},
            expected_revision=completed.revision,
            now=NOW,
        )

        job = service.start_agent_job(
            run.runId,
            node_id="review",
            provider="fake",
            prompt="请给出审阅结论。",
            actor=AGENT_ACTOR,
            now=NOW,
        )

        assert "审阅上游计划。" in provider.prompts[-1]
        assert "请给出审阅结论。" in provider.prompts[-1]
        assert "上游计划正文" in provider.prompts[-1]
        assert job["effectivePrompt"] == provider.prompts[-1]
        assert job["contextArtifacts"][0]["artifactId"]
        consumers = service.list_artifact_consumers(run.runId, job["contextArtifacts"][0]["artifactId"])
        assert consumers[0]["agentJobId"] == job["id"]
        assert consumers[0]["consumerNodeId"] == "review"

        target.write_text("上游计划正文已修改", encoding="utf-8")
        rescanned = service.scan_node_artifacts(
            run.runId,
            node_id="plan",
            expected_revision=passed.revision,
            now="2026-07-28T14:00:00Z",
        )
        assert rescanned["projection"].nodeStates["plan"] == "AWAITING_GATE"
        gate = service.list_gate_results(run.runId)[0]
        assert gate["artifactHashes"]
        assert gate["invalidatedAt"] == "2026-07-28T14:00:00Z"
    finally:
        rmtree(workspace, ignore_errors=True)


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
    assert checkpoint["prompt"] == "用户任务：\n保存后恢复这个 Agent 任务"
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


def test_run_execution_workspace_is_reused_by_default_agent_jobs(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    project_path = copy_harness_project(tmp_path)
    worktree = project_path / ".workflow-platform" / "worktrees" / "dev"
    worktree.mkdir(parents=True)
    project = service.import_project(project_path, now=NOW)

    run = service.create_run(
        project["workflowVersionId"],
        title="Worktree Run",
        execution_workspace=str(worktree),
        now=NOW,
    )
    job = service.start_agent_job(
        run.runId,
        node_id="plan",
        provider="fake",
        prompt="在工作树中修改文件",
        actor=AGENT_ACTOR,
        mode="automatic",
        now=NOW,
    )

    normalized_worktree = os.path.normcase(str(worktree.resolve()))
    assert service.list_runs_for_workflow_version(project["workflowVersionId"])[0]["context"]["executionWorkspace"] == normalized_worktree
    assert os.path.normcase(job["cwd"]) == normalized_worktree


def _create_interactive_agent_job(
    tmp_path: Path,
) -> tuple[WorkflowRuntimeService, RunProjection, dict]:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="Interactive Agent Run", now=NOW)
    job = service.start_agent_job(
        run.runId,
        node_id="plan",
        provider="fake",
        prompt="请先询问目标分支",
        mode="interactive",
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    return service, run, job


def test_runtime_service_creates_interactive_agent_and_audits_user_input(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)

    session = service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    recorded = service.record_interactive_agent_input(
        run.runId,
        job["id"],
        content="目标分支是 release",
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    assert job["mode"] == "interactive"
    assert session["status"] == "RUNNING"
    assert service.list_agent_input(session["id"]) == [
        {
            "id": f"{session['id']}:input:1",
            "sessionId": session["id"],
            "sequence": 1,
            "kind": "initial_prompt",
                "content": "用户任务：\n请先询问目标分支",
            "createdAt": NOW,
        },
        recorded,
    ]
    assert any(
        item["action"] == "agent.interactive.input.recorded"
        for item in service.list_audit_records()
    )
    created_audit = service.list_audit_records(action="agent.interactive.created")[0]
    assert created_audit["actor"]["id"] == trusted_human().id
    assert created_audit["actor"]["type"] == "human"


def test_runtime_service_redacts_interactive_prompt_in_persisted_command(tmp_path) -> None:
    class PromptArgumentProvider(FakeProvider):
        def build_command(
            self,
            *,
            cwd: Path,
            prompt: str,
            allowed_tools: list[str],
        ) -> CliCommand:
            return CliCommand(
                executable=sys.executable,
                args=[str(FAKE_CLI), "complete", prompt],
                cwd=cwd,
            )

    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(
        db,
        agent_provider_factory=lambda _provider: PromptArgumentProvider(),
    )
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="Prompt Redaction", now=NOW)
    prompt = "请使用 token=secret-value 继续"

    job = service.start_agent_job(
        run.runId,
        node_id="plan",
        provider="fake",
        prompt=prompt,
        mode="interactive",
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    assert "secret-value" not in " ".join(job["command"])
    assert "[REDACTED]" in " ".join(job["command"])
    session = service._agent_sessions.get_for_job(job["id"])
    assert session is not None
    assert "secret-value" not in service.list_agent_input(session["id"])[0]["content"]


def test_runtime_service_rolls_back_interactive_job_when_audit_write_fails(
    tmp_path,
    monkeypatch,
) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="Failed Interactive Audit", now=NOW)

    def fail_audit(**_kwargs) -> None:
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(service._audit, "record", fail_audit)

    with pytest.raises(RuntimeError, match="audit unavailable"):
        service.start_agent_job(
            run.runId,
            node_id="plan",
            provider="fake",
            prompt="请询问用户",
            mode="interactive",
            actor=trusted_human().model_dump(),
            now=NOW,
        )

    assert service.list_agent_jobs(run.runId) == []


def test_runtime_service_rolls_back_interactive_session_start_when_audit_write_fails(
    tmp_path,
    monkeypatch,
) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)

    def fail_audit(**_kwargs) -> None:
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(service._audit, "record", fail_audit)

    with pytest.raises(RuntimeError, match="audit unavailable"):
        service.start_interactive_agent_session(
            run.runId,
            job["id"],
            desktop_session_id="pty-1",
            pid=1234,
            actor=trusted_human().model_dump(),
            now=NOW,
        )

    session = service._agent_sessions.get_for_job(job["id"])
    assert session is not None
    assert session["status"] == "QUEUED"
    assert service.get_agent_job(run.runId, job["id"])["status"] == "QUEUED"


def test_runtime_service_does_not_mark_a_bound_interactive_session_as_orphan(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=12,
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    diagnostic = service.get_recovery_diagnostics(run.runId)

    assert job["id"] not in diagnostic["orphanAgentJobIds"]


def test_runtime_service_marks_bound_interactive_session_orphan_after_runtime_restart(
    tmp_path,
) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=12,
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    restarted = WorkflowRuntimeService(
        service._db,
        agent_provider_factory=lambda _provider: FakeProvider(),
    )

    diagnostic = restarted.get_recovery_diagnostics(run.runId)
    cleaned = restarted.cleanup_orphan_agent_jobs(run.runId, now=NOW)

    assert job["id"] in diagnostic["orphanAgentJobIds"]
    assert cleaned["cleanedJobIds"] == [job["id"]]
    assert restarted.get_agent_job(run.runId, job["id"])["status"] == "CANCELLED"
    recovered_session = restarted._agent_sessions.get_for_job(job["id"])
    assert recovered_session is not None
    assert recovered_session["status"] == "RECOVERABLE"


def test_runtime_service_rejects_interactive_input_from_untrusted_actor(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)

    with pytest.raises(ValueError, match="ACTOR_NOT_TRUSTED"):
        service.record_interactive_agent_input(
            run.runId,
            job["id"],
            content="继续",
            actor=AGENT_ACTOR,
            now=NOW,
        )


@pytest.mark.parametrize("content", ["", "   ", "回答\x00无效"])
def test_runtime_service_rejects_empty_or_nul_interactive_input(tmp_path, content: str) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)

    with pytest.raises(ValueError, match="AGENT_INTERACTIVE_INPUT_INVALID"):
        service.record_interactive_agent_input(
            run.runId,
            job["id"],
            content=content,
            actor=trusted_human().model_dump(),
            now=NOW,
        )


def test_runtime_service_appends_output_and_finishes_interactive_agent_session(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    output = service.append_interactive_agent_output(
        run.runId,
        job["id"],
        events=[{"data": "已收到 token=secret-value\r\n"}],
        now=NOW,
    )
    finished = service.finish_interactive_agent_session(
        run.runId,
        job["id"],
        status="COMPLETED",
        summary="任务完成",
        error=None,
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    assert output[0]["kind"] == "terminal_raw"
    assert output[0]["payload"]["text"] == "已收到 token=[REDACTED]\r\n"
    assert finished["status"] == "COMPLETED"
    assert service.get_agent_job(run.runId, job["id"])["status"] == "COMPLETED"


def test_runtime_service_rolls_back_interactive_session_finish_when_audit_write_fails(
    tmp_path,
    monkeypatch,
) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    def fail_audit(**_kwargs) -> None:
        raise RuntimeError("audit unavailable")

    monkeypatch.setattr(service._audit, "record", fail_audit)

    with pytest.raises(RuntimeError, match="audit unavailable"):
        service.finish_interactive_agent_session(
            run.runId,
            job["id"],
            status="COMPLETED",
            summary="任务完成",
            error=None,
            actor=trusted_human().model_dump(),
            now=NOW,
        )

    session = service._agent_sessions.get_for_job(job["id"])
    assert session is not None
    assert session["status"] == "RUNNING"
    assert service.get_agent_job(run.runId, job["id"])["status"] == "RUNNING"


def test_runtime_service_rejects_an_invalid_interactive_output_batch_atomically(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    with pytest.raises(ValueError, match="AGENT_INTERACTIVE_OUTPUT_INVALID"):
        service.append_interactive_agent_output(
            run.runId,
            job["id"],
            events=[{"data": "有效输出"}, {"data": ""}],
            now=NOW,
        )

    assert service.list_agent_output(job["id"]) == []


def test_runtime_service_sanitizes_unpaired_surrogates_in_interactive_output(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    output = service.append_interactive_agent_output(
        run.runId,
        job["id"],
        events=[{"data": "partial:\ud800"}],
        now=NOW,
    )

    assert output[0]["payload"]["text"] == "partial:\ufffd"


def test_runtime_service_sanitizes_legacy_interactive_output_on_read(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    service._agent_jobs.append_output(
        id=f"{job['id']}:output:1",
        job_id=job["id"],
        sequence=1,
        kind="terminal_raw",
        payload={"text": "legacy:\ud800"},
        created_at=NOW,
    )
    service._db.commit()

    output = service.list_agent_output(job["id"])

    assert output[0]["payload"]["text"] == "legacy:\ufffd"


def test_runtime_service_keeps_recent_interactive_output_when_persistence_limit_is_exceeded(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    service._db.execute(
        "UPDATE agent_sessions SET max_output_bytes = ? WHERE job_id = ?",
        (8, job["id"]),
    )
    service._db.commit()

    service.append_interactive_agent_output(
        run.runId,
        job["id"],
        events=[{"data": "old-data"}],
        now=NOW,
    )
    output = service.append_interactive_agent_output(
        run.runId,
        job["id"],
        events=[{"data": "new-data"}],
        now=NOW,
    )

    session = service._agent_sessions.get_for_job(job["id"])
    assert session is not None
    assert session["status"] == "RUNNING"
    assert service.get_agent_job(run.runId, job["id"])["status"] == "RUNNING"
    assert output[0]["payload"]["text"] == "new-data"
    assert [event["payload"]["text"] for event in service.list_agent_output(job["id"])] == [
        "new-data"
    ]
    assert (
        service.list_audit_records(action="agent.interactive.output.persistence_limited")[0]["detail"][
            "reason"
        ]
        == "AGENT_OUTPUT_HISTORY_TRIMMED"
    )


def test_runtime_service_continues_interactive_agent_with_history(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    session = service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    service.record_interactive_agent_input(
        run.runId,
        job["id"],
        content="目标分支是 release",
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    service.append_interactive_agent_output(
        run.runId,
        job["id"],
        events=[{"data": "请确认发布范围"}],
        now=NOW,
    )
    service.finish_interactive_agent_session(
        run.runId,
        job["id"],
        status="RECOVERABLE",
        summary=None,
        error="应用重启",
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    continued = service.continue_interactive_agent(
        run.runId,
        job["id"],
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    continued_session = service._agent_sessions.get_for_job(continued["id"])

    assert continued["mode"] == "interactive"
    assert continued["parentJobId"] == job["id"]
    assert continued_session is not None
    assert service.list_agent_input(continued_session["id"])[0]["content"].startswith(
        "用户任务：\n历史交互记录："
    )
    assert "请确认发布范围" in service.list_agent_input(continued_session["id"])[0]["content"]
    assert session["id"] != continued_session["id"]


def test_runtime_service_rejects_invalid_agent_mode(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="Invalid Agent Mode", now=NOW)

    with pytest.raises(ValueError, match="AGENT_MODE_INVALID"):
        service.start_agent_job(
            run.runId,
            node_id="plan",
            provider="fake",
            prompt="x",
            mode="batch",
            actor=trusted_human().model_dump(),
            now=NOW,
        )


def test_runtime_service_rejects_interactive_agent_start_from_untrusted_actor(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider())
    project = service.import_project(copy_harness_project(tmp_path), now=NOW)
    run = service.create_run(project["workflowVersionId"], title="Untrusted Interactive Agent", now=NOW)

    with pytest.raises(ValueError, match="ACTOR_NOT_TRUSTED"):
        service.start_agent_job(
            run.runId,
            node_id="plan",
            provider="fake",
            prompt="请询问用户",
            mode="interactive",
            actor=AGENT_ACTOR,
            now=NOW,
        )


def test_runtime_service_marks_unbound_interactive_session_recoverable(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)

    diagnostic = service.get_recovery_diagnostics(run.runId)

    assert job["id"] in diagnostic["orphanAgentJobIds"]


def test_runtime_service_recovers_orphaned_interactive_session(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    session = service._agent_sessions.get_for_job(job["id"])
    assert session is not None

    cleaned = service.cleanup_orphan_agent_jobs(run.runId, now=NOW)

    assert cleaned["cleanedJobIds"] == [job["id"]]
    assert service._agent_sessions.get_for_job(job["id"]) == {
        **session,
        "status": "RECOVERABLE",
        "recoveryReason": "RECOVERY_ORPHANED: interactive desktop session is unavailable",
        "endedAt": NOW,
    }


def test_runtime_service_cancels_running_interactive_agent_session(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    service.cancel_agent_job(
        run.runId,
        job["id"],
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    session = service._agent_sessions.get_for_job(job["id"])
    assert service.get_agent_job(run.runId, job["id"])["status"] == "CANCELLED"
    assert session is not None
    assert session["status"] == "CANCELLED"
    assert session["endedAt"] is not None
    assert any(
        item["action"] == "agent.interactive.session.cancelled"
        for item in service.list_audit_records()
    )


def test_runtime_service_does_not_cancel_finished_interactive_agent_session(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    service.finish_interactive_agent_session(
        run.runId,
        job["id"],
        status="COMPLETED",
        summary="任务完成",
        error=None,
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    cancelled = service.cancel_agent_job(
        run.runId,
        job["id"],
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    session = service._agent_sessions.get_for_job(job["id"])
    assert cancelled["status"] == "COMPLETED"
    assert session is not None
    assert session["status"] == "COMPLETED"


def test_runtime_service_does_not_overwrite_finished_session_during_cancel(tmp_path) -> None:
    service, run, job = _create_interactive_agent_job(tmp_path)
    session = service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    service._agent_sessions.finish(
        id=session["id"],
        status="COMPLETED",
        recovery_reason=None,
        ended_at=NOW,
    )
    service._db.commit()

    cancelled = service.cancel_agent_job(
        run.runId,
        job["id"],
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    stored = service._agent_sessions.get_for_job(job["id"])
    assert cancelled["status"] == "RUNNING"
    assert stored is not None
    assert stored["status"] == "COMPLETED"
