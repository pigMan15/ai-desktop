import { useCallback, useEffect, useReducer, useRef } from "react";
import { Plus, RefreshCw } from "lucide-react";

import type {
  RunListQuery,
  RunListResponse,
  RunStatus,
  RunSummaryProjection,
} from "@workflow-platform/contracts";
import { RuntimeClientError } from "../../app/runtimeClient";
import {
  createRunListState,
  hasActiveRunFilters,
  runListReducer,
  type RunListRequestKind,
} from "./runListModel";

const RUN_STATUSES: RunStatus[] = [
  "CREATED",
  "IN_PROGRESS",
  "REVIEWING",
  "BLOCKED",
  "PAUSED",
  "DONE",
  "ARCHIVED",
];

type RunListPageProps = {
  projectId: string;
  projectName: string;
  workflowName?: string;
  workspaces: Array<{ path: string; label: string }>;
  loadRuns(query: RunListQuery, signal: AbortSignal): Promise<RunListResponse>;
  onOpenRun(runId: string): void;
  onNewRun(): void;
};

export function RunListPage({
  projectId,
  projectName,
  workflowName,
  workspaces,
  loadRuns,
  onOpenRun,
  onNewRun,
}: RunListPageProps) {
  const initialQuery: RunListQuery = { limit: 20 };
  const [state, dispatch] = useReducer(runListReducer, initialQuery, createRunListState);
  const queryRef = useRef<RunListQuery>(initialQuery);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);

  const performLoad = useCallback((kind: RunListRequestKind, query: RunListQuery, queryChanged = false) => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (queryChanged) {
      queryRef.current = query;
      dispatch({ type: "query-changed", query, generation });
    } else {
      dispatch({ type: "request-started", kind, generation });
    }

    void loadRuns(query, controller.signal)
      .then((response) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        dispatch({
          type: "request-succeeded",
          kind,
          generation,
          response,
          refreshedAt: new Date().toISOString(),
        });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || controller.signal.aborted || isAbortError(error)) return;
        dispatch({ type: "request-failed", generation, error: toRuntimeClientError(error) });
      });
  }, [loadRuns]);

  useEffect(() => {
    mountedRef.current = true;
    queryRef.current = initialQuery;
    performLoad("initial", initialQuery);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      abortRef.current?.abort();
    };
  }, [performLoad, projectId]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        performLoad("refresh", queryRef.current);
      }
    };
    const interval = window.setInterval(refreshIfVisible, 10_000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refreshIfVisible();
    };
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [performLoad]);

  const changeQuery = (patch: Partial<RunListQuery>) => {
    const next = { ...queryRef.current, ...patch, cursor: undefined };
    performLoad("initial", next, true);
  };

  const toggleStatus = (status: RunStatus) => {
    const selected = queryRef.current.status ?? [];
    changeQuery({
      status: selected.includes(status)
        ? selected.filter((value) => value !== status)
        : [...selected, status],
    });
  };

  const clearFilters = () => {
    performLoad("initial", { limit: queryRef.current.limit ?? 20 }, true);
  };

  const loadMore = () => {
    if (!state.nextCursor) return;
    performLoad("load-more", { ...queryRef.current, cursor: state.nextCursor });
  };

  return (
    <section className="page-runs run-list-page" aria-label="Run 列表">
      <header className="run-list-heading">
        <div>
          <p className="section-kicker">{projectName}</p>
          <h2>运行</h2>
          <p className="run-list-context">{workflowName ? `已绑定：${workflowName}` : "未绑定工作流"}</p>
        </div>
        <button className="quiet-button run-command-button" type="button" onClick={onNewRun}>
          <Plus aria-hidden="true" size={16} strokeWidth={1.8} />
          新建 Run
        </button>
      </header>

      <div className="run-list-toolbar" aria-label="Run 筛选">
        <label className="run-search-field">
          搜索 Run
          <input
            type="search"
            value={state.query.q ?? ""}
            onChange={(event) => changeQuery({ q: event.target.value })}
          />
        </label>
        <label>
          执行工作区
          <select
            value={state.query.workspacePath ?? ""}
            onChange={(event) => changeQuery({ workspacePath: event.target.value || undefined })}
          >
            <option value="">全部工作区</option>
            {workspaces.map((workspace) => (
              <option key={workspace.path} value={workspace.path}>{workspace.label}</option>
            ))}
          </select>
        </label>
        <fieldset className="run-status-filter">
          <legend>状态</legend>
          <div>
            {RUN_STATUSES.map((status) => (
              <label key={status}>
                <input
                  type="checkbox"
                  aria-label={`状态 ${status}`}
                  checked={state.query.status?.includes(status) ?? false}
                  onChange={() => toggleStatus(status)}
                />
                {status}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="run-refresh-control">
          <button
            className="quiet-button icon-button"
            type="button"
            aria-label="刷新 Run 列表"
            title="刷新 Run 列表"
            disabled={state.phase === "refreshing"}
            onClick={() => performLoad("refresh", queryRef.current)}
          >
            <RefreshCw aria-hidden="true" size={16} strokeWidth={1.8} />
          </button>
          <span>{state.lastRefreshedAt ? `上次刷新 ${formatTime(state.lastRefreshedAt)}` : "尚未刷新"}</span>
        </div>
      </div>

      {state.error ? (
        <div className="run-list-error" role="alert">
          <strong>{errorTitle(state.error)}</strong>
          <span>{state.error.message}</span>
          {state.error.correlationId ? <code>{state.error.correlationId}</code> : null}
        </div>
      ) : null}

      {state.phase === "loading" && state.items.length === 0 ? (
        <p className="run-list-loading" role="status">正在加载 Run...</p>
      ) : null}

      {state.phase !== "loading" && !state.error && state.items.length === 0 ? (
        hasActiveRunFilters(state.query) ? (
          <div className="run-list-empty">
            <strong>没有符合条件的 Run</strong>
            <button className="quiet-button" type="button" onClick={clearFilters}>清除筛选</button>
          </div>
        ) : (
          <div className="run-list-empty">
            <strong>尚无 Run</strong>
            <button className="quiet-button" type="button" onClick={onNewRun}>新建 Run</button>
          </div>
        )
      ) : null}

      {state.items.length > 0 ? (
        <div className="run-list-table-wrap">
          <table className="run-list-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>工作流 / 进度</th>
                <th>当前 / 下一环节</th>
                <th>状态 / 阻塞</th>
                <th>工作区 / 活动</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((run) => (
                <RunSummaryRow key={run.id} run={run} onOpen={() => onOpenRun(run.id)} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {state.nextCursor ? (
        <div className="run-list-pagination">
          <button
            className="quiet-button"
            type="button"
            disabled={state.phase === "loading-more"}
            onClick={loadMore}
          >
            {state.phase === "loading-more" ? "正在加载..." : "加载更多"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function RunSummaryRow({ run, onOpen }: { run: RunSummaryProjection; onOpen(): void }) {
  const activate = (event: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen();
  };
  return (
    <tr
      className="run-list-row"
      data-testid={`run-row-${run.id}`}
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={activate}
    >
      <td data-label="Run">
        <strong>{run.title}</strong>
        <code>{shortRunId(run.id)}</code>
      </td>
      <td data-label="工作流 / 进度">
        <strong>{run.workflowName} v{run.workflowVersion}</strong>
        <span>{run.progress.passed} / {run.progress.total}</span>
      </td>
      <td data-label="当前 / 下一环节">
        <span>{nodeNames(run.currentNodes)}</span>
        <small>下一步：{nodeNames(run.nextNodes)}</small>
      </td>
      <td data-label="状态 / 阻塞">
        <span className={`status-pill ${run.status === "BLOCKED" ? "status-blocked" : ""}`}>{run.status}</span>
        <small>{run.blocker?.message ?? "无阻塞"}</small>
      </td>
      <td data-label="工作区 / 活动">
        <span>{run.workspace ? `${run.workspace.label} · ${run.workspace.leaseMode}/${run.workspace.leaseStatus}` : "未分配"}</span>
        <small>Agent {run.activeAgentCount} / 部署 {run.activeDeploymentCount}</small>
      </td>
      <td data-label="更新时间"><time dateTime={run.updatedAt}>{formatDateTime(run.updatedAt)}</time></td>
    </tr>
  );
}

function nodeNames(nodes: Array<{ name: string }>): string {
  return nodes.length > 0 ? nodes.map((node) => node.name).join("、") : "无";
}

function shortRunId(runId: string): string {
  return runId.length > 8 ? `${runId.slice(0, 8)}...` : runId;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium" }).format(new Date(value));
}

function errorTitle(error: RuntimeClientError): string {
  if (error.code === "RUN_REARCHITECTURE_MAINTENANCE") return "运行模块维护中";
  if (error.code === "WORKSPACE_LEASE_CONFLICT") return "工作区已被占用";
  return "Run 列表刷新失败";
}

function toRuntimeClientError(error: unknown): RuntimeClientError {
  if (error instanceof RuntimeClientError) return error;
  return new RuntimeClientError(
    null,
    "NETWORK_ERROR",
    error instanceof Error ? error.message : "无法连接 Runtime",
    undefined,
    null,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
