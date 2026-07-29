from __future__ import annotations

import hashlib
import json
import sqlite3
from uuid import uuid4

from workflow_platform.governance.actors import require_trusted_actor
from workflow_platform.models import Actor
from workflow_platform.persistence.repositories import AuditRecordRepository


class AuditLog:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._records = AuditRecordRepository(db)

    def record(
        self,
        *,
        actor: Actor | dict,
        action: str,
        resource: str,
        detail: dict,
        created_at: str,
    ) -> dict:
        actor_model = require_trusted_actor(
            actor.model_dump() if isinstance(actor, Actor) else actor
        )
        previous_hash = self._records.latest_hash()
        record = {
            "id": str(uuid4()),
            "actor": actor_model.model_dump(),
            "action": action,
            "resource": resource,
            "detail": dict(detail),
            "previousHash": previous_hash,
            "createdAt": created_at,
        }
        record["recordHash"] = _hash_record(record)
        self._records.append(
            id=record["id"],
            actor=actor_model,
            action=action,
            resource=resource,
            detail=record["detail"],
            previous_hash=previous_hash,
            record_hash=record["recordHash"],
            created_at=created_at,
        )
        return dict(record)

    def list(
        self,
        *,
        actor_id: str | None = None,
        action: str | None = None,
        resource: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        return self._records.list(
            actor_id=actor_id,
            action=action,
            resource=resource,
            limit=limit,
        )


def _hash_record(record: dict) -> str:
    content = json.dumps(record, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()
