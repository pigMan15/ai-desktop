import type { Actor, NodeState, RunEvent, RunProjection, RunStatus } from "./events.js";
import type { WorkflowDefinition } from "./workflow.js";

export type DetectionResult = {
  adapterId: string;
  name: string;
  score: number;
  diagnostics: string[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  rootPath: string;
  activeProtocol?: string;
};

export type WorkflowVersion = {
  id: string;
  projectId: string;
  adapterId: string;
  name: string;
  version: string;
  definition: WorkflowDefinition;
  contentHash: string;
  createdAt: string;
};

export type TransitionResult = {
  run: RunProjection;
  accepted: boolean;
  revision: string;
  allowedActions: RunProjection["allowedActions"];
  blockingReasons: RunProjection["blockingReasons"];
  emittedEvents: RunEvent[];
};

export type WorkspaceMode = "write" | "read";
export type WorkspaceLeaseStatus = "active" | "released" | "expired";

export type WorkspaceLease = {
  id: string;
  projectId: string;
  runId: string;
  workspacePath: string;
  mode: WorkspaceMode;
  status: WorkspaceLeaseStatus;
  acquiredAt: string;
  lastVerifiedAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
};

export type RunRecord = {
  id: string;
  projectId: string;
  workflowVersionId: string;
  workflowSnapshot: WorkflowDefinition;
  title: string;
  context: { taskGoal?: string; parameters?: Record<string, unknown> };
  executionWorkspace: string;
  workspaceMode: WorkspaceMode;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
};

export type RunActivitySummary = {
  activeAgentCount: number;
  activeDeploymentCount: number;
  lastEventAt: string | null;
};

export type RunOverview = {
  run: RunRecord;
  projection: RunProjection;
  workflow: WorkflowDefinition;
  workspace: WorkspaceLease | null;
  activity: RunActivitySummary;
};

export type RunSummaryProjection = {
  id: string;
  projectId: string;
  workflowVersionId: string;
  workflowName: string;
  workflowVersion: string;
  title: string;
  status: RunStatus;
  taskGoal: string | null;
  currentNodes: Array<{ id: string; name: string; kind: string; state: NodeState }>;
  nextNodes: Array<{ id: string; name: string; kind: string; condition?: string }>;
  progress: { total: number; passed: number; running: number; blocked: number; pending: number };
  blocker: { code: string; message: string; nodeId?: string } | null;
  workspace: { path: string; label: string; leaseMode: WorkspaceMode; leaseStatus: WorkspaceLeaseStatus } | null;
  activeAgentCount: number;
  activeDeploymentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type RunListQuery = {
  status?: RunStatus[];
  workflowVersionId?: string;
  workspacePath?: string;
  q?: string;
  cursor?: string;
  limit?: number;
};

export type RunListResponse = { items: RunSummaryProjection[]; nextCursor: string | null };

export type CreateRunRequest = {
  workflowVersionId: string;
  title: string;
  taskGoal?: string;
  parameters?: Record<string, unknown>;
  executionWorkspace: { path: string; mode: WorkspaceMode };
  actor: Actor;
};

export type ExecuteRunActionRequest = {
  actionId: string;
  expectedRevision: string;
  actor: Actor;
  payload?: Record<string, unknown>;
};

export type ExecuteRunActionResponse = { projection: RunProjection; emittedEvents: RunEvent[] };

export type RuntimeError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  correlationId: string;
};
