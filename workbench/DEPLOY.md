# 工作台部署与迁移指南

## 1. 持久性（重启后功能还在吗）

**功能与数据都是持久的**：

| 内容 | 存储位置 | 重启后 |
|---|---|---|
| 治理插件（13 个工具） | `.workbench-poc/dsh-home/profiles/*/node_modules/@workflow-platform/workbench-governance` | ✅ 每次 dsh 启动自动加载 |
| 浏览器 UI（工具卡片/收件箱/react-flow 编辑器） | 同 profile 下 `@workflow-platform/workbench-ui` | ✅ 同上 |
| 运行数据（runs/模板/审批/审计/证据哈希） | `<WORKBENCH_STORE>/workbench.db`（SQLite） | ✅ 保留 |
| 项目产物文件 | `<WORKBENCH_PROJECT>/artifacts`、`.workbench-templates`、`.workbench-evidence` | ✅ 保留 |
| 浏览器内未保存的编辑器草稿 | 内存 | ❌ 丢失（保存过的模板已入库） |

唯一"消失"场景：删除 `.workbench-poc/dsh-home`（或整个 `.workbench-poc/`）→ 重新运行安装即可。

> 依赖说明：插件 import 的 `@deepseek-ai/*`（dsh-tools、cordis 等）通过
> `$DSH_HOME/profiles/node_modules` 自动重建的 fallback 解析——升级 dsh 后该目录自动修复，
> 插件无需重装（除非 API 有 breaking change）。

## 2. 新机器/新安装 deepseek-harness 后安装工作台

前置：

- Node.js 22+（含 `node:sqlite`）
- dsh CLI：`npm install -g @deepseek-ai/dsh`（或 npx 调用）
- 已登录/已配置模型的 deepseek-harness（`~/.dsh/settings.yaml` + `.credentials.yaml`，或等效 provider 配置）

### 方式 A：源码安装（推荐）

```powershell
# 1) 把整个 workbench/ 目录拷到新机器
# 2) 安装依赖（typescript / esbuild / react / @xyflow/react / @deepseek-ai/dsh-tools 等全部自包含）
cd workbench
npm install

# 3) 一键安装（构建 governance + client bundle + 装入本地 DSH_HOME + 打印启动命令）
powershell -ExecutionPolicy Bypass -File scripts/install.ps1

# 4) 按打印的命令启动 web 工作台（-DshBin / -RealDshHome 可覆盖探测）
```

### 方式 B：发布为 DSH 插件（npm / tarball）→ 见 §4

### 方式 C：只用 headless（跳过 web bundle）

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -SkipWeb
```

## 3. 升级/更新已有安装

```powershell
# 源码更新后重跑（幂等）
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
# 只重跑引擎部分（跳过 web bundle）：-SkipWeb
# 只重启服务不重装：直接启动 dsh 即可（插件已在 profile 里）
```

## 4. 发布为 DSH 插件（官方推荐方式）

两个包**本身就是 DSH 插件**（bundle 形式：`dsh.bundle.patch` + 自带 `cordis.patch.yml`，
列入 `dsh.profile.bundles` 即自动装载，无需手改 profile patch）。

### 这是官方推荐的方式吗 —— 是

源码实锤（`@deepseek-ai/dsh` v0.1.0-rc.6 `lib/plugin-*.js`）：

- **bundle 形态**（`dsh.bundle.patch` + 包内 patch）就是官方所有 bundle 的结构
  （`dsh-base`、`dsh-headless`、`dsh-web-app` 同款）。
- **`dsh plugin --profile <name> add <pkg>` 是官方安装命令**：初始化 profile →
  转发 pnpm 安装 → **自动 reconcile**：依赖里声明了 `dsh.bundle` 的包
  **自动追加进 `dsh.profile.bundles`**（无需手写 bundles，`update` 也会自动激活
  新版本里新获得 `dsh.bundle` 声明的包）。
- 官方 pnpm 配置（profile 的 `pnpm-workspace.yaml` 模板）：`nodeLinker: hoisted` +
  **`autoInstallPeers: false`** —— 官方本来就禁止自动装 peers（把 peer 链到共享
  安装）。npm 装 tarball 时用 `--legacy-peer-deps` 等价于此。

### 发布到 npm

```powershell
cd packages/workbench-governance
npm run build
npm publish --access public   # 需要 npm 账号拥有 @workflow-platform 或改用你的 scope

cd ../workbench-ui
npm run build:client
npm publish --access public
```

### 安装到某个 profile（官方命令，已验证）

```powershell
# 1) 安装插件包（官方命令自动把包写进 dsh.profile.bundles，无需手改）
dsh plugin --profile workbench-poc-web add @workflow-platform/workbench-governance @workflow-platform/workbench-ui

# 2) 启动
dsh --profile workbench-poc-web --port 3090   # web（含 UI 与审批弹卡）
```

> **⚠️ 官方 bundle 不要 `dsh plugin add`**：`dsh-headless` 等在 npm registry 上的
> 版本是旧的（0.0.1-rc.1，依赖未发布的 `dsh-code-runtime-worker`，装必 404）。
> bundle 解析规则是"**先 dsh 安装、再 profile node_modules**"，所以官方 bundle
> 只需出现在 `dsh.profile.bundles` 里（resolve 自 dsh 全局安装）。新 profile 的
> 默认 bundles 只有 `@deepseek-ai/dsh-base`；headless 场景需把
> `@deepseek-ai/dsh-headless` 加进 bundles（官方 `PROFILE_TEMPLATES.headless` 就是
> `[dsh-base, dsh-headless]`；web 场景加 `@deepseek-ai/dsh-web-app`）。
>
> 本仓库 `scripts/install-plugin.ps1` 已经做完这一切（自动写 bundles，并用 npm
> `--legacy-peer-deps` 等价官方 `autoInstallPeers: false`）。

### 本地 tarball 安装（不发布 npm 时，一键）

### 本地 tarball 安装（不发布 npm 时，一键）

```powershell
# 1) 先构建并打包（产出 release-plugin/*.tgz）
npm install           # 首次装依赖
npm run pack:plugins

# 2) 一键装进指定 profile（默认 web）并自动加入 dsh.profile.bundles
powershell -ExecutionPolicy Bypass -File scripts/install-plugin.ps1 -Profile web -Port 3090

# 3) 启动
dsh --profile web --port 3090
```

手工等价操作（install-plugin.ps1 做的事）：

```powershell
# 在 profile 目录里安装两个 tarball（--legacy-peer-deps 避免 peer 双实例）
cd $env:USERPROFILE\.dsh\profiles\web
npm install <...>/workflow-platform-workbench-governance-0.1.0.tgz --no-save --legacy-peer-deps
npm install <...>/workflow-platform-workbench-ui-0.1.0.tgz --no-save --legacy-peer-deps
# 把两包加入 profile package.json 的 dsh.profile.bundles
#    "dsh": { "profile": { "bundles": [ ..., "@workflow-platform/workbench-governance", "@workflow-platform/workbench-ui" ] } }
```

> **peer 依赖要点**：插件声明 `@deepseek-ai/dsh-tools` 等为 peer。标准 `dsh plugin add`
> 走 pnpm，会把 peer 链到共享安装（与 host 同一实例）。tarball 用 npm 安装必须
> `--legacy-peer-deps`（避免 profile 内产生第二份 dsh-tools 实例导致工具校验炸）。

## 5. 注意

- **凭据**：install.ps1 会把 `~/.dsh/.credentials.yaml` 复制进本地 DSH_HOME（含 API key，
  已 gitignore `.workbench-poc/`）。生产环境建议用环境变量/secret 注入替代。
- **esbuild**：client bundle 构建需要能 spawn 原生二进制的环境（沙箱/CI 里可能被拦，需放行）。
- **端口**：默认 3090，避免与既有 dsh web（3080）冲突。
- **CI**：`.github/workflows/workbench.yml` 已含 engine-test（自动）与 llm-scenarios（手动，
  需 `DEEPSEEK_API_KEY` secret）。
