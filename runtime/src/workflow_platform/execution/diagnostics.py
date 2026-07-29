from __future__ import annotations

import shutil
import subprocess
import sys
from typing import Callable

from workflow_platform.execution.cli import decode_cli_output


FindExecutable = Callable[[str], str | None]
RunCommand = Callable[[list[str]], tuple[int, str, str]]


def diagnose_cli_provider(
    provider: str,
    *,
    platform: str | None = None,
    find_executable: FindExecutable = shutil.which,
    run_command: RunCommand | None = None,
) -> dict[str, str | bool | None]:
    executable, display_name = _provider_command(provider, platform or sys.platform)
    executable_path = find_executable(executable)
    if executable_path is None:
        return {
            "id": provider,
            "executable": executable,
            "available": False,
            "path": None,
            "version": None,
            "message": f"未找到 {executable}，请安装 {display_name} 并确保其位于 PATH 中。",
        }

    exit_code, stdout, _stderr = (run_command or _run_version)([executable_path, "--version"])
    if exit_code != 0:
        return {
            "id": provider,
            "executable": executable,
            "available": False,
            "path": executable_path,
            "version": None,
            "message": f"{display_name} 无法执行版本检测，请检查安装与登录状态。",
        }

    version = stdout.strip().splitlines()[0] if stdout.strip() else None
    return {
        "id": provider,
        "executable": executable,
        "available": True,
        "path": executable_path,
        "version": version,
        "message": f"已检测到 {display_name}。",
    }


def _provider_command(provider: str, platform: str) -> tuple[str, str]:
    is_windows = platform == "win32"
    if provider == "codex":
        return ("codex.cmd" if is_windows else "codex", "Codex CLI")
    if provider == "claude":
        return ("claude.cmd" if is_windows else "claude", "Claude Code CLI")
    raise ValueError(f"Unsupported CLI provider: {provider}")


def _run_version(command: list[str]) -> tuple[int, str, str]:
    completed = subprocess.run(
        command,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=5,
        shell=False,
        startupinfo=_hidden_startupinfo(),
    )
    return (
        completed.returncode,
        decode_cli_output(completed.stdout),
        decode_cli_output(completed.stderr),
    )


def _hidden_startupinfo() -> subprocess.STARTUPINFO | None:
    if sys.platform != "win32":
        return None
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return startupinfo
