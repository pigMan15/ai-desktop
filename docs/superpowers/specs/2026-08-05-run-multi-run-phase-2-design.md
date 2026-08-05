# Run Multi-Run Phase 2 Design

**Status:** Approved for implementation planning

**Scope:** Renderer Run list and new-Run routes

**Source of truth:** `docs/run-multi-run-rearchitecture.zh-CN.md`, especially sections 5, 9, 13, 16, 18, 21, and 22

## Goal

Replace the workflow-version-scoped Run selector with a project-scoped Run list at `#/runs`, add a dedicated creation flow at `#/runs/new`, and establish stable `#/runs/:runId` routing without implementing the Phase 3 detail-page redesign.

## Design Direction

This is a dense desktop operations surface for developers. It keeps the existing neutral and teal visual language, compact controls, 5-6px radii, and restrained motion. The page prioritizes scanning, comparison, and repeated action. It does not introduce a marketing layout, a new component framework, decorative cards, or a new color system.

## Scope Boundaries

Phase 2 includes:

- project-scoped list retrieval, filters, refresh, pagination, empty states, and summary rows;
- `#/runs`, `#/runs/new`, and stable recognition of `#/runs/:runId`;
- a dedicated Run creation page using the current project binding and an execution workspace;
- request invalidation when project, route, filters, or page changes;
- immediate navigation to the created Run;
- tests proving list rows do not trigger per-Run detail, projection, Agent, deployment, or terminal requests.

Phase 2 does not include:

- the Phase 3 Run detail layout and isolated `RunDetailState` implementation;
- node-level execution controls on the list page;
- migration of every legacy non-core Run API used by existing detail modules;
- filters or sort orders absent from the final Runtime list contract;
- worktree creation, which remains a later integration after the Runtime worktree endpoints exist.

The final contract in sections 16-22 takes precedence over earlier product sketches. The list therefore sends only `status`, `workflowVersionId`, `workspacePath`, `q`, `cursor`, and `limit`. Runtime ordering remains `updatedAt DESC`; the Renderer does not simulate global node-kind, blocker, active-Agent, risk, or alternate sort filters over a partial page.

## Routes

Add a dedicated parser with these results:

```ts
type RunRoute =
  | { mode: "list" }
  | { mode: "new" }
  | { mode: "detail"; runId: string };
```

- `#/runs` returns `list`.
- `#/runs/new` returns `new`.
- `#/runs/:runId` returns `detail` with a decoded, non-empty `runId`.
- Query parameters do not change the route mode.
- Malformed deeper Run paths are unknown routes rather than detail routes.

`normalizeRoute` maps all valid Run routes to the `runs` navigation section. The URL is the only authoritative detail selection. A remembered Run ID may be used only as a navigation convenience and never overrides an explicit route.

## API Client

The Renderer client imports the Phase 0 contract types and exposes:

```ts
listProjectRuns(projectId: string, query: RunListQuery, signal?: AbortSignal): Promise<RunListResponse>

createProjectRun(
  projectId: string,
  idempotencyKey: string,
  request: CreateRunRequest,
  signal?: AbortSignal,
): Promise<CreateRunResponse>
```

The list method builds repeated `status` parameters and treats `cursor` as opaque. The creation method targets `/projects/{projectId}/runs`, sends `Idempotency-Key`, and returns the scoped `{ run, projection, workspace }` response.

The shared request function accepts request metadata instead of inferring every request from body presence. It must support headers and `AbortSignal` while preserving the Desktop bridge path. Runtime error envelopes retain `code`, `message`, `details`, and `correlationId` so the list and creation pages can distinguish maintenance, lease conflict, and ordinary connection failures.

## State Model

Phase 2 introduces a focused list state independent of the existing workbench projection:

```ts
type RunListState = {
  query: RunListQuery;
  items: RunSummaryProjection[];
  nextCursor: string | null;
  phase: "idle" | "loading" | "ready" | "refreshing" | "loading-more";
  lastRefreshedAt: string | null;
  error: RuntimeClientError | null;
};
```

State transitions live in a pure reducer or equivalent pure model:

- initial load replaces items;
- refresh replaces items only after success;
- refresh failure keeps items and `lastRefreshedAt`;
- load-more appends by Run ID and preserves Runtime order;
- query changes clear cursor and begin a new request generation;
- stale responses from an older generation are ignored.

App-level ownership is limited to project/session context and route selection. `RunListPage` owns list query and pagination state. The existing global workbench projection remains temporarily available only for the Phase 3 detail compatibility path.

## List Page

`RunListPage` is an unframed operational page with four regions:

1. A compact heading with current project and bound workflow, plus the new-Run command.
2. A toolbar with search, repeated status selection, workspace filter, refresh icon button, and refresh timestamp.
3. A semantic summary table on desktop and stable row layout on narrow screens.
4. Pagination, loading, error, and empty-state feedback.

Each row renders only `RunSummaryProjection` data:

- title and shortened Run ID;
- workflow name and version;
- passed and total nodes with a compact textual progress indicator;
- current and next node names, including multiple candidates;
- status and first blocker;
- workspace label and lease status;
- active Agent and deployment counts;
- updated timestamp.

The row itself navigates to `#/runs/:runId`. Keyboard activation is supported. Interactive controls stop row navigation. Phase 2 list actions are limited to opening detail; pause, resume, and archive remain on the Phase 3 detail path until scoped action state is available without a per-row request.

Initial empty and filtered empty states are distinct:

- no Runs: `尚无 Run` with a new-Run action;
- active filters with no rows: `没有符合条件的 Run` with a clear-filter action.

A failed refresh keeps the previous rows, displays the error and correlation ID when available, and retains the last successful refresh time.

## New Run Page

`NewRunPage` displays the current project and bound workflow as read-only context. It collects:

- title, required and limited to 120 characters;
- optional task goal;
- JSON parameters, validated as an object;
- execution workspace chosen from already discovered worktrees;
- workspace mode, defaulting to `write`.

When no workflow is bound, the page shows an action back to the workflow library or project binding flow. When no execution workspace is available, submission is disabled with a concrete recovery message.

Each user submission creates one stable idempotency key and reuses it for retries until the form meaningfully changes or creation succeeds. On success, the app stores the Run as the last visited Run and navigates to `#/runs/{runId}`. On maintenance or workspace conflict, the form remains populated and displays the Runtime error without issuing a second implicit request.

## Refresh And Cancellation

The list refreshes immediately on entry, every 10 seconds while the Run list is visible, and immediately when the window regains focus. Polling stops when the route changes, the document is hidden, or the component unmounts.

Every request receives an `AbortSignal` where supported and a monotonically increasing request generation. Cleanup aborts the request and invalidates its generation. A response may update state only when its project ID, query key, and generation still match the active page.

Load-more uses the current opaque cursor. A periodic refresh always starts from the first page and replaces the accumulated list after success; it does not combine an old cursor chain with a new first page.

## Error Handling

The client exposes a typed `RuntimeClientError`. Pages render actionable messages for:

- `RUN_REARCHITECTURE_MAINTENANCE`;
- `WORKSPACE_LEASE_CONFLICT`;
- project or Run not found;
- request validation failures;
- network or Desktop bridge failures.

Errors do not become local state transitions for a Run. The list never infers status, allowed actions, or lease ownership.

## Testing

Automated tests cover:

- route parsing for list, new, detail, query strings, encoded IDs, and malformed paths;
- list query serialization, repeated status values, opaque cursor forwarding, project scoping, and error envelope parsing;
- creation URL, idempotency header, request body, and scoped response;
- pure list-state transitions for load, refresh, refresh failure, query replacement, pagination deduplication, and stale response rejection;
- list rendering of all summary fields, desktop and narrow layouts, keyboard navigation, two empty states, retained rows after refresh failure, and load-more;
- polling only while visible, immediate focus refresh, and cancellation on route/query/project change;
- no per-row projection, detail, Agent, deployment, terminal, artifact, approval, gate, or timeline requests;
- new-Run validation, unbound workflow, missing workspace, idempotent retry, conflict/maintenance errors, and success navigation;
- existing Renderer, contracts, and workspace-wide suites.

## Completion Criteria

Phase 2 is complete when:

- `#/runs` is project-scoped and no longer calls the workflow-version Run list endpoint;
- `#/runs/new` creates through the scoped endpoint with an idempotency key and execution workspace;
- direct `#/runs/:runId` navigation remains recognized and never derives selection from global projection state;
- list polling and request cancellation satisfy section 21.3;
- no list row triggers per-Run detail requests;
- Renderer unit tests, build, and workspace-wide tests pass;
- the original source document remains untracked and unmodified.
