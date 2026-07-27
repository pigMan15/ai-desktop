from pathlib import Path

import pytest

from workflow_platform.execution.agent import AgentExecutor, DefaultAgentExecutor
from workflow_platform.terminals.service import create_terminal_session, terminal_session_to_record


@pytest.fixture
def workspace_path() -> Path:
    return Path(__file__).parent / ".execution_boundaries_tmp"


def test_create_terminal_session_binds_scope_and_status(workspace_path: Path) -> None:
    session = create_terminal_session(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        kind="shell",
        cwd=workspace_path,
        project_root=workspace_path.parent,
    )

    assert session["id"]
    assert isinstance(session["id"], str)
    assert session["projectId"] == "project-1"
    assert session["runId"] == "run-1"
    assert session["nodeId"] == "node-1"
    assert session["kind"] == "shell"
    assert session["cwd"] == str(workspace_path.resolve())
    assert session["status"] == "created"


def test_create_terminal_session_returns_stable_schema_fields(workspace_path: Path) -> None:
    session = create_terminal_session(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        kind="shell",
        cwd=workspace_path,
        project_root=workspace_path.parent,
    )

    assert set(session) == {
        "id",
        "projectId",
        "runId",
        "nodeId",
        "kind",
        "status",
        "cwd",
        "pid",
        "createdAt",
        "updatedAt",
    }
    assert session["pid"] is None
    assert session["createdAt"]
    assert session["updatedAt"]
    assert session["createdAt"] == session["updatedAt"]


def test_terminal_session_to_record_maps_api_dto_to_persistence_schema(workspace_path: Path) -> None:
    session = create_terminal_session(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        kind="shell",
        cwd=workspace_path,
        project_root=workspace_path.parent,
    )

    record = terminal_session_to_record(session)

    assert set(record) == {
        "id",
        "project_id",
        "run_id",
        "node_id",
        "kind",
        "status",
        "cwd",
        "pid",
        "created_at",
        "updated_at",
    }
    assert record["project_id"] == session["projectId"]
    assert record["run_id"] == session["runId"]
    assert record["node_id"] == session["nodeId"]
    assert record["created_at"] == session["createdAt"]
    assert record["updated_at"] == session["updatedAt"]


@pytest.mark.parametrize("kind", ["shell", "codex"])
def test_create_terminal_session_accepts_supported_kinds(workspace_path: Path, kind: str) -> None:
    session = create_terminal_session(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        kind=kind,
        cwd=workspace_path,
    )

    assert session["kind"] == kind


def test_create_terminal_session_resolves_relative_cwd_inside_project_root(workspace_path: Path) -> None:
    session = create_terminal_session(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        kind="shell",
        cwd="child",
        project_root=workspace_path,
    )

    assert session["cwd"] == str((workspace_path / "child").resolve())


def test_create_terminal_session_allows_relative_project_root_cwd(workspace_path: Path) -> None:
    session = create_terminal_session(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        kind="shell",
        cwd=".",
        project_root=workspace_path,
    )

    assert session["cwd"] == str(workspace_path.resolve())


def test_create_terminal_session_allows_project_root_as_cwd(workspace_path: Path) -> None:
    session = create_terminal_session(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        kind="shell",
        cwd=workspace_path,
        project_root=workspace_path,
    )

    assert session["cwd"] == str(workspace_path.resolve())


def test_create_terminal_session_rejects_relative_cwd_escape(workspace_path: Path) -> None:
    with pytest.raises(ValueError, match="within project root"):
        create_terminal_session(
            project_id="project-1",
            run_id="run-1",
            node_id="node-1",
            kind="shell",
            cwd="..",
            project_root=workspace_path,
        )


def test_create_terminal_session_rejects_cwd_outside_project_root(workspace_path: Path) -> None:
    with pytest.raises(ValueError, match="within project root"):
        create_terminal_session(
            project_id="project-1",
            run_id="run-1",
            node_id="node-1",
            kind="shell",
            cwd=workspace_path.parent / "other-project",
            project_root=workspace_path,
        )


def test_create_terminal_session_rejects_unsupported_kind(workspace_path: Path) -> None:
    with pytest.raises(ValueError, match="kind"):
        create_terminal_session(
            project_id="project-1",
            run_id="run-1",
            node_id="node-1",
            kind="python",
            cwd=workspace_path,
        )


def test_default_agent_executor_start_returns_interrupted_checkpoint() -> None:
    result = DefaultAgentExecutor().start(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        agent="codex",
        input={"prompt": "implement task"},
    )

    assert result["status"] == "interrupted"
    assert result["messages"] == []
    assert set(result["checkpoint"]) == {"id", "provider"}
    assert result["checkpoint"]["id"]
    assert isinstance(result["checkpoint"]["id"], str)
    assert result["checkpoint"]["provider"] == "codex"


def test_default_agent_executor_resume_completes_and_preserves_checkpoint() -> None:
    executor = DefaultAgentExecutor()
    started = executor.start(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        agent="codex",
        input={"prompt": "implement task"},
    )

    resumed = executor.resume(handle=started, input={"answer": "continue"})

    assert resumed["status"] == "completed"
    assert resumed["checkpoint"] == started["checkpoint"]
    assert resumed["messages"] == []


def test_default_agent_executor_resume_rejects_handle_without_checkpoint() -> None:
    with pytest.raises(ValueError, match="checkpoint"):
        DefaultAgentExecutor().resume(
            handle={
                "status": "interrupted",
                "messages": [],
            },
            input={"answer": "continue"},
        )


def test_default_agent_executor_stop_returns_no_status_event() -> None:
    started = DefaultAgentExecutor().start(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        agent="codex",
        input={"prompt": "implement task"},
    )

    assert DefaultAgentExecutor().stop(handle=started) is None


def test_agent_executor_protocol_exposes_only_provider_lifecycle() -> None:
    exposed_methods = {
        name
        for name, value in AgentExecutor.__dict__.items()
        if callable(value) and not name.startswith("_")
    }

    assert exposed_methods == {"start", "resume", "stop"}
    assert "transition" not in exposed_methods
    assert "approve" not in exposed_methods
    assert "gate" not in exposed_methods


def test_agent_results_do_not_emit_kernel_or_governance_events() -> None:
    executor = DefaultAgentExecutor()
    started = executor.start(
        project_id="project-1",
        run_id="run-1",
        node_id="node-1",
        agent="codex",
        input={"prompt": "implement task"},
    )
    resumed = executor.resume(handle=started, input={"answer": "continue"})

    forbidden_events = {"HUMAN_APPROVED", "GATE_PASSED", "NODE_COMPLETED"}
    assert forbidden_events.isdisjoint(set(started))
    assert forbidden_events.isdisjoint(set(resumed))
    assert "event" not in started
    assert "event" not in resumed
