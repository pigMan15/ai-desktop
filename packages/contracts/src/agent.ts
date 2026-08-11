// Agent runtime ACP adapter and chat contracts (design doc 2026-08-10 v2, section 4)
import type { Actor } from "./events.js";

export const AGENT_TRANSPORTS = ["auto", "cli", "acp", "direct"] as const;
export type AgentTransport = (typeof AGENT_TRANSPORTS)[number];

export const AGENT_PERMISSION_STATUSES = ["PENDING", "ALLOWED", "DENIED", "EXPIRED"] as const;
export type AgentPermissionStatus = (typeof AGENT_PERMISSION_STATUSES)[number];

export const AGENT_PERMISSION_TYPES = [
  "write_file",
  "run_command",
  "network",
  "read_file",
  "env",
  "other",
] as const;
export type AgentPermissionType = (typeof AGENT_PERMISSION_TYPES)[number];

// 限额常量（design doc section 12）
export const AGENT_PERMISSION_PENDING_LIMIT = 50;
export const AGENT_AWAITING_INPUT_MAX_HOURS = 24;

export type AgentPermissionRequest = {
  id: string;
  jobId: string;
  runId: string;
  permissionType: AgentPermissionType;
  target: string;
  details: Record<string, unknown>;
  status: AgentPermissionStatus;
  decidedBy: Actor | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
  updatedAt: string;
};

// 启动 Agent 请求体扩展（向后兼容，字段可选；与现有 StartAgentJobRequest 对齐）
export type StartAgentRequest = {
  nodeId: string;
  provider: "codex" | "claude" | "opencode" | "fake" | "direct";
  mode: "automatic" | "interactive";
  transport?: AgentTransport;
  prompt?: string;
  cwd?: string;
  allowedTools?: string[];
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  actor: Actor;
  now: string;
};

export type ContinueConversationRequest = {
  message: string;
  actor: Actor;
  now: string;
};

export type ContinueConversationQueued = {
  turnId: string;
  status: "RUNNING";
};

export type DecidePermissionRequest = {
  decision: "allow" | "deny";
  reason?: string;
  actor: Actor;
  now: string;
};
