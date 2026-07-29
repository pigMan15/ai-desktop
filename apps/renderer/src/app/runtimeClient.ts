import type { RunProjection } from "@workflow-platform/contracts";

export type RuntimeWorkbenchState = {
  connection: "connected" | "unavailable";
  workspaceStatus: "uninitialized" | "ready";
  projectName: string;
  workflowName: string;
  projection: RunProjection | null;
  timeline: Array<{ id: string; type: string; nodeId?: string; createdAt: string }>;
  artifacts: Array<{ id: string; type: string; uri: string; contentHash: string }>;
  approvals: Array<{ id: string; status: string; comment?: string }>;
  gates: Array<{
    id: string;
    nodeId?: string;
    gateId?: string;
    status: string;
    evidence: string[];
    waiverReason?: string | null;
    failureReason?: string | null;
    actor?: { id?: string; type?: string };
    createdAt?: string;
  }>;
  agentJobs: AgentJobSummary[];
  agentOutput: AgentOutputSummary[];
};

type RuntimeImportResult = {
  projectId: string;
  workflowVersionId: string;
  workflowId?: string;
  workflowName?: string;
};

export type AgentJobSummary = {
  id: string;
  runId: string;
  nodeId: string;
  provider: "codex" | "claude" | "fake";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  command: string[];
  cwd: string;
  pid?: number | null;
  summary?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentOutputSummary = {
  id: string;
  jobId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AgentProviderDiagnostic = {
  id: "codex" | "claude";
  executable: string;
  available: boolean;
  path: string | null;
  version: string | null;
  message: string;
};

export type ArtifactPreview = {
  id: string;
  uri: string;
  contentHash: string;
  currentHash: string;
  integrity: "verified" | "changed";
  mediaType: string;
  sizeBytes: number;
  truncated: boolean;
  content: string | null;
};

export type EvidencePackage = {
  schemaVersion: number;
  runId: string;
  projection: RunProjection;
  timeline: RuntimeWorkbenchState["timeline"];
  artifacts: RuntimeWorkbenchState["artifacts"];
  approvals: RuntimeWorkbenchState["approvals"];
  gates: RuntimeWorkbenchState["gates"];
};

export type RuntimeReport = {
  fileName: string;
  mediaType: "text/markdown";
  content: string;
};

export type DiagnosticSupportBundle = {
  fileName: string;
  mediaType: "application/json";
  content: string;
};

export type WorkflowDefinitionSummary = {
  id: string;
  name: string;
  version: string;
  sourceAdapter: string;
  nodes: Array<{ id: string; name: string; kind: string }>;
  edges: Array<{ id: string; from: string; to: string }>;
  roles: Array<{ id: string; name: string }>;
  gates: Array<{
    id: string;
    name: string;
    description?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  policies: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type CompiledWorkflowSummary = {
  diagnostics: Array<{ code: string; message: string; nodeId?: string; edgeId?: string }>;
  graphSpec: {
    nodes: Array<{ id: string; label: string; kind: string }>;
    edges: Array<{ id: string; from: string; to: string }>;
  };
};

export type WorkflowSimulation = {
  status: "ready" | "blocked";
  diagnostics: Array<{ code: string; message: string; nodeId?: string; edgeId?: string }>;
  steps: Array<{ nodeId: string; state: string }>;
};

export type WorkflowVersionSummary = {
  id: string;
  name: string;
  version: string;
  contentHash: string;
  createdAt: string;
};

export type WorkflowExportFormat = "canonical-json" | "generic-yaml";

export type WorkflowVersionExport = {
  fileName: string;
  mediaType: "application/json" | "application/x-yaml";
  content: string;
};

export type ProjectArchive = {
  projectId: string;
  archived: boolean;
  archivedAt: string;
};

export type WorkflowVersionDiff = {
  fromVersionId: string;
  toVersionId: string;
  addedNodes: Array<Record<string, unknown>>;
  removedNodes: Array<Record<string, unknown>>;
  changedNodes: Array<{
    id: string;
    changes: Record<string, { from: unknown; to: unknown }>;
  }>;
  addedEdges: Array<Record<string, unknown>>;
  removedEdges: Array<Record<string, unknown>>;
  changedEdges: Array<{
    id: string;
    changes: Record<string, { from: unknown; to: unknown }>;
  }>;
};

export type RecoveryDiagnostics = {
  runId: string;
  eventCount: number;
  projectionStatus: string;
  orphanAgentJobIds: string[];
  orphanTerminalSessionIds: string[];
  recoverableAgentCheckpointIds: string[];
  rebuildAvailable: boolean;
};

export type TerminalSessionSummary = {
  id: string;
  runId: string;
  nodeId: string;
  kind: "shell" | "codex";
  status: "running" | "stopped";
  cwd: string;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
};

export type TerminalOutputEvent = {
  sequence: number;
  stream: "stdout" | "stderr";
  data: string;
  createdAt: string;
};

export type SavedWorkflowVersion = {
  workflowVersionId: string;
  definition: WorkflowDefinitionSummary;
  compiled: CompiledWorkflowSummary;
};

export type RunSummary = {
  id: string;
  title: string;
  context?: RunConfiguration;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type RunConfiguration = {
  taskGoal: string;
  parameters: Record<string, unknown>;
};

export type DeploymentSummary = {
  id: string;
  runId: string;
  nodeId: string;
  command: string[];
  cwd: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  pid: number | null;
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeploymentOutputEvent = {
  id: string;
  deploymentId: string;
  sequence: number;
  data: string;
  createdAt: string;
};

export type KnowledgeCandidate = {
  id: string;
  title: string;
  content: string;
  source: string;
  status: "pending" | "approved" | "rejected";
  createdBy?: { id: string; type: string };
  createdAt: string;
  reviewer?: { id: string; type: string } | null;
  reviewComment?: string | null;
  reviewedAt?: string | null;
  publishedAt?: string | null;
};

export type KnowledgeDocument = {
  id: string;
  candidateId: string;
  title: string;
  content: string;
  source: string;
  status: "published";
  publishedAt: string;
  gitPublicationCount: number;
  latestGitPublication: {
    branch: string;
    relativePath: string;
    commitHash: string;
    pushedAt: string;
  } | null;
};

export type KnowledgeSynthesis = {
  id: string;
  candidateId: string;
  provider: "codex" | "claude" | "fake";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  prompt: string;
  summary: string | null;
  error: string | null;
  feedback: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeSynthesisOutputEvent = {
  id: string;
  synthesisId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type KnowledgeDocumentReplay = {
  document: KnowledgeDocument;
  candidate: KnowledgeCandidate;
  auditRecords: AuditRecord[];
};

export type KnowledgeDocumentExport = {
  fileName: string;
  mediaType: "text/markdown";
  content: string;
};

export type AuditRecord = {
  id: string;
  actor: { id: string; type: string; source: string; trusted: boolean };
  action: string;
  resource: string;
  detail: Record<string, unknown>;
  previousHash: string | null;
  recordHash: string;
  createdAt: string;
};

export type SavedWorkspaceContext = {
  apiBaseUrl: string;
  projectPath: string;
  projectName: string;
  workflowName: string;
  runId: string;
};

const RUNTIME_API_BASE_URL =
  import.meta.env.VITE_RUNTIME_API_BASE_URL ?? "http://127.0.0.1:8765";

const AGENT_ACTOR = { id: "renderer-agent", type: "agent", source: "renderer", trusted: false };
const HUMAN_ACTOR = { id: "renderer-human", type: "human", source: "runtime", trusted: true };
const VERIFIER_ACTOR = {
  id: "renderer-verifier",
  type: "verifier",
  source: "runtime",
  trusted: true,
};

export async function loadWorkbenchState(
  apiBaseUrl = readRuntimeConfig().apiBaseUrl,
): Promise<RuntimeWorkbenchState> {
  try {
    await createRuntimeClient(apiBaseUrl).health();
    return emptyWorkbenchState("connected");
  } catch {
    return emptyWorkbenchState("unavailable");
  }
}

export async function restoreWorkbenchState(
  context: SavedWorkspaceContext,
): Promise<RuntimeWorkbenchState> {
  const client = createRuntimeClient(context.apiBaseUrl);
  await client.health();

  const [projection, timeline, artifacts, approvals, gates, agentJobs] = await Promise.all([
    client.getProjection(context.runId),
    client.getTimeline(context.runId),
    client.listArtifacts(context.runId),
    client.listApprovals(context.runId),
    client.listGates(context.runId),
    client.listAgentJobs(context.runId),
  ]);

  return {
    connection: "connected",
    workspaceStatus: "ready",
    projectName: context.projectName,
    workflowName: context.workflowName,
    projection,
    timeline,
    artifacts,
    approvals,
    gates,
    agentJobs,
    agentOutput: [],
  };
}

export function createRuntimeClient(apiBaseUrl: string) {
  return {
    health: () => request(apiBaseUrl, "/health"),
    listAgentProviders: () =>
      request<AgentProviderDiagnostic[]>(apiBaseUrl, "/agents/providers"),
    getWorkflowDefinition: (workflowVersionId: string) =>
      request<WorkflowDefinitionSummary>(apiBaseUrl, `/workflow-versions/${workflowVersionId}`),
    compileWorkflowDefinition: (workflowVersionId: string) =>
      request<CompiledWorkflowSummary>(apiBaseUrl, `/workflow-versions/${workflowVersionId}/compile`, {}),
    simulateWorkflowDefinition: (workflowVersionId: string) =>
      request<WorkflowSimulation>(apiBaseUrl, `/workflow-versions/${workflowVersionId}/simulate`, {}),
    listWorkflowVersionHistory: (workflowVersionId: string) =>
      request<WorkflowVersionSummary[]>(apiBaseUrl, `/workflow-versions/${workflowVersionId}/history`),
    exportWorkflowVersion: (
      workflowVersionId: string,
      format: WorkflowExportFormat,
    ) =>
      request<WorkflowVersionExport>(
        apiBaseUrl,
        `/workflow-versions/${encodeURIComponent(workflowVersionId)}/export?format=${encodeURIComponent(format)}`,
      ),
    diffWorkflowVersions: (workflowVersionId: string, againstWorkflowVersionId: string) =>
      request<WorkflowVersionDiff>(
        apiBaseUrl,
        `/workflow-versions/${workflowVersionId}/diff?against=${encodeURIComponent(againstWorkflowVersionId)}`,
      ),
    saveWorkflowVersion: (
      workflowVersionId: string,
      definition: WorkflowDefinitionSummary,
      now: string,
    ) =>
      request<SavedWorkflowVersion>(apiBaseUrl, `/workflow-versions/${workflowVersionId}/save`, {
        definition,
        actor: HUMAN_ACTOR,
        now,
      }),
    createKnowledgeCandidate: (
      title: string,
      content: string,
      source: string,
      now: string,
    ) =>
      request<KnowledgeCandidate>(apiBaseUrl, "/knowledge/candidates", {
        title,
        content,
        source,
        actor: HUMAN_ACTOR,
        now,
      }),
    listKnowledgeCandidates: (status?: KnowledgeCandidate["status"]) =>
      request<KnowledgeCandidate[]>(
        apiBaseUrl,
        status ? `/knowledge/candidates?status=${encodeURIComponent(status)}` : "/knowledge/candidates",
      ),
    reviewKnowledgeCandidate: (
      candidateId: string,
      decision: "approved" | "rejected",
      comment: string,
      now: string,
    ) =>
      request<KnowledgeCandidate>(apiBaseUrl, `/knowledge/candidates/${candidateId}/review`, {
        decision,
        actor: HUMAN_ACTOR,
        comment,
        now,
      }),
    publishKnowledgeCandidate: (candidateId: string, now: string) =>
      request<KnowledgeDocument>(apiBaseUrl, `/knowledge/candidates/${candidateId}/publish`, {
        actor: HUMAN_ACTOR,
        now,
      }),
    startKnowledgeSynthesis: (
      candidateId: string,
      provider: KnowledgeSynthesis["provider"],
      now: string,
    ) =>
      request<KnowledgeSynthesis>(apiBaseUrl, `/knowledge/candidates/${candidateId}/syntheses`, {
        provider,
        actor: HUMAN_ACTOR,
        now,
      }),
    listKnowledgeSyntheses: () =>
      request<KnowledgeSynthesis[]>(apiBaseUrl, "/knowledge/syntheses"),
    listKnowledgeSynthesisOutput: (synthesisId: string, afterSequence = 0) =>
      request<KnowledgeSynthesisOutputEvent[]>(
        apiBaseUrl,
        `/knowledge/syntheses/${synthesisId}/output?afterSequence=${afterSequence}`,
      ),
    recordKnowledgeSynthesisFeedback: (synthesisId: string, feedback: string, now: string) =>
      request<KnowledgeSynthesis>(apiBaseUrl, `/knowledge/syntheses/${synthesisId}/feedback`, {
        feedback,
        actor: HUMAN_ACTOR,
        now,
      }),
    publishKnowledgeSynthesis: (synthesisId: string, now: string) =>
      request<KnowledgeDocument>(apiBaseUrl, `/knowledge/syntheses/${synthesisId}/publish`, {
        actor: HUMAN_ACTOR,
        now,
      }),
    listKnowledgeDocuments: () =>
      request<KnowledgeDocument[]>(apiBaseUrl, "/knowledge/documents"),
    searchKnowledge: (query: string) =>
      request<KnowledgeDocument[]>(apiBaseUrl, `/knowledge/search?query=${encodeURIComponent(query)}`),
    replayKnowledgeDocument: (documentId: string) =>
      request<KnowledgeDocumentReplay>(
        apiBaseUrl,
        `/knowledge/documents/${encodeURIComponent(documentId)}/replay`,
      ),
    exportKnowledgeDocument: (documentId: string) =>
      request<KnowledgeDocumentExport>(
        apiBaseUrl,
        `/knowledge/documents/${encodeURIComponent(documentId)}/export`,
      ),
    recordKnowledgeGitPublication: (
      documentId: string,
      branch: string,
      relativePath: string,
      commitHash: string,
      now: string,
    ) =>
      request<{
        documentId: string;
        branch: string;
        relativePath: string;
        commitHash: string;
        pushedAt: string;
      }>(
        apiBaseUrl,
        `/knowledge/documents/${encodeURIComponent(documentId)}/git-publications`,
        {
          branch,
          relativePath,
          commitHash,
          actor: HUMAN_ACTOR,
          now,
        },
      ),
    listAuditRecords: (filters: { action?: string; actorId?: string; resource?: string } = {}) => {
      const query = new URLSearchParams();
      if (filters.action) query.set("action", filters.action);
      if (filters.actorId) query.set("actorId", filters.actorId);
      if (filters.resource) query.set("resource", filters.resource);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return request<AuditRecord[]>(apiBaseUrl, `/audit-records${suffix}`);
    },
    importProject: (projectPath: string, now: string) =>
      request<RuntimeImportResult>(apiBaseUrl, "/projects/import", { projectPath, now }),
    archiveProject: (projectId: string, now: string) =>
      request<ProjectArchive>(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/archive`, {
        actor: HUMAN_ACTOR,
        now,
      }),
    createRun: (
      workflowVersionId: string,
      title: string,
      now: string,
      configuration: RunConfiguration = { taskGoal: "", parameters: {} },
    ) =>
      request<RunProjection>(apiBaseUrl, "/runs", {
        workflowVersionId,
        title,
        taskGoal: configuration.taskGoal,
        parameters: configuration.parameters,
        now,
      }),
    listRunsForWorkflowVersion: (workflowVersionId: string) =>
      request<RunSummary[]>(
        apiBaseUrl,
        `/workflow-versions/${encodeURIComponent(workflowVersionId)}/runs`,
      ),
    startDeployment: (runId: string, nodeId: string, expectedRevision: string, now: string) =>
      request<DeploymentSummary>(apiBaseUrl, `/runs/${runId}/deployments`, {
        nodeId,
        actor: HUMAN_ACTOR,
        expectedRevision,
        now,
      }),
    listDeployments: (runId: string) =>
      request<DeploymentSummary[]>(apiBaseUrl, `/runs/${runId}/deployments`),
    listDeploymentOutput: (runId: string, deploymentId: string, afterSequence = 0) =>
      request<DeploymentOutputEvent[]>(
        apiBaseUrl,
        `/runs/${runId}/deployments/${deploymentId}/output?afterSequence=${afterSequence}`,
      ),
    cancelDeployment: (runId: string, deploymentId: string, now: string) =>
      request<DeploymentSummary>(apiBaseUrl, `/runs/${runId}/deployments/${deploymentId}/cancel`, {
        actor: HUMAN_ACTOR,
        now,
      }),
    startNode: (runId: string, nodeId: string, expectedRevision: string, now: string) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/transition`, {
        eventType: "NODE_STARTED",
        nodeId,
        actor: AGENT_ACTOR,
        expectedRevision,
        now,
      }),
    retryGate: (runId: string, nodeId: string, expectedRevision: string, now: string) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/transition`, {
        eventType: "NODE_RETRIED",
        nodeId,
        actor: VERIFIER_ACTOR,
        expectedRevision,
        now,
      }),
    controlRun: (
      runId: string,
      eventType: "RUN_PAUSED" | "RUN_RESUMED" | "RUN_ARCHIVED",
      expectedRevision: string,
      now: string,
    ) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/transition`, {
        eventType,
        actor: HUMAN_ACTOR,
        expectedRevision,
        now,
      }),
    submitArtifact: (
      runId: string,
      nodeId: string,
      artifactPath: string,
      artifactType: string,
      expectedRevision: string,
      now: string,
    ) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/artifacts`, {
        nodeId,
        artifactPath,
        artifactType,
        actor: AGENT_ACTOR,
        expectedRevision,
        now,
      }),
    decideApproval: (
      runId: string,
      nodeId: string,
      decision: "approved" | "rejected" | "deferred",
      comment: string,
      expectedRevision: string,
      now: string,
    ) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/approvals/${nodeId}/decide`, {
        decision,
        actor: HUMAN_ACTOR,
        comment,
        expectedRevision,
        now,
      }),
    submitGate: (
      runId: string,
      nodeId: string,
      gateId: string,
      status: "passed" | "failed" | "waived",
      evidence: string[],
      waiverReason: string | null,
      expectedRevision: string,
      now: string,
    ) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/gates`, {
        nodeId,
        gateId,
        status,
        evidence,
        waiverReason,
        actor: VERIFIER_ACTOR,
        expectedRevision,
        now,
      }),
    getTimeline: (runId: string) =>
      request<RuntimeWorkbenchState["timeline"]>(apiBaseUrl, `/runs/${runId}/timeline`),
    listArtifacts: (runId: string) =>
      request<RuntimeWorkbenchState["artifacts"]>(apiBaseUrl, `/runs/${runId}/artifacts`),
    previewArtifact: (runId: string, artifactId: string) =>
      request<ArtifactPreview>(apiBaseUrl, `/runs/${runId}/artifacts/${artifactId}/preview`),
    getEvidencePackage: (runId: string) =>
      request<EvidencePackage>(apiBaseUrl, `/runs/${runId}/evidence-package`),
    getRunReport: (runId: string) =>
      request<RuntimeReport>(apiBaseUrl, `/runs/${runId}/report`),
    getDiagnosticSupportBundle: () =>
      request<DiagnosticSupportBundle>(apiBaseUrl, "/diagnostics/support-bundle"),
    registerTerminalSession: (
      runId: string,
      nodeId: string,
      kind: "shell" | "codex",
      cwd: string,
      pid: number,
      now: string,
    ) =>
      request<TerminalSessionSummary>(
        apiBaseUrl,
        `/runs/${runId}/terminals`,
        { nodeId, kind, cwd, pid, now },
      ),
    listTerminalSessions: (runId: string) =>
      request<TerminalSessionSummary[]>(apiBaseUrl, `/runs/${runId}/terminals`),
    listTerminalOutput: (runId: string, sessionId: string, afterSequence = 0) =>
      request<TerminalOutputEvent[]>(
        apiBaseUrl,
        `/runs/${runId}/terminals/${sessionId}/output?afterSequence=${afterSequence}`,
      ),
    stopTerminalSession: (runId: string, sessionId: string, now: string) =>
      request<{ id: string; status: string }>(
        apiBaseUrl,
        `/runs/${runId}/terminals/${sessionId}/stop`,
        { now },
      ),
    appendTerminalOutput: (
      runId: string,
      sessionId: string,
      stream: "stdout" | "stderr",
      data: string,
      now: string,
    ) =>
      request<{ accepted: boolean }>(
        apiBaseUrl,
        `/runs/${runId}/terminals/${sessionId}/output`,
        { stream, data, now },
      ),
    exportTerminalEvidence: (runId: string, sessionId: string, now: string) =>
      request<RuntimeWorkbenchState["artifacts"][number]>(
        apiBaseUrl,
        `/runs/${runId}/terminals/${sessionId}/evidence`,
        { actor: HUMAN_ACTOR, now },
      ),
    listApprovals: (runId: string) =>
      request<RuntimeWorkbenchState["approvals"]>(apiBaseUrl, `/runs/${runId}/approvals`),
    listGates: (runId: string) =>
      request<RuntimeWorkbenchState["gates"]>(apiBaseUrl, `/runs/${runId}/gates`),
    rebuildProjection: (runId: string, now: string) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/rebuild-projection`, { now }),
    getRecoveryDiagnostics: (runId: string) =>
      request<RecoveryDiagnostics>(apiBaseUrl, `/runs/${runId}/recovery-diagnostics`),
    cleanupOrphanAgentJobs: (runId: string, now: string) =>
      request<{ runId: string; cleanedJobIds: string[] }>(
        apiBaseUrl,
        `/runs/${runId}/recovery/cleanup-orphan-agents`,
        { now },
      ),
    cleanupOrphanTerminalSessions: (runId: string, now: string) =>
      request<{ runId: string; cleanedSessionIds: string[] }>(
        apiBaseUrl,
        `/runs/${runId}/recovery/cleanup-orphan-terminals`,
        { now },
      ),
    resumeAgentCheckpoint: (runId: string, checkpointId: string, now: string) =>
      request<AgentJobSummary>(
        apiBaseUrl,
        `/runs/${runId}/agent-checkpoints/${checkpointId}/resume`,
        { actor: HUMAN_ACTOR, now },
      ),
    discardAgentCheckpoint: (runId: string, checkpointId: string, now: string) =>
      request<{ id: string; status: string }>(
        apiBaseUrl,
        `/runs/${runId}/agent-checkpoints/${checkpointId}/discard`,
        { actor: HUMAN_ACTOR, now },
      ),
    getProjection: (runId: string) => request<RunProjection>(apiBaseUrl, `/runs/${runId}/projection`),
    startAgentJob: (
      runId: string,
      nodeId: string,
      provider: AgentJobSummary["provider"],
      prompt: string,
      now: string,
    ) =>
      request<AgentJobSummary>(apiBaseUrl, `/runs/${runId}/agents`, {
        nodeId,
        provider,
        prompt,
        actor: AGENT_ACTOR,
        allowedTools: [],
        timeoutSeconds: 300,
        maxOutputBytes: 1_000_000,
        now,
      }),
    listAgentJobs: (runId: string) =>
      request<AgentJobSummary[]>(apiBaseUrl, `/runs/${runId}/agents`),
    listAgentOutput: (runId: string, jobId: string, afterSequence: number) =>
      request<AgentOutputSummary[]>(
        apiBaseUrl,
        `/runs/${runId}/agents/${jobId}/output?afterSequence=${afterSequence}`,
      ),
    cancelAgentJob: (runId: string, jobId: string) =>
      request<AgentJobSummary>(apiBaseUrl, `/runs/${runId}/agents/${jobId}/cancel`, {}),
  };
}

function readRuntimeConfig() {
  const params =
    typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  return {
    apiBaseUrl: params.get("runtimeApiBaseUrl") ?? RUNTIME_API_BASE_URL,
  };
}

async function request<T>(apiBaseUrl: string, path: string, body?: unknown): Promise<T> {
  const desktopRuntime = getDesktopRuntimeBridge();
  if (desktopRuntime) {
    return desktopRuntime.request(path, body) as Promise<T>;
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Runtime API ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

function getDesktopRuntimeBridge():
  | {
      request(path: string, body?: unknown): Promise<unknown>;
    }
  | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = (window as Window & {
    workflowRuntime?: {
      request?: (path: string, body?: unknown) => Promise<unknown>;
    };
  }).workflowRuntime;
  return typeof candidate?.request === "function"
    ? { request: candidate.request.bind(candidate) }
    : null;
}

function emptyWorkbenchState(connection: RuntimeWorkbenchState["connection"]): RuntimeWorkbenchState {
  return {
    connection,
    workspaceStatus: "uninitialized",
    projectName: "",
    workflowName: "",
    projection: null,
    timeline: [],
    artifacts: [],
    approvals: [],
    gates: [],
    agentJobs: [],
    agentOutput: [],
  };
}
