from collections.abc import Iterable

from workflow_platform.models import (
    AllowedAction,
    BlockingReason,
    NodeState,
    RunEvent,
    RunProjection,
    WorkflowDefinition,
)


ACTIVE_NODE_STATES = {
    "READY",
    "RUNNING",
    "AWAITING_ARTIFACT",
    "AWAITING_APPROVAL",
    "AWAITING_GATE",
    "BLOCKED",
}


def rebuild_projection(
    run_id: str,
    workflow: WorkflowDefinition,
    events: Iterable[RunEvent],
) -> RunProjection:
    ordered_events = [event for event in events if event.runId == run_id]
    node_states: dict[str, NodeState] = {node.id: "PENDING" for node in workflow.nodes}
    if workflow.nodes:
        node_states[workflow.nodes[0].id] = "READY"

    status = "CREATED"
    updated_at = ordered_events[-1].createdAt if ordered_events else ""
    has_started_node = False

    for run_event in ordered_events:
        if run_event.type == "NODE_STARTED" and run_event.nodeId:
            has_started_node = True
            if _is_approval_node(workflow, run_event.nodeId):
                node_states[run_event.nodeId] = "AWAITING_APPROVAL"
                status = "REVIEWING"
            else:
                node_states[run_event.nodeId] = "RUNNING"
                status = "IN_PROGRESS"
        elif run_event.type == "ARTIFACT_SUBMITTED" and run_event.nodeId:
            node = _workflow_node(workflow, run_event.nodeId)
            if node is not None and node.artifacts.outputs:
                if node_states.get(run_event.nodeId) == "AWAITING_ARTIFACT":
                    _evaluate_declared_artifact_completion(
                        workflow,
                        run_event.nodeId,
                        ordered_events[: ordered_events.index(run_event) + 1],
                        node_states,
                    )
                    status = _status_from_nodes(node_states, has_started_node)
            else:
                node_states[run_event.nodeId] = "AWAITING_APPROVAL"
                status = "REVIEWING"
        elif run_event.type == "ARTIFACT_INVALIDATED" and run_event.nodeId:
            if _node_requires_approval(workflow, run_event.nodeId):
                node_states[run_event.nodeId] = "AWAITING_APPROVAL"
            elif _node_requires_gate(workflow, run_event.nodeId):
                node_states[run_event.nodeId] = "AWAITING_GATE"
            else:
                node_states[run_event.nodeId] = "AWAITING_ARTIFACT"
            status = "REVIEWING"
        elif run_event.type == "NODE_COMPLETED" and run_event.nodeId:
            node = _workflow_node(workflow, run_event.nodeId)
            if node is not None and node.artifacts.outputs:
                _evaluate_declared_artifact_completion(
                    workflow,
                    run_event.nodeId,
                    ordered_events[: ordered_events.index(run_event) + 1],
                    node_states,
                )
                status = _status_from_nodes(node_states, has_started_node)
            elif _node_requires_approval(workflow, run_event.nodeId):
                node_states[run_event.nodeId] = "AWAITING_APPROVAL"
                status = "REVIEWING"
            elif _node_requires_gate(workflow, run_event.nodeId):
                node_states[run_event.nodeId] = "AWAITING_GATE"
                status = "REVIEWING"
            else:
                _pass_node_and_ready_successors(workflow, run_event.nodeId, node_states)
                status = _status_from_nodes(node_states, has_started_node)
        elif run_event.type == "HUMAN_APPROVED" and run_event.nodeId:
            if _node_requires_gate(workflow, run_event.nodeId):
                node_states[run_event.nodeId] = "AWAITING_GATE"
                status = "REVIEWING"
            else:
                _pass_node_and_ready_successors(workflow, run_event.nodeId, node_states)
                status = _status_from_nodes(node_states, has_started_node)
        elif run_event.type == "HUMAN_DEFERRED" and run_event.nodeId:
            node_states[run_event.nodeId] = "AWAITING_APPROVAL"
            status = "REVIEWING"
        elif run_event.type in {"GATE_PASSED", "GATE_WAIVED"} and run_event.nodeId:
            _pass_node_and_ready_successors(workflow, run_event.nodeId, node_states)
            status = _status_from_nodes(node_states, has_started_node)
        elif run_event.type in {"HUMAN_REJECTED", "GATE_FAILED", "NODE_FAILED"} and run_event.nodeId:
            node_states[run_event.nodeId] = "BLOCKED"
            status = "BLOCKED"
        elif run_event.type == "NODE_RETRIED" and run_event.nodeId:
            node_states[run_event.nodeId] = "AWAITING_GATE"
            status = "REVIEWING"
        elif run_event.type == "GATE_STARTED" and run_event.nodeId:
            node_states[run_event.nodeId] = "AWAITING_GATE"
            status = "REVIEWING"
        elif run_event.type == "RUN_BLOCKED":
            status = "BLOCKED"
        elif run_event.type == "RUN_PAUSED":
            status = "PAUSED"
        elif run_event.type == "RUN_RESUMED":
            status = _status_from_nodes(node_states, has_started_node)
        elif run_event.type == "RUN_COMPLETED":
            status = "DONE"
        elif run_event.type == "RUN_ARCHIVED":
            status = "ARCHIVED"

    if status in {"DONE", "ARCHIVED"}:
        current_node_ids: list[str] = []
    else:
        current_node_ids = [
            node.id for node in workflow.nodes if node_states[node.id] in ACTIVE_NODE_STATES
        ]

    allowed_actions = _allowed_actions(status, node_states, current_node_ids)
    blocking_reasons = _blocking_reasons(node_states, current_node_ids)

    return RunProjection(
        runId=run_id,
        status=status,
        currentNodeIds=current_node_ids,
        nodeStates=node_states,
        allowedActions=allowed_actions,
        blockingReasons=blocking_reasons,
        revision=str(len(ordered_events)),
        updatedAt=updated_at,
    )


def _workflow_node(workflow: WorkflowDefinition, node_id: str):
    return next((node for node in workflow.nodes if node.id == node_id), None)


def _evaluate_declared_artifact_completion(
    workflow: WorkflowDefinition,
    node_id: str,
    events: list[RunEvent],
    node_states: dict[str, NodeState],
) -> None:
    node = _workflow_node(workflow, node_id)
    if node is None:
        return
    submitted_spec_ids = {
        str(event.payload.get("artifactSpecId", ""))
        for event in events
        if event.type == "ARTIFACT_SUBMITTED" and event.nodeId == node_id
    }
    missing = [
        output.id
        for output in node.artifacts.outputs
        if output.required and output.id not in submitted_spec_ids
    ]
    if missing:
        node_states[node_id] = "AWAITING_ARTIFACT"
    elif _node_requires_approval(workflow, node_id):
        node_states[node_id] = "AWAITING_APPROVAL"
    elif _node_requires_gate(workflow, node_id):
        node_states[node_id] = "AWAITING_GATE"
    else:
        _pass_node_and_ready_successors(workflow, node_id, node_states)


def _pass_node_and_ready_successors(
    workflow: WorkflowDefinition,
    node_id: str,
    node_states: dict[str, NodeState],
) -> None:
    node_states[node_id] = "PASSED"
    for target_id in _outgoing_targets(workflow, node_id):
        if _all_predecessors_passed(workflow, target_id, node_states):
            node_states[target_id] = "READY"


def _outgoing_targets(workflow: WorkflowDefinition, node_id: str) -> list[str]:
    return [edge.to for edge in workflow.edges if edge.from_ == node_id]


def _all_predecessors_passed(
    workflow: WorkflowDefinition,
    node_id: str,
    node_states: dict[str, NodeState],
) -> bool:
    predecessors = [edge.from_ for edge in workflow.edges if edge.to == node_id]
    return bool(predecessors) and all(node_states.get(source) == "PASSED" for source in predecessors)


def _node_requires_gate(workflow: WorkflowDefinition, node_id: str) -> bool:
    for node in workflow.nodes:
        if node.id != node_id:
            continue
        return bool(node.gates) or any(requirement.type == "gate" for requirement in node.requires)
    return False


def _node_requires_approval(workflow: WorkflowDefinition, node_id: str) -> bool:
    for node in workflow.nodes:
        if node.id != node_id:
            continue
        return node.kind == "approval" or any(
            requirement.type == "approval" for requirement in node.requires
        )
    return False


def _is_approval_node(workflow: WorkflowDefinition, node_id: str) -> bool:
    node = _workflow_node(workflow, node_id)
    return node is not None and node.kind == "approval"


def _status_from_nodes(node_states: dict[str, NodeState], has_started_node: bool) -> str:
    states = set(node_states.values())
    if "BLOCKED" in states:
        return "BLOCKED"
    if "AWAITING_APPROVAL" in states or "AWAITING_GATE" in states:
        return "REVIEWING"
    if states & {"READY", "RUNNING", "AWAITING_ARTIFACT"}:
        return "IN_PROGRESS" if has_started_node else "CREATED"
    return "DONE"


def _allowed_actions(
    status: str,
    node_states: dict[str, NodeState],
    current_node_ids: list[str],
) -> list[AllowedAction]:
    if status == "ARCHIVED":
        return []
    if status == "PAUSED":
        return [
            AllowedAction(
                id="run-resume",
                label="Resume run",
                eventType="RUN_RESUMED",
                nodeId=None,
                risk="medium",
            )
        ]
    if status in {"DONE", "BLOCKED"}:
        return [
            AllowedAction(
                id="run-archive",
                label="Archive run",
                eventType="RUN_ARCHIVED",
                nodeId=None,
                risk="low",
            )
        ]

    actions: list[AllowedAction] = []
    for node_id in current_node_ids:
        state = node_states[node_id]
        if state == "READY":
            actions.append(
                AllowedAction(
                    id=f"start:{node_id}",
                    label="Start node",
                    eventType="NODE_STARTED",
                    nodeId=node_id,
                    risk="low",
                )
            )
        elif state == "RUNNING":
            actions.append(
                AllowedAction(
                    id=f"submit-artifact:{node_id}",
                    label="Submit artifact",
                    eventType="ARTIFACT_SUBMITTED",
                    nodeId=node_id,
                    risk="medium",
                )
            )
            actions.append(
                AllowedAction(
                    id=f"complete:{node_id}",
                    label="Complete node",
                    eventType="NODE_COMPLETED",
                    nodeId=node_id,
                    risk="medium",
                )
            )
        elif state == "AWAITING_APPROVAL":
            actions.extend(
                [
                    AllowedAction(
                        id=f"approve:{node_id}",
                        label="Approve",
                        eventType="HUMAN_APPROVED",
                        nodeId=node_id,
                        risk="high",
                    ),
                    AllowedAction(
                        id=f"reject:{node_id}",
                        label="Reject",
                        eventType="HUMAN_REJECTED",
                        nodeId=node_id,
                        risk="high",
                    ),
                    AllowedAction(
                        id=f"defer:{node_id}",
                        label="Defer",
                        eventType="HUMAN_DEFERRED",
                        nodeId=node_id,
                        risk="medium",
                    ),
                ]
            )
        elif state == "AWAITING_ARTIFACT":
            actions.append(
                AllowedAction(
                    id=f"submit-artifact:{node_id}",
                    label="Submit artifact",
                    eventType="ARTIFACT_SUBMITTED",
                    nodeId=node_id,
                    risk="medium",
                )
            )
        elif state == "AWAITING_GATE":
            actions.extend(
                [
                    AllowedAction(
                        id=f"gate-pass:{node_id}",
                        label="Pass gate",
                        eventType="GATE_PASSED",
                        nodeId=node_id,
                        risk="medium",
                    ),
                    AllowedAction(
                        id=f"gate-fail:{node_id}",
                        label="Fail gate",
                        eventType="GATE_FAILED",
                        nodeId=node_id,
                        risk="medium",
                    ),
                    AllowedAction(
                        id=f"gate-waive:{node_id}",
                        label="Waive gate",
                        eventType="GATE_WAIVED",
                        nodeId=node_id,
                        risk="high",
                    ),
                ]
            )
    actions.append(
        AllowedAction(
            id="run-pause",
            label="Pause run",
            eventType="RUN_PAUSED",
            nodeId=None,
            risk="medium",
        )
    )
    return actions


def _blocking_reasons(
    node_states: dict[str, NodeState],
    current_node_ids: list[str],
) -> list[BlockingReason]:
    reasons: list[BlockingReason] = []
    for node_id in current_node_ids:
        state = node_states[node_id]
        if state == "AWAITING_APPROVAL":
            reasons.append(
                BlockingReason(
                    code="WAITING_FOR_HUMAN",
                    message="Approval is required",
                    nodeId=node_id,
                )
            )
        elif state == "AWAITING_ARTIFACT":
            reasons.append(
                BlockingReason(
                    code="MISSING_REQUIRED_ARTIFACT",
                    message="A required artifact is missing",
                    nodeId=node_id,
                )
            )
        elif state == "AWAITING_GATE":
            reasons.append(
                BlockingReason(
                    code="WAITING_FOR_GATE",
                    message="Gate verification is required",
                    nodeId=node_id,
                )
            )
        elif state == "BLOCKED":
            reasons.append(
                BlockingReason(
                    code="NODE_BLOCKED",
                    message="Node is blocked",
                    nodeId=node_id,
                )
            )
    return reasons
