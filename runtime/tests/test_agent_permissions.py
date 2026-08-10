import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from fastapi.testclient import TestClient

from workflow_platform.api.app import create_app
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
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


def test_agent_permission_approval_loop(tmp_path) -> None:
    client = _make_client(tmp_path)
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "PERM: SLOW 写入结果",
            "transport": "acp",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    assert started.status_code == 200
    job_id = started.json()["id"]
    job_path = f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}"

    # 等待权限请求落库
    permission = None
    deadline = time.time() + 20
    while time.time() < deadline:
        items = client.get(f"{job_path}/permissions?status=PENDING").json()
        if items:
            permission = items[0]
            break
        time.sleep(0.02)
    assert permission is not None, "权限请求未落库"
    assert permission["permissionType"] == "write_file"
    assert permission["status"] == "PENDING"

    request_id = permission["id"]
    decide_path = f"{job_path}/permissions/{request_id}/decide"
    allowed = client.post(
        decide_path,
        json={"decision": "allow", "reason": "测试允许", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert allowed.status_code == 200
    assert allowed.json()["status"] == "ALLOWED"

    # 重复决定 409
    duplicate = client.post(
        decide_path,
        json={"decision": "deny", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "AGENT_PERMISSION_ALREADY_DECIDED"

    # 审计链
    records = client.get("/audit-records?action=agent.permission.allowed").json()
    assert records
    assert records[0]["action"] == "agent.permission.allowed"

    # 输出事件 acp.permission.decided
    output = client.get(f"{job_path}/output").json()
    kinds = [item["kind"] for item in output]
    assert "acp.permission" in kinds

    # job 完成
    detail = _wait_status(client, run, job_id, {"COMPLETED", "FAILED", "CANCELLED"})
    assert detail["status"] == "COMPLETED", detail


def test_agent_permission_expired_after_job_end(tmp_path) -> None:
    client = _make_client(tmp_path)
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "PERM: 未审批",
            "transport": "acp",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    job_id = started.json()["id"]
    job_path = f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}"
    detail = _wait_status(client, run, job_id, {"COMPLETED", "FAILED", "CANCELLED"})
    assert detail["status"] == "COMPLETED", detail
    items = client.get(f"{job_path}/permissions?status=EXPIRED").json()
    assert items, "job 结束后 PENDING 权限应全部 EXPIRED"
    expired = client.post(
        f"{job_path}/permissions/{items[0]['id']}/decide",
        json={"decision": "allow", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert expired.status_code == 409
    assert expired.json()["code"] == "AGENT_PERMISSION_EXPIRED"


def test_agent_permission_not_found_and_deny(tmp_path) -> None:
    client = _make_client(tmp_path)
    _project_path, run = import_project_and_create_run(client, tmp_path)
    started = client.post(
        f"/projects/{run['projectId']}/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "PERM: SLOW 拒绝",
            "transport": "acp",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    job_id = started.json()["id"]
    job_path = f"/projects/{run['projectId']}/runs/{run['runId']}/agents/{job_id}"
    missing = client.post(
        f"{job_path}/permissions/perm-missing/decide",
        json={"decision": "deny", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert missing.status_code == 404
    assert missing.json()["code"] == "AGENT_PERMISSION_NOT_FOUND_IN_RUN"

    items: list[dict] = []
    deadline = time.time() + 20
    while time.time() < deadline:
        items = client.get(f"{job_path}/permissions?status=PENDING").json()
        if items:
            break
        time.sleep(0.02)
    assert items
    denied = client.post(
        f"{job_path}/permissions/{items[0]['id']}/decide",
        json={"decision": "deny", "reason": "不同意", "actor": HUMAN_ACTOR, "now": NOW},
    )
    assert denied.status_code == 200
    assert denied.json()["status"] == "DENIED"
    records = client.get("/audit-records?action=agent.permission.denied").json()
    assert records
    assert records[0]["action"] == "agent.permission.denied"
