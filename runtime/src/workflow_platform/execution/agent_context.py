from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse

from workflow_platform.artifacts.service import validate_safe_path
from workflow_platform.models import WorkflowDefinition


@dataclass(frozen=True)
class AgentContextResult:
    artifacts: list[dict]
    prompt: str


class AgentContextBuilder:
    """Build bounded, project-local upstream context for an agent invocation."""

    def build(
        self,
        *,
        workflow: WorkflowDefinition,
        node_id: str,
        node_states: dict[str, str],
        artifacts: list[dict],
        project_root: Path,
    ) -> AgentContextResult:
        node = next((candidate for candidate in workflow.nodes if candidate.id == node_id), None)
        if node is None:
            raise ValueError(f"AGENT_UNKNOWN_NODE: Node not found in workflow: {node_id}")
        context = node.agent.context
        if context.upstream == "none":
            return AgentContextResult(artifacts=[], prompt="")

        source_ids = _source_node_ids(workflow, node_id, context.upstream)
        selected: list[dict] = []
        total_chars = 0
        allowed_types = set(context.artifactTypes)
        for source_id in source_ids:
            if node_states.get(source_id) != "PASSED":
                continue
            for artifact in artifacts:
                if artifact.get("nodeId") != source_id:
                    continue
                artifact_type = str(artifact.get("type", ""))
                if allowed_types and artifact_type not in allowed_types:
                    continue
                if len(selected) >= context.maxArtifacts:
                    break
                safe_path = _artifact_path(project_root, str(artifact.get("uri", "")))
                summary: str | None = None
                if context.delivery != "path":
                    summary = _artifact_summary(safe_path, context.summaryCharsPerArtifact)
                    remaining = max(0, context.maxTotalChars - total_chars)
                    if remaining == 0:
                        summary = "[摘要已截断：已达到上下文总长度上限]"
                    elif len(summary) > remaining:
                        summary = summary[:remaining] + "\n[摘要已截断：已达到上下文总长度上限]"
                    total_chars += len(summary)
                selected.append(
                    {
                        "artifactId": artifact.get("id"),
                        "nodeId": source_id,
                        "type": artifact_type,
                        "path": safe_path.relative_to(project_root.resolve()).as_posix(),
                        "contentHash": artifact.get("contentHash"),
                        "summary": summary,
                    }
                )
            if len(selected) >= context.maxArtifacts:
                break

        if not selected:
            return AgentContextResult(artifacts=[], prompt="")
        lines = ["上游正式产物（仅供当前任务使用）："]
        if context.delivery in {"path", "hybrid"}:
            lines.append("这些文件位于当前 Run 工作区。请按需使用 read 工具读取，且不得修改前置产物。")
        for item in selected:
            lines.extend(
                [
                    f"- 类型：{item['type']}",
                    f"  路径：{item['path']}",
                    f"  内容哈希：{item['contentHash'] or '未记录'}",
                ]
            )
            if item["summary"] is not None:
                lines.extend(["  摘要：", item["summary"]])
        return AgentContextResult(artifacts=selected, prompt="\n".join(lines))


def _source_node_ids(workflow: WorkflowDefinition, node_id: str, scope: str) -> list[str]:
    predecessors = {edge.to: [] for edge in workflow.edges}
    for edge in workflow.edges:
        predecessors.setdefault(edge.to, []).append(edge.from_)
    direct = predecessors.get(node_id, [])
    if scope == "direct":
        return direct

    ancestor_ids: set[str] = set()
    pending = list(direct)
    while pending:
        source = pending.pop()
        if source in ancestor_ids:
            continue
        ancestor_ids.add(source)
        pending.extend(predecessors.get(source, []))
    return [node.id for node in workflow.nodes if node.id in ancestor_ids]


def _artifact_path(project_root: Path, uri: str) -> Path:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        raise ValueError("AGENT_CONTEXT_ARTIFACT_URI_INVALID: artifact must use a file URI")
    path_text = unquote(parsed.path)
    if len(path_text) >= 3 and path_text[0] == "/" and path_text[2] == ":":
        path_text = path_text[1:]
    path = validate_safe_path(project_root, Path(path_text))
    if not path.is_file():
        raise ValueError(f"AGENT_CONTEXT_ARTIFACT_MISSING: artifact is not a readable file: {path}")
    return path


def _artifact_summary(path: Path, limit: int) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return "[二进制产物：不读取正文]"
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if len(text) <= limit:
        return text
    return text[:limit] + "\n[摘要已截断：已达到单文件上限]"
