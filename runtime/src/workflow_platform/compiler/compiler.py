from workflow_platform.models import NodeAgentSpec, WorkflowDefinition


_ARTIFACT_PATH_VARIABLES = {"runId", "nodeId", "workflowId", "artifactId", "date"}


def compile_workflow(workflow: WorkflowDefinition) -> dict:
    diagnostics: list[dict] = []
    if not workflow.nodes:
        diagnostics.append(
            {
                "code": "EMPTY_WORKFLOW",
                "message": "Workflow must define at least one node.",
            }
        )
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
        if edge.condition:
            diagnostics.append(
                {
                    "code": "UNSUPPORTED_EDGE_CONDITION",
                    "message": f"Edge '{edge.id}' uses an unsupported condition.",
                    "edgeId": edge.id,
                }
            )

    for node in workflow.nodes:
        output_ids: set[str] = set()
        for output in node.artifacts.outputs:
            if output.id in output_ids:
                diagnostics.append(
                    {
                        "code": "DUPLICATE_ARTIFACT_SPEC_ID",
                        "message": f"Node '{node.id}' defines artifact id '{output.id}' more than once.",
                        "nodeId": node.id,
                        "artifactId": output.id,
                    }
                )
            output_ids.add(output.id)
            for variable in _artifact_path_variables(output.path):
                if variable not in _ARTIFACT_PATH_VARIABLES:
                    diagnostics.append(
                        {
                            "code": "UNKNOWN_ARTIFACT_PATH_VARIABLE",
                            "message": f"Artifact path for '{output.id}' uses unknown variable '{variable}'.",
                            "nodeId": node.id,
                            "artifactId": output.id,
                        }
                    )

        context = node.agent.context
        if any(
            value <= 0
            for value in (
                context.maxArtifacts,
                context.summaryCharsPerArtifact,
                context.maxTotalChars,
            )
        ) or context.maxTotalChars < context.summaryCharsPerArtifact:
            diagnostics.append(
                {
                    "code": "INVALID_AGENT_CONTEXT_LIMIT",
                    "message": f"Node '{node.id}' has invalid agent context limits.",
                    "nodeId": node.id,
                }
            )
        if node.agent != NodeAgentSpec() and node.kind != "agent":
            diagnostics.append(
                {
                    "code": "AGENT_CONFIGURATION_UNSUPPORTED",
                    "message": f"Node '{node.id}' does not support agent configuration.",
                    "nodeId": node.id,
                }
            )
        if node.advance.mode == "auto" and (
            node.kind in {"approval", "gate"}
            or (node.kind == "deploy" and node.metadata.get("risk") == "high")
        ):
            diagnostics.append(
                {
                    "code": "AUTO_ADVANCE_UNSUPPORTED",
                    "message": f"Node '{node.id}' cannot use automatic advance.",
                    "nodeId": node.id,
                }
            )

    if _contains_cycle(workflow):
        diagnostics.append(
            {
                "code": "WORKFLOW_CYCLE",
                "message": "Workflow graph must not contain a cycle.",
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


def _artifact_path_variables(value: str) -> list[str]:
    variables: list[str] = []
    offset = 0
    while True:
        start = value.find("{{", offset)
        if start < 0:
            return variables
        end = value.find("}}", start + 2)
        if end < 0:
            return [*variables, value[start + 2 :]]
        variables.append(value[start + 2 : end])
        offset = end + 2


def _contains_cycle(workflow: WorkflowDefinition) -> bool:
    outgoing: dict[str, list[str]] = {node.id: [] for node in workflow.nodes}
    for edge in workflow.edges:
        if edge.from_ in outgoing and edge.to in outgoing:
            outgoing[edge.from_].append(edge.to)

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node_id: str) -> bool:
        if node_id in visiting:
            return True
        if node_id in visited:
            return False
        visiting.add(node_id)
        if any(visit(target) for target in outgoing[node_id]):
            return True
        visiting.remove(node_id)
        visited.add(node_id)
        return False

    return any(visit(node_id) for node_id in outgoing)
