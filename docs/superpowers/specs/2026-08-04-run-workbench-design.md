# Run Workbench Design

## Goal

Redesign the Run page around the active workflow step. A first-time user must
be able to answer three questions without reading unrelated controls:

1. Which step is the Run currently on?
2. Why is it in that state?
3. What is the next valid action, and what will it do?

Historical Runs, logs, artifacts, and configuration remain available, but they
must not compete with the current step's primary action.

## Page Structure

The page uses a progress-first workbench layout:

1. Header: active Run selector, Run status, current node, and create Run entry.
2. Progress map: the complete workflow graph with current execution path and
   per-node status.
3. Current node workspace: node purpose, assigned role, required inputs,
   expected outputs, acceptance conditions, and blocking reason.
4. Next action panel: one primary Runtime-authorized action followed by any
   alternative Runtime-authorized actions.
5. Contextual execution panel: only the controls appropriate to the selected
   current node kind.
6. Secondary details: run metadata, timeline, parameters, agent output,
   deployment output, and historical node details, collapsed by default.

## Progress Map

The progress map is generated from `WorkflowDefinition.nodes` and
`WorkflowDefinition.edges`, while state is generated from
`RunProjection.nodeStates` and `RunProjection.currentNodeIds`.

It renders graph connections without assuming that node-array order describes
the process. The active execution path is emphasized; completed, pending,
blocked, failed, and skipped nodes are visually distinct. A node tooltip
contains its name, type, state, completion requirements, known blocker, and
the immediate successor nodes.

Selecting a node opens read-only detail for that node. Only a node identified
by the Runtime as current and actionable can populate the execution panel.

## Dynamic Action Resolution

The renderer must never infer that an action is permitted from node kind alone.
`RunProjection.allowedActions` is the authority. The UI maps a permitted action
to human-readable intent and to an action callback only when both are present.

The node kind determines the contextual information and available presentation:

| Node kind | Context shown | Runtime-authorized actions rendered |
| --- | --- | --- |
| `task`, `composite` | purpose, inputs, outputs | start, submit or scan artifact, complete |
| `agent` | role, provider, allowed tools, workspace, prompt | start Agent, inspect terminal, submit artifact, complete |
| `approval` | approver and decision basis | approve, reject, defer |
| `gate` | requirements, evidence, waiver policy | pass, fail, waive, retry |
| `evidence` | evidence sources and artifact requirements | submit or confirm evidence, complete |
| `deploy` | deployment configuration and output | start, cancel, inspect deployment |
| `report` | report requirements and available outputs | generate or download report, complete |

For each current node, the next action panel shows a single primary action in
plain language, for example "Start the implementation Agent in the dev
worktree" or "Approve the design to enter implementation". Required input
controls appear alongside that action. Actions that are unavailable are not
shown as an unexplained collection of disabled buttons. When no action is
available, the panel states the specific waiting condition or blocking reason.

## States and Safety

- An archived project makes the entire workbench read-only and directs the user
  to reimport the project to reactivate it.
- A paused, done, blocked, or archived Run displays its status and reason, with
  only Runtime-authorized recovery actions where available.
- Existing Run history remains readable after a project or Run is archived.
- The server remains the enforcement point; the renderer is only a clear
  presentation of Runtime state.

## Component Boundaries

`RunDashboard` becomes an orchestrator and composes:

- `RunProgressMap`: graph layout, node status, selection, tooltip.
- `RunNextActionPanel`: translates Runtime allowed actions into primary and
  secondary user operations.
- `RunNodeWorkspace`: current node context and kind-specific execution tools.
- `RunDetails`: collapsed Run metadata, timeline, artifact requirements, Agent
  activity, and deployment history.

Shared pure helpers resolve node state labels, action instructions, and graph
relationships. They are unit-tested independently of the component tree.

## Acceptance Criteria

1. The first visible content identifies the current node and its next required
   action.
2. The progress map correctly represents branches from workflow edges and marks
   current Runtime nodes without relying on source order.
3. Hovering a node explains state, requirements, and successor nodes.
4. Current-node controls are determined by `allowedActions` and node metadata;
   unrelated controls are not shown.
5. Completion of an action refreshes the projection and updates the progress
   map and next action without navigation.
6. Archived projects remain read-only in the redesigned page.
7. Component and helper tests cover graph state derivation, tooltip content,
   primary action selection, node-specific control visibility, and archived
   read-only behavior.
