# Complete Product Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a publishable Windows desktop workflow platform that satisfies the operational, governance, knowledge, and packaging requirements in the Chinese development specification.

**Architecture:** Keep the Python Runtime as the sole authority for workflow facts, governance records, and knowledge publishing. Keep Electron as the local process boundary for the managed Runtime and terminal sessions, and keep Renderer actions behind typed Runtime API or preload IPC contracts.

**Tech Stack:** Electron, React, TypeScript, Vite, Vitest, Python, FastAPI, SQLite, pytest, node-pty, Playwright.

---

### Task 1: Governance Completion

**Files:**
- Modify: `runtime/src/workflow_platform/kernel/transition.py`
- Modify: `runtime/src/workflow_platform/kernel/projection.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `apps/renderer/src/app/runtimeClient.ts`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/features/runs/RunDashboard.tsx`
- Modify: `apps/renderer/src/features/gates/GatesPage.tsx`
- Test: `runtime/tests/test_runtime_service.py`
- Test: `apps/renderer/src/features/runs/RunDashboard.test.tsx`
- Test: `apps/renderer/src/features/gates/GatesPage.test.tsx`

- [x] **Step 1: Add a failing Runtime test for an authorized `GATE_WAIVED` event with a non-empty reason.**
- [x] **Step 2: Implement `GATE_WAIVED` validation, projection, typed API submission, and persisted Gate result.**
- [x] **Step 3: Add failing Renderer tests for the waiver reason and Gate review record.**
- [x] **Step 4: Implement the Runtime-backed waiver form and full Gate audit record display.**
- [x] **Step 5: Verify with `python -m pytest -q tests/test_runtime_service.py::test_runtime_service_records_authorized_gate_waiver_with_reason tests/test_kernel.py` and focused Vitest tests.**

### Task 2: Persistent Knowledge and Audit

**Files:**
- Modify: `runtime/src/workflow_platform/persistence/migrations.py`
- Modify: `runtime/src/workflow_platform/persistence/repositories.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `apps/renderer/src/app/runtimeClient.ts`
- Create: `apps/renderer/src/features/knowledge/KnowledgePage.tsx`
- Create: `apps/renderer/src/features/audit/AuditPage.tsx`
- Modify: `apps/renderer/src/app/routes.ts`
- Modify: `apps/renderer/src/app/App.tsx`
- Test: `runtime/tests/test_governance_knowledge.py`
- Test: `runtime/tests/test_api.py`
- Test: `apps/renderer/src/features/knowledge/KnowledgePage.test.tsx`
- Test: `apps/renderer/src/features/audit/AuditPage.test.tsx`

- [x] **Step 1: Add failing API tests for durable knowledge candidates, review, publish, search, and actor-filtered audit records.**
- [x] **Step 2: Add SQLite migrations and repositories; record each governance write as an immutable audit entry.**
- [x] **Step 3: Add Runtime service and FastAPI endpoints that enforce trusted human review before publication.**
- [x] **Step 4: Add Chinese knowledge and audit pages, wired only through the Runtime client.**
- [x] **Step 5: Run focused pytest/Vitest suites and then full Runtime/Renderer suites.**

### Task 3: Artifact, Workflow, Recovery, and Terminal Operations

**Files:**
- Modify: `runtime/src/workflow_platform/api/app.py`
- Modify: `runtime/src/workflow_platform/runtime_service.py`
- Modify: `apps/desktop/src/main/terminal.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/preload/preload.ts`
- Modify: `apps/renderer/src/features/artifacts/ArtifactsPage.tsx`
- Modify: `apps/renderer/src/features/workflow/WorkflowViewer.tsx`
- Modify: `apps/renderer/src/features/recovery/RecoveryPage.tsx`
- Modify: `apps/renderer/src/features/terminal/TerminalPage.tsx`
- Test: `runtime/tests/test_api.py`
- Test: `apps/desktop/test/main.test.ts`
- Test: `apps/renderer/src/features/**/*.test.tsx`

- [x] **Step 1: Add contract tests for artifact preview metadata, event export, recovery diagnostics, and terminal restart/scrollback.**
- [x] **Step 2: Add safe Runtime endpoints for artifact metadata and diagnostic export.**
- [x] **Step 3: Upgrade terminal sessions with restart, bounded scrollback, resize, and xterm rendering.**
- [x] **Step 4: Upgrade workflow/recovery/artifact pages from status-only output to operational views with empty, error, and loading states.**
- [x] **Step 5: Run desktop, Runtime, and Renderer tests.**

### Task 4: Publishable Release Verification

**Files:**
- Modify: `scripts/package-windows-full.ps1`
- Modify: `apps/desktop/electron-builder.config.cjs`
- Modify: `tests/e2e/**/*.spec.ts`
- Test: `scripts/verify.ps1`

- [x] **Step 1: Add Playwright coverage for `Agent -> Artifact -> Approval -> Gate -> Timeline` with the fake CLI.**
- [x] **Step 2: Add Electron E2E coverage for managed Runtime and a terminal session.**
- [x] **Step 3: Run all test suites, production builds, and full Windows packaging.**
- [x] **Step 4: Inspect the package for the Electron executable, renderer assets, and bundled Runtime executable.**
