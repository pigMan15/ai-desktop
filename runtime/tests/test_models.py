import pytest
from pydantic import ValidationError

from workflow_platform.models import (
    Actor,
    RunEvent,
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


def test_actor_requires_trust_flag() -> None:
    with pytest.raises(ValidationError):
        Actor(id="u1", type="human", source="renderer")


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
        nodeStates={"task-1": "DONE", "approval-1": "WAITING"},
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
    assert projection.nodeStates["task-1"] == "DONE"
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
