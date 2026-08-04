# Run Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Run page around a workflow progress map, the current node, and one clear next action derived from Runtime state.

**Architecture:** Runtime remains the authorization and state authority. Pure renderer helpers derive graph state and human-readable action guidance from `WorkflowDefinitionSummary`, `RunProjection`, and `allowedActions`; focused React components render those results while preserving the existing App callbacks.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, `@xyflow/react`, existing CSS tokens.

---

## File Structure

- Create `apps/renderer/src/features/runs/runWorkbenchModel.ts` for graph and action derivation.
- Create `apps/renderer/src/features/runs/runWorkbenchModel.test.ts` for pure model tests.
- Create `apps/renderer/src/features/runs/RunProgressMap.tsx` and its test for the read-only React Flow graph.
- Create `apps/renderer/src/features/runs/RunNextActionPanel.tsx` and its test for current-node actions.
- Modify `apps/renderer/src/features/runs/RunDashboard.tsx` to compose the new workbench and keep existing callbacks.
- Modify `apps/renderer/src/features/runs/RunDashboard.test.tsx` for page-level integration coverage.
- Modify `apps/renderer/src/app/styles.css` for responsive layout, status colors, and tooltips.

### Task 1: Derive Workbench State

**Files:** Create `runWorkbenchModel.ts`; test `runWorkbenchModel.test.ts`.

- [ ] Write failing tests first:

```ts
it("marks current nodes and active graph edges from Runtime projection", () => {
  const graph = buildRunProgressGraph(workflow, projection);
  expect(graph.nodes.find((node) => node.id === "implement")).toMatchObject({ status: "current", current: true, successors: ["verify"] });
  expect(graph.edges.find((edge) => edge.id === "implement-verify")).toMatchObject({ active: true });
});

it("selects a plain-language primary action only from allowedActions", () => {
  const result = resolveNodeGuidance({ workflow, projection, nodeId: "review", projectArchived: false });
  expect(result.primaryAction).toMatchObject({ eventType: "HUMAN_APPROVED", label: "批准方案，进入开发实现" });
});

it("explains that an archived project is read-only", () => {
  const result = resolveNodeGuidance({ workflow, projection, nodeId: "implement", projectArchived: true });
  expect(result.primaryAction).toBeNull();
  expect(result.waitingMessage).toContain("项目已归档");
});
```

- [ ] Run `npm.cmd --workspace apps/renderer run test -- --run src/features/runs/runWorkbenchModel.test.ts`; expect failure because the helpers do not exist.
- [ ] Implement `RunProgressNode`, `RunGuidance`, `buildRunProgressGraph`, and `resolveNodeGuidance`. Build successors from `workflow.edges`, state from `projection.nodeStates`, current status from `projection.currentNodeIds`, and action candidates only from `projection.allowedActions`. Map event types to user-facing label, result sentence, priority, and required input kind. Return the first `blockingReasons` entry as the waiting message when no action is allowed.
- [ ] Run the same model test; expect all tests to pass.
- [ ] Commit with `git add apps/renderer/src/features/runs/runWorkbenchModel.ts apps/renderer/src/features/runs/runWorkbenchModel.test.ts; git commit -m "feat: derive run workbench guidance"`.

### Task 2: Render the Read-Only Progress Map

**Files:** Create `RunProgressMap.tsx` and `RunProgressMap.test.tsx`; modify `styles.css`.

- [ ] Write the failing interaction test:

```tsx
it("highlights the current node and exposes successor information on hover", async () => {
  render(<RunProgressMap workflow={workflow} projection={projection} selectedNodeId="implement" onSelectNode={vi.fn()} />);
  expect(screen.getByRole("button", { name: /开发实现.*进行中/ })).toHaveAttribute("data-status", "current");
  fireEvent.mouseEnter(screen.getByRole("button", { name: /测试验证/ }));
  expect(await screen.findByRole("tooltip")).toHaveTextContent("后续节点");
  expect(screen.getByRole("tooltip")).toHaveTextContent("审核发布");
});
```

- [ ] Run `npm.cmd --workspace apps/renderer run test -- --run src/features/runs/RunProgressMap.test.tsx`; expect failure because the component does not exist.
- [ ] Implement the component with `ReactFlow`, `Background`, and `Controls`; convert the model graph to React Flow nodes/edges using `autoLayoutPositions` from `workflowCanvasModel.ts` when no saved positions exist. Set `nodesDraggable={false}`, `nodesConnectable={false}`, and use a custom button node with `aria-current`, keyboard focus, status data, and a tooltip containing state, requirements, blocker, and successors. Node selection is read-only detail selection, never an execution switch.
- [ ] Add bounded desktop/mobile map sizing, active/completed/blocked/failed/pending edge colors, tooltip layering, and overflow containment to `styles.css`.
- [ ] Run the component test; expect pass.
- [ ] Commit with `git add apps/renderer/src/features/runs/RunProgressMap.tsx apps/renderer/src/features/runs/RunProgressMap.test.tsx apps/renderer/src/app/styles.css; git commit -m "feat: add run progress map"`.

### Task 3: Render Dynamic Next Actions

**Files:** Create `RunNextActionPanel.tsx` and `RunNextActionPanel.test.tsx`; modify `styles.css`.

- [ ] Write failing tests:

```tsx
it("shows only approved actions for an approval node", () => {
  const onAction = vi.fn();
  render(<RunNextActionPanel guidance={approvalGuidance} onAction={onAction} />);
  expect(screen.getByRole("button", { name: "批准方案，进入开发实现" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: /启动 Agent/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "批准方案，进入开发实现" }));
  expect(onAction).toHaveBeenCalledWith("HUMAN_APPROVED");
});

it("shows a concrete wait condition instead of unexplained disabled controls", () => {
  render(<RunNextActionPanel guidance={blockedArtifactGuidance} onAction={vi.fn()} />);
  expect(screen.getByText("等待交付物：plan.md")).toBeInTheDocument();
});
```

- [ ] Run `npm.cmd --workspace apps/renderer run test -- --run src/features/runs/RunNextActionPanel.test.tsx`; expect failure because the component does not exist.
- [ ] Implement a panel that renders one primary action, secondary allowed actions, the action result sentence, and required inputs. Render artifact path/type only for artifact actions, waiver reason only for waivers, Agent provider/workspace/prompt only for Agent actions, and evidence controls only for Gate actions. Render no unrelated controls. Archived and no-action states show a clear read-only/waiting message.
- [ ] Run the component test; expect pass.
- [ ] Commit with `git add apps/renderer/src/features/runs/RunNextActionPanel.tsx apps/renderer/src/features/runs/RunNextActionPanel.test.tsx apps/renderer/src/app/styles.css; git commit -m "feat: add dynamic run next actions"`.

### Task 4: Compose the Run Workbench

**Files:** Modify `RunDashboard.tsx`, `RunDashboard.test.tsx`, and `styles.css`.

- [ ] Add a failing integration test asserting that `RunProgressMap`, `下一步操作`, the current node summary, and a collapsed `查看运行详情` section appear before timeline/parameters and that the primary action invokes the existing callback.
- [ ] Run `npm.cmd --workspace apps/renderer run test -- --run src/features/runs/RunDashboard.test.tsx`; expect failure because the existing flat layout has none of those landmarks.
- [ ] Refactor `RunDashboard` as the orchestrator. Keep workspace/loading/unbound/create states. For an active Run render: header and Run selector, `RunProgressMap`, current node workspace, `RunNextActionPanel`, and native `<details>` sections for metadata, timeline, artifacts, Agent output, and deployment output. Preserve existing App callbacks and projection refresh behavior; the renderer must not mutate Runtime state.
- [ ] Implement the guided-action switch by forwarding existing callback paths for node start/complete, artifact scan/submit, approval, Gate, Run pause/resume/archive, Agent start, and deployment start. Pass `projectArchived` into guidance so archived projects remain readable but fully read-only. Keep cancellation controls available for already-running Agent/deployment cleanup.
- [ ] Run the integration test and the existing Run tests; expect pass.
- [ ] Commit with `git add apps/renderer/src/features/runs/RunDashboard.tsx apps/renderer/src/features/runs/RunDashboard.test.tsx apps/renderer/src/app/styles.css; git commit -m "feat: redesign run workbench"`.

### Task 5: Build and Visual Verification

**Files:** Modify only `styles.css` if visual defects are found.

- [ ] Run `npm.cmd --workspace apps/renderer run build`; expect TypeScript and Vite build success.
- [ ] Start `npm.cmd --workspace apps/renderer run dev -- --host 127.0.0.1 --port 5173` and inspect 1440x900 and 390x844 viewports with Playwright. Verify the current node and next action are visible in the first viewport, the graph does not overlap the header or action panel, tooltips remain readable, mobile stacks map before action content, and no unnecessary page scrollbar appears.
- [ ] Run `npm.cmd --workspace apps/renderer run test`; expect all renderer tests to pass.
- [ ] If CSS changed during visual verification, commit with `git add apps/renderer/src/app/styles.css; git commit -m "fix: polish run workbench layout"`.
