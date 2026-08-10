# 本地 Git 知识库对接与产物回补设计规格

**状态：已按最新代码复核的最终开发基线，可直接编码实施**

> 本文件同时承担产品规格、技术设计和实施计划职责，是本功能唯一开发文档。
> 开发过程中不得再拆分新的子规格或二次方案；如发现契约缺陷，直接修订本文并记录变更。

**初版日期：2026-08-05**

**代码复核日期：2026-08-10**

**适用范围：Renderer、Desktop、Runtime、Contracts、本地 Git 工作区、内置知识库示例包**

## 0. 最新代码基线与适配结论

本文已按 `2026-08-10` 的仓库代码重新核对。仓库 HEAD 仍为提交 `40300ca feat: add project run overview`，
但工作区已合入 2026-08-07 至 2026-08-10 的未提交功能改动：Run 控制台与内嵌 Agent 执行器、Agent roster、
产物扫描反馈、终端项目 Run 发现、Agent 上下文交付（`AgentContextSpec.delivery`）和项目并发控制。
编码时以实际合入后的最新代码为准；如果下列现有契约继续演进，必须先同步修订本文，
不得在实现中静默保留第二套接口或状态模型。

已确认的现状和本功能的适配决定如下：

1. Run 已是 Project 下的一级聚合，所有 Run 子资源 API 使用
   `/projects/{projectId}/runs/{runId}/...`，现已覆盖 projection/overview、agents（含 interactive-session 与
   checkpoints）、terminals、deployments、recovery、timeline、artifacts、approvals、gates。知识变更集属于 Run，
   详情、输出和所有 mutation 也必须完整带上该作用域，与现有 scoped 路由保持同一风格。
2. `RunProjection.revision` 与 `expectedRevision` 已是字符串。新知识库公开契约统一使用不透明字符串 revision，
   Renderer 不解析、不自增；Runtime 可在内部使用十进制字符串递增。
3. Runtime 已使用 `RuntimeContractError` 和 `{ code, message, details?, correlationId }` 错误包络；
   Renderer 已使用 `RuntimeClientError`，Desktop Runtime IPC 已能保留该包络并只转发白名单请求头。
   工作区已新增 `RUN_CONCURRENCY_LIMIT`、`AGENT_CONCURRENCY_LIMIT`、`PROJECT_CONCURRENCY_INVALID` 错误码，
   新增知识错误码不得与 `packages/contracts/src/errors.ts` 的 `ERROR_CODES` 重名。
4. Artifact 已具有 `verified | provisional | invalidated` 状态。只有通过
   `ArtifactRepository.get_for_run(runId, artifactId)` 读取且当前状态为 `verified` 的 Artifact 才能进入知识变更集。
   产物扫描反馈（`RunArtifactScanFeedback`）已落地：变更集创建页的 Artifact 多选应复用扫描结果的四类展示
   （本次新提交/已存在/缺失/无效），但节点完成授权仍完全由 Runtime 的 `allowedActions` 决定。
5. Run 已持有不可变工作流快照、`executionWorkspace`、`workspaceMode` 和 workspace lease。
   知识库是另一份独立本地 Git 仓库：读取 Run Artifact 不占用知识库写锁，知识库写入也不复用 Run workspace lease。
6. Runtime 已有 `agent_jobs`、`agent_output_events`、`CliAgentExecutor`、取消、输出轮询、interactive session
   和 checkpoint 基础设施，并新增 scoped 的 `cleanup_scoped_orphan_agent_jobs` 恢复入口。变更集生成必须扩展并
   复用这些能力；知识任务的重启恢复沿用现有 orphan 检测模式，不再新建平行的知识 Agent 输出体系。
   项目并发控制（`maxActiveRuns`/`maxActiveAgents`）已落地：知识库 Agent 作业是平台级/后台任务，复用 `agent_jobs`
   时不得复用 Run Agent 启动路径的 `AGENT_CONCURRENCY_LIMIT` 检查，默认不计入项目配额；如产品后续要求纳入配额，
   必须先修订本文。为避免完全不受限，知识任务单独设置并发上限：规则发现与变更集生成各最多 2 个同时活动作业，
   超限按 409 拒绝并返回当前活动 job 信息（复用 `KNOWLEDGE_JOB_ALREADY_RUNNING` 语义），由 Task 6 落实并测试。
7. Renderer 已有 `scopedPageModel.ts`、`RuntimeClientError`、带取消信号的 Runtime client，并新增
   `runAgentExecutorModel.ts`、`RunAgentExecutor`、`terminalRunModel.ts` 等 Run 内执行器与轮询组件。
   Run 范围的知识页面复用这些机制（generation 丢弃、轮询、取消、只读状态）；仓库管理与示例初始化仍是平台级页面。
8. Runtime 路由目前集中在 `api/app.py`。本功能可以增加独立 `APIRouter`，但必须由 `create_app()` 显式注册，
   并继续经过现有本地认证、中间件、请求锁和异常处理器。
9. `runtime/workflow-runtime.spec` 已使用 `collect_data_files('workflow_platform')`，打包脚本也使用
   `--collect-data workflow_platform`。示例 Markdown 放进 Python 包即可被收集，不预设额外 `--add-data` 修改。
10. `runtime/src/workflow_platform/examples/` 已存在全功能工作流示例。知识库示例必须作为其子包共存，
    不创建第二个相互竞争的 `knowledge/examples` 根。
11. 旧 `/knowledge/candidates`、`/knowledge/syntheses`、`/knowledge/documents` API 以及旧知识 Git IPC 当前仍存在。
    新链路上线前保持兼容；只有在新 UI 不再调用后，才在最终清理任务中删除旧写入/推送入口。
12. `migrations.py` 具有旧 Run schema 重建逻辑。新增知识表绝不能加入 `RUN_STATE_TABLES_CHILD_FIRST`，
    否则一次 Run 状态迁移会误删用户的知识库绑定、快照和变更历史。
13. `AgentContextSpec.delivery`（`path | hybrid | summary`）已在 Contracts、Runtime 模型和
    `execution/agent_context.py` 落地（对应 2026-08-10 agent-context-delivery 设计）。知识任务的 Artifact 输入
    遵循同一语义：分析副本以路径为主，prompt 只携带按 delivery 模式生成的摘要；旧配置缺省按 `summary` 兼容。
14. Audit 查询已支持 `runId` 过滤（`AuditRecordRepository.list(run_id=...)`）。知识审计动作
    （`knowledge.change_set.*`、`knowledge.repository.*`）应写入 `runId`，沿用现有审计过滤，不新增第二套审计表。

## 1. 背景

当前软件已经具备以下基础能力：

- 从 Run 及其 Artifact 生成知识候选；
- 通过 Codex、Claude Code 等 Agent CLI 合成知识内容；
- 对候选知识进行人工审核；
- 保存知识文档、合成输出、反馈、审计和 Git 发布记录；
- 将平台内知识文档导出到固定路径。

现有模型仍以“平台内部知识文档”为中心，Git 发布路径固定为
`.workflow-platform/knowledge/{documentId}.md`。它不能完整支持以下目标：

1. 用户导入多个已经存在的本地 Git 知识库；
2. 用户在 Run 中勾选一个或多个 Artifact，选择目标知识库；
3. Agent 阅读目标知识库自己的规则、索引和模板；
4. Agent 按目标知识库原有结构生成跨文件变更；
5. 软件展示计划、风险、差异和校验结果；
6. 低风险变更可自动写入，中高风险变更必须审核；
7. 用户可使用外部 Git 工具，也可在软件内暂存和提交；
8. 软件不要求所有知识库采用某个固定目录或模板。

本规格将知识发布模型从“导出一份平台文档”升级为“对任意本地 Git 知识库生成受控、可审计的变更集”。

## 2. 设计来源与原则

内置示例包参考[微信文章《复杂业务团队的 AI Coding 交付实践：知识库、RD 流程和质量门禁》](https://mp.weixin.qq.com/s/aopO-3KO9lenKF5WHhBD7w)
中关于知识分层、索引路由、候选知识、人工审核和知识回补的方法。

软件只提炼其方法，不复制文章原文或脱敏业务案例。示例包中的规则、模板和案例均为原创内容。

核心原则如下：

1. **模板无关**：目标知识库自身的规则是内容组织的权威来源，平台不强制统一目录。
2. **代码和现有仓库是事实来源**：知识库提供稳定上下文，但易变化的接口、字段、配置和状态仍须回到当前代码或正式 Artifact 核对。
3. **先计划、后写入**：Agent 必须先生成结构化计划和差异预览，不能直接进行不可审查的修改。
4. **风险分级**：新增普通知识可自动写入，修改现有知识、索引、规则或模板必须人工审核。
5. **写入与提交分离**：写入工作区不等于 Git 暂存、提交或推送。
6. **全程可追溯**：每项知识变更都能追溯到 Run、Artifact 版本、规则快照、Agent 作业、审核记录和 Git 提交。
7. **失败关闭**：规则不明确、路径越界、基线变化、Git 冲突或校验失败时禁止写入。
8. **最小变更**：Agent 应更新已有知识而不是复制整套流程；首期禁止删除文件。

## 3. 目标与非目标

### 3.1 首期目标

1. 导入、列出、查看和移除本地已克隆的 Git 知识库绑定。
2. 确认仓库根目录、Git 状态、当前分支和 HEAD。
3. 发现并确认目标知识库的规则、索引、模板和写入边界。
4. 从同一 Run 中选择多个已登记 Artifact 创建知识变更集。
5. 使用用户选择的 Agent Provider 生成变更计划和文件差异。
6. 确定性计算风险等级，并执行对应审核门禁。
7. 在基线未变化时将已批准变更原子写入目标工作区。
8. 提供本地 `status`、`diff`、逐文件 `stage/unstage` 和 `commit`。
9. 提供完整可运行的“复杂业务研发知识库”示例包和纯模板模式。
10. 对规则、生成、审核、写入和 Git 操作记录审计。

### 3.2 首期非目标

1. 不在软件内克隆远程仓库。
2. 不管理 Git 托管平台账号、Token、SSH Key 或登录状态。
3. 不提供内置 `push`、Pull Request 或代码评审平台集成。
4. 不自动提交或自动推送。
5. 不支持 Agent 删除或重命名知识文件。
6. 不自动解决 Git 合并冲突。
7. 不强制目标仓库创建平台配置文件。
8. 不用平台内置示例包覆盖目标仓库的既有规范。
9. 不把向量数据库或语义检索作为本阶段前置依赖。

## 4. 总体架构

```text
Local Git Knowledge Repository
        |
        v
Repository Binding
        |
        +--> deterministic scan
        +--> Agent rule discovery
        +--> human-confirmed Rule Snapshot
        |
Run Artifacts selected by user
        |
        v
Knowledge Change Set
        |
        +--> Agent plan
        +--> proposed file changes
        +--> unified diff
        +--> deterministic validation
        +--> deterministic risk classification
        |
        +--> low risk: auto-apply when enabled
        +--> medium/high risk: human approval
        +--> blocked: no write
        |
        v
Local working tree
        |
        +--> external Git client
        +--> built-in status/diff/stage/unstage/commit
```

Runtime 是知识库绑定、规则快照、变更集、风险、写入授权和审计记录的唯一事实来源。

Renderer 只展示 Runtime 返回的状态和 `allowedActions`，不得自行判断某项变更能否写入、暂存或提交。

Desktop 负责目录选择和受控启动 Agent CLI，但不持有知识库业务状态。项目 worktree 的既有 Git
能力继续由 Desktop 管理；本功能新增的知识库扫描、文件写入和 Git 命令统一由 Runtime 执行并审计，
避免 Runtime 已批准的基线与 Desktop 实际操作的基线不一致。

## 5. 领域模型

### 5.1 `KnowledgeRepositoryBinding`

表示用户导入的一个本地 Git 知识库。

```ts
type KnowledgeRepositoryBinding = {
  id: string;
  name: string;
  rootPath: string;
  canonicalRootPath: string;
  repositoryIdentity: string;
  currentBranch: string | null;
  headCommit: string;
  defaultWritePolicy: "risk-based";
  autoApplyLowRisk: boolean;
  status: "ACTIVE" | "RULES_PENDING" | "BLOCKED" | "REMOVED";
  activeRuleSnapshotId: string | null;
  revision: string;
  createdAt: string;
  updatedAt: string;
};
```

约束：

- `rootPath` 必须是已存在的本地目录；
- 目录必须位于一个有效 Git 工作树的根目录；
- 同一规范化根目录只能存在一个活动绑定；
- `repositoryIdentity` 由规范化路径和 Git 仓库标识生成，不依赖远程地址；
- `autoApplyLowRisk` 默认值为 `false`：LOW 变更集默认进入预览，由用户在仓库设置中显式开启自动写入；
  开启时仍不自动暂存或提交；首次开启时界面必须显著提示“LOW 风险变更将自动写入目标仓库”；
- 首期允许 detached HEAD，但禁止执行内置 commit；
- 仓库存在未解决冲突时允许只读预览，禁止应用变更。

### 5.2 `RepositoryRuleSnapshot`

表示用户确认过的一组知识库规则，不等同于平台模板。

```ts
type RepositoryRuleSnapshot = {
  id: string;
  repositoryId: string;
  revision: string;
  headCommit: string;
  discoveredFiles: RuleFileReference[];
  writablePaths: string[];
  protectedPaths: string[];
  indexFiles: string[];
  routingFiles: string[];
  templateFiles: string[];
  validationCommands: string[];
  summary: string;
  openQuestions: string[];
  source: "manifest" | "agent-discovery" | "hybrid";
  contentHash: string;
  status: "PROPOSED" | "CONFIRMED" | "SUPERSEDED" | "STALE";
  confirmedBy: Actor | null;
  confirmedAt: string | null;
};
```

规则快照只记录规则入口、边界和摘要。执行 Agent 仍需读取快照引用的当前原始文件，防止摘要丢失细节。

### 5.3 可选清单 `.ai-workflow/knowledge-repo.yaml`

该清单用于加速和稳定规则发现，但不是导入前提。

```yaml
version: 1
rules:
  - README.md
  - KNOWLEDGE-RULES.md
routing:
  - ROUTING.md
indexes:
  - INDEX.md
templates:
  - template/**/*.md
writablePaths:
  - main/**
  - applications/**
  - candidate/**
  - personal/**
protectedPaths:
  - .git/**
  - .github/**
  - .ai-workflow/**
validation:
  commands:
    - npm run lint:knowledge
```

约束：

- 清单路径必须相对仓库根目录；
- 解析后必须拒绝绝对路径、`..`、符号链接越界和未知字段；
- `validation.commands` 只能来自用户确认的清单或确认后的规则快照；
- 平台不得让 Agent 自行新增命令后立即执行；
- 规则确认界面必须以独立、不可折叠且高亮的区块逐条展示 `validation.commands` 的精确 argv，
  并标注来源（`manifest` 或 `agent-discovery`）；
- 来源为 `agent-discovery` 的校验命令默认不启用，需用户逐条显式确认后才可执行；
  `manifest` 来源的命令随快照确认自动启用，但确认界面同样完整展示。

### 5.4 `KnowledgeChangeSet`

一次面向目标知识库的完整变更提案。

```ts
type KnowledgeChangeSet = {
  id: string;
  projectId: string;
  repositoryId: string;
  ruleSnapshotId: string;
  runId: string;
  sourceArtifacts: SourceArtifactSnapshot[];
  provider: "codex" | "claude" | "fake";
  agentJobId: string | null;
  baseHeadCommit: string;
  baseWorkingTreeFingerprint: string;
  plan: KnowledgeUpdatePlan | null;
  fileChanges: KnowledgeFileChange[];
  unifiedDiff: string | null;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "BLOCKED" | null;
  riskReasons: string[];
  validationResults: ValidationResult[];
  status: KnowledgeChangeSetStatus;
  approvalId: string | null;
  appliedAt: string | null;
  committedHash: string | null;
  revision: string;
  createdAt: string;
  updatedAt: string;
};
```

`SourceArtifactSnapshot` 必须保存 `artifactId`、`runId`、`nodeId`、`workflowVersionId`、`type`、`uri`、
`contentHash` 和登记时的 `status: "verified"`。Runtime 必须先验证 `projectId -> runId`，再使用
`ArtifactRepository.get_for_run(runId, artifactId)` 验证 `runId -> artifactId`；不得先按全局 Artifact ID 查询后再补归属判断。
溯源使用 Run 创建时保存的不可变工作流快照，不重新读取工作流库中的当前版本。

### 5.5 `KnowledgeFileChange`

```ts
type KnowledgeFileChange = {
  path: string;
  operation: "CREATE" | "UPDATE";
  category: "KNOWLEDGE" | "INDEX" | "ROUTING" | "RULE" | "TEMPLATE";
  reason: string;
  sourceArtifactIds: string[];
  beforeHash: string | null;
  proposedContent: string;
  proposedHash: string;
  warnings: string[];
};
```

首期契约中不存在 `DELETE` 和 `RENAME`。

变更集使用的辅助类型固定如下（`Actor` 复用现有 Contracts 定义）：

```ts
type RuleFileReference = {
  path: string;
  category: "RULE" | "INDEX" | "ROUTING" | "TEMPLATE" | "REFERENCE";
  hash: string;
  sizeBytes: number;
  purpose: string;
};

type SourceArtifactSnapshot = {
  artifactId: string;
  projectId: string;
  runId: string;
  nodeId: string;
  workflowVersionId: string | null;
  type: string;
  uri: string;
  contentHash: string;
  status: "verified";
};

type KnowledgeUpdatePlan = {
  summary: string;
  facts: string[];
  inferences: string[];
  openQuestions: string[];
  files: Array<Pick<KnowledgeFileChange, "path" | "operation" | "reason" | "sourceArtifactIds">>;
};

type ValidationResult = {
  validatorId: string;
  validatorType: "builtin" | "repository-command";
  status: "PASSED" | "FAILED" | "SKIPPED";
  summary: string;
  evidenceUri: string | null;
  evidenceHash: string | null;
};

type KnowledgeGitStatus = {
  rootPath: string;
  commonDir: string;
  branch: string | null;
  headCommit: string;
  dirty: boolean;
  conflict: boolean;
  worktreeFingerprint: string;
  stagedPaths: string[];
  unstagedPaths: string[];
};

type KnowledgeApproval = {
  id: string;
  decision: "approved" | "rejected";
  actor: Actor;
  comment: string;
  artifactHashes: string[];
  ruleSnapshotHash: string;
  targetHashes: string[];
  baseHeadCommit: string;
  unifiedDiffHash: string;
  invalidatedAt: string | null;
};

type KnowledgeAgentOutputEvent = {
  id: string;
  jobId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type KnowledgeChangeSetStatus =
  | "DRAFT" | "GENERATING" | "VALIDATING" | "READY_TO_APPLY"
  | "AWAITING_APPROVAL" | "APPROVED" | "APPLYING" | "APPLIED"
  | "PARTIALLY_STAGED" | "STAGED" | "COMMITTED" | "STALE"
  | "BLOCKED" | "FAILED" | "ABANDONED";
```

## 6. 规则发现

规则发现用于理解目标仓库已经存在的维护方式，不用于替用户发明规则。

### 6.1 确定性扫描

Runtime 首先执行有界扫描：

1. 确认 Git 根目录、分支、HEAD、工作树状态和冲突状态；
2. 检查可选清单；
3. 在仓库根及有限深度内查找常见入口文件：
   `README*`、`AGENTS.md`、`CLAUDE.md`、`INDEX.md`、`ROUTING.md`、
   `KNOWLEDGE-RULES.md` 和模板目录；
4. 只收集文件路径、大小、哈希和有限摘要，不把整个仓库无界装入 Prompt；
5. 默认忽略 `.git`、构建产物、依赖目录、二进制文件和用户配置的敏感目录。

### 6.2 Agent 发现报告

Agent 基于扫描结果生成结构化报告：

- 知识库用途；
- 权威规则入口；
- 索引和路由入口；
- 模板入口；
- 知识分类方式；
- 建议可写目录；
- 建议保护目录；
- 可执行的校验命令；
- 发现依据；
- 未确定项和相互冲突的规则。

Agent 无权把建议直接升级为规则。用户必须确认或编辑报告，Runtime 才创建 `CONFIRMED` 规则快照。

### 6.3 无规则仓库

如果仓库没有足够规则：

- 状态为 `RULES_PENDING`；
- 允许生成只读变更预览；
- 禁止自动写入；
- 软件建议用户确认最小写入边界，或从内置示例包复制规则文件；
- 不得默认把仓库根目录设为全量可写。

## 7. 变更生成流程

### 7.1 创建变更集

用户从 Run 中勾选 Artifact、目标知识库和 Agent Provider。Runtime 校验：

- `projectId -> runId -> artifactId` 归属链完整；
- Artifact 当前状态严格等于 `verified`，且内容哈希复核通过；
- 目标知识库活动且存在已确认规则快照；
- 仓库路径仍指向同一个 Git 工作树；
- 当前 Git 基线可读取。

创建后保存 Artifact 哈希、规则快照哈希、HEAD 和工作树指纹。
复制 Artifact 内容时以 Run 保存的 `executionWorkspace` 为根，使用现有 Artifact preview/安全路径校验读取文件，
重新计算 SHA-256 后才写入分析副本；拒绝绝对路径越界、非文件 URI、当前文件哈希变化和无法读取的 Artifact。
知识任务只读访问 Run workspace，不申请或延长其 workspace lease。

### 7.2 Agent 输入合同

Agent Prompt 按以下顺序组装：

1. 平台安全协议和只允许返回结构化提案的约束；
2. 分析副本中的逻辑仓库根 `input/target` 和允许读取、允许写入、禁止写入的相对路径范围；
3. 已确认规则快照；
4. 规则快照引用的原始规则、索引和模板文件；
5. 选中 Artifact 的路径、类型、哈希及必要内容；摘要按 `AgentContextSpec.delivery` 语义提供
   （`path` 模式不内联摘要，指示 Agent 从分析副本按需读取；`hybrid`/`summary` 模式提供有界摘要）；
6. 与目标主题相关的现有知识文件；
7. 输出 Schema 和风险提示要求。

Agent 必须：

- 区分事实、推断和待确认项；
- 为每个文件变更关联至少一个来源 Artifact；
- 优先更新已有知识，避免重复文件；
- 只在允许范围内提出 `CREATE` 或 `UPDATE`；
- 不执行 Git 命令；
- 不直接写入工作区；
- 不建议删除或重命名文件；
- 遇到规则冲突时输出 `blockedReasons`，不得自行选择一方。

### 7.3 Agent 输出合同

Agent 返回结构化 JSON，至少包含：

```ts
type KnowledgeAgentProposal = {
  summary: string;
  rulesUsed: Array<{ path: string; hash: string; purpose: string }>;
  sourceFindings: Array<{
    artifactId: string;
    facts: string[];
    inferences: string[];
    openQuestions: string[];
  }>;
  plan: Array<{
    path: string;
    operation: "CREATE" | "UPDATE";
    reason: string;
    sourceArtifactIds: string[];
  }>;
  changes: KnowledgeFileChange[];
  blockedReasons: string[];
  suggestedValidation: string[];
};
```

Runtime 必须自行验证 JSON、路径、操作类型、文件基线和内容大小。Agent 声称“低风险”或“校验通过”不具有授权作用。

## 8. 风险分类与审核

风险由 Runtime 根据确定性规则计算，Agent 只能提供风险线索。

### 8.1 `LOW`

同时满足以下条件：

- 只有 `CREATE`；
- 目标路径处于已确认的普通知识写入目录；
- 不属于索引、路由、规则或模板；
- 不修改隐藏目录；
- 无未确定项、冲突和校验失败；
- 仓库允许低风险自动写入。

典型场景：在 `candidate/` 或允许的业务知识目录新增 Markdown。

### 8.2 `MEDIUM`

任一条件成立：

- 更新现有普通知识文件；
- 新增内容会改变既有业务结论；
- 同一主题存在多个可能目标文件；

必须审核统一 diff 后才能写入。

### 8.3 `HIGH`

任一条件成立：

- 更新 `INDEX`、`ROUTING`、规则文件或模板；
- 修改全局业务知识或跨应用约束；
- 覆盖现有结论、调整适用范围或改变知识可信级别；
- 变更包含 Agent 标记的兼容性、权限、隐私或发布风险。

必须由可信人工审核，并填写审核意见。

### 8.4 `BLOCKED`

任一条件成立：

- 路径越界或触及保护目录；
- 包含删除、重命名、符号链接写入或非文本文件；
- 规则不明确或互相冲突；
- 存在 Git 未解决冲突；
- Artifact、规则文件、目标文件、HEAD 或工作树基线发生变化；
- Agent 输出无效；
- 必需校验失败；
- 变更规模超过策略上限。

阻断状态下不得提供写入动作，只能重新扫描、重新生成或放弃。

## 9. 变更集状态机

```text
DRAFT
  -> GENERATING
  -> VALIDATING
  -> READY_TO_APPLY          (LOW；自动写入开启时由 Runtime 立即触发下一步)
  -> APPLYING -> APPLIED
  -> AWAITING_APPROVAL       (MEDIUM/HIGH)
  -> APPROVED
  -> APPLYING
  -> APPLIED
  -> PARTIALLY_STAGED
  -> STAGED
  -> COMMITTED
```

任一非终态可以因基线变化进入 `STALE`，因安全或规则问题进入 `BLOCKED`，因 Agent、校验或 I/O 错误进入 `FAILED`。`STALE`、`BLOCKED` 和 `FAILED` 不得写入。重新生成创建一个带 `supersedesChangeSetId` 的新变更集，旧记录保持不变。用户主动放弃进入 `ABANDONED`。

审核绑定以下集合：

- Artifact 哈希；
- 规则快照哈希；
- 目标文件 `beforeHash`；
- `baseHeadCommit`；
- 最终统一 diff 哈希。

任一成员变化后，旧审核立即失效。

## 10. 安全写入

### 10.1 写入前复核

Runtime 在真正写入前重新检查：

1. Git 根目录与导入时一致；
2. HEAD 与变更集基线一致；
3. 工作树相关文件没有变化；
4. 每个现有目标文件的哈希与 `beforeHash` 一致；
5. 每个目标路径仍位于允许目录；
6. 符号链接解析后没有越过仓库根；
7. 审核仍有效；
8. 校验结果仍满足规则。

### 10.2 原子应用

- 所有新内容先写入仓库内受控临时目录；
- 完成编码、换行符、文件大小和路径检查后再替换目标文件；
- 任一文件写入失败时回滚本次变更集已应用的文件；
- 回滚失败时状态为 `FAILED`，记录受影响路径并禁止继续 Git 操作；
- 成功后计算实际文件哈希并与提案一致；
- 写入不会自动暂存。

## 11. Git 操作边界

### 11.1 首期能力

- 查看当前分支、HEAD 和工作区状态；
- 查看目标知识库的完整 diff 或指定变更集 diff；
- 按文件暂存和取消暂存；
- 提交已暂存文件；
- 展示提交哈希并关联变更集；
- 检测用户通过外部 Git 工具完成的提交。

### 11.2 授权约束

- 写入、暂存和提交是三个独立动作；
- 暂存只允许选择仓库内文件；
- 默认只展示本变更集涉及的文件，但用户可以查看完整仓库状态；
- 如果暂存区包含非本变更集文件，提交前必须明确展示并再次确认；
- detached HEAD、冲突状态、空暂存区或 Git identity 缺失时禁止提交；
- Agent 不得执行 stage、commit、branch、merge、reset、clean 或 push；
- 首期不提供 `push`；
- 不保存 Git 凭据。

默认提交信息：

```text
knowledge: update <topic>

Change-Set: <changeSetId>
Source-Run: <runId>
```

用户可以编辑提交标题和正文，但软件自动追加的追踪字段不可被界面静默删除。

## 12. Renderer 信息架构

### 12.1 路由

| 路由 | 页面职责 |
| --- | --- |
| `#/knowledge/repositories` | 本地知识库列表、导入、状态和规则确认入口 |
| `#/knowledge/repositories/:repositoryId` | 仓库概览、规则快照、边界、Git 状态和历史变更集 |
| `#/knowledge/change-sets/new?projectId=...&runId=...` | 从指定 Run 选择 Artifact、目标仓库和 Agent |
| `#/knowledge/change-sets/:changeSetId?projectId=...&runId=...` | 计划、来源、风险、未确定项、diff、校验、审核和写入 |
| `#/knowledge/repositories/:repositoryId/git` | status、diff、stage、unstage 和 commit |
| `#/knowledge/examples` | 内置示例包预览和初始化 |

仓库列表、仓库详情、Git 面板和示例页是平台级资源，不要求 Run 查询参数。创建和查看变更集是 Run 范围页面，
必须复用 `parseScopedRunRoute` 的规则：`projectId`、`runId` 各出现一次、编码合法、`projectId` 与当前项目一致。
上下文变化时使用新的 generation 和 `AbortSignal` 丢弃旧请求结果，不得把上一个 Run 的变更集短暂显示到当前 Run。

### 12.2 核心交互

导入仓库：

1. 选择本地目录；
2. Runtime 验证 Git 根目录；
3. 执行规则发现；
4. 展示发现依据、建议边界和未确定项；
5. 用户编辑并确认规则快照；
6. 仓库进入 `ACTIVE`。

创建变更集：

1. 从当前 Run 或知识库页面进入；
2. 选择一个或多个 `verified` Artifact；
3. 选择目标知识库和 Agent Provider；
4. 展示即将提供给 Agent 的规则与来源范围；
5. 生成计划和 diff；
6. 根据 Runtime 风险结果显示写入或审核动作。

变更集详情必须将以下信息放在同一可扫描视图中：

- 变更摘要与状态；
- 来源 Artifact；
- 使用的规则；
- 未确定项；
- 文件列表和风险原因；
- diff；
- 校验结果；
- 授权动作。

## 13. Runtime API 最终契约

所有写操作携带可信 Actor、适用时的不透明字符串 `expectedRevision` 和 `Idempotency-Key`。
知识库绑定是平台级本地资源；变更集是 Run 子资源，所有变更集路径必须使用项目和 Run 双重前缀。
Runtime 对每次调用重新验证 `project -> run -> change set`，涉及来源时继续验证 `run -> artifact`，
不得信任请求体里的 `projectId`、`runId` 或已有页面上下文。

### 13.1 知识库

```text
POST   /knowledge-repositories/import
GET    /knowledge-repositories
GET    /knowledge-repositories/{repositoryId}
POST   /knowledge-repositories/{repositoryId}/remove
POST   /knowledge-repositories/{repositoryId}/discover-rules
GET    /knowledge-repositories/{repositoryId}/rule-snapshots
POST   /knowledge-repositories/{repositoryId}/rule-snapshots/{snapshotId}/confirm
GET    /knowledge-repositories/{repositoryId}/git/status
GET    /knowledge-repositories/{repositoryId}/git/diff
GET    /knowledge-repositories/{repositoryId}/rule-discovery-jobs/{jobId}
GET    /knowledge-repositories/{repositoryId}/rule-discovery-jobs/{jobId}/output
POST   /knowledge-repositories/{repositoryId}/rule-discovery-jobs/{jobId}/cancel
```

### 13.2 变更集

```text
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets
GET  /projects/{projectId}/runs/{runId}/knowledge-change-sets
GET  /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/generate
GET  /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/output
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/approve
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/reject
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/apply
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/abandon
GET  /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/git/diff
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/git/stage
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/git/unstage
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/git/commit
```

变更集详情响应必须包含 `allowedActions`。Renderer 不根据风险级别自行拼装按钮。`output` 接口验证变更集归属后，
委托现有 `agent_output_events` 查询，不维护第二份输出流。

## 14. 最终持久化结构

新增表：

- `knowledge_repositories`
- `knowledge_rule_snapshots`
- `knowledge_rule_files`
- `knowledge_change_sets`
- `knowledge_change_set_artifacts`
- `knowledge_file_changes`
- `knowledge_change_set_validations`
- `knowledge_change_set_approvals`
- `knowledge_git_operations`
- `knowledge_idempotency_keys`

现有基础设施的复用边界：

- 候选知识仍可作为单条知识输入；
- 旧 `/projects/{projectId}/runs/{runId}/artifacts/knowledge-syntheses` 保留兼容，新的 Artifact 批量回补入口创建变更集；
- `CliAgentExecutor`、`agent_jobs`、`agent_output_events` 和取消能力复用于规则发现与变更集生成；
- `agent_jobs` 增加任务用途与所有者元数据，不新增 `knowledge_agent_jobs` 或
  `knowledge_agent_output_events`；分析副本、结构化结果和日志仍保存在受控文件中；
- 旧的固定路径导出与 Git 发布记录 API 保留一个兼容周期，但新界面不再调用；
- 数据迁移不自动把旧知识文档写入任何外部仓库。

知识库目标目录与 Run `executionWorkspace` 是两个独立资源。知识任务可只读复制已验证 Artifact，
但不得调用 `_require_execution_lease(..., write_required=True)`，也不得把 Run workspace lease 当作目标仓库写锁。
Runtime 为每个 `repositoryIdentity` 维护独立互斥锁；规则扫描使用读路径，apply、stage、unstage 和 commit
在同一仓库锁内串行，不同仓库可并行。

## 15. 内置示例包

### 15.1 定位

示例包名称为“复杂业务研发知识库”。它有两个初始化模式：

1. **完整示例模式**：包含原创虚构业务案例，用于学习、演示和端到端验证；
2. **纯模板模式**：保留规则、目录、字段说明和模板，移除虚构业务内容，用作新团队起点。

示例包是普通本地 Git 知识库，不拥有平台特权。初始化后必须通过与其他仓库相同的导入、规则发现、变更集和 Git 流程。

源码资产固定存放在
`runtime/src/workflow_platform/examples/knowledge/complex-business/`，与现有
`runtime/src/workflow_platform/examples/full_feature_workflow.py` 同属 `workflow_platform.examples` 包。
初始化器通过 `importlib.resources` 读取资产并复制到用户选择的空目录，禁止依赖源码绝对路径。
完整示例中的业务文件由项目内置并具有原创非空内容；纯模板模式由初始化器根据资源清单省略示例案例，
同时为保留的规则、说明和模板写入完整内容，不创建空文件。

### 15.2 目录

```text
README.md
INDEX.md
ROUTING.md
KNOWLEDGE-RULES.md
.ai-workflow/
  knowledge-repo.yaml
main/
  glossary.md
  cross-application-flow.md
  global-constraints.md
applications/
  _template/
    application.md
    INDEX.md
    domain/
      product/
        README.md
      solution/
        README.md
      base/
        README.md
    tech/
      README.md
  sample-order-service/
    application.md
    INDEX.md
    domain/
      product/
        flow-create-order.md
        state-order-lifecycle.md
      solution/
        partner-a/
          INDEX.md
          compatibility-notes.md
      base/
        api.md
        message.md
        model.md
        repository.md
    tech/
      architecture-constraints.md
      error-and-message-handling.md
candidate/
  README.md
  sample-pending-knowledge.md
personal/
  README.md
  sample-debugging-note.md
template/
  knowledge-entry.md
  application-overview.md
  flow.md
  api.md
  decision-record.md
```

### 15.3 内容要求

所有文件必须包含可读内容，不创建空占位文件。

`README.md`：

- 仓库目的和适用场景；
- 知识分层说明；
- 正式知识、候选知识和个人经验的区别；
- 人工审核和知识回补流程；
- “当前代码仍是实现事实”的声明。

`INDEX.md`：

- 全局领域入口；
- 应用入口；
- 按主题、角色、接口、事件和状态的导航示例；
- 最近复核信息。

`ROUTING.md`：

- 需求澄清、方案设计、编码、问题排查、Code Review 和发布计划分别先读什么；
- 先读应用职责，再读 product 主干，再读 solution 差异，再读 base 和 tech，最后回到代码核对；
- 禁止一次性无界读取整个仓库。

`KNOWLEDGE-RULES.md`：

- 每条知识必须包含适用范围、来源证据、owner、最后验证时间和失效条件；
- 事实、推断和待确认项必须明确区分；
- 未确认结论只能进入 `candidate/`；
- `personal/` 不代表团队正式结论；
- solution 只记录相对 product 的差异，不复制主流程；
- 易变化信息只提供定位入口，改代码前必须核对当前实现；
- 修改索引、路由、规则和模板必须人工审核。

模板文件统一包含以下元数据字段：

```yaml
title: string
scope: string
status: confirmed | candidate | personal
owners: string[]
sources:
  - type: artifact | code | document | incident
    ref: string
lastVerifiedAt: YYYY-MM-DD
confidence: high | medium | low
invalidWhen: string[]
```

完整示例模式使用虚构的订单服务展示：

- 主干创单能力；
- 合作方差异扩展；
- 状态生命周期；
- API、消息、模型和存储索引；
- 一条带证据和待确认项的候选知识；
- 一条明确标记为个人经验的排障记录。

### 15.4 示例包权威内容矩阵

示例包文件不得包含未完成占位文本或空标题。完整模式按下表写入，纯模板模式仅移除
`sample-order-service`、`sample-pending-knowledge.md` 和 `sample-debugging-note.md`，其他规则与模板保持完整。

| 文件 | 必须表达的实际内容 |
| --- | --- |
| `README.md` | 订单履约知识库的虚构背景、五层目录、可信级别、审核流程、代码为事实来源、维护角色 |
| `INDEX.md` | 全局术语、跨应用流程、示例订单服务、候选区、个人区和模板区的可点击相对链接 |
| `ROUTING.md` | clarify/design/implement/debug/review/release 六类任务的读取顺序和停止条件 |
| `KNOWLEDGE-RULES.md` | 元数据字段、事实/推断、candidate 转正、personal 限制、product/solution 差异、更新与删除禁令 |
| `.ai-workflow/knowledge-repo.yaml` | 第 5.3 节清单；`validation.commands` 为空数组，避免示例依赖外部工具 |
| `main/glossary.md` | “订单、履约单、服务单、业务身份、回告事件”五个虚构术语及适用范围 |
| `main/cross-application-flow.md` | 网关、订单服务、履约服务的请求/事件链路，明确这是示例而非真实系统 |
| `main/global-constraints.md` | 幂等、事件可重放、状态单向、敏感字段不入知识库四条约束 |
| `_template/application.md` | 职责、非职责、上下游、模块、入口、Owner、验证日期和失效条件字段 |
| `_template/INDEX.md` | product/solution/base/tech 的导航说明和新增文档索引规则 |
| `_template/domain/product/README.md` | 主干业务流程、状态和不变量的收录边界与命名规则 |
| `_template/domain/solution/README.md` | 客户、渠道或区域差异的收录边界，以及禁止复制 product 主流程的规则 |
| `_template/domain/base/README.md` | API、消息、模型、存储入口和“易变事实回代码核对”的规则 |
| `_template/tech/README.md` | 架构约束、错误处理、性能与运维知识的收录边界 |
| `sample-order-service/application.md` | 虚构应用的职责、非职责、上下游、模块、API 与事件入口 |
| `sample-order-service/INDEX.md` | 链接所有示例业务、状态、兼容、基础和技术文档 |
| `flow-create-order.md` | 接单、校验、创建、发事件、回告五步主干流程及失败分支 |
| `state-order-lifecycle.md` | CREATED/ACCEPTED/PROCESSING/COMPLETED/CANCELLED 状态与禁止转换 |
| `partner-a/INDEX.md` | 合作方 A 的差异入口、适用业务身份和回退到 product 的原则 |
| `partner-a/compatibility-notes.md` | 虚构历史字段兼容、终止条件、证据和待复核日期 |
| `base/api.md` | 三个虚构 API 的方法、方向、用途和代码定位占位符格式，不提供真实地址 |
| `base/message.md` | OrderCreated/OrderAdjusted 两个虚构事件的生产者、消费者和幂等键 |
| `base/model.md` | Order/ServiceUnit 的核心字段语义与“需回代码核对”的易变字段标记 |
| `base/repository.md` | OrderRepository 的职责、事务边界和查询语义，不记录真实表名 |
| `architecture-constraints.md` | 主流程与差异扩展的边界、事件异步阶段和禁止跨层写库规则 |
| `error-and-message-handling.md` | 可重试/不可重试异常、死信证据和日志脱敏规则 |
| `candidate/README.md` | candidate 的进入、确认、拒绝和转正规则 |
| `sample-pending-knowledge.md` | 一条置信度 medium 的“合作方 A 可能需要额外状态校验”，包含证据和待确认项 |
| `personal/README.md` | 个人经验不构成正式事实、引用时必须重新验证 |
| `sample-debugging-note.md` | 一条虚构重复事件排查经验，标明个人、日期和不适用范围 |
| `template/knowledge-entry.md` | 第 15.3 节 YAML 元数据和事实、证据、边界、失效条件正文结构 |
| `template/application-overview.md` | 应用职责、上下游、模块、入口和非职责结构 |
| `template/flow.md` | 前置条件、步骤、分支、状态变化、事件和验证点结构 |
| `template/api.md` | 方向、调用方、输入输出语义、错误、幂等和代码定位结构 |
| `template/decision-record.md` | 背景、约束、候选方案、决定、后果、复核条件结构 |

所有示例元数据使用 `owners: [example-team]`、固定示例日期 `2026-08-05`，并在 README 明确
“所有名称和流程均为虚构，只用于演示知识组织与 Agent 更新”。

## 16. 审计与追溯

至少记录以下事件：

- `knowledge.repository.imported`
- `knowledge.repository.rules_discovered`
- `knowledge.repository.rules_confirmed`
- `knowledge.change_set.created`
- `knowledge.change_set.generation_started`
- `knowledge.change_set.generated`
- `knowledge.change_set.validation_completed`
- `knowledge.change_set.approved`
- `knowledge.change_set.rejected`
- `knowledge.change_set.invalidated`
- `knowledge.change_set.applied`
- `knowledge.git.files_staged`
- `knowledge.git.files_unstaged`
- `knowledge.git.commit_created`

审计详情不得记录 Git 凭据或无界保存完整敏感 Artifact 内容。完整 diff 可以作为受控 Evidence 文件保存，数据库记录其 URI 和哈希。

## 17. 错误处理

统一错误码至少包括：

| HTTP | 错误码 | 行为 |
| --- | --- | --- |
| 400 | `KNOWLEDGE_INPUT_INVALID` | 保留表单并标记具体字段 |
| 400 | `KNOWLEDGE_REPOSITORY_NOT_GIT` | 拒绝导入，保留用户选择路径 |
| 409 | `KNOWLEDGE_REPOSITORY_DUPLICATE` | 导航到已有绑定 |
| 409 | `KNOWLEDGE_REVISION_CONFLICT` | 刷新对应仓库或变更集后重新操作 |
| 409 | `KNOWLEDGE_RULES_NOT_CONFIRMED` | 允许预览，禁止写入 |
| 400 | `KNOWLEDGE_PATH_OUTSIDE_REPOSITORY` | 阻断并记录目标路径 |
| 403 | `KNOWLEDGE_PATH_PROTECTED` | 阻断 |
| 409 | `KNOWLEDGE_BASELINE_CHANGED` | 变更集进入 `STALE` |
| 409 | `KNOWLEDGE_GIT_CONFLICT` | 允许只读查看，禁止应用和提交 |
| 422 | `KNOWLEDGE_AGENT_OUTPUT_INVALID` | 保存脱敏诊断，禁止应用 |
| 422 | `KNOWLEDGE_VALIDATION_FAILED` | 进入 `BLOCKED` |
| 409 | `KNOWLEDGE_APPROVAL_INVALIDATED` | 清除可写授权并要求重新审核 |
| 500 | `KNOWLEDGE_APPLY_ROLLBACK_FAILED` | 标记失败并禁止后续 Git 操作 |
| 409 | `KNOWLEDGE_GIT_IDENTITY_MISSING` | 保留暂存状态，引导用户配置 Git |
| 409 | `KNOWLEDGE_CHANGE_SET_NOT_APPLIED` | 拒绝 stage 或 commit 未应用文件 |
| 409 | `KNOWLEDGE_JOB_ALREADY_RUNNING` | 返回当前活动 job |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同一 key 对应了不同请求体，拒绝执行 |
| 404 | `KNOWLEDGE_CHANGE_SET_NOT_FOUND_IN_RUN` | 作用域不匹配，按不存在处理 |
| 409 | `KNOWLEDGE_AGENT_JOB_LOST` | 恢复时 job 已不存在，变更集转为失败 |
| 409 | `KNOWLEDGE_PROVIDER_ISOLATION_UNAVAILABLE` | Provider 不能满足分析根隔离，禁止启动 |
| 413 | `KNOWLEDGE_INPUT_LIMIT_EXCEEDED` | 阻断并显示超限文件 |
| 423 | `KNOWLEDGE_REPOSITORY_BUSY` | 等待同仓库 apply 或 Git 操作结束 |

错误响应统一为：

```json
{
  "code": "KNOWLEDGE_BASELINE_CHANGED",
  "message": "目标知识库基线已变化，请重新生成变更集。",
  "details": {"changeSetId": "...", "changedPaths": ["INDEX.md"]},
  "correlationId": "uuid"
}
```

`details` 只包含安全的相对路径、资源 ID 和期望/实际 revision，不返回文件全文、绝对敏感路径或命令环境。

实现必须直接复用 `runtime_errors.py` 的 `RuntimeContractError` 和 `api/app.py` 的
`runtime_contract_response()`；新 Router 不定义 `_knowledge_error()`、`HTTPException(detail=...)` 或第二个错误映射。
Pydantic 请求校验也应由现有 `RequestValidationError` handler 转换为同一包络：
`code=REQUEST_VALIDATION_FAILED`、安全的字段级 `details.errors` 和 HTTP 400。修改 handler 时保留现有客户端
对旧 `{ detail: ... }` 的兼容解析测试。

Renderer 经 `runtimeClient.ts` 和 Desktop Runtime IPC 接收错误，页面状态只保存 `RuntimeClientError`。
Desktop bridge 继续只允许转发 `Idempotency-Key`，本地认证与 correlation ID 由 Desktop/Runtime 现有链路处理，
知识功能不得把 Runtime Token 暴露给 Renderer。

页面刷新和应用重启后必须恢复规则发现、Agent 生成、审核和 Git 操作的真实状态，不得把进行中任务显示为成功。

## 18. 测试策略

### 18.1 Contracts

- 领域类型、状态、风险等级和 `allowedActions`；
- Agent 输出 Schema；
- API 请求响应类型；
- 禁止 `DELETE`、`RENAME` 和未知风险状态。

### 18.2 Runtime 单元测试

- Git 根目录和重复绑定识别；
- 清单解析、路径规范化和符号链接越界；
- 规则扫描和规则快照失效；
- Artifact 归属、状态和哈希校验；
- `project -> run -> change set -> artifact` 跨项目、跨 Run 和猜测 ID 的拒绝行为；
- 风险分类矩阵；
- 审核绑定和失效；
- 写入前基线复核；
- 多文件原子写入与回滚；
- Git stage、unstage 和 commit 授权。
- 知识仓库锁与 Run workspace lease 相互独立，且同仓库写操作串行、不同仓库可并行。
- `agent_jobs` 复用、purpose/owner 查询、知识任务不触发工作流 node 扫描和遗失 job 恢复。

### 18.3 Runtime API 测试

- 导入、发现、确认、生成、审核、应用和提交完整链路；
- 非可信 Actor 被拒绝；
- revision 冲突和幂等请求；
- 字符串 revision 原样往返，数字 revision 被请求校验拒绝；
- Agent 失败、超时、取消和无效输出；
- 目标仓库在预览后被外部修改；
- 暂存区混入非变更集文件；
- detached HEAD、冲突和 Git identity 缺失。

### 18.4 Renderer 测试

- 本地路径导入流程；
- 规则发现报告的确认和编辑；
- Artifact 多选与上下文预览；
- 风险、未确定项、diff 和校验结果展示；
- 按 `allowedActions` 显示写入、审核和 Git 操作；
- 变更集失效时撤销旧操作入口；
- 页面刷新后恢复实时 Agent 输出。
- Run 查询作用域缺失、重复、编码错误、项目不一致和快速切换时旧响应被丢弃。
- Runtime 错误经浏览器 fetch 与 Desktop IPC 后均恢复为相同 `RuntimeClientError`。

### 18.5 E2E

至少覆盖：

1. 初始化完整示例包；
2. 将示例包作为普通本地仓库导入；
3. Agent 成功发现其规则；
4. 用户确认规则；
5. 从 Run 选择 Artifact；
6. 生成一个低风险新增文件并自动写入；
7. 生成一个修改 `INDEX.md` 的高风险变更并要求审核；
8. 外部修改目标文件后旧审核失效；
9. 应用变更、逐文件暂存并创建本地提交；
10. 重启应用后仍可追溯 Artifact、变更集和 commit。

## 19. 验收标准

首期完成必须同时满足：

1. 可导入至少两个结构不同的本地 Git 知识库，二者无需采用平台目录模板。
2. 无清单仓库可以通过 Agent 发现和人工确认建立规则快照。
3. 有清单仓库可以解析并验证清单，清单仍需形成可审计快照。
4. 用户可从一个 Run 勾选多个当前状态为 `verified` 的 Artifact 创建变更集。
5. Agent 只返回结构化提案，不直接修改文件或执行 Git。
6. Runtime 能稳定区分低、中、高和阻断风险。
7. 中高风险变更未经有效审核不能写入。
8. Artifact、规则、目标文件、HEAD 或工作树变化会使旧变更集或审核失效。
9. 所有写入路径都经过仓库边界、保护目录和符号链接检查。
10. 写入不会自动暂存、提交或推送。
11. 用户可在软件内完成 status、diff、stage、unstage 和本地 commit。
12. 内置示例包所有文件均有实质内容，完整示例和纯模板两种模式均可初始化。
13. 示例包通过普通导入链路完成规则发现和知识更新，不依赖硬编码适配器。
14. 关键动作均可在审计中追溯到 Actor、Run、Artifact、规则快照、diff 和 commit。
15. Runtime、Renderer、Desktop 和 E2E 自动化测试全部通过。
16. 所有 Run 范围知识请求都使用完整 Project/Run 路径，跨作用域 ID 返回 404 且不泄露资源存在性。
17. 新知识表在旧 Run schema 重建测试后仍存在，历史变更集的 Artifact 快照可读取。
18. 开发态和 PyInstaller 打包态读取到相同的非空示例文件集合，无额外绝对路径打包配置。

## 20. 编码阶段

### Phase 1：仓库资源与规则发现

- 新增知识库绑定和规则快照模型；
- 本地 Git 导入；
- 确定性扫描；
- Agent 发现报告；
- 人工确认规则；
- 内置示例包文件生成。

### Phase 2：变更集生成与治理

- Artifact 多选；
- 结构化 Agent 合同；
- diff 生成；
- 风险分类；
- 校验；
- 审核与失效。

### Phase 3：安全写入与本地 Git

- 原子写入和回滚；
- status、diff、stage、unstage、commit；
- 外部提交关联；
- 完整审计和恢复。

### Phase 4：产品化验收

- 完整 Renderer 工作台；
- 示例包端到端用例；
- 打包版真实 Agent CLI 验收；
- 文档、诊断和错误恢复。

## 21. 后续扩展边界

以下能力可以在首期模型上扩展，但不得反向改变本规格的模板无关原则：

- 远程仓库克隆与更新；
- push 和 Pull Request；
- 分支保护与签名提交；
- 多知识库同时回补；
- 知识重复检测和语义检索；
- 知识陈旧度巡检；
- 面向不同知识库的插件式确定性校验器；
- 多 Agent 分别负责抽取、校验和评审。

## 22. 最终决策摘要

- 首期只支持本地已克隆的 Git 知识库。
- 采用目标仓库适配器，不采用固定知识库模板。
- 规则发现由确定性扫描、Agent 理解和人工确认共同完成。
- 生成结果以可审计 `KnowledgeChangeSet` 表达。
- 新增普通知识可按策略自动写入；修改现有知识、索引、规则和模板必须审核。
- 首期禁止删除、重命名、自动提交和 push。
- 应用内提供本地 Git status、diff、stage、unstage 和 commit。
- 内置“复杂业务研发知识库”包含完整原创内容，并提供完整示例与纯模板两种初始化模式。
- 内置示例包用于展示高质量实践，但通过普通适配链路工作，不获得硬编码特权。

## 23. 开发冻结项

以下内容在编码开始前冻结，开发者不需要再次讨论或选择方案：

1. Runtime 是知识库绑定、规则快照、变更集、风险、写入和知识库 Git 操作的唯一事实来源。
2. Desktop 只复用现有目录选择器；不新增知识库 Git IPC，不调用旧的
   `git:preview-knowledge` 或 `git:publish-knowledge` 完成新流程。
3. Agent 永远在 Runtime 管理的临时分析副本中运行，不能以目标知识库为 `cwd`。
4. Agent 通过固定文件 `output/rule-discovery.json` 或 `output/proposal.json` 返回结果；
   stdout 仅用于进度展示。
5. Runtime 读取并验证 Agent 结果后自行生成 diff、风险和授权动作；不接受 Agent 给出的风险结论。
6. 首期只允许 UTF-8 文本的 `CREATE` 和 `UPDATE`，不允许删除、重命名和二进制变更。
7. `LOW` 且仓库开启 `autoApplyLowRisk` 时，在生成和内建校验成功后自动写入；
   关闭该选项时所有变更都停在预览状态。
8. `MEDIUM` 和 `HIGH` 必须由可信人工审核；审核与内容哈希集合绑定。
9. 写入成功不自动 Git stage 或 commit。
10. Git commit 只提交用户实际选择的已暂存文件，不执行 push。
11. 旧候选知识、知识文档和合成 API 保留一个兼容周期，只在“历史知识”视图使用。
12. 内置示例包与普通仓库走完全相同的导入和规则发现流程。
13. 所有变更集 API 都是 Project/Run 作用域；任何服务入口都按
    `projectId -> runId -> changeSetId -> artifactId` 的顺序验证所有权。
14. 所有公开 revision 都是字符串。Renderer 只回传最近一次响应值，不能使用 `+ 1` 预测下一 revision。
15. 知识 Agent 任务复用现有 Agent job、输出和取消设施，并按现有 orphan 模式实现重启恢复；工作流节点 Agent 与知识 Agent
    通过 `purpose` 区分，知识任务完成后不触发节点 Artifact 自动扫描。
16. 知识目标仓库锁与 Run workspace lease 完全独立；不得因为目标仓库可写而授予 Run 工作区写能力，反之亦然。
17. 新 API 只抛出 `RuntimeContractError` 或可被现有 handler 规范化的领域错误，Renderer 只消费
    `RuntimeClientError`，Desktop 不建立新的错误包络。
18. 新知识持久化表不加入 `RUN_STATE_TABLES_CHILD_FIRST`；Run schema 重建后必须通过 `PRAGMA foreign_key_check`。

不存在以下待决项：远程仓库、push、PR、自动提交、删除文件、自动冲突解决、向量检索。

## 24. 最终模块与文件结构

### 24.1 Contracts

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `packages/contracts/src/knowledge.ts` | 新建 | 所有公开知识库类型、枚举、请求响应和运行时守卫 |
| `packages/contracts/src/index.ts` | 修改 | 导出 `knowledge.ts` |
| `packages/contracts/src/contracts.test.ts` | 修改 | 状态、动作和类型运行时测试 |
| `packages/contracts/src/contracts.typecheck.ts` | 修改 | 无效状态、删除操作和缺失字段的编译期测试 |

Renderer 不再在 `runtimeClient.ts` 重复声明新知识库领域类型。

### 24.2 Runtime

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `runtime/src/workflow_platform/knowledge/repository_models.py` | 新建 | Python 枚举、规范化和内部数据结构 |
| `runtime/src/workflow_platform/knowledge/git_gateway.py` | 新建 | `git` 的只读状态、diff、stage、unstage、commit 封装 |
| `runtime/src/workflow_platform/knowledge/rule_discovery.py` | 新建 | 清单解析、确定性扫描、分析副本和规则快照校验 |
| `runtime/src/workflow_platform/knowledge/prompts.py` | 新建 | 规则发现和知识变更 Agent Prompt |
| `runtime/src/workflow_platform/knowledge/proposal.py` | 新建 | Agent JSON 解析、路径校验、diff 和风险分类 |
| `runtime/src/workflow_platform/knowledge/change_set_service.py` | 新建 | 变更集状态机、审核、失效和原子应用 |
| `runtime/src/workflow_platform/knowledge/repository_service.py` | 新建 | 仓库导入、规则任务、Git 操作和领域编排 |
| `runtime/src/workflow_platform/knowledge/agent_runner.py` | 新建 | 用知识任务配置复用 `CliAgentExecutor`，不复用工作流节点前置校验或完成回调 |
| `runtime/src/workflow_platform/examples/knowledge/__init__.py` | 新建 | 使用 `importlib.resources` 列举、预览和初始化两种示例模式 |
| `runtime/src/workflow_platform/examples/knowledge/complex-business/**` | 新建 | 完整示例包的实际非空 Markdown、YAML 与资源清单 |
| `runtime/src/workflow_platform/persistence/knowledge_repositories.py` | 新建 | 新表的 Repository 类 |
| `runtime/src/workflow_platform/persistence/migrations.py` | 修改 | 创建新表、索引，扩展 Agent job 所有权并保证 Run 重建不删除知识表 |
| `runtime/src/workflow_platform/persistence/repositories.py` | 修改 | 扩展 `AgentJobRepository` 的 purpose/owner 查询和 nullable Run 所有权 |
| `runtime/src/workflow_platform/api/knowledge_repositories.py` | 新建 | FastAPI Router 和请求模型 |
| `runtime/src/workflow_platform/api/app.py` | 修改 | 在 `create_app()` 注册 Router，复用现有中间件与错误 handler |
| `runtime/src/workflow_platform/runtime_service.py` | 修改 | 构造并委托给新领域服务；不继续堆积实现细节 |
| `runtime/src/workflow_platform/execution/cli.py` | 修改 | 仅提取可复用 job 执行/回调边界，不削弱现有 CLI 安全限制 |

`runtime/workflow-runtime.spec` 已通过 `collect_data_files('workflow_platform')` 收集包数据，
`scripts/package-runtime.ps1` 也已有 `--collect-data workflow_platform`。首选只新增包内示例文件和打包读取测试；
只有打包测试证明资源缺失时才调整现有收集规则，禁止再增加手写绝对路径或第二套 `--add-data`。

### 24.3 Renderer

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `apps/renderer/src/features/knowledge/KnowledgePage.tsx` | 重写 | 知识库工作台外壳和子路由分发 |
| `apps/renderer/src/features/knowledge/LegacyKnowledgePanel.tsx` | 新建 | 承接现有候选、合成和已发布知识 UI |
| `apps/renderer/src/features/knowledge/RepositoryList.tsx` | 新建 | 本地知识库列表和导入 |
| `apps/renderer/src/features/knowledge/RepositoryDetail.tsx` | 新建 | 规则快照、边界、状态和历史变更集 |
| `apps/renderer/src/features/knowledge/RuleDiscoveryReview.tsx` | 新建 | 编辑并确认规则发现报告 |
| `apps/renderer/src/features/knowledge/ChangeSetCreate.tsx` | 新建 | 选择 Run Artifact、目标仓库和 Provider |
| `apps/renderer/src/features/knowledge/ChangeSetDetail.tsx` | 新建 | 来源、计划、风险、diff、校验、审核和写入 |
| `apps/renderer/src/features/knowledge/KnowledgeGitPanel.tsx` | 新建 | status、diff、stage、unstage 和 commit |
| `apps/renderer/src/features/knowledge/KnowledgeExamples.tsx` | 新建 | 两种示例包预览和初始化 |
| `apps/renderer/src/features/knowledge/knowledgeClient.ts` | 新建 | 新知识库 Runtime API 客户端 |
| `apps/renderer/src/features/knowledge/useKnowledgeChangeSetPage.ts` | 新建 | 基于 `scopedPageModel.ts` 的 Run 作用域加载、轮询和 mutation 后刷新 |
| `apps/renderer/src/features/runs/scopedPageModel.ts` | 复用 | generation、过期响应、刷新、只读和 `RuntimeClientError` 状态 |
| `apps/renderer/src/app/routes.ts` | 修改 | 解析知识库子路由 |
| `apps/renderer/src/app/App.tsx` | 修改 | 移除新知识链路的集中状态，只传运行上下文 |
| `apps/renderer/src/app/runtimeClient.ts` | 修改 | 在现有 hardened request 上增加知识方法；保留结构化错误、headers 与 `AbortSignal` |
| `apps/renderer/src/app/styles.css` | 修改 | 知识库工作台、diff 和审核布局 |

每个新增组件必须有同目录 `.test.tsx`；`knowledgeClient.ts`、Hook 和知识子路由分别有单元测试。
不得复制 `scopedPageModel.ts` 的 reducer，也不得绕过 `runtimeClient.ts` 直接实现第二个 fetch/IPC 错误解析器。

### 24.4 Desktop

新链路复用 `window.workflowProject.selectDirectory()`，所有业务请求都经现有 `window.workflowRuntime.request()`。
Desktop Runtime bridge 继续只转发 `Idempotency-Key` 白名单头并保留结构化 Runtime 错误，不新增知识专用 IPC。
`gitWorkspace.ts` 的项目 worktree 能力保持不变。旧知识发布 IPC `git:preview-knowledge` 和
`git:publish-knowledge` 当前仍由旧 UI 调用；在新链路通过 E2E 且旧 UI 不再调用后，从 Main handler、preload、
Renderer 类型和旧页面按钮一次性删除，防止继续执行“自动写入 + commit + push”。旧知识文档及其历史 Git 发布记录仍可读取；
旧候选、审核、合成和文档 API 保留，不再提供旧 Git 发布写入口。项目 worktree 的 `git:push` 不属于知识库链路，保持不变。

### 24.5 自动化测试

| 文件 | 动作 | 覆盖范围 |
| --- | --- | --- |
| `runtime/tests/test_knowledge_repository_persistence.py` | 新建 | 新表、迁移、排序和恢复 |
| `runtime/tests/test_knowledge_repository_rules.py` | 新建 | 扫描、清单和路径边界 |
| `runtime/tests/test_knowledge_change_sets.py` | 新建 | 输出解析、风险、状态机、审核和原子写入 |
| `runtime/tests/test_knowledge_repository_git.py` | 新建 | status、diff、stage、unstage 和 commit |
| `runtime/tests/test_knowledge_repository_api.py` | 新建 | 完整 API 和错误码 |
| `runtime/tests/test_knowledge_examples.py` | 新建 | 示例包内容与导入 |
| `runtime/tests/test_knowledge_agent_jobs.py` | 新建 | 现有 Agent job 复用、作用域、取消、orphan 恢复和不触发节点扫描 |
| `tests/e2e/knowledge-repository.spec.ts` | 新建 | 完整桌面端流程 |

## 25. 数据库迁移最终定义

在 `migrate(db)` 的现有迁移流程中创建以下表。SQLite 开启外键后，旧数据库迁移不得删除或重建现有知识表。
知识表不加入 `RUN_STATE_TABLES_CHILD_FIRST`。因为旧 Run schema 重建会删除 `runs`、`artifacts` 和
`agent_jobs`，知识变更集对这些对象保存 ID、哈希和元数据快照，但不建立会悬空的数据库外键；
创建和每次 mutation 时仍由服务层执行当前 `project -> run -> artifact/job` 归属校验。

```sql
CREATE TABLE IF NOT EXISTS knowledge_repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  canonical_root_path TEXT NOT NULL UNIQUE,
  repository_identity TEXT NOT NULL,
  current_branch TEXT,
  head_commit TEXT NOT NULL,
  auto_apply_low_risk INTEGER NOT NULL DEFAULT 0 CHECK (auto_apply_low_risk IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RULES_PENDING', 'BLOCKED', 'REMOVED')),
  active_rule_snapshot_id TEXT,
  revision TEXT NOT NULL DEFAULT '1',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_rule_snapshots (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES knowledge_repositories(id) ON DELETE CASCADE,
  head_commit TEXT NOT NULL,
  writable_paths_json TEXT NOT NULL,
  protected_paths_json TEXT NOT NULL,
  index_files_json TEXT NOT NULL,
  routing_files_json TEXT NOT NULL,
  template_files_json TEXT NOT NULL,
  validation_commands_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manifest', 'agent-discovery', 'hybrid')),
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'CONFIRMED', 'SUPERSEDED', 'STALE')),
  revision TEXT NOT NULL DEFAULT '1',
  confirmed_by_json TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_rule_files (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES knowledge_rule_snapshots(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('RULE', 'INDEX', 'ROUTING', 'TEMPLATE', 'REFERENCE')),
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  purpose TEXT NOT NULL,
  UNIQUE(snapshot_id, relative_path)
);

CREATE TABLE IF NOT EXISTS knowledge_change_sets (
  id TEXT PRIMARY KEY,
  supersedes_change_set_id TEXT REFERENCES knowledge_change_sets(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES knowledge_repositories(id),
  rule_snapshot_id TEXT NOT NULL REFERENCES knowledge_rule_snapshots(id),
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'fake')),
  mode TEXT NOT NULL CHECK (mode IN ('preview', 'risk-based')),
  base_head_commit TEXT NOT NULL,
  base_worktree_fingerprint TEXT NOT NULL,
  plan_json TEXT,
  unified_diff_uri TEXT,
  unified_diff_hash TEXT,
  risk_level TEXT CHECK (risk_level IN ('LOW', 'MEDIUM', 'HIGH', 'BLOCKED')),
  risk_reasons_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  agent_job_id TEXT,
  approval_id TEXT,
  committed_hash TEXT,
  revision TEXT NOT NULL DEFAULT '1',
  applied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_change_set_artifacts (
  change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  workflow_version_id TEXT,
  artifact_type TEXT NOT NULL,
  uri TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  artifact_status TEXT NOT NULL CHECK (artifact_status = 'verified'),
  PRIMARY KEY(change_set_id, artifact_id)
);

CREATE TABLE IF NOT EXISTS knowledge_file_changes (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE')),
  category TEXT NOT NULL CHECK (category IN ('KNOWLEDGE', 'INDEX', 'ROUTING', 'RULE', 'TEMPLATE')),
  reason TEXT NOT NULL,
  source_artifact_ids_json TEXT NOT NULL,
  before_hash TEXT,
  proposed_content_uri TEXT NOT NULL,
  proposed_hash TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(change_set_id, relative_path)
);

CREATE TABLE IF NOT EXISTS knowledge_change_set_validations (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id) ON DELETE CASCADE,
  validator_id TEXT NOT NULL,
  validator_type TEXT NOT NULL CHECK (validator_type IN ('builtin', 'repository-command')),
  status TEXT NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'SKIPPED')),
  summary TEXT NOT NULL,
  evidence_uri TEXT,
  evidence_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_change_set_approvals (
  id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES knowledge_change_sets(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor_json TEXT NOT NULL,
  comment TEXT NOT NULL,
  artifact_hashes_json TEXT NOT NULL,
  rule_snapshot_hash TEXT NOT NULL,
  target_hashes_json TEXT NOT NULL,
  base_head_commit TEXT NOT NULL,
  unified_diff_hash TEXT NOT NULL,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_git_operations (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES knowledge_repositories(id),
  change_set_id TEXT REFERENCES knowledge_change_sets(id),
  operation TEXT NOT NULL CHECK (operation IN ('stage', 'unstage', 'commit', 'external-commit-detected')),
  paths_json TEXT NOT NULL,
  commit_hash TEXT,
  actor_json TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_idempotency_keys (
  scope_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope_key, idempotency_key)
);
```

必须同时创建以下索引：

```sql
CREATE INDEX IF NOT EXISTS idx_knowledge_rule_snapshots_repository_updated
  ON knowledge_rule_snapshots(repository_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_change_sets_repository_updated
  ON knowledge_change_sets(repository_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_change_sets_project_run_updated
  ON knowledge_change_sets(project_id, run_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_file_changes_change_set
  ON knowledge_file_changes(change_set_id, relative_path);
CREATE INDEX IF NOT EXISTS idx_knowledge_git_operations_repository_created
  ON knowledge_git_operations(repository_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_idempotency_created
  ON knowledge_idempotency_keys(created_at, scope_key);
```

`status` 的合法值由 Python 和 TypeScript 常量统一测试。由于 SQLite 旧表的 CHECK 约束难以无损扩展，
`knowledge_change_sets.status` 不写数据库 CHECK，由领域层守卫，并在 Contracts 测试中保持完全一致。

现有 `agent_jobs` 需要升级为可表达多种所有者的通用 Agent job。由于当前 `run_id`、`node_id` 是
`NOT NULL`，不能只靠 `ALTER TABLE ADD COLUMN` 完成；迁移必须在关闭外键检查的受控窗口中创建新表、复制旧行、
替换表、重建索引，并在重新开启外键后执行 `PRAGMA foreign_key_check`。该迁移放在当前
`mode/session_id/parent_job_id` 补列逻辑之后，并且只在 `PRAGMA table_info(agent_jobs)` 不含 `purpose` 时执行：

```sql
CREATE TABLE agent_jobs_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  node_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'workflow-node',
    'knowledge-rule-discovery',
    'knowledge-change-set-generation'
  )),
  owner_id TEXT,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  command_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'automatic',
  session_id TEXT,
  parent_job_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  pid INTEGER,
  summary TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (purpose = 'workflow-node' AND project_id IS NOT NULL AND run_id IS NOT NULL AND node_id IS NOT NULL)
    OR
    (purpose = 'knowledge-rule-discovery' AND project_id IS NULL AND run_id IS NULL AND node_id IS NULL AND owner_id IS NOT NULL)
    OR
    (purpose = 'knowledge-change-set-generation' AND project_id IS NOT NULL AND run_id IS NOT NULL AND node_id IS NULL AND owner_id IS NOT NULL)
  )
);

INSERT INTO agent_jobs_v2 (
  id, project_id, run_id, node_id, purpose, owner_id, provider, status,
  command_json, cwd, mode, session_id, parent_job_id, metadata_json,
  pid, summary, error, created_at, updated_at
)
SELECT
  jobs.id, runs.project_id, jobs.run_id, jobs.node_id, 'workflow-node', NULL,
  jobs.provider, jobs.status, jobs.command_json, jobs.cwd, jobs.mode,
  jobs.session_id, jobs.parent_job_id, '{}', jobs.pid, jobs.summary, jobs.error,
  jobs.created_at, jobs.updated_at
FROM agent_jobs AS jobs
JOIN runs ON runs.id = jobs.run_id;

DROP TABLE agent_jobs;
ALTER TABLE agent_jobs_v2 RENAME TO agent_jobs;

CREATE INDEX idx_agent_jobs_run_id ON agent_jobs(run_id);
CREATE INDEX idx_agent_jobs_purpose_owner_updated
  ON agent_jobs(purpose, owner_id, updated_at DESC, id DESC);
```

旧行迁移为 `purpose='workflow-node'`，并从 `runs.project_id` 回填 `project_id`。知识规则发现的 `owner_id`
是 `repositoryId`；变更集生成的 `owner_id` 是 `changeSetId`。`metadata_json` 只保存
`repositoryId`、`snapshotId`、`analysisRoot`、`promptHash`、`resultUri` 和 `resultHash` 等受控元数据，
不保存完整 Prompt、Artifact 正文或 diff。`agent_output_events`、`agent_checkpoints`、`agent_sessions` 和
`artifact_consumers` 保持原表并继续引用替换后的 `agent_jobs`。复制行数必须等于原表行数，否则回滚迁移。

该迁移必须满足以下失败恢复细则：

- 重建前先执行 `CREATE TABLE agent_jobs_backup AS SELECT * FROM agent_jobs;`，备份表与正式表同库保存；
- 复制完成并校验行数一致后，`DROP TABLE agent_jobs` 前再次校验备份表行数等于原表行数；
- `PRAGMA foreign_key_check` 返回非空、行数不一致或任何步骤抛出异常时：删除 `agent_jobs_v2`，
  执行 `DROP TABLE agent_jobs` 后 `ALTER TABLE agent_jobs_backup RENAME TO agent_jobs` 恢复原表，
  写入 `knowledge.migration.agent_jobs_restored` 审计后重新抛出，禁止留下只有 `agent_jobs_v2` 的中间状态；
- 迁移成功后才删除备份表；迁移与知识表创建在同一个受控窗口内完成，任何一步失败都不提交部分 schema。

`knowledge_change_sets.agent_job_id` 不建立外键：如果旧 Run schema 重建清除了瞬时 Agent job，
`GENERATING` 变更集在恢复扫描中转为 `FAILED` 并写入 `KNOWLEDGE_AGENT_JOB_LOST`，历史来源快照仍保留。

所有新 mutation 使用 `knowledge_idempotency_keys`。`scope_key` 是 Runtime 构造的稳定资源键：导入为
`knowledge-repositories`，示例初始化为 `knowledge-example:{exampleId}:{canonicalTargetPath}`，变更集创建为
`project:{projectId}:run:{runId}:knowledge-change-sets`，其余操作为目标资源完整规范路径。相同 key 与相同
`request_hash` 在 24 小时窗口内重放已保存的 status/body；相同 key 配不同 hash 返回
`IDEMPOTENCY_KEY_REUSED`。响应写入与领域 mutation 必须在同一事务提交。

## 26. Contracts 最终定义

`packages/contracts/src/knowledge.ts` 必须导出以下常量，并由字面量推导联合类型：

```ts
export const KNOWLEDGE_REPOSITORY_STATUSES = [
  "ACTIVE", "RULES_PENDING", "BLOCKED", "REMOVED",
] as const;
export const KNOWLEDGE_RULE_SNAPSHOT_STATUSES = [
  "PROPOSED", "CONFIRMED", "SUPERSEDED", "STALE",
] as const;
export const KNOWLEDGE_CHANGE_SET_STATUSES = [
  "DRAFT", "GENERATING", "VALIDATING", "READY_TO_APPLY",
  "AWAITING_APPROVAL", "APPROVED", "APPLYING", "APPLIED",
  "PARTIALLY_STAGED", "STAGED", "COMMITTED", "STALE",
  "BLOCKED", "FAILED", "ABANDONED",
] as const;
export const KNOWLEDGE_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "BLOCKED"] as const;
export const KNOWLEDGE_FILE_OPERATIONS = ["CREATE", "UPDATE"] as const;
export const KNOWLEDGE_FILE_CATEGORIES = [
  "KNOWLEDGE", "INDEX", "ROUTING", "RULE", "TEMPLATE",
] as const;
```

公开实体在第 5 节类型基础上统一增加：

```ts
type AllowedKnowledgeAction =
  | "discover-rules" | "confirm-rules" | "update-settings" | "remove-repository"
  | "create-change-set" | "generate" | "approve" | "reject"
  | "apply" | "abandon" | "stage" | "unstage" | "commit";

type KnowledgeRepositoryDetail = KnowledgeRepositoryBinding & {
  gitStatus: KnowledgeGitStatus;
  activeRuleSnapshot: RepositoryRuleSnapshot | null;
  recentChangeSets: KnowledgeChangeSetSummary[];
  allowedActions: AllowedKnowledgeAction[];
};

type KnowledgeChangeSetDetail = KnowledgeChangeSet & {
  repository: Pick<KnowledgeRepositoryBinding, "id" | "name" | "rootPath">;
  ruleSnapshot: RepositoryRuleSnapshot;
  output: KnowledgeAgentOutputEvent[];
  approval: KnowledgeApproval | null;
  allowedActions: AllowedKnowledgeAction[];
};

type KnowledgeAgentJobSummary = {
  id: string;
  projectId: string | null;
  runId: string | null;
  nodeId: string | null;
  purpose: "knowledge-rule-discovery" | "knowledge-change-set-generation";
  ownerId: string;
  provider: "codex" | "claude" | "fake";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
```

所有写请求统一含有：

```ts
type KnowledgeMutationEnvelope = {
  actor: Actor;
  expectedRevision: string;
  now: string;
};
```

`revision` 与 `expectedRevision` 沿用当前 Run 契约，属于不透明并发令牌。测试可以使用 `"1"`、`"2"`，
但任何 Renderer、Desktop 或 API 调用方都不得把它转成 number、排序或自行递增。

列表 API 返回 `{ items, nextCursor }`，首期 `limit` 默认 20、最大 100，按 `updatedAt DESC, id DESC`。
游标由 Runtime 生成，Renderer 不解析。

## 27. API 请求响应精确定义

### 27.1 导入与示例初始化

```http
POST /knowledge-repositories/import
Idempotency-Key: <uuid>

{
  "name": "物流知识库",
  "rootPath": "D:\\knowledge\\logistics",
  "autoApplyLowRisk": false,
  "actor": { ...trustedHuman },
  "now": "2026-08-07T12:00:00Z"
}
```

成功返回 `201 KnowledgeRepositoryDetail`。Runtime 必须：规范化路径、拒绝 Git 子目录、确认仓库根、
计算 `HEAD`、当前分支、冲突状态和 `repositoryIdentity`，然后以 `RULES_PENDING` 创建绑定。
导入不会自动启动 Agent，界面随后显式调用规则发现。`autoApplyLowRisk` 默认 `false`，示例按默认值展示；
仅当用户在该仓库设置中显式开启时才传 `true`。
若 `canonicalRootPath` 已有活动绑定，返回 409 `KNOWLEDGE_REPOSITORY_DUPLICATE` 和已有 `repositoryId`；
若已有 `REMOVED` 绑定，则在同一记录上恢复为 `RULES_PENDING`、推进 revision、保留历史变更集，
并把旧活动快照标记 `STALE`，不得因唯一约束创建第二条记录。

```http
GET  /knowledge-examples
POST /knowledge-examples/{exampleId}/initialize

{
  "mode": "complete" | "template",
  "targetPath": "D:\\knowledge\\new-kb",
  "initializeGit": true,
  "actor": { ...trustedHuman },
  "now": "..."
}
```

目标目录必须不存在或为空。`initializeGit=true` 时 Runtime 执行 `git init`，但不创建初始 commit。
返回 `{ rootPath, createdFiles, gitInitialized }`，用户仍需通过普通导入 API 绑定。
初始化先写入目标父目录下的唯一 staging 目录，逐文件校验资源清单中的相对路径、非空内容和 SHA-256。
目标不存在时整体原子移动；目标已存在且为空时逐文件原子移动并记录本次创建清单。失败只清理 staging 和本次创建的文件，
不删除进入操作前已存在的任何内容。

### 27.2 规则发现

```http
POST /knowledge-repositories/{repositoryId}/discover-rules
Idempotency-Key: <uuid>

{
  "provider": "codex" | "claude" | "fake",
  "actor": { ...trustedHuman },
  "expectedRevision": "1",
  "now": "..."
}
```

成功返回 `202 { jobId, repositoryId, status: "QUEUED" }`。

```http
GET  /knowledge-repositories/{repositoryId}/rule-discovery-jobs/{jobId}
GET  /knowledge-repositories/{repositoryId}/rule-discovery-jobs/{jobId}/output?afterSequence=0
POST /knowledge-repositories/{repositoryId}/rule-discovery-jobs/{jobId}/cancel
```

这三个接口必须同时验证 `purpose=knowledge-rule-discovery` 且 `ownerId=repositoryId`。任务成功后，
第一个 API 返回 `result`，其内容是 `PROPOSED RepositoryRuleSnapshot`；输出来自现有
`agent_output_events`。取消是 mutation，携带 `Idempotency-Key`、可信 Actor 和仓库 `expectedRevision`。

确认 API：

```http
POST /knowledge-repositories/{repositoryId}/rule-snapshots/{snapshotId}/confirm

{
  "writablePaths": ["main/**", "applications/**", "candidate/**", "personal/**"],
  "protectedPaths": [".git/**", ".github/**", ".ai-workflow/**"],
  "indexFiles": ["INDEX.md"],
  "routingFiles": ["ROUTING.md"],
  "templateFiles": ["template/knowledge-entry.md"],
  "validationCommands": [],
  "summary": "...",
  "openQuestions": [],
  "actor": { ...trustedHuman },
  "expectedRevision": "1",
  "now": "..."
}
```

Runtime 重新读取所有引用文件并生成最终哈希。确认成功后：

- 旧 `CONFIRMED` 快照变成 `SUPERSEDED`；
- 新快照变成 `CONFIRMED`；
- 仓库 `active_rule_snapshot_id` 指向新快照；
- 仓库状态变成 `ACTIVE`；
- 仓库 revision 通过 Runtime `next_revision()` 推进，并将新字符串返回给调用方。

不允许确认仍有 `openQuestions` 的快照。用户必须编辑解决后再提交确认请求。

### 27.3 创建与生成变更集

```http
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets
Idempotency-Key: <uuid>

{
  "repositoryId": "knowledge-repository-...",
  "artifactIds": ["artifact-a", "artifact-b"],
  "provider": "codex",
  "mode": "risk-based" | "preview",
  "actor": { ...trustedHuman },
  "now": "..."
}
```

成功返回 `201 KnowledgeChangeSetDetail`，状态为 `DRAFT`。`mode=preview` 永不自动应用。

```http
GET /projects/{projectId}/runs/{runId}/knowledge-change-sets?cursor=<optional>&limit=20
GET /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}
GET /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/output?afterSequence=0
```

列表只返回该 Run 的变更集；详情和输出先校验 change set 同时匹配路径中的 `projectId`、`runId`。
输出接口再校验 `agentJobId` 指向 `purpose=knowledge-change-set-generation` 且 `ownerId=changeSetId` 的现有 Agent job。
任何一层不匹配统一返回 404 `KNOWLEDGE_CHANGE_SET_NOT_FOUND_IN_RUN`，不得泄露资源是否存在于其他项目或 Run。

```http
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/generate
Idempotency-Key: <uuid>

{ "actor": { ...trustedHuman }, "expectedRevision": "1", "now": "..." }
```

成功返回 `202 { jobId, changeSetId, status: "QUEUED" }`。完成后 Runtime 自动解析输出、运行内建校验、
计算 diff 和风险，并将变更集推进到下一合法状态。该 job 使用
`purpose=knowledge-change-set-generation`、`projectId`、`runId` 和 `ownerId=changeSetId`；不要求工作流节点 ID，
完成后不得调用 `_scan_completed_agent_artifacts()`。

### 27.4 审核、应用和失效

```http
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/approve
{ "comment": "已核对扩展点和索引变更", "actor": ..., "expectedRevision": "4", "now": "..." }

POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/reject
{ "comment": "来源不足，退回补充", "actor": ..., "expectedRevision": "4", "now": "..." }

POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/apply
{ "actor": ..., "expectedRevision": "5", "now": "..." }

POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/abandon
{ "reason": "不再需要", "actor": ..., "expectedRevision": "4", "now": "..." }
```

`approve` 只接受 `AWAITING_APPROVAL`；`apply` 只接受 `READY_TO_APPLY` 或 `APPROVED`。
`reject` 进入 `ABANDONED` 并保留拒绝记录，不允许在原变更集上重新生成。

每次读取变更集详情时，Runtime 执行轻量基线检查。如果哈希集合改变，先在事务中将其标记为 `STALE`
并使审核失效，再返回新状态。任何写 API 都必须执行同样检查。

### 27.5 Git API

```http
GET  /knowledge-repositories/{repositoryId}/git/status
GET  /knowledge-repositories/{repositoryId}/git/diff?scope=working|staged
GET  /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/git/diff?scope=working|staged
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/git/stage
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/git/unstage
POST /projects/{projectId}/runs/{runId}/knowledge-change-sets/{changeSetId}/git/commit
```

仓库级两个 GET 只提供全仓只读状态。任何会读取或改变变更集状态的 Git 调用都使用完整 Project/Run/Change-Set
路径，并在查找目标仓库前验证变更集的 `repositoryId` 与请求所操作的仓库一致。

Stage/unstage 请求：

```json
{
  "paths": ["candidate/order-adjustment.md"],
  "actor": { ... },
  "expectedRepositoryRevision": "7",
  "expectedRevision": "5",
  "now": "..."
}
```

路径中的 `changeSetId` 是唯一变更集来源。`expectedRepositoryRevision` 指知识库绑定 revision，
`expectedRevision` 指变更集 revision；Runtime 必须在同一短事务中验证并分别推进两个令牌。

Commit 请求：

```json
{
  "title": "knowledge: update order adjustment",
  "body": "Update verified order-adjustment knowledge.",
  "paths": ["candidate/order-adjustment.md"],
  "actor": { ... },
  "expectedRepositoryRevision": "8",
  "expectedRevision": "6",
  "now": "..."
}
```

Runtime 将追踪字段追加到正文。Commit 成功返回 `{ commitHash, branch, committedPaths }`，关联变更集进入
`COMMITTED`。`paths` 必须是路径中变更集已 `APPLIED` 的文件子集；仓库级没有 commit mutation，
从 API 结构上保证每次内置 Git 提交都能追溯到 Project、Run 和变更集。

Stage/unstage 完成后，Runtime 以该变更集全部 `APPLIED` 路径为全集重新计算状态：无路径 staged 为 `APPLIED`，
部分 staged 为 `PARTIALLY_STAGED`，全部 staged 为 `STAGED`。外部 Git 工具改变暂存区时，下一次详情或
Git status 请求执行同一计算并更新状态；检测到包含全部变更路径的外部 commit 时记录
`external-commit-detected` 并进入 `COMMITTED`。

### 27.6 设置与移除

```http
POST /knowledge-repositories/{repositoryId}/settings
{ "autoApplyLowRisk": false, "actor": ..., "expectedRevision": "3", "now": "..." }

POST /knowledge-repositories/{repositoryId}/remove
{ "actor": ..., "expectedRevision": "3", "now": "..." }
```

移除只是解除绑定并设置 `REMOVED`，不删除本地目录、Git 数据、变更集或审计记录。存在运行中 Agent
任务时拒绝移除。

## 28. Agent 分析副本与输出文件

### 28.1 分析副本

每个 Agent 任务创建唯一目录：

```text
<runtime-db-parent>/knowledge-jobs/<jobId>/
  input/
    artifacts/<artifactId>.<ext>
    rules/<relative-rule-files>
    target/<relative-target-files>
    manifest.json
  output/
    rule-discovery.json      # RULE_DISCOVERY
    proposal.json            # CHANGE_SET_GENERATION
  logs/
    output.ndjson
```

`runtime-db-parent` 是 `WORKFLOW_PLATFORM_RUNTIME_DB` 所指数据库的父目录；默认开发环境即
`.workflow-platform/`。规则发现任务只复制确定性扫描选中的入口与有限摘要，变更集任务只复制已确认规则、
选中 Artifact 和相关目标文件；Agent 的 `cwd` 是该任务目录，不是目标仓库，也不是 Run `executionWorkspace`。
复制规则：

- 规则文件按原相对路径复制到 `input/rules`；
- 选中 Artifact 复制到 `input/artifacts`，文件名由安全 Artifact ID 和原始扩展名组成；
- 目标文件复制到 `input/target`；
- 所有输入文件在 `manifest.json` 登记 `path`、`sizeBytes`、`sha256` 和来源；
- 限制单文件 2 MiB、单个 Artifact 10 MiB、规则文件总量 20 MiB、目标文件总量 20 MiB；
- 超限进入 `BLOCKED`，不截断、不静默丢弃；
- 任何符号链接不复制其目标，只记录为不支持并阻断相关路径；
- 完成任务后把 `output`、manifest 和有限日志保留为持久证据，清理 `input` 内容；
  `knowledge_file_changes.proposed_content_uri` 必须指向持久 output，不得指向会被系统临时目录清理的文件；
- Runtime 启动时扫描 `QUEUED`/`RUNNING` 知识 job：进程已不存在则标记为可恢复失败，
  不得把缺失任务显示为完成。

### 28.2 Agent CLI 允许能力

调用现有 `CliAgentExecutor`，但由 `knowledge/agent_runner.py` 提供知识任务配置：

- Codex：`codex exec --json --sandbox workspace-write --skip-git-repo-check --cd <analysisRoot> -`；
- Claude：使用现有 provider 的非交互 JSON 输出；
- allowed tools 只允许读取分析副本和写入 `output/`；
- 禁止 Git 命令、网络访问、目标仓库路径访问和项目外 cwd；
- 超时默认 300 秒，最大 900 秒；
- 输出上限 2 MiB；
- 只信任 output 文件，不信任 stdout 中的 Markdown 或 JSON。

Runner 调用 `CliAgentExecutor.run()` 时必须同时传 `cwd=analysisRoot` 与 `project_root=analysisRoot`，
复用现有 cwd 边界和环境白名单。它直接写入/读取 `AgentJobRepository`，不得调用现有
`start_agent_job()` 的工作流 node 校验、Run write lease、上下文 Artifact 消费或完成后 Artifact 扫描。
知识任务首期不创建 `agent_sessions` 或 `agent_checkpoints`：它们当前都绑定工作流 Run/node 语义。
重启时把遗留 `QUEUED`/`RUNNING` job 标记失败，用户通过重新发现或创建 superseding change set 重试；
不要为了本功能扩展交互式 Agent 会话。
`CliAgentExecutor` 当前只提供进程级 cwd、环境白名单和 provider 命令约束；实现知识任务时必须增加测试，
确认 Prompt、命令参数、环境和 manifest 均不包含目标仓库绝对路径。若某 provider 不能保证只写分析根，
该 provider 对知识任务返回 `KNOWLEDGE_PROVIDER_ISOLATION_UNAVAILABLE`，不得仅依赖 Prompt 承诺继续运行。
Agent 完成后检查 output 文件是本 job 创建、没有符号链接、解析后的真实路径位于 output 根且大小未超限。
写入 `agent_jobs.command_json` 前调用 `redact_command()`：保留可诊断的 executable、固定 flag 和分析根，
移除 Claude `-p` 后的完整 Prompt 以及任何包含 Artifact 正文的参数；完整 Prompt 只以哈希和受控分析文件引用存在。

### 28.3 Prompt 固定结构

`prompts.py` 生成以下段落，顺序不可变：

```text
ROLE
  你是知识库维护 Agent。你只分析，不直接修改目标仓库。
AUTHORITY
  规则文件决定目标仓库组织方式；当前 Artifact 是本次输入；代码/正式产物是实现事实。
BOUNDARIES
  只能读取 input/；只能写 output/；禁止删除、重命名、Git、网络和凭据访问。
TASK
  根据输入完成规则发现或生成知识变更提案。
REQUIRED_REASONING
  分开输出事实、推断、未确定项；每项变更必须引用 Artifact；遇到冲突必须阻断。
OUTPUT
  严格按给定 JSON Schema 写入指定 output 文件；stdout 仅输出进度。
```

Prompt 具体内容以 `manifest.json` 的 JSON 形式嵌入，不允许使用未经转义的用户文本拼接系统命令。

知识任务的 Artifact 输入遵循 `AgentContextSpec.delivery`（2026-08-10 已落地）：`path` 模式不内联文件摘要，
prompt 指示 Agent 从分析副本按需读取；`hybrid`/`summary` 模式内联有界摘要。规则发现任务同样按需读取
`input/target`，不在 prompt 内联全部仓库文件。

### 28.4 `rule-discovery.json` Schema

```json
{
  "version": 1,
  "summary": "string",
  "ruleFiles": [
    {"path": "README.md", "category": "RULE", "purpose": "string"}
  ],
  "indexFiles": ["INDEX.md"],
  "routingFiles": ["ROUTING.md"],
  "templateFiles": ["template/knowledge-entry.md"],
  "suggestedWritablePaths": ["candidate/**"],
  "suggestedProtectedPaths": [".git/**"],
  "suggestedValidationCommands": [],
  "findings": ["string"],
  "openQuestions": ["string"],
  "conflicts": ["string"]
}
```

Runtime 强制：`version=1`、所有路径相对且规范化、所有数组元素为字符串、无未知字段、
`openQuestions` 和 `conflicts` 非空时不得确认。

### 28.5 `proposal.json` Schema

```json
{
  "version": 1,
  "summary": "string",
  "rulesUsed": [
    {"path": "KNOWLEDGE-RULES.md", "sha256": "64 hex chars", "purpose": "string"}
  ],
  "sourceFindings": [
    {
      "artifactId": "artifact-1",
      "facts": ["string"],
      "inferences": ["string"],
      "openQuestions": ["string"]
    }
  ],
  "changes": [
    {
      "path": "candidate/example.md",
      "operation": "CREATE",
      "reason": "string",
      "category": "KNOWLEDGE",
      "sourceArtifactIds": ["artifact-1"],
      "content": "UTF-8 markdown",
      "warnings": []
    }
  ],
  "suggestedValidation": ["npm run lint:knowledge"],
  "blockedReasons": []
}
```

Runtime 解析时把 `content` 写入受控的临时 URI，再写入 `knowledge_file_changes.proposed_content_uri`；
不把大文件全文放入 SQLite。

## 29. 基线、哈希与风险算法

### 29.1 路径和哈希

统一使用：

- Windows 路径先 `Path.resolve()`，再转换为 `/` 分隔的仓库相对路径；
- 拒绝空路径、绝对路径、`.`、`..`、NUL、控制字符和路径规范化前后不一致的输入；
- 文件哈希使用 SHA-256，小写十六进制；
- 工作树指纹为 `git status --porcelain=v1 -z` 的 SHA-256；
- HEAD 为 `git rev-parse HEAD`，无 commit 的仓库使用 `EMPTY_HEAD`；
- 仓库 Identity 为 `sha256(canonicalRootPath + "\\n" + gitCommonDir)`。

### 29.2 基线失效

`check_change_set_baseline()` 按以下顺序执行：

1. 重新解析绑定根目录和 Git common dir；
2. 读取当前 HEAD；
3. 读取工作树指纹；
4. 读取每个 `UPDATE` 文件的当前哈希；
5. 读取规则快照每个引用文件的当前哈希；
6. 读取来源 Artifact 的当前哈希和状态。

任一步不一致，在 `BEGIN IMMEDIATE` 中：

- 变更集状态改为 `STALE`；
- 关联审核的 `invalidatedAt` 写入当前时间；
- 写入 `knowledge.change_set.invalidated` 审计；
- 不调用 Agent、不写文件、不运行仓库命令。

### 29.3 风险判定伪代码

```python
def classify(change_set, snapshot, repository):
    reasons = []
    if any(change.operation not in {"CREATE", "UPDATE"} for change in change_set.changes):
        return "BLOCKED", ["unsupported file operation"]
    if any(not is_writable(change.path, snapshot.writable_paths) for change in change_set.changes):
        return "BLOCKED", ["path outside writable paths"]
    if any(is_protected(change.path, snapshot.protected_paths) for change in change_set.changes):
        return "BLOCKED", ["protected path"]
    if change_set.open_questions or change_set.blocked_reasons:
        return "BLOCKED", ["unresolved questions or agent blockers"]
    if any(result.status == "FAILED" for result in change_set.validations):
        return "BLOCKED", ["validation failed"]
    if any(change.category in {"RULE", "ROUTING", "TEMPLATE"} for change in change_set.changes):
        return "HIGH", ["rules, routing, or templates changed"]
    if any(change.operation == "UPDATE" for change in change_set.changes):
        return "MEDIUM", ["existing knowledge changed"]
    return "LOW", reasons
```

算法必须是 Runtime 纯函数，给定同一 proposal、snapshot 和 repository policy 得到同一结果。

### 29.4 内建校验

无论 Agent 是否建议，都执行：

1. JSON Schema 与路径校验；
2. UTF-8、文件大小、Markdown 字符串和换行校验；
3. 来源 Artifact 存在且哈希一致；
4. `UPDATE` 的 before hash 一致；
5. 目标路径可写且不受保护；
6. 内容不存在明显凭据模式；
7. 变更集文件数不超过 50，单文件不超过 2 MiB，总 proposed content 不超过 20 MiB；
8. 清单声明的仓库校验命令（如果已确认）在临时 overlay 中运行，命令失败即阻断；
9. 只能执行已确认命令的精确 argv，不经 shell 拼接，不接受 Agent 新增命令；“已确认”状态与 5.3 一致：
   `agent-discovery` 来源的命令必须逐条显式确认后才可执行。

仓库校验命令的 cwd 是临时 overlay 根，环境只保留 `PATH`、`SYSTEMROOT`、`TEMP`、`TMP` 和必要的用户级 Git 环境；
不注入 API Key、Runtime Token 或完整宿主环境。

## 30. Git Gateway 最终契约

`runtime/src/workflow_platform/knowledge/git_gateway.py` 提供：

```python
class KnowledgeGitGateway(Protocol):
    def inspect(self, root: Path) -> GitInspection: ...
    def diff(self, root: Path, *, staged: bool, paths: list[str] | None = None) -> str: ...
    def stage(self, root: Path, paths: list[str]) -> GitInspection: ...
    def unstage(self, root: Path, paths: list[str]) -> GitInspection: ...
    def commit(self, root: Path, *, title: str, body: str, paths: list[str] | None) -> GitCommit: ...
```

只允许以下 argv：

```text
rev-parse --show-toplevel
rev-parse --git-common-dir
rev-parse HEAD
symbolic-ref --quiet --short HEAD
status --porcelain=v1 -z
diff --no-ext-diff --binary [--cached] [--] <validated paths>
add -- <validated paths>
reset -- <validated paths>
commit --only -m <message> -- <validated paths>
```

实现使用 `subprocess.run(..., shell=False, cwd=root, check=True, timeout=30)`，捕获 stdout/stderr，
单次输出上限 2 MiB。任何非白名单命令、路径未经过 `validate_repository_relative_path()` 或 Git 冲突状态都抛出领域错误。

`commit --only` 只在用户选择了路径时使用；提交前必须再次读取 `status --porcelain=v1 -z`，并拒绝任何路径越界。
Git 操作使用同一 Runtime 锁，避免知识写入和 stage/commit 并发修改。

## 31. Python 服务方法签名

### 31.1 `KnowledgeRepositoryService`

```python
class KnowledgeRepositoryService:
    def import_repository(self, *, name: str, root_path: str, auto_apply_low_risk: bool, actor: dict, now: str) -> dict: ...
    def remove_repository(self, repository_id: str, *, actor: dict, expected_revision: str, now: str) -> dict: ...
    def discover_rules(self, repository_id: str, *, provider: str, actor: dict, expected_revision: str, now: str) -> dict: ...
    def get_rule_discovery_job(self, repository_id: str, job_id: str) -> dict: ...
    def list_rule_discovery_output(self, repository_id: str, job_id: str, *, after_sequence: int) -> list[dict]: ...
    def cancel_rule_discovery(self, repository_id: str, job_id: str, *, actor: dict, expected_revision: str, now: str) -> dict: ...
    def confirm_rule_snapshot(self, repository_id: str, snapshot_id: str, *, payload: dict, actor: dict, expected_revision: str, now: str) -> dict: ...
    def update_settings(self, repository_id: str, *, auto_apply_low_risk: bool, actor: dict, expected_revision: str, now: str) -> dict: ...
    def git_status(self, repository_id: str) -> dict: ...
    def git_diff(self, repository_id: str, *, staged: bool) -> dict: ...
```

### 31.2 `KnowledgeChangeSetService`

```python
class KnowledgeChangeSetService:
    def create(self, *, project_id: str, run_id: str, repository_id: str, artifact_ids: list[str], provider: str, mode: str, actor: dict, now: str) -> dict: ...
    def start_generation(self, project_id: str, run_id: str, change_set_id: str, *, actor: dict, expected_revision: str, now: str) -> dict: ...
    def get(self, project_id: str, run_id: str, change_set_id: str) -> dict: ...
    def list_for_run(self, project_id: str, run_id: str, *, cursor: str | None, limit: int) -> dict: ...
    def list_output(self, project_id: str, run_id: str, change_set_id: str, *, after_sequence: int) -> list[dict]: ...
    def approve(self, project_id: str, run_id: str, change_set_id: str, *, comment: str, actor: dict, expected_revision: str, now: str) -> dict: ...
    def reject(self, project_id: str, run_id: str, change_set_id: str, *, comment: str, actor: dict, expected_revision: str, now: str) -> dict: ...
    def apply(self, project_id: str, run_id: str, change_set_id: str, *, actor: dict, expected_revision: str, now: str) -> dict: ...
    def abandon(self, project_id: str, run_id: str, change_set_id: str, *, reason: str, actor: dict, expected_revision: str, now: str) -> dict: ...
    def git_diff(self, project_id: str, run_id: str, change_set_id: str, *, staged: bool) -> dict: ...
    def git_stage(self, project_id: str, run_id: str, change_set_id: str, *, paths: list[str], actor: dict, expected_revision: str, expected_repository_revision: str, now: str) -> dict: ...
    def git_unstage(self, project_id: str, run_id: str, change_set_id: str, *, paths: list[str], actor: dict, expected_revision: str, expected_repository_revision: str, now: str) -> dict: ...
    def git_commit(self, project_id: str, run_id: str, change_set_id: str, *, title: str, body: str, paths: list[str], actor: dict, expected_revision: str, expected_repository_revision: str, now: str) -> dict: ...
```

所有 mutation 先验证 Actor，再调用统一的 `require_owned_change_set(project_id, run_id, change_set_id)`，
然后验证 revision、状态和基线。创建时通过 `get_scoped_run(project_id, run_id)` 与
`ArtifactRepository.get_for_run(run_id, artifact_id)` 完成归属校验。状态转换、审计和数据库写入在一个 SQLite
短事务中完成；Agent 进程、校验命令和文件复制不占用事务。

## 32. 逐任务编码顺序

以下清单是直接执行顺序。每项先写失败测试，再写最小实现，再运行指定命令；任务完成后单独提交。

### Task 1：Contracts 与错误码

**Files:**

- Create: `packages/contracts/src/knowledge.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/contracts.test.ts`
- Modify: `packages/contracts/src/contracts.typecheck.ts`
- Modify: `packages/contracts/src/errors.ts`

- [ ] 写入状态数组、实体类型、请求响应类型、`allowedActions` 和 `isKnowledge...` 守卫。
- [ ] 增加无效 status、未知 operation、缺少/数字型 `expectedRevision`、nullable 知识 Agent node
  与空路径的失败测试，确认 revision 只能是字符串。
- [ ] 运行 `npm.cmd --workspace @workflow-platform/contracts run test`，预期全部通过。
- [ ] 运行 `npm.cmd --workspace @workflow-platform/contracts run build`，预期退出码 0。

### Task 2：数据库迁移与 Repository

**Files:**

- Modify: `runtime/src/workflow_platform/persistence/migrations.py`
- Create: `runtime/src/workflow_platform/persistence/knowledge_repositories.py`
- Create: `runtime/tests/test_knowledge_repository_persistence.py`

- [ ] 将第 25 节知识表 SQL 放入 `migrate()`；新增表不加入 `RUN_STATE_TABLES_CHILD_FIRST`。
- [ ] 按第 25 节安全重建 `agent_jobs`（备份表、行数校验、`foreign_key_check` 失败恢复均实现），
  保留现有 job、output、checkpoint、session 和 artifact consumer，回填 `project_id`/`purpose`。
- [ ] Repository 实现 `create/get/list/update_revision/create_snapshot/create_change_set/create_file_change/create_validation/create_approval/create_git_operation`
  以及 `claim/replay_idempotency`。
- [ ] 所有 JSON 字段使用 `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`，读取时验证为预期结构。
- [ ] 测试新库、旧库迁移、旧 Run schema 重建后知识表保留、重复 canonical path、外键级联、
  Agent job 迁移、唯一 sequence 和重启恢复。
- [ ] 运行 `python -m pytest runtime/tests/test_knowledge_repository_persistence.py -q`，预期通过。

### Task 3：Git Gateway

**Files:**

- Create: `runtime/src/workflow_platform/knowledge/git_gateway.py`
- Create: `runtime/tests/test_knowledge_repository_git.py`

- [ ] 实现第 30 节白名单命令，禁止 `shell=True`。
- [ ] 实现 `inspect()` 返回 root、common dir、branch、head、dirty、conflict、worktree fingerprint。
- [ ] 实现仓库相对路径校验、符号链接拒绝、状态解析和 UTF-8/GB18030 错误摘要。
- [ ] 使用临时真实 Git 仓库测试 stage、unstage、commit、detached HEAD、冲突和越界路径。
- [ ] 运行 `python -m pytest runtime/tests/test_knowledge_repository_git.py -q`，预期通过。

### Task 4：规则发现与示例包

**Files:**

- Create: `runtime/src/workflow_platform/knowledge/rule_discovery.py`
- Create: `runtime/src/workflow_platform/examples/knowledge/__init__.py`
- Create: `runtime/src/workflow_platform/examples/knowledge/complex-business/**`
- Create: `runtime/tests/test_knowledge_repository_rules.py`
- Create: `runtime/tests/test_knowledge_examples.py`

- [ ] 解析可选 `.ai-workflow/knowledge-repo.yaml`，拒绝未知字段、绝对路径、`..`、非法命令和越界 glob。
- [ ] 实现确定性扫描深度 4、文件总数 500、单文件 2 MiB 的上限；结果按相对路径排序。
- [ ] 创建 Rule Discovery 分析副本和第 28 节 JSON Schema 校验。
- [ ] 实现规则快照确认、快照文件哈希和 stale 检测。
- [ ] 生成完整示例包与纯模板包；每个目录中的每个文件必须有非空内容。
- [ ] 使用 `importlib.resources` 读取示例；验证源码运行和 PyInstaller 数据收集均能列出同一文件集合。
- [ ] 运行 `python -m pytest runtime/tests/test_knowledge_repository_rules.py runtime/tests/test_knowledge_examples.py -q`，预期通过。

### Task 5：Agent Prompt、解析与风险

**Files:**

- Create: `runtime/src/workflow_platform/knowledge/prompts.py`
- Create: `runtime/src/workflow_platform/knowledge/proposal.py`
- Create: `runtime/tests/test_knowledge_change_sets.py`

- [ ] 实现第 28 节 Prompt 固定段落，并将 manifest 作为 JSON 插值；Artifact 摘要按 `AgentContextSpec.delivery`
  语义生成（`path` 模式不内联摘要）。
- [ ] 校验 `rule-discovery.json` 和 `proposal.json`，拒绝未知字段、输出目录外文件、删除操作和来源缺失。
- [ ] 实现 SHA-256、working tree fingerprint、基线失效和第 29 节纯风险函数。
- [ ] 测试 LOW/MEDIUM/HIGH/BLOCKED 全矩阵、凭据内容、路径越界、超限和规则冲突。
- [ ] 运行 `python -m pytest runtime/tests/test_knowledge_change_sets.py -q`，预期通过。

### Task 6：变更集服务与 Runtime Agent 执行

**Files:**

- Create: `runtime/src/workflow_platform/knowledge/change_set_service.py`
- Create: `runtime/src/workflow_platform/knowledge/repository_service.py`
- Create: `runtime/src/workflow_platform/knowledge/agent_runner.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/src/workflow_platform/execution/cli.py`
- Modify: `runtime/src/workflow_platform/persistence/repositories.py`
- Modify: `runtime/src/workflow_platform/api/app.py`
- Create: `runtime/src/workflow_platform/api/knowledge_repositories.py`
- Modify: `runtime/tests/test_knowledge_change_sets.py`
- Create: `runtime/tests/test_knowledge_repository_api.py`

- [ ] 注册 Router 和服务，保证 Runtime 单例共享同一 SQLite 连接、RLock、AuditLog 和 Agent executor，
  且新路由经过现有认证、中间件、请求锁与 `RuntimeContractError` handler。
- [ ] 实现导入、移除、规则发现、确认、设置和 Git API。
- [ ] 实现 `project -> run -> change set -> artifact` 归属验证，并通过 `get_for_run()` 校验 Artifact
  `status == "verified"` 和哈希。
- [ ] 扩展现有 Agent job 的 purpose/owner；实现变更集任务排队（规则发现与生成各最多 2 个活动作业，
  超限返回 409）、现有输出事件、取消、恢复、解析、校验、风险和状态转换。
- [ ] 知识 Agent 使用分析目录且不要求 Run 写 lease、不验证工作流 node、不触发节点 Artifact 扫描；
  但变更集 API 仍验证 Project/Run 归属和项目可变更状态。
- [ ] 实现审核绑定、基线失效、原子写入、回滚和审计。
- [ ] 使用 Fake Provider 测试成功、无效 JSON、超时、取消、重复请求、字符串 revision 冲突、
  Agent job 丢失恢复和重启恢复。
- [ ] 运行 `python -m pytest runtime/tests/test_knowledge_repository_api.py runtime/tests/test_knowledge_change_sets.py -q`，预期通过。

### Task 7：Renderer API 与知识库工作台

**Files:**

- Create: `apps/renderer/src/features/knowledge/knowledgeClient.ts`
- Create: `apps/renderer/src/features/knowledge/useKnowledgeChangeSetPage.ts`
- Rewrite: `apps/renderer/src/features/knowledge/KnowledgePage.tsx`
- Create: `apps/renderer/src/features/knowledge/RepositoryList.tsx`
- Create: `apps/renderer/src/features/knowledge/RepositoryDetail.tsx`
- Create: `apps/renderer/src/features/knowledge/RuleDiscoveryReview.tsx`
- Create: `apps/renderer/src/features/knowledge/ChangeSetCreate.tsx`
- Create: `apps/renderer/src/features/knowledge/ChangeSetDetail.tsx`
- Create: `apps/renderer/src/features/knowledge/KnowledgeGitPanel.tsx`
- Create: `apps/renderer/src/features/knowledge/KnowledgeExamples.tsx`
- Create: `apps/renderer/src/features/knowledge/LegacyKnowledgePanel.tsx`
- Modify: `apps/renderer/src/app/routes.ts`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/styles.css`
- Create/Modify: matching `.test.tsx` files beside each component

- [ ] `knowledgeClient.ts` 复用 `runtimeClient.ts` 的 hardened request，所有 mutation 传 `actor`、
  字符串 `expectedRevision`、`now` 和 `Idempotency-Key`；支持 `AbortSignal`，错误只暴露 `RuntimeClientError`。
- [ ] 子路由支持 `#/knowledge/repositories`、`#/knowledge/repositories/:id`、
  `#/knowledge/change-sets/new?projectId=...&runId=...`、
  `#/knowledge/change-sets/:id?projectId=...&runId=...`、`#/knowledge/repositories/:id/git` 和
  `#/knowledge/examples`，并拒绝缺失、重复、错误编码或与当前项目不一致的作用域参数。
- [ ] 仓库列表实现本地目录选择、导入、规则 pending、ACTIVE、BLOCKED 和 REMOVED 状态。
- [ ] 规则页展示 discovered files、建议可写/保护目录、校验命令和 open questions；有问题时禁用确认。
- [ ] 变更集创建页只列出当前 Run 的 `verified` Artifact，支持全选、取消和来源预览。
- [ ] 变更集页面复用 `scopedPageModel.ts`，上下文切换递增 generation 并取消旧请求；
  404、维护状态、归档只读和后台刷新行为与现有 Run 支持模块一致。
- [ ] 变更集详情展示计划、来源、未确定项、风险、逐文件 diff、校验、审核和 Runtime `allowedActions`。
- [ ] LOW 自动写入显示明确的写入结果；MEDIUM/HIGH 只显示审核动作；BLOCKED 只显示修复入口。
- [ ] Git 页提供 status、working/staged diff、逐文件 stage/unstage 和 commit；没有 push 按钮。
- [ ] 旧候选知识 UI 收入“历史知识”折叠区，不干扰新主流程，且不再显示旧 Git 发布按钮。
- [ ] 运行 `npm.cmd --workspace @workflow-platform/renderer run test` 与 `npm.cmd --workspace @workflow-platform/renderer run build`，预期通过。

### Task 8：打包与桌面 E2E

**Files:**

- Verify first: `runtime/workflow-runtime.spec`
- Verify first: `scripts/package-runtime.ps1`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/main/gitWorkspace.ts`
- Modify: `apps/desktop/src/preload/preload.cts`
- Modify: `apps/desktop/src/preload/global.d.ts`
- Modify: `apps/renderer/src/app/desktopGit.ts`
- Create: `tests/e2e/knowledge-repository.spec.ts`
- Modify: `tests/e2e/desktop-packaged.spec.ts`（验证打包资源并移除旧 publish IPC 断言）
- Modify: `apps/desktop/test/main.test.ts`（验证目录选择仍可用）

- [ ] 验证开发运行时与 PyInstaller 运行时都能读取示例包；当前 `collect_data_files`/`--collect-data`
  足够时不修改打包文件，失败时只修正现有收集规则。
- [ ] 新链路 E2E 通过且旧页面不再调用后，删除旧知识 Git IPC、preload 方法、Renderer 调用和推送按钮，
  保留项目 worktree Git 能力以及旧知识只读 API。
- [ ] E2E 创建本地临时 Git 仓库，导入、发现、确认、选择 Artifact、生成 Fake 提案、预览、审核、写入、stage、commit。
- [ ] E2E 外部修改目标文件后变更集进入 STALE，旧 apply 按钮消失。
- [ ] E2E 验证无 push、无自动 commit、重启后状态可恢复。
- [ ] 运行 `npm.cmd run test:e2e -- tests/e2e/knowledge-repository.spec.ts`，预期通过。
- [ ] 运行 `npm.cmd run test:runtime` 和 `npm.cmd run verify`，预期通过。

## 33. 实现细节伪代码

### 33.1 生成任务

```python
def next_revision(value: str) -> str:
    return str(int(value) + 1)


def generate_change_set(project_id, run_id, change_set_id, actor, expected_revision, now):
    with transaction():
        change_set = repo.require_owned_change_set(project_id, run_id, change_set_id)
        require_human_or_agent_actor(actor)
        require_revision(change_set.revision, expected_revision)
        require_status(change_set.status, {"DRAFT"})
        check_change_set_baseline_or_stale(change_set, now)
        snapshot = repo.require_confirmed_snapshot(change_set.rule_snapshot_id)
        inputs = build_analysis_copy(change_set, snapshot)
        repository = repo.require_repository(change_set.repository_id)
        command = knowledge_agent_runner.build_command(
            provider=change_set.provider,
            analysis_root=inputs.root,
            prompt=build_proposal_prompt(inputs),
        )
        job = jobs.create(
            id=f"agent-job-{uuid4()}",
            project_id=project_id,
            run_id=run_id,
            node_id=None,
            purpose="knowledge-change-set-generation",
            owner_id=change_set_id,
            provider=change_set.provider,
            status="QUEUED",
            command=knowledge_agent_runner.redact_command(command),
            cwd=str(inputs.root),
            metadata={
                "repositoryId": change_set.repository_id,
                "snapshotId": change_set.rule_snapshot_id,
                "analysisRoot": str(inputs.root),
                "promptHash": sha256_text(build_proposal_prompt(inputs)),
            },
            created_at=now,
        )
        repo.transition(change_set_id, "GENERATING", revision=next_revision(change_set.revision))
    knowledge_agent_runner.submit(job, prompt=build_proposal_prompt(inputs), analysis_root=inputs.root)
    return job_summary(job)
```

Agent 完成回调不能直接写文件：

```python
def finish_generation(job_id, output_path, now):
    proposal = parse_proposal(output_path)
    with transaction():
        job = jobs.require(job_id, purpose="knowledge-change-set-generation")
        change_set = repo.require_owned_change_set(job.project_id, job.run_id, job.owner_id)
        repository = repo.require_repository(change_set.repository_id)
        check_change_set_baseline_or_stale(change_set, now)
        files = validate_and_materialize_changes(proposal, change_set, now)
        validations = run_builtin_and_declared_validations(change_set, files)
        risk, reasons = classify(
            change_set.with_files(files, validations),
            repo.require_confirmed_snapshot(change_set.rule_snapshot_id),
            repository,
        )
        status = next_status_after_validation(risk, change_set.mode)
        repo.store_proposal_and_transition(change_set.id, files, validations, risk, reasons, status, now)
        auto_apply = (
            risk == "LOW"
            and change_set.mode == "risk-based"
            and repository.auto_apply_low_risk
        )
        if auto_apply:
            apply_revision = repo.require_change_set(change_set.id).revision
        else:
            apply_revision = None
    if apply_revision is not None:
        apply_change_set(
            job.project_id,
            job.run_id,
            change_set.id,
            actor=SYSTEM_ACTOR,
            expected_revision=apply_revision,
            now=now,
        )
```

### 33.2 原子应用

```python
def apply_change_set(project_id, run_id, change_set_id, actor, expected_revision, now):
    preview = repo.require_owned_change_set(project_id, run_id, change_set_id)
    with repository_locks.for_identity(preview.repository_identity):
        with transaction():
            cs = repo.require_owned_change_set(project_id, run_id, change_set_id)
            require_revision(cs.revision, expected_revision)
            require_status(cs.status, {"READY_TO_APPLY", "APPROVED"})
            check_change_set_baseline_or_stale(cs, now)
            authorize_apply(cs, actor)
            applying_revision = next_revision(cs.revision)
            repo.transition(cs.id, "APPLYING", revision=applying_revision)
        overlay = create_overlay(cs.repository_root)
        try:
            materialize_files(overlay, cs.file_changes)
            run_validations_against_overlay(cs, overlay)
            replace_files_atomically(cs.repository_root, overlay, cs.file_changes)
            verify_written_hashes(cs)
            with transaction():
                repo.transition(cs.id, "APPLIED", applied_at=now, revision=next_revision(applying_revision))
                audit("knowledge.change_set.applied", cs, actor, now)
        except Exception:
            rollback_replaced_files(overlay)
            with transaction():
                repo.transition(cs.id, "FAILED", error=redacted_error(), revision=next_revision(applying_revision))
            raise
```

数据库事务不包住长时间 Agent 进程或仓库校验命令；事务只保护状态快照和短事务写入。文件应用使用 Runtime
按 `repositoryIdentity` 建立的知识锁，防止两个变更集同时写同一仓库。该锁不是 Run workspace lease；
不同仓库可以并行生成和应用，但同一仓库同一时刻只允许一个 apply/stage/unstage/commit。

## 34. 测试数据与 Fake Agent 输出

`fake` Provider 必须支持三种固定场景，通过请求参数或测试 fixture 选择，不由自然语言猜测：

1. `valid-low-create`：新增 `candidate/generated.md`，引用一个 Artifact，风险 LOW；
2. `valid-high-index`：更新 `INDEX.md`，风险由 Runtime 判为 HIGH；
3. `invalid-outside-path`：输出 `../outside.md`，Runtime 判为 BLOCKED。

Fake 输出必须真实写入分析副本的 `output/proposal.json`，再走生产解析路径；禁止测试直接调用 service 内部的“已解析对象”快捷入口。

## 35. 完成定义

编码任务只有同时满足以下条件才算完成：

- [ ] 第 24 节列出的新文件全部存在，旧兼容文件未被无意删除；
- [ ] 第 25 节迁移可在新数据库和当前已有数据库运行；
- [ ] 第 27 节 API 路径、字段、错误码和 `allowedActions` 与 Contracts 一致；
- [ ] Agent 不能访问目标仓库，不能执行 Git，不能直接写业务文件；
- [ ] LOW/MEDIUM/HIGH/BLOCKED 风险矩阵和状态机有自动化测试；
- [ ] 所有审核和 apply 都执行基线复核；
- [ ] 写入、stage、commit 三步可分别审计；
- [ ] 应用内没有新链路 push 和自动 commit；
- [ ] 完整示例包与纯模板包内容非空且可以被普通规则发现；
- [ ] Runtime、Contracts、Renderer、Desktop 和 E2E 测试通过；
- [ ] `git diff --check` 通过；
- [ ] 旧知识 API 的兼容测试通过。

## 36. 开发检查命令

在仓库根目录按以下顺序执行：

```powershell
npm.cmd --workspace @workflow-platform/contracts run test
npm.cmd --workspace @workflow-platform/contracts run build
python -m pytest runtime/tests/test_knowledge_repository_persistence.py runtime/tests/test_knowledge_repository_rules.py runtime/tests/test_knowledge_change_sets.py runtime/tests/test_knowledge_repository_git.py runtime/tests/test_knowledge_repository_api.py runtime/tests/test_knowledge_examples.py runtime/tests/test_knowledge_agent_jobs.py -q
npm.cmd --workspace @workflow-platform/renderer run test
npm.cmd --workspace @workflow-platform/renderer run build
npm.cmd --workspace @workflow-platform/desktop run test
npm.cmd run test:e2e -- tests/e2e/knowledge-repository.spec.ts
npm.cmd run test:runtime
npm.cmd run verify
npm.cmd run package:win:full
npm.cmd run test:e2e:packaged -- tests/e2e/desktop-packaged.spec.ts
git diff --check
```

Windows 环境下若 `python` 不在 PATH，使用项目已配置的 Python 3.11 解释器；不得为了本功能引入新的全局工具。

## 37. 代码提交顺序

每个 Task 通过后使用以下提交顺序，保持可回滚：

```text
feat: add knowledge repository contracts
feat: persist knowledge repository bindings and change sets
feat: add knowledge repository git gateway
feat: discover knowledge repository rules
feat: generate and govern knowledge change sets
feat: expose knowledge repository runtime api
feat: add knowledge repository workbench
test: cover packaged knowledge repository flow
```

提交不得包含现有无关的工作树修改、测试临时目录或打包产物。
