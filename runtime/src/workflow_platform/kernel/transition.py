from workflow_platform.kernel.projection import rebuild_projection
from workflow_platform.models import BlockingReason, RunEvent, WorkflowDefinition


def transition(
    run_id: str,
    workflow: WorkflowDefinition,
    events: list[RunEvent],
    event: RunEvent,
    expected_revision: str,
) -> dict:
    current_projection = rebuild_projection(run_id, workflow, events)

    if expected_revision != current_projection.revision:
        return _rejected(
            current_projection,
            "REVISION_CONFLICT",
            "Expected revision does not match current revision",
            event.nodeId,
        )

    rejection = _validate_event(current_projection.nodeStates, event)
    if rejection is not None:
        code, message = rejection
        return _rejected(current_projection, code, message, event.nodeId)

    first_revision = len(events) + 1
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
    node_states: dict[str, str],
    event: RunEvent,
) -> tuple[str, str] | None:
    if event.type == "NODE_COMPLETED":
        return ("INVALID_TRANSITION", "NODE_COMPLETED cannot be submitted externally")

    if event.type == "NODE_STARTED":
        if event.nodeId is None or node_states.get(event.nodeId) != "READY":
            return ("INVALID_TRANSITION", "Only READY nodes can be started")
        return None

    if event.type == "ARTIFACT_SUBMITTED":
        if event.nodeId is None or node_states.get(event.nodeId) != "RUNNING":
            return ("INVALID_TRANSITION", "Artifacts can only be submitted for RUNNING nodes")
        return None

    if event.type in {"HUMAN_APPROVED", "HUMAN_REJECTED"}:
        if event.actor.type != "human" or not event.actor.trusted:
            return ("PERMISSION_DENIED", "Only trusted human actors can submit approval decisions")
        if event.nodeId is None or node_states.get(event.nodeId) != "AWAITING_APPROVAL":
            return ("INVALID_TRANSITION", "Approval decisions require a node awaiting approval")
        return None

    if event.type in {"GATE_PASSED", "GATE_FAILED"}:
        if event.actor.type not in {"verifier", "system"} or not event.actor.trusted:
            return ("PERMISSION_DENIED", "Only trusted verifier or system actors can submit gate decisions")
        if event.nodeId is None or node_states.get(event.nodeId) not in {
            "AWAITING_APPROVAL",
            "AWAITING_GATE",
        }:
            return ("INVALID_TRANSITION", "Gate decisions require a node awaiting review")
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
