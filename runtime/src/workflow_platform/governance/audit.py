from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4


class AuditLog:
    def __init__(self) -> None:
        self._records: list[dict[str, Any]] = []

    def record(
        self,
        *,
        actor_id: str,
        action: str,
        resource: str,
        detail: dict[str, Any],
    ) -> dict[str, Any]:
        record = {
            "id": str(uuid4()),
            "actorId": actor_id,
            "action": action,
            "resource": resource,
            "detail": dict(detail),
            "createdAt": datetime.now(UTC).isoformat(),
        }
        self._records.append(record)
        return dict(record)

    def list(self, *, actor_id: str | None = None) -> list[dict[str, Any]]:
        return [
            dict(record)
            for record in self._records
            if actor_id is None or record["actorId"] == actor_id
        ]
