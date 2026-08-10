"""Knowledge repository Python enums and normalization helpers (document 24.2).

These constants mirror `packages/contracts/src/knowledge.ts` so Runtime code can
share the same stable vocabulary without importing TypeScript.
"""
from __future__ import annotations

from typing import Any

KNOWLEDGE_REPOSITORY_STATUSES = ("ACTIVE", "RULES_PENDING", "BLOCKED", "REMOVED")
KNOWLEDGE_RULE_SNAPSHOT_STATUSES = ("PROPOSED", "CONFIRMED", "SUPERSEDED", "STALE")
KNOWLEDGE_CHANGE_SET_STATUSES = (
    "DRAFT",
    "GENERATING",
    "VALIDATING",
    "READY_TO_APPLY",
    "AWAITING_APPROVAL",
    "APPROVED",
    "APPLYING",
    "APPLIED",
    "PARTIALLY_STAGED",
    "STAGED",
    "COMMITTED",
    "STALE",
    "BLOCKED",
    "FAILED",
    "ABANDONED",
)
KNOWLEDGE_RISK_LEVELS = ("LOW", "MEDIUM", "HIGH", "BLOCKED")
KNOWLEDGE_FILE_OPERATIONS = ("CREATE", "UPDATE")
KNOWLEDGE_FILE_CATEGORIES = ("KNOWLEDGE", "INDEX", "ROUTING", "RULE", "TEMPLATE")
KNOWLEDGE_RULE_FILE_CATEGORIES = ("RULE", "INDEX", "ROUTING", "TEMPLATE", "REFERENCE")
KNOWLEDGE_PROVIDERS = ("codex", "claude", "fake")
KNOWLEDGE_CHANGE_SET_MODES = ("preview", "risk-based")
KNOWLEDGE_EXAMPLE_MODES = ("complete", "template")

KNOWLEDGE_REPOSITORY_STATUS_SET = frozenset(KNOWLEDGE_REPOSITORY_STATUSES)
KNOWLEDGE_RULE_SNAPSHOT_STATUS_SET = frozenset(KNOWLEDGE_RULE_SNAPSHOT_STATUSES)
KNOWLEDGE_CHANGE_SET_STATUS_SET = frozenset(KNOWLEDGE_CHANGE_SET_STATUSES)
KNOWLEDGE_RISK_LEVEL_SET = frozenset(KNOWLEDGE_RISK_LEVELS)
KNOWLEDGE_FILE_OPERATION_SET = frozenset(KNOWLEDGE_FILE_OPERATIONS)
KNOWLEDGE_FILE_CATEGORY_SET = frozenset(KNOWLEDGE_FILE_CATEGORIES)
KNOWLEDGE_RULE_FILE_CATEGORY_SET = frozenset(KNOWLEDGE_RULE_FILE_CATEGORIES)
KNOWLEDGE_PROVIDER_SET = frozenset(KNOWLEDGE_PROVIDERS)
KNOWLEDGE_CHANGE_SET_MODE_SET = frozenset(KNOWLEDGE_CHANGE_SET_MODES)
KNOWLEDGE_EXAMPLE_MODE_SET = frozenset(KNOWLEDGE_EXAMPLE_MODES)

KNOWLEDGE_PURPOSES = ("knowledge-rule-discovery", "knowledge-change-set-generation")
KNOWLEDGE_PURPOSE_SET = frozenset(KNOWLEDGE_PURPOSES)


def require_enum(value: Any, allowed: frozenset[str], label: str) -> str:
    if value not in allowed:
        raise ValueError(f"{label} 无效: {value}")
    return value
