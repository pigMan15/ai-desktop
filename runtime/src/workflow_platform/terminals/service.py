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


class TerminalSessionRecord(TypedDict):
    id: str
    project_id: str
    run_id: str
    node_id: str
    kind: TerminalKind
    status: str
    cwd: str
    pid: int | None
    created_at: str
    updated_at: str


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

    cwd_path = Path(cwd)
    if project_root is not None:
        resolved_root = Path(project_root).resolve()
        resolved_cwd = (resolved_root / cwd_path if not cwd_path.is_absolute() else cwd_path).resolve()
        try:
            resolved_cwd.relative_to(resolved_root)
        except ValueError as exc:
            raise ValueError("terminal cwd must stay within project root") from exc
    else:
        resolved_cwd = cwd_path.resolve()

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


def terminal_session_to_record(session: TerminalSession) -> TerminalSessionRecord:
    return {
        "id": session["id"],
        "project_id": session["projectId"],
        "run_id": session["runId"],
        "node_id": session["nodeId"],
        "kind": session["kind"],
        "status": session["status"],
        "cwd": session["cwd"],
        "pid": session["pid"],
        "created_at": session["createdAt"],
        "updated_at": session["updatedAt"],
    }
