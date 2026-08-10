# Run Artifact Scan Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Run artifact scans visibly report satisfied, new, unchanged, missing, and invalid artifacts, and state whether Runtime currently allows completing the node.

**Architecture:** Add a focused `RunArtifactScanFeedback` presentation component and keep scan lifecycle state in `RunDetailPage`. The feedback component explains the scan result, while `RunDetailPage` continues to treat `projection.allowedActions` as the only authority for enabling `NODE_COMPLETED`.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, existing Renderer CSS and Runtime client contracts.

**Version control:** The user explicitly requested no staging, commits, or pushes, so commit steps are intentionally omitted.

---

### Task 1: Build the artifact scan feedback component

**Files:**
- Create: `apps/renderer/src/features/runs/RunArtifactScanFeedback.tsx`
- Create: `apps/renderer/src/features/runs/RunArtifactScanFeedback.test.tsx`
- Modify: `apps/renderer/src/app/styles.css`

- [ ] **Step 1: Write failing component tests for successful and blocked scans**

Create test fixtures for `registered`, `unchanged`, `missing`, and `invalid`, then assert the exact user-visible behavior:

```tsx
it("shows satisfied counts and Runtime completion readiness", () => {
  render(
    <RunArtifactScanFeedback
      state={{
        phase: "success",
        nodeId: "implement",
        result: scan({ registered: ["bundle"], unchanged: ["notes"] }),
      }}
      nodeName="Implement"
      canComplete
      blockers={[]}
      artifactsHref="#/artifacts?projectId=p&runId=r"
    />,
  );

  const status = screen.getByRole("status", { name: "产物检查结果" });
  expect(status).toHaveTextContent("已满足 2/2");
  expect(status).toHaveTextContent("本次提交 1");
  expect(status).toHaveTextContent("已存在 1");
  expect(status).toHaveTextContent("可以完成当前节点");
});

it("lists missing and invalid artifacts and explains why the node cannot advance", () => {
  render(
    <RunArtifactScanFeedback
      state={{
        phase: "success",
        nodeId: "implement",
        result: scan({
          missing: ["notes"],
          invalid: [{ artifactSpecId: "bundle", reason: "outside workspace" }],
        }),
      }}
      nodeName="Implement"
      canComplete={false}
      blockers={[{ code: "ARTIFACT_REQUIRED", message: "Waiting for artifacts", nodeId: "implement" }]}
      artifactsHref="#/artifacts?projectId=p&runId=r"
    />,
  );

  const status = screen.getByRole("status", { name: "产物检查结果" });
  expect(status).toHaveTextContent("已满足 0/2");
  expect(status).toHaveTextContent("缺失：notes");
  expect(status).toHaveTextContent("bundle：outside workspace");
  expect(status).toHaveTextContent("暂不能进入下一步");
  expect(status).toHaveTextContent("Waiting for artifacts");
});
```

- [ ] **Step 2: Run the component test and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunArtifactScanFeedback.test.tsx
```

Expected: FAIL because `RunArtifactScanFeedback.tsx` does not exist.

- [ ] **Step 3: Implement the minimal feedback state and component**

Export a small state union and render a compact status band:

```tsx
export type ArtifactScanFeedbackState =
  | { phase: "idle" }
  | { phase: "scanning"; nodeId: string }
  | { phase: "success"; nodeId: string; result: NodeArtifactScan }
  | { phase: "error"; nodeId: string; message: string };

export function RunArtifactScanFeedback(props: RunArtifactScanFeedbackProps) {
  if (props.state.phase === "idle") return null;
  if (props.state.phase === "scanning") {
    return <section className="run-artifact-scan-feedback" role="status" aria-label="产物检查结果">正在扫描声明的产物...</section>;
  }
  if (props.state.phase === "error") {
    return <section className="run-artifact-scan-feedback is-error" role="status" aria-label="产物检查结果"><strong>产物扫描失败</strong><p>{props.state.message}</p></section>;
  }

  const { registered, unchanged, missing, invalid } = props.state.result;
  const satisfied = registered.length + unchanged.length;
  const total = satisfied + missing.length + invalid.length;
  const ready = missing.length === 0 && invalid.length === 0 && props.canComplete;

  return (
    <section className={`run-artifact-scan-feedback ${ready ? "is-ready" : "is-blocked"}`} role="status" aria-label="产物检查结果">
      <div className="run-artifact-scan-summary">
        <div><span>产物检查结果</span><strong>已满足 {satisfied}/{total}</strong><small>{props.nodeName}</small></div>
        <a href={props.artifactsHref}>查看全部产物</a>
      </div>
      <dl className="run-artifact-scan-counts">
        <div><dt>本次提交</dt><dd>{registered.length}</dd></div>
        <div><dt>已存在</dt><dd>{unchanged.length}</dd></div>
        <div><dt>缺失</dt><dd>{missing.length}</dd></div>
        <div><dt>无效</dt><dd>{invalid.length}</dd></div>
      </dl>
      {missing.length > 0 ? <p>缺失：{missing.join(", ")}</p> : null}
      {invalid.map((item) => <p key={item.artifactSpecId}>{item.artifactSpecId}：{item.reason}</p>)}
      <strong>{ready ? "产物要求已满足，可以完成当前节点" : "暂不能进入下一步"}</strong>
      {!ready && props.blockers.length > 0 ? <ul>{props.blockers.map((item) => <li key={`${item.code}:${item.nodeId ?? "run"}`}>{item.message}</li>)}</ul> : null}
    </section>
  );
}
```

- [ ] **Step 4: Add compact responsive styles**

Add CSS using existing surface, success, warning, and danger tokens. Use a four-column count grid on desktop and two columns below `620px`; do not add a nested card or modal.

```css
.run-artifact-scan-feedback { display: grid; gap: 10px; border-left: 3px solid var(--line-strong); background: var(--surface-subtle); padding: 12px; }
.run-artifact-scan-feedback.is-ready { border-left-color: var(--success); }
.run-artifact-scan-feedback.is-blocked { border-left-color: var(--warning); }
.run-artifact-scan-feedback.is-error { border-left-color: var(--danger); }
.run-artifact-scan-summary { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
.run-artifact-scan-summary > div { display: grid; gap: 2px; }
.run-artifact-scan-counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; }
@media (max-width: 620px) { .run-artifact-scan-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
```

- [ ] **Step 5: Run the component tests and verify GREEN**

Run the focused test command from Step 2.

Expected: 1 test file passes with both readiness scenarios covered.

### Task 2: Integrate scan lifecycle and Runtime authorization into Run detail

**Files:**
- Modify: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Modify: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`

- [ ] **Step 1: Extend the existing scan test and add an error-location test**

Change the successful scan fixture to return one registered artifact, one unchanged artifact, no failures, and a projection containing a `NODE_COMPLETED` action for `implement`. Keep the refresh promise pending so the immediate returned projection remains observable, then assert:

```tsx
expect(await screen.findByRole("status", { name: "产物检查结果" })).toHaveTextContent("已满足 2/2");
expect(screen.getByRole("status", { name: "产物检查结果" })).toHaveTextContent("可以完成当前节点");
expect(screen.getByRole("button", { name: "完成当前节点" })).toBeEnabled();
expect(executeAction).not.toHaveBeenCalled();
```

Add a rejected scan assertion:

```tsx
const scanNodeArtifacts = vi.fn().mockRejectedValue(runtimeError(422, "ARTIFACT_SCAN_FAILED", "Cannot read output"));
renderPage({ scanNodeArtifacts });
fireEvent.click(await screen.findByRole("button", { name: "扫描并提交所需产物" }));
expect(await screen.findByRole("status", { name: "产物检查结果" })).toHaveTextContent("Cannot read output");
```

- [ ] **Step 2: Run the Run detail test and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunDetailPage.test.tsx
```

Expected: FAIL because the named in-panel feedback status and completion-ready presentation do not exist.

- [ ] **Step 3: Store scan lifecycle state in `RunDetailPage`**

Add state initialized to idle:

```tsx
const [artifactScanFeedback, setArtifactScanFeedback] = useState<ArtifactScanFeedbackState>({ phase: "idle" });
```

For an `ARTIFACT_SUBMITTED` scan, set `scanning` before the request, save the full result in the success handler, and save the normalized Runtime error message in the catch handler. Clear the state when the selected node changes so a result cannot appear under another node.

```tsx
useEffect(() => {
  setArtifactScanFeedback({ phase: "idle" });
}, [selectedNodeId]);
```

The scan success branch must still return `{ projection: result.projection }` to the existing reducer and must still schedule the full overview refresh.

- [ ] **Step 4: Render readiness from Runtime-authorized actions**

Derive completion permission only from the current projection:

```tsx
const canCompleteSelectedNode = authorizedActions.some(
  (action) => action.eventType === "NODE_COMPLETED" && action.nodeId === selectedNodeId,
);
```

Render `RunArtifactScanFeedback` between the “Runtime 授权操作” heading and action list when its `nodeId` matches the selected node. Pass current-node blockers and the existing artifact route from `buildRunModuleHash("artifacts", runContext)`.

When the feedback is successful with no missing or invalid entries and `canCompleteSelectedNode` is true, add `is-next-ready` to that node's `NODE_COMPLETED` button. This is visual emphasis only; the existing `authorizedActions` list and disabled logic remain unchanged.

- [ ] **Step 5: Run Run detail and component tests**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunArtifactScanFeedback.test.tsx src/features/runs/RunDetailPage.test.tsx
```

Expected: both test files pass; the scan action does not invoke completion automatically.

### Task 3: Verify the Renderer change

**Files:**
- Verify: `apps/renderer/src/features/runs/RunArtifactScanFeedback.tsx`
- Verify: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Verify: `apps/renderer/src/app/styles.css`

- [ ] **Step 1: Run all Renderer tests**

```powershell
npm.cmd --workspace apps/renderer test
```

Expected: all Renderer test files pass with zero failures.

- [ ] **Step 2: Run the production build**

```powershell
npm.cmd --workspace apps/renderer run build
```

Expected: TypeScript checking and Vite production build exit with code 0.

- [ ] **Step 3: Check the changed files for whitespace errors**

```powershell
git diff --check -- apps/renderer/src/features/runs/RunArtifactScanFeedback.tsx apps/renderer/src/features/runs/RunArtifactScanFeedback.test.tsx apps/renderer/src/features/runs/RunDetailPage.tsx apps/renderer/src/features/runs/RunDetailPage.test.tsx apps/renderer/src/app/styles.css
```

Expected: no whitespace errors. Line-ending warnings are acceptable in the existing Windows worktree.
