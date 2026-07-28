# Windows 完整 EXE 打包说明

## 目标

完整打包会生成一个 Windows 桌面安装包，包含：

- Electron 主程序
- Renderer 静态 UI
- PyInstaller 打包后的 Python Runtime：`workflow-runtime.exe`

## 前置依赖

```powershell
npm.cmd install
python -m pip install pyinstaller
```

## 离线完整打包命令

```powershell
npm.cmd run package:win:full
```

输出目录：

```text
release-full/
```

如果旧目录被 Windows 或杀毒软件短暂锁住，脚本会自动改用 `release-full-YYYYMMDD-HHMMSS/`。

产物包括：

- `release-full/win-unpacked/AI Workflow Platform.exe`
- `release-full/AI Workflow Platform 0.1.0-win-unpacked.zip`

这个命令不依赖 NSIS 下载，适合当前 GitHub 连接不稳定的环境。

## NSIS 安装器

如果网络可以访问 GitHub 的 `electron-builder-binaries`，可以尝试生成安装器：

```powershell
npm.cmd run package:win:installer
```

安装器会额外下载 NSIS 资源。当前环境如果出现 `nsis-3.0.4.1.7z` 下载失败，请使用上面的离线完整打包命令。

## 运行方式

启动 `win-unpacked/AI Workflow Platform.exe` 后，Electron 会：

1. 从应用资源目录启动内置 `runtime/workflow-runtime.exe`
2. 等待 Runtime `/health` 通过
3. 加载内置 Renderer 静态页面

开发模式仍可使用：

```powershell
npm.cmd run dev:renderer
npm.cmd run dev:desktop
```

## 注意

- 当前未做代码签名，Windows 可能显示未知发布者。
- Codex/Claude Code CLI 仍依赖用户机器已有 CLI、登录态和权限。
- 如果 `npm.cmd run package:win:full` 提示缺少 PyInstaller，请先执行 `python -m pip install pyinstaller`。
