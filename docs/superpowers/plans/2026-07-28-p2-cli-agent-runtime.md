# P2 CLI Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Run/Node 提供受控的 Codex 和 Claude Code 非交互式 CLI 执行、输出事件、取消、持久化与 Runtime API。

**Architecture:** Python Runtime 增加 `AgentJob`/`AgentOutputEvent` 持久化记录和 provider-neutral `CliAgentExecutor`。Runtime service 验证 Run/Node/项目根目录后启动 provider，provider 以参数数组调用 CLI 并把 JSONL/stream-json 转成持久化日志；Agent 只记录执行证据，不调用 approval 或 gate transition。

**Tech Stack:** Python 3.13、Pydantic、SQLite、FastAPI、pytest、受控 `subprocess.Popen`、pytest fake CLI fixture。

---

## 文件结构

- `runtime/src/workflow_platform/models.py`：增加 Agent job、输出事件和 provider 数据模型。
- `runtime/src/workflow_platform/persistence/migrations.py`：创建 agent job/输出/checkpoint 表。
- `runtime/src/workflow_platform/persistence/repositories.py`：增加 `AgentJobRepository`。
- `runtime/src/workflow_platform/execution/cli.py`：provider-neutral 子进程执行、取消和 JSON line 解析。
- `runtime/src/workflow_platform/execution/providers.py`：Codex/Claude Code 参数构造与事件归一化。
- `runtime/src/workflow_platform/runtime_service.py`：启动、查询、取消 Run-bound agent job。
- `runtime/src/workflow_platform/api/app.py`：暴露 agent job API。
- `runtime/tests/test_execution_cli.py`：执行器、命令策略和输出解析测试。
- `runtime/tests/test_runtime_service.py`：job 持久化和 Run/Node 绑定测试。
- `runtime/tests/test_api.py`：agent API、错误映射和日志 cursor 测试。
- `runtime/tests/fixtures/fake_cli.py`：输出可预测 JSONL 的 fake provider。

### Task 1: Agent Job 数据模型与 SQLite 持久化

**Files:**
- Modify: `runtime/src/workflow_platform/models.py`
- Modify: `runtime/src/workflow_platform/persistence/migrations.py`
- Modify: `runtime/src/workflow_platform/persistence/repositories.py`
- Modify: `runtime/tests/test_persistence.py`

- [ ] **Step 1: 写失败的 migration/repository 测试**

```python
def test_agent_job_repository_round_trips_job_and_output(db) -> None:
    migrate(db)
    repository = AgentJobRepository(db)
    repository.create(
        id="agent-job-1",
        run_id="run-1",
        node_id="implement",
        provider="codex",
        status="RUNNING",
        command=["codex.cmd", "exec", "--json"],
        cwd="C:/project",
        created_at=NOW,
    )
    repository.append_output(
        id="agent-output-1",
        job_id="agent-job-1",
        sequence=1,
        kind="message",
        payload={"text": "planning"},
        created_at=NOW,
    )
    assert repository.get("agent-job-1")["provider"] == "codex"
    assert repository.list_output("agent-job-1", after_sequence=0) == [{
        "sequence": 1, "kind": "message", "payload": {"text": "planning"}, "createdAt": NOW
    }]
```

- [ ] **Step 2: 运行失败测试**

Run: `cd runtime; python -m pytest tests/test_persistence.py -k agent_job -q`

Expected: FAIL，提示 `AgentJobRepository` 尚不存在。

- [ ] **Step 3: 增加 models、表和 repository**

```python
AgentProvider = Literal["codex", "claude"]
AgentJobStatus = Literal["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]

class AgentJob(CanonicalModel):
    id: str
    runId: str
    nodeId: str
    provider: AgentProvider
    status: AgentJobStatus
    command: list[str]
    cwd: str
    pid: int | None = None
    summary: str | None = None
    error: str | None = None
    createdAt: str
    updatedAt: str

class AgentOutputEvent(CanonicalModel):
    id: str
    jobId: str
    sequence: int
    kind: str
    payload: dict[str, Any]
    createdAt: str
```

在 migration 中创建 `agent_jobs`、`agent_output_events`，分别以 `run_id`/`job_id` 建索引；repository 提供 `create`、`set_running`、`finish`、`get`、`append_output`、`list_output(after_sequence)`。

- [ ] **Step 4: 运行通过测试**

Run: `cd runtime; python -m pytest tests/test_persistence.py -k agent_job -q`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add runtime/src/workflow_platform/models.py runtime/src/workflow_platform/persistence runtime/tests/test_persistence.py
git commit -m "feat: persist agent jobs and output"
```

### Task 2: CLI provider 命令策略与输出归一化

**Files:**
- Create: `runtime/src/workflow_platform/execution/providers.py`
- Create: `runtime/tests/test_execution_cli.py`

- [ ] **Step 1: 写失败的 provider 测试**

```python
def test_codex_provider_uses_windows_cmd_and_json_output() -> None:
    command = CodexCliProvider(platform="win32").build_command(
        cwd=Path("C:/project"), prompt="实现节点", allowed_tools=["Read", "Edit"]
    )
    assert command.executable == "codex.cmd"
    assert command.args[:3] == ["exec", "--json", "--sandbox"]
    assert "--dangerously-bypass-approvals-and-sandbox" not in command.args

def test_claude_provider_normalizes_stream_json_message() -> None:
    event = ClaudeCliProvider(platform="win32").parse_line(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"完成"}]}}'
    )
    assert event == {"kind": "message", "payload": {"text": "完成"}}
```

- [ ] **Step 2: 运行失败测试**

Run: `cd runtime; python -m pytest tests/test_execution_cli.py -k "provider" -q`

Expected: FAIL，提示 provider 类不存在。

- [ ] **Step 3: 实现 command dataclass 和两个 provider**

```python
@dataclass(frozen=True)
class CliCommand:
    executable: str
    args: list[str]
    cwd: Path

class CodexCliProvider:
    def build_command(self, *, cwd: Path, prompt: str, allowed_tools: list[str]) -> CliCommand:
        executable = "codex.cmd" if self._platform == "win32" else "codex"
        return CliCommand(
            executable=executable,
            args=["exec", "--json", "--sandbox", "workspace-write", "--cd", str(cwd), prompt],
            cwd=cwd,
        )
```

Claude provider 使用 `claude.cmd`/`claude`、`-p`、`--output-format stream-json`、`--permission-mode acceptEdits` 和受限 `--allowedTools`。两个 provider 对无法解析的行返回 `{"kind": "raw", "payload": {"text": line}}`，不丢失诊断信息。

- [ ] **Step 4: 运行通过测试**

Run: `cd runtime; python -m pytest tests/test_execution_cli.py -k "provider" -q`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add runtime/src/workflow_platform/execution/providers.py runtime/tests/test_execution_cli.py
git commit -m "feat: add Codex and Claude CLI providers"
```

### Task 3: 受控子进程执行、输出与取消

**Files:**
- Create: `runtime/src/workflow_platform/execution/cli.py`
- Modify: `runtime/tests/test_execution_cli.py`
- Create: `runtime/tests/fixtures/fake_cli.py`

- [ ] **Step 1: 写失败的执行器测试**

```python
def test_executor_persists_json_lines_and_completes(tmp_path) -> None:
    events: list[dict] = []
    executor = CliAgentExecutor(
        provider=FakeProvider([sys.executable, str(FAKE_CLI), "complete"]),
        on_output=events.append,
    )
    result = executor.run(prompt="实现节点", cwd=tmp_path, timeout_seconds=5, max_output_bytes=4096)
    assert result.status == "COMPLETED"
    assert [event["kind"] for event in events] == ["message", "final"]

def test_executor_rejects_cwd_outside_project_root(tmp_path) -> None:
    executor = CliAgentExecutor(provider=FakeProvider(["fake"]))
    with pytest.raises(ValueError, match="AGENT_UNSAFE_CWD"):
        executor.run(prompt="x", cwd=tmp_path.parent, project_root=tmp_path, timeout_seconds=5, max_output_bytes=4096)
```

- [ ] **Step 2: 运行失败测试**

Run: `cd runtime; python -m pytest tests/test_execution_cli.py -k "executor" -q`

Expected: FAIL，提示 `CliAgentExecutor` 尚不存在。

- [ ] **Step 3: 实现 executor**

```python
process = subprocess.Popen(
    [command.executable, *command.args],
    cwd=command.cwd,
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    encoding="utf-8",
    errors="replace",
    shell=False,
    env=allowed_environment,
)
```

实现 `cancel(job_id)`，发送 terminate，等待 2 秒后 kill；限制累计输出字节数；超时终止进程并返回 `FAILED`。`allowed_environment` 只保留 `PATH`、`HOME`、`USERPROFILE`、`APPDATA`、`LOCALAPPDATA`、`CODEX_HOME`、`ANTHROPIC_API_KEY` 和明确传入的 provider 环境变量。

- [ ] **Step 4: 运行通过测试**

Run: `cd runtime; python -m pytest tests/test_execution_cli.py -k "executor" -q`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add runtime/src/workflow_platform/execution/cli.py runtime/tests/test_execution_cli.py runtime/tests/fixtures/fake_cli.py
git commit -m "feat: run controlled CLI agent jobs"
```

### Task 4: Runtime service 和 FastAPI Agent Job 端点

**Files:**
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `runtime/tests/test_runtime_service.py`
- Modify: `runtime/tests/test_api.py`

- [ ] **Step 1: 写失败的 service/API 测试**

```python
def test_runtime_service_starts_agent_for_existing_run_node(service, run) -> None:
    job = service.start_agent_job(
        run_id=run.runId,
        node_id="plan",
        provider="codex",
        prompt="生成实现计划",
        actor=AGENT_ACTOR,
        now=NOW,
    )
    assert job["runId"] == run.runId
    assert job["status"] == "COMPLETED"
    assert service.list_agent_output(job["id"], after_sequence=0)[0]["kind"] == "message"

def test_runtime_api_rejects_agent_for_unknown_node(client, run) -> None:
    response = client.post(f"/runs/{run['runId']}/agents", json={
        "nodeId": "missing", "provider": "codex", "prompt": "x",
        "actor": AGENT_ACTOR, "now": NOW,
    })
    assert response.status_code == 400
```

- [ ] **Step 2: 运行失败测试**

Run: `cd runtime; python -m pytest tests/test_runtime_service.py tests/test_api.py -k agent -q`

Expected: FAIL，提示 agent job service/API 尚不存在。

- [ ] **Step 3: 实现 service 和 API**

添加：

```text
POST /runs/{run_id}/agents
GET  /runs/{run_id}/agents
GET  /runs/{run_id}/agents/{job_id}
GET  /runs/{run_id}/agents/{job_id}/output?afterSequence=0
POST /runs/{run_id}/agents/{job_id}/cancel
```

`start_agent_job` 从 `RunRepository.project_root_for_run()` 取得可信 cwd，确认 node 在 workflow 中，调用注入的 executor factory。输出事件只写入 agent job repository；P2 不追加 run transition event，也不修改 node、approval 或 gate 状态。错误码映射为 `AGENT_UNSAFE_CWD`、`AGENT_PROVIDER_UNAVAILABLE`、`AGENT_TIMEOUT`、`AGENT_OUTPUT_LIMIT`、`AGENT_NOT_FOUND`。

- [ ] **Step 4: 运行通过测试**

Run: `cd runtime; python -m pytest tests/test_runtime_service.py tests/test_api.py -k agent -q`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add runtime/src/workflow_platform/runtime_service.py runtime/src/workflow_platform/api/app.py runtime/tests/test_runtime_service.py runtime/tests/test_api.py
git commit -m "feat: expose run-bound agent jobs"
```

### Task 5: P2 fake CLI 集成验收与中文文档

**Files:**
- Modify: `README.md`
- Modify: `docs/mvp-completion-audit.zh-CN.md`
- Modify: `runtime/tests/test_api.py`

- [ ] **Step 1: 写失败的 fake CLI API 集成测试**

```python
def test_runtime_api_runs_configured_fake_agent_and_returns_output(client, run) -> None:
    job = client.post(
        f"/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan",
            "provider": "fake",
            "prompt": "生成计划",
            "actor": AGENT_ACTOR,
            "now": NOW,
        },
    )
    output = client.get(f"/runs/{run['runId']}/agents/{job.json()['id']}/output")
    current = client.get(f"/runs/{run['runId']}").json()

    assert job.status_code == 200
    assert output.json()[0]["payload"]["text"] == "fake-cli: completed"
    assert current["revision"] == run["revision"]
```

- [ ] **Step 2: 运行失败测试**

Run: `cd runtime; python -m pytest tests/test_api.py -k fake_agent -q`

Expected: FAIL，因为 fake provider 配置和 agent API 尚未实现。

- [ ] **Step 3: 增加 fake provider 集成配置和中文文档**

测试 runtime service 时注入 fake provider，不依赖已安装的 Codex/Claude Code；README 与审计文档使用中文更新 P2 范围、CLI 安全边界和精确测试数量。

- [ ] **Step 4: 运行通过测试**

Run: `npm.cmd run verify`

Expected: contracts、renderer、desktop、runtime 全部通过。

- [ ] **Step 5: 提交**

```powershell
git add README.md docs/mvp-completion-audit.zh-CN.md runtime/tests/test_api.py
git commit -m "test: verify CLI agent runtime"
```

## 自审

- P2 规格中的 agent job、CLI provider、受控 cwd、输出、取消、Runtime API、fake CLI 集成和中文文档分别由 Task 1-5 覆盖。
- provider、executor、repository、service 和 API 的类型名在任务间保持一致。
- CLI 不会调用 approval/gate transition，安全约束由 command builder、executor 和 Runtime service 三层共同保护。
