import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  bootstrap,
  createMainWindow,
  registerProjectHandlers,
  registerGitWorkspaceHandlers,
  registerTerminalHandlers,
  registerRuntimeHandlers,
  resolveRendererUrl,
  validateRendererUrl
} from "../src/main/main.js";
import { ManagedRuntime, type RuntimeRequestOptions } from "../src/main/runtime.js";
import { TerminalManager, type TerminalSpawnOptions } from "../src/main/terminal.js";

const registeredChannels: string[] = [];
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const fakeIpcMain = {
  handle(channel: string, handler: (...args: unknown[]) => unknown) {
    registeredChannels.push(channel);
    handlers.set(channel, handler);
  }
};

const runtimeManager = new ManagedRuntime({
  spawnProcess: (command, args, options) => {
    fakeSpawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
    return fakeProcess;
  },
  healthCheck: async () => ({ status: "ok", service: "workflow-runtime" }),
  cwd: "G:\\Project\\ai\\ai-desktop",
  port: 8765,
  runtimeToken: "desktop-local-token",
  env: {},
});

const packagedRuntime = new ManagedRuntime({
  runtimeExecutablePath: "G:\\App\\resources\\runtime\\workflow-runtime.exe",
  spawnProcess: (command, args, options) => {
    packagedSpawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
    return fakeProcess;
  },
  healthCheck: async () => ({ status: "ok", service: "workflow-runtime" }),
  cwd: "G:\\Project\\ai\\ai-desktop",
  port: 8765,
  runtimeToken: "packaged-local-token",
});

registerRuntimeHandlers(fakeIpcMain, runtimeManager);
registerRuntimeHandlers(fakeIpcMain, runtimeManager);

assert.deepEqual(registeredChannels, [
  "runtime:health",
  "runtime:status",
  "runtime:restart",
  "runtime:logs",
  "runtime:request"
]);
assert.deepEqual(await handlers.get("runtime:health")?.(), {
  status: "ok",
  service: "workflow-runtime"
});

class RecordingRuntime extends ManagedRuntime {
  readonly requests: RuntimeRequestOptions[] = [];

  override async request<T>(options: RuntimeRequestOptions): Promise<T> {
    this.requests.push(options);
    return { accepted: true } as T;
  }
}

const recordingRuntime = new RecordingRuntime({ externalUrl: "http://127.0.0.1:9999" });
const requestHandlers = new Map<string, (...args: unknown[]) => unknown>();
registerRuntimeHandlers(
  {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      requestHandlers.set(channel, handler);
    },
  },
  recordingRuntime,
);
const runtimeRequestHandler = requestHandlers.get("runtime:request");
const validRuntimeRequest = {
  path: "/runs",
  method: "POST" as const,
  body: { workflowVersionId: "version-1" },
  headers: { "idempotency-key": "create-run-1" },
};
assert.deepEqual(await runtimeRequestHandler?.(undefined, validRuntimeRequest), { accepted: true });
assert.deepEqual(recordingRuntime.requests, [{
  ...validRuntimeRequest,
  headers: { "Idempotency-Key": "create-run-1" },
}]);

const invalidRuntimeRequests: Array<{ value: unknown; error: RegExp }> = [
  { value: null, error: /options must be an object/i },
  { value: [], error: /options must be an object/i },
  {
    value: Object.assign(new Date(), { path: "/runs" }),
    error: /options must be an object/i,
  },
  { value: { path: "https://example.com/runs" }, error: /relative API path/i },
  { value: { path: "/runs", method: "PUT" }, error: /method must be GET or POST/i },
  { value: { path: "/runs", headers: [] }, error: /headers must be an object/i },
  { value: { path: "/runs", headers: new Date() }, error: /headers must be an object/i },
  { value: { path: "/runs", headers: { "Idempotency-Key": 123 } }, error: /header values must be strings/i },
  { value: { path: "/runs", headers: { "x-workflow-platform-token": "spoofed" } }, error: /header is not allowed/i },
  { value: { path: "/runs", headers: { Authorization: "Bearer spoofed" } }, error: /header is not allowed/i },
  { value: { path: "/runs", headers: { "Content-Type": "text/plain" } }, error: /header is not allowed/i },
];
for (const invalidRequest of invalidRuntimeRequests) {
  assert.throws(
    () => runtimeRequestHandler?.(undefined, invalidRequest.value),
    invalidRequest.error,
  );
}
assert.equal(recordingRuntime.requests.length, 1);

const createdWindows: Electron.BrowserWindowConstructorOptions[] = [];
class FakeBrowserWindow {
  constructor(options: Electron.BrowserWindowConstructorOptions) {
    createdWindows.push(options);
  }

  async loadURL(url: string) {
    assert.equal(url, "http://127.0.0.1:5173/");
  }
}

await createMainWindow({
  BrowserWindowClass: FakeBrowserWindow,
  rendererUrl: "http://127.0.0.1:5173",
  preloadPath: "preload.js"
});

const fallbackUrls: string[] = [];
class FallbackBrowserWindow {
  constructor(_options: Electron.BrowserWindowConstructorOptions) {}

  async loadURL(url: string) {
    fallbackUrls.push(url);
    if (fallbackUrls.length === 1) {
      throw new Error("renderer unavailable");
    }
  }
}

await createMainWindow({
  BrowserWindowClass: FallbackBrowserWindow,
  rendererUrl: "http://127.0.0.1:5173",
  rendererDistPath: "G:\\Project\\ai\\ai-desktop\\apps\\renderer\\dist",
  preloadPath: "preload.js"
});
assert.deepEqual(fallbackUrls, [
  "http://127.0.0.1:5173/",
  "file:///G:/Project/ai/ai-desktop/apps/renderer/dist/index.html"
]);

assert.deepEqual(createdWindows[0].webPreferences, {
  preload: "preload.js",
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true
});

assert.equal(validateRendererUrl("http://127.0.0.1:5173"), "http://127.0.0.1:5173/");
assert.throws(() => validateRendererUrl("https://example.com"), /Unsafe renderer URL/);
assert.equal(
  resolveRendererUrl({
    isPackaged: true,
    rendererDistPath: "G:\\Project\\ai\\ai-desktop\\apps\\renderer\\dist"
  }),
  "file:///G:/Project/ai/ai-desktop/apps/renderer/dist/index.html"
);

const fakeSpawnCalls: Array<{
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}> = [];
const packagedSpawnCalls: Array<{
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}> = [];
const fakeProcess = new EventEmitter() as EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
};
fakeProcess.pid = 4321;
fakeProcess.stdout = new EventEmitter();
fakeProcess.stderr = new EventEmitter();
let killed = false;
fakeProcess.kill = () => {
  killed = true;
};

await runtimeManager.start();
assert.equal(runtimeManager.status().state, "ready");
assert.equal(runtimeManager.status().pid, 4321);
assert.equal(runtimeManager.status().url, "http://127.0.0.1:8765");
assert.deepEqual(
  {
    command: fakeSpawnCalls[0]?.command,
    args: fakeSpawnCalls[0]?.args,
    cwd: fakeSpawnCalls[0]?.cwd,
  },
  {
  command: process.platform === "win32" ? "python.exe" : "python",
  args: [
    "-m",
    "uvicorn",
    "workflow_platform.api.app:create_runtime_app",
    "--factory",
    "--host",
    "127.0.0.1",
    "--port",
    "8765"
  ],
  cwd: "G:\\Project\\ai\\ai-desktop"
  },
);
assert.equal(fakeSpawnCalls[0]?.env.WORKFLOW_PLATFORM_RUNTIME_TOKEN, "desktop-local-token");
assert.equal(
  fakeSpawnCalls[0]?.env.PYTHONPATH,
  "G:\\Project\\ai\\ai-desktop\\runtime\\src",
);

fakeProcess.stdout.emit("data", Buffer.from("runtime ready\n"));
fakeProcess.stderr.emit("data", Buffer.from("warning line\n"));
assert.deepEqual(runtimeManager.logs().map((entry) => entry.message), [
  "runtime ready",
  "warning line"
]);

await runtimeManager.stop();
assert.equal(killed, true);
assert.equal(runtimeManager.status().state, "stopped");

await runtimeManager.restart();
assert.equal(runtimeManager.status().state, "ready");

await packagedRuntime.start();
assert.deepEqual(
  {
    command: packagedSpawnCalls[0]?.command,
    args: packagedSpawnCalls[0]?.args,
    cwd: packagedSpawnCalls[0]?.cwd,
  },
  {
    command: "G:\\App\\resources\\runtime\\workflow-runtime.exe",
    args: [],
    cwd: "G:\\Project\\ai\\ai-desktop",
  },
);
assert.equal(packagedSpawnCalls[0]?.env.WORKFLOW_PLATFORM_RUNTIME_TOKEN, "packaged-local-token");

let delayedHealthAttempts = 0;
const delayedRuntime = new ManagedRuntime({
  spawnProcess: () => fakeProcess,
  healthCheck: async () => {
    delayedHealthAttempts += 1;
    if (delayedHealthAttempts < 3) {
      throw new Error("Runtime is still starting");
    }
    return { status: "ok", service: "workflow-runtime" };
  },
  healthRetryAttempts: 3,
  healthRetryDelayMs: 0,
});

await delayedRuntime.start();
assert.equal(delayedRuntime.status().state, "ready");
assert.equal(delayedHealthAttempts, 3);

const environmentPortRuntime = new ManagedRuntime({
  env: { WORKFLOW_PLATFORM_RUNTIME_PORT: "8877" },
});
assert.equal(environmentPortRuntime.status().port, 8877);

const proxiedFetchCalls: Array<{ input: string; init?: RequestInit }> = [];
const proxiedRuntime = new ManagedRuntime({
  port: 8899,
  runtimeToken: "proxy-local-token",
});
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  proxiedFetchCalls.push({ input: String(input), init });
  return {
    ok: true,
    status: 200,
    json: async () => ({ accepted: true }),
  } as Response;
}) as typeof fetch;
assert.deepEqual(await proxiedRuntime.request({ path: "/agents/providers" }), { accepted: true });
assert.deepEqual(proxiedFetchCalls[0], {
  input: "http://127.0.0.1:8899/agents/providers",
  init: {
    method: "GET",
    headers: { "X-Workflow-Platform-Token": "proxy-local-token" },
    body: undefined,
  },
});
assert.deepEqual(
  await proxiedRuntime.request({
    path: "/runs",
    method: "POST",
    body: { workflowVersionId: "version-1" },
    headers: { "idempotency-key": "create-run-1" },
  }),
  { accepted: true },
);
assert.deepEqual(proxiedFetchCalls[1], {
  input: "http://127.0.0.1:8899/runs",
  init: {
    method: "POST",
    headers: {
      "Idempotency-Key": "create-run-1",
      "content-type": "application/json",
      "X-Workflow-Platform-Token": "proxy-local-token",
    },
    body: JSON.stringify({ workflowVersionId: "version-1" }),
  },
});
assert.deepEqual(
  await proxiedRuntime.request({ path: "/runs/create", method: "POST" }),
  { accepted: true },
);
assert.deepEqual(proxiedFetchCalls[2], {
  input: "http://127.0.0.1:8899/runs/create",
  init: {
    method: "POST",
    headers: { "X-Workflow-Platform-Token": "proxy-local-token" },
    body: undefined,
  },
});
await assert.rejects(
  () => proxiedRuntime.request({ path: "https://example.com/agents/providers" }),
  /relative API path/,
);

globalThis.fetch = (async () => ({
  ok: false,
  status: 400,
  json: async () => ({ detail: "WORKFLOW_DIAGNOSTICS_ERROR: AGENT_CONFIGURATION_UNSUPPORTED" }),
  text: async () => "",
}) as Response) as typeof fetch;
await assert.rejects(
  () => proxiedRuntime.request({ path: "/workflow-versions/example/save", body: {} }),
  /400: WORKFLOW_DIAGNOSTICS_ERROR: AGENT_CONFIGURATION_UNSUPPORTED/,
);

const emptyExternalRuntime = new ManagedRuntime({
  externalUrl: "",
  env: { WORKFLOW_PLATFORM_RUNTIME_PORT: "8877" },
});
assert.deepEqual(emptyExternalRuntime.status(), {
  mode: "managed",
  state: "stopped",
  url: "http://127.0.0.1:8877",
  port: 8877,
  pid: null,
  lastError: null,
});

const lifecycleHandlers = new Map<string, () => void | Promise<void>>();
let lifecycleRuntimeStopped = false;
let lifecycleTerminalsStopped = false;
const lifecycleProcess = new EventEmitter() as EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
};

const projectHandlers = new Map<string, () => unknown>();
const projectIpcMain = {
  handle(channel: string, handler: () => unknown) {
    projectHandlers.set(channel, handler);
  },
};

registerProjectHandlers(projectIpcMain, {
  showOpenDialog: async () => ({ canceled: false, filePaths: ["G:\\Project\\selected"] }),
});
assert.equal(await projectHandlers.get("project:select-directory")?.(), "G:\\Project\\selected");
lifecycleProcess.pid = 9999;
lifecycleProcess.stdout = new EventEmitter();
lifecycleProcess.stderr = new EventEmitter();
lifecycleProcess.kill = () => {
  lifecycleRuntimeStopped = true;
};
const lifecycleRuntime = new ManagedRuntime({
  spawnProcess: () => lifecycleProcess,
  healthCheck: async () => ({ status: "ok", service: "workflow-runtime" }),
});
bootstrap({
  appLike: {
    whenReady: async () => undefined,
    on(event, listener) {
      lifecycleHandlers.set(event, listener);
    },
    quit() {},
  },
  ipcMainLike: {
    handle() {},
  },
  runtimeManager: lifecycleRuntime,
  terminalManager: {
    stopAll() {
      lifecycleTerminalsStopped = true;
    },
  },
  createWindow: async () => ({ loadURL: async () => undefined }),
  getAllWindows: () => [],
});
await new Promise((resolve) => setImmediate(resolve));
await lifecycleHandlers.get("before-quit")?.();
assert.equal(lifecycleRuntimeStopped, true);
assert.equal(lifecycleTerminalsStopped, true);

const terminalOutputCallbacks: Array<(data: string) => void> = [];
const terminalWrites: string[] = [];
const terminalResizes: Array<{ columns: number; rows: number }> = [];
let terminalKilled = false;
const fakePty = {
  pid: 6789,
  write(data: string) {
    terminalWrites.push(data);
  },
  resize(columns: number, rows: number) {
    terminalResizes.push({ columns, rows });
  },
  kill() {
    terminalKilled = true;
  },
  onData(callback: (data: string) => void) {
    terminalOutputCallbacks.push(callback);
    return { dispose() {} };
  },
};
const terminalManager = new TerminalManager({
  spawnPty: (command: string, args: string[], options: TerminalSpawnOptions) => {
    assert.equal(command, "cmd.exe");
    assert.deepEqual(args, ["/d", "/k", "chcp 65001>nul"]);
    assert.equal(options.cwd, "G:\\Project\\demo");
    assert.equal(options.env.PYTHONIOENCODING, "utf-8");
    return fakePty;
  },
});

const terminal = terminalManager.create({
  kind: "shell",
  cwd: "G:\\Project\\demo",
  projectRoot: "G:\\Project\\demo",
  columns: 120,
  rows: 40,
});
const liveTerminalOutput: Array<{ sequence: number; data: string }> = [];
const unsubscribeLiveTerminalOutput = terminalManager.subscribeOutput(terminal.id, (event) => {
  liveTerminalOutput.push(event);
});
terminalOutputCallbacks[0]?.("正在执行\r\n");
assert.deepEqual(liveTerminalOutput, [{ sequence: 1, data: "正在执行\r\n" }]);
unsubscribeLiveTerminalOutput();
terminalOutputCallbacks[0]?.("不会实时推送\r\n");
assert.deepEqual(liveTerminalOutput, [{ sequence: 1, data: "正在执行\r\n" }]);
assert.deepEqual(terminalManager.requestCommand(terminal.id, "dir"), {
  status: "executed",
  commandSummary: "dir",
});
terminalManager.interrupt(terminal.id);
terminalManager.resize(terminal.id, 100, 30);

assert.equal(terminal.pid, 6789);
assert.deepEqual(terminalManager.read(terminal.id, 0), [
  { sequence: 1, data: "正在执行\r\n" },
  { sequence: 2, data: "不会实时推送\r\n" },
]);
for (let index = 0; index < 2_001; index += 1) {
  terminalOutputCallbacks[0]?.(`chunk-${index}`);
}
assert.deepEqual(
  terminalManager.read(terminal.id, 2_000).map((event) => event.sequence),
  [2_001, 2_002, 2_003],
);
assert.deepEqual(terminalWrites, ["dir\r", "\u0003"]);
assert.deepEqual(terminalResizes, [{ columns: 100, rows: 30 }]);

const providerSpawnCalls: Array<{
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}> = [];
const providerWrites: string[] = [];
const providerManager = new TerminalManager({
  spawnPty: (command: string, args: string[], options: TerminalSpawnOptions) => {
    providerSpawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
    return {
      pid: 7777,
      write(data: string) {
        providerWrites.push(data);
      },
      resize() {},
      kill() {},
      onData() {
        return { dispose() {} };
      },
    };
  },
});
const claudeSession = providerManager.create({
  kind: "claude",
  cwd: "G:\\Project\\demo",
  projectRoot: "G:\\Project\\demo",
  columns: 120,
  rows: 36,
  initialPrompt: "请等待用户回复。",
});
assert.equal(claudeSession.kind, "claude");
assert.deepEqual(providerSpawnCalls[0], {
  command: "claude.cmd",
  args: ["--ax-screen-reader", "--permission-mode", "acceptEdits", "请等待用户回复。"],
  cwd: "G:\\Project\\demo",
  env: providerSpawnCalls[0]?.env,
});
assert.equal(providerSpawnCalls[0]?.env.PYTHONIOENCODING, "utf-8");
const codexSession = providerManager.create({
  kind: "codex",
  cwd: "G:\\Project\\demo",
  projectRoot: "G:\\Project\\demo",
  initialPrompt: "继续实现交互式终端\n并写入计划",
});
assert.deepEqual(providerSpawnCalls[1]?.args, [
  "--sandbox",
  "workspace-write",
  "--ask-for-approval",
  "on-request",
  "--cd",
  "G:\\Project\\demo",
  "继续实现交互式终端 并写入计划",
]);
providerManager.writeInput(claudeSession.id, "继续\r");
providerManager.writeInput(codexSession.id, "\u0003");
assert.deepEqual(providerWrites, ["继续\r", "\u0003"]);
assert.throws(() => terminalManager.writeInput(terminal.id, "echo no\r"), /Provider terminal/);

const commandManager = terminalManager as TerminalManager & {
  requestCommand(
    sessionId: string,
    command: string,
  ): {
    status: "executed" | "pending_approval" | "blocked";
    approval?: { id: string; riskLevel: "high"; commandSummary: string; impact: string };
    reason?: string;
  };
};

const deletionRequest = commandManager.requestCommand(terminal.id, "del .\\build");
assert.equal(deletionRequest.status, "pending_approval");
assert.equal(deletionRequest.approval?.riskLevel, "high");
assert.match(deletionRequest.approval?.commandSummary ?? "", /del/i);
assert.deepEqual(terminalWrites, ["dir\r", "\u0003"]);

const submitLineDecision = terminalManager.submitShellLine(terminal.id, "del .\\build");
assert.equal(submitLineDecision.status, "pending_approval");
assert.deepEqual(terminalWrites, ["dir\r", "\u0003"]);

const chainedCommand = commandManager.requestCommand(terminal.id, "echo safe & del .\\build");
assert.deepEqual(chainedCommand, {
  status: "blocked",
  reason: "终端命令不允许包含 Shell 元字符或命令串联。",
});

const multilineCommand = commandManager.requestCommand(terminal.id, "echo safe\rdel .\\build");
assert.deepEqual(multilineCommand, {
  status: "blocked",
  reason: "终端命令必须为单行文本。",
});

const outsidePathCommand = commandManager.requestCommand(terminal.id, "cd G:\\outside");
assert.deepEqual(outsidePathCommand, {
  status: "blocked",
  reason: "命令引用的路径必须位于项目根目录内。",
});
const indirectDeletionCommand = commandManager.requestCommand(terminal.id, "call del .\\build");
assert.equal(indirectDeletionCommand.status, "pending_approval");
assert.deepEqual(terminalWrites, ["dir\r", "\u0003"]);

terminalManager.stop(terminal.id);
assert.equal(terminalKilled, true);

const auditedCommandWrites: string[] = [];
const auditedDecisions: Array<Record<string, string>> = [];
const auditedManager = new TerminalManager({
  spawnPty: () => ({
    pid: 9876,
    write(data: string) {
      auditedCommandWrites.push(data);
    },
    resize() {},
    kill() {},
    onData() {
      return { dispose() {} };
    },
  }),
  recordCommandDecision: async (decision) => {
    auditedDecisions.push(decision);
  },
});
const auditedSession = auditedManager.create({
  kind: "shell",
  cwd: "G:\\Project\\demo",
  projectRoot: "G:\\Project\\demo",
});
const auditedPending = auditedManager.requestCommand(auditedSession.id, "del .\\build");
assert.equal(auditedPending.status, "pending_approval");
await assert.rejects(
  () => auditedManager.approveCommand(auditedSession.id, auditedPending.approval!.id),
  /Runtime 终端会话尚未绑定/,
);
assert.deepEqual(auditedCommandWrites, []);
auditedManager.bindRuntimeSession(auditedSession.id, "run-1", "runtime-terminal-1");
assert.deepEqual(
  await auditedManager.approveCommand(auditedSession.id, auditedPending.approval!.id),
  { status: "executed", commandSummary: "del .\\build" },
);
assert.deepEqual(auditedCommandWrites, ["del .\\build\r"]);
assert.deepEqual(auditedDecisions, [
  {
    runId: "run-1",
    runtimeSessionId: "runtime-terminal-1",
    decision: "approved",
    riskLevel: "high",
    commandSummary: "del .\\build",
    impact: "该命令可能删除文件、覆盖工作区、强制推送或影响系统进程。",
  },
]);

const terminalChannels: string[] = [];
const terminalHandlers = new Map<string, (...args: unknown[]) => unknown>();
const pushedTerminalOutput: Array<{ channel: string; payload: unknown }> = [];
registerTerminalHandlers(
  {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      terminalChannels.push(channel);
      terminalHandlers.set(channel, handler);
    },
  },
  terminalManager,
);
assert.deepEqual(terminalChannels, [
  "terminal:create",
  "terminal:bind-runtime-session",
  "terminal:command",
  "terminal:submit-shell-line",
  "terminal:write-input",
  "terminal:approve-command",
  "terminal:reject-command",
  "terminal:read",
  "terminal:resize",
  "terminal:interrupt",
  "terminal:stop",
]);
const terminalFromIpc = terminalHandlers.get("terminal:create")?.(
  {
    sender: {
      send(channel: string, payload: unknown) {
        pushedTerminalOutput.push({ channel, payload });
      },
    },
  },
  {
    kind: "shell",
    cwd: "G:\\Project\\demo",
    projectRoot: "G:\\Project\\demo",
    columns: 90,
    rows: 28,
  },
) as { id: string; columns: number; rows: number };
terminalOutputCallbacks.at(-1)?.("实时 PTY 帧\r\n");
assert.deepEqual(pushedTerminalOutput, [{
  channel: "terminal:output",
  payload: {
    sessionId: terminalFromIpc.id,
    event: { sequence: 1, data: "实时 PTY 帧\r\n" },
  },
}]);
const commandDecision = terminalHandlers.get("terminal:command")?.(
  undefined,
  terminalFromIpc.id,
  "del .\\build",
) as {
  status: "pending_approval";
  approval: { id: string };
};
const shellDecisionFromIpc = terminalHandlers.get("terminal:submit-shell-line")?.(
  undefined,
  terminalFromIpc.id,
  "del .\\build",
) as {
  status: "pending_approval";
};
assert.equal(shellDecisionFromIpc.status, "pending_approval");
terminalHandlers.get("terminal:bind-runtime-session")?.(
  undefined,
  terminalFromIpc.id,
  "run-1",
  "runtime-terminal-1",
);
await terminalHandlers.get("terminal:approve-command")?.(
  undefined,
  terminalFromIpc.id,
  commandDecision.approval.id,
);
terminalHandlers.get("terminal:resize")?.(undefined, terminalFromIpc.id, 110, 35);
assert.equal(terminalFromIpc.columns, 90);
assert.deepEqual(terminalWrites.slice(-1), ["del .\\build\r"]);
assert.deepEqual(terminalResizes.slice(-1), [{ columns: 110, rows: 35 }]);
terminalHandlers.get("terminal:interrupt")?.(undefined, terminalFromIpc.id);
assert.deepEqual(terminalWrites.slice(-1), ["\u0003"]);
terminalHandlers.get("terminal:stop")?.(undefined, terminalFromIpc.id);

const gitChannels: string[] = [];
const gitHandlers = new Map<string, (...args: unknown[]) => unknown>();
const gitManager = {
  status: async (projectRoot: string) => ({
    rootPath: projectRoot,
    branch: "main",
    detachedHead: false,
    dirty: false,
    changes: [],
  }),
  listWorktrees: async () => [],
  createWorktree: async (_projectRoot: string, branch: string) => ({
    path: "G:\\Project\\demo\\.workflow-platform\\worktrees\\feature-review",
    branch,
    head: null,
    bare: false,
  }),
  removeWorktree: async () => undefined,
  mergeBack: async (projectRoot: string) => ({
    rootPath: projectRoot,
    branch: "main",
    detachedHead: false,
    dirty: false,
    changes: [],
  }),
  push: async () => undefined,
  previewKnowledgeDocument: async (_projectRoot: string, documentId: string, markdown: string) => ({
    relativePath: `.workflow-platform/knowledge/${documentId}.md`,
    previousContent: "",
    nextContent: markdown,
  }),
  publishKnowledgeDocument: async (_projectRoot: string, documentId: string) => ({
    branch: "main",
    relativePath: `.workflow-platform/knowledge/${documentId}.md`,
    commitHash: "abc1234",
  }),
};
registerGitWorkspaceHandlers(
  {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      gitChannels.push(channel);
      gitHandlers.set(channel, handler);
    },
  },
  gitManager,
);
assert.deepEqual(gitChannels, [
  "git:status",
  "git:worktrees",
  "git:create-worktree",
  "git:remove-worktree",
  "git:merge-back",
  "git:push",
  "git:preview-knowledge",
  "git:publish-knowledge",
]);
assert.deepEqual(
  await gitHandlers.get("git:create-worktree")?.(undefined, "G:\\Project\\demo", "feature/review"),
  {
    path: "G:\\Project\\demo\\.workflow-platform\\worktrees\\feature-review",
    branch: "feature/review",
    head: null,
    bare: false,
  },
);
assert.deepEqual(
  await gitHandlers.get("git:preview-knowledge")?.(
    undefined,
    "G:\\Project\\demo",
    "knowledge-document-1",
    "# 知识\n",
  ),
  {
    relativePath: ".workflow-platform/knowledge/knowledge-document-1.md",
    previousContent: "",
    nextContent: "# 知识\n",
  },
);
assert.deepEqual(
  await gitHandlers.get("git:publish-knowledge")?.(
    undefined,
    "G:\\Project\\demo",
    "knowledge-document-1",
    "# 知识\n",
  ),
  {
    branch: "main",
    relativePath: ".workflow-platform/knowledge/knowledge-document-1.md",
    commitHash: "abc1234",
  },
);
