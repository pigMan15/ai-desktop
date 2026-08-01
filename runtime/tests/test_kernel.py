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
    run_id: str = "run-1",
    created_at: str = NOW,
    payload: dict | None = None,
) -> RunEvent:
    return RunEvent(
        id=event_id,
        runId=run_id,
        type=event_type,
        nodeId=node_id,
        actor=actor or system_actor(),
        payload=payload or {},
        createdAt=created_at,
        revision=revision,
    )


def artifact_event(
    event_id: str,
    node_id: str,
    actor: Actor | None = None,
    revision: str = "0",
    run_id: str = "run-1",
) -> RunEvent:
    return event(
        event_id,
        "ARTIFACT_SUBMITTED",
        node_id,
        actor,
        revision,
        run_id,
        payload={"artifactUri": f"artifact://{node_id}", "artifactType": "plan"},
    )


def gate_pass_event(event_id: str, node_id: str, actor: Actor | None = None) -> RunEvent:
    return event(
        event_id,
        "GATE_PASSED",
        node_id,
        actor,
        payload={"evidence": [f"artifact:{node_id}"], "gateId": "security"},
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


def gated_workflow() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="workflow-1",
        name="Gated",
        version="1",
        sourceAdapter="fixture",
        nodes=[
            WorkflowNode(id="deploy", name="Deploy", kind="deploy", gates=["security"]),
        ],
        edges=[],
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
    assert [action.eventType for action in projection.allowedActions] == ["NODE_STARTED", "RUN_PAUSED"]


def test_trusted_human_can_pause_and_resume_an_active_run() -> None:
    events = [event("event-1", "NODE_STARTED", "draft", agent_actor(), revision="1")]
    paused = transition(
        "run-1",
        linear_workflow(),
        events,
        event("event-2", "RUN_PAUSED", actor=human_actor()),
        expected_revision="1",
    )


def artifact_workflow(*, approval: bool = False, gate: bool = False) -> WorkflowDefinition:
    requirements = (
        [{"type": "approval", "approvalRole": "tech-lead", "required": True}]
        if approval
        else []
    )
    return WorkflowDefinition(
        id="workflow-artifacts",
        name="Artifact workflow",
        version="1",
        sourceAdapter="fixture",
        nodes=[
            WorkflowNode(
                id="build",
                name="Build",
                kind="agent",
                requires=requirements,
                gates=["quality"] if gate else [],
                artifacts={
                    "outputs": [
                        {
                            "id": "report",
                            "name": "报告",
                            "type": "report",
                            "required": True,
                            "path": "reports/{{runId}}/report.md",
                        },
                        {
                            "id": "notes",
                            "name": "说明",
                            "type": "notes",
                            "required": False,
                            "path": "reports/{{runId}}/notes.md",
                        },
                    ]
                },
            )
        ],
        edges=[],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )


def branching_workflow() -> WorkflowDefinition:
    return WorkflowDefinition(
        id="workflow-branching",
        name="Branching",
        version="1",
        sourceAdapter="fixture",
        nodes=[
            WorkflowNode(id="root", name="Root", kind="agent"),
            WorkflowNode(id="left", name="Left", kind="agent"),
            WorkflowNode(id="right", name="Right", kind="agent"),
            WorkflowNode(id="join", name="Join", kind="agent"),
        ],
        edges=[
            WorkflowEdge(id="root-left", from_="root", to="left"),
            WorkflowEdge(id="root-right", from_="root", to="right"),
            WorkflowEdge(id="left-join", from_="left", to="join"),
            WorkflowEdge(id="right-join", from_="right", to="join"),
        ],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )

    assert paused["accepted"] is True
    assert paused["run"].status == "PAUSED"
    assert [(action.eventType, action.nodeId) for action in paused["allowedActions"]] == [
        ("RUN_RESUMED", None),
    ]

    resumed = transition(
        "run-1",
        linear_workflow(),
        [*events, *paused["emittedEvents"]],
        event("event-3", "RUN_RESUMED", actor=human_actor()),
        expected_revision=paused["revision"],
    )

    assert resumed["accepted"] is True
    assert resumed["run"].status == "IN_PROGRESS"
    assert resumed["run"].nodeStates["draft"] == "RUNNING"


def test_trusted_human_resume_restores_created_status_before_any_node_starts() -> None:
    created = transition(
        "run-1",
        linear_workflow(),
        [],
        event("event-1", "RUN_PAUSED", actor=human_actor()),
        expected_revision="0",
    )

    resumed = transition(
        "run-1",
        linear_workflow(),
        created["emittedEvents"],
        event("event-2", "RUN_RESUMED", actor=human_actor()),
        expected_revision=created["revision"],
    )

    assert resumed["accepted"] is True
    assert resumed["run"].status == "CREATED"
    assert resumed["run"].nodeStates["draft"] == "READY"


def test_rebuild_projection_revision_and_updated_at_ignore_other_runs() -> None:
    events = [
        event(
            "other-1",
            "NODE_STARTED",
            "draft",
            agent_actor(),
            "1",
            run_id="run-2",
            created_at="2026-07-27T13:01:00Z",
        ),
        event(
            "event-1",
            "NODE_STARTED",
            "draft",
            agent_actor(),
            "1",
            created_at="2026-07-27T13:02:00Z",
        ),
        event(
            "other-2",
            "ARTIFACT_SUBMITTED",
            "draft",
            agent_actor(),
            "2",
            run_id="run-2",
            created_at="2026-07-27T13:03:00Z",
        ),
        event(
            "event-2",
            "ARTIFACT_SUBMITTED",
            "draft",
            agent_actor(),
            "2",
            created_at="2026-07-27T13:04:00Z",
        ),
    ]

    projection = rebuild_projection("run-1", linear_workflow(), events)

    assert projection.revision == "2"
    assert projection.updatedAt == "2026-07-27T13:04:00Z"
    assert projection.nodeStates["draft"] == "AWAITING_APPROVAL"


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
    assert [action.eventType for action in result["allowedActions"]] == [
        "ARTIFACT_SUBMITTED",
        "NODE_COMPLETED",
        "RUN_PAUSED",
    ]


def test_transition_expected_revision_uses_only_target_run_events() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        event("other-1", "NODE_STARTED", "draft", agent_actor(), "1", run_id="run-2"),
    ]

    result = transition(
        "run-1",
        linear_workflow(),
        events,
        artifact_event("event-2", "draft", agent_actor()),
        expected_revision="1",
    )

    assert result["accepted"] is True
    assert [emitted.revision for emitted in result["emittedEvents"]] == ["2"]
    assert result["revision"] == "2"
    assert result["run"].nodeStates["draft"] == "AWAITING_APPROVAL"


def test_transition_rejects_new_event_for_different_run_id_without_emitting() -> None:
    result = transition(
        "run-1",
        linear_workflow(),
        [],
        event("event-1", "NODE_STARTED", "draft", agent_actor(), run_id="run-2"),
        expected_revision="0",
    )

    assert result["accepted"] is False
    assert result["revision"] == "0"
    assert result["run"].revision == "0"
    assert result["run"].nodeStates["draft"] == "READY"
    assert result["emittedEvents"] == []
    assert result["blockingReasons"][0].code == "INVALID_TRANSITION"
    assert "runId" in result["blockingReasons"][0].message


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
        artifact_event("event-2", "draft", agent_actor()),
        expected_revision="1",
    )

    assert result["accepted"] is True
    assert result["run"].status == "REVIEWING"
    assert result["run"].nodeStates["draft"] == "AWAITING_APPROVAL"
    assert [action.eventType for action in result["allowedActions"]] == [
        "HUMAN_APPROVED",
        "HUMAN_REJECTED",
        "HUMAN_DEFERRED",
        "RUN_PAUSED",
    ]


def test_artifact_submission_requires_artifact_payload() -> None:
    events = [event("event-1", "NODE_STARTED", "draft", agent_actor(), "1")]

    result = transition(
        "run-1",
        linear_workflow(),
        events,
        event("event-2", "ARTIFACT_SUBMITTED", "draft", agent_actor()),
        expected_revision="1",
    )

    assert result["accepted"] is False
    assert result["blockingReasons"][0].code == "MISSING_ARTIFACT"


def test_agent_cannot_submit_human_approval() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        artifact_event("event-2", "draft", agent_actor(), "2"),
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
        artifact_event("event-2", "draft", agent_actor(), "2"),
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


def test_starting_an_approval_node_enters_the_approval_inbox() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        event("event-2", "NODE_COMPLETED", "draft", system_actor(), "2"),
    ]

    result = transition(
        "run-1",
        linear_workflow(),
        events,
        event("event-3", "NODE_STARTED", "review", human_actor()),
        expected_revision="2",
    )

    assert result["accepted"] is True
    assert result["run"].status == "REVIEWING"
    assert result["run"].nodeStates["review"] == "AWAITING_APPROVAL"
    assert [action.eventType for action in result["allowedActions"]] == [
        "HUMAN_APPROVED",
        "HUMAN_REJECTED",
        "HUMAN_DEFERRED",
        "RUN_PAUSED",
    ]


def test_human_rejection_blocks_run() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        artifact_event("event-2", "draft", agent_actor(), "2"),
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


def test_trusted_verifier_can_retry_a_blocked_gate_node() -> None:
    events = [
        event("event-1", "NODE_STARTED", "deploy", agent_actor(), "1"),
        artifact_event("event-2", "deploy", agent_actor(), "2"),
        event("event-3", "HUMAN_APPROVED", "deploy", human_actor(), "3"),
        event("event-4", "GATE_FAILED", "deploy", verifier_actor(), "4"),
    ]

    result = transition(
        "run-1",
        gated_workflow(),
        events,
        event("event-5", "NODE_RETRIED", "deploy", verifier_actor()),
        expected_revision="4",
    )

    assert result["accepted"] is True
    assert result["run"].status == "REVIEWING"
    assert result["run"].nodeStates["deploy"] == "AWAITING_GATE"
    assert {action.eventType for action in result["allowedActions"]} == {
        "GATE_PASSED",
        "GATE_FAILED",
        "GATE_WAIVED",
        "RUN_PAUSED",
    }


def test_gate_pass_is_rejected_while_node_is_awaiting_approval() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        artifact_event("event-2", "draft", agent_actor(), "2"),
    ]

    result = transition(
        "run-1",
        linear_workflow(),
        events,
        event("event-3", "GATE_PASSED", "draft", verifier_actor()),
        expected_revision="2",
    )

    assert result["accepted"] is False
    assert result["emittedEvents"] == []
    assert result["blockingReasons"][0].code == "INVALID_TRANSITION"


def test_human_approval_moves_gated_node_to_awaiting_gate() -> None:
    events = [
        event("event-1", "NODE_STARTED", "deploy", agent_actor(), "1"),
        artifact_event("event-2", "deploy", agent_actor(), "2"),
    ]

    result = transition(
        "run-1",
        gated_workflow(),
        events,
        event("event-3", "HUMAN_APPROVED", "deploy", human_actor()),
        expected_revision="2",
    )

    assert result["accepted"] is True
    assert result["run"].status == "REVIEWING"
    assert result["run"].nodeStates["deploy"] == "AWAITING_GATE"
    assert [action.eventType for action in result["allowedActions"]] == [
        "GATE_PASSED",
        "GATE_FAILED",
        "GATE_WAIVED",
        "RUN_PAUSED",
    ]


def test_system_can_pass_awaiting_gate_and_complete_final_node_deterministically() -> None:
    events = [
        event("event-1", "NODE_STARTED", "deploy", agent_actor(), "1"),
        artifact_event("event-2", "deploy", agent_actor(), "2"),
        event("event-3", "HUMAN_APPROVED", "deploy", human_actor(), "3"),
    ]

    result = transition(
        "run-1",
        gated_workflow(),
        events,
        gate_pass_event("event-4", "deploy", system_actor()),
        expected_revision="3",
    )

    assert result["accepted"] is True
    assert [emitted.type for emitted in result["emittedEvents"]] == [
        "GATE_PASSED",
        "RUN_COMPLETED",
    ]
    assert result["revision"] == "5"
    assert result["run"].status == "DONE"
    assert result["run"].currentNodeIds == []


def test_gate_pass_requires_evidence_or_waiver_payload() -> None:
    events = [
        event("event-1", "NODE_STARTED", "deploy", agent_actor(), "1"),
        artifact_event("event-2", "deploy", agent_actor(), "2"),
        event("event-3", "HUMAN_APPROVED", "deploy", human_actor(), "3"),
    ]

    result = transition(
        "run-1",
        gated_workflow(),
        events,
        event("event-4", "GATE_PASSED", "deploy", verifier_actor()),
        expected_revision="3",
    )

    assert result["accepted"] is False
    assert result["blockingReasons"][0].code == "MISSING_EVIDENCE"


def test_auto_run_completed_revision_uses_target_run_count_in_mixed_events() -> None:
    events = [
        event("event-1", "NODE_STARTED", "deploy", agent_actor(), "1"),
        event("other-1", "NODE_STARTED", "deploy", agent_actor(), "1", run_id="run-2"),
        artifact_event("event-2", "deploy", agent_actor(), "2"),
        artifact_event("other-2", "deploy", agent_actor(), "2", run_id="run-2"),
        event("event-3", "HUMAN_APPROVED", "deploy", human_actor(), "3"),
    ]

    result = transition(
        "run-1",
        gated_workflow(),
        events,
        gate_pass_event("event-4", "deploy", verifier_actor()),
        expected_revision="3",
    )

    assert result["accepted"] is True
    assert [emitted.revision for emitted in result["emittedEvents"]] == ["4", "5"]
    assert [emitted.type for emitted in result["emittedEvents"]] == [
        "GATE_PASSED",
        "RUN_COMPLETED",
    ]
    assert result["revision"] == "5"


def test_agent_cannot_pass_gate() -> None:
    events = [
        event("event-1", "NODE_STARTED", "draft", agent_actor(), "1"),
        artifact_event("event-2", "draft", agent_actor(), "2"),
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


def test_declared_required_artifact_blocks_completion_until_registered() -> None:
    workflow = artifact_workflow(approval=True)
    events = [event("event-1", "NODE_STARTED", "build", agent_actor(), "1")]

    completed = transition(
        "run-1",
        workflow,
        events,
        event("event-2", "NODE_COMPLETED", "build", system_actor()),
        expected_revision="1",
    )

    assert completed["accepted"] is True
    assert completed["run"].nodeStates["build"] == "AWAITING_ARTIFACT"
    assert completed["blockingReasons"][0].code == "MISSING_REQUIRED_ARTIFACT"

    submitted = transition(
        "run-1",
        workflow,
        [*events, *completed["emittedEvents"]],
        event(
            "event-3",
            "ARTIFACT_SUBMITTED",
            "build",
            agent_actor(),
            payload={
                "artifactUri": "artifact://report",
                "artifactType": "report",
                "artifactSpecId": "report",
            },
        ),
        expected_revision=completed["revision"],
    )

    assert submitted["accepted"] is True
    assert submitted["run"].nodeStates["build"] == "AWAITING_APPROVAL"


def test_changed_artifact_invalidates_a_completed_approval_decision() -> None:
    workflow = artifact_workflow(approval=True)
    events = [
        event("event-1", "NODE_STARTED", "build", agent_actor(), "1"),
        event(
            "event-2", "ARTIFACT_SUBMITTED", "build", agent_actor(), "2",
            payload={"artifactUri": "artifact://report", "artifactType": "report", "artifactSpecId": "report"},
        ),
        event("event-3", "NODE_COMPLETED", "build", system_actor(), "3"),
        event("event-4", "HUMAN_APPROVED", "build", human_actor(), "4"),
    ]

    invalidated = transition(
        "run-1",
        workflow,
        events,
        event(
            "event-5", "ARTIFACT_INVALIDATED", "build", system_actor(),
            payload={"reason": "content hash changed", "beforeHashes": ["old"], "afterHashes": ["new"]},
        ),
        expected_revision="4",
    )

    assert invalidated["accepted"] is True
    assert invalidated["run"].nodeStates["build"] == "AWAITING_APPROVAL"


def test_optional_artifact_does_not_block_node_completion() -> None:
    workflow = artifact_workflow(gate=True)
    events = [
        event("event-1", "NODE_STARTED", "build", agent_actor(), "1"),
        event(
            "event-2",
            "ARTIFACT_SUBMITTED",
            "build",
            agent_actor(),
            "2",
            payload={
                "artifactUri": "artifact://report",
                "artifactType": "report",
                "artifactSpecId": "report",
            },
        ),
    ]

    completed = transition(
        "run-1",
        workflow,
        events,
        event("event-3", "NODE_COMPLETED", "build", system_actor()),
        expected_revision="2",
    )

    assert completed["accepted"] is True
    assert completed["run"].nodeStates["build"] == "AWAITING_GATE"


def test_passing_node_unlocks_all_outgoing_targets_and_join_waits_for_all_predecessors() -> None:
    workflow = branching_workflow()
    events = [
        event("event-1", "NODE_STARTED", "root", agent_actor(), "1"),
        event("event-2", "NODE_COMPLETED", "root", system_actor(), "2"),
    ]
    branched = rebuild_projection("run-1", workflow, events)

    assert branched.nodeStates == {
        "root": "PASSED",
        "left": "READY",
        "right": "READY",
        "join": "PENDING",
    }

    after_left = rebuild_projection(
        "run-1",
        workflow,
        [
            *events,
            event("event-3", "NODE_STARTED", "left", agent_actor(), "3"),
            event("event-4", "NODE_COMPLETED", "left", system_actor(), "4"),
        ],
    )
    assert after_left.nodeStates["join"] == "PENDING"

    after_both = rebuild_projection(
        "run-1",
        workflow,
        [
            *events,
            event("event-3", "NODE_STARTED", "left", agent_actor(), "3"),
            event("event-4", "NODE_COMPLETED", "left", system_actor(), "4"),
            event("event-5", "NODE_STARTED", "right", agent_actor(), "5"),
            event("event-6", "NODE_COMPLETED", "right", system_actor(), "6"),
        ],
    )
    assert after_both.nodeStates["join"] == "READY"
