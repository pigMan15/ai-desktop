from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


NODE_KINDS = (
    "task",
    "agent",
    "approval",
    "gate",
    "evidence",
    "deploy",
    "report",
    "composite",
)

RUN_EVENT_TYPES = (
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
)

NodeKind = Literal[
    "task",
    "agent",
    "approval",
    "gate",
    "evidence",
    "deploy",
    "report",
    "composite",
]
RunEventType = Literal[
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
]
ActorType = Literal["human", "agent", "system", "verifier", "executor", "adapter"]
ActorSource = Literal["renderer", "runtime", "terminal", "agent", "adapter"]
RunStatus = Literal[
    "CREATED",
    "IN_PROGRESS",
    "REVIEWING",
    "BLOCKED",
    "PAUSED",
    "DONE",
    "ARCHIVED",
]
AgentProvider = Literal["codex", "claude", "fake"]
AgentMode = Literal["interactive", "automatic"]
AgentJobStatus = Literal["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]
AgentSessionStatus = Literal[
    "QUEUED",
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "RECOVERABLE",
]
NodeState = Literal[
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
]
ActionRisk = Literal["low", "medium", "high"]
RequirementType = Literal["artifact", "approval", "gate", "evidence"]
ArtifactContextScope = Literal["none", "direct", "ancestors"]
ArtifactContextDelivery = Literal["path", "hybrid", "summary"]
AdvanceMode = Literal["manual", "auto"]


class CanonicalModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class RequirementSpec(CanonicalModel):
    type: RequirementType
    artifactType: str | None = None
    approvalRole: str | None = None
    gateId: str | None = None
    evidenceType: str | None = None
    required: bool = True


class ArtifactOutputSpec(CanonicalModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    type: str = Field(min_length=1)
    required: bool
    path: str = Field(min_length=1)
    templatePath: str | None = None
    description: str | None = None


class NodeArtifactSpec(CanonicalModel):
    outputs: list[ArtifactOutputSpec] = Field(default_factory=list)


class AgentContextSpec(CanonicalModel):
    upstream: ArtifactContextScope = "none"
    delivery: ArtifactContextDelivery = "path"
    artifactTypes: list[str] = Field(default_factory=list)
    maxArtifacts: int = 8
    summaryCharsPerArtifact: int = 4000
    maxTotalChars: int = 16000

    @model_validator(mode="before")
    @classmethod
    def preserve_legacy_summary_delivery(cls, value: Any) -> Any:
        if isinstance(value, dict) and "delivery" not in value and (
            "summaryCharsPerArtifact" in value or "maxTotalChars" in value
        ):
            return {**value, "delivery": "summary"}
        return value


class NodeAgentSpec(CanonicalModel):
    roleId: str | None = None
    promptTemplate: str | None = None
    context: AgentContextSpec = Field(default_factory=AgentContextSpec)


class NodeAdvanceSpec(CanonicalModel):
    mode: AdvanceMode = "manual"


class WorkflowNode(CanonicalModel):
    id: str
    name: str
    kind: NodeKind
    role: str | None = None
    description: str | None = None
    requires: list[RequirementSpec] = Field(default_factory=list)
    gates: list[str] = Field(default_factory=list)
    artifacts: NodeArtifactSpec = Field(default_factory=NodeArtifactSpec)
    agent: NodeAgentSpec = Field(default_factory=NodeAgentSpec)
    advance: NodeAdvanceSpec = Field(default_factory=NodeAdvanceSpec)
    metadata: dict[str, Any] = Field(default_factory=dict)


class WorkflowEdge(CanonicalModel):
    id: str
    from_: str = Field(alias="from")
    to: str
    condition: str | None = None
    trigger: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class Role(CanonicalModel):
    id: str
    assetVersionId: str | None = None
    name: str
    purpose: str | None = None
    description: str | None = None
    instructions: str | None = None
    inputRequirements: str | None = None
    outputRequirements: str | None = None
    acceptanceCriteria: str | None = None
    forbiddenActions: str | None = None
    provider: Literal["codex", "claude"] | None = None
    model: str | None = None
    allowedTools: list[str] = Field(default_factory=list)
    disabled: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class Gate(CanonicalModel):
    id: str
    name: str
    description: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class WorkflowDefinition(CanonicalModel):
    id: str
    name: str
    version: str
    sourceAdapter: str
    nodes: list[WorkflowNode]
    edges: list[WorkflowEdge]
    roles: list[Role]
    gates: list[Gate]
    policies: dict[str, Any]
    metadata: dict[str, Any]


class Actor(CanonicalModel):
    id: str
    type: ActorType
    source: ActorSource
    trusted: bool


class RunEvent(CanonicalModel):
    id: str
    runId: str
    type: RunEventType
    nodeId: str | None = None
    actor: Actor
    payload: dict[str, Any]
    createdAt: str
    revision: str


class AllowedAction(CanonicalModel):
    id: str
    label: str
    eventType: RunEventType
    nodeId: str | None = None
    risk: ActionRisk


class BlockingReason(CanonicalModel):
    code: str
    message: str
    nodeId: str | None = None


class RunProjection(CanonicalModel):
    runId: str
    status: RunStatus
    currentNodeIds: list[str]
    nodeStates: dict[str, NodeState]
    allowedActions: list[AllowedAction]
    blockingReasons: list[BlockingReason]
    revision: str
    updatedAt: str


WorkspaceMode = Literal["write", "read"]
WorkspaceLeaseStatus = Literal["active", "released", "expired"]


class WorkspaceLease(CanonicalModel):
    id: str
    projectId: str
    runId: str
    workspacePath: str
    mode: WorkspaceMode
    status: WorkspaceLeaseStatus
    acquiredAt: str
    lastVerifiedAt: str
    releasedAt: str | None
    releaseReason: str | None


class RunSummaryNode(CanonicalModel):
    id: str
    name: str
    kind: str
    state: NodeState


class RunSummaryNextNode(CanonicalModel):
    id: str
    name: str
    kind: str
    condition: str | None = None


class RunProgress(CanonicalModel):
    total: int
    passed: int
    running: int
    blocked: int
    pending: int


class RunWorkspaceSummary(CanonicalModel):
    path: str
    label: str
    leaseMode: WorkspaceMode
    leaseStatus: WorkspaceLeaseStatus


class RunSummaryProjection(CanonicalModel):
    id: str
    projectId: str
    workflowVersionId: str
    workflowName: str
    workflowVersion: str
    title: str
    status: RunStatus
    taskGoal: str | None
    currentNodes: list[RunSummaryNode]
    nextNodes: list[RunSummaryNextNode]
    progress: RunProgress
    blocker: BlockingReason | None
    workspace: RunWorkspaceSummary | None
    activeAgentCount: int
    activeDeploymentCount: int
    createdAt: str
    updatedAt: str


class ExecutionWorkspace(CanonicalModel):
    path: str
    mode: WorkspaceMode


class CreateRunRequest(CanonicalModel):
    workflowVersionId: str
    title: str = Field(min_length=1, max_length=120)
    taskGoal: str | None = None
    parameters: dict[str, Any] | None = None
    executionWorkspace: ExecutionWorkspace
    actor: Actor


class ExecuteRunActionRequest(CanonicalModel):
    actionId: str
    expectedRevision: str
    actor: Actor
    payload: dict[str, Any] | None = None


class RuntimeError(CanonicalModel):
    code: str
    message: str
    details: dict[str, Any] | None = None
    correlationId: str


class AgentJob(CanonicalModel):
    id: str
    runId: str
    nodeId: str
    provider: AgentProvider
    status: AgentJobStatus
    mode: AgentMode = "automatic"
    command: list[str]
    cwd: str
    pid: int | None = None
    sessionId: str | None = None
    parentJobId: str | None = None
    summary: str | None = None
    error: str | None = None
    createdAt: str
    updatedAt: str


class AgentSession(CanonicalModel):
    id: str
    runId: str
    jobId: str
    provider: AgentProvider
    status: AgentSessionStatus
    desktopSessionId: str | None = None
    pid: int | None = None
    cwd: str
    maxOutputBytes: int
    recoveryReason: str | None = None
    createdAt: str
    updatedAt: str
    endedAt: str | None = None


class AgentOutputEvent(CanonicalModel):
    id: str
    jobId: str
    sequence: int
    kind: str
    payload: dict[str, Any]
    createdAt: str
