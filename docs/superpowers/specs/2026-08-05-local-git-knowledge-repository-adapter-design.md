# 本地 Git 知识库对接与产物回补设计规格

**状态：已确认，可进入实施计划**

**日期：2026-08-05**

**适用范围：Renderer、Desktop、Runtime、Contracts、本地 Git 工作区、内置知识库示例包**

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

内置示例包参考微信文章《复杂业务团队的 AI Coding 交付实践：知识库、RD 流程和质量门禁》中关于知识分层、索引路由、候选知识、人工审核和知识回补的方法。

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

Desktop 负责受控启动 Agent CLI 和本地 Git 子进程，但不持有业务状态。

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
  status: "ACTIVE" | "RULES_PENDING" | "BLOCKED" | "REMOVED";
  activeRuleSnapshotId: string | null;
  createdAt: string;
  updatedAt: string;
};
```

约束：

- `rootPath` 必须是已存在的本地目录；
- 目录必须位于一个有效 Git 工作树的根目录；
- 同一规范化根目录只能存在一个活动绑定；
- `repositoryIdentity` 由规范化路径和 Git 仓库标识生成，不依赖远程地址；
- 首期允许 detached HEAD，但禁止执行内置 commit；
- 仓库存在未解决冲突时允许只读预览，禁止应用变更。

### 5.2 `RepositoryRuleSnapshot`

表示用户确认过的一组知识库规则，不等同于平台模板。

```ts
type RepositoryRuleSnapshot = {
  id: string;
  repositoryId: string;
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
- 平台不得让 Agent 自行新增命令后立即执行。

### 5.4 `KnowledgeChangeSet`

一次面向目标知识库的完整变更提案。

```ts
type KnowledgeChangeSet = {
  id: string;
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
  createdAt: string;
  updatedAt: string;
};
```

`SourceArtifactSnapshot` 必须保存 `artifactId`、`runId`、`nodeId`、`type`、`uri`、`contentHash` 和登记时的状态。只有正式、未失效且属于指定 Run 的 Artifact 可以进入变更集。

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

- Artifact 属于同一 Run；
- Artifact 状态正式且未失效；
- 目标知识库活动且存在已确认规则快照；
- 仓库路径仍指向同一个 Git 工作树；
- 当前 Git 基线可读取。

创建后保存 Artifact 哈希、规则快照哈希、HEAD 和工作树指纹。

### 7.2 Agent 输入合同

Agent Prompt 按以下顺序组装：

1. 平台安全协议和只允许返回结构化提案的约束；
2. 目标知识库根目录和允许读取、允许写入、禁止写入范围；
3. 已确认规则快照；
4. 规则快照引用的原始规则、索引和模板文件；
5. 选中 Artifact 的路径、类型、哈希、摘要及必要内容；
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
- 需要同步普通索引，但未触及路由和规则。

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
  -> DISCOVERING
  -> GENERATING
  -> VALIDATING
  -> READY_TO_APPLY          (LOW 且允许自动写入)
  -> AWAITING_APPROVAL       (MEDIUM/HIGH)
  -> APPROVED
  -> APPLYING
  -> APPLIED
  -> PARTIALLY_STAGED
  -> STAGED
  -> COMMITTED
```

任一非终态可以因基线变化进入 `STALE`，因安全或规则问题进入 `BLOCKED`，因 Agent、校验或 I/O 错误进入 `FAILED`。`STALE`、`BLOCKED` 和 `FAILED` 不得写入，重新生成必须创建新 revision，保留旧记录用于审计。

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

建议提交信息：

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
| `#/knowledge/change-sets/new` | 从 Run 选择 Artifact、目标仓库和 Agent |
| `#/knowledge/change-sets/:changeSetId` | 计划、来源、风险、未确定项、diff、校验、审核和写入 |
| `#/knowledge/repositories/:repositoryId/git` | status、diff、stage、unstage 和 commit |
| `#/knowledge/examples` | 内置示例包预览和初始化 |

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
2. 选择一个或多个正式 Artifact；
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

## 13. Runtime API 草案

所有写操作携带可信 Actor、`expectedRevision` 和幂等键。以下路径为领域草案，实施时应与多 Run 重构后的项目级路径契约统一。

### 13.1 知识库

```text
POST   /knowledge-repositories/import
GET    /knowledge-repositories
GET    /knowledge-repositories/{repositoryId}
DELETE /knowledge-repositories/{repositoryId}
POST   /knowledge-repositories/{repositoryId}/discover-rules
GET    /knowledge-repositories/{repositoryId}/rule-snapshots
POST   /knowledge-repositories/{repositoryId}/rule-snapshots/{snapshotId}/confirm
GET    /knowledge-repositories/{repositoryId}/git/status
GET    /knowledge-repositories/{repositoryId}/git/diff
POST   /knowledge-repositories/{repositoryId}/git/stage
POST   /knowledge-repositories/{repositoryId}/git/unstage
POST   /knowledge-repositories/{repositoryId}/git/commit
```

### 13.2 变更集

```text
POST /runs/{runId}/knowledge-change-sets
GET  /knowledge-change-sets
GET  /knowledge-change-sets/{changeSetId}
POST /knowledge-change-sets/{changeSetId}/generate
GET  /knowledge-change-sets/{changeSetId}/output
POST /knowledge-change-sets/{changeSetId}/validate
POST /knowledge-change-sets/{changeSetId}/approve
POST /knowledge-change-sets/{changeSetId}/reject
POST /knowledge-change-sets/{changeSetId}/apply
POST /knowledge-change-sets/{changeSetId}/abandon
```

变更集详情响应必须包含 `allowedActions`。Renderer 不根据风险级别自行拼装按钮。

## 14. 持久化建议

新增表：

- `knowledge_repositories`
- `knowledge_repository_rule_snapshots`
- `knowledge_repository_rule_files`
- `knowledge_change_sets`
- `knowledge_change_set_artifacts`
- `knowledge_file_changes`
- `knowledge_change_set_validations`
- `knowledge_change_set_approvals`
- `knowledge_git_operations`

现有 `knowledge_candidates`、`knowledge_syntheses` 和输出事件表可在首期复用：

- 候选知识仍可作为单条知识输入；
- Artifact 批量抽取改为创建变更集；
- 合成执行器和实时输出复用于变更集 Agent 作业；
- 旧的固定路径 Git 发布 API 保留只读兼容，不再作为新界面的主路径；
- 数据迁移不自动把旧知识文档写入任何外部仓库。

## 15. 内置示例包

### 15.1 定位

示例包名称为“复杂业务研发知识库”。它有两个初始化模式：

1. **完整示例模式**：包含原创虚构业务案例，用于学习、演示和端到端验证；
2. **纯模板模式**：保留规则、目录、字段说明和模板，移除虚构业务内容，用作新团队起点。

示例包是普通本地 Git 知识库，不拥有平台特权。初始化后必须通过与其他仓库相同的导入、规则发现、变更集和 Git 流程。

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
      solution/
      base/
    tech/
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

| 错误码 | 行为 |
| --- | --- |
| `KNOWLEDGE_REPOSITORY_NOT_GIT` | 拒绝导入，保留用户选择路径 |
| `KNOWLEDGE_REPOSITORY_DUPLICATE` | 导航到已有绑定 |
| `KNOWLEDGE_RULES_NOT_CONFIRMED` | 允许预览，禁止写入 |
| `KNOWLEDGE_PATH_OUTSIDE_REPOSITORY` | 阻断并记录目标路径 |
| `KNOWLEDGE_PATH_PROTECTED` | 阻断 |
| `KNOWLEDGE_BASELINE_CHANGED` | 变更集进入 `STALE` |
| `KNOWLEDGE_GIT_CONFLICT` | 允许只读查看，禁止应用和提交 |
| `KNOWLEDGE_AGENT_OUTPUT_INVALID` | 保存 Agent 输出用于诊断，禁止应用 |
| `KNOWLEDGE_VALIDATION_FAILED` | 进入 `BLOCKED` 或等待重新生成 |
| `KNOWLEDGE_APPROVAL_INVALIDATED` | 清除可写授权并要求重新审核 |
| `KNOWLEDGE_APPLY_ROLLBACK_FAILED` | 标记失败并禁止后续 Git 操作 |
| `KNOWLEDGE_GIT_IDENTITY_MISSING` | 保留暂存状态，引导用户配置 Git |

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
- 风险分类矩阵；
- 审核绑定和失效；
- 写入前基线复核；
- 多文件原子写入与回滚；
- Git stage、unstage 和 commit 授权。

### 18.3 Runtime API 测试

- 导入、发现、确认、生成、审核、应用和提交完整链路；
- 非可信 Actor 被拒绝；
- revision 冲突和幂等请求；
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
4. 用户可从一个 Run 勾选多个正式 Artifact 创建变更集。
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

## 20. 实施分期建议

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
