# Full Windows EXE Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full Windows packaging path that bundles Electron, Renderer static files, and a PyInstaller-built Runtime executable.

**Architecture:** Electron chooses renderer/runtime paths by environment: dev uses localhost/external overrides, packaged uses static renderer HTML and a bundled Runtime executable under resources. Python Runtime gets a tiny PyInstaller entry module.

**Tech Stack:** Electron, Vite, electron-builder, PyInstaller, FastAPI/Uvicorn, TypeScript tests, pytest.

---

### Task 1: Electron packaged path selection

**Files:**
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/main/runtime.ts`
- Test: `apps/desktop/test/main.test.ts`

- [ ] Add failing tests for packaged renderer file URL and bundled Runtime executable command.
- [ ] Implement `resolveRendererUrl` and `runtimeExecutablePath`.
- [ ] Run `npm.cmd --workspace @workflow-platform/desktop run test`.

### Task 2: Runtime PyInstaller entry

**Files:**
- Create: `runtime/src/workflow_platform/packaged_runtime.py`
- Test: `runtime/tests/test_packaged_runtime.py`

- [ ] Add failing test for host/port environment parsing.
- [ ] Implement `runtime_host`, `runtime_port`, and `main`.
- [ ] Run `python -m pytest tests/test_packaged_runtime.py -q`.

### Task 3: Packaging scripts

**Files:**
- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Create: `scripts/package-runtime.ps1`
- Create: `docs/windows-exe-packaging.zh-CN.md`

- [ ] Add scripts for building Renderer, Desktop, Runtime exe, and electron-builder.
- [ ] Add electron-builder config with `extraResources` for bundled Runtime.
- [ ] Document Chinese packaging commands.
- [ ] Run `npm.cmd run verify`.
