import type { ErrorCode } from "./errors.js";
import type { WorkflowDefinition } from "./workflow.js";

export type DetectionResult = {
  projectRoot: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  languages: string[];
  frameworks: string[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  rootPath: string;
  detected: DetectionResult;
};

export type WorkflowVersion = {
  id: string;
  workflowId: string;
  version: string;
  definition: WorkflowDefinition;
  createdAt: string;
};

export type TransitionResult = {
  ok: boolean;
  runId: string;
  nextNodeIds: string[];
  errorCode?: ErrorCode;
  message?: string;
};
