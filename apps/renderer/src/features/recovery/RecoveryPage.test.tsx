import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RecoveryPage } from "./RecoveryPage";

describe("RecoveryPage", () => {
  it("allows operators to request a Runtime projection rebuild for the current Run", () => {
    const onRebuild = vi.fn();

    render(
      <RecoveryPage
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "demo",
          workflowName: "Demo Workflow",
          projection: {
            runId: "run-1",
            status: "REVIEWING",
            currentNodeIds: [],
            nodeStates: {},
            allowedActions: [],
            blockingReasons: [],
            revision: "3",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        onRebuild={onRebuild}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重建投影" }));
    expect(onRebuild).toHaveBeenCalledTimes(1);
  });

  it("renders Runtime recovery diagnostics before an operator rebuilds a Run", () => {
    const onCleanupOrphans = vi.fn();
    const onResumeAgentCheckpoint = vi.fn();
    const onDiscardAgentCheckpoint = vi.fn();
    render(
      <RecoveryPage
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "demo",
          workflowName: "Demo Workflow",
          projection: {
            runId: "run-1",
            status: "REVIEWING",
            currentNodeIds: [],
            nodeStates: {},
            allowedActions: [],
            blockingReasons: [],
            revision: "3",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [],
          agentJobs: [],
          agentOutput: [],
        }}
        diagnostics={{
          runId: "run-1",
          eventCount: 7,
          projectionStatus: "REVIEWING",
          orphanAgentJobIds: ["job-orphan"],
          orphanTerminalSessionIds: ["terminal-orphan"],
          recoverableAgentCheckpointIds: ["checkpoint-orphan"],
          rebuildAvailable: true,
        }}
        onCleanupOrphans={onCleanupOrphans}
        onResumeAgentCheckpoint={onResumeAgentCheckpoint}
        onDiscardAgentCheckpoint={onDiscardAgentCheckpoint}
      />,
    );

    expect(screen.getByText("事件数：7")).toBeInTheDocument();
    expect(screen.getByText("遗留 Agent：job-orphan")).toBeInTheDocument();
    expect(screen.getByText("待恢复终端：terminal-orphan")).toBeInTheDocument();
    expect(screen.getByText("可恢复 Agent checkpoint：checkpoint-orphan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "清理遗留 Agent" }));
    expect(onCleanupOrphans).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "恢复 Agent checkpoint" }));
    expect(onResumeAgentCheckpoint).toHaveBeenCalledWith("checkpoint-orphan");
    fireEvent.click(screen.getByRole("button", { name: "放弃 Agent checkpoint" }));
    expect(onDiscardAgentCheckpoint).toHaveBeenCalledWith("checkpoint-orphan");
  });
});
