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

declare global {
  interface Window {
    workflowRuntime: {
      health(): Promise<RuntimeHealth>;
      status(): Promise<RuntimeStatus>;
      restart(): Promise<RuntimeStatus>;
      logs(): Promise<RuntimeLogEntry[]>;
      request(options: RuntimeRequestOptions): Promise<unknown>;
    };
    workflowTerminal: {
      create(request: {
        kind: "shell" | "codex" | "claude";
        cwd: string;
        projectRoot: string;
        columns: number;
        rows: number;
        initialPrompt?: string;
      }): Promise<TerminalSession>;
      bindRuntimeSession(sessionId: string, runId: string, runtimeSessionId: string): Promise<void>;
      requestCommand(sessionId: string, command: string): Promise<TerminalCommandDecision>;
      submitShellLine(sessionId: string, command: string): Promise<TerminalCommandDecision>;
      writeInput(sessionId: string, data: string): Promise<void>;
      approveCommand(sessionId: string, approvalId: string): Promise<TerminalCommandDecision>;
      rejectCommand(sessionId: string, approvalId: string): Promise<TerminalCommandDecision>;
      read(sessionId: string, afterSequence: number): Promise<TerminalOutput[]>;
      resize(sessionId: string, columns: number, rows: number): Promise<TerminalSession>;
      interrupt(sessionId: string): Promise<void>;
      stop(sessionId: string): Promise<void>;
    };
    workflowGit: {
      status(projectRoot: string): Promise<GitWorkspaceStatus>;
      listWorktrees(projectRoot: string): Promise<GitWorktree[]>;
      createWorktree(projectRoot: string, branch: string): Promise<GitWorktree>;
      removeWorktree(projectRoot: string, worktreePath: string): Promise<void>;
      mergeBack(projectRoot: string, sourceBranch: string): Promise<GitWorkspaceStatus>;
      push(projectRoot: string): Promise<void>;
      previewKnowledgeDocument(
        projectRoot: string,
        documentId: string,
        markdown: string,
      ): Promise<KnowledgeDocumentPreview>;
      publishKnowledgeDocument(
        projectRoot: string,
        documentId: string,
        markdown: string,
      ): Promise<PublishedKnowledgeDocument>;
    };
    workflowProject: {
      selectDirectory(): Promise<string | null>;
    };
  }
}

export {};
