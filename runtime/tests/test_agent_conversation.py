import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient

from workflow_platform.api.app import create_app
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.execution.providers import CliCommand, CodexCliProvider
from workflow_platform.runtime_service import WorkflowRuntimeService
from test_api import AGENT_ACTOR, HUMAN_ACTOR, NOW, FakeProvider, import_project_and_create_run


def _make_client(tmp_path) -> TestClient:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    return TestClient(
        create_app(WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: FakeProvider()))
    )


def _wait_status(client: TestClient, run: dict, job_id: str, targets: set[str]) -> dict:
    deadline = time.time() + 20
    detail = {}
    while time.time() < deadline:
        detail = client.get(f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}").json()
        if detail["status"] in targets:
            return detail
        time.sleep(0.02)
    return detail


def test_agent_conversation_chat_flow(tmp_path) -> None:
    client = _make_client(tmp_path)
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "第一轮",
            "transport": "acp",
            "conversational": True,
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert started.status_code == 200
    job_id = started.json()["id"]
    job_path = f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}"

    detail = _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})
    assert detail["status"] == "AWAITING_INPUT", detail
    assert detail.get("metadata", {}).get("conversational") is True

    # AWAITING_INPUT 不计入活动 Agent 并发：可再启动第二个任务
    second = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={"nodeId": "plan", "provider": "fake", "prompt": "并行", "actor": AGENT_ACTOR, "now": NOW},
    )
    assert second.status_code == 200

    # 续话
    continued = client.post(
        f"{job_path}/conversation/message",
        json={"message": "继续，按方案改", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert continued.status_code == 200, continued.text
    assert continued.json()["status"] == "RUNNING"
    assert continued.json()["turnId"]

    back = _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})
    assert back["status"] == "AWAITING_INPUT", back

    output = client.get(f"{job_path}/output").json()
    texts = [item["payload"].get("text") or "" for item in output if item["kind"] == "acp.message"]
    assert any("fake ack: 继续" in text for text in texts), texts

    # 再次续话（多轮）
    again = client.post(
        f"{job_path}/conversation/message",
        json={"message": "再来一轮", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert again.status_code == 200
    _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})

    # orphan 清理不误删 AWAITING_INPUT
    cleaned = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/recovery/cleanup-orphan-agents",
        json={"now": NOW},
    )
    assert cleaned.status_code == 200
    assert job_id not in cleaned.json()["cleanedJobIds"]

    # 取消结束聊天并终态化
    cancelled = client.post(
        f"{job_path}/cancel",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "CANCELLED"


def test_agent_conversation_requires_awaiting_input(tmp_path) -> None:
    client = _make_client(tmp_path)
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "单轮",
            "transport": "acp",
            "conversational": False,
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    job_id = started.json()["id"]
    job_path = f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}"
    _wait_status(client, run, job_id, {"COMPLETED", "FAILED", "CANCELLED"})
    resp = client.post(
        f"{job_path}/conversation/message",
        json={"message": "不应该能续话", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "AGENT_CONVERSATION_NOT_AWAITING_INPUT"

FAKE_CLI = Path(__file__).parent / "fixtures" / "fake_cli.py"


class ChatCliFakeProvider:
    id = "fake"

    def build_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        allowed_tools: list[str],
    ) -> CliCommand:
        return CliCommand(executable=sys.executable, args=[str(FAKE_CLI), "complete"], cwd=cwd)

    def build_conversation_command(
        self,
        *,
        cwd: Path,
        prompt: str,
        thread_id: str | None = None,
        allowed_tools: list[str] | None = None,
    ) -> CliCommand:
        if thread_id:
            args = [str(FAKE_CLI), "chat-resume", thread_id, prompt]
        else:
            args = [str(FAKE_CLI), "chat-start"]
        return CliCommand(executable=sys.executable, args=args, cwd=cwd)

    def parse_line(self, line: str) -> dict:
        return CodexCliProvider(platform="linux").parse_line(line)


def test_agent_conversation_cli_chat_flow(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _provider: ChatCliFakeProvider())
    client = TestClient(create_app(service))
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "第一轮",
            "transport": "cli",
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
    assert detail["metadata"]["transport"] == "cli"
    assert detail["metadata"]["codexThreadId"] == "thread-123"

    # 续话：聊天 + 命令执行（fake 只回文本，真实 Codex 会执行命令）
    continued = client.post(
        f"{job_path}/conversation/message",
        json={"message": "继续，执行命令", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert continued.status_code == 200, continued.text
    assert continued.json()["status"] == "RUNNING"
    back = _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})
    assert back["status"] == "AWAITING_INPUT", back

    output = client.get(f"{job_path}/output").json()
    texts = [item["payload"].get("text") or "" for item in output if item["kind"] == "acp.message"]
    assert any("fake chat resume" in text and "继续" in text for text in texts), texts

    # Runtime 重启后依据持久化 thread id 重建执行器，继续同一会话
    service._agent_executors.pop(job_id, None)
    again = client.post(
        f"{job_path}/conversation/message",
        json={"message": "重启后继续", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert again.status_code == 200, again.text
    _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})
    output_after = client.get(f"{job_path}/output").json()
    texts_after = [item["payload"].get("text") or "" for item in output_after if item["kind"] == "acp.message"]
    assert any("fake chat resume" in text and "重启后继续" in text for text in texts_after), texts_after

    cancelled = client.post(
        f"{job_path}/cancel",
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "CANCELLED"


def test_agent_conversation_cli_requires_chat_capable_provider(tmp_path) -> None:
    client = _make_client(tmp_path)
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "第一轮",
            "transport": "cli",
            "conversational": True,
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    # FakeProvider 不支持 build_conversation_command → 拒绝 cli 聊天
    assert started.status_code in {400, 422}
