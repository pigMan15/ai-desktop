import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentJobSummary } from "../../app/runtimeClient";

vi.mock("../terminal/TerminalViewport", () => ({
  TerminalViewport: ({ ariaLabel, writable }: { ariaLabel: string; writable?: boolean }) => (
    <section aria-label={ariaLabel} data-writable={String(Boolean(writable))} />
  ),
}));

import { RunAgentExecutorPage } from "./RunAgentExecutorPage";

afterEach(cleanup);

const jobs: AgentJobSummary[] = [
  {
    id: "job-1",
    runId: "run-1",
    nodeId: "plan",
    provider: "codex",
    status: "COMPLETED",
    mode: "interactive",
    command: ["codex"],
    cwd: "G:\\Project\\demo",
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
  },
  {
    id: "job-2",
    runId: "run-1",
    nodeId: "plan",
    provider: "claude",
    status: "RUNNING",
    mode: "interactive",
    command: ["claude"],
    cwd: "G:\\Project\\demo",
    createdAt: "2026-08-07T10:01:00.000Z",
    updatedAt: "2026-08-07T10:01:00.000Z",
  },
];

describe("RunAgentExecutorPage", () => {
  it("keeps the full-screen executor inside the Run route", () => {
    render(
      <RunAgentExecutorPage
        runId="run-1"
        jobId="job-2"
        jobs={jobs}
        persistedOutput={[]}
        liveOutputByJob={{}}
        sessionStateByJob={{ "job-2": { writable: true } }}
        onSelectJob={vi.fn()}
        onInput={vi.fn()}
        onInterrupt={vi.fn()}
        onResize={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Agent 执行器" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回 Run" })).toHaveAttribute("href", "#/runs/run-1");
    expect(screen.getByRole("tab", { name: /job-2.*claude.*RUNNING/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByLabelText("Agent 执行器 job-2")).toHaveAttribute("data-writable", "true");
  });
});
