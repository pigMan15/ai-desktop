from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import sys
from typing import Any, Protocol


@dataclass(frozen=True)
class CliCommand:
    executable: str
    args: list[str]
    cwd: Path
    stdin: str | None = None


class CliProvider(Protocol):
    id: str

    def build_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        allowed_tools: list[str],
    ) -> CliCommand: ...

    def parse_line(self, line: str) -> dict[str, Any]: ...


class CodexCliProvider:
    id = "codex"

    def __init__(self, *, platform: str | None = None) -> None:
        self._platform = platform or sys.platform

    def build_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        allowed_tools: list[str],
    ) -> CliCommand:
        executable = "codex.cmd" if self._platform == "win32" else "codex"
        return CliCommand(
            executable=executable,
            args=[
                "exec",
                "--json",
                "--sandbox",
                "workspace-write",
                "--skip-git-repo-check",
                "--cd",
                str(cwd),
                "-",
            ],
            cwd=cwd,
            stdin=prompt,
        )

    def parse_line(self, line: str) -> dict[str, Any]:
        payload = _parse_json_line(line)
        if payload is None:
            return _raw_event(line)

        event_type = payload.get("type")
        if event_type == "thread.started":
            thread_id = _text_from_value(payload.get("thread_id"))
            suffix = f"（{thread_id}）" if thread_id else ""
            return {"kind": "progress", "payload": {"text": f"Codex 会话已创建{suffix}。"}}
        if event_type == "turn.started":
            return {"kind": "progress", "payload": {"text": "Codex 正在分析并生成结果。"}}
        if event_type == "turn.completed":
            return {"kind": "progress", "payload": {"text": "Codex 已完成本轮处理。"}}
        if event_type in {"message", "assistant_message"}:
            text = _text_from_value(payload.get("message")) or _text_from_value(payload.get("text"))
            if text is not None:
                return {"kind": "message", "payload": {"text": text}}
        if event_type in {"final", "final_message", "result"}:
            text = _text_from_value(payload.get("message")) or _text_from_value(payload.get("text"))
            if text is not None:
                return {"kind": "final", "payload": {"text": text}}
        if event_type in {"error", "failure"}:
            text = _text_from_value(payload.get("message")) or _text_from_value(payload.get("error"))
            if text is not None:
                return {"kind": "error", "payload": {"text": text}}
        if event_type == "item.completed":
            item = payload.get("item")
            if isinstance(item, dict) and item.get("type") == "agent_message":
                text = _text_from_value(item.get("text"))
                if text is not None:
                    return {"kind": "message", "payload": {"text": text}}
        if event_type == "item.started":
            item = payload.get("item")
            if isinstance(item, dict) and item.get("type") == "command_execution":
                command = _text_from_value(item.get("command"))
                if command is not None:
                    return {"kind": "progress", "payload": {"text": f"Codex 正在执行命令：{command}"}}

        return _raw_event(line)


class ClaudeCliProvider:
    id = "claude"

    def __init__(self, *, platform: str | None = None) -> None:
        self._platform = platform or sys.platform

    def build_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        allowed_tools: list[str],
    ) -> CliCommand:
        executable = "claude.cmd" if self._platform == "win32" else "claude"
        args = [
            "-p",
            prompt,
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "acceptEdits",
        ]
        if allowed_tools:
            args.extend(["--allowedTools", ",".join(allowed_tools)])
        return CliCommand(executable=executable, args=args, cwd=cwd)

    def parse_line(self, line: str) -> dict[str, Any]:
        payload = _parse_json_line(line)
        if payload is None:
            return _raw_event(line)

        event_type = payload.get("type")
        if event_type == "assistant":
            text = _text_from_claude_message(payload.get("message"))
            if text is not None:
                return {"kind": "message", "payload": {"text": text}}
        if event_type in {"result", "final"}:
            text = _text_from_value(payload.get("result")) or _text_from_value(payload.get("text"))
            if text is not None:
                return {"kind": "final", "payload": {"text": text}}
        if event_type == "error":
            text = _text_from_value(payload.get("message")) or _text_from_value(payload.get("error"))
            if text is not None:
                return {"kind": "error", "payload": {"text": text}}

        return _raw_event(line)


def _parse_json_line(line: str) -> dict[str, Any] | None:
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _raw_event(line: str) -> dict[str, Any]:
    return {"kind": "raw", "payload": {"text": line}}


def _text_from_value(value: Any) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None


def _text_from_claude_message(message: Any) -> str | None:
    if not isinstance(message, dict):
        return None
    content = message.get("content")
    if not isinstance(content, list):
        return None
    text_parts = [
        item.get("text")
        for item in content
        if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str)
    ]
    text = "".join(text_parts)
    return text or None
