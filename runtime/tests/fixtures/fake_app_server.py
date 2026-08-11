"""Fake Codex app-server over stdio JSON-RPC (tests + fake provider).

Implements the subset of the app-server protocol used by AppServerAgentExecutor:
initialize, thread/start, thread/resume, turn/start, turn/interrupt, plus the
item/commandExecution/requestApproval server->client approval flow and the
item/started / item/completed / item/agentMessage/delta / turn/completed
notifications.
"""
from __future__ import annotations

import json
import sys
import time
from uuid import uuid4

SESSIONS: dict[str, str] = {}


def _send(payload: dict) -> None:
    sys.stdout.buffer.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def _read_message() -> dict | None:
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue
    return None


def _turn_events(thread_id: str, turn_id: str, text: str, *, with_approval: bool) -> None:
    item_id = f"item-{uuid4()}"
    command = "powershell -Command \"echo fake-output\""
    _send({
        "jsonrpc": "2.0",
        "method": "turn/started",
        "params": {"threadId": thread_id, "turnId": turn_id},
    })
    _send({
        "jsonrpc": "2.0",
        "method": "item/started",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "item": {
                "type": "commandExecution",
                "id": item_id,
                "command": command,
                "cwd": "",
                "processId": None,
                "source": "shell",
                "status": "running",
                "commandActions": [],
                "aggregatedOutput": None,
                "exitCode": None,
                "durationMs": None,
            },
        },
    })
    if with_approval:
        approval_id = 9000
        _send({
            "jsonrpc": "2.0",
            "id": approval_id,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "command": command,
                "cwd": "",
                "reason": "fake approval",
                "startedAtMs": 0,
            },
        })
        # Wait for the client's approval response before completing the item.
        response = _read_message()
        decision = ((response or {}).get("result") or {}).get("decision")
        if decision == "approved":
            status, exit_code, output = "completed", 0, "fake-output"
        else:
            status, exit_code, output = "failed", 1, ""
        _send({
            "jsonrpc": "2.0",
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "item": {
                    "type": "commandExecution",
                    "id": item_id,
                    "command": command,
                    "cwd": "",
                    "processId": None,
                    "source": "shell",
                    "status": status,
                    "commandActions": [],
                    "aggregatedOutput": output,
                    "exitCode": exit_code,
                    "durationMs": 1,
                },
            },
        })
    else:
        _send({
            "jsonrpc": "2.0",
            "method": "item/completed",
            "params": {
                "threadId": thread_id,
                "turnId": turn_id,
                "item": {
                    "type": "commandExecution",
                    "id": item_id,
                    "command": command,
                    "cwd": "",
                    "processId": None,
                    "source": "shell",
                    "status": "completed",
                    "commandActions": [],
                    "aggregatedOutput": "fake-output",
                    "exitCode": 0,
                    "durationMs": 1,
                },
            },
        })
    message_id = f"msg-{uuid4()}"
    _send({
        "jsonrpc": "2.0",
        "method": "item/started",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "item": {"type": "agentMessage", "id": message_id, "text": "", "phase": "final_answer"},
        },
    })
    reply = f"fake app-server reply: {text[:40]}"
    for part in [reply[:10], reply[10:]]:
        _send({
            "jsonrpc": "2.0",
            "method": "item/agentMessage/delta",
            "params": {"threadId": thread_id, "turnId": turn_id, "itemId": message_id, "delta": part},
        })
    _send({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": thread_id,
            "turnId": turn_id,
            "item": {"type": "agentMessage", "id": message_id, "text": reply, "phase": "final_answer"},
        },
    })
    _send({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": thread_id, "turnId": turn_id}})


def main() -> int:
    while True:
        message = _read_message()
        if message is None:
            return 0
        method = message.get("method") or ""
        request_id = message.get("id")
        params = message.get("params") or {}
        if method == "initialize":
            _send({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "clientInfo": {"name": "fake", "version": "0.0.1"},
                    "capabilities": {},
                },
            })
        elif method == "thread/start":
            thread_id = str(uuid4())
            SESSIONS[thread_id] = thread_id
            _send({
                "jsonrpc": "2.0",
                "method": "thread/started",
                "params": {"thread": {"id": thread_id, "status": {"type": "idle"}}},
            })
            _send({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "thread": {"id": thread_id, "status": {"type": "idle"}},
                    "cwd": params.get("cwd") or "",
                    "approvalPolicy": params.get("approvalPolicy") or "on-request",
                    "approvalsReviewer": {"type": "user"},
                    "model": "fake",
                    "modelProvider": "fake",
                    "sandbox": {
                        "type": "workspaceWrite",
                        "writableRoots": [params.get("cwd") or ""],
                        "networkAccess": False,
                        "excludeTmpdirEnvVar": False,
                        "excludeSlashTmp": False,
                    },
                },
            })
        elif method == "thread/resume":
            thread_id = params.get("threadId") or str(uuid4())
            _send({
                "jsonrpc": "2.0",
                "method": "thread/started",
                "params": {"thread": {"id": thread_id, "status": {"type": "idle"}}},
            })
            _send({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {
                    "thread": {"id": thread_id, "status": {"type": "idle"}},
                    "cwd": params.get("cwd") or "",
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": {"type": "user"},
                    "model": "fake",
                    "modelProvider": "fake",
                    "sandbox": {
                        "type": "workspaceWrite",
                        "writableRoots": [params.get("cwd") or ""],
                        "networkAccess": False,
                        "excludeTmpdirEnvVar": False,
                        "excludeSlashTmp": False,
                    },
                },
            })
        elif method == "turn/start":
            turn_id = str(uuid4())
            thread_id = params.get("threadId") or ""
            text = "".join(
                item.get("text", "") for item in (params.get("input") or []) if item.get("type") == "text"
            )
            with_approval = "PERM:" in text
            _send({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"turnId": turn_id, "threadId": thread_id},
            })
            _turn_events(thread_id, turn_id, text, with_approval=with_approval)
        elif method == "turn/interrupt":
            _send({"jsonrpc": "2.0", "id": request_id, "result": {}})
            _send({
                "jsonrpc": "2.0",
                "method": "turn/completed",
                "params": {"threadId": params.get("threadId"), "turnId": params.get("turnId")},
            })
        else:
            _send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"unknown method {method}"},
            })


if __name__ == "__main__":
    raise SystemExit(main())
