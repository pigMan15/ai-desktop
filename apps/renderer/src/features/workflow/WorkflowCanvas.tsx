import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type OnConnect,
  type OnEdgesDelete,
  type OnNodeDrag,
  type OnNodesDelete,
  useNodesInitialized,
} from "@xyflow/react";

import type {
  CompiledWorkflowSummary,
  RuntimeWorkbenchState,
  WorkflowDefinitionSummary,
} from "../../app/runtimeClient";
import { addFlowEdge, applyNodePositions, removeFlowEdges, toFlowGraph } from "./workflowCanvasModel";

import "@xyflow/react/dist/style.css";

type WorkflowNode = WorkflowDefinitionSummary["nodes"][number];

type WorkflowCanvasProps = {
  definition: WorkflowDefinitionSummary;
  compiled?: CompiledWorkflowSummary | null;
  state?: RuntimeWorkbenchState | null;
  onDefinitionChange: (definition: WorkflowDefinitionSummary) => void;
  onRemoveNodes: (nodeIds: string[]) => void;
  onSelectNode: (nodeId: string) => void;
  viewResetKey?: number;
};

type WorkflowCanvasNodeData = {
  node: WorkflowNode;
  roleName?: string;
  runState?: string;
  diagnostics: string[];
  onSelect: (nodeId: string) => void;
};

type WorkflowCanvasNode = Node<WorkflowCanvasNodeData>;

export function WorkflowCanvas({
  definition,
  compiled = null,
  state = null,
  onDefinitionChange,
  onRemoveNodes,
  onSelectNode,
  viewResetKey = 0,
}: WorkflowCanvasProps) {
  const { nodes: graphNodes, edges } = useMemo(() => toFlowGraph(definition), [definition]);
  const roleNames = useMemo(
    () => new Map(definition.roles.map((role) => [role.id, role.name])),
    [definition.roles],
  );
  const nodes = useMemo<WorkflowCanvasNode[]>(() => graphNodes.map((graphNode) => {
    const node = graphNode.data.node as WorkflowNode;
    const roleId = node.kind === "agent" ? node.agent?.roleId : undefined;
    return {
      ...graphNode,
      type: "workflow",
      data: {
        node,
        roleName: roleId ? roleNames.get(roleId) ?? roleId : undefined,
        runState: state?.projection?.nodeStates[node.id],
        diagnostics: (compiled?.diagnostics ?? [])
          .filter((diagnostic) => diagnostic.nodeId === node.id)
          .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
        onSelect: onSelectNode,
      },
    };
  }), [compiled?.diagnostics, graphNodes, onSelectNode, roleNames, state?.projection?.nodeStates]);
  const nodeSignature = graphNodes.map((node) => node.id).join("|");

  const connect: OnConnect = (connection: Connection) => {
    if (connection.source && connection.target) {
      onDefinitionChange(addFlowEdge(definition, connection.source, connection.target));
    }
  };

  const handleNodeDragStop: OnNodeDrag<WorkflowCanvasNode> = (_, node) => {
    onDefinitionChange(applyNodePositions(definition, {
      [node.id]: { x: node.position.x, y: node.position.y },
    }));
  };

  const handleEdgesDelete: OnEdgesDelete = (deletedEdges) => {
    onDefinitionChange(removeFlowEdges(definition, deletedEdges.map((edge) => edge.id)));
  };

  const handleNodesDelete: OnNodesDelete<WorkflowCanvasNode> = (deletedNodes) => {
    onRemoveNodes(deletedNodes.map((node) => node.id));
  };

  return (
    <div className="workflow-canvas" aria-label="Workflow canvas">
      <ReactFlow<WorkflowCanvasNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        onConnect={connect}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onNodeDragStop={handleNodeDragStop}
        onEdgesDelete={handleEdgesDelete}
        onNodesDelete={handleNodesDelete}
      >
        <WorkflowCanvasViewport nodeSignature={nodeSignature} viewResetKey={viewResetKey} />
        <Background gap={20} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
      <div className="workflow-canvas-accessible-controls" aria-label="Canvas connection controls">
        {definition.nodes.map((node) => (
          <button
            type="button"
            key={node.id}
            aria-label={`选择节点 ${node.id}`}
            onClick={() => onSelectNode(node.id)}
          >
            选择节点 {node.id}
          </button>
        ))}
        {definition.nodes.flatMap((source) => definition.nodes
          .filter((target) => target.id !== source.id)
          .map((target) => (
            <button
              type="button"
              key={`${source.id}-${target.id}`}
              aria-label={`连接 ${source.id} 到 ${target.id}`}
              onClick={() => connect({
                source: source.id,
                sourceHandle: null,
                target: target.id,
                targetHandle: null,
              })}
            >
              连接 {source.id} 到 {target.id}
            </button>
          )))}
      </div>
    </div>
  );
}

function WorkflowCanvasViewport({ nodeSignature, viewResetKey }: { nodeSignature: string; viewResetKey: number }) {
  const { fitView } = useReactFlow<WorkflowCanvasNode, Edge>();
  const nodesInitialized = useNodesInitialized({ includeHiddenNodes: true });

  useEffect(() => {
    if (!nodesInitialized || !nodeSignature) {
      return;
    }
    let frame: number | null = null;
    const fitCanvas = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        void fitView({ padding: 0.18, minZoom: 0.65, maxZoom: 1.1, duration: 0 });
      });
    };
    const canvas = document.querySelector(".workflow-canvas");
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fitCanvas);

    fitCanvas();
    if (observer && canvas) observer.observe(canvas);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [fitView, nodeSignature, nodesInitialized, viewResetKey]);

  return null;
}

function WorkflowCanvasNode({ data }: NodeProps<WorkflowCanvasNode>) {
  const { node, roleName, runState, diagnostics, onSelect } = data;

  return (
    <article className="workflow-flow-node" data-kind={node.kind}>
      <Handle type="target" position={Position.Left} aria-label={`Target ${node.id}`} />
      <button type="button" className="workflow-flow-node-select" aria-label={`选择节点 ${node.id}`} onClick={() => onSelect(node.id)}>
        <strong>{node.name}</strong>
        <span>{node.kind}</span>
        {roleName ? <span>Role: {roleName}</span> : null}
        {runState ? <span>Run: {runState}</span> : null}
        {diagnostics.map((diagnostic) => <span className="workflow-flow-node-error" key={diagnostic}>{diagnostic}</span>)}
      </button>
      <Handle type="source" position={Position.Right} aria-label={`Source ${node.id}`} />
    </article>
  );
}

const NODE_TYPES = { workflow: WorkflowCanvasNode };
