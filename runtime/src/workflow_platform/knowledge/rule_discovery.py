"""Knowledge repository rule discovery (document sections 5.3, 6, 28.1).

Parses the optional `.ai-workflow/knowledge-repo.yaml` manifest, runs the
bounded deterministic scan, builds rule-discovery analysis copies and computes
snapshot hashes.
"""
from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import shutil
from pathlib import Path
from typing import Any

import yaml

SCAN_MAX_DEPTH = 4
SCAN_MAX_FILES = 500
SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024

ANALYSIS_RULE_FILE_BYTES = 2 * 1024 * 1024
ANALYSIS_RULE_TOTAL_BYTES = 20 * 1024 * 1024
ANALYSIS_ARTIFACT_BYTES = 10 * 1024 * 1024
ANALYSIS_TARGET_TOTAL_BYTES = 20 * 1024 * 1024
SUMMARY_CHARS = 4000

MANIFEST_ALLOWED_FIELDS = {
    "version",
    "rules",
    "routing",
    "indexes",
    "templates",
    "writablePaths",
    "protectedPaths",
    "validation",
}
MANIFEST_PATH_FIELDS = ("rules", "routing", "indexes", "templates", "writablePaths", "protectedPaths")

ENTRY_FILE_NAMES = (
    "README.md",
    "README",
    "AGENTS.md",
    "CLAUDE.md",
    "INDEX.md",
    "ROUTING.md",
    "KNOWLEDGE-RULES.md",
)

IGNORED_DIRECTORIES = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    "release",
    "installed-e2e",
    ".worktrees",
    "__pycache__",
    ".idea",
    ".vscode",
    ".pytest_cache",
}

BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".bmp", ".webp",
    ".zip", ".gz", ".tar", ".7z", ".exe", ".dll", ".so", ".dylib",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".woff", ".woff2", ".ttf", ".otf", ".class", ".pyc", ".db", ".sqlite",
}


class KnowledgeRuleDiscoveryError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _validated_glob(pattern: str, field: str) -> str:
    if not isinstance(pattern, str) or not pattern:
        raise KnowledgeRuleDiscoveryError(
            "KNOWLEDGE_INPUT_INVALID", f"{field} 包含空路径", status=400
        )
    normalized = pattern.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise KnowledgeRuleDiscoveryError(
            "KNOWLEDGE_PATH_OUTSIDE_REPOSITORY", f"{field} 不允许绝对路径: {pattern}", status=400
        )
    parts = normalized.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise KnowledgeRuleDiscoveryError(
            "KNOWLEDGE_PATH_OUTSIDE_REPOSITORY", f"{field} 包含 . 或 .. 片段: {pattern}", status=400
        )
    if posixpath.normpath(normalized) != normalized:
        raise KnowledgeRuleDiscoveryError(
            "KNOWLEDGE_PATH_OUTSIDE_REPOSITORY", f"{field} 路径未规范化: {pattern}", status=400
        )
    return normalized


def _validated_path_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise KnowledgeRuleDiscoveryError(
            "KNOWLEDGE_INPUT_INVALID", f"{field} 必须是字符串数组", status=400
        )
    return [_validated_glob(item, field) for item in value]


def _validated_commands(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, dict):
        raise KnowledgeRuleDiscoveryError("KNOWLEDGE_INPUT_INVALID", "validation 必须是映射", status=400)
    unknown = set(value) - {"commands"}
    if unknown:
        raise KnowledgeRuleDiscoveryError(
            "KNOWLEDGE_INPUT_INVALID", f"validation 未知字段 {sorted(unknown)}", status=400
        )
    commands = value.get("commands")
    if commands is None:
        return []
    if not isinstance(commands, list) or not all(isinstance(item, str) for item in commands):
        raise KnowledgeRuleDiscoveryError("KNOWLEDGE_INPUT_INVALID", "validation.commands 必须是字符串数组", status=400)
    for command in commands:
        if "\x00" in command or "\n" in command or "\r" in command:
            raise KnowledgeRuleDiscoveryError(
                "KNOWLEDGE_INPUT_INVALID", "validation.commands 包含非法控制字符", status=400
            )
    return commands


def parse_knowledge_repo_manifest(text: str, repository_root: Path) -> dict:
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as error:
        raise KnowledgeRuleDiscoveryError(
            "KNOWLEDGE_INPUT_INVALID", f"清单 YAML 解析失败: {error}", status=400
        ) from error
    if raw is None:
        return _empty_manifest()
    if not isinstance(raw, dict):
        raise KnowledgeRuleDiscoveryError("KNOWLEDGE_INPUT_INVALID", "清单必须是映射", status=400)
    unknown = set(raw) - MANIFEST_ALLOWED_FIELDS
    if unknown:
        raise KnowledgeRuleDiscoveryError(
            "KNOWLEDGE_INPUT_INVALID", f"清单未知字段 {sorted(unknown)}", status=400
        )
    if raw.get("version") != 1:
        raise KnowledgeRuleDiscoveryError("KNOWLEDGE_INPUT_INVALID", "仅支持 version 1", status=400)
    manifest: dict[str, Any] = {}
    for field in MANIFEST_PATH_FIELDS:
        manifest[field] = _validated_path_list(raw.get(field), field)
    manifest["validationCommands"] = _validated_commands(raw.get("validation"))
    return manifest


def _empty_manifest() -> dict:
    return {
        "rules": [],
        "routing": [],
        "indexes": [],
        "templates": [],
        "writablePaths": [],
        "protectedPaths": [],
        "validationCommands": [],
    }


def _ignored_directory(name: str) -> bool:
    return name in IGNORED_DIRECTORIES or name.startswith(".pytest") or name.startswith("release-")


def _is_entry_file(relative_path: str) -> bool:
    return relative_path in ENTRY_FILE_NAMES or relative_path.lower().startswith("readme")


def _matches_manifest(relative_path: str, manifest: dict | None) -> bool:
    if manifest is None:
        return False
    import fnmatch

    for field in ("rules", "routing", "indexes", "templates"):
        for pattern in manifest[field]:
            if fnmatch.fnmatch(relative_path, pattern):
                return True
    return False


def _is_binary(relative_path: str) -> bool:
    suffix = Path(relative_path).suffix.lower()
    return suffix in BINARY_EXTENSIONS or suffix == ""


def _scan_file_entry(root: Path, relative_path: str, path: Path, size: int) -> dict:
    try:
        content = path.read_bytes()[:SCAN_MAX_FILE_BYTES]
    except OSError:
        content = b""
    return {
        "path": relative_path,
        "sizeBytes": size,
        "sha256": hashlib.sha256(content).hexdigest(),
        "summary": _limited_summary(content),
    }


def _limited_summary(content: bytes) -> str:
    text = content.decode("utf-8", errors="replace")
    return text[:SUMMARY_CHARS]


def deterministic_scan(repository_root: Path, manifest: dict | None = None) -> dict:
    root = repository_root.resolve()
    found: list[dict] = []
    for current, dirs, files in os.walk(root):
        current_path = Path(current)
        if current_path != root:
            depth = len(current_path.relative_to(root).parts)
            if depth >= SCAN_MAX_DEPTH:
                dirs[:] = []
        dirs[:] = [d for d in dirs if not _ignored_directory(d)]
        for file_name in files:
            if len(found) >= SCAN_MAX_FILES:
                break
            relative = (
                current_path.relative_to(root).as_posix() + "/" + file_name
                if current_path != root
                else file_name
            )
            if _is_binary(relative):
                continue
            if not (_is_entry_file(relative) or _matches_manifest(relative, manifest)):
                continue
            path = current_path / file_name
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_size > SCAN_MAX_FILE_BYTES:
                continue
            found.append(_scan_file_entry(root, relative, path, stat.st_size))
    found.sort(key=lambda item: item["path"])
    return {
        "rootPath": str(root),
        "count": len(found),
        "files": found,
    }


def snapshot_content_hash(snapshot: dict) -> str:
    content = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def reread_rule_files(repository_root: Path, discovered_files: list[dict]) -> list[dict]:
    """Re-read referenced rule files and return current hash/size/status.

    Used when confirming a snapshot so the final hashes reflect the current
    working tree, and for stale detection during baseline checks.
    """
    root = repository_root.resolve()
    refreshed: list[dict] = []
    for entry in discovered_files:
        relative = entry["path"]
        path = root / relative
        try:
            resolved = path.resolve()
            resolved.relative_to(root)
        except (OSError, ValueError):
            refreshed.append({**entry, "status": "missing", "sha256": None, "sizeBytes": None})
            continue
        if not path.is_file():
            refreshed.append({**entry, "status": "missing", "sha256": None, "sizeBytes": None})
            continue
        try:
            content = path.read_bytes()
        except OSError:
            refreshed.append({**entry, "status": "unreadable", "sha256": None, "sizeBytes": None})
            continue
        refreshed.append(
            {
                **entry,
                "status": "unchanged" if entry.get("hash") == hashlib.sha256(content).hexdigest() else "changed",
                "sha256": hashlib.sha256(content).hexdigest(),
                "sizeBytes": len(content),
            }
        )
    return refreshed


def build_rule_discovery_analysis(
    analysis_root: Path,
    repository_root: Path,
    scan_result: dict,
    *,
    now: str,
) -> dict:
    """Copy scanned entry files into input/target and write manifest.json."""
    target_dir = analysis_root / "input" / "target"
    total_bytes = 0
    entries: list[dict] = []
    root = repository_root.resolve()
    for file_entry in scan_result["files"]:
        relative = file_entry["path"]
        source = root / relative
        if not source.is_file():
            continue
        stat = source.stat()
        if stat.st_size > ANALYSIS_RULE_FILE_BYTES:
            raise KnowledgeRuleDiscoveryError(
                "KNOWLEDGE_INPUT_LIMIT_EXCEEDED",
                f"规则文件超过 2 MiB 上限: {relative}",
                status=413,
            )
        total_bytes += stat.st_size
        if total_bytes > ANALYSIS_TARGET_TOTAL_BYTES:
            raise KnowledgeRuleDiscoveryError(
                "KNOWLEDGE_INPUT_LIMIT_EXCEEDED",
                "规则文件总量超过 20 MiB 上限",
                status=413,
            )
        destination = target_dir / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        entries.append(
            {
                "path": relative,
                "source": "repository-scan",
                "sizeBytes": stat.st_size,
                "sha256": file_entry["sha256"],
            }
        )
    manifest = {
        "kind": "rule-discovery",
        "createdAt": now,
        "repositoryRoot": str(root),
        "entries": entries,
    }
    (analysis_root / "input").mkdir(parents=True, exist_ok=True)
    (analysis_root / "input" / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (analysis_root / "output").mkdir(parents=True, exist_ok=True)
    (analysis_root / "logs").mkdir(parents=True, exist_ok=True)
    return manifest


def write_analysis_output(analysis_root: Path, relative_path: str, content: str) -> Path:
    """Write a structured output file under output/ with path validation."""
    validated = _validated_glob(relative_path, "output")
    destination = (analysis_root / "output" / validated).resolve()
    output_root = (analysis_root / "output").resolve()
    try:
        destination.relative_to(output_root)
    except ValueError:
        raise KnowledgeRuleDiscoveryError(
            "KNOWLEDGE_PATH_OUTSIDE_REPOSITORY",
            "输出路径越过 output 根",
            status=403,
        ) from None
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(content, encoding="utf-8", newline="\n")
    return destination
