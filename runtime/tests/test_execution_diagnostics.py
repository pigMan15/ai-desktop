from pathlib import Path

from workflow_platform.execution.diagnostics import diagnose_cli_provider


def test_diagnose_cli_provider_reports_missing_windows_command() -> None:
    diagnostic = diagnose_cli_provider(
        "codex",
        platform="win32",
        find_executable=lambda _name: None,
    )

    assert diagnostic == {
        "id": "codex",
        "executable": "codex.cmd",
        "available": False,
        "path": None,
        "version": None,
        "message": "未找到 codex.cmd，请安装 Codex CLI 并确保其位于 PATH 中。",
    }


def test_diagnose_cli_provider_reports_version_when_command_runs() -> None:
    calls: list[list[str]] = []

    diagnostic = diagnose_cli_provider(
        "claude",
        platform="win32",
        find_executable=lambda _name: "C:\\Users\\demo\\AppData\\Roaming\\npm\\claude.cmd",
        run_command=lambda command: calls.append(command) or (0, "2.1.0", ""),
    )

    assert calls == [["C:\\Users\\demo\\AppData\\Roaming\\npm\\claude.cmd", "--version"]]
    assert diagnostic == {
        "id": "claude",
        "executable": "claude.cmd",
        "available": True,
        "path": "C:\\Users\\demo\\AppData\\Roaming\\npm\\claude.cmd",
        "version": "2.1.0",
        "message": "已检测到 Claude Code CLI。",
    }


def test_diagnose_cli_provider_returns_command_failure_without_exposing_stderr() -> None:
    diagnostic = diagnose_cli_provider(
        "codex",
        platform="linux",
        find_executable=lambda _name: "/usr/local/bin/codex",
        run_command=lambda _command: (1, "", "token=secret"),
    )

    assert diagnostic == {
        "id": "codex",
        "executable": "codex",
        "available": False,
        "path": "/usr/local/bin/codex",
        "version": None,
        "message": "Codex CLI 无法执行版本检测，请检查安装与登录状态。",
    }
