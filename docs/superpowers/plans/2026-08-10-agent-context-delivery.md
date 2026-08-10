# Agent Context Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make upstream Agent context path-first while retaining configurable summary and hybrid delivery.

**Architecture:** Add a backward-compatible delivery enum to the shared workflow model and runtime model. The context builder emits validated relative paths and only reads files for hybrid/summary modes. The workflow editor and API types expose the setting without changing artifact storage or terminal execution.

**Tech Stack:** Python runtime, TypeScript contracts/React renderer, Vitest and pytest.

---

### Task 1: Extend context contracts and defaults

**Files:** `packages/contracts/src/workflow.ts`, `runtime/src/workflow_platform/models.py`, compiler tests and contract tests.

- [ ] Add `delivery: "path" | "hybrid" | "summary"` with default `path` in both TypeScript and Python models.
- [ ] Preserve parsing of legacy configurations that omit the field.
- [ ] Add failing serialization and validation tests, then implement the model changes.

### Task 2: Implement path-first context construction

**Files:** `runtime/src/workflow_platform/execution/agent_context.py`, `runtime/tests/test_agent_context.py`, `runtime/tests/test_runtime_service.py`.

- [ ] Add failing tests asserting path mode excludes file body, hybrid mode is bounded, and summary mode preserves current output.
- [ ] Update the builder to include relative path, type, source node, and hash in all modes; read and truncate content only for hybrid/summary.
- [ ] Add explicit read-only instructions and retain safe-path validation.

### Task 3: Expose delivery mode in workflow editor and client types

**Files:** `apps/renderer/src/app/runtimeClient.ts`, `apps/renderer/src/features/workflow/WorkflowViewer.tsx`, related renderer tests.

- [ ] Add the optional delivery field to renderer types and defaults.
- [ ] Add a select control for delivery mode and disable summary limit inputs in path mode.
- [ ] Add UI tests for saving and rendering the setting.

### Task 4: Verify integration

- [ ] Run runtime context/compiler tests.
- [ ] Run renderer tests.
- [ ] Run `npm.cmd test` and `npm.cmd run build`.
