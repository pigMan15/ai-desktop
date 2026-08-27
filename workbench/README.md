# DSH Workbench

在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 之上构建的**受治理 AI 工程工作流工作台**：
DSH 插件（host + browser）实现事件溯源 Run、审批/产物/证据治理、运行时模板库与 react-flow 可视化编排编辑器。

## ✅ 最终验收（2026-08-14，Web UI 实测）

在 DSH Web 界面完成两条 `poc` 运行全流程推进，`node.approved` 的 actor=**`ui-human`**（GUI 弹卡批准）与 headless 的 `trusted-human`（决策文件）**双审批路径全部验证**；证据包导出（13 事件/3 产物/13 项哈希链）落盘。核心论断成立：**DSH 插件在审批点真正暂停 Agent、等人工批准后放行，Agent 无法绕过，全程可审计**。

## 结构

```
workbench/
├── packages/
│   ├── workbench-governance/     # host 插件（TS）：13 个 workflow_* 工具、SQLite 事件溯源、HTTP 端点
│   └── workbench-ui/             # browser 插件（TSX + esbuild + react-flow）
├── profile/ + profile-web/       # headless / web profile 模板
├── scripts/                      # bootstrap / install / demo / verify / dump / check
├── .github/workflows/workbench.yml  # CI（engine-test 自动 + llm-scenarios 手动）
└── DEPLOY.md                     # 部署与迁移指南（三种安装方式）
```

## 三种安装方式

### A. 源码安装（新机器，推荐）

```powershell
# 1) 前置：Node 22+、dsh CLI（npm i -g @deepseek-ai/dsh）、已配置模型的 ~/.dsh
# 2) 安装依赖（typescript/esbuild/react/@xyflow/react/@deepseek-ai/dsh-tools 等）
npm install

# 3) 构建 + 安装进本地 DSH_HOME + 打印启动命令
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

### B. 发布为 DSH 插件（npm / tarball）

```powershell
# 打包（产出 release-plugin/*.tgz）
npm run pack:plugins
# 发布后（或用 tarball）：
#   dsh plugin --profile <web-profile> add @workflow-platform/workbench-governance @workflow-platform/workbench-ui
# 官方命令会自动把声明了 dsh.bundle 的包写进 dsh.profile.bundles（自动装载），无需手改
```

### C. 一键脚本（= A，本机/演示）

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

## 使用

```powershell
# web 工作台（审批弹卡 + react-flow 编辑器 + 实时收件箱/工作流面板）
$env:DSH_HOME = "$PWD\.workbench-poc\dsh-home"
$env:WORKBENCH_STORE = "$PWD\.workbench-poc\store-web"
$env:WORKBENCH_PROJECT = "$PWD\.workbench-poc\project-web"
$env:WORKBENCH_UI_APPROVAL = "1"
$env:WORKBENCH_DEFAULT_WORKFLOW = "poc"   # 可选：对话绑定默认工作流（workflow_start 省略 workflow 参数时使用）
dsh --profile workbench-poc-web --port 3090

# headless 自动化验证
powershell -ExecutionPolicy Bypass -File scripts/demo.ps1 -Scenario pause   # approve/reject/missing/template/template-io/template-file/evidence/inbox
powershell -ExecutionPolicy Bypass -File scripts/verify.ps1 -SkipLlm        # 引擎测试
```

## 能力清单

- **事件溯源 Run**：SQLite（`node:sqlite`）事件流 + 投影，可重放恢复（字节级一致）。
- **治理**：产物闸门（SHA-256 + 版本 + 项目边界）→ 审批闸门（UI 弹卡 / 决策文件）→ 证据锚定 + 漂移检测 → 防篡改证据包 → 审批收件箱。
- **模板**：运行时模板库（保存/导入/项目同步均人工门控），项目文件化（`.workbench-templates/*.json`）；`workflow_start` 支持 `WORKBENCH_DEFAULT_WORKFLOW` 对话级默认绑定；工具描述与报错中的可用模板名实时动态生成。**预录 3 套 AI 时代 IT 软件工程工作流**（spec-first，基于 SDLC Reimagined 研究）：`sdlc`（spec→design→implement→review→test，spec/design/review/test 人工审批）、`hotfix`（diagnose→verify→deploy，仅 deploy 审批）、`spike`（research→recommend，recommend 审批），外加传统 `poc`。
- **角色库**：工作流角色 = 节点契约模板（`description` 职责 / `inputs` 上游产物 / `outputs` 输出产物，产物可带**内容模板**）。节点可绑定角色（固定版本 + 版本历史归档），保存时校验产物须为角色输出；推进时上游硬校验（非首节点的 required inputs 必须由已完成前序节点产出，否则 `AWAITING_UPSTREAM`）；`node.completed` 快照角色契约进证据链（防事后改角色洗白）；角色变更与模板同级 trusted-human 门控 + 独立审计链；项目文件化 `.workbench-roles/*.json`。**预录 10 角色**：planner/verifier/shipper + spec-writer/architect/implementer/reviewer/tester/debugger/researcher。
- **会话隔离**：`workflow_start` 不传 `projectDir` 时自动按调用会话派生 `<WORKBENCH_PROJECT>/sessions/<sessionId>`——每个对话独立工件边界互不污染；治理数据（事件/审批/审计/证据）仍全局共享，工作台全量可管理。
- **工具（18 个）**：start / advance / audit / check / run_list / evidence_export / approval_inbox / editor / template_save / list / export / import / sync_project / role_save / role_list / role_export / role_import / role_sync_project。
- **UI**：工具卡片、收件箱卡片、引擎驱动 Run 节点图、react-flow 可视化编辑器（侧边栏"⚙ 工作台"）、实时面板（5s 轮询）、**"工作流"标签页**（`GET /workbench/templates` 全量列表 + 点击编辑 + 一键新建 + **导入/导出 JSON**）、**"角色库"标签页**（`GET /workbench/roles` 契约列表 + 表单编辑 + 一键新建 + **导入/导出 JSON** + 编辑器节点角色绑定下拉 + 同步契约）。
- **工程**：TS monorepo、50+ 项引擎直测、本地 CI（verify.ps1）、GitHub Actions CI。

## 验证状态

- headless LLM 场景（9 个）+ Web UI 人工验收（`ui-human` 审批弹卡）全部通过。
- 引擎直测、打包脚本、CI 配置就绪；详情见 DEPLOY.md 与各脚本。
