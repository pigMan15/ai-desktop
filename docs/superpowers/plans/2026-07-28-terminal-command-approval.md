# 终端命令审批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让高风险终端命令在项目路径边界内通过可信人工确认后才可执行，并留下 Runtime 审计证据。

**Architecture:** Electron `TerminalManager` 是命令输入的唯一 PTY 写入者，使用受限单行命令策略和一次性审批标识。Runtime 持久化审计事件，Renderer 通过 preload 展示中文确认和提交决定。

**Tech Stack:** TypeScript、Electron、node-pty、React、Vitest、Python、FastAPI、SQLite、pytest。

---

### Task 1: 定义主进程命令策略

**Files:**
- Modify: `apps/desktop/src/main/terminal.ts`
- Test: `apps/desktop/test/main.test.ts`

- [x] **Step 1: 写入失败测试。** 验证 `requestCommand()` 对 `del G:\Project\demo\build` 返回待确认而不写入 PTY；对 `echo ok & del x`、`echo ok\rdel x` 和 `cd G:\outside` 返回阻止且不写入 PTY。
- [x] **Step 2: 运行桌面测试，确认新断言因缺少 `requestCommand` 而失败。**

  Run: `npm.cmd --workspace @workflow-platform/desktop run test`

  Expected: FAIL，错误指向 `requestCommand is not a function`。

- [x] **Step 3: 实现单行解析、元字符拒绝、项目路径验证、高风险分类和一次性审批。**
- [x] **Step 4: 运行桌面测试，确认新命令策略通过。**

### Task 2: Runtime 审计端点

**Files:**
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `runtime/tests/test_runtime_service.py`
- Modify: `runtime/tests/test_api.py`

- [x] **Step 1: 写入失败测试。** 以受信任人工 Actor 请求 `terminal.command.approved` 审计，验证记录包含 Run、会话、风险等级和脱敏命令摘要；验证非可信 Actor 被拒绝。
- [x] **Step 2: 运行 focused pytest，确认端点尚不存在。**
- [x] **Step 3: 实现 Runtime 服务与 FastAPI 请求模型/端点，并复用终端脱敏函数。**
- [x] **Step 4: 运行 focused pytest，确认审计持久化与鉴权通过。**

### Task 3: IPC、确认界面与审计连接

**Files:**
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/preload/preload.cts`
- Modify: `apps/desktop/src/preload/global.d.ts`
- Modify: `apps/renderer/src/features/terminal/TerminalPage.tsx`
- Modify: `apps/renderer/src/features/terminal/TerminalPage.test.tsx`
- Modify: `apps/desktop/test/main.test.ts`

- [x] **Step 1: 写入失败 Renderer 测试。** 高风险 `del` 输入必须出现“确认危险命令”界面并且 PTY 不先写入；批准后调用 `approveCommand`，拒绝后调用 `rejectCommand`。
- [x] **Step 2: 运行 focused Vitest，确认 UI 尚未显示确认界面。**
- [x] **Step 3: 替换裸 `write` IPC 为请求/批准/拒绝 IPC；主进程将每个决策异步提交 Runtime 审计；Renderer 禁用 xterm stdin 并提供中文确认交互。**
- [x] **Step 4: 运行 Desktop 和 Renderer focused tests。**

### Task 4: 回归验证

**Files:**
- Test: `apps/desktop/test/main.test.ts`
- Test: `apps/renderer/src/features/terminal/TerminalPage.test.tsx`
- Test: `runtime/tests/test_runtime_service.py`
- Test: `runtime/tests/test_api.py`

- [x] **Step 1: 运行桌面、Runtime 和 Renderer 全量相关套件。**

  Run: `npm.cmd --workspace @workflow-platform/desktop run test`

  Run: `python -m pytest runtime/tests/test_runtime_service.py runtime/tests/test_api.py -q`

  Run: `npm.cmd --workspace @workflow-platform/renderer run test -- --run`

- [x] **Step 2: 记录通过结果和仍未覆盖的 OS 级隔离限制。**

已验证结果：Desktop 测试通过；Runtime `215 passed`；Renderer `62 passed`。当前实现以受限的单行命令策略和只读安全白名单强制项目路径边界，未列入白名单的命令必须确认；它不能替代 Windows 级沙箱或容器隔离，任意 Shell 元编程与脚本宿主被明确阻止。
