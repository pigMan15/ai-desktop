"""Built-in knowledge repository examples (document section 15).

The `complex-business` asset directory ships as package data (collected by
`collect_data_files('workflow_platform')`). Initialization reads assets via
`importlib.resources`, never through source absolute paths.
"""
from __future__ import annotations

import shutil
import subprocess
from importlib import resources
from pathlib import Path
from uuid import uuid4

from workflow_platform.knowledge.git_gateway import KnowledgeGitError, validate_repository_relative_path

EXAMPLE_ID = "complex-business"
EXAMPLE_NAME = "复杂业务研发知识库"
EXAMPLE_DESCRIPTION = (
    "虚构订单履约研发知识库，演示知识分层、索引路由、候选知识与人工审核。"
)

_PACKAGE = "workflow_platform.examples.knowledge"
_ASSET_DIR = "complex-business"

_TEMPLATE_REMOVED_PREFIX = ("applications/sample-order-service",)
_TEMPLATE_REMOVED_FILES = (
    "candidate/sample-pending-knowledge.md",
    "personal/sample-debugging-note.md",
)


def list_examples() -> list[dict]:
    return [
        {
            "id": EXAMPLE_ID,
            "name": EXAMPLE_NAME,
            "description": EXAMPLE_DESCRIPTION,
            "modes": ["complete", "template"],
        }
    ]


def _asset_root() -> Path:
    return resources.files(_PACKAGE) / _ASSET_DIR


def _asset_files() -> list[str]:
    root = _asset_root()
    files: list[str] = []
    for path in root.rglob("*"):
        if path.is_file():
            files.append(path.relative_to(root).as_posix())
    return sorted(files)


def _read_asset(relative: str) -> bytes:
    return (_asset_root() / relative).read_bytes()


def _removed_in_template(relative: str) -> bool:
    if relative in _TEMPLATE_REMOVED_FILES:
        return True
    return any(relative.startswith(prefix) for prefix in _TEMPLATE_REMOVED_PREFIX)


def initialize(
    example_id: str,
    *,
    mode: str,
    target_path: str,
    initialize_git: bool,
    now: str,
) -> dict:
    if example_id != EXAMPLE_ID:
        raise ValueError(f"KNOWLEDGE_EXAMPLE_NOT_FOUND: {example_id}")
    if mode not in {"complete", "template"}:
        raise ValueError(f"KNOWLEDGE_INPUT_INVALID: unsupported mode {mode}")
    target = Path(target_path).resolve()
    if target.exists() and any(target.iterdir()):
        raise ValueError("KNOWLEDGE_EXAMPLE_TARGET_NOT_EMPTY")
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.parent / f".{EXAMPLE_ID}-staging-{uuid4().hex[:8]}"
    created: list[str] = []
    try:
        for relative in _asset_files():
            if mode == "template" and _removed_in_template(relative):
                continue
            try:
                validate_repository_relative_path(relative)
            except KnowledgeGitError as error:
                raise ValueError(
                    f"KNOWLEDGE_EXAMPLE_INVALID_ASSET: {relative}: {error.message}"
                ) from error
            content = _read_asset(relative)
            if not content.strip():
                raise ValueError(f"KNOWLEDGE_EXAMPLE_EMPTY_ASSET: {relative}")
            destination = staging / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            created.append(relative)
        if not created:
            raise ValueError("KNOWLEDGE_EXAMPLE_EMPTY_CONTENT")
        if target.exists():
            for relative in created:
                shutil.move(str(staging / relative), str(target / relative))
            shutil.rmtree(staging, ignore_errors=True)
        else:
            shutil.move(str(staging), str(target))
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    git_initialized = False
    if initialize_git:
        subprocess.run(
            ["git", "init", "-q"],
            cwd=str(target),
            shell=False,
            check=True,
            timeout=30,
        )
        git_initialized = True
    return {
        "rootPath": str(target),
        "createdFiles": created,
        "gitInitialized": git_initialized,
    }
