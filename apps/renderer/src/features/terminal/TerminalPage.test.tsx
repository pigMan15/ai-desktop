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
      <button type="button" onClick={() => onInput?.("npm test\r")}>粘贴命令</button>
      <button type="button" onClick={() => onInput?.("\u001b[D\u001b[Cdir\r")}>方向键后输入 dir</button>
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
      kind: "shell" as const,
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

  it("将一次粘贴的 Shell 文本按完整命令行提交", async () => {
    const bridge = installTerminalBridge();
    render(<TerminalPage projectPath="G:\\Project\\demo" />);

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await waitFor(() => expect(bridge.create).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "粘贴命令" }));

    await waitFor(() => expect(bridge.submitShellLine).toHaveBeenCalledWith("terminal-1", "npm test"));
  });

  it("忽略方向键 ANSI 序列而不把控制字符残片写入命令", async () => {
    const bridge = installTerminalBridge();
    render(<TerminalPage projectPath="G:\\Project\\demo" />);

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await waitFor(() => expect(bridge.create).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "方向键后输入 dir" }));

    await waitFor(() => expect(bridge.submitShellLine).toHaveBeenCalledWith("terminal-1", "dir"));
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
        projectPath={"G:\\Project\\demo"}
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
        projectId="project-1"
        runId="run-1"
        projectPath={"G:\\Project\\demo"}
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await waitFor(() => expect(bridge.create).toHaveBeenCalled());
    expect(bridge.bindRuntimeSession).toHaveBeenCalledWith(
      "terminal-1",
      "project-1",
      "run-1",
      "runtime-terminal-1",
    );
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
    const onExportEvidence = vi.fn(async () => ({
      uri: "file:///G:/Project/demo/.workflow-platform/evidence/terminal.log",
    }));

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

    fireEvent.click(screen.getByRole("button", { name: "导出终端证据" }));
    await waitFor(() => expect(onExportEvidence).toHaveBeenCalledWith({
      runId: "run-1",
      sessionId: "runtime-terminal-1",
    }));

    fireEvent.click(screen.getByRole("button", { name: "停止终端" }));
    await waitFor(() => expect(bridge.stop).toHaveBeenCalledWith("terminal-1"));
    expect(onStopSession).toHaveBeenCalledWith({ runId: "run-1", sessionId: "runtime-terminal-1" });
  });

  it("独立终端导出脱敏日志并显示保存路径", async () => {
    const exportedPath = String.raw`G:\Project\demo\.workflow-platform\terminal-logs\terminal-1-1-1.log`;
    const bridge = installTerminalBridge({
      read: vi.fn(async (_sessionId: string, afterSequence: number) =>
        afterSequence === 0 ? [{ sequence: 1, data: "standalone output\r\n" }] : [],
      ),
      exportOutput: vi.fn(async () => ({
        path: exportedPath,
        firstSequence: 1,
        lastSequence: 1,
      })),
    });
    render(<TerminalPage projectPath="G:\\Project\\demo" />);

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    expect(await screen.findByText("standalone output")).toBeInTheDocument();
    const exportButton = screen.getByRole("button", { name: "导出终端日志" });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);

    await waitFor(() => expect(bridge.exportOutput).toHaveBeenCalledWith("terminal-1"));
    expect(screen.getByRole("status")).toHaveTextContent(exportedPath);
  });

  it("选择非当前 Run 和节点后创建已绑定终端", async () => {
    const bridge = installTerminalBridge();
    const onLoadRunNodes = vi.fn(async (runId: string) =>
      runId === "run-2" ? [{ id: "verify", name: "验证" }] : [],
    );
    const onRegisterSession = vi.fn(async () => ({ id: "runtime-terminal-2" }));

    render(
      <TerminalPage
        projectId="project-1"
        projectPath={"G:\\Project\\demo"}
        runOptions={[
          { id: "run-1", title: "交付流程" },
          { id: "run-2", title: "发布流程" },
        ]}
        onLoadRunNodes={onLoadRunNodes}
        onRegisterSession={onRegisterSession}
      />,
    );

    fireEvent.change(screen.getByLabelText("关联 Run"), { target: { value: "run-2" } });
    await waitFor(() => expect(onLoadRunNodes).toHaveBeenCalledWith("run-2"));
    fireEvent.change(screen.getByLabelText("绑定节点"), { target: { value: "verify" } });
    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));

    await waitFor(() => expect(onRegisterSession).toHaveBeenCalledWith({
      runId: "run-2",
      nodeId: "verify",
      kind: "shell",
      cwd: "G:\\Project\\demo",
      pid: 1234,
    }));
    expect(bridge.bindRuntimeSession).toHaveBeenCalledWith(
      "terminal-1",
      "project-1",
      "run-2",
      "runtime-terminal-2",
    );
  });

  it("默认隐藏已结束 Run，并支持按名称或 ID 搜索", async () => {
    installTerminalBridge();
    render(
      <TerminalPage
        projectPath={"G:\\Project\\demo"}
        runOptions={[
          terminalRun("run-active", "Active Run", "IN_PROGRESS", "Workflow", "2", true),
          terminalRun("run-done", "Done Run", "DONE", "Workflow", "1", false),
          terminalRun("archived-id", "Archived Run", "ARCHIVED", "Legacy", "1", false),
        ]}
      />,
    );

    expect(screen.getByRole("option", { name: /Active Run.*IN_PROGRESS.*Workflow 2/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Done Run/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("显示已结束 Run"));
    expect(screen.getByRole("option", { name: /Done Run.*DONE.*Workflow 1/ })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索 Run"), { target: { value: "archived-id" } });
    expect(screen.getByRole("option", { name: /Archived Run/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Done Run/ })).not.toBeInTheDocument();
  });

  it("已结束 Run 仅允许查看历史，不能创建或绑定终端", async () => {
    installTerminalBridge();
    const onRegisterSession = vi.fn(async () => ({ id: "runtime-terminal-old" }));
    render(
      <TerminalPage
        projectPath={"G:\\Project\\demo"}
        runOptions={[terminalRun("run-done", "Done Run", "DONE", "Legacy", "1", false)]}
        onLoadRunNodes={vi.fn(async () => [{ id: "verify", name: "验证" }])}
        onLoadRunSessions={vi.fn(async () => [])}
        onRegisterSession={onRegisterSession}
      />,
    );

    fireEvent.click(screen.getByLabelText("显示已结束 Run"));
    fireEvent.change(screen.getByLabelText("关联 Run"), { target: { value: "run-done" } });

    expect(await screen.findByText("该 Run 已结束，仅支持查看终端历史")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建终端" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "绑定到 Run" })).not.toBeInTheDocument();
    expect(onRegisterSession).not.toHaveBeenCalled();
  });

  it("按终端内选择的旧 Run 加载会话和历史输出", async () => {
    installTerminalBridge();
    const historySession = {
      id: "history-old",
      runId: "run-old",
      nodeId: "verify",
      kind: "shell" as const,
      status: "stopped" as const,
      cwd: "G:\\Project\\old",
      pid: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-01T00:01:00Z",
    };
    const onLoadRunSessions = vi.fn(async (runId: string) => runId === "run-old" ? [historySession] : []);
    const onLoadHistoryOutput = vi.fn(async (runId: string, sessionId: string) => [
      { sequence: 1, stream: "stdout" as const, data: `${runId}/${sessionId}/old output\r\n`, createdAt: "2026-08-01T00:00:00Z" },
    ]);

    render(
      <TerminalPage
        projectPath={"G:\\Project\\demo"}
        runOptions={[terminalRun("run-old", "Old Run", "DONE", "Legacy", "1", false)]}
        onLoadRunNodes={vi.fn(async () => [{ id: "verify", name: "验证" }])}
        onLoadRunSessions={onLoadRunSessions}
        onLoadHistoryOutput={onLoadHistoryOutput}
      />,
    );

    fireEvent.click(screen.getByLabelText("显示已结束 Run"));
    fireEvent.change(screen.getByLabelText("关联 Run"), { target: { value: "run-old" } });
    await waitFor(() => expect(onLoadRunSessions).toHaveBeenCalledWith("run-old"));
    fireEvent.change(screen.getByLabelText("历史终端会话"), { target: { value: "history-old" } });
    fireEvent.click(screen.getByRole("button", { name: "查看历史输出" }));

    expect(onLoadHistoryOutput).toHaveBeenCalledWith("run-old", "history-old");
    expect(await screen.findByText(/old output/)).toBeInTheDocument();
  });

  it("项目 Run 加载失败时可重试且不影响独立终端", () => {
    installTerminalBridge();
    const onRetryRunOptions = vi.fn();
    render(
      <TerminalPage
        projectPath={"G:\\Project\\demo"}
        runOptionsError="读取项目 Run 失败"
        onRetryRunOptions={onRetryRunOptions}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("读取项目 Run 失败");
    expect(screen.getByRole("button", { name: "创建终端" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重新加载 Run" }));
    expect(onRetryRunOptions).toHaveBeenCalledTimes(1);
  });

  it("将运行中的独立终端绑定到 Run 并按顺序回填已有输出一次", async () => {
    let bound = false;
    let emittedAfterBinding = false;
    const bridge = installTerminalBridge({
      bindRuntimeSession: vi.fn(async () => {
        bound = true;
      }),
      read: vi.fn(async (_sessionId: string, afterSequence: number) =>
        afterSequence === 0
          ? [
              { sequence: 1, data: "first\r\n" },
              { sequence: 2, data: "second\r\n" },
            ]
          : bound && afterSequence === 2 && !emittedAfterBinding
            ? (emittedAfterBinding = true, [{ sequence: 3, data: "third\r\n" }])
          : [],
      ),
    });
    const onRegisterSession = vi.fn(async () => ({ id: "runtime-terminal-2" }));
    const onAppendOutput = vi.fn(async () => undefined);

    render(
      <TerminalPage
        projectId="project-1"
        projectPath="G:\\Project\\demo"
        runOptions={[{ id: "run-2", title: "发布流程" }]}
        onLoadRunNodes={vi.fn(async () => [{ id: "verify", name: "验证" }])}
        onRegisterSession={onRegisterSession}
        onAppendOutput={onAppendOutput}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    expect(await screen.findByText(/first/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("关联 Run"), { target: { value: "run-2" } });
    await screen.findByRole("option", { name: "验证" });
    fireEvent.change(screen.getByLabelText("绑定节点"), { target: { value: "verify" } });
    fireEvent.click(screen.getByRole("button", { name: "绑定到 Run" }));

    await waitFor(() => expect(bridge.bindRuntimeSession).toHaveBeenCalledWith(
      "terminal-1",
      "project-1",
      "run-2",
      "runtime-terminal-2",
    ));
    await waitFor(() => expect(onAppendOutput).toHaveBeenCalledTimes(3));
    expect(onAppendOutput.mock.calls).toEqual([
      [{ runId: "run-2", sessionId: "runtime-terminal-2", stream: "stdout", data: "first\r\n" }],
      [{ runId: "run-2", sessionId: "runtime-terminal-2", stream: "stdout", data: "second\r\n" }],
      [{ runId: "run-2", sessionId: "runtime-terminal-2", stream: "stdout", data: "third\r\n" }],
    ]);
    expect(screen.queryByRole("button", { name: "绑定到 Run" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("关联 Run")).toBeDisabled();
    expect(screen.getByLabelText("绑定节点")).toBeDisabled();
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

  it("creates an independent local terminal without a Run", async () => {
    const bridge = installTerminalBridge();

    render(<TerminalPage projectPath="G:\\Project\\demo" />);
    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));

    await waitFor(() => expect(bridge.create).toHaveBeenCalled());
    expect(bridge.bindRuntimeSession).not.toHaveBeenCalled();
    expect(screen.getByLabelText("ANSI 终端")).toHaveAttribute("data-writable", "true");
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
  exportOutput: ReturnType<typeof vi.fn>;
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
    exportOutput: vi.fn(async () => ({
      path: "G:\\Project\\demo\\.workflow-platform\\terminal-logs\\terminal-1-1-1.log",
      firstSequence: 1,
      lastSequence: 1,
    })),
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

function terminalRun(
  id: string,
  title: string,
  status: "CREATED" | "IN_PROGRESS" | "REVIEWING" | "BLOCKED" | "PAUSED" | "DONE" | "ARCHIVED",
  workflowName: string,
  workflowVersion: string,
  bindable: boolean,
) {
  return {
    id,
    title,
    status,
    workflowName,
    workflowVersion,
    createdAt: "2026-08-01T00:00:00Z",
    bindable,
  };
}
