# Terminal Project Run Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Terminal discover every Run in the current project, search and reveal historical Runs, and keep completed or archived Runs read-only.

**Architecture:** Add a focused terminal Run model for pagination, sorting, filtering, and bindability. Keep the existing project-level Runtime API unchanged. `App` owns project Run loading, while `TerminalPage` owns selector state, history loading for the selected Run, and UI enforcement of read-only Runs.

**Tech Stack:** React 18, TypeScript, Runtime HTTP client, Vitest, Testing Library.

**Commit policy:** Do not stage or commit. The workspace contains overlapping user changes and the user previously requested no Git operations.

---

## File Map

- Create `apps/renderer/src/features/terminal/terminalRunModel.ts`: project Run pagination, bindability, sorting, filtering, and option formatting.
- Create `apps/renderer/src/features/terminal/terminalRunModel.test.ts`: pure model and pagination coverage.
- Modify `apps/renderer/src/features/terminal/TerminalPage.tsx`: search, historical toggle, read-only enforcement, selected-Run history loading, and retry UI.
- Modify `apps/renderer/src/features/terminal/TerminalPage.test.tsx`: selector, read-only, history, and existing binding regressions.
- Modify `apps/renderer/src/app/App.tsx`: load project Runs independently from workflow-version Runs and wire selected-Run terminal history.
- Modify `apps/renderer/src/app/App.test.tsx`: prove older workflow-version Runs are listed through project pagination and routed with their own Run ID.
- Modify `docs/full-feature-local-delivery-workflow-guide.zh-CN.md`: explain old Run discovery and read-only behavior.

### Task 1: Terminal Run Model

**Files:**
- Create: `apps/renderer/src/features/terminal/terminalRunModel.test.ts`
- Create: `apps/renderer/src/features/terminal/terminalRunModel.ts`

- [ ] **Step 1: Write failing bindability, sorting, and filtering tests**

Create tests with two active Runs and two ended Runs:

```ts
import { describe, expect, it, vi } from "vitest";

import {
  buildTerminalRunOptions,
  filterTerminalRunOptions,
  isTerminalRunBindable,
  loadAllTerminalRuns,
} from "./terminalRunModel";

describe("terminalRunModel", () => {
  it("keeps the active Run first and marks terminal states read-only", () => {
    const options = buildTerminalRunOptions([
      run("run-old", "DONE", "2026-08-01T00:00:00Z", "Old workflow", "1"),
      run("run-live", "IN_PROGRESS", "2026-08-02T00:00:00Z", "Current workflow", "2"),
      run("run-paused", "PAUSED", "2026-08-03T00:00:00Z", "Current workflow", "2"),
    ], "run-live");

    expect(options.map((item) => item.id)).toEqual(["run-live", "run-paused", "run-old"]);
    expect(options.find((item) => item.id === "run-old")?.bindable).toBe(false);
    expect(isTerminalRunBindable("ARCHIVED")).toBe(false);
    expect(isTerminalRunBindable("BLOCKED")).toBe(true);
  });

  it("searches title and ID and hides ended Runs by default", () => {
    const options = buildTerminalRunOptions([
      run("run-release", "IN_PROGRESS", "2026-08-02T00:00:00Z", "Release", "2"),
      run("run-legacy", "DONE", "2026-08-01T00:00:00Z", "Legacy", "1"),
    ], null);

    expect(filterTerminalRunOptions(options, "", false).map((item) => item.id)).toEqual(["run-release"]);
    expect(filterTerminalRunOptions(options, "legacy", true).map((item) => item.id)).toEqual(["run-legacy"]);
    expect(filterTerminalRunOptions(options, "run-release", true).map((item) => item.id)).toEqual(["run-release"]);
  });
});
```

Use a local `run(...)` fixture that returns a complete `RunSummaryProjection` with `workflowVersionId`, `workflowName`, `workflowVersion`, status, workspace, progress, and timestamps.

- [ ] **Step 2: Run the model test and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer run test -- src/features/terminal/terminalRunModel.test.ts
```

Expected: FAIL because `terminalRunModel.ts` does not exist.

- [ ] **Step 3: Implement the option model and pure filtering**

Create:

```ts
import type { RunListResponse, RunSummaryProjection, RunStatus } from "@workflow-platform/contracts";

export type TerminalRunOption = {
  id: string;
  title: string;
  status: RunStatus;
  workflowName: string;
  workflowVersion: string;
  createdAt: string;
  bindable: boolean;
};

const BINDABLE_STATUSES = new Set<RunStatus>([
  "CREATED",
  "IN_PROGRESS",
  "REVIEWING",
  "BLOCKED",
  "PAUSED",
]);

export function isTerminalRunBindable(status: string): boolean {
  return BINDABLE_STATUSES.has(status as RunStatus);
}

export function buildTerminalRunOptions(
  runs: RunSummaryProjection[],
  activeRunId: string | null,
): TerminalRunOption[] {
  return runs
    .map((run) => ({
      id: run.id,
      title: run.title,
      status: run.status,
      workflowName: run.workflowName,
      workflowVersion: run.workflowVersion,
      createdAt: run.createdAt,
      bindable: isTerminalRunBindable(run.status),
    }))
    .sort((left, right) => {
      if (left.id === activeRunId) return -1;
      if (right.id === activeRunId) return 1;
      return right.createdAt.localeCompare(left.createdAt);
    });
}

export function filterTerminalRunOptions(
  options: TerminalRunOption[],
  query: string,
  showEnded: boolean,
): TerminalRunOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  return options.filter((option) => {
    if (!showEnded && !option.bindable) return false;
    if (!normalized) return true;
    return option.title.toLocaleLowerCase().includes(normalized)
      || option.id.toLocaleLowerCase().includes(normalized);
  });
}
```

- [ ] **Step 4: Add a failing pagination test**

Append:

```ts
it("loads every project Run page and rejects a repeated cursor", async () => {
  const loadPage = vi.fn()
    .mockResolvedValueOnce({ items: [run("run-new", "IN_PROGRESS", "2026-08-02T00:00:00Z", "Current", "2")], nextCursor: "page-2" })
    .mockResolvedValueOnce({ items: [run("run-old", "DONE", "2026-08-01T00:00:00Z", "Legacy", "1")], nextCursor: null });

  await expect(loadAllTerminalRuns(loadPage)).resolves.toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "run-new" }),
    expect.objectContaining({ id: "run-old" }),
  ]));
  expect(loadPage.mock.calls).toEqual([[undefined], ["page-2"]]);

  const repeated = vi.fn()
    .mockResolvedValueOnce({ items: [], nextCursor: "same" })
    .mockResolvedValueOnce({ items: [], nextCursor: "same" });
  await expect(loadAllTerminalRuns(repeated)).rejects.toThrow("Repeated project Run cursor: same");
});
```

- [ ] **Step 5: Run the test and verify RED**

Expected: FAIL because `loadAllTerminalRuns` is missing.

- [ ] **Step 6: Implement guarded project pagination**

Add:

```ts
export async function loadAllTerminalRuns(
  loadPage: (cursor?: string) => Promise<RunListResponse>,
): Promise<RunSummaryProjection[]> {
  const runs: RunSummaryProjection[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await loadPage(cursor);
    runs.push(...page.items);
    const nextCursor = page.nextCursor ?? undefined;
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new Error(`Repeated project Run cursor: ${nextCursor}`);
    }
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);
  return runs;
}
```

- [ ] **Step 7: Run the model tests and verify GREEN**

Expected: all `terminalRunModel` tests pass.

### Task 2: Terminal Selector, Read-Only Runs, and Run-Scoped History

**Files:**
- Modify: `apps/renderer/src/features/terminal/TerminalPage.test.tsx`
- Modify: `apps/renderer/src/features/terminal/TerminalPage.tsx`

- [ ] **Step 1: Write failing search and ended-Run visibility tests**

Render options containing `IN_PROGRESS`, `DONE`, and `ARCHIVED`. Assert:

```ts
expect(screen.getByRole("option", { name: /Active Run.*IN_PROGRESS.*Workflow 2/ })).toBeInTheDocument();
expect(screen.queryByRole("option", { name: /Done Run/ })).not.toBeInTheDocument();

fireEvent.click(screen.getByLabelText("显示已结束 Run"));
expect(screen.getByRole("option", { name: /Done Run.*DONE.*Workflow 1/ })).toBeInTheDocument();

fireEvent.change(screen.getByLabelText("搜索 Run"), { target: { value: "archived-id" } });
expect(screen.getByRole("option", { name: /Archived Run/ })).toBeInTheDocument();
expect(screen.queryByRole("option", { name: /Done Run/ })).not.toBeInTheDocument();
```

Pass complete `TerminalRunOption` values including status, workflow metadata, `createdAt`, and `bindable`.

- [ ] **Step 2: Run TerminalPage tests and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer run test -- src/features/terminal/TerminalPage.test.tsx
```

Expected: FAIL because search and ended-Run controls are absent.

- [ ] **Step 3: Add filtering controls and descriptive option labels**

Import `filterTerminalRunOptions` and `TerminalRunOption` from `terminalRunModel`. Replace the local two-field option type. Track:

```ts
const [runQuery, setRunQuery] = useState("");
const [showEndedRuns, setShowEndedRuns] = useState(false);
const visibleRunOptions = filterTerminalRunOptions(runOptions, runQuery, showEndedRuns);
```

Render `搜索 Run` as a text input and `显示已结束 Run` as a checkbox. Format options as:

```ts
`${option.title} · ${option.status} · ${option.workflowName} ${option.workflowVersion} · ${option.createdAt}`
```

Always retain the currently selected option in the rendered list, even when a filter changes, so the controlled select never points at a missing value.

- [ ] **Step 4: Write a failing read-only Run test**

Select a `DONE` option after enabling ended Runs and assert:

```ts
expect(await screen.findByText("该 Run 已结束，仅支持查看终端历史")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "创建终端" })).toBeDisabled();
expect(screen.queryByRole("button", { name: "绑定到 Run" })).not.toBeInTheDocument();
expect(onRegisterSession).not.toHaveBeenCalled();
```

Also render a live standalone terminal before selecting `DONE` to prove an existing terminal cannot be attached to it.

- [ ] **Step 5: Run the read-only test and verify RED**

Expected: FAIL because ended Run bindability is not enforced.

- [ ] **Step 6: Enforce bindability in every mutation path**

Derive:

```ts
const selectedRun = runOptions.find((option) => option.id === selectedRunId) ?? null;
const selectedRunBindable = !selectedRunId || selectedRun?.bindable === true;
```

Guard `registerAndBind`, disable terminal creation when a selected Run is not bindable, hide `绑定到 Run` for a read-only selection, and show `该 Run 已结束，仅支持查看终端历史`. Unknown selected Run IDs are treated as read-only unless they are the explicit legacy `runId` prop with no option metadata.

- [ ] **Step 7: Write a failing selected-Run history test**

Change the callback contracts to the wished-for API in the test:

```ts
const onLoadRunSessions = vi.fn(async (runId: string) => runId === "run-old" ? [historySession] : []);
const onLoadHistoryOutput = vi.fn(async (runId: string, sessionId: string) => [historyOutput]);
```

Select `run-old`, assert `onLoadRunSessions("run-old")`, choose the returned history session, load output, and assert:

```ts
expect(onLoadHistoryOutput).toHaveBeenCalledWith("run-old", "history-old");
expect(await screen.findByText("old output")).toBeInTheDocument();
```

- [ ] **Step 8: Run the selected-Run history test and verify RED**

Expected: FAIL because history is still supplied globally and output loading receives only a session ID.

- [ ] **Step 9: Implement selected-Run history loading with stale-request protection**

Add props:

```ts
onLoadRunSessions?: (runId: string) => Promise<TerminalSessionSummary[]>;
onLoadHistoryOutput?: (runId: string, sessionId: string) => Promise<TerminalOutputEvent[]>;
```

Track displayed sessions separately from the initial `historySessions` prop. In `selectRun`, increment a request token, clear the selected history session, and load nodes plus sessions for the selected Run. Apply results only when the token still matches and the terminal has not become bound. Call history output with `selectedHistorySession.runId` and its ID.

On failure, keep standalone terminal creation available and set an actionable page message without changing an existing binding.

- [ ] **Step 10: Add failing Run-list retry UI test**

Pass:

```tsx
runOptionsError="读取项目 Run 失败"
onRetryRunOptions={onRetryRunOptions}
```

Assert the alert is visible, standalone `创建终端` remains enabled, and clicking `重新加载 Run` calls the retry callback.

- [ ] **Step 11: Implement loading/error/retry props**

Add:

```ts
runOptionsLoading?: boolean;
runOptionsError?: string;
onRetryRunOptions?: () => void;
```

Disable only the Run selector while loading. Render the error with `role="alert"` and a `重新加载 Run` button. Do not disable standalone terminal creation because project Run discovery failed.

- [ ] **Step 12: Run TerminalPage and viewport tests and verify GREEN**

Run:

```powershell
npm.cmd --workspace apps/renderer run test -- src/features/terminal/TerminalPage.test.tsx src/features/terminal/TerminalViewport.test.tsx
```

Expected: all selected tests pass, including standalone log export, active binding, backfill, post-binding polling, and read-only history.

### Task 3: App Project-Level Loading and Wiring

**Files:**
- Modify: `apps/renderer/src/app/App.test.tsx`
- Modify: `apps/renderer/src/app/App.tsx`

- [ ] **Step 1: Write a failing paginated old-Run integration test**

Extend the Terminal integration test so `/projects/project-1/runs?limit=100` returns an active Run and `nextCursor: "older"`; the cursor request returns a `DONE` Run whose `workflowVersionId` differs from the current binding.

Assert:

```ts
expect(await screen.findByRole("option", { name: /当前 Run.*IN_PROGRESS/ })).toBeInTheDocument();
fireEvent.click(screen.getByLabelText("显示已结束 Run"));
expect(await screen.findByRole("option", { name: /旧 Run.*DONE.*旧工作流 1/ })).toBeInTheDocument();
expect(requests).toContain("/projects/project-1/runs?limit=100");
expect(requests).toContain("/projects/project-1/runs?cursor=older&limit=100");
```

Also assert the current `/workflow-versions/workflow-version-1/runs` response is empty, proving the option came from the project endpoint.

- [ ] **Step 2: Run App tests and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer run test -- src/app/App.test.tsx
```

Expected: FAIL because Terminal still receives the workflow-version `runs` state.

- [ ] **Step 3: Add independent terminal Run state and paginated loader**

In `App`, add:

```ts
const [terminalRuns, setTerminalRuns] = useState<RunSummaryProjection[]>([]);
const [terminalRunsLoading, setTerminalRunsLoading] = useState(false);
const [terminalRunsError, setTerminalRunsError] = useState("");
```

Create a `loadTerminalRuns` callback using `loadAllTerminalRuns`:

```ts
const loadTerminalRuns = useCallback(async () => {
  if (!projectId || state?.connection !== "connected") return;
  setTerminalRunsLoading(true);
  setTerminalRunsError("");
  try {
    const runtimeClient = createRuntimeClient(apiBaseUrl);
    const items = await loadAllTerminalRuns((cursor) =>
      runtimeClient.listProjectRuns(projectId, { ...(cursor ? { cursor } : {}), limit: 100 }),
    );
    setTerminalRuns(items);
  } catch (error) {
    setTerminalRunsError(`读取项目 Run 失败：${errorMessage(error)}`);
  } finally {
    setTerminalRunsLoading(false);
  }
}, [apiBaseUrl, projectId, state?.connection]);
```

Invoke it when Terminal becomes active. Do not replace the existing workflow-version `runs` state because other modules still use it.

- [ ] **Step 4: Wire active sorting, retry, and selected-Run history**

Define:

```ts
const terminalActiveRunId = state?.projection?.runId ?? initialRunId;
const terminalRunOptions = buildTerminalRunOptions(terminalRuns, terminalActiveRunId);
```

Pass `terminalRunOptions`, loading/error/retry props, and:

```tsx
onLoadRunSessions={(runId) => client.listTerminalSessions(projectId, runId)}
onLoadHistoryOutput={(runId, sessionId) =>
  client.listTerminalOutput(projectId, runId, sessionId)
}
```

Change the initial Terminal history effect to use `terminalActiveRunId`. Keep register and stop refreshes scoped to the Run supplied by `TerminalPage`.

- [ ] **Step 5: Add an old-Run history integration assertion**

Select the `DONE` old Run, mock `/projects/project-1/runs/run-old/terminals` with one session, load its output, and assert every request uses `run-old`. Assert no POST registration request is sent for `run-old`.

- [ ] **Step 6: Run App and Terminal tests and verify GREEN**

Run:

```powershell
npm.cmd --workspace apps/renderer run test -- src/app/App.test.tsx src/features/terminal/TerminalPage.test.tsx
```

Expected: all selected tests pass.

### Task 4: Guide and Final Verification

**Files:**
- Modify: `docs/full-feature-local-delivery-workflow-guide.zh-CN.md`

- [ ] **Step 1: Update the Terminal guide**

Document:

- Active project Runs are shown by default, regardless of workflow version.
- Search accepts Run name or Run ID.
- `显示已结束 Run` reveals `DONE` and `ARCHIVED` Runs.
- Ended Runs can load terminal history and output but cannot create or bind a terminal.
- Select an active Run and node to create new Run-bound terminal evidence.

- [ ] **Step 2: Run focused regression tests**

```powershell
npm.cmd --workspace apps/renderer run test -- src/features/terminal/terminalRunModel.test.ts src/features/terminal/TerminalPage.test.tsx src/features/terminal/TerminalViewport.test.tsx src/app/App.test.tsx
```

Expected: exit code 0 with no failed tests.

- [ ] **Step 3: Run the complete project test suite**

```powershell
npm.cmd test
```

Expected: contracts, renderer, and desktop suites pass; only the three intentional legacy `WorkflowViewer` skips remain.

- [ ] **Step 4: Run the production build**

```powershell
npm.cmd run build
```

Expected: contracts, renderer TypeScript/Vite, and desktop TypeScript builds exit 0. The existing Vite chunk-size warning is non-blocking.

- [ ] **Step 5: Check formatting only in files from this feature**

```powershell
git diff --check -- apps/renderer/src/features/terminal/terminalRunModel.ts apps/renderer/src/features/terminal/terminalRunModel.test.ts apps/renderer/src/features/terminal/TerminalPage.tsx apps/renderer/src/features/terminal/TerminalPage.test.tsx apps/renderer/src/app/App.tsx apps/renderer/src/app/App.test.tsx docs/full-feature-local-delivery-workflow-guide.zh-CN.md
```

Also use `Select-String -Pattern '[ \t]+$'` on the two new untracked files because `git diff --check` does not inspect untracked content.
