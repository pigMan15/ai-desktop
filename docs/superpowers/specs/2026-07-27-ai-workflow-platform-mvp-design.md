# AI Workflow Platform MVP Design

## Context

This design implements the MVP described by:

- `docs/ai-workflow-platform-development-spec.zh-CN.md`
- `docs/ai-workflow-platform-implementation-plan.zh-CN.md`

The product is a general AI engineering workflow platform, not a `.harness` editor, not a single terminal, and not a fixed process board. The MVP must preserve the platform boundary:

- Files are imported protocols.
- Adapters translate protocols into the canonical model.
- Workflow Kernel is the trusted state transition boundary.
- Runtime events are the source of truth.
- Projections drive the UI.
- Human approval, gates, artifacts, and evidence cannot be bypassed by Renderer, Terminal, or Agent execution.

## Approved Direction

Proceed with the implementation document's M1-M6 MVP sequence as a single coherent product track:

1. M1: Foundation and contracts
2. M2: Canonical model and adapter
3. M3: Event store and kernel
4. M4: Approval, gate, and artifact
5. M5: Terminal and agent provider
6. M6: UI MVP

This is not a separate route from the implementation document. It is the execution strategy for that document: build the full MVP trunk first, keep every milestone runnable and testable, and avoid isolated UI demos or runtime-only islands.

## Architecture

The repository will use the documented monorepo shape:

```text
apps/
  desktop/
    src/
      main/
      preload/
  renderer/
    src/
      app/
      features/
        projects/
        workflow/
        runs/
        terminal/
        gates/
        artifacts/
        approvals/
        recovery/
        settings/
packages/
  contracts/
    src/
      rpc.ts
      workflow.ts
      events.ts
      errors.ts
runtime/
  src/
    workflow_platform/
      main.py
      api/
      adapters/
      kernel/
      compiler/
      execution/
      persistence/
      artifacts/
      gates/
      approvals/
      terminals/
      recovery/
      security/
  tests/
docs/
scripts/
```

Layer responsibilities:

- Electron desktop shell owns the desktop app process, preload bridge, and local runtime lifecycle.
- React renderer owns the user interface and never directly mutates trusted workflow state.
- TypeScript contracts define shared RPC, workflow, event, error, and UI-facing data shapes.
- Python runtime owns canonical workflow import, persistence, transition validation, projection generation, terminal sessions, approvals, gates, artifacts, and recovery.
- SQLite stores workflow versions, runs, runtime events, projections, artifacts, approvals, gate results, terminal sessions, and audit records.

## Hard Boundaries

The MVP must enforce these invariants from the beginning:

- Renderer does not directly read or write trusted workflow state.
- Renderer actions call typed RPC/IPC endpoints.
- Terminal sessions cannot submit `NODE_COMPLETED`.
- Agent providers cannot submit `HUMAN_APPROVED`.
- Gate pass/fail events require an authorized verifier or system actor.
- Gate pass/fail requires evidence or an explicit waiver.
- Runtime state advances only through `transition(runId, event, expectedRevision)`.
- Projection state must be rebuildable from `run_events`.
- UI buttons must come from Runtime-computed `allowedActions`.
- Provider-native objects must not enter contracts, SQLite authority state, or renderer state.

## Data Flow

Project import:

1. User selects a project root.
2. Renderer calls `project.detect(rootPath)`.
3. Runtime AdapterRegistry runs compatible adapters.
4. User selects an adapter.
5. Renderer calls `project.import(request)`.
6. Runtime imports a canonical `WorkflowDefinition`.
7. Runtime stores a workflow version and diagnostics.
8. Project Dashboard opens with protocol, workflow version, and diagnostics.

Run execution:

1. User creates a run from a workflow version.
2. Runtime appends `RUN_CREATED`.
3. Kernel computes initial node states, current nodes, allowed actions, blocking reasons, and revision.
4. Renderer displays only the returned projection.
5. User or executor submits runtime events such as artifact submission, approval decision, gate result, retry, pause, resume, or archive.
6. Kernel validates actor, revision, node state, requirements, evidence, and policy.
7. Runtime appends accepted events and rebuilds the projection.
8. UI refreshes timeline, current node, allowed actions, blocking reasons, artifacts, approval state, and gate state.

Recovery:

1. On app start or project open, Runtime scans stored runs, terminal sessions, checkpoints, and orphan sessions.
2. Runtime rebuilds projections from `run_events`.
3. Recovery page shows recoverable runs and sessions.
4. User chooses recover, stop, cleanup, or continue using Runtime-returned allowed actions.

## MVP Modules

Foundation:

- Workspace package scripts for renderer, desktop, contracts, runtime, tests, and development.
- Electron shell that can start the renderer and communicate with Runtime through preload-safe APIs.
- Python runtime health endpoint or local JSON-RPC endpoint.
- SQLite migration runner with WAL mode.
- Shared TypeScript contracts and Python Pydantic models aligned by tests.

Canonical model and adapter:

- `WorkflowDefinition`, `WorkflowNode`, `WorkflowEdge`, `RequirementSpec`, roles, gates, policies, diagnostics.
- AdapterRegistry with detection scores and compatibility diagnostics.
- Harness Adapter MVP import for `.harness`-style workflow files.
- Workflow version storage with content hash.
- Basic compiler diagnostics and graph view model.

Event store and kernel:

- `run_events` as the runtime source of truth.
- `run_projections` as read model.
- `transition(runId, event, expectedRevision)` as the only state advancement entrypoint.
- Guard rules for actor trust, revision conflicts, node state, approval, gate, artifact, and completion.
- Projection rebuild from events.
- Allowed action calculation.
- Timeline API.

Approval, gate, and artifact:

- Artifact metadata store with safe path validation and content hash.
- Evidence references that can be bound to artifacts, terminal output, or gate results.
- Approval inbox and approval decision handling.
- Gate result submission, failure, retry, and waiver support.
- Audit records for risky or governance-relevant decisions.

Terminal and agent provider:

- Terminal session model bound to project, run, and optionally node.
- Shell terminal MVP with session lifecycle and scrollback.
- Terminal output can become evidence.
- AgentExecutor interface with default provider boundary.
- LangGraph provider may start as an adapter-compatible implementation or stub if dependency installation is unavailable, but contracts must already prevent provider objects from leaking into core.
- Agent execution results normalize to `ExecutionResult`.

Renderer UI:

- Project Dashboard
- Workflow Viewer
- Run Dashboard
- Terminal page
- Approval Inbox
- Gates page
- Artifacts page
- Recovery page
- Settings page

UI must use restrained engineering-workbench styling: dense, clear, status-oriented, and optimized for scanning current run status, next actions, blocking reasons, evidence, and audit context.

## Error Handling

Runtime errors should be typed and exposed through contracts:

- validation error
- adapter unsupported
- workflow diagnostics error
- revision conflict
- permission denied
- invalid transition
- missing artifact
- unsafe path
- missing evidence
- gate failed
- approval rejected
- runtime unavailable
- terminal unavailable

Renderer must show blocking reasons from Runtime instead of inferring state locally.

## Testing Strategy

Python tests:

- Canonical schema validation
- Adapter detection and Harness import
- SQLite migrations
- Event append ordering
- Transition guard rules
- Allowed actions
- Approval policy
- Gate policy
- Artifact safe path and hashing
- Projection rebuild

TypeScript tests:

- Contract shape exports
- API client request/response handling
- Renderer state mapping from projections
- UI action rendering from allowed actions

End-to-end tests:

- Start app/runtime
- Import a Harness-like project
- Create a run
- Start node
- Submit artifact
- Approve
- Submit gate pass
- Complete run through Kernel transitions
- Rebuild projection after restart

## Acceptance Criteria

The MVP is complete when current evidence proves:

- A project can be imported.
- At least one workflow can be compiled from a supported adapter.
- A workflow version is persisted.
- A run can be created.
- Run state advances from events.
- Projection state can be rebuilt from events.
- A terminal session can be bound to a run/node.
- A terminal output item can become evidence.
- An artifact can be submitted with metadata and hash.
- A human approval can be requested and decided by a trusted human actor.
- An agent actor cannot perform human approval.
- A gate requires authorized verifier/system actor and evidence or waiver.
- A gate can pass or fail.
- A run can reach done through Kernel-approved transitions.
- UI exposes allowed actions returned by Runtime.
- UI does not contain a direct state-completion path.
- Agent provider integration is behind `AgentExecutor`.
- Provider-native objects do not become authoritative runtime state.
- Recovery can rebuild run projection from events.

## Implementation Notes

- Prefer small, well-bounded modules over a large runtime file.
- Keep contracts stable and explicit; do not expose provider-specific internals.
- Use SQLite JSON columns for canonical definitions and projection payloads in MVP, while keeping event and projection tables queryable.
- Keep UI pages functional before decorative; each page must answer what is happening, what is blocked, and what actions are allowed.
- When a dependency cannot be installed in the current environment, preserve the interface and provide a deterministic local implementation or stub with tests documenting the boundary.
