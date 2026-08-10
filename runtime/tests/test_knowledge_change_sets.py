import json
from pathlib import Path

import pytest

from workflow_platform.knowledge.proposal import (
    KnowledgeProposalError,
    attach_before_hashes,
    classify_risk,
    generate_unified_diff,
    has_credential_like_content,
    parse_proposal,
    run_builtin_validations,
    validate_rule_discovery_output,
)
from workflow_platform.knowledge.prompts import (
    build_change_set_prompt,
    build_rule_discovery_prompt,
    prompt_hash,
)


def _snapshot(writable=None, protected=None, open_questions=None):
    return {
        "writablePaths": writable if writable is not None else ["candidate/**", "main/**"],
        "protectedPaths": protected if protected is not None else [".git/**", ".ai-workflow/**"],
        "openQuestions": open_questions if open_questions is not None else [],
    }


def _changes(*specs):
    return [
        {
            "path": spec.get("path", "candidate/new.md"),
            "operation": spec.get("operation", "CREATE"),
            "category": spec.get("category", "KNOWLEDGE"),
            "sourceArtifactIds": ["artifact-1"],
        }
        for spec in specs
    ]


def test_risk_matrix_low_medium_high_blocked() -> None:
    assert classify_risk(changes=_changes(), snapshot=_snapshot(), validation_results=[]) == (
        "LOW",
        [],
    )
    assert classify_risk(
        changes=_changes({"operation": "UPDATE"}), snapshot=_snapshot(), validation_results=[]
    ) == ("MEDIUM", ["existing knowledge changed"])
    assert classify_risk(
        changes=_changes({"category": "RULE"}), snapshot=_snapshot(), validation_results=[]
    ) == ("HIGH", ["rules, routing, index, or templates changed"])
    assert classify_risk(
        changes=_changes({"category": "INDEX"}), snapshot=_snapshot(), validation_results=[]
    )[0] == "HIGH"
    assert classify_risk(
        changes=_changes({"path": "main/secret.md"}),
        snapshot=_snapshot(writable=["candidate/**"]),
        validation_results=[],
    )[0] == "BLOCKED"
    assert classify_risk(
        changes=_changes({"path": ".git/config"}),
        snapshot=_snapshot(),
        validation_results=[],
    )[0] == "BLOCKED"
    assert classify_risk(
        changes=_changes(),
        snapshot=_snapshot(open_questions=["规则冲突"]),
        validation_results=[],
    )[0] == "BLOCKED"
    assert classify_risk(
        changes=_changes(),
        snapshot=_snapshot(),
        validation_results=[{"status": "FAILED", "validatorId": "x"}],
    )[0] == "BLOCKED"

    # 受保护但可人工审核的索引/模板文件：应判定 HIGH（人工审核），而不是 BLOCKED
    assert classify_risk(
        changes=_changes({"path": "INDEX.md", "category": "INDEX"}),
        snapshot=_snapshot(
            writable=["main/**", "applications/**", "candidate/**", "personal/**"],
            protected=[".git/**", ".github/**", ".ai-workflow/**", "INDEX.md", "ROUTING.md", "template/**", "applications/_template/**"],
        ),
        validation_results=[],
    ) == ("HIGH", ["rules, routing, index, or templates changed"])
    assert classify_risk(
        changes=_changes({"path": "applications/_template/application.md", "category": "TEMPLATE"}),
        snapshot=_snapshot(
            writable=["main/**", "applications/**", "candidate/**", "personal/**"],
            protected=[".git/**", ".github/**", ".ai-workflow/**", "INDEX.md", "template/**", "applications/_template/**"],
        ),
        validation_results=[],
    ) == ("HIGH", ["rules, routing, index, or templates changed"])
    # 系统级禁区仍然 BLOCKED
    assert classify_risk(
        changes=_changes({"path": ".ai-workflow/knowledge-repo.yaml"}),
        snapshot=_snapshot(
            writable=["main/**", "applications/**", "candidate/**", "personal/**"],
            protected=[".git/**", ".github/**", ".ai-workflow/**", "INDEX.md"],
        ),
        validation_results=[],
    )[0] == "BLOCKED"


def test_parse_proposal_persists_content(tmp_path: Path) -> None:
    analysis = tmp_path / "analysis"
    (analysis / "output").mkdir(parents=True)
    proposal = parse_proposal(
        {
            "version": 1,
            "summary": "add order flow",
            "rulesUsed": [{"path": "KNOWLEDGE-RULES.md", "sha256": "a" * 64, "purpose": "rules"}],
            "sourceFindings": [{"artifactId": "artifact-1", "facts": [], "inferences": [], "openQuestions": []}],
            "changes": [
                {
                    "path": "candidate/order-flow.md",
                    "operation": "CREATE",
                    "reason": "记录创单流程",
                    "category": "KNOWLEDGE",
                    "sourceArtifactIds": ["artifact-1"],
                    "content": "# 创单流程\n",
                    "warnings": [],
                }
            ],
            "suggestedValidation": [],
            "blockedReasons": [],
        },
        analysis,
        now="2026-08-10T00:00:00Z",
    )
    assert proposal["changes"][0]["proposedHash"]
    content_uri = Path(proposal["changes"][0]["contentUri"])
    assert content_uri.is_file()
    assert content_uri.read_text(encoding="utf-8") == "# 创单流程\n"


def test_parse_proposal_rejects_unsafe_operations_and_paths(tmp_path: Path) -> None:
    analysis = tmp_path / "analysis"
    (analysis / "output").mkdir(parents=True)
    base = {
        "version": 1,
        "summary": "x",
        "rulesUsed": [],
        "sourceFindings": [],
        "changes": [],
        "suggestedValidation": [],
        "blockedReasons": [],
    }
    with pytest.raises(KnowledgeProposalError) as exc:
        parse_proposal({**base, "changes": [{"path": "../x.md", "operation": "CREATE", "reason": "r", "category": "KNOWLEDGE", "sourceArtifactIds": ["a"], "content": "x"}]}, analysis, now="t")
    assert "路径无效" in exc.value.message
    with pytest.raises(KnowledgeProposalError) as exc:
        parse_proposal({**base, "changes": [{"path": "x.md", "operation": "DELETE", "reason": "r", "category": "KNOWLEDGE", "sourceArtifactIds": ["a"], "content": "x"}]}, analysis, now="t")
    assert "不支持的变更操作" in exc.value.message
    with pytest.raises(KnowledgeProposalError) as exc:
        parse_proposal({**base, "changes": [{"path": "x.md", "operation": "CREATE", "reason": "r", "category": "KNOWLEDGE", "sourceArtifactIds": [], "content": "x"}]}, analysis, now="t")
    assert "必须引用至少一个来源 Artifact" in exc.value.message


def test_parse_proposal_rejects_unknown_fields_and_size_limit(tmp_path: Path) -> None:
    analysis = tmp_path / "analysis"
    (analysis / "output").mkdir(parents=True)
    with pytest.raises(KnowledgeProposalError):
        parse_proposal({"version": 1, "unexpected": True}, analysis, now="t")
    base = {
        "version": 1,
        "summary": "x",
        "rulesUsed": [],
        "sourceFindings": [],
        "changes": [{"path": "x.md", "operation": "CREATE", "reason": "r", "category": "KNOWLEDGE", "sourceArtifactIds": ["a"], "content": "y" * (2 * 1024 * 1024 + 1)}],
        "suggestedValidation": [],
        "blockedReasons": [],
    }
    with pytest.raises(KnowledgeProposalError) as exc:
        parse_proposal(base, analysis, now="t")
    assert exc.value.status == 413


def test_validate_rule_discovery_output(tmp_path: Path) -> None:
    payload = {
        "version": 1,
        "summary": "rules",
        "ruleFiles": [{"path": "KNOWLEDGE-RULES.md", "category": "RULE", "purpose": "main"}],
        "indexFiles": ["INDEX.md"],
        "routingFiles": ["ROUTING.md"],
        "templateFiles": ["template/knowledge-entry.md"],
        "suggestedWritablePaths": ["main/**"],
        "suggestedProtectedPaths": [".git/**"],
        "suggestedValidationCommands": [],
        "findings": ["f"],
        "openQuestions": [],
        "conflicts": [],
    }
    normalized = validate_rule_discovery_output(payload)
    assert normalized["version"] == 1
    assert normalized["ruleFiles"][0]["category"] == "RULE"
    with_questions = validate_rule_discovery_output({**payload, "openQuestions": ["?"], "conflicts": ["!"]})
    assert with_questions["openQuestions"] == ["?"]
    assert with_questions["conflicts"] == ["!"]


def test_builtin_validations_credentials_and_before_hash(tmp_path: Path) -> None:
    analysis = tmp_path / "analysis"
    (analysis / "output").mkdir(parents=True)
    (tmp_path / "main").mkdir()
    (tmp_path / "main" / "existing.md").write_text("# old\n", encoding="utf-8")
    repo = tmp_path
    proposal = parse_proposal(
        {
            "version": 1,
            "summary": "x",
            "rulesUsed": [],
            "sourceFindings": [],
            "changes": [
                {
                    "path": "main/existing.md",
                    "operation": "UPDATE",
                    "reason": "r",
                    "category": "KNOWLEDGE",
                    "sourceArtifactIds": ["artifact-1"],
                    "content": "# new\n",
                    "warnings": [],
                }
            ],
            "suggestedValidation": [],
            "blockedReasons": [],
        },
        analysis,
        now="2026-08-10T00:00:00Z",
    )
    attach_before_hashes(proposal, repo)
    results = run_builtin_validations(
        proposal=proposal,
        snapshot=_snapshot(writable=["main/**"]),
        artifact_hashes={"artifact-1": "h"},
        repository_root=repo,
        now="2026-08-10T00:00:00Z",
    )
    statuses = {r["validatorId"]: r["status"] for r in results}
    assert statuses["before-hash"] == "PASSED"
    assert statuses["credentials"] == "PASSED"

    credential_proposal = parse_proposal(
        {
            "version": 1,
            "summary": "x",
            "rulesUsed": [],
            "sourceFindings": [],
            "changes": [
                {
                    "path": "candidate/leak.md",
                    "operation": "CREATE",
                    "reason": "r",
                    "category": "KNOWLEDGE",
                    "sourceArtifactIds": ["artifact-1"],
                    "content": "password=secret123\n",
                    "warnings": [],
                }
            ],
            "suggestedValidation": [],
            "blockedReasons": [],
        },
        analysis,
        now="2026-08-10T00:00:00Z",
    )
    results = run_builtin_validations(
        proposal=credential_proposal,
        snapshot=_snapshot(),
        artifact_hashes={"artifact-1": "h"},
        repository_root=repo,
        now="2026-08-10T00:00:00Z",
    )
    statuses = {r["validatorId"]: r["status"] for r in results}
    assert statuses["credentials"] == "FAILED"


def test_has_credential_like_content() -> None:
    assert has_credential_like_content("AKIAABCDEFGHIJKLMNOP")
    assert has_credential_like_content("-----BEGIN RSA PRIVATE KEY-----")
    assert has_credential_like_content("password=secret")
    assert not has_credential_like_content("普通知识内容")


def test_prompt_fixed_order_and_delivery(tmp_path: Path) -> None:
    prompt = build_rule_discovery_prompt(
        manifest=None,
        scan_summary={"count": 1, "files": []},
        delivery="path",
    )
    order = [prompt.index("ROLE"), prompt.index("AUTHORITY"), prompt.index("BOUNDARIES"), prompt.index("TASK"), prompt.index("REQUIRED_REASONING"), prompt.index("OUTPUT")]
    assert order == sorted(order)
    assert "只能读取 input/；只能写 output/" in prompt
    assert prompt_hash(prompt) == prompt_hash(prompt)

    change_prompt = build_change_set_prompt(
        manifest={"kind": "x"},
        snapshot_summary={"id": "s1"},
        artifact_summaries=[
            {"artifactId": "a1", "type": "markdown", "path": "input/artifacts/a1.md", "contentHash": "h", "summary": None}
        ],
        existing_knowledge_summaries=[],
        delivery="path",
    )
    assert "请按需读取" in change_prompt
    assert "摘要：" not in change_prompt


def test_generate_unified_diff(tmp_path: Path) -> None:
    analysis = tmp_path / "analysis"
    (analysis / "output").mkdir(parents=True)
    (tmp_path / "main").mkdir()
    (tmp_path / "main" / "x.md").write_text("a\n", encoding="utf-8")
    proposal = parse_proposal(
        {
            "version": 1,
            "summary": "x",
            "rulesUsed": [],
            "sourceFindings": [],
            "changes": [
                {
                    "path": "main/x.md",
                    "operation": "UPDATE",
                    "reason": "r",
                    "category": "KNOWLEDGE",
                    "sourceArtifactIds": ["artifact-1"],
                    "content": "b\n",
                    "warnings": [],
                }
            ],
            "suggestedValidation": [],
            "blockedReasons": [],
        },
        analysis,
        now="2026-08-10T00:00:00Z",
    )
    diff = generate_unified_diff(repository_root=tmp_path, changes=proposal["changes"])
    assert "a/main/x.md" in diff
    assert "b/main/x.md" in diff
    assert "-a" in diff
    assert "+b" in diff
