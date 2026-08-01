# AI Workflow Platform

AI Workflow Platform 是一个本地桌面 AI 工程工作流软件，面向“导入项目 -> 规范化工作流 -> 创建 Run -> 推进节点 -> 调用 Codex/Claude Code CLI -> 审批/Gate/证据归档 -> 打包交付”的完整闭环。

当前版本已经接入 Runtime API、Electron 桌面运行时、独立页面路由、受控终端、交互式 Agent 会话、实时日志、Windows EXE 打包脚本和中文工作台。

## 环境要求

- Windows 10/11。
- Node.js 与 npm，可在 PowerShell 中运行 `node -v`、`npm.cmd -v`。
- Python 3.11+，用于 Runtime 服务和打包 Runtime EXE。
- 可选：Codex CLI，确保 `codex.cmd` 在 `PATH` 中可用且已登录。
- 可选：Claude Code CLI，确保 `claude.cmd` 在 `PATH` 中可用且已登录。
- 可选：PyInstaller，完整打包 Runtime EXE 时需要；缺失时执行 `python -m pip install pyinstaller`。

## 开发命令

```powershell
npm install
npm.cmd run test
npm.cmd run test:runtime
npm.cmd run verify
npm.cmd run test:e2e
```

Windows PowerShell 也可以直接运行统一验证脚本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
```

## 启动桌面应用

开发模式：

```powershell
npm.cmd run dev
```

该命令会启动 Vite Renderer，并由 Electron 自动管理 Runtime。不要在开发时另行手动启动 `uvicorn`；这样会导致应用连接到过期 Runtime 进程。进入设置或初始化页面后，配置项目路径和工作流信息；已经保存过工作区会话时，应用会自动恢复上次的项目、工作流版本和 Run。

## Run 模块怎么使用

1. 打开“运行”页面。
2. 选择或创建一个 Run。
3. 在节点卡片中选择目标节点，例如 `plan`、`verify`、`deploy`。
4. 需要推进普通节点时，点击对应动作按钮。
5. 需要 AI 参与时，在“Agent 提示词”中输入中文或英文任务说明。
6. 选择 Agent Provider：`Codex`、`Claude Code` 或测试用 `Fake`。
7. 选择 Agent 模式。
8. 点击“启动 Agent”。

## 产物驱动工作流怎么使用

工作流管理员在“工作流”页面为每个节点配置交付物规范：交付物 ID、名称、类型、项目内固定路径、可选模板、说明和必需性；同时配置 Agent 模板、上游上下文范围、类型过滤、摘要上限和推进方式。保存前可模拟，保存时 Runtime 会拒绝无效路径、重复 ID、未知模板变量和不安全的自动推进配置。

创建 Run 后，执行者只需要启动节点和 Agent，不需要手动填写标准 Artifact 的路径或类型。Runtime 会把本节点应生成的文件、固定位置以及上游已通过 Artifact 的路径、哈希和摘要组装为 `effectivePrompt`。Run 页面会显示当前节点的交付物要求和启动前上下文预览。

Agent 完成后，或用户点击“重新检查节点产物”后，Runtime 会扫描声明的固定路径，校验项目边界，计算哈希并登记版本：

- 必需交付物缺失时，节点保持 `AWAITING_ARTIFACT`，不能推进。
- 可选交付物缺失不会阻塞节点。
- 相同内容重复扫描不会生成重复版本；文件变化会生成新版本，并保留旧版本用于比较和 Evidence。
- 失败 Agent 产生的临时交付物会显示为“待确认”。只有可信人工点击“确认正式产物”后，它才会影响节点状态。
- 下游 Agent 只会读取上游 `PASSED` 节点的正式 Artifact；Artifact 页面可查看每个版本被哪些 Agent 消费。

审批和 Gate 会绑定当时正式 Artifact 的哈希集合。之后重新扫描到内容变化时，Runtime 会使旧审批/Gate 记录失效、写入审计，并让节点重新进入待审批或待 Gate 状态。这样不能用一次旧审批覆盖已经变更的交付物。

Agent 模式说明：

- `交互式终端`：默认模式。应用会在桌面端创建受控 PTY，真正启动 `codex.cmd` 或 `claude.cmd`，并把输出显示在 Run 页面底部的 `Agent 交互终端` 中。
- `自动执行`：适合无人工追问的短任务。Runtime 直接执行 provider 命令，输出写入 Agent 日志。

## Agent 启动后怎么回复

在 `交互式终端` 模式下，Agent 如果输出“需要你回复”“是否继续”“选择方案”等内容，直接在底部的 `Agent 交互终端` 里输入回复并按回车即可。不要再取消旧 Agent 再新建一个 Agent。

常用操作：

- 回复普通文本：直接输入，例如 `继续`，然后按 Enter。
- 选择 CLI 提示项：输入 CLI 要求的序号或文字，然后按 Enter。
- 中断当前 CLI：点击终端工具栏的中断按钮或发送 Ctrl+C。
- 取消 Agent：点击 Run 页面中的取消按钮，应用会停止绑定的桌面终端并把取消状态写回 Runtime。
- 继续历史交互：对已经结束的交互式 Agent 使用继续入口，Runtime 会带上历史输入输出创建新的交互式会话。

交互式输入会先写入真实 CLI，再由应用把完整的回车行记录到 Runtime 审计链；输出会按序列号增量转录，刷新页面后仍可看到已持久化的输出。

## 终端模块怎么使用

终端页面支持三类会话：

- `Shell`：打开受控系统 Shell，适合执行项目命令。
- `Codex`：打开 Codex CLI 交互终端。
- `Claude`：打开 Claude Code CLI 交互终端。

使用方式：

1. 打开“终端”页面。
2. 选择终端类型、工作目录和尺寸。
3. 点击“创建终端”。
4. 直接在 xterm 终端区域输入命令或回复，按 Enter 发送。

Shell 终端会对高风险命令弹出中文确认；取消后不会写入 PTY，并会通过可信人工 Actor 写入 Runtime 审计。Codex/Claude 终端按 CLI 原始交互方式写入输入，适合直接处理 CLI 的追问、确认和继续执行。

终端工具栏支持：

- 搜索输出。
- 复制选中内容。
- 粘贴剪贴板内容。
- 清屏。
- 跳到最新输出。
- 调整终端尺寸。
- Ctrl+C 中断。
- 停止会话。
- 导出 Evidence。
- 查看历史输出。
- 基于历史会话新建终端。

## 实时日志和布局

Run 页面、部署输出、Agent 输出和终端页面都使用有边界高度的 xterm 风格日志区域，不会因为长日志无限撑高页面。

日志区域支持 ANSI 输出、中文文本、增量追加和滚动。Codex/Claude/Shell 的子进程输出会按 UTF-8、GB18030 顺序解码，避免 Windows 中文环境中常见的乱码。

## Codex CLI / Claude Code CLI 对接

对接条件：

```powershell
where.exe codex
where.exe claude
codex --version
claude --version
```

如果命令不可用，请把对应 CLI 的 `.cmd` 入口加入用户或系统 `PATH`，然后重启桌面应用。Runtime 诊断会优先检查 `codex.cmd` 和 `claude.cmd`，不会依赖 PowerShell `.ps1` shim。

登录状态由 CLI 自己管理。本软件不会保存 Codex 或 Claude Code 的明文凭据，也不会把登录 token 写入应用数据库、日志、审计记录或 Evidence 包。

## 打包成 Windows EXE

完整打包命令：

```powershell
npm.cmd run package:win:full
```

该命令会执行：

- 构建 contracts、renderer 和 desktop。
- 使用 PyInstaller 打包 Python Runtime EXE。
- 生成免安装 ZIP。
- 生成 NSIS 安装器。

只打包 Runtime：

```powershell
npm.cmd run build:runtime:exe
```

只生成安装器路径：

```powershell
npm.cmd run package:win:installer
```

打包脚本的结构校验：

```powershell
npm.cmd run test:package-script
```

打包后建议验证：

```powershell
npm.cmd run test:e2e:packaged
npm.cmd run test:e2e:installed
```

如果 EXE 打开空白，优先检查：

- 是否执行过 `npm.cmd run build`。
- `apps/renderer/dist/index.html` 是否存在。
- Electron 是否加载 `file:` 资源而不是开发服务器地址。
- Runtime EXE 是否在打包产物目录中。
- Windows 安全软件是否阻止 Runtime 或 Electron 子进程启动。

## 验证说明

默认完整验证：

```powershell
npm.cmd run verify
```

`verify` 会运行 contracts、renderer、desktop 和 Runtime 测试，但不启动浏览器 E2E。浏览器端到端验证需要单独运行：

```powershell
npm.cmd run test:e2e
```

本轮交互式 Agent/终端增强至少需要通过：

```powershell
npm.cmd --workspace @workflow-platform/renderer run test
npm.cmd --workspace @workflow-platform/renderer run build
python -m pytest runtime/tests/test_execution_cli.py -q
```

## 当前能力范围

当前版本覆盖：

- Project import。
- Adapter detection。
- Harness / Markdown Checklist / Generic YAML Adapter import。
- Canonical Workflow storage。
- Event-sourced Run state。
- Runtime-backed Project / Workflow / Run API。
- 独立页面路由。
- Run 创建、切换、暂停、恢复、归档和事件重建。
- Artifact / Approval / Gate / Evidence。
- Codex CLI、Claude Code CLI 和 fake CLI provider。
- 自动执行 Agent。
- 交互式 Agent 终端。
- Shell/Codex/Claude 受控终端。
- 危险 Shell 命令确认和审计。
- 部署实时输出。
- Runtime 诊断和恢复。
- Windows Runtime EXE、免安装 ZIP 和 NSIS 安装器打包。
- 中文界面、中文文档和中文错误提示。

需要真实环境继续验收的内容：

- 已登录 Codex CLI 和 Claude Code CLI 的真实长任务、登录失效、超时、取消和非零退出抽查。
- Git 远程 push 的成功、失败、凭据拒绝和冲突场景。
- 长时间运行终端、系统重启、异常退出后的恢复抽查。
- 目标 Windows 机器上的安装包签名、杀毒软件拦截和企业权限策略验证。

详细验收清单见 `docs/remaining-work-and-acceptance.zh-CN.md`。
