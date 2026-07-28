from datetime import UTC, datetime
from pathlib import Path
import subprocess
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


class TerminalOutputEvent(TypedDict):
    sequence: int
    stream: Literal["stdout", "stderr"]
    data: str


class ManagedTerminalSession(TerminalSession):
    columns: int
    rows: int


class TerminalSessionManager:
    def __init__(self, *, spawn_process=None) -> None:
        self._spawn_process = spawn_process or self._default_spawn
        self._sessions: dict[str, ManagedTerminalSession] = {}
        self._processes: dict[str, object] = {}
        self._output: dict[str, list[TerminalOutputEvent]] = {}

    def create(
        self,
        *,
        project_id: str,
        run_id: str,
        node_id: str,
        kind: TerminalKind,
        cwd: str | Path,
        project_root: str | Path,
    ) -> ManagedTerminalSession:
        session = create_terminal_session(
            project_id=project_id,
            run_id=run_id,
            node_id=node_id,
            kind=kind,
            cwd=cwd,
            project_root=project_root,
        )
        process = self._spawn_process(self._command_for(kind), cwd=session["cwd"])
        managed: ManagedTerminalSession = {
            **session,
            "status": "running",
            "pid": getattr(process, "pid", None),
            "updatedAt": _now(),
            "columns": 80,
            "rows": 24,
        }
        self._sessions[managed["id"]] = managed
        self._processes[managed["id"]] = process
        self._output[managed["id"]] = []
        return managed

    def write(self, session_id: str, data: str) -> None:
        process = self._process_for(session_id)
        stdin = getattr(process, "stdin", None)
        if stdin is None:
            raise ValueError("Terminal process stdin is unavailable")
        stdin.write(data)
        stdin.flush()
        self._sessions[session_id]["updatedAt"] = _now()

    def append_output(
        self,
        session_id: str,
        stream: Literal["stdout", "stderr"],
        data: str,
    ) -> None:
        self._session_for(session_id)
        sequence = len(self._output[session_id]) + 1
        self._output[session_id].append({"sequence": sequence, "stream": stream, "data": data})
        self._sessions[session_id]["updatedAt"] = _now()

    def scrollback(self, session_id: str, *, after_sequence: int = 0) -> list[TerminalOutputEvent]:
        self._session_for(session_id)
        return [
            event for event in self._output[session_id] if event["sequence"] > after_sequence
        ]

    def resize(self, session_id: str, *, columns: int, rows: int) -> ManagedTerminalSession:
        if columns < 1 or rows < 1:
            raise ValueError("terminal size must be positive")
        session = self._session_for(session_id)
        session["columns"] = columns
        session["rows"] = rows
        session["updatedAt"] = _now()
        return session

    def stop(self, session_id: str) -> ManagedTerminalSession:
        session = self._session_for(session_id)
        process = self._process_for(session_id)
        if getattr(process, "poll", lambda: 0)() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
        session["status"] = "stopped"
        session["updatedAt"] = _now()
        return session

    def restart(self, session_id: str) -> ManagedTerminalSession:
        session = self._session_for(session_id)
        self.stop(session_id)
        process = self._spawn_process(self._command_for(session["kind"]), cwd=session["cwd"])
        self._processes[session_id] = process
        session["status"] = "running"
        session["pid"] = getattr(process, "pid", None)
        session["updatedAt"] = _now()
        return session

    def _session_for(self, session_id: str) -> ManagedTerminalSession:
        try:
            return self._sessions[session_id]
        except KeyError as exc:
            raise KeyError(f"Terminal session not found: {session_id}") from exc

    def _process_for(self, session_id: str):
        self._session_for(session_id)
        return self._processes[session_id]

    @staticmethod
    def _command_for(kind: TerminalKind) -> list[str]:
        if kind == "codex":
            return ["codex.cmd"] if _is_windows() else ["codex"]
        return ["cmd.exe"] if _is_windows() else ["/bin/sh"]

    @staticmethod
    def _default_spawn(command: list[str], *, cwd: str):
        return subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            shell=False,
        )


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


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _is_windows() -> bool:
    return __import__("sys").platform == "win32"
