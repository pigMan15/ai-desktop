import assert from "node:assert/strict";
import { createMainWindow, registerRuntimeHandlers, validateRendererUrl } from "../src/main/main.js";

const registeredChannels: string[] = [];
const fakeIpcMain = {
  handle(channel: string, handler: () => unknown) {
    registeredChannels.push(channel);
    assert.deepEqual(handler(), {
      status: "ok",
      service: "workflow-runtime"
    });
  }
};

registerRuntimeHandlers(fakeIpcMain);
registerRuntimeHandlers(fakeIpcMain);

assert.deepEqual(registeredChannels, ["runtime:health"]);

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
