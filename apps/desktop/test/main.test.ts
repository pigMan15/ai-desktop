import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  bootstrap,
  createMainWindow,
  registerGitWorkspaceHandlers,
  registerTerminalHandlers,
  registerRuntimeHandlers,
  resolveRendererUrl,
  validateRendererUrl
} from "../src/main/main.js";
import { ManagedRuntime } from "../src/main/runtime.js";
import { TerminalManager, type TerminalSpawnOptions } from "../src/main/terminal.js";

const registeredChannels: string[] = [];
const handlers = new Map<string, () => unknown>();
const fakeIpcMain = {
  handle(channel: string, handler: () => unknown) {
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
await assert.rejects(
  () => proxiedRuntime.request({ path: "https://example.com/agents/providers" }),
  /relative API path/,
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
const lifecycleProcess = new EventEmitter() as EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
};
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
  createWindow: async () => ({ loadURL: async () => undefined }),
  getAllWindows: () => [],
});
await new Promise((resolve) => setImmediate(resolve));
await lifecycleHandlers.get("before-quit")?.();
assert.equal(lifecycleRuntimeStopped, true);

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
    assert.deepEqual(args, []);
    assert.equal(options.cwd, "G:\\Project\\demo");
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
terminalOutputCallbacks[0]?.("正在执行\r\n");
assert.deepEqual(terminalManager.requestCommand(terminal.id, "dir"), {
  status: "executed",
  commandSummary: "dir",
});
terminalManager.interrupt(terminal.id);
terminalManager.resize(terminal.id, 100, 30);

assert.equal(terminal.pid, 6789);
assert.deepEqual(terminalManager.read(terminal.id, 0), [{ sequence: 1, data: "正在执行\r\n" }]);
assert.deepEqual(terminalWrites, ["dir\r", "\u0003"]);
assert.deepEqual(terminalResizes, [{ columns: 100, rows: 30 }]);

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
  "terminal:approve-command",
  "terminal:reject-command",
  "terminal:read",
  "terminal:resize",
  "terminal:interrupt",
  "terminal:stop",
]);
const terminalFromIpc = terminalHandlers.get("terminal:create")?.(
  undefined,
  {
    kind: "shell",
    cwd: "G:\\Project\\demo",
    projectRoot: "G:\\Project\\demo",
    columns: 90,
    rows: 28,
  },
) as { id: string; columns: number; rows: number };
const commandDecision = terminalHandlers.get("terminal:command")?.(
  undefined,
  terminalFromIpc.id,
  "del .\\build",
) as {
  status: "pending_approval";
  approval: { id: string };
};
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
