# 多 Run 并行运行模块改造方案

**状态：方案待确认**

**目标版本：多 Run 列表与详情页架构**

**适用范围：Renderer、Desktop、Runtime、项目工作区与 Git worktree 管理**

## 1. 背景与问题

现有 Run 页面围绕应用内唯一的 `state.projection` 工作。它可以创建和切换多个
Run，但 UI、轮询、终端、产物和节点操作均隐含“当前只有一个 Run”的前提。这会带来
以下问题：

1. Run 列表按 `workflowVersionId` 查询，多个项目复用同一工作流版本时会混入彼此的
   Run。
2. Run 页面在列表、详情、创建、Agent、终端、交付物和审计之间承担过多职责，页面长且
   难以扫描。
3. 当前 Run 通过全局状态切换；用户无法在列表中稳定地比较多个进行中的 Run，也无法从
   URL 直接进入一个具体 Run。
4. Runtime 允许创建多个 Run，但并不会自动为它们分配独立工作区。两个可写 Run 若使用
   同一 `main` 或同一 worktree，可能并发修改同一文件。
5. 终端、门禁、审批、产物、恢复和审计等运行态模块没有统一、显式的 Run 上下文。

本方案将 Run 定义为独立的运行实例：

```text
项目 Project
  └─ 工作流资产 Workflow Asset
       └─ 工作流版本 Workflow Version
            ├─ Run A -> 独立投影、事件、产物、Agent、工作区
            ├─ Run B -> 独立投影、事件、产物、Agent、工作区
            └─ Run C -> 独立投影、事件、产物、Agent、工作区
```

工作流定义仍是可复用、无运行状态的资产；所有实时进度只在指定 Run 的详情中呈现。

## 2. 目标与边界

### 2.1 目标

1. 支持一个项目在同一工作流版本下创建、查看和管理多个 Run。
2. 支持多个 Run 同时执行，并通过独立 worktree 保证可写工作区互不冲突。
3. 将 Run 模块拆分为列表页和详情页：列表用于比较与调度，详情用于执行和追溯。
4. 让所有运行态页面以 `runId` 为明确上下文，允许通过 URL 直达和刷新恢复。
5. 所有可执行操作持续以 Runtime 的 `allowedActions` 为唯一授权来源。
6. 保持改造上线后创建的 Run、已归档项目和工作流版本可读可审计；不迁移改造前的历史运行数据。

### 2.2 非目标

1. 不在本阶段支持同一 Run 内无限制并行节点调度。Run 内并行仍由工作流图与 Runtime
   状态机决定。
2. 不在本阶段引入跨机器分布式执行器或集群调度。
3. 不改变工作流编辑页的职责；它只维护定义、版本和编译诊断。
4. 不将角色库复制为 Run 私有资产。Run 持有创建时的工作流/角色版本快照即可。

## 3. 核心设计原则

| 原则 | 设计要求 |
| --- | --- |
| Run 上下文显式化 | 所有运行态路由、API、终端、产物和操作请求均以 `runId` 定位。 |
| 项目隔离 | 列表、统计和操作默认以 `projectId` 过滤，不能因共用工作流版本而跨项目混入。 |
| 工作区独占写入 | 同一项目内，一个可写 worktree 同一时刻只能由一个活动 Run 占用。 |
| Runtime 授权 | Renderer 只展示 Runtime 允许的动作，不能按节点类型猜测或伪造状态。 |
| 摘要优先 | 列表只加载摘要；完整投影、日志和终端只在详情页按需加载。 |
| URL 可恢复 | 浏览器刷新、桌面应用重启或外部链接进入时，可恢复到 `#/runs/:runId`。 |
| 运行快照不可漂移 | 改造上线后创建的 Run 持续引用创建时的工作流版本；之后修改工作流或角色库不改变该 Run。 |

## 4. 信息架构与路由

采用现有 hash 路由体系，新增以下页面和上下文：

| 路由 | 页面 | 责任 |
| --- | --- | --- |
| `#/runs` | Run 列表页 | 当前项目下的 Run 扫描、筛选、新建和快捷调度。 |
| `#/runs/new` | 新建 Run 页或模态流程 | 选择工作流版本、任务目标、参数与独立工作区。 |
| `#/runs/:runId` | Run 详情页 | 进度图、当前/下一环节、授权操作和运行详情。 |
| `#/runs/:runId/terminal/:jobId` | Agent 终端上下文 | 指定 Agent 作业的交互终端和输出。 |
| `#/artifacts?runId=:runId` | Run 产物视图 | 指定 Run 的交付物、预览和差异。 |
| `#/gates?runId=:runId` | Run 门禁视图 | 指定 Run 的门禁证据、结果和豁免。 |
| `#/approvals?runId=:runId` | Run 审批视图 | 指定 Run 的审批任务和决策。 |
| `#/audit?runId=:runId` | Run 审计视图 | 指定 Run 的事件与证据链。 |
| `#/recovery?runId=:runId` | Run 恢复视图 | 指定 Run 的重建、诊断和受控清理。 |

`runId` 非法、不可访问或不属于当前项目时，详情页显示明确错误并返回列表页，不能回退到
其他 Run 的全局状态。

## 5. Run 列表页设计

### 5.1 页面结构

```text
运行
项目：<当前项目>  工作流：<当前绑定版本>                         [新建 Run]

[搜索] [状态：全部] [工作区：全部] [更新时间] [刷新]

Run 名称 | 工作流进度 | 当前环节 -> 下一环节 | 状态/风险 | 必要信息 | 操作
---------------------------------------------------------------------------------
实现登录  | 4/7         | 开发实现 -> 验证测试  | 进行中     | dev worktree | 暂停  更多
修复导入  | 2/6         | 需求澄清 -> 技术方案  | 等待审批   | main 锁定    | 查看
发布验证  | 6/6         | 无后续环节            | 已完成     | 已归档       | 查看  归档
```

每行点击进入 `#/runs/:runId`，不采用行内展开。列表行本身不可承载复杂的表单、终端或
节点编辑，避免多 Run 时页面变成长列表与长详情的混合体。

### 5.2 工具栏

工具栏固定为轻量、面向高频操作的区域：

1. 当前项目与绑定工作流版本，只读展示；工作流切换回项目模块完成。
2. 关键筛选：状态、当前节点类型、执行工作区、是否有阻塞、是否有运行中 Agent。
3. 文本搜索：匹配 Run 名称、任务目标和 Run ID。
4. 排序：最近更新时间、创建时间、风险状态。
5. 明确命令：刷新和新建 Run。刷新使用图标按钮并提供 tooltip。

已完成和已归档 Run 默认保留在列表中，但筛选器默认优先展示进行中、等待操作和阻塞状态。

### 5.3 Run 摘要行字段

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| Run 名称 | `runs.title` | 主识别信息，辅以短 Run ID。 |
| 工作流 | 工作流资产和版本 | 显示名称、版本和节点总数。 |
| 进度 | `nodeStates` 摘要 | 已完成/总节点数及紧凑状态条。 |
| 当前环节 | `currentNodeIds` | 显示一个或多个当前节点名称。 |
| 下一环节 | 工作流边 + 当前节点 | 显示直接后继；分支时显示候选数量与名称摘要。 |
| 状态 | `projection.status` | 使用一致的状态色和文本。 |
| 阻塞摘要 | `blockingReasons` | 仅展示第一条摘要，详情页展示完整原因。 |
| 工作区 | Run context | 展示 worktree 名称和占用状态。 |
| 活动 | Agent/部署摘要 | 例如“2 个 Agent 运行中”。 |
| 更新时间 | projection/run metadata | 用于调度与排序。 |

### 5.4 列表级操作

列表右侧只呈现低风险、无需补充输入的动作：进入详情、暂停、恢复、归档。所有节点级动作
（启动 Agent、提交产物、审批、门禁、部署）仅在详情页执行。每项操作仍须在 Runtime 返回
的允许动作集合中出现。

## 6. Run 详情页设计

### 6.1 首屏布局

```text
< 返回 Run 列表
Run：实现登录                 进行中       项目 / 工作流 v4 / dev-worktree

完整运行进度图

当前工作环节                                      下一步操作
开发实现 [RUNNING]                                [启动 Agent]
目标、角色、输入、产物、完成条件、阻塞原因        动作结果说明与所需输入
下一工作环节：验证测试                            其他 Runtime 允许操作

运行详情：交付物与上下文 | Agent 与终端 | 门禁与审批 | 部署 | 时间线 | 审计
```

当前工作环节和下一步操作必须在第一屏可见。完整进度图描述该 Run 的专属状态，不向工作流
定义页写入或投射运行状态。

### 6.2 进度图

1. 图结构来自 Run 引用的工作流版本，不读取当前工作流资产的可编辑定义。
2. 节点状态来自该 `runId` 的 `RunProjection`。
3. 支持完成、进行中、等待输入、阻塞、失败、跳过和待执行状态。
4. 节点悬浮展示状态、输入条件、产物要求、阻塞原因和后继节点。
5. 点击节点只切换详情查看；只有 Runtime 标识为当前且允许操作的节点能显示操作区。
6. 分支图不依赖节点数组顺序，后继关系只由 workflow edge 决定。

### 6.3 当前与下一工作环节

当前环节卡展示：节点名称、节点类型、执行角色、工作目标、必需输入、预期产物、完成方式、
阻塞原因、执行工作区和当前 Agent 状态。

下一工作环节基于当前节点的直接出边计算：

1. 单一路径：显示下一节点名称、类型和进入条件。
2. 多分支：显示“存在 N 个候选后续环节”，列出条件和候选节点；不得伪装为唯一下一步。
3. 没有后继：显示“无直接后续环节”；若 Run 未完成，则同时显示 Runtime 的阻塞或收尾动作。
4. 后继节点是否实际进入由 Runtime 状态机决定，Renderer 仅作可解释展示。

### 6.4 动态操作区

操作区以 `RunProjection.allowedActions` 为唯一来源。它仅显示当前 Run、当前节点、当前版本号
下真实允许的操作，且每次操作携带 `runId`、`revision` 和时间戳。

| 节点类型 | 详情内容 | 可能的 Runtime 授权操作 |
| --- | --- | --- |
| `task`、`composite` | 任务目标、输入输出、完成条件 | 启动、提交/扫描产物、完成。 |
| `agent` | 角色、Provider、允许工具、worktree、提示词 | 启动 Agent、打开终端、取消、提交产物、完成。 |
| `approval` | 审批人、决策依据、待确认事项 | 批准、拒绝、暂缓。 |
| `gate` | 规则、证据、豁免要求 | 启动检查、通过、失败、豁免、重试。 |
| `evidence` | 证据来源与格式 | 提交或确认证据、完成。 |
| `deploy` | 目标环境、命令、回滚信息 | 启动、取消、查看输出。 |
| `report` | 报告要求和可用产物 | 生成/下载报告、完成。 |

没有允许操作时，展示具体等待条件或阻塞原因，不展示一组无法理解的禁用按钮。

### 6.5 次级详情

次级信息使用标签页或原生折叠区，不与首屏调度信息竞争：

1. 交付物与上下文。
2. Agent 任务、实时输出和交互终端。
3. 门禁、审批与证据。
4. 部署历史与输出。
5. Runtime 时间线。
6. 参数、元数据和工作区信息。
7. 审计与恢复诊断。

所有跳转都保留 `runId`。例如从详情进入产物页后，返回应回到同一 Run 的详情页。

## 7. 多 Run 并行与 worktree 隔离

### 7.1 并行规则

1. 不同项目的 Run 可并行，彼此天然隔离。
2. 同一项目的多个 Run 可并行，但每个会写入代码的 Run 必须拥有独立 worktree。
3. 同一项目、同一路径、两个活动可写 Run 不允许并行。读取、审计或已完成 Run 不占用写锁。
4. 一个 Run 内启动多个 Agent 时，仍受 Run 自身的 Agent 并发配额控制。
5. 部署节点可增加环境级锁，防止两个 Run 对同一目标环境并发部署。

### 7.2 新建 Run 流程

```text
新建 Run
  -> 输入名称、目标、参数
  -> 选择工作流绑定版本（默认项目当前绑定版本）
  -> 选择执行工作区
       -> 可用 worktree：选择
       -> 无可用 worktree：创建新 worktree
       -> main 已被活动可写 Run 占用：禁止选择并说明占用 Run
  -> Runtime 原子校验与预留 worktree
  -> 创建 Run、初始事件和投影
```

默认策略：优先推荐尚未占用的非主 worktree。`main` 只能被一个活动可写 Run 使用；用户可为
纯审阅/只读流程显式选择只读模式，但 Runtime 必须验证节点及工具权限不包含写入能力。

### 7.3 工作区租约

新增 `run_workspace_leases` 概念：

| 字段 | 说明 |
| --- | --- |
| `id` | 租约 ID。 |
| `project_id` | 所属项目。 |
| `run_id` | 占用该工作区的 Run。 |
| `workspace_path` | 规范化后的绝对路径。 |
| `mode` | `write` 或 `read`。 |
| `status` | `active`、`released`、`expired`。 |
| `acquired_at` / `released_at` | 生命周期审计时间。 |

对活动 `write` 租约建立 `(project_id, workspace_path)` 唯一约束。创建 Run、启动会写入的
Agent、启动部署均在事务内校验租约。Run 完成、失败、归档或显式释放后结束租约；进程异常时
由恢复模块检查存活作业后受控释放。

## 8. Runtime 与 API 改造

### 8.1 现有接口问题

现有 `GET /workflow-versions/{workflowVersionId}/runs` 缺少 `projectId` 条件。它不能作为
多项目共享工作流时的默认 Run 列表接口。

### 8.2 新增与调整接口

| 接口 | 用途 | 关键返回/约束 |
| --- | --- | --- |
| `GET /projects/{projectId}/runs` | 项目 Run 摘要列表 | 支持 `workflowVersionId`、`status`、`cursor`、`limit`；列表项直接返回 `RunSummaryProjection`，不另设 summary 接口。 |
| `GET /projects/{projectId}/runs/{runId}` | Run 元数据 | 校验 Run 必须属于路径中的项目。 |
| `GET /projects/{projectId}/runs/{runId}/projection` | 详情实时投影 | 明确以 `projectId + runId` 为范围。 |
| `GET /projects/{projectId}/runs/{runId}/overview` | 详情首屏聚合 | 返回元数据、投影、工作流版本摘要、工作区租约和活动统计。 |
| `POST /projects/{projectId}/runs` | 创建 Run | 接收 `workflowVersionId`、工作区或 worktree 创建策略；事务内建立租约。 |
| `POST /projects/{projectId}/worktrees` | 创建 worktree | 返回可用于新 Run 的路径与分支信息。 |
| `GET /projects/{projectId}/workspaces` | 可选工作区 | 返回可写性、占用 Run、租约状态、分支和推荐程度。 |
| `POST /projects/{projectId}/runs/{runId}/workspace/release` | 受控释放租约 | 只允许终态 Run 或具备恢复授权的操作。 |

原工作流版本级列表接口不再作为 Run 模块的数据源；完成调用方切换后直接删除，避免继续维护
跨项目语义不完整的兼容接口。

### 8.3 Run 摘要模型

建议新增 `RunSummaryProjection`：

```ts
type RunSummaryProjection = {
  id: string;
  projectId: string;
  workflowVersionId: string;
  workflowName: string;
  workflowVersion: string;
  title: string;
  status: RunStatus;
  taskGoal: string | null;
  currentNodes: Array<{ id: string; name: string; kind: string; state: NodeState }>;
  nextNodes: Array<{ id: string; name: string; kind: string; condition?: string }>;
  progress: { total: number; passed: number; running: number; blocked: number; pending: number };
  blocker: { code: string; message: string; nodeId?: string } | null;
  workspace: { path: string; label: string; leaseMode: "read" | "write"; leaseStatus: string } | null;
  activeAgentCount: number;
  activeDeploymentCount: number;
  createdAt: string;
  updatedAt: string;
};
```

摘要由 Runtime 在一次查询中聚合，Renderer 不为列表中的每个 Run 逐个请求 projection、Agent
和产物接口。

### 8.4 并发与状态一致性

1. Run 创建、工作区租约获取、初始事件和 projection 保存必须在同一个数据库事务完成。
2. 节点操作继续使用 `revision` 乐观并发控制；过期页面提交应收到冲突并刷新对应 Run。
3. Agent 与部署启动接口二次检查 Run 状态、项目归档状态、允许动作和工作区租约。
4. 所有实体查询在服务端验证 Run 到项目的归属，不能只信任 Renderer 传来的 `runId`。
5. 批量刷新使用只读查询，不改变任何 Run 的当前节点或执行状态。

## 9. Renderer 状态与刷新策略

### 9.1 状态模型

移除“整个应用只保存一个当前 projection”的语义，拆分为：

```text
WorkspaceSession
  - projectId
  - workflowVersionId
  - lastVisitedRunId

RunListState
  - filters, sort, cursor
  - summaries[]
  - lastRefreshedAt

RunDetailState(runId)
  - run metadata
  - workflow version definition (只读)
  - projection
  - allowedActions
  - node requirements/context
  - agent/deployment/terminal state
```

`#/runs/:runId` 是详情页唯一可信的 Run 选择来源；本地存储只记忆最近访问，不替代 URL。

### 9.2 刷新频率

| 页面 | 数据 | 策略 |
| --- | --- | --- |
| Run 列表 | 摘要 | 可见时每 10 秒刷新；窗口重新聚焦立即刷新。 |
| Run 详情 | projection 与允许操作 | 进行中每 2 秒，非进行中每 10 秒，离开页面停止。 |
| Agent 输出 | 当前详情页的运行中作业 | 每 1-2 秒增量拉取或后续替换为事件流。 |
| 非选中 Run 的 Agent/终端 | 不加载详细输出 | 仅在摘要中展示数量和最新状态。 |

请求必须携带取消/失效标识，防止用户从 Run A 跳到 Run B 后，A 的异步响应覆盖 B 的详情。

## 10. 其他模块改造矩阵

| 模块 | 必须调整 | 调整内容 |
| --- | --- | --- |
| 项目 | 是 | 展示活动 Run 数、最近 Run、进入 `#/runs`；新建 Run 选择工作区。 |
| 工作流 | 是 | 仅显示引用该版本的 Run 数和入口；禁止显示任何实时 Run 节点状态。 |
| 终端 | 是 | 终端会话路径携带 `runId` 和 `jobId`，启动前校验 worktree 租约。 |
| 产物 | 是 | 增加项目/Run 筛选、Run 标签和返回详情链接。 |
| 门禁 | 是 | Gate 结果、证据和豁免按 `runId` 查询与操作。 |
| 审批 | 是 | 审批任务带 Run、节点和项目标识；决策回到对应 Run 详情。 |
| 审计 | 是 | 支持 Run 范围查询和事件证据链跳转。 |
| 恢复 | 是 | 恢复诊断、重建 projection、清理终端按 Run 执行。 |
| 知识库 | 建议 | 知识候选记录来源 Run，支持按 Run 回溯。 |
| 设置 | 建议 | 设置每项目活动 Run 上限、每 Run Agent 上限和默认 worktree 策略。 |
| 角色库 | 否 | 无需重构；Run 使用创建时工作流版本中的角色快照。 |
| Desktop Git | 是 | 提供 worktree 列表、创建、占用提示和安全释放能力。 |

## 11. 上线切换与数据重置策略

本次改造不兼容改造前的 Run、投影、事件、终端会话、产物索引、审批、门禁和工作区占用数据。
工作流、项目绑定、全局角色库等静态配置保留；所有运行态数据以新模型重新开始。

1. 发布前停止并明确终止所有旧版 Run 的 Agent、终端和部署作业，避免旧进程继续向已替换的
   Runtime 数据写入。
2. 数据库升级时删除旧运行态记录并创建新的 `run_workspace_leases` 表及项目级索引；不编写旧
   Run 到新模型的转换脚本，不保留历史兼容视图。
3. Renderer 与 Runtime 在同一版本完成切换：移除旧的工作流版本级 Run 列表调用、旧全局
   `projection` 回退逻辑和旧 Run 路由。
4. 升级完成后，用户从 `#/runs` 创建新的 Run；任何无法找到的旧 `runId` 或无效链接均显示
   “运行记录不存在或已随版本升级清理”，并返回 Run 列表，不尝试加载或恢复。
5. 项目归档后，改造上线后创建的 Run 列表与详情保持只读；新建 Run、获取可写租约、节点执行
   和 Agent 启动全部由 Runtime 拒绝。

## 12. 错误处理与安全要求

| 场景 | 行为 |
| --- | --- |
| Run 不属于当前项目 | API 返回 404 或权限错误；Renderer 返回列表页，不显示其他项目数据。 |
| 工作流版本已删除 | 改造上线后创建的 Run 使用创建时快照；若快照不可读取，显示受控错误和审计入口。 |
| worktree 被占用 | 创建或启动动作拒绝，展示占用 Run、工作区和可选替代 worktree。 |
| revision 冲突 | 仅刷新当前 `runId` 的详情与列表摘要，提示状态已更新。 |
| Agent/终端异常断开 | 保留作业与日志，恢复页可检查和清理；不自动释放写租约。 |
| 项目或 Run 已归档 | 页面只读，隐藏所有非授权写操作。 |
| 批量刷新失败 | 保留最后成功摘要并标记刷新时间；不清空列表制造“无 Run”假象。 |

## 13. 分期实施计划

### 阶段 0：契约与基线

1. 定义 `RunSummaryProjection`、工作区租约模型和项目级 Run 查询契约。
2. 为跨项目同版本 Run 混入、租约冲突、URL 直达、旧 `runId` 被清理后的受控跳转建立失败测试。
3. 记录当前单 Run 页面行为，作为迁移回归基线。

### 阶段 1：Runtime 项目隔离与工作区租约

1. 实现 `GET /projects/{projectId}/runs` 与摘要接口。
2. 实现租约表、事务获取、释放和恢复校验。
3. 在 Run 创建、Agent 启动和部署启动路径接入租约检查。
4. 为 SQLite 事务、并发创建和跨项目读取增加测试。

### 阶段 2：Run 列表页

1. 实现 `#/runs` 工具栏、筛选、分页和摘要列表。
2. 取消 Run 页面按工作流版本的全局列表查询。
3. 实现 URL 跳转与项目级范围校验。
4. 验证列表不加载终端日志或每项逐个 projection。

### 阶段 3：Run 详情页

1. 实现 `#/runs/:runId`，将当前工作台迁移到详情页。
2. 详情加载 Run、版本定义和 projection，保持进度图、当前/下一环节、动态操作区。
3. 将 Agent、产物、门禁、审批、部署和时间线作为带 `runId` 的次级详情。
4. 移除对全局唯一 `state.projection` 的依赖。

### 阶段 4：跨模块 Run 上下文

1. 改造终端、产物、门禁、审批、审计和恢复路由与查询。
2. 增加从列表、详情和各模块之间的保留上下文跳转。
3. 项目页增加 Run 概览和独立 worktree 引导。

### 阶段 5：并行体验与韧性

1. 新建 Run 流程显示 worktree 占用状态和推荐项。
2. 增加活动 Run/Agent 并发上限配置。
3. 实现轮询取消、前后台节流、失败重试和恢复租约诊断。
4. 进行多项目、同项目多 worktree、异常退出和归档场景验收。

## 14. 验收标准

1. 同一项目可同时创建至少两个活动 Run，并分别使用不同 worktree。
2. 两个项目绑定同一工作流版本时，项目 A 的 Run 列表不会出现项目 B 的 Run。
3. `#/runs/:runId` 刷新后仍展示对应 Run，而非最近一次全局 Run。
4. 列表首屏可比较 Run 状态、当前环节、下一环节、工作区和阻塞原因，无需进入详情。
5. 点击列表行只进入详情页，不存在行内展开的复杂操作区。
6. 详情首屏展示完整进度图、当前工作环节、下一工作环节和 Runtime 授权的下一步操作。
7. 详情页只轮询当前 `runId`；后台 Run 在列表中更新摘要但不加载终端输出。
8. 在同一 worktree 创建第二个可写 Run 会被拒绝，并提供可用替代 worktree。
9. Agent、终端、部署、产物、门禁、审批、审计和恢复记录均可追溯至唯一 `runId`。
10. 项目或 Run 归档后，改造上线后创建的运行信息可读，所有写入操作被 Runtime 拒绝。
11. 所有状态推进仍通过 Runtime 的版本号校验和 `allowedActions` 执行。
12. Renderer、Runtime 与 Desktop 的单元、集成和关键多 Run 场景测试通过。

## 15. 推荐实施顺序

先完成阶段 1 的项目隔离和 worktree 租约，再实施阶段 2 的列表页。原因是列表页的正确性
依赖项目级查询，而详情页的安全并行依赖 Runtime 对工作区的强制约束。完成这两项后再迁移
现有 Run 工作台到详情路由，可避免在 UI 层暂时掩盖数据越界或工作区冲突。

## 16. 最终实施契约与优先级

本文件是本次改造唯一的产品、架构、接口和验收依据。第 16 至 22 节为实施级契约；如与前文
存在表述差异，以本节及后续章节为准。开发过程中不得为保留旧 Run 数据、旧路由或旧接口增加
兼容分支。

1. 改造范围只覆盖 Run 及其运行态关联模块，不改变项目、工作流资产、工作流版本、项目绑定和
   全局角色库的业务含义。
2. 每个新 Run 必须固定 `projectId`、`workflowVersionId`、工作流定义快照和执行工作区；这四项
   创建后不可修改。
3. 所有写操作都必须同时验证项目未归档、Run 未归档、当前 `revision`、`allowedActions` 和工作区
   租约。任何一项不满足即拒绝，不允许 Renderer 降级为本地修改状态。
4. 所有读取、跳转、轮询和外部模块入口都以 `projectId + runId` 为范围。`runId` 只用于 URL 标识，
   不能单独作为跨项目查询、写入或终端启动的授权依据。
5. 工作流编辑页始终只展示静态定义和版本信息；Run 的节点颜色、执行进度、阻塞原因、Agent 和
   操作按钮只存在于 Run 详情页。

## 17. 数据库与工作区租约契约

### 17.1 上线数据清理边界

保留 `projects`、`workflow_assets`、`workflow_versions`、项目绑定、角色资产及其版本等静态配置。
清理所有改造前的运行态数据：`runs`、`run_events`、`run_projections`、`artifacts`、`approvals`、
`gate_results`、`terminal_sessions`、`terminal_output_events`、`agent_jobs`、`agent_sessions`、
`agent_output_events`、`agent_checkpoints`、`deployments`、`deployment_output_events` 以及资源属于
Run 的审计记录。不得删除用户 Git worktree；升级后的工作区列表通过 `git worktree list` 重新发现，
并从“未占用”状态开始。

清理前 Runtime 进入维护模式，停止接受新的 Run、Agent、终端和部署请求。先请求旧进程正常终止，
30 秒后仍存活的进程由 Desktop 终止；进程均退出后才执行数据库升级。清理后的旧链接统一按
“运行记录不存在或已随版本升级清理”处理，不保存旧 ID 映射或兼容查询接口。

### 17.2 Run 数据模型

新 `runs` 记录必须包含以下不可变字段：

| 字段 | 约束 | 用途 |
| --- | --- | --- |
| `id` | 主键 | Run 标识。 |
| `project_id` | 非空，外键至项目 | 项目级隔离的首要条件。 |
| `workflow_version_id` | 非空，删除受限 | 指向创建时选定的版本。存在引用 Run 时不得删除该版本，只能归档。 |
| `workflow_snapshot_json` | 非空 | 创建 Run 时写入完整编译后工作流定义，包括角色快照。详情页和执行器只读取此快照。 |
| `title` | 非空，1-120 字符 | 列表主标题。 |
| `context_json` | 非空 | `taskGoal`、运行参数和非结构化上下文。 |
| `execution_workspace` | 非空，规范化绝对路径 | Run 唯一执行目录。 |
| `workspace_mode` | `write` 或 `read` | 决定是否需要独占租约。 |
| `status`、`created_at`、`updated_at` | 非空 | Run 生命周期与列表排序。 |

`workflow_version_id` 的外键策略必须为 `ON DELETE RESTRICT`，不得使用级联删除。数据库须建立
`runs(project_id, updated_at DESC)`、`runs(project_id, status, updated_at DESC)` 与
`runs(project_id, workflow_version_id, updated_at DESC)` 索引。

### 17.3 `run_workspace_leases` 表

```sql
CREATE TABLE run_workspace_leases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  workspace_path TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('write', 'read')),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
  acquired_at TEXT NOT NULL,
  last_verified_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT
);
CREATE UNIQUE INDEX run_workspace_active_write_unique
  ON run_workspace_leases(project_id, workspace_path)
  WHERE mode = 'write' AND status = 'active';
CREATE INDEX run_workspace_lease_project_status_idx
  ON run_workspace_leases(project_id, status, workspace_path);
```

`workspace_path` 必须使用解析符号链接后的绝对路径、Windows 大小写归一化路径和去尾部分隔符后的值。
同一项目内 `main` 也属于普通可写工作区，只是同一时刻同样只能被一个可写 Run 占用。`read` 租约
可以并存，但 Runtime 必须拒绝以 `read` 租约启动具备写入能力的 Agent、终端命令或部署。

### 17.4 原子性与恢复

创建 Run 时使用单一 SQLite `BEGIN IMMEDIATE` 事务依次完成：确认项目和工作流版本可用、规范化
工作区路径、检查可写租约唯一索引、插入 Run 和工作流快照、插入租约、写入 `RUN_CREATED` 事件、
生成初始 projection、提交事务。任何一步失败必须回滚，不能留下无 Run 的租约或无租约的可写 Run。

租约状态只能按下表转换：

| 当前状态 | 可转换状态 | 触发条件 |
| --- | --- | --- |
| `active` | `released` | Run 已 `DONE` 或 `ARCHIVED`，且不存在活跃 Agent、终端或部署。 |
| `active` | `expired` | 恢复诊断确认宿主进程已异常退出、关联作业均不存在且管理员显式确认。 |
| `expired` | `released` | 恢复流程完成清理并记录原因。 |
| `released` | 无 | 终态；不得重新激活。 |

不得仅因超时自动释放可写租约。Runtime 启动时及恢复页的“诊断”操作应更新 `last_verified_at`；
非终态 Run 即使无前端页面打开也持续保留租约，直到显式恢复处理完成。

## 18. Runtime API 最终契约

所有 Run 相关 API 统一使用 `/projects/{projectId}/runs` 前缀。`projectId` 与 Run 归属不一致时返回
`404 RUN_NOT_FOUND_IN_PROJECT`，不得透露其他项目的 Run 信息。

### 18.1 列表、详情与工作区

| 方法与路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `GET /projects/{projectId}/runs` | 查询参数：重复 `status`、`workflowVersionId`、`workspacePath`、`q`、`cursor`、`limit`。`limit` 默认 20，最大 100。 | `{ items: RunSummaryProjection[], nextCursor: string | null }`，按 `updatedAt DESC` 排序。 |
| `GET /projects/{projectId}/runs/{runId}` | 无 | Run 元数据、工作流快照摘要、租约摘要。 |
| `GET /projects/{projectId}/runs/{runId}/projection` | 无 | 完整 `RunProjection`。 |
| `GET /projects/{projectId}/runs/{runId}/overview` | 无 | `{ run, projection, workflow, workspace, activity }`，用于详情页首屏。 |
| `GET /projects/{projectId}/workspaces` | 可选 `mode=write|read` | 已发现 worktree、分支、路径、可写性、占用 Run 和推荐级别。 |
| `POST /projects/{projectId}/worktrees` | `{ name, branchName, baseRef }` | `201`，返回新 worktree。创建 worktree 不创建 Run 或租约。 |

`cursor` 是 Runtime 生成的不透明值，Renderer 不得自行解析或构造。列表请求只读取摘要，严禁在
Renderer 端对每一行额外请求 projection、日志或终端输出。

### 18.2 创建与状态推进

创建 Run 的请求为：

```ts
type CreateRunRequest = {
  workflowVersionId: string;
  title: string;
  taskGoal?: string;
  parameters?: Record<string, unknown>;
  executionWorkspace: { path: string; mode: "write" | "read" };
  actor: Actor;
};
```

`POST /projects/{projectId}/runs` 要求 `Idempotency-Key` 请求头；同一项目、同一键在 24 小时内返回
第一次创建的结果，而不创建第二个 Run。成功返回 `201 { run, projection, workspace }`，并设置
`Location: /projects/{projectId}/runs/{runId}`。

节点操作统一使用：

```ts
type ExecuteRunActionRequest = {
  actionId: string;
  expectedRevision: string;
  actor: Actor;
  payload?: Record<string, unknown>;
};
```

`POST /projects/{projectId}/runs/{runId}/actions` 仅接受本次 projection 的 `allowedActions` 中存在的
`actionId`。Runtime 根据 `actionId` 解析事件和节点，忽略客户端自行拼装的事件类型或节点状态。
成功返回 `{ projection, emittedEvents }`；Renderer 以响应中的 projection 完整替换当前详情状态。

`POST /projects/{projectId}/runs/{runId}/workspace/release` 只允许终态 Run，或携带恢复授权且通过进程
诊断的请求。Agent、终端、部署、产物、门禁、审批、审计和恢复 API 均必须采用同样的项目和 Run
路径前缀；不得保留仅包含 `/runs/{runId}` 的可写路由。

### 18.3 统一错误响应

```ts
type RuntimeError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId: string;
};
```

| HTTP 状态 | `code` | Renderer 行为 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 在当前表单显示字段错误，不清空用户输入。 |
| 404 | `RUN_NOT_FOUND_IN_PROJECT` | 停止轮询，提示记录不存在或已清理，返回 Run 列表。 |
| 409 | `REVISION_CONFLICT` | 刷新该 Run 的 overview 和列表摘要，提示状态已更新。 |
| 409 | `WORKSPACE_LEASE_CONFLICT` | 保留创建表单，展示占用 Run 与可选工作区。 |
| 409 | `PROJECT_ARCHIVED` 或 `RUN_ARCHIVED` | 将页面切换为只读并刷新详情。 |
| 423 | `WORKSPACE_RECOVERY_REQUIRED` | 引导进入该 Run 的恢复诊断，不提供强制启动。 |
| 503 | `RUN_REARCHITECTURE_MAINTENANCE` | 显示维护状态，延迟后允许用户手动刷新。 |

## 19. Runtime 状态机与授权规则

Run 状态固定为 `CREATED`、`IN_PROGRESS`、`REVIEWING`、`BLOCKED`、`PAUSED`、`DONE`、`ARCHIVED`；
节点状态固定为 `PENDING`、`READY`、`RUNNING`、`AWAITING_ARTIFACT`、`AWAITING_APPROVAL`、
`AWAITING_GATE`、`PASSED`、`FAILED`、`BLOCKED`、`SKIPPED`。这些枚举继续由
`packages/contracts/src/events.ts` 导出，Python Runtime 只能消费同一份契约。

| 节点状态 | 允许的后继状态 |
| --- | --- |
| `PENDING` | `READY`、`SKIPPED` |
| `READY` | `RUNNING`、`SKIPPED`、`BLOCKED` |
| `RUNNING` | `AWAITING_ARTIFACT`、`AWAITING_APPROVAL`、`AWAITING_GATE`、`PASSED`、`FAILED`、`BLOCKED` |
| `AWAITING_ARTIFACT` | `RUNNING`、`PASSED`、`BLOCKED` |
| `AWAITING_APPROVAL` | `RUNNING`、`PASSED`、`FAILED`、`BLOCKED` |
| `AWAITING_GATE` | `RUNNING`、`PASSED`、`FAILED`、`BLOCKED` |
| `FAILED` | `READY`、`BLOCKED` |
| `BLOCKED` | `READY`、`FAILED` |
| `PASSED`、`SKIPPED` | 无 |

`PAUSED` 与 `ARCHIVED` 是 Run 级覆盖状态：暂停期间不允许节点推进；归档后仅允许读取。
所有必经节点均为 `PASSED` 或 `SKIPPED` 时 Run 才能进入 `DONE`。存在运行节点时为 `IN_PROGRESS`；
等待审批或门禁且没有运行节点时为 `REVIEWING`；存在阻塞节点时为 `BLOCKED`。状态转换只能由
`RUN_EVENT_TYPES` 事件驱动，且事件必须正好对应 Runtime 当前计算出的 `allowedActions`。

每次写操作必须携带 `expectedRevision`。revision 不匹配时不写入事件、不修改租约、不重试动作，
直接返回 `REVISION_CONFLICT`。Renderer 不能根据节点类型推测按钮、成功结果或下一状态；它只能
将 `allowedActions` 映射为用户可读的操作名称、所需输入和风险提示。

## 20. 执行器、终端与 worktree 约束

1. 启动 Agent、交互终端或部署前，Runtime 必须重新读取该 Run、租约和 `allowedActions`，并确认
   `cwd` 等于 Run 的 `execution_workspace`。禁止将运行命令隐式回退到项目 `main` 目录。
2. 可写操作要求 `mode=write` 且租约 `active`；读模式 Run 只能启动经过工具白名单验证的只读作业。
3. 同一 Run 内的多个 Agent 共用该 Run 的租约和 worktree，但受项目级并发上限与 Run 级 Agent
   上限控制。默认上限为每项目 3 个活跃 Run、每 Run 2 个活跃 Agent；设置模块可调整为 1-10，
   Runtime 是最终校验方。
4. 在 `#/runs/new` 创建 worktree 时，Renderer 调用 `POST /projects/{projectId}/worktrees`，默认建议
   分支名为 `run/{uuid}`；随后创建 Run 时只锁定该接口返回的工作区路径。创建 Run 因租约冲突失败时
   不自动删除新 worktree，它会保留为可复用候选项。既有 worktree 的分支绝不被重命名。
5. Run 完成或归档不会自动删除 Git worktree，只释放数据库租约。删除 worktree 是项目模块的独立、
   明确确认操作，且必须先确认无活跃租约。

## 21. Renderer 路由、页面与刷新契约

### 21.1 路由与状态

| 路由 | 必须行为 |
| --- | --- |
| `#/runs` | 当前项目的摘要列表、筛选、刷新和“新建 Run”。点击行进入详情，绝不行内展开。 |
| `#/runs/new` | 选择当前项目绑定的工作流版本、填写名称和目标、选择或创建 worktree。无可用工作流时给出进入工作流库创建并绑定的入口。 |
| `#/runs/:runId` | 加载该 Run overview；首屏固定展示进度图、当前环节、下一环节和 Runtime 授权动作。 |
| `#/runs/:runId/terminal/:jobId` | 只打开指定 Run 与作业的终端，返回时回到同一 Run 详情。 |
| `#/artifacts?runId=:runId` 等次级页 | 必须同时保留当前项目和 Run 上下文，并提供返回该 Run 详情的入口。 |

应用状态拆分为 `WorkspaceSession`、`RunListState` 与按 `runId` 隔离的 `RunDetailState`。禁止再使用
全局唯一 `state.projection` 作为页面数据来源。路由中的 `runId` 是详情选择的唯一来源；本地存储
只能记录最近访问项，不能覆盖路由。

### 21.2 详情页可见信息与操作

详情页首屏的顺序固定为：返回列表与 Run 标识、Run 状态和工作区、完整进度图、当前工作环节卡、
下一工作环节说明、主要授权操作、其他授权操作。当前节点卡必须显示角色、目标、输入、产物、
完成条件、阻塞原因、执行工作区和 Agent 状态；节点悬浮提示显示状态、进入条件、后继节点和
用户下一步，不展示无效或禁用的猜测性按钮。

列表只展示标题、工作流版本、进度、当前/下一环节、状态、首条阻塞原因、工作区、活动数和更新时间。
列表动作仅限进入详情、暂停、恢复、归档等无额外输入且被授权的低风险操作；节点推进、Agent 启动、
产物提交、审批、门禁和部署只能在详情页执行。

### 21.3 加载、错误与轮询

1. 列表可见时每 10 秒刷新；详情中的活跃 Run 每 2 秒刷新，其他 Run 每 10 秒刷新。页面隐藏、
   路由改变或请求被替换时必须取消旧请求。
2. 列表初次为空时显示“尚无 Run”与新建入口；筛选无结果时显示“没有符合条件的 Run”与清除筛选。
   两种空态不得混用。
3. `404`、归档、revision 冲突、租约冲突和维护错误严格遵循第 18.3 节。刷新失败保留最近一次
   成功数据并标记更新时间，不得把列表清空为“无 Run”。
4. 成功执行操作后立即用响应 projection 更新详情，并使对应项目的列表摘要失效；不等待切换菜单
   或下一轮轮询才更新节点状态。

## 22. 测试、发布与完成定义

### 22.1 必须自动化的测试矩阵

| 层级 | 必测场景 |
| --- | --- |
| Contracts | 状态、事件、`RunSummaryProjection`、错误响应和 API 请求类型保持一致。 |
| Runtime 单元 | 节点/Run 状态转换、`allowedActions`、revision 拒绝、归档拒绝、读写权限判断。 |
| Persistence 集成 | SQLite 并发创建同一路径可写 Run 只有一个成功；失败事务不残留 Run 或租约；跨项目查询隔离。 |
| Runtime API | 分页与筛选、`Idempotency-Key`、路径项目校验、租约冲突、恢复释放、维护模式和旧链接 404。 |
| Renderer 单元 | 列表不请求逐项详情；路由切换取消旧请求；当前/下一环节与按钮只来自 projection。 |
| Desktop/E2E | 两个 worktree 并行 Run、Agent 确实在对应 worktree 写入、终端与产物回到同一 Run、项目归档后全部写操作被拒绝。 |

所有测试必须在清空旧运行态数据后的新数据库上运行。只有 Renderer、Runtime、Desktop 的全量单元、
集成和 E2E 测试均通过，且第 14 节验收标准全部满足，改造才可视为完成。

### 22.2 发布顺序与回滚边界

1. 打包并验证包含 Runtime、Renderer、Desktop 的候选版本，在独立新数据库执行完整测试矩阵。
2. 进入维护模式，终止旧运行进程并确认没有存活 PID。
3. 清理旧运行态数据，重建 Run 相关表、索引和租约结构，执行健康检查：迁移版本正确、可发现
   worktree、可创建和释放测试租约。
4. 同时发布新版 Runtime 与 Renderer，禁止新 Renderer 请求旧接口或旧 Renderer 请求新接口。
5. 执行冒烟验证：导入项目、绑定工作流、创建两个不同 worktree 的 Run、启动一个 Agent、查看终端、
   归档 Run 并确认租约释放。

运行态数据清理完成后不存在数据级回滚；只能回滚程序包并保持空的新版运行数据。因此第 1 步的
候选版本测试和第 5 步的冒烟验证是发布门槛，任何一项失败均停止发布，不对生产数据执行清理。
