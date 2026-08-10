import {
  ERROR_CODES,
  KNOWLEDGE_CHANGE_SET_STATUSES,
  KNOWLEDGE_FILE_CATEGORIES,
  KNOWLEDGE_FILE_OPERATIONS,
  KNOWLEDGE_PROVIDERS,
  KNOWLEDGE_REPOSITORY_STATUSES,
  KNOWLEDGE_RISK_LEVELS,
  KNOWLEDGE_RULE_FILE_CATEGORIES,
  KNOWLEDGE_RULE_SNAPSHOT_STATUSES,
  NODE_KINDS,
  NODE_STATES,
  RUN_EVENT_TYPES,
  type CreateRunRequest,
  type ExecuteRunActionRequest,
  type KnowledgeChangeSetDetail,
  type KnowledgeRepositoryDetail,
  type KnowledgeRepositoryStatus,
  type ExecuteRunActionResponse,
  type NodeState,
  type RunListResponse,
  type RunOverview,
  type RunProjection,
  type RunSummaryProjection,
  type RuntimeError,
  type TransitionResult,
  type WorkspaceLease,
  type WorkflowDefinition,
  type WorkflowMetadata,
  type WorkflowRole,
} from "./index.js";

function it(name: string, test: () => void): void {
  try {
    test();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function expect<T>(actual: T): { toEqual(expected: T): void } {
  return {
    toEqual(expected: T): void {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
      }
    },
  };
}

it("exports stable workflow constants in plan order", () => {
  expect([...NODE_KINDS]).toEqual([
    "task",
    "agent",
    "approval",
    "gate",
    "evidence",
    "deploy",
    "report",
    "composite",
  ]);
});

it("exports stable runtime event constants in plan order", () => {
  expect([...RUN_EVENT_TYPES]).toEqual([
    "RUN_CREATED",
    "NODE_STARTED",
    "ARTIFACT_SUBMITTED",
    "ARTIFACT_INVALIDATED",
    "APPROVAL_REQUESTED",
    "HUMAN_APPROVED",
    "HUMAN_REJECTED",
    "HUMAN_DEFERRED",
    "GATE_STARTED",
    "GATE_PASSED",
    "GATE_FAILED",
    "GATE_WAIVED",
    "NODE_COMPLETED",
    "NODE_FAILED",
    "NODE_RETRIED",
    "RUN_BLOCKED",
    "RUN_PAUSED",
    "RUN_RESUMED",
    "RUN_COMPLETED",
    "RUN_ARCHIVED",
  ]);
});

it("exports stable node state constants in runtime order", () => {
  expect([...NODE_STATES]).toEqual([
    "PENDING",
    "READY",
    "RUNNING",
    "AWAITING_ARTIFACT",
    "AWAITING_APPROVAL",
    "AWAITING_GATE",
    "PASSED",
    "FAILED",
    "BLOCKED",
    "SKIPPED",
  ]);
});

it("exports stable error constants in plan order", () => {
  expect([...ERROR_CODES]).toEqual([
    "VALIDATION_ERROR",
    "ADAPTER_UNSUPPORTED",
    "WORKFLOW_DIAGNOSTICS_ERROR",
    "REVISION_CONFLICT",
    "PERMISSION_DENIED",
    "INVALID_TRANSITION",
    "MISSING_ARTIFACT",
    "UNSAFE_PATH",
    "MISSING_EVIDENCE",
    "GATE_FAILED",
    "APPROVAL_REJECTED",
    "RUNTIME_UNAVAILABLE",
    "TERMINAL_UNAVAILABLE",
    "INVALID_REQUEST",
    "RUN_NOT_FOUND_IN_PROJECT",
    "WORKSPACE_LEASE_CONFLICT",
    "PROJECT_ARCHIVED",
    "RUN_ARCHIVED",
    "WORKSPACE_RECOVERY_REQUIRED",
    "RUN_REARCHITECTURE_MAINTENANCE",
    "RUN_CONCURRENCY_LIMIT",
    "AGENT_CONCURRENCY_LIMIT",
    "PROJECT_CONCURRENCY_INVALID",
    "KNOWLEDGE_INPUT_INVALID",
    "KNOWLEDGE_REPOSITORY_NOT_GIT",
    "KNOWLEDGE_REPOSITORY_DUPLICATE",
    "KNOWLEDGE_REVISION_CONFLICT",
    "KNOWLEDGE_RULES_NOT_CONFIRMED",
    "KNOWLEDGE_PATH_OUTSIDE_REPOSITORY",
    "KNOWLEDGE_PATH_PROTECTED",
    "KNOWLEDGE_BASELINE_CHANGED",
    "KNOWLEDGE_GIT_CONFLICT",
    "KNOWLEDGE_AGENT_OUTPUT_INVALID",
    "KNOWLEDGE_VALIDATION_FAILED",
    "KNOWLEDGE_APPROVAL_INVALIDATED",
    "KNOWLEDGE_APPLY_ROLLBACK_FAILED",
    "KNOWLEDGE_GIT_IDENTITY_MISSING",
    "KNOWLEDGE_CHANGE_SET_NOT_APPLIED",
    "KNOWLEDGE_JOB_ALREADY_RUNNING",
    "IDEMPOTENCY_KEY_REUSED",
    "KNOWLEDGE_CHANGE_SET_NOT_FOUND_IN_RUN",
    "KNOWLEDGE_AGENT_JOB_LOST",
    "KNOWLEDGE_PROVIDER_ISOLATION_UNAVAILABLE",
    "KNOWLEDGE_INPUT_LIMIT_EXCEEDED",
    "KNOWLEDGE_REPOSITORY_BUSY",
  ]);
});

it("accepts multi-run RPC contract shapes", () => {
  const actor = {
    id: "user-1",
    type: "human" as const,
    source: "renderer" as const,
    trusted: true,
  };
  const summary: RunSummaryProjection = {
    id: "run-1",
    projectId: "project-1",
    workflowVersionId: "workflow-version-1",
    workflowName: "Release workflow",
    workflowVersion: "1.0.0",
    title: "Ship release",
    status: "IN_PROGRESS",
    taskGoal: "Publish the verified release.",
    currentNodes: [{ id: "build", name: "Build", kind: "agent", state: "RUNNING" }],
    nextNodes: [{ id: "approve", name: "Approve", kind: "approval", condition: "build passed" }],
    progress: { total: 3, passed: 1, running: 1, blocked: 0, pending: 1 },
    blocker: null,
    workspace: {
      path: "G:/work/release",
      label: "release",
      leaseMode: "write",
      leaseStatus: "active",
    },
    activeAgentCount: 1,
    activeDeploymentCount: 0,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:01:00.000Z",
  };
  const lease: WorkspaceLease = {
    id: "lease-1",
    projectId: "project-1",
    runId: "run-1",
    workspacePath: "G:/work/release",
    mode: "write",
    status: "active",
    acquiredAt: "2026-08-05T00:00:00.000Z",
    lastVerifiedAt: "2026-08-05T00:01:00.000Z",
    releasedAt: null,
    releaseReason: null,
  };
  const createRequest: CreateRunRequest = {
    workflowVersionId: "workflow-version-1",
    title: "Ship release",
    taskGoal: "Publish the verified release.",
    parameters: { channel: "stable" },
    executionWorkspace: { path: "G:/work/release", mode: "write" },
    actor,
  };
  const actionRequest: ExecuteRunActionRequest = {
    actionId: "approve-build",
    expectedRevision: "rev-1",
    actor,
    payload: { comment: "Approved" },
  };
  const listResponse: RunListResponse = { items: [summary], nextCursor: "cursor-2" };
  const runtimeError: RuntimeError = {
    code: "WORKSPACE_LEASE_CONFLICT",
    message: "Workspace is already leased.",
    details: { leaseId: lease.id },
    correlationId: "correlation-1",
  };

  expect({
    status: listResponse.items[0]?.status,
    leaseMode: lease.mode,
    workspaceMode: createRequest.executionWorkspace.mode,
    actionId: actionRequest.actionId,
    errorCode: runtimeError.code,
    cursor: listResponse.nextCursor,
  }).toEqual({
    status: "IN_PROGRESS",
    leaseMode: "write",
    workspaceMode: "write",
    actionId: "approve-build",
    errorCode: "WORKSPACE_LEASE_CONFLICT",
    cursor: "cursor-2",
  });
});

it("accepts canonical project-scoped Run overview and action response shapes", () => {
  const workflow: WorkflowDefinition = {
    id: "workflow-1",
    name: "Release workflow snapshot",
    version: "4",
    sourceAdapter: "harness",
    nodes: [{ id: "plan", name: "Plan", kind: "task" }],
    edges: [],
    roles: [],
    gates: [],
    policies: {},
    metadata: {},
  };
  const projection: RunProjection = {
    runId: "run-1",
    status: "IN_PROGRESS",
    currentNodeIds: ["plan"],
    nodeStates: { plan: "RUNNING" },
    allowedActions: [],
    blockingReasons: [],
    revision: "2",
    updatedAt: "2026-08-06T00:01:00.000Z",
  };
  const workspace: WorkspaceLease = {
    id: "lease-1",
    projectId: "project-1",
    runId: "run-1",
    workspacePath: "G:/work/release",
    mode: "write",
    status: "active",
    acquiredAt: "2026-08-06T00:00:00.000Z",
    lastVerifiedAt: "2026-08-06T00:01:00.000Z",
    releasedAt: null,
    releaseReason: null,
  };
  const overview: RunOverview = {
    run: {
      id: "run-1",
      projectId: "project-1",
      workflowVersionId: "workflow-version-1",
      workflowSnapshot: workflow,
      title: "Release candidate",
      context: { taskGoal: "Ship", parameters: { dryRun: true } },
      executionWorkspace: "G:/work/release",
      workspaceMode: "write",
      status: "IN_PROGRESS",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:01:00.000Z",
    },
    projection,
    workflow,
    workspace,
    activity: {
      activeAgentCount: 1,
      activeDeploymentCount: 0,
      lastEventAt: "2026-08-06T00:01:00.000Z",
    },
  };
  const actionResponse: ExecuteRunActionResponse = {
    projection,
    emittedEvents: [],
  };

  expect({
    snapshotName: overview.workflow.name,
    sameSnapshot: overview.workflow === overview.run.workflowSnapshot,
    workspaceRunId: overview.workspace?.runId,
    activeAgents: overview.activity.activeAgentCount,
    actionRevision: actionResponse.projection.revision,
    emittedCount: actionResponse.emittedEvents.length,
  }).toEqual({
    snapshotName: "Release workflow snapshot",
    sameSnapshot: true,
    workspaceRunId: "run-1",
    activeAgents: 1,
    actionRevision: "2",
    emittedCount: 0,
  });
});

it("accepts planned workflow, projection, and transition shapes", () => {
  const role: WorkflowRole = {
    id: "engineer",
    name: "Engineer",
    instructions: "Build and verify the change.",
    provider: "codex",
    allowedTools: ["terminal"],
  };
  const metadata: WorkflowMetadata = {
    canvas: {
      nodes: {
        "node-1": { x: 120, y: 80 },
      },
    },
    importedAt: "2026-07-27T00:00:00.000Z",
  };
  const workflow: WorkflowDefinition = {
    id: "workflow-1",
    name: "Release workflow",
    version: "1.0.0",
    sourceAdapter: "harness",
    nodes: [
      {
        id: "node-1",
        name: "Build",
        kind: "agent",
        requires: [{ type: "artifact", artifactType: "build-log", required: true }],
        gates: ["unit-tests"],
        metadata: { owner: "platform" },
        artifacts: {
          outputs: [
            {
              id: "build-log",
              name: "构建日志",
              type: "build-log",
              required: true,
              path: "reports/{{runId}}/build.log",
            },
          ],
        },
        agent: {
          roleId: "engineer",
          context: {
            upstream: "direct",
            maxArtifacts: 8,
            summaryCharsPerArtifact: 4000,
            maxTotalChars: 16000,
          },
        },
        advance: { mode: "manual" },
      },
    ],
    edges: [
      {
        id: "edge-1",
        from: "node-1",
        to: "node-2",
        trigger: "NODE_COMPLETED",
        metadata: { automatic: true },
      },
    ],
    roles: [role],
    gates: [{ id: "unit-tests", name: "Unit tests" }],
    policies: { approvalsRequired: 1 },
    metadata,
  };

  const waitingForApproval: NodeState = "AWAITING_APPROVAL";
  const run: RunProjection = {
    runId: "run-1",
    status: "REVIEWING",
    currentNodeIds: ["node-1"],
    nodeStates: { "node-1": waitingForApproval },
    allowedActions: [
      {
        id: "approve-node-1",
        label: "Approve",
        eventType: "HUMAN_APPROVED",
        nodeId: "node-1",
        risk: "medium",
      },
    ],
    blockingReasons: [{ code: "APPROVAL_REQUIRED", message: "Approval is required", nodeId: "node-1" }],
    revision: "rev-1",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };

  const transition: TransitionResult = {
    run,
    accepted: true,
    revision: "rev-2",
    allowedActions: [],
    blockingReasons: [],
    emittedEvents: [
      {
        id: "event-1",
        runId: "run-1",
        type: "HUMAN_APPROVED",
        nodeId: "node-1",
        actor: {
          id: "user-1",
          type: "human",
          source: "renderer",
          trusted: true,
        },
        payload: { comment: "Looks good" },
        createdAt: "2026-07-27T00:00:00.000Z",
        revision: "rev-2",
      },
    ],
  };

  expect({
    workflowId: workflow.id,
    roleInstructions: workflow.roles[0]?.instructions,
    agentRoleId: workflow.nodes[0]?.agent?.roleId,
    nodePosition: workflow.metadata.canvas?.nodes["node-1"],
    runStatus: transition.run.status,
    emittedType: transition.emittedEvents[0]?.type,
  }).toEqual({
    workflowId: "workflow-1",
    roleInstructions: "Build and verify the change.",
    agentRoleId: "engineer",
    nodePosition: { x: 120, y: 80 },
    runStatus: "REVIEWING",
    emittedType: "HUMAN_APPROVED",
  });
});

it("accepts legacy workflows without role instructions or canvas metadata", () => {
  const workflow: WorkflowDefinition = {
    id: "legacy-workflow",
    name: "Legacy workflow",
    version: "1.0.0",
    sourceAdapter: "legacy",
    nodes: [{ id: "agent-1", name: "Agent", kind: "agent" }],
    edges: [],
    roles: [{ id: "engineer", name: "Engineer" }],
    gates: [],
    policies: {},
    metadata: {},
  };

  expect({
    role: workflow.roles[0],
    node: workflow.nodes[0],
    metadata: workflow.metadata,
  }).toEqual({
    role: { id: "engineer", name: "Engineer" },
    node: { id: "agent-1", name: "Agent", kind: "agent" },
    metadata: {},
  });
});

it("exports stable knowledge repository constants in plan order", () => {
  expect([...KNOWLEDGE_REPOSITORY_STATUSES]).toEqual([
    "ACTIVE",
    "RULES_PENDING",
    "BLOCKED",
    "REMOVED",
  ]);
});

it("exports stable knowledge rule snapshot constants in plan order", () => {
  expect([...KNOWLEDGE_RULE_SNAPSHOT_STATUSES]).toEqual([
    "PROPOSED",
    "CONFIRMED",
    "SUPERSEDED",
    "STALE",
  ]);
});

it("exports stable knowledge change set constants in state machine order", () => {
  expect([...KNOWLEDGE_CHANGE_SET_STATUSES]).toEqual([
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
  ]);
});

it("exports stable knowledge risk, operation, category, and provider constants", () => {
  expect([...KNOWLEDGE_RISK_LEVELS]).toEqual(["LOW", "MEDIUM", "HIGH", "BLOCKED"]);
  expect([...KNOWLEDGE_FILE_OPERATIONS]).toEqual(["CREATE", "UPDATE"]);
  expect([...KNOWLEDGE_FILE_CATEGORIES]).toEqual([
    "KNOWLEDGE",
    "INDEX",
    "ROUTING",
    "RULE",
    "TEMPLATE",
  ]);
  expect([...KNOWLEDGE_RULE_FILE_CATEGORIES]).toEqual([
    "RULE",
    "INDEX",
    "ROUTING",
    "TEMPLATE",
    "REFERENCE",
  ]);
  expect([...KNOWLEDGE_PROVIDERS]).toEqual(["codex", "claude", "fake"]);
});

it("accepts knowledge repository and change set detail shapes", () => {
  const repositoryStatus: KnowledgeRepositoryStatus = "ACTIVE";
  const repository: KnowledgeRepositoryDetail = {
    id: "knowledge-repository-1",
    name: "物流知识库",
    rootPath: "D:\\knowledge\\logistics",
    canonicalRootPath: "D:\\knowledge\\logistics",
    repositoryIdentity: "sha256-identity",
    currentBranch: "main",
    headCommit: "abc123",
    defaultWritePolicy: "risk-based",
    autoApplyLowRisk: false,
    status: repositoryStatus,
    activeRuleSnapshotId: null,
    revision: "1",
    createdAt: "2026-08-10T00:00:00Z",
    updatedAt: "2026-08-10T00:00:00Z",
    gitStatus: {
      rootPath: "D:\\knowledge\\logistics",
      commonDir: "D:\\knowledge\\logistics\\.git",
      branch: "main",
      headCommit: "abc123",
      dirty: false,
      conflict: false,
      worktreeFingerprint: "fingerprint",
      stagedPaths: [],
      unstagedPaths: [],
    },
    activeRuleSnapshot: null,
    recentChangeSets: [],
    allowedActions: ["discover-rules", "remove-repository"],
  };

  const changeSet: KnowledgeChangeSetDetail = {
    id: "knowledge-change-set-1",
    projectId: "project-1",
    repositoryId: "knowledge-repository-1",
    ruleSnapshotId: "snapshot-1",
    runId: "run-1",
    sourceArtifacts: [],
    provider: "fake",
    mode: "preview",
    agentJobId: null,
    baseHeadCommit: "abc123",
    baseWorkingTreeFingerprint: "fingerprint",
    plan: null,
    fileChanges: [],
    unifiedDiff: null,
    riskLevel: null,
    riskReasons: [],
    validationResults: [],
    status: "DRAFT",
    approvalId: null,
    appliedAt: null,
    committedHash: null,
    revision: "1",
    createdAt: "2026-08-10T00:00:00Z",
    updatedAt: "2026-08-10T00:00:00Z",
    repository: {
      id: "knowledge-repository-1",
      name: "物流知识库",
      rootPath: "D:\\knowledge\\logistics",
    },
    ruleSnapshot: {
      id: "snapshot-1",
      repositoryId: "knowledge-repository-1",
      revision: "1",
      headCommit: "abc123",
      discoveredFiles: [],
      writablePaths: [],
      protectedPaths: [],
      indexFiles: [],
      routingFiles: [],
      templateFiles: [],
      validationCommands: [],
      summary: "summary",
      openQuestions: [],
      source: "manifest",
      contentHash: "hash",
      status: "CONFIRMED",
      confirmedBy: null,
      confirmedAt: null,
    },
    output: [],
    approval: null,
    allowedActions: ["generate"],
  };

  expect({
    repositoryStatus: repository.status,
    changeSetStatus: changeSet.status,
    provider: changeSet.provider,
    firstAction: repository.allowedActions[0],
  }).toEqual({
    repositoryStatus: "ACTIVE",
    changeSetStatus: "DRAFT",
    provider: "fake",
    firstAction: "discover-rules",
  });
});
