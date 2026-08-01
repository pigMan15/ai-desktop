from __future__ import annotations

import hashlib
from pathlib import Path
import re


_ARTIFACT_TEMPLATE_VARIABLE = re.compile(r"{{([^{}]+)}}")
_ARTIFACT_TEMPLATE_VARIABLES = {"runId", "nodeId", "workflowId", "artifactId", "date"}


def validate_safe_path(project_root: str | Path, artifact_path: str | Path) -> Path:
    """Return a resolved artifact path after confirming it stays under the project root."""
    root = Path(project_root).resolve(strict=False)
    candidate = Path(artifact_path)
    resolved = (candidate if candidate.is_absolute() else root / candidate).resolve(strict=False)

    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError(
            f"artifact path must stay within project root: {resolved} is outside {root}"
        ) from exc

    return resolved


def hash_artifact(path: str | Path) -> str:
    artifact_path = Path(path)
    digest = hashlib.sha256()

    with artifact_path.open("rb") as artifact:
        for chunk in iter(lambda: artifact.read(1024 * 1024), b""):
            digest.update(chunk)

    return digest.hexdigest()


def render_artifact_path(
    project_root: str | Path,
    template: str,
    *,
    run_id: str,
    node_id: str,
    workflow_id: str,
    artifact_id: str,
    date: str,
) -> Path:
    """Render a declared relative artifact path and keep it inside the project."""
    if not isinstance(template, str) or not template.strip() or "\x00" in template:
        raise ValueError("artifact path template must be a non-empty string without NUL")
    if "{{" in _ARTIFACT_TEMPLATE_VARIABLE.sub("", template) or "}}" in _ARTIFACT_TEMPLATE_VARIABLE.sub("", template):
        raise ValueError("artifact path template contains an unclosed variable")

    values = {
        "runId": run_id,
        "nodeId": node_id,
        "workflowId": workflow_id,
        "artifactId": artifact_id,
        "date": date,
    }

    def replace(match: re.Match[str]) -> str:
        variable = match.group(1)
        if variable not in _ARTIFACT_TEMPLATE_VARIABLES:
            raise ValueError(f"artifact path template uses unknown variable: {variable}")
        value = values[variable]
        if not value:
            raise ValueError(f"artifact path template variable is empty: {variable}")
        return value

    rendered = _ARTIFACT_TEMPLATE_VARIABLE.sub(replace, template).strip()
    candidate = Path(rendered)
    if candidate.is_absolute():
        raise ValueError("artifact path template must be relative to the project root")
    return validate_safe_path(project_root, candidate)
