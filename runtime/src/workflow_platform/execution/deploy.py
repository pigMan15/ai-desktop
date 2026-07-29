from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import subprocess
from threading import RLock, Thread
from typing import Callable

from workflow_platform.execution.cli import ALLOWED_ENVIRONMENT_KEYS, decode_cli_output


@dataclass(frozen=True)
class DeployExecutionResult:
    status: str
    summary: str | None
    error: str | None
    output: str


class DeployExecutor:
    def __init__(
        self,
        *,
        on_output: Callable[[str], None] | None = None,
        on_started: Callable[[int], None] | None = None,
    ) -> None:
        self._on_output = on_output
        self._on_started = on_started
        self._processes: dict[str, subprocess.Popen[bytes]] = {}
        self._cancelled: set[str] = set()
        self._lock = RLock()

    def run(
        self,
        *,
        deployment_id: str,
        command: list[str],
        cwd: Path,
        timeout_seconds: float,
        max_output_bytes: int,
    ) -> DeployExecutionResult:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            shell=False,
            env={
                key: value
                for key, value in os.environ.items()
                if key.upper() in ALLOWED_ENVIRONMENT_KEYS
            },
            startupinfo=_hidden_startupinfo(),
        )
        with self._lock:
            self._processes[deployment_id] = process
            cancelled_before_start = deployment_id in self._cancelled
        if self._on_started is not None:
            self._on_started(process.pid)
        if cancelled_before_start:
            _terminate_process(process)

        output: list[str] = []
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
                if self._on_output is not None:
                    self._on_output(line)

        reader = Thread(target=read_output, daemon=True)
        reader.start()
        try:
            try:
                process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                _terminate_process(process)
                reader.join(timeout=2)
                return DeployExecutionResult(
                    status="FAILED",
                    summary=None,
                    error=f"DEPLOY_TIMEOUT: 部署命令超过 {timeout_seconds} 秒仍未结束。",
                    output="".join(output),
                )

            reader.join(timeout=2)
            captured_output = "".join(output)
            if output_limit_reached:
                return DeployExecutionResult(
                    status="FAILED",
                    summary=None,
                    error=f"DEPLOY_OUTPUT_LIMIT: 部署输出超过 {max_output_bytes} 字节。",
                    output=captured_output,
                )
            if self._is_cancelled(deployment_id):
                return DeployExecutionResult(
                    status="CANCELLED",
                    summary=None,
                    error="DEPLOY_CANCELLED: 部署已被用户取消。",
                    output=captured_output,
                )
            if process.returncode == 0:
                return DeployExecutionResult(
                    status="COMPLETED",
                    summary=_summarize_output(captured_output),
                    error=None,
                    output=captured_output,
                )
            return DeployExecutionResult(
                status="FAILED",
                summary=None,
                error=f"DEPLOY_FAILED: 部署命令以退出码 {process.returncode} 结束。",
                output=captured_output,
            )
        finally:
            with self._lock:
                self._processes.pop(deployment_id, None)
                self._cancelled.discard(deployment_id)

    def cancel(self, deployment_id: str) -> bool:
        with self._lock:
            process = self._processes.get(deployment_id)
            self._cancelled.add(deployment_id)
            if process is None:
                return True
        _terminate_process(process)
        return True

    def _is_cancelled(self, deployment_id: str) -> bool:
        with self._lock:
            return deployment_id in self._cancelled


def _summarize_output(output: str) -> str:
    for line in reversed(output.splitlines()):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        text = payload.get("text") if isinstance(payload, dict) else None
        if isinstance(text, str) and text.strip():
            return text.strip()
    return next((line.strip() for line in reversed(output.splitlines()) if line.strip()), "部署命令已完成。")


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
