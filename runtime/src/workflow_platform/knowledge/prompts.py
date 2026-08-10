"""Knowledge Agent prompts (document section 28.3).

Prompts follow a fixed paragraph order. The analysis copy manifest is embedded
as JSON so no user text is ever spliced into a shell command.
"""
from __future__ import annotations

import json
from typing import Any

ROLE_RULE_DISCOVERY = "你是知识库规则发现 Agent。你只分析，不直接修改目标仓库。"
ROLE_CHANGE_SET = "你是知识库维护 Agent。你只分析，不直接修改目标仓库。"

AUTHORITY = "规则文件决定目标仓库组织方式；当前 Artifact 是本次输入；代码/正式产物是实现事实。"
BOUNDARIES = "只能读取 input/；只能写 output/；禁止删除、重命名、Git、网络和凭据访问。"
TASK_RULE_DISCOVERY = "根据输入完成规则发现报告。"
TASK_CHANGE_SET = "根据输入生成知识变更提案。"
REQUIRED_REASONING = "分开输出事实、推断、未确定项；每项变更必须引用 Artifact；遇到冲突必须阻断。"
OUTPUT_RULE_DISCOVERY = "严格按给定 JSON Schema 写入 output/rule-discovery.json；stdout 仅输出进度。"
OUTPUT_CHANGE_SET = "严格按给定 JSON Schema 写入 output/proposal.json；stdout 仅输出进度。"


def _manifest_block(manifest: dict | None) -> str:
    if not manifest:
        return "（无输入清单）"
    return json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True)


def _artifact_block(artifact_summaries: list[dict], delivery: str) -> str:
    lines: list[str] = []
    for item in artifact_summaries:
        lines.append(
            f"- {item.get('artifactId', '?')} 类型={item.get('type', '?')} "
            f"路径={item.get('path', '?')} 哈希={item.get('contentHash', '?')}"
        )
        summary = item.get("summary")
        if summary is not None and delivery in {"hybrid", "summary"}:
            lines.append(f"  摘要：{summary}")
        elif delivery in {"path", "hybrid"}:
            lines.append("  位置：分析副本 input/artifacts/，请按需读取。")
    return "\n".join(lines) if lines else "（无选中 Artifact）"


def build_rule_discovery_prompt(
    *,
    manifest: dict | None,
    scan_summary: dict,
    delivery: str = "path",
) -> str:
    sections = [
        "ROLE",
        "  " + ROLE_RULE_DISCOVERY,
        "AUTHORITY",
        "  " + AUTHORITY,
        "BOUNDARIES",
        "  " + BOUNDARIES,
        "TASK",
        "  " + TASK_RULE_DISCOVERY,
        "REQUIRED_REASONING",
        "  " + REQUIRED_REASONING,
        "OUTPUT",
        "  " + OUTPUT_RULE_DISCOVERY,
        "INPUT_MANIFEST",
        _manifest_block(manifest),
        "SCAN_SUMMARY",
        json.dumps(scan_summary, ensure_ascii=False, indent=2, sort_keys=True),
    ]
    return "\n".join(sections)


def build_change_set_prompt(
    *,
    manifest: dict | None,
    snapshot_summary: dict,
    artifact_summaries: list[dict],
    existing_knowledge_summaries: list[dict],
    delivery: str = "path",
) -> str:
    sections = [
        "ROLE",
        "  " + ROLE_CHANGE_SET,
        "AUTHORITY",
        "  " + AUTHORITY,
        "BOUNDARIES",
        "  " + BOUNDARIES,
        "TASK",
        "  " + TASK_CHANGE_SET,
        "REQUIRED_REASONING",
        "  " + REQUIRED_REASONING,
        "OUTPUT",
        "  " + OUTPUT_CHANGE_SET,
        "INPUT_MANIFEST",
        _manifest_block(manifest),
        "RULE_SNAPSHOT",
        json.dumps(snapshot_summary, ensure_ascii=False, indent=2, sort_keys=True),
        "ARTIFACTS",
        _artifact_block(artifact_summaries, delivery),
        "EXISTING_KNOWLEDGE",
        json.dumps(existing_knowledge_summaries, ensure_ascii=False, indent=2, sort_keys=True),
    ]
    return "\n".join(sections)


def prompt_hash(prompt: str) -> str:
    import hashlib

    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()
