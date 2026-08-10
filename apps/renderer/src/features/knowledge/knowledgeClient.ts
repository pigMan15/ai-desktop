import type {
  AllowedKnowledgeAction,
  KnowledgeChangeSetDetail,
  KnowledgeChangeSetMode,
  KnowledgeExampleInitializeResponse,
  KnowledgeExampleSummary,
  KnowledgeGitCommitResponse,
  KnowledgeProvider,
  KnowledgeRepositoryDetail,
  KnowledgeRuleSnapshotStatus,
} from "@workflow-platform/contracts";
import { request, RuntimeClientError } from "../../app/runtimeClient";

export type KnowledgeRepositorySummary = KnowledgeRepositoryDetail;

export type KnowledgeRuleSnapshotSummary = {
  id: string;
  repositoryId: string;
  revision: string;
  headCommit: string;
  discoveredFiles: Array<{ path: string; category: string; hash: string; sizeBytes: number; purpose: string }>;
  writablePaths: string[];
  protectedPaths: string[];
  indexFiles: string[];
  routingFiles: string[];
  templateFiles: string[];
  validationCommands: string[];
  summary: string;
  openQuestions: string[];
  source: "manifest" | "agent-discovery" | "hybrid";
  contentHash: string;
  status: KnowledgeRuleSnapshotStatus;
  confirmedBy: { id: string; type: string; source: string; trusted: boolean } | null;
  confirmedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type KnowledgeRuleDiscoveryJob = {
  id: string;
  projectId: string | null;
  runId: string | null;
  nodeId: string | null;
  purpose: string;
  ownerId: string;
  provider: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  result: KnowledgeRuleSnapshotSummary | null;
};

export type Actor = {
  id: string;
  type: "human" | "agent" | "system" | "verifier" | "executor" | "adapter";
  source: "renderer" | "runtime" | "terminal" | "agent" | "adapter";
  trusted: boolean;
};

export type KnowledgeClient = {
  listRepositories: () => Promise<KnowledgeRepositorySummary[]>;
  importRepository: (input: { name: string; rootPath: string; autoApplyLowRisk: boolean; actor: Actor; now: string }) => Promise<KnowledgeRepositoryDetail>;
  getRepository: (repositoryId: string) => Promise<KnowledgeRepositoryDetail>;
  removeRepository: (repositoryId: string, input: { actor: Actor; expectedRevision: string; now: string }) => Promise<KnowledgeRepositoryDetail>;
  discoverRules: (repositoryId: string, input: { provider: KnowledgeProvider; actor: Actor; expectedRevision: string; now: string }) => Promise<{ jobId: string; repositoryId: string; status: "QUEUED" }>;
  getRuleDiscoveryJob: (repositoryId: string, jobId: string) => Promise<KnowledgeRuleDiscoveryJob>;
  cancelRuleDiscovery: (
    repositoryId: string,
    jobId: string,
    input: { actor: Actor; expectedRevision: string; now: string },
  ) => Promise<{
    id: string;
    purpose: string;
    ownerId: string;
    provider: string;
    status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
    summary: string | null;
    error: string | null;
  }>;
  listRuleDiscoveryOutput: (
    repositoryId: string,
    jobId: string,
    afterSequence: number,
  ) => Promise<{
    items: Array<{
      id: string;
      jobId: string;
      sequence: number;
      kind: string;
      payload: Record<string, unknown>;
      createdAt: string;
    }>;
  }>;
  listRuleSnapshots: (repositoryId: string) => Promise<KnowledgeRuleSnapshotSummary[]>;
  confirmRuleSnapshot: (
    repositoryId: string,
    snapshotId: string,
    input: {
      writablePaths: string[];
      protectedPaths: string[];
      indexFiles: string[];
      routingFiles: string[];
      templateFiles: string[];
      validationCommands: string[];
      summary: string;
      openQuestions: string[];
      actor: Actor;
      expectedRevision: string;
      now: string;
    },
  ) => Promise<KnowledgeRepositoryDetail>;
  updateSettings: (repositoryId: string, input: { autoApplyLowRisk: boolean; actor: Actor; expectedRevision: string; now: string }) => Promise<KnowledgeRepositoryDetail>;
  gitStatus: (repositoryId: string) => Promise<{
    rootPath: string;
    commonDir: string;
    branch: string | null;
    headCommit: string;
    dirty: boolean;
    conflict: boolean;
    worktreeFingerprint: string;
    stagedPaths: string[];
    unstagedPaths: string[];
  }>;
  gitDiff: (repositoryId: string, scope: "working" | "staged") => Promise<{ diff: string }>;
  listExamples: () => Promise<{ items: KnowledgeExampleSummary[] }>;
  initializeExample: (exampleId: string, input: { mode: "complete" | "template"; targetPath: string; initializeGit: boolean; actor: Actor; now: string }) => Promise<KnowledgeExampleInitializeResponse>;
  createChangeSet: (
    projectId: string,
    runId: string,
    input: { repositoryId: string; artifactIds: string[]; provider: KnowledgeProvider; mode: KnowledgeChangeSetMode; actor: Actor; now: string },
  ) => Promise<KnowledgeChangeSetDetail>;
  listChangeSets: (projectId: string, runId: string) => Promise<{ items: Array<{ id: string; repositoryId: string; runId: string; status: string; riskLevel: string | null; revision: string; createdAt: string; updatedAt: string }>; nextCursor: string | null }>;
  getChangeSet: (projectId: string, runId: string, changeSetId: string) => Promise<KnowledgeChangeSetDetail>;
  generateChangeSet: (projectId: string, runId: string, changeSetId: string, input: { actor: Actor; expectedRevision: string; now: string }) => Promise<{ jobId: string; changeSetId: string; status: "QUEUED" }>;
  approveChangeSet: (projectId: string, runId: string, changeSetId: string, input: { comment: string; actor: Actor; expectedRevision: string; now: string }) => Promise<KnowledgeChangeSetDetail>;
  rejectChangeSet: (projectId: string, runId: string, changeSetId: string, input: { comment: string; actor: Actor; expectedRevision: string; now: string }) => Promise<KnowledgeChangeSetDetail>;
  applyChangeSet: (projectId: string, runId: string, changeSetId: string, input: { actor: Actor; expectedRevision: string; now: string }) => Promise<KnowledgeChangeSetDetail>;
  abandonChangeSet: (projectId: string, runId: string, changeSetId: string, input: { reason: string; actor: Actor; expectedRevision: string; now: string }) => Promise<KnowledgeChangeSetDetail>;
  gitStage: (projectId: string, runId: string, changeSetId: string, input: { paths: string[]; actor: Actor; expectedRevision: string; expectedRepositoryRevision: string; now: string }) => Promise<KnowledgeChangeSetDetail>;
  gitUnstage: (projectId: string, runId: string, changeSetId: string, input: { paths: string[]; actor: Actor; expectedRevision: string; expectedRepositoryRevision: string; now: string }) => Promise<KnowledgeChangeSetDetail>;
  gitCommit: (projectId: string, runId: string, changeSetId: string, input: { title: string; body: string; paths: string[]; actor: Actor; expectedRevision: string; expectedRepositoryRevision: string; now: string }) => Promise<KnowledgeGitCommitResponse>;
};

export { RuntimeClientError };

export function createKnowledgeClient(apiBaseUrl: string): KnowledgeClient {
  const now = () => new Date().toISOString();
  const humanActor = (): Actor => ({ id: "renderer-user", type: "human", source: "renderer", trusted: true });

  return {
    listRepositories: async () => {
      const response = await request<{ items: KnowledgeRepositorySummary[] }>(apiBaseUrl, "/knowledge-repositories");
      return response.items;
    },
    importRepository: async (input) => request(apiBaseUrl, "/knowledge-repositories/import", { method: "POST", body: { ...input, now: input.now } }),
    getRepository: async (repositoryId) => request(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}`),
    removeRepository: async (repositoryId, input) => request(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}/remove`, { method: "POST", body: input }),
    discoverRules: async (repositoryId, input) => request(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}/discover-rules`, { method: "POST", body: input }),
    getRuleDiscoveryJob: async (repositoryId, jobId) => request(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}/rule-discovery-jobs/${encodeURIComponent(jobId)}`),
    cancelRuleDiscovery: async (repositoryId, jobId, input) =>
      request(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}/rule-discovery-jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: input }),
    listRuleDiscoveryOutput: async (repositoryId, jobId, afterSequence) =>
      request(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}/rule-discovery-jobs/${encodeURIComponent(jobId)}/output?afterSequence=${afterSequence}`),
    listRuleSnapshots: async (repositoryId) => {
      const response = await request<{ items: KnowledgeRuleSnapshotSummary[] }>(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}/rule-snapshots`);
      return response.items;
    },
    confirmRuleSnapshot: async (repositoryId, snapshotId, input) => request(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}/rule-snapshots/${encodeURIComponent(snapshotId)}/confirm`, { method: "POST", body: input }),
    updateSettings: async (repositoryId, input) => request(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}/settings`, { method: "POST", body: input }),
    gitStatus: async (repositoryId) => request(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}/git/status`),
    gitDiff: async (repositoryId, scope) => request(apiBaseUrl, `/knowledge-repositories/${encodeURIComponent(repositoryId)}/git/diff?scope=${encodeURIComponent(scope)}`),
    listExamples: async () => request(apiBaseUrl, "/knowledge-examples"),
    initializeExample: async (exampleId, input) => request(apiBaseUrl, `/knowledge-examples/${encodeURIComponent(exampleId)}/initialize`, { method: "POST", body: input }),
    createChangeSet: async (projectId, runId, input) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets`, { method: "POST", body: input }),
    listChangeSets: async (projectId, runId) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets`),
    getChangeSet: async (projectId, runId, changeSetId) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets/${encodeURIComponent(changeSetId)}`),
    generateChangeSet: async (projectId, runId, changeSetId, input) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets/${encodeURIComponent(changeSetId)}/generate`, { method: "POST", body: input }),
    approveChangeSet: async (projectId, runId, changeSetId, input) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets/${encodeURIComponent(changeSetId)}/approve`, { method: "POST", body: input }),
    rejectChangeSet: async (projectId, runId, changeSetId, input) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets/${encodeURIComponent(changeSetId)}/reject`, { method: "POST", body: input }),
    applyChangeSet: async (projectId, runId, changeSetId, input) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets/${encodeURIComponent(changeSetId)}/apply`, { method: "POST", body: input }),
    abandonChangeSet: async (projectId, runId, changeSetId, input) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets/${encodeURIComponent(changeSetId)}/abandon`, { method: "POST", body: input }),
    gitStage: async (projectId, runId, changeSetId, input) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets/${encodeURIComponent(changeSetId)}/git/stage`, { method: "POST", body: input }),
    gitUnstage: async (projectId, runId, changeSetId, input) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets/${encodeURIComponent(changeSetId)}/git/unstage`, { method: "POST", body: input }),
    gitCommit: async (projectId, runId, changeSetId, input) => request(apiBaseUrl, `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/knowledge-change-sets/${encodeURIComponent(changeSetId)}/git/commit`, { method: "POST", body: input }),
  };
}
