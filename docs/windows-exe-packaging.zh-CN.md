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
- `release-full/AI Workflow Platform Setup <版本号>.exe`
- `release-full/AI Workflow Platform 0.1.0-win-unpacked.zip`

打包脚本会检查主程序、内置 Runtime 和 NSIS 安装器是否都已生成；任一项缺失会直接失败，不会把不完整产物当作发布包。

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
- 首次生成 NSIS 安装器时，`electron-builder` 可能需要下载 NSIS 资源；网络受限时请配置可访问的镜像或在可联网构建机上执行打包。
