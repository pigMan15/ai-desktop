from __future__ import annotations

from collections.abc import Sequence


AUTHORIZED_GATE_ACTORS = frozenset({"verifier", "system"})


def validate_gate_decision(
    *,
    actor: str,
    evidence: Sequence[str] | None,
    waiver_reason: str | None,
) -> None:
    if actor not in AUTHORIZED_GATE_ACTORS:
        raise ValueError("gate decisions allow only verifier or system actors")

    has_evidence = any(item.strip() for item in evidence or [])
    has_waiver = bool(waiver_reason and waiver_reason.strip())

    if not has_evidence and not has_waiver:
        raise ValueError("gate decision requires evidence or a non-empty waiver reason")
