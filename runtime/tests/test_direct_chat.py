"""Model-direct (OpenAI-compatible) chat provider tests (design doc Phase 4)."""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient

from workflow_platform.api.app import create_app
from workflow_platform.execution.cli import CliExecutionResult
from workflow_platform.execution.direct_chat import (
    DEFAULT_BASE_URL,
    DirectChatConfig,
    DirectChatExecutor,
    _chat_completions_url,
    stream_chat_completion,
)
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService
from test_api import AGENT_ACTOR, HUMAN_ACTOR, NOW, FakeProvider, import_project_and_create_run


class _SseHandler(BaseHTTPRequestHandler):
    chunks = ["你好", "，世界", "！"]
    error_code: int | None = None

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        if _SseHandler.error_code is not None:
            self.send_response(_SseHandler.error_code)
            self.end_headers()
            self.wfile.write(b'{"error": {"message": "boom"}}')
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for chunk in _SseHandler.chunks:
            payload = {"choices": [{"delta": {"content": chunk}}]}
            self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, *args) -> None:
        pass



def _serve_sse() -> tuple[ThreadingHTTPServer, threading.Thread]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _SseHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _wait_status(client: TestClient, run: dict, job_id: str, targets: set[str]) -> dict:
    deadline = time.time() + 20
    detail = {}
    while time.time() < deadline:
        detail = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}").json()
        if detail["status"] in targets:
            return detail
        time.sleep(0.02)
    return detail


def _make_service(tmp_path, direct_factory=None):
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    return WorkflowRuntimeService(
        db,
        agent_provider_factory=lambda _provider: FakeProvider(),
        direct_chat_factory=direct_factory,
    )


class FakeDirectExecutor:
    """Deterministic direct executor for API-level tests."""

    def __init__(self, config, on_output=None, on_started=None):
        self._config = config
        self._on_output = on_output
        self._on_started = on_started
        self._alive = False
        self._completed = threading.Event()

    def _emit(self, event: dict) -> None:
        if self._on_output is not None:
            self._on_output(event)

    def run(self, *, job_id: str, prompt: str, **kwargs) -> CliExecutionResult:
        del kwargs
        self._alive = True
        if self._on_started is not None:
            self._on_started(0)
        self._emit({"kind": "acp.message", "payload": {"text": f"direct ack: {prompt[:40]}", "messageId": "m1"}})
        return CliExecutionResult(status="AWAITING_INPUT", summary="direct ack", error=None, exit_code=0)

    def continue_conversation(self, job_id: str, message: str) -> str:
        self._emit({"kind": "chat.user", "payload": {"text": message}})
        self._emit({"kind": "acp.message", "payload": {"text": f"direct ack: {message[:40]}", "messageId": "m2"}})
        self._completed.set()
        return "turn-2"

    def wait_turn_completed(self, job_id: str, timeout: float) -> bool:
        return self._completed.wait(timeout=timeout)

    def is_conversation_alive(self, job_id: str) -> bool:
        return self._alive

    def end_conversation(self, job_id: str) -> None:
        self._alive = False

    def cancel(self, job_id: str) -> bool:
        self._alive = False
        return True


def test_chat_completions_url_normalization() -> None:
    assert _chat_completions_url("https://api.openai.com/v1") == "https://api.openai.com/v1/chat/completions"
    assert _chat_completions_url("https://api.deepseek.com/v1/") == "https://api.deepseek.com/v1/chat/completions"
    assert _chat_completions_url("https://example.com/chat/completions") == "https://example.com/chat/completions"


def test_stream_chat_completion_parses_sse() -> None:
    server, thread = _serve_sse()
    try:
        port = server.server_address[1]
        config = DirectChatConfig(
            vendor="test",
            base_url=f"http://127.0.0.1:{port}/v1",
            api_key="test-key",
            model="test-model",
        )
        deltas: list[str] = []
        text = stream_chat_completion(config, [{"role": "user", "content": "hi"}], on_delta=deltas.append)
        assert text == "你好，世界！"
        assert deltas == ["你好", "，世界", "！"]
    finally:
        server.shutdown()


def test_stream_chat_completion_http_error_raises_value_error() -> None:
    _SseHandler.error_code = 401
    server, thread = _serve_sse()
    try:
        port = server.server_address[1]
        config = DirectChatConfig(
            vendor="test",
            base_url=f"http://127.0.0.1:{port}/v1",
            api_key="test-key",
            model="test-model",
        )
        try:
            stream_chat_completion(config, [{"role": "user", "content": "hi"}], on_delta=lambda _d: None)
            raise AssertionError("expected ValueError")
        except ValueError as error:
            assert "AGENT_DIRECT_HTTP_ERROR" in str(error)
    finally:
        server.shutdown()
        _SseHandler.error_code = None


def test_direct_executor_conversation_flow_with_fake_streamer() -> None:
    def fake_streamer(config, messages, on_delta):
        assert messages[0]["role"] == "system"
        assert messages[-1]["role"] == "user"
        for part in ("流式", "回复"):
            on_delta(part)
        return "流式回复"

    events: list[dict] = []
    started: list[int] = []
    executor = DirectChatExecutor(
        config=DirectChatConfig(api_key="k", base_url="http://x", model="m"),
        on_output=events.append,
        on_started=started.append,
        streamer=fake_streamer,
    )
    result = executor.run(
        job_id="job-1",
        prompt="首轮",
        cwd=None,
        project_root=None,
        timeout_seconds=30,
        max_output_bytes=1000,
        conversational=True,
    )
    assert result.status == "AWAITING_INPUT"
    assert started == [0]
    message_events = [e for e in events if e["kind"] == "acp.message"]
    assert len(message_events) == 2
    assert message_events[0]["payload"]["text"] == "流式"
    assert message_events[0]["payload"]["messageId"] == message_events[1]["payload"]["messageId"]

    assert executor.is_conversation_alive("job-1")
    turn_id = executor.continue_conversation("job-1", "继续")
    assert turn_id.startswith("direct-turn-")
    assert executor.wait_turn_completed("job-1", timeout=5)
    texts = [e["payload"]["text"] for e in events if e["kind"] == "acp.message"]
    assert "流式" in texts
    executor.end_conversation("job-1")
    assert not executor.is_conversation_alive("job-1")


def test_runtime_api_model_provider_settings_roundtrip(tmp_path) -> None:
    client = TestClient(create_app(_make_service(tmp_path)))
    empty = client.get("/settings/model-provider")
    assert empty.status_code == 200
    assert empty.json()["hasApiKey"] is False
    assert empty.json()["available"] is False

    saved = client.put(
        "/settings/model-provider",
        json={
            "vendor": "deepseek",
            "baseUrl": "https://api.deepseek.com/v1",
            "apiKey": "sk-test-123",
            "model": "deepseek-chat",
            "temperature": 0.3,
            "systemPrompt": "你是测试助手",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    assert saved.status_code == 200
    body = saved.json()
    assert body["vendor"] == "deepseek"
    assert body["model"] == "deepseek-chat"
    assert body["hasApiKey"] is True
    assert body["apiKey"] == "********"
    assert body["available"] is True

    fetched = client.get("/settings/model-provider")
    assert fetched.json()["hasApiKey"] is True
    assert fetched.json()["apiKey"] == "********"

    # blank apiKey keeps existing key
    updated = client.put(
        "/settings/model-provider",
        json={
            "vendor": "deepseek",
            "baseUrl": "https://api.deepseek.com/v1",
            "apiKey": "",
            "model": "deepseek-reasoner",
            "temperature": None,
            "systemPrompt": None,
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    assert updated.status_code == 200
    assert updated.json()["model"] == "deepseek-reasoner"
    assert updated.json()["hasApiKey"] is True

    invalid = client.put(
        "/settings/model-provider",
        json={
            "baseUrl": "not-a-url",
            "model": "m",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    assert invalid.status_code == 422
    assert invalid.json()["code"] == "AGENT_DIRECT_BASE_URL_INVALID"


def test_runtime_api_direct_provider_diagnostic(tmp_path) -> None:
    second = tmp_path / "second"
    service = _make_service(second)
    service.save_model_provider_config(
        vendor="openai",
        base_url="https://api.openai.com/v1",
        api_key="sk-test",
        model="gpt-test",
        temperature=None,
        system_prompt=None,
        actor=HUMAN_ACTOR,
        now=NOW,
    )
    client = TestClient(create_app(service))
    diagnostics = client.get("/agents/providers").json()
    direct = next(item for item in diagnostics if item["id"] == "direct")
    assert direct["available"] is True
    assert "gpt-test" in direct["message"]


def test_runtime_api_direct_chat_flow(tmp_path) -> None:
    service = _make_service(tmp_path, direct_factory=lambda config, on_output, on_started: FakeDirectExecutor(config, on_output, on_started))
    service.save_model_provider_config(
        vendor="openai",
        base_url="https://api.openai.com/v1",
        api_key="sk-test",
        model="gpt-test",
        temperature=None,
        system_prompt=None,
        actor=HUMAN_ACTOR,
        now=NOW,
    )
    client = TestClient(create_app(service))
    _project_path, run = import_project_and_create_run(client, tmp_path)

    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "direct",
            "prompt": "你好",
            "transport": "direct",
            "conversational": True,
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert started.status_code == 200, started.text
    job_id = started.json()["id"]
    job_path = f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}"
    detail = _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})
    assert detail["status"] == "AWAITING_INPUT", detail
    assert detail.get("metadata", {}).get("transport") == "direct"
    assert detail.get("metadata", {}).get("conversational") is True

    output = client.get(f"{job_path}/output").json()
    assert any(item["kind"] == "acp.message" for item in output)

    continued = client.post(
        f"{job_path}/conversation/message",
        json={"message": "继续", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert continued.status_code == 200
    assert continued.json()["status"] == "RUNNING"
    _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})
    output2 = client.get(f"{job_path}/output").json()
    texts = [item["payload"].get("text") or "" for item in output2 if item["kind"] == "acp.message"]
    assert any("direct ack: 继续" in text for text in texts), texts
    user_events = [item for item in output2 if item["kind"] == "chat.user"]
    assert any(item["payload"].get("text") == "继续" for item in user_events), user_events

    cancelled = client.post(f"{job_path}/cancel", json={"actor": HUMAN_ACTOR, "now": NOW})
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "CANCELLED"


def test_runtime_api_direct_requires_config_and_conversational(tmp_path) -> None:
    first = tmp_path / "first"
    client = TestClient(create_app(_make_service(first)))
    _project_path, run = import_project_and_create_run(client, first)

    # not configured
    missing_config = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "direct",
            "prompt": "x",
            "conversational": True,
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert missing_config.status_code == 422
    assert missing_config.json()["code"] == "AGENT_DIRECT_NOT_CONFIGURED"

    service = _make_service(tmp_path / "second")
    service.save_model_provider_config(
        vendor="openai",
        base_url="https://api.openai.com/v1",
        api_key="sk-test",
        model="gpt-test",
        temperature=None,
        system_prompt=None,
        actor=HUMAN_ACTOR,
        now=NOW,
    )
    client2 = TestClient(create_app(service))
    _project_path2, run2 = import_project_and_create_run(client2, tmp_path / "second")

    # conversational required
    non_conversational = client2.post(
        f"/projects/{run2['projectId']}/runs/{run2['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "direct",
            "prompt": "x",
            "transport": "direct",
            "conversational": False,
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert non_conversational.status_code == 422
    assert non_conversational.json()["code"] == "AGENT_DIRECT_REQUIRES_CONVERSATIONAL"
def test_runtime_api_model_providers_crud(tmp_path) -> None:
    service = _make_service(tmp_path)
    client = TestClient(create_app(service))

    empty = client.get("/settings/model-providers").json()
    assert empty["providers"] == []
    assert empty["activeProviderId"] is None

    created = client.post(
        "/settings/model-providers",
        json={
            "name": "DeepSeek",
            "vendor": "deepseek",
            "baseUrl": "https://api.deepseek.com/v1",
            "apiKey": "sk-1",
            "model": "deepseek-chat",
            "temperature": 0.3,
            "maxTokens": 4096,
            "topP": 0.9,
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    assert created.status_code == 200, created.text
    first = created.json()
    assert first["isDefault"] is True
    assert first["hasApiKey"] is True
    assert first["apiKey"] == "********"
    assert first["maxTokens"] == 4096
    assert first["topP"] == 0.9

    second = client.post(
        "/settings/model-providers",
        json={
            "name": "OpenAI",
            "vendor": "openai",
            "baseUrl": "https://api.openai.com/v1",
            "apiKey": "sk-2",
            "model": "gpt-4o-mini",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    ).json()
    assert second["isDefault"] is False

    listing = client.get("/settings/model-providers").json()
    assert len(listing["providers"]) == 2
    assert listing["activeProviderId"] == first["id"]

    updated = client.put(
        f"/settings/model-providers/{second['id']}",
        json={
            "name": "OpenAI Main",
            "baseUrl": "https://api.openai.com/v1",
            "apiKey": "",
            "model": "gpt-4o",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "OpenAI Main"
    assert updated.json()["model"] == "gpt-4o"
    assert updated.json()["hasApiKey"] is True  # blank key keeps existing

    defaulted = client.post(
        f"/settings/model-providers/{second['id']}/default",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )
    assert defaulted.status_code == 200
    listing2 = client.get("/settings/model-providers").json()
    assert listing2["activeProviderId"] == second["id"]

    deleted = client.request(
        "DELETE",
        f"/settings/model-providers/{second['id']}",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )
    assert deleted.status_code == 200, deleted.text
    listing3 = client.get("/settings/model-providers").json()
    assert [p["id"] for p in listing3["providers"]] == [first["id"]]
    assert listing3["activeProviderId"] == first["id"]  # promoted after default deleted

    missing = client.put(
        "/settings/model-providers/does-not-exist",
        json={"model": "x", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert missing.status_code == 404
    assert missing.json()["code"] == "MODEL_PROVIDER_NOT_FOUND"


def test_runtime_api_model_provider_test_by_id(tmp_path) -> None:
    server, thread = _serve_sse()
    try:
        service = _make_service(tmp_path)
        client = TestClient(create_app(service))
        port = server.server_address[1]
        provider = client.post(
            "/settings/model-providers",
            json={
                "name": "Local",
                "vendor": "custom",
                "baseUrl": f"http://127.0.0.1:{port}/v1",
                "apiKey": "k",
                "model": "m",
                "actor": HUMAN_ACTOR,
                "now": NOW,
            },
        ).json()
        result = client.post(
            f"/settings/model-providers/{provider['id']}/test",
            json={"actor": HUMAN_ACTOR, "now": NOW},
        )
        assert result.status_code == 200
        assert result.json()["ok"] is True
    finally:
        server.shutdown()


def test_runtime_api_direct_chat_with_selected_provider(tmp_path) -> None:
    service = _make_service(
        tmp_path,
        direct_factory=lambda config, on_output, on_started: FakeDirectExecutor(config, on_output, on_started),
    )
    client = TestClient(create_app(service))
    provider = client.post(
        "/settings/model-providers",
        json={
            "name": "OpenAI",
            "vendor": "openai",
            "baseUrl": "https://api.openai.com/v1",
            "apiKey": "sk-test",
            "model": "gpt-test",
            "actor": HUMAN_ACTOR,
            "now": NOW,
        },
    ).json()
    _project_path, run = import_project_and_create_run(client, tmp_path)

    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "direct",
            "prompt": "你好",
            "transport": "direct",
            "conversational": True,
            "modelProviderId": provider["id"],
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert started.status_code == 200, started.text
    assert started.json()["metadata"]["modelProviderId"] == provider["id"]
    job_id = started.json()["id"]
    detail = _wait_status(
        client,
        run,
        job_id,
        {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"},
    )
    assert detail["status"] == "AWAITING_INPUT", detail

    # unknown provider id -> 404
    bad = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "direct",
            "prompt": "x",
            "transport": "direct",
            "conversational": True,
            "modelProviderId": "does-not-exist",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert bad.status_code == 404
    assert bad.json()["code"] == "MODEL_PROVIDER_NOT_FOUND"
