from pathlib import Path

import pytest
import yaml

from workflow_platform.adapters.base import DetectionResult
from workflow_platform.adapters.generic_yaml import GenericYamlAdapter
from workflow_platform.adapters.harness import HarnessAdapter
from workflow_platform.adapters.markdown_checklist import MarkdownChecklistAdapter
from workflow_platform.adapters.registry import AdapterRegistry, default_registry


FIXTURES = Path(__file__).parent / "fixtures"


class FixedScoreAdapter:
    def __init__(self, adapter_id: str, score: int) -> None:
        self.id = adapter_id
        self.name = adapter_id.title()
        self._score = score

    def detect(self, project_path: Path) -> DetectionResult:
        return DetectionResult(
            adapter_id=self.id,
            name=self.name,
            score=self._score,
            diagnostics=[],
        )

    def import_workflow(self, project_path: Path):
        raise NotImplementedError


def test_harness_detects_workflow_yaml() -> None:
    result = HarnessAdapter().detect(FIXTURES / "harness_project")

    assert result.adapter_id == "harness"
    assert result.model_dump(by_alias=True)["adapterId"] == "harness"
    assert result.name == "Harness"
    assert result.score == 100
    assert result.diagnostics == []


def test_harness_detect_returns_zero_when_workflow_yaml_missing() -> None:
    result = HarnessAdapter().detect(FIXTURES / "missing_project")

    assert result.score == 0
    assert "未找到 .harness/workflow.yaml" in result.diagnostics


def test_harness_detect_ignores_workflow_yaml_directory(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    (project_path / ".harness" / "workflow.yaml").mkdir(parents=True)

    result = HarnessAdapter().detect(project_path)

    assert result.score == 0
    assert ".harness/workflow.yaml" in result.diagnostics[0]


def test_registry_filters_zero_scores_and_sorts_descending() -> None:
    registry = AdapterRegistry(
        [
            FixedScoreAdapter("low", 10),
            FixedScoreAdapter("zero", 0),
            FixedScoreAdapter("high", 80),
        ]
    )

    results = registry.detect(FIXTURES / "missing_project")

    assert [result.adapter_id for result in results] == ["high", "low"]
    assert [result.score for result in results] == [80, 10]


def test_harness_imports_workflow_definition_with_source_metadata() -> None:
    workflow = HarnessAdapter().import_workflow(FIXTURES / "harness_project")

    assert workflow.id == "demo-workflow"
    assert workflow.sourceAdapter == "harness"
    assert workflow.metadata["sourcePath"].endswith(".harness/workflow.yaml")
    assert workflow.nodes[0].id == "plan"
    assert workflow.edges[0].from_ == "plan"
    assert workflow.edges[0].model_dump(by_alias=True)["from"] == "plan"
    assert workflow.roles[0].id == "planner"
    assert workflow.gates[0].id == "plan-ready"
    assert workflow.policies["approvals"]["requireHumanReview"] is True


def test_harness_import_raises_clear_error_when_workflow_yaml_missing() -> None:
    with pytest.raises(FileNotFoundError, match=r"\.harness[/\\]workflow\.yaml"):
        HarnessAdapter().import_workflow(FIXTURES / "missing_project")


def test_harness_import_raises_clear_error_when_workflow_yaml_empty() -> None:
    project_path = FIXTURES / "empty_harness_project"
    workflow_path = project_path / ".harness" / "workflow.yaml"

    with pytest.raises(ValueError) as exc_info:
        HarnessAdapter().import_workflow(project_path)

    message = str(exc_info.value)
    assert "Harness workflow 文件为空" in message
    assert str(workflow_path) in message


def test_harness_import_wraps_invalid_yaml_with_context() -> None:
    project_path = FIXTURES / "invalid_yaml_harness_project"
    workflow_path = project_path / ".harness" / "workflow.yaml"

    with pytest.raises(ValueError) as exc_info:
        HarnessAdapter().import_workflow(project_path)

    message = str(exc_info.value)
    assert f"Harness workflow 文件无效: {workflow_path}" in message
    assert isinstance(exc_info.value.__cause__, yaml.YAMLError)


def test_harness_import_rejects_non_mapping_yaml() -> None:
    project_path = FIXTURES / "non_mapping_harness_project"
    workflow_path = project_path / ".harness" / "workflow.yaml"

    with pytest.raises(ValueError) as exc_info:
        HarnessAdapter().import_workflow(project_path)

    message = str(exc_info.value)
    assert "Harness workflow 顶层必须是 mapping" in message
    assert str(workflow_path) in message


def test_harness_import_wraps_validation_error_with_context() -> None:
    project_path = FIXTURES / "missing_required_harness_project"
    workflow_path = project_path / ".harness" / "workflow.yaml"

    with pytest.raises(ValueError) as exc_info:
        HarnessAdapter().import_workflow(project_path)

    message = str(exc_info.value)
    assert "Harness workflow 导入失败" in message
    assert str(workflow_path) in message


@pytest.mark.parametrize(
    "fixture_name",
    ["metadata_null_harness_project", "metadata_list_harness_project"],
)
def test_harness_import_rejects_non_mapping_metadata(fixture_name: str) -> None:
    project_path = FIXTURES / fixture_name
    workflow_path = project_path / ".harness" / "workflow.yaml"

    with pytest.raises(ValueError) as exc_info:
        HarnessAdapter().import_workflow(project_path)

    message = str(exc_info.value)
    assert "metadata" in message
    assert "mapping" in message
    assert str(workflow_path) in message


def test_markdown_checklist_adapter_imports_checked_tasks_as_workflow() -> None:
    result = MarkdownChecklistAdapter().detect(FIXTURES / "markdown_checklist_project")
    workflow = MarkdownChecklistAdapter().import_workflow(
        FIXTURES / "markdown_checklist_project"
    )

    assert result.score == 80
    assert workflow.sourceAdapter == "markdown-checklist"
    assert workflow.name == "Release Checklist"
    assert workflow.metadata["sourcePath"].endswith("workflow.md")
    assert [node.id for node in workflow.nodes] == ["step-1", "step-2"]
    assert [node.name for node in workflow.nodes] == [
        "Draft implementation plan",
        "Review evidence and approve",
    ]
    assert workflow.edges[0].from_ == "step-1"
    assert workflow.edges[0].to == "step-2"


def test_markdown_checklist_detect_ignores_workflow_md_directory(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    (project_path / "workflow.md").mkdir(parents=True)

    result = MarkdownChecklistAdapter().detect(project_path)

    assert result.score == 0


def test_markdown_checklist_detect_returns_clear_error_when_workflow_md_missing() -> None:
    result = MarkdownChecklistAdapter().detect(FIXTURES / "missing_project")

    assert result.score == 0
    assert "未找到 workflow.md" in result.diagnostics


def test_markdown_checklist_import_raises_clear_error_when_workflow_md_missing() -> None:
    with pytest.raises(FileNotFoundError) as exc_info:
        MarkdownChecklistAdapter().import_workflow(FIXTURES / "missing_project")

    message = str(exc_info.value)
    assert "未找到 workflow.md" in message


def test_markdown_checklist_import_raises_clear_error_when_no_items(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    project_path.mkdir()
    workflow_path = project_path / "workflow.md"
    workflow_path.write_text("# Empty Checklist\n\nNo tasks yet.\n", encoding="utf-8")

    with pytest.raises(ValueError) as exc_info:
        MarkdownChecklistAdapter().import_workflow(project_path)

    message = str(exc_info.value)
    assert "Markdown checklist" in message
    assert str(workflow_path) in message


def test_generic_yaml_adapter_imports_canonical_schema() -> None:
    result = GenericYamlAdapter().detect(FIXTURES / "generic_yaml_project")
    workflow = GenericYamlAdapter().import_workflow(FIXTURES / "generic_yaml_project")

    assert result.score == 70
    assert workflow.sourceAdapter == "generic-yaml"
    assert workflow.metadata["sourcePath"].endswith("workflow.yaml")
    assert workflow.nodes[0].kind == "agent"
    assert workflow.gates[0].id == "tests"


def test_generic_yaml_adapter_merges_source_path_into_metadata(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    project_path.mkdir()
    workflow_path = project_path / "workflow.yaml"
    workflow_path.write_text(
        "\n".join(
            [
                "id: generic-demo",
                "name: Generic Demo",
                "version: '1'",
                "nodes: []",
                "edges: []",
                "roles: []",
                "gates: []",
                "policies: {}",
                "metadata:",
                "  domain: testing",
            ]
        ),
        encoding="utf-8",
    )

    workflow = GenericYamlAdapter().import_workflow(project_path)

    assert workflow.metadata["domain"] == "testing"
    assert workflow.metadata["sourcePath"] == workflow_path.as_posix()


def test_generic_yaml_detect_ignores_workflow_yaml_directory(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    (project_path / "workflow.yaml").mkdir(parents=True)

    result = GenericYamlAdapter().detect(project_path)

    assert result.score == 0


def test_generic_yaml_detect_returns_clear_error_when_workflow_yaml_missing() -> None:
    result = GenericYamlAdapter().detect(FIXTURES / "missing_project")

    assert result.score == 0
    assert "未找到 workflow.yaml" in result.diagnostics


def test_generic_yaml_import_raises_clear_error_when_workflow_yaml_missing() -> None:
    with pytest.raises(FileNotFoundError) as exc_info:
        GenericYamlAdapter().import_workflow(FIXTURES / "missing_project")

    message = str(exc_info.value)
    assert "未找到 workflow.yaml" in message


def test_generic_yaml_import_raises_clear_error_when_workflow_yaml_empty(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    project_path.mkdir()
    workflow_path = project_path / "workflow.yaml"
    workflow_path.write_text("", encoding="utf-8")

    with pytest.raises(ValueError) as exc_info:
        GenericYamlAdapter().import_workflow(project_path)

    message = str(exc_info.value)
    assert "Generic YAML workflow 文件为空" in message
    assert str(workflow_path) in message


def test_generic_yaml_import_rejects_non_mapping_yaml(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    project_path.mkdir()
    workflow_path = project_path / "workflow.yaml"
    workflow_path.write_text("- not\n- mapping\n", encoding="utf-8")

    with pytest.raises(ValueError) as exc_info:
        GenericYamlAdapter().import_workflow(project_path)

    message = str(exc_info.value)
    assert "Generic YAML workflow 顶层必须是 mapping" in message
    assert str(workflow_path) in message


@pytest.mark.parametrize("metadata", ["null", "[]"])
def test_generic_yaml_import_rejects_non_mapping_metadata(
    tmp_path: Path,
    metadata: str,
) -> None:
    project_path = tmp_path / "project"
    project_path.mkdir()
    workflow_path = project_path / "workflow.yaml"
    workflow_path.write_text(
        "\n".join(
            [
                "id: demo",
                "name: Demo",
                "version: '1'",
                "nodes: []",
                f"metadata: {metadata}",
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError) as exc_info:
        GenericYamlAdapter().import_workflow(project_path)

    message = str(exc_info.value)
    assert "metadata" in message
    assert "mapping" in message
    assert str(workflow_path) in message


def test_generic_yaml_import_wraps_validation_error_with_context(tmp_path: Path) -> None:
    project_path = tmp_path / "project"
    project_path.mkdir()
    workflow_path = project_path / "workflow.yaml"
    workflow_path.write_text("name: Missing Required Fields\n", encoding="utf-8")

    with pytest.raises(ValueError) as exc_info:
        GenericYamlAdapter().import_workflow(project_path)

    message = str(exc_info.value)
    assert "Generic YAML workflow 导入失败" in message
    assert str(workflow_path) in message


def test_registry_includes_three_p1_adapters() -> None:
    registry = default_registry()
    results = registry.detect(FIXTURES / "markdown_checklist_project")
    assert results[0].adapter_id == "markdown-checklist"
