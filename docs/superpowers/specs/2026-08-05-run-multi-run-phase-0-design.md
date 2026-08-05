# 多 Run 并行运行改造：阶段 0 设计

**范围：** 本规格只实施 `docs/run-multi-run-rearchitecture.zh-CN.md` 第 13 节的“阶段 0：契约与基线”。第 16 至 22 节的最终契约优先于该文档前面的描述。

## 目标

在不改变数据库、Runtime 路由或 Renderer 页面行为的前提下，建立阶段 1 至 5 共同依赖的 Run、工作区租约和项目范围访问契约，并用自动化测试锁定关键隔离与迁移行为。

## 不在范围内

- 创建 `run_workspace_leases` 表或修改 `runs` 表。
- 实现项目范围的 Runtime API、创建 Run 事务、租约获取/释放/恢复。
- 实现 `#/runs` 列表、新建 Run 或新的 Run 详情页面。
- 为旧 Run 数据、旧 URL 或旧 API 添加兼容逻辑。

## 架构

`packages/contracts` 是 Renderer 与 Runtime 使用的 TypeScript 运行态边界。它将导出固定的 Run 状态与事件类型、`RunSummaryProjection`、`WorkspaceLease`、项目范围 Run 查询和写入请求，以及统一的 `RuntimeError` 响应。

Python Runtime 在 `runtime/src/workflow_platform/models.py` 定义等价的 Pydantic 模型和字面量，供阶段 1 的持久化与 API 使用。阶段 0 不使任何已有端点依赖这些新增模型，避免未实现的行为误暴露给用户。

## 契约

### Run 与租约

- Run 归属由不可变的 `projectId` 表示；任何 Run 读取、写入、跳转和轮询都必须带有 `projectId + runId` 范围。
- `RunSummaryProjection` 只包含列表所需信息：Run 标识、标题、工作流版本、状态、进度、当前/下一节点、首个阻塞原因、工作区、活动计数和更新时间。它不包含完整 projection、终端输出或日志。
- `WorkspaceLease` 包含 `projectId`、`runId`、规范化工作区路径、`write | read` 模式、`active | released | expired` 状态及获取、验证、释放元数据。
- `CreateRunRequest` 固定工作流版本、标题、可选目标与参数、执行工作区及操作者。实际创建端点、幂等键和数据库原子性属于阶段 1。
- 动作请求只携带 `actionId`、`expectedRevision`、操作者和可选 payload；客户端不得提交自行推断的事件类型或节点状态。

### 错误

统一错误值固定为 `{ code, message, details?, correlationId }`。阶段 0 先定义以下后续测试所依赖的错误码：`RUN_NOT_FOUND_IN_PROJECT`、`WORKSPACE_LEASE_CONFLICT`、`REVISION_CONFLICT`、`RUN_REARCHITECTURE_MAINTENANCE`。

## 基线测试

新增测试必须先失败，并在对应阶段实现后转绿：

1. 项目 A 不能使用项目 B 的 `runId` 读取、推进或启动关联作业，即使两者引用同一工作流版本。
2. 同一项目中，两个可写 Run 不能同时租用同一规范化工作区；读租约可以并存，但不能启动可写作业。
3. `projectId + runId` 是直达 URL 和 Runtime 查询的唯一范围；只给出 `runId` 不构成授权。
4. 清理前版本的 Run 链接统一得到受控的 `RUN_NOT_FOUND_IN_PROJECT`，Renderer 停止轮询并返回 Run 列表，不保留 ID 映射。
5. 当前单 Run 工作台的进度图、当前/下一节点、授权动作和入口行为被测试覆盖，作为后续详情页迁移回归基线。

阶段 0 允许这些行为测试处于预期失败状态，但契约测试和现有测试必须通过；失败应明确是阶段 1 逻辑尚未实现，而不是导入、类型或测试环境错误。

## 验收

- TypeScript contracts 的类型检查与测试通过，Python 模型测试通过。
- 新增失败基线覆盖上述四类运行时行为，并显示预期的“尚未实现”失败。
- 单 Run 工作台回归基线通过。
- 没有数据库迁移、Runtime API、持久化逻辑或 Renderer 页面行为改动。

## 后续衔接

阶段 1 以本规格的模型实现 SQLite 架构、`BEGIN IMMEDIATE` 原子创建、租约约束、项目范围 API 和 API/持久化测试。阶段 2 至 5 仅消费项目范围 API 和 projection，不绕过契约直接访问运行态数据。
