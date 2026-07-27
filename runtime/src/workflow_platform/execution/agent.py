from typing import Any, Protocol
from uuid import uuid4


AgentResult = dict[str, Any]


class AgentExecutor(Protocol):
    def start(
        self,
        *,
        project_id: str,
        run_id: str,
        node_id: str,
        agent: str,
        input: dict[str, Any],
    ) -> AgentResult: ...

    def resume(self, *, handle: AgentResult, input: dict[str, Any]) -> AgentResult: ...

    def stop(self, *, handle: AgentResult) -> None: ...


class DefaultAgentExecutor:
    def start(
        self,
        *,
        project_id: str,
        run_id: str,
        node_id: str,
        agent: str,
        input: dict[str, Any],
    ) -> AgentResult:
        return {
            "project_id": project_id,
            "run_id": run_id,
            "node_id": node_id,
            "agent": agent,
            "checkpoint": str(uuid4()),
            "status": "interrupted",
        }

    def resume(self, *, handle: AgentResult, input: dict[str, Any]) -> AgentResult:
        return {
            "project_id": handle.get("project_id"),
            "run_id": handle.get("run_id"),
            "node_id": handle.get("node_id"),
            "agent": handle.get("agent"),
            "checkpoint": handle["checkpoint"],
            "status": "completed",
        }

    def stop(self, *, handle: AgentResult) -> None:
        return None
