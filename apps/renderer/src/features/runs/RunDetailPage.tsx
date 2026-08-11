import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ArrowLeft, Play, RefreshCw, BookOpen } from "lucide-react";

import type {
  Actor,
  ExecuteRunActionRequest,
  ExecuteRunActionResponse,
  RunOverview,
  WorkflowNode,
} from "@workflow-platform/contracts";
import {
  RuntimeClientError,
  type AgentJobSummary,
  type AgentOutputSummary,
  type AgentProviderDiagnostic,
  type ModelProviderRecord,
  type NodeArtifactScan,
} from "../../app/runtimeClient";
import { buildRunModuleHash } from "../../app/routes";
import type { TerminalViewportOutput } from "../terminal/TerminalViewport";
import type { AgentPermissionRequest } from "@workflow-platform/contracts";
import { RunAgentExecutor, type RunAgentSessionState } from "./RunAgentExecutor";
import {
  RunArtifactScanFeedback,
  type ArtifactScanFeedbackState,
} from "./RunArtifactScanFeedback";
import {
  clearRunArtifactScan,
  loadRunArtifactScan,
  saveRunArtifactScan,
} from "./runArtifactScanStorage";
import {
  loadRunWorkflowSnapshot,
  saveRunWorkflowSnapshot,
} from "./runWorkflowSnapshotStorage";
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
  gateActor: Actor;
  loadOverview(signal: AbortSignal): Promise<RunOverview>;
  agentJobs: AgentJobSummary[];
  agentOutput: AgentOutputSummary[];
  agentLiveOutput: Record<string, TerminalViewportOutput[]>;
  agentSessionState: Record<string, RunAgentSessionState>;
  providerDiagnostics?: AgentProviderDiagnostic[];
  modelProviders?: ModelProviderRecord[] | null;
  activeModelProviderId?: string | null;
  onStartAgent?(request: RunAgentStartRequest): Promise<AgentJobSummary>;
  onStartDeployment?(nodeId: string, expectedRevision: string): Promise<void>;
  onAgentInput(jobId: string, data: string): Promise<void> | void;
  onAgentInterrupt(jobId: string): Promise<void> | void;
  onAgentResize(jobId: string, columns: number, rows: number): Promise<void> | void;
  onStopAgent(jobId: string): Promise<void> | void;
  agentPermissions?: Record<string, AgentPermissionRequest[]>;
  onContinueAgent?(jobId: string, message: string): Promise<void> | void;
  onDecideAgentPermission?(jobId: string, requestId: string, decision: "allow" | "deny", reason?: string): Promise<void> | void;
  scanNodeArtifacts?(nodeId: string, expectedRevision: string, now: string, signal: AbortSignal): Promise<NodeArtifactScan>;
  executeAction(
    request: ExecuteRunActionRequest,
    signal: AbortSignal,
  ): Promise<ExecuteRunActionResponse>;
  onReturnToList(): void;
};

export type RunAgentStartRequest = {
  nodeId: string;
  provider: AgentJobSummary["provider"];
  prompt: string;
  mode: "interactive" | "automatic";
  allowedTools: string[];
  cwd: string;
  transport?: "auto" | "cli" | "acp" | "direct" | "app-server";
  conversational?: boolean;
  modelProviderId?: string | null;
};

export function RunDetailPage(props: RunDetailPageProps) {
  return <RunDetailPageContent key={`${props.projectId}:${props.runId}`} {...props} />;
}

function RunDetailPageContent({
  projectId,
  runId,
  projectName,
  actor,
  gateActor,
  loadOverview,
  agentJobs,
  agentOutput,
  agentLiveOutput,
  agentSessionState,
  providerDiagnostics,
  modelProviders,
  activeModelProviderId,
  onStartAgent,
  onStartDeployment,
  onAgentInput,
  onAgentInterrupt,
  onAgentResize,
  onStopAgent,
  agentPermissions,
  onContinueAgent,
  onDecideAgentPermission,
  scanNodeArtifacts,
  executeAction,
  onReturnToList,
}: RunDetailPageProps) {
  const [state, dispatch] = useReducer(runDetailReducer, undefined, createRunDetailState);
  const [actionInputsById, setActionInputsById] = useState<Record<string, ActionInputValues>>({});
  const [transitionNotice, setTransitionNotice] = useState<string | null>(null);
  const [artifactScanFeedback, setArtifactScanFeedback] = useState<ArtifactScanFeedbackState>(() => {
    const result = loadRunArtifactScan(projectId, runId);
    return result ? { phase: "success", nodeId: result.nodeId, result } : { phase: "idle" };
  });
  const [forcedReadOnly, setForcedReadOnly] = useState(false);
  const [selectedAgentJobId, setSelectedAgentJobId] = useState<string | null>(null);
  const [agentProvider, setAgentProvider] = useState<AgentJobSummary["provider"]>("codex");
  const [agentMode, setAgentMode] = useState<"interactive" | "automatic">("interactive");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentTransport, setAgentTransport] = useState<"auto" | "cli" | "acp" | "direct" | "app-server">("auto");
  const [agentConversational, setAgentConversational] = useState(false);
  const [agentModelProviderId, setAgentModelProviderId] = useState<string | null>(null);
  const [agentLaunchError, setAgentLaunchError] = useState<string | null>(null);
  const [agentLaunching, setAgentLaunching] = useState(false);
  const [deploymentStarting, setDeploymentStarting] = useState(false);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const hasWorkflowSnapshot = isWorkflowSnapshot(state.overview?.workflow);

  const selectedAgentNode = state.overview && hasWorkflowSnapshot
    ? state.overview.workflow.nodes.find(
      (node) => node.id === (state.selectedNodeId ?? state.overview?.projection.currentNodeIds[0]),
    ) ?? null
    : null;
  const selectedAgentRoleId = selectedAgentNode?.agent?.roleId ?? selectedAgentNode?.role;
  const selectedAgentRole = hasWorkflowSnapshot
    ? state.overview?.workflow.roles.find((role) => role.id === selectedAgentRoleId)
    : undefined;

  useEffect(() => {
    setAgentPrompt("");
    setAgentLaunchError(null);
    if (selectedAgentRole?.provider) setAgentProvider(selectedAgentRole.provider);
  }, [selectedAgentNode?.id, selectedAgentRole?.provider]);

  useEffect(() => {
    // ??????????????? Provider????????
    if (agentTransport === "direct" && agentProvider !== "direct") {
      setAgentProvider("direct");
      return;
    }
    if (agentTransport === "app-server" && agentProvider !== "codex") {
      setAgentProvider("codex");
      return;
    }
    if (agentProvider === "direct") {
      setAgentMode("automatic");
      setAgentConversational(true);
      setAgentTransport("direct");
      const available = modelProviders ?? [];
      const active = activeModelProviderId && available.some((candidate) => candidate.id === activeModelProviderId)
        ? activeModelProviderId
        : available[0]?.id ?? null;
      setAgentModelProviderId((current) => current ?? active);
      return;
    }
    setAgentModelProviderId(null);
    if (agentTransport === "direct") {
      setAgentTransport("auto");
    }
  }, [agentProvider, agentTransport, modelProviders, activeModelProviderId]);

  const startAgent = useCallback(async () => {
    if (!state.overview || !selectedAgentNode || !onStartAgent || !agentPrompt.trim()) return;
    setAgentLaunching(true);
    setAgentLaunchError(null);
    try {
      const job = await onStartAgent({
        nodeId: selectedAgentNode.id,
        provider: agentProvider,
        prompt: agentPrompt.trim(),
        mode: agentMode,
        allowedTools: selectedAgentRole?.allowedTools ?? [],
        cwd: state.overview.workspace?.workspacePath ?? state.overview.run.executionWorkspace,
        transport: agentProvider === "direct" ? "direct" : agentTransport,
        conversational: agentProvider === "direct" ? true : agentConversational,
        modelProviderId: agentProvider === "direct" ? agentModelProviderId : null,
      });
      if (mountedRef.current) setSelectedAgentJobId(job.id);
    } catch (error) {
      if (mountedRef.current) {
        setAgentLaunchError(error instanceof Error ? error.message : "Agent 启动失败");
      }
    } finally {
      if (mountedRef.current) setAgentLaunching(false);
    }
  }, [agentMode, agentPrompt, agentProvider, onStartAgent, selectedAgentNode, selectedAgentRole?.allowedTools, state.overview]);

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
        const workflow = isWorkflowSnapshot(overview.workflow)
          ? overview.workflow
          : loadRunWorkflowSnapshot(projectId, runId);
        const normalizedOverview = workflow && !isWorkflowSnapshot(overview.workflow)
          ? { ...overview, workflow }
          : overview;
        if (isWorkflowSnapshot(normalizedOverview.workflow)) {
          saveRunWorkflowSnapshot(projectId, runId, normalizedOverview.workflow);
        }
        dispatch({
          type: "request-succeeded",
          kind,
          generation,
          overview: normalizedOverview,
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
  }, [loadOverview, projectId, runId]);

  const startDeployment = useCallback(async (nodeId: string) => {
    if (!state.overview || !onStartDeployment || deploymentStarting) return;
    setDeploymentStarting(true);
    setDeploymentError(null);
    try {
      await onStartDeployment(nodeId, state.overview.projection.revision);
      if (mountedRef.current) {
        setTransitionNotice("本地部署已启动，状态将自动刷新。");
        performLoad("refresh");
      }
    } catch (error) {
      if (mountedRef.current) {
        setDeploymentError(error instanceof Error ? error.message : "本地部署启动失败");
      }
    } finally {
      if (mountedRef.current) setDeploymentStarting(false);
    }
  }, [deploymentStarting, onStartDeployment, performLoad, state.overview]);

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

  useEffect(() => {
    if (state.overview || state.phase !== "error") return;
    const timeout = window.setTimeout(() => {
      if (document.visibilityState === "visible") performLoad("initial");
    }, 2_000);
    return () => window.clearTimeout(timeout);
  }, [performLoad, state.error, state.overview, state.phase]);

  const runAction = useCallback((action: RunGuidanceAction) => {
    if (!state.overview || busyRef.current) return;
    const inputs = actionInputsById[action.id] ?? EMPTY_ACTION_INPUTS;
    const selectedActionNode = action.nodeId
      ? state.overview.workflow.nodes.find((candidate) => candidate.id === action.nodeId) ?? null
      : null;
    const declaredOutput = selectedActionNode?.artifacts?.outputs?.[0];
    const effectiveInputs = {
      ...inputs,
      artifactPath: inputs.artifactPath || declaredOutput?.path || "",
      artifactType: inputs.artifactType || declaredOutput?.type || "",
    };
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
      actor: isGateAction(action) ? gateActor : actor,
      ...actionPayload(action, effectiveInputs),
    };

    const artifactScanNodeId = action.eventType === "ARTIFACT_SUBMITTED" && action.nodeId && scanNodeArtifacts
      ? action.nodeId
      : null;
    if (artifactScanNodeId) {
      setArtifactScanFeedback({ phase: "scanning", nodeId: artifactScanNodeId });
    }

    const actionRequest = artifactScanNodeId && scanNodeArtifacts
      ? scanNodeArtifacts(artifactScanNodeId, state.overview.projection.revision, new Date().toISOString(), controller.signal)
        .then((result) => {
          if (mountedRef.current) {
            saveRunArtifactScan(projectId, runId, result);
            setArtifactScanFeedback({ phase: "success", nodeId: artifactScanNodeId, result });
          }
          return { projection: result.projection } as ExecuteRunActionResponse;
        })
      : executeAction(request, controller.signal);

    void actionRequest
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
        if (artifactScanNodeId) {
          setArtifactScanFeedback({ phase: "error", nodeId: artifactScanNodeId, message: runtimeError.message });
        }
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
  }, [actionInputsById, actor, executeAction, gateActor, performLoad, scanNodeArtifacts, state.overview]);

  const returnLink = (
    <a
      href="#/runs"
      className="quiet-link"
      onClick={(event) => {
        event.preventDefault();
        onReturnToList();
      }}
    >
      <ArrowLeft size={14} aria-hidden="true" />
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

  if (!hasWorkflowSnapshot) {
    return (
      <section className="page-runs run-detail-page">
        <p className="run-detail-state" role="status">工作流加载中，请稍候...</p>
        <button type="button" className="quiet-button" onClick={() => performLoad("refresh")}>重新加载</button>
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
  const canCompleteSelectedNode = authorizedActions.some(
    (action) => action.eventType === "NODE_COMPLETED" && action.nodeId === selectedNodeId,
  );
  const artifactScanAllowsCompletion = artifactScanFeedback.phase === "success"
    && artifactScanFeedback.nodeId === selectedNodeId
    && artifactScanFeedback.result.missing.length === 0
    && artifactScanFeedback.result.invalid.length === 0
    && canCompleteSelectedNode;
  const runContext = { projectId, runId };
  const availableProviderDiagnostics = providerDiagnostics ?? DEFAULT_PROVIDER_DIAGNOSTICS;
  const selectedProviderDiagnostic = availableProviderDiagnostics.find((diagnostic) => diagnostic.id === agentProvider);
  const providerAvailable = selectedProviderDiagnostic?.available === true;
  const showAgentLaunch = selectedNode?.kind === "agent" && projection.nodeStates[selectedNode.id] === "RUNNING";
  const agentReadOnly = forcedReadOnly || projection.status === "ARCHIVED" || run.status === "ARCHIVED";

  return (
    <section className="page-runs run-detail-page" aria-label={`Run 详情：${run.title}`}>
      <header className="run-console-toolbar">
        <div className="run-console-identity">
          {returnLink}
          <div>
            <p className="eyebrow">{projectName} · {workflow.name} v{workflow.version}</p>
            <h2>{run.title}</h2>
            <p className="run-detail-identity"><code title={run.id}>{shortRunId(run.id)}</code> · {statusLabel(projection.status)} · 修订 {projection.revision}</p>
          </div>
        </div>
        <div className="run-console-toolbar-actions">
          <span>最近刷新 {formatTime(state.lastRefreshedAt)}</span>
          <a
            className="quiet-button icon-text-button"
            href={`#/knowledge/change-sets/new?projectId=${encodeURIComponent(projectId)}&runId=${encodeURIComponent(runId)}`}
          >
            <BookOpen size={15} aria-hidden="true" />
            创建知识变更集
          </a>
          <button
            type="button"
            className="quiet-button icon-text-button"
            disabled={state.phase === "refreshing" || state.phase === "acting"}
            onClick={() => performLoad("refresh")}
          >
            <RefreshCw size={15} aria-hidden="true" />
            刷新
          </button>
        </div>
      </header>

      {state.error ? <ErrorNotice error={state.error} /> : null}
      {transitionNotice ? <div className="run-detail-notice" role="status">{transitionNotice}</div> : null}

      <section className="run-console-status-strip" aria-label="Run 概览">
        <div><span>工作区</span><strong>{overview.workspace?.workspacePath ?? run.executionWorkspace}</strong><small>{run.workspaceMode === "write" ? "可写" : "只读"} · 租约 {overview.workspace?.status ?? "无"}</small></div>
        <div><span>当前节点</span><strong>{selectedNode?.name ?? "无当前节点"}</strong><small>{selectedNodeId ? projection.nodeStates[selectedNodeId] : "IDLE"} · {selectedNode?.kind ?? "-"}</small></div>
        <div><span>执行活动</span><strong>{overview.activity.activeAgentCount} 个 Agent</strong><small>{overview.activity.activeDeploymentCount} 个活跃部署</small></div>
        <div><span>最近事件</span><strong>{formatTime(overview.activity.lastEventAt)}</strong><small>{projection.blockingReasons.length} 项阻塞信息</small></div>
      </section>

      <section className="run-console-main" aria-label="运行进度与控制">
        <div className="run-console-workspace">
          <div className="run-console-graph">
            <div className="run-console-section-heading">
              <div><p className="eyebrow">Workflow</p><h3>运行进度</h3></div>
              <span>{workflow.nodes.length} 个节点</span>
            </div>
            <RunProgressMap
              workflow={workflow}
              projection={projection}
              selectedNodeId={selectedNodeId}
              onSelectNode={(nodeId) => {
                if (nodeId !== selectedNode?.id) {
                  clearRunArtifactScan(projectId, runId);
                  setArtifactScanFeedback({ phase: "idle" });
                }
                dispatch({ type: "node-selected", nodeId });
              }}
            />
          </div>
          <RunAgentExecutor
            runId={runId}
            jobs={agentJobs}
            persistedOutput={agentOutput}
            liveOutputByJob={agentLiveOutput}
            sessionStateByJob={agentSessionState}
            selectedJobId={selectedAgentJobId}
            onSelectJob={setSelectedAgentJobId}
            onInput={onAgentInput}
            onInterrupt={onAgentInterrupt}
            onResize={onAgentResize}
            onStop={onStopAgent}
            permissionsByJob={agentPermissions}
            onContinueConversation={onContinueAgent}
            onDecidePermission={onDecideAgentPermission}
            showFullScreenLink
          />
        </div>

        <section className="run-console-control" aria-label="当前节点控制">
          <CurrentNodeSection node={selectedNode} run={run} overview={overview} blockers={blockers} />
          <section className="run-detail-actions" aria-label="Runtime 授权操作">
            <div className="run-console-section-heading">
              <div><p className="eyebrow">Runtime</p><h3>授权操作</h3></div>
                <span>{authorizedActions.length} 项可用</span>
            </div>
            {artifactScanFeedback.phase !== "idle" && artifactScanFeedback.nodeId === selectedNodeId ? (
              <RunArtifactScanFeedback
                state={artifactScanFeedback}
                nodeName={selectedNode?.name ?? selectedNodeId ?? "当前节点"}
                canComplete={canCompleteSelectedNode}
                blockers={blockers}
                artifactsHref={buildRunModuleHash("artifacts", runContext)}
              />
            ) : null}
            {authorizedActions.length === 0 ? (
              <p className="run-next-action-message">{guidance.waitingMessage ?? "当前没有可执行操作。"}</p>
            ) : (
              <div className="run-detail-action-list">
                {authorizedActions.map((action) => {
                  const inputs = actionInputsById[action.id] ?? EMPTY_ACTION_INPUTS;
                  const node = action.nodeId ? workflow.nodes.find((candidate) => candidate.id === action.nodeId) : null;
                  const targetLabel = node?.name ?? action.nodeId ?? run.title;
                  const hasDuplicateType = authorizedActions.some((candidate) => candidate.id !== action.id && candidate.eventType === action.eventType);
                  const displayLabel = hasDuplicateType ? `${action.allowedAction.label} · ${targetLabel}` : action.label;
                  const declaredArtifactReady = action.eventType === "ARTIFACT_SUBMITTED"
                    && Boolean(scanNodeArtifacts && node?.artifacts?.outputs?.length);
                  const disabled = state.phase !== "ready"
                    || (!declaredArtifactReady && !actionInputsReady(action, inputs, null));
                  const completionReady = artifactScanAllowsCompletion
                    && action.eventType === "NODE_COMPLETED"
                    && action.nodeId === selectedNodeId;
                  const deploymentStart = action.eventType === "NODE_STARTED"
                    && node?.kind === "deploy"
                    && Boolean(onStartDeployment);
                  const actionButtonLabel = deploymentStart ? "启动本地部署" : displayLabel;
                  const setInput = (field: keyof ActionInputValues, value: string) => {
                    setActionInputsById((current) => ({ ...current, [action.id]: { ...(current[action.id] ?? EMPTY_ACTION_INPUTS), [field]: value } }));
                  };
                  return <div className="run-detail-action" key={action.id} role="group" aria-label={displayLabel}>
                    <div><strong>{displayLabel}</strong><p>{action.result}</p></div>
                  {renderActionInputs(action, { ...inputs, setInput }, node ?? null, Boolean(scanNodeArtifacts))}
                    {action.risk === "low" ? (
                      <button type="button" className={`run-next-action-primary-button${completionReady ? " is-next-ready" : ""}`} disabled={disabled || (deploymentStart && deploymentStarting)} onClick={() => deploymentStart ? void startDeployment(action.nodeId!) : runAction(action)}>{actionButtonLabel}</button>
                    ) : (
                      <details className="run-detail-confirmation">
                        <summary>{displayLabel}</summary>
                        <p>此操作风险为{action.risk === "high" ? "高" : "中"}，请确认后执行。</p>
                        <button type="button" className={`run-next-action-primary-button${completionReady ? " is-next-ready" : ""}`} disabled={disabled} onClick={() => runAction(action)}>确认执行 {displayLabel}</button>
                      </details>
                    )}
                  </div>;
                })}
              </div>
            )}
            {deploymentError ? <p className="run-next-action-message" role="status">本地部署启动失败：{deploymentError}</p> : null}
          </section>

          {showAgentLaunch ? (
            <section className="run-agent-command" aria-label="Agent 执行">
              <div className="run-console-section-heading">
                <div><p className="eyebrow">Agent</p><h3>Agent 执行</h3></div>
                {agentLaunching ? <span>正在启动...</span> : null}
              </div>
              <div className="run-agent-controls">
                <label className="run-agent-provider">Agent Provider<select value={agentProvider} onChange={(event) => {
                  const value = event.target.value as AgentJobSummary["provider"];
                  setAgentProvider(value);
                  if (value !== "direct") {
                    if (agentTransport === "direct") setAgentTransport("auto");
                    setAgentConversational(false);
                  }
                }} disabled={agentReadOnly || agentLaunching}>{availableProviderDiagnostics.map((diagnostic) => <option key={diagnostic.id} value={diagnostic.id} disabled={!diagnostic.available}>{providerLabel(diagnostic.id)}{diagnostic.available ? "" : "（不可用）"}</option>)}</select></label>
                <fieldset className="run-agent-mode" role="radiogroup">
                  <legend>Agent 模式</legend>
                  <div>
                    {agentProvider === "direct" ? (
                      <span className="run-agent-mode-note">聊天模式（模型直连，多轮对话）</span>
                    ) : (
                      <>
                        <label><input type="radio" name="agent-mode" value="interactive" checked={agentMode === "interactive"} onChange={() => setAgentMode("interactive")} disabled={agentReadOnly || agentLaunching} /><span>交互式终端</span></label>
                        <label><input type="radio" name="agent-mode" value="automatic" checked={agentMode === "automatic"} onChange={() => setAgentMode("automatic")} disabled={agentReadOnly || agentLaunching} /><span>自动执行</span></label>
                      </>
                    )}
                  </div>
                </fieldset>
                <label className="run-agent-transport">Agent 传输<select value={agentTransport} onChange={(event) => setAgentTransport(event.target.value as "auto" | "cli" | "acp" | "direct" | "app-server")} disabled={agentReadOnly || agentLaunching || agentProvider === "direct"}><option value="auto">自动</option><option value="cli">CLI（legacy）</option><option value="acp">ACP</option><option value="direct">模型直连</option></select></label>
                <label className="run-agent-conversational"><input type="checkbox" checked={agentConversational} onChange={(event) => { setAgentConversational(event.target.checked); if (event.target.checked) setAgentTransport(agentProvider === "codex" ? "app-server" : "acp"); }} disabled={agentReadOnly || agentLaunching || agentMode !== "automatic" || agentProvider === "direct"} /><span>{agentProvider === "direct" ? "聊天模式（模型直连自动开启）" : agentProvider === "codex" ? "聊天模式（多轮 + 命令执行 + 审批）" : "聊天模式（多轮，需 ACP）"}</span></label>

                {agentProvider === "direct" ? (
                  <label className="run-agent-model-service">模型服务<select value={agentModelProviderId ?? ""} onChange={(event) => setAgentModelProviderId(event.target.value || null)} disabled={agentReadOnly || agentLaunching || !modelProviders?.length}><option value="">默认服务</option>{modelProviders?.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}{provider.isDefault ? "（默认）" : ""}</option>)}</select></label>
                ) : null}
                <label className="run-agent-prompt">Agent 提示词<textarea value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} disabled={agentReadOnly || agentLaunching} /></label>
                <button type="button" className="run-agent-start" disabled={agentReadOnly || agentLaunching || !onStartAgent || !agentPrompt.trim() || !providerAvailable} onClick={() => void startAgent()}>
                  <Play size={15} aria-hidden="true" />
                  {agentLaunching ? "正在启动" : "启动 Agent"}
                </button>
              </div>
              <dl className="run-agent-meta">
                <div><dt>工作区</dt><dd>{overview.workspace?.workspacePath ?? run.executionWorkspace}</dd></div>
                <div><dt>角色</dt><dd>{selectedAgentRole?.name ?? selectedAgentRoleId ?? "未指定"}</dd></div>
                <div><dt>允许工具</dt><dd>{selectedAgentRole?.allowedTools?.join(", ") || "未限制"}</dd></div>
                <div><dt>Provider</dt><dd>{providerLabel(agentProvider)} {providerAvailable ? "可用" : "不可用"}</dd></div>
              </dl>
              {agentLaunchError ? <p className="run-next-action-message" role="status">Agent 启动失败：{agentLaunchError}</p> : null}
            </section>
          ) : null}

          <SuccessorSection successors={successors} status={projection.status} blockerCount={blockers.length} actionCount={authorizedActions.length} />
        </section>
      </section>

      <nav className="run-console-resources" aria-label="Run 资源">
        <div className="run-console-tabs" role="tablist" aria-label="Run 资源视图">
          <button type="button" role="tab" aria-selected="true">上下文</button>
          <a href={buildRunModuleHash("artifacts", runContext)}>产物</a>
          <a href={buildRunModuleHash("gates", runContext)}>检查关卡</a>
          <a href={buildRunModuleHash("approvals", runContext)}>审批</a>
          <a href={buildRunModuleHash("deployment", runContext)}>部署</a>
          <a href={buildRunModuleHash("audit", runContext)}>审计</a>
          <a href={buildRunModuleHash("recovery", runContext)}>恢复</a>
        </div>
        <section className="run-console-context" role="tabpanel" aria-label="上下文">
          <dl className="facts">
            <div><dt>任务目标</dt><dd>{run.context.taskGoal ?? "未设置"}</dd></div>
            <div><dt>创建时间</dt><dd>{formatTime(run.createdAt)}</dd></div>
            <div><dt>工作区租约</dt><dd>{overview.workspace?.status ?? "无"}</dd></div>
            <div><dt>执行活动</dt><dd>{overview.activity.activeAgentCount} 个 Agent · {overview.activity.activeDeploymentCount} 个部署</dd></div>
          </dl>
          <pre className="code-block">{JSON.stringify(run.context.parameters ?? {}, null, 2)}</pre>
        </section>
      </nav>
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

const DEFAULT_PROVIDER_DIAGNOSTICS: AgentProviderDiagnostic[] = [
  { id: "codex", executable: "codex", available: true, path: null, version: null, message: "未检测" },
  { id: "claude", executable: "claude", available: true, path: null, version: null, message: "未检测" },
  { id: "fake", executable: "fake", available: true, path: null, version: null, message: "演示用假执行器" },
  { id: "direct", executable: "direct", available: false, path: null, version: null, message: "未配置模型厂商（设置页填写）" },
];

function providerLabel(provider: AgentJobSummary["provider"]): string {
  if (provider === "codex") return "Codex CLI";
  if (provider === "claude") return "Claude Code";
  if (provider === "opencode") return "OpenCode";
  if (provider === "direct") return "模型直连（OpenAI 兼容）";
  return "Fake（演示）";
}

function renderActionInputs(
  action: RunGuidanceAction,
  inputs: ActionInputState,
  node: WorkflowNode | null,
  useDeclaredOutput: boolean,
) {
  if (action.eventType === "ARTIFACT_SUBMITTED") {
    const declaredOutput = useDeclaredOutput ? node?.artifacts?.outputs?.[0] : undefined;
    return <div className="run-action-input-grid"><label>产物路径<input value={inputs.artifactPath || declaredOutput?.path || ""} onChange={(event) => inputs.setInput("artifactPath", event.target.value)} /></label><label>产物类型<input value={inputs.artifactType || declaredOutput?.type || ""} onChange={(event) => inputs.setInput("artifactType", event.target.value)} /></label></div>;
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

function isGateAction(action: RunGuidanceAction): boolean {
  return ["GATE_PASSED", "GATE_FAILED", "GATE_WAIVED"].includes(action.eventType);
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
  node: WorkflowNode | null = null,
): boolean {
  if (action.eventType === "ARTIFACT_SUBMITTED") {
    const declaredOutput = node?.artifacts?.outputs?.[0];
    return Boolean((inputs.artifactPath.trim() || declaredOutput?.path) && (inputs.artifactType.trim() || declaredOutput?.type));
  }
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

function isWorkflowSnapshot(value: unknown): value is RunOverview["workflow"] {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as { nodes?: unknown; edges?: unknown };
  return Array.isArray(snapshot.nodes) && Array.isArray(snapshot.edges);
}
