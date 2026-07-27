# AI Workflow Platform

本项目是一个本地桌面 AI 工程工作流平台 MVP，用于验证项目导入、工作流规范化、运行状态推进、治理边界和桌面工作台的基础闭环。

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

## 验证说明

`npm.cmd run verify` 默认运行 TypeScript 单元/类型测试和 Python runtime 测试，不启动浏览器 E2E。浏览器端到端验证需要单独运行：

```powershell
npm.cmd run test:e2e
```

## MVP 范围

当前仓库覆盖的是 MVP 基础实现和验证路径，主要包括：

- Project import
- Adapter detection
- Harness Adapter
- Canonical Workflow storage
- Event-sourced Run state
- Kernel transition
- Approval-Gate-Artifact governance
- Terminal boundary
- AgentExecutor boundary
- Renderer workbench
- Recovery projection rebuild
- TypeScript contracts 与 Python Pydantic models 对齐
- FastAPI runtime health endpoint
- Electron main/preload 基础边界
- Playwright renderer smoke E2E

## 当前定位

这是面向本地桌面工作流平台的 MVP 验证实现，不代表已经完成最终产品规格中的全部高级能力。真实 `node-pty` 终端、真实 LangGraph provider、完整 Runtime API、完整 Electron runtime process management、高级 Knowledge publishing 等能力仍属于后续建设范围。
