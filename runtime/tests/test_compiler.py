from workflow_platform.compiler.compiler import compile_workflow
from workflow_platform.models import WorkflowDefinition, WorkflowEdge, WorkflowNode


def _workflow(
    *,
    nodes: list[WorkflowNode] | None = None,
    edges: list[WorkflowEdge] | None = None,
) -> WorkflowDefinition:
    return WorkflowDefinition(
        id="workflow-1",
        name="Demo workflow",
        version="v1",
        sourceAdapter="fixture",
        nodes=nodes
        if nodes is not None
        else [
            WorkflowNode(id="task-1", name="Implement", kind="task"),
            WorkflowNode(id="approval-1", name="Approve", kind="approval"),
        ],
        edges=edges
        if edges is not None
        else [
            WorkflowEdge(id="edge-1", from_="task-1", to="approval-1"),
        ],
        roles=[],
        gates=[],
        policies={},
        metadata={},
    )


def test_compile_workflow_returns_graph_spec_for_valid_workflow() -> None:
    result = compile_workflow(_workflow())

    assert result == {
        "workflowId": "workflow-1",
        "versionId": "v1",
        "diagnostics": [],
        "graphSpec": {
            "nodes": [
                {"id": "task-1", "label": "Implement", "kind": "task"},
                {"id": "approval-1", "label": "Approve", "kind": "approval"},
            ],
            "edges": [
                {"id": "edge-1", "from": "task-1", "to": "approval-1"},
            ],
        },
    }


def test_compile_workflow_rejects_an_empty_workflow() -> None:
    result = compile_workflow(_workflow(nodes=[], edges=[]))

    assert result["diagnostics"] == [
        {
            "code": "EMPTY_WORKFLOW",
            "message": "Workflow must define at least one node.",
        }
    ]


def test_compile_workflow_reports_missing_edge_source_and_target() -> None:
    workflow = _workflow(
        edges=[
            WorkflowEdge(id="edge-1", from_="missing-source", to="approval-1"),
            WorkflowEdge(id="edge-2", from_="task-1", to="missing-target"),
        ]
    )

    result = compile_workflow(workflow)

    assert result["diagnostics"] == [
        {
            "code": "EDGE_SOURCE_MISSING",
            "message": "Edge 'edge-1' references missing source node 'missing-source'.",
            "edgeId": "edge-1",
            "nodeId": "missing-source",
        },
        {
            "code": "EDGE_TARGET_MISSING",
            "message": "Edge 'edge-2' references missing target node 'missing-target'.",
            "edgeId": "edge-2",
            "nodeId": "missing-target",
        },
    ]
    assert result["graphSpec"]["edges"] == [
        {"id": "edge-1", "from": "missing-source", "to": "approval-1"},
        {"id": "edge-2", "from": "task-1", "to": "missing-target"},
    ]


def test_compile_workflow_reports_duplicate_node_ids_without_blocking_graph() -> None:
    workflow = _workflow(
        nodes=[
            WorkflowNode(id="task-1", name="Implement", kind="task"),
            WorkflowNode(id="task-1", name="Implement again", kind="agent"),
        ],
        edges=[],
    )

    result = compile_workflow(workflow)

    assert result["diagnostics"] == [
        {
            "code": "DUPLICATE_NODE_ID",
            "message": "Node id 'task-1' is defined more than once.",
            "nodeId": "task-1",
        }
    ]
    assert result["graphSpec"]["nodes"] == [
        {"id": "task-1", "label": "Implement", "kind": "task"},
        {"id": "task-1", "label": "Implement again", "kind": "agent"},
    ]


def test_compile_workflow_rejects_invalid_artifact_contracts_and_agent_limits() -> None:
    workflow = _workflow(
        nodes=[
            WorkflowNode(
                id="agent-1",
                name="Agent",
                kind="agent",
                artifacts={
                    "outputs": [
                        {
                            "id": "report",
                            "name": "报告",
                            "type": "report",
                            "required": True,
                            "path": "docs/{{unknown}}/report.md",
                        },
                        {
                            "id": "report",
                            "name": "重复报告",
                            "type": "report",
                            "required": False,
                            "path": "docs/report.md",
                        },
                    ]
                },
                agent={
                    "context": {
                        "upstream": "direct",
                        "maxArtifacts": 0,
                        "summaryCharsPerArtifact": 100,
                        "maxTotalChars": 50,
                    }
                },
            )
        ],
        edges=[],
    )

    codes = {diagnostic["code"] for diagnostic in compile_workflow(workflow)["diagnostics"]}

    assert codes == {
        "DUPLICATE_ARTIFACT_SPEC_ID",
        "UNKNOWN_ARTIFACT_PATH_VARIABLE",
        "INVALID_AGENT_CONTEXT_LIMIT",
    }


def test_compile_workflow_rejects_cycles_and_unsupported_auto_advance() -> None:
    workflow = _workflow(
        nodes=[
            WorkflowNode(id="approval", name="审批", kind="approval", advance={"mode": "auto"}),
            WorkflowNode(id="agent", name="Agent", kind="agent"),
        ],
        edges=[
            WorkflowEdge(id="edge-1", from_="approval", to="agent"),
            WorkflowEdge(id="edge-2", from_="agent", to="approval"),
        ],
    )

    codes = {diagnostic["code"] for diagnostic in compile_workflow(workflow)["diagnostics"]}

    assert codes == {"WORKFLOW_CYCLE", "AUTO_ADVANCE_UNSUPPORTED"}
