export const WORKFLOW_PLATFORM_VERSION = "0.1.0";

export type RuntimeHealth = {
  status: "ok";
  service: "workflow-runtime";
};

export * from "./workflow.js";
export * from "./events.js";
export * from "./rpc.js";
export * from "./errors.js";
export * from "./knowledge.js";
