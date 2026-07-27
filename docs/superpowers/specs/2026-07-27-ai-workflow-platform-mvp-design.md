# AI 工程工作流平台 MVP 设计

## 背景

本设计用于落实以下两份文档定义的 MVP：

- `docs/ai-workflow-platform-development-spec.zh-CN.md`
- `docs/ai-workflow-platform-implementation-plan.zh-CN.md`

产品定位是通用 AI 工程工作流平台，不是 `.harness` 文件编辑器、单一 Terminal，也不是固定流程看板。MVP 从第一版开始就要保留平台边界：

- 文件只是协议输入。
- Adapter 将协议翻译为统一领域模型。
- Workflow Kernel 是可信状态转换边界。
- Runtime event 是运行时事实源。
- Projection 驱动 UI。
- Renderer、Terminal、Agent 都不能绕过人工确认、Gate、Artifact 和 Evidence 治理。

## 已确认方向

按实施文档中的 M1-M6 MVP 顺序推进：

1. M1：基础工程和 Contracts
2. M2：Canonical Model 和 Adapter
3. M3：Event Store 和 Kernel
4. M4：Approval / Gate / Artifact
5. M5：Terminal 和 Agent Provider
6. M6：UI MVP

这不是替代实施文档的新路线，而是对实施文档的执行方式：先搭完整 MVP 主干，让每个里程碑都可运行、可测试，避免孤立 UI demo 或 Runtime 孤岛。

## 总体架构

仓库采用实施文档推荐的 monorepo 结构：

```text
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

分层职责：

- Electron desktop shell 负责桌面壳、preload bridge 和本地 Runtime 生命周期。
- React renderer 负责用户界面，不直接修改可信 workflow 状态。
- TypeScript contracts 定义共享 RPC、workflow、event、error 和 UI-facing 数据结构。
- Python runtime 负责 canonical workflow import、持久化、状态转换校验、projection 生成、terminal session、approval、gate、artifact 和 recovery。
- SQLite 存储 workflow version、run、runtime event、projection、artifact、approval、gate result、terminal session 和 audit record。

## 硬边界

MVP 必须从一开始强制以下约束：

- Renderer 不直接读写可信 workflow 状态。
- Renderer 动作只能调用 typed RPC/IPC。
- Terminal session 不能提交 `NODE_COMPLETED`。
- Agent provider 不能提交 `HUMAN_APPROVED`。
- Gate pass/fail event 必须来自授权 verifier 或 system actor。
- Gate pass/fail 必须绑定 evidence，或者提供明确 waiver。
- Runtime 状态只能通过 `transition(runId, event, expectedRevision)` 推进。
- Projection 必须能从 `run_events` 重建。
- UI 按钮必须来自 Runtime 计算出的 `allowedActions`。
- Provider-native object 不能进入 contracts、SQLite 权威状态或 renderer state。

## 数据流

项目导入：

1. 用户选择项目根目录。
2. Renderer 调用 `project.detect(rootPath)`。
3. Runtime 的 AdapterRegistry 执行兼容 adapter 检测。
4. 用户选择 adapter。
5. Renderer 调用 `project.import(request)`。
6. Runtime 导入 canonical `WorkflowDefinition`。
7. Runtime 保存 workflow version 和 diagnostics。
8. Project Dashboard 展示协议、workflow version 和 diagnostics。

Run 执行：

1. 用户基于 workflow version 创建 run。
2. Runtime 追加 `RUN_CREATED` event。
3. Kernel 计算初始 node state、current node、allowed action、blocking reason 和 revision。
4. Renderer 只展示 Runtime 返回的 projection。
5. 用户或 executor 提交 artifact、approval decision、gate result、retry、pause、resume、archive 等 runtime event。
6. Kernel 校验 actor、revision、node state、requirement、evidence 和 policy。
7. Runtime 追加被接受的 event，并重建 projection。
8. UI 刷新 timeline、current node、allowed action、blocking reason、artifact、approval state 和 gate state。

Recovery：

1. App 启动或项目打开时，Runtime 扫描已存储 run、terminal session、checkpoint 和 orphan session。
2. Runtime 从 `run_events` 重建 projection。
3. Recovery 页面展示可恢复 run 和 session。
4. 用户通过 Runtime 返回的 allowed action 执行 recover、stop、cleanup 或 continue。

## MVP 模块

基础工程：

- Workspace package scripts，覆盖 renderer、desktop、contracts、runtime、tests 和 development。
- Electron shell 可以启动 renderer，并通过 preload-safe API 与 Runtime 通信。
- Python runtime 提供 health endpoint 或本地 JSON-RPC endpoint。
- SQLite migration runner 启用 WAL mode。
- TypeScript contracts 与 Python Pydantic models 通过测试保持一致。

Canonical model 和 Adapter：

- 定义 `WorkflowDefinition`、`WorkflowNode`、`WorkflowEdge`、`RequirementSpec`、role、gate、policy 和 diagnostic。
- AdapterRegistry 支持 detection score 和 compatibility diagnostic。
- Harness Adapter MVP 导入 `.harness` 风格 workflow 文件。
- Workflow version 持久化，并计算 content hash。
- 基础 compiler diagnostic 和 graph view model。

Event Store 和 Kernel：

- `run_events` 是运行时事实源。
- `run_projections` 是读取模型。
- `transition(runId, event, expectedRevision)` 是唯一状态推进入口。
- Guard rules 覆盖 actor trust、revision conflict、node state、approval、gate、artifact 和 completion。
- 支持从 event 重建 projection。
- 计算 allowed action。
- 提供 timeline API。

Approval、Gate 和 Artifact：

- Artifact metadata store 支持 safe path validation 和 content hash。
- Evidence reference 可绑定 artifact、terminal output 或 gate result。
- Approval inbox 和 approval decision handling。
- Gate result submission、failure、retry 和 waiver。
- 高风险或治理相关决策写入 audit record。

Terminal 和 Agent Provider：

- Terminal session model 绑定 project、run，并可选绑定 node。
- Shell terminal MVP 支持 session lifecycle 和 scrollback。
- Terminal output 可以转为 evidence。
- AgentExecutor interface 定义默认 provider 边界。
- LangGraph provider 可以先是符合接口的实现或 stub，前提是依赖不可用时边界仍然由测试保护。
- Agent execution result 统一归一化为 `ExecutionResult`。

Renderer UI：

- Project Dashboard
- Workflow Viewer
- Run Dashboard
- Terminal page
- Approval Inbox
- Gates page
- Artifacts page
- Recovery page
- Settings page

UI 风格应是克制的工程工作台：信息密度高、状态清晰、便于扫描当前 run 状态、下一步动作、阻塞原因、证据和审计上下文。

## 错误处理

Runtime 错误需要类型化，并通过 contracts 暴露：

- validation error
- adapter unsupported
- workflow diagnostics error
- revision conflict
- permission denied
- invalid transition
- missing artifact
- unsafe path
- missing evidence
- gate failed
- approval rejected
- runtime unavailable
- terminal unavailable

Renderer 必须展示 Runtime 返回的 blocking reason，不能本地推断可信状态。

## 测试策略

Python 测试：

- Canonical schema validation
- Adapter detection 和 Harness import
- SQLite migrations
- Event append ordering
- Transition guard rules
- Allowed actions
- Approval policy
- Gate policy
- Artifact safe path 和 hashing
- Projection rebuild

TypeScript 测试：

- Contract shape exports
- API client request/response handling
- Renderer state mapping from projections
- UI action rendering from allowed actions

端到端测试：

- 启动 app/runtime
- 导入 Harness-like 项目
- 创建 run
- 启动 node
- 提交 artifact
- 人工 approval
- 提交 gate pass
- 通过 Kernel transition 完成 run
- 重启后 rebuild projection

## 验收标准

MVP 完成时，必须有当前证据证明：

- 可以导入一个项目。
- 至少一个 workflow 可以从受支持 adapter 编译。
- Workflow version 可以持久化。
- Run 可以创建。
- Run 状态由 event 推进。
- Projection 可以从 event 重建。
- Terminal session 可以绑定 run/node。
- Terminal output 可以转为 evidence。
- Artifact 可以带 metadata 和 hash 提交。
- Human approval 可以由 trusted human actor 请求和决策。
- Agent actor 不能执行 human approval。
- Gate 需要授权 verifier/system actor，并需要 evidence 或 waiver。
- Gate 可以 pass 或 fail。
- Run 可以通过 Kernel-approved transition 到达 done。
- UI 暴露 Runtime 返回的 allowed action。
- UI 不存在直接完成状态的绕过路径。
- Agent provider 集成在 `AgentExecutor` 后面。
- Provider-native object 不会成为权威 runtime state。
- Recovery 可以从 event 重建 run projection。

## 实施注意事项

- 优先使用小而边界清晰的模块，避免大型 runtime 文件。
- Contracts 保持稳定、显式，不暴露 provider-specific internals。
- MVP 阶段可以使用 SQLite JSON 字段保存 canonical definition 和 projection payload，同时保持 event 和 projection 表可查询。
- UI 先功能完整，再做视觉打磨；每个页面都必须回答当前发生了什么、卡在哪里、下一步能做什么。
- 当当前环境不能安装某个依赖时，保留接口并提供确定性的本地实现或 stub，用测试记录边界。
