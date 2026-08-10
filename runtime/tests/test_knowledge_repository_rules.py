import json
from pathlib import Path

import pytest

from workflow_platform.knowledge.rule_discovery import (
    KnowledgeRuleDiscoveryError,
    build_rule_discovery_analysis,
    deterministic_scan,
    parse_knowledge_repo_manifest,
    reread_rule_files,
    snapshot_content_hash,
    write_analysis_output,
)


def test_parse_manifest_accepts_valid_content(tmp_path: Path) -> None:
    manifest_text = """
version: 1
rules:
  - KNOWLEDGE-RULES.md
routing:
  - ROUTING.md
indexes:
  - INDEX.md
templates:
  - template/**/*.md
writablePaths:
  - main/**
protectedPaths:
  - .git/**
validation:
  commands: []
"""
    manifest = parse_knowledge_repo_manifest(manifest_text, tmp_path)
    assert manifest["rules"] == ["KNOWLEDGE-RULES.md"]
    assert manifest["writablePaths"] == ["main/**"]
    assert manifest["validationCommands"] == []


def test_parse_manifest_rejects_unknown_fields(tmp_path: Path) -> None:
    with pytest.raises(KnowledgeRuleDiscoveryError) as exc:
        parse_knowledge_repo_manifest("version: 1\nunexpected: true\n", tmp_path)
    assert exc.value.code == "KNOWLEDGE_INPUT_INVALID"


def test_parse_manifest_rejects_unsafe_paths(tmp_path: Path) -> None:
    for bad in ('rules:\n  - "/etc/x"\n', 'rules:\n  - "C:/x"\n', 'rules:\n  - "../x"\n', 'rules:\n  - "a/../b"\n'):
        with pytest.raises(KnowledgeRuleDiscoveryError):
            parse_knowledge_repo_manifest(bad, tmp_path)


def test_parse_manifest_rejects_invalid_commands(tmp_path: Path) -> None:
    with pytest.raises(KnowledgeRuleDiscoveryError):
        parse_knowledge_repo_manifest("validation:\n  commands:\n    - 'cmd\\nother'\n", tmp_path)


def test_deterministic_scan_finds_entries_sorted_and_ignores_ignored_dirs(tmp_path: Path) -> None:
    (tmp_path / "INDEX.md").write_text("# Index\n", encoding="utf-8")
    (tmp_path / "ROUTING.md").write_text("# Routing\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "pkg.md").write_text("x", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("x", encoding="utf-8")
    (tmp_path / "binary.png").write_bytes(b"\x89PNG")
    result = deterministic_scan(tmp_path)
    assert result["count"] == 2
    assert [f["path"] for f in result["files"]] == ["INDEX.md", "ROUTING.md"]
    assert all(f["sizeBytes"] > 0 for f in result["files"])
    assert len(result["files"][0]["sha256"]) == 64


def test_deterministic_scan_respects_depth_and_file_limits(tmp_path: Path) -> None:
    deep = tmp_path / "a" / "b" / "c" / "d" / "e"
    deep.mkdir(parents=True)
    (deep / "README.md").write_text("deep", encoding="utf-8")
    result = deterministic_scan(tmp_path)
    assert result["count"] == 0  # depth 5 > max depth 4


def test_analysis_copy_contains_targets_and_manifest(tmp_path: Path) -> None:
    (tmp_path / "INDEX.md").write_text("# Index\n", encoding="utf-8")
    scan = deterministic_scan(tmp_path)
    analysis = tmp_path / "jobs" / "job-1"
    manifest = build_rule_discovery_analysis(
        analysis, tmp_path, scan, now="2026-08-10T00:00:00Z"
    )
    assert manifest["kind"] == "rule-discovery"
    assert (analysis / "input" / "target" / "INDEX.md").read_text(encoding="utf-8") == "# Index\n"
    assert (analysis / "input" / "manifest.json").exists()
    assert (analysis / "output").is_dir()
    assert (analysis / "logs").is_dir()


def test_snapshot_hash_is_stable_and_order_independent() -> None:
    first = snapshot_content_hash({"a": 1, "b": [2, 3]})
    second = snapshot_content_hash({"b": [2, 3], "a": 1})
    assert first == second
    assert len(first) == 64


def test_reread_rule_files_detects_change_and_missing(tmp_path: Path) -> None:
    (tmp_path / "INDEX.md").write_text("# v1\n", encoding="utf-8")
    discovered = [
        {"path": "INDEX.md", "hash": "0" * 64, "sizeBytes": 5},
    ]
    refreshed = reread_rule_files(tmp_path, discovered)
    assert refreshed[0]["status"] == "changed"
    (tmp_path / "INDEX.md").unlink()
    refreshed = reread_rule_files(tmp_path, discovered)
    assert refreshed[0]["status"] == "missing"


def test_write_analysis_output_rejects_escape(tmp_path: Path) -> None:
    analysis = tmp_path / "analysis"
    analysis.mkdir()
    (analysis / "output").mkdir()
    with pytest.raises(KnowledgeRuleDiscoveryError) as exc:
        write_analysis_output(analysis, "../escape.md", "x")
    assert exc.value.code == "KNOWLEDGE_PATH_OUTSIDE_REPOSITORY"
