from workflow_platform.compiler.compiler import compile_workflow
from workflow_platform.examples.full_feature_workflow import (
    REQUIRED_ROLE_IDS,
    build_full_feature_workflow,
)
from workflow_platform.models import NODE_KINDS


def test_full_feature_workflow_covers_every_node_kind_and_compiles() -> None:
    role_versions = {role_id: f"role-version:{role_id}:test" for role_id in REQUIRED_ROLE_IDS}

    workflow = build_full_feature_workflow(role_versions)

    assert {node.kind for node in workflow.nodes} == set(NODE_KINDS)
    assert len(workflow.nodes) == 13
    assert len(workflow.edges) == 12
    assert workflow.nodes[0].id == "intake"
    assert workflow.nodes[-1].id == "closeout"
    assert all(
        edge.from_ == workflow.nodes[index].id
        and edge.to == workflow.nodes[index + 1].id
        for index, edge in enumerate(workflow.edges)
    )
    deployment = next(node for node in workflow.nodes if node.id == "local-deploy")
    assert deployment.kind == "deploy"
    assert deployment.metadata["environment"] == "local-staging"
    assert deployment.metadata["risk"] == "high"
    assert deployment.metadata["serverRequired"] is False
    assert deployment.metadata["deploy"]["command"][:2] == ["node", "-e"]
    assert {role.id: role.assetVersionId for role in workflow.roles} == role_versions
    assert all(node.agent.roleId for node in workflow.nodes if node.kind == "agent")
    assert compile_workflow(workflow)["diagnostics"] == []
