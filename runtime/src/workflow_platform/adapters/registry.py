from pathlib import Path

from workflow_platform.adapters.base import DetectionResult, WorkflowAdapter


class AdapterRegistry:
    def __init__(self, adapters: list[WorkflowAdapter]) -> None:
        self._adapters = adapters

    def detect(self, project_path: Path) -> list[DetectionResult]:
        results = [adapter.detect(project_path) for adapter in self._adapters]
        matches = [result for result in results if result.score > 0]
        return sorted(matches, key=lambda result: result.score, reverse=True)
