import * as pty from "node-pty";
import path from "node:path";

export type TerminalKind = "shell" | "codex" | "claude";

export type TerminalSession = {
  id: string;
  kind: TerminalKind;
  cwd: string;
  pid: number;
  columns: number;
  rows: number;
};

export type TerminalOutput = {
  sequence: number;
  data: string;
};

export type TerminalCommandDecision =
  | {
      status: "executed";
      commandSummary: string;
    }
  | {
      status: "pending_approval";
      approval: {
        id: string;
        riskLevel: "high";
        commandSummary: string;
        impact: string;
      };
    }
  | {
      status: "blocked";
      reason: string;
    };

export type TerminalCommandDecisionRecord = {
  runId: string;
  runtimeSessionId: string;
  decision: "approved" | "rejected";
  riskLevel: "high";
  commandSummary: string;
  impact: string;
};

export type TerminalSpawnOptions = {
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
};

type PtyProcess = {
  pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): { dispose(): void };
};

type SpawnPty = (
  command: string,
  args: string[],
  options: TerminalSpawnOptions,
) => PtyProcess;

type ManagedSession = {
  session: TerminalSession;
  process: PtyProcess;
  output: TerminalOutput[];
  outputListeners: Set<(event: TerminalOutput) => void>;
  disposeOutput: () => void;
  projectRoot: string;
  pendingCommands: Map<string, PendingCommand>;
  runtimeBinding?: {
    runId: string;
    runtimeSessionId: string;
  };
};

type PendingCommand = {
  command: string;
  commandSummary: string;
  impact: string;
};

export class TerminalManager {
  private readonly spawnPty: SpawnPty;
  private readonly recordCommandDecision?: (decision: TerminalCommandDecisionRecord) => Promise<void>;
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(options: {
    spawnPty?: SpawnPty;
    recordCommandDecision?: (decision: TerminalCommandDecisionRecord) => Promise<void>;
  } = {}) {
    this.spawnPty =
      options.spawnPty ??
      ((command, args, spawnOptions) =>
        pty.spawn(command, args, {
          cwd: spawnOptions.cwd,
          cols: spawnOptions.cols,
          rows: spawnOptions.rows,
          name: "xterm-color",
        }));
    this.recordCommandDecision = options.recordCommandDecision;
  }

  create(options: {
    kind: TerminalKind;
    cwd: string;
    projectRoot: string;
    columns?: number;
    rows?: number;
    initialPrompt?: string;
  }): TerminalSession {
    const columns = options.columns ?? 80;
    const rows = options.rows ?? 24;
    const cwd = resolveProjectCwd(options.cwd, options.projectRoot);
    const [command, args] = commandFor(options.kind, cwd, options.initialPrompt);
    const process = this.spawnPty(command, args, {
      cwd,
      cols: columns,
      rows,
      env: terminalEnvironment(),
    });
    const session: TerminalSession = {
      id: `terminal-${crypto.randomUUID()}`,
      kind: options.kind,
      cwd,
      pid: process.pid,
      columns,
      rows,
    };
    const output: TerminalOutput[] = [];
    const outputListeners = new Set<(event: TerminalOutput) => void>();
    let nextOutputSequence = 1;
    const disposable = process.onData((data) => {
      const event = { sequence: nextOutputSequence, data };
      output.push(event);
      nextOutputSequence += 1;
      if (output.length > 2_000) {
        output.shift();
      }
      for (const listener of outputListeners) {
        listener(event);
      }
    });
    this.sessions.set(session.id, {
      session,
      process,
      output,
      outputListeners,
      disposeOutput: () => disposable.dispose(),
      projectRoot: path.resolve(options.projectRoot),
      pendingCommands: new Map(),
    });
    return { ...session };
  }

  requestCommand(sessionId: string, command: string): TerminalCommandDecision {
    const managed = this.get(sessionId);
    const analysis = analyzeTerminalCommand(
      command,
      managed.session.cwd,
      managed.projectRoot,
      managed.session.kind,
    );
    if (analysis.status === "blocked") {
      return analysis;
    }
    if (analysis.riskLevel === "high") {
      const approvalId = `terminal-command-approval-${crypto.randomUUID()}`;
      managed.pendingCommands.set(approvalId, {
        command: analysis.command,
        commandSummary: analysis.commandSummary,
        impact: analysis.impact,
      });
      return {
        status: "pending_approval",
        approval: {
          id: approvalId,
          riskLevel: "high",
          commandSummary: analysis.commandSummary,
          impact: analysis.impact,
        },
      };
    }

    managed.process.write(`${analysis.command}\r`);
    return {
      status: "executed",
      commandSummary: analysis.commandSummary,
    };
  }

  submitShellLine(sessionId: string, command: string): TerminalCommandDecision {
    const managed = this.get(sessionId);
    if (managed.session.kind !== "shell") {
      return {
        status: "blocked",
        reason: "Shell line submission is only available for shell terminals",
      };
    }
    return this.requestCommand(sessionId, command);
  }

  writeInput(sessionId: string, data: string): void {
    const managed = this.get(sessionId);
    if (managed.session.kind === "shell") {
      throw new Error("Provider terminal input is only available for Codex and Claude sessions");
    }
    managed.process.write(data);
  }

  bindRuntimeSession(sessionId: string, runId: string, runtimeSessionId: string): void {
    if (!runId.trim() || !runtimeSessionId.trim()) {
      throw new Error("Runtime terminal session binding is required");
    }
    this.get(sessionId).runtimeBinding = { runId, runtimeSessionId };
  }

  async approveCommand(sessionId: string, approvalId: string): Promise<TerminalCommandDecision> {
    const managed = this.get(sessionId);
    const pendingCommand = managed.pendingCommands.get(approvalId);
    if (!pendingCommand) {
      return {
        status: "blocked",
        reason: "危险命令审批不存在、已拒绝或已过期。",
      };
    }
    await this.recordHighRiskDecision(managed, "approved", pendingCommand);
    managed.pendingCommands.delete(approvalId);
    managed.process.write(`${pendingCommand.command}\r`);
    return {
      status: "executed",
      commandSummary: pendingCommand.commandSummary,
    };
  }

  async rejectCommand(sessionId: string, approvalId: string): Promise<TerminalCommandDecision> {
    const managed = this.get(sessionId);
    const pendingCommand = managed.pendingCommands.get(approvalId);
    if (!pendingCommand) {
      return {
        status: "blocked",
        reason: "危险命令审批不存在、已拒绝或已过期。",
      };
    }
    await this.recordHighRiskDecision(managed, "rejected", pendingCommand);
    managed.pendingCommands.delete(approvalId);
    return {
      status: "blocked",
      reason: "危险命令已被用户拒绝。",
    };
  }

  resize(sessionId: string, columns: number, rows: number): TerminalSession {
    if (columns < 1 || rows < 1) {
      throw new Error("Terminal size must be positive");
    }
    const managed = this.get(sessionId);
    managed.process.resize(columns, rows);
    managed.session.columns = columns;
    managed.session.rows = rows;
    return { ...managed.session };
  }

  read(sessionId: string, afterSequence: number): TerminalOutput[] {
    return this.get(sessionId).output.filter((event) => event.sequence > afterSequence);
  }

  subscribeOutput(sessionId: string, listener: (event: TerminalOutput) => void): () => void {
    const managed = this.get(sessionId);
    managed.outputListeners.add(listener);
    return () => managed.outputListeners.delete(listener);
  }

  interrupt(sessionId: string): void {
    this.get(sessionId).process.write("\u0003");
  }

  stop(sessionId: string): void {
    const managed = this.get(sessionId);
    managed.disposeOutput();
    managed.outputListeners.clear();
    managed.process.kill();
    this.sessions.delete(sessionId);
  }

  stopAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.stop(sessionId);
    }
  }

  private get(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Terminal session not found: ${sessionId}`);
    }
    return session;
  }

  private async recordHighRiskDecision(
    managed: ManagedSession,
    decision: "approved" | "rejected",
    pendingCommand: PendingCommand,
  ): Promise<void> {
    if (!this.recordCommandDecision) {
      return;
    }
    if (!managed.runtimeBinding) {
      throw new Error("Runtime 终端会话尚未绑定，不能执行危险命令。");
    }
    await this.recordCommandDecision({
      runId: managed.runtimeBinding.runId,
      runtimeSessionId: managed.runtimeBinding.runtimeSessionId,
      decision,
      riskLevel: "high",
      commandSummary: pendingCommand.commandSummary,
      impact: pendingCommand.impact,
    });
  }
}

function commandFor(kind: TerminalKind, cwd: string, initialPrompt?: string): [string, string[]] {
  const prompt = commandLinePrompt(initialPrompt);
  if (kind === "codex") {
    return [
      process.platform === "win32" ? "codex.cmd" : "codex",
      [
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "--cd",
        cwd,
        prompt ?? "",
      ].filter(Boolean),
    ];
  }
  if (kind === "claude") {
    return [
      process.platform === "win32" ? "claude.cmd" : "claude",
      ["--ax-screen-reader", "--permission-mode", "acceptEdits", prompt ?? ""].filter(
        Boolean,
      ),
    ];
  }
  return [
    process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    process.platform === "win32" ? ["/d", "/k", "chcp 65001>nul"] : [],
  ];
}

function commandLinePrompt(initialPrompt?: string): string | undefined {
  const normalized = initialPrompt?.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return normalized || undefined;
}

function terminalEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PYTHONIOENCODING: "utf-8",
  };
}

function resolveProjectCwd(cwd: string, projectRoot: string): string {
  const root = path.resolve(projectRoot);
  const resolvedCwd = path.resolve(cwd);
  const relative = path.relative(root, resolvedCwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Terminal cwd must stay within project root");
  }
  return resolvedCwd;
}

function analyzeTerminalCommand(
  rawCommand: string,
  cwd: string,
  projectRoot: string,
  kind: TerminalKind,
):
  | { status: "blocked"; reason: string }
  | {
      status: "ready";
      command: string;
      commandSummary: string;
      impact: string;
      riskLevel: "normal" | "high";
    } {
  if (!rawCommand.trim()) {
    return { status: "blocked", reason: "终端命令不能为空。" };
  }
  if (/[\r\n]/.test(rawCommand)) {
    return { status: "blocked", reason: "终端命令必须为单行文本。" };
  }
  if (/[\u0000-\u001f\u007f]/.test(rawCommand)) {
    return { status: "blocked", reason: "终端命令包含不允许的控制字符。" };
  }

  const command = rawCommand.trim();
  if (kind === "codex") {
    return {
      status: "ready",
      command,
      commandSummary: "Codex 交互输入",
      impact: "将发送给已启动的 Codex CLI；其工具调用仍使用 CLI 自身的确认策略。",
      riskLevel: "normal",
    };
  }
  if (/[&|<>^%!?`;]/.test(command)) {
    return { status: "blocked", reason: "终端命令不允许包含 Shell 元字符或命令串联。" };
  }

  const tokens = splitCommand(command);
  if (!tokens) {
    return { status: "blocked", reason: "终端命令的引号不匹配。" };
  }
  const pathValidation = validateCommandPaths(tokens, cwd, projectRoot);
  if (!pathValidation) {
    return { status: "blocked", reason: "命令引用的路径必须位于项目根目录内。" };
  }

  const commandName = normalizeCommandName(tokens[0] ?? "");
  if (SHELL_LAUNCHERS.has(commandName)) {
    return {
      status: "blocked",
      reason: "不允许通过子 Shell 或脚本宿主绕过受治理终端策略。",
    };
  }

  const risk = classifyCommandRisk(commandName, tokens.slice(1));
  return {
    status: "ready",
    command,
    commandSummary: summarizeCommand(commandName, tokens.slice(1)),
    impact: risk === "high" ? "该命令可能删除文件、覆盖工作区、强制推送或影响系统进程。" : "仅在当前项目终端会话中执行。",
    riskLevel: risk,
  };
}

const SHELL_LAUNCHERS = new Set([
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "bash",
  "sh",
  "wscript",
  "cscript",
  "mshta",
  "rundll32",
]);

const HIGH_RISK_COMMANDS = new Set([
  "del",
  "erase",
  "rd",
  "rmdir",
  "rm",
  "remove-item",
  "format",
  "diskpart",
  "shutdown",
  "restart-computer",
  "stop-computer",
  "taskkill",
  "kill",
]);

const SAFE_READONLY_COMMANDS = new Set([
  "cat",
  "cd",
  "chcp",
  "cls",
  "dir",
  "echo",
  "findstr",
  "help",
  "ls",
  "pwd",
  "type",
  "ver",
  "where",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "diff",
  "log",
  "rev-parse",
  "show",
  "status",
]);

function splitCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  for (const character of command) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (quote) {
    return null;
  }
  if (token) {
    tokens.push(token);
  }
  return tokens;
}

function validateCommandPaths(tokens: string[], cwd: string, projectRoot: string): boolean {
  for (const token of tokens.slice(1)) {
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    if (!looksLikePath(value)) {
      continue;
    }
    const candidate = path.win32.isAbsolute(value)
      ? path.win32.resolve(value)
      : path.win32.resolve(cwd, value);
    const relative = path.win32.relative(path.win32.resolve(projectRoot), candidate);
    if (relative.startsWith("..") || path.win32.isAbsolute(relative)) {
      return false;
    }
  }
  return true;
}

function looksLikePath(value: string): boolean {
  return (
    value.startsWith(".") ||
    value.startsWith("\\") ||
    value.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(value)
  );
}

function normalizeCommandName(commandName: string): string {
  return commandName.toLowerCase();
}

function classifyCommandRisk(commandName: string, argumentsList: string[]): "normal" | "high" {
  if (HIGH_RISK_COMMANDS.has(commandName)) {
    return "high";
  }
  if (commandName === "git") {
    const subcommand = argumentsList[0]?.toLowerCase();
    return subcommand && SAFE_GIT_SUBCOMMANDS.has(subcommand) ? "normal" : "high";
  }
  return SAFE_READONLY_COMMANDS.has(commandName) ? "normal" : "high";
}

function summarizeCommand(commandName: string, argumentsList: string[]): string {
  const visibleArguments = argumentsList.slice(0, 4).join(" ");
  return [commandName, visibleArguments].filter(Boolean).join(" ");
}
