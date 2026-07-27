from __future__ import annotations

import hashlib
from pathlib import Path


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
