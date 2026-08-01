from pathlib import Path
from shutil import rmtree

from workflow_platform.execution.agent_context import AgentContextBuilder
from workflow_platform.models import WorkflowDefinition, WorkflowEdge, WorkflowNode


def test_agent_context_builder_includes_only_passed_ancestor_artifacts_with_limits() -> None:
    workspace = Path(__file__).parent / ".agent_context_tmp"
    rmtree(workspace, ignore_errors=True)
    workspace.mkdir(parents=True)
    try:
        requirement = workspace / "requirements.md"
        requirement.write_text("需求摘要：登录必须支持超时处理。", encoding="utf-8")
        plan = workspace / "plan.md"
        plan.write_text("计划摘要：增加超时重试和回归测试。", encoding="utf-8")
        workflow = WorkflowDefinition(
            id="workflow-1",
            name="Demo",
            version="1",
            sourceAdapter="fixture",
            nodes=[
                WorkflowNode(id="requirement", name="需求", kind="agent"),
                WorkflowNode(id="plan", name="方案", kind="agent"),
                WorkflowNode(
                    id="implementation",
                    name="实现",
                    kind="agent",
                    agent={
                        "context": {
                            "upstream": "ancestors",
                            "artifactTypes": ["requirement", "plan"],
                            "maxArtifacts": 2,
                            "summaryCharsPerArtifact": 12,
                            "maxTotalChars": 20,
                        }
                    },
                ),
            ],
            edges=[
                WorkflowEdge(id="requirement-plan", from_="requirement", to="plan"),
                WorkflowEdge(id="plan-implementation", from_="plan", to="implementation"),
            ],
            roles=[],
            gates=[],
            policies={},
            metadata={},
        )

        result = AgentContextBuilder().build(
            workflow=workflow,
            node_id="implementation",
            node_states={"requirement": "PASSED", "plan": "PASSED", "implementation": "READY"},
            artifacts=[
                {"nodeId": "requirement", "type": "requirement", "uri": requirement.as_uri()},
                {"nodeId": "plan", "type": "plan", "uri": plan.as_uri()},
                {"nodeId": "plan", "type": "debug", "uri": plan.as_uri()},
            ],
            project_root=workspace,
        )

        assert [item["type"] for item in result.artifacts] == ["requirement", "plan"]
        assert "requirements.md" in result.prompt
        assert "plan.md" in result.prompt
        assert "debug" not in result.prompt
        assert "已截断" in result.prompt
    finally:
        rmtree(workspace, ignore_errors=True)
