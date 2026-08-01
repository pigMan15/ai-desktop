import { useEffect, useRef, useState } from "react";

import type { TerminalOutputEvent, TerminalSessionSummary } from "../../app/runtimeClient";
import { TerminalViewport, type TerminalViewportOutput } from "./TerminalViewport";

type TerminalKind = "shell" | "codex" | "claude";

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
  bindRuntimeSession(sessionId: string, runId: string, runtimeSessionId: string): Promise<void>;
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
  runId?: string | null;
  projectPath?: string;
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
  onExportEvidence?: (session: { runId: string; sessionId: string }) => Promise<void>;
  historySessions?: TerminalSessionSummary[];
  onLoadHistoryOutput?: (sessionId: string) => Promise<TerminalOutputEvent[]>;
};

export function TerminalPage({
  runId = null,
  projectPath = "",
  nodeId: initialNodeId = "",
  onRegisterSession,
  onStopSession,
  onAppendOutput,
  onExportEvidence,
  historySessions = [],
  onLoadHistoryOutput,
}: TerminalPageProps) {
  const bridge = getTerminalBridge();
  const [projectRoot, setProjectRoot] = useState(projectPath);
  const [nodeId, setNodeId] = useState(initialNodeId);
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
  const [message, setMessage] = useState(bridge ? "等待创建终端" : "桌面终端不可用");
  const shellLineRef = useRef("");
  const latestSequence = output.reduce((latest, event) => Math.max(latest, event.sequence), 0);
  const selectedHistorySession =
    historySessions.find((candidate) => candidate.id === historySessionId) ?? null;

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
          if (runId && session.runtimeSessionId && onAppendOutput) {
            try {
              await Promise.all(
                events.map((event) =>
                  onAppendOutput({
                    runId,
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
  }, [bridge, onAppendOutput, runId, session?.id, latestSequence]);

  async function createTerminal() {
    if (!bridge || !runId || !nodeId.trim() || !projectRoot.trim() || !onRegisterSession) {
      return;
    }
    try {
      const nextSession = await bridge.create({
        kind,
        cwd: projectRoot.trim(),
        projectRoot: projectRoot.trim(),
        columns,
        rows,
        initialPrompt: initialPrompt.trim() || undefined,
      });
      try {
        const registeredSession = await onRegisterSession({
          runId,
          nodeId: nodeId.trim(),
          kind: nextSession.kind,
          cwd: nextSession.cwd,
          pid: nextSession.pid,
        });
        nextSession.runtimeSessionId = registeredSession.id;
        await bridge.bindRuntimeSession(nextSession.id, runId, registeredSession.id);
      } catch (error) {
        await bridge.stop(nextSession.id);
        throw error;
      }
      setSession(nextSession);
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
    const historicalSession = historySessions.find((candidate) => candidate.id === sessionId);
    if (!historicalSession) {
      return;
    }
    setProjectRoot(historicalSession.cwd);
    setNodeId(historicalSession.nodeId);
    setKind(historicalSession.kind as TerminalKind);
    setMessage(`已选择历史会话：${historicalSession.id}`);
  }

  async function loadHistoryOutput() {
    if (!selectedHistorySession || !onLoadHistoryOutput) {
      return;
    }
    try {
      const historyOutput = await onLoadHistoryOutput(selectedHistorySession.id);
      setSession(null);
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
    if (data === "\r") {
      const line = shellLineRef.current;
      shellLineRef.current = "";
      await submitShellLine(line);
      return;
    }
    if (data === "\u0003") {
      await interruptTerminal();
      return;
    }
    if (data === "\u007f") {
      shellLineRef.current = shellLineRef.current.slice(0, -1);
      return;
    }
    if (!/[\r\n\u0000-\u001f\u007f]/.test(data)) {
      shellLineRef.current += data;
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
      if (runId && session.runtimeSessionId && onStopSession) {
        await onStopSession({ runId, sessionId: session.runtimeSessionId });
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

  async function exportEvidence() {
    if (!session?.runtimeSessionId || !runId || !onExportEvidence) {
      return;
    }
    try {
      await onExportEvidence({ runId, sessionId: session.runtimeSessionId });
      setMessage("已生成 Evidence");
    } catch (error) {
      setMessage(`导出 Evidence 失败：${errorMessage(error)}`);
    }
  }

  return (
    <section id="terminal" className="panel" aria-labelledby="terminal-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">命令行</p>
          <h2 id="terminal-title">终端</h2>
        </div>
        <span className="status-pill">{message}</span>
      </div>
      <div className="form-grid">
        <label>
          历史终端会话
          <select
            value={historySessionId}
            onChange={(event) => selectHistorySession(event.target.value)}
            disabled={Boolean(session)}
          >
            <option value="">选择已持久化的会话</option>
            {historySessions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.nodeId} / {candidate.kind} / {candidate.status} / {candidate.createdAt}
              </option>
            ))}
          </select>
        </label>
        <label>
          项目根目录
          <input
            value={projectRoot}
            onChange={(event) => setProjectRoot(event.target.value)}
            placeholder="例如 G:\\Project\\demo"
          />
        </label>
        <label>
          绑定节点
          <input
            value={nodeId}
            onChange={(event) => setNodeId(event.target.value)}
            placeholder="例如 plan"
            disabled={Boolean(session)}
          />
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
          disabled={!bridge || !runId || !selectedHistorySession || !onRegisterSession}
          onClick={createTerminal}
        >
          基于此会话新建终端
        </button>
        <button
          className="quiet-button"
          disabled={!bridge || !runId || !nodeId.trim() || !projectRoot.trim() || !onRegisterSession}
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
        <button
          className="quiet-button"
          disabled={!session || output.length === 0 || !runId || !onExportEvidence}
          onClick={exportEvidence}
        >
          转为 Evidence
        </button>
      </div>
      <TerminalViewport
        ariaLabel="ANSI 终端"
        resetKey={session?.id ?? "none"}
        output={output}
        writable={Boolean(session)}
        localEcho={session?.kind === "shell"}
        onInput={handleTerminalInput}
        onInterrupt={interruptTerminal}
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
