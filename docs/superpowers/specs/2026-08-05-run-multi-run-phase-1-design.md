# 多 Run 并行运行改造：阶段 1 设计

**范围：** 本规格实施 `docs/run-multi-run-rearchitecture.zh-CN.md` 第 13 节的“阶段 1：Runtime 项目隔离与工作区租约”。第 16 至 22 节的最终契约优先。

## 目标

将 Runtime 从以全局 `runId` 和工作流版本为中心的运行态访问，改为以 `projectId + runId` 为授权边界的持久化、查询、创建和执行入口；同一项目的同一可写工作区在任一时刻只能由一个活跃 Run 占用。

## 不在范围内

- Renderer 的 `#/runs` 列表、新建 Run 和详情页迁移，属于阶段 2 和 3。
- 终端、产物、门禁、审批、审计和恢复页面的项目范围路由迁移，属于阶段 4。
- worktree 创建 UI、占用状态呈现和恢复页面交互，属于阶段 5。
- 旧运行态数据、旧 Run URL 或旧写入 API 的兼容分支。

## 数据库与迁移

升级进入维护模式并清除文档第 17.1 节列出的运行态表数据，不删除项目、工作流资产、版本、绑定、角色资产或用户 Git worktree。迁移重新建立 `runs`：`project_id`、`workflow_version_id`、完整编译后 `workflow_snapshot_json`、`context_json`、规范化绝对 `execution_workspace`、`workspace_mode`、状态和时间戳均不可变；工作流版本外键使用 `ON DELETE RESTRICT`。建立项目列表、状态和版本过滤索引。

新增 `run_workspace_leases` 表与部分唯一索引：仅 `(project_id, workspace_path)` 上 `mode='write' AND status='active'` 的记录唯一。路径在存储前解析符号链接、转为绝对路径、移除尾部分隔符，并在 Windows 上使用大小写归一后的值。

## Runtime 流程

创建 Run 在持有 Runtime 锁的单个 SQLite `BEGIN IMMEDIATE` 事务内完成：验证项目未归档且版本已绑定、规范化工作区、检查并插入可写租约、写入 Run 与工作流快照、写入 `RUN_CREATED` 事件、保存初始 projection，再提交。任何异常回滚所有写入。`Idempotency-Key` 在同项目 24 小时内返回第一次的创建结果。

Run 仓储新增项目范围的读取和列表方法；所有新核心 API 使用 `/projects/{projectId}/runs` 前缀。列表只聚合并返回 `RunSummaryProjection`，支持状态、版本、工作区、搜索、游标和限制过滤，不进行逐项 projection 或日志查询。项目与 Run 不匹配时统一返回 `404 RUN_NOT_FOUND_IN_PROJECT`。

启动 Agent 或部署前重新读取 Run、租约和授权状态。写入能力要求 `workspace_mode='write'` 和 `active` 租约；读模式只允许后续白名单只读作业。未满足条件以标准 `RuntimeError` 返回，不允许 Runtime 或 Renderer 降级为无租约执行。

## 租约生命周期

租约在终态 Run 且没有活跃 Agent、终端或部署时从 `active` 变为 `released`。异常恢复只能在宿主进程已退出、关联作业不存在并获得显式管理员确认后变为 `expired`，恢复清理完成后变为 `released`。不会因为超时自动释放可写租约；Runtime 启动和恢复诊断仅更新 `last_verified_at`。

## 错误和安全

所有新增 API 返回 `{ code, message, details?, correlationId }`。参数错误为 `INVALID_REQUEST`；租约冲突为 `WORKSPACE_LEASE_CONFLICT`；旧或跨项目 Run 为 `RUN_NOT_FOUND_IN_PROJECT`；维护期为 `RUN_REARCHITECTURE_MAINTENANCE`。创建和动作写入还必须校验项目未归档、Run 未归档、revision 与 Runtime 的 `allowedActions`；阶段 1 为后续动作 API 提供这些验证边界，不保留 `/runs/{runId}` 的新写路由。

## 测试

阶段 0 的三个 Runtime `xfail` 用例在本阶段转绿：跨项目详情隔离、同路径可写租约冲突、清理后的 Run 受控 404。新增持久化集成测试覆盖并发创建时只有一个成功、任一步失败不残留 Run 或租约、项目列表不混入其他项目版本、`Idempotency-Key` 不创建第二个 Run，以及租约释放和恢复状态转换。API 测试覆盖筛选、分页、`limit` 上限、项目范围和统一错误信封。

## 验收

- 新 Run 固定项目、工作流版本快照和规范化执行工作区，且在一个事务内获得租约。
- 同项目同一可写路径并发创建只有一个成功；读租约可并存，但不能启动可写执行器。
- 所有阶段 1 Run 查询和写入 API 均以项目范围访问，跨项目返回受控 404。
- 运行态升级不删除用户 worktree，旧 Run 链接不进行映射或兼容查询。
- 阶段 0 Runtime 基线转绿，完整 contracts、Runtime、Renderer 和 Desktop 测试套件通过。
