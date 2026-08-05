# Run Multi-Run Phase 3 Design

**Status:** Approved from the source architecture contract

**Scope:** Project-scoped Run detail state, first-screen scheduling information, and authorized actions

**Source of truth:** `docs/run-multi-run-rearchitecture.zh-CN.md`, especially sections 6, 13, 16, 18, 19, 21, and 22

## Goal

Replace the compatibility `RunDashboard` path at `#/runs/:runId` with an isolated, project-scoped detail page. The URL Run ID is authoritative, the page loads one scoped overview, and every state transition is selected from the current projection's `allowedActions`.

## Scope Boundaries

Phase 3 includes:

- a complete typed overview contract containing Run metadata, the immutable workflow snapshot, projection, workspace lease, and activity summary;
- a scoped action response envelope containing the replacement projection and emitted events;
- a reducer-backed `RunDetailState` owned by the detail page rather than `App.state.projection`;
- the fixed first-screen order: back link, identity/status/workspace, progress graph, current step, next-step explanation, and authorized actions;
- direct URL loading, refresh restoration, active/terminal polling cadence, focus refresh, cancellation, and stale-response rejection;
- explicit loading, not-found, maintenance, revision-conflict, archived/read-only, and retained-data refresh states;
- contextual secondary-detail navigation carrying `projectId` and `runId` without migrating every nested API yet.

Phase 3 does not include:

- migrating terminal, artifact, gate, approval, audit, recovery, or deployment APIs and pages; that is Phase 4;
- worktree discovery/recommendation and concurrency configuration; that is Phase 5;
- retaining the workflow-version Run selector or creation form inside the detail page;
- inferring actions, next node state, or success from workflow node kinds in the Renderer.

## Contract

Add shared contract types:

```ts
export type RunRecord = {
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

export type RunActivitySummary = {
  activeAgentCount: number;
  activeDeploymentCount: number;
  lastEventAt: string | null;
};

export type RunOverview = {
  run: RunRecord;
  projection: RunProjection;
  workflow: WorkflowDefinition;
  workspace: WorkspaceLease | null;
  activity: RunActivitySummary;
};
```

`GET /projects/{projectId}/runs/{runId}/overview` returns exactly `RunOverview`. The workflow field is the Run's immutable snapshot, never the current editable workflow asset. Runtime computes activity counts from the Run's active jobs/deployments and derives `lastEventAt` from the latest event when one exists.

`POST /projects/{projectId}/runs/{runId}/actions` accepts `ExecuteRunActionRequest` and returns `ExecuteRunActionResponse`:

```ts
{ projection: RunProjection; emittedEvents: RunEvent[] }
```

The Runtime rejects an absent action ID, revision mismatch, archived project/Run, or cross-project Run before writing an event.

## Detail State

`RunDetailPage` owns a pure reducer state:

```ts
type RunDetailState = {
  overview: RunOverview | null;
  phase: "loading" | "ready" | "refreshing" | "acting" | "not-found" | "maintenance" | "error";
  selectedNodeId: string | null;
  lastRefreshedAt: string | null;
  error: RuntimeClientError | null;
  generation: number;
};
```

Initial load clears stale data. Background refresh retains the last successful overview. A successful action replaces only `overview.projection`, then immediately refreshes the overview so metadata, lease, and activity cannot remain stale. A revision conflict refreshes the overview and shows a state-updated message. Not-found stops polling and offers a return to `#/runs`. Archived responses refresh into read-only mode and hide non-authorized actions.

Every load or action carries a generation and an `AbortSignal`. Project ID, Run ID, route instance, query identity, and generation must still match before a result mutates state.

## Polling

- `CREATED`, `IN_PROGRESS`, `REVIEWING`, `BLOCKED`, and `PAUSED` Runs refresh every 2 seconds while visible.
- `DONE` and `ARCHIVED` Runs refresh every 10 seconds while visible.
- Hidden documents do not poll.
- Focus and transition back to visible trigger an immediate refresh.
- Route/project changes and unmount abort the current browser request and invalidate the generation.
- A refresh failure retains the overview and last refresh timestamp.

## First-Screen Layout

The page remains a dense desktop operations surface using the existing neutral/teal tokens, 5-6px radii, and compact typography.

1. A back link to the project Run list.
2. Run title and short ID, status, project/workflow version, workspace label/mode/lease status, and last refresh time.
3. The existing `RunProgressMap`, using only `overview.workflow` and `overview.projection`.
4. A two-column scheduling band: current-step facts on the left and the authorized action panel on the right. It collapses to one column on narrow screens.
5. An explicit next-step section. One successor shows its name, kind, and edge condition. Multiple successors are labeled as candidates and listed separately. No successor shows the terminal explanation plus Runtime blockers/actions.
6. Secondary-detail links for artifacts, Agents/terminal, gates/approvals, deployment, timeline, audit, and recovery. Links carry both `projectId` and `runId`; Phase 4 makes each destination fully scoped.

Current-step facts include node name/kind, role, goal, required inputs, expected artifacts, completion mode, all matching blocking reasons, execution workspace, and active Agent summary. Missing optional metadata is stated plainly rather than replaced with guessed values.

## Authorized Actions

The page renders only actions present in `overview.projection.allowedActions`. The action ID is the transport identity. Event type is used only for presentation and known payload fields, never to invent availability or a resulting state.

Low-risk actions can execute immediately. Medium/high-risk actions require an explicit confirmation surface. Known payload inputs remain local until submit:

- artifact submission: artifact path/type;
- gate pass: verified evidence URI;
- gate waiver: reason;
- other actions: no payload unless the Runtime contract adds a typed field.

Buttons disappear when the action is absent. Archived/read-only states show no write buttons instead of disabled speculative controls.

## App Integration

`App` supplies only stable context and transport callbacks:

```ts
<RunDetailPage
  key={`${projectId}:${runId}`}
  projectId={projectId}
  runId={runId}
  projectName={projectName}
  loadOverview={loadRunOverview}
  executeAction={executeRunAction}
  onReturnToList={() => { window.location.hash = "#/runs"; }}
/>
```

When the current route is a Run detail, App must not restore or poll legacy global Run state, list workflow-version Runs, or call unscoped projection/timeline/artifact/approval/gate/Agent/deployment endpoints. Other modules may keep their compatibility state until Phase 4, but the detail route does not consume it.

## Testing

Automated tests cover:

- contract type shapes for overview, Run record, activity, and action response;
- Runtime overview workflow snapshot, workspace, activity, cross-project 404, and action response envelope;
- Renderer client encoding, abort propagation, typed errors, exact action body, and scoped paths;
- reducer initial/refresh/action transitions, retained refresh data, stale generations, conflict/not-found/maintenance modes, and node selection reset;
- progress graph branch behavior independent of node array order;
- detail rendering order, current/next facts, multiple candidates, no-successor state, all blockers, workspace/activity, and allowed-action-only controls;
- 2/10-second visible polling, focus refresh, hidden pause, abort/unmount, and project/Run replacement;
- App direct URL integration proving zero legacy detail/list calls and no use of saved/global projection selection;
- desktop and narrow viewport layout with no overlap or horizontal overflow.

## Completion Criteria

Phase 3 is complete when `#/runs/:runId` is entirely project-scoped, reload-safe, reducer-owned, and independent from the global workbench projection; its first screen matches the fixed information order; actions come only from `allowedActions`; active and terminal polling satisfy the contract; all focused and full suites/builds pass; and the original source document remains untracked.
