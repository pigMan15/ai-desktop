# 实时 Agent 终端设计

## 目标

让 Run 页中的 Codex CLI 与 Claude Code 交互终端直接呈现 PTY 数据帧，不经过 Runtime 轮询或历史回放，以获得接近 Windows 终端的 TUI 交互体验。

## 架构

Electron 主进程的 `TerminalManager` 在接收 PTY 数据时保留有限历史并通知该会话的订阅者。`terminal:create` IPC 将订阅者绑定到创建会话的 Renderer `webContents`；preload 只暴露按会话 ID 过滤的 `onOutput` 订阅 API。

Renderer 将实时帧存入按 Agent job ID 分组的本地滚动缓冲区，并将其直接传给 xterm。Runtime 输出保存改为异步、批量的审计任务，失败仅报告审计同步状态，不阻塞终端渲染或用户输入。

## 生命周期与错误处理

停止会话时主进程清理订阅者。Renderer 卸载、取消 Agent 或检测到会话不存在时注销订阅并清理本地缓冲区。应用重启后的历史输出保持只读查看用途；没有存活 PTY 的会话不尝试恢复为交互终端。

## 验收

- PTY 数据到达后无需 Runtime HTTP 请求即可写入 Run 页 xterm。
- Codex/Claude TUI 的光标移动与局部刷新不被数据库轮询延迟。
- 输入和 Ctrl+C 仍直接写入同一 PTY。
- Runtime 输出保存故障不停止实时终端。
- 主进程、preload 与 Renderer 各有回归测试。
