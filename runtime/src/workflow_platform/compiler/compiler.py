from workflow_platform.models import WorkflowDefinition


def compile_workflow(workflow: WorkflowDefinition) -> dict:
    diagnostics: list[dict] = []
    seen_node_ids: set[str] = set()
    duplicate_node_ids: set[str] = set()

    for node in workflow.nodes:
        if node.id in seen_node_ids and node.id not in duplicate_node_ids:
            diagnostics.append(
                {
                    "code": "DUPLICATE_NODE_ID",
                    "message": f"Node id '{node.id}' is defined more than once.",
                    "nodeId": node.id,
                }
            )
            duplicate_node_ids.add(node.id)
        seen_node_ids.add(node.id)

    for edge in workflow.edges:
        if edge.from_ not in seen_node_ids:
            diagnostics.append(
                {
                    "code": "EDGE_SOURCE_MISSING",
                    "message": (
                        f"Edge '{edge.id}' references missing source node "
                        f"'{edge.from_}'."
                    ),
                    "edgeId": edge.id,
                    "nodeId": edge.from_,
                }
            )
        if edge.to not in seen_node_ids:
            diagnostics.append(
                {
                    "code": "EDGE_TARGET_MISSING",
                    "message": (
                        f"Edge '{edge.id}' references missing target node "
                        f"'{edge.to}'."
                    ),
                    "edgeId": edge.id,
                    "nodeId": edge.to,
                }
            )

    return {
        "workflowId": workflow.id,
        "versionId": workflow.version,
        "diagnostics": diagnostics,
        "graphSpec": {
            "nodes": [
                {"id": node.id, "label": node.name, "kind": node.kind}
                for node in workflow.nodes
            ],
            "edges": [
                {"id": edge.id, "from": edge.from_, "to": edge.to}
                for edge in workflow.edges
            ],
        },
    }
