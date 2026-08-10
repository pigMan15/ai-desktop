import os
import sys
import threading
from pathlib import Path

import pytest

from workflow_platform.execution.acp import (
    AcpError,
    AcpSession,
    acp_event_to_agent_output,
    map_acp_permission,
)


def _make_session(tmp_path: Path, *, timeout_seconds: float = 5.0) -> AcpSession:
    session = AcpSession(
        sys.executable,
        ["-m", "workflow_platform.execution.fake_acp"],
        cwd=tmp_path,
        env=dict(os.environ),
        timeout_seconds=timeout_seconds,
    )
    return session


def test_acp_session_new_turn_messages_and_close(tmp_path: Path) -> None:
    session = _make_session(tmp_path)
    events: list[dict] = []
    lock = threading.Lock()

    def on_event(event: dict) -> None:
        with lock:
            events.append(event)

    session.set_event_callback(on_event)
    session.start()
    try:
        assert session.is_alive()
        session_id = session.new_session({"mode": "auto"})
        assert session_id
        turn_id = session.send_turn("实现登录接口", session_id=session_id)
        assert turn_id
        deadline = 0
        while deadline < 50:
            with lock:
                if any(e.get("method") == "turn/completed" for e in events):
                    break
            deadline += 1
            import time

            time.sleep(0.05)
        with lock:
            methods = [e.get("method") for e in events]
        assert "session/started" in methods
        assert "turn/started" in methods
        assert "message" in methods
        assert "turn/completed" in methods
        mapped = [acp_event_to_agent_output(e) for e in events]
        assert any(item["kind"] == "acp.message" for item in mapped)
    finally:
        session.close()
    assert not session.is_alive()


def test_acp_permission_request_mapping(tmp_path: Path) -> None:
    session = _make_session(tmp_path)
    events: list[dict] = []
    session.set_event_callback(events.append)
    session.start()
    try:
        session_id = session.new_session()
        session.send_turn("PERM: 写入结果", session_id=session_id)
        import time

        deadline = 0
        while deadline < 50:
            if any(e.get("method") == "permission/request" for e in events):
                break
            deadline += 1
            time.sleep(0.05)
        permission_events = [e for e in events if e.get("method") == "permission/request"]
        assert permission_events
        request = permission_events[0]
        mapped = map_acp_permission(request)
        assert mapped["permissionType"] == "write_file"
        assert mapped["target"] == "output/result.md"
        request_id = (request.get("params") or {}).get("requestId")
        assert request_id
        session.request_permission_response(request_id, allow=True, reason="测试")
        assert acp_event_to_agent_output(request)["kind"] == "acp.permission"
    finally:
        session.close()


def test_acp_continue_turn(tmp_path: Path) -> None:
    session = _make_session(tmp_path)
    events: list[dict] = []
    session.set_event_callback(events.append)
    session.start()
    try:
        session_id = session.new_session()
        turn_id = session.send_turn("第一轮", session_id=session_id)
        continued = session.continue_turn(turn_id, "继续")
        assert continued
        import time

        deadline = 0
        while deadline < 50:
            if sum(1 for e in events if e.get("method") == "message") >= 2:
                break
            deadline += 1
            time.sleep(0.05)
        assert sum(1 for e in events if e.get("method") == "message") >= 2
    finally:
        session.close()


def test_acp_error_response_raises(tmp_path: Path) -> None:
    session = _make_session(tmp_path)
    session.start()
    try:
        with pytest.raises(AcpError) as exc:
            session._request("error", {})
        assert exc.value.code == "AGENT_ACP_ERROR"
    finally:
        session.close()


def test_acp_timeout_raises(tmp_path: Path) -> None:
    session = _make_session(tmp_path, timeout_seconds=0.1)
    session.start()
    try:
        with pytest.raises(AcpError) as exc:
            session._request("slow", {})
        assert exc.value.code == "AGENT_ACP_TIMEOUT"
    finally:
        session.close()


def test_acp_disconnect_detected(tmp_path: Path) -> None:
    session = _make_session(tmp_path)
    session.start()
    assert session.is_alive()
    session.close()
    assert not session.is_alive()


def test_acp_agent_executor_auto_turn_completes(tmp_path: Path) -> None:
    from workflow_platform.execution.cli import AcpAgentExecutor
    from workflow_platform.execution.providers import FakeAcpProvider

    outputs: list[dict] = []
    pids: list[int] = []
    executor = AcpAgentExecutor(
        provider=FakeAcpProvider(),
        on_output=outputs.append,
        on_started=pids.append,
    )
    result = executor.run(
        job_id="job-1",
        prompt="hello acp",
        cwd=tmp_path,
        project_root=tmp_path,
        timeout_seconds=10,
        max_output_bytes=1_000_000,
    )
    assert result.status == "COMPLETED"
    assert result.summary == "fake ack: hello acp"
    assert pids
    assert any(item["kind"] == "acp.message" for item in outputs)
    assert any(item["kind"] == "acp.turn" for item in outputs)


def test_acp_agent_executor_cancel_before_start(tmp_path: Path) -> None:
    from workflow_platform.execution.cli import AcpAgentExecutor
    from workflow_platform.execution.providers import FakeAcpProvider

    executor = AcpAgentExecutor(provider=FakeAcpProvider())
    assert executor.cancel("job-2") is True
    result = executor.run(
        job_id="job-2",
        prompt="hello",
        cwd=tmp_path,
        project_root=tmp_path,
        timeout_seconds=10,
        max_output_bytes=1_000_000,
    )
    assert result.status == "CANCELLED"
