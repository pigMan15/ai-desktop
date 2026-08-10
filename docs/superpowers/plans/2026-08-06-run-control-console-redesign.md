# Run Control Console Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recompose the project-scoped Run detail page as a compact operational console with a contextual Agent command bar and responsive resource navigation.

**Architecture:** Keep `RunDetailPage` as the scoped data/state owner and preserve all existing Runtime contracts. Restructure only its semantic layout and local presentation, using existing helpers and routes. Update the existing CSS system rather than adding a component framework or dependency.

**Tech Stack:** React 18, TypeScript, Testing Library, Vitest, native CSS Grid, Lucide React, existing Playwright/browser tooling.

---

### Task 1: Lock The New Page Hierarchy With Failing Tests

**Files:**
- Modify: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`

- [ ] Change the hierarchy test to require `运行进度与控制` as a two-part region containing `运行进度图` before `当前节点控制`, followed by the `Run 资源` tab navigation.
- [ ] Require the compact toolbar to expose `返回 Run 列表`, title/status/revision, last refresh, and an icon-labeled `刷新` command without duplicating page headings.
- [ ] Require the local `上下文` tab to be selected and the scoped resources to be links with the existing project/run URLs.
- [ ] Run `npm.cmd --workspace apps/renderer test -- src/features/runs/RunDetailPage.test.tsx` and confirm failures point to missing `运行进度与控制`, `当前节点控制`, and `Run 资源` semantics.

### Task 2: Recompose The Run Console Markup

**Files:**
- Modify: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Modify: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`

- [ ] Replace the loose heading with `run-console-toolbar`: back icon/link, title and compact identity metadata on the left; refresh time plus icon command on the right.
- [ ] Replace overview tiles with `run-console-status-strip` showing workspace, selected/current node, active Agent/deployment counts, and latest event.
- [ ] Wrap the map and selected-node/action surface in `run-console-main`, using `run-console-graph` and `run-console-control` children under the `运行进度与控制` region.
- [ ] Move `CurrentNodeSection`, blockers, `authorizedActions`, and successor summary into `run-console-control`; preserve exact action input and dispatch behavior.
- [ ] Replace the resource grid and local accordions with `run-console-resources`: a `tablist` whose selected `上下文` tab controls an inline context panel, while other items remain scoped links for artifacts, gates, approvals, deployment, audit, and recovery.
- [ ] Re-run the focused test until all existing state/action/polling cases and the new hierarchy pass.

### Task 3: Redesign The Agent Command Bar

**Files:**
- Modify: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Modify: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`

- [ ] Replace the generic form section with `run-agent-command`, located inside the selected-node control surface.
- [ ] Render Provider as a compact select, mode as a radio-backed segmented control, prompt as the dominant textarea, and Start as an icon/text command using Lucide `Play`.
- [ ] Render workspace, selected role, allowed tools, and Provider availability in `run-agent-meta`; do not use read-only text inputs for metadata.
- [ ] Render existing jobs as `run-agent-jobs` rows with status and a Lucide terminal link; preserve the exact terminal URL.
- [ ] Extend tests to assert radio semantics, unavailable Provider disabling, busy label, inline launch error, archived disabling, exact start payload, and refreshed job link.
- [ ] Re-run the focused test and confirm every Agent state passes.

### Task 4: Apply The Responsive Visual System

**Files:**
- Modify: `apps/renderer/src/app/styles.css`

- [ ] Replace the obsolete `run-detail-*` layout rules with console-specific rules: a compact toolbar, four-column status strip, 65/35 main grid, stable graph height, narrow control rail, divided action rows, and low-border resource tabs.
- [ ] Add complete hover, focus-visible, active, disabled, busy, warning, and error states using the existing neutral/teal semantic variables.
- [ ] At `980px`, stack graph/control and reduce the status strip to two columns. At `620px`, use one status column, a single-column Agent command layout, horizontally scrollable resource tabs, and full-width primary commands.
- [ ] Scan the resulting CSS for gradients, decorative shadows, radius inconsistency, overflowing fixed widths, and accidental purple/blue palette additions; remove any found.

### Task 5: Verify Behavior And Layout

**Files:**
- Verify: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Verify: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`
- Verify: `apps/renderer/src/app/styles.css`

- [ ] Run `npm.cmd --workspace apps/renderer test` and record the exact file/test count.
- [ ] Run `npm.cmd --workspace apps/renderer run build` and record the build result and existing chunk warning.
- [ ] Run `git diff --check` and inspect only the three redesign files for unintended changes.
- [ ] Start the local Runtime/Renderer on isolated ports and capture desktop and narrow screenshots of a running Agent node. Confirm no overlap, clipping, blank graph, unstable controls, or unreadable text.
- [ ] Do not stage or commit; report changed behavior, verification evidence, screenshot paths, and residual warnings.
