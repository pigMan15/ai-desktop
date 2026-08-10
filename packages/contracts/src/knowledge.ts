import type { Actor } from "./events.js";

// ---------------------------------------------------------------------------
// Stable constants (document section 26)
// ---------------------------------------------------------------------------

export const KNOWLEDGE_REPOSITORY_STATUSES = [
  "ACTIVE",
  "RULES_PENDING",
  "BLOCKED",
  "REMOVED",
] as const;

export const KNOWLEDGE_RULE_SNAPSHOT_STATUSES = [
  "PROPOSED",
  "CONFIRMED",
  "SUPERSEDED",
  "STALE",
] as const;

export const KNOWLEDGE_CHANGE_SET_STATUSES = [
  "DRAFT",
  "GENERATING",
  "VALIDATING",
  "READY_TO_APPLY",
  "AWAITING_APPROVAL",
  "APPROVED",
  "APPLYING",
  "APPLIED",
  "PARTIALLY_STAGED",
  "STAGED",
  "COMMITTED",
  "STALE",
  "BLOCKED",
  "FAILED",
  "ABANDONED",
] as const;

export const KNOWLEDGE_RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "BLOCKED"] as const;

export const KNOWLEDGE_FILE_OPERATIONS = ["CREATE", "UPDATE"] as const;

export const KNOWLEDGE_FILE_CATEGORIES = [
  "KNOWLEDGE",
  "INDEX",
  "ROUTING",
  "RULE",
  "TEMPLATE",
] as const;

export const KNOWLEDGE_RULE_FILE_CATEGORIES = [
  "RULE",
  "INDEX",
  "ROUTING",
  "TEMPLATE",
  "REFERENCE",
] as const;

export const KNOWLEDGE_PROVIDERS = ["codex", "claude", "fake"] as const;

export const KNOWLEDGE_CHANGE_SET_MODES = ["preview", "risk-based"] as const;

export const KNOWLEDGE_EXAMPLE_MODES = ["complete", "template"] as const;

// ---------------------------------------------------------------------------
// Derived union types
// ---------------------------------------------------------------------------

export type KnowledgeRepositoryStatus = (typeof KNOWLEDGE_REPOSITORY_STATUSES)[number];
export type KnowledgeRuleSnapshotStatus = (typeof KNOWLEDGE_RULE_SNAPSHOT_STATUSES)[number];
export type KnowledgeChangeSetStatus = (typeof KNOWLEDGE_CHANGE_SET_STATUSES)[number];
export type KnowledgeRiskLevel = (typeof KNOWLEDGE_RISK_LEVELS)[number];
export type KnowledgeFileOperation = (typeof KNOWLEDGE_FILE_OPERATIONS)[number];
export type KnowledgeFileCategory = (typeof KNOWLEDGE_FILE_CATEGORIES)[number];
export type KnowledgeRuleFileCategory = (typeof KNOWLEDGE_RULE_FILE_CATEGORIES)[number];
export type KnowledgeProvider = (typeof KNOWLEDGE_PROVIDERS)[number];
export type KnowledgeChangeSetMode = (typeof KNOWLEDGE_CHANGE_SET_MODES)[number];
export type KnowledgeExampleMode = (typeof KNOWLEDGE_EXAMPLE_MODES)[number];

// ---------------------------------------------------------------------------
// Domain entities (document section 5)
// ---------------------------------------------------------------------------

export type KnowledgeRepositoryBinding = {
  id: string;
  name: string;
  rootPath: string;
  canonicalRootPath: string;
  repositoryIdentity: string;
  currentBranch: string | null;
  headCommit: string;
  defaultWritePolicy: "risk-based";
  autoApplyLowRisk: boolean;
  status: KnowledgeRepositoryStatus;
  activeRuleSnapshotId: string | null;
  revision: string;
  createdAt: string;
  updatedAt: string;
};

export type RuleFileReference = {
  path: string;
  category: KnowledgeRuleFileCategory;
  hash: string;
  sizeBytes: number;
  purpose: string;
};

export type RepositoryRuleSnapshot = {
  id: string;
  repositoryId: string;
  revision: string;
  headCommit: string;
  discoveredFiles: RuleFileReference[];
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
  confirmedBy: Actor | null;
  confirmedAt: string | null;
};

export type SourceArtifactSnapshot = {
  artifactId: string;
  projectId: string;
  runId: string;
  nodeId: string;
  workflowVersionId: string | null;
  type: string;
  uri: string;
  contentHash: string;
  status: "verified";
};

export type KnowledgeFileChange = {
  path: string;
  operation: KnowledgeFileOperation;
  category: KnowledgeFileCategory;
  reason: string;
  sourceArtifactIds: string[];
  beforeHash: string | null;
  proposedContent: string;
  proposedHash: string;
  warnings: string[];
};

export type KnowledgeUpdatePlan = {
  summary: string;
  facts: string[];
  inferences: string[];
  openQuestions: string[];
  files: Array<
    Pick<KnowledgeFileChange, "path" | "operation" | "reason" | "sourceArtifactIds">
  >;
};

export type ValidationResult = {
  validatorId: string;
  validatorType: "builtin" | "repository-command";
  status: "PASSED" | "FAILED" | "SKIPPED";
  summary: string;
  evidenceUri: string | null;
  evidenceHash: string | null;
};

export type KnowledgeChangeSet = {
  id: string;
  projectId: string;
  repositoryId: string;
  ruleSnapshotId: string;
  runId: string;
  sourceArtifacts: SourceArtifactSnapshot[];
  provider: KnowledgeProvider;
  mode: KnowledgeChangeSetMode;
  agentJobId: string | null;
  baseHeadCommit: string;
  baseWorkingTreeFingerprint: string;
  plan: KnowledgeUpdatePlan | null;
  fileChanges: KnowledgeFileChange[];
  unifiedDiff: string | null;
  riskLevel: KnowledgeRiskLevel | null;
  riskReasons: string[];
  validationResults: ValidationResult[];
  status: KnowledgeChangeSetStatus;
  approvalId: string | null;
  appliedAt: string | null;
  committedHash: string | null;
  revision: string;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeGitStatus = {
  rootPath: string;
  commonDir: string;
  branch: string | null;
  headCommit: string;
  dirty: boolean;
  conflict: boolean;
  worktreeFingerprint: string;
  stagedPaths: string[];
  unstagedPaths: string[];
};

export type KnowledgeApproval = {
  id: string;
  decision: "approved" | "rejected";
  actor: Actor;
  comment: string;
  artifactHashes: string[];
  ruleSnapshotHash: string;
  targetHashes: string[];
  baseHeadCommit: string;
  unifiedDiffHash: string;
  invalidatedAt: string | null;
};

export type KnowledgeAgentOutputEvent = {
  id: string;
  jobId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type KnowledgeAgentJobSummary = {
  id: string;
  projectId: string | null;
  runId: string | null;
  nodeId: string | null;
  purpose: "knowledge-rule-discovery" | "knowledge-change-set-generation";
  ownerId: string;
  provider: KnowledgeProvider;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  summary: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Actions and detail views (document section 26)
// ---------------------------------------------------------------------------

export type AllowedKnowledgeAction =
  | "discover-rules"
  | "confirm-rules"
  | "update-settings"
  | "remove-repository"
  | "create-change-set"
  | "generate"
  | "approve"
  | "reject"
  | "apply"
  | "abandon"
  | "stage"
  | "unstage"
  | "commit";

export type KnowledgeChangeSetSummary = Pick<
  KnowledgeChangeSet,
  | "id"
  | "projectId"
  | "repositoryId"
  | "runId"
  | "status"
  | "riskLevel"
  | "revision"
  | "createdAt"
  | "updatedAt"
>;

export type KnowledgeRepositoryDetail = KnowledgeRepositoryBinding & {
  gitStatus: KnowledgeGitStatus;
  activeRuleSnapshot: RepositoryRuleSnapshot | null;
  recentChangeSets: KnowledgeChangeSetSummary[];
  allowedActions: AllowedKnowledgeAction[];
};

export type KnowledgeChangeSetDetail = KnowledgeChangeSet & {
  repository: Pick<KnowledgeRepositoryBinding, "id" | "name" | "rootPath">;
  ruleSnapshot: RepositoryRuleSnapshot;
  output: KnowledgeAgentOutputEvent[];
  approval: KnowledgeApproval | null;
  allowedActions: AllowedKnowledgeAction[];
};

// ---------------------------------------------------------------------------
// Mutation envelope and requests / responses (document section 27)
// ---------------------------------------------------------------------------

export type KnowledgeMutationEnvelope = {
  actor: Actor;
  expectedRevision: string;
  now: string;
};

export type KnowledgeImportRequest = KnowledgeMutationEnvelope & {
  name: string;
  rootPath: string;
  autoApplyLowRisk: boolean;
};

export type KnowledgeExampleSummary = {
  id: string;
  name: string;
  description: string;
  modes: KnowledgeExampleMode[];
};

export type KnowledgeExampleInitializeRequest = {
  mode: KnowledgeExampleMode;
  targetPath: string;
  initializeGit: boolean;
  actor: Actor;
  now: string;
};

export type KnowledgeExampleInitializeResponse = {
  rootPath: string;
  createdFiles: string[];
  gitInitialized: boolean;
};

export type KnowledgeRuleDiscoveryRequest = KnowledgeMutationEnvelope & {
  provider: KnowledgeProvider;
};

export type KnowledgeRuleDiscoveryQueued = {
  jobId: string;
  repositoryId: string;
  status: "QUEUED";
};

export type KnowledgeRuleDiscoveryJob = KnowledgeAgentJobSummary & {
  result: RepositoryRuleSnapshot | null;
};

export type KnowledgeRuleSnapshotConfirmRequest = KnowledgeMutationEnvelope & {
  writablePaths: string[];
  protectedPaths: string[];
  indexFiles: string[];
  routingFiles: string[];
  templateFiles: string[];
  validationCommands: string[];
  summary: string;
  openQuestions: string[];
};

export type KnowledgeChangeSetCreateRequest = {
  repositoryId: string;
  artifactIds: string[];
  provider: KnowledgeProvider;
  mode: KnowledgeChangeSetMode;
  actor: Actor;
  now: string;
};

export type KnowledgeChangeSetGenerateRequest = KnowledgeMutationEnvelope;

export type KnowledgeChangeSetGenerateQueued = {
  jobId: string;
  changeSetId: string;
  status: "QUEUED";
};

export type KnowledgeChangeSetApproveRequest = KnowledgeMutationEnvelope & {
  comment: string;
};

export type KnowledgeChangeSetRejectRequest = KnowledgeMutationEnvelope & {
  comment: string;
};

export type KnowledgeChangeSetApplyRequest = KnowledgeMutationEnvelope;

export type KnowledgeChangeSetAbandonRequest = KnowledgeMutationEnvelope & {
  reason: string;
};

export type KnowledgeChangeSetListResponse = {
  items: KnowledgeChangeSetSummary[];
  nextCursor: string | null;
};

export type KnowledgeGitStageRequest = KnowledgeMutationEnvelope & {
  paths: string[];
  expectedRepositoryRevision: string;
};

export type KnowledgeGitUnstageRequest = KnowledgeGitStageRequest;

export type KnowledgeGitCommitRequest = KnowledgeMutationEnvelope & {
  title: string;
  body: string;
  paths: string[];
  expectedRepositoryRevision: string;
};

export type KnowledgeGitCommitResponse = {
  commitHash: string;
  branch: string;
  committedPaths: string[];
};

export type KnowledgeSettingsRequest = KnowledgeMutationEnvelope & {
  autoApplyLowRisk: boolean;
};

export type KnowledgeRemoveRepositoryRequest = KnowledgeMutationEnvelope;

// ---------------------------------------------------------------------------
// Agent output contract (document section 7.3)
// ---------------------------------------------------------------------------

export type KnowledgeAgentProposal = {
  summary: string;
  rulesUsed: Array<{ path: string; hash: string; purpose: string }>;
  sourceFindings: Array<{
    artifactId: string;
    facts: string[];
    inferences: string[];
    openQuestions: string[];
  }>;
  plan: Array<{
    path: string;
    operation: KnowledgeFileOperation;
    reason: string;
    sourceArtifactIds: string[];
  }>;
  changes: KnowledgeFileChange[];
  blockedReasons: string[];
  suggestedValidation: string[];
};
