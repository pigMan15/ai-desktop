import type { RuntimeHealth, RuntimeLogEntry, RuntimeStatus } from "../main/runtime.js";

declare global {
  interface Window {
    workflowRuntime: {
      health(): Promise<RuntimeHealth>;
      status(): Promise<RuntimeStatus>;
      restart(): Promise<RuntimeStatus>;
      logs(): Promise<RuntimeLogEntry[]>;
    };
  }
}

export {};
