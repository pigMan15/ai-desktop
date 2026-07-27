from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, Field

from workflow_platform.models import WorkflowDefinition


class DetectionResult(BaseModel):
    adapter_id: str
    name: str
    score: int
    diagnostics: list[str] = Field(default_factory=list)


class WorkflowAdapter(Protocol):
    id: str
    name: str

    def detect(self, project_path: Path) -> DetectionResult:
        ...

    def import_workflow(self, project_path: Path) -> WorkflowDefinition:
        ...
