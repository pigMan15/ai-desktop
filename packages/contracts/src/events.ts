export const RUN_EVENT_TYPES = [
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
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];
export const NODE_STATES = [
  "PENDING",
  "READY",
  "RUNNING",
  "AWAITING_ARTIFACT",
  "AWAITING_APPROVAL",
  "AWAITING_GATE",
  "PASSED",
  "FAILED",
  "BLOCKED",
  "SKIPPED",
] as const;

export type NodeState = (typeof NODE_STATES)[number];

export type RunStatus = "CREATED" | "IN_PROGRESS" | "REVIEWING" | "BLOCKED" | "PAUSED" | "DONE" | "ARCHIVED";

export type ActorType = "human" | "agent" | "system" | "verifier" | "executor" | "adapter";
export type ActorSource = "renderer" | "runtime" | "terminal" | "agent" | "adapter";

export type Actor = {
  id: string;
  type: ActorType;
  source: ActorSource;
  trusted: boolean;
};

export type RunEvent = {
  id: string;
  runId: string;
  type: RunEventType;
  nodeId?: string;
  actor: Actor;
  payload: Record<string, unknown>;
  createdAt: string;
  revision: string;
};

export type AllowedAction = {
  id: string;
  label: string;
  eventType: RunEventType;
  nodeId?: string;
  risk: "low" | "medium" | "high";
};

export type RunProjection = {
  runId: string;
  status: RunStatus;
  currentNodeIds: string[];
  nodeStates: Record<string, NodeState>;
  allowedActions: AllowedAction[];
  blockingReasons: Array<{ code: string; message: string; nodeId?: string }>;
  revision: string;
  updatedAt: string;
};
