# 完整 Windows EXE 打包设计

## 目标

生成一个 Windows 桌面应用安装包/EXE，包含 Electron UI、构建后的 Renderer 静态资源，以及内置 Python Runtime 可执行文件。用户安装后不需要单独启动 Vite 或安装 Python 才能打开工作台。

## 方案

- Renderer 使用 Vite 构建到 `apps/renderer/dist`。
- Python Runtime 使用 PyInstaller 打包为 `workflow-runtime.exe`。
- Electron 生产环境从 `file://.../apps/renderer/dist/index.html` 加载 UI。
- Electron 打包环境从 `process.resourcesPath/runtime/workflow-runtime.exe` 启动内置 Runtime。
- 开发环境保留现有 `RENDERER_URL` 和 `WORKFLOW_PLATFORM_RUNTIME_URL` 外部覆盖能力。

## 边界

- 当前不做代码签名、自动更新和安装器品牌素材。
- Codex/Claude CLI 登录态仍依赖用户机器已有 CLI 和凭据。
- PyInstaller 和 electron-builder 需要本机能够安装依赖。
