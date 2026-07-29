# 规格 10.3-10.12 验收矩阵

本文档对应 `docs/ai-workflow-platform-development-spec.zh-CN.md` 第 10.3 至 10.12 节。状态只按可验证证据记录，不以“页面存在”替代功能完成。

状态说明：

- `已验证`：已有自动化或可重复脚本证据。
- `部分验证`：实现已存在，聚焦语法或子链路验证通过，但完整自动化或打包环境仍未完成。
- `待验证`：需要在浏览器、Electron、打包 EXE 或安装版中继续验证。

## 当前验证命令

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `node -e "...ts.transpileModule..."` | 通过 | `App.tsx`、`runtimeClient.ts`、`TerminalPage.tsx`、`GatesPage.tsx` 等聚焦语法检查通过。 |
| `python -m py_compile ...` | 通过 | Runtime 核心服务、API、迁移、仓储和脱敏模块可编译。 |
| `npm.cmd run test` | 通过 | Contracts、Renderer、Desktop 全量 Node 侧测试通过：Renderer 20 个文件、80 个测试通过。 |
| `python -m pytest runtime/tests -q` | 通过 | Runtime 全量 pytest 通过：227 passed，1 个 FastAPI/TestClient 库级 warning。 |
| `npm.cmd run build` | 通过 | Contracts build、Renderer `tsc + vite build`、Desktop `tsc` 均通过。 |
| `python -m pytest runtime/tests/test_api.py -k "project_archive or workflow_export" -q` | 通过 | 项目归档、重导入恢复、归档项目拒绝新 Run、Canonical JSON 导出、Generic YAML 导出与再导入均通过。 |
| `python -m pytest runtime/tests/test_persistence.py::test_migrate_adds_project_archive_column_to_existing_database -q` | 通过 | 已存在 SQLite 数据库可增量添加 `projects.archived_at`。 |
| `npm.cmd --workspace @workflow-platform/renderer run test -- --run src/app/workspaceSession.test.ts src/app/runtimeClient.test.ts src/features/projects/ProjectDashboard.test.tsx src/features/workflow/WorkflowViewer.test.tsx` | 通过 | 项目 ID 会话持久化、项目归档入口、工作流导出请求及格式选择均通过。 |
| `npm.cmd --workspace @workflow-platform/renderer run test -- --run src/app/runtimeClient.test.ts src/features/knowledge/KnowledgePage.test.tsx src/app/App.test.tsx` | 通过 | 知识合成输出 API 请求、App 集成渲染、中文实时输出和非嵌套卡片结构通过。 |
| `python -m pytest runtime/tests/test_api.py::test_runtime_api_runs_a_governed_deploy_command_and_records_log_artifact -q` | 通过 | 部署启动授权、受限配置、输出、日志 Artifact 与 Kernel 状态回写通过。 |
| `npm.cmd run package:win:full` | 通过 | Runtime EXE、免安装 ZIP 和 NSIS 安装器重新生成通过；构建主机输出目录标为 `release-full-20260729-063614`，与当前验证日期 2026 年 7 月 28 日不一致。 |
| `npm.cmd run test:package-script` | 通过 | 打包脚本的安装器发现、镜像配置和产物结构检查通过。 |
| `npm.cmd run test:e2e:packaged` | 通过，`3 passed` | 刚生成的免安装 EXE 从 `file:` 加载应用资源、启动受管 Runtime 并保持独立路由；同一 E2E 在临时项目中真实执行受控 `hostname.exe` Deploy、取消危险终端命令并检查 Runtime 审计，以及通过临时 fake Codex CLI 显示知识合成实时输出。 |
| 将新 NSIS 安装器静默安装到临时目录后执行 `npm.cmd run test:e2e:installed` | 通过，`5 passed` | 新安装目录中的 EXE 从安装目录加载资源、启动受管 Runtime，并完成 Shell 终端输出、Ctrl+C 中断信号、危险命令取消审计、真实 Codex CLI 与真实 Claude Code CLI 的界面验收。 |
| `npm.cmd run test:e2e` | 通过，`10 passed, 5 skipped` | 浏览器工作流、源码 Electron 和最新免安装 EXE 全部通过；5 个跳过项仅为未传入安装版 EXE 路径时的安装版套件，已由上述独立安装版命令补齐。 |
| `npm.cmd run test:e2e:p1` | 通过，`1 passed` | 项目页唯一工作区面板在宽屏下完整覆盖网格；另以 `390 × 844` 视口抽查，无横向溢出。 |
| Runtime 真实 CLI 验收 | 通过 | 已登录 Codex CLI 和 Claude Code CLI 分别通过 `start_agent_job` 在临时工作流中完成无文件读写任务，实时输出事件和 `COMPLETED` 状态均已验证；未记录明文凭据。 |

## 10.1-10.2 补充验收

| 验收项 | 实现位置 | 自动化测试 | 手工验证步骤 | 当前结果 | 遗留风险 |
| --- | --- | --- | --- | --- | --- |
| 项目逻辑归档与恢复 | `migrations.py`、`repositories.py`、`runtime_service.py`、`api/app.py`、`ProjectDashboard.tsx` | `test_runtime_api_project_archive_and_reimport_reactivates_it`、`test_migrate_adds_project_archive_column_to_existing_database`、`ProjectDashboard.test.tsx`、`runtimeClient.test.ts` | 导入项目，创建历史 Run，点击“归档项目”；确认仍可查看工作流、创建 Run 返回 `PROJECT_ARCHIVED`；重新导入同一路径后创建 Run。 | 已验证 | 归档状态以本地 Runtime SQLite 为准；跨机器同步策略需由后续服务端部署方案确定。 |
| 工作流编辑、版本与导出 | `runtime_service.py`、`api/app.py`、`runtimeClient.ts`、`WorkflowViewer.tsx` | `test_runtime_api_workflow_export_supports_canonical_json_and_generic_yaml`、`runtimeClient.test.ts`、`WorkflowViewer.test.tsx` | 在工作流页选择 Canonical JSON 或 Generic YAML，点击“导出工作流”；将 YAML 保存为 `workflow.yaml` 后重新导入。 | 已验证 | 浏览器下载目录由用户系统策略决定；导出不会写入原项目目录。 |

## 10.3 Run Management

| 验收项 | 实现位置 | 自动化测试 | 手工验证步骤 | 当前结果 | 遗留风险 |
| --- | --- | --- | --- | --- | --- |
| 创建 Run | `runtime/src/workflow_platform/runtime_service.py`、`apps/renderer/src/features/runs/RunDashboard.tsx` | `runtime/tests/test_api.py`、`apps/renderer/src/app/App.test.tsx`、`workflow-product-loop.spec.ts` | 导入项目后创建中文标题 Run，确认 Timeline 出现 `RUN_CREATED`。 | 已验证 | 复杂 Run 分组和批量操作可继续扩展。 |
| 选择 workflow 版本 | `ProjectDashboard.tsx`、`runtimeClient.ts` | `ProjectDashboard.test.tsx`、`workflow-p1.spec.ts` | 选择导入后的 workflowVersionId，再创建 Run。 | 已验证 | 打包版设置持久化已冒烟，复杂多版本编辑仍需扩展。 |
| 配置 Run 参数 | `runtime_service.create_run`、`RunRepository`、`RunDashboard.tsx` | `test_runtime_api_persists_run_objective_and_parameters`、`RunDashboard.test.tsx`、`workflow-product-loop.spec.ts` | 填写“任务目标”和 JSON 参数，创建后切换 Run 并核对持久化上下文。 | 已验证 | 高级参数 schema 和字段级编辑可继续扩展。 |
| 暂停/恢复/归档 Run | `kernel/transition.py`、`RunDashboard.tsx` | `runtime/tests/test_kernel.py`、`RunDashboard.test.tsx`、`workflow-product-loop.spec.ts` | 点击暂停、恢复、归档，确认 allowedActions 刷新。 | 已验证 | 归档后恢复策略需在更多数据状态下回归。 |
| Timeline/当前节点/allowedActions | `kernel/projection.py`、`RunDashboard.tsx` | `App.test.tsx`、`RunDashboard.test.tsx`、`workflow-product-loop.spec.ts` | 执行节点、提交 Artifact、审批和 Gate，确认状态栏更新。 | 已验证 | 打包版已验证启动和路由，完整治理链路仍以浏览器 E2E 覆盖。 |
| 多 Run（独立上下文与切换） | `RunRepository.list_for_workflow_version`、`RunDashboard.tsx` | `RunDashboard.test.tsx`、`workflow-product-loop.spec.ts` | 创建两个带不同目标和参数的 Run，切换后确认各自上下文独立。 | 已验证 | 界面保持单活跃 Run，批量并行控制可继续扩展。 |
| 事件重建 Run 状态 | `runtime_service.rebuild_projection`、`RecoveryPage.tsx` | `runtime/tests/test_kernel.py`、`RecoveryPage.test.tsx`、`desktop-installed.spec.ts` | Recovery 页面点击重建投影。 | 已验证 | 复杂损坏事件日志需要更多负例。 |

## 10.4 Execution

| 验收项 | 实现位置 | 自动化测试 | 手工验证步骤 | 当前结果 | 遗留风险 |
| --- | --- | --- | --- | --- | --- |
| Agent 执行 | `execution/agent.py`、`execution/cli.py`、`RunDashboard.tsx` | `runtime/tests/test_execution_cli.py`、`test_api.py`、真实 Runtime CLI 验收、`desktop-installed.spec.ts` | 选择 fake/codex/claude provider 启动节点，查看实时输出。 | 已验证 | 已验证真实 Codex/Claude 登录态、受控环境、实时事件与完成状态；最新安装版 EXE 已通过界面完成两种真实 Provider 的无副作用任务。 |
| Codex/Shell terminal 执行 | `apps/desktop/src/main/terminal.ts`、`TerminalPage.tsx` | `apps/desktop/test/main.test.ts`、`TerminalPage.test.tsx`、`desktop-electron.spec.ts` | 创建 Shell/Codex 终端，发送输入并查看输出。 | 已验证 | Codex CLI 真实认证仍取决于本机 CLI 状态。 |
| Manual task 执行 | `ApprovalInbox.tsx`、`approvals/service.py` | `ApprovalInbox.test.tsx`、`test_api.py` | 人工审批 approve/reject/defer。 | 部分验证 | 需端到端验证权限错误提示。 |
| Gate 执行与自动 Gate | `runtime_service.submit_gate_result`、`runtime_service._evaluate_automatic_gate`、`GatesPage.tsx` | `test_runtime_api_automatically_passes_configured_gate_with_artifact_evidence`、`GatesPage.test.tsx`、`workflow-product-loop.spec.ts` | 提交 Gate pass/fail/waive，或配置 `metadata.automatic.requiredArtifactTypes` 后确认可信系统 Actor 自动写入证据与结果。 | 已验证 | 重试上限策略需继续扩展。 |
| Deploy 执行 | `execution/deploy.py`、`runtime_service.py`、`api/app.py`、`RunDashboard.tsx` | `runtime/tests/test_api.py`、`RunDashboard.test.tsx`、`runtimeClient.test.ts`、`desktop-packaged.spec.ts` | 在节点 `metadata.deploy` 配置受限命令，使用可信人工启动，确认输出、取消、Artifact 日志和 Timeline。 | 已验证 | 免安装 EXE 已在临时项目内真实执行非 Shell 的 `hostname.exe`，会话 `COMPLETED` 且实时输出可见；安装版可继续进行目标机抽查，不接受 Renderer 传入任意 Shell 命令。 |
| Report 生成 | `runtime_service.get_run_report` | `test_api.py`、`ArtifactsPage.test.tsx`、`GatesPage.test.tsx` | 下载 Run/Gate 报告并检查 Gate、审批、Evidence。 | 已验证 | 打包版文件保存 UI 已冒烟，外部目标目录策略需更多手工验收。 |
| Checkpoint / Interrupt / resume / Retry / Timeout | `agent_checkpoints`、`RecoveryPage.tsx`、`runtime_service.py` | `test_api.py` | 人为制造 recoverable checkpoint，恢复或放弃。 | 部分验证 | 超时策略和真实 CLI 中断仍需 E2E。 |

## 10.5 Terminal

| 验收项 | 实现位置 | 自动化测试 | 手工验证步骤 | 当前结果 | 遗留风险 |
| --- | --- | --- | --- | --- | --- |
| Codex Terminal / Shell Terminal | `TerminalManager`、`TerminalPage` | `main.test.ts`、`TerminalPage.test.tsx`、`desktop-electron.spec.ts`、`desktop-installed.spec.ts` | 创建 Shell/Codex 终端并确认进程启动。 | 已验证 | Codex 终端的真实认证仍取决于本机 CLI 登录态。 |
| Run/Node-bound session | `runtimeClient.registerTerminalSession`、`TerminalSessionRepository` | `runtimeClient.test.ts`、`test_api.py`、`desktop-electron.spec.ts` | 创建终端后查看 Runtime 会话列表。 | 已验证 | 打包版终端真实创建仍建议继续在目标机器手工验收。 |
| ANSI / Unicode | `xterm.js`、输出持久化 | `TerminalPage.test.tsx`、`test_terminal_redaction.py` | 输出中文和 ANSI 文本，确认显示与保存。 | 部分验证 | 需视觉 E2E 截图验证。 |
| 复制粘贴/搜索/Resize/Scrollback | `TerminalPage.tsx` | `TerminalPage.test.tsx` | 搜索长输出、复制粘贴、resize 并继续导出 Evidence。 | 已验证 | 剪贴板系统权限失败在真实桌面仍需手工抽查。 |
| Ctrl+C / Stop / Restart | `TerminalManager.interrupt`、Electron IPC、`TerminalPage` | `main.test.ts`、`TerminalPage.test.tsx`、`desktop-installed.spec.ts` | 发送 Ctrl+C、停止、重启并确认 Runtime 会话状态与提示更新。 | 已验证 | 长时间运行命令的真实中断效果仍需人工抽查。 |
| Session recovery / 输出脱敏 / 输出转 Evidence | `RecoveryPage`、`redaction.py`、`export_terminal_output_as_evidence` | `test_api.py`、`test_terminal_redaction.py`、`TerminalPage.test.tsx`、`desktop-electron.spec.ts` | 回放历史会话，从旧配置新建终端，导出 Evidence。 | 已验证 | Electron E2E 已覆盖应用退出、同一用户资料与 Runtime 数据库重启、遗留终端清理及历史输出回放；真实长生命周期终端仍需长时运行抽查。 |

## 10.6-10.12 摘要矩阵

| 规格节 | 关键能力 | 实现位置 | 当前结果 | 下一步验收 |
| --- | --- | --- | --- | --- |
| 10.6 Approval | inbox、请求视图、approve/reject/defer、comment、actor、timestamp、permission、防 Agent 代签 | `ApprovalInbox.tsx`、`approvals/service.py`、`governance/actors.py` | 已验证 | 真实多人 Actor/权限源仍需接入企业身份后复验。 |
| 10.7 Gates | dashboard、manual/verifier decision、自动 Gate、waiver、retry、failure recovery、BLOCKED、Evidence、report | `GatesPage.tsx`、`runtime_service.py`、`kernel/projection.py` | 已验证 | 重试上限与更多 BLOCKED 路由可继续产品化。 |
| 10.8 Artifacts/Evidence | browser、Markdown/text preview、hash、provenance、safe path、diff、package、report | `ArtifactsPage.tsx`、`artifacts/service.py`、`runtime_service.py` | 已验证 | 大文件、二进制预览和外部路径策略需扩展。 |
| 10.9 Git/Workspace | branch、worktree、dirty/detached、merge、conflict、commit、push | `gitWorkspace.ts`、`GitWorkspacePanel.tsx`、`desktopGit.ts` | 部分验证 | 本机 Git 凭据下 push 成功/失败/取消仍需目标账号实测。 |
| 10.10 Knowledge | candidate、review、accepted queue、shared repo、CLI synthesis、实时输出、diff、feedback、push、count、replay | `knowledge/service.py`、`knowledge_synthesis_output_events`、`runtime_service.py`、`KnowledgePage.tsx`、`AuditPage.tsx` | 部分验证 | Runtime、页面与打包 EXE 已覆盖候选审核后的 fake Codex CLI 合成实时输出；真实 Codex/Claude 登录态已由 Runtime Agent 链路和安装版界面验证，Git push 成功、失败和取消仍待凭据验收。 |
| 10.11 Recovery/Diagnostics | Run recovery、Terminal recovery、Agent checkpoint、orphan cleanup、projection rebuild、event log、diagnostic export、redaction、SQLite 读取串行化 | `RecoveryPage.tsx`、`runtime_service.py`、`diagnostics/support-bundle`、`redaction.py` | 已验证 | 长时运行、异常退出和真实用户数据目录仍需抽查。 |
| 10.12 Settings/Security | CLI discovery、executor selection、adapter settings、credential boundary、local token、path sandbox、command approval、danger guard、audit log | `SettingsPage.tsx`、`execution/diagnostics.py`、`api/app.py`、`TerminalManager`、`audit.py`、`desktop-electron.spec.ts` | 部分验证 | Electron E2E 已覆盖危险命令在桌面审批对话框中被取消、命令未执行、可信人工拒绝审计成功写入；`codex.cmd` / `claude.cmd` 的真实安装与认证已验证。令牌轮换、登录失效和系统剪贴板权限仍需最终人工验收。 |

## 交付说明

- 常规受限沙箱下 Renderer/Vite 和 pytest 会遇到 Windows 子进程或临时目录权限问题；使用用户批准的提升执行后，全量自动化已通过。
- 本轮源码的 Runtime、Node、生产构建、Windows 打包、免安装 EXE E2E 和安装版 EXE E2E 均已通过；桌面 Electron E2E 另已覆盖危险命令的取消与审计、应用重启后的遗留终端清理及历史输出回放。
- 新打包目录为 `release-full-20260729-063614`，但当前验证日期是 2026 年 7 月 28 日。目录标签处于未来日期，说明构建主机时钟存在偏差；发布前应校准构建机时间或使用可审计的 CI 版本号。
- 当前打包版 E2E 已验证启动、Runtime、路由、受控 Deploy Runner 和 fake Codex CLI 知识合成实时输出；最新安装版 EXE 已验证受管 Runtime、Shell 终端输出、Ctrl+C，以及真实 Codex/Claude CLI 的界面调用。
- 已登录的 Codex CLI 与 Claude Code CLI 已在真实 Runtime Agent 链路和安装版桌面界面中通过无副作用任务验收；仍需完成 Git push 成功、失败和取消的凭据验收。
