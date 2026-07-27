import electron from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeHealth } from "./runtime.js";

const { BrowserWindow, app, ipcMain } = electron;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRendererUrl = process.env.RENDERER_URL ?? "http://127.0.0.1:5173";
const registeredRuntimeHandlers = new WeakSet<IpcMainLike>();

export type IpcMainLike = {
  handle(channel: "runtime:health", handler: () => ReturnType<typeof runtimeHealth>): void;
};

type BrowserWindowLike = {
  loadURL(url: string): Promise<unknown>;
};

type BrowserWindowConstructor = new (options: Electron.BrowserWindowConstructorOptions) => BrowserWindowLike;

type AppLike = {
  whenReady(): Promise<unknown>;
  on(event: "activate" | "window-all-closed", listener: () => void | Promise<void>): void;
  quit(): void;
};

export function registerRuntimeHandlers(ipcMainLike: IpcMainLike = ipcMain): void {
  if (registeredRuntimeHandlers.has(ipcMainLike)) {
    return;
  }

  ipcMainLike.handle("runtime:health", () => runtimeHealth());
  registeredRuntimeHandlers.add(ipcMainLike);
}

export async function createMainWindow(options: {
  BrowserWindowClass?: BrowserWindowConstructor;
  rendererUrl?: string;
  preloadPath?: string;
} = {}): Promise<BrowserWindowLike> {
  const {
    BrowserWindowClass = BrowserWindow,
    rendererUrl = defaultRendererUrl,
    preloadPath = path.join(currentDir, "../preload/preload.js")
  } = options;

  const window = new BrowserWindowClass({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: preloadPath
    }
  });

  await window.loadURL(rendererUrl);
  return window;
}

export function bootstrap(options: {
  appLike?: AppLike;
  ipcMainLike?: IpcMainLike;
  createWindow?: () => Promise<BrowserWindowLike>;
  getAllWindows?: () => BrowserWindowLike[];
  platform?: NodeJS.Platform;
} = {}): void {
  const {
    appLike = app,
    ipcMainLike = ipcMain,
    createWindow = createMainWindow,
    getAllWindows = () => BrowserWindow.getAllWindows(),
    platform = process.platform
  } = options;

  registerRuntimeHandlers(ipcMainLike);

  appLike.whenReady().then(async () => {
    await createWindow();

    appLike.on("activate", async () => {
      if (getAllWindows().length === 0) {
        await createWindow();
      }
    });
  });

  appLike.on("window-all-closed", () => {
    if (platform !== "darwin") {
      appLike.quit();
    }
  });
}
