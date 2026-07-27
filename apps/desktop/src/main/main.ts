import { BrowserWindow, app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

async function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(currentDir, "../preload/preload.js")
    }
  });

  const rendererUrl = process.env.VITE_DEV_SERVER_URL;

  if (rendererUrl) {
    await window.loadURL(rendererUrl);
    return;
  }

  await window.loadFile(path.join(currentDir, "../../../renderer/index.html"));
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
