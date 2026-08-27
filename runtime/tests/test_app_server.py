import sys
import time
from pathlib import Path
from threading import Event, Thread

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient

from workflow_platform.api.app import create_app
from workflow_platform.execution.app_server import AppServerAgentExecutor, map_app_server_permission
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService
from test_api import AGENT_ACTOR, HUMAN_ACTOR, NOW, FakeProvider, import_project_and_create_run


FAKE_APP_SERVER = Path(__file__).parent / "fixtures" / "fake_app_server.py"


def _make_app_server_executor(on_output, on_started, on_permission):
    return AppServerAgentExecutor(
        executable=sys.executable,
        base_args=[str(FAKE_APP_SERVER)],
        on_output=on_output,
        on_started=on_started,
        on_permission=on_permission,
    )


def _make_client(tmp_path) -> TestClient:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    return TestClient(
        create_app(
            WorkflowRuntimeService(
                db,
                agent_provider_factory=lambda _provider: FakeProvider(),
                app_server_factory=_make_app_server_executor,
            )
        )
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


def test_map_app_server_permission_fields() -> None:
    mapped = map_app_server_permission(
        "item/commandExecution/requestApproval",
        {"itemId": "i1", "command": "rg --files", "cwd": "G:/ws", "reason": "scan"},
    )
    assert mapped["permissionType"] == "run_command"
    assert mapped["target"] == "rg --files"
    assert mapped["details"]["cwd"] == "G:/ws"

    mapped_file = map_app_server_permission(
        "item/fileChange/requestApproval",
        {"fileChanges": [{"path": "src/a.ts"}], "reason": "edit"},
    )
    assert mapped_file["permissionType"] == "write_file"
    assert mapped_file["target"] == "src/a.ts"

    mapped_perm = map_app_server_permission(
        "item/permissions/requestApproval",
        {"requested": ["network"], "reason": "net"},
    )
    assert mapped_perm["permissionType"] == "network"


def test_app_server_executor_chat_with_approval(tmp_path: Path) -> None:
    events: list[dict] = []
    permissions: list[tuple[str, dict]] = []
    permission_seen = Event()

    def on_permission(request_id: str, mapped: dict) -> None:
        permissions.append((request_id, mapped))
        permission_seen.set()

    executor = AppServerAgentExecutor(
        executable=sys.executable,
        base_args=[str(FAKE_APP_SERVER)],
        on_output=events.append,
        on_permission=on_permission,
    )
    holder: dict = {}
    thread = Thread(
        target=lambda: holder.update(
            result=executor.run(
                job_id="agent-job-app",
                prompt="??? PERM: ?????????",
                cwd=tmp_path,
                project_root=tmp_path,
                timeout_seconds=20,
                max_output_bytes=4096,
                conversational=True,
            )
        )
    )
    thread.start()
    assert permission_seen.wait(timeout=10), "approval request was not surfaced"
    request_id, mapped = permissions[0]
    assert mapped["permissionType"] == "run_command"
    assert mapped["target"].startswith("powershell")

    executor.respond_permission(request_id, allow=True)
    thread.join(timeout=20)
    result = holder.get("result")
    assert result is not None
    assert result.status == "AWAITING_INPUT", result
    assert executor.thread_id_for("agent-job-app")

    tool_events = [event for event in events if event["kind"] == "tool"]
    assert len(tool_events) >= 2
    assert tool_events[0]["payload"]["status"] == "running"
    assert tool_events[-1]["payload"]["status"] == "completed"
    assert tool_events[-1]["payload"]["text"] == "fake-output"

    assert any(
        event["kind"] == "acp.message" and "fake app-server reply" in event["payload"].get("text", "")
        for event in events
    )

    # ????? PERM: ???????
    continued = executor.continue_conversation("agent-job-app", "????")
    assert continued.startswith("app-server-turn-")
    assert executor.wait_turn_completed("agent-job-app", timeout=10) is True
    assert executor.is_conversation_alive("agent-job-app") is True
    assert any(
        event["kind"] == "acp.message" and "????" in event["payload"].get("text", "")
        for event in events
    )

    executor.end_conversation("agent-job-app")
    assert executor.is_conversation_alive("agent-job-app") is False


def test_app_server_executor_rejects_permission(tmp_path: Path) -> None:
    events: list[dict] = []
    permission_seen = Event()
    permissions: list[tuple[str, dict]] = []

    def on_permission(request_id: str, mapped: dict) -> None:
        permissions.append((request_id, mapped))
        permission_seen.set()

    executor = AppServerAgentExecutor(
        executable=sys.executable,
        base_args=[str(FAKE_APP_SERVER)],
        on_output=events.append,
        on_permission=on_permission,
    )
    holder: dict = {}
    thread = Thread(
        target=lambda: holder.update(
            result=executor.run(
                job_id="agent-job-deny",
                prompt="PERM: ??????",
                cwd=tmp_path,
                project_root=tmp_path,
                timeout_seconds=20,
                max_output_bytes=4096,
                conversational=True,
            )
        )
    )
    thread.start()
    assert permission_seen.wait(timeout=10)
    executor.respond_permission(permissions[0][0], allow=False, reason="???")
    thread.join(timeout=20)
    result = holder.get("result")
    assert result is not None and result.status == "AWAITING_INPUT", result
    tool_events = [event for event in events if event["kind"] == "tool"]
    assert tool_events[-1]["payload"]["status"] == "failed"


def test_agent_conversation_app_server_chat_flow(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(
        db,
        agent_provider_factory=lambda _provider: FakeProvider(),
        app_server_factory=_make_app_server_executor,
    )
    client = TestClient(create_app(service))
    _project_path, run = import_project_and_create_run(client, tmp_path)

    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "codex",
            "prompt": "??? PERM: ????",
            "transport": "app-server",
            "conversational": True,
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert started.status_code == 200, started.text
    job_id = started.json()["id"]
    job_path = f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}"

    # ?????????????????????????
    permissions = []
    deadline = time.time() + 15
    while time.time() < deadline:
        permissions = client.get(f"{job_path}/permissions?status=PENDING").json()
        if permissions:
            break
        time.sleep(0.05)
    assert len(permissions) == 1, permissions
    request_id = permissions[0]["id"]
    assert permissions[0]["permissionType"] == "run_command"

    # ????????? AWAITING_INPUT
    decided = client.post(
        f"{job_path}/permissions/{request_id}/decide",
        json={"decision": "allow", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert decided.status_code == 200, decided.text
    detail = _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})
    assert detail["status"] == "AWAITING_INPUT", detail
    assert detail["metadata"]["transport"] == "app-server"
    assert isinstance(detail["metadata"].get("codexThreadId"), str)
    assert detail["metadata"]["codexThreadId"]

    output = client.get(f"{job_path}/output").json()
    kinds = [item["kind"] for item in output]
    assert "tool" in kinds, kinds
    assert any(item["kind"] == "acp.message" for item in output), kinds
    assert any(
        item["kind"] == "acp.permission" and item["payload"].get("status") == "ALLOWED"
        for item in output
    ), output

    # ??
    continued = client.post(
        f"{job_path}/conversation/message",
        json={"message": "????", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert continued.status_code == 200, continued.text
    assert continued.json()["status"] == "RUNNING"
    back = _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})
    assert back["status"] == "AWAITING_INPUT", back

    # Runtime ???????? thread id ????????????
    service._agent_executors.pop(job_id, None)
    again = client.post(
        f"{job_path}/conversation/message",
        json={"message": "?????", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert again.status_code == 200, again.text
    _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})
    output_after = client.get(f"{job_path}/output").json()
    texts_after = [
        item["payload"].get("text") or ""
        for item in output_after
        if item["kind"] == "acp.message"
    ]
    assert any("?????" in text for text in texts_after), texts_after

    # ??????
    cancelled = client.post(f"{job_path}/cancel", json={"actor": HUMAN_ACTOR, "now": NOW})
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "CANCELLED"


def test_agent_conversation_app_server_requires_codex_provider(tmp_path) -> None:
    client = _make_client(tmp_path)
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "claude",
            "prompt": "x",
            "transport": "app-server",
            "conversational": True,
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert started.status_code == 422
    assert started.json()["code"] == "AGENT_APP_SERVER_UNAVAILABLE"

def test_agent_conversation_app_server_cancel_after_executor_loss(tmp_path) -> None:
    # Runtime 重启后执行器丢失，AWAITING_INPUT 仍应可以终止
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(
        db,
        agent_provider_factory=lambda _provider: FakeProvider(),
        app_server_factory=_make_app_server_executor,
    )
    client = TestClient(create_app(service))
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "codex",
            "prompt": "第一轮",
            "transport": "app-server",
            "conversational": True,
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert started.status_code == 200, started.text
    job_id = started.json()["id"]
    job_path = f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}"
    _wait_status(client, run, job_id, {"AWAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"})
    service._agent_executors.pop(job_id, None)
    cancelled = client.post(f"{job_path}/cancel", json={"actor": HUMAN_ACTOR, "now": NOW})
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "CANCELLED"


def test_agent_job_delete_removes_all_records(tmp_path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(
        db,
        agent_provider_factory=lambda _provider: FakeProvider(),
        app_server_factory=_make_app_server_executor,
    )
    client = TestClient(create_app(service))
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "codex",
            "prompt": "单轮",
            "transport": "app-server",
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

    deleted = client.request(
        "DELETE",
        job_path,
        json={"actor": HUMAN_ACTOR, "now": NOW},
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"jobId": job_id, "deleted": True}
    assert client.get(job_path).status_code == 404
    assert client.get(f"{job_path}/output").status_code == 404
    assert service._agent_jobs.list_output(job_id) == []
    assert service._agent_sessions.get_for_job(job_id) is None
    assert service._agent_executors.get(job_id) is None
