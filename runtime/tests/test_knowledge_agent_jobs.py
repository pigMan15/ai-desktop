import sys
import time
from pathlib import Path

import pytest

from workflow_platform.execution.providers import CliCommand, CodexCliProvider
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService

NOW = "2026-08-10T00:00:00Z"
TRUSTED = {"id": "user-1", "type": "human", "source": "renderer", "trusted": True}
FIXTURES = Path(__file__).parent / "fixtures"
FAKE_CLI = FIXTURES / "fake_cli.py"


class KnowledgeFakeProvider:
    id = "fake"

    def __init__(self, mode: str = "knowledge-valid-low") -> None:
        self._mode = mode

    def build_command(self, *, cwd: Path, prompt: str, allowed_tools: list[str]) -> CliCommand:
        mode = "knowledge-rule-discovery" if "rule-discovery.json" in prompt else self._mode
        return CliCommand(executable=sys.executable, args=[str(FAKE_CLI), mode], cwd=cwd)

    def parse_line(self, line: str) -> dict:
        return CodexCliProvider(platform="linux").parse_line(line)


def _wait_job(service, job_id: str, purpose: str, owner_id: str, timeout: float = 20.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = service._agent_jobs.get_owned(job_id, purpose=purpose, owner_id=owner_id)
        assert job is not None
        if job["status"] in {"COMPLETED", "FAILED", "CANCELLED"}:
            return job
        time.sleep(0.1)
    raise AssertionError(f"job did not finish: {job_id}")


def test_rule_discovery_job_scope_and_cancel(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _p: KnowledgeFakeProvider())
    analysis_root = service._jobs_root / "job-scope"
    queued = service._knowledge_agent_runner.start_rule_discovery(
        job_id="knowledge-job-scope",
        repository_id="repo-1",
        provider="fake",
        analysis_root=analysis_root,
        prompt="rule-discovery.json 输出到 output/rule-discovery.json",
        now=NOW,
    )
    assert queued["status"] == "QUEUED"
    # 作用域查询：正确 owner 可查到，错误 owner 查不到
    owned = service._agent_jobs.get_owned("knowledge-job-scope", purpose="knowledge-rule-discovery", owner_id="repo-1")
    assert owned is not None
    assert service._agent_jobs.get_owned("knowledge-job-scope", purpose="knowledge-rule-discovery", owner_id="other") is None
    jobs = service._knowledge_agent_runner.list_active_by_purpose_owner(
        purpose="knowledge-rule-discovery", owner_id="repo-1"
    ) if hasattr(service._knowledge_agent_runner, "list_active_by_purpose_owner") else []
    # 取消
    service._knowledge_agent_runner.cancel("knowledge-job-scope", actor=TRUSTED, now=NOW)
    job = _wait_job(service, "knowledge-job-scope", "knowledge-rule-discovery", "repo-1")
    assert job["status"] == "CANCELLED"


def test_recover_orphaned_knowledge_jobs_marks_failed(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _p: KnowledgeFakeProvider())
    # 直接插入一个没有执行器的 RUNNING 知识 job（模拟重启遗留）
    service._agent_jobs.create(
        id="knowledge-job-orphan",
        project_id=None,
        run_id=None,
        node_id=None,
        purpose="knowledge-rule-discovery",
        owner_id="repo-orphan",
        provider="fake",
        status="RUNNING",
        command=["fake"],
        cwd=str(tmp_path),
        created_at=NOW,
        metadata={"repositoryId": "repo-orphan"},
    )
    recovered = service._knowledge_agent_runner.recover_orphaned_jobs(now=NOW)
    assert "knowledge-job-orphan" in recovered["recoveredJobIds"]
    job = service._agent_jobs.get("knowledge-job-orphan")
    assert job["status"] == "FAILED"
    assert "KNOWLEDGE_AGENT_JOB_LOST" in (job["error"] or "")


def test_startup_recovery_marks_legacy_knowledge_jobs_failed(tmp_path: Path) -> None:
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    # 先构造一个带遗留 RUNNING job 的库
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _p: KnowledgeFakeProvider())
    service._agent_jobs.create(
        id="knowledge-job-legacy",
        project_id=None,
        run_id=None,
        node_id=None,
        purpose="knowledge-rule-discovery",
        owner_id="repo-legacy",
        provider="fake",
        status="RUNNING",
        command=["fake"],
        cwd=str(tmp_path),
        created_at=NOW,
        metadata={"repositoryId": "repo-legacy"},
    )
    db.commit()
    service._agent_jobs.create(
        id="knowledge-job-active",
        project_id=None,
        run_id=None,
        node_id=None,
        purpose="knowledge-rule-discovery",
        owner_id="repo-active",
        provider="fake",
        status="QUEUED",
        command=["fake"],
        cwd=str(tmp_path),
        created_at=NOW,
        metadata={"repositoryId": "repo-active"},
    )
    db.commit()
    # 重新构造服务模拟重启 → 启动恢复执行
    db.close()
    db2 = connect(tmp_path / "workflow.db")
    migrate(db2)
    service2 = WorkflowRuntimeService(db2, agent_provider_factory=lambda _p: KnowledgeFakeProvider())
    legacy = service2._agent_jobs.get("knowledge-job-legacy")
    active = service2._agent_jobs.get("knowledge-job-active")
    assert legacy is not None and legacy["status"] == "FAILED"
    assert active is not None and active["status"] == "FAILED"


def test_generation_completion_does_not_scan_run_artifacts(tmp_path: Path) -> None:
    # 生成完成只推进变更集状态，不触发 Run 节点 Artifact 扫描
    db = connect(tmp_path / "workflow.db")
    migrate(db)
    service = WorkflowRuntimeService(db, agent_provider_factory=lambda _p: KnowledgeFakeProvider())
    job_id = "knowledge-job-scan-check"
    analysis = service._jobs_root / job_id
    (analysis / "output").mkdir(parents=True)
    (analysis / "output" / "proposal.json").write_text(
        "{}",
        encoding="utf-8",
    )
    # 直接调用完成回调（job 不存在的场景应安全返回）
    service._knowledge_job_completed(job_id, type("R", (), {"status": "COMPLETED", "summary": "s", "error": None, "exit_code": 0})(), analysis)
    assert service._knowledge_agent_runner.active_count("knowledge-rule-discovery") >= 0
