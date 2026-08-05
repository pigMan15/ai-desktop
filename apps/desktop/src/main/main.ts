import electron from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ManagedRuntime,
  runtimeIpcFailure,
  runtimeIpcSuccess,
  runtimeHealth,
  validateRuntimeRequestPath,
  type RuntimeLogEntry,
  type RuntimeRequestOptions,
  type RuntimeStatus
} from "./runtime.js";
import { TerminalManager, type TerminalCommandDecisionRecord } from "./terminal.js";
import { GitWorkspaceManager } from "./gitWorkspace.js";

const { BrowserWindow, app, dialog, ipcMain } = electron;
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
const defaultTerminalManager = new TerminalManager({
  recordCommandDecision: recordTerminalCommandDecision,
});
const defaultGitWorkspaceManager = new GitWorkspaceManager();

export type IpcMainLike = {
  handle(channel: "runtime:health", handler: () => ReturnType<typeof runtimeHealth>): void;
  handle(channel: "runtime:status", handler: () => RuntimeStatus): void;
  handle(channel: "runtime:restart", handler: () => Promise<RuntimeStatus>): void;
  handle(channel: "runtime:logs", handler: () => RuntimeLogEntry[]): void;
  handle(channel: "runtime:request", handler: (...args: unknown[]) => unknown): void;
  handle(channel: "project:select-directory", handler: (...args: unknown[]) => unknown): void;
};

type TerminalIpcMainLike = {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
};

type TerminalIpcEvent = {
  sender?: {
    send(channel: string, payload: unknown): void;
  };
};

type GitWorkspaceIpcMainLike = {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void;
};

type ProjectDialogLike = {
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
};

type ProjectIpcMainLike = Pick<IpcMainLike, "handle">;

type GitWorkspaceOperations = Pick<
  GitWorkspaceManager,
  | "status"
  | "listWorktrees"
  | "createWorktree"
  | "removeWorktree"
  | "mergeBack"
  | "push"
  | "previewKnowledgeDocument"
  | "publishKnowledgeDocument"
>;

type BrowserWindowLike = {
  loadURL(url: string): Promise<unknown>;
};

type BrowserWindowConstructor = new (options: Electron.BrowserWindowConstructorOptions) => BrowserWindowLike;

type AppLike = {
  whenReady(): Promise<unknown>;
  on(
    event: "activate" | "window-all-closed" | "before-quit",
    listener: () => void | Promise<void>,
  ): void;
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
  ipcMainLike.handle("runtime:request", (_event, options: unknown) => {
    const parsedOptions = parseRuntimeRequestOptions(options);
    return runtimeManager.request(parsedOptions).then(
      (value) => runtimeIpcSuccess(value),
      (error: unknown) => {
        const runtimeError = readRuntimeProxyError(error);
        if (runtimeError) return runtimeIpcFailure(runtimeError);
        throw error;
      },
    );
  });
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
    preloadPath = path.join(currentDir, "../preload/preload.cjs")
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

  const resolvedRendererUrl = resolveRendererUrl({ isPackaged, rendererUrl, rendererDistPath });
  try {
    await window.loadURL(resolvedRendererUrl);
  } catch (error) {
    if (isPackaged || resolvedRendererUrl.startsWith("file:")) {
      throw error;
    }
    await window.loadURL(resolveRendererUrl({
      isPackaged: true,
      rendererDistPath,
    }));
  }
  return window;
}

export function registerTerminalHandlers(
  ipcMainLike: TerminalIpcMainLike = ipcMain,
  terminalManager: TerminalManager = defaultTerminalManager,
): void {
  ipcMainLike.handle("terminal:create", (event: unknown, request: unknown) => {
    const payload = parseTerminalCreateRequest(request);
    const session = terminalManager.create(payload);
    const sender = (event as TerminalIpcEvent | undefined)?.sender;
    if (sender) {
      terminalManager.subscribeOutput(session.id, (output) => {
        sender.send("terminal:output", { sessionId: session.id, event: output });
      });
    }
    return session;
  });
  ipcMainLike.handle(
    "terminal:bind-runtime-session",
    (_event, sessionId: unknown, runId: unknown, runtimeSessionId: unknown) => {
      terminalManager.bindRuntimeSession(
        requireString(sessionId, "Terminal session ID"),
        requireString(runId, "Run ID"),
        requireString(runtimeSessionId, "Runtime terminal session ID"),
      );
    },
  );
  ipcMainLike.handle("terminal:command", (_event, sessionId: unknown, command: unknown) =>
    terminalManager.requestCommand(
      requireString(sessionId, "Terminal session ID"),
      requireString(command, "Terminal command"),
    ),
  );
  ipcMainLike.handle("terminal:submit-shell-line", (_event, sessionId: unknown, command: unknown) =>
    terminalManager.submitShellLine(
      requireString(sessionId, "Terminal session ID"),
      requireString(command, "Terminal command"),
    ),
  );
  ipcMainLike.handle("terminal:write-input", (_event, sessionId: unknown, data: unknown) => {
    terminalManager.writeInput(
      requireString(sessionId, "Terminal session ID"),
      requireString(data, "Terminal input"),
    );
  });
  ipcMainLike.handle("terminal:approve-command", (_event, sessionId: unknown, approvalId: unknown) =>
    terminalManager.approveCommand(
      requireString(sessionId, "Terminal session ID"),
      requireString(approvalId, "Terminal command approval ID"),
    ),
  );
  ipcMainLike.handle("terminal:reject-command", (_event, sessionId: unknown, approvalId: unknown) =>
    terminalManager.rejectCommand(
      requireString(sessionId, "Terminal session ID"),
      requireString(approvalId, "Terminal command approval ID"),
    ),
  );
  ipcMainLike.handle("terminal:read", (_event, sessionId: unknown, afterSequence: unknown) => {
    return terminalManager.read(
      requireString(sessionId, "Terminal session ID"),
      requireNonNegativeInteger(afterSequence, "Terminal output sequence"),
    );
  });
  ipcMainLike.handle(
    "terminal:resize",
    (_event, sessionId: unknown, columns: unknown, rows: unknown) =>
      terminalManager.resize(
        requireString(sessionId, "Terminal session ID"),
        requirePositiveInteger(columns, "Terminal columns"),
        requirePositiveInteger(rows, "Terminal rows"),
      ),
  );
  ipcMainLike.handle("terminal:interrupt", (_event, sessionId: unknown) => {
    terminalManager.interrupt(requireString(sessionId, "Terminal session ID"));
  });
  ipcMainLike.handle("terminal:stop", (_event, sessionId: unknown) => {
    terminalManager.stop(requireString(sessionId, "Terminal session ID"));
  });
}

export function registerGitWorkspaceHandlers(
  ipcMainLike: GitWorkspaceIpcMainLike = ipcMain,
  workspaceManager: GitWorkspaceOperations = defaultGitWorkspaceManager,
): void {
  ipcMainLike.handle("git:status", (_event, projectRoot: unknown) =>
    workspaceManager.status(requireString(projectRoot, "Project root")),
  );
  ipcMainLike.handle("git:worktrees", (_event, projectRoot: unknown) =>
    workspaceManager.listWorktrees(requireString(projectRoot, "Project root")),
  );
  ipcMainLike.handle("git:create-worktree", (_event, projectRoot: unknown, branch: unknown) =>
    workspaceManager.createWorktree(
      requireString(projectRoot, "Project root"),
      requireString(branch, "Git branch"),
    ),
  );
  ipcMainLike.handle("git:remove-worktree", (_event, projectRoot: unknown, worktreePath: unknown) =>
    workspaceManager.removeWorktree(
      requireString(projectRoot, "Project root"),
      requireString(worktreePath, "Worktree path"),
    ),
  );
  ipcMainLike.handle("git:merge-back", (_event, projectRoot: unknown, sourceBranch: unknown) =>
    workspaceManager.mergeBack(
      requireString(projectRoot, "Project root"),
      requireString(sourceBranch, "Source branch"),
    ),
  );
  ipcMainLike.handle("git:push", (_event, projectRoot: unknown) =>
    workspaceManager.push(requireString(projectRoot, "Project root")),
  );
  ipcMainLike.handle(
    "git:preview-knowledge",
    (_event, projectRoot: unknown, documentId: unknown, markdown: unknown) =>
      workspaceManager.previewKnowledgeDocument(
        requireString(projectRoot, "Project root"),
        requireString(documentId, "Knowledge document ID"),
        requireString(markdown, "Knowledge document content"),
      ),
  );
  ipcMainLike.handle(
    "git:publish-knowledge",
    (_event, projectRoot: unknown, documentId: unknown, markdown: unknown) =>
      workspaceManager.publishKnowledgeDocument(
        requireString(projectRoot, "Project root"),
        requireString(documentId, "Knowledge document ID"),
        requireString(markdown, "Knowledge document content"),
      ),
  );
}

export function registerProjectHandlers(
  ipcMainLike: ProjectIpcMainLike = ipcMain,
  projectDialog: ProjectDialogLike = dialog,
): void {
  ipcMainLike.handle("project:select-directory", async () => {
    const selection = await projectDialog.showOpenDialog({
      title: "选择项目目录",
      properties: ["openDirectory"],
    });
    return selection.canceled ? null : selection.filePaths[0] ?? null;
  });
}

function isElectronPackaged(): boolean {
  return Boolean(app?.isPackaged);
}

function runtimeResourcesPath(): string {
  return process.resourcesPath ?? path.resolve(currentDir, "../../../..", "resources");
}

async function recordTerminalCommandDecision(
  decision: TerminalCommandDecisionRecord,
): Promise<void> {
  if (defaultRuntimeManager.status().state !== "ready") {
    throw new Error("Runtime 未就绪，无法记录危险命令审批。");
  }
  await defaultRuntimeManager.request({
    path: `/runs/${encodeURIComponent(decision.runId)}/terminals/${encodeURIComponent(decision.runtimeSessionId)}/command-decisions`,
    body: {
      decision: decision.decision,
      riskLevel: decision.riskLevel,
      commandSummary: decision.commandSummary,
      impact: decision.impact,
      actor: {
        id: "desktop-terminal-human",
        type: "human",
        source: "terminal",
        trusted: true,
      },
      now: new Date().toISOString(),
    },
  });
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
  terminalManager?: Pick<TerminalManager, "stopAll">;
  createWindow?: () => Promise<BrowserWindowLike>;
  getAllWindows?: () => BrowserWindowLike[];
  platform?: NodeJS.Platform;
} = {}): void {
  const {
    appLike = app,
    ipcMainLike = ipcMain,
    runtimeManager = defaultRuntimeManager,
    terminalManager = defaultTerminalManager,
    createWindow = createMainWindow,
    getAllWindows = () => BrowserWindow.getAllWindows(),
    platform = process.platform
  } = options;

  registerRuntimeHandlers(ipcMainLike, runtimeManager);
  registerTerminalHandlers(ipcMainLike);
  registerGitWorkspaceHandlers(ipcMainLike);
  registerProjectHandlers(ipcMainLike);

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
  appLike.on("before-quit", async () => {
    terminalManager.stopAll();
    await runtimeManager.stop();
  });
}

function parseTerminalCreateRequest(request: unknown): {
  kind: "shell" | "codex" | "claude";
  cwd: string;
  projectRoot: string;
  columns: number;
  rows: number;
  initialPrompt?: string;
} {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid terminal create request");
  }
  const payload = request as Record<string, unknown>;
  const kind = payload.kind;
  if (kind !== "shell" && kind !== "codex" && kind !== "claude") {
    throw new Error("Unsupported terminal kind");
  }
  const parsed: {
    kind: "shell" | "codex" | "claude";
    cwd: string;
    projectRoot: string;
    columns: number;
    rows: number;
    initialPrompt?: string;
  } = {
    kind,
    cwd: requireString(payload.cwd, "Terminal cwd"),
    projectRoot: requireString(payload.projectRoot, "Terminal project root"),
    columns: requirePositiveInteger(payload.columns ?? 80, "Terminal columns"),
    rows: requirePositiveInteger(payload.rows ?? 24, "Terminal rows"),
  };
  if (payload.initialPrompt !== undefined) {
    parsed.initialPrompt = requireString(payload.initialPrompt, "Terminal initial prompt");
  }
  return parsed;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function parseRuntimeRequestOptions(value: unknown): RuntimeRequestOptions {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Runtime request options must be an object");
  }
  const options = value as Record<string, unknown>;
  const method = options.method;
  if (method !== undefined && method !== "GET" && method !== "POST") {
    throw new Error("Runtime request method must be GET or POST");
  }
  const headers = parseRuntimeRequestHeaders(options.headers);
  return {
    path: validateRuntimeRequestPath(requireString(options.path, "Runtime request path")),
    ...(method === undefined ? {} : { method }),
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(headers === undefined ? {} : { headers }),
  };
}

function parseRuntimeRequestHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Runtime request headers must be an object");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw new Error("Runtime request header values must be strings");
    }
    if (name.toLowerCase() !== "idempotency-key") {
      throw new Error(`Runtime request header is not allowed: ${name}`);
    }
    headers["Idempotency-Key"] = headerValue;
  }
  return headers;
}

function readRuntimeProxyError(error: unknown): {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId: string | null;
} | null {
  if (!(error instanceof Error)) return null;
  const candidate = error as Error & Record<string, unknown>;
  if (
    !Number.isInteger(candidate.status)
    || (candidate.status as number) < 100
    || (candidate.status as number) > 599
    || typeof candidate.code !== "string"
    || !candidate.code
    || typeof candidate.message !== "string"
    || (candidate.correlationId !== null && typeof candidate.correlationId !== "string")
    || (candidate.details !== undefined && !isPlainRecord(candidate.details))
  ) {
    return null;
  }
  return {
    status: candidate.status as number,
    code: candidate.code,
    message: candidate.message,
    ...(candidate.details === undefined ? {} : { details: candidate.details as Record<string, unknown> }),
    correlationId: candidate.correlationId as string | null,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  );
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}
