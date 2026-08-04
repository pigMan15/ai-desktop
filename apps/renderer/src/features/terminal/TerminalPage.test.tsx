import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalPage } from "./TerminalPage";

vi.mock("./TerminalViewport", () => ({
  TerminalViewport: ({ ariaLabel, output, writable, localEcho, onInput, onInterrupt, onResize }: {
    ariaLabel: string;
    output: Array<{ sequence: number; data: string }>;
    writable?: boolean;
    localEcho?: boolean;
    onInput?: (data: string) => void | Promise<void>;
    onInterrupt?: () => void;
    onResize?: (columns: number, rows: number) => void;
  }) => (
    <section
      aria-label={ariaLabel}
      className="terminal-viewport"
      data-local-echo={String(Boolean(localEcho))}
      data-writable={String(Boolean(writable))}
    >
      <pre aria-label="mock-terminal-output">{output.map((event) => event.data).join("")}</pre>
      <button type="button" onClick={() => onInput?.("echo hello")}>输入 echo</button>
      <button type="button" onClick={() => onInput?.("del .\\build")}>输入危险命令</button>
      <button type="button" onClick={() => onInput?.("继续\r")}>输入 Agent 回复</button>
      <button type="button" onClick={() => onInput?.("\r")}>回车</button>
      <button type="button" onClick={onInterrupt}>中断</button>
      <button type="button" onClick={() => onResize?.(120, 40)}>自动调整尺寸</button>
    </section>
  ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  delete (window as Window & { workflowTerminal?: unknown }).workflowTerminal;
});

describe("TerminalPage", () => {
  it("在非桌面环境禁用终端创建，并只展示只读视口", () => {
    render(<TerminalPage runId="run-1" projectPath={"G:\\Project\\demo"} nodeId="plan" />);

    expect(screen.getByText("桌面终端不可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建终端" })).toBeDisabled();
    expect(screen.queryByLabelText("终端输入")).not.toBeInTheDocument();
    expect(screen.getByLabelText("ANSI 终端")).toHaveAttribute("data-writable", "false");
  });

  it("在 xterm 中输入 Shell 命令并通过治理桥提交整行", async () => {
    const bridge = installTerminalBridge();
    const onRegisterSession = vi.fn(async () => ({ id: "runtime-terminal-1" }));

    render(
      <TerminalPage
        runId="run-1"
        projectPath={"G:\\Project\\demo"}
        nodeId="plan"
        onRegisterSession={onRegisterSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await waitFor(() => expect(bridge.create).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "输入 echo" }));
    fireEvent.click(screen.getByRole("button", { name: "回车" }));

    await waitFor(() => expect(bridge.submitShellLine).toHaveBeenCalledWith("terminal-1", "echo hello"));
    expect(onRegisterSession).toHaveBeenCalledWith({
      runId: "run-1",
      nodeId: "plan",
      kind: "shell",
      cwd: "G:\\Project\\demo",
      pid: 1234,
    });
    expect(screen.queryByLabelText("终端输入")).not.toBeInTheDocument();
    expect(screen.getByLabelText("ANSI 终端")).toHaveAttribute("data-local-echo", "true");
  });

  it("默认在当前 Run 的执行工作区创建终端", async () => {
    const bridge = installTerminalBridge();
    render(
      <TerminalPage
        runId="run-1"
        projectPath={String.raw`G:\Project\demo`}
        executionWorkspace={String.raw`G:\Project\demo\.workflow-platform\worktrees\dev`}
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await waitFor(() => expect(bridge.create).toHaveBeenCalledWith(expect.objectContaining({
      cwd: String.raw`G:\Project\demo\.workflow-platform\worktrees\dev`,
      projectRoot: String.raw`G:\Project\demo`,
    })));
  });

  it("终端读取暂时失败后继续轮询后续输出", async () => {
    vi.useFakeTimers();
    const bridge = installTerminalBridge({
      read: vi.fn()
        .mockRejectedValueOnce(new Error("temporary read failure"))
        .mockResolvedValueOnce([{ sequence: 1, data: "recovered output\\r\\n" }])
        .mockResolvedValue([]),
    });

    render(
      <TerminalPage
        runId="run-1"
        projectPath="G:\\Project\\demo"
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await vi.waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(500);

    expect(screen.getByLabelText("mock-terminal-output")).toHaveTextContent("recovered output");
  });

  it("Shell 高风险命令从 xterm 输入后弹出确认，并在批准后执行", async () => {
    const bridge = installTerminalBridge({
      submitShellLine: vi.fn(async () => ({
        status: "pending_approval" as const,
        approval: {
          id: "approval-1",
          riskLevel: "high" as const,
          commandSummary: "del .\\build",
          impact: "会删除构建目录。",
        },
      })),
    });

    render(
      <TerminalPage
        runId="run-1"
        projectPath={"G:\\Project\\demo"}
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await waitFor(() => expect(bridge.create).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "输入危险命令" }));
    fireEvent.click(screen.getByRole("button", { name: "回车" }));

    expect(await screen.findByRole("dialog", { name: "确认危险命令" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认并执行" }));

    await waitFor(() => expect(bridge.approveCommand).toHaveBeenCalledWith("terminal-1", "approval-1"));
  });

  it("Codex 和 Claude 终端直接把 xterm 输入写入 provider 进程", async () => {
    const bridge = installTerminalBridge();

    render(
      <TerminalPage
        runId="run-1"
        projectPath={"G:\\Project\\demo"}
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
      />,
    );

    fireEvent.change(screen.getByLabelText("终端类型"), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText("启动提示"), { target: { value: "请继续实现剩余内容" } });
    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await waitFor(() => expect(bridge.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: "claude",
      initialPrompt: "请继续实现剩余内容",
    })));

    fireEvent.click(screen.getByRole("button", { name: "输入 Agent 回复" }));

    await waitFor(() => expect(bridge.writeInput).toHaveBeenCalledWith("terminal-1", "继续\r"));
    expect(bridge.submitShellLine).not.toHaveBeenCalled();
  });

  it("轮询输出后同步 Runtime、支持停止、调整尺寸和导出 Evidence", async () => {
    const bridge = installTerminalBridge({
      read: vi.fn(async (_sessionId: string, afterSequence: number) =>
        afterSequence === 0 ? [{ sequence: 1, data: "构建完成\r\n" }] : [],
      ),
      resize: vi.fn(async () => ({
        id: "terminal-1",
        kind: "shell" as const,
        cwd: "G:\\Project\\demo",
        pid: 1234,
        columns: 120,
        rows: 40,
      })),
    });
    const onAppendOutput = vi.fn(async () => undefined);
    const onStopSession = vi.fn(async () => undefined);
    const onExportEvidence = vi.fn(async () => undefined);

    render(
      <TerminalPage
        runId="run-1"
        projectPath={"G:\\Project\\demo"}
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
        onAppendOutput={onAppendOutput}
        onStopSession={onStopSession}
        onExportEvidence={onExportEvidence}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    expect(await screen.findByText("构建完成")).toBeInTheDocument();
    await waitFor(() => expect(onAppendOutput).toHaveBeenCalledWith({
      runId: "run-1",
      sessionId: "runtime-terminal-1",
      stream: "stdout",
      data: "构建完成\r\n",
    }));

    fireEvent.change(screen.getByLabelText("终端列数"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("终端行数"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "应用尺寸" }));
    await waitFor(() => expect(bridge.resize).toHaveBeenCalledWith("terminal-1", 120, 40));

    fireEvent.click(screen.getByRole("button", { name: "转为 Evidence" }));
    await waitFor(() => expect(onExportEvidence).toHaveBeenCalledWith({
      runId: "run-1",
      sessionId: "runtime-terminal-1",
    }));

    fireEvent.click(screen.getByRole("button", { name: "停止终端" }));
    await waitFor(() => expect(bridge.stop).toHaveBeenCalledWith("terminal-1"));
    expect(onStopSession).toHaveBeenCalledWith({ runId: "run-1", sessionId: "runtime-terminal-1" });
  });

  it("xterm viewport resize 同步到运行中的 PTY", async () => {
    const bridge = installTerminalBridge();

    render(
      <TerminalPage
        runId="run-1"
        projectPath={"G:\\Project\\demo"}
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await waitFor(() => expect(bridge.create).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "自动调整尺寸" }));

    await waitFor(() => expect(bridge.resize).toHaveBeenCalledWith("terminal-1", 120, 40));
  });

  it("相同 viewport 尺寸重复通知时不重复 resize PTY", async () => {
    const bridge = installTerminalBridge();

    render(
      <TerminalPage
        runId="run-1"
        projectPath={"G:\\Project\\demo"}
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await waitFor(() => expect(bridge.create).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "自动调整尺寸" }));
    fireEvent.click(screen.getByRole("button", { name: "自动调整尺寸" }));

    await waitFor(() => expect(bridge.resize).toHaveBeenCalledTimes(1));
  });

  it("加载历史会话为只读输出，并能基于历史配置新建终端", async () => {
    const bridge = installTerminalBridge();
    const onLoadHistoryOutput = vi.fn(async () => [
      { sequence: 1, stream: "stdout" as const, data: "历史输出\r\n", createdAt: "2026-07-29T00:00:00Z" },
    ]);

    render(
      <TerminalPage
        runId="run-1"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-2" }))}
        historySessions={[
          {
            id: "history-1",
            runId: "run-1",
            nodeId: "verify",
            kind: "claude",
            status: "stopped",
            cwd: "G:\\Project\\history",
            pid: null,
            createdAt: "2026-07-29T00:00:00Z",
            updatedAt: "2026-07-29T00:00:00Z",
          },
        ]}
        onLoadHistoryOutput={onLoadHistoryOutput}
      />,
    );

    fireEvent.change(screen.getByLabelText("历史终端会话"), { target: { value: "history-1" } });
    fireEvent.click(screen.getByRole("button", { name: "查看历史输出" }));

    expect(await screen.findByText("历史输出")).toBeInTheDocument();
    expect(screen.getByLabelText("ANSI 终端")).toHaveAttribute("data-writable", "false");

    fireEvent.click(screen.getByRole("button", { name: "基于此会话新建终端" }));
    await waitFor(() => expect(bridge.create).toHaveBeenCalledWith(expect.objectContaining({
      kind: "claude",
      cwd: "G:\\Project\\history",
      projectRoot: "G:\\Project\\history",
    })));
  });
});

type TerminalBridgeMock = {
  create: ReturnType<typeof vi.fn>;
  bindRuntimeSession: ReturnType<typeof vi.fn>;
  submitShellLine: ReturnType<typeof vi.fn>;
  writeInput: ReturnType<typeof vi.fn>;
  approveCommand: ReturnType<typeof vi.fn>;
  rejectCommand: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function installTerminalBridge(overrides: Partial<TerminalBridgeMock> = {}) {
  const bridge = {
    create: vi.fn(async (request: { kind: "shell" | "codex" | "claude"; cwd: string; columns: number; rows: number }) => ({
      id: "terminal-1",
      kind: request.kind,
      cwd: request.cwd,
      pid: 1234,
      columns: request.columns,
      rows: request.rows,
    })),
    bindRuntimeSession: vi.fn(async () => undefined),
    submitShellLine: vi.fn(async (_sessionId: string, command: string) => ({
      status: "executed" as const,
      commandSummary: command,
    })),
    writeInput: vi.fn(async () => undefined),
    approveCommand: vi.fn(async () => ({ status: "executed" as const, commandSummary: "del .\\build" })),
    rejectCommand: vi.fn(async () => ({ status: "blocked" as const, reason: "已取消危险命令" })),
    read: vi.fn(async () => []),
    resize: vi.fn(async (_sessionId: string, columns: number, rows: number) => ({
      id: "terminal-1",
      kind: "shell" as const,
      cwd: "G:\\Project\\demo",
      pid: 1234,
      columns,
      rows,
    })),
    interrupt: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "workflowTerminal", {
    configurable: true,
    value: bridge,
  });
  return bridge;
}
