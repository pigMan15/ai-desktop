# P2-P6 完整产品开发设计

## 目标

在已完成的 P1 Runtime-backed 产品闭环基础上，完成外部 Agent CLI、操作型桌面工作台、Electron Runtime 生命周期、真实终端、治理与 Knowledge 的后续能力，使平台可在本地桌面环境中完成受控的 AI 工程工作流。

## 范围和交付顺序

### P2：CLI Agent Runtime

- 新增 provider-neutral `AgentExecutor` 端口和 `AgentJob` 持久化记录。
- 新增 Codex 与 Claude Code provider：
  - Codex 使用 `codex.cmd exec --json`。
  - Claude Code 使用 `claude.cmd -p --output-format stream-json`。
- Runtime 使用无 shell 的子进程调用，限定 `cwd` 为 Run 绑定项目根目录。
- 解析 JSONL/stream-json，写入 agent job、输出片段、最终摘要和失败原因。
- 支持取消、超时、最大输出量和允许的工具白名单。
- CLI Agent 不能产生 human approval 或 gate pass；仍须经现有 Kernel transition 和治理端点。

### P3：操作型 UI

- Renderer 从只读状态面升级为可执行工作台。
- 支持项目路径导入、创建 Run、启动节点、提交 Artifact、人工审批、Gate 判定、Agent 启动和取消。
- 支持 Run timeline、CLI 日志流、失败/加载/空状态和错误反馈。
- 所有状态变更仅调用 Runtime API；Renderer 不维护本地事实状态。

### P4：Electron Runtime 生命周期

- Electron main process 在应用启动时启动 Python Runtime 子进程。
- 通过健康检查等待 Runtime 就绪，记录端口与进程 id。
- preload 仅暴露最小的 typed IPC API。
- 支持停止、异常退出检测、一次受控重启和诊断日志读取。
- 生产与开发模式分别支持外部 Runtime URL 和受管 Runtime 子进程。

### P5：真实终端

- 使用 `node-pty`/ConPTY 创建 Shell 或 Codex 终端会话。
- Session 绑定 project/run/node，记录 cwd、命令、状态、退出码与 scrollback。
- 支持 create、write、resize、stop、restart、scrollback 和事件订阅。
- Renderer 通过 preload IPC 显示输出并发送输入；不直接访问系统终端。
- 终端输出可作为 Artifact 或 Gate evidence 的候选引用，但不自动通过 Gate。

### P6：治理、Knowledge 与发布验收

- 增加角色权限、命令策略、waiver、不可篡改审计事件和治理查询。
- 增加本地 Knowledge provider：候选生成、人工审核、发布、检索、引用追踪和 replay。
- 增加导出和诊断包，补充桌面安装/打包与 Electron E2E 验收。

## 架构

```text
Renderer
  -> typed Runtime API / preload IPC
Electron main
  -> managed Python Runtime
  -> managed node-pty terminal sessions
Python Runtime
  -> Kernel / event store / projection
  -> AgentExecutor providers (Codex, Claude Code)
  -> governance and knowledge services
SQLite
  -> runs, events, projections, agent jobs, terminal sessions,
     audit records, knowledge documents and publication records
```

## 安全与治理约束

- Renderer 不能执行本地进程、访问 shell、读取密钥或绕过 Runtime。
- 所有外部 CLI 使用参数数组启动，`shell=False`，并从最小化环境变量中继承必要认证。
- Windows 调用 `codex.cmd`、`claude.cmd`，不依赖会受执行策略影响的 PowerShell `.ps1` shim。
- CLI 命令、可写目录、可调用工具、超时、输出大小和并发数由 Runtime policy 决定。
- 不启用 Codex 或 Claude Code 的危险跳过审批/权限参数。
- Agent、Terminal、Knowledge provider 只能提交候选 Artifact/evidence；human approval 和 Gate result 仍通过受信 actor 和 Kernel 验证。

## 数据与 API

- P2 新增 `agent_jobs`、`agent_output_events`、`agent_checkpoints`。
- P5 扩展 `terminal_sessions` 和 `terminal_output_events`。
- P6 新增 `audit_records`、`knowledge_documents`、`knowledge_candidates`、`knowledge_publications`。
- API 采用 Run-bound 资源路径，所有变更请求携带 actor、expectedRevision 和 now。
- 日志流优先使用轮询式 cursor API；Electron terminal 输出使用 IPC subscription。

## 测试与验收

- Python pytest 覆盖 provider command 构造、输出解析、取消、超时、权限拒绝、事件持久化和治理绕过拒绝。
- Renderer Vitest 覆盖表单、错误态、禁用态、日志与 Runtime 调用。
- Desktop tests 覆盖 Runtime 生命周期、preload 白名单和 terminal IPC。
- Playwright 运行真实 Runtime 与受控 fake CLI，验证完整 Agent -> Artifact -> Approval -> Gate -> Timeline 路径。
- Electron E2E 验证受管 Runtime 和 terminal session 的关键路径。

## 明确不做

- 不让 LangGraph、Codex 或 Claude Code 的内部状态成为平台事实源。
- 不让 Agent 自动批准人工审批、自动 waive Gate 或绕过安全策略。
- 不把真实用户密钥、完整环境变量或任意系统路径暴露给 Renderer。
- 不在 P2-P6 中引入云端多租户、远程协作或计费系统。
