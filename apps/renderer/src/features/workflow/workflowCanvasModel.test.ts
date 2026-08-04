import { describe, expect, it } from "vitest";

import type { WorkflowDefinitionSummary } from "../../app/runtimeClient";
import {
  addFlowEdge,
  applyNodePositions,
  autoLayoutPositions,
  removeFlowEdges,
  toFlowGraph,
} from "./workflowCanvasModel";

function definition(overrides: Partial<WorkflowDefinitionSummary> = {}): WorkflowDefinitionSummary {
  return {
    id: "release-workflow",
    name: "Release workflow",
    version: "1",
    sourceAdapter: "harness",
    nodes: [
      { id: "build", name: "Build", kind: "agent", role: "legacy-builder", agent: { roleId: "engineer" } },
      { id: "review", name: "Review", kind: "approval" },
      { id: "deploy", name: "Deploy", kind: "deploy" },
    ],
    edges: [
      { id: "build-review", from: "build", to: "review" },
      { id: "review-deploy", from: "review", to: "deploy" },
    ],
    roles: [{ id: "engineer", name: "Engineer" }],
    gates: [],
    policies: {},
    metadata: {},
    ...overrides,
  };
}

describe("workflowCanvasModel", () => {
  it("uses deterministic automatic layout when canvas positions are absent", () => {
    const graph = toFlowGraph(definition());

    expect(graph.nodes.map((node) => ({ id: node.id, position: node.position }))).toEqual([
      { id: "build", position: { x: 0, y: 0 } },
      { id: "review", position: { x: 260, y: 0 } },
      { id: "deploy", position: { x: 520, y: 0 } },
    ]);
  });

  it("converts workflow edges to React Flow edges", () => {
    const graph = toFlowGraph(definition());

    expect(graph.edges).toEqual([
      { id: "build-review", source: "build", target: "review" },
      { id: "review-deploy", source: "review", target: "deploy" },
    ]);
  });

  it("does not share canvas position objects with the workflow metadata", () => {
    const original = definition({
      metadata: { canvas: { nodes: { build: { x: 20, y: 30 }, deploy: { x: 40, y: 50 } } } },
    });
    const graph = toFlowGraph(original);
    const positions = { build: { x: 120, y: 80 } };
    const updated = applyNodePositions(original, positions);

    const buildFlowNode = graph.nodes.find((node) => node.id === "build")!;
    buildFlowNode.position.x = 999;
    updated.metadata.canvas!.nodes!.deploy.x = 888;
    updated.metadata.canvas!.nodes!.build.x = 777;

    expect(original.metadata.canvas!.nodes).toEqual({
      build: { x: 20, y: 30 },
      deploy: { x: 40, y: 50 },
    });
    expect(positions).toEqual({ build: { x: 120, y: 80 } });
  });

  it("updates only canvas metadata when applying dragged positions", () => {
    const original = definition({
      metadata: {
        importedAt: "2026-08-01T00:00:00Z",
        canvas: { nodes: { build: { x: 20, y: 30 } } },
      },
    });

    const updated = applyNodePositions(original, {
      build: { x: 120, y: 80 },
      review: { x: 380, y: 80 },
    });

    expect(updated).not.toBe(original);
    expect(updated.metadata).toEqual({
      importedAt: "2026-08-01T00:00:00Z",
      canvas: {
        nodes: {
          build: { x: 120, y: 80 },
          review: { x: 380, y: 80 },
        },
      },
    });
    expect(updated.nodes).toBe(original.nodes);
    expect(updated.edges).toBe(original.edges);
    expect(updated.roles).toBe(original.roles);
  });

  it("adds a stable edge while rejecting duplicate and self-referential connections", () => {
    const original = definition({ edges: [{ id: "edge-build-review", from: "build", to: "review" }] });

    const added = addFlowEdge(original, "review", "deploy");

    expect(added.edges).toEqual([
      { id: "edge-build-review", from: "build", to: "review" },
      { id: "edge-review-deploy", from: "review", to: "deploy" },
    ]);
    expect(addFlowEdge(added, "review", "deploy")).toBe(added);
    expect(addFlowEdge(added, "build", "build")).toBe(added);
  });

  it("removes flow edges by id without changing the original definition", () => {
    const original = definition();

    const updated = removeFlowEdges(original, ["build-review"]);

    expect(updated.edges).toEqual([{ id: "review-deploy", from: "review", to: "deploy" }]);
    expect(original.edges).toHaveLength(2);
  });

  it("lays out branching and disconnected nodes deterministically by id", () => {
    const nodes = [
      { id: "zeta", name: "Zeta", kind: "task" },
      { id: "beta", name: "Beta", kind: "task" },
      { id: "alpha", name: "Alpha", kind: "task" },
      { id: "gamma", name: "Gamma", kind: "task" },
      { id: "orphan-b", name: "Orphan B", kind: "task" },
      { id: "orphan-a", name: "Orphan A", kind: "task" },
    ];
    const edges = [
      { id: "alpha-gamma", from: "alpha", to: "gamma" },
      { id: "beta-gamma", from: "beta", to: "gamma" },
      { id: "gamma-zeta", from: "gamma", to: "zeta" },
    ];

    expect(autoLayoutPositions(nodes, edges)).toEqual({
      alpha: { x: 0, y: 0 },
      beta: { x: 0, y: 150 },
      gamma: { x: 260, y: 0 },
      zeta: { x: 520, y: 0 },
      "orphan-a": { x: 0, y: 300 },
      "orphan-b": { x: 0, y: 450 },
    });
  });

  it("lays out cyclic drafts with stable finite coordinates", () => {
    const nodes = [
      { id: "review", name: "Review", kind: "task" },
      { id: "build", name: "Build", kind: "task" },
      { id: "deploy", name: "Deploy", kind: "task" },
    ];
    const edges = [
      { id: "build-review", from: "build", to: "review" },
      { id: "review-deploy", from: "review", to: "deploy" },
      { id: "deploy-build", from: "deploy", to: "build" },
    ];

    const first = autoLayoutPositions(nodes, edges);
    const second = autoLayoutPositions(nodes, edges);

    expect(first).toEqual(second);
    expect(Object.keys(first).sort()).toEqual(["build", "deploy", "review"]);
    expect(Object.values(first).every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });
});
