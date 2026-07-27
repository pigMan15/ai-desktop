import { BrowserWindow, app, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeHealth } from "./runtime.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.RENDERER_URL ?? "http://127.0.0.1:5173";

ipcMain.handle("runtime:health", () => runtimeHealth());

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(currentDir, "../preload/preload.js")
    }
  });

  await window.loadURL(rendererUrl);
}

app.whenReady().then(async () => {
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
