from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


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


class CanonicalModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class RequirementSpec(CanonicalModel):
    type: RequirementType
    artifactType: str | None = None
    approvalRole: str | None = None
    gateId: str | None = None
    evidenceType: str | None = None
    required: bool = True


class WorkflowNode(CanonicalModel):
    id: str
    name: str
    kind: NodeKind
    role: str | None = None
    description: str | None = None
    requires: list[RequirementSpec] = Field(default_factory=list)
    gates: list[str] = Field(default_factory=list)
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
    name: str


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
