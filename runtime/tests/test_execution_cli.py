from pathlib import Path
import sys
from threading import Event, Thread
import time

import pytest

from workflow_platform.execution.cli import CliAgentExecutor, _to_chat_event, decode_cli_output
from workflow_platform.execution.providers import (
    CliCommand,
    ClaudeCliProvider,
    CodexCliProvider,
)


FAKE_CLI = Path(__file__).parent / "fixtures" / "fake_cli.py"


class FakeProvider:
    id = "fake"

    def __init__(self, mode: str) -> None:
        self._mode = mode

    def build_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        allowed_tools: list[str],
    ) -> CliCommand:
        return CliCommand(
            executable=sys.executable,
            args=[str(FAKE_CLI), self._mode],
            cwd=cwd,
        )

    def parse_line(self, line: str) -> dict:
        return CodexCliProvider(platform="linux").parse_line(line)


def test_codex_provider_uses_windows_cmd_json_output_and_workspace_sandbox() -> None:
    cwd = Path("C:/project")
    command = CodexCliProvider(platform="win32").build_command(
        cwd=cwd,
        prompt="实现节点",
        allowed_tools=["Read", "Edit"],
    )

    assert command.executable == "codex.cmd"
    assert command.args == [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--cd",
        str(cwd),
        "-",
    ]
    assert command.stdin == "实现节点"
    assert command.cwd == cwd
    assert "--dangerously-bypass-approvals-and-sandbox" not in command.args


def test_codex_provider_streams_multiline_prompt_over_stdin() -> None:
    prompt = "整理知识候选\n\n- 保留验证结论\n- 不执行命令"

    command = CodexCliProvider(platform="win32").build_command(
        cwd=Path("C:/project"),
        prompt=prompt,
        allowed_tools=[],
    )

    assert command.args[-1] == "-"
    assert command.stdin == prompt


def test_codex_provider_uses_posix_binary_name() -> None:
    command = CodexCliProvider(platform="linux").build_command(
        cwd=Path("/project"),
        prompt="implement",
        allowed_tools=[],
    )

    assert command.executable == "codex"


def test_claude_provider_uses_windows_cmd_print_mode_and_allowed_tools() -> None:
    command = ClaudeCliProvider(platform="win32").build_command(
        cwd=Path("C:/project"),
        prompt="实现节点",
        allowed_tools=["Read", "Edit", "Bash(git *)"],
    )

    assert command.executable == "claude.cmd"
    assert command.args == [
        "-p",
        "实现节点",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
        "--allowedTools",
        "Read,Edit,Bash(git *)",
    ]
    assert command.cwd == Path("C:/project")
    assert "--dangerously-skip-permissions" not in command.args


def test_claude_provider_omits_allowed_tools_when_empty() -> None:
    command = ClaudeCliProvider(platform="linux").build_command(
        cwd=Path("/project"),
        prompt="implement",
        allowed_tools=[],
    )

    assert command.executable == "claude"
    assert "--allowedTools" not in command.args


def test_executor_preserves_windows_system_root_for_cli_processes(monkeypatch) -> None:
    monkeypatch.setenv("SYSTEMROOT", r"C:\Windows")

    environment = CliAgentExecutor(provider=FakeProvider("complete"))._allowed_environment()

    assert next(
        (value for key, value in environment.items() if key.upper() == "SYSTEMROOT"),
        None,
    ) == r"C:\Windows"


def test_executor_preserves_windows_temp_directories_for_cli_processes(monkeypatch) -> None:
    monkeypatch.setenv("TEMP", r"C:\Users\tester\AppData\Local\Temp")
    monkeypatch.setenv("TMP", r"C:\Users\tester\AppData\Local\Temp")

    environment = CliAgentExecutor(provider=FakeProvider("complete"))._allowed_environment()

    assert environment["TEMP"] == r"C:\Users\tester\AppData\Local\Temp"
    assert environment["TMP"] == r"C:\Users\tester\AppData\Local\Temp"


def test_decode_cli_output_accepts_utf8_and_gb18030_bytes() -> None:
    assert decode_cli_output("部署完成".encode("utf-8")) == "部署完成"
    assert decode_cli_output("部署完成".encode("gb18030")) == "部署完成"


def test_claude_provider_normalizes_stream_json_text_message() -> None:
    event = ClaudeCliProvider(platform="win32").parse_line(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"完成"}]}}'
    )

    assert event == {"kind": "message", "payload": {"text": "完成"}}


def test_codex_provider_normalizes_common_json_message_shapes() -> None:
    provider = CodexCliProvider(platform="win32")

    assert provider.parse_line('{"type":"message","message":"完成"}') == {
        "kind": "message",
        "payload": {"text": "完成"},
    }
    assert provider.parse_line('{"type":"final","text":"已完成"}') == {
        "kind": "final",
        "payload": {"text": "已完成"},
    }
    assert provider.parse_line(
        '{"type":"item.completed","item":{"type":"agent_message","text":"合成后的知识正文"}}'
    ) == {
        "kind": "message",
        "payload": {"text": "合成后的知识正文"},
    }


def test_codex_provider_normalizes_execution_progress_events() -> None:
    provider = CodexCliProvider(platform="win32")

    assert provider.parse_line('{"type":"thread.started","thread_id":"thread-1"}') == {
        "kind": "progress",
        "payload": {"text": "Codex 会话已创建（thread-1）。", "threadId": "thread-1"},
    }
    assert provider.parse_line('{"type":"turn.started"}') == {
        "kind": "progress",
        "payload": {"text": "Codex 正在分析并生成结果。"},
    }
    assert provider.parse_line(
        '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"rg --files"}}'
    ) == {
        "kind": "tool",
        "payload": {
            "text": "Codex 正在执行命令：rg --files",
            "title": "rg --files",
            "status": "running",
            "itemId": "item_0",
        },
    }
    assert provider.parse_line('{"type":"turn.completed"}') == {
        "kind": "progress",
        "payload": {"text": "Codex 已完成本轮处理。"},
    }


def test_providers_preserve_unrecognized_or_invalid_lines_as_raw_output() -> None:
    assert CodexCliProvider(platform="win32").parse_line("not json") == {
        "kind": "raw",
        "payload": {"text": "not json"},
    }
    assert ClaudeCliProvider(platform="win32").parse_line('{"type":"unknown","value":1}') == {
        "kind": "raw",
        "payload": {"text": '{"type":"unknown","value":1}'},
    }


def test_executor_runs_provider_and_parses_output(tmp_path: Path) -> None:
    events: list[dict] = []
    executor = CliAgentExecutor(provider=FakeProvider("complete"), on_output=events.append)

    result = executor.run(
        job_id="agent-job-1",
        prompt="实现节点",
        cwd=tmp_path,
        project_root=tmp_path,
        timeout_seconds=5,
        max_output_bytes=4096,
    )

    assert result.status == "COMPLETED"
    assert result.summary == "fake-cli: completed"
    assert result.error is None
    assert [event["kind"] for event in events] == ["message", "final"]


def test_executor_uses_last_agent_message_when_cli_omits_a_final_event(tmp_path: Path) -> None:
    result = CliAgentExecutor(provider=FakeProvider("message-only")).run(
        job_id="agent-job-message-only",
        prompt="整理知识",
        cwd=tmp_path,
        project_root=tmp_path,
        timeout_seconds=5,
        max_output_bytes=4096,
    )

    assert result.status == "COMPLETED"
    assert result.summary == "fake-cli: message only"


def test_executor_emits_output_before_streaming_process_exits(tmp_path: Path) -> None:
    first_output = Event()
    events: list[dict] = []

    def on_output(event: dict) -> None:
        events.append(event)
        first_output.set()

    executor = CliAgentExecutor(provider=FakeProvider("stream"), on_output=on_output)
    result_holder = {}
    thread = Thread(
        target=lambda: result_holder.update(
            result=executor.run(
                job_id="agent-job-stream",
                prompt="x",
                cwd=tmp_path,
                project_root=tmp_path,
                timeout_seconds=5,
                max_output_bytes=4096,
            )
        )
    )

    thread.start()

    assert first_output.wait(timeout=0.3)
    assert thread.is_alive()
    thread.join(timeout=5)
    assert result_holder["result"].status == "COMPLETED"
    assert [event["kind"] for event in events] == ["message", "final"]


def test_executor_rejects_cwd_outside_project_root(tmp_path: Path) -> None:
    executor = CliAgentExecutor(provider=FakeProvider("complete"))

    with pytest.raises(ValueError, match="AGENT_UNSAFE_CWD"):
        executor.run(
            job_id="agent-job-1",
            prompt="x",
            cwd=tmp_path.parent,
            project_root=tmp_path,
            timeout_seconds=5,
            max_output_bytes=4096,
        )


def test_executor_fails_when_output_exceeds_limit(tmp_path: Path) -> None:
    executor = CliAgentExecutor(provider=FakeProvider("large"))

    result = executor.run(
        job_id="agent-job-1",
        prompt="x",
        cwd=tmp_path,
        project_root=tmp_path,
        timeout_seconds=5,
        max_output_bytes=64,
    )

    assert result.status == "FAILED"
    assert result.error == "AGENT_OUTPUT_LIMIT: CLI output exceeded 64 bytes"


def test_executor_timeout_terminates_process(tmp_path: Path) -> None:
    executor = CliAgentExecutor(provider=FakeProvider("sleep"))

    result = executor.run(
        job_id="agent-job-1",
        prompt="x",
        cwd=tmp_path,
        project_root=tmp_path,
        timeout_seconds=0.1,
        max_output_bytes=4096,
    )

    assert result.status == "FAILED"
    assert result.error == "AGENT_TIMEOUT: CLI process exceeded 0.1 seconds"


def test_executor_cancel_terminates_running_process(tmp_path: Path) -> None:
    executor = CliAgentExecutor(provider=FakeProvider("sleep"))
    result_holder = {}

    thread = Thread(
        target=lambda: result_holder.update(
            result=executor.run(
                job_id="agent-job-1",
                prompt="x",
                cwd=tmp_path,
                project_root=tmp_path,
                timeout_seconds=10,
                max_output_bytes=4096,
            )
        )
    )
    thread.start()
    for _ in range(50):
        if executor.cancel("agent-job-1"):
            break
        time.sleep(0.02)
    thread.join(timeout=5)

    assert result_holder["result"].status == "CANCELLED"

class ChatFakeProvider:
    id = "fake"

    def build_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        allowed_tools: list[str],
    ) -> CliCommand:
        return CliCommand(executable=sys.executable, args=[str(FAKE_CLI), "complete"], cwd=cwd)

    def build_conversation_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        thread_id: str | None = None,
        allowed_tools: list[str] | None = None,
    ) -> CliCommand:
        if thread_id:
            args = [str(FAKE_CLI), "chat-resume", thread_id, prompt]
        else:
            args = [str(FAKE_CLI), "chat-start"]
        return CliCommand(executable=sys.executable, args=args, cwd=cwd)

    def parse_line(self, line: str) -> dict:
        return CodexCliProvider(platform="linux").parse_line(line)


def test_codex_provider_builds_conversation_commands() -> None:
    provider = CodexCliProvider(platform="win32")
    cwd = Path("C:/project")

    first = provider.build_conversation_command(cwd=cwd, prompt="第一轮")
    assert first.executable == "codex.cmd"
    assert first.args == [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--cd",
        str(cwd),
        "-",
    ]
    assert first.stdin == "第一轮"

    resumed = provider.build_conversation_command(
        cwd=cwd, prompt="继续", thread_id="thread-1"
    )
    assert resumed.args == [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        "--cd",
        str(cwd),
        "resume",
        "thread-1",
        "-",
    ]
    assert resumed.stdin == "继续"


def test_codex_provider_emits_tool_blocks_for_command_execution() -> None:
    provider = CodexCliProvider(platform="win32")

    completed = provider.parse_line(
        '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"rg --files","status":"completed","exit_code":0,"aggregated_output":"src/a.ts"}}'
    )
    assert completed == {
        "kind": "tool",
        "payload": {
            "text": "src/a.ts",
            "title": "rg --files",
            "status": "completed",
            "itemId": "item_0",
            "exitCode": 0,
        },
    }

    failed = provider.parse_line(
        '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bad","status":"failed","exit_code":1,"aggregated_output":"boom"}}'
    )
    assert failed["kind"] == "tool"
    assert failed["payload"]["status"] == "failed"
    assert failed["payload"]["text"] == "boom"

    mcp = provider.parse_line(
        '{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","tool":"list_mcp_resources","result":{"content":[{"type":"text","text":"ok"}]}}}'
    )
    assert mcp["kind"] == "tool"
    assert mcp["payload"]["title"] == "MCP 工具 list_mcp_resources"
    assert mcp["payload"]["text"] == "ok"


def test_to_chat_event_maps_cli_events_to_chat_shape() -> None:
    mapped = _to_chat_event({"kind": "message", "payload": {"text": "hi"}})
    assert mapped is not None
    assert mapped["kind"] == "acp.message"
    assert mapped["payload"]["text"] == "hi"
    assert isinstance(mapped["payload"]["messageId"], str)
    assert _to_chat_event({"kind": "final", "payload": {"text": "done"}})["kind"] == "acp.message"
    assert _to_chat_event({"kind": "progress", "payload": {"text": "working"}}) == {
        "kind": "acp.turn",
        "payload": {"text": "working"},
    }
    assert _to_chat_event({"kind": "error", "payload": {"text": "boom"}}) == {
        "kind": "acp.error",
        "payload": {"text": "boom"},
    }
    tool = _to_chat_event({"kind": "tool", "payload": {"title": "cmd", "status": "running"}})
    assert tool == {"kind": "tool", "payload": {"title": "cmd", "status": "running"}}
    assert _to_chat_event({"kind": "raw", "payload": {"text": "noise"}}) is None


def test_executor_runs_conversational_cli_chat(tmp_path: Path) -> None:
    events: list[dict] = []
    executor = CliAgentExecutor(provider=ChatFakeProvider(), on_output=events.append)

    result = executor.run(
        job_id="agent-job-chat",
        prompt="第一轮",
        cwd=tmp_path,
        project_root=tmp_path,
        timeout_seconds=5,
        max_output_bytes=4096,
        conversational=True,
    )
    assert result.status == "AWAITING_INPUT"
    assert executor.thread_id_for("agent-job-chat") == "thread-123"
    assert executor.is_conversation_alive("agent-job-chat") is True
    assert any(
        event["kind"] == "acp.message" and "fake chat first" in event["payload"]["text"]
        for event in events
    )

    turn_id = executor.continue_conversation("agent-job-chat", "继续，执行命令")
    assert turn_id.startswith("codex-turn-")
    assert executor.wait_turn_completed("agent-job-chat", timeout=5) is True
    assert executor.is_conversation_alive("agent-job-chat") is True
    user_events = [event for event in events if event["kind"] == "chat.user"]
    assert any(event["payload"]["text"] == "继续，执行命令" for event in user_events)
    resumed = [
        event
        for event in events
        if event["kind"] == "acp.message" and "fake chat resume" in event["payload"]["text"]
    ]
    assert resumed, events

    executor.end_conversation("agent-job-chat")
    assert executor.is_conversation_alive("agent-job-chat") is False


def test_executor_conversational_run_streams_tool_blocks(tmp_path: Path) -> None:
    events: list[dict] = []
    provider = ChatFakeProvider()
    provider.build_conversation_command = lambda *, cwd, prompt, thread_id=None, allowed_tools=None: CliCommand(
        executable=sys.executable, args=[str(FAKE_CLI), "chat-tools"], cwd=cwd
    )
    executor = CliAgentExecutor(provider=provider, on_output=events.append)
    result = executor.run(
        job_id="agent-job-tools",
        prompt="扫描",
        cwd=tmp_path,
        project_root=tmp_path,
        timeout_seconds=5,
        max_output_bytes=4096,
        conversational=True,
    )
    assert result.status == "AWAITING_INPUT"
    tool_events = [event for event in events if event["kind"] == "tool"]
    assert len(tool_events) == 2, events
    assert tool_events[0]["payload"]["status"] == "running"
    assert tool_events[1]["payload"]["status"] == "completed"
    assert tool_events[0]["payload"]["itemId"] == tool_events[1]["payload"]["itemId"]
    assert tool_events[1]["payload"]["text"] == "src/a.ts\nsrc/b.ts"
    executor.end_conversation("agent-job-tools")
