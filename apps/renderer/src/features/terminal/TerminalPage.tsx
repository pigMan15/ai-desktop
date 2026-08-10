import { useEffect, useRef, useState } from "react";

import type { TerminalOutputEvent, TerminalSessionSummary } from "../../app/runtimeClient";
import { TerminalViewport, type TerminalViewportOutput } from "./TerminalViewport";
import {
  filterTerminalRunOptions,
  type TerminalRunOption,
} from "./terminalRunModel";

type TerminalKind = "shell" | "codex" | "claude";
const EMPTY_HISTORY_SESSIONS: TerminalSessionSummary[] = [];

export type { TerminalRunOption } from "./terminalRunModel";
export type TerminalNodeOption = { id: string; name: string };
type LegacyTerminalRunOption = { id: string; title: string };

type TerminalSession = {
  id: string;
  runtimeSessionId?: string;
  kind: TerminalKind;
  cwd: string;
  pid: number;
  columns: number;
  rows: number;
};

type TerminalCommandDecision =
  | { status: "executed"; commandSummary: string }
  | {
      status: "pending_approval";
      approval: {
        id: string;
        riskLevel: "high";
        commandSummary: string;
        impact: string;
      };
    }
  | { status: "blocked"; reason: string };

type TerminalBridge = {
  create(request: {
    kind: TerminalKind;
    cwd: string;
    projectRoot: string;
    columns: number;
    rows: number;
    initialPrompt?: string;
  }): Promise<TerminalSession>;
  bindRuntimeSession(sessionId: string, projectId: string, runId: string, runtimeSessionId: string): Promise<void>;
  exportOutput(sessionId: string): Promise<{
    path: string;
    firstSequence: number;
    lastSequence: number;
  }>;
  requestCommand?(sessionId: string, command: string): Promise<TerminalCommandDecision>;
  submitShellLine?(sessionId: string, command: string): Promise<TerminalCommandDecision>;
  writeInput(sessionId: string, data: string): Promise<void>;
  approveCommand(sessionId: string, approvalId: string): Promise<TerminalCommandDecision>;
  rejectCommand(sessionId: string, approvalId: string): Promise<TerminalCommandDecision>;
  read(sessionId: string, afterSequence: number): Promise<TerminalViewportOutput[]>;
  resize(sessionId: string, columns: number, rows: number): Promise<TerminalSession>;
  interrupt(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
};

type TerminalPageProps = {
  projectId?: string;
  runId?: string | null;
  runOptions?: Array<TerminalRunOption | LegacyTerminalRunOption>;
  runOptionsLoading?: boolean;
  runOptionsError?: string;
  onRetryRunOptions?: () => void;
  onLoadRunNodes?: (runId: string) => Promise<TerminalNodeOption[]>;
  onLoadRunSessions?: (runId: string) => Promise<TerminalSessionSummary[]>;
  projectPath?: string;
  executionWorkspace?: string;
  nodeId?: string;
  onRegisterSession?: (session: {
    runId: string;
    nodeId: string;
    kind: TerminalKind;
    cwd: string;
    pid: number;
  }) => Promise<{ id: string }>;
  onStopSession?: (session: { runId: string; sessionId: string }) => Promise<void>;
  onAppendOutput?: (output: {
    runId: string;
    sessionId: string;
    stream: "stdout";
    data: string;
  }) => Promise<void>;
  onExportEvidence?: (session: { runId: string; sessionId: string }) => Promise<{ uri: string }>;
  historySessions?: TerminalSessionSummary[];
  onLoadHistoryOutput?: (runId: string, sessionId: string) => Promise<TerminalOutputEvent[]>;
};

export function TerminalPage({
  projectId = "",
  runId = null,
  runOptions = [],
  runOptionsLoading = false,
  runOptionsError = "",
  onRetryRunOptions,
  onLoadRunNodes,
  onLoadRunSessions,
  projectPath = "",
  executionWorkspace = "",
  nodeId: initialNodeId = "",
  onRegisterSession,
  onStopSession,
  onAppendOutput,
  onExportEvidence,
  historySessions = EMPTY_HISTORY_SESSIONS,
  onLoadHistoryOutput,
}: TerminalPageProps) {
  const bridge = getTerminalBridge();
  const [projectRoot, setProjectRoot] = useState(executionWorkspace || projectPath);
  const [selectedRunId, setSelectedRunId] = useState(runId ?? "");
  const [selectedNodeId, setSelectedNodeId] = useState(initialNodeId);
  const [nodeOptions, setNodeOptions] = useState<TerminalNodeOption[]>(
    initialNodeId ? [{ id: initialNodeId, name: initialNodeId }] : [],
  );
  const [binding, setBinding] = useState(false);
  const [kind, setKind] = useState<TerminalKind>("shell");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [output, setOutput] = useState<TerminalViewportOutput[]>([]);
  const [pendingApproval, setPendingApproval] = useState<
    Extract<TerminalCommandDecision, { status: "pending_approval" }>["approval"] | null
  >(null);
  const [columns, setColumns] = useState(100);
  const [rows, setRows] = useState(30);
  const [historySessionId, setHistorySessionId] = useState("");
  const [displayedHistorySessions, setDisplayedHistorySessions] = useState(historySessions);
  const [runQuery, setRunQuery] = useState("");
  const [showEndedRuns, setShowEndedRuns] = useState(false);
  const [message, setMessage] = useState(bridge ? "等待创建终端" : "桌面终端不可用");
  const [exportStatus, setExportStatus] = useState("");
  const shellLineRef = useRef("");
  const lastResizedSessionRef = useRef<{ sessionId: string; columns: number; rows: number } | null>(null);
  const resizeInFlightRef = useRef(false);
  const runLoadTokenRef = useRef(0);
  const latestSequence = output.reduce((latest, event) => Math.max(latest, event.sequence), 0);
  const normalizedRunOptions = runOptions.map((candidate): TerminalRunOption => "status" in candidate
    ? candidate
    : {
        ...candidate,
        status: "CREATED",
        workflowName: "",
        workflowVersion: "",
        createdAt: "",
        bindable: true,
      });
  const selectedRun = normalizedRunOptions.find((candidate) => candidate.id === selectedRunId) ?? null;
  const selectedRunBindable = !selectedRunId
    || selectedRun?.bindable === true
    || (selectedRunId === runId && !selectedRun);
  const filteredRunOptions = filterTerminalRunOptions(normalizedRunOptions, runQuery, showEndedRuns);
  const visibleRunOptions = selectedRun && !filteredRunOptions.some((candidate) => candidate.id === selectedRun.id)
    ? [selectedRun, ...filteredRunOptions]
    : filteredRunOptions;
  const selectedHistorySession =
    displayedHistorySessions.find((candidate) => candidate.id === historySessionId) ?? null;

  useEffect(() => {
    if (!session) setProjectRoot(executionWorkspace || projectPath);
  }, [executionWorkspace, projectPath, session]);

  useEffect(() => {
    setDisplayedHistorySessions(historySessions);
  }, [historySessions]);

  useEffect(() => {
    if (!bridge || !session) {
      return;
    }
    let disposed = false;
    let timer: number | undefined;

    const readOutput = async () => {
      try {
        const events = await bridge.read(session.id, latestSequence);
        if (disposed) {
          return;
        }
        if (events.length > 0) {
          setOutput((current) => [...current, ...events].slice(-2_000));
          if (selectedRunId && session.runtimeSessionId && onAppendOutput) {
            try {
              await Promise.all(
                events.map((event) =>
                  onAppendOutput({
                    runId: selectedRunId,
                    sessionId: session.runtimeSessionId!,
                    stream: "stdout",
                    data: event.data,
                  }),
                ),
              );
            } catch (error) {
              setMessage(`终端输出同步失败：${errorMessage(error)}`);
            }
          }
        }
      } catch (error) {
        if (!disposed) {
          setMessage(`终端输出读取失败，将自动重试：${errorMessage(error)}`);
        }
      } finally {
        if (!disposed) {
          timer = window.setTimeout(() => void readOutput(), 500);
        }
      }
    };

    void readOutput();
    return () => {
      disposed = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [bridge, onAppendOutput, selectedRunId, session?.id, session?.runtimeSessionId, latestSequence]);

  async function selectRun(nextRunId: string) {
    const loadToken = runLoadTokenRef.current + 1;
    runLoadTokenRef.current = loadToken;
    setSelectedRunId(nextRunId);
    setSelectedNodeId("");
    setNodeOptions([]);
    setHistorySessionId("");
    setDisplayedHistorySessions([]);
    if (!nextRunId) {
      return;
    }
    const nextRun = normalizedRunOptions.find((candidate) => candidate.id === nextRunId);
    if (nextRun && !nextRun.bindable) {
      setMessage("该 Run 已结束，仅支持查看终端历史");
    }
    try {
      const [nodes, sessions] = await Promise.all([
        onLoadRunNodes?.(nextRunId) ?? Promise.resolve([]),
        onLoadRunSessions?.(nextRunId) ?? Promise.resolve([]),
      ]);
      if (runLoadTokenRef.current !== loadToken) {
        return;
      }
      setNodeOptions(nodes);
      setDisplayedHistorySessions(sessions);
      if (nodes.length === 1 && (!nextRun || nextRun.bindable)) {
        setSelectedNodeId(nodes[0].id);
      }
    } catch (error) {
      if (runLoadTokenRef.current === loadToken) {
        setMessage(`加载 Run 终端信息失败：${errorMessage(error)}`);
      }
    }
  }

  async function registerAndBind(nextSession: TerminalSession, existingOutput: TerminalViewportOutput[]) {
    if (!selectedRunId || !selectedRunBindable || !selectedNodeId || !onRegisterSession || !bridge) {
      return nextSession;
    }
    const registeredSession = await onRegisterSession({
      runId: selectedRunId,
      nodeId: selectedNodeId,
      kind: nextSession.kind,
      cwd: nextSession.cwd,
      pid: nextSession.pid,
    });
    await bridge.bindRuntimeSession(nextSession.id, projectId, selectedRunId, registeredSession.id);
    if (onAppendOutput) {
      for (const event of existingOutput) {
        await onAppendOutput({
          runId: selectedRunId,
          sessionId: registeredSession.id,
          stream: "stdout",
          data: event.data,
        });
      }
    }
    return { ...nextSession, runtimeSessionId: registeredSession.id };
  }

  async function createTerminal() {
    if (!bridge || !projectRoot.trim()) {
      return;
    }
    try {
      let nextSession = await bridge.create({
        kind,
        cwd: projectRoot.trim(),
        projectRoot: projectPath.trim() || projectRoot.trim(),
        columns,
        rows,
        initialPrompt: initialPrompt.trim() || undefined,
      });
      nextSession = await registerAndBind(nextSession, []);
      setSession(nextSession);
      lastResizedSessionRef.current = {
        sessionId: nextSession.id,
        columns: nextSession.columns,
        rows: nextSession.rows,
      };
      setColumns(nextSession.columns);
      setRows(nextSession.rows);
      setOutput([]);
      shellLineRef.current = "";
      setPendingApproval(null);
      setMessage("运行中");
    } catch (error) {
      setMessage(`创建终端失败：${errorMessage(error)}`);
    }
  }

  function selectHistorySession(sessionId: string) {
    setHistorySessionId(sessionId);
    const historicalSession = displayedHistorySessions.find((candidate) => candidate.id === sessionId);
    if (!historicalSession) {
      return;
    }
    setProjectRoot(historicalSession.cwd);
    setSelectedRunId(historicalSession.runId);
    setSelectedNodeId(historicalSession.nodeId);
    setNodeOptions([{ id: historicalSession.nodeId, name: historicalSession.nodeId }]);
    setKind(historicalSession.kind as TerminalKind);
    setMessage(`已选择历史会话：${historicalSession.id}`);
  }

  async function loadHistoryOutput() {
    if (!selectedHistorySession || !onLoadHistoryOutput) {
      return;
    }
    try {
      const historyOutput = await onLoadHistoryOutput(
        selectedHistorySession.runId,
        selectedHistorySession.id,
      );
      setSession(null);
      lastResizedSessionRef.current = null;
      setOutput(historyOutput.map(({ sequence, data }) => ({ sequence, data })));
      shellLineRef.current = "";
      setMessage(`已加载历史会话：${selectedHistorySession.id}（只读）`);
    } catch (error) {
      setMessage(`加载历史会话失败：${errorMessage(error)}`);
    }
  }

  async function handleTerminalInput(data: string) {
    if (!bridge || !session) {
      return;
    }
    if (session.kind !== "shell") {
      try {
        await bridge.writeInput(session.id, data);
      } catch (error) {
        setMessage(`发送输入失败：${errorMessage(error)}`);
      }
      return;
    }
    const normalizedInput = stripTerminalControlSequences(data)
      .replace(/\r\n/g, "\r")
      .replace(/\n/g, "\r");
    for (const character of normalizedInput) {
      if (character === "\r") {
        const line = shellLineRef.current;
        shellLineRef.current = "";
        await submitShellLine(line);
      } else if (character === "\u0003") {
        await interruptTerminal();
      } else if (character === "\u007f") {
        shellLineRef.current = shellLineRef.current.slice(0, -1);
      } else if (!/[\u0000-\u001f]/.test(character)) {
        shellLineRef.current += character;
      }
    }
  }

  async function submitShellLine(command: string) {
    if (!bridge || !session || session.kind !== "shell" || !command.trim()) {
      return;
    }
    try {
      const submit = bridge.submitShellLine ?? bridge.requestCommand;
      if (!submit) {
        throw new Error("当前终端桥接不支持 Shell 输入");
      }
      const decision = await submit(session.id, command);
      if (decision.status === "pending_approval") {
        setPendingApproval(decision.approval);
        setMessage("等待确认危险命令");
        return;
      }
      if (decision.status === "blocked") {
        setMessage(decision.reason);
        return;
      }
      setMessage(`已发送命令：${decision.commandSummary}`);
    } catch (error) {
      setMessage(`发送命令失败：${errorMessage(error)}`);
    }
  }

  async function interruptTerminal() {
    if (!bridge || !session) {
      return;
    }
    try {
      await bridge.interrupt(session.id);
      setMessage("已发送 Ctrl+C 中断信号");
    } catch (error) {
      setMessage(`发送 Ctrl+C 失败：${errorMessage(error)}`);
    }
  }

  async function approvePendingCommand() {
    if (!bridge || !session || !pendingApproval) {
      return;
    }
    try {
      const decision = await bridge.approveCommand(session.id, pendingApproval.id);
      setPendingApproval(null);
      if (decision.status === "executed") {
        setMessage(`已批准并执行危险命令：${decision.commandSummary}`);
      } else if (decision.status === "blocked") {
        setMessage(decision.reason);
      } else {
        setMessage("危险命令仍在等待确认。");
      }
    } catch (error) {
      setMessage(`批准危险命令失败：${errorMessage(error)}`);
    }
  }

  async function rejectPendingCommand() {
    if (!bridge || !session || !pendingApproval) {
      return;
    }
    try {
      const decision = await bridge.rejectCommand(session.id, pendingApproval.id);
      setPendingApproval(null);
      setMessage(decision.status === "blocked" ? decision.reason : "危险命令状态异常。");
    } catch (error) {
      setMessage(`拒绝危险命令失败：${errorMessage(error)}`);
    }
  }

  async function stopTerminal() {
    if (!bridge || !session) {
      return;
    }
    try {
      await bridge.stop(session.id);
      if (selectedRunId && session.runtimeSessionId && onStopSession) {
        await onStopSession({ runId: selectedRunId, sessionId: session.runtimeSessionId });
      }
      setSession(null);
      shellLineRef.current = "";
      setMessage("已停止");
    } catch (error) {
      setMessage(`停止终端失败：${errorMessage(error)}`);
    }
  }

  async function resizeTerminal() {
    if (!bridge || !session || columns < 1 || rows < 1) {
      return;
    }
    try {
      const nextSession = await bridge.resize(session.id, columns, rows);
      lastResizedSessionRef.current = {
        sessionId: session.id,
        columns: nextSession.columns,
        rows: nextSession.rows,
      };
      setSession({ ...nextSession, runtimeSessionId: session.runtimeSessionId });
      setMessage(`已调整为 ${nextSession.columns} x ${nextSession.rows}`);
    } catch (error) {
      setMessage(`调整终端尺寸失败：${errorMessage(error)}`);
    }
  }

  async function restartTerminal() {
    if (!bridge || !session) {
      return;
    }
    await stopTerminal();
    await createTerminal();
  }

  async function syncViewportSize(nextColumns: number, nextRows: number) {
    if (!bridge || !session || nextColumns < 1 || nextRows < 1 || resizeInFlightRef.current) {
      return;
    }
    const previous = lastResizedSessionRef.current;
    if (previous?.sessionId === session.id && previous.columns === nextColumns && previous.rows === nextRows) {
      return;
    }
    resizeInFlightRef.current = true;
    try {
      const nextSession = await bridge.resize(session.id, nextColumns, nextRows);
      lastResizedSessionRef.current = {
        sessionId: session.id,
        columns: nextSession.columns,
        rows: nextSession.rows,
      };
      setSession((current) => current?.id === session.id
        ? { ...nextSession, runtimeSessionId: current.runtimeSessionId }
        : current);
      setColumns(nextSession.columns);
      setRows(nextSession.rows);
    } catch (error) {
      setMessage(`终端尺寸同步失败：${errorMessage(error)}`);
    } finally {
      resizeInFlightRef.current = false;
    }
  }

  async function exportEvidence() {
    if (!session) {
      return;
    }
    if (output.length === 0) {
      setExportStatus("终端暂无可导出的输出");
      return;
    }
    try {
      if (session.runtimeSessionId && selectedRunId && onExportEvidence) {
        const artifact = await onExportEvidence({ runId: selectedRunId, sessionId: session.runtimeSessionId });
        setExportStatus(artifact.uri);
        setMessage("已生成 Evidence");
      } else {
        const exported = await bridge!.exportOutput(session.id);
        setExportStatus(exported.path);
        setMessage("终端日志已导出");
      }
    } catch (error) {
      const detail = `导出失败：${errorMessage(error)}`;
      setExportStatus(detail);
      setMessage(detail);
    }
  }

  async function bindCurrentSession() {
    if (!session || session.runtimeSessionId || binding) {
      return;
    }
    setBinding(true);
    try {
      const boundSession = await registerAndBind(session, output);
      if (!boundSession.runtimeSessionId) {
        setMessage("请选择 Run 和绑定节点");
        return;
      }
      setSession(boundSession);
      setMessage("已绑定到 Run");
    } catch (error) {
      setMessage(`绑定 Run 失败：${errorMessage(error)}`);
    } finally {
      setBinding(false);
    }
  }

  return (
    <section id="terminal" className="panel page-workspace page-terminal" aria-labelledby="terminal-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">命令行</p>
          <h2 id="terminal-title">终端</h2>
        </div>
        <span className="status-pill">{message}</span>
      </div>
      {runOptionsError ? (
        <div role="alert" className="button-row">
          <span>{runOptionsError}</span>
          {onRetryRunOptions ? (
            <button className="quiet-button" onClick={onRetryRunOptions}>重新加载 Run</button>
          ) : null}
        </div>
      ) : null}
      <div className="form-grid">
        <label>
          搜索 Run
          <input
            value={runQuery}
            onChange={(event) => setRunQuery(event.target.value)}
            placeholder="输入 Run 名称或 ID"
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={showEndedRuns}
            onChange={(event) => setShowEndedRuns(event.target.checked)}
          />
          显示已结束 Run
        </label>
        <label>
          关联 Run
          <select
            value={selectedRunId}
            onChange={(event) => void selectRun(event.target.value)}
            disabled={runOptionsLoading || binding || Boolean(session?.runtimeSessionId)}
          >
            <option value="">不关联 Run</option>
            {visibleRunOptions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.workflowName
                  ? `${candidate.title} · ${candidate.status} · ${candidate.workflowName} ${candidate.workflowVersion} · ${candidate.createdAt}`
                  : candidate.title}
              </option>
            ))}
            {selectedRunId && !normalizedRunOptions.some((candidate) => candidate.id === selectedRunId) ? (
              <option value={selectedRunId}>{selectedRunId}</option>
            ) : null}
          </select>
        </label>
        <label>
          历史终端会话
          <select
            value={historySessionId}
            onChange={(event) => selectHistorySession(event.target.value)}
            disabled={Boolean(session)}
          >
            <option value="">选择已持久化的会话</option>
            {displayedHistorySessions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.nodeId} / {candidate.kind} / {candidate.status} / {candidate.createdAt}
              </option>
            ))}
          </select>
        </label>
        <label>
          执行工作区
          <input
            value={projectRoot}
            onChange={(event) => setProjectRoot(event.target.value)}
            placeholder="例如 G:\\Project\\demo"
          />
        </label>
        <label>
          绑定节点
          <select
            value={selectedNodeId}
            onChange={(event) => setSelectedNodeId(event.target.value)}
            disabled={binding || Boolean(session?.runtimeSessionId) || !selectedRunId || !selectedRunBindable}
          >
            <option value="">选择节点</option>
            {nodeOptions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
            ))}
          </select>
        </label>
        <label>
          终端类型
          <select value={kind} onChange={(event) => setKind(event.target.value as TerminalKind)}>
            <option value="shell">系统 Shell</option>
            <option value="codex">Codex CLI</option>
            <option value="claude">Claude Code CLI</option>
          </select>
        </label>
        <label>
          启动提示
          <input
            value={initialPrompt}
            onChange={(event) => setInitialPrompt(event.target.value)}
            disabled={Boolean(session) || kind === "shell"}
          />
        </label>
        <label>
          终端列数
          <input
            type="number"
            min="1"
            value={columns}
            onChange={(event) => setColumns(Number(event.target.value))}
            disabled={!session}
          />
        </label>
        <label>
          终端行数
          <input
            type="number"
            min="1"
            value={rows}
            onChange={(event) => setRows(Number(event.target.value))}
            disabled={!session}
          />
        </label>
      </div>
      <div className="button-row">
        <button
          className="quiet-button"
          disabled={Boolean(session) || !selectedHistorySession || !onLoadHistoryOutput}
          onClick={loadHistoryOutput}
        >
          查看历史输出
        </button>
        <button
          className="quiet-button"
          disabled={!bridge || !selectedRunId || !selectedRunBindable || !selectedNodeId || !selectedHistorySession || !onRegisterSession}
          onClick={createTerminal}
        >
          基于此会话新建终端
        </button>
        <button
          className="quiet-button"
          disabled={!bridge || !projectRoot.trim() || Boolean(selectedRunId && (!selectedRunBindable || !selectedNodeId))}
          onClick={createTerminal}
        >
          创建终端
        </button>
        <button className="quiet-button" disabled={!session} onClick={stopTerminal}>
          停止终端
        </button>
        <button className="quiet-button" disabled={!session} onClick={restartTerminal}>
          重启终端
        </button>
        <button className="quiet-button" disabled={!session} onClick={resizeTerminal}>
          应用尺寸
        </button>
        {session && !session.runtimeSessionId && selectedRunBindable ? (
          <button
            className="quiet-button"
            disabled={binding || !selectedRunId || !selectedNodeId || !onRegisterSession}
            onClick={bindCurrentSession}
          >
            绑定到 Run
          </button>
        ) : null}
        <button
          className="quiet-button"
          disabled={!session}
          onClick={exportEvidence}
        >
          {session?.runtimeSessionId ? "导出终端证据" : "导出终端日志"}
        </button>
        {exportStatus ? <p role="status">{exportStatus}</p> : null}
      </div>
      <TerminalViewport
        ariaLabel="ANSI 终端"
        resetKey={session?.id ?? "none"}
        output={output}
        writable={Boolean(session)}
        localEcho={session?.kind === "shell"}
        onInput={handleTerminalInput}
        onInterrupt={interruptTerminal}
        onResize={syncViewportSize}
      />
      {pendingApproval ? (
        <div className="dialog-backdrop" role="presentation">
          <section className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="terminal-command-title">
            <h3 id="terminal-command-title">确认危险命令</h3>
            <p>风险等级：高</p>
            <pre>{pendingApproval.commandSummary}</pre>
            <p>{pendingApproval.impact}</p>
            <div className="button-row">
              <button className="quiet-button" onClick={rejectPendingCommand}>
                取消危险命令
              </button>
              <button className="quiet-button" onClick={approvePendingCommand}>
                确认并执行
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function getTerminalBridge(): TerminalBridge | null {
  return (window as Window & { workflowTerminal?: TerminalBridge }).workflowTerminal ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripTerminalControlSequences(data: string): string {
  return data
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001bO./g, "")
    .replace(/\u001b./g, "");
}
