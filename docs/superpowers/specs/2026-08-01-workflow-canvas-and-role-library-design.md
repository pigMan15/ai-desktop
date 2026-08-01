# 工作流画布与角色库设计

## 目标

将当前工作流的表单式节点和连线编辑升级为 React Flow 画布编辑，并提供平台自主管理的角色库。每个 Agent 节点可以绑定一个角色；运行时把角色定义、节点要求、交付物和上游上下文组合成不可变的有效提示词。

被导入项目不需要也不会要求存在 `.harness` 目录。`harness-desktop/.harness/agents/*.md` 只作为角色定义内容结构的参考。

## 范围

- 使用 `@xyflow/react` 渲染工作流画布，支持拖拽、连线、缩放、平移、删除和自动布局。
- 保留 JSON 编辑入口作为高级编辑与故障恢复方式。
- 在工作流版本中保存角色定义、节点角色绑定和画布布局。
- 提供角色库的创建、编辑、禁用、删除与内置模板复制。
- 对 Agent 节点的角色引用执行编译校验，并在创建 Run 时固定角色快照。

本次不实现从外部项目目录自动读取或持续同步 Agent 文件，不在画布中实现条件表达式编辑，也不改变既有 Gate、Artifact 与 Agent Provider 的权限模型。

## 数据模型

将现有精简的 `roles` 扩展为完整角色定义：

```ts
type WorkflowRole = {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  provider?: "codex" | "claude";
  allowedTools?: string[];
  disabled?: boolean;
  metadata?: Record<string, unknown>;
};

type WorkflowNode = {
  // existing fields
  role?: string; // Existing business or approval role; unchanged.
  agent?: NodeAgentSpec & { roleId?: string };
};

type WorkflowMetadata = {
  canvas?: {
    nodes: Record<string, { x: number; y: number }>;
  };
};
```

`node.role` 保留现有工作流对业务职责、审批角色的表达，不复用于执行 Agent。`node.agent.roleId` 是 Agent 角色 ID，不复制角色正文。角色正文随 `WorkflowDefinition` 一起版本化。`metadata.canvas` 仅保存编辑器位置；Runtime 编译、执行、导出通用 YAML 时不依赖坐标。

每个 Run 在创建时保存该工作流版本的完整定义，Agent Job 另持久化最终 `effectivePrompt`。后续修改角色或画布均不会影响已运行或已完成的 Run。

## 角色与节点

角色是可复用的执行说明，内容包含职责、边界、需要读取的上下文、输出要求。节点是一次具体工作环节，保留自身的 `promptTemplate`、Artifact 声明和上下游配置。

仅 `kind: "agent"` 的节点可通过 `node.agent.roleId` 绑定执行角色。一个节点至多绑定一个执行角色；相同角色可被多个节点复用。节点可以无执行角色运行，用其现有节点提示词保持向后兼容。禁用角色不能被新节点绑定，但保留旧版本与已有 Run 的可追溯性。

内置模板至少包括：需求分析、技术架构、计划、开发、测试、验证、部署和编排。模板属于平台资源，创建工作流时复制为该工作流版本内的角色定义，用户可以自由编辑副本。

## 提示词组装

Runtime 以固定顺序组装有效提示词：

1. 角色定义：名称、职责、边界和 `instructions`。
2. 节点执行要求：`node.agent.promptTemplate`。
3. 本节点 Artifact 目标与模板说明。
4. 已通过上游节点的 Artifact 上下文。
5. 用户提交的本次任务。

角色可声明默认 Provider 和工具白名单。节点启动界面以角色默认值预填，用户显式选择可覆盖 Provider；工具权限仍受既有 Runtime 安全控制。最终使用的 Provider、工具与有效提示词必须记入 Agent Job 和审计记录。

## 编译与错误处理

保存与模拟前的工作流编译增加以下诊断：

- 角色 ID 重复、空 ID、空名称或空 instructions。
- Agent 节点的 `agent.roleId` 引用不存在或已禁用的角色。
- 非 Agent 节点设置 `agent.roleId`。
- 角色声明未知 Provider 或非法工具标识。
- 画布布局包含未知节点或非有限坐标时忽略布局并返回警告，不阻止工作流运行。

无角色的 Agent 节点不是错误，以兼容现有工作流。无法解析角色引用时必须阻止保存新版本和创建 Run。

## 界面设计

工作流页面采用三栏工作区：

- 左侧：节点类型工具箱与角色库入口。
- 中间：React Flow 画布，节点显示名称、类型、已绑定角色、Run 状态和校验错误；连接手柄只用于定义前后依赖。
- 右侧：选中节点的属性面板，包含节点类型、执行角色选择、Agent、Artifact、推进方式与删除操作。

角色库用独立视图或抽屉展示角色列表和 Markdown 文本编辑器。创建角色时可选择内置模板或空白角色。节点删除会同时删除相连边；角色删除在仍被当前工作流引用时应被拒绝，并提示先解绑或替换引用。

画布编辑即时更新本地草稿和 sessionStorage。保存新版本、重置草稿、历史版本比较、导出与模拟沿用当前页面已有行为。JSON 编辑的修改应重建画布节点；无坐标的节点使用确定性自动布局。

## 测试

- Contracts：角色序列化、节点角色字段和向后兼容的无角色工作流。
- Runtime：角色引用校验、有效提示词的组装顺序、Run 快照不受角色后续更新影响。
- Renderer：画布节点/边到草稿的双向同步、创建连线、选择节点、绑定角色、角色删除保护、JSON 回退。
- E2E：创建角色，绑定开发节点，启动 Agent 并验证有效提示词包含角色指令；刷新应用后未保存画布草稿可恢复。

## 验收标准

1. 用户无需项目内任何特殊目录，即可创建和编辑角色。
2. Agent 节点可在画布属性面板绑定角色，角色内容参与执行提示词。
3. 画布与 JSON 编辑都能生成同一份规范工作流定义并保存为新版本。
4. 无效角色引用阻止保存；无角色 Agent 节点继续兼容运行。
5. 角色和布局的后续修改不影响已创建 Run 的执行记录。
6. 角色、节点、边与提示词相关测试通过。
