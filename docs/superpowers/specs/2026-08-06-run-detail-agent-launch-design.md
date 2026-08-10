# Run Detail Agent Launch Design

## Problem

The project-scoped Run route renders `RunDetailPage`, but the Agent launch controls remain in the unused legacy `RunDashboard`. After a user starts an Agent workflow node, the current page can list existing Agent jobs but cannot create one.

## Scope

- Add Agent launch controls to the current project-scoped Run detail page.
- Show the controls only when the selected workflow node has kind `agent` and its projected state is `RUNNING`.
- Preserve the existing Provider, interactive/automatic mode, prompt, role tool defaults, execution workspace, and desktop interactive-terminal behavior.
- Refresh the scoped Agent job list after a successful launch and expose the resulting Agent terminal link.
- Keep archived or forced-read-only Runs unable to launch Agents.
- Do not restore `RunDashboard` or any legacy `/runs/{runId}` API.

## Component And Data Flow

`RunDetailPage` owns the selected node and renders a compact Agent execution section beside the Runtime-authorized actions. It receives Provider diagnostics and an `onStartAgent` callback from `App`.

The callback carries the scoped `projectId`, `runId`, selected node id, Provider, prompt, mode, allowed tools, and Run execution workspace. `App` delegates to the existing project-scoped Runtime client and, for interactive mode, creates the existing desktop terminal session. After completion, `RunDetailPage` reloads its Agent jobs so the new job and terminal link are visible without leaving the page.

Agent launch remains a scoped subresource operation rather than a synthetic `allowedActions` entry. Runtime `allowedActions` continue to represent workflow state transitions only.

## UI Rules

- An Agent node in `READY` state shows the normal Runtime `Start node` action, not the Agent launch form.
- Once that node reaches `RUNNING`, the Agent section appears.
- The launch button is disabled until the prompt is non-empty and the selected Provider is available.
- Archived/read-only Runs do not expose an enabled launch command.
- Non-Agent nodes never show the Agent launch section.
- Launch errors remain on the detail page and do not discard the loaded Run overview.

## Tests

- A `RunDetailPage` regression test first proves that a running Agent node currently lacks the launch command.
- Verify a running Agent node renders the form and calls `onStartAgent` with the exact scoped inputs.
- Verify `READY` and non-Agent nodes do not show the form.
- Verify archived/read-only Runs cannot launch an Agent.
- Verify successful launch refreshes the Agent job links.
- Run the focused detail-page tests, the Renderer suite, and the Renderer production build.
