from __future__ import annotations

import json
from pathlib import Path
import signal
import sys
import time


cancelled = False


def _handle_signal(_signum: int, _frame: object) -> None:
    global cancelled
    cancelled = True


signal.signal(signal.SIGTERM, _handle_signal)


def emit(kind: str, text: str) -> None:
    print(json.dumps({"type": kind, "text": text}, ensure_ascii=False), flush=True)


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "complete"
    if mode == "complete":
        emit("message", "fake-cli: started")
        emit("final", "fake-cli: completed")
        return 0
    if mode == "message-only":
        emit("message", "fake-cli: message only")
        return 0
    if mode == "large":
        emit("message", "x" * 512)
        return 0
    if mode == "sleep":
        emit("message", "fake-cli: sleeping")
        for _ in range(50):
            if cancelled:
                emit("error", "fake-cli: cancelled")
                return 130
            time.sleep(0.1)
        emit("final", "fake-cli: woke")
        return 0
    if mode == "stream":
        emit("message", "fake-cli: first output")
        time.sleep(0.8)
        emit("final", "fake-cli: streamed completion")
        return 0
    if mode == "knowledge-rule-discovery":
        _write_rule_discovery(Path.cwd())
        emit("final", "fake-cli: rule discovery completed")
        return 0
    if mode in ("knowledge-valid-low", "knowledge-valid-high", "knowledge-invalid-outside"):
        _write_proposal(Path.cwd(), mode)
        emit("final", "fake-cli: proposal completed")
        return 0
    emit("error", "fake-cli: failed")
    return 2


def _write_rule_discovery(cwd: Path) -> None:
    output_dir = cwd / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "summary": "fake: 规则发现结果",
        "ruleFiles": [
            {"path": "KNOWLEDGE-RULES.md", "category": "RULE", "purpose": "权威规则"}
        ],
        "indexFiles": ["INDEX.md"],
        "routingFiles": ["ROUTING.md"],
        "templateFiles": [],
        "suggestedWritablePaths": ["candidate/**", "main/**"],
        "suggestedProtectedPaths": [".git/**", ".ai-workflow/**"],
        "suggestedValidationCommands": [],
        "findings": ["fake: 发现 README 与 KNOWLEDGE-RULES"],
        "openQuestions": [],
        "conflicts": [],
    }
    (output_dir / "rule-discovery.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _load_manifest(cwd: Path):
    manifest_path = cwd / "input" / "manifest.json"
    if manifest_path.exists():
        try:
            return json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
    return None


def _source_artifact_ids(cwd: Path) -> list[str]:
    manifest = _load_manifest(cwd)
    if manifest:
        ids = [
            entry["artifactId"]
            for entry in manifest.get("entries", [])
            if entry.get("source") == "artifact" and entry.get("artifactId")
        ]
        if ids:
            return ids
    return ["artifact-1"]


def _write_proposal(cwd: Path, mode: str) -> None:
    output_dir = cwd / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    artifact_ids = _source_artifact_ids(cwd)
    if mode == "knowledge-valid-low":
        changes = [
            {
                "path": "candidate/generated.md",
                "operation": "CREATE",
                "reason": "fake: 根据 Artifact 生成候选知识",
                "category": "KNOWLEDGE",
                "sourceArtifactIds": artifact_ids,
                "content": "# 生成的候选知识\n\n来自 artifact-1。\n",
                "warnings": [],
            }
        ]
    elif mode == "knowledge-valid-high":
        changes = [
            {
                "path": "INDEX.md",
                "operation": "UPDATE",
                "reason": "fake: 更新索引",
                "category": "INDEX",
                "sourceArtifactIds": artifact_ids,
                "content": "# 索引\n\n- 新增候选知识链接\n",
                "warnings": [],
            }
        ]
    else:
        changes = [
            {
                "path": "../outside.md",
                "operation": "CREATE",
                "reason": "fake: 越界",
                "category": "KNOWLEDGE",
                "sourceArtifactIds": artifact_ids,
                "content": "# 越界文件\n",
                "warnings": [],
            }
        ]
    payload = {
        "version": 1,
        "summary": "fake: 知识变更提案",
        "rulesUsed": [
            {"path": "KNOWLEDGE-RULES.md", "sha256": "0" * 64, "purpose": "rules"}
        ],
        "sourceFindings": [
            {
                "artifactId": "artifact-1",
                "facts": ["fake fact"],
                "inferences": [],
                "openQuestions": [],
            }
        ],
        "changes": changes,
        "suggestedValidation": [],
        "blockedReasons": [],
    }
    (output_dir / "proposal.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    raise SystemExit(main())
