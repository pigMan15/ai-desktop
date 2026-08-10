"""Fake ACP server over stdio JSON-RPC (tests + fake provider).

Simulates: session/new -> session/started, session/turn -> turn/started + message
(+ optional permission/request when prompt contains 'PERM:') + turn/completed,
turn/continue -> message + turn/completed, permission/respond -> ok.
"""
from __future__ import annotations

import json
import sys
import time
from uuid import uuid4


def _send(payload: dict) -> None:
    # 强制 UTF-8 字节输出，避免 Windows 控制台编码（GBK）污染 JSON-RPC 流
    sys.stdout.buffer.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def main() -> int:
    sessions: dict[str, str] = {}
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        request_id = request.get("id")
        method = request.get("method") or ""
        params = request.get("params") or {}
        if method == "session/new":
            session_id = str(uuid4())
            sessions[session_id] = session_id
            _send({"jsonrpc": "2.0", "id": request_id, "result": {"sessionId": session_id}})
            _send({
                "jsonrpc": "2.0",
                "method": "session/started",
                "params": {"sessionId": session_id},
            })
        elif method == "session/turn":
            session_id = params.get("sessionId", "")
            prompt = params.get("prompt", "")
            turn_id = str(uuid4())
            _send({"jsonrpc": "2.0", "id": request_id, "result": {"turnId": turn_id}})
            _send({"jsonrpc": "2.0", "method": "turn/started", "params": {"turnId": turn_id, "sessionId": session_id}})
            _send({
                "jsonrpc": "2.0",
                "method": "message",
                "params": {"turnId": turn_id, "role": "agent", "text": f"fake ack: {prompt[:80]}"},
            })
            if "PERM:" in prompt:
                _send({
                    "jsonrpc": "2.0",
                    "method": "permission/request",
                    "params": {
                        "requestId": f"perm-{turn_id}",
                        "turnId": turn_id,
                        "permissionType": "write_file",
                        "target": "output/result.md",
                        "description": "写输出文件",
                    },
                })
            if "SLOW" in prompt:
                time.sleep(0.5)
            _send({"jsonrpc": "2.0", "method": "turn/completed", "params": {"turnId": turn_id, "sessionId": session_id}})
        elif method == "turn/continue":
            turn_id = params.get("turnId", str(uuid4()))
            message = params.get("message", "")
            _send({"jsonrpc": "2.0", "id": request_id, "result": {"turnId": turn_id}})
            _send({
                "jsonrpc": "2.0",
                "method": "message",
                "params": {"turnId": turn_id, "role": "agent", "text": f"fake ack: {message[:80]}"},
            })
            _send({"jsonrpc": "2.0", "method": "turn/completed", "params": {"turnId": turn_id}})
        elif method == "permission/respond":
            _send({"jsonrpc": "2.0", "id": request_id, "result": {"ok": True}})
        elif method == "session/close":
            _send({"jsonrpc": "2.0", "id": request_id, "result": {"ok": True}})
            _send({"jsonrpc": "2.0", "method": "session/finished", "params": {}})
            return 0
        elif method == "slow":
            time.sleep(1.0)
            _send({"jsonrpc": "2.0", "id": request_id, "result": {"ok": True}})
        elif method == "error":
            _send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32000, "message": "fake error"},
            })
        else:
            _send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32601, "message": f"unknown method {method}"},
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
