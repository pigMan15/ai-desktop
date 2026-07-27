import type { RunProjection } from "@workflow-platform/contracts";

export type RuntimeWorkbenchState = {
  connection: "connected" | "unavailable";
  projectName: string;
  workflowName: string;
  projection: RunProjection;
  timeline: Array<{ id: string; type: string; nodeId?: string; createdAt: string }>;
  artifacts: Array<{ id: string; type: string; uri: string; contentHash: string }>;
  approvals: Array<{ id: string; status: string; comment?: string }>;
  gates: Array<{ id: string; status: string; evidence: string[] }>;
};

export async function loadWorkbenchState(): Promise<RuntimeWorkbenchState> {
  return {
    connection: "connected",
    projectName: "demo-workflow",
    workflowName: "Demo Workflow",
    projection: {
      runId: "run-demo",
      status: "REVIEWING",
      currentNodeIds: ["plan"],
      nodeStates: { plan: "AWAITING_APPROVAL" },
      allowedActions: [],
      blockingReasons: [{ code: "WAITING_FOR_HUMAN", message: "等待人工审批", nodeId: "plan" }],
      revision: "3",
      updatedAt: "2026-07-28T00:00:00Z",
    },
    timeline: [{ id: "event-3", type: "ARTIFACT_SUBMITTED", nodeId: "plan", createdAt: "2026-07-28T00:00:00Z" }],
    artifacts: [{ id: "artifact-1", type: "plan", uri: "artifact://plan.md", contentHash: "sha256:demo" }],
    approvals: [{ id: "approval-1", status: "pending" }],
    gates: [{ id: "gate-1", status: "waiting", evidence: ["artifact:plan"] }],
  };
}
