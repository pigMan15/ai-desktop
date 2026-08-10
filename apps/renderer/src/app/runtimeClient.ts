import type {
  CreateRunRequest,
  ExecuteRunActionRequest,
  ExecuteRunActionResponse,
  ProjectConcurrencySettings,
  RunListQuery,
  RunListResponse,
  RunOverview,
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

export type ProjectWorkspaceCandidate = {
  path: string;
  label: string;
  occupiedByRunId: string | null;
  leaseMode: WorkspaceMode | null;
  leaseStatus: "active" | "released" | "expired" | null;
  recommended: boolean;
};

export type ProjectWorktree = {
  path: string;
  branch: string;
  head: string | null;
  bare: boolean;
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
  projectId?: string;
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
  projectId?: string;
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
    summary?: string | null;
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
        delivery?: "path" | "hybrid" | "summary";
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
  workspaceLease?: WorkspaceLease | null;
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
  projectId: string;
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
  return {
    connection: "connected",
    workspaceStatus: "ready",
    projectName: context.projectName,
    workflowName: context.workflowName,
    projection: null,
    timeline: [],
    artifacts: [],
    approvals: [],
    gates: [],
    agentJobs: [],
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
    getProjectRunOverview: (
      projectId: string,
      runId: string,
      signal?: AbortSignal,
    ) =>
      request<RunOverview>(
        apiBaseUrl,
        `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/overview`,
        { method: "GET", signal },
      ),
    executeProjectRunAction: (
      projectId: string,
      runId: string,
      body: ExecuteRunActionRequest,
      signal?: AbortSignal,
    ) =>
      request<ExecuteRunActionResponse>(
        apiBaseUrl,
        `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/actions`,
        { method: "POST", body, signal },
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
    getProjectConcurrency: (projectId: string, signal?: AbortSignal) =>
      request<ProjectConcurrencySettings>(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/concurrency`, { signal }),
    updateProjectConcurrency: (projectId: string, settings: ProjectConcurrencySettings, now: string, signal?: AbortSignal) =>
      request<ProjectConcurrencySettings>(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/concurrency`, {
        method: "PUT",
        body: { ...settings, actor: HUMAN_ACTOR, now },
        signal,
      }),
    listProjectWorkspaces: (projectId: string, signal?: AbortSignal) =>
      request<ProjectWorkspaceCandidate[]>(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/workspaces`, { signal }),
    createProjectWorktree: (projectId: string, name: string, branchName: string, baseRef = "HEAD", signal?: AbortSignal) =>
      request<ProjectWorktree>(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/worktrees`, {
        method: "POST",
        body: { name, branchName, baseRef },
        signal,
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
    startDeployment: (projectId: string, runId: string, nodeId: string, expectedRevision: string, now: string, signal?: AbortSignal) =>
      request<DeploymentSummary>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/deployments`, {
        body: { nodeId, actor: HUMAN_ACTOR, expectedRevision, now }, signal,
      }),
    listDeployments: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<DeploymentSummary[]>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/deployments`, { method: "GET", signal }),
    getDeployment: (projectId: string, runId: string, deploymentId: string, signal?: AbortSignal) =>
      request<DeploymentSummary>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/deployments/${encodeURIComponent(deploymentId)}`, { method: "GET", signal }),
    listDeploymentOutput: (projectId: string, runId: string, deploymentId: string, afterSequence = 0, signal?: AbortSignal) =>
      request<DeploymentOutputEvent[]>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/deployments/${encodeURIComponent(deploymentId)}/output?afterSequence=${afterSequence}`,
        { method: "GET", signal },
      ),
    cancelDeployment: (projectId: string, runId: string, deploymentId: string, now: string, signal?: AbortSignal) =>
      request<DeploymentSummary>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/deployments/${encodeURIComponent(deploymentId)}/cancel`, {
        body: { actor: HUMAN_ACTOR, now }, signal,
      }),
    startNode: (projectId: string, runId: string, nodeId: string, expectedRevision: string, now: string, signal?: AbortSignal) =>
      request<RunProjection>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/transition`, {
        body: { eventType: "NODE_STARTED", nodeId, actor: AGENT_ACTOR, expectedRevision, now }, signal,
      }),
    retryGate: (projectId: string, runId: string, nodeId: string, expectedRevision: string, now: string, signal?: AbortSignal) =>
      request<RunProjection>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/transition`, {
        body: { eventType: "NODE_RETRIED", nodeId, actor: VERIFIER_ACTOR, expectedRevision, now }, signal,
      }),
    controlRun: (
      projectId: string,
      runId: string,
      eventType: "RUN_PAUSED" | "RUN_RESUMED" | "RUN_ARCHIVED",
      expectedRevision: string,
      now: string,
      signal?: AbortSignal,
    ) =>
      request<RunProjection>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/transition`, {
        body: { eventType, actor: HUMAN_ACTOR, expectedRevision, now }, signal,
      }),
    submitArtifact: (
      projectId: string,
      runId: string,
      nodeId: string,
      artifactPath: string,
      artifactType: string,
      expectedRevision: string,
      now: string,
      signal?: AbortSignal,
    ) =>
      request<RunProjection>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/artifacts`, {
        body: { nodeId, artifactPath, artifactType, actor: AGENT_ACTOR, expectedRevision, now }, signal,
      }),
    decideApproval: (
      projectId: string,
      runId: string,
      nodeId: string,
      decision: "approved" | "rejected" | "deferred",
      comment: string,
      expectedRevision: string,
      now: string,
      signal?: AbortSignal,
    ) =>
      request<RunProjection>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/approvals/${encodeURIComponent(nodeId)}/decide`, {
        body: { decision, actor: HUMAN_ACTOR, comment, expectedRevision, now }, signal,
      }),
    submitGate: (
      projectId: string,
      runId: string,
      nodeId: string,
      gateId: string,
      status: "passed" | "failed" | "waived",
      evidence: string[],
      waiverReason: string | null,
      expectedRevision: string,
      now: string,
      signal?: AbortSignal,
    ) =>
      request<RunProjection>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/gates`, {
        body: { nodeId, gateId, status, evidence, waiverReason, actor: VERIFIER_ACTOR, expectedRevision, now }, signal,
      }),
    getTimeline: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<RuntimeWorkbenchState["timeline"]>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/timeline`, { method: "GET", signal }),
    listArtifacts: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<RuntimeWorkbenchState["artifacts"]>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/artifacts`, { method: "GET", signal }),
    extractArtifactsToKnowledgeSyntheses: (
      projectId: string,
      runId: string,
      artifactIds: string[],
      provider: KnowledgeSynthesis["provider"],
      now: string,
    ) =>
      request<{ runId: string; items: Array<{ artifactId: string; candidateId: string; synthesisId: string; status: KnowledgeSynthesis["status"] }> }>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/artifacts/knowledge-syntheses`,
        { body: { artifactIds, provider, actor: HUMAN_ACTOR, now } },
      ),
    getNodeArtifactRequirements: (projectId: string, runId: string, nodeId: string, signal?: AbortSignal) =>
      request<NodeArtifactRequirements>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/nodes/${encodeURIComponent(nodeId)}/artifact-requirements`,
        { method: "GET", signal },
      ),
    getNodeContext: (projectId: string, runId: string, nodeId: string, signal?: AbortSignal) =>
      request<NodeContextPreview>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/nodes/${encodeURIComponent(nodeId)}/context`, { method: "GET", signal }),
    completeNode: (projectId: string, runId: string, nodeId: string, expectedRevision: string, now: string, signal?: AbortSignal) =>
      request<RunProjection>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/nodes/${encodeURIComponent(nodeId)}/complete`, {
        body: { actor: HUMAN_ACTOR, expectedRevision, now }, signal,
      }),
    confirmArtifact: (projectId: string, runId: string, nodeId: string, artifactId: string, expectedRevision: string, now: string, signal?: AbortSignal) =>
      request<{ artifact: RuntimeWorkbenchState["artifacts"][number]; projection: RunProjection }>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/nodes/${encodeURIComponent(nodeId)}/artifacts/${encodeURIComponent(artifactId)}/confirm`,
        { body: { actor: HUMAN_ACTOR, expectedRevision, now }, signal },
      ),
    listArtifactConsumers: (projectId: string, runId: string, artifactId: string, signal?: AbortSignal) =>
      request<ArtifactConsumer[]>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/artifacts/${encodeURIComponent(artifactId)}/consumers`, { method: "GET", signal }),
    previewArtifact: (projectId: string, runId: string, artifactId: string, signal?: AbortSignal) =>
      request<ArtifactPreview>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/artifacts/${encodeURIComponent(artifactId)}/preview`, { method: "GET", signal }),
    getEvidencePackage: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<EvidencePackage>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/evidence-package`, { method: "GET", signal }),
    getRunReport: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<RuntimeReport>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/report`, { method: "GET", signal }),
    getDiagnosticSupportBundle: () =>
      request<DiagnosticSupportBundle>(apiBaseUrl, "/diagnostics/support-bundle"),
    registerTerminalSession: (
      projectId: string,
      runId: string,
      nodeId: string,
      kind: TerminalSessionSummary["kind"],
      cwd: string,
      pid: number,
      now: string,
      signal?: AbortSignal,
    ) =>
      request<TerminalSessionSummary>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/terminals`,
        { body: { nodeId, kind, cwd, pid, now }, signal },
      ),
    listTerminalSessions: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<TerminalSessionSummary[]>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/terminals`, { method: "GET", signal }),
    listTerminalOutput: (projectId: string, runId: string, sessionId: string, afterSequence = 0, signal?: AbortSignal) =>
      request<TerminalOutputEvent[]>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/terminals/${encodeURIComponent(sessionId)}/output?afterSequence=${afterSequence}`,
        { method: "GET", signal },
      ),
    stopTerminalSession: (projectId: string, runId: string, sessionId: string, now: string, signal?: AbortSignal) =>
      request<{ id: string; status: string }>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/terminals/${encodeURIComponent(sessionId)}/stop`,
        { body: { now }, signal },
      ),
    appendTerminalOutput: (
      projectId: string,
      runId: string,
      sessionId: string,
      stream: "stdout" | "stderr",
      data: string,
      now: string,
      signal?: AbortSignal,
    ) =>
      request<{ accepted: boolean }>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/terminals/${encodeURIComponent(sessionId)}/output`,
        { body: { stream, data, now }, signal },
      ),
    exportTerminalEvidence: (projectId: string, runId: string, sessionId: string, now: string, signal?: AbortSignal) =>
      request<RuntimeWorkbenchState["artifacts"][number]>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/terminals/${encodeURIComponent(sessionId)}/evidence`,
        { body: { actor: HUMAN_ACTOR, now }, signal },
      ),
    listApprovals: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<RuntimeWorkbenchState["approvals"]>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/approvals`, { method: "GET", signal }),
    listGates: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<RuntimeWorkbenchState["gates"]>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/gates`, { method: "GET", signal }),
    listRunAuditRecords: (projectId: string, runId: string, action = "", signal?: AbortSignal) => {
      const query = new URLSearchParams();
      if (action) query.set("action", action);
      const suffix = query.size ? `?${query.toString()}` : "";
      return request<AuditRecord[]>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/audit-records${suffix}`, { method: "GET", signal });
    },
    rebuildProjection: (projectId: string, runId: string, now: string, signal?: AbortSignal) =>
      request<RunProjection>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/rebuild-projection`, { body: { now }, signal }),
    getRecoveryDiagnostics: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<RecoveryDiagnostics>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/recovery-diagnostics`, { method: "GET", signal }),
    cleanupOrphanAgentJobs: (projectId: string, runId: string, now: string, signal?: AbortSignal) =>
      request<{ runId: string; cleanedJobIds: string[] }>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/recovery/cleanup-orphan-agents`,
        { body: { now }, signal },
      ),
    cleanupOrphanTerminalSessions: (projectId: string, runId: string, now: string, signal?: AbortSignal) =>
      request<{ runId: string; cleanedSessionIds: string[] }>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/recovery/cleanup-orphan-terminals`,
        { body: { now }, signal },
      ),
    resumeAgentCheckpoint: (projectId: string, runId: string, checkpointId: string, now: string, signal?: AbortSignal) =>
      request<AgentJobSummary>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/agent-checkpoints/${encodeURIComponent(checkpointId)}/resume`,
        { body: { actor: HUMAN_ACTOR, now }, signal },
      ),
    discardAgentCheckpoint: (projectId: string, runId: string, checkpointId: string, now: string, signal?: AbortSignal) =>
      request<{ id: string; status: string }>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/agent-checkpoints/${encodeURIComponent(checkpointId)}/discard`,
        { body: { actor: HUMAN_ACTOR, now }, signal },
      ),
    getProjection: (projectId: string, runId: string, signal?: AbortSignal) => request<RunProjection>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/projection`, { method: "GET", signal }),
    startAgentJob: (
      projectId: string,
      runId: string,
      nodeId: string,
      provider: AgentJobSummary["provider"],
      prompt: string,
      now: string,
      mode: "automatic" | "interactive" = "automatic",
      allowedTools: string[] = [],
      cwd?: string,
      signal?: AbortSignal,
    ) =>
      request<AgentStartResult>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/agents`, {
        body: { nodeId, provider, prompt, actor: mode === "interactive" ? HUMAN_ACTOR : AGENT_ACTOR, allowedTools, cwd, timeoutSeconds: 300, maxOutputBytes: 1_000_000, mode, now }, signal,
      }),
    scanNodeArtifacts: (projectId: string, runId: string, nodeId: string, expectedRevision: string, now: string, signal?: AbortSignal) =>
      request<NodeArtifactScan>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/nodes/${encodeURIComponent(nodeId)}/artifacts/scan`, {
        body: { expectedRevision, now }, signal,
      }),
    startInteractiveAgentSession: (
      projectId: string,
      runId: string,
      jobId: string,
      desktopSessionId: string,
      pid: number,
      now: string,
      signal?: AbortSignal,
    ) =>
      request<AgentSessionSummary>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/agents/${encodeURIComponent(jobId)}/interactive-session/start`,
        { body: { desktopSessionId, pid, actor: HUMAN_ACTOR, now }, signal },
      ),
    recordInteractiveAgentInput: (projectId: string, runId: string, jobId: string, content: string, now: string, signal?: AbortSignal) =>
      request<{ id: string; sessionId: string; sequence: number; kind: string; content: string; createdAt: string }>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/agents/${encodeURIComponent(jobId)}/interactive-session/input`,
        { body: { content, actor: HUMAN_ACTOR, now }, signal },
      ),
    appendInteractiveAgentOutput: (
      projectId: string,
      runId: string,
      jobId: string,
      events: InteractiveAgentOutputInput[],
      now: string,
      signal?: AbortSignal,
    ) =>
      request<AgentOutputSummary[]>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/agents/${encodeURIComponent(jobId)}/interactive-session/output`,
        { body: { events, now }, signal },
      ),
    finishInteractiveAgentSession: (
      projectId: string,
      runId: string,
      jobId: string,
      status: AgentSessionSummary["status"],
      summary: string | null,
      error: string | null,
      now: string,
      signal?: AbortSignal,
    ) =>
      request<AgentSessionSummary>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/agents/${encodeURIComponent(jobId)}/interactive-session/ended`,
        { body: { status, summary, error, actor: HUMAN_ACTOR, now }, signal },
      ),
    getInteractiveAgentSession: (projectId: string, runId: string, jobId: string, signal?: AbortSignal) =>
      request<AgentSessionSummary>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/agents/${encodeURIComponent(jobId)}/interactive-session`, { method: "GET", signal }),
    continueInteractiveAgent: (projectId: string, runId: string, jobId: string, now: string, signal?: AbortSignal) =>
      request<AgentJobSummary>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/agents/${encodeURIComponent(jobId)}/interactive-session/continue`,
        { body: { actor: HUMAN_ACTOR, now }, signal },
      ),
    listAgentJobs: (projectId: string, runId: string, signal?: AbortSignal) =>
      request<AgentJobSummary[]>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/agents`, { method: "GET", signal }),
    getAgentJob: (projectId: string, runId: string, jobId: string, signal?: AbortSignal) =>
      request<AgentJobSummary>(apiBaseUrl, `${scopedRunPath(projectId, runId)}/agents/${encodeURIComponent(jobId)}`, { method: "GET", signal }),
    listAgentOutput: (projectId: string, runId: string, jobId: string, afterSequence: number, signal?: AbortSignal) =>
      request<AgentOutputSummary[]>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/agents/${encodeURIComponent(jobId)}/output?afterSequence=${afterSequence}`,
        { method: "GET", signal },
      ),
    cancelAgentJob: (projectId: string, runId: string, jobId: string, now?: string, signal?: AbortSignal) =>
      request<AgentJobSummary>(
        apiBaseUrl,
        `${scopedRunPath(projectId, runId)}/agents/${encodeURIComponent(jobId)}/cancel`,
        now ? { body: { actor: HUMAN_ACTOR, now }, signal } : { method: "POST", signal },
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

const scopedRunPath = (projectId: string, runId: string) =>
  `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`;

const RUNTIME_IPC_PROTOCOL = "workflow-platform.runtime-ipc.v1#7f8c2a61";

export async function request<T>(
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
