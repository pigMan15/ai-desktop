from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import subprocess
from threading import RLock, Thread
from typing import Any, Callable

from workflow_platform.execution.providers import CliProvider


ALLOWED_ENVIRONMENT_KEYS = {
    "PATH",
    "SYSTEMROOT",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "CODEX_HOME",
    "ANTHROPIC_API_KEY",
}


@dataclass(frozen=True)
class CliExecutionResult:
    status: str
    summary: str | None
    error: str | None
    exit_code: int | None


class CliAgentExecutor:
    def __init__(
        self,
        *,
        provider: CliProvider,
        on_output: Callable[[dict[str, Any]], None] | None = None,
        on_started: Callable[[int], None] | None = None,
        extra_environment: dict[str, str] | None = None,
    ) -> None:
        self._provider = provider
        self._on_output = on_output
        self._on_started = on_started
        self._extra_environment = extra_environment or {}
        self._processes: dict[str, subprocess.Popen[bytes]] = {}
        self._cancelled: set[str] = set()
        self._lock = RLock()

    def run(
        self,
        *,
        job_id: str,
        prompt: str,
        cwd: Path,
        project_root: Path,
        timeout_seconds: float,
        max_output_bytes: int,
        allowed_tools: list[str] | None = None,
    ) -> CliExecutionResult:
        resolved_cwd = _resolve_safe_cwd(cwd, project_root)
        command = self._provider.build_command(
            cwd=resolved_cwd,
            prompt=prompt,
            allowed_tools=allowed_tools or [],
        )
        process = subprocess.Popen(
            [command.executable, *command.args],
            cwd=command.cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            shell=False,
            env=self._allowed_environment(),
            startupinfo=_hidden_startupinfo(),
        )
        with self._lock:
            self._processes[job_id] = process
            cancelled_before_start = job_id in self._cancelled
        if self._on_started is not None:
            self._on_started(process.pid)
        if cancelled_before_start:
            _terminate_process(process)

        try:
            output: list[str] = []
            events: list[dict[str, Any]] = []
            output_bytes = 0
            output_limit_reached = False
            output_lock = RLock()

            def read_output() -> None:
                nonlocal output_bytes, output_limit_reached
                if process.stdout is None:
                    return
                for raw_line in process.stdout:
                    line = decode_cli_output(raw_line)
                    if not line:
                        continue
                    with output_lock:
                        output.append(line)
                        output_bytes += len(raw_line)
                        if output_bytes > max_output_bytes:
                            output_limit_reached = True
                            _terminate_process(process)
                            return
                    event = self._provider.parse_line(line.strip())
                    events.append(event)
                    if self._on_output is not None:
                        self._on_output(event)

            reader = Thread(target=read_output, daemon=True)
            reader.start()
            try:
                process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                _terminate_process(process)
                reader.join(timeout=2)
                return CliExecutionResult(
                    status="FAILED",
                    summary=None,
                    error=f"AGENT_TIMEOUT: CLI process exceeded {timeout_seconds} seconds",
                    exit_code=process.returncode,
                )

            reader.join(timeout=2)
            if output_limit_reached:
                return CliExecutionResult(
                    status="FAILED",
                    summary=None,
                    error=f"AGENT_OUTPUT_LIMIT: CLI output exceeded {max_output_bytes} bytes",
                    exit_code=process.returncode,
                )

            if self._is_cancelled(job_id):
                return CliExecutionResult(
                    status="CANCELLED",
                    summary=None,
                    error="AGENT_CANCELLED: CLI process was cancelled",
                    exit_code=process.returncode,
                )

            final_event = next((event for event in reversed(events) if event["kind"] == "final"), None)
            error_event = next((event for event in reversed(events) if event["kind"] == "error"), None)
            if process.returncode == 0:
                return CliExecutionResult(
                    status="COMPLETED",
                    summary=_event_text(final_event),
                    error=None,
                    exit_code=process.returncode,
                )
            return CliExecutionResult(
                status="FAILED",
                summary=None,
                error=_event_text(error_event) or f"AGENT_FAILED: CLI exited with {process.returncode}",
                exit_code=process.returncode,
            )
        finally:
            with self._lock:
                self._processes.pop(job_id, None)
                self._cancelled.discard(job_id)

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            process = self._processes.get(job_id)
            self._cancelled.add(job_id)
            if process is None:
                return True
        _terminate_process(process)
        return True

    def _allowed_environment(self) -> dict[str, str]:
        environment = {
            key: value
            for key, value in os.environ.items()
            if key.upper() in ALLOWED_ENVIRONMENT_KEYS
        }
        environment.update(self._extra_environment)
        return environment

    def _is_cancelled(self, job_id: str) -> bool:
        with self._lock:
            return job_id in self._cancelled


def _resolve_safe_cwd(cwd: Path, project_root: Path) -> Path:
    resolved_cwd = cwd.resolve()
    resolved_project_root = project_root.resolve()
    if resolved_cwd != resolved_project_root and resolved_project_root not in resolved_cwd.parents:
        raise ValueError("AGENT_UNSAFE_CWD: CLI cwd must stay within project root")
    return resolved_cwd


def decode_cli_output(data: bytes) -> str:
    for encoding in ("utf-8", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _terminate_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        process.kill()


def _hidden_startupinfo() -> subprocess.STARTUPINFO | None:
    if os.name != "nt":
        return None
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    return startupinfo


def _event_text(event: dict[str, Any] | None) -> str | None:
    if event is None:
        return None
    payload = event.get("payload")
    if not isinstance(payload, dict):
        return None
    text = payload.get("text")
    return text if isinstance(text, str) and text else None
