from pathlib import Path

import pytest

from workflow_platform.adapters.base import DetectionResult
from workflow_platform.adapters.harness import HarnessAdapter
from workflow_platform.adapters.registry import AdapterRegistry


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
    assert result.name == "Harness"
    assert result.score == 100
    assert result.diagnostics == []


def test_harness_detect_returns_zero_when_workflow_yaml_missing() -> None:
    result = HarnessAdapter().detect(FIXTURES / "missing_project")

    assert result.score == 0
    assert "未找到 .harness/workflow.yaml" in result.diagnostics


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
