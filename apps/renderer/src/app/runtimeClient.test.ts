import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRuntimeState } from "./runtimeClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runtimeClient", () => {
  it("loads the P1 product loop from Runtime API responses", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path: url.pathname, body });

      const payloadByPath: Record<string, unknown> = {
        "/health": { status: "ok", service: "workflow-runtime" },
        "/projects/import": {
          projectId: "project-demo",
          workflowVersionId: "workflow-version-demo",
          workflowId: "demo-workflow",
          workflowName: "Demo Workflow",
        },
        "/runs": projection("run-demo", "1", "CREATED"),
        "/runs/run-demo/transition": projection("run-demo", "2", "IN_PROGRESS"),
        "/runs/run-demo/artifacts": [
          {
            id: "artifact-1",
            type: "plan",
            uri: "file:///project/plan.md",
            contentHash: "sha256:test",
          },
        ],
        "/runs/run-demo/approvals": [
          { id: "approval-1", status: "approved", comment: "Renderer P1 人工审批通过" },
        ],
        "/runs/run-demo/gates": [
          { id: "gate-1", status: "passed", evidence: ["file:///project/plan.md#p1-e2e"] },
        ],
        "/runs/run-demo/timeline": [
          { id: "event-1", type: "RUN_CREATED", createdAt: "2026-07-28T00:00:00Z" },
          {
            id: "event-5",
            type: "GATE_PASSED",
            nodeId: "plan",
            createdAt: "2026-07-28T00:00:00Z",
          },
        ],
      };

      if (url.pathname === "/runs/run-demo/approvals/plan/decide") {
        return jsonResponse(projection("run-demo", "4", "REVIEWING"));
      }
      if (url.pathname === "/runs/run-demo/artifacts" && init?.method === "POST") {
        return jsonResponse(projection("run-demo", "3", "REVIEWING"));
      }
      if (url.pathname === "/runs/run-demo/gates" && init?.method === "POST") {
        return jsonResponse(projection("run-demo", "5", "IN_PROGRESS"));
      }

      return jsonResponse(payloadByPath[url.pathname]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await loadRuntimeState({
      apiBaseUrl: "http://127.0.0.1:8765",
      projectPath: "G:\\Project\\demo",
      artifactPath: "G:\\Project\\demo\\plan.md",
      now: "2026-07-28T00:00:00Z",
    });

    expect(state.connection).toBe("connected");
    expect(state.projectName).toBe("demo");
    expect(state.workflowName).toBe("Demo Workflow");
    expect(state.projection.revision).toBe("5");
    expect(state.timeline.map((event) => event.type)).toEqual(["RUN_CREATED", "GATE_PASSED"]);
    expect(state.artifacts[0].contentHash).toBe("sha256:test");
    expect(calls.map((call) => call.path)).toEqual([
      "/health",
      "/projects/import",
      "/runs",
      "/runs/run-demo/transition",
      "/runs/run-demo/artifacts",
      "/runs/run-demo/approvals/plan/decide",
      "/runs/run-demo/gates",
      "/runs/run-demo/timeline",
      "/runs/run-demo/artifacts",
      "/runs/run-demo/approvals",
      "/runs/run-demo/gates",
    ]);
  });
});

function projection(runId: string, revision: string, status: "CREATED" | "IN_PROGRESS" | "REVIEWING") {
  return {
    runId,
    status,
    currentNodeIds: ["plan"],
    nodeStates: { plan: "AWAITING_APPROVAL" },
    allowedActions: [],
    blockingReasons: [{ code: "WAITING_FOR_HUMAN", message: "等待人工审批", nodeId: "plan" }],
    revision,
    updatedAt: "2026-07-28T00:00:00Z",
  };
}

function jsonResponse(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
}
