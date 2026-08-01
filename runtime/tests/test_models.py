from typing import get_args

import pytest
from pydantic import ValidationError

from workflow_platform.models import (
    AgentContextSpec,
    Actor,
    AllowedAction,
    ArtifactOutputSpec,
    NodeKind,
    NodeState,
    RequirementSpec,
    RunEvent,
    RunEventType,
    RunProjection,
    WorkflowDefinition,
    WorkflowEdge,
    WorkflowNode,
)


def test_workflow_definition_accepts_task_node() -> None:
    workflow = WorkflowDefinition(
        id="wf-1",
        name="Demo workflow",
        version="1",
        sourceAdapter="fixture",
        nodes=[WorkflowNode(id="task-1", name="Implement", kind="task")],
        edges=[],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )

    assert workflow.nodes[0].kind == "task"


def test_node_kinds_match_contract_order() -> None:
    assert get_args(NodeKind) == (
        "task",
        "agent",
        "approval",
        "gate",
        "evidence",
        "deploy",
        "report",
        "composite",
    )


def test_run_event_types_match_contract_order() -> None:
    assert get_args(RunEventType) == (
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


def test_node_states_match_plan_order() -> None:
    assert get_args(NodeState) == (
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
    )


def test_actor_requires_trust_flag() -> None:
    with pytest.raises(ValidationError):
        Actor(id="u1", type="human", source="renderer")


def test_requirement_spec_required_defaults_true_and_rejects_none() -> None:
    requirement = RequirementSpec(type="artifact", artifactType="plan")

    assert requirement.required is True

    with pytest.raises(ValidationError):
        RequirementSpec(type="artifact", artifactType="plan", required=None)


def test_workflow_node_defaults_collection_fields_to_empty_containers() -> None:
    node = WorkflowNode(id="task-1", name="Implement", kind="task")

    assert node.requires == []
    assert node.gates == []
    assert node.metadata == {}
    assert node.artifacts.outputs == []
    assert node.agent.context.upstream == "none"
    assert node.advance.mode == "manual"


def test_workflow_node_accepts_declarative_artifact_and_agent_contracts() -> None:
    node = WorkflowNode(
        id="implementation",
        name="开发实现",
        kind="agent",
        artifacts={
            "outputs": [
                {
                    "id": "implementation-report",
                    "name": "实施报告",
                    "type": "implementation-report",
                    "required": True,
                    "path": "docs/runs/{{runId}}/{{nodeId}}/implementation.md",
                    "templatePath": "templates/artifacts/implementation.md",
                }
            ]
        },
        agent={
            "promptTemplate": "完成实现与测试。",
            "context": {
                "upstream": "ancestors",
                "artifactTypes": ["requirement", "plan"],
                "maxArtifacts": 8,
                "summaryCharsPerArtifact": 4000,
                "maxTotalChars": 16000,
            },
        },
        advance={"mode": "auto"},
    )

    assert node.artifacts.outputs[0] == ArtifactOutputSpec(
        id="implementation-report",
        name="实施报告",
        type="implementation-report",
        required=True,
        path="docs/runs/{{runId}}/{{nodeId}}/implementation.md",
        templatePath="templates/artifacts/implementation.md",
    )
    assert node.agent.context == AgentContextSpec(
        upstream="ancestors",
        artifactTypes=["requirement", "plan"],
        maxArtifacts=8,
        summaryCharsPerArtifact=4000,
        maxTotalChars=16000,
    )
    assert node.advance.mode == "auto"


def test_invalid_node_kind_raises_validation_error() -> None:
    with pytest.raises(ValidationError):
        WorkflowNode(id="n1", name="Nope", kind="unknown")


def test_run_event_accepts_human_approved_with_actor_source_and_trusted() -> None:
    event = RunEvent(
        id="event-1",
        runId="run-1",
        type="HUMAN_APPROVED",
        nodeId="approval-1",
        actor=Actor(id="u1", type="human", source="renderer", trusted=True),
        payload={"decision": "approved"},
        createdAt="2026-07-27T13:00:00Z",
        revision="rev-1",
    )

    assert event.type == "HUMAN_APPROVED"
    assert event.actor.source == "renderer"
    assert event.actor.trusted is True


def test_run_projection_includes_runtime_projection_fields() -> None:
    projection = RunProjection(
        runId="run-1",
        status="BLOCKED",
        currentNodeIds=["approval-1"],
        nodeStates={"task-1": "PASSED", "approval-1": "AWAITING_APPROVAL"},
        allowedActions=[
            {
                "id": "approve",
                "label": "Approve",
                "eventType": "HUMAN_APPROVED",
                "nodeId": "approval-1",
                "risk": "high",
            }
        ],
        blockingReasons=[
            {
                "code": "WAITING_FOR_HUMAN",
                "message": "Approval is required",
                "nodeId": "approval-1",
            }
        ],
        revision="rev-2",
        updatedAt="2026-07-27T13:05:00Z",
    )

    assert projection.currentNodeIds == ["approval-1"]
    assert projection.nodeStates["task-1"] == "PASSED"
    assert projection.allowedActions[0].eventType == "HUMAN_APPROVED"
    assert projection.blockingReasons[0].code == "WAITING_FOR_HUMAN"
    assert projection.revision == "rev-2"
    assert projection.updatedAt == "2026-07-27T13:05:00Z"


def test_workflow_edge_accepts_json_from_alias() -> None:
    edge = WorkflowEdge.model_validate(
        {
            "id": "edge-1",
            "from": "task-1",
            "to": "approval-1",
        }
    )

    assert edge.from_ == "task-1"
    assert edge.model_dump(by_alias=True)["from"] == "task-1"


def test_invalid_run_event_type_raises_validation_error() -> None:
    with pytest.raises(ValidationError):
        RunEvent(
            id="event-1",
            runId="run-1",
            type="UNKNOWN_EVENT",
            actor=Actor(id="system", type="system", source="runtime", trusted=True),
            payload={},
            createdAt="2026-07-27T13:00:00Z",
            revision="rev-1",
        )


def test_invalid_allowed_action_risk_raises_validation_error() -> None:
    with pytest.raises(ValidationError):
        AllowedAction(
            id="approve",
            label="Approve",
            eventType="HUMAN_APPROVED",
            risk="critical",
        )


def test_invalid_run_projection_status_raises_validation_error() -> None:
    with pytest.raises(ValidationError):
        RunProjection(
            runId="run-1",
            status="WAITING",
            currentNodeIds=[],
            nodeStates={},
            allowedActions=[],
            blockingReasons=[],
            revision="rev-1",
            updatedAt="2026-07-27T13:05:00Z",
        )


def test_invalid_node_state_raises_validation_error() -> None:
    with pytest.raises(ValidationError):
        RunProjection(
            runId="run-1",
            status="IN_PROGRESS",
            currentNodeIds=["task-1"],
            nodeStates={"task-1": "WAITING_FOR_APPROVAL"},
            allowedActions=[],
            blockingReasons=[],
            revision="rev-1",
            updatedAt="2026-07-27T13:05:00Z",
        )
