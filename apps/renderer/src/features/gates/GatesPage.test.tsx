import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GatesPage } from "./GatesPage";

afterEach(cleanup);

describe("GatesPage", () => {
  it("loads and waives a gate through the URL-owned Run context", async () => {
    const projection = {
      runId: "run-1", status: "BLOCKED" as const, currentNodeIds: ["plan"], nodeStates: { plan: "BLOCKED" as const },
      allowedActions: [{ id: "waive:plan", label: "提交 Gate 豁免", eventType: "GATE_WAIVED" as const, nodeId: "plan", risk: "high" as const }],
      blockingReasons: [], revision: "5", updatedAt: "2026-08-06T00:00:00Z",
    };
    const gate = { id: "gate-1", nodeId: "plan", gateId: "plan-ready", status: "failed" as const, evidence: ["failed"] };
    const client = {
      getProjectRunOverview: vi.fn(async () => ({ projection })),
      listGates: vi.fn(async () => [gate]),
      submitGate: vi.fn(async () => projection),
    };
    render(<GatesPage state={null} context={{ projectId: "project-1", runId: "run-1" }} client={client} />);

    fireEvent.change(await screen.findByLabelText("Gate 豁免理由：plan-ready"), { target: { value: "approved exception" } });
    fireEvent.click(screen.getByRole("button", { name: "提交 Gate 豁免" }));

    await waitFor(() => expect(client.submitGate).toHaveBeenCalledWith(
      "project-1", "run-1", "plan", "plan-ready", "waived", ["failed"], "approved exception", "5", expect.any(String),
    ));
    expect(client.listGates).toHaveBeenCalledWith("project-1", "run-1", expect.any(AbortSignal));
  });
  it("显示 Gate 证据、授权豁免理由和执行者，并允许下载 Gate 报告", () => {
    const onDownloadGateReport = vi.fn();
    render(
      <GatesPage
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: null,
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [
            {
              id: "gate-result-1",
              nodeId: "plan",
              gateId: "plan-ready",
              status: "waived",
              evidence: [],
              waiverReason: "上线窗口紧急，已获授权",
              actor: { id: "verifier-1", type: "verifier" },
              createdAt: "2026-07-28T00:00:00Z",
            },
          ],
          agentJobs: [],
          agentOutput: [],
        }}
        onDownloadGateReport={onDownloadGateReport}
      />,
    );

    expect(screen.getByText("plan-ready")).toBeInTheDocument();
    expect(screen.getByText("豁免理由：上线窗口紧急，已获授权")).toBeInTheDocument();
    expect(screen.getByText("verifier-1")).toBeInTheDocument();
    expect(screen.getByText("证据：无证据")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下载 Gate 报告" }));
    expect(onDownloadGateReport).toHaveBeenCalledTimes(1);
  });

  it("将可信 Runtime 系统执行者标记为自动 Gate", () => {
    render(
      <GatesPage
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-1",
            status: "IN_PROGRESS",
            currentNodeIds: ["review"],
            nodeStates: { plan: "PASSED", review: "READY" },
            allowedActions: [],
            blockingReasons: [],
            revision: "5",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [
            {
              id: "gate-automatic",
              nodeId: "plan",
              gateId: "plan-ready",
              status: "passed",
              evidence: ["file:///project/plan.md"],
              actor: {
                id: "runtime-auto-gate",
                type: "system",
              },
              createdAt: "2026-07-28T00:00:00Z",
            },
          ],
          agentJobs: [],
          agentOutput: [],
        }}
      />,
    );

    expect(screen.getByText("自动 Gate")).toBeInTheDocument();
  });

  it("仅在 Runtime 允许时提供失败 Gate 的重试入口", () => {
    const onRetryGate = vi.fn();
    render(
      <GatesPage
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-1",
            status: "BLOCKED",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "BLOCKED" },
            allowedActions: [
              { id: "retry:plan", label: "重试 Gate", eventType: "NODE_RETRIED", nodeId: "plan", risk: "medium" },
            ],
            blockingReasons: [{ code: "NODE_BLOCKED", message: "Gate 失败", nodeId: "plan" }],
            revision: "5",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [
            {
              id: "gate-result-1",
              nodeId: "plan",
              gateId: "plan-ready",
              status: "failed",
              evidence: ["测试失败"],
              waiverReason: null,
              failureReason: "缺少回归测试 Evidence",
            },
          ],
          agentJobs: [],
          agentOutput: [],
        }}
        onRetryGate={onRetryGate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "重试 Gate" }));

    expect(screen.getByText("失败原因：缺少回归测试 Evidence")).toBeInTheDocument();
    expect(screen.getByText("当前阻塞：Gate 失败")).toBeInTheDocument();
    expect(screen.getByText("下一步允许的操作：重试 Gate")).toBeInTheDocument();
    expect(screen.getByText("同一 Gate 已记录 1 次审查")).toBeInTheDocument();
    expect(onRetryGate).toHaveBeenCalledWith("plan");
  });

  it("在 Runtime 允许时从 BLOCKED Gate 直接提交豁免理由", () => {
    const onWaiveGate = vi.fn();
    render(
      <GatesPage
        state={{
          connection: "connected",
          workspaceStatus: "ready",
          projectName: "示例项目",
          workflowName: "示例工作流",
          projection: {
            runId: "run-1",
            status: "BLOCKED",
            currentNodeIds: ["plan"],
            nodeStates: { plan: "BLOCKED" },
            allowedActions: [
              { id: "waive:plan", label: "提交 Gate 豁免", eventType: "GATE_WAIVED", nodeId: "plan", risk: "high" },
            ],
            blockingReasons: [{ code: "NODE_BLOCKED", message: "Gate 失败", nodeId: "plan" }],
            revision: "5",
            updatedAt: "2026-07-28T00:00:00Z",
          },
          timeline: [],
          artifacts: [],
          approvals: [],
          gates: [
            {
              id: "gate-result-1",
              nodeId: "plan",
              gateId: "plan-ready",
              status: "failed",
              evidence: ["测试失败"],
              waiverReason: null,
              failureReason: "缺少回归测试 Evidence",
            },
          ],
          agentJobs: [],
          agentOutput: [],
        }}
        onWaiveGate={onWaiveGate}
      />,
    );

    expect(screen.getByRole("button", { name: "提交 Gate 豁免" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Gate 豁免理由：plan-ready"), {
      target: { value: "紧急修复窗口，已获得负责人书面授权。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交 Gate 豁免" }));

    expect(onWaiveGate).toHaveBeenCalledWith(
      "plan",
      "plan-ready",
      "紧急修复窗口，已获得负责人书面授权。",
    );
  });
});
