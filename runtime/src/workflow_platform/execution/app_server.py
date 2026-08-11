"""Codex app-server conversational executor (official Codex App protocol).

Spawns `codex app-server --listen stdio://` per job and drives the newline
delimited JSON-RPC protocol used by the official Codex App:

- initialize -> thread/start (approvalPolicy + sandbox) -> turn/start per user
  message; follow-up turns reuse the same thread id.
- Approval requests arrive as server->client JSON-RPC requests
  (item/commandExecution/requestApproval, item/fileChange/requestApproval,
  item/permissions/requestApproval). The executor surfaces them through the
  same agent-permission pipeline used by ACP and responds approved/denied when
  the human decides.
- Tool/command execution items are emitted as `tool` chat events so the
  ChatView can render execution blocks like the Codex App.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
import subprocess
from threading import Event, RLock, Thread
from typing import Any, Callable
from uuid import uuid4

from workflow_platform.execution.cli import CliExecutionResult, _hidden_startupinfo

APP_SERVER_APPROVAL_METHODS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
}


def app_server_executable(platform: str | None = None) -> str:
    return "codex.cmd" if (platform or sys.platform) == "win32" else "codex"


class AppServerClient:
    """Newline-delimited JSON-RPC 2.0 client over stdio."""

    def __init__(
        self,
        *,
        executable: str,
        base_args: list[str] | None,
        cwd: Path,
        env: dict[str, str],
        on_notification: Callable[[str, dict[str, Any]], None],
        on_request: Callable[[int, str, dict[str, Any]], None],
    ) -> None:
        self._executable = executable
        self._base_args = base_args or ["app-server", "--listen", "stdio://"]
        self._cwd = cwd
        self._env = env
        self._on_notification = on_notification
        self._on_request = on_request
        self._process: subprocess.Popen[bytes] | None = None
        self._next_id = 0
        self._pending: dict[int, dict[str, Any]] = {}
        self._lock = RLock()

    def start(self) -> int:
        self._process = subprocess.Popen(
            [self._executable, *self._base_args],
            cwd=self._cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            shell=False,
            env=self._env,
            startupinfo=_hidden_startupinfo(),
        )
        Thread(target=self._read_loop, name="app-server-reader", daemon=True).start()
        return self._process.pid or 0

    def _read_loop(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        for raw_line in process.stdout:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            method = message.get("method")
            message_id = message.get("id")
            if isinstance(message_id, int) and method is None:
                with self._lock:
                    pending = self._pending.pop(message_id, None)
                if pending is not None:
                    pending["result"] = message
                    pending["event"].set()
            elif isinstance(message_id, int) and isinstance(method, str):
                self._on_request(message_id, method, message.get("params") or {})
            elif isinstance(method, str):
                try:
                    self._on_notification(method, message.get("params") or {})
                except Exception:
                    pass

    def _request(self, method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
        process = self._process
        if process is None or process.stdin is None:
            raise RuntimeError("AGENT_APP_SERVER_NOT_STARTED: app-server process is not running")
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
            holder: dict[str, Any] = {"event": Event(), "result": None}
            self._pending[request_id] = holder
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        }
        process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        process.stdin.flush()
        if not holder["event"].wait(timeout=timeout):
            with self._lock:
                self._pending.pop(request_id, None)
            raise TimeoutError(f"AGENT_APP_SERVER_TIMEOUT: {method} timed out after {timeout}s")
        response = holder["result"] or {}
        if "error" in response:
            error = response["error"]
            raise RuntimeError(
                f"AGENT_APP_SERVER_ERROR: {method} -> {json.dumps(error, ensure_ascii=False)[:300]}"
            )
        return response.get("result") or {}

    def respond(self, request_id: int, result: dict[str, Any]) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def respond_error(self, request_id: int, message: str) -> None:
        self._write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": message},
            }
        )

    def _write(self, payload: dict[str, Any]) -> None:
        process = self._process
        if process is None or process.stdin is None:
            return
        try:
            process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
            process.stdin.flush()
        except OSError:
            pass

    def initialize(self, timeout: float = 15.0) -> dict[str, Any]:
        return self._request(
            "initialize",
            {"clientInfo": {"name": "ai-desktop", "version": "0.1.0"}},
            timeout=timeout,
        )

    def thread_start(
        self,
        *,
        cwd: Path,
        approval_policy: str = "on-request",
        sandbox: str = "workspace-write",
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return self._request(
            "thread/start",
            {
                "cwd": str(cwd),
                "approvalPolicy": approval_policy,
                "sandbox": sandbox,
                "baseInstructions": (
                    "You are ai-desktop's coding agent. Work inside the provided workspace. "
                    "Execute commands and edit files as needed."
                ),
            },
            timeout=timeout,
        )

    def thread_resume(self, *, thread_id: str, cwd: Path, timeout: float = 30.0) -> dict[str, Any]:
        return self._request(
            "thread/resume",
            {"threadId": thread_id, "cwd": str(cwd)},
            timeout=timeout,
        )

    def turn_start(
        self,
        *,
        thread_id: str,
        message: str,
        approval_policy: str = "on-request",
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        return self._request(
            "turn/start",
            {
                "threadId": thread_id,
                "input": [{"type": "text", "text": message, "text_elements": []}],
                "approvalPolicy": approval_policy,
            },
            timeout=timeout,
        )

    def interrupt_turn(self, *, thread_id: str, turn_id: str, timeout: float = 10.0) -> dict[str, Any]:
        return self._request(
            "turn/interrupt",
            {"threadId": thread_id, "turnId": turn_id},
            timeout=timeout,
        )

    def close(self) -> None:
        process = self._process
        self._process = None
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()


def map_app_server_permission(method: str, params: dict[str, Any]) -> dict[str, Any]:
    """Map an app-server approval request to AgentPermissionRequest fields."""
    if method == "item/commandExecution/requestApproval":
        command = params.get("command") or ""
        return {
            "permissionType": "run_command",
            "target": str(command)[:500] or "????",
            "details": {
                "cwd": params.get("cwd"),
                "reason": params.get("reason"),
                "itemId": params.get("itemId"),
                "turnId": params.get("turnId"),
            },
        }
    if method == "item/fileChange/requestApproval":
        changes = params.get("fileChanges") or params.get("changes") or []
        paths = []
        if isinstance(changes, list):
            for change in changes:
                if isinstance(change, dict):
                    path = change.get("path") or change.get("filePath") or change.get("file_path")
                    if isinstance(path, str) and path:
                        paths.append(path)
        return {
            "permissionType": "write_file",
            "target": ", ".join(paths)[:500] or "????",
            "details": {
                "reason": params.get("reason"),
                "itemId": params.get("itemId"),
                "turnId": params.get("turnId"),
            },
        }
    if method == "item/permissions/requestApproval":
        requested = params.get("requested") or params.get("permissions") or params.get("requests") or []
        summary = ""
        if isinstance(requested, list):
            summary = ", ".join(
                str(item) for item in requested if isinstance(item, str)
            )[:500]
        return {
            "permissionType": "network",
            "target": summary or "??????",
            "details": {
                "reason": params.get("reason"),
                "itemId": params.get("itemId"),
                "turnId": params.get("turnId"),
            },
        }
    return {
        "permissionType": "other",
        "target": "????",
        "details": {"method": method, "reason": params.get("reason")},
    }


class AppServerAgentExecutor:
    """Conversational Codex executor over the app-server protocol.

    Same shape as AcpAgentExecutor / CliAgentExecutor (constructor injection +
    run() returning CliExecutionResult). conversational=True keeps the thread
    alive after the first turn and returns AWAITING_INPUT.
    """

    def __init__(
        self,
        *,
        executable: str | None = None,
        base_args: list[str] | None = None,
        on_output: Callable[[dict[str, Any]], None] | None = None,
        on_started: Callable[[int], None] | None = None,
        on_permission: Callable[[str, dict], None] | None = None,
        extra_environment: dict[str, str] | None = None,
    ) -> None:
        self._executable = executable or app_server_executable()
        self._base_args = base_args
        self._on_output = on_output
        self._on_started = on_started
        self._on_permission = on_permission
        self._extra_environment = extra_environment or {}
        self._clients: dict[str, AppServerClient] = {}
        self._conversations: dict[str, dict[str, Any]] = {}
        self._cancelled: set[str] = set()
        self._lock = RLock()

    # -- lifecycle ----------------------------------------------------------

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
        del project_root, max_output_bytes, allowed_tools
        resolved_cwd = cwd.resolve()
        state = self._new_state(job_id, resolved_cwd)
        client = self._start_client(job_id, resolved_cwd, state)
        with self._lock:
            cancelled_before_start = job_id in self._cancelled
        pid = client.start()
        if self._on_started is not None:
            self._on_started(pid)
        if cancelled_before_start:
            self._drop_state(job_id)
            return CliExecutionResult(
                status="CANCELLED",
                summary=None,
                error="AGENT_CANCELLED: app-server chat cancelled before start",
                exit_code=None,
            )
        try:
            client.initialize()
            result = client.thread_start(cwd=resolved_cwd, approval_policy="on-request")
            thread = result.get("thread") or {}
            thread_id = thread.get("id") or result.get("threadId")
            if isinstance(thread_id, str) and thread_id:
                state["thread_id"] = thread_id
            else:
                raise RuntimeError("AGENT_THREAD_LOST: app-server did not return a thread id")
            self._emit(
                {
                    "kind": "acp.turn",
                    "payload": {"text": f"Codex ??????{thread_id}??"},
                }
            )
            turn_id = client.turn_start(thread_id=thread_id, message=prompt)
            state["turn_id"] = turn_id
            if not state["completed"].wait(timeout=timeout_seconds):
                return CliExecutionResult(
                    status="FAILED",
                    summary=None,
                    error=f"AGENT_TIMEOUT: app-server turn exceeded {timeout_seconds} seconds",
                    exit_code=None,
                )
            if self._is_cancelled(job_id):
                self._drop_state(job_id)
                return CliExecutionResult(
                    status="CANCELLED",
                    summary=None,
                    error="AGENT_CANCELLED: app-server chat was cancelled",
                    exit_code=None,
                )
            error_event = next(
                (event for event in state["events"] if event["kind"] == "acp.error"),
                None,
            )
            if error_event is not None:
                self._drop_state(job_id)
                return CliExecutionResult(
                    status="FAILED",
                    summary=None,
                    error=error_event["payload"].get("text") or "AGENT_FAILED: app-server error",
                    exit_code=None,
                )
            if not conversational:
                self._drop_state(job_id)
                return CliExecutionResult(
                    status="COMPLETED",
                    summary=self._last_message(state),
                    error=None,
                    exit_code=0,
                )
            return CliExecutionResult(
                status="AWAITING_INPUT",
                summary=self._last_message(state),
                error=None,
                exit_code=None,
            )
        except Exception as error:
            self._drop_state(job_id)
            return CliExecutionResult(
                status="FAILED",
                summary=None,
                error=f"AGENT_APP_SERVER_ERROR: {error}",
                exit_code=None,
            )

    def continue_conversation(self, job_id: str, message: str) -> str:
        with self._lock:
            state = self._conversations.get(job_id)
        if state is None:
            raise ValueError("AGENT_CONVERSATION_LOST: app-server chat is not active")
        thread_id = state.get("thread_id")
        if not isinstance(thread_id, str) or not thread_id:
            raise ValueError("AGENT_CONVERSATION_LOST: app-server thread id missing")
        if self._on_output is not None:
            self._on_output({"kind": "chat.user", "payload": {"text": message}})
        state["completed"].clear()
        state["events"] = []
        state["tool_outputs"] = {}

        def worker() -> None:
            try:
                turn_id = state["client"].turn_start(thread_id=thread_id, message=message)
                state["turn_id"] = turn_id
                state["completed"].wait(timeout=300)
            except Exception as error:
                state["completed"].set()
                if self._on_output is not None:
                    self._on_output(
                        {"kind": "acp.error", "payload": {"text": f"AGENT_CONTINUE_ERROR: {error}"}}
                    )

        Thread(target=worker, name=f"app-server-chat-{job_id}", daemon=True).start()
        return f"app-server-turn-{uuid4()}"

    def wait_turn_completed(self, job_id: str, timeout: float) -> bool:
        with self._lock:
            state = self._conversations.get(job_id)
        if state is None:
            return False
        return bool(state["completed"].wait(timeout=timeout))

    def is_conversation_alive(self, job_id: str) -> bool:
        with self._lock:
            return job_id in self._conversations

    def end_conversation(self, job_id: str) -> None:
        self._drop_state(job_id)

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            self._cancelled.add(job_id)
            state = self._conversations.get(job_id)
        if state is not None:
            turn_id = state.get("turn_id")
            thread_id = state.get("thread_id")
            try:
                if isinstance(thread_id, str) and isinstance(turn_id, str) and turn_id:
                    state["client"].interrupt_turn(thread_id=thread_id, turn_id=turn_id)
            except Exception:
                pass
        self._drop_state(job_id)
        return True

    def thread_id_for(self, job_id: str) -> str | None:
        with self._lock:
            state = self._conversations.get(job_id)
        if state is None:
            return None
        thread_id = state.get("thread_id")
        return thread_id if isinstance(thread_id, str) and thread_id else None

    def adopt_conversation(self, job_id: str, *, thread_id: str, cwd: Path) -> None:
        """Rebuild an app-server client for a persisted thread (Runtime restart)."""
        resolved_cwd = cwd.resolve()
        state = self._new_state(job_id, resolved_cwd)
        state["thread_id"] = thread_id
        client = self._start_client(job_id, resolved_cwd, state)
        client.start()
        client.initialize()
        client.thread_resume(thread_id=thread_id, cwd=resolved_cwd)

    def respond_permission(self, request_id: str, *, allow: bool, reason: str | None = None) -> None:
        with self._lock:
            state = next(
                (
                    candidate
                    for candidate in self._conversations.values()
                    if request_id in (candidate.get("pending_requests") or {})
                ),
                None,
            )
            jsonrpc_id = None
            if state is not None:
                jsonrpc_id = (state.get("pending_requests") or {}).pop(request_id, None)
        if state is None or jsonrpc_id is None:
            return
        if allow:
            decision: dict[str, Any] = {"decision": "approved"}
        else:
            decision = {"decision": {"denied": {"rejection": reason or "denied by user"}}}
        state["client"].respond(int(jsonrpc_id), decision)

    # -- internals ----------------------------------------------------------

    def _new_state(self, job_id: str, cwd: Path) -> dict[str, Any]:
        state: dict[str, Any] = {
            "client": None,
            "thread_id": None,
            "cwd": cwd,
            "turn_id": None,
            "events": [],
            "completed": Event(),
            "pending_requests": {},
            "tool_outputs": {},
        }
        with self._lock:
            self._conversations[job_id] = state
        return state

    def _start_client(self, job_id: str, cwd: Path, state: dict[str, Any]) -> AppServerClient:
        client = AppServerClient(
            executable=self._executable,
            base_args=self._base_args,
            cwd=cwd,
            env=self._allowed_environment(),
            on_notification=lambda method, params: self._handle_notification(
                job_id, method, params
            ),
            on_request=lambda request_id, method, params: self._handle_request(
                job_id, request_id, method, params
            ),
        )
        with self._lock:
            self._clients[job_id] = client
        state["client"] = client
        return client

    def _handle_notification(self, job_id: str, method: str, params: dict[str, Any]) -> None:
        with self._lock:
            state = self._conversations.get(job_id)
        if state is None:
            return
        if method == "thread/started":
            thread = params.get("thread") or {}
            thread_id = thread.get("id")
            if isinstance(thread_id, str) and thread_id:
                state["thread_id"] = thread_id
            self._emit({"kind": "acp.turn", "payload": {"text": "Codex ??????"}})
        elif method == "turn/started":
            self._emit({"kind": "acp.turn", "payload": {"text": "Codex ??????????"}})
        elif method == "item/started":
            self._emit_item_state(job_id, params.get("item") or {}, status="running")
        elif method == "item/completed":
            self._emit_item_state(job_id, params.get("item") or {}, status="completed")
        elif method == "item/agentMessage/delta":
            item_id = params.get("itemId")
            delta = params.get("delta")
            if isinstance(item_id, str) and isinstance(delta, str) and delta:
                state["events"].append(
                    {"kind": "acp.message", "payload": {"text": delta, "messageId": item_id}}
                )
                self._emit(
                    {"kind": "acp.message", "payload": {"text": delta, "messageId": item_id}}
                )
        elif method == "item/commandExecution/outputDelta":
            item_id = params.get("itemId")
            delta = params.get("delta") or params.get("output") or ""
            if isinstance(item_id, str) and isinstance(delta, str) and delta:
                outputs = state["tool_outputs"]
                outputs[item_id] = outputs.get(item_id, "") + delta
                self._emit(
                    {
                        "kind": "tool",
                        "payload": {
                            "itemId": item_id,
                            "title": state.get("tool_titles", {}).get(item_id) or "????",
                            "status": "running",
                            "text": outputs[item_id][-8000:],
                        },
                    }
                )
        elif method == "turn/completed":
            state["completed"].set()
        elif method == "thread/status/changed":
            status = params.get("status") or {}
            if isinstance(status, dict) and status.get("type") == "idle":
                state["completed"].set()
        elif method == "thread/closed":
            state["completed"].set()
        elif method == "item/autoApprovalReview/started":
            self._emit(
                {"kind": "acp.turn", "payload": {"text": "??????"}}
            )
        elif method == "warning":
            text = params.get("text") or params.get("message")
            if isinstance(text, str) and text:
                self._emit({"kind": "acp.error", "payload": {"text": text[:500]}})

    def _handle_request(self, job_id: str, request_id: int, method: str, params: dict[str, Any]) -> None:
        with self._lock:
            state = self._conversations.get(job_id)
        if state is None:
            return
        if method in APP_SERVER_APPROVAL_METHODS:
            request_key = str(request_id)
            state["pending_requests"][request_key] = request_id
            mapped = map_app_server_permission(method, params)
            if self._on_permission is not None:
                try:
                    self._on_permission(request_key, mapped)
                except Exception:
                    pass
            return
        # Unknown server->client request: decline so the turn cannot hang.
        state["client"].respond_error(request_id, "unsupported by ai-desktop")

    def _emit_item_state(self, job_id: str, item: dict[str, Any], *, status: str) -> None:
        with self._lock:
            state = self._conversations.get(job_id)
        if state is None or not isinstance(item, dict):
            return
        item_type = item.get("type")
        item_id = item.get("id")
        if not isinstance(item_id, str):
            return
        if item_type == "commandExecution":
            command = item.get("command") or "????"
            if status == "running":
                state.setdefault("tool_titles", {})[item_id] = command
                self._emit(
                    {
                        "kind": "tool",
                        "payload": {
                            "itemId": item_id,
                            "title": command,
                            "status": "running",
                            "text": state.get("tool_outputs", {}).get(item_id, ""),
                        },
                    }
                )
            else:
                item_status = item.get("status") or "completed"
                failed = item_status == "failed" or item.get("exitCode") not in (None, 0)
                output = item.get("aggregatedOutput") or ""
                payload: dict[str, Any] = {
                    "itemId": item_id,
                    "title": command,
                    "status": "failed" if failed else "completed",
                    "text": output[:4000] if output else ("??????" if failed else "??????"),
                }
                if item.get("exitCode") is not None:
                    payload["exitCode"] = item.get("exitCode")
                self._emit({"kind": "tool", "payload": payload})
        elif item_type == "mcpToolCall":
            tool = item.get("tool") or "MCP"
            title = f"MCP ?? {tool}"
            if status == "running":
                self._emit(
                    {
                        "kind": "tool",
                        "payload": {"itemId": item_id, "title": title, "status": "running", "text": ""},
                    }
                )
            else:
                failed = bool(item.get("error"))
                result = item.get("result") or {}
                text = ""
                if isinstance(result, dict):
                    content = result.get("content") or []
                    if isinstance(content, list):
                        for part in content:
                            if isinstance(part, dict) and part.get("type") == "text":
                                text += str(part.get("text", "")) + "\n"
                self._emit(
                    {
                        "kind": "tool",
                        "payload": {
                            "itemId": item_id,
                            "title": title,
                            "status": "failed" if failed else "completed",
                            "text": text.strip()[:4000] or ("????" if failed else "????"),
                        },
                    }
                )
        elif item_type == "agentMessage":
            text = item.get("text")
            if isinstance(text, str) and text:
                state["events"].append(
                    {"kind": "acp.message", "payload": {"text": text, "messageId": item_id}}
                )
                self._emit(
                    {"kind": "acp.message", "payload": {"text": text, "messageId": item_id}}
                )

    def _last_message(self, state: dict[str, Any]) -> str | None:
        for event in reversed(state["events"]):
            if event["kind"] == "acp.message":
                text = event["payload"].get("text")
                if isinstance(text, str) and text:
                    return text
        return None

    def _drop_state(self, job_id: str) -> None:
        with self._lock:
            state = self._conversations.pop(job_id, None)
            client = self._clients.pop(job_id, None)
            self._cancelled.discard(job_id)
        if client is not None:
            client.close()
        elif state is not None and state.get("client") is not None:
            state["client"].close()

    def _emit(self, event: dict[str, Any]) -> None:
        if self._on_output is not None:
            try:
                self._on_output(event)
            except Exception:
                pass

    def _allowed_environment(self) -> dict[str, str]:
        from workflow_platform.execution.cli import ALLOWED_ENVIRONMENT_KEYS

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
