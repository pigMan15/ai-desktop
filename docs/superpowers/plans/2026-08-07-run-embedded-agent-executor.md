# Run Embedded Agent Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the wasted Run-page space, keep Agent execution inside Run with switchable Job tabs and writable PTY sessions, and restore Terminal as a Run-independent workspace tool.

**Architecture:** `App` remains the sole owner of Runtime Agent jobs, persisted output, live PTY output, and interactive bindings. A new reusable `RunAgentExecutor` renders those values inside Run detail and the Run-owned full-screen Agent route; `TerminalPage` keeps separate local terminal sessions and no longer loads Run Agent jobs.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, xterm.js, hash routing, existing desktop `workflowTerminal` bridge.

**Working-tree constraint:** Do not stage or commit during this plan. The repository already contains unrelated uncommitted phase work.

---

## File Structure

- Create `apps/renderer/src/features/runs/runAgentExecutorModel.ts`: pure Job selection and output projection helpers.
- Create `apps/renderer/src/features/runs/runAgentExecutorModel.test.ts`: model behavior tests.
- Create `apps/renderer/src/features/runs/RunAgentExecutor.tsx`: reusable tabbed Agent terminal surface.
- Create `apps/renderer/src/features/runs/RunAgentExecutor.test.tsx`: executor interaction tests.
- Create `apps/renderer/src/features/runs/RunAgentExecutorPage.tsx`: Run-owned full-screen wrapper.
- Create `apps/renderer/src/features/runs/RunAgentExecutorPage.test.tsx`: full-screen route view tests.
- Modify `apps/renderer/src/features/runs/RunDetailPage.tsx`: replace local Agent Job state with controlled App state and embed executor below the graph.
- Modify `apps/renderer/src/features/runs/RunDetailPage.test.tsx`: verify no navigation, automatic selection, and layout order.
- Modify `apps/renderer/src/app/App.tsx`: establish one active Run source and wire PTY operations into both Run executor views.
- Modify `apps/renderer/src/app/App.test.tsx`: cover shared binding, Run route stability, and independent terminal creation.
- Modify `apps/renderer/src/app/routes.ts`: replace the scoped Agent terminal route with a Run-owned Agent route.
- Modify `apps/renderer/src/app/routes.test.ts`: cover canonical Agent executor routing.
- Modify `apps/renderer/src/features/terminal/TerminalPage.tsx`: remove scoped Agent loading and allow local sessions without Run registration.
- Modify `apps/renderer/src/features/terminal/TerminalPage.test.tsx`: cover independent local terminal behavior.
- Modify `apps/renderer/src/app/styles.css`: compact graph, fill left column with executor, and add responsive Job tabs.

### Task 1: Correct Route Ownership and Terminal Independence

**Files:**
- Modify: `apps/renderer/src/app/routes.ts`
- Modify: `apps/renderer/src/app/routes.test.ts`
- Modify: `apps/renderer/src/features/terminal/TerminalPage.tsx`
- Modify: `apps/renderer/src/features/terminal/TerminalPage.test.tsx`
- Modify: `apps/renderer/src/app/App.tsx`
- Test: `apps/renderer/src/app/App.test.tsx`

- [ ] **Step 1: Write failing route tests**

Replace the terminal-specific scoped route expectation with a Run-owned Agent route:

```ts
it("round-trips the canonical Run Agent executor route", () => {
  const hash = buildRunAgentExecutorHash("run /上海", "job ?7/#");
  expect(hash).toBe("#/runs/run%20%2F%E4%B8%8A%E6%B5%B7/agents/job%20%3F7%2F%23");
  expect(parseRunRoute(hash)).toEqual({ mode: "agent", runId: "run /上海", jobId: "job ?7/#" });
  expect(normalizeRoute(hash)).toBe("runs");
});

it("keeps the bare terminal route independent from Run context", () => {
  expect(normalizeRoute("#/terminal")).toBe("terminal");
  expect(parseScopedRunRoute("#/terminal", "project-1")).toEqual({ mode: "none" });
});
```

- [ ] **Step 2: Run route tests and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/app/routes.test.ts
```

Expected: FAIL because `buildRunAgentExecutorHash` and `RunRoute.mode === "agent"` do not exist.

- [ ] **Step 3: Implement the Run-owned route**

Change the route contract to:

```ts
export type RunRoute =
  | { mode: "list" }
  | { mode: "new" }
  | { mode: "detail"; runId: string }
  | { mode: "agent"; runId: string; jobId: string }
  | { mode: "unknown" };

export const buildRunAgentExecutorHash = (runId: string, jobId: string) =>
  `#/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(jobId)}`;
```

Parse `#/runs/{runId}/agents/{jobId}` before the detail route. Remove `terminal` from `ScopedRunRoute`, `parseScopedRunRoute`, and `parseScopedNavigationRoute`; malformed Agent subroutes must return `RunRoute.mode === "unknown"`.

- [ ] **Step 4: Write a failing TerminalPage independence test**

Install the existing fake desktop bridge and render without `runId`, `nodeId`, or Runtime registration callbacks:

```tsx
it("creates an independent local terminal without a Run", async () => {
  const bridge = installTerminalBridge();
  render(<TerminalPage projectPath="G:\\Project\\demo" />);
  fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
  await waitFor(() => expect(bridge.create).toHaveBeenCalled());
  expect(bridge.bindRuntimeSession).not.toHaveBeenCalled();
  expect(screen.getByLabelText("ANSI 终端")).toHaveAttribute("data-writable", "true");
});
```

- [ ] **Step 5: Run TerminalPage test and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/terminal/TerminalPage.test.tsx
```

Expected: FAIL because `createTerminal` currently requires `runId`, `nodeId`, and `onRegisterSession`.

- [ ] **Step 6: Make Runtime registration optional**

Remove `context`, `loadJob`, and `loadJobOutput` from `TerminalPageProps` and delete scoped Agent effects. Create the local bridge session whenever `bridge` and `projectRoot.trim()` exist. Only register and bind when all Runtime fields exist:

```ts
const nextSession = await bridge.create({
  kind,
  cwd: projectRoot.trim(),
  projectRoot: projectPath.trim() || projectRoot.trim(),
  columns,
  rows,
  initialPrompt: initialPrompt.trim() || undefined,
});

if (runId && nodeId.trim() && onRegisterSession) {
  const registered = await onRegisterSession({
    runId,
    nodeId: nodeId.trim(),
    kind: nextSession.kind,
    cwd: nextSession.cwd,
    pid: nextSession.pid,
  });
  nextSession.runtimeSessionId = registered.id;
  await bridge.bindRuntimeSession(nextSession.id, runId, registered.id);
}
```

Enable “创建终端” with `!bridge || !projectRoot.trim()` as the only creation guard. In `App`, remove `#/terminal` from `routeRequiresRunContext` and render `TerminalPage` without scoped Agent props.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/app/routes.test.ts src/features/terminal/TerminalPage.test.tsx src/app/App.test.tsx
```

Expected: all selected files PASS.

### Task 2: Build the Pure Agent Executor Model

**Files:**
- Create: `apps/renderer/src/features/runs/runAgentExecutorModel.ts`
- Create: `apps/renderer/src/features/runs/runAgentExecutorModel.test.ts`

- [ ] **Step 1: Write failing model tests**

Cover active-first selection, requested selection, and live-output precedence:

```ts
it("selects the requested Job, otherwise the newest active Job", () => {
  expect(selectAgentJob(jobs, "job-done")?.id).toBe("job-done");
  expect(selectAgentJob(jobs, null)?.id).toBe("job-running-new");
});

it("uses live PTY output while present and persisted output as fallback", () => {
  expect(agentViewportOutput("job-1", persisted, { "job-1": live })).toEqual(live);
  expect(agentViewportOutput("job-2", persisted, {})).toEqual([
    { sequence: 2, data: "persisted" },
  ]);
});
```

- [ ] **Step 2: Run model tests and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/runAgentExecutorModel.test.ts
```

Expected: FAIL because the model module does not exist.

- [ ] **Step 3: Implement the minimal model**

Export:

```ts
export function selectAgentJob(
  jobs: AgentJobSummary[],
  requestedJobId: string | null,
): AgentJobSummary | null;

export function agentViewportOutput(
  jobId: string,
  persisted: AgentOutputSummary[],
  liveByJob: Record<string, TerminalViewportOutput[]>,
): TerminalViewportOutput[];
```

Selection order is requested existing Job, newest `RUNNING`/`QUEUED` Job by `updatedAt`, then newest Job by `updatedAt`. Map persisted payload using `payload.data`, then `payload.text`, then `JSON.stringify(payload)`. When live output for a Job is non-empty, use it as authoritative to avoid rendering the same PTY event twice.

- [ ] **Step 4: Run model tests and verify GREEN**

Run the same command. Expected: PASS.

### Task 3: Build the Reusable Tabbed RunAgentExecutor

**Files:**
- Create: `apps/renderer/src/features/runs/RunAgentExecutor.tsx`
- Create: `apps/renderer/src/features/runs/RunAgentExecutor.test.tsx`

- [ ] **Step 1: Write failing executor component tests**

Mock `TerminalViewport` and cover the desired public interface:

```tsx
type RunAgentSessionState = {
  writable: boolean;
  persistenceLimited?: boolean;
};

render(
  <RunAgentExecutor
    runId="run-1"
    jobs={[runningJob, completedJob]}
    persistedOutput={persistedOutput}
    liveOutputByJob={{ "job-running": [{ sequence: 1, data: "live" }] }}
    sessionStateByJob={{ "job-running": { writable: true } }}
    selectedJobId="job-running"
    onSelectJob={onSelectJob}
    onInput={onInput}
    onInterrupt={onInterrupt}
    onResize={onResize}
    onStop={onStop}
  />,
);
```

Assertions:

- both Job tabs render with short ID, Provider, and status;
- clicking the completed Job calls `onSelectJob("job-completed")`;
- the running viewport is writable and forwards input with `job-running`;
- completed and automatic Jobs are read-only;
- interrupt, resize, and stop target the selected Job;
- an empty Job list renders a compact “尚未启动 Agent” state;
- the optional full-screen link uses `buildRunAgentExecutorHash`.

- [ ] **Step 2: Run component tests and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunAgentExecutor.test.tsx
```

Expected: FAIL because `RunAgentExecutor` does not exist.

- [ ] **Step 3: Implement the component**

Export `RunAgentSessionState`. Use `selectAgentJob` and `agentViewportOutput`. Render Job buttons with `role="tab"`, a selected status/header row, `TerminalViewport`, a Stop button for active Jobs, and an optional “全屏执行器” link. Set viewport behavior as:

```tsx
const sessionState = selectedJob ? sessionStateByJob[selectedJob.id] : undefined;
const writable = Boolean(
  selectedJob?.mode === "interactive" &&
  (selectedJob.status === "QUEUED" || selectedJob.status === "RUNNING") &&
  sessionState?.writable,
);

<TerminalViewport
  ariaLabel={`Agent 执行器 ${selectedJob.id}`}
  resetKey={selectedJob.id}
  output={viewportOutput}
  writable={writable}
  onInput={(data) => onInput(selectedJob.id, data)}
  onInterrupt={() => onInterrupt(selectedJob.id)}
  onResize={(columns, rows) => onResize(selectedJob.id, columns, rows)}
/>
```

Show explicit messages for automatic mode, missing binding, and persistence-limited sessions.

- [ ] **Step 4: Run component tests and verify GREEN**

Run the same command. Expected: PASS.

### Task 4: Embed the Executor in RunDetailPage

**Files:**
- Modify: `apps/renderer/src/features/runs/RunDetailPage.tsx`
- Modify: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`

- [ ] **Step 1: Write failing Run detail tests**

Change the test fixture to pass controlled Agent data and callbacks. Add assertions that:

```ts
expect(window.location.hash).toBe("#/runs/run%2Fone");
expect(screen.getByRole("region", { name: "Agent 执行器" })).toBeInTheDocument();
expect(screen.queryByRole("link", { name: /打开 Agent 终端/ })).not.toBeInTheDocument();
expect(graph.compareDocumentPosition(executor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
```

After `onStartAgent` resolves with `job-new`, verify its tab becomes selected and no hash change occurs. Add a multiple-Job test that switches tabs and forwards input to the selected Job ID.

- [ ] **Step 2: Run RunDetailPage tests and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunDetailPage.test.tsx
```

Expected: FAIL because Run detail has no embedded executor and still owns a local Job copy.

- [ ] **Step 3: Replace local Agent state with controlled props**

Remove `loadAgentJobs`, the local `agentJobs` state, and the Job-to-terminal link list. Add props:

```ts
agentJobs: AgentJobSummary[];
agentOutput: AgentOutputSummary[];
agentLiveOutput: Record<string, TerminalViewportOutput[]>;
agentSessionState: Record<string, RunAgentSessionState>;
onAgentInput(jobId: string, data: string): Promise<void>;
onAgentInterrupt(jobId: string): Promise<void>;
onAgentResize(jobId: string, columns: number, rows: number): Promise<void>;
onStopAgent(jobId: string): Promise<void>;
```

Keep `selectedAgentJobId` in `RunDetailPage`; after `onStartAgent` resolves, set it to the returned Job ID. Wrap the graph and executor in `.run-console-workspace`:

```tsx
<div className="run-console-workspace">
  <section className="run-console-graph">...</section>
  <RunAgentExecutor ... />
</div>
<section className="run-console-control">...</section>
```

- [ ] **Step 4: Run RunDetailPage tests and verify GREEN**

Run the same command. Expected: all Run detail tests PASS.

### Task 5: Wire the Single Agent State Source in App

**Files:**
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/App.test.tsx`

- [ ] **Step 1: Write failing App integration tests**

Add tests proving:

- `activeRunId` is the Run detail ID, so `listAgentJobs` and interactive PTY reads run while `#/runs/{runId}` is open;
- starting an interactive Agent leaves `window.location.hash` on the Run detail;
- the embedded viewport becomes writable after the desktop binding is created;
- input, `Ctrl+C`, resize, and stop call the same desktop session ID created for that Job;
- Runtime Job polling does not alternate with a RunDetailPage-local list.

Use the existing mocked `TerminalViewport` input buttons and desktop bridge spies. Assert the desktop ID rather than merely checking callback counts:

```ts
expect(terminalBridge.writeInput).toHaveBeenCalledWith("desktop-agent-1", "继续\r");
expect(terminalBridge.interrupt).toHaveBeenCalledWith("desktop-agent-1");
expect(window.location.hash).toBe("#/runs/run-1");
```

- [ ] **Step 2: Run App tests and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/app/App.test.tsx
```

Expected: FAIL because `activeRunId` currently excludes Run detail routes and executor props are not wired.

- [ ] **Step 3: Make the Run route part of active Run state**

Define:

```ts
const routeRunId = runRoute.mode === "detail" || runRoute.mode === "agent"
  ? runRoute.runId
  : null;
const activeRunId = routeRunId ?? ("context" in scopedRoute ? scopedRoute.context.runId : null);
```

This makes the existing Runtime Job poll and PTY read loop operate while Run detail or full-screen Agent executor is visible.

- [ ] **Step 4: Pass controlled Agent state and PTY callbacks**

Build session state from `interactiveAgentTerminals`:

```ts
const agentSessionState = Object.fromEntries(
  Object.entries(interactiveAgentTerminals).map(([jobId, binding]) => [
    jobId,
    { writable: true, persistenceLimited: Boolean(binding.persistenceLimited) },
  ]),
);
```

Pass `state?.agentJobs`, `state?.agentOutput`, `liveAgentOutput[runId]`, and the existing input/resize/cancel handlers to `RunDetailPage`.

Change input, interrupt, and stop handlers to receive `runId` explicitly instead of reading `state?.projection?.runId`:

```ts
async function handleAgentTerminalInput(runId: string, jobId: string, data: string) { ... }
async function handleAgentTerminalInterrupt(runId: string, jobId: string) { ... }
async function handleCancelAgent(runId: string, jobId: string) { ... }
```

Bind them at the render site with the route Run ID. This prevents a direct full-screen route or rapid Run switch from sending input to a stale projection.

After `startInteractiveAgentSession`, reload the canonical Job list and return the matching current Job instead of reinserting the stale pre-binding result:

```ts
const jobs = await client.listAgentJobs(projectId, runId);
const currentJob = jobs.find((candidate) => candidate.id === job.id) ?? job;
setState((current) => current ? { ...current, agentJobs: jobs, agentOutput: output } : current);
return currentJob;
```

- [ ] **Step 5: Run App and Run executor tests and verify GREEN**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/app/App.test.tsx src/features/runs/RunDetailPage.test.tsx src/features/runs/RunAgentExecutor.test.tsx
```

Expected: all selected files PASS.

### Task 6: Add the Run-Owned Full-Screen Executor

**Files:**
- Create: `apps/renderer/src/features/runs/RunAgentExecutorPage.tsx`
- Create: `apps/renderer/src/features/runs/RunAgentExecutorPage.test.tsx`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/App.test.tsx`

- [ ] **Step 1: Write failing full-screen view tests**

Render the page with two Jobs and an initial `jobId`. Verify the heading, back link, selected tab, and writable viewport:

```tsx
expect(screen.getByRole("link", { name: "返回 Run" })).toHaveAttribute("href", "#/runs/run-1");
expect(screen.getByRole("tab", { name: /job-2/ })).toHaveAttribute("aria-selected", "true");
expect(screen.getByLabelText("Agent 执行器 job-2")).toHaveAttribute("data-writable", "true");
```

- [ ] **Step 2: Run the page test and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunAgentExecutorPage.test.tsx
```

Expected: FAIL because the page does not exist.

- [ ] **Step 3: Implement and route the full-screen page**

`RunAgentExecutorPage` renders a compact Run header, back link, and `RunAgentExecutor` with `fullScreen`. In `App`, render it when `currentRoute === "runs" && runRoute.mode === "agent"`, passing the same jobs, output, binding state, and PTY callbacks as Run detail. Do not render `TerminalPage` for this route.

- [ ] **Step 4: Run route, page, and App tests and verify GREEN**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/app/routes.test.ts src/features/runs/RunAgentExecutorPage.test.tsx src/app/App.test.tsx
```

Expected: all selected files PASS.

### Task 7: Eliminate Blank Space and Finish Responsive Layout

**Files:**
- Modify: `apps/renderer/src/app/styles.css`
- Test: `apps/renderer/src/features/runs/RunDetailPage.test.tsx`

- [ ] **Step 1: Verify the structural layout contract from Task 4**

Run the Run detail test that asserts `.run-console-workspace` contains the graph followed by the executor and `.run-console-control` remains the second main-grid child:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunDetailPage.test.tsx
```

Expected: PASS before visual CSS work begins, proving the DOM order used by the responsive rules is stable.

- [ ] **Step 2: Implement desktop and responsive CSS**

Use these layout constraints:

```css
.run-console-main {
  display: grid;
  grid-template-columns: minmax(0, 1.85fr) minmax(340px, 1fr);
  align-items: start;
}
.run-console-workspace { display: grid; min-width: 0; align-content: start; }
.run-console-graph .run-progress-map {
  min-height: 320px;
  height: clamp(320px, 38vh, 460px);
}
.run-agent-executor { min-width: 0; border-top: 1px solid var(--line); }
.run-agent-job-tabs { display: flex; min-width: 0; overflow-x: auto; }
.run-agent-executor .terminal-surface { height: clamp(24rem, 44vh, 36rem); }
```

At `980px`, set `.run-console-main` to one column and order workspace before control. At `620px`, keep Job tabs horizontally scrollable and reduce terminal height without clipping controls.

- [ ] **Step 3: Run focused tests**

Run:

```powershell
npm.cmd --workspace apps/renderer test -- src/features/runs/RunDetailPage.test.tsx src/features/runs/RunAgentExecutor.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Perform browser visual verification**

Start the local Runtime and Renderer using the existing project scripts. In the in-app browser, verify a Run with at least two Agent Jobs at desktop width and the available narrow viewport:

- no horizontal overflow (`scrollWidth <= clientWidth`);
- graph height is between 320 and 460 pixels;
- executor immediately follows graph with no large empty band;
- Job tabs switch visible output;
- interactive viewport accepts input without route navigation;
- automatic/completed Job remains read-only;
- control rail does not overlap the executor.

Save the desktop screenshot under the configured visualizations workspace.

### Task 8: Final Regression Verification

**Files:**
- Verify all files listed above.

- [ ] **Step 1: Run the full Renderer suite**

```powershell
npm.cmd --workspace apps/renderer test
```

Expected: all Renderer test files and tests PASS.

- [ ] **Step 2: Run the production build**

```powershell
npm.cmd --workspace apps/renderer run build
```

Expected: TypeScript and Vite build PASS; the existing chunk-size warning may remain.

- [ ] **Step 3: Check scoped diffs**

```powershell
git diff --check -- apps/renderer/src/app/App.tsx apps/renderer/src/app/App.test.tsx apps/renderer/src/app/routes.ts apps/renderer/src/app/routes.test.ts apps/renderer/src/app/styles.css apps/renderer/src/features/runs/RunDetailPage.tsx apps/renderer/src/features/runs/RunDetailPage.test.tsx apps/renderer/src/features/runs/RunAgentExecutor.tsx apps/renderer/src/features/runs/RunAgentExecutor.test.tsx apps/renderer/src/features/runs/RunAgentExecutorPage.tsx apps/renderer/src/features/runs/RunAgentExecutorPage.test.tsx apps/renderer/src/features/runs/runAgentExecutorModel.ts apps/renderer/src/features/runs/runAgentExecutorModel.test.ts apps/renderer/src/features/terminal/TerminalPage.tsx apps/renderer/src/features/terminal/TerminalPage.test.tsx
```

Expected: exit code `0` with no whitespace errors. Do not stage or commit.
