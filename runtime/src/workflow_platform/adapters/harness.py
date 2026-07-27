from pathlib import Path
from typing import Any

import yaml

from workflow_platform.adapters.base import DetectionResult
from workflow_platform.models import WorkflowDefinition


class HarnessAdapter:
    id = "harness"
    name = "Harness"

    def detect(self, project_path: Path) -> DetectionResult:
        workflow_path = self._workflow_path(project_path)
        if workflow_path.exists():
            return DetectionResult(
                adapter_id=self.id,
                name=self.name,
                score=100,
                diagnostics=[],
            )

        return DetectionResult(
            adapter_id=self.id,
            name=self.name,
            score=0,
            diagnostics=["未找到 .harness/workflow.yaml"],
        )

    def import_workflow(self, project_path: Path) -> WorkflowDefinition:
        workflow_path = self._workflow_path(project_path)
        if not workflow_path.exists():
            raise FileNotFoundError(f"未找到 Harness workflow 文件: {workflow_path}")

        with workflow_path.open("r", encoding="utf-8") as workflow_file:
            raw_workflow = yaml.safe_load(workflow_file) or {}

        if not isinstance(raw_workflow, dict):
            raise ValueError(f"Harness workflow 文件格式无效: {workflow_path}")

        workflow_data: dict[str, Any] = {
            **raw_workflow,
            "sourceAdapter": self.id,
            "metadata": {
                **raw_workflow.get("metadata", {}),
                "sourcePath": workflow_path.as_posix(),
            },
        }

        return WorkflowDefinition.model_validate(workflow_data)

    def _workflow_path(self, project_path: Path) -> Path:
        return project_path / ".harness" / "workflow.yaml"
