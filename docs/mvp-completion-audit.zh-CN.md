# MVP 完成审计

## 审计结论

本仓库完成的是本地桌面 AI 工程工作流平台的 MVP 基础实现与验证路径。它已经覆盖从协议识别、Harness 导入、canonical workflow 存储、事务化 run event append、event-sourced run projection、kernel transition、治理边界、Runtime API、执行边界、renderer workbench 到恢复投影重建的最小闭环。

本审计不声明最终完整产品已经完成。高级运行时、真实外部 provider、完整桌面进程管理、完整交互式 UI 和知识发布等能力仍为后续工作。

## 证据命令和结果摘要

以下命令作为 Task 14 最终验证命令：

```powershell
npm.cmd run verify
npm.cmd run test:e2e
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1
git status --short
```

结果摘要：

- `npm.cmd run verify`：通过。contracts 5 个测试通过，renderer 4 个测试通过，desktop 测试/类型检查通过，runtime pytest 102 个测试通过；pytest 输出 1 个 `StarletteDeprecationWarning`，不影响通过结果。默认 verify 不运行浏览器 E2E。
- `npm.cmd run test:e2e`：通过。Playwright Chromium 1 个 smoke 测试通过，验证 MVP workbench 中 `Projects`、`Run Dashboard`、`Recovery` 可见。
- `powershell -ExecutionPolicy Bypass -File scripts/verify.ps1`：通过。执行与默认 verify 等价的 PowerShell 验证路径，runtime pytest 102 个测试通过，并保留同一个 `StarletteDeprecationWarning`。
- `git status --short`：提交后应为空。

## 验收映射

| MVP Done Definition | 测试证据 | 文件证据 |
| --- | --- | --- |
| Project import | `runtime/tests/test_adapters.py` 覆盖 Harness workflow 导入、缺失文件、空文件、非法 YAML、非法 metadata 等路径。 | `runtime/src/workflow_platform/adapters/harness.py` |
| Adapter detection | `runtime/tests/test_adapters.py` 覆盖 Harness 检测和 registry 按 score 过滤排序。 | `runtime/src/workflow_platform/adapters/base.py`, `runtime/src/workflow_platform/adapters/registry.py` |
| Harness Adapter | `runtime/tests/test_adapters.py` 验证 `.harness/workflow.yaml` 映射到 `WorkflowDefinition`，包括 nodes、edges、roles、gates、policies 和 source metadata。 | `runtime/src/workflow_platform/adapters/harness.py` |
| Canonical Workflow storage | `runtime/tests/test_persistence.py` 验证 migration 表结构、外键、唯一索引，以及 `WorkflowVersionRepository` 对 workflow JSON alias 的 round trip。 | `runtime/src/workflow_platform/persistence/migrations.py`, `runtime/src/workflow_platform/persistence/repositories.py` |
| Runtime-backed vertical path | `runtime/tests/test_runtime_service.py` 覆盖 Harness project import、workflow version 持久化、run 创建、事务化 event append、artifact submit、human approval、gate pass 和 projection 回读。 | `runtime/src/workflow_platform/runtime_service.py`, `runtime/src/workflow_platform/persistence/repositories.py` |
| Canonical models/contracts | `packages/contracts/src/contracts.test.ts` 和 `runtime/tests/test_models.py` 覆盖 TypeScript constants、Python Pydantic models、非法 node kind 校验。 | `packages/contracts/src/*.ts`, `runtime/src/workflow_platform/models.py` |
| Workflow compiler | `runtime/tests/test_compiler.py` 覆盖 graph spec 输出、缺失 edge source/target diagnostics、重复 node id diagnostics。 | `runtime/src/workflow_platform/compiler/compiler.py` |
| Event-sourced Run state | `runtime/tests/test_kernel.py` 覆盖 projection 从 events 重建、revision 和 target run 过滤。 | `runtime/src/workflow_platform/kernel/projection.py` |
| Kernel transition | `runtime/tests/test_kernel.py` 覆盖 node start、artifact submit、approval、gate、revision conflict、非法 transition、artifact payload guard、gate evidence guard、自动完成等路径。 | `runtime/src/workflow_platform/kernel/transition.py` |
| Approval-Gate-Artifact kernel/service 层基础约束 | `runtime/tests/test_governance.py` 覆盖 artifact path sandbox、artifact hash、gate actor/evidence 约束；kernel 测试覆盖 human approval 权限，Runtime service/API 测试覆盖 artifact endpoint guard。 | `runtime/src/workflow_platform/artifacts/service.py`, `runtime/src/workflow_platform/approvals/service.py`, `runtime/src/workflow_platform/gates/service.py`, `runtime/src/workflow_platform/runtime_service.py` |
| Terminal boundary | `runtime/tests/test_execution_boundaries.py` 验证 terminal session 绑定 project/run/node/cwd，并保持创建态。 | `runtime/src/workflow_platform/terminals/service.py` |
| AgentExecutor boundary | `runtime/tests/test_execution_boundaries.py` 验证默认 executor 返回规范化 interrupted/checkpoint 结果。 | `runtime/src/workflow_platform/execution/agent.py` |
| Runtime API | `runtime/tests/test_api.py` 验证 FastAPI `/health`、`/projects/import`、`/runs`、`/runs/{run_id}/transition` 和 `/runs/{run_id}/artifacts` endpoint。 | `runtime/src/workflow_platform/api/app.py`, `runtime/src/workflow_platform/main.py` |
| Electron desktop boundary | `apps/desktop/test/main.test.ts`、`apps/desktop/test/runtime-health.test-d.ts` 覆盖 desktop main/preload/runtime 的基础边界、显式 webPreferences 安全配置和 renderer URL 白名单。 | `apps/desktop/src/main/*.ts`, `apps/desktop/src/preload/*.ts` |
| Renderer workbench | `apps/renderer/src/app/App.test.tsx` 验证 MVP 导航和页面入口。 | `apps/renderer/src/app/App.tsx`, `apps/renderer/src/features/*/*.tsx` |
| Browser E2E smoke | `tests/e2e/workflow-mvp.spec.ts` 验证浏览器中可见 `Projects`、`Run Dashboard`、`Recovery`。 | `playwright.config.ts`, `tests/e2e/workflow-mvp.spec.ts` |
| Recovery projection rebuild | `runtime/tests/test_kernel.py` 覆盖 projection rebuild；renderer Recovery 页面提供 MVP 入口。 | `runtime/src/workflow_platform/kernel/projection.py`, `apps/renderer/src/features/recovery/RecoveryPage.tsx` |
| Unified verification path | `npm.cmd run verify` 和 `scripts/verify.ps1` 覆盖默认非浏览器验证路径；E2E 通过 `npm.cmd run test:e2e` 单独运行。 | `package.json`, `scripts/verify.ps1` |

## 剩余限制

当前实现仍有明确边界：

- 终端是 `Terminal boundary` MVP，没有接入真实 `node-pty`、进程 IO 流、退出码采集和长生命周期管理。
- `AgentExecutor` 是 provider boundary/stub，没有接入真实 LangGraph provider、模型调用、checkpoint persistence 或 resume orchestration。
- Runtime API 已覆盖导入、创建 run、transition 和 artifact submit 的最小纵向路径，但不是完整产品 API。
- `run_events` 与 `run_projections` 的 schema、projection、workflow version repository、run repository 和事务化 append event 已验证；更复杂的跨进程并发恢复服务仍需后续实现。
- Electron main/preload 已建立基础边界，但完整 runtime process management、端口发现、崩溃重启、日志采集和打包发布仍未完成。
- Renderer workbench 是 MVP 信息架构和 Runtime-backed 路径说明，不是完整交互式产品 UI。
- Approval/Gate/Artifact 已有基础治理约束，但完整审计日志、策略引擎、签名、证据链和角色权限模型仍需后续补齐。
- Knowledge publishing、跨项目知识库、搜索索引、引用追踪和高级发布流不在当前 MVP 完成范围。
- 浏览器 E2E 不包含在默认 `verify` 中，需要通过 `npm.cmd run test:e2e` 单独执行。

## 自审说明

- 文档只描述 Task 14 审计和 README，不新增产品功能。
- README 与审计文档均使用中文说明，必要命令、文件路径和代码标识保留英文。
- 审计表中的每个验收项都指向测试文件和实现文件，避免无证据声明。
