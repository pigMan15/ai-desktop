import type { RunEvent, RunProjection } from "./events.js";
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
