# Run Multi-Run Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy workflow-version Run selector with a project-scoped Run list at `#/runs`, add scoped Run creation at `#/runs/new`, and preserve stable direct navigation to `#/runs/:runId` for the Phase 3 compatibility detail.

**Architecture:** Add a small Run route parser, explicit Runtime request metadata across the Renderer/Desktop bridge, a typed scoped client, and focused list/new-page components. `RunListPage` owns a pure reducer-backed list state, query, pagination, and refresh lifecycle; `App` supplies current project, binding, worktrees, scoped loaders, navigation, and the temporary existing detail dashboard. No list row loads per-Run detail data.

**Tech Stack:** TypeScript, React 18, Vitest, Testing Library, Electron IPC, native Fetch, existing CSS design language, Lucide React icons.

---

## File Map

- Modify `apps/renderer/src/app/routes.ts` and `routes.test.ts`: parse and normalize Run list/new/detail routes.
- Modify `apps/desktop/src/main/runtime.ts`, `main.ts`, `preload/preload.cts`, `preload/global.d.ts`, and `test/main.test.ts`: carry validated method, body, and headers through Electron IPC.
- Modify `apps/renderer/src/app/runtimeClient.ts` and `runtimeClient.test.ts`: add typed errors and project-scoped list/create calls.
- Create `apps/renderer/src/features/runs/runListModel.ts` and `runListModel.test.ts`: pure request-generation and result transitions.
- Create `apps/renderer/src/features/runs/RunListPage.tsx` and `RunListPage.test.tsx`: summary-only project list.
- Create `apps/renderer/src/features/runs/NewRunPage.tsx` and `NewRunPage.test.tsx`: validated scoped creation form and stable retry key.
- Modify `apps/renderer/src/app/App.tsx`, `App.test.tsx`, and `styles.css`: route integration, scoped loader wiring, compatibility detail selection, and page styling.
- Modify `apps/renderer/package.json` and root `package-lock.json`: install `lucide-react` in the Renderer workspace.

### Task 1: Stable Run Routes

**Files:**
- Modify: `apps/renderer/src/app/routes.ts`
- Test: `apps/renderer/src/app/routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Import `parseRunRoute` and assert the public contract:

```ts
expect(parseRunRoute("#/runs")).toEqual({ mode: "list" });
expect(parseRunRoute("#/runs?status=BLOCKED")).toEqual({ mode: "list" });
expect(parseRunRoute("#/runs/new")).toEqual({ mode: "new" });
expect(parseRunRoute("#/runs/run%2Fone?tab=overview")).toEqual({ mode: "detail", runId: "run/one" });
expect(parseRunRoute("#/runs/")).toEqual({ mode: "unknown" });
expect(parseRunRoute("#/runs/run-1/terminal/job-1")).toEqual({ mode: "unknown" });
expect(normalizeRoute("#/runs/new")).toBe("runs");
expect(normalizeRoute("#/runs/run-1")).toBe("runs");
expect(isKnownRouteHash("#/runs/run-1")).toBe(true);
```

Replace the existing `it.fails` direct-Run assertion with a passing assertion.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd --workspace apps/renderer test -- src/app/routes.test.ts`

Expected: FAIL because `parseRunRoute` does not exist and direct Run routes are not normalized.

- [ ] **Step 3: Implement the parser**

Add this public type and parser, catching malformed URI encodings:

```ts
export type RunRoute =
  | { mode: "list" }
  | { mode: "new" }
  | { mode: "detail"; runId: string }
  | { mode: "unknown" };

export function parseRunRoute(hash: string): RunRoute {
  const pathname = hash.split("?")[0];
  if (pathname === "#/runs") return { mode: "list" };
  if (pathname === "#/runs/new") return { mode: "new" };
  const match = pathname.match(/^#\/runs\/([^/]+)$/);
  if (!match?.[1]) return { mode: "unknown" };
  try {
    const runId = decodeURIComponent(match[1]);
    return runId ? { mode: "detail", runId } : { mode: "unknown" };
  } catch {
    return { mode: "unknown" };
  }
}
```

Use it from `normalizeRoute` and `isKnownRouteHash` without changing workflow routing.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd --workspace apps/renderer test -- src/app/routes.test.ts`

Expected: all route tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/renderer/src/app/routes.ts apps/renderer/src/app/routes.test.ts
git commit -m "feat: add stable run routes"
```

### Task 2: Explicit Desktop Runtime Requests

**Files:**
- Modify: `apps/desktop/src/main/runtime.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/preload/preload.cts`
- Modify: `apps/desktop/src/preload/global.d.ts`
- Test: `apps/desktop/test/main.test.ts`

- [ ] **Step 1: Write failing proxy and IPC tests**

Extend the managed Runtime fetch assertion to call:

```ts
await proxiedRuntime.request({
  path: "/projects/project-1/runs",
  method: "POST",
  headers: { "Idempotency-Key": "create-1" },
  body: { title: "Release" },
});
```

Assert Fetch receives `POST`, JSON content type, `Idempotency-Key`, and the local auth token. Invoke the registered `runtime:request` handler with an options object and assert invalid absolute paths, unsupported methods, and forbidden renderer-supplied auth headers reject before Fetch.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd --workspace apps/desktop test`

Expected: FAIL because the bridge and `RuntimeRequestOptions` do not accept explicit method/headers.

- [ ] **Step 3: Implement explicit request metadata**

Use one serializable shape across all layers:

```ts
export type RuntimeRequestOptions = {
  path: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
};
```

In `main.ts`, validate that the IPC value is a plain object, `path` is a relative API path, method is only GET/POST, header names are allowlisted to `Idempotency-Key`, and header values are strings. Never accept `X-Workflow-Platform-Token` from Renderer. In `ManagedRuntime.request`, merge allowed caller headers with JSON content type and the Desktop-owned local token. Preserve the old default inference only for existing call sites that omit `method`.

Expose this signature from preload and its declaration:

```ts
request(options: RuntimeRequestOptions): Promise<unknown>;
```

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd --workspace apps/desktop test`

Expected: Desktop tests PASS with request headers forwarded and auth spoofing rejected.

- [ ] **Step 5: Build Desktop**

Run: `npm.cmd --workspace apps/desktop run build`

Expected: TypeScript build PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/desktop/src/main/runtime.ts apps/desktop/src/main/main.ts apps/desktop/src/preload/preload.cts apps/desktop/src/preload/global.d.ts apps/desktop/test/main.test.ts
git commit -m "feat: carry runtime request metadata through desktop"
```

### Task 3: Project-Scoped Renderer Runtime Client

**Files:**
- Modify: `apps/renderer/src/app/runtimeClient.ts`
- Test: `apps/renderer/src/app/runtimeClient.test.ts`

- [ ] **Step 1: Write failing list, create, and error tests**

Using the existing Fetch mock harness, assert:

```ts
await client.listProjectRuns("project/a", {
  status: ["BLOCKED", "PAUSED"],
  workflowVersionId: "version/1",
  workspacePath: "G:\\work trees\\one",
  q: "release candidate",
  cursor: "opaque+/=",
  limit: 40,
}, signal);
```

The exact URL must contain encoded project/path values, two `status` parameters, and an unchanged opaque cursor value after URL decoding. For creation, assert `POST /projects/project-1/runs`, `Idempotency-Key: create-1`, the exact `CreateRunRequest` body, and returned `{ run, projection, workspace }`. Add a non-2xx error body and assert `RuntimeClientError` preserves `status`, `code`, `message`, `details`, and `correlationId`. Test both browser Fetch and the Desktop options-object bridge.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd --workspace apps/renderer test -- src/app/runtimeClient.test.ts`

Expected: FAIL because scoped methods, metadata, abort support, and typed errors are absent.

- [ ] **Step 3: Implement the typed request helper**

Import `CreateRunRequest`, `RunListQuery`, `RunListResponse`, `RunProjection`, `RunStatus`, `WorkspaceLease`, `WorkspaceMode`, and `WorkflowDefinition`. Define the actual scoped response locally:

```ts
export type ScopedCreateRunResponse = {
  run: {
    id: string;
    projectId: string;
    workflowVersionId: string;
    workflowSnapshot: WorkflowDefinition;
    title: string;
    context: { taskGoal?: string; parameters?: Record<string, unknown> };
    executionWorkspace: string;
    workspaceMode: WorkspaceMode;
    status: RunStatus;
    createdAt: string;
    updatedAt: string;
  };
  projection: RunProjection;
  workspace: WorkspaceLease;
};
```

Add `RuntimeClientError extends Error` with the five preserved fields. Change the internal request helper to accept `{ method, body, headers, signal }`, send the serializable subset through Desktop, and pass `signal` only to browser Fetch. Parse either a canonical top-level Runtime error or FastAPI `detail` containing that object; use a generic typed error for bridge/network failures.

- [ ] **Step 4: Implement scoped methods**

Serialize query parameters with `URLSearchParams.append`:

```ts
listProjectRuns(projectId, query, signal) {
  const params = new URLSearchParams();
  query.status?.forEach((status) => params.append("status", status));
  if (query.workflowVersionId) params.set("workflowVersionId", query.workflowVersionId);
  if (query.workspacePath) params.set("workspacePath", query.workspacePath);
  if (query.q) params.set("q", query.q);
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.size ? `?${params.toString()}` : "";
  return request<RunListResponse>(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs${suffix}`, { signal });
}
```

Creation explicitly sends method, header, body, and signal. Keep legacy detail methods needed by `RunDashboard` until Phase 3, but list/new routes must not call legacy `/workflow-versions/.../runs` or `/runs` creation.

- [ ] **Step 5: Verify GREEN**

Run: `npm.cmd --workspace apps/renderer test -- src/app/runtimeClient.test.ts`

Expected: runtime client tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/renderer/src/app/runtimeClient.ts apps/renderer/src/app/runtimeClient.test.ts
git commit -m "feat: add scoped run runtime client"
```

### Task 4: Pure Run List State Model

**Files:**
- Create: `apps/renderer/src/features/runs/runListModel.ts`
- Test: `apps/renderer/src/features/runs/runListModel.test.ts`

- [ ] **Step 1: Write failing reducer tests**

Cover initial request, successful replacement, refresh retaining rows until success, refresh error retention, load-more deduplication by ID, query reset, and stale generation rejection. Use actions shaped as:

```ts
{ type: "request-started", kind: "initial" | "refresh" | "load-more", generation: 2 }
{ type: "request-succeeded", kind: "refresh", generation: 2, response, refreshedAt: "2026-08-05T10:00:00Z" }
{ type: "request-failed", generation: 2, error }
{ type: "query-changed", query: { status: ["BLOCKED"], limit: 20 }, generation: 3 }
```

Assert an action whose generation differs from `state.generation` returns the identical state object.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd --workspace apps/renderer test -- src/features/runs/runListModel.test.ts`

Expected: FAIL because the model file does not exist.

- [ ] **Step 3: Implement the reducer**

Export:

```ts
export type RunListState = {
  query: RunListQuery;
  items: RunSummaryProjection[];
  nextCursor: string | null;
  phase: "idle" | "loading" | "ready" | "refreshing" | "loading-more";
  lastRefreshedAt: string | null;
  error: RuntimeClientError | null;
  generation: number;
};

export function createRunListState(query: RunListQuery = { limit: 20 }): RunListState;
export function runListReducer(state: RunListState, action: RunListAction): RunListState;
export function hasActiveRunFilters(query: RunListQuery): boolean;
```

For load-more, append only unseen IDs in response order. Query changes clear items/cursor/error and set `phase: "loading"`. Refresh errors preserve items and `lastRefreshedAt` while returning to `ready` when cached rows exist.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd --workspace apps/renderer test -- src/features/runs/runListModel.test.ts`

Expected: all model tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/renderer/src/features/runs/runListModel.ts apps/renderer/src/features/runs/runListModel.test.ts
git commit -m "feat: add run list state model"
```

### Task 5: Project Run List Page

**Files:**
- Create: `apps/renderer/src/features/runs/RunListPage.tsx`
- Test: `apps/renderer/src/features/runs/RunListPage.test.tsx`
- Modify: `apps/renderer/src/app/styles.css`
- Modify: `apps/renderer/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the icon dependency**

Run: `npm.cmd install lucide-react --workspace apps/renderer`

Expected: `lucide-react` appears in Renderer dependencies and the lockfile changes only for that package.

- [ ] **Step 2: Write failing page tests**

Render the page with representative `RunSummaryProjection` rows returned by an injected loader. Assert title/short ID, workflow/version, progress, multiple current/next nodes, blocker, workspace lease, active Agent/deployment counts, updated time, row click and Enter/Space navigation, and button event propagation. Assert the component calls only the injected project-scoped loader and never constructs a Runtime client or requests per-Run resources.

Add separate tests for:

```ts
expect(screen.getByText("尚无 Run")).toBeInTheDocument();
expect(screen.getByText("没有符合条件的 Run")).toBeInTheDocument();
expect(screen.getByText(/上次刷新/)).toBeInTheDocument();
expect(screen.getByRole("alert")).toHaveTextContent("correlation-1");
```

Also test search/status/workspace filters, clear filters, refresh, new Run, and load more. With fake timers and controllable promises, test 10-second visible polling, focus refresh, paused polling while hidden, cleanup abort, stale project/query response rejection, and retained rows after refresh failure.

- [ ] **Step 3: Verify RED**

Run: `npm.cmd --workspace apps/renderer test -- src/features/runs/RunListPage.test.tsx`

Expected: FAIL because the page does not exist.

- [ ] **Step 4: Implement the page**

Use props that inject transport while keeping list state and lifecycle in the page:

```ts
type RunListPageProps = {
  projectId: string;
  projectName: string;
  workflowName?: string;
  workspaces: Array<{ path: string; label: string }>;
  loadRuns(query: RunListQuery, signal: AbortSignal): Promise<RunListResponse>;
  onOpenRun(runId: string): void;
  onNewRun(): void;
};
```

Use `useReducer(runListReducer)` for query, pagination, request phase, and generation. Use semantic table markup on desktop, CSS grid rows on narrow screens, native multi-select/checklist status controls, a search input, workspace select, `RefreshCw` and `Plus` icons, and `title`/accessible names on icon buttons. Render initial loading separately from both empty states. A retained-data error is an inline alert above existing rows.

For every request, increment a generation ref, abort the superseded browser request, and dispatch only if project ID, stable query key, route-mounted instance, and generation still match. Initial load and refresh omit cursor; load-more includes only the current opaque cursor. Desktop IPC cannot stop the underlying request, so generation rejection remains mandatory even though browser Fetch receives the signal.

While mounted and `document.visibilityState === "visible"`, schedule a 10-second interval. Listen for `focus` and `visibilitychange`; focus or becoming visible performs an immediate first-page refresh. Cleanup clears the interval, removes listeners, aborts Fetch, and invalidates the generation.

- [ ] **Step 5: Add restrained responsive styles**

Extend existing CSS variables and patterns. Keep radii at 5-6px, teal accent, stable grid tracks, no nested cards, no gradients, and no oversized display text. At narrow widths, turn each row into a stable labeled grid without horizontal overlap.

- [ ] **Step 6: Verify GREEN**

Run: `npm.cmd --workspace apps/renderer test -- src/features/runs/RunListPage.test.tsx`

Expected: page tests PASS without act warnings.

- [ ] **Step 7: Commit**

```powershell
git add apps/renderer/src/features/runs/RunListPage.tsx apps/renderer/src/features/runs/RunListPage.test.tsx apps/renderer/src/app/styles.css apps/renderer/package.json package-lock.json
git commit -m "feat: add project run list page"
```

### Task 6: New Run Page

**Files:**
- Create: `apps/renderer/src/features/runs/NewRunPage.tsx`
- Test: `apps/renderer/src/features/runs/NewRunPage.test.tsx`
- Modify: `apps/renderer/src/app/styles.css`

- [ ] **Step 1: Write failing form tests**

Test required title, 120-character boundary, parameters parsing only a JSON object (reject arrays/scalars), default write mode, required workspace, unbound workflow action, no-workspace recovery text, disabled duplicate submission, and preserved values after `RuntimeClientError`.

For idempotency, inject `createIdempotencyKey` and assert:

```ts
await user.click(screen.getByRole("button", { name: "创建 Run" }));
await rejectedCreate;
await user.click(screen.getByRole("button", { name: "重试创建" }));
expect(onCreate.mock.calls[0][0].idempotencyKey).toBe("key-1");
expect(onCreate.mock.calls[1][0].idempotencyKey).toBe("key-1");
await user.type(screen.getByLabelText("运行目标"), " changed");
await user.click(screen.getByRole("button", { name: "重试创建" }));
expect(onCreate.mock.calls[2][0].idempotencyKey).toBe("key-2");
```

Assert success calls `onCreated(run.id)` once.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd --workspace apps/renderer test -- src/features/runs/NewRunPage.test.tsx`

Expected: FAIL because the page does not exist.

- [ ] **Step 3: Implement the form**

Use explicit context and submission props:

```ts
type NewRunPageProps = {
  project: { id: string; name: string };
  binding: { workflowVersionId: string; workflowName: string } | null;
  workspaces: Array<{ path: string; branch: string; isMain: boolean }>;
  actor: Actor;
  createIdempotencyKey?: () => string;
  onCreate(input: { idempotencyKey: string; request: CreateRunRequest }): Promise<ScopedCreateRunResponse>;
  onCreated(runId: string): void;
  onCancel(): void;
  onOpenWorkflowLibrary(): void;
};
```

Generate one key on submit and retain it in a ref together with a canonical form fingerprint. Reuse it only while title, goal, parameters text, workspace, mode, workflow version, and project are unchanged. Reset after success. Keep form values and render canonical Runtime error messages/correlation IDs after failure.

- [ ] **Step 4: Verify GREEN**

Run: `npm.cmd --workspace apps/renderer test -- src/features/runs/NewRunPage.test.tsx`

Expected: all creation tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add apps/renderer/src/features/runs/NewRunPage.tsx apps/renderer/src/features/runs/NewRunPage.test.tsx apps/renderer/src/app/styles.css
git commit -m "feat: add scoped run creation page"
```

### Task 7: App Route Integration

**Files:**
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/App.test.tsx`

- [ ] **Step 1: Write failing integration tests**

Add focused App tests for these observable requests and routes:

1. `#/runs` calls only `GET /projects/{projectId}/runs?limit=20` for list data and renders summaries.
2. No list row causes requests containing `/projection`, `/overview`, `/agents`, `/deployments`, `/terminal`, `/artifacts`, `/approvals`, `/gates`, or `/timeline`.
3. Clicking new navigates to `#/runs/new`; successful scoped POST with `Idempotency-Key` navigates to `#/runs/{runId}` and records the last visited Run.
4. Direct `#/runs/run-1` renders the existing `RunDashboard` compatibility detail using URL `runId`, never `state.projection.id` as route selection.
5. Route and project changes unmount/remount the list page with the new scoped loader.
6. A failed refresh rendered by the page leaves existing rows and timestamp visible.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd --workspace apps/renderer test -- src/app/App.test.tsx`

Expected: new integration tests FAIL because App still uses `listRunsForWorkflowVersion` and the combined dashboard.

- [ ] **Step 3: Integrate Run route selection**

Derive `const runRoute = parseRunRoute(currentHash)`. Render:

```tsx
runRoute.mode === "list" ? <RunListPage ... />
  : runRoute.mode === "new" ? <NewRunPage ... />
  : runRoute.mode === "detail" ? <RunDashboard activeRunId={runRoute.runId} ... />
  : null
```

Use current project ID/name, current project binding, and already loaded `gitWorktrees`. Creation calls `createProjectRun`, records the resulting ID in existing session storage, then sets `window.location.hash` to the encoded detail route. Do not create worktrees in this phase.

- [ ] **Step 4: Inject project-scoped list loading**

Pass a memoized or stable callback that delegates only to the scoped client:

```ts
loadRuns={(query, signal) =>
  createRuntimeClient(apiBaseUrl).listProjectRuns(activeProject.id, query, signal)
}
```

Remove the `#/runs` effect that calls `listRunsForWorkflowVersion`. Keep only the legacy detail data needed when `runRoute.mode === "detail"`; route and project changes naturally unmount or replace the list instance.

- [ ] **Step 5: Wire scoped creation**

Pass `NewRunPage` a callback that calls `createProjectRun(activeProject.id, idempotencyKey, request)`. On success, persist the last visited Run ID and navigate to the encoded detail hash. On failure, allow the page to retain the form and retry key; do not issue an implicit second request.

- [ ] **Step 6: Verify GREEN**

Run: `npm.cmd --workspace apps/renderer test -- src/app/App.test.tsx`

Expected: all App tests PASS, including zero per-row detail requests.

- [ ] **Step 7: Run focused Renderer suite**

Run: `npm.cmd --workspace apps/renderer test -- src/app/routes.test.ts src/app/runtimeClient.test.ts src/features/runs/runListModel.test.ts src/features/runs/RunListPage.test.tsx src/features/runs/NewRunPage.test.tsx src/app/App.test.tsx`

Expected: all Phase 2 Renderer tests PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/renderer/src/app/App.tsx apps/renderer/src/app/App.test.tsx
git commit -m "feat: integrate project scoped run routes"
```

### Task 8: Phase 2 Verification

**Files:**
- No production changes expected; fix only regressions demonstrated by failing tests, always with a failing regression test first.

- [ ] **Step 1: Run Renderer tests**

Run: `npm.cmd --workspace apps/renderer test`

Expected: all Renderer tests PASS with no unhandled rejection or act warning.

- [ ] **Step 2: Build Renderer**

Run: `npm.cmd --workspace apps/renderer run build`

Expected: TypeScript and Vite build PASS.

- [ ] **Step 3: Run Desktop tests and build**

Run: `npm.cmd --workspace apps/desktop test`

Run: `npm.cmd --workspace apps/desktop run build`

Expected: both PASS.

- [ ] **Step 4: Run workspace tests and build**

Run: `npm.cmd test`

Run: `npm.cmd run build`

Expected: contracts, Renderer, Desktop tests and all builds PASS.

- [ ] **Step 5: Verify source integrity and scope**

Run: `git diff --check`

Run: `git status --short`

Run: `git log --oneline -12`

Expected: no whitespace errors; only `docs/run-multi-run-rearchitecture.zh-CN.md` remains untracked; each Phase 2 task has an independent commit.

- [ ] **Step 6: Final review**

Review the full Phase 2 commit range against `docs/superpowers/specs/2026-08-05-run-multi-run-phase-2-design.md` and sections 18.1, 18.2, 21.1, 21.3, and 22.1 of the source document. Confirm no legacy list/create endpoint is called from list/new routes, no summary row triggers detail requests, and Phase 3 detail redesign has not leaked into scope.
