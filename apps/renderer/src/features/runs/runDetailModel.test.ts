import { describe, expect, it } from "vitest";

import type {
  ExecuteRunActionResponse,
  RunOverview,
  WorkflowDefinition,
} from "@workflow-platform/contracts";
import { RuntimeClientError } from "../../app/runtimeClient";
import {
  createRunDetailState,
  detailPollInterval,
  runDetailReducer,
} from "./runDetailModel";

const NOW = "2026-08-06T10:00:00Z";

describe("runDetailReducer", () => {
  it("loads an initial overview", () => {
    const loading = runDetailReducer(createRunDetailState(), {
      type: "request-started",
      kind: "initial",
      generation: 1,
    });

    expect(loading).toMatchObject({ phase: "loading", generation: 1, error: null });

    const ready = runDetailReducer(loading, {
      type: "request-succeeded",
      kind: "initial",
      generation: 1,
      overview: overview(),
      refreshedAt: NOW,
    });

    expect(ready).toMatchObject({
      phase: "ready",
      overview: { run: { id: "run-1" } },
      lastRefreshedAt: NOW,
      error: null,
    });
  });

  it("retains the overview during refresh and after a refresh failure", () => {
    const current = readyState();
    const refreshing = runDetailReducer(current, {
      type: "request-started",
      kind: "refresh",
      generation: 2,
    });

    expect(refreshing.phase).toBe("refreshing");
    expect(refreshing.overview).toBe(current.overview);

    const error = runtimeError(503, "RUN_REARCHITECTURE_MAINTENANCE");
    const failed = runDetailReducer(refreshing, {
      type: "request-failed",
      generation: 2,
      error,
    });

    expect(failed.phase).toBe("ready");
    expect(failed.overview).toBe(current.overview);
    expect(failed.lastRefreshedAt).toBe(NOW);
    expect(failed.error).toBe(error);
  });

  it("enters acting and replaces only the projection after action success", () => {
    const current = readyState();
    const acting = runDetailReducer(current, { type: "action-started", generation: 3 });
    const response: ExecuteRunActionResponse = {
      projection: { ...current.overview!.projection, revision: "2", status: "IN_PROGRESS" },
      emittedEvents: [],
    };

    expect(acting.phase).toBe("acting");
    const succeeded = runDetailReducer(acting, {
      type: "action-succeeded",
      generation: 3,
      response,
    });

    expect(succeeded.phase).toBe("ready");
    expect(succeeded.overview?.projection).toBe(response.projection);
    expect(succeeded.overview?.run).toBe(current.overview?.run);
    expect(succeeded.lastRefreshedAt).toBe(NOW);
    expect(succeeded.error).toBeNull();
  });

  it("retains cached data and exposes a revision conflict", () => {
    const current = { ...readyState(), phase: "acting" as const, generation: 4 };
    const error = runtimeError(409, "REVISION_CONFLICT");

    const failed = runDetailReducer(current, {
      type: "action-failed",
      generation: 4,
      error,
    });

    expect(failed.phase).toBe("ready");
    expect(failed.overview).toBe(current.overview);
    expect(failed.error).toBe(error);
  });

  it.each([
    [404, "RUN_NOT_FOUND_IN_PROJECT", "not-found"],
    [503, "RUN_REARCHITECTURE_MAINTENANCE", "maintenance"],
    [500, "RUNTIME_ERROR", "error"],
  ] as const)("maps an uncached %s %s failure to %s", (status, code, phase) => {
    const state = { ...createRunDetailState(), generation: 5 };
    const error = runtimeError(status, code);

    expect(runDetailReducer(state, {
      type: "request-failed",
      generation: 5,
      error,
    })).toMatchObject({ phase, overview: null, error });
  });

  it("changes selection and resets it when a replacement workflow omits the node", () => {
    const selected = runDetailReducer(readyState(), {
      type: "node-selected",
      nodeId: "review",
    });

    expect(selected.selectedNodeId).toBe("review");
    const replacement = overview({
      workflow: { ...workflow(), nodes: workflow().nodes.filter((node) => node.id !== "review") },
    });
    const refreshed = runDetailReducer(
      { ...selected, phase: "refreshing", generation: 6 },
      {
        type: "request-succeeded",
        kind: "refresh",
        generation: 6,
        overview: replacement,
        refreshedAt: "2026-08-06T10:01:00Z",
      },
    );

    expect(refreshed.selectedNodeId).toBeNull();
  });

  it("keeps the cached workflow when a refresh response is temporarily incomplete", () => {
    const current = readyState();
    const incomplete = { ...overview(), workflow: undefined } as unknown as RunOverview;

    const refreshed = runDetailReducer(
      { ...current, phase: "refreshing" as const, generation: 6 },
      {
        type: "request-succeeded",
        kind: "refresh",
        generation: 6,
        overview: incomplete,
        refreshedAt: "2026-08-06T10:01:00Z",
      },
    );

    expect(refreshed.phase).toBe("ready");
    expect(refreshed.overview?.workflow).toBe(current.overview?.workflow);
  });

  it("returns the identical state for a stale generation", () => {
    const state = { ...readyState(), phase: "refreshing" as const, generation: 8 };

    expect(runDetailReducer(state, {
      type: "request-succeeded",
      kind: "refresh",
      generation: 7,
      overview: overview({ runId: "stale-run" }),
      refreshedAt: NOW,
    })).toBe(state);
  });
});

describe("detailPollInterval", () => {
  it("polls active and terminal runs at their specified intervals", () => {
    expect(detailPollInterval(undefined)).toBe(2000);
    expect(detailPollInterval("IN_PROGRESS")).toBe(2000);
    expect(detailPollInterval("PAUSED")).toBe(2000);
    expect(detailPollInterval("DONE")).toBe(10000);
    expect(detailPollInterval("ARCHIVED")).toBe(10000);
  });
});

function readyState() {
  return {
    ...createRunDetailState(),
    overview: overview(),
    phase: "ready" as const,
    lastRefreshedAt: NOW,
    generation: 1,
  };
}

function overview(
  options: { runId?: string; workflow?: WorkflowDefinition } = {},
): RunOverview {
  const definition = options.workflow ?? workflow();
  const runId = options.runId ?? "run-1";
  return {
    run: {
      id: runId,
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      workflowSnapshot: definition,
      title: "Release candidate",
      context: { taskGoal: "Ship", parameters: { dryRun: true } },
      executionWorkspace: "G:/Work/release",
      workspaceMode: "write",
      status: "CREATED",
      createdAt: NOW,
      updatedAt: NOW,
    },
    projection: {
      runId,
      status: "CREATED",
      currentNodeIds: ["plan"],
      nodeStates: { plan: "READY", review: "PENDING" },
      allowedActions: [],
      blockingReasons: [],
      revision: "1",
      updatedAt: NOW,
    },
    workflow: definition,
    workspace: null,
    activity: { activeAgentCount: 0, activeDeploymentCount: 0, lastEventAt: NOW },
  };
}

function workflow(): WorkflowDefinition {
  return {
    id: "workflow-1",
    name: "Release workflow",
    version: "1",
    sourceAdapter: "test",
    nodes: [
      { id: "plan", name: "Plan", kind: "agent" },
      { id: "review", name: "Review", kind: "approval" },
    ],
    edges: [{ id: "plan-review", from: "plan", to: "review" }],
    roles: [],
    gates: [],
    policies: {},
    metadata: {},
  };
}

function runtimeError(status: number, code: string) {
  return new RuntimeClientError(status, code, code, undefined, `corr-${code}`);
}
