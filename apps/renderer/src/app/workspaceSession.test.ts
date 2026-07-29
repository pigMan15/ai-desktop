import { afterEach, describe, expect, it, vi } from "vitest";

import { loadWorkspaceSession, saveWorkspaceSession } from "./workspaceSession";

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("workspaceSession", () => {
  it("persists only the workspace context needed to restore a Run", () => {
    saveWorkspaceSession({
      apiBaseUrl: "http://127.0.0.1:9900",
      projectPath: "G:\\Project\\demo",
      projectId: "project-demo",
      workflowVersionId: "workflow-version-1",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-1",
    });

    expect(loadWorkspaceSession()).toEqual({
      apiBaseUrl: "http://127.0.0.1:9900",
      projectPath: "G:\\Project\\demo",
      projectId: "project-demo",
      workflowVersionId: "workflow-version-1",
      projectName: "demo",
      workflowName: "Demo Workflow",
      runId: "run-1",
    });
  });

  it("uses the Vite runtime API URL when no saved workspace exists", async () => {
    vi.stubEnv("VITE_RUNTIME_API_BASE_URL", "http://127.0.0.1:8866");
    vi.resetModules();

    const { emptyWorkspaceSession } = await import("./workspaceSession");

    expect(emptyWorkspaceSession().apiBaseUrl).toBe("http://127.0.0.1:8866");
  });
});
