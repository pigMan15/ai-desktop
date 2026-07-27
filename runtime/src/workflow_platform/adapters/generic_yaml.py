from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml
from pydantic import ValidationError

from workflow_platform.adapters.base import DetectionResult
from workflow_platform.models import WorkflowDefinition


class GenericYamlAdapter:
    id = "generic-yaml"
    name = "Generic YAML"

    def detect(self, project_path: Path) -> DetectionResult:
        workflow_path = self._workflow_path(project_path)
        if workflow_path.exists():
            return DetectionResult(
                adapter_id=self.id,
                name=self.name,
                score=70,
                diagnostics=[],
            )

        return DetectionResult(
            adapter_id=self.id,
            name=self.name,
            score=0,
            diagnostics=["未找到 workflow.yaml"],
        )

    def import_workflow(self, project_path: Path) -> WorkflowDefinition:
        workflow_path = self._workflow_path(project_path)
        if not workflow_path.exists():
            raise FileNotFoundError(f"未找到 workflow.yaml: {workflow_path}")

        try:
            with workflow_path.open("r", encoding="utf-8") as workflow_file:
                raw_workflow = yaml.safe_load(workflow_file)
        except yaml.YAMLError as error:
            raise ValueError(
                f"Generic YAML workflow 文件无效: {workflow_path}"
            ) from error

        if raw_workflow is None:
            raise ValueError(f"Generic YAML workflow 文件为空: {workflow_path}")

        if not isinstance(raw_workflow, dict):
            raise ValueError(
                f"Generic YAML workflow 顶层必须是 mapping: {workflow_path}"
            )

        metadata = raw_workflow.get("metadata", {})
        if "metadata" in raw_workflow and not isinstance(metadata, Mapping):
            raise ValueError(
                f"Generic YAML workflow metadata 必须是 mapping: {workflow_path}"
            )

        workflow_data: dict[str, Any] = {
            **raw_workflow,
            "sourceAdapter": self.id,
            "metadata": {
                **metadata,
                "sourcePath": workflow_path.as_posix(),
            },
        }

        try:
            return WorkflowDefinition.model_validate(workflow_data)
        except ValidationError as error:
            raise ValueError(
                f"Generic YAML workflow 导入失败: {workflow_path}"
            ) from error

    def _workflow_path(self, project_path: Path) -> Path:
        return project_path / "workflow.yaml"
