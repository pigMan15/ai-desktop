from __future__ import annotations

from pathlib import Path

from workflow_platform.terminals.service import TerminalSessionManager


class FakeStream:
    def __init__(self) -> None:
        self.writes: list[str] = []

    def write(self, value: str) -> None:
        self.writes.append(value)

    def flush(self) -> None:
        return None


class FakeProcess:
    pid = 2468

    def __init__(self) -> None:
        self.stdin = FakeStream()
        self.stdout = FakeStream()
        self.stderr = FakeStream()
        self.terminated = False

    def poll(self) -> None:
        return None

    def terminate(self) -> None:
        self.terminated = True

    def wait(self, timeout: float | None = None) -> int:
        return 0


def test_terminal_session_manager_controls_shell_io_and_scrollback(tmp_path: Path) -> None:
    spawned: list[tuple[list[str], str]] = []
    process = FakeProcess()

    def spawn(command: list[str], *, cwd: str) -> FakeProcess:
        spawned.append((command, cwd))
        return process

    manager = TerminalSessionManager(spawn_process=spawn)
    session = manager.create(
        project_id="project-1",
        run_id="run-1",
        node_id="plan",
        kind="shell",
        cwd=".",
        project_root=tmp_path,
    )

    assert session["status"] == "running"
    assert session["pid"] == 2468
    assert spawned[0][1] == str(tmp_path.resolve())

    manager.write(session["id"], "npm.cmd run verify\r")
    manager.append_output(session["id"], "stdout", "验证开始\n")
    resized = manager.resize(session["id"], columns=120, rows=40)

    assert process.stdin.writes == ["npm.cmd run verify\r"]
    assert manager.scrollback(session["id"], after_sequence=0) == [
        {
            "sequence": 1,
            "stream": "stdout",
            "data": "验证开始\n",
        }
    ]
    assert resized["columns"] == 120
    assert resized["rows"] == 40

    stopped = manager.stop(session["id"])
    assert stopped["status"] == "stopped"
    assert process.terminated is True

    restarted = manager.restart(session["id"])
    assert restarted["status"] == "running"
    assert len(spawned) == 2


def test_terminal_session_manager_rejects_unknown_sessions_and_project_escape(
    tmp_path: Path,
) -> None:
    manager = TerminalSessionManager(spawn_process=lambda _command, *, cwd: FakeProcess())

    try:
        manager.create(
            project_id="project-1",
            run_id="run-1",
            node_id="plan",
            kind="shell",
            cwd=tmp_path.parent,
            project_root=tmp_path,
        )
    except ValueError as error:
        assert str(error) == "terminal cwd must stay within project root"
    else:
        raise AssertionError("expected terminal project escape rejection")

    try:
        manager.write("missing", "whoami")
    except KeyError as error:
        assert str(error) == "'Terminal session not found: missing'"
    else:
        raise AssertionError("expected missing terminal session")
