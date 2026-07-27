export const NODE_KINDS = ["input", "agent", "tool", "human", "output"] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export type RequirementSpec = {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
};

export type WorkflowNode = {
  id: string;
  kind: NodeKind;
  name: string;
  description?: string;
  requirementIds?: string[];
  config?: Record<string, unknown>;
};

export type WorkflowEdge = {
  id: string;
  from: string;
  to: string;
  condition?: string;
};

export type WorkflowDefinition = {
  id: string;
  version: string;
  name: string;
  description?: string;
  requirements: RequirementSpec[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};
