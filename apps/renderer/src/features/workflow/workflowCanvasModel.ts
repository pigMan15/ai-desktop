import type { Edge, Node } from "@xyflow/react";

import type { WorkflowDefinitionSummary } from "../../app/runtimeClient";

export type FlowPosition = { x: number; y: number };

type WorkflowNode = WorkflowDefinitionSummary["nodes"][number];
type WorkflowEdge = WorkflowDefinitionSummary["edges"][number];

export function toFlowGraph(definition: WorkflowDefinitionSummary): { nodes: Node[]; edges: Edge[] } {
  const automaticPositions = autoLayoutPositions(definition.nodes, definition.edges);
  const storedPositions = definition.metadata.canvas?.nodes ?? {};

  return {
    nodes: definition.nodes.map((node) => {
      const position = storedPositions[node.id] ?? automaticPositions[node.id] ?? { x: 0, y: 0 };
      return {
        id: node.id,
        position: { x: position.x, y: position.y },
        data: { label: node.name, node },
      };
    }),
    edges: definition.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
    })),
  };
}

export function applyNodePositions(
  definition: WorkflowDefinitionSummary,
  positions: Record<string, FlowPosition>,
): WorkflowDefinitionSummary {
  const canvas = definition.metadata.canvas;

  return {
    ...definition,
    metadata: {
      ...definition.metadata,
      canvas: {
        ...canvas,
        nodes: copyPositions({ ...canvas?.nodes, ...positions }),
      },
    },
  };
}

export function addFlowEdge(
  definition: WorkflowDefinitionSummary,
  source: string,
  target: string,
): WorkflowDefinitionSummary {
  if (source === target || definition.edges.some((edge) => edge.from === source && edge.to === target)) {
    return definition;
  }

  const id = uniqueEdgeId(`edge-${source}-${target}`, definition.edges);
  return {
    ...definition,
    edges: [...definition.edges, { id, from: source, to: target }],
  };
}

export function removeFlowEdges(
  definition: WorkflowDefinitionSummary,
  edgeIds: Iterable<string>,
): WorkflowDefinitionSummary {
  const removedIds = new Set(edgeIds);
  return {
    ...definition,
    edges: definition.edges.filter((edge) => !removedIds.has(edge.id)),
  };
}

export function autoLayoutPositions(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Record<string, FlowPosition> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const connectedIds = new Set<string>();
  const outgoing = new Map<string, string[]>();
  const incomingCounts = new Map<string, number>();
  const layers = new Map<string, number>();

  for (const node of nodes) {
    outgoing.set(node.id, []);
    incomingCounts.set(node.id, 0);
    layers.set(node.id, 0);
  }

  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    connectedIds.add(edge.from);
    connectedIds.add(edge.to);
    outgoing.get(edge.from)?.push(edge.to);
    incomingCounts.set(edge.to, (incomingCounts.get(edge.to) ?? 0) + 1);
  }

  const queue = [...connectedIds].filter((id) => incomingCounts.get(id) === 0).sort();
  const orderedConnectedIds: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    orderedConnectedIds.push(id);
    for (const target of (outgoing.get(id) ?? []).sort()) {
      layers.set(target, Math.max(layers.get(target) ?? 0, (layers.get(id) ?? 0) + 1));
      const remaining = (incomingCounts.get(target) ?? 0) - 1;
      incomingCounts.set(target, remaining);
      if (remaining === 0) {
        queue.push(target);
        queue.sort();
      }
    }
  }

  const unresolvedIds = [...connectedIds].filter((id) => !orderedConnectedIds.includes(id)).sort();
  const maxLayer = Math.max(0, ...[...layers.values()]);
  for (const id of unresolvedIds) {
    layers.set(id, maxLayer + 1);
  }

  const orderedIds = [
    ...orderedConnectedIds,
    ...unresolvedIds,
    ...nodes.map((node) => node.id).filter((id) => !connectedIds.has(id)).sort(),
  ];
  const rowsByLayer = new Map<number, number>();

  return Object.fromEntries(orderedIds.map((id) => {
    const layer = layers.get(id) ?? 0;
    const row = rowsByLayer.get(layer) ?? 0;
    rowsByLayer.set(layer, row + 1);
    return [id, { x: layer * 260, y: row * 150 }];
  }));
}

function copyPositions(positions: Record<string, FlowPosition>): Record<string, FlowPosition> {
  return Object.fromEntries(Object.entries(positions).map(([id, position]) => [
    id,
    { x: position.x, y: position.y },
  ]));
}

function uniqueEdgeId(baseId: string, edges: WorkflowEdge[]): string {
  const ids = new Set(edges.map((edge) => edge.id));
  if (!ids.has(baseId)) return baseId;

  let suffix = 2;
  while (ids.has(`${baseId}-${suffix}`)) suffix += 1;
  return `${baseId}-${suffix}`;
}
