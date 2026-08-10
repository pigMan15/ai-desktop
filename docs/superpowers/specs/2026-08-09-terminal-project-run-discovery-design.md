# Terminal Project Run Discovery Design

## Goal

Allow the Terminal module to discover Runs across the current project, including Runs created from older workflow versions, while preventing new terminal output from being attached to completed or archived Runs.

## Data Source

The Terminal route will stop deriving its Run options from `listRunsForWorkflowVersion(workflowVersionId)`. It will call the existing project-scoped endpoint `GET /projects/{projectId}/runs` through `listProjectRuns`.

The client will load pages until `nextCursor` is empty so an older Run is not silently omitted. No Runtime endpoint or database migration is required.

## Run Model

`TerminalRunOption` will include:

- Run ID and title.
- Run status.
- Workflow name and version.
- Creation time.
- Whether the Run accepts a new terminal binding.

The bindable statuses are `CREATED`, `IN_PROGRESS`, `REVIEWING`, `BLOCKED`, and `PAUSED`. `DONE` and `ARCHIVED` Runs are read-only. Unknown future statuses default to read-only.

## Terminal UI

The Run selector will:

- Put the active Run first when one exists.
- Show active Runs by default.
- Provide a search field that matches Run title and ID.
- Provide a `显示已结束 Run` checkbox.
- Render each option with title, status, workflow name/version, and creation time.
- Keep completed and archived options selectable for inspection, but mark them read-only.

Selecting a read-only Run loads its workflow nodes and persisted terminal sessions. The create and `绑定到 Run` actions remain disabled, and the page displays that the selected Run only supports history inspection.

Selecting a bindable Run loads nodes and enables creation or binding after a node is selected.

## History Loading

Terminal history will be scoped to the Run selected inside Terminal, rather than the globally active Run. Changing the selected Run reloads that Run's terminal sessions. Historical output requests carry both the selected Run ID and session ID.

This makes old Run inspection functional instead of merely listing an option that cannot load its sessions.

## Error Handling

- A project Run list failure leaves standalone terminal use available and displays a retryable message.
- A node or terminal-history load failure does not change the current terminal binding.
- Binding remains blocked until the selected Run's bindability is known.
- Pagination stops only at a null cursor; repeated cursors are treated as an error to prevent an infinite request loop.

## Tests

Renderer tests will verify:

- Project-level pagination includes a Run from an older workflow version.
- Active Runs appear before historical Runs.
- Search and `显示已结束 Run` filtering.
- `DONE` and `ARCHIVED` Runs cannot create or bind terminals.
- Selecting an old Run loads its nodes and terminal history with that Run ID.
- Existing standalone terminal and active Run binding/export behavior remains unchanged.

No backend tests are needed because the project-scoped Run list, filters, and cursor contract already have coverage.
