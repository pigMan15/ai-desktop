# 交互式 Agent 与终端体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在同一 Run 中提供可直接输入的交互式 Codex/Claude Agent 会话，并将终端与所有实时日志改为稳定、可滚动、中文可读的单一 Xterm/日志视图。

**Architecture:** Runtime 保存 Agent 模式、会话、人工输入、输出和审计；Electron 主进程通过 `node-pty` 启动并管理交互 Provider；Renderer 使用可复用的 Xterm 视图将输出显示与输入直接绑定。自动执行继续使用 Runtime 内的 JSON 流式 Executor，交互式会话不再从 Renderer 直接启动任意命令。

**Tech Stack:** Python 3/FastAPI/SQLite/Pytest，Electron 31/TypeScript/`node-pty`，React 18/Vitest/Testing Library，Xterm 6/Playwright。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `runtime/src/workflow_platform/persistence/migrations.py` | 增量迁移交互 Agent 会话和人工输入表，兼容旧数据库。 |
| `runtime/src/workflow_platform/persistence/repositories.py` | 读写 Job 模式、会话状态、人工输入和输出序列。 |
| `runtime/src/workflow_platform/models.py` | 声明交互会话、模式与 API 数据模型。 |
| `runtime/src/workflow_platform/runtime_service.py` | 治理交互 Job 的创建、启动确认、输入、输出、结束和继续。 |
| `runtime/src/workflow_platform/api/app.py` | 暴露受本地认证保护的交互 Agent API。 |
| `runtime/tests/test_persistence.py`、`test_runtime_service.py`、`test_api.py` | 覆盖迁移、权限、审计、恢复和 API 契约。 |
| `apps/desktop/src/main/terminal.ts` | 统一 Shell/Codex/Claude PTY，UTF-8 环境和输入策略。 |
| `apps/desktop/src/main/main.ts` | 注册受校验的交互 Agent PTY IPC。 |
| `apps/desktop/src/preload/preload.cts`、`global.d.ts` | 只暴露白名单 IPC 桥。 |
| `apps/desktop/test/main.test.ts` | 验证 Provider PTY 命令、编码环境与 IPC。 |
| `apps/renderer/src/features/terminal/TerminalViewport.tsx` | 新建：唯一 Xterm 视图、直接输入、自动跟随、未读提示和搜索。 |
| `apps/renderer/src/features/terminal/TerminalPage.tsx` | 采用 `TerminalViewport`，删除重复 `<pre>` 和外部输入框。 |
| `apps/renderer/src/features/runs/RunDashboard.tsx` | 增加 Agent 模式、交互会话 Xterm 和受限自动日志视窗。 |
| `apps/renderer/src/app/runtimeClient.ts`、`App.tsx` | 声明 API 客户端、协调 Runtime 记录与 PTY 生命周期。 |
| `apps/renderer/src/app/styles.css` | 固定高度、响应式日志容器和 Xterm 布局。 |
| Renderer 测试、`tests/e2e/desktop-electron.spec.ts`、打包 E2E | 验证交互继续、直接输入、乱码和高度回归。 |

## Task 1: 建立 Runtime 交互会话数据模型与迁移

**Files:**
- Modify: `runtime/src/workflow_platform/persistence/migrations.py`
- Modify: `runtime/src/workflow_platform/models.py`
- Modify: `runtime/tests/test_persistence.py`

- [ ] **Step 1: 写入失败迁移测试**

```python
def test_migrate_adds_interactive_agent_columns_and_tables_to_existing_database() -> None:
    db = connect(fresh_db_path("interactive-agent-migration"))
    migrate(db)

    agent_job_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(agent_jobs)").fetchall()
    }
    input_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(agent_input_events)").fetchall()
    }
    session_columns = {
        row["name"] for row in db.execute("PRAGMA table_info(agent_sessions)").fetchall()
    }

    assert {"mode", "session_id", "parent_job_id"} <= agent_job_columns
    assert {"id", "run_id", "job_id", "provider", "status", "cwd"} <= session_columns
    assert {"id", "session_id", "sequence", "kind", "content"} <= input_columns
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd runtime; python -m pytest tests/test_persistence.py -k interactive_agent_migration -q`

Expected: FAIL，`agent_sessions` 或新列不存在。

- [ ] **Step 3: 增加迁移和 Pydantic 模型**

在 `migrate()` 现有 `projects.archived_at` 增量迁移之后增加列检查和建表：

```python
agent_job_columns = {
    row["name"] for row in db.execute("PRAGMA table_info(agent_jobs)").fetchall()
}
if "mode" not in agent_job_columns:
    db.execute("ALTER TABLE agent_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'automatic'")
if "session_id" not in agent_job_columns:
    db.execute("ALTER TABLE agent_jobs ADD COLUMN session_id TEXT")
if "parent_job_id" not in agent_job_columns:
    db.execute("ALTER TABLE agent_jobs ADD COLUMN parent_job_id TEXT")

db.executescript(
    """
    CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        job_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        desktop_session_id TEXT,
        pid INTEGER,
        cwd TEXT NOT NULL,
        recovery_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ended_at TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
        FOREIGN KEY (job_id) REFERENCES agent_jobs(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS agent_input_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
        UNIQUE(session_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_sessions_run_status
        ON agent_sessions(run_id, status, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_agent_input_events_session_sequence
        ON agent_input_events(session_id, sequence);
    """
)
```

在 `models.py` 中增加：

```python
AgentMode = Literal["interactive", "automatic"]
AgentSessionStatus = Literal["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "RECOVERABLE"]

class AgentSession(CanonicalModel):
    id: str
    runId: str
    jobId: str
    provider: AgentProvider
    status: AgentSessionStatus
    desktopSessionId: str | None = None
    pid: int | None = None
    cwd: str
    recoveryReason: str | None = None
    createdAt: str
    updatedAt: str
    endedAt: str | None = None
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd runtime; python -m pytest tests/test_persistence.py -k interactive_agent_migration -q`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add runtime/src/workflow_platform/persistence/migrations.py runtime/src/workflow_platform/models.py runtime/tests/test_persistence.py
git commit -m "feat: add interactive agent persistence schema"
```

## Task 2: 扩展仓储与 Runtime 交互式 Job 治理

**Files:**
- Modify: `runtime/src/workflow_platform/persistence/repositories.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/tests/test_runtime_service.py`

- [ ] **Step 1: 写入失败服务测试**

```python
def test_runtime_service_creates_interactive_agent_and_audits_user_input(tmp_path) -> None:
    service, run = create_runtime_service_with_run(tmp_path)

    job = service.start_agent_job(
        run.runId,
        node_id="plan",
        provider="codex",
        prompt="请先询问我目标分支。",
        mode="interactive",
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    session = service.start_interactive_agent_session(
        run.runId,
        job["id"],
        desktop_session_id="pty-1",
        pid=1234,
        actor=trusted_human().model_dump(),
        now=NOW,
    )
    service.record_interactive_agent_input(
        run.runId,
        job["id"],
        content="目标分支是 release。",
        actor=trusted_human().model_dump(),
        now=NOW,
    )

    assert job["mode"] == "interactive"
    assert session["status"] == "RUNNING"
    assert service.list_agent_input(session["id"])[1]["content"] == "目标分支是 release。"
    assert any(
        item["action"] == "agent.interactive.input.recorded"
        for item in service.list_audit_records()
    )
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd runtime; python -m pytest tests/test_runtime_service.py -k interactive_agent_and_audits -q`

Expected: FAIL，缺少 `mode` 参数和交互会话服务方法。

- [ ] **Step 3: 实现仓储和服务方法**

为 `AgentJobRepository.create()` 增加 `mode`、`session_id`、`parent_job_id` 参数，并扩展 `_job_row_to_dict()`：

```python
"mode": row["mode"],
"sessionId": row["session_id"],
"parentJobId": row["parent_job_id"],
```

新增 `AgentSessionRepository`，最小公开接口为：

```python
create(id, run_id, job_id, provider, cwd, created_at)
mark_running(id, desktop_session_id, pid, updated_at)
finish(id, status, recovery_reason, ended_at)
get_for_job(job_id)
append_input(id, session_id, sequence, kind, content, created_at)
list_input(session_id)
```

将 `WorkflowRuntimeService.start_agent_job()` 签名扩展为：

```python
def start_agent_job(
    self, run_id: str, *, node_id: str, provider: str, prompt: str,
    actor: dict, now: str, mode: str = "automatic",
    allowed_tools: list[str] | None = None, timeout_seconds: float = 300,
    max_output_bytes: int = 1_000_000, resumed_from_checkpoint_id: str | None = None,
    parent_job_id: str | None = None,
) -> dict:
```

当 `mode == "interactive"` 时，创建 Job、Session 和 `initial_prompt` 输入事件，写入 `agent.interactive.created` 审计后立即返回，不创建 `CliAgentExecutor` 线程。非法模式抛出 `AGENT_MODE_INVALID`。

实现以下服务方法：

```python
start_interactive_agent_session(run_id, job_id, *, desktop_session_id, pid, actor, now) -> dict
record_interactive_agent_input(run_id, job_id, *, content, actor, now) -> dict
append_interactive_agent_output(run_id, job_id, *, events, now) -> list[dict]
finish_interactive_agent_session(run_id, job_id, *, status, summary, error, actor, now) -> dict
continue_interactive_agent(run_id, job_id, *, actor, now) -> dict
```

`record_interactive_agent_input()` 必须调用 `require_trusted_human`，用 `redact_terminal_output(content)` 存储，拒绝空白或带 NUL 的输入，并记录 `agent.interactive.input.recorded`。`append_interactive_agent_output()` 使用现有 `agent_output_events` 的最大序列号加一，写入 `kind="terminal_raw"` 和脱敏 `{"text": ...}`。

- [ ] **Step 4: 增加错误与恢复失败测试**

```python
def test_runtime_service_rejects_interactive_input_from_untrusted_actor(tmp_path) -> None:
    service, run, job = create_interactive_agent_job(tmp_path)

    with pytest.raises(ValueError, match="ACTOR_NOT_TRUSTED"):
        service.record_interactive_agent_input(
            run.runId, job["id"], content="继续",
            actor={"id": "agent", "type": "agent", "source": "agent", "trusted": False},
            now=NOW,
        )

def test_runtime_service_marks_unbound_interactive_session_recoverable(tmp_path) -> None:
    service, run, job = create_interactive_agent_job(tmp_path)
    service.start_interactive_agent_session(
        run.runId, job["id"], desktop_session_id="pty-1", pid=12,
        actor=trusted_human().model_dump(), now=NOW,
    )

    diagnostic = service.get_recovery_diagnostics(run.runId)

    assert job["id"] in diagnostic["orphanAgentJobIds"]
```

- [ ] **Step 5: 运行服务测试确认通过**

Run: `cd runtime; python -m pytest tests/test_runtime_service.py -k "interactive_agent or unbound_interactive" -q`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add runtime/src/workflow_platform/persistence/repositories.py runtime/src/workflow_platform/runtime_service.py runtime/tests/test_runtime_service.py
git commit -m "feat: govern interactive agent sessions"
```

## Task 3: 暴露交互式 Agent Runtime API

**Files:**
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `runtime/tests/test_api.py`

- [ ] **Step 1: 写入失败 API 测试**

```python
def test_runtime_api_persists_interactive_agent_input_and_output(tmp_path) -> None:
    client, run = create_client_with_run(tmp_path)
    job = client.post(
        f"/runs/{run['runId']}/agents",
        json={
            "nodeId": "plan", "provider": "fake", "prompt": "询问用户。",
            "mode": "interactive", "actor": HUMAN_ACTOR, "now": NOW,
        },
    ).json()

    started = client.post(
        f"/runs/{run['runId']}/agents/{job['id']}/interactive-session/start",
        json={"desktopSessionId": "pty-1", "pid": 1234, "actor": HUMAN_ACTOR, "now": NOW},
    )
    accepted = client.post(
        f"/runs/{run['runId']}/agents/{job['id']}/interactive-session/input",
        json={"content": "选择 A", "actor": HUMAN_ACTOR, "now": NOW},
    )
    output = client.post(
        f"/runs/{run['runId']}/agents/{job['id']}/interactive-session/output",
        json={"events": [{"data": "已收到选择 A\\r\\n"}], "now": NOW},
    )

    assert started.status_code == 200
    assert accepted.status_code == 200
    assert output.status_code == 200
    assert client.get(f"/runs/{run['runId']}/agents/{job['id']}/output").json()[-1]["payload"]["text"] == "已收到选择 A\\r\\n"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd runtime; python -m pytest tests/test_api.py -k interactive_agent_input_and_output -q`

Expected: FAIL，路由为 404 或请求模型不接受 `mode`。

- [ ] **Step 3: 实现请求模型、路由和错误映射**

添加请求模型：

```python
class StartInteractiveAgentSessionRequest(BaseModel):
    desktopSessionId: str
    pid: int
    actor: dict[str, Any]
    now: str

class InteractiveAgentInputRequest(BaseModel):
    content: str
    actor: dict[str, Any]
    now: str

class InteractiveAgentOutputRequest(BaseModel):
    events: list[dict[str, str]]
    now: str

class FinishInteractiveAgentSessionRequest(BaseModel):
    status: str
    summary: str | None = None
    error: str | None = None
    actor: dict[str, Any]
    now: str
```

向 `StartAgentJobRequest` 添加：

```python
mode: str = "automatic"
```

按规格注册 `/interactive-session/start`、`/input`、`/output`、`/ended`、`GET /interactive-session` 和 `/continue` 路由。将 `AGENT_MODE_INVALID`、`AGENT_INTERACTIVE_SESSION_REQUIRED`、`AGENT_INTERACTIVE_SESSION_STATE_INVALID` 映射为 400/409。

- [ ] **Step 4: 运行 API 测试确认通过**

Run: `cd runtime; python -m pytest tests/test_api.py -k interactive_agent -q`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add runtime/src/workflow_platform/api/app.py runtime/tests/test_api.py
git commit -m "feat: add interactive agent runtime API"
```

## Task 4: 为 Codex、Claude 和 Shell 统一安全 PTY 能力

**Files:**
- Modify: `apps/desktop/src/main/terminal.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/preload/preload.cts`
- Modify: `apps/desktop/src/preload/global.d.ts`
- Modify: `apps/desktop/test/main.test.ts`

- [ ] **Step 1: 写入失败 Electron 测试**

在 `apps/desktop/test/main.test.ts` 增加对 Provider PTY 的断言：

```ts
const interactive = terminalManager.create({
  kind: "claude",
  cwd: "G:\\Project\\demo",
  projectRoot: "G:\\Project\\demo",
  columns: 120,
  rows: 36,
  initialPrompt: "请等待用户回复。",
});

assert.equal(interactive.kind, "claude");
assert.equal(ptySpawnCalls[0]?.command, "claude.cmd");
assert.deepEqual(ptySpawnCalls[0]?.args, [
  "--ax-screen-reader",
  "--permission-mode",
  "acceptEdits",
  "请等待用户回复。",
]);
assert.equal(ptySpawnCalls[0]?.options.env?.PYTHONIOENCODING, "utf-8");
```

增加 Shell 直接输入仍经审批的断言：

```ts
const decision = terminalManager.submitShellLine(shell.id, "del .\\build");
assert.equal(decision.status, "pending_approval");
assert.deepEqual(terminalWrites, []);
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --workspace @workflow-platform/desktop run test`

Expected: FAIL，`claude` 类型和 `submitShellLine` 不存在。

- [ ] **Step 3: 扩展 TerminalManager**

将类型扩展为：

```ts
export type TerminalKind = "shell" | "codex" | "claude";
export type TerminalCreateRequest = {
  kind: TerminalKind;
  cwd: string;
  projectRoot: string;
  columns?: number;
  rows?: number;
  initialPrompt?: string;
};
```

让 `TerminalSpawnOptions` 包含受控环境：

```ts
export type TerminalSpawnOptions = {
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
};
```

`commandFor()` 必须只返回内部构造的 Provider 命令：

```ts
if (kind === "codex") {
  return [windows ? "codex.cmd" : "codex", [
    "--sandbox", "workspace-write", "--ask-for-approval", "on-request",
    "--no-alt-screen", "--cd", cwd, initialPrompt ?? "",
  ].filter(Boolean)];
}
if (kind === "claude") {
  return [windows ? "claude.cmd" : "claude", [
    "--ax-screen-reader", "--permission-mode", "acceptEdits", initialPrompt ?? "",
  ].filter(Boolean)];
}
return [windows ? "cmd.exe" : "/bin/sh", windows ? ["/d", "/k", "chcp 65001>nul"] : []];
```

构造环境：

```ts
function terminalEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PYTHONIOENCODING: "utf-8",
  };
}
```

新增 `writeInput(sessionId, data)`，仅允许 `codex`/`claude` 直接写入；新增 `submitShellLine()` 复用现有 `analyzeTerminalCommand()` 与审批机制。禁止 Renderer 将任意 command/args 传给 `create()`。

在 `main.ts` 注册 `terminal:write-input`、扩展 `terminal:create` 的三种 `kind` 和可选 `initialPrompt`；在 preload 声明同名桥接方法。

- [ ] **Step 4: 运行桌面测试确认通过**

Run: `npm --workspace @workflow-platform/desktop run test`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src/main/terminal.ts apps/desktop/src/main/main.ts apps/desktop/src/preload/preload.cts apps/desktop/src/preload/global.d.ts apps/desktop/test/main.test.ts
git commit -m "feat: add governed interactive provider terminals"
```

## Task 5: 先建立可复用 Xterm 视图与日志跟随行为

**Files:**
- Create: `apps/renderer/src/features/terminal/TerminalViewport.tsx`
- Create: `apps/renderer/src/features/terminal/TerminalViewport.test.tsx`
- Modify: `apps/renderer/src/app/styles.css`

- [ ] **Step 1: 写入失败组件测试**

```tsx
it("用户上滚后暂停跟随并显示未读输出数", async () => {
  const onInput = vi.fn();
  render(
    <TerminalViewport
      ariaLabel="交互日志"
      output={[{ sequence: 1, data: "第一行\r\n" }]}
      writable
      onInput={onInput}
    />,
  );

  fireEvent.scroll(screen.getByLabelText("交互日志"), { target: { scrollTop: 0 } });
  rerender(
    <TerminalViewport
      ariaLabel="交互日志"
      output={[
        { sequence: 1, data: "第一行\r\n" },
        { sequence: 2, data: "第二行\r\n" },
      ]}
      writable
      onInput={onInput}
    />,
  );

  expect(screen.getByRole("button", { name: "跳到最新（1 条未读）" })).toBeVisible();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --workspace @workflow-platform/renderer run test -- TerminalViewport`

Expected: FAIL，文件不存在。

- [ ] **Step 3: 实现视图组件**

组件 props：

```ts
type TerminalViewportProps = {
  ariaLabel: string;
  output: Array<{ sequence: number; data: string }>;
  writable?: boolean;
  onInput?: (data: string) => Promise<void> | void;
  onInterrupt?: () => void;
  className?: string;
};
```

使用动态导入的 `@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-search`。设置：

```ts
new Terminal({
  convertEol: true,
  cursorBlink: writable,
  disableStdin: !writable,
  scrollback: 2_000,
  fontFamily: '"Cascadia Code", Consolas, monospace',
  fontSize: 13,
  theme: { background: "#111827", foreground: "#e5f7ef", cursor: "#fef3c7" },
});
```

当 `writable` 时在 `terminal.onData()` 中调用 `onInput(data)`；只在用户位于底部时自动滚动。上滚后计算新增事件数，显示带 `aria-label="跳到最新（N 条未读）"` 的图标按钮。提供同一条工具栏内的搜索、上一个/下一个、复制和清屏显示按钮。

CSS 必须包含：

```css
.terminal-surface {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  min-height: 0;
  height: clamp(26rem, 58vh, 38rem);
}
.terminal-viewport {
  min-height: 0;
  overflow: hidden;
  border: 1px solid #273449;
  border-radius: 6px;
  background: #111827;
}
```

- [ ] **Step 4: 运行组件测试确认通过**

Run: `npm --workspace @workflow-platform/renderer run test -- TerminalViewport`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/renderer/src/features/terminal/TerminalViewport.tsx apps/renderer/src/features/terminal/TerminalViewport.test.tsx apps/renderer/src/app/styles.css
git commit -m "feat: add bounded interactive terminal viewport"
```

## Task 6: 改造终端页面为直接 Xterm 输入

**Files:**
- Modify: `apps/renderer/src/features/terminal/TerminalPage.tsx`
- Modify: `apps/renderer/src/features/terminal/TerminalPage.test.tsx`
- Modify: `apps/renderer/src/app/styles.css`

- [ ] **Step 1: 写入失败 UI 测试**

```tsx
it("在终端视窗内直接输入并经 Shell 治理发送命令", async () => {
  const requestCommand = vi.fn(async () => ({
    status: "executed" as const,
    commandSummary: "echo hello",
  }));
  installTerminalBridge({ requestCommand });
  renderTerminalPage();

  await createShellTerminal();
  fireEvent.keyDown(screen.getByLabelText("ANSI 终端"), { key: "Enter" });

  expect(screen.queryByLabelText("终端输入")).not.toBeInTheDocument();
  expect(requestCommand).toHaveBeenCalledWith("terminal-1", "echo hello");
});
```

在测试辅助中将 Xterm 动态导入替换为可触发 `onData` 的 fake terminal，依次发出 `"e"`, `"c"`, `"h"`, `"o"`, `" "`, `"h"`, `"e"`, `"l"`, `"l"`, `"o"`, `"\r"`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --workspace @workflow-platform/renderer run test -- TerminalPage`

Expected: FAIL，因为页面仍有 `终端输入` 和 `发送输入`。

- [ ] **Step 3: 用 `TerminalViewport` 替换重复渲染**

删除：

```tsx
<label>终端输入<input ... /></label>
<button>发送输入</button>
<pre className="terminal-readout" ...>{outputText.trimEnd()}</pre>
<div ref={viewportRef} className="terminal-viewport" ... />
```

新增 Shell 行缓冲处理器：

```ts
const [shellLine, setShellLine] = useState("");

async function handleTerminalData(data: string) {
  if (session?.kind !== "shell") {
    await bridge?.writeInput(session!.id, data);
    return;
  }
  if (data === "\r") {
    const line = shellLine;
    setShellLine("");
    await sendShellLine(line);
    return;
  }
  if (data === "\u0003") {
    await interruptTerminal();
    return;
  }
  if (data === "\u007f") {
    setShellLine((value) => value.slice(0, -1));
    return;
  }
  if (!/[\r\n\u0000-\u001f\u007f]/.test(data)) {
    setShellLine((value) => value + data);
  }
}
```

`sendShellLine()` 使用 `bridge.requestCommand()`，保留现有审批对话框。由 `TerminalViewport` 的临时本地回显展示未提交 Shell 行，按回车后清除本地行并让 PTY 回显实际命令，避免重复显示。

历史回放传 `writable={false}`。保留停止、重启、resize、Evidence 和搜索能力；删除“发送输入”“粘贴到输入”“清空输出”旧按钮，改由视窗工具栏承载复制/粘贴/清屏显示。

- [ ] **Step 4: 运行终端测试确认通过**

Run: `npm --workspace @workflow-platform/renderer run test -- TerminalPage`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/renderer/src/features/terminal/TerminalPage.tsx apps/renderer/src/features/terminal/TerminalPage.test.tsx apps/renderer/src/app/styles.css
git commit -m "feat: support direct terminal input in xterm"
```

## Task 7: 将 Run Agent 连接到交互式 PTY 与 Runtime 转录

**Files:**
- Modify: `apps/renderer/src/app/runtimeClient.ts`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/features/runs/RunDashboard.tsx`
- Modify: `apps/renderer/src/features/runs/RunDashboard.test.tsx`
- Modify: `apps/renderer/src/app/runtimeClient.test.ts`
- Modify: `apps/renderer/src/app/App.test.tsx`

- [ ] **Step 1: 写入失败 Runtime Client 测试**

```ts
it("starts and records an interactive agent session", async () => {
  const client = createRuntimeClient("http://127.0.0.1:8765");

  await client.startAgentJob("run-demo", "plan", "codex", "询问我目标", "interactive", NOW);
  await client.startInteractiveAgentSession("run-demo", "job-1", "pty-1", 1234, NOW);
  await client.recordInteractiveAgentInput("run-demo", "job-1", "目标是 main", NOW);

  expect(calls.map(({ path }) => path)).toEqual([
    "/runs/run-demo/agents",
    "/runs/run-demo/agents/job-1/interactive-session/start",
    "/runs/run-demo/agents/job-1/interactive-session/input",
  ]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --workspace @workflow-platform/renderer run test -- runtimeClient`

Expected: FAIL，客户端方法不存在。

- [ ] **Step 3: 增加客户端类型与 API 方法**

扩展 `AgentJobSummary`：

```ts
mode: "interactive" | "automatic";
sessionId?: string | null;
parentJobId?: string | null;
```

新增：

```ts
startInteractiveAgentSession(runId, jobId, desktopSessionId, pid, now)
recordInteractiveAgentInput(runId, jobId, content, now)
appendInteractiveAgentOutput(runId, jobId, events, now)
finishInteractiveAgentSession(runId, jobId, status, summary, error, now)
getInteractiveAgentSession(runId, jobId)
continueInteractiveAgent(runId, jobId, now)
```

所有人类输入和会话开始/结束 API 传入 `HUMAN_ACTOR`，不复用 `AGENT_ACTOR`。

- [ ] **Step 4: 写入失败 Run Dashboard 测试**

```tsx
it("交互式 Agent 启动后在同一 Agent Xterm 中直接回复", async () => {
  const onStartAgent = vi.fn();
  const onAgentInput = vi.fn();
  render(<RunDashboard state={interactiveState} onStartAgent={onStartAgent} onAgentInput={onAgentInput} />);

  fireEvent.change(screen.getByLabelText("Agent 模式"), { target: { value: "interactive" } });
  fireEvent.click(screen.getByRole("button", { name: "启动 Agent" }));
  await fireInteractiveTerminalData("继续执行，目标分支是 main。\r");

  expect(onStartAgent).toHaveBeenCalledWith("plan", "codex", expect.any(String), "interactive");
  expect(onAgentInput).toHaveBeenCalledWith("agent-job-1", "继续执行，目标分支是 main。\r");
  expect(screen.queryByLabelText("Agent 回复输入框")).not.toBeInTheDocument();
});
```

- [ ] **Step 5: 运行失败测试**

Run: `npm --workspace @workflow-platform/renderer run test -- RunDashboard`

Expected: FAIL，因为模式与直接输入回调不存在。

- [ ] **Step 6: 实现 App 生命周期协调**

`handleStartAgent` 接受模式：

```ts
async function handleStartAgent(
  nodeId: string, provider: AgentJobSummary["provider"], prompt: string,
  mode: "interactive" | "automatic",
) {
  const job = await client.startAgentJob(runId, nodeId, provider, prompt, mode, now());
  if (mode !== "interactive") {
    // 保留现有 Runtime 轮询路径。
    return;
  }
  const terminal = await window.workflowTerminal.create({
    kind: provider,
    cwd: projectPath,
    projectRoot: projectPath,
    columns: 120,
    rows: 32,
    initialPrompt: prompt,
  });
  await client.startInteractiveAgentSession(runId, job.id, terminal.id, terminal.pid, now());
  setInteractiveAgentTerminal({ jobId: job.id, terminalId: terminal.id });
}
```

PTY 输出按 sequence 读取并以最多 20 条、250ms 节流调用 `appendInteractiveAgentOutput()`；网络暂时失败时保留内存队列并显示中文“正在重试保存转录”，不得丢弃已读输出。

当 PTY 退出或用户取消时，先停止本地会话，再调用 `finishInteractiveAgentSession()`。自动 Job 继续使用已有 Runtime 轮询。

`RunDashboard` 增加 `Agent 模式` 的分段控件，默认值 `"interactive"`，在交互 Job 存在时渲染 `TerminalViewport`，其 `onInput` 先调用 `recordInteractiveAgentInput()` 再调用 `workflowTerminal.writeInput()`。输入失败时不写入 PTY，并在页面显示 Runtime 错误。

- [ ] **Step 7: 运行 Renderer 单元测试确认通过**

Run: `npm --workspace @workflow-platform/renderer run test -- runtimeClient RunDashboard App`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add apps/renderer/src/app/runtimeClient.ts apps/renderer/src/app/runtimeClient.test.ts apps/renderer/src/app/App.tsx apps/renderer/src/app/App.test.tsx apps/renderer/src/features/runs/RunDashboard.tsx apps/renderer/src/features/runs/RunDashboard.test.tsx
git commit -m "feat: run interactive agents in xterm"
```

## Task 8: 完成 Run/部署日志布局与中文编码回归

**Files:**
- Modify: `apps/renderer/src/features/runs/RunDashboard.tsx`
- Modify: `apps/renderer/src/app/styles.css`
- Modify: `apps/renderer/src/features/runs/RunDashboard.test.tsx`
- Modify: `runtime/src/workflow_platform/execution/cli.py`
- Modify: `runtime/tests/test_execution_cli.py`

- [ ] **Step 1: 写入失败视图与编码测试**

```tsx
it("将部署与自动 Agent 输出放在固定高度的实时日志视窗中", () => {
  render(<RunDashboard state={automaticJobState} deploymentOutput={longOutput} />);

  expect(screen.getByLabelText("部署实时输出")).toHaveClass("live-log-viewer");
  expect(screen.getByLabelText("Agent 输出：agent-job-1")).toHaveClass("live-log-viewer");
});
```

```python
def test_executor_falls_back_to_windows_code_page_when_utf8_decode_fails() -> None:
    assert decode_cli_output("中文".encode("gbk")) == "中文"
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm --workspace @workflow-platform/renderer run test -- RunDashboard`

Run: `cd runtime; python -m pytest tests/test_execution_cli.py -k windows_code_page -q`

Expected: FAIL，视窗 class 和解码函数不存在。

- [ ] **Step 3: 实现固定日志和回退解码**

为部署和自动 Agent 输出使用：

```tsx
<section className="live-log-viewer" aria-label={`Agent 输出：${job.id}`}>
  <pre>{events.map((event) => formatAgentPayload(event.payload)).join("\n")}</pre>
</section>
```

CSS：

```css
.live-log-viewer {
  max-height: clamp(14rem, 34vh, 26rem);
  overflow: auto;
  border: 1px solid #273449;
  border-radius: 6px;
  background: #111827;
}
.live-log-viewer pre {
  min-width: max-content;
  margin: 0;
  padding: 12px;
  color: #e5f7ef;
}
```

在 `execution/cli.py` 中将读取从 `text=True` 改为字节流，并新增：

```python
def decode_cli_output(data: bytes) -> str:
    for encoding in ("utf-8", "utf-8-sig", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")
```

读取线程累计字节并以 `decode_cli_output(line)` 传给 Provider，继续按 UTF-8 计算输出上限。不要改变非 Windows UTF-8 的已有输出行为。

- [ ] **Step 4: 运行定向测试确认通过**

Run: `npm --workspace @workflow-platform/renderer run test -- RunDashboard`

Run: `cd runtime; python -m pytest tests/test_execution_cli.py -k "windows_code_page or executor" -q`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/renderer/src/features/runs/RunDashboard.tsx apps/renderer/src/features/runs/RunDashboard.test.tsx apps/renderer/src/app/styles.css runtime/src/workflow_platform/execution/cli.py runtime/tests/test_execution_cli.py
git commit -m "fix: bound live logs and normalize Chinese output"
```

## Task 9: 端到端验证交互继续与打包版本

**Files:**
- Modify: `tests/e2e/desktop-electron.spec.ts`
- Modify: `tests/e2e/desktop-packaged.spec.ts`
- Modify: `tests/e2e/desktop-installed.spec.ts`

- [ ] **Step 1: 写入失败开发版 E2E**

在 `desktop-electron.spec.ts` 创建临时 `codex.cmd`：

```bat
@echo off
echo Agent 需要你的回复：请输入目标分支
set /p answer=
echo 已收到：%answer%
```

测试动作：

```ts
await window.getByLabel("Agent 模式").selectOption("interactive");
await window.getByLabel("Agent Provider").selectOption("codex");
await window.getByLabel("Agent 提示语").fill("询问目标分支");
await window.getByRole("button", { name: "启动 Agent" }).click();
await expect(window.getByLabel("Agent 交互终端")).toContainText("请输入目标分支");
await window.getByLabel("Agent 交互终端").pressSequentially("release");
await window.getByLabel("Agent 交互终端").press("Enter");
await expect(window.getByLabel("Agent 交互终端")).toContainText("已收到：release");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx playwright test tests/e2e/desktop-electron.spec.ts -g "交互式 Agent"`

Expected: FAIL，因为模式和 Agent Xterm 不存在。

- [ ] **Step 3: 更新已打包/已安装回归**

将所有旧的：

```ts
window.getByLabel("终端输入").fill("echo installed-terminal-e2e");
window.getByRole("button", { name: "发送输入" }).click();
window.getByLabel("终端输出")
```

替换为聚焦 `ANSI 终端` 后的 `pressSequentially()`、`press("Enter")` 和 `ANSI 终端` 输出断言。新增高度断言：

```ts
const box = await window.getByLabel("Agent 交互终端").boundingBox();
expect(box?.height).toBeGreaterThan(300);
expect(box?.height).toBeLessThan(700);
```

使用含中文回显的 fake CLI，断言 Xterm 可见“已收到：发布分支”而不是替换字符 `�`。

- [ ] **Step 4: 运行开发版 E2E**

Run: `npm.cmd run test:e2e`

Expected: PASS，原终端、危险命令审批、恢复、交互 Agent 和现有工作流回归均通过。

- [ ] **Step 5: 运行构建与打包验证**

Run: `npm.cmd run verify`

Expected: PASS。

Run: `npm.cmd run build`

Expected: PASS。

Run: `npm.cmd run package:win:full`

Expected: 生成 Runtime EXE、免安装包和 NSIS 安装包。

Run: `npm.cmd run test:e2e:packaged`

Expected: PASS。

将新安装程序路径传给既有安装版测试后运行：

Run: `set INSTALLED_DESKTOP_EXE=<安装后的 AI Workflow Platform.exe>&& npm.cmd run test:e2e:installed`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add tests/e2e/desktop-electron.spec.ts tests/e2e/desktop-packaged.spec.ts tests/e2e/desktop-installed.spec.ts
git commit -m "test: cover interactive agent terminals end to end"
```

## Task 10: 更新中文使用说明与最终验证

**Files:**
- Modify: `README.md`
- Modify: `docs/remaining-work-and-acceptance.zh-CN.md`

- [ ] **Step 1: 写入文档验收清单**

README 新增“交互式 Agent”章节，必须说明：

```markdown
1. 在“运行”页面创建 Run。
2. 选择 Agent Provider 和“交互式”模式。
3. 启动后直接在 Agent 终端中输入；Enter 发送，Ctrl+C 中断。
4. 自动执行模式不支持中途对话；使用“继续为交互会话”保留任务转录。
5. 应用异常退出后可恢复的是转录和上下文，不是原操作系统进程。
```

验收文档增加 Run 交互会话、单一 Xterm 输入、中文输出、固定日志高度、自动跟随和打包 E2E 的验收证据入口。

- [ ] **Step 2: 运行全量验证**

Run: `npm.cmd run verify`

Expected: 所有 Renderer、Desktop、Runtime 测试通过。

Run: `npm.cmd run test:e2e`

Expected: 所有适用开发版 E2E 通过。

- [ ] **Step 3: 最终提交**

```bash
git add README.md docs/remaining-work-and-acceptance.zh-CN.md
git commit -m "docs: explain interactive agent terminal workflow"
```
