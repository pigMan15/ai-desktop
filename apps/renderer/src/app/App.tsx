import { useEffect, useState } from "react";

import { ApprovalInbox } from "../features/approvals/ApprovalInbox";
import { ArtifactsPage } from "../features/artifacts/ArtifactsPage";
import { GatesPage } from "../features/gates/GatesPage";
import { ProjectDashboard } from "../features/projects/ProjectDashboard";
import { RecoveryPage } from "../features/recovery/RecoveryPage";
import { RunDashboard } from "../features/runs/RunDashboard";
import { SettingsPage } from "../features/settings/SettingsPage";
import { TerminalPage } from "../features/terminal/TerminalPage";
import { WorkflowViewer } from "../features/workflow/WorkflowViewer";
import { Navigation } from "./navigation";
import {
  createRuntimeClient,
  loadWorkbenchState,
  type AgentJobSummary,
  type RuntimeWorkbenchState,
} from "./runtimeClient";

export function App() {
  const [state, setState] = useState<RuntimeWorkbenchState | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState("http://127.0.0.1:8765");
  const [projectPath, setProjectPath] = useState("");
  const [artifactPath, setArtifactPath] = useState("");
  const [workflowVersionId, setWorkflowVersionId] = useState("");
  const [nodeId, setNodeId] = useState("plan");
  const [agentProvider, setAgentProvider] = useState<AgentJobSummary["provider"]>("fake");
  const [agentPrompt, setAgentPrompt] = useState("请用中文开发剩余内容");
  const [lastAgentJobId, setLastAgentJobId] = useState("");
  const [operationMessage, setOperationMessage] = useState("等待操作");

  useEffect(() => {
    let isMounted = true;

    loadWorkbenchState()
      .then((workbenchState) => {
        if (isMounted) {
          setState(workbenchState);
        }
      })
      .catch(() => {
        if (isMounted) {
          setState(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const connectionText =
    state?.connection === "connected" ? "连接状态：已连接" : "连接状态：不可用";
  const runStatus = state?.projection.status ?? "正在加载";
  const client = createRuntimeClient(apiBaseUrl);
  const now = () => new Date().toISOString();

  async function refreshRun(runId: string) {
    const [projection, timeline, artifacts, approvals, gates, agentJobs] = await Promise.all([
      client.getProjection(runId),
      client.getTimeline(runId),
      client.listArtifacts(runId),
      client.listApprovals(runId),
      client.listGates(runId),
      client.listAgentJobs(runId).catch(() => []),
    ]);
    setState((current) => ({
      connection: "connected",
      projectName: current?.projectName ?? projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "未命名项目",
      workflowName: current?.workflowName ?? workflowVersionId,
      projection,
      timeline,
      artifacts,
      approvals,
      gates,
      agentJobs,
      agentOutput: current?.agentOutput ?? [],
    }));
  }

  async function handleImportProject() {
    try {
      await client.health();
      const imported = await client.importProject(projectPath, now());
      setWorkflowVersionId(imported.workflowVersionId);
      setState((current) => ({
        ...(current ?? fallbackState()),
        connection: "connected",
        projectName: projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? imported.projectId,
        workflowName: imported.workflowName ?? imported.workflowId ?? imported.workflowVersionId,
      }));
      setOperationMessage(`导入完成：${imported.workflowName ?? imported.workflowVersionId}`);
    } catch (error) {
      setOperationMessage(`导入失败：${errorMessage(error)}`);
    }
  }

  async function handleCreateRun() {
    try {
      const projection = await client.createRun(
        workflowVersionId,
        `中文交互 Run ${now()}`,
        now(),
      );
      setState((current) => ({
        connection: "connected",
        projectName: current?.projectName ?? projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "未命名项目",
        workflowName: current?.workflowName ?? workflowVersionId,
        projection,
        timeline: [],
        artifacts: [],
        approvals: [],
        gates: [],
        agentJobs: [],
        agentOutput: [],
      }));
      setOperationMessage(`Run 已创建：${projection.runId}`);
    } catch (error) {
      setOperationMessage(`创建 Run 失败：${errorMessage(error)}`);
    }
  }

  async function updateProjection(
    action: (runId: string, revision: string, timestamp: string) => Promise<RuntimeWorkbenchState["projection"]>,
    successMessage: string,
  ) {
    const projection = state?.projection;
    if (!projection) {
      return;
    }
    try {
      const nextProjection = await action(projection.runId, projection.revision, now());
      setState((current) => (current ? { ...current, projection: nextProjection } : current));
      await refreshRun(nextProjection.runId);
      setOperationMessage(successMessage);
    } catch (error) {
      setOperationMessage(`操作失败：${errorMessage(error)}`);
    }
  }

  async function handleStartAgent() {
    const projection = state?.projection;
    if (!projection) {
      return;
    }
    try {
      const job = await client.startAgentJob(
        projection.runId,
        nodeId,
        agentProvider,
        agentPrompt,
        now(),
      );
      setLastAgentJobId(job.id);
      const output = await client.listAgentOutput(projection.runId, job.id, 0).catch(() => []);
      setState((current) =>
        current
          ? {
              ...current,
              agentJobs: [job],
              agentOutput: output,
            }
          : current,
      );
      setOperationMessage(`Agent 已启动：${job.id}`);
    } catch (error) {
      setOperationMessage(`Agent 启动失败：${errorMessage(error)}`);
    }
  }

  async function handleCancelAgent() {
    const runId = state?.projection.runId;
    if (!runId || !lastAgentJobId) {
      return;
    }
    try {
      const job = await client.cancelAgentJob(runId, lastAgentJobId);
      setState((current) =>
        current
          ? {
              ...current,
              agentJobs: current.agentJobs.map((candidate) =>
                candidate.id === job.id ? { ...candidate, ...job } : candidate,
              ),
            }
          : current,
      );
      setOperationMessage(`Agent 已取消：${job.id}`);
    } catch (error) {
      setOperationMessage(`Agent 取消失败：${errorMessage(error)}`);
    }
  }

  return (
    <div className="app-shell">
      <Navigation />
      <main className="workbench" aria-labelledby="app-title">
        <header className="workbench-header">
          <div>
            <p className="section-kicker">Renderer UI MVP</p>
            <h1 id="app-title">Renderer UI MVP 工作台</h1>
          </div>
          <div className="run-summary" aria-label="当前运行摘要">
            <span>当前 Run 状态</span>
            <strong>{runStatus}</strong>
            <span>{connectionText}</span>
          </div>
        </header>
        <section className="panel panel-wide" aria-labelledby="operations-title">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Operations</p>
              <h2 id="operations-title">交互式 Runtime 操作</h2>
            </div>
            <span className="status-pill">{operationMessage}</span>
          </div>
          <div className="form-grid">
            <label>
              Runtime API 地址
              <input value={apiBaseUrl} onChange={(event) => setApiBaseUrl(event.target.value)} />
            </label>
            <label>
              项目路径
              <input value={projectPath} onChange={(event) => setProjectPath(event.target.value)} />
            </label>
            <label>
              Artifact 路径
              <input value={artifactPath} onChange={(event) => setArtifactPath(event.target.value)} />
            </label>
            <label>
              节点 ID
              <input value={nodeId} onChange={(event) => setNodeId(event.target.value)} />
            </label>
            <label>
              Agent Provider
              <select
                value={agentProvider}
                onChange={(event) => setAgentProvider(event.target.value as AgentJobSummary["provider"])}
              >
                <option value="fake">fake</option>
                <option value="codex">codex</option>
                <option value="claude">claude</option>
              </select>
            </label>
            <label className="form-wide">
              Agent 提示词
              <textarea value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} />
            </label>
          </div>
          <div className="button-row">
            <button className="quiet-button" onClick={handleImportProject}>
              导入项目
            </button>
            <button className="quiet-button" disabled={!workflowVersionId} onClick={handleCreateRun}>
              创建 Run
            </button>
            <button className="quiet-button" disabled={!state?.projection} onClick={handleStartAgent}>
              启动 Agent
            </button>
            <button className="quiet-button" disabled={!lastAgentJobId} onClick={handleCancelAgent}>
              取消 Agent
            </button>
          </div>
          <ul className="compact-list" aria-label="Agent 输出">
            {(state?.agentOutput ?? []).map((event) => (
              <li key={event.id}>{formatAgentPayload(event.payload)}</li>
            ))}
          </ul>
        </section>
        <div className="content-grid">
          <ProjectDashboard state={state} />
          <RunDashboard
            state={state}
            onStartNode={() =>
              updateProjection(
                (runId, revision, timestamp) => client.startNode(runId, nodeId, revision, timestamp),
                `节点已启动：${nodeId}`,
              )
            }
            onSubmitArtifact={() =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.submitArtifact(runId, nodeId, artifactPath, "plan", revision, timestamp),
                `Artifact 已提交：${nodeId}`,
              )
            }
            onApprove={() =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.decideApproval(runId, nodeId, "approved", "中文审批", revision, timestamp),
                `审批已通过：${nodeId}`,
              )
            }
            onPassGate={() =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.submitGate(
                    runId,
                    nodeId,
                    "plan-ready",
                    "passed",
                    [`file://${artifactPath}`],
                    revision,
                    timestamp,
                  ),
                `Gate 已通过：${nodeId}`,
              )
            }
          />
          <WorkflowViewer />
          <TerminalPage />
          <GatesPage state={state} />
          <ArtifactsPage state={state} />
          <ApprovalInbox state={state} />
          <RecoveryPage state={state} />
          <SettingsPage />
        </div>
      </main>
    </div>
  );
}

function fallbackState(): RuntimeWorkbenchState {
  return {
    connection: "unavailable",
    projectName: "未导入",
    workflowName: "未导入",
    projection: {
      runId: "",
      status: "CREATED",
      currentNodeIds: [],
      nodeStates: {},
      allowedActions: [],
      blockingReasons: [],
      revision: "0",
      updatedAt: "",
    },
    timeline: [],
    artifacts: [],
    approvals: [],
    gates: [],
    agentJobs: [],
    agentOutput: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAgentPayload(payload: Record<string, unknown>): string {
  const text = payload.text ?? payload.message ?? payload.summary ?? JSON.stringify(payload);
  return String(text);
}
