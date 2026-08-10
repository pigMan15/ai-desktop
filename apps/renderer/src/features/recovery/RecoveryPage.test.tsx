import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecoveryPage } from "./RecoveryPage";

afterEach(cleanup);

describe("RecoveryPage", () => {
  it("rebuilds through the URL-owned Run context", async () => {
    const diagnostics = { runId: "run-1", eventCount: 1, projectionStatus: "CREATED", orphanAgentJobIds: [], orphanTerminalSessionIds: [], recoverableAgentCheckpointIds: [], rebuildAvailable: true };
    const client = {
      getRecoveryDiagnostics: vi.fn(async () => diagnostics),
      rebuildProjection: vi.fn(async () => ({})),
    };
    render(<RecoveryPage state={null} context={{ projectId: "project-1", runId: "run-1" }} client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "重建投影" }));
    await waitFor(() => expect(client.rebuildProjection).toHaveBeenCalledWith("project-1", "run-1", expect.any(String)));
  });
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
