import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import type {
  Actor,
  ExecuteRunActionRequest,
  ExecuteRunActionResponse,
  RunOverview,
  WorkflowNode,
} from "@workflow-platform/contracts";
import { RuntimeClientError } from "../../app/runtimeClient";
import { RunProgressMap } from "./RunProgressMap";
import {
  createRunDetailState,
  detailPollInterval,
  runDetailReducer,
  type RunDetailRequestKind,
} from "./runDetailModel";
import {
  resolveAllowedActionGuidance,
  resolveNodeGuidance,
  resolveRunSuccessors,
  type RunGuidanceAction,
} from "./runWorkbenchModel";

export type RunDetailPageProps = {
  projectId: string;
  runId: string;
  projectName: string;
  actor: Actor;
  loadOverview(signal: AbortSignal): Promise<RunOverview>;
  executeAction(
    request: ExecuteRunActionRequest,
    signal: AbortSignal,
  ): Promise<ExecuteRunActionResponse>;
  onReturnToList(): void;
};

export function RunDetailPage(props: RunDetailPageProps) {
  return <RunDetailPageContent key={`${props.projectId}:${props.runId}`} {...props} />;
}

function RunDetailPageContent({
  projectId,
  runId,
  projectName,
  actor,
  loadOverview,
  executeAction,
  onReturnToList,
}: RunDetailPageProps) {
  const [state, dispatch] = useReducer(runDetailReducer, undefined, createRunDetailState);
  const [actionInputsById, setActionInputsById] = useState<Record<string, ActionInputValues>>({});
  const [transitionNotice, setTransitionNotice] = useState<string | null>(null);
  const [forcedReadOnly, setForcedReadOnly] = useState(false);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);

  const performLoad = useCallback((kind: RunDetailRequestKind) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "request-started", kind, generation });

    void loadOverview(controller.signal)
      .then((overview) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        dispatch({
          type: "request-succeeded",
          kind,
          generation,
          overview,
          refreshedAt: new Date().toISOString(),
        });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || controller.signal.aborted || isAbortError(error)) return;
        dispatch({ type: "request-failed", generation, error: toRuntimeClientError(error) });
      })
      .finally(() => {
        if (abortRef.current === controller) busyRef.current = false;
      });
    return true;
  }, [loadOverview]);

  useEffect(() => {
    mountedRef.current = true;
    busyRef.current = false;
    setForcedReadOnly(false);
    performLoad("initial");
    return () => {
      mountedRef.current = false;
      busyRef.current = false;
      generationRef.current += 1;
      abortRef.current?.abort();
    };
  }, [performLoad, projectId, runId]);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") performLoad("refresh");
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refreshIfVisible();
    };
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [performLoad]);

  useEffect(() => {
    if (state.phase !== "ready" || !state.overview) return;
    const timeout = window.setTimeout(() => {
      if (document.visibilityState === "visible") performLoad("refresh");
    }, detailPollInterval(state.overview.projection.status));
    return () => window.clearTimeout(timeout);
  }, [performLoad, state.lastRefreshedAt, state.overview, state.phase]);

  const runAction = useCallback((action: RunGuidanceAction) => {
    if (!state.overview || busyRef.current) return;
    const inputs = actionInputsById[action.id] ?? EMPTY_ACTION_INPUTS;
    setTransitionNotice(null);
    busyRef.current = true;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "action-started", generation });
    const request: ExecuteRunActionRequest = {
      actionId: action.id,
      expectedRevision: state.overview.projection.revision,
      actor,
      ...actionPayload(action, inputs),
    };

    void executeAction(request, controller.signal)
      .then((response) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        dispatch({ type: "action-succeeded", generation, response });
        busyRef.current = false;
        queueMicrotask(() => {
          if (mountedRef.current) performLoad("refresh");
        });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || controller.signal.aborted || isAbortError(error)) return;
        const runtimeError = toRuntimeClientError(error);
        dispatch({ type: "action-failed", generation, error: runtimeError });
        if (["REVISION_CONFLICT", "PROJECT_ARCHIVED", "RUN_ARCHIVED"].includes(runtimeError.code)) {
          if (runtimeError.code !== "REVISION_CONFLICT") setForcedReadOnly(true);
          setTransitionNotice(
            runtimeError.code === "REVISION_CONFLICT"
              ? "状态已更新，已刷新当前 Run。"
              : "归档状态已更新，当前 Run 已刷新。",
          );
          busyRef.current = false;
          queueMicrotask(() => {
            if (mountedRef.current) performLoad("refresh");
          });
        }
      })
      .finally(() => {
        if (abortRef.current === controller) busyRef.current = false;
      });
  }, [actionInputsById, actor, executeAction, performLoad, state.overview]);

  const returnLink = (
    <a
      href="#/runs"
      className="quiet-link"
      onClick={(event) => {
        event.preventDefault();
        onReturnToList();
      }}
    >
      返回 Run 列表
    </a>
  );

  if (!state.overview) {
    if (state.phase === "loading") {
      return <section className="page-runs run-detail-page"><p className="run-detail-state">正在加载 Run...</p></section>;
    }
    if (state.phase === "not-found") {
      return <section className="page-runs run-detail-page">{returnLink}<h2>此项目中不存在该 Run</h2><p>{state.error?.message}</p></section>;
    }
    if (state.phase === "maintenance") {
      return (
        <section className="page-runs run-detail-page">
          {returnLink}
          <h2>Run 服务维护中</h2>
          <p>{state.error?.message}</p>
          <button type="button" className="quiet-button" onClick={() => performLoad("initial")}>重试</button>
        </section>
      );
    }
    return (
      <section className="page-runs run-detail-page">
        {returnLink}
        <h2>无法加载 Run</h2>
        <p>{state.error?.message ?? "Runtime 请求失败"}</p>
        <button type="button" className="quiet-button" onClick={() => performLoad("initial")}>重试</button>
      </section>
    );
  }

  const { overview } = state;
  const { projection, run, workflow } = overview;
  const selectedNodeId = state.selectedNodeId
    ?? projection.currentNodeIds[0]
    ?? null;
  const selectedNode = workflow.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const successors = selectedNodeId
    ? resolveRunSuccessors(workflow, selectedNodeId)
    : { kind: "none" as const, items: [] };
  const guidance = resolveNodeGuidance({
    workflow,
    projection,
    nodeId: selectedNodeId,
    projectArchived: forcedReadOnly || projection.status === "ARCHIVED",
  });
  const authorizedActions = forcedReadOnly ? [] : resolveAllowedActionGuidance(projection);
  const blockers = projection.blockingReasons.filter(
    (blocker) => blocker.nodeId === undefined || blocker.nodeId === selectedNodeId,
  );
  const context = `projectId=${encodeURIComponent(projectId)}&runId=${encodeURIComponent(runId)}`;

  return (
    <section className="page-runs run-detail-page" aria-label={`Run 详情：${run.title}`}>
      <header className="run-detail-heading">
        <div>
          {returnLink}
          <p className="eyebrow">{projectName}</p>
          <h2>{run.title}</h2>
          <p className="run-detail-identity"><code title={run.id}>{shortRunId(run.id)}</code> · {statusLabel(projection.status)} · 修订 {projection.revision}</p>
        </div>
        <button
          type="button"
          className="quiet-button icon-text-button"
          disabled={state.phase === "refreshing" || state.phase === "acting"}
          onClick={() => performLoad("refresh")}
        >
          <RefreshCw size={15} aria-hidden="true" />
          刷新
        </button>
      </header>

      {state.error ? <ErrorNotice error={state.error} /> : null}
      {transitionNotice ? <div className="run-detail-notice" role="status">{transitionNotice}</div> : null}

      <section className="run-detail-overview-band" aria-label="Run 概览">
        <div><span>工作流</span><strong>{workflow.name}</strong><small>版本 {workflow.version}</small></div>
        <div><span>工作区</span><strong>{overview.workspace?.workspacePath ?? run.executionWorkspace}</strong><small>{run.workspaceMode === "write" ? "可写" : "只读"} · 租约 {overview.workspace?.status ?? "无"}</small></div>
        <div><span>活动</span><strong>{overview.activity.activeAgentCount} 个活跃 Agent</strong><small>{overview.activity.activeDeploymentCount} 个活跃部署</small></div>
        <div><span>最近事件</span><strong>{formatTime(overview.activity.lastEventAt)}</strong><small>最近刷新 {formatTime(state.lastRefreshedAt)}</small></div>
      </section>

      <RunProgressMap
        workflow={workflow}
        projection={projection}
        selectedNodeId={selectedNodeId}
        onSelectNode={(nodeId) => dispatch({ type: "node-selected", nodeId })}
      />

      <div className="run-detail-scheduling-band">
        <CurrentNodeSection node={selectedNode} run={run} overview={overview} blockers={blockers} />
        <section className="run-detail-actions" aria-label="Runtime 授权操作">
          <div className="panel-heading">
            <div><p className="eyebrow">Runtime</p><h3>授权操作</h3></div>
            <span>{authorizedActions.length} 项可用</span>
          </div>
          {authorizedActions.length === 0 ? (
            <p className="run-next-action-message">{guidance.waitingMessage ?? "当前没有可执行操作。"}</p>
          ) : (
            <div className="run-detail-action-list">
              {authorizedActions.map((action) => {
                const inputs = actionInputsById[action.id] ?? EMPTY_ACTION_INPUTS;
                const node = action.nodeId
                  ? workflow.nodes.find((candidate) => candidate.id === action.nodeId)
                  : null;
                const targetLabel = node?.name ?? action.nodeId ?? run.title;
                const hasDuplicateType = authorizedActions.some(
                  (candidate) => candidate.id !== action.id && candidate.eventType === action.eventType,
                );
                const displayLabel = hasDuplicateType
                  ? `${action.allowedAction.label} · ${targetLabel}`
                  : action.label;
                const disabled = state.phase !== "ready" || !actionInputsReady(action, inputs);
                const setInput = (field: keyof ActionInputValues, value: string) => {
                  setActionInputsById((current) => ({
                    ...current,
                    [action.id]: { ...(current[action.id] ?? EMPTY_ACTION_INPUTS), [field]: value },
                  }));
                };
                return <div className="run-detail-action" key={action.id} role="group" aria-label={displayLabel}>
                  <div><strong>{displayLabel}</strong><p>{action.result}</p></div>
                  {renderActionInputs(action, { ...inputs, setInput })}
                  {action.risk === "low" ? (
                    <button type="button" className="run-next-action-primary-button" disabled={disabled} onClick={() => runAction(action)}>{displayLabel}</button>
                  ) : (
                    <details className="run-detail-confirmation">
                      <summary>{displayLabel}</summary>
                      <p>此操作风险为{action.risk === "high" ? "高" : "中"}，请确认后执行。</p>
                      <button type="button" className="run-next-action-primary-button" disabled={disabled} onClick={() => runAction(action)}>确认执行 {displayLabel}</button>
                    </details>
                  )}
                </div>;
              })}
            </div>
          )}
        </section>
      </div>

      <SuccessorSection
        successors={successors}
        status={projection.status}
        blockerCount={blockers.length}
        actionCount={authorizedActions.length}
      />

      <section className="run-detail-context" aria-label="Run 上下文">
        <div>
          <h3>运行参数</h3>
          <dl className="facts">
            <div><dt>任务目标</dt><dd>{run.context.taskGoal ?? "未设置"}</dd></div>
            <div><dt>创建时间</dt><dd>{formatTime(run.createdAt)}</dd></div>
          </dl>
          <pre className="code-block">{JSON.stringify(run.context.parameters ?? {}, null, 2)}</pre>
        </div>
        <nav aria-label="Run 相关资源">
          <h3>相关资源</h3>
          <div className="run-detail-links">
            <a href={`#/artifacts?${context}`}>产物</a>
            <a href={`#/terminal?${context}`}>终端</a>
            <a href={`#/gates?${context}`}>检查关卡</a>
            <a href={`#/approvals?${context}`}>审批</a>
            <a href={`#/audit?${context}`}>审计</a>
            <a href={`#/recovery?${context}`}>恢复</a>
          </div>
        </nav>
      </section>

      <section className="run-detail-local-sections" aria-label="Run 本地详情">
        <details><summary>部署历史与输出</summary><p>{overview.activity.activeDeploymentCount} 个活跃部署；完整记录将在阶段 4 接入 scoped API。</p></details>
        <details><summary>Runtime 时间线</summary><p>最近事件：{formatTime(overview.activity.lastEventAt)}</p></details>
      </section>
    </section>
  );
}

function CurrentNodeSection({
  node,
  run,
  overview,
  blockers,
}: {
  node: WorkflowNode | null;
  run: RunOverview["run"];
  overview: RunOverview;
  blockers: RunOverview["projection"]["blockingReasons"];
}) {
  const requirements = node?.requires ?? [];
  const outputs = node?.artifacts?.outputs ?? [];
  return (
    <section className="run-detail-current" aria-label="当前工作环节">
      <p className="eyebrow">当前工作环节</p>
      <h3>{node?.name ?? "无当前环节"}</h3>
      {node ? (
        <dl className="facts">
          <div><dt>节点 ID</dt><dd><code>{node.id}</code></dd></div>
          <div><dt>类型</dt><dd>{node.kind}</dd></div>
          <div><dt>角色</dt><dd>{node.role ?? "未指定"}</dd></div>
          <div><dt>目标</dt><dd>{node.description ?? "未提供节点目标"}</dd></div>
          <div><dt>输入要求</dt><dd>{requirements.length ? requirements.map(formatRequirement).join("；") : "无"}</dd></div>
          <div><dt>产物输出</dt><dd>{outputs.length ? outputs.map((output) => output.name).join("、") : "无"}</dd></div>
          <div><dt>完成方式</dt><dd>{node.advance ? (node.advance.mode === "auto" ? "自动完成" : "手动完成") : "未声明"}</dd></div>
          <div><dt>执行工作区</dt><dd>{overview.workspace?.workspacePath ?? run.executionWorkspace}</dd></div>
          <div><dt>Agent 状态</dt><dd>{overview.activity.activeAgentCount} 个活跃 Agent</dd></div>
        </dl>
      ) : null}
      {blockers.length > 0 ? (
        <div className="run-detail-blockers">
          <strong>阻塞原因</strong>
          <ul>{blockers.map((blocker, index) => <li key={`${blocker.code}:${index}`}>{blocker.message}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}

function SuccessorSection({
  successors,
  status,
  blockerCount,
  actionCount,
}: {
  successors: ReturnType<typeof resolveRunSuccessors>;
  status: RunOverview["projection"]["status"];
  blockerCount: number;
  actionCount: number;
}) {
  const terminal = status === "DONE" || status === "ARCHIVED";
  return (
    <section className="run-detail-next" aria-label="下一工作环节">
      <p className="eyebrow">下一工作环节</p>
      <h3>{successors.kind === "none" ? "无直接后续环节" : successors.kind === "single" ? "1 个后继环节" : `${successors.items.length} 个候选后继环节`}</h3>
      {successors.items.length > 0 ? (
        <ol>{successors.items.map(({ node, condition }) => <li key={node.id}><strong>{node.name}</strong><span>{node.kind}</span>{condition ? <small>{condition}</small> : null}</li>)}</ol>
      ) : (
        <p>{terminal ? "Run 已完成，不再调度后继环节。" : `Runtime 当前提供 ${actionCount} 项收尾操作和 ${blockerCount} 项阻塞信息。`}</p>
      )}
    </section>
  );
}

function ErrorNotice({ error }: { error: RuntimeClientError }) {
  return (
    <div className="run-detail-error" role="status">
      <strong>{error.code === "REVISION_CONFLICT" ? "修订冲突，请刷新后重试。" : error.message}</strong>
      {error.correlationId ? <code>{error.correlationId}</code> : null}
    </div>
  );
}

type ActionInputValues = {
  artifactPath: string;
  artifactType: string;
  comment: string;
  evidenceUri: string;
  waiverReason: string;
};

type ActionInputState = ActionInputValues & {
  setInput(field: keyof ActionInputValues, value: string): void;
};

const EMPTY_ACTION_INPUTS: ActionInputValues = {
  artifactPath: "",
  artifactType: "",
  comment: "",
  evidenceUri: "",
  waiverReason: "",
};

function renderActionInputs(action: RunGuidanceAction, inputs: ActionInputState) {
  if (action.eventType === "ARTIFACT_SUBMITTED") {
    return <div className="run-action-input-grid"><label>产物路径<input value={inputs.artifactPath} onChange={(event) => inputs.setInput("artifactPath", event.target.value)} /></label><label>产物类型<input value={inputs.artifactType} onChange={(event) => inputs.setInput("artifactType", event.target.value)} /></label></div>;
  }
  if (["HUMAN_APPROVED", "HUMAN_REJECTED", "HUMAN_DEFERRED"].includes(action.eventType)) {
    return <label>审批说明<textarea value={inputs.comment} onChange={(event) => inputs.setInput("comment", event.target.value)} /></label>;
  }
  if (["GATE_PASSED", "GATE_FAILED"].includes(action.eventType)) {
    return <label>证据 URI<input value={inputs.evidenceUri} onChange={(event) => inputs.setInput("evidenceUri", event.target.value)} /></label>;
  }
  if (action.eventType === "GATE_WAIVED") {
    return <label>豁免原因<textarea value={inputs.waiverReason} onChange={(event) => inputs.setInput("waiverReason", event.target.value)} /></label>;
  }
  return null;
}

function actionPayload(action: RunGuidanceAction, inputs: ActionInputValues): Pick<ExecuteRunActionRequest, "payload"> | Record<string, never> {
  if (action.eventType === "ARTIFACT_SUBMITTED") return { payload: { artifactPath: inputs.artifactPath.trim(), artifactType: inputs.artifactType.trim() } };
  if (["HUMAN_APPROVED", "HUMAN_REJECTED", "HUMAN_DEFERRED"].includes(action.eventType)) return inputs.comment.trim() ? { payload: { comment: inputs.comment.trim() } } : {};
  if (action.eventType === "GATE_PASSED") return { payload: { evidenceUri: inputs.evidenceUri.trim() } };
  if (action.eventType === "GATE_FAILED") return { payload: { evidenceUri: inputs.evidenceUri.trim() } };
  if (action.eventType === "GATE_WAIVED") return { payload: { waiverReason: inputs.waiverReason.trim() } };
  return {};
}

function actionInputsReady(
  action: RunGuidanceAction,
  inputs: ActionInputValues,
): boolean {
  if (action.eventType === "ARTIFACT_SUBMITTED") return Boolean(inputs.artifactPath.trim() && inputs.artifactType.trim());
  if (["GATE_PASSED", "GATE_FAILED"].includes(action.eventType)) return Boolean(inputs.evidenceUri.trim());
  if (action.eventType === "GATE_WAIVED") return Boolean(inputs.waiverReason.trim());
  return true;
}

function formatRequirement(requirement: WorkflowNode["requires"] extends Array<infer Item> | undefined ? Item : never): string {
  if (requirement.type === "artifact") return `产物 ${requirement.artifactType}`;
  if (requirement.type === "approval") return `审批 ${requirement.approvalRole ?? "required"}`;
  if (requirement.type === "gate") return `检查关卡 ${requirement.gateId}`;
  return `证据 ${requirement.evidenceType}`;
}

function formatTime(value: string | null): string {
  if (!value) return "暂无";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function statusLabel(status: RunOverview["projection"]["status"]): string {
  return {
    CREATED: "已创建",
    IN_PROGRESS: "运行中",
    REVIEWING: "审核中",
    BLOCKED: "已阻塞",
    PAUSED: "已暂停",
    DONE: "已完成",
    ARCHIVED: "已归档",
  }[status];
}

function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 8)}…` : runId;
}

function toRuntimeClientError(error: unknown): RuntimeClientError {
  if (error instanceof RuntimeClientError) return error;
  return new RuntimeClientError(null, "NETWORK_ERROR", error instanceof Error ? error.message : "Runtime 请求失败", undefined, null);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
