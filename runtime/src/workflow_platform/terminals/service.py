from pathlib import Path
from typing import Literal
from uuid import uuid4


TerminalKind = Literal["shell", "codex"]


def create_terminal_session(
    *,
    project_id: str,
    run_id: str,
    node_id: str,
    kind: TerminalKind,
    cwd: str | Path,
) -> dict[str, str]:
    if kind not in {"shell", "codex"}:
        raise ValueError("terminal kind must be shell or codex")

    return {
        "id": str(uuid4()),
        "project_id": project_id,
        "run_id": run_id,
        "node_id": node_id,
        "kind": kind,
        "cwd": str(Path(cwd).resolve()),
        "status": "created",
    }
