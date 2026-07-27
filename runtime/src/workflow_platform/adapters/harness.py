from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

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
            diagnostics=["\u672a\u627e\u5230 .harness/workflow.yaml"],
        )

    def import_workflow(self, project_path: Path) -> WorkflowDefinition:
        workflow_path = self._workflow_path(project_path)
        if not workflow_path.exists():
            raise FileNotFoundError(
                f"\u672a\u627e\u5230 Harness workflow \u6587\u4ef6: {workflow_path}"
            )

        try:
            with workflow_path.open("r", encoding="utf-8") as workflow_file:
                raw_workflow = yaml.safe_load(workflow_file)
        except yaml.YAMLError as error:
            raise ValueError(
                f"Harness workflow \u6587\u4ef6\u65e0\u6548: {workflow_path}"
            ) from error

        if raw_workflow is None:
            raise ValueError(
                f"Harness workflow \u6587\u4ef6\u4e3a\u7a7a: {workflow_path}"
            )

        if not isinstance(raw_workflow, dict):
            raise ValueError(
                f"Harness workflow \u9876\u5c42\u5fc5\u987b\u662f mapping: {workflow_path}"
            )

        workflow_data: dict[str, Any] = {
            **raw_workflow,
            "sourceAdapter": self.id,
            "metadata": {
                **raw_workflow.get("metadata", {}),
                "sourcePath": workflow_path.as_posix(),
            },
        }

        try:
            return WorkflowDefinition.model_validate(workflow_data)
        except ValidationError as error:
            raise ValueError(
                f"Harness workflow \u5bfc\u5165\u5931\u8d25: {workflow_path}"
            ) from error

    def _workflow_path(self, project_path: Path) -> Path:
        return project_path / ".harness" / "workflow.yaml"
