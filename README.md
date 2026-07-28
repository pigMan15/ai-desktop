# AI Workflow Platform

本项目是一个本地桌面 AI 工程工作流平台 MVP，用于验证项目导入、工作流规范化、运行状态推进、治理边界、Runtime API 和桌面工作台的最小闭环。

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
- Harness / Markdown Checklist / Generic YAML Adapter import
- Canonical Workflow storage
- Event-sourced Run state
- Transactional run event append 与 projection upsert
- Runtime-backed Harness import -> create run -> transition path
- Runtime-backed Project / Workflow / Run API
- Kernel transition
- Artifact / Approval / Gate 持久化记录与 kernel/service 层基础约束
- Terminal boundary
- AgentExecutor boundary
- P2 CLI Agent Runtime：Codex / Claude Code provider 命令构造、受控子进程执行、fake CLI 集成测试、agent job/output 持久化和 Run-bound API
- Runtime Timeline 和 Projection rebuild
- Renderer Runtime-backed workbench（配置 Runtime endpoint 和项目路径后从 API 拉取 P1 状态；未配置时显示不可用 fallback）
- TypeScript contracts 与 Python Pydantic models 对齐
- FastAPI runtime health/import/run/transition/artifact endpoints
- Electron main/preload 基础边界与 renderer URL 安全校验
- Playwright renderer smoke E2E
- P1 Playwright Runtime-backed product loop path

## 当前定位

这是面向本地桌面工作流平台的 MVP/P2 验证实现，不代表已经完成最终产品规格中的全部高级能力。真实 `node-pty` 终端、真实 LangGraph provider、完整交互式 UI、完整 Electron runtime process management、高级 Knowledge publishing 等能力仍属于后续建设范围。
