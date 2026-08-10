import { describe, expect, it } from "vitest";

import { RuntimeClientError } from "../../app/runtimeClient";
import {
  createScopedPageState,
  reduceScopedPage,
  scopedContextKey,
  type ScopedPageState,
} from "./scopedPageModel";

const NOW = "2026-08-06T00:00:00Z";
const contextA = { projectId: "project-a", runId: "run-a" };
const contextB = { projectId: "project-b", runId: "run-b" };
const error = (status: number, code = "RUNTIME_ERROR") =>
  new RuntimeClientError(status, code, "error", undefined, null);

describe("scopedPageModel", () => {
  it("builds a stable context key", () => {
    expect(scopedContextKey({ ...contextA, jobId: "job-1" })).toBe("project-a:run-a:job-1");
  });

  it("ignores a stale response from a previous Run generation", () => {
    const initial = createScopedPageState<string[]>(contextA);
    const loadingB = reduceScopedPage(initial, {
      type: "context-changed",
      context: contextB,
      generation: 2,
    });
    const stale = reduceScopedPage(loadingB, {
      type: "load-succeeded",
      contextKey: scopedContextKey(contextA),
      generation: 1,
      data: ["A"],
      at: NOW,
    });
    expect(stale).toBe(loadingB);
  });

  it("retains trusted data when a refresh fails", () => {
    const key = scopedContextKey(contextA);
    const ready: ScopedPageState<string[]> = {
      ...createScopedPageState(contextA),
      data: ["trusted"],
      phase: "ready",
      generation: 3,
      lastRefreshedAt: NOW,
    };
    const refreshing = reduceScopedPage(ready, {
      type: "load-started",
      contextKey: key,
      generation: 4,
      retainData: true,
    });
    const failed = reduceScopedPage(refreshing, {
      type: "load-failed",
      contextKey: key,
      generation: 4,
      error: error(503),
    });
    expect(failed.data).toEqual(["trusted"]);
    expect(failed.phase).toBe("ready");
    expect(failed.stale).toBe(true);
  });

  it("maps not-found and maintenance failures", () => {
    const state = createScopedPageState(contextA);
    const notFound = reduceScopedPage(
      reduceScopedPage(state, {
        type: "load-started",
        contextKey: scopedContextKey(contextA),
        generation: 1,
        retainData: false,
      }),
      {
        type: "load-failed",
        contextKey: scopedContextKey(contextA),
        generation: 1,
        error: error(404, "RUN_NOT_FOUND_IN_PROJECT"),
      },
    );
    expect(notFound.phase).toBe("not-found");
    const maintenance = reduceScopedPage(notFound, {
      type: "load-failed",
      contextKey: scopedContextKey(contextA),
      generation: 1,
      error: error(503, "RUN_REARCHITECTURE_MAINTENANCE"),
    });
    expect(maintenance.phase).toBe("maintenance");
  });

  it("marks archived data read-only", () => {
    const state = createScopedPageState(contextA);
    const next = reduceScopedPage(state, {
      type: "load-succeeded",
      contextKey: scopedContextKey(contextA),
      generation: 0,
      data: { archived: true },
      at: NOW,
      readOnly: true,
    });
    expect(next.readOnly).toBe(true);
    expect(next.phase).toBe("ready");
  });
});
