import { useEffect, useRef, useState } from "react";

import { ApprovalInbox } from "../features/approvals/ApprovalInbox";
import { ArtifactsPage } from "../features/artifacts/ArtifactsPage";
import { GatesPage } from "../features/gates/GatesPage";
import { KnowledgePage } from "../features/knowledge/KnowledgePage";
import { ProjectDashboard } from "../features/projects/ProjectDashboard";
import {
  GitWorkspacePanel,
  type GitWorkspaceStatus,
  type GitWorktree,
} from "../features/projects/GitWorkspacePanel";
import { RecoveryPage } from "../features/recovery/RecoveryPage";
import { RunDashboard } from "../features/runs/RunDashboard";
import { AuditPage } from "../features/audit/AuditPage";
import {
  SettingsPage,
  type ManagedRuntimeStatus,
  type RuntimeLogEntry,
} from "../features/settings/SettingsPage";
import { TerminalPage } from "../features/terminal/TerminalPage";
import type { TerminalViewportOutput } from "../features/terminal/TerminalViewport";
import { WorkflowViewer } from "../features/workflow/WorkflowViewer";
import { Navigation } from "./navigation";
import { normalizeRoute, routeHash } from "./routes";
import {
  isInteractiveAgentSessionClosedError,
  isInteractiveAgentOutputLimitError,
  isTerminalSessionMissingError,
  mergeAgentOutput,
} from "./agentOutput";
import { desktopGitApi } from "./desktopGit";
import { desktopProjectApi } from "./desktopProject";
import {
  createRuntimeClient,
  loadWorkbenchState,
  restoreWorkbenchState,
  type AgentJobSummary,
  type AgentOutputSummary,
  type AgentProviderDiagnostic,
  type ArtifactPreview,
  type AuditRecord,
  type CompiledWorkflowSummary,
  type DeploymentOutputEvent,
  type DeploymentSummary,
  type KnowledgeCandidate,
  type KnowledgeDocument,
  type KnowledgeDocumentExport,
  type KnowledgeDocumentReplay,
  type KnowledgeSynthesis,
  type KnowledgeSynthesisOutputEvent,
  type RuntimeWorkbenchState,
  type RecoveryDiagnostics,
  type RunConfiguration,
  type RunSummary,
  type TerminalOutputEvent,
  type TerminalSessionSummary,
  type WorkflowDefinitionSummary,
  type WorkflowExportFormat,
  type WorkflowSimulation,
  type WorkflowVersionDiff,
  type WorkflowVersionSummary,
} from "./runtimeClient";
import { loadWorkspaceSession, saveWorkspaceSession } from "./workspaceSession";

export function App() {
  const [savedSession] = useState(loadWorkspaceSession);
  const [state, setState] = useState<RuntimeWorkbenchState | null>(null);
  const [currentRoute, setCurrentRoute] = useState(() => normalizeRoute(window.location.hash));
  const [apiBaseUrl, setApiBaseUrl] = useState(savedSession.apiBaseUrl);
  const [projectPath, setProjectPath] = useState(savedSession.projectPath);
  const [projectId, setProjectId] = useState(savedSession.projectId ?? "");
  const [projectArchived, setProjectArchived] = useState(false);
  const [workflowVersionId, setWorkflowVersionId] = useState(savedSession.workflowVersionId);
  const [operationMessage, setOperationMessage] = useState("等待操作");
  const [managedRuntime, setManagedRuntime] = useState<ManagedRuntimeStatus | null>(null);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLogEntry[]>([]);
  const [providerDiagnostics, setProviderDiagnostics] = useState<AgentProviderDiagnostic[] | undefined>(
    undefined,
  );
  const [knowledgeCandidates, setKnowledgeCandidates] = useState<KnowledgeCandidate[]>([]);
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocument[]>([]);
  const [knowledgeSyntheses, setKnowledgeSyntheses] = useState<KnowledgeSynthesis[]>([]);
  const [knowledgeSynthesisOutput, setKnowledgeSynthesisOutput] = useState<
    KnowledgeSynthesisOutputEvent[]
  >([]);
  const [knowledgeReplay, setKnowledgeReplay] = useState<KnowledgeDocumentReplay | null>(null);
  const [knowledgeGitPreview, setKnowledgeGitPreview] = useState<{
    documentId: string;
    title: string;
    relativePath: string;
    previousContent: string;
    nextContent: string;
  } | null>(null);
  const [publishingKnowledgeDocumentId, setPublishingKnowledgeDocumentId] = useState<string | null>(null);
  const [auditRecords, setAuditRecords] = useState<AuditRecord[]>([]);
  const [artifactPreview, setArtifactPreview] = useState<ArtifactPreview | null>(null);
  const [artifactComparison, setArtifactComparison] = useState<{
    before: { id: string; content: string };
    after: { id: string; content: string };
  } | null>(null);
  const [workflowDefinition, setWorkflowDefinition] = useState<WorkflowDefinitionSummary | null>(null);
  const [compiledWorkflow, setCompiledWorkflow] = useState<CompiledWorkflowSummary | null>(null);
  const [workflowSimulation, setWorkflowSimulation] = useState<WorkflowSimulation | null>(null);
  const [workflowHistory, setWorkflowHistory] = useState<WorkflowVersionSummary[]>([]);
  const [workflowDiff, setWorkflowDiff] = useState<WorkflowVersionDiff | null>(null);
  const [gitWorkspaceStatus, setGitWorkspaceStatus] = useState<GitWorkspaceStatus | null>(null);
  const [gitWorktrees, setGitWorktrees] = useState<GitWorktree[]>([]);
  const [recoveryDiagnostics, setRecoveryDiagnostics] = useState<RecoveryDiagnostics | null>(null);
  const [terminalSessions, setTerminalSessions] = useState<TerminalSessionSummary[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [artifactInventory, setArtifactInventory] = useState<RuntimeWorkbenchState["artifacts"]>([]);
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [deploymentOutput, setDeploymentOutput] = useState<DeploymentOutputEvent[]>([]);
  const [interactiveAgentTerminals, setInteractiveAgentTerminals] = useState<
    Record<string, InteractiveAgentTerminalBinding>
  >({});
  const [liveAgentOutput, setLiveAgentOutput] = useState<
    Record<string, Record<string, TerminalViewportOutput[]>>
  >({});
  const agentInputBuffersRef = useRef<Record<string, string>>({});
  const liveAgentOutputPendingRef = useRef<Record<string, Record<string, TerminalViewportOutput[]>>>({});
  const liveAgentOutputFrameRef = useRef<number | null>(null);
  const runSwitchInProgressRef = useRef(false);

  useEffect(() => {
    if (currentRoute === "workflow") {
      const workbench = document.querySelector<HTMLElement>(".workbench");
      if (workbench) {
        workbench.scrollTop = 0;
        workbench.scrollLeft = 0;
      }
    }
  }, [currentRoute]);

  function appendLiveAgentOutput(runId: string, jobId: string, event: TerminalViewportOutput) {
    const pending = liveAgentOutputPendingRef.current;
    const runOutput = pending[runId] ?? {};
    pending[runId] = {
      ...runOutput,
      [jobId]: [...(runOutput[jobId] ?? []), event],
    };
    if (liveAgentOutputFrameRef.current !== null) {
      return;
    }
    liveAgentOutputFrameRef.current = window.requestAnimationFrame(() => {
      const batch = liveAgentOutputPendingRef.current;
      liveAgentOutputPendingRef.current = {};
      liveAgentOutputFrameRef.current = null;
      setLiveAgentOutput((current) => {
        const next = { ...current };
        for (const [nextRunId, jobs] of Object.entries(batch)) {
          const nextRunOutput = { ...(current[nextRunId] ?? {}) };
          for (const [nextJobId, events] of Object.entries(jobs)) {
            nextRunOutput[nextJobId] = [...(nextRunOutput[nextJobId] ?? []), ...events].slice(-2_000);
          }
          next[nextRunId] = nextRunOutput;
        }
        return next;
      });
    });
  }

  function clearDisplayedAgentTerminal() {
    setState((current) =>
      current
        ? {
            ...current,
            agentJobs: [],
            agentOutput: [],
          }
        : current,
    );
  }

  useEffect(() => {
    let isMounted = true;

    const initialLoad = savedSession.runId && apiBaseUrl === savedSession.apiBaseUrl
      ? restoreWorkbenchState({ ...savedSession, runId: savedSession.runId })
        .catch(() => loadWorkbenchState(apiBaseUrl))
      : loadWorkbenchState(apiBaseUrl);

    initialLoad
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
  }, [apiBaseUrl, savedSession]);

  useEffect(() => {
    void refreshManagedRuntimeDiagnostics();
  }, []);

  useEffect(() => {
    if (state?.connection !== "connected") {
      setProviderDiagnostics(undefined);
      return;
    }

    let isMounted = true;
    createRuntimeClient(apiBaseUrl)
      .listAgentProviders()
      .then((diagnostics) => {
        if (isMounted) {
          setProviderDiagnostics(Array.isArray(diagnostics) ? diagnostics : []);
        }
      })
      .catch(() => {
        if (isMounted) {
          setProviderDiagnostics([]);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [apiBaseUrl, state?.connection]);

  useEffect(() => {
    if (!workflowVersionId || state?.connection !== "connected") {
      setWorkflowDefinition(null);
      setCompiledWorkflow(null);
      setWorkflowSimulation(null);
      setWorkflowHistory([]);
      setWorkflowDiff(null);
      return;
    }
    setWorkflowSimulation(null);
    setWorkflowDiff(null);
    let isMounted = true;
    const runtimeClient = createRuntimeClient(apiBaseUrl);
    Promise.all([
      runtimeClient.getWorkflowDefinition(workflowVersionId),
      runtimeClient.compileWorkflowDefinition(workflowVersionId),
      runtimeClient.listWorkflowVersionHistory(workflowVersionId),
    ])
      .then(([definition, compiled, history]) => {
        if (isMounted) {
          setWorkflowDefinition(definition);
          setCompiledWorkflow(compiled);
          setWorkflowHistory(history);
        }
      })
      .catch(() => {
        if (isMounted) {
          setWorkflowDefinition(null);
          setCompiledWorkflow(null);
          setWorkflowHistory([]);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [apiBaseUrl, state?.connection, workflowVersionId]);

  useEffect(() => {
    if (currentRoute !== "artifacts" || state?.connection !== "connected") {
      return;
    }
    let isMounted = true;
    Promise.all(runs.map((run) => createRuntimeClient(apiBaseUrl).listArtifacts(run.id))).then((artifactGroups) => {
      if (isMounted) setArtifactInventory(artifactGroups.flat());
    }).catch((error) => {
      if (isMounted) setOperationMessage(`读取产物列表失败：${errorMessage(error)}`);
    });
    return () => { isMounted = false; };
  }, [apiBaseUrl, currentRoute, runs, state?.connection]);

  useEffect(() => {
    if (!workflowVersionId || state?.connection !== "connected") {
      setRuns([]);
      return;
    }
    let isMounted = true;
    createRuntimeClient(apiBaseUrl)
      .listRunsForWorkflowVersion(workflowVersionId)
      .then((items) => {
        if (isMounted) {
          setRuns(items);
        }
      })
      .catch(() => {
        if (isMounted) {
          setRuns([]);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [apiBaseUrl, state?.connection, workflowVersionId]);

  const activeRunId = state?.projection?.runId ?? null;
  const agentJobSignature = (state?.agentJobs ?? [])
    .map((job) => `${job.id}:${job.status}`)
    .join("|");
  const deploymentSignature = deployments.map((deployment) => `${deployment.id}:${deployment.status}`).join("|");
  const interactiveAgentTerminalSignature = Object.entries(interactiveAgentTerminals)
    .map(([jobId, binding]) => `${jobId}:${binding.desktopSessionId}:${binding.afterSequence}`)
    .join("|");

  useEffect(() => {
    if (!activeRunId || state?.connection !== "connected") {
      setRecoveryDiagnostics(null);
      return;
    }
    let isMounted = true;
    createRuntimeClient(apiBaseUrl)
      .getRecoveryDiagnostics(activeRunId)
      .then((diagnostics) => {
        if (isMounted) {
          setRecoveryDiagnostics(diagnostics);
        }
      })
      .catch(() => {
        if (isMounted) {
          setRecoveryDiagnostics(null);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [activeRunId, apiBaseUrl, state?.connection]);

  useEffect(() => {
    if (!activeRunId || state?.connection !== "connected" || currentRoute !== "terminal") {
      setTerminalSessions([]);
      return;
    }
    let isMounted = true;
    createRuntimeClient(apiBaseUrl)
      .listTerminalSessions(activeRunId)
      .then((sessions) => {
        if (isMounted) {
          setTerminalSessions(sessions);
        }
      })
      .catch(() => {
        if (isMounted) {
          setTerminalSessions([]);
        }
      });
    return () => {
      isMounted = false;
    };
  }, [activeRunId, apiBaseUrl, currentRoute, state?.connection]);

  useEffect(() => {
    if (!activeRunId) {
      return;
    }

    let disposed = false;
    let timer: number | undefined;

    const pollAgentActivity = async () => {
      try {
        const runtimeClient = createRuntimeClient(apiBaseUrl);
        const jobs = await runtimeClient.listAgentJobs(activeRunId);
        if (disposed || runSwitchInProgressRef.current) {
          return;
        }

        const currentOutput = state?.agentOutput ?? [];
        const outputByJob = await Promise.all(
          jobs.map(async (job) => {
            const afterSequence = currentOutput
              .filter((event) => event.jobId === job.id)
              .reduce((latest, event) => Math.max(latest, event.sequence), 0);
            return runtimeClient.listAgentOutput(activeRunId, job.id, afterSequence);
          }),
        );
        if (disposed) {
          return;
        }

        const incomingOutput = outputByJob.flat();
        setState((current) => {
          if (runSwitchInProgressRef.current || current?.projection?.runId !== activeRunId) {
            return current;
          }
          return {
            ...current,
            agentJobs: jobs,
            agentOutput: mergeAgentOutput(current.agentOutput, incomingOutput),
          };
        });

        if (jobs.some((job) => job.status === "QUEUED" || job.status === "RUNNING")) {
          timer = window.setTimeout(() => void pollAgentActivity(), 1_500);
        }
      } catch {
        // 轮询失败不会伪造任务完成；用户可继续查看上一次可信输出。
        if ((state?.agentJobs ?? []).some((job) => job.status === "QUEUED" || job.status === "RUNNING")) {
          timer = window.setTimeout(() => void pollAgentActivity(), 1_500);
        }
      }
    };

    void pollAgentActivity();
    return () => {
      disposed = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [activeRunId, agentJobSignature, apiBaseUrl]);

  useEffect(() => {
    if (!activeRunId || state?.connection !== "connected") {
      return;
    }
    const terminalBridge = getDesktopTerminalBridge();
    if (!terminalBridge) {
      return;
    }
    const runningInteractiveJobs = (state?.agentJobs ?? []).filter(
      (job) =>
        job.mode === "interactive" &&
        (job.status === "QUEUED" || job.status === "RUNNING") &&
        interactiveAgentTerminals[job.id],
    );
    if (runningInteractiveJobs.length === 0) {
      return;
    }

    let disposed = false;
    let timer: number | undefined;
    let readingJobId: string | null = null;

    const pollInteractiveAgentTerminals = async () => {
      try {
        const runtimeClient = createRuntimeClient(apiBaseUrl);
        for (const job of runningInteractiveJobs) {
          readingJobId = job.id;
          const binding = interactiveAgentTerminals[job.id];
          if (!binding) {
            continue;
          }
          const terminalEvents = await terminalBridge.read(binding.desktopSessionId, binding.afterSequence);
          if (disposed) {
            return;
          }
          if (terminalEvents.length === 0) {
            continue;
          }
          let recordedOutput: AgentOutputSummary[] = [];
          let persistenceLimited = Boolean(binding.persistenceLimited);
          if (!persistenceLimited) {
            try {
              recordedOutput = await runtimeClient.appendInteractiveAgentOutput(
                activeRunId,
                job.id,
                terminalEvents.map((event) => ({ data: event.data })),
                now(),
              );
            } catch (error) {
              if (!isInteractiveAgentOutputLimitError(error)) {
                throw error;
              }
              setOperationMessage("Agent 审计输出已达到上限，实时终端仍可继续使用。");
              persistenceLimited = true;
              setInteractiveAgentTerminals((current) => ({
                ...current,
                [job.id]: { ...binding, persistenceLimited: true },
              }));
            }
          }
          if (disposed) {
            return;
          }
          const nextSequence = terminalEvents.reduce(
            (latest, event) => Math.max(latest, event.sequence),
            binding.afterSequence,
          );
          setInteractiveAgentTerminals((current) => ({
            ...current,
            [job.id]: { ...binding, afterSequence: nextSequence, persistenceLimited },
          }));
          setState((current) => {
            if (current?.projection?.runId !== activeRunId) {
              return current;
            }
            return {
              ...current,
              agentOutput: mergeAgentOutput(current.agentOutput, recordedOutput),
            };
          });
        }
      } catch (error) {
        if (isTerminalSessionMissingError(error) && readingJobId) {
          const missingJobId = readingJobId;
          setInteractiveAgentTerminals((current) => {
            const next = { ...current };
            delete next[missingJobId];
            return next;
          });
          delete agentInputBuffersRef.current[missingJobId];
          setOperationMessage("桌面终端会话已失效，已停止该 Agent 的终端同步。");
        } else if (isInteractiveAgentSessionClosedError(error)) {
          const affectedBindings = Object.fromEntries(
            runningInteractiveJobs
              .map((job) => [job.id, interactiveAgentTerminals[job.id]])
              .filter((entry): entry is [string, InteractiveAgentTerminalBinding] => Boolean(entry[1])),
          );
          await Promise.all(
            Object.values(affectedBindings).map((binding) =>
              terminalBridge.stop(binding.desktopSessionId).catch(() => undefined),
            ),
          );
          setInteractiveAgentTerminals((current) => {
            const next = { ...current };
            for (const jobId of Object.keys(affectedBindings)) {
              delete next[jobId];
              delete agentInputBuffersRef.current[jobId];
            }
            return next;
          });
          const jobs = await createRuntimeClient(apiBaseUrl).listAgentJobs(activeRunId).catch(() => null);
          if (jobs) {
            setState((current) =>
              current?.projection?.runId === activeRunId ? { ...current, agentJobs: jobs } : current,
            );
          }
          setOperationMessage("Agent 交互会话已结束，已停止本地终端同步。");
        } else {
          // Runtime persistence is best-effort for the live PTY; it must not interrupt TUI input.
        }
      } finally {
        if (!disposed) {
          timer = window.setTimeout(() => void pollInteractiveAgentTerminals(), 500);
        }
      }
    };

    void pollInteractiveAgentTerminals();
    return () => {
      disposed = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [
    activeRunId,
    apiBaseUrl,
    interactiveAgentTerminalSignature,
    agentJobSignature,
    state?.connection,
  ]);

  useEffect(() => {
    if (!activeRunId || state?.connection !== "connected") {
      setDeployments([]);
      setDeploymentOutput([]);
      return;
    }

    let disposed = false;
    let timer: number | undefined;

    const pollDeploymentActivity = async () => {
      try {
        const runtimeClient = createRuntimeClient(apiBaseUrl);
        const items = await runtimeClient.listDeployments(activeRunId);
        const output = (
          await Promise.all(
            items.map((deployment) => runtimeClient.listDeploymentOutput(activeRunId, deployment.id)),
          )
        ).flat();
        if (disposed) {
          return;
        }
        setDeployments(items);
        setDeploymentOutput(output);
        if (items.some((deployment) => deployment.status === "QUEUED" || deployment.status === "RUNNING")) {
          timer = window.setTimeout(() => void pollDeploymentActivity(), 1_500);
        } else if (deployments.some((deployment) => deployment.status === "QUEUED" || deployment.status === "RUNNING")) {
          await refreshRun(activeRunId);
          await refreshRuns();
        }
      } catch {
        // 部署轮询失败时保持上一次可信会话与输出，避免伪造完成结果。
      }
    };

    void pollDeploymentActivity();
    return () => {
      disposed = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [activeRunId, apiBaseUrl, deploymentSignature, state?.connection]);

  useEffect(() => {
    const syncRoute = () => {
      const route = normalizeRoute(window.location.hash);
      if (window.location.hash !== routeHash(route)) {
        window.history.replaceState(null, "", routeHash(route));
      }
      setCurrentRoute(route);
    };

    syncRoute();
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  const connectionText =
    state?.connection === "connected" ? "连接状态：已连接" : "连接状态：不可用";
  const runStatus = state?.projection?.status ?? "尚未创建 Run";
  const client = createRuntimeClient(apiBaseUrl);
  const now = () => new Date().toISOString();

  useEffect(() => {
    if (state?.connection !== "connected" || currentRoute !== "knowledge") {
      return;
    }
    void refreshKnowledge();
  }, [apiBaseUrl, currentRoute, state?.connection]);

  const hasActiveKnowledgeSynthesis = knowledgeSyntheses.some(
    (synthesis) => synthesis.status === "QUEUED" || synthesis.status === "RUNNING",
  );

  useEffect(() => {
    if (
      state?.connection !== "connected" ||
      currentRoute !== "knowledge" ||
      !hasActiveKnowledgeSynthesis
    ) {
      return;
    }
    const timer = window.setInterval(() => void refreshKnowledge(), 1_500);
    return () => window.clearInterval(timer);
  }, [apiBaseUrl, currentRoute, hasActiveKnowledgeSynthesis, state?.connection]);

  useEffect(() => {
    if (state?.connection !== "connected" || currentRoute !== "audit") {
      return;
    }
    void refreshAuditRecords("");
  }, [apiBaseUrl, currentRoute, state?.connection]);

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
      workspaceStatus: "ready",
      projectName: current?.projectName ?? projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "未命名项目",
      workflowName: current?.workflowName ?? workflowVersionId,
      projection,
      timeline,
      artifacts,
      approvals,
      gates,
      agentJobs,
      agentOutput: current?.projection?.runId === runId ? current.agentOutput : [],
    }));
  }

  async function refreshRuns() {
    if (!workflowVersionId) {
      setRuns([]);
      return;
    }
    setRuns(await createRuntimeClient(apiBaseUrl).listRunsForWorkflowVersion(workflowVersionId));
  }

  async function handleImportProject() {
    try {
      await client.health();
      const imported = await client.importProject(projectPath, now());
      setProjectId(imported.projectId);
      setProjectArchived(false);
      setWorkflowVersionId(imported.workflowVersionId ?? "");
      setRuns([]);
      const projectName = projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? imported.projectId;
      const workflowName = imported.workflowName ?? imported.workflowId ?? imported.workflowVersionId ?? "未绑定工作流";
      setState((current) => ({
        ...(current ?? fallbackState()),
        connection: "connected",
        workspaceStatus: "ready",
        projectName,
        workflowName,
      }));
      saveWorkspaceSession({
        apiBaseUrl,
        projectPath,
        projectId: imported.projectId,
        workflowVersionId: imported.workflowVersionId ?? "",
        projectName,
        workflowName,
        runId: null,
      });
      setOperationMessage(
        imported.createdDefaultWorkflow
          ? `已为项目创建起步工作流：${workflowName}，可在工作流模块继续编辑。`
          : `导入完成：${workflowName}`,
      );
      void refreshGitWorkspace();
    } catch (error) {
      setOperationMessage(`导入失败：${errorMessage(error)}`);
    }
  }

  async function handleSelectProjectDirectory() {
    const projectDesktopApi = desktopProjectApi();
    if (!projectDesktopApi) {
      setOperationMessage("当前运行环境不支持系统目录选择，请手动输入项目路径。");
      return;
    }
    try {
      const selectedPath = await projectDesktopApi.selectDirectory();
      if (selectedPath) {
        setProjectPath(selectedPath);
        setOperationMessage("已选择项目目录，请确认后导入项目。");
      }
    } catch (error) {
      setOperationMessage(`选择项目目录失败：${errorMessage(error)}`);
    }
  }

  async function refreshGitWorkspace() {
    const git = desktopGitApi();
    if (!git || !projectPath.trim()) {
      setGitWorkspaceStatus(null);
      setGitWorktrees([]);
      return;
    }
    try {
      const [status, worktrees] = await Promise.all([
        git.status(projectPath),
        git.listWorktrees(projectPath),
      ]);
      setGitWorkspaceStatus(status);
      setGitWorktrees(worktrees);
    } catch (error) {
      setGitWorkspaceStatus(null);
      setGitWorktrees([]);
      setOperationMessage(`读取 Git 工作区失败：${errorMessage(error)}`);
    }
  }

  async function handleCreateGitWorktree(branch: string) {
    const git = desktopGitApi();
    if (!git) {
      return;
    }
    try {
      await git.createWorktree(projectPath, branch);
      await refreshGitWorkspace();
      setOperationMessage(`Git Worktree 已创建：${branch}`);
    } catch (error) {
      setOperationMessage(`创建 Git Worktree 失败：${errorMessage(error)}`);
    }
  }

  async function handleRemoveGitWorktree(worktreePath: string) {
    const git = desktopGitApi();
    if (!git) {
      return;
    }
    try {
      await git.removeWorktree(projectPath, worktreePath);
      await refreshGitWorkspace();
      setOperationMessage("Git Worktree 已清理。");
    } catch (error) {
      setOperationMessage(`清理 Git Worktree 失败：${errorMessage(error)}`);
    }
  }

  async function handleMergeGitWorktree(branch: string) {
    const git = desktopGitApi();
    if (!git) {
      return;
    }
    try {
      await git.mergeBack(projectPath, branch);
      await refreshGitWorkspace();
      setOperationMessage(`已合并分支：${branch}`);
    } catch (error) {
      setOperationMessage(`合并分支失败：${errorMessage(error)}`);
    }
  }

  async function handlePushGitBranch() {
    const git = desktopGitApi();
    if (!git) {
      return;
    }
    try {
      await git.push(projectPath);
      await refreshGitWorkspace();
      setOperationMessage("Git 分支已推送。");
    } catch (error) {
      setOperationMessage(`推送 Git 分支失败：${errorMessage(error)}`);
    }
  }

  async function handleCheckRuntimeConnection() {
    const workbenchState = await loadWorkbenchState(apiBaseUrl);
    setState(workbenchState);
    setOperationMessage(
      workbenchState.connection === "connected" ? "Runtime 已连接" : "Runtime API 不可用",
    );
  }

  async function refreshManagedRuntimeDiagnostics() {
    const desktopRuntime = getDesktopRuntimeBridge();
    if (!desktopRuntime) {
      return;
    }
    try {
      const [status, logs] = await Promise.all([
        desktopRuntime.status(),
        desktopRuntime.logs(),
      ]);
      setManagedRuntime(status);
      setRuntimeLogs(logs);
      if (status.state === "ready" && status.url && status.url !== apiBaseUrl) {
        setApiBaseUrl(status.url);
      }
    } catch {
      // IPC 诊断不可用时保留浏览器/外部 Runtime 的使用方式。
    }
  }

  async function refreshProviderDiagnostics() {
    if (state?.connection !== "connected") {
      setProviderDiagnostics(undefined);
      setOperationMessage("Runtime 未连接，无法检测 CLI。");
      return;
    }
    try {
      const diagnostics = await createRuntimeClient(apiBaseUrl).listAgentProviders();
      setProviderDiagnostics(Array.isArray(diagnostics) ? diagnostics : []);
      setOperationMessage("CLI 可用性诊断已更新。");
    } catch (error) {
      setProviderDiagnostics([]);
      setOperationMessage(`CLI 可用性诊断失败：${errorMessage(error)}`);
    }
  }

  async function handleRestartManagedRuntime() {
    const desktopRuntime = getDesktopRuntimeBridge();
    if (!desktopRuntime) {
      return;
    }
    try {
      const status = await desktopRuntime.restart();
      const logs = await desktopRuntime.logs();
      setManagedRuntime(status);
      setRuntimeLogs(logs);
      handleApiBaseUrlChange(status.url);
      const workbenchState = await loadWorkbenchState(status.url);
      setState(workbenchState);
      setOperationMessage(
        workbenchState.connection === "connected"
          ? "Runtime 已重启并连接"
          : "Runtime 重启后仍不可用，请查看诊断日志",
      );
    } catch (error) {
      setOperationMessage(`Runtime 重启失败：${errorMessage(error)}`);
      await refreshManagedRuntimeDiagnostics();
    }
  }

  function handleApiBaseUrlChange(value: string) {
    setApiBaseUrl(value);
    saveWorkspaceSession({
      ...loadWorkspaceSession(),
      apiBaseUrl: value,
    });
  }

  async function handleCreateRun(title: string, configuration: RunConfiguration) {
    try {
      if (!projectId || !workflowVersionId) {
        throw new Error("请先为项目绑定工作流");
      }
      runSwitchInProgressRef.current = true;
      clearDisplayedAgentTerminal();
      const projection = await client.createRun(
        workflowVersionId,
        title,
        now(),
        configuration,
        projectId,
      );
      await refreshRun(projection.runId);
      runSwitchInProgressRef.current = false;
      await refreshRuns();
      saveWorkspaceSession({
        apiBaseUrl,
        projectPath,
        projectId,
        workflowVersionId,
        projectName: state?.projectName ?? projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "未命名项目",
        workflowName: state?.workflowName ?? workflowVersionId,
        runId: projection.runId,
      });
      setOperationMessage(`Run 已创建：${projection.runId}`);
    } catch (error) {
      runSwitchInProgressRef.current = false;
      setOperationMessage(`创建 Run 失败：${errorMessage(error)}`);
    }
  }

  async function handleSelectRun(runId: string) {
    if (!runId || runId === state?.projection?.runId) {
      return;
    }
    try {
      runSwitchInProgressRef.current = true;
      clearDisplayedAgentTerminal();
      await refreshRun(runId);
      runSwitchInProgressRef.current = false;
      saveWorkspaceSession({
        apiBaseUrl,
        projectPath,
        projectId,
        workflowVersionId,
        projectName: state?.projectName ?? projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "未命名项目",
        workflowName: state?.workflowName ?? workflowVersionId,
        runId,
      });
      setOperationMessage(`已切换到 Run：${runId}`);
    } catch (error) {
      runSwitchInProgressRef.current = false;
      setOperationMessage(`切换 Run 失败：${errorMessage(error)}`);
    }
  }

  async function updateProjection(
    action: (runId: string, revision: string, timestamp: string) => Promise<NonNullable<RuntimeWorkbenchState["projection"]>>,
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
      await refreshRuns();
      setOperationMessage(successMessage);
    } catch (error) {
      setOperationMessage(`操作失败：${errorMessage(error)}`);
    }
  }

  async function handleStartAgent(
    selectedNodeId: string,
    provider: AgentJobSummary["provider"],
    prompt: string,
    mode: "interactive" | "automatic" = "interactive",
    allowedTools: string[] = [],
    cwd?: string,
  ) {
    const projection = state?.projection;
    if (!projection) {
      return;
    }
    try {
      const terminalBridge = getDesktopTerminalBridge();
      const canUseInteractiveTerminal =
        mode === "interactive" && terminalBridge && (provider === "codex" || provider === "claude");
      const agentMode = canUseInteractiveTerminal ? "interactive" : "automatic";
      const executionCwd = cwd || projectPath;
      const job = await client.startAgentJob(
        projection.runId,
        selectedNodeId,
        provider,
        prompt,
        now(),
        agentMode,
        allowedTools,
        executionCwd,
      );
      if (canUseInteractiveTerminal) {
        let terminalSession: Awaited<ReturnType<DesktopTerminalBridge["create"]>> | null = null;
        try {
          terminalSession = await terminalBridge.create({
            kind: provider,
            cwd: executionCwd,
            projectRoot: projectPath,
            columns: 100,
            rows: 30,
            initialPrompt: job.effectivePrompt ?? prompt,
          });
          await client.startInteractiveAgentSession(
            projection.runId,
            job.id,
            terminalSession.id,
            terminalSession.pid,
            now(),
          );
          terminalBridge.onOutput?.(terminalSession.id, (event) => {
            appendLiveAgentOutput(projection.runId, job.id, event);
          });
          setInteractiveAgentTerminals((current) => ({
            ...current,
            [job.id]: {
              desktopSessionId: terminalSession!.id,
              pid: terminalSession!.pid,
              afterSequence: 0,
            },
          }));
        } catch (error) {
          if (terminalSession) {
            await terminalBridge.stop(terminalSession.id).catch(() => undefined);
          }
          await client.finishInteractiveAgentSession(
            projection.runId,
            job.id,
            "RECOVERABLE",
            null,
            `桌面交互终端启动失败：${errorMessage(error)}`,
            now(),
          ).catch(() => undefined);
          throw error;
        }
      }
      const output = await client.listAgentOutput(projection.runId, job.id, 0).catch(() => []);
      setState((current) =>
        current
          ? {
              ...current,
              agentJobs: [...current.agentJobs.filter((candidate) => candidate.id !== job.id), job],
              agentOutput: output,
            }
          : current,
      );
      setOperationMessage(
        agentMode === "interactive"
          ? `交互式 Agent 已启动：${job.id}`
          : `Agent 已启动：${job.id}`,
      );
    } catch (error) {
      setOperationMessage(`Agent 启动失败：${errorMessage(error)}`);
    }
  }

  async function handleAgentTerminalInput(jobId: string, data: string) {
    const runId = state?.projection?.runId;
    const binding = interactiveAgentTerminals[jobId];
    const terminalBridge = getDesktopTerminalBridge();
    if (!runId || !binding || !terminalBridge) {
      setOperationMessage("Agent 交互终端尚未就绪。");
      return;
    }
    try {
      if (data === "\u0003") {
        await terminalBridge.interrupt(binding.desktopSessionId);
        await client.recordInteractiveAgentInput(runId, jobId, "Ctrl+C", now());
        setOperationMessage(`已中断 Agent：${jobId}`);
        return;
      }
      await terminalBridge.writeInput(binding.desktopSessionId, data);
      const completedInputs = collectCompletedTerminalInputs(jobId, data, agentInputBuffersRef.current);
      for (const content of completedInputs) {
        await client.recordInteractiveAgentInput(runId, jobId, content, now());
      }
    } catch (error) {
      setOperationMessage(`发送 Agent 输入失败：${errorMessage(error)}`);
    }
  }

  async function handleAgentTerminalResize(jobId: string, columns: number, rows: number) {
    const binding = interactiveAgentTerminals[jobId];
    const terminalBridge = getDesktopTerminalBridge();
    if (!binding || !terminalBridge || columns < 1 || rows < 1) {
      return;
    }
    await terminalBridge.resize(binding.desktopSessionId, columns, rows).catch(() => undefined);
  }

  async function handleCancelAgent(jobId: string) {
    const runId = state?.projection?.runId;
    if (!runId) {
      return;
    }
    try {
      const terminalBridge = getDesktopTerminalBridge();
      const binding = interactiveAgentTerminals[jobId];
      if (terminalBridge && binding) {
        await terminalBridge.stop(binding.desktopSessionId).catch(() => undefined);
      }
      setLiveAgentOutput((current) => {
        const next = { ...current };
        const runOutput = { ...(next[runId] ?? {}) };
        delete runOutput[jobId];
        next[runId] = runOutput;
        return next;
      });
      const job = await client.cancelAgentJob(runId, jobId, now());
      setInteractiveAgentTerminals((current) => {
        const next = { ...current };
        delete next[jobId];
        return next;
      });
      delete agentInputBuffersRef.current[jobId];
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

  async function handleStartDeployment(nodeId: string) {
    const projection = state?.projection;
    if (!projection) {
      return;
    }
    try {
      const deployment = await client.startDeployment(
        projection.runId,
        nodeId,
        projection.revision,
        now(),
      );
      setDeployments((current) => [
        deployment,
        ...current.filter((candidate) => candidate.id !== deployment.id),
      ]);
      setDeploymentOutput([]);
      await refreshRun(projection.runId);
      setOperationMessage(`部署已启动：${deployment.id}`);
    } catch (error) {
      setOperationMessage(`启动部署失败：${errorMessage(error)}`);
    }
  }

  async function handleCancelDeployment(deploymentId: string) {
    const runId = state?.projection?.runId;
    if (!runId) {
      return;
    }
    try {
      const deployment = await client.cancelDeployment(runId, deploymentId, now());
      setDeployments((current) =>
        current.map((candidate) => (candidate.id === deployment.id ? { ...candidate, ...deployment } : candidate)),
      );
      setOperationMessage(`部署取消请求已提交：${deployment.id}`);
    } catch (error) {
      setOperationMessage(`取消部署失败：${errorMessage(error)}`);
    }
  }

  async function refreshKnowledge() {
    try {
      const [candidates, documents, syntheses] = await Promise.all([
        createRuntimeClient(apiBaseUrl).listKnowledgeCandidates(),
        createRuntimeClient(apiBaseUrl).listKnowledgeDocuments(),
        createRuntimeClient(apiBaseUrl).listKnowledgeSyntheses(),
      ]);
      const synthesisOutput = (
        await Promise.all(
          syntheses.map((synthesis) =>
            createRuntimeClient(apiBaseUrl).listKnowledgeSynthesisOutput(synthesis.id),
          ),
        )
      ).flat();
      setKnowledgeCandidates(candidates);
      setKnowledgeDocuments(documents);
      setKnowledgeSyntheses(syntheses);
      setKnowledgeSynthesisOutput(synthesisOutput);
    } catch (error) {
      setOperationMessage(`读取知识库失败：${errorMessage(error)}`);
    }
  }

  async function handleCreateKnowledgeCandidate(title: string, content: string, source: string) {
    try {
      await createRuntimeClient(apiBaseUrl).createKnowledgeCandidate(title, content, source, now());
      await refreshKnowledge();
      setOperationMessage("知识候选已创建，等待人工审核");
    } catch (error) {
      setOperationMessage(`创建知识候选失败：${errorMessage(error)}`);
    }
  }

  async function handleCreateKnowledgeCandidateFromArtifact(
    runId: string,
    artifact: RuntimeWorkbenchState["artifacts"][number],
  ) {
    try {
      const preview = await createRuntimeClient(apiBaseUrl).previewArtifact(runId, artifact.id);
      if (preview.content === null || !preview.content.trim()) {
        throw new Error("该产物不是可提炼的文本内容，或内容为空。");
      }
      const path = artifact.relativePath ?? artifact.uri;
      const title = artifact.artifactSpecId ?? `${artifact.type} - ${path}`;
      await createRuntimeClient(apiBaseUrl).createKnowledgeCandidate(
        title,
        preview.content,
        `run:${runId}`,
        now(),
      );
      await refreshKnowledge();
      setOperationMessage("已从 Run 产物创建知识候选，可继续启动 CLI 合成。");
    } catch (error) {
      setOperationMessage(`从 Run 产物创建知识候选失败：${errorMessage(error)}`);
      throw error;
    }
  }

  async function handleReviewKnowledgeCandidate(
    candidateId: string,
    decision: "approved" | "rejected",
  ) {
    try {
      await createRuntimeClient(apiBaseUrl).reviewKnowledgeCandidate(
        candidateId,
        decision,
        decision === "approved" ? "人工审核通过" : "人工审核拒绝",
        now(),
      );
      await refreshKnowledge();
      setOperationMessage(decision === "approved" ? "知识候选已批准" : "知识候选已拒绝");
    } catch (error) {
      setOperationMessage(`审核知识候选失败：${errorMessage(error)}`);
    }
  }

  async function handlePublishKnowledgeCandidate(candidateId: string) {
    try {
      await createRuntimeClient(apiBaseUrl).publishKnowledgeCandidate(candidateId, now());
      await refreshKnowledge();
      setOperationMessage("知识已发布并写入审计记录");
    } catch (error) {
      setOperationMessage(`发布知识失败：${errorMessage(error)}`);
    }
  }

  async function handleStartKnowledgeSynthesis(
    candidateId: string,
    provider: KnowledgeSynthesis["provider"],
  ) {
    try {
      await createRuntimeClient(apiBaseUrl).startKnowledgeSynthesis(candidateId, provider, now());
      await refreshKnowledge();
      setOperationMessage("知识 CLI 合成已开始，将在完成后显示差异稿。");
    } catch (error) {
      setOperationMessage(`启动知识 CLI 合成失败：${errorMessage(error)}`);
    }
  }

  async function handleExtractArtifactsToKnowledge(
    runId: string,
    artifactIds: string[],
    provider: KnowledgeSynthesis["provider"],
  ) {
    try {
      const result = await client.extractArtifactsToKnowledgeSyntheses(runId, artifactIds, provider, now());
      await refreshKnowledge();
      setArtifactInventory((current) => [...current]);
      setOperationMessage(`已启动 ${result.items.length} 项产物的 ${provider === "claude" ? "Claude Code" : "Codex"} CLI 合成，可在知识库查看进度与结果。`);
    } catch (error) {
      setOperationMessage(`启动产物 CLI 合成失败：${errorMessage(error)}`);
      throw error;
    }
  }

  async function handleRecordKnowledgeSynthesisFeedback(synthesisId: string, feedback: string) {
    try {
      await createRuntimeClient(apiBaseUrl).recordKnowledgeSynthesisFeedback(synthesisId, feedback, now());
      await refreshKnowledge();
      setOperationMessage("知识合成反馈已保存。");
    } catch (error) {
      setOperationMessage(`保存知识合成反馈失败：${errorMessage(error)}`);
    }
  }

  async function handlePublishKnowledgeSynthesis(synthesisId: string) {
    try {
      await createRuntimeClient(apiBaseUrl).publishKnowledgeSynthesis(synthesisId, now());
      await refreshKnowledge();
      setOperationMessage("知识合成稿已发布并写入审计记录。");
    } catch (error) {
      setOperationMessage(`发布知识合成稿失败：${errorMessage(error)}`);
    }
  }

  async function handleReplayKnowledgeDocument(documentId: string) {
    try {
      const replay = await createRuntimeClient(apiBaseUrl).replayKnowledgeDocument(documentId);
      setKnowledgeReplay(replay);
      setOperationMessage("知识发布记录已回放。");
    } catch (error) {
      setKnowledgeReplay(null);
      setOperationMessage(`回放知识发布记录失败：${errorMessage(error)}`);
    }
  }

  async function exportKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentExport> {
    return createRuntimeClient(apiBaseUrl).exportKnowledgeDocument(documentId);
  }

  async function handlePreviewKnowledgeGit(documentId: string) {
    const git = desktopGitApi();
    const document = knowledgeDocuments.find((candidate) => candidate.id === documentId);
    if (!git || !projectPath.trim() || !document) {
      setOperationMessage("当前项目未启用 Electron Git 工作区，无法预览知识变更。");
      return;
    }
    try {
      const exported = await exportKnowledgeDocument(documentId);
      const preview = await git.previewKnowledgeDocument(projectPath, documentId, exported.content);
      setKnowledgeGitPreview({ documentId, title: document.title, ...preview });
      setOperationMessage(`已生成知识 Git 变更预览：${preview.relativePath}`);
    } catch (error) {
      setKnowledgeGitPreview(null);
      setOperationMessage(`预览知识 Git 变更失败：${errorMessage(error)}`);
    }
  }

  async function handlePublishKnowledgeGit(documentId: string) {
    const git = desktopGitApi();
    const document = knowledgeDocuments.find((candidate) => candidate.id === documentId);
    if (!git || !projectPath.trim() || !document) {
      setOperationMessage("当前项目未启用 Electron Git 工作区，无法提交知识。");
      return;
    }
    setPublishingKnowledgeDocumentId(documentId);
    try {
      const exported = await exportKnowledgeDocument(documentId);
      const published = await git.publishKnowledgeDocument(projectPath, documentId, exported.content);
      await client.recordKnowledgeGitPublication(
        documentId,
        published.branch,
        published.relativePath,
        published.commitHash,
        now(),
      );
      setKnowledgeGitPreview({
        documentId,
        title: document.title,
        relativePath: published.relativePath,
        previousContent: knowledgeGitPreview?.documentId === documentId
          ? knowledgeGitPreview.previousContent
          : "",
        nextContent: exported.content,
      });
      await refreshKnowledge();
      await refreshGitWorkspace();
      setOperationMessage(
        `知识已提交并推送到 ${published.branch}：${published.relativePath}（${published.commitHash}）`,
      );
    } catch (error) {
      setOperationMessage(`提交并推送知识失败：${errorMessage(error)}`);
    } finally {
      setPublishingKnowledgeDocumentId(null);
    }
  }

  async function refreshAuditRecords(action: string) {
    try {
      setAuditRecords(
        await createRuntimeClient(apiBaseUrl).listAuditRecords(action ? { action } : {}),
      );
    } catch (error) {
      setOperationMessage(`读取审计记录失败：${errorMessage(error)}`);
    }
  }

  async function handleRebuildProjection() {
    const runId = state?.projection?.runId;
    if (!runId) {
      return;
    }
    try {
      await client.rebuildProjection(runId, now());
      await refreshRun(runId);
      setOperationMessage(`投影已重建：${runId}`);
    } catch (error) {
      setOperationMessage(`投影重建失败：${errorMessage(error)}`);
    }
  }

  async function handleCleanupOrphanAgentJobs() {
    const runId = state?.projection?.runId;
    if (!runId) {
      return;
    }
    try {
      const result = await client.cleanupOrphanAgentJobs(runId, now());
      await refreshRun(runId);
      const diagnostics = await client.getRecoveryDiagnostics(runId);
      setRecoveryDiagnostics(diagnostics);
      setOperationMessage(`已清理遗留 Agent：${result.cleanedJobIds.length} 个`);
    } catch (error) {
      setOperationMessage(`清理遗留 Agent 失败：${errorMessage(error)}`);
    }
  }

  async function handleCleanupOrphanTerminalSessions() {
    const runId = state?.projection?.runId;
    if (!runId) {
      return;
    }
    try {
      const result = await client.cleanupOrphanTerminalSessions(runId, now());
      await refreshRun(runId);
      const diagnostics = await client.getRecoveryDiagnostics(runId);
      setRecoveryDiagnostics(diagnostics);
      setOperationMessage(`已清理遗留终端：${result.cleanedSessionIds.length} 个`);
    } catch (error) {
      setOperationMessage(`清理遗留终端失败：${errorMessage(error)}`);
    }
  }

  async function handleResumeAgentCheckpoint(checkpointId: string) {
    const runId = state?.projection?.runId;
    if (!runId) {
      return;
    }
    try {
      const job = await client.resumeAgentCheckpoint(runId, checkpointId, now());
      await refreshRun(runId);
      setRecoveryDiagnostics(await client.getRecoveryDiagnostics(runId));
      setOperationMessage(`已从 checkpoint 恢复 Agent：${job.id}`);
    } catch (error) {
      setOperationMessage(`恢复 Agent checkpoint 失败：${errorMessage(error)}`);
    }
  }

  async function handleDiscardAgentCheckpoint(checkpointId: string) {
    const runId = state?.projection?.runId;
    if (!runId) {
      return;
    }
    try {
      await client.discardAgentCheckpoint(runId, checkpointId, now());
      setRecoveryDiagnostics(await client.getRecoveryDiagnostics(runId));
      setOperationMessage(`已放弃 Agent checkpoint：${checkpointId}`);
    } catch (error) {
      setOperationMessage(`放弃 Agent checkpoint 失败：${errorMessage(error)}`);
    }
  }

  async function handlePreviewArtifact(runId: string, artifactId: string) {
    try {
      const preview = await createRuntimeClient(apiBaseUrl).previewArtifact(runId, artifactId);
      setArtifactPreview(preview);
      setOperationMessage(
        preview.integrity === "changed" ? "产物内容已变更，请重新审核。" : "产物预览已加载。",
      );
    } catch (error) {
      setOperationMessage(`读取产物预览失败：${errorMessage(error)}`);
    }
  }

  async function handleCompareArtifacts(beforeRunId: string, beforeArtifactId: string, afterRunId: string, afterArtifactId: string) {
    try {
      const [before, after] = await Promise.all([
        createRuntimeClient(apiBaseUrl).previewArtifact(beforeRunId, beforeArtifactId),
        createRuntimeClient(apiBaseUrl).previewArtifact(afterRunId, afterArtifactId),
      ]);
      if (before.integrity !== "verified" || after.integrity !== "verified") {
        throw new Error("产物内容已变更，不能生成可信差异");
      }
      if (before.truncated || after.truncated) {
        throw new Error("产物预览已截断，不能生成完整差异");
      }
      if (before.content === null || after.content === null) {
        throw new Error("二进制产物不支持文本差异比较");
      }
      setArtifactComparison({
        before: { id: before.id, content: before.content },
        after: { id: after.id, content: after.content },
      });
      setOperationMessage("产物文本差异已加载。");
    } catch (error) {
      setArtifactComparison(null);
      setOperationMessage(`比较产物失败：${errorMessage(error)}`);
    }
  }

  async function handleDownloadEvidencePackage() {
    const runId = state?.projection?.runId;
    if (!runId) {
      return;
    }
    try {
      const evidencePackage = await createRuntimeClient(apiBaseUrl).getEvidencePackage(runId);
      downloadTextFile(
        `${runId}-evidence-package.json`,
        JSON.stringify(evidencePackage, null, 2),
        "application/json",
      );
      setOperationMessage("证据包已下载。");
    } catch (error) {
      setOperationMessage(`下载证据包失败：${errorMessage(error)}`);
    }
  }

  async function handleDownloadRunReport() {
    const runId = state?.projection?.runId;
    if (!runId) {
      return;
    }
    try {
      const report = await createRuntimeClient(apiBaseUrl).getRunReport(runId);
      downloadTextFile(report.fileName, report.content, report.mediaType);
      setOperationMessage("运行报告已下载。");
    } catch (error) {
      setOperationMessage(`下载运行报告失败：${errorMessage(error)}`);
    }
  }

  async function handleDownloadDiagnostics() {
    try {
      const bundle = await createRuntimeClient(apiBaseUrl).getDiagnosticSupportBundle();
      downloadTextFile(bundle.fileName, bundle.content, bundle.mediaType);
      setOperationMessage("诊断支持包已下载。");
    } catch (error) {
      setOperationMessage(`下载诊断支持包失败：${errorMessage(error)}`);
    }
  }

  async function handleSaveWorkflowDefinition(definition: WorkflowDefinitionSummary) {
    if (!workflowVersionId) {
      return;
    }
    try {
      const saved = await client.saveWorkflowVersion(workflowVersionId, definition, now());
      setWorkflowVersionId(saved.workflowVersionId);
      setWorkflowDefinition(saved.definition);
      setCompiledWorkflow(saved.compiled);
      setWorkflowSimulation(null);
      setWorkflowDiff(null);
      saveWorkspaceSession({
        ...loadWorkspaceSession(),
        apiBaseUrl,
        projectPath,
        projectId,
        workflowVersionId: saved.workflowVersionId,
        projectName: state?.projectName ?? "",
        workflowName: saved.definition.name,
      });
      setOperationMessage(`工作流新版本已保存：${saved.definition.version}`);
    } catch (error) {
      setOperationMessage(`保存工作流版本失败：${errorMessage(error)}`);
      throw error;
    }
  }

  async function handleSimulateWorkflowDefinition() {
    if (!workflowVersionId) {
      return;
    }
    try {
      const simulation = await client.simulateWorkflowDefinition(workflowVersionId);
      setWorkflowSimulation(simulation);
      setOperationMessage(
        simulation.status === "ready" ? "工作流模拟完成，可创建 Run。" : "工作流模拟发现阻塞项。",
      );
    } catch (error) {
      setOperationMessage(`模拟工作流版本失败：${errorMessage(error)}`);
    }
  }

  async function handleCompareWorkflowVersion(againstWorkflowVersionId: string) {
    if (!workflowVersionId) {
      return;
    }
    try {
      const diff = await client.diffWorkflowVersions(workflowVersionId, againstWorkflowVersionId);
      setWorkflowDiff(diff);
      setOperationMessage("工作流版本差异已加载。");
    } catch (error) {
      setOperationMessage(`读取工作流版本差异失败：${errorMessage(error)}`);
    }
  }

  async function handleRestoreWorkflowVersion(historicalWorkflowVersionId: string) {
    if (!workflowVersionId) {
      return;
    }
    try {
      const historicalDefinition = await client.getWorkflowDefinition(historicalWorkflowVersionId);
      await handleSaveWorkflowDefinition(historicalDefinition);
      setOperationMessage(`已从历史版本恢复并创建新版本：${historicalDefinition.version}`);
    } catch (error) {
      setOperationMessage(`恢复工作流历史版本失败：${errorMessage(error)}`);
    }
  }

  async function handleExportWorkflowVersion(format: WorkflowExportFormat) {
    if (!workflowVersionId) {
      return;
    }
    try {
      const exported = await client.exportWorkflowVersion(workflowVersionId, format);
      downloadTextFile(exported.fileName, exported.content, exported.mediaType);
      setOperationMessage(`工作流已导出：${exported.fileName}`);
    } catch (error) {
      setOperationMessage(`导出工作流失败：${errorMessage(error)}`);
    }
  }

  async function handleArchiveProject() {
    if (!projectId) {
      setOperationMessage("当前项目缺少归档标识，请重新导入后再试。");
      return;
    }
    try {
      await client.archiveProject(projectId, now());
      setProjectArchived(true);
      setOperationMessage("项目已归档；重新导入同一路径即可恢复为活动状态。");
    } catch (error) {
      setOperationMessage(`归档项目失败：${errorMessage(error)}`);
    }
  }

  async function handleApprovalDecision(
    nodeId: string,
    decision: "approved" | "rejected" | "deferred",
    comment: string,
  ) {
    const messageByDecision = {
      approved: "审批已批准",
      rejected: "审批已拒绝",
      deferred: "审批已暂缓",
    };
    await updateProjection(
      (runId, revision, timestamp) =>
        client.decideApproval(runId, nodeId, decision, comment, revision, timestamp),
      `${messageByDecision[decision]}：${nodeId}`,
    );
  }

  return (
    <div className="app-shell">
      <Navigation currentRoute={currentRoute} />
      <main className="workbench" aria-labelledby="app-title">
        <header className="workbench-header">
          <div>
            <p className="section-kicker">AI WORKFLOW PLATFORM</p>
            <h1 id="app-title">AI Workflow 工作台</h1>
          </div>
          <div className="run-summary" aria-label="当前运行摘要">
            <span>当前 Run 状态</span>
            <strong>{runStatus}</strong>
            <span>{connectionText}</span>
          </div>
        </header>
        <div className="content-grid">
          {currentRoute === "projects" ? (
            <ProjectDashboard
              state={state}
              projectPath={projectPath}
              onProjectPathChange={setProjectPath}
              onImport={handleImportProject}
              onSelectDirectory={desktopProjectApi() ? () => void handleSelectProjectDirectory() : undefined}
              onArchive={projectId ? handleArchiveProject : undefined}
              archived={projectArchived}
              onReimport={projectArchived ? handleImportProject : undefined}
              operationMessage={operationMessage}
              gitPanel={
                desktopGitApi() ? (
                  <GitWorkspacePanel
                    projectPath={projectPath}
                    status={gitWorkspaceStatus}
                    worktrees={gitWorktrees}
                    onRefresh={() => void refreshGitWorkspace()}
                    onCreateWorktree={(branch) => void handleCreateGitWorktree(branch)}
                    onRemoveWorktree={(worktreePath) => void handleRemoveGitWorktree(worktreePath)}
                    onMergeBack={(branch) => void handleMergeGitWorktree(branch)}
                    onPush={() => void handlePushGitBranch()}
                  />
                ) : null
              }
            />
          ) : null}
          {currentRoute === "runs" ? (
          <RunDashboard
            state={state}
            workflow={workflowDefinition}
              runs={runs}
              activeRunId={activeRunId}
              onSelectRun={handleSelectRun}
              onCreateRun={handleCreateRun}
            onStartNode={(selectedNodeId) =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.startNode(runId, selectedNodeId, revision, timestamp),
                `节点已启动：${selectedNodeId}`,
              )
            }
            onCompleteNode={(selectedNodeId) =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.completeNode(runId, selectedNodeId, revision, timestamp),
                `节点已完成：${selectedNodeId}`,
              )
            }
            onScanNodeArtifacts={(selectedNodeId) =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.scanNodeArtifacts(runId, selectedNodeId, revision, timestamp)
                    .then((result) => result.projection),
                `已检查节点产物：${selectedNodeId}`,
              )
            }
            onLoadNodeArtifactRequirements={(selectedNodeId) => {
              const runId = state?.projection?.runId;
              return runId
                ? client.getNodeArtifactRequirements(runId, selectedNodeId)
                : Promise.reject(new Error("当前没有可用 Run"));
            }}
            onLoadNodeContext={(selectedNodeId) => {
              const runId = state?.projection?.runId;
              return runId
                ? client.getNodeContext(runId, selectedNodeId)
                : Promise.reject(new Error("当前没有可用 Run"));
            }}
            onSubmitArtifact={(selectedNodeId, selectedArtifactPath, selectedArtifactType) =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.submitArtifact(
                    runId,
                    selectedNodeId,
                    selectedArtifactPath,
                    selectedArtifactType,
                    revision,
                    timestamp,
                  ),
                `Artifact 已提交：${selectedNodeId}`,
              )
            }
            onApprove={(selectedNodeId) =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.decideApproval(
                    runId,
                    selectedNodeId,
                    "approved",
                    "中文审批",
                    revision,
                    timestamp,
                  ),
                `审批已通过：${selectedNodeId}`,
              )
            }
            onPassGate={(selectedNodeId, selectedArtifactUri) =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.submitGate(
                    runId,
                    selectedNodeId,
                    "plan-ready",
                    "passed",
                    [selectedArtifactUri],
                    null,
                    revision,
                    timestamp,
                  ),
                `Gate 已通过：${selectedNodeId}`,
              )
            }
            onWaiveGate={(selectedNodeId, waiverReason) =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.submitGate(
                    runId,
                    selectedNodeId,
                    "plan-ready",
                    "waived",
                    [],
                    waiverReason,
                    revision,
                    timestamp,
                  ),
                `Gate 已豁免：${selectedNodeId}`,
              )
            }
            onPauseRun={() =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.controlRun(runId, "RUN_PAUSED", revision, timestamp),
                "Run 已暂停。",
              )
            }
            onResumeRun={() =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.controlRun(runId, "RUN_RESUMED", revision, timestamp),
                "Run 已恢复。",
              )
            }
            onArchiveRun={() =>
              updateProjection(
                (runId, revision, timestamp) =>
                  client.controlRun(runId, "RUN_ARCHIVED", revision, timestamp),
                "Run 已归档。",
              )
            }
            onStartAgent={handleStartAgent}
            agentWorkspaces={[
              { path: gitWorkspaceStatus?.rootPath ?? projectPath, label: `${gitWorkspaceStatus?.branch ?? "main"}（主工作区）` },
              ...gitWorktrees
                .filter((worktree) => !worktree.bare && worktree.path !== (gitWorkspaceStatus?.rootPath ?? projectPath))
                .map((worktree) => ({ path: worktree.path, label: `${worktree.branch ?? "分离 HEAD"}（Worktree）` })),
            ]}
            onCancelAgent={handleCancelAgent}
            onAgentTerminalInput={handleAgentTerminalInput}
            onAgentTerminalResize={handleAgentTerminalResize}
            liveAgentOutput={activeRunId ? liveAgentOutput[activeRunId] ?? {} : {}}
            deployments={deployments}
            deploymentOutput={deploymentOutput}
            onStartDeployment={handleStartDeployment}
            onCancelDeployment={handleCancelDeployment}
            operationMessage={operationMessage}
            providerDiagnostics={providerDiagnostics}
            />
          ) : null}
          {currentRoute === "workflow" ? (
            <WorkflowViewer
              state={state}
              workflow={workflowDefinition}
              compiled={compiledWorkflow}
              simulation={workflowSimulation}
              history={workflowHistory}
              diff={workflowDiff}
              workflowVersionId={workflowVersionId}
              onSaveDefinition={handleSaveWorkflowDefinition}
              onSimulate={handleSimulateWorkflowDefinition}
              onCompareVersion={handleCompareWorkflowVersion}
              onRestoreVersion={handleRestoreWorkflowVersion}
              onExportWorkflow={handleExportWorkflowVersion}
            />
          ) : null}
          {currentRoute === "terminal" ? (
            <TerminalPage
              runId={state?.projection?.runId ?? null}
              projectPath={projectPath}
              executionWorkspace={runs.find((run) => run.id === state?.projection?.runId)?.context?.executionWorkspace ?? projectPath}
              nodeId={state?.projection?.currentNodeIds[0] ?? ""}
              historySessions={terminalSessions}
              onRegisterSession={async ({ runId, nodeId, kind, cwd, pid }) => {
                const registered = await client.registerTerminalSession(
                  runId,
                  nodeId,
                  kind,
                  cwd,
                  pid,
                  now(),
                );
                setTerminalSessions(await client.listTerminalSessions(runId));
                return registered;
              }}
              onStopSession={async ({ runId, sessionId }) => {
                await client.stopTerminalSession(runId, sessionId, now());
                setTerminalSessions(await client.listTerminalSessions(runId));
              }}
              onAppendOutput={async ({ runId, sessionId, stream, data }) => {
                await client.appendTerminalOutput(runId, sessionId, stream, data, now());
              }}
              onLoadHistoryOutput={async (sessionId): Promise<TerminalOutputEvent[]> => {
                const runId = state?.projection?.runId;
                return runId ? client.listTerminalOutput(runId, sessionId) : [];
              }}
              onExportEvidence={async ({ runId, sessionId }) => {
                await client.exportTerminalEvidence(runId, sessionId, now());
                const artifacts = await client.listArtifacts(runId);
                setState((current) =>
                  current?.projection?.runId === runId ? { ...current, artifacts } : current,
                );
                setOperationMessage("终端输出已转为 Evidence");
              }}
            />
          ) : null}
          {currentRoute === "gates" ? (
            <GatesPage
              state={state}
              onRetryGate={(nodeId) =>
                updateProjection(
                  (runId, revision, timestamp) =>
                    client.retryGate(runId, nodeId, revision, timestamp),
                  "Gate 已进入重试复核",
                )
              }
              onDownloadGateReport={handleDownloadRunReport}
              onWaiveGate={(nodeId, gateId, waiverReason) =>
                updateProjection(
                  (runId, revision, timestamp) =>
                    client.submitGate(
                      runId,
                      nodeId,
                      gateId,
                      "waived",
                      [],
                      waiverReason,
                      revision,
                      timestamp,
                    ),
                  `Gate 已豁免：${nodeId}`,
                )
              }
            />
          ) : null}
          {currentRoute === "artifacts" ? (
            <ArtifactsPage
              state={state}
              artifacts={artifactInventory}
              runs={runs}
              extractionCountsByArtifactId={Object.fromEntries(
                knowledgeCandidates.reduce((counts, candidate) => {
                  const matched = /^run:[^:]+:artifact:(.+)$/.exec(candidate.source);
                  if (matched) counts.set(matched[1], (counts.get(matched[1]) ?? 0) + 1);
                  return counts;
                }, new Map<string, number>()),
              )}
              preview={artifactPreview}
              onClosePreview={() => setArtifactPreview(null)}
              onPreviewArtifact={handlePreviewArtifact}
              comparison={artifactComparison}
              onCompareArtifacts={handleCompareArtifacts}
              onDownloadEvidencePackage={handleDownloadEvidencePackage}
              onDownloadReport={handleDownloadRunReport}
              onStartKnowledgeExtraction={handleExtractArtifactsToKnowledge}
              onConfirmArtifact={(runId, artifact) => {
                if (!artifact.nodeId) {
                  return;
                }
                void updateProjection(
                  (activeRunId, revision, timestamp) => {
                    if (activeRunId !== runId) throw new Error("请先切换到该产物所属 Run 后确认产物。");
                    return client.confirmArtifact(activeRunId, artifact.nodeId!, artifact.id, revision, timestamp)
                      .then((result) => result.projection);
                  },
                  `产物已确认：${artifact.id}`,
                );
              }}
              onLoadArtifactConsumers={(runId, artifactId) => client.listArtifactConsumers(runId, artifactId)}
            />
          ) : null}
          {currentRoute === "approvals" ? (
            <ApprovalInbox state={state} onDecide={handleApprovalDecision} />
          ) : null}
          {currentRoute === "knowledge" ? (
            <KnowledgePage
              candidates={knowledgeCandidates}
              documents={knowledgeDocuments}
              syntheses={knowledgeSyntheses}
              synthesisOutput={knowledgeSynthesisOutput}
              replay={knowledgeReplay}
              runs={runs}
              activeRunId={activeRunId}
              onCreate={handleCreateKnowledgeCandidate}
              onReview={handleReviewKnowledgeCandidate}
              onPublish={handlePublishKnowledgeCandidate}
              onFeedbackSynthesis={handleRecordKnowledgeSynthesisFeedback}
              onPublishSynthesis={handlePublishKnowledgeSynthesis}
              onReplay={handleReplayKnowledgeDocument}
              gitAvailable={Boolean(desktopGitApi() && projectPath.trim())}
              onPreviewGit={handlePreviewKnowledgeGit}
              onPublishGit={handlePublishKnowledgeGit}
              publishingDocumentId={publishingKnowledgeDocumentId}
              gitPreview={knowledgeGitPreview}
              operationMessage={operationMessage}
            />
          ) : null}
          {currentRoute === "audit" ? (
            <AuditPage records={auditRecords} onFilter={refreshAuditRecords} />
          ) : null}
          {currentRoute === "recovery" ? (
            <RecoveryPage
              state={state}
              diagnostics={recoveryDiagnostics}
              onRebuild={handleRebuildProjection}
              onCleanupOrphans={handleCleanupOrphanAgentJobs}
              onCleanupTerminalSessions={handleCleanupOrphanTerminalSessions}
              onResumeAgentCheckpoint={handleResumeAgentCheckpoint}
              onDiscardAgentCheckpoint={handleDiscardAgentCheckpoint}
              operationMessage={operationMessage}
            />
          ) : null}
          {currentRoute === "settings" ? (
            <SettingsPage
              apiBaseUrl={apiBaseUrl}
              connection={state?.connection ?? "unavailable"}
              onApiBaseUrlChange={handleApiBaseUrlChange}
              onCheckConnection={handleCheckRuntimeConnection}
              managedRuntime={managedRuntime}
              runtimeLogs={runtimeLogs}
              onRestartManagedRuntime={managedRuntime ? handleRestartManagedRuntime : undefined}
              onDownloadDiagnostics={handleDownloadDiagnostics}
              operationMessage={operationMessage}
              providerDiagnostics={providerDiagnostics}
              onRefreshProviderDiagnostics={refreshProviderDiagnostics}
            />
          ) : null}
        </div>
      </main>
    </div>
  );
}

function fallbackState(): RuntimeWorkbenchState {
  return {
    connection: "unavailable",
    workspaceStatus: "uninitialized",
    projectName: "未导入",
    workflowName: "未导入",
    projection: null,
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

function downloadTextFile(fileName: string, content: string, mediaType: string) {
  const downloadUrl = URL.createObjectURL(
    new Blob([content], { type: `${mediaType};charset=utf-8` }),
  );
  const link = document.createElement("a");
  link.href = downloadUrl;
  link.download = fileName;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(downloadUrl);
}

function collectCompletedTerminalInputs(
  jobId: string,
  data: string,
  buffers: Record<string, string>,
): string[] {
  const completed: string[] = [];
  let current = buffers[jobId] ?? "";
  for (const character of data) {
    if (character === "\r" || character === "\n") {
      const trimmed = current.trim();
      if (trimmed) {
        completed.push(trimmed);
      }
      current = "";
      continue;
    }
    if (character === "\u007f") {
      current = current.slice(0, -1);
      continue;
    }
    if (!/[\u0000-\u001f\u007f]/.test(character)) {
      current += character;
    }
  }
  buffers[jobId] = current;
  return completed;
}

type DesktopRuntimeBridge = {
  status(): Promise<ManagedRuntimeStatus>;
  restart(): Promise<ManagedRuntimeStatus>;
  logs(): Promise<RuntimeLogEntry[]>;
};

type DesktopTerminalBridge = {
  create(request: {
    kind: "shell" | "codex" | "claude";
    cwd: string;
    projectRoot: string;
    columns: number;
    rows: number;
    initialPrompt?: string;
  }): Promise<{
    id: string;
    kind: "shell" | "codex" | "claude";
    cwd: string;
    pid: number;
    columns: number;
    rows: number;
  }>;
  read(sessionId: string, afterSequence: number): Promise<Array<{ sequence: number; data: string }>>;
  resize(
    sessionId: string,
    columns: number,
    rows: number,
  ): Promise<{ columns: number; rows: number }>;
  onOutput?(
    sessionId: string,
    listener: (event: { sequence: number; data: string }) => void,
  ): () => void;
  writeInput(sessionId: string, data: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
};

type InteractiveAgentTerminalBinding = {
  desktopSessionId: string;
  pid: number;
  afterSequence: number;
  persistenceLimited?: boolean;
};

function getDesktopRuntimeBridge(): DesktopRuntimeBridge | null {
  const candidate = (window as Window & { workflowRuntime?: DesktopRuntimeBridge }).workflowRuntime;
  return candidate ?? null;
}

function getDesktopTerminalBridge(): DesktopTerminalBridge | null {
  const candidate = (window as Window & { workflowTerminal?: DesktopTerminalBridge }).workflowTerminal;
  return candidate ?? null;
}
