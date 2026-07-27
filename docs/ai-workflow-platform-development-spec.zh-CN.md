# AI 工程工作流平台开发设计文档

## 1. 产品定位

本产品定位为通用 AI 工程工作流平台。

它不应该被设计成 `.harness` 文件编辑器、单一 Codex Terminal，或固定流程看板。它应该抽取 `.harness` 背后的工程化思想，并通过框架化 Runtime 实现。

核心定位：

```text
AI 工程工作流运行器
= Workflow Kernel
+ Adapter 插件系统
+ Agent 执行运行时
+ 事件驱动的 Run 状态
+ 人工确认 / Gate / Evidence 治理
```

`.harness` 只是其中一种受支持的项目协议。其他项目格式只要能表达类似的概念，例如 workflow 节点、门禁、人工确认、产物、证据、角色或失败恢复策略，也应该可以接入软件。

## 2. 目标

- 移除对 `.harness` 目录结构的强绑定。
- 定义稳定的统一工作流领域模型。
- 支持多种项目协议 Adapter。
- 引入成熟执行框架处理图执行和 Agent 执行。
- 保持工作流推进确定、可审计、可恢复。
- 防止 Agent 或 Terminal 绕过人工确认和门禁。
- 保留现有桌面工程能力，例如 Terminal、Git worktree、merge back、Recovery、Diagnostics、Artifacts、Knowledge。

## 3. 非目标

- 不把 `.harness/workflow.yaml` 扩展成万能 DSL。
- 不让外部文件直接驱动 Runtime 状态。
- 不允许 Renderer、Terminal 或 Agent 直接标记节点完成。
- 不把 Terminal 进程退出视为节点完成。
- 不允许模型输出自动变成人工确认。
- 不让 LangGraph 成为可信治理边界。

## 4. 总体架构

```text
Renderer UI
  -> Application RPC
  -> Workflow Kernel
  -> Workflow Compiler
  -> Execution Runtime
      -> Agent Runner
      -> Terminal Runner
      -> Gate Runner
      -> Approval Runtime
  -> Persistence Layer
      -> SQLite Event Store
      -> Run Projection Store
      -> Artifact Store
      -> Audit Log
  -> Adapter Layer
      -> Harness Adapter
      -> Markdown Checklist Adapter
      -> Generic YAML Adapter
      -> GitHub Actions Adapter
      -> Custom Plugin Adapter
```

## 5. 核心架构原则

1. 内部模型优先。
   应用 Runtime 只操作统一工作流模型，不直接依赖文件结构。

2. Adapter 作为边界。
   文件、目录、YAML、JSON、Markdown 或远程系统都必须通过 Adapter 导入。

3. 事件驱动状态。
   Run 状态由事件推导。Projection 表只作为快速读取模型。

4. 唯一状态推进入口。
   所有 workflow 推进必须通过 `transition(runId, event, expectedRevision)`。

5. 治理优先于执行。
   人工确认、Gate、Artifact 校验、重试策略和失败恢复由 Workflow Kernel 强制执行。

6. Agent 框架只是执行器。
   LangGraph 等框架可以执行 Agent 节点，但不能绕过 Kernel 策略。

7. 文件只是导入、导出和快照。
   文件用于兼容、审查和迁移，但不作为运行时事实源。

## 6. 主要模块

### 6.1 Renderer UI

职责：

- 项目导入和协议识别。
- Workflow 可视化和编辑。
- Run Dashboard 和 Timeline。
- Terminal 和 Agent 执行面板。
- Approval Inbox。
- Gate Dashboard。
- Artifact 和 Evidence 浏览。
- Knowledge 审核和发布。
- Recovery 和 Diagnostics。
- Settings。

Renderer 不得直接访问 shell、文件系统或可信 workflow 状态。

### 6.2 Application RPC

职责：

- 在 Renderer 和 Runtime 之间提供类型化 API。
- 校验请求结构。
- 附加 actor 身份。
- 强制能力边界。
- 返回 Runtime 计算出的 allowed actions。

示例 API：

```ts
project.import(request)
workflow.get(projectId)
workflow.compile(definition)
workflow.simulate(workflowId, input)
run.create(request)
run.get(runId)
run.transition(runId, event, expectedRevision)
run.timeline(runId)
terminal.create(request)
terminal.write(sessionId, data)
artifact.get(artifactId)
gate.submitResult(request)
approval.decide(request)
knowledge.generateCandidates(runId)
```

### 6.3 Workflow Kernel

职责：

- 维护统一 workflow 语义。
- 校验状态转换。
- 计算当前节点和 allowed actions。
- 强制人工确认要求。
- 强制 Gate 要求。
- 强制 Artifact 和 Evidence 要求。
- 应用 retry 和 recovery policy。
- 生成 Run projection。
- 记录 audit event。

Workflow Kernel 是系统的可信边界。

### 6.4 Workflow Compiler

职责：

- 将统一 WorkflowDefinition 编译为可执行图。
- 校验节点、边、角色、Gate、Artifact 和 Policy。
- 生成诊断信息。
- 生成 UI 可视化模型。
- 生成 Agent 节点的执行计划。

输出：

```ts
type CompiledWorkflow = {
  workflowId: string
  versionId: string
  nodes: CompiledNode[]
  edges: CompiledEdge[]
  diagnostics: Diagnostic[]
  graphSpec: GraphSpec
}
```

### 6.5 Adapter Layer

Adapter 负责将外部项目协议转换为统一模型。

接口：

```ts
interface WorkflowAdapter {
  id: string
  name: string
  detect(projectRoot: string): Promise<DetectionResult>
  importWorkflow(projectRoot: string): Promise<WorkflowDefinition>
  importRuns?(projectRoot: string): Promise<WorkflowRun[]>
  exportWorkflow?(workflow: WorkflowDefinition, target: string): Promise<void>
  exportSnapshot?(run: RunProjection, target: string): Promise<void>
  capabilities(): AdapterCapabilities
}
```

首批 Adapter：

- Harness Adapter
- Markdown Checklist Adapter
- Generic YAML Adapter

后续 Adapter：

- GitHub Actions Adapter
- Jira / Linear Adapter
- Remote Workflow Adapter
- Custom Plugin Adapter

### 6.6 Execution Runtime

职责：

- 启动、停止、恢复执行会话。
- 执行 Agent 节点。
- 执行 Terminal 命令。
- 执行 Gate 检查。
- 处理人工任务。
- 将执行结果转换为 Runtime Event。

Executor 类型：

```text
AgentExecutor
TerminalExecutor
ManualTaskExecutor
GateExecutor
DeployExecutor
ReportExecutor
```

### 6.7 Agent Runner

默认可以使用 LangGraph 作为 Agent Runner，但核心系统不得绑定 LangGraph。

职责：

- 执行 AI / Agent 节点。
- 支持 checkpoint。
- 支持 interrupt / resume。
- 支持条件路由。
- 支持多步骤 Agent flow。

限制：

- 不能直接完成 workflow node。
- 不能直接提交 human approval。
- 不能直接通过 Gate。
- 必须将结果报告为 Workflow Kernel 可处理的事件。

### 6.8 框架集成与反锁定策略

平台不应该变成 LangGraph App、LangChain App，或多个 Agent 框架的大杂烩。产品应该是一个工作流平台，Agent 框架只是可替换执行 Provider。

核心规则：

```text
Core 拥有领域模型。
Provider 拥有框架特定执行。
Adapter 在 Provider 和 Core Contract 之间转换。
```

核心模型、数据库表、RPC Contract 和 UI 状态都不应该暴露框架原生对象，例如 LangGraph state、LangChain tool、LlamaIndex index、CrewAI crew 或 AutoGen message。

框架通过稳定内部端口接入：

```ts
interface AgentExecutor {
  start(request: AgentExecutionRequest): Promise<ExecutionHandle>
  resume(handle: ExecutionHandle, input: ResumeInput): Promise<ExecutionResult>
  stop(handle: ExecutionHandle): Promise<void>
}

interface ToolProvider {
  listTools(context: ToolContext): Promise<ToolDefinition[]>
  invokeTool(request: ToolInvokeRequest): Promise<ToolResult>
}

interface KnowledgeProvider {
  index(request: KnowledgeIndexRequest): Promise<KnowledgeIndexResult>
  search(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult>
  retrieve(request: KnowledgeRetrieveRequest): Promise<KnowledgeDocument[]>
}

interface CheckpointProvider {
  createCheckpoint(request: CheckpointRequest): Promise<CheckpointRef>
  resumeCheckpoint(ref: CheckpointRef): Promise<CheckpointState>
}
```

默认 Provider 策略：

```text
Workflow Kernel：平台自研。
AgentExecutor：默认 LangGraph Provider。
ToolProvider：原生 schema-based provider，可选 MCP / LangChain 支持。
KnowledgeProvider：先做轻量本地实现，可选 LlamaIndex 支持。
TracingProvider：先做原生 audit event，可选 OpenAI Agents SDK 风格 trace。
```

依赖分层：

```text
Core Dependencies
  SQLite
  schema validation
  typed RPC contracts
  event store
  state machine rules
  audit and security utilities

Default Optional Providers
  LangGraph AgentExecutor
  MCP-compatible ToolProvider
  lightweight local KnowledgeProvider

Experimental Providers
  LangChain ToolProvider
  LlamaIndex KnowledgeProvider
  OpenAI Agents SDK Executor / Tracing Provider
  CrewAI multi-agent provider
  AutoGen distributed agent provider
```

反锁定约束：

- 领域模型不得 import provider-specific class。
- 数据库不得将 provider-native object 存为权威状态。
- RPC 不得暴露 provider-native structure。
- UI 只能渲染平台 projection，不直接渲染 provider internals。
- Agent 输出必须归一化为 `ExecutionResult`。
- Tool 调用必须经过 `ToolProvider`。
- Checkpoint 必须使用平台自有的 `CheckpointRef`。
- Provider 升级或替换不得改变 Run、Event、Artifact、Gate、Approval schema。

推荐第一版实现：

```text
先构建稳定 Kernel。
先构建 Provider Interface。
只交付一个默认 LangGraph AgentExecutor。
其他框架保持 optional 或 experimental。
```

### 6.9 Persistence Layer

推荐使用 SQLite 作为本地持久化。

核心表：

```text
projects
project_protocols
workflow_definitions
workflow_versions
workflow_adapters
runs
run_events
run_projections
artifacts
evidence
approvals
gates
gate_results
terminal_sessions
agent_sessions
knowledge_candidates
audit_events
settings
```

运行时事实源：

```text
run_events
```

快速读取模型：

```text
run_projections
```

## 7. 统一领域模型

### 7.1 WorkflowDefinition

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

### 7.2 WorkflowNode

```ts
type WorkflowNode = {
  id: string
  name: string
  kind: NodeKind
  role?: string
  description?: string
  inputs?: InputSpec[]
  outputs?: OutputSpec[]
  requires?: RequirementSpec[]
  gates?: string[]
  retryPolicy?: RetryPolicy
  timeoutPolicy?: TimeoutPolicy
  metadata?: Record<string, unknown>
}
```

### 7.3 NodeKind

```text
task
agent
approval
gate
evidence
deploy
report
composite
```

### 7.4 WorkflowEdge

```ts
type WorkflowEdge = {
  id: string
  from: string
  to: string
  condition?: string
  trigger?: TransitionTrigger
  metadata?: Record<string, unknown>
}
```

### 7.5 WorkflowRun

```ts
type WorkflowRun = {
  id: string
  projectId: string
  workflowVersionId: string
  status: RunStatus
  currentNodeIds: string[]
  context: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
```

### 7.6 RunEvent

```ts
type RunEvent = {
  id: string
  runId: string
  type: RunEventType
  nodeId?: string
  actor: Actor
  payload: Record<string, unknown>
  createdAt: string
  revision: string
}
```

### 7.7 RunEventType

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

### 7.8 Actor

```ts
type Actor = {
  id: string
  type: 'human' | 'agent' | 'system' | 'verifier' | 'executor' | 'adapter'
  source: 'renderer' | 'runtime' | 'terminal' | 'agent' | 'adapter'
  trusted: boolean
}
```

## 8. 状态机设计

节点状态：

```text
PENDING
READY
RUNNING
AWAITING_ARTIFACT
AWAITING_APPROVAL
AWAITING_GATE
PASSED
FAILED
BLOCKED
SKIPPED
```

Run 状态：

```text
CREATED
IN_PROGRESS
REVIEWING
BLOCKED
DONE
ARCHIVED
```

唯一推进入口：

```ts
transition(runId, event, expectedRevision): TransitionResult
```

返回：

```ts
type TransitionResult = {
  run: RunProjection
  accepted: boolean
  revision: string
  allowedActions: Action[]
  blockingReasons: BlockingReason[]
  emittedEvents: RunEvent[]
}
```

## 9. 治理规则

必需规则：

- Human approval 只能由 trusted human actor 产生。
- Agent actor 不能产生 `HUMAN_APPROVED`。
- Terminal session 不能产生 `NODE_COMPLETED`。
- Gate pass/fail 只能由授权 verifier/runtime actor 产生。
- 每个 Gate result 必须引用 evidence 或 explicit waiver。
- 每个 node completion 必须由 Kernel 校验推导。
- 每次状态变化必须追加 event。
- 每个 projection 必须可由 events 重建。
- 每个风险操作必须生成 audit event。

## 10. 功能范围

### 10.1 Project Management

- 导入项目。
- 识别可用协议。
- 初始化协议。
- 修复协议。
- 显示兼容性诊断。
- 归档项目。
- 管理项目设置。

### 10.2 Workflow Management

- Workflow 可视化编辑。
- 节点编辑。
- 边和路由编辑。
- 角色编辑。
- Artifact 要求编辑。
- Gate 策略编辑。
- Failure recovery 编辑。
- Workflow 版本历史。
- Semantic diff。
- Workflow simulation。
- Import / Export。
- 协议转换。

### 10.3 Run Management

- 创建 Run。
- 选择 workflow 版本。
- 配置 run 参数。
- 暂停 Run。
- 恢复 Run。
- 归档 Run。
- 展示 timeline。
- 展示当前节点。
- 展示 allowed actions。
- 支持多个并发 Run。
- 从事件重建 Run 状态。

### 10.4 Execution

- Agent 执行。
- Codex terminal 执行。
- Shell terminal 执行。
- Manual task 执行。
- Gate 执行。
- Deploy 执行。
- Report 生成。
- Checkpoint。
- Interrupt / resume。
- Retry。
- Timeout handling。

### 10.5 Terminal

- Codex Terminal。
- Shell Terminal。
- Run-bound session。
- Node-bound session。
- ANSI 支持。
- Unicode 支持。
- 复制粘贴。
- 搜索。
- Resize。
- Scrollback。
- Ctrl+C。
- Stop。
- Restart。
- Session recovery。
- 输出脱敏。
- 输出转 Evidence。

### 10.6 Approval

- Approval inbox。
- Approval request view。
- Accept。
- Reject。
- Defer。
- Comment。
- Actor 记录。
- Timestamp 记录。
- Permission validation。
- 防止 Agent 代签。

### 10.7 Gates

- Gate dashboard。
- Automatic gate。
- Manual gate。
- Verifier-only decision。
- Waiver。
- Retry。
- Failure recovery。
- BLOCKED routing。
- Evidence binding。
- Gate report。

### 10.8 Artifacts and Evidence

- Artifact browser。
- Markdown preview。
- Text preview。
- Hashing。
- Provenance tracking。
- Safe path resolution。
- Diff。
- Evidence package。
- Report export。

### 10.9 Git and Workspace

- 独立 branch。
- 独立 worktree。
- Worktree 创建。
- Worktree 清理。
- Dirty check。
- Detached HEAD check。
- Merge back。
- Fast-forward strategy。
- Conflict guard。
- Commit assistance。
- Push assistance。

### 10.10 Knowledge

- Knowledge candidate generation。
- Candidate review。
- Accepted queue。
- Shared knowledge repository。
- Agent synthesis。
- Diff preview。
- Human feedback。
- Push via App。
- Pushed count。
- Knowledge replay。

### 10.11 Recovery and Diagnostics

- Run recovery。
- Terminal recovery。
- Agent checkpoint recovery。
- Orphan session cleanup。
- Projection rebuild。
- Event log validation。
- Diagnostic export。
- Secret redaction。

### 10.12 Settings and Security

- Codex CLI discovery。
- Manual executor selection。
- Adapter settings。
- Credential boundary。
- Local runtime token。
- Path sandbox。
- Command approval。
- Dangerous operation guard。
- Audit log。

## 11. 用户工作流

### 11.1 导入项目

```text
用户选择项目目录。
Adapter Registry 扫描目录。
兼容 Adapter 返回检测结果。
用户选择协议。
Runtime 导入 WorkflowDefinition。
Runtime 创建 WorkflowVersion。
打开项目 Dashboard。
```

### 11.2 创建 Run

```text
用户选择项目。
用户点击 New Run。
用户选择 Workflow Version。
用户输入任务目标。
用户配置 Run 参数。
Runtime 创建 Run。
如需要则创建 branch/worktree。
Kernel 计算初始节点。
UI 展示当前节点和 allowed actions。
```

### 11.3 执行节点

```text
用户打开 Run。
用户查看当前节点。
用户启动 Terminal 或 Agent。
Executor 执行任务。
Executor 产生 artifact 或 evidence。
用户提交 artifact/evidence。
Runtime 校验提交。
Kernel 判断 approval 和 gate 要求。
Kernel 推进、阻塞或等待。
```

### 11.4 人工确认

```text
Run 进入 AWAITING_APPROVAL。
UI 展示 approval request。
用户查看 artifact 和 evidence。
用户 accept、reject 或 defer。
Kernel 校验 human actor。
Runtime 记录 approval event。
Run 继续、阻塞或保持 reviewing。
```

### 11.5 Gate 验证

```text
Run 进入 AWAITING_GATE。
Verifier 执行检查。
Verifier 提交 gate result。
Runtime 校验 evidence。
PASS 允许继续。
FAIL 触发 recovery policy。
失败超过上限后 Run BLOCKED。
Waiver 必须记录原因和授权 actor。
```

### 11.6 Merge Back

```text
Run 到达 DONE。
用户打开 Merge Back。
Runtime 检查目标 worktree 是否 clean。
Runtime 检查 run worktree 是否 clean。
Runtime 检查 branch 状态。
UI 展示 merge preview。
用户确认。
Runtime 执行 fast-forward merge。
Runtime 记录 audit event。
Run 标记 merged 或 archived。
```

### 11.7 Knowledge Promotion

```text
Run 完成。
Runtime 生成 knowledge candidates。
用户审核 candidates。
用户接受选中的 candidates。
Agent 合成 knowledge repository changes。
UI 展示 diff。
用户反馈或确认。
Runtime commit 并 push。
Candidate 标记 pushed。
```

### 11.8 Recovery

```text
App 启动或项目打开。
Recovery 扫描 runs、terminal sessions 和 checkpoints。
UI 展示可恢复项。
用户选择 recover、stop 或 cleanup。
Runtime 从 events 重建 projections。
用户从 allowed actions 继续。
```

## 12. 迁移计划

### Phase 1：Canonical Model 和 Adapter Registry

- 定义统一 workflow 类型。
- 新增 adapter registry。
- 实现 Harness Adapter import。
- 将 workflow versions 存入 SQLite。
- 通过 compatibility path 保留现有 `.harness` 行为。

### Phase 2：Event Store 和 Transition Runtime

- 新增 `run_events`。
- 新增 `run_projections`。
- 实现 `transition()`。
- 用 event submission 替代直接 complete node。
- 由 Kernel 生成 allowed actions。

### Phase 3：Workflow Compiler

- 编译统一 workflow definitions。
- 校验 nodes、edges、gates、roles、artifacts、policies。
- 支持 workflow simulation。
- 为 UI 生成 diagnostics。

### Phase 4：Agent Runner

- 定义 `AgentExecutor`、`ToolProvider`、`KnowledgeProvider`、`CheckpointProvider` ports。
- 将 LangGraph 作为默认 `AgentExecutor` provider。
- 增加 checkpoint 支持。
- 增加 interrupt / resume。
- 将 Agent 输出转换为 Runtime events。
- 保证 Agent provider 对象不进入 core model、database schema、RPC contract 和 UI state。

### Phase 5：UI Refactor

- Project import 改为 adapter-driven。
- Workflow Studio 编辑 canonical model。
- Run page 读取 projections。
- Terminal 提交 events。
- Approval 和 Gate 面板由 Kernel 驱动。

### Phase 6：Compatibility and Export

- 导出 `.harness` snapshots。
- 尽可能迁移旧 Runs。
- 保留 `.harness` 作为官方 Adapter。
- 增加 Markdown 和 Generic YAML adapters。

## 13. 验收标准

- 新 Run 不再以 `.harness/state.json` 作为事实源执行。
- `.harness` 项目仍可导入和运行。
- Run 状态可由 `run_events` 重建。
- Terminal 不能直接完成节点。
- Agent 不能提交 human approval。
- Gate decision 需要授权 actor。
- Gate result 需要 evidence 或 waiver。
- UI 只展示 Runtime 返回的 actions。
- Workflow 至少能从两种 Adapter 导入。
- 默认 Agent provider 支持 checkpoint 和 resume。
- LangGraph 可在 `AgentExecutor` 接口背后替换，不改变 Kernel、RPC 或 persistence schema。
- Provider-native object 不作为权威运行时状态保存。
- 现有 terminal、recovery、artifact、Git worktree、merge back 和 knowledge 能力被保留。

## 14. 最终产品形态

```text
文件是协议。
Adapter 翻译协议。
Workflow Kernel 强制治理。
Framework Provider 执行 Agent 工作流。
LangGraph 是默认 AgentExecutor，不是平台核心。
Event Store 记录事实。
Projection 驱动 UI。
Artifact 和 Evidence 支撑审计。
人工确认和 Gate 不可绕过。
```

最终产品应成为通用 AI 工程工作流平台，能够支持 `.harness` 以及未来多种 workflow protocol，而不将 Runtime 硬编码绑定到任何一种文件布局。

## 15. UI 设计声明

UI 的定位是“工程工作流操作台”，不是营销页、聊天窗口或文件浏览器。界面必须帮助用户清楚理解当前 Run 的状态、阻塞原因、可执行动作、证据和风险。

核心 UI 原则：

- UI 只展示 Runtime 返回的 projection 和 allowed actions。
- UI 不自行推断节点是否可完成。
- UI 不直接读取或写入 workflow 状态文件。
- UI 不直接访问 shell 或文件系统。
- UI 上所有推进按钮都必须对应 Runtime event。
- 高风险动作必须显示确认、影响范围和审计记录。
- Approval、Gate、Artifact、Terminal 状态必须在同一 Run 上下文中可追踪。

主导航建议：

```text
Projects
Runs
Workflow
Terminal
Gates
Artifacts
Knowledge
Recovery
Settings
```

核心页面：

```text
Project Dashboard
  展示项目协议、Adapter、Workflow 版本、活跃 Run、诊断状态。

Run Dashboard
  展示当前节点、Run 状态、Timeline、Allowed Actions、阻塞原因。

Workflow Studio
  可视化编辑 canonical workflow model，支持 diff、版本、模拟和诊断。

Terminal
  展示 Run-bound / Node-bound session，支持 Codex 和 Shell 执行。

Approval Inbox
  展示待确认事项、证据、风险、历史决策和确认入口。

Gates
  展示 Gate 状态、验证结果、waiver、retry 和 evidence 绑定。

Artifacts
  展示产物列表、预览、hash、来源、diff 和 evidence package。

Knowledge
  展示知识候选、审核状态、合成过程、diff、push 状态。

Recovery
  展示可恢复 Run、Terminal、Agent checkpoint 和 orphan session。

Settings
  管理 executor、Adapter、Codex CLI、权限、安全和诊断配置。
```

关键交互约束：

```text
Complete / Submit / Approve / Pass Gate 等按钮不能本地改变状态。
按钮点击后只发送 event。
Runtime 返回 accepted=false 时，UI 必须展示 blockingReasons。
Runtime 返回新的 allowedActions 后，UI 刷新动作区。
Terminal exit 只能改变 Terminal 状态，不能改变 Node 状态。
Agent 输出只能进入 Draft / Artifact / Evidence，不自动进入 Approval。
```

Run 页面布局建议：

```text
顶部：Run 名称、状态、Workflow 版本、当前节点、风险级别。
左侧：Workflow 节点进度和 Timeline。
中间：当前节点详情、任务说明、Artifact/Evidence。
右侧：Allowed Actions、Blocking Reasons、Approval/Gate 状态。
底部或独立页：Terminal / Agent execution console。
```

UI 状态必须覆盖：

```text
loading
empty
ready
running
awaiting artifact
awaiting approval
awaiting gate
blocked
failed
done
recovery available
revision conflict
permission denied
```

UI 验收标准：

- 用户始终能看出当前 Run 卡在哪个节点。
- 用户始终能看出下一步允许做什么。
- 用户能区分 Agent 输出、Artifact、Evidence、Human Approval。
- 用户能查看 Gate 为什么通过、失败或被 waiver。
- 用户能从 Timeline 回看所有关键事件。
- UI 不出现绕过 Kernel 的状态推进路径。
- UI 能从 Projection 重建，不依赖直接读取协议文件。

## 16. 架构技术栈

推荐主技术栈：

```text
Desktop Shell
  Electron

Renderer
  React
  TypeScript
  Vite
  Zustand 或 TanStack Query
  React Router
  xterm.js

Application Contract
  TypeScript shared contracts
  JSON-RPC 或 typed IPC
  Zod schema validation

Runtime
  Python 3.11+
  FastAPI 或本地 JSON-RPC runtime
  Pydantic
  asyncio

Workflow Kernel
  自研 deterministic state machine
  event-sourced transition engine
  policy / guard / approval / gate modules

Agent Provider
  默认 LangGraph
  通过 AgentExecutor interface 接入

Persistence
  SQLite
  WAL mode
  migrations
  event store + projection tables

Terminal
  node-pty / ConPTY
  xterm.js renderer

Artifacts
  local artifact store
  content hash
  safe path resolver
  markdown/text preview

Knowledge
  first-party lightweight index
  optional LlamaIndex provider

Tools
  native ToolProvider
  optional MCP-compatible provider
  optional LangChain provider

Observability
  native audit events
  structured logs
  optional OpenAI Agents SDK / LangSmith-style tracing adapter

Testing
  pytest
  Vitest
  Playwright
  contract tests
  migration tests
  recovery tests
```

技术栈分层：

```text
Core
  TypeScript contracts
  Python Runtime
  Pydantic
  SQLite
  deterministic Workflow Kernel

Default Providers
  LangGraph AgentExecutor
  native ToolProvider
  native KnowledgeProvider

Optional Providers
  LlamaIndex KnowledgeProvider
  LangChain ToolProvider
  OpenAI Agents SDK tracing / guardrail adapter
  MCP ToolProvider

Experimental Providers
  CrewAI
  AutoGen
  Temporal / Inngest-style durable task provider
```

推荐原因：

- Electron + React 适合桌面工作台、Terminal、复杂工程 UI 和本地 Runtime 管理。
- Python Runtime 适合接入 LangGraph、Pydantic、Agent 工具链和本地工程自动化。
- SQLite 适合作为本地单机事实源，配合 event store 和 projection 使用。
- LangGraph 适合作为默认 AgentExecutor，因为它专注 long-running、stateful agent、checkpoint、human-in-the-loop。
- 核心状态机必须自研，避免被任一 Agent 框架锁死。

不建议进入 Core 的内容：

```text
LangGraph state object
LangChain tool object
LlamaIndex index object
OpenAI Agents SDK trace object
CrewAI crew object
AutoGen message object
```

这些只能存在于 Provider 内部，并转换为平台自己的：

```text
ExecutionResult
ToolResult
KnowledgeSearchResult
CheckpointRef
RunEvent
Artifact
Evidence
```

部署形态：

```text
Development
  Electron dev server
  Python runtime from source
  SQLite local database

Packaged Desktop
  Electron app
  bundled Python runtime executable
  local SQLite database
  local artifact store

Future Remote Mode
  Desktop UI
  remote Runtime API
  remote AgentExecutor
  shared artifact/evidence backend
```

参考资料：

- LangGraph 官方文档说明其面向 durable execution、streaming、human-in-the-loop 和 persistence。
- LangGraph interrupt 支持暂停执行并等待外部输入，适合人工确认场景。
- LangGraph persistence 支持 checkpoint、state history 和 replay。
- FastAPI 支持 async path operation，适合本地 Runtime API。
- SQLite WAL 适合本地并发读写和事务持久化。
