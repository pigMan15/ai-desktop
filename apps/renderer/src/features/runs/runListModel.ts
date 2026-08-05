import type { RunListQuery, RunListResponse, RunSummaryProjection } from "@workflow-platform/contracts";
import type { RuntimeClientError } from "../../app/runtimeClient";

export type RunListRequestKind = "initial" | "refresh" | "load-more";

export type RunListState = {
  query: RunListQuery;
  items: RunSummaryProjection[];
  nextCursor: string | null;
  phase: "idle" | "loading" | "ready" | "refreshing" | "loading-more";
  lastRefreshedAt: string | null;
  error: RuntimeClientError | null;
  generation: number;
};

export type RunListAction =
  | { type: "request-started"; kind: RunListRequestKind; generation: number }
  | {
      type: "request-succeeded";
      kind: RunListRequestKind;
      generation: number;
      response: RunListResponse;
      refreshedAt: string;
    }
  | { type: "request-failed"; generation: number; error: RuntimeClientError }
  | { type: "query-changed"; query: RunListQuery; generation: number };

export function createRunListState(query: RunListQuery = { limit: 20 }): RunListState {
  return {
    query,
    items: [],
    nextCursor: null,
    phase: "idle",
    lastRefreshedAt: null,
    error: null,
    generation: 0,
  };
}

export function runListReducer(state: RunListState, action: RunListAction): RunListState {
  if (action.type === "query-changed") {
    return {
      ...state,
      query: action.query,
      items: [],
      nextCursor: null,
      phase: "loading",
      error: null,
      generation: action.generation,
    };
  }

  if (action.type === "request-started") {
    return {
      ...state,
      phase: requestPhase(action.kind),
      error: null,
      generation: action.generation,
    };
  }

  if (action.generation !== state.generation) {
    return state;
  }

  if (action.type === "request-failed") {
    return {
      ...state,
      phase: state.items.length > 0 ? "ready" : "idle",
      error: action.error,
    };
  }

  return {
    ...state,
    items:
      action.kind === "load-more"
        ? appendUniqueRuns(state.items, action.response.items)
        : action.response.items,
    nextCursor: action.response.nextCursor,
    phase: "ready",
    lastRefreshedAt: action.refreshedAt,
    error: null,
  };
}

export function hasActiveRunFilters(query: RunListQuery): boolean {
  return Boolean(
    query.status?.length
      || query.workflowVersionId
      || query.workspacePath
      || query.q?.trim(),
  );
}

function requestPhase(kind: RunListRequestKind): RunListState["phase"] {
  if (kind === "refresh") return "refreshing";
  if (kind === "load-more") return "loading-more";
  return "loading";
}

function appendUniqueRuns(
  current: RunSummaryProjection[],
  incoming: RunSummaryProjection[],
): RunSummaryProjection[] {
  const seen = new Set(current.map((item) => item.id));
  const appended: RunSummaryProjection[] = [];
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    appended.push(item);
  }
  return [...current, ...appended];
}
