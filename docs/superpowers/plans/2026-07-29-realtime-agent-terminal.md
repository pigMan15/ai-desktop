# 实时 Agent 终端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Run 页 Agent 提供由 Electron IPC 直接驱动的低延迟 xterm 输出。

**Architecture:** `TerminalManager` 为 PTY 输出增加订阅接口，主进程将帧推送给创建会话的 Renderer。preload 注册可取消监听器，App 将实时帧用于渲染并异步批量保存至 Runtime。

**Tech Stack:** Electron IPC、node-pty、React、xterm、Vitest、Node assert。

---

### Task 1: 主进程 PTY 输出订阅

**Files:**
- Modify: `apps/desktop/src/main/terminal.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Test: `apps/desktop/test/main.test.ts`

- [ ] 写入失败测试，断言订阅者收到同一序号和数据帧，取消订阅后不再接收。
- [ ] 实现 `TerminalManager.subscribeOutput(sessionId, listener)`，并在 `onData` 中通知监听器；停止会话时清理监听器。
- [ ] 在 `terminal:create` 中把创建该会话的 Renderer 绑定为订阅者，推送 `terminal:output` 事件。

### Task 2: 安全 preload 输出监听

**Files:**
- Modify: `apps/desktop/src/preload/preload.cts`
- Test: `apps/desktop/test/preload.test.ts`（如现有测试结构允许）

- [ ] 写入失败测试，断言监听器只接收匹配会话 ID 的帧且取消函数移除监听器。
- [ ] 暴露 `workflowTerminal.onOutput(sessionId, listener): () => void`，不暴露原始 Electron IPC 对象。

### Task 3: Renderer 实时缓冲与后台审计

**Files:**
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/features/runs/RunDashboard.tsx`
- Test: `apps/renderer/src/app/App.test.tsx`

- [ ] 写入失败测试，断言实时 IPC 帧立即出现在 Agent 终端，且无需等待 `/interactive-session/output` 响应。
- [ ] 为每个交互 Agent 保存本地输出缓冲，订阅 PTY 帧后立刻更新 xterm 输入数据。
- [ ] 将 Runtime 输出写入移到定时批量队列；失败仅显示审计同步状态并保留实时终端。
- [ ] 取消、失效或卸载时注销监听与清理队列。

### Task 4: 集成验证

**Files:**
- Test: `apps/desktop/test/main.test.ts`
- Test: `apps/renderer/src/app/App.test.tsx`

- [ ] 执行桌面端、Renderer、Runtime 全部测试。
- [ ] 执行生产构建。
