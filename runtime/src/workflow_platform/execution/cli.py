from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import subprocess
from threading import RLock, Thread
from typing import Any, Callable

from workflow_platform.execution.acp import AcpSession, acp_event_to_agent_output
from workflow_platform.execution.providers import AcpProvider, CliProvider


ALLOWED_ENVIRONMENT_KEYS = {
    "PATH",
    "SYSTEMROOT",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "CODEX_HOME",
    "ANTHROPIC_API_KEY",
    "PYTHONPATH",
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
        conversational: bool = False,
    ) -> CliExecutionResult:
        del conversational
        resolved_cwd = _resolve_safe_cwd(cwd, project_root)
        command = self._provider.build_command(
            cwd=resolved_cwd,
            prompt=prompt,
            allowed_tools=allowed_tools or [],
        )
        process = subprocess.Popen(
            [command.executable, *command.args],
            cwd=command.cwd,
            stdin=subprocess.PIPE if command.stdin is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            shell=False,
            env=self._allowed_environment(),
            startupinfo=_hidden_startupinfo(),
        )
        if command.stdin is not None and process.stdin is not None:
            process.stdin.write(command.stdin.encode("utf-8"))
            process.stdin.close()
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
            last_message_event = next(
                (event for event in reversed(events) if event["kind"] == "message"),
                None,
            )
            error_event = next((event for event in reversed(events) if event["kind"] == "error"), None)
            if process.returncode == 0:
                return CliExecutionResult(
                    status="COMPLETED",
                    summary=_event_text(final_event) or _event_text(last_message_event),
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


class AcpAgentExecutor:
    """ACP 执行器：与 CliAgentExecutor 同形状（构造注入 + run 返回结果）。

    conversational=True 时 run() 在首轮 turn 完成后保持 ACP 会话存活并返回
    AWAITING_INPUT，后续通过 continue_conversation() 续话；cancel() 结束会话。
    """

    def __init__(
        self,
        *,
        provider: AcpProvider,
        on_output: Callable[[dict[str, Any]], None] | None = None,
        on_started: Callable[[int], None] | None = None,
        extra_environment: dict[str, str] | None = None,
        on_permission: Callable[[str, dict], None] | None = None,
    ) -> None:
        self._provider = provider
        self._on_output = on_output
        self._on_started = on_started
        self._on_permission = on_permission
        self._extra_environment = extra_environment or {}
        self._sessions: dict[str, AcpSession] = {}
        self._conversations: dict[str, dict[str, Any]] = {}
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
        conversational: bool = False,
    ) -> CliExecutionResult:
        del max_output_bytes, allowed_tools
        resolved_cwd = _resolve_safe_cwd(cwd, project_root)
        command = self._provider.build_acp_command(cwd=resolved_cwd)
        session = AcpSession(
            command.executable,
            command.args,
            cwd=command.cwd,
            env=self._allowed_environment(),
        )
        import threading

        state: dict[str, Any] = {
            "session": session,
            "session_id": None,
            "turn_id": None,
            "events": [],
            "completed": threading.Event(),
        }
        conversation = bool(conversational)

        def handle_event(event: dict[str, Any]) -> None:
            state["events"].append(event)
            if event.get("method") in {"turn/completed", "session/finished", "error"}:
                state["completed"].set()
            if event.get("method") == "permission/request" and self._on_permission is not None:
                request_id = (event.get("params") or {}).get("requestId")
                if isinstance(request_id, str) and request_id:
                    state.setdefault("request_ids", set()).add(request_id)
                    self._on_permission(request_id, self._provider.map_permission(event))
            if self._on_output is not None:
                self._on_output(acp_event_to_agent_output(event))

        session.set_event_callback(handle_event)
        with self._lock:
            self._sessions[job_id] = session
            cancelled_before_start = job_id in self._cancelled
        session.start()
        if self._on_started is not None and session.pid() is not None:
            self._on_started(session.pid() or 0)
        if cancelled_before_start:
            session.close()
            with self._lock:
                self._sessions.pop(job_id, None)
            return CliExecutionResult(
                status="CANCELLED",
                summary=None,
                error="AGENT_CANCELLED: ACP session was cancelled before start",
                exit_code=None,
            )
        try:
            session_id = session.new_session({"mode": "auto" if not conversation else "chat"})
            state["session_id"] = session_id
            turn_id = session.send_turn(prompt, session_id=session_id)
            state["turn_id"] = turn_id
            if not state["completed"].wait(timeout=timeout_seconds):
                return CliExecutionResult(
                    status="FAILED",
                    summary=None,
                    error=f"AGENT_TIMEOUT: ACP turn exceeded {timeout_seconds} seconds",
                    exit_code=None,
                )
            if self._is_cancelled(job_id):
                return CliExecutionResult(
                    status="CANCELLED",
                    summary=None,
                    error="AGENT_CANCELLED: ACP session was cancelled",
                    exit_code=None,
                )
            error_events = [event for event in state["events"] if event.get("method") == "error"]
            if error_events:
                params = error_events[-1].get("params") or {}
                return CliExecutionResult(
                    status="FAILED",
                    summary=None,
                    error=str(params.get("text") or params.get("message") or "ACP error"),
                    exit_code=None,
                )
            last_text = _last_acp_message(state["events"])
            if conversation:
                # 首轮完成：保持会话存活，进入 AWAITING_INPUT
                with self._lock:
                    self._conversations[job_id] = state
                    self._sessions.pop(job_id, None)
                return CliExecutionResult(
                    status="AWAITING_INPUT",
                    summary=last_text,
                    error=None,
                    exit_code=None,
                )
            return CliExecutionResult(
                status="COMPLETED",
                summary=last_text,
                error=None,
                exit_code=0,
            )
        finally:
            if not conversation:
                session.close()
                with self._lock:
                    self._sessions.pop(job_id, None)
                    self._cancelled.discard(job_id)

    def continue_conversation(self, job_id: str, message: str) -> str:
        with self._lock:
            state = self._conversations.get(job_id)
        if state is None:
            raise ValueError("AGENT_CONVERSATION_LOST: ACP conversation is not active")
        session: AcpSession = state["session"]
        if not session.is_alive():
            raise ValueError("AGENT_CONVERSATION_LOST: ACP session is not alive")
        state["events"] = []
        state["completed"].clear()
        if self._on_output is not None:
            self._on_output({"kind": "chat.user", "payload": {"text": message}})
        turn_id = session.continue_turn(str(state["turn_id"]), message)
        state["turn_id"] = turn_id
        return turn_id

    def wait_turn_completed(self, job_id: str, timeout: float) -> bool:
        with self._lock:
            state = self._conversations.get(job_id)
        if state is None:
            return False
        return bool(state["completed"].wait(timeout=timeout))

    def is_conversation_alive(self, job_id: str) -> bool:
        with self._lock:
            state = self._conversations.get(job_id)
        if state is None:
            return False
        return bool(state["session"].is_alive())

    def end_conversation(self, job_id: str) -> None:
        with self._lock:
            state = self._conversations.pop(job_id, None)
            self._cancelled.discard(job_id)
        if state is not None:
            state["session"].close()

    def respond_permission(self, request_id: str, *, allow: bool, reason: str | None = None) -> None:
        with self._lock:
            state = next(
                (
                    candidate
                    for candidate in self._conversations.values()
                    if request_id in (candidate.get("request_ids") or set())
                ),
                None,
            )
        if state is None:
            return
        try:
            state["session"].request_permission_response(request_id, allow=allow, reason=reason)
        except Exception:
            pass

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            session = self._sessions.get(job_id)
            conversation = self._conversations.get(job_id)
            self._cancelled.add(job_id)
            if session is None and conversation is None:
                return True
        if session is not None:
            session.close()
        if conversation is not None:
            conversation["session"].close()
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


def _last_acp_message(events: list[dict[str, Any]]) -> str | None:
    for event in reversed(events):
        if event.get("method") == "message":
            text = (event.get("params") or {}).get("text")
            if isinstance(text, str) and text:
                return text
    return None

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
