import type {
  ExecuteRunActionResponse,
  RunOverview,
  RunStatus,
} from "@workflow-platform/contracts";
import type { RuntimeClientError } from "../../app/runtimeClient";

export type RunDetailPhase =
  | "loading"
  | "ready"
  | "refreshing"
  | "acting"
  | "not-found"
  | "maintenance"
  | "error";

export type RunDetailState = {
  overview: RunOverview | null;
  phase: RunDetailPhase;
  selectedNodeId: string | null;
  lastRefreshedAt: string | null;
  error: RuntimeClientError | null;
  generation: number;
};

export type RunDetailRequestKind = "initial" | "refresh";

export type RunDetailAction =
  | { type: "request-started"; kind: RunDetailRequestKind; generation: number }
  | {
      type: "request-succeeded";
      kind: RunDetailRequestKind;
      generation: number;
      overview: RunOverview;
      refreshedAt: string;
    }
  | { type: "request-failed"; generation: number; error: RuntimeClientError }
  | { type: "action-started"; generation: number }
  | {
      type: "action-succeeded";
      generation: number;
      response: ExecuteRunActionResponse;
    }
  | { type: "action-failed"; generation: number; error: RuntimeClientError }
  | { type: "node-selected"; nodeId: string | null };

export function createRunDetailState(): RunDetailState {
  return {
    overview: null,
    phase: "loading",
    selectedNodeId: null,
    lastRefreshedAt: null,
    error: null,
    generation: 0,
  };
}

export function runDetailReducer(
  state: RunDetailState,
  action: RunDetailAction,
): RunDetailState {
  if (action.type === "node-selected") {
    return { ...state, selectedNodeId: action.nodeId };
  }

  if (action.type === "request-started") {
    return {
      ...state,
      phase: action.kind === "refresh" ? "refreshing" : "loading",
      error: null,
      generation: action.generation,
    };
  }

  if (action.type === "action-started") {
    return {
      ...state,
      phase: "acting",
      error: null,
      generation: action.generation,
    };
  }

  if (action.generation !== state.generation) {
    return state;
  }

  if (action.type === "request-succeeded") {
    const overview = mergeOverview(state.overview, action.overview);
    return {
      ...state,
      overview,
      phase: "ready",
      selectedNodeId: selectedNodeInOverview(
        state.selectedNodeId,
        overview,
      ),
      lastRefreshedAt: action.refreshedAt,
      error: null,
    };
  }

  if (action.type === "action-succeeded") {
    return {
      ...state,
      overview: state.overview
        ? { ...state.overview, projection: action.response.projection }
        : null,
      phase: state.overview ? "ready" : "error",
      error: null,
    };
  }

  return {
    ...state,
    phase: failurePhase(state.overview, action.error),
    error: action.error,
  };
}

function mergeOverview(
  previous: RunOverview | null,
  incoming: RunOverview,
): RunOverview {
  if (previous && !isWorkflowSnapshot(incoming.workflow)) {
    return { ...incoming, workflow: previous.workflow };
  }
  return incoming;
}

function isWorkflowSnapshot(value: RunOverview["workflow"]): boolean {
  return Boolean(value && Array.isArray(value.nodes) && Array.isArray(value.edges));
}

export function detailPollInterval(status: RunStatus | undefined): 2000 | 10000 {
  return status === "DONE" || status === "ARCHIVED" ? 10000 : 2000;
}

function selectedNodeInOverview(
  selectedNodeId: string | null,
  overview: RunOverview,
): string | null {
  if (selectedNodeId === null) return null;
  return overview.workflow.nodes.some((node) => node.id === selectedNodeId)
    ? selectedNodeId
    : null;
}

function failurePhase(
  overview: RunOverview | null,
  error: RuntimeClientError,
): RunDetailPhase {
  if (overview) return "ready";
  if (error.code === "RUN_NOT_FOUND_IN_PROJECT") return "not-found";
  if (error.code === "RUN_REARCHITECTURE_MAINTENANCE") return "maintenance";
  return "error";
}
