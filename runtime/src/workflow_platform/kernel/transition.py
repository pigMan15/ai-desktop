from workflow_platform.kernel.projection import rebuild_projection
from workflow_platform.models import BlockingReason, RunEvent, WorkflowDefinition


def transition(
    run_id: str,
    workflow: WorkflowDefinition,
    events: list[RunEvent],
    event: RunEvent,
    expected_revision: str,
) -> dict:
    target_events = [candidate for candidate in events if candidate.runId == run_id]
    current_projection = rebuild_projection(run_id, workflow, events)

    if event.runId != run_id:
        return _rejected(
            current_projection,
            "INVALID_TRANSITION",
            "Event runId does not match target run",
            event.nodeId,
        )

    if expected_revision != current_projection.revision:
        return _rejected(
            current_projection,
            "REVISION_CONFLICT",
            "Expected revision does not match current revision",
            event.nodeId,
        )

    rejection = _validate_event(current_projection, event)
    if rejection is not None:
        code, message = rejection
        return _rejected(current_projection, code, message, event.nodeId)

    first_revision = len(target_events) + 1
    accepted_event = event.model_copy(update={"revision": str(first_revision)})
    emitted_events = [accepted_event]

    projected_events = [*events, accepted_event]
    next_projection = rebuild_projection(run_id, workflow, projected_events)
    if _should_complete_run(current_projection.status, next_projection.status):
        completed_event = RunEvent(
            id=f"{run_id}:run-completed:{first_revision + 1}",
            runId=run_id,
            type="RUN_COMPLETED",
            nodeId=None,
            actor=event.actor,
            payload={},
            createdAt=event.createdAt,
            revision=str(first_revision + 1),
        )
        emitted_events.append(completed_event)
        projected_events.append(completed_event)
        next_projection = rebuild_projection(run_id, workflow, projected_events)

    return {
        "run": next_projection,
        "accepted": True,
        "revision": next_projection.revision,
        "allowedActions": next_projection.allowedActions,
        "blockingReasons": next_projection.blockingReasons,
        "emittedEvents": emitted_events,
    }


def _validate_event(
    projection,
    event: RunEvent,
) -> tuple[str, str] | None:
    node_states = projection.nodeStates
    if event.type in {"NODE_COMPLETED", "NODE_FAILED"}:
        if event.actor.type not in {"executor", "system"} or not event.actor.trusted:
            return ("PERMISSION_DENIED", "Only trusted executors or system actors can finish execution nodes")
        if event.nodeId is None or node_states.get(event.nodeId) != "RUNNING":
            return ("INVALID_TRANSITION", "Execution completion requires a RUNNING node")
        return None

    if event.type == "RUN_PAUSED":
        if event.actor.type != "human" or not event.actor.trusted:
            return ("PERMISSION_DENIED", "Only trusted human actors can pause runs")
        if projection.status not in {"CREATED", "IN_PROGRESS", "REVIEWING"}:
            return ("INVALID_TRANSITION", "Only active runs can be paused")
        if event.nodeId is not None:
            return ("INVALID_TRANSITION", "Run pause does not accept a node ID")
        return None

    if event.type == "RUN_RESUMED":
        if event.actor.type != "human" or not event.actor.trusted:
            return ("PERMISSION_DENIED", "Only trusted human actors can resume runs")
        if projection.status != "PAUSED":
            return ("INVALID_TRANSITION", "Only paused runs can be resumed")
        if event.nodeId is not None:
            return ("INVALID_TRANSITION", "Run resume does not accept a node ID")
        return None

    if event.type == "RUN_ARCHIVED":
        if event.actor.type != "human" or not event.actor.trusted:
            return ("PERMISSION_DENIED", "Only trusted human actors can archive runs")
        if projection.status not in {"DONE", "BLOCKED"}:
            return ("INVALID_TRANSITION", "Only completed or blocked runs can be archived")
        if event.nodeId is not None:
            return ("INVALID_TRANSITION", "Run archive does not accept a node ID")
        return None

    if event.type == "NODE_RETRIED":
        if event.actor.type not in {"verifier", "system"} or not event.actor.trusted:
            return ("PERMISSION_DENIED", "Only trusted verifier or system actors can retry gate nodes")
        if event.nodeId is None or node_states.get(event.nodeId) != "BLOCKED":
            return ("INVALID_TRANSITION", "Only blocked nodes can be retried")
        return None

    if projection.status == "PAUSED":
        return ("INVALID_TRANSITION", "Paused runs must be resumed before node actions")

    if projection.status == "ARCHIVED":
        return ("INVALID_TRANSITION", "Archived runs cannot accept new events")

    if event.type == "NODE_STARTED":
        if event.nodeId is None or node_states.get(event.nodeId) != "READY":
            return ("INVALID_TRANSITION", "Only READY nodes can be started")
        return None

    if event.type == "ARTIFACT_SUBMITTED":
        if event.nodeId is None or node_states.get(event.nodeId) != "RUNNING":
            return ("INVALID_TRANSITION", "Artifacts can only be submitted for RUNNING nodes")
        if not event.payload.get("artifactUri") or not event.payload.get("artifactType"):
            return ("MISSING_ARTIFACT", "Artifact submissions require artifactUri and artifactType")
        return None

    if event.type in {"HUMAN_APPROVED", "HUMAN_REJECTED", "HUMAN_DEFERRED"}:
        if event.actor.type != "human" or not event.actor.trusted:
            return ("PERMISSION_DENIED", "Only trusted human actors can submit approval decisions")
        if event.nodeId is None or node_states.get(event.nodeId) != "AWAITING_APPROVAL":
            return ("INVALID_TRANSITION", "Approval decisions require a node awaiting approval")
        return None

    if event.type in {"GATE_PASSED", "GATE_FAILED", "GATE_WAIVED"}:
        if event.actor.type not in {"verifier", "system"} or not event.actor.trusted:
            return ("PERMISSION_DENIED", "Only trusted verifier or system actors can submit gate decisions")
        if event.nodeId is None or node_states.get(event.nodeId) != "AWAITING_GATE":
            return ("INVALID_TRANSITION", "Gate decisions require a node awaiting gate verification")
        if event.type == "GATE_WAIVED" and not str(event.payload.get("waiverReason", "")).strip():
            return ("MISSING_EVIDENCE", "Gate waivers require a non-empty waiverReason")
        if event.type != "GATE_WAIVED" and not event.payload.get("evidence"):
            return ("MISSING_EVIDENCE", "Gate decisions require evidence or waiverReason")
        return None

    return ("INVALID_TRANSITION", f"{event.type} is not accepted by the kernel")


def _should_complete_run(previous_status: str, next_status: str) -> bool:
    return previous_status != "DONE" and next_status == "DONE"


def _rejected(
    projection,
    code: str,
    message: str,
    node_id: str | None,
) -> dict:
    blocking_reasons = [
        BlockingReason(code=code, message=message, nodeId=node_id),
        *projection.blockingReasons,
    ]
    return {
        "run": projection,
        "accepted": False,
        "revision": projection.revision,
        "allowedActions": projection.allowedActions,
        "blockingReasons": blocking_reasons,
        "emittedEvents": [],
    }
