"""Knowledge Agent output parsing, validation and risk (document sections 7.3,
28.4, 28.5, 29).

`parse_proposal` persists proposed content to the analysis output directory so
large file bodies never enter SQLite; `classify_risk` is a pure function.
"""
from __future__ import annotations

import hashlib
import json
import posixpath
import re
from pathlib import Path
from typing import Any

from workflow_platform.knowledge.git_gateway import (
    KnowledgeGitError,
    validate_repository_relative_path,
)
from workflow_platform.knowledge.rule_discovery import write_analysis_output

ALLOWED_RULE_DISCOVERY_FIELDS = {
    "version",
    "summary",
    "ruleFiles",
    "indexFiles",
    "routingFiles",
    "templateFiles",
    "suggestedWritablePaths",
    "suggestedProtectedPaths",
    "suggestedValidationCommands",
    "findings",
    "openQuestions",
    "conflicts",
}
ALLOWED_PROPOSAL_FIELDS = {
    "version",
    "summary",
    "rulesUsed",
    "sourceFindings",
    "changes",
    "suggestedValidation",
    "blockedReasons",
}
ALLOWED_CHANGE_FIELDS = {
    "path",
    "operation",
    "reason",
    "category",
    "sourceArtifactIds",
    "content",
    "warnings",
}
RULE_FILE_CATEGORIES = {"RULE", "INDEX", "ROUTING", "TEMPLATE", "REFERENCE"}
FILE_CATEGORIES = {"KNOWLEDGE", "INDEX", "ROUTING", "RULE", "TEMPLATE"}
OPERATIONS = {"CREATE", "UPDATE"}

MAX_FILE_CHANGES = 50
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024

CREDENTIAL_PATTERNS = (
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)password\s*[:=]\s*\S+"),
    re.compile(r"(?i)api[_-]?key\s*[:=]\s*\S+"),
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),
)


class KnowledgeProposalError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def _require_mapping(value: Any, label: str) -> dict:
    if not isinstance(value, dict):
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", f"{label} 必须是对象")
    return value


def _require_string_list(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", f"{label} 必须是字符串数组")
    return list(value)


def _validated_path(path: str, label: str) -> str:
    try:
        return validate_repository_relative_path(path)
    except KnowledgeGitError as error:
        raise KnowledgeProposalError(
            "KNOWLEDGE_AGENT_OUTPUT_INVALID",
            f"{label} 路径无效: {error.message}",
        ) from error


def validate_rule_discovery_output(payload: Any) -> dict:
    data = _require_mapping(payload, "rule-discovery.json")
    unknown = set(data) - ALLOWED_RULE_DISCOVERY_FIELDS
    if unknown:
        raise KnowledgeProposalError(
            "KNOWLEDGE_AGENT_OUTPUT_INVALID", f"rule-discovery 未知字段 {sorted(unknown)}"
        )
    if data.get("version") != 1:
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "rule-discovery version 必须为 1")
    if not isinstance(data.get("summary", ""), str):
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "rule-discovery summary 必须是字符串")

    rule_files = data.get("ruleFiles", [])
    if not isinstance(rule_files, list):
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "ruleFiles 必须是数组")
    normalized_rule_files: list[dict] = []
    for item in rule_files:
        entry = _require_mapping(item, "ruleFiles 元素")
        unknown = set(entry) - {"path", "category", "purpose"}
        if unknown:
            raise KnowledgeProposalError(
                "KNOWLEDGE_AGENT_OUTPUT_INVALID", f"ruleFiles 元素未知字段 {sorted(unknown)}"
            )
        path = _validated_path(entry["path"], "ruleFiles.path")
        category = entry.get("category")
        if category not in RULE_FILE_CATEGORIES:
            raise KnowledgeProposalError(
                "KNOWLEDGE_AGENT_OUTPUT_INVALID", f"ruleFiles.category 无效: {category}"
            )
        purpose = entry.get("purpose", "")
        if not isinstance(purpose, str):
            raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "ruleFiles.purpose 必须是字符串")
        normalized_rule_files.append({"path": path, "category": category, "purpose": purpose})

    normalized: dict[str, Any] = {
        "version": 1,
        "summary": data.get("summary", ""),
        "ruleFiles": normalized_rule_files,
        "indexFiles": [_validated_path(p, "indexFiles") for p in _require_string_list(data.get("indexFiles", []), "indexFiles")],
        "routingFiles": [_validated_path(p, "routingFiles") for p in _require_string_list(data.get("routingFiles", []), "routingFiles")],
        "templateFiles": [_validated_path(p, "templateFiles") for p in _require_string_list(data.get("templateFiles", []), "templateFiles")],
        "suggestedWritablePaths": _require_string_list(data.get("suggestedWritablePaths", []), "suggestedWritablePaths"),
        "suggestedProtectedPaths": _require_string_list(data.get("suggestedProtectedPaths", []), "suggestedProtectedPaths"),
        "suggestedValidationCommands": _require_string_list(data.get("suggestedValidationCommands", []), "suggestedValidationCommands"),
        "findings": _require_string_list(data.get("findings", []), "findings"),
        "openQuestions": _require_string_list(data.get("openQuestions", []), "openQuestions"),
        "conflicts": _require_string_list(data.get("conflicts", []), "conflicts"),
    }
    return normalized


def parse_proposal(payload: Any, analysis_root: Path, *, now: str) -> dict:
    data = _require_mapping(payload, "proposal.json")
    unknown = set(data) - ALLOWED_PROPOSAL_FIELDS
    if unknown:
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", f"proposal 未知字段 {sorted(unknown)}")
    if data.get("version") != 1:
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "proposal version 必须为 1")
    if not isinstance(data.get("summary", ""), str):
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "proposal summary 必须是字符串")

    rules_used = data.get("rulesUsed", [])
    if not isinstance(rules_used, list):
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "rulesUsed 必须是数组")
    normalized_rules: list[dict] = []
    for item in rules_used:
        entry = _require_mapping(item, "rulesUsed 元素")
        unknown = set(entry) - {"path", "sha256", "purpose"}
        if unknown:
            raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", f"rulesUsed 元素未知字段 {sorted(unknown)}")
        path = _validated_path(entry["path"], "rulesUsed.path")
        sha256 = entry.get("sha256")
        if not isinstance(sha256, str) or len(sha256) != 64:
            raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "rulesUsed.sha256 必须是 64 位十六进制")
        normalized_rules.append(
            {"path": path, "sha256": sha256.lower(), "purpose": entry.get("purpose", "")}
        )

    source_findings = data.get("sourceFindings", [])
    if not isinstance(source_findings, list):
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "sourceFindings 必须是数组")
    normalized_findings: list[dict] = []
    for item in source_findings:
        entry = _require_mapping(item, "sourceFindings 元素")
        unknown = set(entry) - {"artifactId", "facts", "inferences", "openQuestions"}
        if unknown:
            raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", f"sourceFindings 元素未知字段 {sorted(unknown)}")
        normalized_findings.append(
            {
                "artifactId": entry.get("artifactId", ""),
                "facts": _require_string_list(entry.get("facts", []), "sourceFindings.facts"),
                "inferences": _require_string_list(entry.get("inferences", []), "sourceFindings.inferences"),
                "openQuestions": _require_string_list(entry.get("openQuestions", []), "sourceFindings.openQuestions"),
            }
        )

    changes = data.get("changes", [])
    if not isinstance(changes, list):
        raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "changes 必须是数组")
    if len(changes) > MAX_FILE_CHANGES:
        raise KnowledgeProposalError(
            "KNOWLEDGE_INPUT_LIMIT_EXCEEDED",
            f"变更文件数超过 {MAX_FILE_CHANGES} 上限",
            status=413,
        )
    total_bytes = 0
    normalized_changes: list[dict] = []
    for index, item in enumerate(changes):
        entry = _require_mapping(item, "changes 元素")
        unknown = set(entry) - ALLOWED_CHANGE_FIELDS
        if unknown:
            raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", f"changes 元素未知字段 {sorted(unknown)}")
        path = _validated_path(entry["path"], "changes.path")
        operation = entry.get("operation")
        if operation not in OPERATIONS:
            raise KnowledgeProposalError(
                "KNOWLEDGE_AGENT_OUTPUT_INVALID",
                f"不支持的变更操作: {operation}（首期仅 CREATE/UPDATE）",
            )
        category = entry.get("category")
        if category not in FILE_CATEGORIES:
            raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", f"changes.category 无效: {category}")
        reason = entry.get("reason", "")
        if not isinstance(reason, str) or not reason:
            raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "changes.reason 不能为空")
        source_artifact_ids = _require_string_list(entry.get("sourceArtifactIds", []), "changes.sourceArtifactIds")
        if not source_artifact_ids:
            raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "每项变更必须引用至少一个来源 Artifact")
        content = entry.get("content")
        if not isinstance(content, str):
            raise KnowledgeProposalError("KNOWLEDGE_AGENT_OUTPUT_INVALID", "changes.content 必须是字符串")
        content_bytes = content.encode("utf-8")
        if len(content_bytes) > MAX_FILE_BYTES:
            raise KnowledgeProposalError(
                "KNOWLEDGE_INPUT_LIMIT_EXCEEDED", f"单文件内容超过 2 MiB 上限: {path}", status=413
            )
        total_bytes += len(content_bytes)
        if total_bytes > MAX_TOTAL_BYTES:
            raise KnowledgeProposalError(
                "KNOWLEDGE_INPUT_LIMIT_EXCEEDED", "总 proposed content 超过 20 MiB 上限", status=413
            )
        warnings = _require_string_list(entry.get("warnings", []), "changes.warnings")
        content_uri = write_analysis_output(
            analysis_root, f"proposal-content-{index:03d}.md", content
        )
        normalized_changes.append(
            {
                "path": path,
                "operation": operation,
                "reason": reason,
                "category": category,
                "sourceArtifactIds": source_artifact_ids,
                "contentUri": str(content_uri),
                "proposedHash": hashlib.sha256(content_bytes).hexdigest(),
                "warnings": warnings,
            }
        )

    return {
        "version": 1,
        "summary": data.get("summary", ""),
        "rulesUsed": normalized_rules,
        "sourceFindings": normalized_findings,
        "changes": normalized_changes,
        "suggestedValidation": _require_string_list(data.get("suggestedValidation", []), "suggestedValidation"),
        "blockedReasons": _require_string_list(data.get("blockedReasons", []), "blockedReasons"),
    }


def has_credential_like_content(text: str) -> bool:
    return any(pattern.search(text) for pattern in CREDENTIAL_PATTERNS)


def _path_matches_any(patterns: list[str], path: str) -> bool:
    import fnmatch

    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def is_writable(path: str, writable_paths: list[str]) -> bool:
    if not writable_paths:
        return False
    return _path_matches_any(writable_paths, path)


def is_protected(path: str, protected_paths: list[str]) -> bool:
    return _path_matches_any(protected_paths, path)


def is_hard_protected(path: str, protected_paths: list[str]) -> bool:
    import fnmatch
    """系统级禁区（如 .git/**、.ai-workflow/**），任何变更一律 BLOCKED。

    规则：保护模式以点目录开头视为硬禁区；普通保护文件（如 INDEX.md、
    template/**）属于“修改必须人工审核”，应走 HIGH 由人批准，而非直接阻断。
    """
    return any(
        fnmatch.fnmatch(path, pattern) and pattern.split("/", 1)[0].startswith(".")
        for pattern in protected_paths
    )


def classify_risk(
    *,
    changes: list[dict],
    snapshot: dict,
    validation_results: list[dict],
) -> tuple[str, list[str]]:
    """Pure risk classification (document section 29.3)."""
    reasons: list[str] = []
    writable = snapshot.get("writablePaths") or []
    protected = snapshot.get("protectedPaths") or []
    if any(change["operation"] not in OPERATIONS for change in changes):
        return "BLOCKED", ["unsupported file operation"]
    if any(
        not is_writable(change["path"], writable) and not is_protected(change["path"], protected)
        for change in changes
    ):
        return "BLOCKED", ["path outside writable paths"]
    if any(is_hard_protected(change["path"], protected) for change in changes):
        return "BLOCKED", ["protected path"]
    if snapshot.get("openQuestions") or changes and any(
        change.get("blockedReasons") for change in changes
    ):
        return "BLOCKED", ["unresolved questions or agent blockers"]
    if any(result.get("status") == "FAILED" for result in validation_results):
        return "BLOCKED", ["validation failed"]
    if any(change["category"] in {"RULE", "ROUTING", "TEMPLATE", "INDEX"} for change in changes):
        return "HIGH", ["rules, routing, index, or templates changed"]
    if any(change["operation"] == "UPDATE" for change in changes):
        return "MEDIUM", ["existing knowledge changed"]
    return "LOW", reasons


def run_builtin_validations(
    *,
    proposal: dict,
    snapshot: dict,
    artifact_hashes: dict[str, str],
    repository_root: Path,
    now: str,
) -> list[dict]:
    """Run the built-in validators from document section 29.4.

    `artifact_hashes` maps artifactId -> verified content hash from the Run
    artifacts; `repository_root` is used to verify UPDATE before-hashes.
    """
    results: list[dict] = []

    def record(validator_id: str, status: str, summary: str, evidence_uri: str | None = None, evidence_hash: str | None = None) -> None:
        results.append(
            {
                "validatorId": validator_id,
                "validatorType": "builtin",
                "status": status,
                "summary": summary,
                "evidenceUri": evidence_uri,
                "evidenceHash": evidence_hash,
            }
        )

    # 1. Schema and path validation are enforced by parse_proposal before this runs.
    record("schema", "PASSED", "JSON Schema 与路径校验通过")

    # 2. UTF-8, size and markdown string checks (size enforced during parse).
    credential_issue: str | None = None
    for change in proposal["changes"]:
        content = read_change_content(change)
        if has_credential_like_content(content):
            credential_issue = change["path"]
            break
    if credential_issue is not None:
        record("credentials", "FAILED", f"检测到疑似凭据内容: {credential_issue}")
    else:
        record("credentials", "PASSED", "未检测到明显凭据模式")

    # 3. Source artifacts exist and hashes match.
    missing = [
        artifact_id
        for change in proposal["changes"]
        for artifact_id in change["sourceArtifactIds"]
        if artifact_id not in artifact_hashes
    ]
    if missing:
        record("artifact", "FAILED", f"来源 Artifact 缺失或哈希不一致: {sorted(set(missing))}")
    else:
        record("artifact", "PASSED", "来源 Artifact 均存在且哈希一致")

    # 4. UPDATE before-hash matches current working tree.
    changed: list[str] = []
    for change in proposal["changes"]:
        if change["operation"] != "UPDATE":
            continue
        path = repository_root / change["path"]
        if not path.is_file():
            changed.append(f"{change['path']}（不存在）")
            continue
        current = hashlib.sha256(path.read_bytes()).hexdigest()
        expected = change.get("beforeHash")
        if expected is not None and current != expected:
            changed.append(change["path"])
    if changed:
        record("before-hash", "FAILED", f"基线文件哈希已变化: {changed}")
    else:
        record("before-hash", "PASSED", "UPDATE 基线哈希一致")

    # 5. Writable/protected path checks are enforced by classify_risk.

    # 7. Limits are enforced during parse.

    return results


def read_change_content(change: dict) -> str:
    """Read persisted proposed content from the output URI."""
    path = Path(change["contentUri"])
    return path.read_text(encoding="utf-8")


def attach_before_hashes(proposal: dict, repository_root: Path) -> None:
    """Compute beforeHash for UPDATE changes from the current working tree."""
    root = repository_root.resolve()
    for change in proposal["changes"]:
        if change["operation"] == "UPDATE":
            path = root / change["path"]
            if path.is_file():
                change["beforeHash"] = hashlib.sha256(path.read_bytes()).hexdigest()
            else:
                change["beforeHash"] = None


def generate_unified_diff(
    *, repository_root: Path, changes: list[dict], target_dir: Path | None = None
) -> str:
    """Generate a unified diff for the proposed changes."""
    import difflib

    diff_parts: list[str] = []
    for change in changes:
        relative = change["path"]
        old_text: str = ""
        source = repository_root / relative
        if change["operation"] == "UPDATE" and source.is_file():
            old_text = source.read_text(encoding="utf-8")
        new_text = read_change_content(change)
        old_lines = old_text.splitlines(keepends=True)
        new_lines = new_text.splitlines(keepends=True)
        diff = "".join(
            difflib.unified_diff(
                old_lines,
                new_lines,
                fromfile=f"a/{relative}",
                tofile=f"b/{relative}",
                lineterm="",
            )
        )
        if diff:
            diff_parts.append(diff)
        else:
            diff_parts.append(f"--- a/{relative}\n+++ b/{relative}\n（无内容差异）\n")
    return "\n".join(diff_parts)
