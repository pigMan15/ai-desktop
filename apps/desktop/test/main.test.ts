import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMainWindow, registerRuntimeHandlers, validateRendererUrl } from "../src/main/main.js";
import { ManagedRuntime } from "../src/main/runtime.js";

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
    fakeSpawnCalls.push({ command, args, cwd: options.cwd });
    return fakeProcess;
  },
  healthCheck: async () => ({ status: "ok", service: "workflow-runtime" }),
  cwd: "G:\\Project\\ai\\ai-desktop",
  port: 8765
});

registerRuntimeHandlers(fakeIpcMain, runtimeManager);
registerRuntimeHandlers(fakeIpcMain, runtimeManager);

assert.deepEqual(registeredChannels, [
  "runtime:health",
  "runtime:status",
  "runtime:restart",
  "runtime:logs"
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

const fakeSpawnCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
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
assert.deepEqual(fakeSpawnCalls[0], {
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
});

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
