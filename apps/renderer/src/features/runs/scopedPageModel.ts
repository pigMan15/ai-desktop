import type { RunContext } from "../../app/routes";
import { RuntimeClientError } from "../../app/runtimeClient";

export type ScopedPagePhase =
  | "loading"
  | "ready"
  | "refreshing"
  | "acting"
  | "not-found"
  | "maintenance"
  | "error";

export type ScopedPageState<T> = {
  data: T | null;
  phase: ScopedPagePhase;
  error: RuntimeClientError | null;
  contextKey: string;
  generation: number;
  lastRefreshedAt: string | null;
  stale: boolean;
  readOnly: boolean;
};

export type ScopedPageAction<T> =
  | { type: "context-changed"; context: RunContext; generation: number }
  | { type: "load-started"; contextKey: string; generation: number; retainData: boolean }
  | {
      type: "load-succeeded";
      contextKey: string;
      generation: number;
      data: T;
      at: string;
      readOnly?: boolean;
    }
  | { type: "load-failed"; contextKey: string; generation: number; error: RuntimeClientError }
  | { type: "action-started"; contextKey: string; generation: number }
  | { type: "action-succeeded"; contextKey: string; generation: number; data?: T; at?: string }
  | { type: "action-failed"; contextKey: string; generation: number; error: RuntimeClientError };

export function scopedContextKey(context: RunContext): string {
  return [context.projectId, context.runId, context.jobId ?? ""].join(":");
}

export function createScopedPageState<T>(context: RunContext): ScopedPageState<T> {
  return {
    data: null,
    phase: "loading",
    error: null,
    contextKey: scopedContextKey(context),
    generation: 0,
    lastRefreshedAt: null,
    stale: false,
    readOnly: false,
  };
}

export function reduceScopedPage<T>(
  state: ScopedPageState<T>,
  action: ScopedPageAction<T>,
): ScopedPageState<T> {
  if (action.type === "context-changed") {
    return {
      ...createScopedPageState<T>(action.context),
      generation: action.generation,
    };
  }

  if (action.type === "load-started") {
    if (action.contextKey !== state.contextKey || action.generation < state.generation) return state;
    return {
      ...state,
      phase: action.retainData && state.data !== null ? "refreshing" : "loading",
      error: null,
      stale: false,
      generation: action.generation,
    };
  }

  if (action.type === "action-started") {
    if (action.contextKey !== state.contextKey || action.generation < state.generation) return state;
    return { ...state, phase: "acting", error: null };
  }

  if (action.contextKey !== state.contextKey || action.generation !== state.generation) {
    return state;
  }

  if (action.type === "load-succeeded") {
    return {
      ...state,
      data: action.data,
      phase: "ready",
      error: null,
      lastRefreshedAt: action.at,
      stale: false,
      readOnly: action.readOnly ?? state.readOnly,
    };
  }

  if (action.type === "action-succeeded") {
    return {
      ...state,
      data: action.data ?? state.data,
      phase: "ready",
      error: null,
      stale: false,
      lastRefreshedAt: action.at ?? state.lastRefreshedAt,
    };
  }

  const error = action.error;
  const hasData = state.data !== null;
  return {
    ...state,
    phase: errorPhase(error, hasData),
    error,
    stale: hasData,
    readOnly: state.readOnly || isArchivedError(error),
  };
}

function errorPhase(error: RuntimeClientError, hasData: boolean): ScopedPagePhase {
  if (hasData) return "ready";
  if (error.code === "RUN_NOT_FOUND_IN_PROJECT" || error.status === 404) return "not-found";
  if (error.code === "RUN_REARCHITECTURE_MAINTENANCE" || error.status === 503) return "maintenance";
  return "error";
}

function isArchivedError(error: RuntimeClientError): boolean {
  return error.code.includes("ARCHIVED") || error.code === "RUN_ARCHIVED";
}
