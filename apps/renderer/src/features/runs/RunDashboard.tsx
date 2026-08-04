import { useEffect, useState } from "react";

import type {
  AgentJobSummary,
  AgentProviderDiagnostic,
  DeploymentOutputEvent,
  DeploymentSummary,
  RunSummary,
  RunConfiguration,
  RuntimeWorkbenchState,
  NodeArtifactRequirements,
  NodeContextPreview,
  ProjectWorkflowBinding,
  WorkflowDefinitionSummary,
} from "../../app/runtimeClient";
import { TerminalViewport, type TerminalViewportOutput } from "../terminal/TerminalViewport";

export type AgentWorkspaceOption = {
  path: string;
  label: string;
};

type Props = {
  state: RuntimeWorkbenchState | null;
  workflow?: WorkflowDefinitionSummary | null;
  runs?: RunSummary[];
  activeRunId?: string | null;
  onSelectRun?: (runId: string) => void;
  onCreateRun?: (title: string, configuration: RunConfiguration) => void;
  onStartNode?: (nodeId: string) => void;
  onCompleteNode?: (nodeId: string) => void;
  onScanNodeArtifacts?: (nodeId: string) => void;
  onLoadNodeArtifactRequirements?: (nodeId: string) => Promise<NodeArtifactRequirements>;
  onLoadNodeContext?: (nodeId: string) => Promise<NodeContextPreview>;
  onSubmitArtifact?: (nodeId: string, artifactPath: string, artifactType: string) => void;
  onApprove?: (nodeId: string) => void;
  onPassGate?: (nodeId: string, artifactPath: string) => void;
  onWaiveGate?: (nodeId: string, waiverReason: string) => void;
  onPauseRun?: () => void;
  onResumeRun?: () => void;
  onArchiveRun?: () => void;
  onStartAgent?: (
    nodeId: string,
    provider: AgentJobSummary["provider"],
    prompt: string,
    mode: "interactive" | "automatic",
    allowedTools: string[],
    cwd?: string,
  ) => void;
  agentWorkspaces?: AgentWorkspaceOption[];
  onCancelAgent?: (jobId: string) => void;
  onAgentTerminalInput?: (jobId: string, data: string) => void;
  onAgentTerminalResize?: (jobId: string, columns: number, rows: number) => void;
  liveAgentOutput?: Record<string, TerminalViewportOutput[]>;
  deployments?: DeploymentSummary[];
  deploymentOutput?: DeploymentOutputEvent[];
  onStartDeployment?: (nodeId: string) => void;
  onCancelDeployment?: (deploymentId: string) => void;
  operationMessage?: string;
  providerDiagnostics?: AgentProviderDiagnostic[];
  workflowBinding?: ProjectWorkflowBinding | null;
};

export function RunDashboard({
  state,
  workflow = null,
  runs = [],
  activeRunId = null,
  onSelectRun,
  onCreateRun,
  onStartNode,
  onCompleteNode,
  onScanNodeArtifacts,
  onLoadNodeArtifactRequirements,
  onLoadNodeContext,
  onSubmitArtifact,
  onApprove,
  onPassGate,
  onWaiveGate,
  onPauseRun,
  onResumeRun,
  onArchiveRun,
  onStartAgent,
  agentWorkspaces = [],
  onCancelAgent,
  onAgentTerminalInput,
  onAgentTerminalResize,
  liveAgentOutput = {},
  deployments = [],
  deploymentOutput = [],
  onStartDeployment,
  onCancelDeployment,
  operationMessage,
  providerDiagnostics,
  workflowBinding,
}: Props) {
  const [runTitle, setRunTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [parametersText, setParametersText] = useState("{}");
  const [runConfigurationError, setRunConfigurationError] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [artifactPath, setArtifactPath] = useState("");
  const [artifactType, setArtifactType] = useState("");
  const [waiverReason, setWaiverReason] = useState("");
  const [agentProvider, setAgentProvider] = useState<AgentJobSummary["provider"]>("codex");
  const [agentMode, setAgentMode] = useState<"interactive" | "automatic">("interactive");
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentWorkspacePath, setAgentWorkspacePath] = useState("");
  const [runWorkspacePath, setRunWorkspacePath] = useState("");
  const [artifactRequirements, setArtifactRequirements] = useState<NodeArtifactRequirements | null>(null);
  const [nodeContext, setNodeContext] = useState<NodeContextPreview | null>(null);
  const projection = state?.projection;
  const workspaceReady = state?.workspaceStatus === "ready";
  const projectWorkflowUnbound = workflowBinding === null;
  const agentJobs = Array.isArray(state?.agentJobs) ? state.agentJobs : [];
  const agentOutput = Array.isArray(state?.agentOutput) ? state.agentOutput : [];
  const activeInteractiveAgent = [...agentJobs]
    .reverse()
    .find((job) => job.mode === "interactive" && (job.status === "QUEUED" || job.status === "RUNNING"));
  const latestAgentJob = activeInteractiveAgent ?? [...agentJobs].reverse()[0] ?? null;
  const agentTerminalOutput = latestAgentJob
    ? (activeInteractiveAgent && liveAgentOutput[latestAgentJob.id]
      ? liveAgentOutput[latestAgentJob.id]
      : agentOutput
        .filter((event) => event.jobId === latestAgentJob.id)
        .sort((left, right) => left.sequence - right.sequence)
        .map((event): TerminalViewportOutput => ({ sequence: event.sequence, data: formatAgentPayload(event.payload) })))
    : [];
  const selectedProviderDiagnostic = providerDiagnostics?.find(
    (diagnostic) => diagnostic.id === agentProvider,
  );
  const providerAvailable =
    providerDiagnostics === undefined || selectedProviderDiagnostic?.available === true;
  const availableNodeIds = Object.keys(projection?.nodeStates ?? {});
  const currentNodeId = availableNodeIds.includes(nodeId)
    ? nodeId
    : projection?.currentNodeIds[0] ?? availableNodeIds[0] ?? null;
  const selectedWorkflowNode = workflow?.nodes?.find((node) => node.id === currentNodeId);
  const selectedRole = selectedWorkflowNode?.agent?.roleId
    ? workflow?.roles?.find((role) => role.id === selectedWorkflowNode.agent?.roleId)
    : undefined;
  const roleAllowedTools = selectedRole?.allowedTools ?? [];

  useEffect(() => {
    if (selectedRole?.provider) {
      setAgentProvider(selectedRole.provider);
    }
  }, [currentNodeId, selectedRole?.id, selectedRole?.provider]);

  useEffect(() => {
    if (agentWorkspaces.some((workspace) => workspace.path === agentWorkspacePath)) {
      return;
    }
    const nonRootWorkspace = agentWorkspaces.length === 2 ? agentWorkspaces[1] : undefined;
    setAgentWorkspacePath(nonRootWorkspace?.path ?? agentWorkspaces[0]?.path ?? "");
  }, [agentWorkspacePath, agentWorkspaces]);

  useEffect(() => {
    if (agentWorkspaces.some((workspace) => workspace.path === runWorkspacePath)) {
      return;
    }
    const nonRootWorkspace = agentWorkspaces.length === 2 ? agentWorkspaces[1] : undefined;
    setRunWorkspacePath(nonRootWorkspace?.path ?? agentWorkspaces[0]?.path ?? "");
  }, [agentWorkspaces, runWorkspacePath]);

  useEffect(() => {
    const nextCurrentNodeId = projection?.currentNodeIds[0] ?? "";
    const selectedNodeState = nodeId ? projection?.nodeStates[nodeId] : undefined;
    if (
      nextCurrentNodeId &&
      (!nodeId || selectedNodeState === "PASSED" || selectedNodeState === "FAILED" || selectedNodeState === "SKIPPED")
    ) {
      setNodeId(nextCurrentNodeId);
    }
  }, [nodeId, projection?.currentNodeIds, projection?.nodeStates]);
  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;
  const nodeState = currentNodeId ? projection?.nodeStates[currentNodeId] : undefined;
  const blockingReason = projection?.blockingReasons[0];
  const declaredArtifactRequirements = Array.isArray(artifactRequirements?.requirements)
    ? artifactRequirements.requirements
    : [];
  const gateEvidenceUri = declaredArtifactRequirements
    .flatMap((requirement) => requirement.artifacts)
    .find((artifact) => artifact.status === "verified")?.uri ?? null;
  const contextArtifacts = Array.isArray(nodeContext?.artifacts) ? nodeContext.artifacts : [];
  const hasRun = Boolean(state?.connection === "connected" && projection?.runId);
  const canRunAction = (eventType: string, nodeId: string | null = currentNodeId) =>
    hasRun &&
    (projection?.allowedActions.some(
      (action) =>
        action.eventType === eventType &&
        (action.nodeId === nodeId || action.nodeId === undefined),
    ) ?? false);

  useEffect(() => {
    if (!projection?.runId || !currentNodeId || !onLoadNodeArtifactRequirements) {
      setArtifactRequirements(null);
      return;
    }
    let cancelled = false;
    void onLoadNodeArtifactRequirements(currentNodeId)
      .then((requirements) => {
        if (!cancelled) setArtifactRequirements(requirements);
      })
      .catch(() => {
        if (!cancelled) setArtifactRequirements(null);
      });
    return () => { cancelled = true; };
  }, [currentNodeId, onLoadNodeArtifactRequirements, projection?.runId]);

  useEffect(() => {
    if (!projection?.runId || !currentNodeId || !onLoadNodeContext) {
      setNodeContext(null);
      return;
    }
    let cancelled = false;
    void Promise.resolve().then(() => onLoadNodeContext(currentNodeId))
      .then((context) => { if (!cancelled) setNodeContext(context); })
      .catch(() => { if (!cancelled) setNodeContext(null); });
    return () => { cancelled = true; };
  }, [currentNodeId, onLoadNodeContext, projection?.runId]);

  useEffect(() => {
    setNodeId((selectedNodeId) => (
      availableNodeIds.includes(selectedNodeId)
        ? selectedNodeId
        : projection?.currentNodeIds[0] ?? availableNodeIds[0] ?? ""
    ));
  }, [projection?.runId, projection?.currentNodeIds, availableNodeIds.join("|")]);

  useEffect(() => {
    if (!declaredArtifactRequirements.some((requirement) => requirement.type === artifactType)) {
      setArtifactType("");
    }
  }, [artifactType, declaredArtifactRequirements]);

  function createRun() {
    try {
      const parsed = JSON.parse(parametersText || "{}");
      if (!isRecord(parsed)) {
        throw new Error("运行参数必须是 JSON 对象。");
      }
      setRunConfigurationError("");
      onCreateRun?.(runTitle.trim(), {
        taskGoal: taskGoal.trim(),
        parameters: parsed,
        executionWorkspace: runWorkspacePath || undefined,
      });
    } catch (error) {
      setRunConfigurationError(error instanceof Error ? error.message : "运行参数格式无效。");
    }
  }

  if (!workspaceReady) {
    return (
      <section id="runs" className="panel page-workspace page-runs" aria-labelledby="runs-title">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Run</p>
            <h2 id="runs-title">运行管理</h2>
          </div>
          <span className="status-pill status-watch">等待项目导入</span>
        </div>
        <p className="body-copy">请先在项目工作区导入一个项目，再创建和管理 Run。</p>
        <div className="button-row">
          <a className="quiet-button" href="#/projects">
            前往项目工作区
          </a>
        </div>
      </section>
    );
  }

  if (projectWorkflowUnbound) {
    return (
      <section id="runs" className="panel page-workspace page-runs" aria-labelledby="runs-title">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">运行</p>
            <h2 id="runs-title">运行管理</h2>
          </div>
          <span className="status-pill status-watch">等待工作流绑定</span>
        </div>
        <p className="body-copy">请先为项目选择并绑定工作流，再创建 Run。</p>
        <div className="button-row">
          <a className="quiet-button" href="#/projects">去选择工作流</a>
        </div>
      </section>
    );
  }

  if (!projection) {
    return (
      <section id="runs" className="panel page-workspace page-runs" aria-labelledby="runs-title">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">运行</p>
            <h2 id="runs-title">运行管理</h2>
          </div>
          <span className="status-pill status-watch">可以创建 Run</span>
        </div>
        <p className="body-copy">为已导入的工作流创建一个 Run，然后按运行状态执行节点和治理操作。</p>
        <label>
          Run 名称
          <input
            value={runTitle}
            onChange={(event) => setRunTitle(event.target.value)}
            placeholder="例如：修复登录流程"
          />
        </label>
        <label>
          任务目标
          <textarea
            value={taskGoal}
            onChange={(event) => setTaskGoal(event.target.value)}
            placeholder="例如：验证发布流程并生成可审计报告"
          />
        </label>
        <label>
          执行工作区
          <select aria-label="Run 执行工作区" value={runWorkspacePath} onChange={(event) => setRunWorkspacePath(event.target.value)}>
            {agentWorkspaces.map((workspace) => (
              <option key={workspace.path} value={workspace.path}>{workspace.label}</option>
            ))}
          </select>
        </label>
        <label>
          运行参数（JSON 对象）
          <textarea
            value={parametersText}
            onChange={(event) => setParametersText(event.target.value)}
            placeholder='例如：{"dryRun":true}'
          />
        </label>
        {runConfigurationError ? <p role="alert">{runConfigurationError}</p> : null}
        <div className="button-row">
          <button
            className="quiet-button"
            disabled={!runTitle.trim()}
            onClick={createRun}
          >
            创建 Run
          </button>
        </div>
      </section>
    );
  }

  return (
    <section id="runs" className="panel page-workspace page-runs" aria-labelledby="runs-title">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">运行</p>
          <h2 id="runs-title">运行管理</h2>
        </div>
        <span className="status-pill status-blocked">{projection.status}</span>
      </div>
      <p className="body-copy">所有运行操作均由 Runtime 的允许操作和版本号校验，不会在界面本地伪造状态。</p>
      <div className="form-grid">
        <label>
          切换 Run
          <select value={activeRunId ?? ""} onChange={(event) => onSelectRun?.(event.target.value)}>
            {runs.map((run) => (
              <option key={run.id} value={run.id}>
                {run.title}（{run.status}）
              </option>
            ))}
          </select>
        </label>
        <label>
          新建 Run 名称
          <input
            value={runTitle}
            onChange={(event) => setRunTitle(event.target.value)}
            placeholder="例如：并行修复登录流程"
          />
        </label>
        <label>
          任务目标
          <textarea
            value={taskGoal}
            onChange={(event) => setTaskGoal(event.target.value)}
            placeholder="例如：验证发布流程并生成可审计报告"
          />
        </label>
        <label>
          执行工作区
          <select aria-label="新建 Run 执行工作区" value={runWorkspacePath} onChange={(event) => setRunWorkspacePath(event.target.value)}>
            {agentWorkspaces.map((workspace) => (
              <option key={workspace.path} value={workspace.path}>{workspace.label}</option>
            ))}
          </select>
        </label>
        <label>
          运行参数（JSON 对象）
          <textarea
            value={parametersText}
            onChange={(event) => setParametersText(event.target.value)}
            placeholder='例如：{"dryRun":true}'
          />
        </label>
        <div className="button-row">
          <button
            className="quiet-button"
            disabled={!runTitle.trim()}
            onClick={createRun}
          >
            创建并切换 Run
          </button>
        </div>
      </div>
      {runConfigurationError ? <p role="alert">{runConfigurationError}</p> : null}
      <dl className="facts">
        <div>
          <dt>当前 Run 状态</dt>
          <dd>{projection.status}</dd>
        </div>
        <div>
          <dt>当前节点状态</dt>
          <dd>{nodeState ?? "未选择节点"}</dd>
        </div>
        <div>
          <dt>阻塞原因</dt>
          <dd>
            {blockingReason
              ? `${blockingReason.code}：${blockingReason.message}`
              : "暂无阻塞原因"}
          </dd>
        </div>
        <div>
          <dt>任务目标</dt>
          <dd>{activeRun?.context?.taskGoal || "未设置"}</dd>
        </div>
        <div>
          <dt>执行工作区</dt>
          <dd>{activeRun?.context?.executionWorkspace || "主工作区"}</dd>
        </div>
      </dl>
      <pre className="code-block" aria-label="运行参数">
        {JSON.stringify(activeRun?.context?.parameters ?? {}, null, 2)}
      </pre>
      {declaredArtifactRequirements.length ? (
        <div className="gate-record" aria-label="节点交付物要求">
          <div className="panel-heading">
            <strong>节点交付物要求</strong>
            <span className="status-pill">Runtime 已计算</span>
          </div>
          <ul className="compact-list">
            {declaredArtifactRequirements.map((requirement) => (
              <li key={requirement.id}>
                {requirement.required ? "必需" : "可选"}：{requirement.name}（{requirement.type}）
                <br />{requirement.relativePath}
                {requirement.artifacts.length ? `，已登记 ${requirement.artifacts.length} 个版本` : "，尚未登记"}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {nodeState === "AWAITING_GATE" ? (
        <p className="body-copy">
          Gate 证据：{gateEvidenceUri ?? "当前节点没有已验证交付物，无法通过 Gate。"}
        </p>
      ) : null}
      {nodeContext ? (
        <div className="gate-record" aria-label="节点上游上下文预览">
          <div className="panel-heading">
            <strong>节点上游上下文预览</strong>
            <span className="status-pill">{contextArtifacts.length} 个正式产物</span>
          </div>
          {contextArtifacts.length ? (
            <ul className="compact-list">
              {contextArtifacts.map((artifact, index) => (
                <li key={`${artifact.artifactId ?? artifact.path}-${index}`}>
                  {artifact.type}：{artifact.path}；哈希 {artifact.contentHash ?? "未记录"}
                  <pre className="code-block">{artifact.summary}</pre>
                </li>
              ))}
            </ul>
          ) : <p className="body-copy">当前节点不接收上游正式产物。</p>}
        </div>
      ) : null}
      <ul className="compact-list" aria-label="Runtime Timeline">
        {(state?.timeline ?? []).map((event) => (
          <li key={event.id}>
            {event.type}
            {event.nodeId ? `：${event.nodeId}` : ""}
          </li>
        ))}
      </ul>
      <div className="form-grid">
        <label>
          节点 ID
          <select
            value={currentNodeId ?? ""}
            onChange={(event) => setNodeId(event.target.value)}
            disabled={!availableNodeIds.length}
          >
            {!availableNodeIds.length ? <option value="">当前 Run 没有可用节点</option> : null}
            {availableNodeIds.map((availableNodeId) => (
              <option key={availableNodeId} value={availableNodeId}>{availableNodeId}</option>
            ))}
          </select>
        </label>
        <label>
          Artifact 路径
          <input
            value={artifactPath}
            onChange={(event) => setArtifactPath(event.target.value)}
            placeholder="例如 G:\Project\my-workflow\docs\plan.md"
          />
        </label>
        <label>
          Artifact 类型
          <select
            value={artifactType}
            onChange={(event) => setArtifactType(event.target.value)}
            disabled={!declaredArtifactRequirements.length}
          >
            <option value="">选择当前节点交付物</option>
            {declaredArtifactRequirements.map((requirement) => (
              <option key={requirement.id} value={requirement.type}>
                {requirement.name}（{requirement.type}）
              </option>
            ))}
          </select>
        </label>
        <label className="form-wide">
          豁免理由
          <textarea
            value={waiverReason}
            onChange={(event) => setWaiverReason(event.target.value)}
            placeholder="说明已授权的风险、影响范围和豁免原因"
          />
        </label>
      </div>
      <div className="button-row">
        <button
          className="quiet-button"
          disabled={!canRunAction("NODE_STARTED") || !nodeId.trim()}
          onClick={() => onStartNode?.(nodeId.trim())}
        >
          启动节点
        </button>
        <button
          className="quiet-button"
          disabled={!canRunAction("NODE_COMPLETED") || !nodeId.trim()}
          onClick={() => onCompleteNode?.(nodeId.trim())}
        >
          完成当前节点
        </button>
        {onStartDeployment ? (
          <button
            className="quiet-button"
            disabled={!canRunAction("NODE_STARTED") || !nodeId.trim()}
            onClick={() => onStartDeployment(nodeId.trim())}
          >
            启动部署
          </button>
        ) : null}
        <button
          className="quiet-button"
          disabled={!canRunAction("ARTIFACT_SUBMITTED") || !nodeId.trim()}
          onClick={() => onScanNodeArtifacts?.(nodeId.trim())}
        >
          重新检查节点产物
        </button>
        <button
          className="quiet-button"
          disabled={
            !canRunAction("ARTIFACT_SUBMITTED") ||
            !nodeId.trim() ||
            !artifactPath.trim() ||
            !artifactType.trim()
          }
          onClick={() => onSubmitArtifact?.(nodeId.trim(), artifactPath.trim(), artifactType.trim())}
          aria-label="提交 Artifact"
        >
          附加非声明产物
        </button>
        <button
          className="quiet-button"
          disabled={!canRunAction("HUMAN_APPROVED") || !nodeId.trim()}
          onClick={() => onApprove?.(nodeId.trim())}
        >
          人工批准
        </button>
        <button
          className="quiet-button"
          disabled={!canRunAction("GATE_PASSED") || !currentNodeId || !gateEvidenceUri}
          onClick={() => {
            if (currentNodeId && gateEvidenceUri) {
              onPassGate?.(currentNodeId, gateEvidenceUri);
            }
          }}
        >
          通过 Gate
        </button>
        <button
          className="quiet-button"
          disabled={!canRunAction("GATE_WAIVED") || nodeState !== "AWAITING_GATE" || !waiverReason.trim()}
          onClick={() => onWaiveGate?.(nodeId.trim(), waiverReason.trim())}
        >
          豁免 Gate
        </button>
        <button
          className="quiet-button"
          disabled={!canRunAction("RUN_PAUSED", null)}
          onClick={onPauseRun}
        >
          暂停 Run
        </button>
        <button
          className="quiet-button"
          disabled={!canRunAction("RUN_RESUMED", null)}
          onClick={onResumeRun}
        >
          恢复 Run
        </button>
        <button
          className="quiet-button"
          disabled={!canRunAction("RUN_ARCHIVED", null)}
          onClick={onArchiveRun}
        >
          归档 Run
        </button>
      </div>
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Deploy</p>
          <h3>部署执行</h3>
        </div>
      </div>
      {deployments.length > 0 ? (
        <div className="gate-stack" aria-label="部署会话">
          {deployments.map((deployment) => (
            <article className="gate-record" key={deployment.id}>
              <div className="panel-heading">
                <strong>{deployment.nodeId}</strong>
                <span className="status-pill">{deployment.status}</span>
              </div>
              <dl className="facts">
                <div>
                  <dt>工作目录</dt>
                  <dd>{deployment.cwd}</dd>
                </div>
                <div>
                  <dt>命令</dt>
                  <dd>{deployment.command.join(" ")}</dd>
                </div>
                <div>
                  <dt>结果</dt>
                  <dd>{deployment.summary ?? deployment.error ?? "等待部署结果"}</dd>
                </div>
              </dl>
              {deployment.status === "QUEUED" || deployment.status === "RUNNING" ? (
                <div className="button-row">
                  <button
                    className="quiet-button"
                    onClick={() => onCancelDeployment?.(deployment.id)}
                    aria-label={`取消部署：${deployment.id}`}
                  >
                    取消部署
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="body-copy">当前 Run 尚无部署会话。</p>
      )}
      {deploymentOutput.length > 0 ? (
        <TerminalViewport
          ariaLabel="部署实时输出"
          className="live-log-viewer"
          output={deploymentOutput
            .slice()
            .sort((left, right) => left.sequence - right.sequence)
            .map((event) => ({ sequence: event.sequence, data: event.data }))}
        />
      ) : null}
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Agent</p>
          <h3>Agent 执行</h3>
        </div>
        {operationMessage ? <span className="status-pill">{operationMessage}</span> : null}
      </div>
      <div className="form-grid">
        <label>
          Agent Provider
          <select
            value={agentProvider}
            onChange={(event) => setAgentProvider(event.target.value as AgentJobSummary["provider"])}
          >
            {(providerDiagnostics ?? defaultProviderDiagnostics).map((diagnostic) => (
              <option
                key={diagnostic.id}
                value={diagnostic.id}
                disabled={!diagnostic.available}
              >
                {providerLabel(diagnostic.id)}
                {diagnostic.available ? "" : "（不可用）"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent 模式
          <select
            value={agentMode}
            onChange={(event) => setAgentMode(event.target.value as "interactive" | "automatic")}
          >
            <option value="interactive">交互式终端</option>
            <option value="automatic">自动执行</option>
          </select>
        </label>
        <label>
          执行工作区
          <input value={activeRun?.context?.executionWorkspace || agentWorkspacePath} readOnly aria-label="Agent 执行工作区" />
        </label>
        <label className="form-wide">
          Agent 提示词
          <textarea
            value={agentPrompt}
            onChange={(event) => setAgentPrompt(event.target.value)}
            placeholder="描述要在当前节点执行的任务"
          />
        </label>
      </div>
      {providerDiagnostics ? (
        <ul className="compact-list" aria-label="CLI Provider 状态">
          {providerDiagnostics.map((diagnostic) => (
            <li key={diagnostic.id}>
              {providerLabel(diagnostic.id)}：{diagnostic.message}
              {diagnostic.version ? `（版本 ${diagnostic.version}）` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="button-row">
        <button
          className="quiet-button"
          disabled={!hasRun || !nodeId.trim() || !agentPrompt.trim() || !providerAvailable}
          onClick={() => onStartAgent?.(nodeId.trim(), agentProvider, agentPrompt.trim(), agentMode, roleAllowedTools, activeRun?.context?.executionWorkspace || agentWorkspacePath || undefined)}
        >
          启动 Agent
        </button>
        {agentJobs
          .filter((job) => job.status === "QUEUED" || job.status === "RUNNING")
          .map((job) => (
            <button
              className="quiet-button"
              key={job.id}
              onClick={() => onCancelAgent?.(job.id)}
            >
              取消 Agent：{job.id}
            </button>
          ))}
      </div>
      <ul className="compact-list" aria-label="Agent 任务">
        {agentJobs.map((job) => (
          <li key={job.id}>
            {job.id}：{job.status}
            {job.summary ? `：${job.summary}` : ""}
          </li>
        ))}
      </ul>
      <TerminalViewport
        ariaLabel="Agent 交互终端"
        resetKey={`${activeRunId ?? "none"}:${latestAgentJob?.id ?? "none"}`}
        output={agentTerminalOutput}
        writable={Boolean(activeInteractiveAgent && onAgentTerminalInput)}
        onInput={(data) => {
          if (activeInteractiveAgent) {
            onAgentTerminalInput?.(activeInteractiveAgent.id, data);
          }
        }}
        onResize={(columns, rows) => {
          if (activeInteractiveAgent) {
            onAgentTerminalResize?.(activeInteractiveAgent.id, columns, rows);
          }
        }}
        onInterrupt={() => {
          if (activeInteractiveAgent) {
            onAgentTerminalInput?.(activeInteractiveAgent.id, "\u0003");
          }
        }}
      />
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatAgentPayload(payload: Record<string, unknown>): string {
  const text = payload.text ?? payload.message ?? payload.summary ?? JSON.stringify(payload);
  return String(text);
}

const defaultProviderDiagnostics: AgentProviderDiagnostic[] = [
  {
    id: "codex",
    executable: "codex",
    available: true,
    path: null,
    version: null,
    message: "正在等待 Runtime 检测 Codex CLI。",
  },
  {
    id: "claude",
    executable: "claude",
    available: true,
    path: null,
    version: null,
    message: "正在等待 Runtime 检测 Claude Code CLI。",
  },
];

function providerLabel(provider: "codex" | "claude"): string {
  return provider === "codex" ? "Codex CLI" : "Claude Code CLI";
}
