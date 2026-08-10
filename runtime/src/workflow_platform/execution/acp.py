"""ACP (Agent Client Protocol) client over JSON-RPC stdio (design doc section 6.1).

Real CLI flags (claude --acp / opencode --acp) are confirmed by Phase 0 spike;
the protocol client here follows the ACP event/method shape and tolerates drift by
falling back to acp.raw output events.
"""
from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

ACP_JSON_RPC_TIMEOUT_SECONDS = 30.0
ACP_EVENT_TIMEOUT_SECONDS = 1.0

ACP_PERMISSION_TYPES = {
    "write_file",
    "run_command",
    "network",
    "read_file",
    "env",
    "other",
}


class AcpError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def normalize_permission_type(value: str) -> str:
    text = (value or "other").strip().lower().replace("-", "_")
    if text in ACP_PERMISSION_TYPES:
        return text
    if text in {"write", "writefile", "edit", "write_file"}:
        return "write_file"
    if text in {"command", "execute", "run", "shell"}:
        return "run_command"
    if text in {"http", "https", "web", "fetch"}:
        return "network"
    if text in {"read", "readfile", "view"}:
        return "read_file"
    return "other"


def map_acp_permission(request: dict) -> dict:
    """ACP permission.request → AgentPermissionRequest fields."""
    params = request.get("params") or {}
    raw_type = params.get("permissionType") or params.get("type") or "other"
    target = (
        params.get("target")
        or params.get("path")
        or params.get("command")
        or str(params.get("description") or "")
    )
    ignored = {"permissionType", "type", "target", "path", "command", "description"}
    details = {key: value for key, value in params.items() if key not in ignored}
    return {
        "permissionType": normalize_permission_type(str(raw_type)),
        "target": str(target),
        "details": details,
    }


def acp_event_to_agent_output(event: dict) -> dict:
    """ACP 事件 → { kind, payload }；kind: acp.turn/acp.message/acp.tool/acp.permission/acp.error/acp.raw."""
    method = str(event.get("method") or "")
    params = event.get("params") or {}
    kind_map = {
        "session/started": "acp.turn",
        "session/finished": "acp.turn",
        "turn/started": "acp.turn",
        "turn/completed": "acp.turn",
        "message": "acp.message",
        "tool/started": "acp.tool",
        "tool/completed": "acp.tool",
        "permission/request": "acp.permission",
        "error": "acp.error",
    }
    kind = kind_map.get(method, "acp.raw")
    return {"kind": kind, "payload": {"event": method, **params}}


class AcpEventReader(threading.Thread):
    """后台线程读取 stdout JSON-RPC；通知走 on_event，响应按 id 路由到 response 队列。"""

    def __init__(
        self,
        stream,
        *,
        on_event: Callable[[dict], None],
        responses: dict[int, "queue.Queue[dict]"],
    ) -> None:
        super().__init__(daemon=True)
        self._stream = stream
        self._on_event = on_event
        self._responses = responses

    def run(self) -> None:
        for raw in self._stream:
            line = raw.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._on_event({"method": "error", "params": {"text": line[:500]}})
                continue
            if not isinstance(message, dict):
                continue
            if "id" in message and isinstance(message.get("id"), int):
                response_queue = self._responses.get(message["id"])
                if response_queue is not None:
                    response_queue.put(message)
            elif message.get("method"):
                self._on_event(message)


class AcpSession:
    """一个 ACP 子进程：JSON-RPC over stdio，可承载多个 session/turn。"""

    def __init__(
        self,
        executable: str,
        args: list[str],
        *,
        cwd: Path,
        env: dict[str, str],
        timeout_seconds: float = ACP_JSON_RPC_TIMEOUT_SECONDS,
    ) -> None:
        self._executable = executable
        self._args = list(args)
        self._cwd = cwd
        self._env = dict(env)
        self._timeout_seconds = timeout_seconds
        self._process: subprocess.Popen[bytes] | None = None
        self._next_id = 1
        self._responses: dict[int, queue.Queue[dict]] = {}
        self._on_event: Callable[[dict], None] | None = None
        self._reader: AcpEventReader | None = None

    def set_event_callback(self, callback: Callable[[dict], None]) -> None:
        self._on_event = callback

    def start(self) -> None:
        if self._process is not None and self.is_alive():
            return
        self._process = subprocess.Popen(
            [self._executable, *self._args],
            cwd=str(self._cwd),
            env=self._env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._reader = AcpEventReader(
            self._process.stdout,
            on_event=self._dispatch_event,
            responses=self._responses,
        )
        self._reader.start()

    def _dispatch_event(self, event: dict) -> None:
        if self._on_event is not None:
            try:
                self._on_event(event)
            except Exception:
                # 回调异常不得终止读取线程
                pass

    def new_session(self, config: dict | None = None) -> str:
        response = self._request("session/new", {"config": config or {}})
        session_id = response.get("sessionId") or response.get("session_id")
        if not session_id:
            raise AcpError("AGENT_ACP_INVALID_RESPONSE", "ACP session/new 未返回 sessionId")
        return str(session_id)

    def send_turn(self, prompt: str, *, session_id: str) -> str:
        response = self._request("session/turn", {"sessionId": session_id, "prompt": prompt})
        turn_id = response.get("turnId") or response.get("turn_id")
        if not turn_id:
            raise AcpError("AGENT_ACP_INVALID_RESPONSE", "ACP session/turn 未返回 turnId")
        return str(turn_id)

    def continue_turn(self, turn_id: str, message: str) -> str:
        response = self._request("turn/continue", {"turnId": turn_id, "message": message})
        return str(response.get("turnId") or response.get("turn_id") or turn_id)

    def request_permission_response(
        self, request_id: str, *, allow: bool, reason: str | None = None
    ) -> None:
        self._request(
            "permission/respond",
            {"requestId": request_id, "allow": allow, "reason": reason},
        )

    def _request(self, method: str, params: dict) -> dict:
        if not self.is_alive():
            raise AcpError("AGENT_ACP_NOT_ALIVE", "ACP 子进程已退出")
        request_id = self._next_id
        self._next_id += 1
        response_queue: queue.Queue[dict] = queue.Queue()
        self._responses[request_id] = response_queue
        try:
            payload = {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }
            assert self._process is not None and self._process.stdin is not None
            self._process.stdin.write((json.dumps(payload) + "\n").encode("utf-8"))
            self._process.stdin.flush()
            try:
                message = response_queue.get(timeout=self._timeout_seconds)
            except queue.Empty:
                raise AcpError(
                    "AGENT_ACP_TIMEOUT",
                    f"ACP 请求超时: {method}",
                    status=423,
                )
            if "error" in message and message["error"] is not None:
                error = message["error"]
                raise AcpError(
                    "AGENT_ACP_ERROR",
                    f"ACP 返回错误: {error.get('message', error)}",
                )
            return message.get("result") or {}
        finally:
            self._responses.pop(request_id, None)

    def close(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
        except OSError:
            pass
        try:
            process.terminate()
            process.wait(timeout=5)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass

    def is_alive(self) -> bool:
        process = self._process
        if process is None:
            return False
        return process.poll() is None

    def pid(self) -> int | None:
        return self._process.pid if self._process is not None else None


def build_acp_command(provider: str, *, cwd: Path) -> "CliCommand | None":
    """按 provider 构造 ACP 启动命令；不支持 ACP 的 provider 返回 None。"""
    from workflow_platform.execution.providers import CliCommand

    if provider == "fake":
        return CliCommand(
            executable=sys.executable,
            args=["-m", "workflow_platform.execution.fake_acp"],
            cwd=cwd,
        )
    if provider == "claude":
        executable = "claude.cmd" if sys.platform == "win32" else "claude"
        return CliCommand(executable=executable, args=["--acp"], cwd=cwd)
    if provider == "opencode":
        executable = "opencode.cmd" if sys.platform == "win32" else "opencode"
        return CliCommand(executable=executable, args=["--acp"], cwd=cwd)
    return None
