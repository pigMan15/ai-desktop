# Terminal Run Binding and Evidence Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make terminal-to-Run binding executable from the Terminal module, export Run-bound output as Evidence, and export standalone output as a local redacted log with a visible saved path.

**Architecture:** Keep Runtime Evidence unchanged for Run-bound sessions. Add one desktop IPC operation for standalone transcript export, and let `TerminalPage` own optional binding state while `App` supplies Run summaries, node loading, and Runtime callbacks. Existing output is backfilled exactly once when a live standalone terminal is bound.

**Tech Stack:** Electron IPC/preload bridge, node-pty, React 18, TypeScript, Vitest/Testing Library, Node assert tests, Python Runtime HTTP API.

**Commit policy:** Do not stage or commit; the current workspace contains unrelated user changes and the user requested no Git commit.

---

## File Map

- `apps/desktop/src/main/terminal.ts`: create redacted standalone transcript files and return their paths.
- `apps/desktop/src/main/main.ts`: register the `terminal:export-output` IPC handler.
- `apps/desktop/src/preload/preload.cts`: expose standalone export through `workflowTerminal`.
- `apps/desktop/src/preload/global.d.ts`: declare the new bridge method.
- `apps/desktop/test/main.test.ts`: verify file content, redaction, path confinement, and IPC registration.
- `apps/renderer/src/features/terminal/TerminalPage.tsx`: select Run/node, bind live terminals, backfill output, choose export path, and display saved location.
- `apps/renderer/src/features/terminal/TerminalPage.test.tsx`: cover binding, output backfill, standalone log export, Evidence URI, and errors.
- `apps/renderer/src/app/App.tsx`: provide Run options, load workflow nodes, and return Evidence artifact URIs.
- `apps/renderer/src/app/App.test.tsx`: verify App-to-Terminal callbacks use the selected Run rather than only the globally active Run.
- `docs/full-feature-local-delivery-workflow-guide.zh-CN.md`: document standalone and Run-bound terminal procedures.

### Task 1: Standalone Transcript Export in Desktop Main

**Files:**
- Modify: `apps/desktop/test/main.test.ts`
- Modify: `apps/desktop/src/main/terminal.ts`

- [ ] **Step 1: Write a failing manager test**

Create a temporary project directory, emit PTY output containing a secret, and assert the wished-for API:

```ts
const exported = standaloneManager.exportOutput(standaloneSession.id);
assert.match(exported.path, /\.workflow-platform[\\/]terminal-logs/);
assert.equal(exported.firstSequence, 1);
assert.equal(exported.lastSequence, 1);
assert.equal(
  fs.readFileSync(exported.path, "utf8"),
  "OPENAI_API_KEY=[REDACTED]\r\nbuild complete\r\n",
);
```

Also assert that an empty session rejects with `Terminal session has no output`.

- [ ] **Step 2: Run the desktop test and verify RED**

Run:

```powershell
npm.cmd --workspace apps/desktop run test
```

Expected: TypeScript fails because `TerminalManager.exportOutput` does not exist.

- [ ] **Step 3: Implement the export type, redaction, and safe file write**

Add:

```ts
export type TerminalLogExport = {
  path: string;
  firstSequence: number;
  lastSequence: number;
};

exportOutput(sessionId: string): TerminalLogExport {
  const managed = this.get(sessionId);
  if (managed.output.length === 0) {
    throw new Error("Terminal session has no output");
  }
  const firstSequence = managed.output[0].sequence;
  const lastSequence = managed.output.at(-1)!.sequence;
  const directory = path.join(managed.projectRoot, ".workflow-platform", "terminal-logs");
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${managed.session.id}-${firstSequence}-${lastSequence}.log`);
  fs.writeFileSync(target, redactTerminalTranscript(managed.output.map((item) => item.data).join("")), "utf8");
  return { path: target, firstSequence, lastSequence };
}
```

Implement `redactTerminalTranscript` with the same assignment, Authorization, JSON, query-string, Bearer, and known-token patterns used by `runtime/src/workflow_platform/terminals/redaction.py`. Resolve the target and verify `path.relative(managed.projectRoot, target)` does not escape the project root before writing.

- [ ] **Step 4: Run the desktop test and verify GREEN**

Run `npm.cmd --workspace apps/desktop run test`.

Expected: exit code 0, exported content is redacted, and the empty-output assertion passes.

### Task 2: Desktop IPC and Preload Bridge

**Files:**
- Modify: `apps/desktop/test/main.test.ts`
- Modify: `apps/desktop/src/main/main.ts`
- Modify: `apps/desktop/src/preload/preload.cts`
- Modify: `apps/desktop/src/preload/global.d.ts`

- [ ] **Step 1: Write a failing IPC registration test**

Extend the expected channel list with `terminal:export-output`, invoke the handler, and assert it delegates to the manager with a validated session ID.

```ts
assert.ok(terminalChannels.includes("terminal:export-output"));
const exportedFromIpc = terminalHandlers.get("terminal:export-output")?.(
  undefined,
  terminalFromIpc.id,
);
assert.match((exportedFromIpc as TerminalLogExport).path, /terminal-logs/);
```

- [ ] **Step 2: Run the desktop test and verify RED**

Run `npm.cmd --workspace apps/desktop run test`.

Expected: channel assertion fails because the handler is not registered.

- [ ] **Step 3: Register and expose the method**

In `registerTerminalHandlers` add:

```ts
ipcMainLike.handle("terminal:export-output", (_event, sessionId: unknown) =>
  terminalManager.exportOutput(requireString(sessionId, "Terminal session ID")),
);
```

Expose and type:

```ts
exportOutput: (sessionId: string): Promise<TerminalLogExport> =>
  ipcRenderer.invoke("terminal:export-output", sessionId) as Promise<TerminalLogExport>,
```

- [ ] **Step 4: Run desktop tests and production typecheck**

Run:

```powershell
npm.cmd --workspace apps/desktop run test
npm.cmd --workspace apps/desktop run build
```

Expected: both exit 0.

### Task 3: Terminal Binding and Export Behavior

**Files:**
- Modify: `apps/renderer/src/features/terminal/TerminalPage.test.tsx`
- Modify: `apps/renderer/src/features/terminal/TerminalPage.tsx`

- [ ] **Step 1: Extend the test bridge and write failing standalone-export test**

Add `exportOutput` to the mock bridge. Create an independent terminal, return one output frame, click `导出终端日志`, and assert:

```ts
expect(bridge.exportOutput).toHaveBeenCalledWith("terminal-1");
expect(screen.getByRole("status")).toHaveTextContent(
  String.raw`G:\Project\demo\.workflow-platform\terminal-logs\terminal-1-1-1.log`,
);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer run test -- src/features/terminal/TerminalPage.test.tsx
```

Expected: fails because `exportOutput` is not in the bridge and the button still routes standalone sessions to a message only.

- [ ] **Step 3: Write failing tests for new-terminal binding and live-terminal binding**

Pass two Run options and an `onLoadRunNodes` callback. Verify selecting `run-2` loads nodes and that creating a terminal calls:

```ts
expect(onRegisterSession).toHaveBeenCalledWith({
  runId: "run-2",
  nodeId: "verify",
  kind: "shell",
  cwd: String.raw`G:\Project\demo`,
  pid: 1234,
});
expect(bridge.bindRuntimeSession).toHaveBeenCalledWith(
  "terminal-1",
  "run-2",
  "runtime-terminal-2",
);
```

For an already running standalone terminal with two output events, click `绑定到 Run` and assert the two existing frames are appended once, in sequence, before later frames are appended by polling.

- [ ] **Step 4: Run focused tests and verify RED**

Run the same focused Vitest command.

Expected: selectors and bind action are missing.

- [ ] **Step 5: Implement binding state and output backfill**

Add focused public types:

```ts
export type TerminalRunOption = { id: string; title: string };
export type TerminalNodeOption = { id: string; name: string };
```

Add props `runOptions`, `onLoadRunNodes`, and change `onExportEvidence` to return `Promise<{ uri: string }>`. Track `selectedRunId`, `selectedNodeId`, `nodeOptions`, `binding`, and `exportLocation`.

Create one `bindSessionToRun` helper that:

1. Calls `onRegisterSession` with the selected Run and node.
2. Calls `bridge.bindRuntimeSession`.
3. Appends every current output event through `onAppendOutput` in sequence.
4. Updates the session with `runtimeSessionId` only after all three operations succeed.

Disable selectors while binding and after binding. Guard against repeated clicks with a `binding` boolean.

- [ ] **Step 6: Implement the two export paths and visible result**

Use the session binding to select the operation:

```ts
if (session.runtimeSessionId && selectedRunId && onExportEvidence) {
  const artifact = await onExportEvidence({
    runId: selectedRunId,
    sessionId: session.runtimeSessionId,
  });
  setExportLocation(artifact.uri);
} else {
  const exported = await bridge.exportOutput(session.id);
  setExportLocation(exported.path);
}
```

Render `导出终端证据` for bound sessions and `导出终端日志` for standalone sessions. Render a nearby `<p role="status">` containing the exact path/URI after success or a specific error after failure.

- [ ] **Step 7: Run focused Terminal tests and verify GREEN**

Run:

```powershell
npm.cmd --workspace apps/renderer run test -- src/features/terminal/TerminalPage.test.tsx src/features/terminal/TerminalViewport.test.tsx
```

Expected: all terminal tests pass.

### Task 4: App Wiring for Run Options and Evidence URI

**Files:**
- Modify: `apps/renderer/src/app/App.test.tsx`
- Modify: `apps/renderer/src/app/App.tsx`

- [ ] **Step 1: Write a failing App integration test**

Open the Terminal route with two Run summaries. Select the second Run, load its overview, select a node, create/bind a terminal, and assert Runtime requests target `/projects/<project>/runs/run-2/terminals`, not the globally active Run.

Also make `exportTerminalEvidence` return `{ uri: "file:///G:/Project/demo/.workflow-platform/evidence/terminal.log" }` and assert that URI appears in the Terminal page after export.

- [ ] **Step 2: Run the App test and verify RED**

Run:

```powershell
npm.cmd --workspace apps/renderer run test -- src/app/App.test.tsx
```

Expected: Terminal has no Run selector and the export callback returns `void`.

- [ ] **Step 3: Wire Run summaries, node loading, and returned artifact URI**

Pass:

```tsx
runOptions={runs.map((run) => ({ id: run.id, title: run.title }))}
onLoadRunNodes={async (runId) => {
  const overview = await client.getProjectRunOverview(projectId, runId);
  return overview.workflow.nodes.map((node) => ({ id: node.id, name: node.name }));
}}
```

Keep registration, output append, stop, and history callbacks scoped to the `runId` supplied by `TerminalPage`. Return the Evidence artifact URI:

```ts
const artifact = await client.exportTerminalEvidence(projectId, runId, sessionId, now());
setOperationMessage("终端输出已导出为 Evidence");
return { uri: artifact.uri };
```

- [ ] **Step 4: Run App and Terminal tests**

Run:

```powershell
npm.cmd --workspace apps/renderer run test -- src/app/App.test.tsx src/features/terminal/TerminalPage.test.tsx
```

Expected: all selected tests pass.

### Task 5: User Guide and Full Verification

**Files:**
- Modify: `docs/full-feature-local-delivery-workflow-guide.zh-CN.md`

- [ ] **Step 1: Update the standalone terminal procedure**

Document: leave `关联 Run` empty, create terminal, execute a command, click `导出终端日志`, and read the exact `.workflow-platform/terminal-logs/...log` path shown below the button.

- [ ] **Step 2: Update the Run-bound procedure**

Document: select the target Run, load and select a node, create a bound terminal or bind the current live terminal, verify the binding status, execute a command, click `导出终端证据`, then verify both the displayed URI and the corresponding item in the Artifacts module.

- [ ] **Step 3: Run focused regression tests**

Run:

```powershell
npm.cmd --workspace apps/desktop run test
npm.cmd --workspace apps/renderer run test -- src/features/terminal/TerminalPage.test.tsx src/features/terminal/TerminalViewport.test.tsx src/app/App.test.tsx
```

Expected: exit code 0 with no failed tests.

- [ ] **Step 4: Run the complete project test suite**

Run `npm.cmd test`.

Expected: contracts, renderer, and desktop suites pass; only the three intentionally skipped legacy `WorkflowViewer` tests remain skipped.

- [ ] **Step 5: Run the production build**

Run `npm.cmd run build` outside the restricted sandbox if Vite reports `spawn EPERM`.

Expected: contracts, renderer Vite build, and desktop TypeScript build exit 0. The existing chunk-size warning is non-blocking.

- [ ] **Step 6: Check changed-file formatting**

Run:

```powershell
git diff --check -- apps/desktop/src/main/terminal.ts apps/desktop/src/main/main.ts apps/desktop/src/preload/preload.cts apps/desktop/src/preload/global.d.ts apps/desktop/test/main.test.ts apps/renderer/src/features/terminal/TerminalPage.tsx apps/renderer/src/features/terminal/TerminalPage.test.tsx apps/renderer/src/app/App.tsx apps/renderer/src/app/App.test.tsx docs/full-feature-local-delivery-workflow-guide.zh-CN.md
```

Expected: no whitespace errors in files changed by this plan.
