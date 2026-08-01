# 产物驱动工作流完整改造方案

## 1. 文档目标

本文定义 AI Workflow Platform 的产物驱动工作流改造方案。改造完成后，工作流可以为每个节点声明是否产生 Artifact、Artifact 类型、固定路径、模板和是否必需；Runtime 自动把上游已通过节点的 Artifact 作为上下文传给下游 Agent，并依据 Artifact、审批和 Gate 的真实结果推进节点。

本文同时作为产品设计、技术设计、实施顺序和验收标准。实现过程中不得把核心判断放在 Renderer，也不得依赖用户手工复制上游文件、手工填写标准 Artifact 路径或手工拼接 Agent Prompt。

## 2. 当前问题

当前系统已经具备 Workflow、Run、Agent、Artifact、Approval、Gate 和审计基础能力，但尚未形成完整闭环：

1. 工作流没有正式声明节点输出 Artifact 的结构化字段。
2. Run 页面需要用户手工填写 Artifact 路径和类型。
3. Agent 启动时只收到用户输入的 Prompt，不会自动获得上游可信 Artifact。
4. Agent 退出、Artifact 提交、节点完成、审批和 Gate 之间缺少统一完成判定。
5. 当前投影会在提交任意 Artifact 后直接进入审批，未校验节点声明的全部必需 Artifact。
6. 当前节点通过后只处理第一条出边，不能正确解锁多个后继节点。
7. Artifact 文件在审批或 Gate 后发生变化时，原决策不会自动失效。

## 3. 设计目标

改造必须实现以下能力：

1. 每个节点可以配置零个、一个或多个输出 Artifact。
2. 每个 Artifact 可以配置名称、类型、路径、模板、说明和必需性。
3. 无输出 Artifact 的节点是合法节点，不需要额外占位文件。
4. Runtime 自动解析 Artifact 路径、检查文件、计算哈希并登记版本。
5. Agent 自动获得上游已通过 Artifact 的引用、哈希和受限摘要。
6. Agent 自动获得本节点交付物路径和模板要求。
7. 节点完成必须统一校验执行结果、必需 Artifact、审批和 Gate。
8. 默认采用半自动推进，只有明确配置的低风险节点才自动推进。
9. 所有判断可审计、可恢复、可重复执行，并保持幂等。

## 4. 非目标

首版不实现以下内容：

1. 不自动把 Agent 创建的所有文件都当成正式 Artifact。
2. 不使用新的 AI 调用生成 Artifact 摘要，首版采用确定性文本截断和结构化元数据。
3. 不允许自动推进绕过人工审批、Gate 或高风险部署。
4. 不把原始终端日志当作节点正式交付物；日志仍可单独导出 Evidence。
5. 不允许 Artifact 或模板路径访问项目目录之外的文件。

## 5. 核心流程

```text
工作流定义节点交付物
        |
        v
Runtime 启动节点并解析产物路径
        |
        v
收集上游 PASSED 节点的 Artifact
        |
        v
组装 effectivePrompt 并启动 Agent
        |
        v
Agent 按模板和固定路径生成文件
        |
        v
Runtime 自动扫描、校验、计算哈希并登记
        |
        v
必需产物是否齐全？ -- 否 --> AWAITING_ARTIFACT
        |
       是
        v
是否需要审批？ ------ 是 --> AWAITING_APPROVAL
        |
       否/已批准
        v
是否需要 Gate？ ----- 是 --> AWAITING_GATE
        |
       否/已通过
        v
节点 PASSED，解锁满足依赖的后继节点
```

## 6. 工作流契约

### 6.1 新增类型

在 TypeScript contracts 与 Python models 中增加等价的一等字段，不将关键规则隐藏在自由格式 `metadata` 中。

```ts
export type ArtifactOutputSpec = {
  id: string;
  name: string;
  type: string;
  required: boolean;
  path: string;
  templatePath?: string;
  description?: string;
};

export type NodeArtifactSpec = {
  outputs: ArtifactOutputSpec[];
};

export type AgentContextSpec = {
  upstream: "none" | "direct" | "ancestors";
  artifactTypes?: string[];
  maxArtifacts: number;
  summaryCharsPerArtifact: number;
  maxTotalChars: number;
};

export type NodeAgentSpec = {
  promptTemplate?: string;
  context: AgentContextSpec;
};

export type NodeAdvanceSpec = {
  mode: "manual" | "auto";
};
```

`WorkflowNode` 增加：

```ts
artifacts?: NodeArtifactSpec;
agent?: NodeAgentSpec;
advance?: NodeAdvanceSpec;
```

字段缺失时使用兼容默认值：

```text
artifacts.outputs = []
agent.context.upstream = none
advance.mode = manual
```

### 6.2 完整节点示例

```json
{
  "id": "implementation",
  "name": "开发实现",
  "kind": "agent",
  "description": "依据已批准方案完成代码和测试",
  "requires": [
    { "type": "approval", "approvalRole": "tech-lead", "required": true }
  ],
  "gates": ["implementation-ready"],
  "artifacts": {
    "outputs": [
      {
        "id": "implementation-report",
        "name": "实施报告",
        "type": "implementation-report",
        "required": true,
        "path": "docs/runs/{{runId}}/{{nodeId}}/implementation.md",
        "templatePath": "templates/artifacts/implementation.md",
        "description": "记录代码变更、设计偏差、验证结果和遗留风险"
      },
      {
        "id": "change-notes",
        "name": "变更说明",
        "type": "change-notes",
        "required": false,
        "path": "docs/runs/{{runId}}/{{nodeId}}/changes.md"
      }
    ]
  },
  "agent": {
    "promptTemplate": "根据上游需求和已批准方案完成实现与测试。",
    "context": {
      "upstream": "ancestors",
      "artifactTypes": ["requirement", "plan"],
      "maxArtifacts": 8,
      "summaryCharsPerArtifact": 4000,
      "maxTotalChars": 16000
    }
  },
  "advance": {
    "mode": "manual"
  }
}
```

### 6.3 无产物节点

审批、协调或人工确认节点可以不配置 `artifacts`，也可以明确配置空数组：

```json
{
  "id": "release-approval",
  "name": "发布审批",
  "kind": "approval",
  "artifacts": { "outputs": [] },
  "advance": { "mode": "manual" }
}
```

## 7. 路径和模板规则

支持以下路径变量：

```text
{{runId}}
{{nodeId}}
{{workflowId}}
{{artifactId}}
{{date}}
```

Runtime 必须在节点启动前完成变量解析。解析后的路径必须满足：

1. 是项目目录内的相对路径。
2. 不能包含未识别变量、空路径或 NUL 字符。
3. 解析后不能通过 `..`、绝对路径或符号链接逃逸项目根目录。
4. 同一节点的 Artifact 目标路径不能冲突。
5. 配置了 `templatePath` 时，模板必须存在、可读并位于项目目录内。
6. 未配置模板的 Artifact 仍合法，适用于二进制包、截图和工具生成报告。

模板不会由 Runtime 自动复制为最终产物。Runtime 会把模板路径和目标路径注入 Agent Prompt，由 Agent 按模板生成内容。后续可增加“初始化空白产物”能力，但不属于首版。

## 8. 工作流编译校验

`compile_workflow()` 和 Renderer 保存前校验必须增加：

1. Artifact spec ID 在节点内唯一。
2. 名称、类型和路径不能为空。
3. `required` 必须是布尔值。
4. 路径变量必须来自允许列表。
5. `maxArtifacts`、单文件摘要长度和总摘要长度必须为合理正整数。
6. `agent` 配置只能用于支持 Agent 的节点。
7. `advance.mode=auto` 不能用于 approval、gate 和高风险 deploy 节点。
8. 工作流图必须无环。
9. 所有边必须引用已存在节点。
10. 多入边节点必须等全部必需前置节点 PASSED 后才能 READY。

编译错误必须阻止保存工作流版本或创建 Run，不能仅显示警告后继续运行。

## 9. Runtime 状态机

### 9.1 节点状态

保留现有状态并正式启用 `AWAITING_ARTIFACT`：

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

### 9.2 完成判定器

新增独立 `NodeCompletionEvaluator`，输入为工作流定义、节点、执行结果、Artifact、审批和 Gate，输出下一状态及缺失条件。

判定顺序固定为：

1. 执行失败：`FAILED` 或 `BLOCKED`。
2. 执行尚未结束：保持 `RUNNING`。
3. 必需 Artifact 缺失：`AWAITING_ARTIFACT`。
4. 需要审批且未批准：`AWAITING_APPROVAL`。
5. 需要 Gate 且未通过：`AWAITING_GATE`。
6. 所有条件满足：`PASSED`。

Agent 进程正常退出只是“执行结束”，不直接代表节点通过。

### 9.3 Artifact 提交事件

修正当前 `ARTIFACT_SUBMITTED` 后固定进入审批的逻辑：

1. `RUNNING` 和 `AWAITING_ARTIFACT` 节点都允许登记 Artifact。
2. 每次登记后重新运行完成判定器。
3. 可选 Artifact 缺失不阻塞。
4. 必需 Artifact 齐全后才进入审批、Gate 或 PASSED。

### 9.4 后继节点解锁

节点 PASSED 后重新计算所有出边目标：

1. 目标节点所有必需前置节点均 PASSED 时设为 READY。
2. 任一必需前置节点未通过时保持 PENDING。
3. 支持一个节点解锁多个后继节点。
4. 支持多个前置节点汇聚到一个节点。
5. 首版不执行自由文本 edge condition；存在 condition 时编译器必须拒绝不支持的表达式。

## 10. Artifact 自动扫描和登记

新增 `NodeArtifactService`，负责：

1. 获取当前 Run 使用的不可变工作流版本。
2. 解析节点 Artifact spec 和目标路径。
3. 检查目标文件存在、可读且未越界。
4. 计算 SHA-256、文件大小、媒体类型和修改时间。
5. 按 `runId + nodeId + artifactSpecId + contentHash` 幂等登记。
6. 相同内容重复扫描不创建重复版本。
7. 内容变化时创建新 Artifact 版本并保留旧版本。
8. 记录来源 Agent Job、工作流版本、模板路径和扫描时间。
9. 返回 `missing`、`registered`、`unchanged`、`changed`、`invalid` 状态。

自动扫描触发点：

1. 自动 Agent 正常或失败退出后。
2. 交互式 Agent PTY 进程退出后。
3. 用户点击“重新检查产物”。
4. Runtime 恢复 Run 时执行只读一致性检查。

Agent 失败后发现的文件标记为 `provisional`，必须由可信人工确认后才能成为正式 Artifact，避免把半成品直接传给下游节点。

## 11. 上游上下文组装

新增 `AgentContextBuilder`，只在 Runtime 中生成可信上下文。

### 11.1 Artifact 选择

1. `none`：不传上游 Artifact。
2. `direct`：只传直接前置节点的 Artifact。
3. `ancestors`：按拓扑顺序传所有祖先节点的 Artifact。
4. 只选择来源节点状态为 PASSED 的正式 Artifact。
5. 配置 `artifactTypes` 时仅选择匹配类型。
6. 相同 Artifact spec 默认只选择最新正式版本。

### 11.2 摘要规则

首版采用确定性摘要：

1. UTF-8 文本文件读取规范化文本并按字符上限截断。
2. Markdown 保留标题和正文开头。
3. JSON 使用格式化后的受限文本。
4. 二进制文件不读取正文，只提供元数据。
5. 单文件和总 Prompt 均执行长度上限。
6. 超限时保留路径、类型、哈希，并明确标记摘要已截断。

### 11.3 effectivePrompt

Runtime 生成的 Prompt 顺序固定为：

```text
当前 Run 目标
当前节点名称、说明和完成条件
上游可信 Artifact 列表、路径、哈希和摘要
本节点必须生成的 Artifact
每个 Artifact 的目标路径、模板路径和说明
安全约束与项目根目录
工作流节点 promptTemplate
用户本次补充 Prompt
```

`startAgentJob` 必须返回 `effectivePrompt`。Renderer 启动桌面 Codex/Claude PTY 时必须使用该字段，不能继续把原始用户 Prompt 直接交给 CLI。

## 12. Agent 生命周期集成

### 12.1 自动 Agent

1. Runtime 创建 Job 前组装上下文。
2. CLI 使用 `effectivePrompt` 启动。
3. 进程退出后保存执行结果。
4. 自动扫描节点声明的 Artifact。
5. 调用节点完成判定器。
6. 更新 Job、节点投影和审计记录。

### 12.2 交互式 Agent

1. Runtime 先创建 Job 并返回 `effectivePrompt`。
2. Electron 使用 `effectivePrompt` 创建 PTY。
3. PTY 输入输出保持实时直连，日志异步镜像到 Runtime。
4. PTY 退出时 Electron 调用会话结束 API，并携带退出码。
5. Runtime 扫描产物并重新计算节点状态。
6. Agent 尚未退出时允许用户手动触发重新扫描，但不能伪造执行完成。

## 13. API 改造

新增 API：

```text
GET  /runs/{runId}/nodes/{nodeId}/context
GET  /runs/{runId}/nodes/{nodeId}/artifact-requirements
POST /runs/{runId}/nodes/{nodeId}/artifacts/scan
POST /runs/{runId}/nodes/{nodeId}/complete
POST /runs/{runId}/nodes/{nodeId}/artifacts/{artifactSpecId}/confirm
GET  /runs/{runId}/artifacts/{artifactId}/consumers
```

调整 Agent 启动响应：

```json
{
  "job": {},
  "effectivePrompt": "...",
  "contextArtifacts": [],
  "expectedArtifacts": []
}
```

所有改变 Run 状态的请求必须继续携带 `expectedRevision`。扫描接口本身幂等，但扫描后触发状态推进时必须检查 revision，冲突时返回 409 并要求客户端刷新。

## 14. 持久化改造

Artifact 表或关联表需要增加：

```text
artifact_spec_id
workflow_version_id
source_agent_job_id
template_path
relative_path
content_hash
file_size
media_type
status                 verified | provisional | invalidated
supersedes_artifact_id
verified_at
```

增加 Artifact consumer 关系：

```text
artifact_id
consumer_run_id
consumer_node_id
agent_job_id
context_created_at
```

增加唯一索引，确保同一节点、同一 spec、同一内容哈希不会重复登记。迁移不得修改或删除现有 Artifact 数据；旧数据标记为手工附加产物，继续可预览和导出。

## 15. 审批和 Gate 一致性

审批和 Gate 必须绑定 Artifact 内容哈希集合，而不是只绑定节点 ID。

如果已审批或已通过 Gate 的必需 Artifact 内容发生变化：

1. 新建 Artifact 版本。
2. 将旧审批/Gate 结果标记为失效。
3. 节点重新进入 AWAITING_APPROVAL 或 AWAITING_GATE。
4. 审计记录变化前后哈希和失效原因。

这样可以防止“审批后修改文件但仍沿用旧批准”的问题。

## 16. Renderer 改造

### 16.1 工作流模块

为节点增加结构化配置区：

1. 是否声明产物。
2. 添加、删除和排序 Artifact spec。
3. 编辑名称、类型、必需性、路径、模板和说明。
4. 配置上游上下文范围、类型过滤和长度上限。
5. 配置手动或自动推进。
6. 保存前展示字段级编译错误。

JSON 编辑仍保留，但结构化编辑与 JSON 草稿必须使用同一契约。

### 16.2 Run 模块

当前节点区域显示：

```text
上游输入
- 需求说明 / requirement / 已验证
- 技术方案 / plan / 已批准

本节点交付物
- 实施报告 / 必需 / 已登记
- 变更说明 / 可选 / 未生成
```

提供操作：

1. 预览 Agent 上下文。
2. 启动 Agent。
3. 重新检查产物。
4. 确认失败 Agent 留下的 provisional Artifact。
5. 完成节点。
6. 条件满足时启动下一节点。

删除标准流程中的手工 Artifact 路径输入框。保留“添加附加 Artifact”入口，用于工作流未声明但需要留档的额外文件。

### 16.3 Artifact 模块

增加展示：

1. Artifact spec ID 和来源工作流版本。
2. 来源节点和来源 Agent Job。
3. 模板、相对路径、内容哈希和版本关系。
4. 正式、临时或已失效状态。
5. 被哪些下游节点和 Agent 使用。
6. 历史版本对比。

## 17. 安全要求

1. 路径校验必须在 Runtime 完成，不能只依赖前端。
2. 使用 resolve 后的真实路径检查符号链接逃逸。
3. Prompt 只暴露项目内相对路径，不泄露无关系统路径。
4. 文本摘要继续执行终端输出同等级别的脱敏策略。
5. 文件过大时不读取正文，只记录元数据。
6. 模板和 Artifact 扫描设置单文件大小、总读取量和超时限制。
7. Agent 不能通过输出文本声明“文件已生成”；必须以文件系统和哈希为准。
8. 自动推进必须由 Runtime 白名单规则决定。

## 18. 兼容策略

1. 老工作流没有 `artifacts` 时视为无声明产物。
2. 老工作流没有 `agent.context` 时不自动注入 Artifact。
3. 现有手工提交 Artifact API 暂时保留。
4. 手工提交的文件只有类型和规范化路径均匹配时，才可满足声明产物要求。
5. 旧 Artifact 保持可查看、比较、导出和用于 Evidence。
6. 新创建的工作流版本默认使用新契约；不原地修改已运行 Run 绑定的工作流版本。

## 19. 实施阶段

### 阶段一：契约、编译器与状态机

修改范围：

- `packages/contracts/src/workflow.ts`
- `runtime/src/workflow_platform/models.py`
- `runtime/src/workflow_platform/compiler/compiler.py`
- `runtime/src/workflow_platform/kernel/projection.py`
- `runtime/src/workflow_platform/kernel/transition.py`

交付：新契约、配置校验、AWAITING_ARTIFACT、统一完成判定、多出边和多入边解锁。

### 阶段二：Artifact 扫描、版本与上下文

修改范围：

- `runtime/src/workflow_platform/artifacts/service.py`
- `runtime/src/workflow_platform/runtime_service.py`
- `runtime/src/workflow_platform/persistence/migrations.py`
- `runtime/src/workflow_platform/persistence/repositories.py`

交付：路径渲染、安全扫描、自动登记、版本关系、consumer 关系和 AgentContextBuilder。

### 阶段三：Agent 和 API 集成

修改范围：

- `runtime/src/workflow_platform/api/app.py`
- `runtime/src/workflow_platform/runtime_service.py`
- `apps/renderer/src/app/runtimeClient.ts`
- `apps/renderer/src/app/App.tsx`
- Electron PTY 会话结束桥接代码

交付：effectivePrompt、自动/交互 Agent 结束扫描、节点完成 API 和恢复逻辑。

### 阶段四：工作流、Run 和 Artifact 界面

修改范围：

- `apps/renderer/src/features/workflow/WorkflowViewer.tsx`
- `apps/renderer/src/features/runs/RunDashboard.tsx`
- `apps/renderer/src/features/artifacts/ArtifactsPage.tsx`
- 对应样式和测试文件

交付：结构化产物配置、上下文预览、交付物状态、自动扫描操作、消费者和版本展示。

### 阶段五：迁移、文档和端到端验收

交付：数据库迁移、示例工作流、模板示例、README 使用说明、全量自动化测试和 Electron 手工验收。

## 20. 测试策略

### 20.1 Contracts 与编译器

覆盖：零产物、多产物、可选产物、重复 ID、路径冲突、未知变量、模板越界、非法自动推进、环形工作流和多入边。

### 20.2 Runtime 单元测试

覆盖：

1. 必需产物缺失进入 AWAITING_ARTIFACT。
2. 可选产物缺失不阻塞。
3. 相同文件重复扫描保持幂等。
4. 文件变化创建新版本。
5. Artifact 越界和符号链接逃逸被拒绝。
6. 上下文只包含 PASSED 节点正式 Artifact。
7. 摘要长度和总长度严格受限。
8. Artifact 变化使审批和 Gate 失效。
9. 多后继节点正确解锁。
10. 汇聚节点等待全部前置节点通过。

### 20.3 API 测试

覆盖上下文预览、要求列表、扫描、确认 provisional Artifact、完成节点、revision 冲突和消费者查询。

### 20.4 Renderer 测试

覆盖结构化配置、保存校验、Run 交付物状态、重新扫描、上下文预览、附加 Artifact 和错误提示。

### 20.5 端到端测试

建立如下完整工作流：

```text
需求分析 -> 方案设计 -> 开发实现 -> 测试验证 -> 发布审批
```

验证上游 Artifact 自动进入下游 Prompt、必需 Artifact 自动登记、审批和 Gate 阻塞、文件变化导致决策失效、最终 Run 完成和重启恢复。

## 21. 改造后的实际使用流程

### 21.1 工作流管理员配置一次

1. 在工作流模块创建节点和连线。
2. 为需要交付物的节点添加 Artifact 定义。
3. 配置固定路径、模板和必需性。
4. 为 Agent 节点配置上游上下文范围。
5. 配置审批、Gate 和推进方式。
6. 模拟并保存新的工作流版本。

### 21.2 用户创建 Run

用户只填写 Run 名称、目标和业务参数，不填写 Artifact 路径。Runtime 将第一个满足依赖的节点置为 READY。

### 21.3 用户启动节点 Agent

Runtime 自动检查模板，收集上游 Artifact，生成 effectivePrompt，并明确告诉 Agent 本节点必须生成哪些文件以及固定路径。

### 21.4 Agent 生成交付物

Agent 按模板写入工作流配置的路径。用户可继续在交互终端沟通，不需要重新创建 Agent，也不需要把上游内容复制到 Prompt。

### 21.5 Runtime 自动登记

Agent 退出后 Runtime 自动扫描。文件存在则计算哈希并登记；必需文件缺失则节点进入 AWAITING_ARTIFACT，并显示缺失名称和期望路径。

### 21.6 审批和 Gate

产物齐全后，节点按配置进入审批或 Gate。审批人员看到实际 Artifact 内容和哈希；Gate 使用正式 Artifact 作为证据。审批后文件发生变化会要求重新审批。

### 21.7 下一节点继续执行

节点 PASSED 后后继节点变为 READY。下游 Agent 自动获得上游 Artifact 的路径、哈希和摘要，无需用户手工传递。

### 21.8 无产物节点

审批、协调等无产物节点在执行条件满足后直接进入审批、Gate 或 PASSED，不会要求创建无意义文件。

## 22. 示例完整流程

```text
创建 Run：修复登录接口超时

需求分析 Agent
  -> 自动生成 docs/runs/run-123/requirements.md
  -> Runtime 登记 requirement Artifact

方案设计 Agent
  -> 自动获得 requirements.md 引用和摘要
  -> 自动生成 docs/runs/run-123/design.md
  -> 技术负责人审批

开发实现 Agent
  -> 自动获得需求和已批准方案
  -> 修改代码
  -> 自动生成 implementation.md

测试验证 Agent
  -> 自动获得需求、方案和实施报告
  -> 自动生成 reports/run-123/test-report.md
  -> 自动 Gate 校验

发布审批
  -> 无产物
  -> 查看全部 Artifact、Gate 和审计记录
  -> 批准后 Run 完成
```

## 23. 验收标准

1. 工作流可为每个节点配置零个、一个或多个 Artifact。
2. Artifact 支持必需和可选、固定路径和可选模板。
3. Run 执行标准节点时不需要手工填写 Artifact 路径和类型。
4. Agent 使用 Runtime 生成的 effectivePrompt。
5. 下游 Agent 自动获得上游正式 Artifact 的引用、哈希和摘要。
6. Runtime 自动扫描、校验、计算哈希并登记 Artifact。
7. 必需 Artifact 缺失时节点不能推进。
8. 可选 Artifact 缺失时节点可以推进。
9. 无产物节点可以正常完成。
10. 审批和 Gate 绑定 Artifact 哈希，文件变化后旧结果失效。
11. 一个节点可以解锁多个后继节点，汇聚节点等待全部前置节点。
12. Runtime 和 Electron 重启后 Run、Artifact、引用关系和阻塞状态可恢复。
13. 所有自动行为都有审计记录。
14. 全量 contracts、renderer、desktop 和 runtime 测试通过。

## 24. 完成定义

只有当契约、Runtime 状态机、Artifact 自动登记、上下文注入、Agent 生命周期、审批/Gate 一致性、Renderer 界面、迁移、测试和中文使用文档全部完成后，本改造才可视为完成。仅增加配置字段或界面输入框不构成完成。
