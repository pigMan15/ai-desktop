from __future__ import annotations


def health() -> dict[str, str]:
    return {"status": "ok", "service": "workflow-runtime"}
