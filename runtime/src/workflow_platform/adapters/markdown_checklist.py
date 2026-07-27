from pathlib import Path
import re

from workflow_platform.adapters.base import DetectionResult
from workflow_platform.models import WorkflowDefinition


CHECKLIST_ITEM_RE = re.compile(r"^\s*-\s+\[[ xX]\]\s+(.+?)\s*$")
TITLE_RE = re.compile(r"^#\s+(.+?)\s*$")


class MarkdownChecklistAdapter:
    id = "markdown-checklist"
    name = "Markdown Checklist"

    def detect(self, project_path: Path) -> DetectionResult:
        workflow_path = self._workflow_path(project_path)
        if workflow_path.exists():
            return DetectionResult(
                adapter_id=self.id,
                name=self.name,
                score=80,
                diagnostics=[],
            )

        return DetectionResult(
            adapter_id=self.id,
            name=self.name,
            score=0,
            diagnostics=["未找到 workflow.md"],
        )

    def import_workflow(self, project_path: Path) -> WorkflowDefinition:
        workflow_path = self._workflow_path(project_path)
        if not workflow_path.exists():
            raise FileNotFoundError(f"未找到 workflow.md: {workflow_path}")

        content = workflow_path.read_text(encoding="utf-8")
        title = self._parse_title(content) or "Markdown Checklist"
        items = self._parse_checklist_items(content)
        if not items:
            raise ValueError(
                f"Markdown checklist 中没有可导入的任务项: {workflow_path}"
            )

        nodes = [
            {
                "id": f"step-{index}",
                "name": item,
                "kind": "task",
                "metadata": {},
            }
            for index, item in enumerate(items, start=1)
        ]
        edges = [
            {
                "id": f"edge-step-{index}-step-{index + 1}",
                "from": f"step-{index}",
                "to": f"step-{index + 1}",
                "metadata": {},
            }
            for index in range(1, len(items))
        ]

        return WorkflowDefinition.model_validate(
            {
                "id": workflow_path.parent.name,
                "name": title,
                "version": "1",
                "sourceAdapter": self.id,
                "nodes": nodes,
                "edges": edges,
                "roles": [],
                "gates": [],
                "policies": {},
                "metadata": {
                    "sourcePath": workflow_path.as_posix(),
                },
            }
        )

    def _workflow_path(self, project_path: Path) -> Path:
        return project_path / "workflow.md"

    def _parse_title(self, content: str) -> str | None:
        for line in content.splitlines():
            match = TITLE_RE.match(line)
            if match:
                return match.group(1)
        return None

    def _parse_checklist_items(self, content: str) -> list[str]:
        items = []
        for line in content.splitlines():
            match = CHECKLIST_ITEM_RE.match(line)
            if match:
                items.append(match.group(1))
        return items
