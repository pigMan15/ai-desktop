import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalPage } from "./TerminalPage";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { workflowTerminal?: unknown }).workflowTerminal;
});

describe("TerminalPage", () => {
  it("在非桌面环境提示终端不可用", () => {
    render(<TerminalPage />);

    expect(screen.getByText("桌面终端不可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建终端" })).toBeDisabled();
  });

  it("创建桌面终端会话、发送输入、读取输出并停止", async () => {
    const create = vi.fn(async () => ({
      id: "terminal-1",
      kind: "shell",
      cwd: "G:\\Project\\demo",
      pid: 1234,
      columns: 100,
      rows: 30,
    }));
    const requestCommand = vi.fn(async () => ({
      status: "executed" as const,
      commandSummary: "echo hello",
    }));
    const read = vi.fn(async (_sessionId: string, afterSequence: number) =>
      afterSequence < 1 ? [{ sequence: 1, data: "hello\r\n" }] : [],
    );
    const stop = vi.fn(async () => undefined);
    const interrupt = vi.fn(async () => undefined);
    const stopSession = vi.fn(async () => undefined);
    const appendOutput = vi.fn(async () => undefined);
    const exportEvidence = vi.fn(async () => undefined);
    Object.defineProperty(window, "workflowTerminal", {
      configurable: true,
      value: {
        create,
        bindRuntimeSession: vi.fn(async () => undefined),
        requestCommand,
        approveCommand: vi.fn(async () => ({ status: "executed" as const, commandSummary: "echo hello" })),
        rejectCommand: vi.fn(async () => ({ status: "blocked" as const, reason: "危险命令已被用户拒绝。" })),
        read,
        resize: vi.fn(async () => undefined),
        interrupt,
        stop,
      },
    });

    const registerSession = vi.fn(async () => ({ id: "runtime-terminal-1" }));
    render(
      <TerminalPage
        runId="run-1"
        projectPath="G:\\Project\\demo"
        nodeId="plan"
        onRegisterSession={registerSession}
        onStopSession={stopSession}
        onAppendOutput={appendOutput}
        onExportEvidence={exportEvidence}
      />,
    );

    fireEvent.change(screen.getByLabelText("项目根目录"), {
      target: { value: "G:\\Project\\demo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));

    expect(await screen.findByText("运行中")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("终端输入"), {
      target: { value: "echo hello" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送输入" }));

    await waitFor(() => expect(screen.getByLabelText("终端输出")).toHaveTextContent("hello"));
    expect(screen.getByLabelText("终端输出").textContent).toBe("hello");

    expect(create).toHaveBeenCalledWith({
      kind: "shell",
      cwd: "G:\\Project\\demo",
      projectRoot: "G:\\Project\\demo",
      columns: 100,
      rows: 30,
    });
    expect(registerSession).toHaveBeenCalledWith({
      runId: "run-1",
      nodeId: "plan",
      kind: "shell",
      cwd: "G:\\Project\\demo",
      pid: 1234,
    });
    expect(requestCommand).toHaveBeenCalledWith("terminal-1", "echo hello");
    fireEvent.click(screen.getByRole("button", { name: "发送 Ctrl+C" }));
    expect(interrupt).toHaveBeenCalledWith("terminal-1");
    await waitFor(() =>
      expect(appendOutput).toHaveBeenCalledWith({
        runId: "run-1",
        sessionId: "runtime-terminal-1",
        stream: "stdout",
        data: "hello\r\n",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "转为 Evidence" }));
    await waitFor(() =>
      expect(exportEvidence).toHaveBeenCalledWith({ runId: "run-1", sessionId: "runtime-terminal-1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "停止终端" }));
    expect(stop).toHaveBeenCalledWith("terminal-1");
    await waitFor(() =>
      expect(stopSession).toHaveBeenCalledWith({ runId: "run-1", sessionId: "runtime-terminal-1" }),
    );
  });

  it("高风险命令必须经中文确认后才会执行", async () => {
    const create = vi.fn(async () => ({
      id: "terminal-1",
      kind: "shell",
      cwd: "G:\\Project\\demo",
      pid: 1234,
      columns: 100,
      rows: 30,
    }));
    const requestCommand = vi.fn(async () => ({
      status: "pending_approval" as const,
      approval: {
        id: "approval-1",
        riskLevel: "high" as const,
        commandSummary: "del .\\build",
        impact: "该命令可能删除项目内文件。",
      },
    }));
    const approveCommand = vi.fn(async () => ({
      status: "executed" as const,
      commandSummary: "del .\\build",
    }));
    const rejectCommand = vi.fn(async () => ({
      status: "blocked" as const,
      reason: "危险命令已被用户拒绝。",
    }));
    const write = vi.fn(async () => undefined);
    Object.defineProperty(window, "workflowTerminal", {
      configurable: true,
      value: {
        create,
        bindRuntimeSession: vi.fn(async () => undefined),
        write,
        read: vi.fn(async () => []),
        resize: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        requestCommand,
        approveCommand,
        rejectCommand,
      },
    });

    render(
      <TerminalPage
        runId="run-1"
        projectPath="G:\\Project\\demo"
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
      />,
    );
    fireEvent.change(screen.getByLabelText("项目根目录"), {
      target: { value: "G:\\Project\\demo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await screen.findByText("运行中");

    fireEvent.change(screen.getByLabelText("终端输入"), {
      target: { value: "del .\\build" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送输入" }));

    expect(await screen.findByRole("dialog", { name: "确认危险命令" })).toBeInTheDocument();
    expect(requestCommand).toHaveBeenCalledWith("terminal-1", "del .\\build");
    expect(write).not.toHaveBeenCalled();
    expect(approveCommand).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认并执行" }));
    await waitFor(() => expect(approveCommand).toHaveBeenCalledWith("terminal-1", "approval-1"));
  });

  it("支持搜索终端输出、复制输出并粘贴到受治理输入框", async () => {
    const writeText = vi.fn(async () => undefined);
    const readText = vi.fn(async () => "echo 状态");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText, readText },
    });
    Object.defineProperty(window, "workflowTerminal", {
      configurable: true,
      value: {
        create: vi.fn(async () => ({
          id: "terminal-search",
          kind: "shell",
          cwd: "G:\\Project\\demo",
          pid: 1234,
          columns: 100,
          rows: 30,
        })),
        bindRuntimeSession: vi.fn(async () => undefined),
        requestCommand: vi.fn(async () => ({ status: "executed" as const, commandSummary: "echo 状态" })),
        approveCommand: vi.fn(async () => ({ status: "executed" as const, commandSummary: "echo 状态" })),
        rejectCommand: vi.fn(async () => ({ status: "blocked" as const, reason: "已拒绝" })),
        read: vi.fn(async (_sessionId: string, afterSequence: number) =>
          afterSequence === 0
            ? [
                { sequence: 1, data: "build started\r\n" },
                { sequence: 2, data: "BUILD completed\r\n" },
              ]
            : [],
        ),
        resize: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
      },
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
    await screen.findByText("运行中");
    await waitFor(() => expect(screen.getByLabelText("终端输出")).toHaveTextContent("BUILD completed"));

    fireEvent.change(screen.getByLabelText("搜索终端输出"), { target: { value: "build" } });
    expect(screen.getByText("搜索结果：1 / 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一个命中" }));
    expect(screen.getByText("搜索结果：2 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "复制输出" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("build started\r\nBUILD completed\r\n"),
    );
    fireEvent.click(screen.getByRole("button", { name: "粘贴到输入" }));
    await waitFor(() => expect(screen.getByLabelText("终端输入")).toHaveValue("echo 状态"));
  });

  it("allows an active session to resize, clear its local view, and restart", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        id: "terminal-1",
        kind: "shell",
        cwd: "G:\\Project\\demo",
        pid: 1234,
        columns: 100,
        rows: 30,
      })
      .mockResolvedValueOnce({
        id: "terminal-2",
        kind: "shell",
        cwd: "G:\\Project\\demo",
        pid: 5678,
        columns: 120,
        rows: 40,
      });
    const resize = vi.fn(async () => ({
      id: "terminal-1",
      kind: "shell",
      cwd: "G:\\Project\\demo",
      pid: 1234,
      columns: 120,
      rows: 40,
    }));
    const stop = vi.fn(async () => undefined);
    Object.defineProperty(window, "workflowTerminal", {
      configurable: true,
      value: {
        create,
        bindRuntimeSession: vi.fn(async () => undefined),
        write: vi.fn(async () => undefined),
        read: vi.fn(async () => [{ sequence: 1, data: "hello\r\n" }]),
        resize,
        stop,
      },
    });

    render(
      <TerminalPage
        runId="run-1"
        projectPath="G:\\Project\\demo"
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
      />,
    );
    fireEvent.change(screen.getByLabelText("项目根目录"), {
      target: { value: "G:\\Project\\demo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await screen.findByText("运行中");

    fireEvent.change(screen.getByLabelText("终端列数"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("终端行数"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "应用尺寸" }));
    expect(resize).toHaveBeenCalledWith("terminal-1", 120, 40);

    fireEvent.click(screen.getByRole("button", { name: "清空输出" }));
    expect(screen.getByLabelText("终端输出")).toHaveTextContent("");

    fireEvent.click(screen.getByRole("button", { name: "重启终端" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(stop).toHaveBeenCalledWith("terminal-1");
  });

  it("keeps the Runtime session binding after a PTY resize so stop and Evidence export still audit the same session", async () => {
    const resize = vi.fn(async () => ({
      id: "terminal-1",
      kind: "shell",
      cwd: "G:\\Project\\demo",
      pid: 1234,
      columns: 120,
      rows: 40,
    }));
    const stopSession = vi.fn(async () => undefined);
    const exportEvidence = vi.fn(async () => undefined);
    Object.defineProperty(window, "workflowTerminal", {
      configurable: true,
      value: {
        create: vi.fn(async () => ({
          id: "terminal-1",
          kind: "shell",
          cwd: "G:\\Project\\demo",
          pid: 1234,
          columns: 100,
          rows: 30,
        })),
        bindRuntimeSession: vi.fn(async () => undefined),
        read: vi.fn(async () => [{ sequence: 1, data: "resize 后仍需审计\r\n" }]),
        requestCommand: vi.fn(async () => ({ status: "executed" as const, commandSummary: "echo ok" })),
        approveCommand: vi.fn(async () => ({ status: "executed" as const, commandSummary: "echo ok" })),
        rejectCommand: vi.fn(async () => ({ status: "blocked" as const, reason: "已拒绝" })),
        resize,
        stop: vi.fn(async () => undefined),
      },
    });

    render(
      <TerminalPage
        runId="run-1"
        projectPath="G:\\Project\\demo"
        nodeId="plan"
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-1" }))}
        onStopSession={stopSession}
        onExportEvidence={exportEvidence}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建终端" }));
    await screen.findByText("运行中");
    await waitFor(() => expect(screen.getByLabelText("终端输出")).toHaveTextContent("仍需审计"));

    fireEvent.change(screen.getByLabelText("终端列数"), { target: { value: "120" } });
    fireEvent.change(screen.getByLabelText("终端行数"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "应用尺寸" }));
    await screen.findByText("已调整为 120 × 40");

    fireEvent.click(screen.getByRole("button", { name: "转为 Evidence" }));
    await waitFor(() =>
      expect(exportEvidence).toHaveBeenCalledWith({ runId: "run-1", sessionId: "runtime-terminal-1" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "停止终端" }));
    await waitFor(() =>
      expect(stopSession).toHaveBeenCalledWith({ runId: "run-1", sessionId: "runtime-terminal-1" }),
    );
  });

  it("replays a persisted session as read-only and creates a new terminal from its configuration", async () => {
    const create = vi.fn(async () => ({
      id: "terminal-new",
      kind: "shell",
      cwd: "G:\\Project\\demo",
      pid: 5678,
      columns: 100,
      rows: 30,
    }));
    const loadHistoryOutput = vi.fn(async () => [
      {
        sequence: 1,
        stream: "stdout" as const,
        data: "历史输出已脱敏\r\n",
        createdAt: "2026-07-28T00:00:00Z",
      },
    ]);
    Object.defineProperty(window, "workflowTerminal", {
      configurable: true,
      value: {
        create,
        bindRuntimeSession: vi.fn(async () => undefined),
        write: vi.fn(async () => undefined),
        read: vi.fn(async () => []),
        resize: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
      },
    });

    render(
      <TerminalPage
        runId="run-1"
        historySessions={[
          {
            id: "terminal-history",
            runId: "run-1",
            nodeId: "plan",
            kind: "shell",
            status: "stopped",
            cwd: "G:\\Project\\demo",
            pid: null,
            createdAt: "2026-07-28T00:00:00Z",
            updatedAt: "2026-07-28T00:01:00Z",
          },
        ]}
        onLoadHistoryOutput={loadHistoryOutput}
        onRegisterSession={vi.fn(async () => ({ id: "runtime-terminal-new" }))}
      />,
    );

    fireEvent.change(screen.getByLabelText("历史终端会话"), {
      target: { value: "terminal-history" },
    });
    fireEvent.click(screen.getByRole("button", { name: "查看历史输出" }));

    expect(await screen.findByLabelText("终端输出")).toHaveTextContent("历史输出已脱敏");
    expect(screen.getByLabelText("终端输入")).toBeDisabled();
    expect(loadHistoryOutput).toHaveBeenCalledWith("terminal-history");

    fireEvent.click(screen.getByRole("button", { name: "基于此会话新建终端" }));
    await screen.findByText("运行中");
    expect(create).toHaveBeenCalledWith({
      kind: "shell",
      cwd: "G:\\Project\\demo",
      projectRoot: "G:\\Project\\demo",
      columns: 100,
      rows: 30,
    });
  });
});
