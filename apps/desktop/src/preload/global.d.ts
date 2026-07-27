import type { RuntimeHealth } from "../main/runtime.js";

declare global {
  interface Window {
    workflowRuntime: {
      health(): Promise<RuntimeHealth>;
    };
  }
}

export {};
