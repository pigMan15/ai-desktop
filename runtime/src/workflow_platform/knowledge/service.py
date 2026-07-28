from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4


class LocalKnowledgeService:
    def __init__(self) -> None:
        self._candidates: dict[str, dict] = {}
        self._documents: dict[str, dict] = {}

    def create_candidate(self, *, title: str, content: str, source: str) -> dict:
        candidate = {
            "id": str(uuid4()),
            "title": title,
            "content": content,
            "source": source,
            "status": "pending",
            "reviewer": None,
            "createdAt": _now(),
        }
        self._candidates[candidate["id"]] = candidate
        return dict(candidate)

    def review(
        self,
        candidate_id: str,
        *,
        reviewer: str,
        decision: Literal["approved", "rejected"],
    ) -> dict:
        candidate = self._candidate(candidate_id)
        candidate["status"] = decision
        candidate["reviewer"] = reviewer
        candidate["reviewedAt"] = _now()
        return dict(candidate)

    def publish(self, candidate_id: str) -> dict:
        candidate = self._candidate(candidate_id)
        if candidate["status"] != "approved":
            raise ValueError("Knowledge candidate must be approved before publication")
        document = {
            "id": str(uuid4()),
            "candidateId": candidate_id,
            "title": candidate["title"],
            "content": candidate["content"],
            "source": candidate["source"],
            "status": "published",
            "publishedAt": _now(),
        }
        self._documents[document["id"]] = document
        return dict(document)

    def search(self, query: str) -> list[dict]:
        needle = query.casefold()
        return [
            dict(document)
            for document in self._documents.values()
            if needle in document["title"].casefold() or needle in document["content"].casefold()
        ]

    def _candidate(self, candidate_id: str) -> dict:
        try:
            return self._candidates[candidate_id]
        except KeyError as exc:
            raise KeyError(f"Knowledge candidate not found: {candidate_id}") from exc


def _now() -> str:
    return datetime.now(UTC).isoformat()
