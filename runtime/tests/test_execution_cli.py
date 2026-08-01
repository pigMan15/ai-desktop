from pathlib import Path
import sys
from threading import Event, Thread
import time

import pytest

from workflow_platform.execution.cli import CliAgentExecutor, decode_cli_output
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
        "payload": {"text": "Codex 会话已创建（thread-1）。"},
    }
    assert provider.parse_line('{"type":"turn.started"}') == {
        "kind": "progress",
        "payload": {"text": "Codex 正在分析并生成结果。"},
    }
    assert provider.parse_line(
        '{"type":"item.started","item":{"type":"command_execution","command":"rg --files"}}'
    ) == {
        "kind": "progress",
        "payload": {"text": "Codex 正在执行命令：rg --files"},
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
