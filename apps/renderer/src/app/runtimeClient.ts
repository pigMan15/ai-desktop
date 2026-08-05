import type {
  CreateRunRequest,
  RunListQuery,
  RunListResponse,
  RunProjection,
  RunStatus,
  WorkspaceLease,
  WorkspaceMode,
  WorkflowDefinition,
} from "@workflow-platform/contracts";

export type ScopedCreateRunResponse = {
  run: {
    id: string;
    projectId: string;
    workflowVersionId: string;
    workflowSnapshot: WorkflowDefinition;
    title: string;
    context: { taskGoal?: string; parameters?: Record<string, unknown> };
    executionWorkspace: string;
    workspaceMode: WorkspaceMode;
    status: RunStatus;
    createdAt: string;
    updatedAt: string;
  };
  projection: RunProjection;
  workspace: WorkspaceLease;
};

export class RuntimeClientError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly correlationId: string | null;

  constructor(
    status: number | null,
    code: string,
    message: string,
    details: Record<string, unknown> | undefined,
    correlationId: string | null,
  ) {
    super(message);
    this.name = "RuntimeClientError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
    this.correlationId = correlationId;
  }
}

export type RuntimeWorkbenchState = {
  connection: "connected" | "unavailable";
  workspaceStatus: "uninitialized" | "ready";
  projectName: string;
  workflowName: string;
  projection: RunProjection | null;
  timeline: Array<{ id: string; type: string; nodeId?: string; createdAt: string }>;
  artifacts: Array<{
    id: string;
    runId?: string;
    nodeId?: string;
    type: string;
    uri: string;
    contentHash: string;
    artifactSpecId?: string | null;
    workflowVersionId?: string | null;
    relativePath?: string | null;
    fileSize?: number | null;
    mediaType?: string | null;
    status?: "verified" | "provisional" | "invalidated" | null;
    supersedesArtifactId?: string | null;
  }>;
  approvals: Array<{
    id: string;
    nodeId?: string;
    status: string;
    comment?: string;
    artifactHashes?: string[];
    invalidatedAt?: string | null;
    invalidationReason?: string | null;
  }>;
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
    artifactHashes?: string[];
    invalidatedAt?: string | null;
    invalidationReason?: string | null;
  }>;
  agentJobs: AgentJobSummary[];
  agentOutput: AgentOutputSummary[];
};

type RuntimeImportResult = {
  projectId: string;
  workflowVersionId: string | null;
  workflowId?: string | null;
  workflowName?: string | null;
  createdDefaultWorkflow?: boolean;
  workflowBindingStatus: "bound" | "unbound";
};

export type WorkflowLibraryItem = {
  workflowId: string;
  name: string;
  isBuiltin: boolean;
  archivedAt: string | null;
  updatedAt: string;
  workflowVersionId: string | null;
  currentVersion: string | null;
  nodeCount: number;
  boundProjectCount: number;
};

export type ProjectWorkflowBinding = {
  projectId: string;
  workflowId: string;
  workflowVersionId: string;
  actor: Record<string, unknown>;
  boundAt: string;
  workflowBindingStatus: "bound";
};

export type WorkflowCreateResult = {
  workflowId: string;
  workflowVersionId: string;
  isBuiltin: boolean;
};

export type AgentJobSummary = {
  id: string;
  runId: string;
  nodeId: string;
  provider: "codex" | "claude" | "fake";
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  mode?: "automatic" | "interactive";
  command: string[];
  cwd: string;
  pid?: number | null;
  sessionId?: string | null;
  parentJobId?: string | null;
  summary?: string | null;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ArtifactConsumer = {
  id: string;
  artifactId: string;
  consumerRunId: string;
  consumerNodeId: string;
  agentJobId: string | null;
  contextCreatedAt: string;
};

export type AgentStartResult = AgentJobSummary & {
  job: AgentJobSummary;
  effectivePrompt: string;
  contextArtifacts: Array<{
    artifactId?: string | null;
    nodeId: string;
    type: string;
    path: string;
    contentHash?: string | null;
    summary: string;
  }>;
  expectedArtifacts: Array<{
    id: string;
    name: string;
    type: string;
    required: boolean;
    relativePath: string;
  }>;
};

export type NodeContextPreview = {
  runId: string;
  nodeId: string;
  artifacts: AgentStartResult["contextArtifacts"];
  prompt: string;
  expectedArtifacts: AgentStartResult["expectedArtifacts"];
};

export type AgentSessionSummary = {
  id: string;
  runId: string;
  jobId: string;
  provider: AgentJobSummary["provider"];
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "RECOVERABLE";
  desktopSessionId?: string | null;
  pid?: number | null;
  cwd: string;
  maxOutputBytes: number;
  recoveryReason?: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt?: string | null;
};

export type InteractiveAgentOutputInput = {
  data: string;
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

export type NodeArtifactScan = {
  runId: string;
  nodeId: string;
  registered: string[];
  unchanged: string[];
  missing: string[];
  invalid: Array<{ artifactSpecId: string; reason: string }>;
  projection: RunProjection;
};

export type NodeArtifactRequirements = {
  runId: string;
  nodeId: string;
  requirements: Array<{
    id: string;
    name: string;
    type: string;
    required: boolean;
    relativePath: string;
    templatePath?: string | null;
    description?: string | null;
    artifacts: RuntimeWorkbenchState["artifacts"];
  }>;
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
  nodes: Array<{
    id: string;
    name: string;
    kind: string;
    role?: string;
    description?: string;
    artifacts?: {
      outputs: Array<{
        id: string;
        name: string;
        type: string;
        required: boolean;
        path: string;
        templatePath?: string;
        description?: string;
      }>;
    };
    agent?: {
      roleId?: string;
      promptTemplate?: string;
      context?: {
        upstream: "none" | "direct" | "ancestors";
        artifactTypes?: string[];
        maxArtifacts?: number;
        summaryCharsPerArtifact?: number;
        maxTotalChars?: number;
      };
    };
    advance?: { mode: "manual" | "auto" };
  }>;
  edges: Array<{ id: string; from: string; to: string }>;
  roles: WorkflowRoleSummary[];
  gates: Array<{
    id: string;
    name: string;
    description?: string | null;
    metadata?: Record<string, unknown>;
  }>;
  policies: Record<string, unknown>;
  metadata: Record<string, unknown> & {
    canvas?: {
      nodes?: Record<string, { x: number; y: number }>;
    };
  };
};

export type WorkflowRoleSummary = {
  id: string;
  assetVersionId?: string;
  name: string;
  purpose?: string;
  description?: string;
  instructions?: string;
  inputRequirements?: string;
  outputRequirements?: string;
  acceptanceCriteria?: string;
  forbiddenActions?: string;
  provider?: "codex" | "claude";
  model?: string;
  allowedTools?: string[];
  disabled?: boolean;
  metadata?: Record<string, unknown>;
};

export type RoleAssetSummary = WorkflowRoleSummary & {
  isBuiltin: boolean;
  archivedAt: string | null;
  updatedAt: string;
  roleVersionId: string;
  version: number;
};

export type RoleVersionSummary = { roleVersionId: string; version: number; createdAt: string; definition: WorkflowRoleSummary };
export type RoleWorkflowReference = { workflowVersionId: string; workflowName: string; workflowVersion: string };

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
  nodeCount?: number;
  edgeCount?: number;
  nodeSummary?: string;
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
  kind: "shell" | "codex" | "claude";
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
  executionWorkspace?: string;
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
    listProjectRuns: (projectId: string, query: RunListQuery = {}, signal?: AbortSignal) => {
      const params = new URLSearchParams();
      for (const status of query.status ?? []) params.append("status", status);
      if (query.workflowVersionId !== undefined) params.set("workflowVersionId", query.workflowVersionId);
      if (query.workspacePath !== undefined) params.set("workspacePath", query.workspacePath);
      if (query.q !== undefined) params.set("q", query.q);
      if (query.cursor !== undefined) params.set("cursor", query.cursor);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.size === 0 ? "" : `?${params.toString()}`;
      return request<RunListResponse>(
        apiBaseUrl,
        `/projects/${encodeURIComponent(projectId)}/runs${suffix}`,
        { method: "GET", signal },
      );
    },
    createProjectRun: (
      projectId: string,
      idempotencyKey: string,
      body: CreateRunRequest,
      signal?: AbortSignal,
    ) =>
      request<ScopedCreateRunResponse>(
        apiBaseUrl,
        `/projects/${encodeURIComponent(projectId)}/runs`,
        {
          method: "POST",
          body,
          headers: { "Idempotency-Key": idempotencyKey },
          signal,
        },
      ),
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
    listWorkflows: () => request<WorkflowLibraryItem[]>(apiBaseUrl, "/workflows"),
    listRoleAssets: () => request<RoleAssetSummary[]>(apiBaseUrl, "/roles"),
    saveRoleAsset: (definition: WorkflowRoleSummary, now: string) =>
      request<{ roleId: string; roleVersionId: string; version: number }>(apiBaseUrl, "/roles", {
        definition,
        actor: HUMAN_ACTOR,
        now,
      }),
    archiveRoleAsset: (roleId: string, now: string) =>
      request<{ roleId: string; archived: boolean; archivedAt: string | null }>(apiBaseUrl, `/roles/${encodeURIComponent(roleId)}/archive`, { actor: HUMAN_ACTOR, now }),
    restoreRoleAsset: (roleId: string, now: string) =>
      request<{ roleId: string; restored: boolean }>(apiBaseUrl, `/roles/${encodeURIComponent(roleId)}/restore`, { actor: HUMAN_ACTOR, now }),
    deleteRoleAsset: (roleId: string, now: string) =>
      request<{ roleId: string; deleted: boolean }>(apiBaseUrl, `/roles/${encodeURIComponent(roleId)}/delete`, { actor: HUMAN_ACTOR, now }),
    listRoleVersionHistory: (roleId: string) => request<RoleVersionSummary[]>(apiBaseUrl, `/roles/${encodeURIComponent(roleId)}/history`),
    listRoleReferences: (roleId: string) => request<RoleWorkflowReference[]>(apiBaseUrl, `/roles/${encodeURIComponent(roleId)}/references`),
    createWorkflow: (definition: WorkflowDefinitionSummary, isBuiltin: boolean, now: string) =>
      request<WorkflowCreateResult>(apiBaseUrl, "/workflows", {
        definition,
        isBuiltin,
        actor: HUMAN_ACTOR,
        now,
      }),
    copyWorkflowTemplate: (workflowId: string, name: string, now: string) =>
      request<WorkflowCreateResult>(apiBaseUrl, `/workflows/${encodeURIComponent(workflowId)}/copy`, {
        name,
        actor: HUMAN_ACTOR,
        now,
      }),
    archiveWorkflow: (workflowId: string, now: string) =>
      request<{ workflowId: string; archived: boolean; archivedAt: string | null }>(
        apiBaseUrl,
        `/workflows/${encodeURIComponent(workflowId)}/archive`,
        { actor: HUMAN_ACTOR, now },
      ),
    deleteWorkflow: (workflowId: string, now: string) =>
      request<{ workflowId: string; deleted: boolean }>(apiBaseUrl, `/workflows/${encodeURIComponent(workflowId)}/delete`, { actor: HUMAN_ACTOR, now }),
    getProjectWorkflowBinding: (projectId: string) =>
      request<ProjectWorkflowBinding | null>(
        apiBaseUrl,
        `/projects/${encodeURIComponent(projectId)}/workflow-binding`,
      ),
    bindProjectWorkflow: (projectId: string, workflowId: string, workflowVersionId: string, now: string) =>
      request<ProjectWorkflowBinding>(
        apiBaseUrl,
        `/projects/${encodeURIComponent(projectId)}/workflow-binding`,
        { workflowId, workflowVersionId, actor: HUMAN_ACTOR, now },
      ),
    createRun: (
      workflowVersionId: string,
      title: string,
      now: string,
      configuration: RunConfiguration = { taskGoal: "", parameters: {} },
      projectId = "",
    ) =>
      request<RunProjection>(apiBaseUrl, "/runs", {
        projectId,
        workflowVersionId,
        title,
        taskGoal: configuration.taskGoal,
        parameters: configuration.parameters,
        executionWorkspace: configuration.executionWorkspace,
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
    extractArtifactsToKnowledgeSyntheses: (
      runId: string,
      artifactIds: string[],
      provider: KnowledgeSynthesis["provider"],
      now: string,
    ) =>
      request<{ runId: string; items: Array<{ artifactId: string; candidateId: string; synthesisId: string; status: KnowledgeSynthesis["status"] }> }>(
        apiBaseUrl,
        `/runs/${runId}/artifacts/knowledge-syntheses`,
        { artifactIds, provider, actor: HUMAN_ACTOR, now },
      ),
    getNodeArtifactRequirements: (runId: string, nodeId: string) =>
      request<NodeArtifactRequirements>(
        apiBaseUrl,
        `/runs/${runId}/nodes/${nodeId}/artifact-requirements`,
      ),
    getNodeContext: (runId: string, nodeId: string) =>
      request<NodeContextPreview>(apiBaseUrl, `/runs/${runId}/nodes/${nodeId}/context`),
    completeNode: (runId: string, nodeId: string, expectedRevision: string, now: string) =>
      request<RunProjection>(apiBaseUrl, `/runs/${runId}/nodes/${nodeId}/complete`, {
        actor: HUMAN_ACTOR,
        expectedRevision,
        now,
      }),
    confirmArtifact: (runId: string, nodeId: string, artifactId: string, expectedRevision: string, now: string) =>
      request<{ artifact: RuntimeWorkbenchState["artifacts"][number]; projection: RunProjection }>(
        apiBaseUrl,
        `/runs/${runId}/nodes/${nodeId}/artifacts/${artifactId}/confirm`,
        { actor: HUMAN_ACTOR, expectedRevision, now },
      ),
    listArtifactConsumers: (runId: string, artifactId: string) =>
      request<ArtifactConsumer[]>(apiBaseUrl, `/runs/${runId}/artifacts/${artifactId}/consumers`),
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
      kind: TerminalSessionSummary["kind"],
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
      mode: "automatic" | "interactive" = "automatic",
      allowedTools: string[] = [],
      cwd?: string,
    ) =>
      request<AgentStartResult>(apiBaseUrl, `/runs/${runId}/agents`, {
        nodeId,
        provider,
        prompt,
        actor: mode === "interactive" ? HUMAN_ACTOR : AGENT_ACTOR,
        allowedTools,
        cwd,
        timeoutSeconds: 300,
        maxOutputBytes: 1_000_000,
        mode,
        now,
      }),
    scanNodeArtifacts: (runId: string, nodeId: string, expectedRevision: string, now: string) =>
      request<NodeArtifactScan>(apiBaseUrl, `/runs/${runId}/nodes/${nodeId}/artifacts/scan`, {
        expectedRevision,
        now,
      }),
    startInteractiveAgentSession: (
      runId: string,
      jobId: string,
      desktopSessionId: string,
      pid: number,
      now: string,
    ) =>
      request<AgentSessionSummary>(
        apiBaseUrl,
        `/runs/${runId}/agents/${jobId}/interactive-session/start`,
        { desktopSessionId, pid, actor: HUMAN_ACTOR, now },
      ),
    recordInteractiveAgentInput: (runId: string, jobId: string, content: string, now: string) =>
      request<{ id: string; sessionId: string; sequence: number; kind: string; content: string; createdAt: string }>(
        apiBaseUrl,
        `/runs/${runId}/agents/${jobId}/interactive-session/input`,
        { content, actor: HUMAN_ACTOR, now },
      ),
    appendInteractiveAgentOutput: (
      runId: string,
      jobId: string,
      events: InteractiveAgentOutputInput[],
      now: string,
    ) =>
      request<AgentOutputSummary[]>(
        apiBaseUrl,
        `/runs/${runId}/agents/${jobId}/interactive-session/output`,
        { events, now },
      ),
    finishInteractiveAgentSession: (
      runId: string,
      jobId: string,
      status: AgentSessionSummary["status"],
      summary: string | null,
      error: string | null,
      now: string,
    ) =>
      request<AgentSessionSummary>(
        apiBaseUrl,
        `/runs/${runId}/agents/${jobId}/interactive-session/ended`,
        { status, summary, error, actor: HUMAN_ACTOR, now },
      ),
    getInteractiveAgentSession: (runId: string, jobId: string) =>
      request<AgentSessionSummary>(apiBaseUrl, `/runs/${runId}/agents/${jobId}/interactive-session`),
    continueInteractiveAgent: (runId: string, jobId: string, now: string) =>
      request<AgentJobSummary>(
        apiBaseUrl,
        `/runs/${runId}/agents/${jobId}/interactive-session/continue`,
        { actor: HUMAN_ACTOR, now },
      ),
    listAgentJobs: (runId: string) =>
      request<AgentJobSummary[]>(apiBaseUrl, `/runs/${runId}/agents`),
    listAgentOutput: (runId: string, jobId: string, afterSequence: number) =>
      request<AgentOutputSummary[]>(
        apiBaseUrl,
        `/runs/${runId}/agents/${jobId}/output?afterSequence=${afterSequence}`,
      ),
    cancelAgentJob: (runId: string, jobId: string, now?: string) =>
      request<AgentJobSummary>(
        apiBaseUrl,
        `/runs/${runId}/agents/${jobId}/cancel`,
        now ? { actor: HUMAN_ACTOR, now } : {},
      ),
  };
}

function readRuntimeConfig() {
  const params =
    typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  return {
    apiBaseUrl: params.get("runtimeApiBaseUrl") ?? RUNTIME_API_BASE_URL,
  };
}

type RuntimeRequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

const RUNTIME_IPC_PROTOCOL = "workflow-platform.runtime-ipc.v1#7f8c2a61";

async function request<T>(
  apiBaseUrl: string,
  path: string,
  optionsOrLegacyBody: RuntimeRequestOptions | unknown = undefined,
): Promise<T> {
  const options = normalizeRequestOptions(optionsOrLegacyBody);
  const desktopRuntime = getDesktopRuntimeBridge();
  if (desktopRuntime) {
    const desktopOptions = {
      path,
      ...(options.method === undefined ? {} : { method: options.method }),
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    };
    try {
      const result = await desktopRuntime.request(desktopOptions);
      return decodeDesktopRuntimeResponse<T>(result);
    } catch (error) {
      throw normalizeTransportError(error, "DESKTOP_ERROR");
    }
  }
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: options.body === undefined
        ? options.headers
        : { "Content-Type": "application/json", ...options.headers },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    throw normalizeTransportError(error, "NETWORK_ERROR");
  }
  if (!response.ok) {
    const errorBody: unknown = await response.json().catch(() => null);
    throw parseRuntimeError(errorBody, response.status, path);
  }
  return (await response.json()) as T;
}

function normalizeRequestOptions(value: RuntimeRequestOptions | unknown): RuntimeRequestOptions {
  if (
    typeof value === "object"
    && value !== null
    && ("method" in value || "body" in value || "headers" in value || "signal" in value)
  ) {
    return value as RuntimeRequestOptions;
  }
  return value === undefined ? {} : { body: value };
}

function parseRuntimeError(errorBody: unknown, status: number, path: string): RuntimeClientError {
  const envelope = isRecord(errorBody) && "detail" in errorBody ? errorBody.detail : errorBody;
  if (
    isRecord(envelope)
    && typeof envelope.code === "string"
    && typeof envelope.message === "string"
  ) {
    return new RuntimeClientError(
      status,
      envelope.code,
      envelope.message,
      isRecord(envelope.details) ? envelope.details : undefined,
      typeof envelope.correlationId === "string" ? envelope.correlationId : null,
    );
  }
  const detail = typeof envelope === "string" ? envelope : null;
  return new RuntimeClientError(
    status,
    "RUNTIME_API_ERROR",
    detail
      ? `Runtime API ${path} failed with ${status}: ${detail}`
      : `Runtime API ${path} failed with ${status}`,
    undefined,
    null,
  );
}

function normalizeTransportError(error: unknown, code: string): unknown {
  if (isAbortError(error) || error instanceof RuntimeClientError) return error;
  const message = error instanceof Error && error.message ? error.message : "Runtime request failed";
  return new RuntimeClientError(null, code, message, undefined, null);
}

function decodeDesktopRuntimeResponse<T>(value: unknown): T {
  if (!hasDesktopRuntimeMarker(value)) return value as T;
  const runtimeError = readDesktopRuntimeError(value);
  if (runtimeError) throw runtimeError;
  if (isDesktopRuntimeSuccess(value)) return value.value as T;
  throw new RuntimeClientError(
    null,
    "DESKTOP_ERROR",
    "Invalid Desktop Runtime response envelope",
    undefined,
    null,
  );
}

function hasDesktopRuntimeMarker(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && Object.prototype.hasOwnProperty.call(value, "__workflowPlatformRuntimeIpc");
}

function readDesktopRuntimeError(value: unknown): RuntimeClientError | null {
  if (!isRecord(value) || value.__workflowPlatformRuntimeIpc !== RUNTIME_IPC_PROTOCOL) return null;
  if (value.kind !== "runtime-error" || !isRecord(value.error)) return null;
  const error = value.error;
  if (
    !Number.isInteger(error.status)
    || (error.status as number) < 100
    || (error.status as number) > 599
    || typeof error.code !== "string"
    || !error.code
    || typeof error.message !== "string"
    || (error.details !== undefined && !isRecord(error.details))
    || (error.correlationId !== null && typeof error.correlationId !== "string")
  ) {
    return null;
  }
  return new RuntimeClientError(
    error.status as number,
    error.code,
    error.message,
    error.details as Record<string, unknown> | undefined,
    error.correlationId as string | null,
  );
}

function isDesktopRuntimeSuccess(
  value: unknown,
): value is Record<string, unknown> & { kind: "success"; value: unknown } {
  return isRecord(value)
    && value.__workflowPlatformRuntimeIpc === RUNTIME_IPC_PROTOCOL
    && value.kind === "success"
    && Object.prototype.hasOwnProperty.call(value, "value");
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDesktopRuntimeBridge():
  | {
      request(options: {
        path: string;
        method?: "GET" | "POST";
        body?: unknown;
        headers?: Record<string, string>;
      }): Promise<unknown>;
    }
  | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = (window as Window & {
    workflowRuntime?: {
      request?: (options: {
        path: string;
        method?: "GET" | "POST";
        body?: unknown;
        headers?: Record<string, string>;
      }) => Promise<unknown>;
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
