"""Direct OpenAI-compatible chat provider (design doc 2026-08-10 Phase 4).

Provider `direct` calls an OpenAI-compatible /chat/completions endpoint over
SSE and reuses the conversational agent job + ChatView pipeline. It does not
run an agent CLI and does not issue tool/permission requests.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from http.client import HTTPException
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from workflow_platform.execution.cli import CliExecutionResult

DIRECT_HTTP_TIMEOUT_SECONDS = 60

DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4o-mini"
DEFAULT_TEMPERATURE = 0.7
DEFAULT_SYSTEM_PROMPT = "?? ai-desktop ??????????????????????"

MASKED_API_KEY = "********"


@dataclass(frozen=True)
class DirectChatConfig:
    vendor: str = "openai"
    base_url: str = DEFAULT_BASE_URL
    api_key: str = ""
    model: str = DEFAULT_MODEL
    temperature: float = DEFAULT_TEMPERATURE
    max_tokens: int | None = None
    top_p: float | None = None
    system_prompt: str = DEFAULT_SYSTEM_PROMPT

    @property
    def configured(self) -> bool:
        return bool(
            self.base_url.strip()
            and self.model.strip()
            and self.api_key.strip()
            and self.api_key != MASKED_API_KEY
        )


ChatStreamer = Callable[[DirectChatConfig, list[dict[str, Any]], Callable[[str], None]], str]


def stream_chat_completion(
    config: DirectChatConfig,
    messages: list[dict[str, Any]],
    on_delta: Callable[[str], None],
) -> str:
    """Call OpenAI-compatible chat completions with SSE streaming.

    Returns the full assistant text. Each content delta is forwarded to
    ``on_delta`` as soon as it arrives.
    """
    if not config.configured:
        raise ValueError(
            "AGENT_DIRECT_NOT_CONFIGURED: ??????????????????????"
        )
    endpoint = _chat_completions_url(config.base_url)
    payload: dict[str, Any] = {
        "model": config.model,
        "messages": messages,
        "stream": True,
        "temperature": config.temperature,
    }
    if config.max_tokens is not None:
        payload["max_tokens"] = config.max_tokens
    if config.top_p is not None:
        payload["top_p"] = config.top_p
    request = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.api_key}",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    collected: list[str] = []
    try:
        with urlopen(request, timeout=DIRECT_HTTP_TIMEOUT_SECONDS) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                delta = (choices[0].get("delta") or {})
                content = delta.get("content")
                if isinstance(content, str) and content:
                    collected.append(content)
                    on_delta(content)
                else:
                    # DeepSeek Reasoner ?????????? reasoning_content
                    reasoning = delta.get("reasoning_content")
                    if isinstance(reasoning, str) and reasoning:
                        collected.append(reasoning)
                        on_delta(reasoning)
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")[:500]
        raise ValueError(f"AGENT_DIRECT_HTTP_ERROR: ?????? {error.code}: {body}") from error
    except (URLError, TimeoutError, HTTPException, OSError) as error:
        raise ValueError(f"AGENT_DIRECT_NETWORK_ERROR: ????????: {error}") from error
    return "".join(collected)


def _chat_completions_url(base_url: str) -> str:
    url = (base_url or DEFAULT_BASE_URL).strip().rstrip("/")
    if url.endswith("/chat/completions"):
        return url
    return f"{url}/chat/completions"


@dataclass
class _TurnState:
    events: list[dict[str, Any]] = field(default_factory=list)
    completed: threading.Event = field(default_factory=threading.Event)
    error: str | None = None


class DirectChatExecutor:
    """Conversational executor backed by an OpenAI-compatible chat API.

    Mirrors the AcpAgentExecutor interface used by the runtime service:
    ``run`` streams the first turn and parks the job in AWAITING_INPUT,
    ``continue_conversation`` streams subsequent turns asynchronously.
    """

    def __init__(
        self,
        *,
        config: DirectChatConfig,
        on_output: Callable[[dict[str, Any]], None] | None = None,
        on_started: Callable[[int], None] | None = None,
        streamer: ChatStreamer | None = None,
    ) -> None:
        self._config = config
        self._on_output = on_output
        self._on_started = on_started
        self._streamer = streamer or stream_chat_completion
        self._states: dict[str, _TurnState] = {}
        self._histories: dict[str, list[dict[str, Any]]] = {}
        self._lock = threading.RLock()

    def run(
        self,
        *,
        job_id: str,
        prompt: str,
        cwd: Any,
        project_root: Any,
        timeout_seconds: float,
        max_output_bytes: int,
        allowed_tools: list[str] | None = None,
        conversational: bool = False,
    ) -> CliExecutionResult:
        del cwd, project_root, timeout_seconds, max_output_bytes, allowed_tools
        if self._on_started is not None:
            self._on_started(0)
        return self._run_first_turn(job_id, prompt, keep_alive=conversational)

    def continue_conversation(self, job_id: str, message: str) -> str:
        with self._lock:
            state = self._states.get(job_id)
            history = self._histories.get(job_id)
        if state is None or history is None:
            raise ValueError("AGENT_CONVERSATION_LOST: direct conversation is not active")
        turn_id = f"direct-turn-{uuid4()}"
        state.events = []
        state.completed.clear()
        state.error = None
        self._emit({"kind": "chat.user", "payload": {"text": message}})
        self._spawn_turn(job_id, turn_id, message)
        return turn_id

    def wait_turn_completed(self, job_id: str, timeout: float) -> bool:
        with self._lock:
            state = self._states.get(job_id)
        if state is None:
            return False
        return bool(state.completed.wait(timeout=timeout))

    def is_conversation_alive(self, job_id: str) -> bool:
        with self._lock:
            return job_id in self._states

    def end_conversation(self, job_id: str) -> None:
        with self._lock:
            self._states.pop(job_id, None)
            self._histories.pop(job_id, None)

    def cancel(self, job_id: str) -> bool:
        self.end_conversation(job_id)
        return True

    # -- internals ----------------------------------------------------------

    def _run_first_turn(
        self, job_id: str, prompt: str, *, keep_alive: bool
    ) -> CliExecutionResult:
        history: list[dict[str, Any]] = [
            {"role": "system", "content": self._config.system_prompt or DEFAULT_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        message_id = f"direct-message-{uuid4()}"
        state = _TurnState()
        with self._lock:
            self._histories[job_id] = history
            self._states[job_id] = state
        self._emit({
            "kind": "acp.turn",
            "payload": {"text": "正在请求模型回复（" + self._config.model + "）…"},
        })
        try:
            text = self._stream_turn(job_id, message_id, history, state)
        except Exception as error:
            state.error = f"AGENT_DIRECT_ERROR: {error}"
            self._emit({"kind": "acp.error", "payload": {"text": state.error}})
            with self._lock:
                self._states.pop(job_id, None)
                self._histories.pop(job_id, None)
            return CliExecutionResult(status="FAILED", summary=None, error=state.error, exit_code=1)
        if not keep_alive:
            with self._lock:
                self._states.pop(job_id, None)
                self._histories.pop(job_id, None)
            return CliExecutionResult(status="COMPLETED", summary=text or None, error=None, exit_code=0)
        state.completed.set()
        return CliExecutionResult(status="AWAITING_INPUT", summary=text or None, error=None, exit_code=0)

    def _spawn_turn(self, job_id: str, turn_id: str, message: str) -> None:
        def worker() -> None:
            with self._lock:
                state = self._states.get(job_id)
                history = self._histories.get(job_id)
            if state is None or history is None:
                return
            history.append({"role": "user", "content": message})
            message_id = f"direct-message-{turn_id}"
            self._emit({
                "kind": "acp.turn",
                "payload": {"text": "正在请求模型回复（" + self._config.model + "）…"},
            })
            try:
                self._stream_turn(job_id, message_id, history, state)
            except Exception as error:
                state.error = f"AGENT_DIRECT_ERROR: {error}"
                self._emit({"kind": "acp.error", "payload": {"text": state.error}})
            finally:
                state.completed.set()

        threading.Thread(target=worker, name=f"direct-turn-{job_id}", daemon=True).start()

    def _stream_turn(
        self,
        job_id: str,
        message_id: str,
        history: list[dict[str, Any]],
        state: _TurnState,
    ) -> str:
        def on_delta(delta: str) -> None:
            with self._lock:
                state.events.append(
                    {"kind": "acp.message", "payload": {"text": delta, "messageId": message_id}}
                )
            self._emit({"kind": "acp.message", "payload": {"text": delta, "messageId": message_id}})

        text = self._streamer(self._config, history, on_delta)
        history.append({"role": "assistant", "content": text})
        return text

    def _emit(self, event: dict[str, Any]) -> None:
        if self._on_output is not None:
            try:
                self._on_output(event)
            except Exception:
                # ??????????????
                pass


def _default_direct_chat_executor(
    config: DirectChatConfig,
    on_output: Callable[[dict[str, Any]], None] | None,
    on_started: Callable[[int], None] | None,
) -> DirectChatExecutor:
    return DirectChatExecutor(config=config, on_output=on_output, on_started=on_started)
