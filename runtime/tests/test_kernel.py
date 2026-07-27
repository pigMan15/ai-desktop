from workflow_platform.kernel.projection import rebuild_projection
from workflow_platform.kernel.transition import transition
from workflow_platform.models import Actor, RunEvent, WorkflowDefinition, WorkflowEdge, WorkflowNode


NOW = "2026-07-27T13:00:00Z"


def human_actor(*, trusted: bool = True) -> Actor:
    return Actor(id="human-1", type="human", source="renderer", trusted=trusted)


def agent_actor() -> Actor:
    return Actor(id="agent-1", type="agent", source="agent", trusted=False)


def verifier_actor() -> Actor:
    return Actor(id="verifier-1", type="verifier", source="runtime", trusted=True)


def system_actor() -> Actor:
    return Actor(id="system", type="system", source="runtime", trusted=True)


def event(
    event_id: str,
    event_type: str,
    node_id: str | None = None,
    actor: Actor | None = None,
    revision: str = "0",
) -> RunEvent:
    return RunEvent(
        id=event_id,
        runId="run-1",
        type=event_type,
        nodeId=node_id,
        actor=actor or system_actor(),
        payload={},
        createdAt=NOW,
        revision=revision,
    )


def linear_workflow() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="workflow-1",
        name="Linear",
        version="1",
        sourceAdapter="fixture",
        nodes=[
            WorkflowNode(id="draft", name="Draft", kind="agent"),
            WorkflowNode(id="review", name="Review", kind="approval"),
        ],
        edges=[WorkflowEdge(id="edge-1", from_="draft", to="review")],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )


def test_rebuild_projection_without_events_marks_first_node_ready() -> None:
    projection = rebuild_projection("run-1", linear_workflow(), [])

    assert projection.status == "CREATED"
    assert projection.revision == "0"
    assert projection.currentNodeIds == ["draft"]
    assert projection.nodeStates == {"draft": "READY", "review": "PENDING"}
    assert [action.eventType for action in projection.allowedActions] == ["NODE_STARTED"]


def test_transition_starts_ready_node_and_advances_revision() -> None:
    result = transition(
        "run-1",
        linear_workflow(),
        [],
        event("event-1", "NODE_STARTED", "draft", agent_actor()),
        expected_revision="0",
    )

    assert result["accepted"] is True
    assert result["revision"] == "1"
    assert [emitted.type for emitted in result["emittedEvents"]] == ["NODE_STARTED"]
    assert result["run"].status == "IN_PROGRESS"
    assert result["run"].nodeStates["draft"] == "RUNNING"


def test_transition_rejects_revision_conflict_without_emitting_events() -> None:
    result = transition(
        "run-1",
        linear_workflow(),
        [],
        event("event-1", "NODE_STARTED", "draft", agent_actor()),
        expected_revision="1",
    )

    assert result["accepted"] is False
    assert result["revision"] == "0"
    assert result["emittedEvents"] == []
    assert result["blockingReasons"][0].code == "REVISION_CONFLICT"


def test_artifact_submission_waits_for_approval_actions() -> None:
    events = [event("event-1", "NODE_STARTED", "draft", agent_actor(), "1")]

    result = transition(
        "run-1",
        linear_workflow(),
        events,
        event("event-2", "ARTIFACT_SUBMITTED", "draft", agent_actor()),
        expected_revision="1",
    )

    assert result["accepted"] is True
    assert result["run"].status == "REVIEWING"
    assert result["run"].nodeStates["draft"] == "AWAITING_APPROVAL"
    assert [action.eventType for action in result["allowedActions"]] == [
        "HUMAN_APPROVED",
        "HUMAN_REJECTED",
    ]


def test_agent_cannot_submit_human_approval() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        event("event-2", "ARTIFACT_SUBMITTED", "draft", agent_actor(), "2"),
    ]

    result = transition(
        "run-1",
        linear_workflow(),
        events,
        event("event-3", "HUMAN_APPROVED", "draft", agent_actor()),
        expected_revision="2",
    )

    assert result["accepted"] is False
    assert result["emittedEvents"] == []
    assert result["blockingReasons"][0].code == "PERMISSION_DENIED"


def test_human_approval_passes_node_and_readies_next_node() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        event("event-2", "ARTIFACT_SUBMITTED", "draft", agent_actor(), "2"),
    ]

    result = transition(
        "run-1",
        linear_workflow(),
        events,
        event("event-3", "HUMAN_APPROVED", "draft", human_actor()),
        expected_revision="2",
    )

    assert result["accepted"] is True
    assert result["run"].status == "IN_PROGRESS"
    assert result["run"].nodeStates["draft"] == "PASSED"
    assert result["run"].nodeStates["review"] == "READY"
    assert result["run"].currentNodeIds == ["review"]


def test_human_rejection_blocks_run() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        event("event-2", "ARTIFACT_SUBMITTED", "draft", agent_actor(), "2"),
    ]

    result = transition(
        "run-1",
        linear_workflow(),
        events,
        event("event-3", "HUMAN_REJECTED", "draft", human_actor()),
        expected_revision="2",
    )

    assert result["accepted"] is True
    assert result["run"].status == "BLOCKED"
    assert result["run"].nodeStates["draft"] == "BLOCKED"
    assert result["blockingReasons"][0].code == "NODE_BLOCKED"


def test_verifier_can_pass_gate_and_complete_final_node_deterministically() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        event("event-2", "ARTIFACT_SUBMITTED", "draft", agent_actor(), "2"),
        event("event-3", "HUMAN_APPROVED", "draft", human_actor(), "3"),
        event("event-4", "NODE_STARTED", "review", agent_actor(), "4"),
        event("event-5", "ARTIFACT_SUBMITTED", "review", agent_actor(), "5"),
    ]

    result = transition(
        "run-1",
        linear_workflow(),
        events,
        event("event-6", "GATE_PASSED", "review", verifier_actor()),
        expected_revision="5",
    )

    assert result["accepted"] is True
    assert [emitted.type for emitted in result["emittedEvents"]] == [
        "GATE_PASSED",
        "RUN_COMPLETED",
    ]
    assert result["revision"] == "7"
    assert result["run"].status == "DONE"
    assert result["run"].currentNodeIds == []


def test_agent_cannot_pass_gate() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        event("event-2", "ARTIFACT_SUBMITTED", "draft", agent_actor(), "2"),
    ]

    result = transition(
        "run-1",
        linear_workflow(),
        events,
        event("event-3", "GATE_PASSED", "draft", agent_actor()),
        expected_revision="2",
    )

    assert result["accepted"] is False
    assert result["blockingReasons"][0].code == "PERMISSION_DENIED"


def test_node_completed_cannot_be_submitted_externally() -> None:
    result = transition(
        "run-1",
        linear_workflow(),
        [],
        event("event-1", "NODE_COMPLETED", "draft", system_actor()),
        expected_revision="0",
    )

    assert result["accepted"] is False
    assert result["emittedEvents"] == []
    assert result["blockingReasons"][0].code == "INVALID_TRANSITION"
