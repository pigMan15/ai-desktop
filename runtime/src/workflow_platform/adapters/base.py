from pathlib import Path
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field

from workflow_platform.models import WorkflowDefinition


class DetectionResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    adapter_id: str = Field(alias="adapterId")
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
