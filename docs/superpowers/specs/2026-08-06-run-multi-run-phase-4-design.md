# Run Multi-Run Phase 4 Design

**Status:** Approved from the source architecture contract

**Scope:** Project-scoped Run context across Agent, terminal, deployment, artifact, gate, approval, audit, recovery, and project overview surfaces

**Source of truth:** `docs/run-multi-run-rearchitecture.zh-CN.md`, especially sections 4, 6.5, 8, 9, 10, 12, 13, 18, 20, 21, and 22

## Goal

Carry the project-scoped Run model beyond the list and detail pages. Every Run child page and Runtime operation derives its authoritative context from the URL, validates both project-to-Run and Run-to-child ownership, owns isolated asynchronous state, and returns to the same Run detail. Remove the remaining writable routes whose authorization scope is only a `runId`.

Phase 4 also makes the project page a useful entry point by showing project-level Run activity and recent Runs from summary data already owned by the project.

## Scope Boundaries

Phase 4 includes:

- a shared Renderer `RunContext` route contract with `projectId`, `runId`, and optional `jobId`;
- canonical Agent terminal routing at `#/runs/:runId/terminal/:jobId`;
- encoded project and Run context on artifact, gate, approval, deployment, audit, and recovery routes;
- project-scoped Runtime routes for every Agent, terminal, deployment, artifact, gate, approval, timeline/audit, and recovery read or write used by these pages;
- service-layer ownership checks for project, Run, and child resources before reads or writes;
- removal of unscoped writable Run child routes after all Renderer consumers migrate;
- isolated, abortable, stale-response-safe page state for every secondary surface;
- archived/read-only handling and consistent return links to the same Run detail;
- project overview data for active Run count and recent Runs without per-row detail requests;
- end-to-end navigation coverage for terminal and artifact round trips.

Phase 4 does not include:

- worktree discovery, recommendation ranking, creation guidance, concurrency-limit settings, or resilience hardening assigned to Phase 5;
- redesigning workflow assets, roles, knowledge, or settings beyond removing accidental dependence on global Run selection;
- preserving compatibility for pre-rearchitecture Run data or old deep links;
- introducing a cross-page global Run store;
- changing the Phase 3 Run detail layout or authorized-action semantics except where links must target the new scoped routes.

## Architecture

### Authoritative Run Context

Renderer uses one immutable value for all Run child surfaces:

```ts
export type RunContext = {
  projectId: string;
  runId: string;
  jobId?: string;
};
```

The URL is authoritative for `runId` and `jobId`. The active imported project supplies `projectId`; secondary query routes must also carry an encoded `projectId` and are rejected when it does not match the active project. Saved session state may help reopen a project but must never replace, repair, or override missing or malformed Run route context.

Route parsing is strict and total: it either returns a complete `RunContext` for the selected surface or an explicit invalid-route result. Empty identifiers, malformed percent encoding, absent required query parameters, and missing terminal `jobId` render a context error. They never fall back to `App.state.projection`, `activeRunId`, the first Run, or the most recently visited Run.

`App` remains the composition boundary. It parses context and injects scoped client functions, stable actors, and navigation callbacks. A secondary page owns its loaded records, loading phase, errors, request generation, and selection state.

### Runtime Ownership Boundary

Every scoped service operation begins with the same two checks:

1. Load `runId` through `projectId`; if the Run does not belong to the project, return `RUN_NOT_FOUND_IN_PROJECT` without revealing whether it exists elsewhere.
2. When a child identifier is supplied, load it through the validated Run and reject a record owned by another Run as not found.

Write operations then retain their existing domain authorization: project/Run archive state, expected revision, actor trust or role, workspace lease and mode, allowed action, and child lifecycle checks. Moving the route is not authorization by itself.

A focused service helper may centralize scoped Run lookup and child ownership checks. Domain methods stay responsible for their own transition rules. No endpoint accepts a client-provided project association for a child record.

## Route Contract

Canonical Renderer routes are:

| Surface | Route | Required context |
| --- | --- | --- |
| Run detail | `#/runs/:runId` | active `projectId`, path `runId` |
| Agent terminal | `#/runs/:runId/terminal/:jobId` | active `projectId`, path `runId`, path `jobId` |
| Artifacts | `#/artifacts?projectId=:projectId&runId=:runId` | query `projectId`, query `runId` |
| Gates | `#/gates?projectId=:projectId&runId=:runId` | query `projectId`, query `runId` |
| Approvals | `#/approvals?projectId=:projectId&runId=:runId` | query `projectId`, query `runId` |
| Deployment | `#/deployment?projectId=:projectId&runId=:runId` | query `projectId`, query `runId` |
| Timeline/audit | `#/audit?projectId=:projectId&runId=:runId` | query `projectId`, query `runId` |
| Recovery | `#/recovery?projectId=:projectId&runId=:runId` | query `projectId`, query `runId` |

All identifiers are encoded with `encodeURIComponent` and decoded exactly once. Route builders, rather than page-local string concatenation, produce these hashes. Every page exposes a return target generated as `#/runs/${encodeURIComponent(runId)}` and preserves the active project.

Top-level navigation to a Run-owned secondary module must include the current scoped context. Opening one of these routes without both identifiers renders the same explicit invalid-link state as any other incomplete deep link. It must not restore a saved/global projection or select a Run on the user's behalf.

## Scoped Runtime API Matrix

All Run-owned routes use `/projects/{projectId}/runs/{runId}` as their prefix. Existing request and response bodies remain stable unless a scoped response envelope is required for revision replacement.

| Resource | Scoped operations required in Phase 4 |
| --- | --- |
| Timeline and reports | list timeline, build report, build evidence package |
| Agents | start/list/get/cancel jobs; list output; list/resume/discard checkpoints; get/start/input/output/end/continue interactive sessions |
| Terminals | create/list sessions; stop; record command decision; append/list output; export output as evidence |
| Deployments | start/list/get/cancel deployments; list incremental output |
| Artifacts | submit/list/preview/confirm; list consumers; scan node artifacts; load node requirements/context; extract knowledge syntheses |
| Gates | list results; submit, retry, or waive only through the existing authorized transition contract |
| Approvals | list tasks; decide with actor and expected revision |
| Audit | list records scoped to the validated project and Run; preserve evidence/event links within that Run |
| Recovery | load diagnostics; rebuild projection; clean orphan Agent jobs; clean orphan terminal sessions; checkpoint recovery operations |

Reads and writes both validate ownership. Cross-project requests and cross-Run child identifiers return 404. The response must not distinguish a missing resource from one outside the requested scope.

Unscoped writable endpoints under `/runs/{runId}/...` are deleted once the scoped client has migrated. Legacy node-completion, gate, approval, Agent, terminal, deployment, artifact, and recovery writes are not compatibility aliases; Run transitions go through the scoped action contract or a scoped resource operation. Unscoped read endpoints used only by migrated Run child pages are deleted as part of the same task so new code cannot silently regress. Project-wide APIs such as provider diagnostics and intentionally global audit administration remain separate only when they do not read or mutate a selected Run.

## Page Ownership

Each secondary page owns a reducer or equivalent pure state with this common shape:

```ts
type ScopedPageState<T> = {
  data: T | null;
  phase: "loading" | "ready" | "refreshing" | "acting" | "not-found" | "maintenance" | "error";
  error: RuntimeClientError | null;
  generation: number;
  lastRefreshedAt: string | null;
};
```

Pages may extend the shape with local selection, incremental output sequence, form values, or confirmation state. They must not read or write `App.state.projection`, `activeRunId`, shared artifact inventory, shared terminal sessions, shared audit records, or shared recovery diagnostics.

### Agent Terminal

The terminal route loads exactly the `jobId` inside its scoped Run, then loads its interactive session and incremental Agent output. An unknown job, a job from another Run, or a job from another project produces not found. The page never substitutes another active job.

Desktop terminal creation remains a two-sided operation: Runtime authorizes the scoped Run/job and its writable lease before the Renderer asks the desktop bridge to start a process. Persistence calls use the same scoped identifiers. On unmount or route replacement, polling and pending requests stop; desktop process lifecycle remains governed by explicit stop/cancel operations rather than component teardown.

### Artifacts, Gates, and Approvals

These pages load their own Run overview or projection only when needed for display and revision-bound writes. Artifact previews and consumer lookups must match the active request generation. Gate and approval controls derive availability from the current scoped projection and refresh it after a successful write or revision conflict.

Archived projects/Runs remain readable. Artifact, gate, and approval mutation controls disappear in read-only mode; the client does not simulate local success.

### Deployment, Audit, and Recovery

Deployment output is incremental and keyed by the scoped deployment identifier. Audit loads only records attributable to the selected Run. Recovery loads diagnostics for one Run and refreshes them after every successful recovery write.

Recovery and deployment writes preserve trusted actor, lease, lifecycle, and confirmation requirements. A `WORKSPACE_RECOVERY_REQUIRED` response links to the same Run's recovery route.

## Data Flow

For initial page load:

1. Parse and validate the current hash into `RunContext`.
2. Create a new request generation and abort the previous generation.
3. Request the page's scoped resources using `projectId` and `runId`.
4. Runtime validates project/Run ownership before loading child records.
5. Commit the response only when route identity, request generation, and component instance still match.
6. Render a return link to the same Run detail.

For a write:

1. Build the request from the current scoped projection, trusted injected actor, and local form values.
2. Runtime revalidates ownership, archive status, revision, actor, lease, and resource lifecycle.
3. On success, replace returned projection state where applicable and refresh page-owned data.
4. On conflict, discard optimistic assumptions and reload the current Run context.

No navigation or response mutates a global current Run. Switching from Run A to Run B aborts A requests and increments the generation before B data can be accepted.

## Project Overview

The project page displays:

- active Run count for the current project;
- a compact recent Runs list ordered by `updatedAt DESC`;
- a direct link to `#/runs`;
- links from recent rows to their Run detail;
- an independent worktree guidance entry point, without implementing Phase 5 discovery or recommendation logic.

The data source is the project-scoped Run summary endpoint with a bounded limit and status filtering where appropriate. It must not request a projection, terminal output, artifact inventory, or Agent list per row. Archived projects render the overview read-only.

## Refresh and Concurrency

- Initial loads clear data from any previous Run.
- Background and incremental refreshes retain the last trusted data when they fail.
- Every fetch accepts an `AbortSignal`; route changes and unmount abort pending work.
- A monotonically increasing generation rejects responses from older contexts even if abort races.
- Agent, terminal, and deployment output use sequence cursors returned by the Runtime and append only records newer than the accepted sequence.
- Hidden documents pause output polling. Focus or visibility restoration triggers an immediate refresh.
- Page polling stops on not found. Terminal/Agent active output may poll every 1-2 seconds; other active Run child state follows the Phase 3 2-second active and 10-second terminal cadence where applicable.
- No batch refresh changes Run node state or performs writes.

## Error Behavior

| Condition | Renderer behavior |
| --- | --- |
| Missing or malformed route context | Show an explicit invalid-link state with a return to the project Run list; issue no Run child request. |
| `RUN_NOT_FOUND_IN_PROJECT` or child not found | Stop polling, clear data that belongs to another context, and offer return to the Run list. |
| `PROJECT_ARCHIVED` or `RUN_ARCHIVED` | Refresh trusted data, enter read-only mode, and remove mutation controls. |
| `REVISION_CONFLICT` | Retain form input when meaningful, refresh the current Run overview/page data, and explain that state changed. |
| `WORKSPACE_RECOVERY_REQUIRED` | Retain trusted data and link to the same Run's recovery page; never force start. |
| `RUN_REARCHITECTURE_MAINTENANCE` | Show maintenance state; retain the last trusted data during refresh failures and allow delayed manual retry. |
| Network or refresh failure with trusted data | Keep the data visible, mark it stale, and allow retry. |
| Invalid terminal job or child identifier | Show not found; never fall back to another job, session, artifact, deployment, or Run. |

Errors continue using the typed Runtime error envelope and correlation ID. User-entered values are not cleared by validation errors.

## Delivery Boundaries

### 4A: Scoped Foundation

- add strict route parsing/building and `RunContext` tests;
- add common Runtime scoped lookup/ownership behavior;
- add the project-prefixed API surface and scoped Renderer client methods;
- prove encoded identifiers, abort propagation, and cross-project read/write rejection;
- keep pages on their old state only until 4B, without adding new unscoped consumers.

### 4B: Secondary Page Migration

- migrate Agent terminal, terminal persistence, deployments, artifacts, gates, approvals, audit, and recovery to scoped clients;
- give each page isolated state, cancellation, generation checks, explicit errors, read-only behavior, and same-Run return navigation;
- remove migrated dependence on `App.state.projection` and related shared collections;
- remove unscoped writable Run child routes and the migrated unscoped reads;
- preserve all existing lease, actor, revision, and transition authorization.

### 4C: Project Overview and End-to-End Closure

- add active Run count, recent Runs, Run-list entry, and worktree guidance to the project page;
- complete direct and cross-page navigation integration;
- add terminal and artifact same-Run round-trip E2E coverage;
- run full Runtime and Renderer suites, production build, and desktop/narrow visual checks;
- audit Phase 4 against the source contract before declaring completion.

Each boundary is implemented through test-first tasks with an independent commit and review gate. A boundary is not complete while its old state fallback or writable unscoped route remains.

## Testing

Automated tests cover:

- route parsing/building with spaces, slashes, Unicode, reserved characters, malformed encoding, absent query values, and terminal `jobId`;
- scoped client paths, exact request bodies, query encoding, typed error envelopes, and `AbortSignal` propagation;
- service/API cross-project rejection for every resource family and cross-Run rejection for child IDs on both reads and writes;
- archived project/Run read-only behavior and rejection of mutation attempts;
- revision, actor, lease, and action authorization after route migration;
- reducer initial/refresh/action transitions, retained trusted data, aborted requests, stale generation rejection, and context replacement;
- invalid route and invalid terminal job behavior with zero fallback requests;
- Agent/terminal/deployment incremental output isolation and sequence handling;
- artifact preview/consumer stale-response rejection;
- gate, approval, and recovery refresh after writes and revision conflict;
- project overview active count/recent ordering with no per-row detail calls;
- App integration proving migrated pages make no unscoped Runtime calls and do not consume saved/global projection state;
- terminal and artifact navigation from Run detail and back to the exact same Run;
- desktop and narrow viewport layouts with no overlap or horizontal overflow.

Existing relevant Runtime and Renderer suites run after every boundary. Phase 4 closes only after the full Runtime suite, full Renderer suite, production build, and browser geometry checks pass, with any pre-existing warnings documented.

## Completion Criteria

Phase 4 is complete when every Run-owned secondary API and page is scoped by `projectId + runId`, every child identifier is verified under that Run, canonical terminal routing includes `jobId`, pages own isolated abortable state, invalid context never falls back to global selection, archived Runs are read-only, navigation returns to the same Run, the project page shows summary-only Run activity, unscoped writable Run child routes are gone, all focused and full verification passes, and the original source document remains untracked.
