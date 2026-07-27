from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, TypedDict
from uuid import uuid4


TerminalKind = Literal["shell", "codex"]


class TerminalSession(TypedDict):
    id: str
    projectId: str
    runId: str
    nodeId: str
    kind: TerminalKind
    status: str
    cwd: str
    pid: int | None
    createdAt: str
    updatedAt: str


def create_terminal_session(
    *,
    project_id: str,
    run_id: str,
    node_id: str,
    kind: TerminalKind,
    cwd: str | Path,
    project_root: str | Path | None = None,
) -> TerminalSession:
    if kind not in {"shell", "codex"}:
        raise ValueError("terminal kind must be shell or codex")

    resolved_cwd = Path(cwd).resolve()
    if project_root is not None:
        resolved_root = Path(project_root).resolve()
        try:
            resolved_cwd.relative_to(resolved_root)
        except ValueError as exc:
            raise ValueError("terminal cwd must stay within project root") from exc

    now = datetime.now(UTC).isoformat()

    return {
        "id": str(uuid4()),
        "projectId": project_id,
        "runId": run_id,
        "nodeId": node_id,
        "kind": kind,
        "status": "created",
        "cwd": str(resolved_cwd),
        "pid": None,
        "createdAt": now,
        "updatedAt": now,
    }
