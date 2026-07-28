# Renderer 独立页面路由设计

## 目标

将桌面端 Renderer 从单页长工作台改为独立模块页面。侧栏菜单点击后只显示对应模块，并支持浏览器历史前进、后退和刷新。

## 路由方案

采用 hash 路由，保证 Electron 打包后的 `file://` 页面能够可靠加载：

| 菜单 | 路由 | 内容 |
| --- | --- | --- |
| Projects | `#/projects` | 项目看板和导入项目操作 |
| Runs | `#/runs` | Run 状态和 Runtime 操作 |
| Workflow | `#/workflow` | 工作流查看器 |
| Terminal | `#/terminal` | 终端会话和输出 |
| Gates | `#/gates` | 质量门禁 |
| Artifacts | `#/artifacts` | 产物与证据 |
| Approvals | `#/approvals` | 审批收件箱 |
| Recovery | `#/recovery` | 恢复信息 |
| Settings | `#/settings` | 配置页 |

空 hash 和未知 hash 均重定向到 `#/projects`。

## 组件边界

`App` 负责加载共享 Runtime state、解析当前 hash 以及选择页面。`Navigation` 接收当前路由并输出真实 hash 链接与当前态。各功能模块继续保持独立，仅在对应路由中挂载。

需要 Runtime 操作的输入和按钮放在 Runs 页面，避免所有页面重复显示同一套首页操作区。

## 状态与错误处理

`hashchange` 驱动当前视图更新；浏览器历史前进和后退由原生 hash 历史处理。未知路由立即替换为 Projects，避免空白内容区。

## 验证

新增 Renderer 测试，覆盖：

- 默认路由显示 Projects；
- 点击菜单后更新 hash 并显示目标模块；
- `hashchange` 后只渲染对应模块；
- 未知 hash 回退到 Projects。
