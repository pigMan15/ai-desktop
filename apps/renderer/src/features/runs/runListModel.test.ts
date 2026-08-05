import { describe, expect, it } from "vitest";

import type { RunSummaryProjection } from "@workflow-platform/contracts";
import { RuntimeClientError } from "../../app/runtimeClient";
import {
  createRunListState,
  hasActiveRunFilters,
  runListReducer,
} from "./runListModel";

function summary(id: string, updatedAt = "2026-08-05T10:00:00Z"): RunSummaryProjection {
  return {
    id,
    projectId: "project-1",
    workflowVersionId: "workflow-version-1",
    workflowName: "Release",
    workflowVersion: "1",
    title: `Run ${id}`,
    status: "IN_PROGRESS",
    taskGoal: null,
    currentNodes: [],
    nextNodes: [],
    progress: { total: 2, passed: 0, running: 1, blocked: 0, pending: 1 },
    blocker: null,
    workspace: null,
    activeAgentCount: 0,
    activeDeploymentCount: 0,
    createdAt: "2026-08-05T09:00:00Z",
    updatedAt,
  };
}

describe("runListReducer", () => {
  it("starts an initial request and replaces rows after success", () => {
    const loading = runListReducer(createRunListState(), {
      type: "request-started",
      kind: "initial",
      generation: 1,
    });

    expect(loading.phase).toBe("loading");
    expect(loading.generation).toBe(1);

    const ready = runListReducer(loading, {
      type: "request-succeeded",
      kind: "initial",
      generation: 1,
      response: { items: [summary("run-1")], nextCursor: "cursor-2" },
      refreshedAt: "2026-08-05T10:01:00Z",
    });

    expect(ready).toMatchObject({
      phase: "ready",
      items: [{ id: "run-1" }],
      nextCursor: "cursor-2",
      lastRefreshedAt: "2026-08-05T10:01:00Z",
      error: null,
    });
  });

  it("keeps existing rows during refresh and replaces them only after success", () => {
    const initial = {
      ...createRunListState(),
      items: [summary("run-old")],
      nextCursor: "old-cursor",
      phase: "ready" as const,
      lastRefreshedAt: "2026-08-05T10:00:00Z",
    };
    const refreshing = runListReducer(initial, {
      type: "request-started",
      kind: "refresh",
      generation: 2,
    });

    expect(refreshing.phase).toBe("refreshing");
    expect(refreshing.items).toEqual(initial.items);

    const ready = runListReducer(refreshing, {
      type: "request-succeeded",
      kind: "refresh",
      generation: 2,
      response: { items: [summary("run-new")], nextCursor: null },
      refreshedAt: "2026-08-05T10:02:00Z",
    });

    expect(ready.items.map((item) => item.id)).toEqual(["run-new"]);
    expect(ready.lastRefreshedAt).toBe("2026-08-05T10:02:00Z");
  });

  it("retains rows and the last successful timestamp after refresh failure", () => {
    const error = new RuntimeClientError(503, "RUN_REARCHITECTURE_MAINTENANCE", "维护中", undefined, "corr-1");
    const refreshing = {
      ...createRunListState(),
      items: [summary("run-1")],
      phase: "refreshing" as const,
      generation: 3,
      lastRefreshedAt: "2026-08-05T10:00:00Z",
    };

    const failed = runListReducer(refreshing, { type: "request-failed", generation: 3, error });

    expect(failed.phase).toBe("ready");
    expect(failed.items).toEqual(refreshing.items);
    expect(failed.lastRefreshedAt).toBe("2026-08-05T10:00:00Z");
    expect(failed.error).toBe(error);
  });

  it("appends load-more rows in response order and deduplicates by Run ID", () => {
    const loadingMore = {
      ...createRunListState(),
      items: [summary("run-1"), summary("run-2")],
      phase: "loading-more" as const,
      generation: 4,
    };

    const ready = runListReducer(loadingMore, {
      type: "request-succeeded",
      kind: "load-more",
      generation: 4,
      response: { items: [summary("run-2"), summary("run-3"), summary("run-4")], nextCursor: "cursor-3" },
      refreshedAt: "2026-08-05T10:03:00Z",
    });

    expect(ready.items.map((item) => item.id)).toEqual(["run-1", "run-2", "run-3", "run-4"]);
    expect(ready.nextCursor).toBe("cursor-3");
  });

  it("resets rows and cursor when the query changes", () => {
    const current = {
      ...createRunListState(),
      items: [summary("run-1")],
      nextCursor: "cursor-2",
      phase: "ready" as const,
      error: new RuntimeClientError(null, "NETWORK_ERROR", "offline", undefined, null),
    };

    const changed = runListReducer(current, {
      type: "query-changed",
      query: { status: ["BLOCKED"], limit: 20 },
      generation: 5,
    });

    expect(changed).toMatchObject({
      query: { status: ["BLOCKED"], limit: 20 },
      items: [],
      nextCursor: null,
      phase: "loading",
      error: null,
      generation: 5,
    });
  });

  it("returns the identical state for stale request results", () => {
    const state = { ...createRunListState(), phase: "refreshing" as const, generation: 6 };
    const result = runListReducer(state, {
      type: "request-succeeded",
      kind: "refresh",
      generation: 5,
      response: { items: [summary("stale")], nextCursor: null },
      refreshedAt: "2026-08-05T10:04:00Z",
    });

    expect(result).toBe(state);
  });
});

describe("hasActiveRunFilters", () => {
  it("ignores pagination while recognizing user-visible filters", () => {
    expect(hasActiveRunFilters({ limit: 20, cursor: "opaque" })).toBe(false);
    expect(hasActiveRunFilters({ status: ["PAUSED"] })).toBe(true);
    expect(hasActiveRunFilters({ workflowVersionId: "version-1" })).toBe(true);
    expect(hasActiveRunFilters({ workspacePath: "G:\\project" })).toBe(true);
    expect(hasActiveRunFilters({ q: "release" })).toBe(true);
    expect(hasActiveRunFilters({ status: [], q: "   " })).toBe(false);
  });
});
