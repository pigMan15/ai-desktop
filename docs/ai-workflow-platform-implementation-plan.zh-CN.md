# AI 工程工作流平台实施计划

## 1. 文档目标

本文档用于指导新仓库从零实现 AI 工程工作流平台。

配套架构文档：

```text
ai-workflow-platform-development-spec.zh-CN.md
```

本文档关注：

- MVP 范围。
- 推荐目录结构。
- 数据库 Schema。
- RPC/API Contract。
- Canonical Workflow Schema。
- 状态机 Transition Spec。
- Adapter 开发规范。
- Agent Provider 规范。
- UI 页面规格。
- 测试计划。
- 开发里程碑。

## 2. MVP 范围

MVP 必须完成：

```text
Project import
Adapter detection
Harness Adapter import
Canonical Workflow storage
Workflow versioning
Run creation
Event-sourced Run state
Workflow transition engine
Allowed actions
Approval
Gate
Artifact metadata
Terminal session
LangGraph AgentExecutor provider
Run timeline
Basic Workflow viewer
Basic Run dashboard
Recovery projection rebuild
```

MVP 延后：

```text
Workflow visual editor
GitHub Actions Adapter
LlamaIndex provider
CrewAI provider
AutoGen provider
Remote Runtime
Advanced Knowledge publishing
Full protocol conversion
Marketplace plugin system
```

## 3. 推荐仓库结构

```text
ai-workflow-platform/
  apps/
    desktop/
      src/
        main/
        preload/
    renderer/
      src/
        app/
        features/
          projects/
          workflow/
          runs/
          terminal/
          gates/
          artifacts/
          approvals/
          recovery/
          settings/
  packages/
    contracts/
      src/
        rpc.ts
        workflow.ts
        events.ts
        errors.ts
  runtime/
    src/
      workflow_platform/
        main.py
        api/
        adapters/
        kernel/
        compiler/
        execution/
        persistence/
        artifacts/
        gates/
        approvals/
        terminals/
        recovery/
        security/
    tests/
  docs/
  scripts/
```

## 4. 数据库 Schema

推荐使用 SQLite。

### 4.1 projects

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  active_protocol TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 4.2 workflow_versions

```sql
CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 4.3 runs

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  context_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 4.4 run_events

```sql
CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  node_id TEXT,
  actor_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);
```

### 4.5 run_projections

```sql
CREATE TABLE run_projections (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  current_node_ids_json TEXT NOT NULL,
  node_states_json TEXT NOT NULL,
  allowed_actions_json TEXT NOT NULL,
  blocking_reasons_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 4.6 artifacts

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  uri TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  producer_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 4.7 approvals

```sql
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_by_json TEXT NOT NULL,
  decided_by_json TEXT,
  comment TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
```

### 4.8 gate_results

```sql
CREATE TABLE gate_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 4.9 terminal_sessions

```sql
CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  cwd TEXT NOT NULL,
  pid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 5. RPC/API Contract

### 5.1 Project APIs

```ts
project.detect(rootPath): DetectionResult[]
project.import(request): ProjectSummary
project.get(projectId): ProjectDetail
project.list(): ProjectSummary[]
```

### 5.2 Workflow APIs

```ts
workflow.get(projectId): WorkflowDetail
workflow.import(projectId, adapterId): WorkflowVersion
workflow.compile(definition): CompileResult
workflow.simulate(workflowVersionId, input): SimulationResult
workflow.versions(projectId): WorkflowVersion[]
```

### 5.3 Run APIs

```ts
run.create(request): RunProjection
run.get(runId): RunProjection
run.timeline(runId): RunEvent[]
run.transition(runId, event, expectedRevision): TransitionResult
run.pause(runId): RunProjection
run.resume(runId): RunProjection
run.archive(runId): RunProjection
```

### 5.4 Terminal APIs

```ts
terminal.create(request): TerminalSession
terminal.write(sessionId, data): void
terminal.resize(sessionId, cols, rows): void
terminal.stop(sessionId): TerminalSession
terminal.restart(sessionId): TerminalSession
terminal.scrollback(sessionId): TerminalScrollback
```

### 5.5 Approval APIs

```ts
approval.list(projectId): ApprovalSummary[]
approval.decide(request): TransitionResult
```

### 5.6 Gate APIs

```ts
gate.list(runId): GateState[]
gate.submitResult(request): TransitionResult
gate.waive(request): TransitionResult
```

## 6. Canonical Workflow Schema

### 6.1 WorkflowDefinition

```ts
type WorkflowDefinition = {
  id: string
  name: string
  version: string
  sourceAdapter: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  roles: RoleDefinition[]
  gates: GateDefinition[]
  policies: WorkflowPolicy
  metadata: Record<string, unknown>
}
```

### 6.2 WorkflowNode

```ts
type WorkflowNode = {
  id: string
  name: string
  kind: 'task' | 'agent' | 'approval' | 'gate' | 'evidence' | 'deploy' | 'report' | 'composite'
  role?: string
  description?: string
  requires?: RequirementSpec[]
  gates?: string[]
  retryPolicy?: RetryPolicy
  timeoutPolicy?: TimeoutPolicy
  metadata?: Record<string, unknown>
}
```

### 6.3 RequirementSpec

```ts
type RequirementSpec =
  | { type: 'artifact'; artifactType: string; required: boolean }
  | { type: 'approval'; approvalRole?: string; required: boolean }
  | { type: 'gate'; gateId: string; required: boolean }
  | { type: 'evidence'; evidenceType: string; required: boolean }
```

## 7. 状态机 Transition Spec

### 7.1 通用事件

```text
RUN_CREATED
NODE_STARTED
ARTIFACT_SUBMITTED
APPROVAL_REQUESTED
HUMAN_APPROVED
HUMAN_REJECTED
HUMAN_DEFERRED
GATE_STARTED
GATE_PASSED
GATE_FAILED
GATE_WAIVED
NODE_COMPLETED
NODE_FAILED
NODE_RETRIED
RUN_BLOCKED
RUN_COMPLETED
RUN_ARCHIVED
```

### 7.2 基础转换

```text
PENDING + NODE_STARTED -> RUNNING
RUNNING + ARTIFACT_SUBMITTED -> AWAITING_APPROVAL | AWAITING_GATE | PASSED
AWAITING_APPROVAL + HUMAN_APPROVED -> AWAITING_GATE | PASSED
AWAITING_APPROVAL + HUMAN_REJECTED -> BLOCKED
AWAITING_APPROVAL + HUMAN_DEFERRED -> AWAITING_APPROVAL
AWAITING_GATE + GATE_PASSED -> PASSED
AWAITING_GATE + GATE_FAILED -> FAILED | BLOCKED
FAILED + NODE_RETRIED -> RUNNING
PASSED -> next node READY
last node PASSED -> RUN DONE
```

### 7.3 Guard Rules

```text
HUMAN_APPROVED requires actor.type = human
GATE_PASSED requires actor.type = verifier or system
NODE_COMPLETED cannot be submitted externally
ARTIFACT_SUBMITTED requires artifact exists and safe path validation passes
GATE_WAIVED requires waiver reason and authorized actor
transition requires expectedRevision match
```

## 8. Adapter 开发规范

Adapter 必须实现：

```text
detect
importWorkflow
capabilities
```

可选实现：

```text
importRuns
exportWorkflow
exportSnapshot
repair
diagnose
```

Adapter 输出必须是 Canonical WorkflowDefinition，不得输出 Runtime 内部状态。

Harness Adapter MVP 映射：

```text
workflow.yaml nodes -> WorkflowNode
workflow.yaml routes -> WorkflowEdge
workflow.yaml gates -> GateDefinition
state.json run_id -> WorkflowRun.id
state.json completed_nodes -> imported Run projection only
phase_dir files -> Artifact metadata
```

## 9. Agent Provider 规范

Agent Provider 只能实现接口，不能修改 Run 状态。

```ts
interface AgentExecutor {
  start(request: AgentExecutionRequest): Promise<ExecutionHandle>
  resume(handle: ExecutionHandle, input: ResumeInput): Promise<ExecutionResult>
  stop(handle: ExecutionHandle): Promise<void>
}
```

ExecutionResult：

```ts
type ExecutionResult = {
  status: 'completed' | 'interrupted' | 'failed' | 'cancelled'
  artifacts?: ArtifactRef[]
  evidence?: EvidenceRef[]
  messages?: AgentMessage[]
  checkpoint?: CheckpointRef
  error?: ExecutionError
}
```

LangGraph Provider MVP：

```text
start agent node
persist checkpoint ref
support interrupt/resume
normalize output to ExecutionResult
never emit human approval
never pass gate directly
```

## 10. UI 页面规格

### 10.1 Project Dashboard

显示：

```text
项目名称
项目路径
识别到的 Adapter
Workflow 版本
活跃 Runs
诊断状态
```

操作：

```text
Import Workflow
Create Run
Open Workflow
Open Settings
```

### 10.2 Run Dashboard

显示：

```text
Run 状态
当前节点
节点 Timeline
Allowed Actions
Blocking Reasons
Artifact/Evidence
Approval/Gate 状态
```

操作：

```text
Start Node
Submit Artifact
Open Terminal
Request Approval
Run Gate
Retry
Archive
```

### 10.3 Terminal

显示：

```text
Session 状态
绑定 Run
绑定 Node
Terminal output
Scrollback
```

操作：

```text
Create Codex Terminal
Create Shell Terminal
Write
Resize
Stop
Restart
Attach Output as Evidence
```

### 10.4 Approval Inbox

显示：

```text
待确认节点
请求说明
Artifact
Evidence
风险
历史评论
```

操作：

```text
Accept
Reject
Defer
Comment
```

### 10.5 Gates

显示：

```text
Gate 列表
状态
Evidence
Waiver
Retry count
```

操作：

```text
Submit PASS
Submit FAIL
Waive
Retry
```

## 11. 测试计划

### 11.1 Unit Tests

```text
Canonical schema validation
Workflow compiler
Transition guards
Allowed actions
Projection rebuild
Adapter import
Gate policy
Approval policy
```

### 11.2 Contract Tests

```text
RPC request/response
error codes
revision conflict
permission denied
provider normalization
```

### 11.3 Integration Tests

```text
project import -> workflow version
run create -> node ready
submit artifact -> awaiting approval
approval accept -> awaiting gate
gate pass -> next node
gate fail -> recovery
projection rebuild from events
```

### 11.4 E2E Tests

```text
import project
create run
open terminal
submit artifact
approve
pass gate
finish run
recover after restart
```

## 12. 开发里程碑

### M1：基础工程和 Contracts

交付：

```text
monorepo structure
Electron shell
React renderer
Python runtime
typed RPC
SQLite migrations
shared contracts
```

验收：

```text
App 启动
Renderer 可调用 Runtime health API
数据库可迁移
contract tests 通过
```

### M2：Canonical Model 和 Adapter

交付：

```text
WorkflowDefinition schema
AdapterRegistry
HarnessAdapter import
WorkflowVersion storage
Diagnostics
```

验收：

```text
能导入一个 Harness-like 项目
能生成 canonical workflow
能保存 workflow version
```

### M3：Event Store 和 Kernel

交付：

```text
run_events
run_projections
transition engine
allowed actions
guard rules
projection rebuild
```

验收：

```text
Run 可创建
状态由 events 推进
UI 不直接完成节点
projection 可重建
```

### M4：Approval / Gate / Artifact

交付：

```text
Artifact store
Approval runtime
Gate runtime
Evidence binding
Waiver
Retry
```

验收：

```text
Agent 不能确认
Terminal 不能完成节点
Gate 需要 evidence
Fail 可回退或 BLOCKED
```

### M5：Terminal 和 Agent Provider

交付：

```text
node-pty terminal
xterm.js UI
LangGraph AgentExecutor
checkpoint ref
interrupt/resume
ExecutionResult normalization
```

验收：

```text
Terminal 可运行
输出可转 evidence
LangGraph 节点可 checkpoint
Agent 输出不能绕过 Kernel
```

### M6：UI MVP

交付：

```text
Project Dashboard
Run Dashboard
Workflow Viewer
Terminal Page
Approval Inbox
Gate Page
Artifact Page
Recovery Page
```

验收：

```text
用户能完整走通一条 Run
所有按钮来自 allowed actions
阻塞原因清晰展示
中断后可恢复
```

## 13. MVP Done Definition

MVP 完成必须满足：

```text
一个项目可导入
一个 workflow 可编译
一个 run 可创建
一个 terminal 可绑定 run/node
一个 artifact 可提交
一个 approval 可人工确认
一个 gate 可通过或失败
一个 run 可完成
状态可从 events 重建
UI 无绕过 Kernel 的推进路径
LangGraph 仅作为 AgentExecutor provider
```

