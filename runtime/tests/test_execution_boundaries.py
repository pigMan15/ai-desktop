from pathlib import Path

import pytest

from workflow_platform.execution.agent import AgentExecutor, DefaultAgentExecutor
from workflow_platform.terminals.service import create_terminal_session


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
    )

    assert session["id"]
    assert isinstance(session["id"], str)
    assert session["project_id"] == "project-1"
    assert session["run_id"] == "run-1"
    assert session["node_id"] == "node-1"
    assert session["kind"] == "shell"
    assert session["cwd"] == str(workspace_path.resolve())
    assert session["status"] == "created"


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
    assert result["checkpoint"]
    assert isinstance(result["checkpoint"], str)


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
