export const RUN_EVENT_TYPES = [
  "RUN_STARTED",
  "NODE_STARTED",
  "NODE_COMPLETED",
  "NODE_FAILED",
  "HUMAN_REVIEW_REQUESTED",
  "HUMAN_APPROVED",
  "HUMAN_REJECTED",
  "RUN_COMPLETED",
  "RUN_FAILED",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type ActorType = "system" | "user" | "agent" | "tool";

export type ActorSource = {
  id: string;
  label?: string;
};

export type Actor = {
  type: ActorType;
  source?: ActorSource;
};

export type RunEvent = {
  id: string;
  runId: string;
  type: RunEventType;
  timestamp: string;
  actor: Actor;
  nodeId?: string;
  payload?: Record<string, unknown>;
};

export type AllowedAction = {
  id: string;
  label: string;
  eventType: RunEventType;
  nodeId?: string;
  payloadSchema?: Record<string, unknown>;
};

export type RunProjection = {
  runId: string;
  workflowId: string;
  status: "pending" | "running" | "waiting_for_human" | "completed" | "failed";
  currentNodeIds: string[];
  events: RunEvent[];
  allowedActions: AllowedAction[];
};
