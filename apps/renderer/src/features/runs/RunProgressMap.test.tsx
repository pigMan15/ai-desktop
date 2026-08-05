import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RunProjection } from "@workflow-platform/contracts";
import type { WorkflowDefinitionSummary } from "../../app/runtimeClient";
import { RunProgressMap } from "./RunProgressMap";

const { fitViewMock } = vi.hoisted(() => ({ fitViewMock: vi.fn() }));

vi.mock("@xyflow/react", async () => {
  const React = await import("react");

  return {
    ReactFlow: ({ children, elementsSelectable, fitViewOptions, nodeTypes, nodes, onInit, panOnDrag }: { children: React.ReactNode; elementsSelectable?: boolean; fitViewOptions?: { minZoom?: number }; nodeTypes: Record<string, React.ComponentType<{ data: unknown }>>; nodes: Array<{ id: string; type?: string; data: unknown }>; onInit?: (instance: { fitView: typeof fitViewMock }) => void; panOnDrag?: boolean }) => {
      React.useEffect(() => {
        onInit?.({ fitView: fitViewMock });
      }, [onInit]);

      return (
        <div
          data-testid="react-flow"
          data-elements-selectable={String(elementsSelectable)}
          data-fit-view-min-zoom={String(fitViewOptions?.minZoom)}
          data-pan-on-drag={String(panOnDrag)}
        >
          {nodes.map((node) => {
            const NodeComponent = nodeTypes[node.type ?? ""];
            return <NodeComponent key={node.id} data={node.data} />;
          })}
          {children}
        </div>
      );
    },
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fitViewMock.mockClear();
});

function workflow(): WorkflowDefinitionSummary {
  return {
    id: "release-workflow",
    name: "Release workflow",
    version: "1",
    sourceAdapter: "harness",
    nodes: [
      {
        id: "implement",
        name: "Implement change",
        kind: "agent",
        description: "Write the requested change.",
        artifacts: {
          outputs: [
            { id: "release-notes", name: "release-notes.md", type: "document", required: true, path: "release-notes.md" },
          ],
        },
      },
      {
        id: "verify",
        name: "Verify release",
        kind: "task",
        description: "Run the release checks.",
      },
      {
        id: "publish",
        name: "Publish release",
        kind: "approval",
        description: "Approve the release.",
      },
    ],
    edges: [
      { id: "implement-verify", from: "implement", to: "verify" },
      { id: "verify-publish", from: "verify", to: "publish" },
    ],
    roles: [],
    gates: [{ id: "quality-gate", name: "Quality gate" }],
    policies: {},
    metadata: {},
  };
}

function projection(overrides: Partial<RunProjection> = {}): RunProjection {
  return {
    runId: "run-1",
    status: "IN_PROGRESS",
    currentNodeIds: ["implement"],
    nodeStates: { implement: "RUNNING", verify: "READY", publish: "PENDING" },
    allowedActions: [],
    blockingReasons: [{ code: "WAITING_FOR_REVIEW", message: "Waiting for reviewer", nodeId: "implement" }],
    revision: "1",
    updatedAt: "2026-08-04T00:00:00Z",
    ...overrides,
  };
}

function workflowWithNodeRequirements(): WorkflowDefinitionSummary {
  const definition = workflow();
  const nodes = definition.nodes.map((node) => node.id === "implement" ? {
    ...node,
    requires: [
      { type: "artifact", artifactType: "source-bundle", required: true },
      { type: "approval", approvalRole: "maintainer", required: true },
    ],
    gates: ["quality-gate"],
  } : node);

  return { ...definition, nodes: nodes as WorkflowDefinitionSummary["nodes"] };
}

describe("RunProgressMap", () => {
  it("highlights the current node", () => {
    render(
      <RunProgressMap
        workflow={workflow()}
        projection={projection()}
        selectedNodeId="implement"
        onSelectNode={vi.fn()}
      />,
    );

    const node = screen.getByRole("button", { name: /Implement change.*In progress/i });
    expect(node).toHaveAttribute("data-status", "current");
    expect(node).toHaveAttribute("aria-current", "step");
    expect(node).toHaveAttribute("aria-pressed", "true");
  });

  it("shows successor information in the node tooltip on hover", async () => {
    render(
      <RunProgressMap
        workflow={workflow()}
        projection={projection()}
        selectedNodeId="implement"
        onSelectNode={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Verify release/i }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Successors");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Publish release");
  });

  it("shows the node kind in the tooltip", async () => {
    render(
      <RunProgressMap
        workflow={workflow()}
        projection={projection()}
        selectedNodeId="implement"
        onSelectNode={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Implement change/i }));

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Kind: agent");
  });

  it("shows required artifacts, node requirements, and named gates", async () => {
    render(
      <RunProgressMap
        workflow={workflowWithNodeRequirements()}
        projection={projection()}
        selectedNodeId="implement"
        onSelectNode={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Implement change/i }));

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("release-notes.md");
    expect(tooltip).toHaveTextContent("artifact: source-bundle");
    expect(tooltip).toHaveTextContent("approval: maintainer");
    expect(tooltip).toHaveTextContent("Quality gate");
  });

  it("shows a blocker only on the node it belongs to", async () => {
    render(
      <RunProgressMap
        workflow={workflow()}
        projection={projection({
          blockingReasons: [{ code: "VERIFY_BLOCKED", message: "Verification is blocked", nodeId: "verify" }],
        })}
        selectedNodeId="implement"
        onSelectNode={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: /Implement change/i }));
    expect(await screen.findByRole("tooltip")).not.toHaveTextContent("Verification is blocked");

    fireEvent.mouseLeave(screen.getByRole("button", { name: /Implement change/i }));
    fireEvent.mouseEnter(screen.getByRole("button", { name: /Verify release/i }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Blocker: Verification is blocked");
  });

  it("selects a node for read-only detail", () => {
    const onSelectNode = vi.fn();
    render(
      <RunProgressMap
        workflow={workflow()}
        projection={projection()}
        selectedNodeId="implement"
        onSelectNode={onSelectNode}
      />,
    );

    expect(screen.getByTestId("react-flow")).toHaveAttribute("data-elements-selectable", "false");
    fireEvent.click(screen.getByRole("button", { name: /Publish release/i }));

    expect(onSelectNode).toHaveBeenCalledWith("publish");
  });

  it("allows panning and fits larger workflows at a reduced zoom", () => {
    render(
      <RunProgressMap
        workflow={workflow()}
        projection={projection()}
        selectedNodeId="implement"
        onSelectNode={vi.fn()}
      />,
    );

    expect(screen.getByTestId("react-flow")).toHaveAttribute("data-pan-on-drag", "true");
    expect(Number(screen.getByTestId("react-flow").getAttribute("data-fit-view-min-zoom"))).toBeLessThanOrEqual(0.25);
  });

  it("refits the graph when its container size changes and disconnects on unmount", () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    let frameCallback: FrameRequestCallback | undefined;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    fitViewMock.mockClear();

    const { unmount } = render(
      <RunProgressMap
        workflow={workflow()}
        projection={projection()}
        selectedNodeId="implement"
        onSelectNode={vi.fn()}
      />,
    );

    const entry = (width: number) => ({ contentRect: { width, height: 360 } }) as ResizeObserverEntry;
    act(() => resizeCallback?.([entry(800)], {} as ResizeObserver));
    expect(fitViewMock).not.toHaveBeenCalled();

    act(() => resizeCallback?.([entry(360)], {} as ResizeObserver));
    expect(fitViewMock).not.toHaveBeenCalled();
    act(() => frameCallback?.(performance.now()));
    expect(fitViewMock).toHaveBeenCalledTimes(1);
    expect(fitViewMock).toHaveBeenCalledWith({ padding: 0.2, minZoom: 0.2, maxZoom: 1 });

    unmount();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
