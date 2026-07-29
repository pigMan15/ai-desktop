# 项目归档与工作流导出实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 补齐规格 10.1 的项目归档，以及 10.2 的工作流导出和 Generic YAML 协议转换，同时保持 Runtime 事件源和项目目录不被导出操作改写。

**架构：** 项目归档在 SQLite 中以 `archived_at` 逻辑标记实现，保留历史 Run、Artifact 与审计记录；新建 Run 会拒绝归档项目，重新导入同一路径会恢复为活动状态。工作流导出从已持久化的 canonical definition 生成 Canonical JSON 或 Generic YAML 文本，Renderer 仅触发浏览器下载。

**技术栈：** Python/FastAPI/SQLite/Pydantic，React/TypeScript/Vitest，pytest。

---

### 任务 1：项目归档 Runtime

**文件：**
- 修改：`runtime/src/workflow_platform/persistence/migrations.py`
- 修改：`runtime/src/workflow_platform/persistence/repositories.py`
- 修改：`runtime/src/workflow_platform/runtime_service.py`
- 修改：`runtime/src/workflow_platform/api/app.py`
- 测试：`runtime/tests/test_api.py`

- [ ] **步骤 1：编写失败的 API 测试**

新增测试：导入项目后归档项目；项目仍可查询既有 workflow，但创建新 Run 返回中文 `PROJECT_ARCHIVED` 错误；重新导入相同路径后可创建 Run。

- [ ] **步骤 2：运行测试确认失败**

运行：`python -m pytest runtime/tests/test_api.py -k project_archive -q`

预期：失败，因为归档端点和状态尚不存在。

- [ ] **步骤 3：实现最小归档能力**

为 `projects` 增加可空 `archived_at`，仓储提供 `archive`、`is_archived`；`import_project` 清除归档标记；`create_run` 在持久化前拒绝归档项目；归档端点要求可信人工 Actor 并写入审计。

- [ ] **步骤 4：运行测试确认通过**

运行：`python -m pytest runtime/tests/test_api.py -k project_archive -q`

预期：通过。

### 任务 2：工作流导出与 Generic YAML 转换

**文件：**
- 修改：`runtime/src/workflow_platform/runtime_service.py`
- 修改：`runtime/src/workflow_platform/api/app.py`
- 修改：`apps/renderer/src/app/runtimeClient.ts`
- 修改：`apps/renderer/src/features/workflow/WorkflowViewer.tsx`
- 测试：`runtime/tests/test_api.py`
- 测试：`apps/renderer/src/app/runtimeClient.test.ts`
- 测试：`apps/renderer/src/features/workflow/WorkflowViewer.test.tsx`

- [ ] **步骤 1：编写失败的 Runtime 和 Renderer 测试**

断言导出 `canonical-json` 返回稳定、可解析的 canonical workflow；导出 `generic-yaml` 返回可被 `GenericYamlAdapter` 再次导入的 YAML；Renderer 请求对应端点并显示两种导出命令。

- [ ] **步骤 2：运行测试确认失败**

运行：
`python -m pytest runtime/tests/test_api.py -k workflow_export -q`

`npm.cmd --workspace @workflow-platform/renderer run test -- --run src/app/runtimeClient.test.ts src/features/workflow/WorkflowViewer.test.tsx`

预期：失败，因为客户端和导出端点尚不存在。

- [ ] **步骤 3：实现最小导出能力**

Runtime 以 `format=canonical-json|generic-yaml` 参数返回 `{ fileName, mediaType, content }`，未知格式返回中文错误。Renderer 使用既有下载帮助函数下载当前 workflow；`WorkflowViewer` 用原生选择控件选择格式。

- [ ] **步骤 4：运行测试确认通过**

运行上一步的 pytest 与 Vitest 命令。

预期：全部通过。

### 任务 3：回归与中文验收文档

**文件：**
- 修改：`docs/acceptance-matrix-10.3-10.12.zh-CN.md`
- 修改：`docs/remaining-work-and-acceptance.zh-CN.md`

- [ ] **步骤 1：补充规格 10.1 与 10.2 的验收证据**

在中文矩阵中列出项目逻辑归档、重新导入恢复，以及 Canonical JSON/Generic YAML 导出与再导入证据。

- [ ] **步骤 2：执行完整回归**

运行：`npm.cmd run verify`

运行：`npm.cmd run test:e2e`

预期：测试通过；安装版套件可由独立的 `test:e2e:installed` 继续补齐。
