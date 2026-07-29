from __future__ import annotations

from collections.abc import Iterable

from pydantic import ValidationError

from workflow_platform.models import Actor


def require_trusted_actor(
    raw_actor: dict,
    *,
    allowed_types: Iterable[str] | None = None,
) -> Actor:
    try:
        actor = Actor.model_validate(raw_actor)
    except ValidationError as error:
        raise ValueError("ACTOR_INVALID: 操作者身份信息无效。") from error

    if not actor.id.strip():
        raise ValueError("ACTOR_INVALID: 操作者标识不能为空。")
    if not actor.trusted:
        raise ValueError("ACTOR_NOT_TRUSTED: 当前操作需要可信操作者。")

    allowed = set(allowed_types or ())
    if allowed and actor.type not in allowed:
        raise ValueError("ACTOR_PERMISSION_DENIED: 当前操作者无权执行此操作。")
    return actor


def require_trusted_human(raw_actor: dict, *, operation: str) -> Actor:
    actor = require_trusted_actor(raw_actor)
    if actor.type != "human":
        raise ValueError(f"ACTOR_PERMISSION_DENIED: 只有可信人工操作者可以{operation}。")
    return actor
