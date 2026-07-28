from __future__ import annotations


TRUSTED_HUMAN_ACTOR = "trusted_human"


def validate_human_decision(actor: str) -> None:
    if actor != TRUSTED_HUMAN_ACTOR:
        raise ValueError("approval decisions allow only trusted human actors")
