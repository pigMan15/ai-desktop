# Run Control Console Redesign

## Design Read

This is an operational desktop tool for developers. The Run page should feel quiet, compact, and predictable, with the information density of an IDE control surface rather than a collection of equal-weight dashboard sections.

Design dials: variance 4, motion 2, density 7. The existing cool-neutral palette, teal accent, typography, and 5-6px radius remain authoritative.

## Goals

- Make Run state, current work, and the next executable command readable in one viewport.
- Place Agent execution directly in the selected running Agent node's workflow context.
- Reduce repeated headings, borders, resource buttons, and full-width form fields.
- Preserve all project/run scoped APIs, routes, refresh behavior, authorization, and error handling.
- Keep the page usable at desktop and narrow application-window widths.

## Information Architecture

The page has four levels, in this order:

1. A compact identity toolbar with the back command, Run title, status, revision, refresh, and last refresh time.
2. A four-column operational status strip for workspace, current node, active execution, and latest event.
3. A two-column control area. The wider column contains the workflow progress map. The narrower column contains the selected node summary, blockers, Runtime-authorized actions, and the contextual Agent launcher.
4. A tabbed resource area for context, artifacts, gates, approvals, deployment, audit, and recovery.

The page uses dividers and whitespace for grouping. It does not place cards inside cards and does not make every section float independently.

## Control Area

### Workflow Column

The progress map remains the primary spatial representation. Selecting a node updates only the adjacent control column. Its container has a stable minimum height so graph loading and node selection do not shift the page.

### Selected Node Column

The node name, kind, state, role, completion mode, and concise requirements are shown as a dense definition list. Blocking reasons appear immediately beneath the identity as a narrow warning strip.

Runtime-authorized actions follow the node facts. Each action keeps Runtime as its sole authority, preserves required inputs and risk confirmation, and uses one compact command row rather than a separate large panel.

### Agent Command Bar

The Agent launcher appears only when the selected node kind is `agent` and its projected state is `RUNNING`.

- Provider is a compact select.
- Interactive/automatic mode is a segmented control.
- Prompt is the dominant editable field.
- Start uses the existing Lucide play icon with an accessible text label.
- Workspace, role, and allowed tools are secondary metadata, not read-only form controls.
- Starting, unavailable Provider, archived/read-only, error, and successful job states remain visible without changing routes.
- Existing jobs are rendered as compact rows with status and a terminal link.

## Resource Tabs

The existing resource-link grid and bottom detail accordions become a single tab strip. `Context` is the default local tab and shows task goal, parameters, workspace lease, and activity. The other tabs navigate to the existing project/run scoped module routes; they do not duplicate those modules inside the Run page.

The tab strip wraps or becomes horizontally scrollable at narrow widths. Labels never truncate into ambiguous text.

## Responsive Behavior

- At wide widths, the workflow/control split is approximately 65/35.
- Below the existing tablet breakpoint, the control column moves below the workflow map.
- The status strip becomes two columns, then one column on narrow windows.
- The Agent command bar becomes a two-row grid and finally a single column; the start button remains stable and full-width only on narrow screens.
- No font size scales with viewport width, and no content overlaps or changes the dimensions of fixed controls.

## Visual Rules

- Use one teal accent for selection, commands, links, and focus indication.
- Use warm colors only for warning/error semantics.
- Keep borders light and mostly horizontal; avoid decorative shadows and gradients.
- Use existing Lucide icons for back, refresh, start, terminal, and resource navigation.
- Buttons have explicit hover, focus, active, disabled, and busy states.
- Body text and control labels meet WCAG AA contrast; keyboard selection and tab order follow visual order.

## State And Error Handling

Initial loading uses a stable skeleton matching the toolbar, status strip, and control area. Cached refresh failures keep current content visible. Revision conflicts and archive transitions retain current behavior. Agent launch errors stay beside the Agent command bar. A failed Agent list refresh does not remove the loaded Run overview.

## Testing And Verification

- Update `RunDetailPage` tests for hierarchy and node selection without weakening scoped API assertions.
- Preserve action payload, risk confirmation, refresh, polling, not-found, maintenance, and cached-error tests.
- Cover Agent visibility, exact start request, busy/read-only/unavailable/error states, refreshed jobs, and terminal links.
- Add accessibility assertions for tabs, segmented mode selection, command labels, and keyboard operation.
- Verify desktop and narrow layouts with browser screenshots after implementation.
- Run the complete Renderer test suite, production build, and `git diff --check`.

## Non-Goals

- No Runtime, persistence, Contracts, or Desktop API changes.
- No restoration of legacy `/runs/{runId}` APIs or `RunDashboard`.
- No redesign of the global sidebar, Run list, or scoped resource pages.
- No new component framework or visual dependency.
