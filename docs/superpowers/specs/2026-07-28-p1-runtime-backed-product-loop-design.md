# P1 Runtime-backed 产品闭环设计

## 目标

P1 的目标是把当前 Runtime-backed MVP 推进为可操作的产品骨架。用户应当能够通过 Runtime API 和 Renderer UI 走通一条真实 Run：

```text
导入项目 -> 创建 Run -> 启动节点 -> 提交 Artifact -> 人工审批 -> Gate 验证 -> Timeline / Projection 回看
```

P1 不追求最终完整产品形态，不接入真实 LangGraph provider、不实现完整 `node-pty` 终端、不做 Knowledge publishing 和 Git merge back。P1 要先把后续能力共同依赖的领域模型、持久化、API 和 UI 状态推进路径打稳。

## 范围

### Adapter 和 Workflow

- 保留 Harness Adapter。
- 新增 Markdown Checklist Adapter，用 Markdown checklist 转换为 canonical workflow。
- 新增 Generic YAML Adapter，用通用 YAML schema 转换为 canonical workflow。
- Adapter detection 返回 camelCase RPC 形状。
- Workflow import 后保存 project、workflow version、diagnostics 和 graph view。
- Workflow compiler 继续作为 canonical model 校验入口。

### Run 和 Timeline

- Run 创建后写入 `runs`、`run_events` 和 `run_projections`。
- 所有状态推进仍通过 Kernel transition。
- Runtime service 提供 `run.get`、`run.timeline` 和 projection rebuild。
- Timeline 从 `run_events` 读取，不从 Renderer 本地状态推断。
- Revision conflict 返回稳定错误，并且不写入事件。

### Artifact / Approval / Gate

- Artifact 提交必须走 Runtime artifact endpoint。
- Artifact 需要安全路径校验、content hash、producer、createdAt，并写入 `artifacts` 表。
- Approval request / decision 写入 `approvals` 表。
- Human approval 只能由 trusted human actor 产生。
- Gate result 写入 `gate_results` 表。
- Gate pass/fail/waiver 必须绑定 evidence 或 waiver reason。
- Kernel 只接受 Runtime service 已校验过的 artifact/gate payload。

### API

P1 补齐以下 Runtime API：

```text
POST /projects/import
GET  /projects/{project_id}
GET  /projects/{project_id}/workflows
POST /runs
GET  /runs/{run_id}
GET  /runs/{run_id}/timeline
POST /runs/{run_id}/transition
POST /runs/{run_id}/artifacts
GET  /runs/{run_id}/artifacts
POST /runs/{run_id}/approvals/{approval_id}/decide
GET  /runs/{run_id}/approvals
POST /runs/{run_id}/gates
GET  /runs/{run_id}/gates
POST /runs/{run_id}/rebuild-projection
```

API 错误映射：

- validation / unsafe path -> 400
- missing resource -> 404
- revision conflict / duplicate run -> 409
- permission denied -> 403
- runtime unavailable -> 503

### Renderer UI

Renderer 从静态说明推进到 Runtime-backed 最小交互：

- Project Dashboard：导入项目、展示 adapter detection、workflow versions 和 diagnostics。
- Run Dashboard：创建 Run、显示 projection、timeline、allowed actions 和 blocking reasons。
- Artifacts：提交 artifact、展示 hash、producer 和 evidence 绑定。
- Approval Inbox：显示待审批项，支持 approve/reject/defer/comment。
- Gates：显示 gate 状态，支持 pass/fail/waiver，并展示 evidence 要求。
- Recovery：触发 projection rebuild，展示 rebuild 结果。

UI 约束：

- UI 不直接改变 Run 状态。
- UI 按 Runtime `allowedActions` 渲染按钮。
- `accepted=false` 时展示 `blockingReasons`。
- 高风险 action 需要明确确认文案。
- UI 不直接读取项目协议文件作为事实源。

## 架构

```text
Renderer
  -> Runtime API Client
  -> FastAPI Runtime API
  -> WorkflowRuntimeService
  -> Adapter / Compiler / Kernel
  -> SQLite repositories
  -> Projection / Timeline response
```

`WorkflowRuntimeService` 是 P1 应用层编排入口，负责：

- Adapter import 和 workflow version 持久化。
- Run 创建和 event append。
- Artifact / Approval / Gate 服务编排。
- 调用 Kernel transition。
- 维护 projection upsert。
- 返回 API 和 UI 使用的稳定 DTO。

Repository 层负责 SQLite 表读写，不包含业务状态决策。Kernel 负责状态转换和 allowed actions，不直接做文件系统 IO。

## 数据模型和持久化

P1 使用现有表并补齐 repository：

- `projects`
- `workflow_versions`
- `runs`
- `run_events`
- `run_projections`
- `artifacts`
- `approvals`
- `gate_results`

写入策略：

- Run event append 和 projection upsert 在同一事务内完成。
- 单连接 Runtime service 使用写锁串行化本地请求。
- 重复 import 使用 upsert，保证 workflow version 可用。
- 重复 create run 返回 conflict，不静默覆盖。
- Projection 必须能从 `run_events` 重建。

## 错误处理

P1 所有 API 返回稳定错误结构：

```json
{
  "code": "REVISION_CONFLICT",
  "message": "Expected revision does not match current revision",
  "details": {}
}
```

内部异常不直接泄露为 500，除非属于未预期 bug。常见错误必须被测试覆盖。

## 测试策略

### Runtime

- Adapter detection/import tests。
- Workflow compiler diagnostics tests。
- Repository migration/round-trip/upsert tests。
- Runtime service integration tests。
- Kernel transition guard tests。
- Artifact/Approval/Gate repository tests。
- Projection rebuild/timeline tests。

### API

- Project import -> Run create -> Node start -> Artifact submit -> Approval decide -> Gate result -> Timeline 回看。
- Revision conflict 不写事件。
- Permission denied 映射为 403。
- Unsafe path / missing artifact 映射为 400/404。
- Duplicate run 映射为 409。

### Renderer

- 导入项目后展示 workflow version。
- 创建 Run 后展示 projection。
- allowed actions 驱动按钮。
- rejected transition 展示 blocking reasons。
- Artifact/Approval/Gate 页面不提供本地状态推进。

### E2E

Playwright 覆盖一条最小真实流：

```text
打开 Renderer -> 导入 fixture project -> 创建 Run -> 启动节点 -> 提交 artifact -> approve -> gate pass -> timeline 可见
```

## 验收标准

- 至少两种 Adapter 可导入 workflow。
- 用户能通过 Runtime API 完成 P1 纵向流。
- Renderer 能通过 Runtime-backed 状态展示并推进同一条流。
- Artifact、Approval、Gate 都有持久化记录。
- Timeline 能从 events 回看关键步骤。
- Projection 能从 events 重建。
- UI 不存在绕过 Kernel 的完成、审批或 Gate 通过路径。
- `npm.cmd run verify`、`npm.cmd run test:e2e`、`powershell -ExecutionPolicy Bypass -File scripts/verify.ps1` 通过。

## 非范围

- 真实 LangGraph provider。
- 真实 `node-pty` / ConPTY 终端 IO。
- Knowledge candidate generation 和 publishing。
- Git worktree / merge back 产品闭环。
- 打包发布和 runtime process supervisor。
- 多用户远程协作模式。

这些能力放入 P2-P6，依赖 P1 的 Runtime-backed 产品闭环。
