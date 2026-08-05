import { describe, expect, it } from "vitest";

import type { RunProjection } from "@workflow-platform/contracts";
import type { WorkflowDefinitionSummary } from "../../app/runtimeClient";
import {
  buildRunProgressGraph,
  resolveNodeGuidance,
  resolveRunSuccessors,
} from "./runWorkbenchModel";

function workflow(overrides: Partial<WorkflowDefinitionSummary> = {}): WorkflowDefinitionSummary {
  return {
    id: "release-workflow",
    name: "Release workflow",
    version: "1",
    sourceAdapter: "harness",
    nodes: [
      { id: "verify", name: "Verify", kind: "task", description: "Run verification" },
      {
        id: "implement",
        name: "Implement",
        kind: "agent",
        role: "developer",
        description: "Write the change",
      },
      { id: "review", name: "Review", kind: "approval", description: "Review the change" },
    ],
    edges: [
      { id: "implement-review", from: "implement", to: "review" },
      { id: "review-verify", from: "review", to: "verify" },
    ],
    roles: [],
    gates: [],
    policies: {},
    metadata: {},
    ...overrides,
  };
}

function projection(overrides: Partial<RunProjection> = {}): RunProjection {
  return {
    runId: "run-1",
    status: "IN_PROGRESS",
    currentNodeIds: ["implement"],
    nodeStates: { implement: "RUNNING", review: "PENDING", verify: "PENDING" },
    allowedActions: [],
    blockingReasons: [],
    revision: "1",
    updatedAt: "2026-08-04T00:00:00Z",
    ...overrides,
  };
}

describe("runWorkbenchModel", () => {
  it("presents one successor with its workflow edge condition", () => {
    const result = resolveRunSuccessors(
      workflow({
        edges: [
          {
            id: "implement-review",
            from: "implement",
            to: "review",
            condition: "tests pass",
          } as WorkflowDefinitionSummary["edges"][number],
        ],
      }),
      "implement",
    );

    expect(result).toEqual({
      kind: "single",
      items: [{ node: expect.objectContaining({ id: "review", name: "Review" }), condition: "tests pass" }],
    });
  });

  it("preserves workflow edge order and conditions for multiple successors", () => {
    const result = resolveRunSuccessors(
      workflow({
        edges: [
          { id: "implement-verify", from: "implement", to: "verify", condition: "fast path" } as WorkflowDefinitionSummary["edges"][number],
          { id: "implement-review", from: "implement", to: "review", condition: "review required" } as WorkflowDefinitionSummary["edges"][number],
        ],
      }),
      "implement",
    );

    expect(result.kind).toBe("multiple");
    expect(result.items.map(({ node, condition }) => ({ id: node.id, condition }))).toEqual([
      { id: "verify", condition: "fast path" },
      { id: "review", condition: "review required" },
    ]);
  });

  it("presents no successor when the selected node has no outgoing edge", () => {
    expect(resolveRunSuccessors(workflow(), "verify")).toEqual({ kind: "none", items: [] });
  });

  it("builds successors from workflow edges and marks current nodes and edges", () => {
    const graph = buildRunProgressGraph(workflow(), projection({
      nodeStates: { implement: "RUNNING", review: "READY", verify: "PENDING" },
    }));

    expect(graph.nodes.find((node) => node.id === "implement")).toMatchObject({
      name: "Implement",
      kind: "agent",
      state: "RUNNING",
      status: "current",
      current: true,
      successors: ["review"],
    });
    expect(graph.nodes.find((node) => node.id === "review")?.successors).toEqual(["verify"]);
    expect(graph.edges).toEqual([
      { id: "implement-review", source: "implement", target: "review", status: "current", active: true },
      { id: "review-verify", source: "review", target: "verify", status: "pending", active: false },
    ]);
  });

  it("distinguishes completed, current, and pending branch edges", () => {
    const graph = buildRunProgressGraph(
      workflow({
        nodes: [
          { id: "plan", name: "Plan", kind: "task" },
          { id: "implement", name: "Implement", kind: "agent" },
          { id: "verify", name: "Verify", kind: "task" },
          { id: "alternate", name: "Alternate", kind: "task" },
        ],
        edges: [
          { id: "plan-implement", from: "plan", to: "implement" },
          { id: "implement-verify", from: "implement", to: "verify" },
          { id: "implement-alternate", from: "implement", to: "alternate" },
        ],
      }),
      projection({
        currentNodeIds: ["implement"],
        nodeStates: { plan: "PASSED", implement: "RUNNING", verify: "READY", alternate: "PENDING" },
      }),
    );

    expect(graph.edges).toEqual([
      { id: "plan-implement", source: "plan", target: "implement", status: "completed", active: false },
      { id: "implement-verify", source: "implement", target: "verify", status: "current", active: true },
      { id: "implement-alternate", source: "implement", target: "alternate", status: "pending", active: false },
    ]);
  });

  it("preserves workflow node details needed by the progress map and action panel", () => {
    const definition = workflow();
    const graph = buildRunProgressGraph(definition, projection());
    const implement = graph.nodes.find((node) => node.id === "implement");

    expect(implement).toMatchObject({
      description: "Write the change",
      role: "developer",
      workflowNode: {
        id: "implement",
        name: "Implement",
        kind: "agent",
        role: "developer",
        description: "Write the change",
      },
    });
    expect(implement?.workflowNode).toBe(definition.nodes.find((node) => node.id === "implement"));
  });

  it("uses allowedActions as the only source of plain-language action guidance", () => {
    const result = resolveNodeGuidance({
      workflow: workflow(),
      projection: projection({
        currentNodeIds: ["review"],
        nodeStates: { implement: "PASSED", review: "AWAITING_APPROVAL", verify: "PENDING" },
        allowedActions: [
          {
            id: "approve-review",
            label: "Approve",
            eventType: "HUMAN_APPROVED",
            nodeId: "review",
            risk: "medium",
          },
        ],
      }),
      nodeId: "review",
      projectArchived: false,
    });

    expect(result.primaryAction).toMatchObject({
      id: "approve-review",
      eventType: "HUMAN_APPROVED",
      label: "批准当前节点",
      result: "批准当前节点并继续运行。",
      priority: "primary",
      requiredInput: "none",
    });
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.allowedAction.id).toBe("approve-review");
    expect(result.actions.some((action) => action.eventType === "NODE_STARTED")).toBe(false);
  });

  it("selects the highest-priority allowed action and preserves secondary allowed actions", () => {
    const result = resolveNodeGuidance({
      workflow: workflow(),
      projection: projection({
        allowedActions: [
          {
            id: "waive-review",
            label: "Waive",
            eventType: "GATE_WAIVED",
            nodeId: "review",
            risk: "high",
          },
          {
            id: "approve-review",
            label: "Approve",
            eventType: "HUMAN_APPROVED",
            nodeId: "review",
            risk: "medium",
          },
          {
            id: "pause-run",
            label: "Pause",
            eventType: "RUN_PAUSED",
            risk: "medium",
          },
        ],
      }),
      nodeId: "review",
      projectArchived: false,
    });

    expect(result.primaryAction?.id).toBe("approve-review");
    expect(result.secondaryActions.map((action) => action.id)).toEqual(["waive-review", "pause-run"]);
    expect(result.actions.map((action) => action.id)).toEqual([
      "waive-review",
      "approve-review",
      "pause-run",
    ]);
  });

  it("selects artifact submission before completion regardless of allowed action order", () => {
    const artifactAction = {
      id: "submit-artifact",
      label: "Submit artifact",
      eventType: "ARTIFACT_SUBMITTED" as const,
      nodeId: "implement",
      risk: "low" as const,
    };
    const completeAction = {
      id: "complete-implement",
      label: "Complete",
      eventType: "NODE_COMPLETED" as const,
      nodeId: "implement",
      risk: "low" as const,
    };
    const withCompletionFirst = resolveNodeGuidance({
      workflow: workflow(),
      projection: projection({
        nodeStates: { implement: "AWAITING_ARTIFACT", review: "PENDING", verify: "PENDING" },
        allowedActions: [completeAction, artifactAction],
      }),
      nodeId: "implement",
      projectArchived: false,
    });
    const withArtifactFirst = resolveNodeGuidance({
      workflow: workflow(),
      projection: projection({
        nodeStates: { implement: "AWAITING_ARTIFACT", review: "PENDING", verify: "PENDING" },
        allowedActions: [artifactAction, completeAction],
      }),
      nodeId: "implement",
      projectArchived: false,
    });

    expect(withCompletionFirst.primaryAction).toMatchObject({
      id: "submit-artifact",
      eventType: "ARTIFACT_SUBMITTED",
      label: "扫描并提交所需产物",
      priority: "primary",
    });
    expect(withArtifactFirst.primaryAction?.id).toBe("submit-artifact");
    expect(withCompletionFirst.secondaryActions.map((action) => action.id)).toEqual(["complete-implement"]);
  });

  it("returns Chinese-only labels and results for every Runtime-authorized event", () => {
    const eventTypes: Array<RunProjection["allowedActions"][number]["eventType"]> = [
      "RUN_CREATED",
      "NODE_STARTED",
      "ARTIFACT_SUBMITTED",
      "ARTIFACT_INVALIDATED",
      "APPROVAL_REQUESTED",
      "HUMAN_APPROVED",
      "HUMAN_REJECTED",
      "HUMAN_DEFERRED",
      "GATE_STARTED",
      "GATE_PASSED",
      "GATE_FAILED",
      "GATE_WAIVED",
      "NODE_COMPLETED",
      "NODE_FAILED",
      "NODE_RETRIED",
      "RUN_BLOCKED",
      "RUN_PAUSED",
      "RUN_RESUMED",
      "RUN_COMPLETED",
      "RUN_ARCHIVED",
    ];
    const result = resolveNodeGuidance({
      workflow: workflow(),
      projection: projection({
        allowedActions: eventTypes.map((eventType) => ({
          id: `action-${eventType}`,
          label: eventType,
          eventType,
          risk: "low",
        })),
      }),
      nodeId: "implement",
      projectArchived: false,
    });

    expect(result.actions).toHaveLength(eventTypes.length);
    for (const action of result.actions) {
      expect(action.label).not.toMatch(/[A-Za-z]/);
      expect(action.result).not.toMatch(/[A-Za-z]/);
    }
  });

  it("returns the first Runtime blocking reason when no action is allowed", () => {
    const result = resolveNodeGuidance({
      workflow: workflow(),
      projection: projection({
        allowedActions: [],
        blockingReasons: [
          { code: "MISSING_ARTIFACT", message: "Waiting for plan.md", nodeId: "implement" },
          { code: "OTHER", message: "A later reason" },
        ],
      }),
      nodeId: "implement",
      projectArchived: false,
    });

    expect(result.primaryAction).toBeNull();
    expect(result.waitingMessage).toBe("Waiting for plan.md");
  });

  it("returns an explicit read-only waiting message for archived projects", () => {
    const result = resolveNodeGuidance({
      workflow: workflow(),
      projection: projection({
        allowedActions: [
          {
            id: "start-implement",
            label: "Start",
            eventType: "NODE_STARTED",
            nodeId: "implement",
            risk: "low",
          },
        ],
      }),
      nodeId: "implement",
      projectArchived: true,
    });

    expect(result.primaryAction).toBeNull();
    expect(result.actions).toEqual([]);
    expect(result.readOnly).toBe(true);
    expect(result.waitingMessage).toBe(
      "项目已归档，运行仅可查看；重新导入项目后可恢复操作。",
    );
  });
});
