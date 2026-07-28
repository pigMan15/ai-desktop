import electron from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ManagedRuntime,
  runtimeHealth,
  type RuntimeLogEntry,
  type RuntimeStatus
} from "./runtime.js";

const { BrowserWindow, app, ipcMain } = electron;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRendererUrl = process.env.RENDERER_URL ?? "http://127.0.0.1:5173";
const registeredRuntimeHandlers = new WeakSet<IpcMainLike>();
const allowedRendererHosts = new Set(["127.0.0.1", "localhost"]);
const defaultRuntimeManager = new ManagedRuntime({
  externalUrl: process.env.WORKFLOW_PLATFORM_RUNTIME_URL,
  runtimeExecutablePath: isElectronPackaged()
    ? path.join(runtimeResourcesPath(), "runtime", "workflow-runtime.exe")
    : undefined,
  cwd: path.resolve(currentDir, "../../../..")
});

export type IpcMainLike = {
  handle(channel: "runtime:health", handler: () => ReturnType<typeof runtimeHealth>): void;
  handle(channel: "runtime:status", handler: () => RuntimeStatus): void;
  handle(channel: "runtime:restart", handler: () => Promise<RuntimeStatus>): void;
  handle(channel: "runtime:logs", handler: () => RuntimeLogEntry[]): void;
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

export function registerRuntimeHandlers(
  ipcMainLike: IpcMainLike = ipcMain,
  runtimeManager: ManagedRuntime = defaultRuntimeManager
): void {
  if (registeredRuntimeHandlers.has(ipcMainLike)) {
    return;
  }

  ipcMainLike.handle("runtime:health", () => runtimeHealth());
  ipcMainLike.handle("runtime:status", () => runtimeManager.status());
  ipcMainLike.handle("runtime:restart", () => runtimeManager.restart());
  ipcMainLike.handle("runtime:logs", () => runtimeManager.logs());
  registeredRuntimeHandlers.add(ipcMainLike);
}

export async function createMainWindow(options: {
  BrowserWindowClass?: BrowserWindowConstructor;
  rendererUrl?: string;
  rendererDistPath?: string;
  isPackaged?: boolean;
  preloadPath?: string;
} = {}): Promise<BrowserWindowLike> {
  const {
    BrowserWindowClass = BrowserWindow,
    rendererUrl = defaultRendererUrl,
    isPackaged = isElectronPackaged(),
    rendererDistPath = isPackaged
      ? path.join(runtimeResourcesPath(), "app.asar", "renderer", "dist")
      : path.resolve(currentDir, "../../../renderer/dist"),
    preloadPath = path.join(currentDir, "../preload/preload.js")
  } = options;

  const window = new BrowserWindowClass({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await window.loadURL(resolveRendererUrl({ isPackaged, rendererUrl, rendererDistPath }));
  return window;
}

function isElectronPackaged(): boolean {
  return Boolean(app?.isPackaged);
}

function runtimeResourcesPath(): string {
  return process.resourcesPath ?? path.resolve(currentDir, "../../../..", "resources");
}

export function validateRendererUrl(rendererUrl: string): string {
  const parsedUrl = new URL(rendererUrl);
  if (parsedUrl.protocol !== "http:" || !allowedRendererHosts.has(parsedUrl.hostname)) {
    throw new Error(`Unsafe renderer URL: ${rendererUrl}`);
  }
  return parsedUrl.toString();
}

export function resolveRendererUrl(options: {
  isPackaged: boolean;
  rendererUrl?: string;
  rendererDistPath?: string;
}): string {
  if (!options.isPackaged) {
    return validateRendererUrl(options.rendererUrl ?? defaultRendererUrl);
  }
  if (!options.rendererDistPath) {
    throw new Error("Packaged renderer dist path is required");
  }
  return pathToFileURL(path.join(options.rendererDistPath, "index.html")).toString();
}

export function bootstrap(options: {
  appLike?: AppLike;
  ipcMainLike?: IpcMainLike;
  runtimeManager?: ManagedRuntime;
  createWindow?: () => Promise<BrowserWindowLike>;
  getAllWindows?: () => BrowserWindowLike[];
  platform?: NodeJS.Platform;
} = {}): void {
  const {
    appLike = app,
    ipcMainLike = ipcMain,
    runtimeManager = defaultRuntimeManager,
    createWindow = createMainWindow,
    getAllWindows = () => BrowserWindow.getAllWindows(),
    platform = process.platform
  } = options;

  registerRuntimeHandlers(ipcMainLike, runtimeManager);

  appLike.whenReady().then(async () => {
    await runtimeManager.start();
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
