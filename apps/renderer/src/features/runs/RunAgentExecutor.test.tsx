import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentJobSummary, AgentOutputSummary } from "../../app/runtimeClient";

vi.mock("../terminal/TerminalViewport", () => ({
  TerminalViewport: ({ ariaLabel, output, writable, onInput, onInterrupt, onResize }: {
    ariaLabel: string;
    output: Array<{ sequence: number; data: string }>;
    writable?: boolean;
    onInput?: (data: string) => void | Promise<void>;
    onInterrupt?: () => void;
    onResize?: (columns: number, rows: number) => void;
  }) => (
    <section aria-label={ariaLabel} data-writable={String(Boolean(writable))}>
      <pre>{output.map((event) => event.data).join("")}</pre>
      <button type="button" onClick={() => onInput?.("继续\r")}>输入 Agent</button>
      <button type="button" onClick={onInterrupt}>中断 Agent</button>
      <button type="button" onClick={() => onResize?.(120, 40)}>调整 Agent 尺寸</button>
    </section>
  ),
}));

import { RunAgentExecutor } from "./RunAgentExecutor";

afterEach(cleanup);

const job = (
  id: string,
  status: AgentJobSummary["status"],
  mode: AgentJobSummary["mode"] = "interactive",
): AgentJobSummary => ({
  id,
  runId: "run-1",
  nodeId: "node-1",
  provider: id.includes("claude") ? "claude" : "codex",
  status,
  mode,
  command: ["agent"],
  cwd: "G:\\Project\\demo",
  createdAt: "2026-08-07T10:00:00.000Z",
  updatedAt: "2026-08-07T10:00:00.000Z",
});

const persistedOutput: AgentOutputSummary[] = [{
  id: "output-1",
  jobId: "job-completed-claude",
  sequence: 1,
  kind: "stdout",
  payload: { data: "persisted result" },
  createdAt: "2026-08-07T10:00:01.000Z",
}];

const baseProps = () => ({
  runId: "run-1",
  jobs: [
    job("job-running-codex", "RUNNING"),
    job("job-completed-claude", "COMPLETED"),
  ],
  persistedOutput,
  liveOutputByJob: {
    "job-running-codex": [{ sequence: 1, data: "live result" }],
  },
  sessionStateByJob: {
    "job-running-codex": { writable: true },
  },
  selectedJobId: "job-running-codex",
  onSelectJob: vi.fn(),
  onInput: vi.fn(),
  onInterrupt: vi.fn(),
  onResize: vi.fn(),
  onStop: vi.fn(),
});

describe("RunAgentExecutor", () => {
  it("renders named Agent roster items and selects a different Job", () => {
    const props = baseProps();
    render(<RunAgentExecutor {...props} />);

    const roster = screen.getByRole("tablist", { name: "Agents" });
    const runningAgent = within(roster).getByRole("tab", { name: /job-running-codex.*codex.*RUNNING/i });
    expect(runningAgent).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(runningAgent).getByTestId("agent-codename")).not.toBeEmptyDOMElement();
    expect(within(runningAgent).getByTestId("agent-icon")).toBeInTheDocument();
    fireEvent.click(within(roster).getByRole("tab", { name: /job-completed-claude.*claude.*COMPLETED/i }));
    expect(props.onSelectJob).toHaveBeenCalledWith("job-completed-claude");
  });

  it("renders the selected interactive stream and targets its PTY operations", () => {
    const props = baseProps();
    render(<RunAgentExecutor {...props} />);

    const viewport = screen.getByLabelText("Agent 执行器 job-running-codex");
    expect(viewport).toHaveAttribute("data-writable", "true");
    expect(within(viewport).getByText("live result")).toBeInTheDocument();

    fireEvent.click(within(viewport).getByRole("button", { name: "输入 Agent" }));
    fireEvent.click(within(viewport).getByRole("button", { name: "中断 Agent" }));
    fireEvent.click(within(viewport).getByRole("button", { name: "调整 Agent 尺寸" }));
    fireEvent.click(screen.getByRole("button", { name: "停止 Agent" }));

    expect(props.onInput).toHaveBeenCalledWith("job-running-codex", "继续\r");
    expect(props.onInterrupt).toHaveBeenCalledWith("job-running-codex");
    expect(props.onResize).toHaveBeenCalledWith("job-running-codex", 120, 40);
    expect(props.onStop).toHaveBeenCalledWith("job-running-codex");
  });

  it("keeps completed and automatic Jobs read-only", () => {
    const completedProps = baseProps();
    render(<RunAgentExecutor {...completedProps} selectedJobId="job-completed-claude" />);
    expect(screen.getByLabelText("Agent 执行器 job-completed-claude")).toHaveAttribute(
      "data-writable",
      "false",
    );
    expect(screen.getByText("persisted result")).toBeInTheDocument();
    cleanup();

    const automatic = job("job-automatic", "RUNNING", "automatic");
    render(
      <RunAgentExecutor
        {...baseProps()}
        jobs={[automatic]}
        selectedJobId="job-automatic"
        sessionStateByJob={{ "job-automatic": { writable: true } }}
      />,
    );
    expect(screen.getByLabelText("Agent 执行器 job-automatic")).toHaveAttribute(
      "data-writable",
      "false",
    );
    expect(screen.getByText(/自动模式.*只读/)).toBeInTheDocument();
  });

  it("renders an empty state and an optional Run-owned full-screen link", () => {
    const { rerender } = render(<RunAgentExecutor {...baseProps()} jobs={[]} selectedJobId={null} />);
    expect(screen.getByText("尚未启动 Agent")).toBeInTheDocument();

    rerender(<RunAgentExecutor {...baseProps()} showFullScreenLink />);
    expect(screen.getByRole("link", { name: "全屏执行器" })).toHaveAttribute(
      "href",
      "#/runs/run-1/agents/job-running-codex",
    );
  });
});

  it("shows an end-session button for AWAITING_INPUT chat jobs", () => {
    const awaiting = { ...job("job-awaiting", "AWAITING_INPUT", "automatic"), metadata: { conversational: true } };
    const props = {
      ...baseProps(),
      jobs: [awaiting],
      selectedJobId: "job-awaiting",
    };
    render(<RunAgentExecutor {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "结束会话" }));
    expect(props.onStop).toHaveBeenCalledWith("job-awaiting");
  });

  it("requires a second click to delete an agent", () => {
    const props = {
      ...baseProps(),
      onDeleteAgent: vi.fn(),
    };
    render(<RunAgentExecutor {...props} selectedJobId="job-completed-claude" />);
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(props.onDeleteAgent).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "确认删除？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除？" }));
    expect(props.onDeleteAgent).toHaveBeenCalledWith("job-completed-claude");
  });
