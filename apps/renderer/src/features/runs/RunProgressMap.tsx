import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

import type { RunProjection } from "@workflow-platform/contracts";

import type { WorkflowDefinitionSummary } from "../../app/runtimeClient";
import { buildRunProgressGraph, type RunProgressEdge, type RunProgressNode } from "./runWorkbenchModel";
import { autoLayoutPositions } from "../workflow/workflowCanvasModel";

import "@xyflow/react/dist/style.css";

type RunProgressMapProps = {
  workflow: WorkflowDefinitionSummary;
  projection: RunProjection;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
};

type RunProgressMapNodeData = {
  node: RunProgressNode;
  selected: boolean;
  blocker?: string;
  successors: string[];
  requirements: string[];
  onSelect: (nodeId: string) => void;
};

type WorkflowNodeRequirement = {
  type?: string;
  artifactType?: string;
  approvalRole?: string;
  evidenceType?: string;
  gateId?: string;
};

type WorkflowNodeWithRequirements = WorkflowDefinitionSummary["nodes"][number] & {
  requires?: WorkflowNodeRequirement[];
  gates?: string[];
};

type RunProgressMapNode = Node<RunProgressMapNodeData, "run-progress">;
type RunProgressMapEdge = Edge<{ status: RunProgressEdge["status"] }>;

const NODE_TYPES = { "run-progress": RunProgressMapNodeButton };

export function RunProgressMap({ workflow, projection, selectedNodeId, onSelectNode }: RunProgressMapProps) {
  const graph = useMemo(() => buildRunProgressGraph(workflow, projection), [projection, workflow]);
  const { nodes, edges } = useMemo(() => toFlowGraph(graph.nodes, graph.edges, workflow, projection, selectedNodeId, onSelectNode), [
    graph.edges,
    graph.nodes,
    onSelectNode,
    projection,
    selectedNodeId,
    workflow,
  ]);

  return (
    <section className="run-progress-map" aria-label="运行进度图">
      <ReactFlow<RunProgressMapNode, RunProgressMapEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.2, maxZoom: 1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        edgesReconnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        selectionOnDrag={false}
        panOnDrag
        zoomOnDoubleClick={false}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}

function toFlowGraph(
  graphNodes: RunProgressNode[],
  graphEdges: RunProgressEdge[],
  workflow: WorkflowDefinitionSummary,
  projection: RunProjection,
  selectedNodeId: string | null,
  onSelectNode: (nodeId: string) => void,
): { nodes: RunProgressMapNode[]; edges: RunProgressMapEdge[] } {
  const automaticPositions = autoLayoutPositions(workflow.nodes, workflow.edges);
  const storedPositions = workflow.metadata.canvas?.nodes ?? {};
  const namesById = new Map(graphNodes.map((node) => [node.id, node.name]));

  return {
    nodes: graphNodes.map((node) => ({
      id: node.id,
      type: "run-progress",
      position: storedPositions[node.id] ?? automaticPositions[node.id] ?? { x: 0, y: 0 },
      data: {
        node,
        selected: node.id === selectedNodeId,
        blocker: blockerForNode(node, projection),
        successors: node.successors.map((id) => namesById.get(id) ?? id),
        requirements: requirementsForNode(node, workflow),
        onSelect: onSelectNode,
      },
    })),
    edges: graphEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      className: `run-progress-edge run-progress-edge--${edge.status}`,
      data: { status: edge.status },
      animated: edge.active,
    })),
  };
}

function RunProgressMapNodeButton({ data }: NodeProps<RunProgressMapNode>) {
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const { node, selected, blocker, successors, requirements, onSelect } = data;
  const statusLabel = statusText(node.status);
  const tooltipId = `run-progress-tooltip-${node.id}`;

  return (
    <article
      className="run-progress-node"
      data-status={node.status}
      data-current={node.current || undefined}
      data-selected={selected || undefined}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        className="run-progress-node-button"
        data-status={node.status}
        aria-current={node.current ? "step" : undefined}
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        aria-label={`${node.name}. ${statusLabel}${node.current ? ". Current step." : ""}`}
        aria-pressed={selected}
        onClick={() => onSelect(node.id)}
        onMouseEnter={() => setTooltipVisible(true)}
        onMouseLeave={() => setTooltipVisible(false)}
        onFocus={() => setTooltipVisible(true)}
        onBlur={() => setTooltipVisible(false)}
      >
        <span className="run-progress-node-heading">
          <strong>{node.name}</strong>
          {node.current ? <span className="run-progress-current-marker">Current</span> : null}
        </span>
        <span className="run-progress-node-status">{statusLabel}</span>
      </button>
      {tooltipVisible ? (
        <div className="run-progress-tooltip" id={tooltipId} role="tooltip">
          <strong>{node.name}</strong>
          <span>State: {statusLabel} ({node.state})</span>
          <span>Kind: {node.kind}</span>
          {node.description ? <span>Description: {node.description}</span> : null}
          {requirements.length > 0 ? <span>Requirements: {requirements.join(", ")}</span> : null}
          {blocker ? <span>Blocker: {blocker}</span> : null}
          <span>Successors: {successors.length > 0 ? successors.join(", ") : "None"}</span>
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </article>
  );
}

function blockerForNode(node: RunProgressNode, projection: RunProjection): string | undefined {
  return projection.blockingReasons
    .find((blocker) => blocker.nodeId === undefined || blocker.nodeId === node.id)
    ?.message;
}

function requirementsForNode(node: RunProgressNode, workflow: WorkflowDefinitionSummary): string[] {
  const workflowNode = node.workflowNode as WorkflowNodeWithRequirements;
  const gateNames = new Map(workflow.gates.map((gate) => [gate.id, gate.name]));
  const requiredArtifacts = (workflowNode.artifacts?.outputs ?? [])
    .filter((output) => output.required)
    .map((output) => output.name);
  const requirements = (workflowNode.requires ?? []).map((requirement) => formatRequirement(requirement, gateNames));
  const gates = (workflowNode.gates ?? []).map((gateId) => gateNames.get(gateId) ?? gateId);

  return [...requiredArtifacts, ...requirements, ...gates];
}

function formatRequirement(requirement: WorkflowNodeRequirement, gateNames: Map<string, string>): string {
  if (requirement.type === "artifact") return `artifact: ${requirement.artifactType ?? "required"}`;
  if (requirement.type === "approval") return `approval: ${requirement.approvalRole ?? "required"}`;
  if (requirement.type === "evidence") return `evidence: ${requirement.evidenceType ?? "required"}`;
  if (requirement.type === "gate") {
    const gateId = requirement.gateId ?? "required";
    return `gate: ${gateNames.get(gateId) ?? gateId}`;
  }

  return requirement.type ?? "required";
}

function statusText(status: RunProgressNode["status"]): string {
  return {
    current: "In progress",
    completed: "Completed",
    blocked: "Blocked",
    failed: "Failed",
    pending: "Pending",
    skipped: "Skipped",
  }[status];
}
