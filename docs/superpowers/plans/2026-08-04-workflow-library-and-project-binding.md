# Workflow Library And Project Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将工作流入口改为可复用工作流资产列表，并完成模板复制、画布编辑、版本管理和项目导入绑定闭环。

**Architecture:** 保留现有 `WorkflowVersion` 作为不可变版本记录，在其上增加软件级工作流资产查询和项目绑定关系。Renderer 使用列表路由和编辑路由，复用现有 `WorkflowViewer` 作为画布编辑器；项目导入只负责识别项目文件，绑定在独立步骤完成。

**Tech Stack:** Python/FastAPI/SQLite/Pydantic、Electron IPC、React/TypeScript、Vitest、pytest。

---

### Task 1: 工作流资产与项目绑定 Runtime API

**Files:**
- Modify: `runtime/src/workflow_platform/persistence/migrations.py`
- Modify: `runtime/src/workflow_platform/persistence/repositories.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `apps/renderer/src/app/runtimeClient.ts`
- Test: `runtime/tests/test_api.py`
- Test: `runtime/tests/test_runtime_service.py`

- [ ] **Step 1: Write failing tests**

覆盖以下契约：列出项目可用的工作流资产；复制内置模板产生新的非内置工作流；项目可以绑定指定版本；绑定后创建 Run 使用该版本；缺少工作流文件的项目导入返回 `workflowBindingStatus: "unbound"` 而不是 500。

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `py -m pytest runtime/tests/test_api.py -k "workflow_library or workflow_binding or unbound_import" --no-header -q`

Expected: FAIL because the list, copy and binding endpoints do not exist.

- [ ] **Step 3: Add persistence and service contracts**

新增 `project_workflow_bindings` 表，唯一约束 `project_id`，保存 `workflow_id`、`workflow_version_id`、绑定人和时间；增加工作流资产查询，返回当前版本、内置标识、绑定数量和更新时间。模板复制必须复制定义 JSON，生成新的工作流 ID 和第一版本；归档资产不可作为新绑定目标。

- [ ] **Step 4: Add API and client methods**

增加：

```text
GET  /workflows
POST /workflows
POST /workflows/{workflow_id}/copy
POST /workflows/{workflow_id}/archive
GET  /projects/{project_id}/workflow-binding
POST /projects/{project_id}/workflow-binding
```

`POST /runs` 创建前校验项目存在活动绑定，并且当调用方未传 `workflowVersionId` 时使用绑定版本；保留已有显式版本调用以兼容历史客户端，但拒绝不属于绑定工作流的版本。

- [ ] **Step 5: Run focused tests and confirm pass**

Run: `py -m pytest runtime/tests/test_api.py runtime/tests/test_runtime_service.py -k "workflow_library or workflow_binding or unbound_import" --no-header -q`

Expected: all new tests pass.

- [ ] **Step 6: Commit**

```bash
git add runtime/src/workflow_platform/persistence/migrations.py runtime/src/workflow_platform/persistence/repositories.py runtime/src/workflow_platform/runtime_service.py runtime/src/workflow_platform/api/app.py apps/renderer/src/app/runtimeClient.ts runtime/tests/test_api.py runtime/tests/test_runtime_service.py
git commit -m "feat: add workflow library and project bindings"
```

### Task 2: 工作流列表与编辑路由

**Files:**
- Create: `apps/renderer/src/features/workflow/WorkflowLibraryPage.tsx`
- Create: `apps/renderer/src/features/workflow/WorkflowLibraryPage.test.tsx`
- Modify: `apps/renderer/src/features/workflow/WorkflowViewer.tsx`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/routes.ts`
- Modify: `apps/renderer/src/app/navigation.tsx`
- Modify: `apps/renderer/src/app/styles.css`

- [ ] **Step 1: Write failing UI tests**

验证进入 `#/workflow` 显示列表；点击新建进入 `#/workflow/new`；点击编辑进入指定工作流画布；模板行显示“基于模板新建”而不是直接编辑；保存后返回列表并刷新版本摘要。

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx.cmd vitest run src/features/workflow/WorkflowLibraryPage.test.tsx --reporter=dot`

Expected: FAIL because the library component and route do not exist.

- [ ] **Step 3: Implement list page**

用现有 `runtimeClient` 查询工作流资产，提供搜索、类型筛选、空状态和行操作；模板复制调用 Task 1 的 copy API；归档前在行内确认，并禁止归档仍被绑定或有历史 Run 的资产。

- [ ] **Step 4: Split route ownership**

让 `WorkflowViewer` 只负责编辑态；列表态不再加载或渲染画布。通过 route state 传入 `new`、`edit:{workflowId}` 和 `versions:{workflowId}`，保存后回到列表。旧的当前工作流链接统一重定向到列表或当前编辑页。

- [ ] **Step 5: Move existing canvas controls**

保留现有节点库、角色库、配置、模拟、版本对比、恢复、导出能力，但把运行状态从画布移除，把编辑器顶栏压缩为返回、标题、草稿状态、版本管理和保存。所有抽屉可关闭，画布占用剩余高度且页面本身不滚动。

- [ ] **Step 6: Run UI tests and typecheck**

Run: `npx.cmd vitest run src/features/workflow/WorkflowLibraryPage.test.tsx src/features/workflow/WorkflowViewer.test.tsx --reporter=dot`；`npm.cmd --workspace apps/renderer exec tsc -- --noEmit`

Expected: new and existing workflow tests pass; TypeScript exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/renderer/src/features/workflow apps/renderer/src/app apps/renderer/src/app/styles.css
git commit -m "feat: add workflow library and editor routes"
```

### Task 3: 项目导入绑定向导

**Files:**
- Create: `apps/renderer/src/features/projects/WorkflowBindingStep.tsx`
- Create: `apps/renderer/src/features/projects/WorkflowBindingStep.test.tsx`
- Modify: `apps/renderer/src/features/projects/ProjectDashboard.tsx`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/features/runs/RunDashboard.tsx`

- [ ] **Step 1: Write failing tests**

验证无绑定项目显示“选择工作流”；选择已有工作流可以绑定；点击“创建业务工作流”跳转工作流新建页并保留项目回跳信息；绑定完成后 Run 页面允许创建；未绑定时创建按钮禁用并显示原因。

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx.cmd vitest run src/features/projects/WorkflowBindingStep.test.tsx --reporter=dot`

Expected: FAIL because the binding step is not present.

- [ ] **Step 3: Implement binding step**

列表显示内置模板和用户工作流的名称、说明、节点数与当前版本；模板使用复制后绑定，已有工作流直接绑定指定版本；“新建业务工作流”跳转 `#/workflow/new?returnProject=<id>`。

- [ ] **Step 4: Implement return flow**

工作流保存成功后读取回跳参数，返回项目绑定步骤并预选新资产；取消编辑不改变项目绑定状态。刷新工作流列表后保证新建资产立即可见。

- [ ] **Step 5: Gate Run creation**

Run Dashboard 接收项目绑定状态。未绑定时显示操作提示和“去选择工作流”入口，不发送创建 Run 请求；绑定后使用绑定的固定版本创建 Run。

- [ ] **Step 6: Run tests and commit**

Run: `npx.cmd vitest run src/features/projects/WorkflowBindingStep.test.tsx src/features/runs/RunDashboard.test.tsx --reporter=dot`

```bash
git add apps/renderer/src/features/projects apps/renderer/src/features/runs/RunDashboard.tsx apps/renderer/src/app/App.tsx
git commit -m "feat: guide projects through workflow binding"
```

### Task 4: 兼容、版本回归与交付验证

**Files:**
- Modify: `runtime/tests/test_api.py`
- Modify: `runtime/tests/test_runtime_service.py`
- Modify: `apps/renderer/src/app/App.test.tsx`
- Modify: `apps/renderer/src/features/workflow/WorkflowViewer.test.tsx`
- Modify: `apps/renderer/src/features/projects/ProjectDashboard.test.tsx`

- [ ] **Step 1: Add compatibility coverage**

覆盖旧项目已有工作流、无工作流文件项目、模板复制后修改、绑定升级不影响历史 Run、已归档工作流不可绑定，以及当前 Run 下拉仍包含历史版本 Run。

- [ ] **Step 2: Run complete validation**

Run: `py -m pytest runtime/tests/test_api.py runtime/tests/test_runtime_service.py --no-header -q`; `npx.cmd vitest run --reporter=dot`; `npm.cmd --workspace apps/renderer exec tsc -- --noEmit`; `npm.cmd --workspace apps/desktop test`; `git diff --check`.

Expected: all tests pass; TypeScript exits 0; `git diff --check` has no whitespace errors.

- [ ] **Step 3: Review operational behavior**

手动验证：导入无工作流项目、从模板复制、创建业务工作流、回跳绑定、创建 Run、打开编辑器、保存新版本、恢复历史版本、切换项目和关闭所有抽屉；确认页面级纵向滚动条不会覆盖画布。

- [ ] **Step 4: Commit**

```bash
git add runtime/tests apps/renderer/src/app/App.test.tsx apps/renderer/src/features/workflow apps/renderer/src/features/projects
git commit -m "test: cover workflow library and binding flow"
```
