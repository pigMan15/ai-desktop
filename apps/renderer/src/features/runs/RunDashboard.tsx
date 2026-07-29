import { useState } from "react";

import type {
  AgentJobSummary,
  AgentProviderDiagnostic,
  DeploymentOutputEvent,
  DeploymentSummary,
  RunSummary,
  RunConfiguration,
  RuntimeWorkbenchState,
} from "../../app/runtimeClient";
import { TerminalViewport, type TerminalViewportOutput } from "../terminal/TerminalViewport";

type Props = {
  state: RuntimeWorkbenchState | null;
  runs?: RunSummary[];
  activeRunId?: string | null;
  onSelectRun?: (runId: string) => void;
  onCreateRun?: (title: string, configuration: RunConfiguration) => void;
  onStartNode?: (nodeId: string) => void;
  onSubmitArtifact?: (nodeId: string, artifactPath: string) => void;
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
  ) => void;
  onCancelAgent?: (jobId: string) => void;
  onAgentTerminalInput?: (jobId: string, data: string) => void;
  deployments?: DeploymentSummary[];
  deploymentOutput?: DeploymentOutputEvent[];
  onStartDeployment?: (nodeId: string) => void;
  onCancelDeployment?: (deploymentId: string) => void;
  operationMessage?: string;
  providerDiagnostics?: AgentProviderDiagnostic[];
};

export function RunDashboard({
  state,
  runs = [],
  activeRunId = null,
  onSelectRun,
  onCreateRun,
  onStartNode,
  onSubmitArtifact,
  onApprove,
  onPassGate,
  onWaiveGate,
  onPauseRun,
  onResumeRun,
  onArchiveRun,
  onStartAgent,
  onCancelAgent,
  onAgentTerminalInput,
  deployments = [],
  deploymentOutput = [],
  onStartDeployment,
  onCancelDeployment,
  operationMessage,
  providerDiagnostics,
}: Props) {
  const [runTitle, setRunTitle] = useState("");
  const [taskGoal, setTaskGoal] = useState("");
  const [parametersText, setParametersText] = useState("{}");
  const [runConfigurationError, setRunConfigurationError] = useState("");
  const [nodeId, setNodeId] = useState("plan");
  const [artifactPath, setArtifactPath] = useState("");
  const [waiverReason, setWaiverReason] = useState("");
  const [agentProvider, setAgentProvider] = useState<AgentJobSummary["provider"]>("codex");
  const [agentMode, setAgentMode] = useState<"interactive" | "automatic">("interactive");
  const [agentPrompt, setAgentPrompt] = useState("");
  const projection = state?.projection;
  const workspaceReady = state?.workspaceStatus === "ready";
  const agentJobs = Array.isArray(state?.agentJobs) ? state.agentJobs : [];
  const agentOutput = Array.isArray(state?.agentOutput) ? state.agentOutput : [];
  const activeInteractiveAgent = [...agentJobs]
    .reverse()
    .find((job) => job.mode === "interactive" && (job.status === "QUEUED" || job.status === "RUNNING"));
  const latestAgentJob = activeInteractiveAgent ?? [...agentJobs].reverse()[0] ?? null;
  const agentTerminalOutput = latestAgentJob
    ? agentOutput
        .filter((event) => event.jobId === latestAgentJob.id)
        .sort((left, right) => left.sequence - right.sequence)
        .map((event): TerminalViewportOutput => ({ sequence: event.sequence, data: formatAgentPayload(event.payload) }))
    : [];
  const selectedProviderDiagnostic = providerDiagnostics?.find(
    (diagnostic) => diagnostic.id === agentProvider,
  );
  const providerAvailable =
    providerDiagnostics === undefined || selectedProviderDiagnostic?.available === true;
  const currentNodeId = projection?.currentNodeIds[0] ?? nodeId;
  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;
  const nodeState = currentNodeId ? projection?.nodeStates[currentNodeId] : undefined;
  const blockingReason = projection?.blockingReasons[0];
  const hasRun = Boolean(state?.connection === "connected" && projection?.runId);
  const canRunAction = (eventType: string, nodeId: string | null = currentNodeId) =>
    hasRun &&
    (projection?.allowedActions.some(
      (action) =>
        action.eventType === eventType &&
        (action.nodeId === nodeId || action.nodeId === undefined),
    ) ?? false);

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
      });
    } catch (error) {
      setRunConfigurationError(error instanceof Error ? error.message : "运行参数格式无效。");
    }
  }

  if (!workspaceReady) {
    return (
      <section id="runs" className="panel" aria-labelledby="runs-title">
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

  if (!projection) {
    return (
      <section id="runs" className="panel" aria-labelledby="runs-title">
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
    <section id="runs" className="panel" aria-labelledby="runs-title">
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
      </dl>
      <pre className="code-block" aria-label="运行参数">
        {JSON.stringify(activeRun?.context?.parameters ?? {}, null, 2)}
      </pre>
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
          <input value={nodeId} onChange={(event) => setNodeId(event.target.value)} />
        </label>
        <label>
          Artifact 路径
          <input
            value={artifactPath}
            onChange={(event) => setArtifactPath(event.target.value)}
            placeholder="例如 G:\Project\my-workflow\docs\plan.md"
          />
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
          disabled={!canRunAction("ARTIFACT_SUBMITTED") || !nodeId.trim() || !artifactPath.trim()}
          onClick={() => onSubmitArtifact?.(nodeId.trim(), artifactPath.trim())}
        >
          提交 Artifact
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
          disabled={!canRunAction("GATE_PASSED") || !nodeId.trim() || !artifactPath.trim()}
          onClick={() => onPassGate?.(nodeId.trim(), artifactPath.trim())}
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
          onClick={() => onStartAgent?.(nodeId.trim(), agentProvider, agentPrompt.trim(), agentMode)}
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
        output={agentTerminalOutput}
        writable={Boolean(activeInteractiveAgent && onAgentTerminalInput)}
        onInput={(data) => {
          if (activeInteractiveAgent) {
            onAgentTerminalInput?.(activeInteractiveAgent.id, data);
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
