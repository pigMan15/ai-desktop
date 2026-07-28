from pathlib import Path

from workflow_platform.execution.providers import (
    ClaudeCliProvider,
    CodexCliProvider,
)


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
        "--cd",
        str(cwd),
        "实现节点",
    ]
    assert command.cwd == cwd
    assert "--dangerously-bypass-approvals-and-sandbox" not in command.args


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


def test_providers_preserve_unrecognized_or_invalid_lines_as_raw_output() -> None:
    assert CodexCliProvider(platform="win32").parse_line("not json") == {
        "kind": "raw",
        "payload": {"text": "not json"},
    }
    assert ClaudeCliProvider(platform="win32").parse_line('{"type":"unknown","value":1}') == {
        "kind": "raw",
        "payload": {"text": '{"type":"unknown","value":1}'},
    }
