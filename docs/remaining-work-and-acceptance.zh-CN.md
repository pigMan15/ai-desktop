# AI 工程工作流平台：剩余工作与验收清单

## 1. 文档目的

本文档记录当前版本距离“可交付的完整软件”仍需取得的验收证据和外部环境验证条件。它不再把已经实现并由自动化测试覆盖的功能误列为“待开发”。

本清单依据以下文档和当前实现整理：

- `docs/ai-workflow-platform-development-spec.zh-CN.md`
- `docs/ai-workflow-platform-implementation-plan.zh-CN.md`
- `docs/acceptance-matrix-10.3-10.12.zh-CN.md`
- 当前 Runtime、Renderer、Electron、打包脚本和自动化测试

## 2. 已完成的产品能力

以下能力已经实现，且已具备单元、集成或端到端自动化测试；它们不是 MVP 占位页面：

- Run 创建、暂停、恢复、归档、事件重建、Timeline 和 `allowedActions` 驱动的操作。
- 项目逻辑归档：可信人工归档会写入审计链，历史 Run 与工作流版本可继续查看；归档项目拒绝创建新的 Run，重新导入同一路径会恢复为活动状态。
- 工作流版本导出：可从工作流页下载稳定的 Canonical JSON 或可由 Generic YAML Adapter 再导入的 Generic YAML；导出不会改写项目目录。
- Agent/CLI 执行、运行输出持久化、节点状态回写、失败诊断、Checkpoint、恢复、取消、超时和重试记录。
- Codex CLI、Claude Code CLI 和 fake CLI 的发现、受控调用、实时输出采集及中文错误诊断边界。
- Shell/Codex/Claude 终端、Run/Node 会话绑定、历史输出回放、从旧会话重建新终端、遗留会话清理、搜索、复制粘贴、Resize、Ctrl+C、停止和 Evidence 导出。
- Run 模块交互式 Agent 会话：启动 Codex/Claude Code Agent 时默认创建受控 PTY，在页面底部 `Agent 交互终端` 中实时显示输出，并允许用户直接在 xterm 内输入回复后回车发送；输入、输出、取消、继续和结束状态会写回 Runtime。
- 终端危险命令审批：高风险命令必须经桌面审批对话框确认；用户取消不会写入 PTY，并由可信人工 Actor 将拒绝结果写入 Runtime 审计链。
- Gate、自动 Gate、Waiver、BLOCKED 处理入口、审批、可信 Actor、审计链、Artifact/Evidence 预览、差异比较、Run 报告和 Evidence Package。
- 本地项目 Git 工作区状态、分支、工作树、冲突、提交、受控推送和知识文档发布记录。
- 知识候选、人工审核、CLI 合成、实时合成输出、Diff、人工反馈、仅成功合成稿发布、Git 发布次数与回放。
- 受治理 Deploy Runner：部署命令只从工作流节点元数据读取，禁止 Renderer 传 Shell 命令，执行受项目目录、超时、输出上限、取消、审计和 Artifact 日志约束。
- 恢复诊断、支持包导出、共享 SQLite 读取串行化和跨终端/日志/Evidence 的敏感信息脱敏。
- 独立路由、中文业务界面、Runtime 随 Electron 受管启动、Windows Runtime EXE 构建和完整 Windows 打包脚本。

近期修复：`apps/renderer/src/app/styles.css` 中错误的重复 `.terminal-readout` 规则曾将终端、部署、产物和知识实时输出隐藏为 1px；该规则已移除。知识合成区也已从嵌套卡片改为候选卡片内的普通分区。Run Agent、部署输出和终端模块已统一使用有边界高度的 xterm 风格输出区，避免长日志无限撑高页面；CLI 输出按 UTF-8、GB18030 顺序解码，降低 Windows 中文环境乱码风险。

## 3. P0：必须在真实环境完成的验收

### 3.1 Codex CLI 与 Claude Code CLI 的真实登录态

**当前状态**

程序已完成 CLI 发现、执行、输出、超时、取消、非零退出和中文诊断的代码与 fake CLI 自动化覆盖。2026 年 7 月 28 日已在本机已登录的真实 Codex CLI 与 Claude Code CLI 上，经 Runtime 的 `start_agent_job`、受控子进程、实时事件持久化和完成状态链路分别执行无文件读写的固定文本任务并通过。

**已取得的真实环境证据**

- Codex CLI 已通过 Runtime 完成任务并写入 8 条实时输出事件；Claude Code CLI 已通过 Runtime 完成任务并写入 45 条实时输出事件。
- 2026 年 7 月 28 日，最新安装版 EXE 已通过桌面界面分别启动真实 Codex CLI 与 Claude Code CLI 的无副作用任务；两条任务均显示实时输出并达到 `COMPLETED`。该安装版验收脚本共 `5 passed`，同时覆盖应用启动、Shell 终端、Ctrl+C 和危险终端命令取消后的 Runtime 审计。
- Windows 受控环境现保留 `SYSTEMROOT`，避免 Node/Codex 在缺少系统根目录时以退出码 `134` 崩溃；该白名单同时用于 Deploy Runner。
- Codex Provider 在非 Git 工作流目录中显式传入 `--skip-git-repo-check`，同时保留 `--sandbox workspace-write`；Claude Provider 在流式 JSON 输出模式下传入版本要求的 `--verbose`。
- Runtime 诊断已确认 `codex.cmd` 与 `claude.cmd` 可用；PowerShell 对 `.ps1` shim 的执行策略不会影响应用使用 `.cmd` 入口。

**仍需补充的负例抽查**

- 在桌面界面中分别抽查未安装、未登录、登录失效、超时、用户取消和非零退出的中文提示。

**通过标准**

- 已登录 CLI 能执行一个无副作用的真实任务并持续显示实时输出。
- 不在应用数据库、日志、审计记录或导出包中保存 CLI 明文凭据。

### 3.2 Git 凭据下的真实推送

**当前状态**

项目工作区和知识发布已具备本地 Git 操作、失败提示、审计和发布次数逻辑；自动化测试不持有目标仓库的推送凭据。

**仍需验收**

- 使用目标账号在测试远程仓库验证分支、提交和 push 成功路径。
- 验证认证拒绝、网络失败和用户取消不会伪造成功状态，也不会错误增加知识发布次数。
- 确认冲突、脏工作树和 detached HEAD 的中文处理提示。

**通过标准**

- 成功 push 可追溯到分支和 commit hash。
- 失败或取消仅记录真实状态，不改写候选、文档或计数。

### 3.3 打包 EXE 与安装版的新增闭环

**当前状态**

本轮已重新生成 Runtime EXE、免安装 ZIP 和 NSIS 安装器，并通过免安装 EXE 与最新安装版 EXE 的 Playwright 验证：应用可从 `file:` 资源加载，Runtime 可被 Electron 受管启动，独立路由可用。最新免安装与安装版发布目录为 `release-full-20260729-141801`。

**已取得的打包版闭环证据**

- `npm.cmd run test:e2e:packaged` 已于 2026 年 7 月 29 日通过（`3 passed`），覆盖刚生成的免安装 EXE：以 `file:` 资源加载、Electron 受管 Runtime、独立路由，以及危险终端命令取消后 Runtime 审计记录。
- 同一测试在临时用户数据与临时 Runtime 数据库中导入项目、创建 Run、保存仅含 `deploy` 节点的工作流版本，并从页面启动受控部署；部署命令为非 Shell 的 `C:\Windows\System32\hostname.exe`，部署会话到达 `COMPLETED` 且实时输出在页面可见。
- 同一测试将临时 fake `codex.cmd` 前置到 `PATH`，由打包 EXE 发现并以真实 Runtime CLI 执行链路启动知识合成；知识候选绑定刚创建的真实 Run ID，页面断言收到 `packaged-knowledge-final` 实时输出。

**仍需验收**

- 安装版 EXE 已验证启动、受管 Runtime、恢复路由、Shell 终端输出、Ctrl+C，以及通过界面调用已登录的真实 Codex CLI 与 Claude Code CLI；其 Deploy Runner 与知识合成可沿用上述受控闭环步骤在目标安装目录抽查。
- GitHub 远程凭据已通过只读 `git ls-remote --heads origin` 验证；真实 Git 凭据下的 push 成功、失败和取消仍不能由只读验证或临时 Git 环境替代。

**通过标准**

- 应用不依赖 Vite、源代码路径或手工启动 Python Runtime。
- 打包版与安装版均能展示中文界面、实时输出和错误提示。

## 4. P1：长期运行与兼容性抽查

### 4.1 长时终端与恢复

- `desktop-electron.spec.ts` 已在同一临时 Electron 用户资料和 Runtime SQLite 数据库中覆盖应用退出、重启后的遗留终端诊断、清理和历史输出回放。仍需运行真实长生命周期终端后重启应用，确认历史输出可回放，旧会话不被错误标记为仍在运行，新会话具有新的 Session ID。
- 抽查异常退出、网络中断和遗留进程清理后的审计、输出脱敏和 Evidence 导出。

### 4.2 Windows 剪贴板与视觉检查

- 在真实 Windows 桌面验证复制、粘贴、快捷键和权限拒绝提示。
- 检查 ANSI、Unicode、长日志、部署输出、知识合成输出和产物预览在常用分辨率下均可阅读。

## 5. 已有自动化证据

截至 2026 年 7 月 29 日，本工作区最近一次完整验证结果为：

- `python -m pytest runtime/tests -q`：`227 passed`，仅有 1 个 FastAPI/TestClient 上游弃用 warning；其中包含项目归档、工作流导出、恢复诊断与其他 Run 读取并发访问的 SQLite 串行化回归。
- `npm.cmd run test`：Contracts、Renderer（20 个文件、80 项）和 Desktop 全量测试通过。
- `npm.cmd run build`：Contracts、Renderer（TypeScript 与 Vite）和 Desktop 生产构建通过。
- `npm.cmd run package:win:full`：Runtime EXE、免安装 ZIP 和 NSIS 安装器重新生成通过，最新目录为 `release-full-20260729-141801`。
- `npm.cmd run test:package-script`：打包脚本的安装器发现、镜像配置和产物结构检查通过。
- `npm.cmd run test:e2e`：浏览器工作流、源码 Electron 和最新免安装 EXE 共 `10 passed, 5 skipped`；跳过项仅为未在该命令中传入安装版 EXE 路径的安装版套件，已由下一条独立验收补齐。
- `npm.cmd run test:e2e:packaged`：刚生成的免安装 EXE 启动受管 Runtime 和独立路由通过；危险终端命令取消后 Runtime 审计成功写入；并已完成受控 Deploy Runner 与 fake Codex CLI 知识合成的真实实时输出闭环。
- 将本次生成的 NSIS 安装器静默安装到临时目录，并令 `INSTALLED_DESKTOP_EXE` 与 `INSTALLED_REAL_PROVIDER_EXE` 指向该新安装 EXE 后执行 `npm.cmd run test:e2e:installed`：`5 passed`。新安装目录中的 EXE 启动受管 Runtime，并完成 Shell 终端输出、Ctrl+C、危险终端命令取消审计、真实 Codex CLI 与真实 Claude Code CLI 的界面验收。
- `npm.cmd run test:e2e:p1`：项目页唯一工作区面板在宽屏下覆盖整个三列网格；Playwright 实测面板与网格宽度比例为 `1.0`，并已在 `390 × 844` 移动视口确认无横向溢出。
- Runtime 真实 CLI 验收：已登录 Codex CLI 与 Claude Code CLI 分别完成无文件读写任务，实时输出事件与 `COMPLETED` 状态均被 Runtime 持久化；未输出或记录明文凭据。
- 知识合成实时输出的 Runtime API、客户端请求、页面渲染和 App 集成均有回归测试。
- 交互式 Agent 与终端直接输入回归：`npm.cmd --workspace @workflow-platform/renderer run test` 已通过 `21` 个测试文件、`88` 个用例；覆盖 Run 默认交互式 Agent、xterm 内直接回复、Terminal Shell/Codex/Claude 直接输入、历史会话只读回放、Runtime client 交互式 API、App 层桌面 PTY 绑定，以及终端先以只读状态渲染、创建会话后切换为可输入状态的回归。
- Runtime CLI 编码回归：`python -m pytest runtime/tests/test_execution_cli.py -q` 已通过 `15 passed`；覆盖 UTF-8 与 GB18030 输出解码，以及受控 CLI 执行、实时输出、cwd 边界、输出上限、超时和取消。
- Renderer 生产构建回归：`npm.cmd --workspace @workflow-platform/renderer run build` 已通过，TypeScript 与 Vite 生产资源构建均完成。
- Deploy Runner 覆盖可信人工启动、受限命令配置、输出持久化、日志 Artifact、完成/失败状态和取消入口。
- Run 的任务目标与 JSON 参数已写入 `runs.context_json` 和 `RUN_CREATED` 事件；多 Run 可创建、切换，并保持独立上下文。自动 Gate 可依据必需 Artifact 类型由可信系统 Actor 生成证据和结果。
- 项目归档 API、旧 SQLite 数据库的 `archived_at` 增量迁移、项目页归档入口，以及 Canonical JSON/Generic YAML 工作流导出已由 Runtime 和 Renderer 专项测试覆盖。

详细实现位置、自动化测试和手工步骤见 `docs/acceptance-matrix-10.3-10.12.zh-CN.md`。

## 6. 最终完成定义

仅在以下条件全部满足时，版本才可称为“完整软件”或“可交付完整版”：

- 开发规格第 `10.3` 至 `10.12` 的功能项均有实现和可验证证据，或经过用户明确同意从范围中移除。
- Runtime、Renderer、Desktop、打包脚本和端到端测试在当前源码上通过。
- Codex CLI、Claude Code CLI 和 Git push 已在目标 Windows 机器的真实登录/凭据边界下完成验收。
- 新构建的免安装包与安装版已验证 Runtime 受管启动、独立路由、终端、Deploy Runner、知识合成实时输出和恢复路径。
- 遗留风险、环境限制和已知不支持项均以中文写入交付说明，不以页面存在、MVP 或演示路径替代生产功能。
