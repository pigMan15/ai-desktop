import electron from "electron";
import type {
  RuntimeHealth,
  RuntimeLogEntry,
  RuntimeRequestOptions,
  RuntimeStatus,
} from "../main/runtime.js";
import type { TerminalCommandDecision, TerminalOutput, TerminalSession } from "../main/terminal.js";
import type {
  GitWorkspaceStatus,
  GitWorktree,
  KnowledgeDocumentPreview,
  PublishedKnowledgeDocument,
} from "../main/gitWorkspace.js";

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("workflowRuntime", {
  health: (): Promise<RuntimeHealth> =>
    ipcRenderer.invoke("runtime:health") as Promise<RuntimeHealth>,
  status: (): Promise<RuntimeStatus> =>
    ipcRenderer.invoke("runtime:status") as Promise<RuntimeStatus>,
  restart: (): Promise<RuntimeStatus> =>
    ipcRenderer.invoke("runtime:restart") as Promise<RuntimeStatus>,
  logs: (): Promise<RuntimeLogEntry[]> =>
    ipcRenderer.invoke("runtime:logs") as Promise<RuntimeLogEntry[]>,
  request: (options: RuntimeRequestOptions): Promise<unknown> =>
    ipcRenderer.invoke("runtime:request", options) as Promise<unknown>,
});

contextBridge.exposeInMainWorld("workflowTerminal", {
  create: (request: {
    kind: "shell" | "codex" | "claude";
    cwd: string;
    projectRoot: string;
    columns: number;
    rows: number;
    initialPrompt?: string;
  }): Promise<TerminalSession> =>
    ipcRenderer.invoke("terminal:create", request) as Promise<TerminalSession>,
  bindRuntimeSession: (sessionId: string, runId: string, runtimeSessionId: string): Promise<void> =>
    ipcRenderer.invoke("terminal:bind-runtime-session", sessionId, runId, runtimeSessionId) as Promise<void>,
  requestCommand: (sessionId: string, command: string): Promise<TerminalCommandDecision> =>
    ipcRenderer.invoke("terminal:command", sessionId, command) as Promise<TerminalCommandDecision>,
  submitShellLine: (sessionId: string, command: string): Promise<TerminalCommandDecision> =>
    ipcRenderer.invoke("terminal:submit-shell-line", sessionId, command) as Promise<TerminalCommandDecision>,
  writeInput: (sessionId: string, data: string): Promise<void> =>
    ipcRenderer.invoke("terminal:write-input", sessionId, data) as Promise<void>,
  approveCommand: (sessionId: string, approvalId: string): Promise<TerminalCommandDecision> =>
    ipcRenderer.invoke("terminal:approve-command", sessionId, approvalId) as Promise<TerminalCommandDecision>,
  rejectCommand: (sessionId: string, approvalId: string): Promise<TerminalCommandDecision> =>
    ipcRenderer.invoke("terminal:reject-command", sessionId, approvalId) as Promise<TerminalCommandDecision>,
  read: (sessionId: string, afterSequence: number): Promise<TerminalOutput[]> =>
    ipcRenderer.invoke("terminal:read", sessionId, afterSequence) as Promise<TerminalOutput[]>,
  onOutput: (sessionId: string, listener: (event: TerminalOutput) => void): (() => void) => {
    const handler = (_event: unknown, payload: unknown) => {
      if (!payload || typeof payload !== "object") return;
      const value = payload as { sessionId?: unknown; event?: TerminalOutput };
      if (value.sessionId === sessionId && value.event) listener(value.event);
    };
    ipcRenderer.on("terminal:output", handler);
    return () => ipcRenderer.removeListener("terminal:output", handler);
  },
  resize: (sessionId: string, columns: number, rows: number): Promise<TerminalSession> =>
    ipcRenderer.invoke("terminal:resize", sessionId, columns, rows) as Promise<TerminalSession>,
  interrupt: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("terminal:interrupt", sessionId) as Promise<void>,
  stop: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke("terminal:stop", sessionId) as Promise<void>,
});

contextBridge.exposeInMainWorld("workflowGit", {
  status: (projectRoot: string): Promise<GitWorkspaceStatus> =>
    ipcRenderer.invoke("git:status", projectRoot) as Promise<GitWorkspaceStatus>,
  listWorktrees: (projectRoot: string): Promise<GitWorktree[]> =>
    ipcRenderer.invoke("git:worktrees", projectRoot) as Promise<GitWorktree[]>,
  createWorktree: (projectRoot: string, branch: string): Promise<GitWorktree> =>
    ipcRenderer.invoke("git:create-worktree", projectRoot, branch) as Promise<GitWorktree>,
  removeWorktree: (projectRoot: string, worktreePath: string): Promise<void> =>
    ipcRenderer.invoke("git:remove-worktree", projectRoot, worktreePath) as Promise<void>,
  mergeBack: (projectRoot: string, sourceBranch: string): Promise<GitWorkspaceStatus> =>
    ipcRenderer.invoke("git:merge-back", projectRoot, sourceBranch) as Promise<GitWorkspaceStatus>,
  push: (projectRoot: string): Promise<void> =>
    ipcRenderer.invoke("git:push", projectRoot) as Promise<void>,
  previewKnowledgeDocument: (
    projectRoot: string,
    documentId: string,
    markdown: string,
  ): Promise<KnowledgeDocumentPreview> =>
    ipcRenderer.invoke("git:preview-knowledge", projectRoot, documentId, markdown) as Promise<KnowledgeDocumentPreview>,
  publishKnowledgeDocument: (
    projectRoot: string,
    documentId: string,
    markdown: string,
  ): Promise<PublishedKnowledgeDocument> =>
    ipcRenderer.invoke("git:publish-knowledge", projectRoot, documentId, markdown) as Promise<PublishedKnowledgeDocument>,
});

contextBridge.exposeInMainWorld("workflowProject", {
  selectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("project:select-directory") as Promise<string | null>,
});
