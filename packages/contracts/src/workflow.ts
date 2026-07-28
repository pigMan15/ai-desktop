export const NODE_KINDS = [
  "task",
  "agent",
  "approval",
  "gate",
  "evidence",
  "deploy",
  "report",
  "composite",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export type RequirementSpec =
  | { type: "artifact"; artifactType: string; required: boolean }
  | { type: "approval"; approvalRole?: string; required: boolean }
  | { type: "gate"; gateId: string; required: boolean }
  | { type: "evidence"; evidenceType: string; required: boolean };

export type WorkflowNode = {
  id: string;
  name: string;
  kind: NodeKind;
  role?: string;
  description?: string;
  requires?: RequirementSpec[];
  gates?: string[];
  metadata?: Record<string, unknown>;
};

export type WorkflowEdge = {
  id: string;
  from: string;
  to: string;
  condition?: string;
  trigger?: string;
  metadata?: Record<string, unknown>;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  version: string;
  sourceAdapter: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  roles: Array<{ id: string; name: string }>;
  gates: Array<{ id: string; name: string; description?: string }>;
  policies: Record<string, unknown>;
  metadata: Record<string, unknown>;
};
