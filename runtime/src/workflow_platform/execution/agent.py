from typing import Any, Literal, Protocol, TypedDict
from uuid import uuid4


class CheckpointRef(TypedDict):
    id: str
    provider: str


class ExecutionResult(TypedDict):
    status: Literal["interrupted", "completed"]
    messages: list[str]
    checkpoint: CheckpointRef


class ExecutionHandle(TypedDict):
    status: Literal["interrupted", "completed"]
    messages: list[str]
    checkpoint: CheckpointRef


class AgentExecutor(Protocol):
    def start(
        self,
        *,
        project_id: str,
        run_id: str,
        node_id: str,
        agent: str,
        input: dict[str, Any],
    ) -> ExecutionResult: ...

    def resume(self, *, handle: ExecutionHandle, input: dict[str, Any]) -> ExecutionResult: ...

    def stop(self, *, handle: ExecutionHandle) -> None: ...


class DefaultAgentExecutor:
    def start(
        self,
        *,
        project_id: str,
        run_id: str,
        node_id: str,
        agent: str,
        input: dict[str, Any],
    ) -> ExecutionResult:
        return {
            "status": "interrupted",
            "messages": [],
            "checkpoint": {
                "id": str(uuid4()),
                "provider": agent,
            },
        }

    def resume(self, *, handle: ExecutionHandle, input: dict[str, Any]) -> ExecutionResult:
        checkpoint = _require_checkpoint(handle)
        return {
            "status": "completed",
            "messages": [],
            "checkpoint": checkpoint,
        }

    def stop(self, *, handle: ExecutionHandle) -> None:
        return None


def _require_checkpoint(handle: ExecutionHandle) -> CheckpointRef:
    checkpoint = handle.get("checkpoint")
    if not isinstance(checkpoint, dict):
        raise ValueError("execution handle requires checkpoint")

    checkpoint_id = checkpoint.get("id")
    provider = checkpoint.get("provider")
    if not isinstance(checkpoint_id, str) or not checkpoint_id:
        raise ValueError("execution handle checkpoint requires id")
    if not isinstance(provider, str) or not provider:
        raise ValueError("execution handle checkpoint requires provider")

    return {"id": checkpoint_id, "provider": provider}
