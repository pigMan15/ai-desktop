import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalInbox } from "./ApprovalInbox";

afterEach(cleanup);

describe("ApprovalInbox", () => {
  it("submits a commented deferred decision only when Runtime allows it", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalInbox
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-1",
            status: "REVIEWING",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "AWAITING_APPROVAL" },
            allowedActions: [
              {
                id: "defer:plan",
                label: "Defer",
                eventType: "HUMAN_DEFERRED",
                nodeId: "plan",
                risk: "medium",
              },
            ],
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
        onDecide={onDecide}
      />,
    );

    fireEvent.change(screen.getByLabelText("审批评论"), {
      target: { value: "等待安全团队补充证据" },
    });
    fireEvent.click(screen.getByRole("button", { name: "暂缓审批" }));

    expect(onDecide).toHaveBeenCalledWith("plan", "deferred", "等待安全团队补充证据");
    expect(screen.getByRole("button", { name: "批准" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
  });
});
