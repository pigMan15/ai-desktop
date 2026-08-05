import type {
  CreateRunRequest,
  ExecuteRunActionResponse,
  NodeKind,
  RequirementSpec,
  RunEventType,
  RunOverview,
  RunSummaryProjection,
  TransitionResult,
  WorkspaceLease,
} from "./index.js";

declare const validRunOverview: RunOverview;

const invalidOverviewWorkflow: RunOverview = {
  ...validRunOverview,
  // @ts-expect-error RunOverview requires a workflow snapshot object.
  workflow: undefined,
};

const invalidOverviewActivity: RunOverview = {
  ...validRunOverview,
  activity: {
    ...validRunOverview.activity,
    // @ts-expect-error Run activity counts are numeric.
    activeAgentCount: "one",
  },
};

// @ts-expect-error ExecuteRunActionResponse requires emittedEvents.
const actionResponseWithoutEvents: ExecuteRunActionResponse = {
  projection: validRunOverview.projection,
};

void invalidOverviewWorkflow;
void invalidOverviewActivity;
void actionResponseWithoutEvents;

const plannedNodeKind: NodeKind = "agent";
const plannedRunEventType: RunEventType = "HUMAN_APPROVED";
const plannedRequirement: RequirementSpec = {
  type: "gate",
  gateId: "security-review",
  required: true,
};

void plannedNodeKind;
void plannedRunEventType;
void plannedRequirement;

// @ts-expect-error NodeKind is limited to the planned node kind constants.
const invalidNodeKind: NodeKind = "manual";

// @ts-expect-error RunEventType is limited to the planned runtime event constants.
const invalidRunEventType: RunEventType = "RUN_STARTED";

const invalidRequirementFieldMix: RequirementSpec = {
  type: "artifact",
  // @ts-expect-error RequirementSpec artifact requirements need artifact fields, not gate fields.
  gateId: "security-review",
  required: true,
};

const invalidRequirementKind: RequirementSpec = {
  // @ts-expect-error RequirementSpec only accepts the planned discriminant values.
  type: "checkpoint",
  required: true,
};

// @ts-expect-error TransitionResult requires run, revision, allowedActions, blockingReasons, and emittedEvents.
const incompleteTransition: TransitionResult = {
  accepted: true,
};

void invalidNodeKind;
void invalidRunEventType;
void invalidRequirementFieldMix;
void invalidRequirementKind;
void incompleteTransition;

const invalidWorkspaceLeaseMode: WorkspaceLease = {
  id: "lease-1",
  projectId: "project-1",
  runId: "run-1",
  workspacePath: "G:/work/release",
  // @ts-expect-error WorkspaceLease mode is limited to read or write.
  mode: "exclusive",
  status: "active",
  acquiredAt: "2026-08-05T00:00:00.000Z",
  lastVerifiedAt: "2026-08-05T00:00:00.000Z",
  releasedAt: null,
  releaseReason: null,
};

// @ts-expect-error CreateRunRequest requires an execution workspace.
const createRunWithoutWorkspace: CreateRunRequest = {
  workflowVersionId: "workflow-version-1",
  title: "Ship release",
  actor: { id: "user-1", type: "human", source: "renderer", trusted: true },
};

const invalidRunSummaryStatus: RunSummaryProjection = {
  id: "run-1",
  projectId: "project-1",
  workflowVersionId: "workflow-version-1",
  workflowName: "Release workflow",
  workflowVersion: "1.0.0",
  title: "Ship release",
  // @ts-expect-error RunSummaryProjection status is limited to RunStatus.
  status: "RUNNING",
  taskGoal: null,
  currentNodes: [],
  nextNodes: [],
  progress: { total: 0, passed: 0, running: 0, blocked: 0, pending: 0 },
  blocker: null,
  workspace: null,
  activeAgentCount: 0,
  activeDeploymentCount: 0,
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
};

void invalidWorkspaceLeaseMode;
void createRunWithoutWorkspace;
void invalidRunSummaryStatus;
