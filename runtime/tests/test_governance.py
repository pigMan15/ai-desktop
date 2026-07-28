from pathlib import Path
import re
import shutil

import pytest

from workflow_platform.approvals.service import validate_human_decision
from workflow_platform.artifacts.service import hash_artifact, validate_safe_path
from workflow_platform.gates.service import validate_gate_decision


@pytest.fixture
def governance_workspace(request: pytest.FixtureRequest) -> Path:
    test_root = Path(__file__).parent / ".governance_tmp"
    workspace = test_root / re.sub(r"[^A-Za-z0-9_.-]", "_", request.node.name)
    shutil.rmtree(workspace, ignore_errors=True)
    workspace.mkdir(parents=True)
    try:
        yield workspace
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def test_validate_safe_path_allows_project_root(governance_workspace: Path) -> None:
    assert validate_safe_path(governance_workspace, governance_workspace) == governance_workspace.resolve()


def test_validate_safe_path_allows_relative_path_inside_project_root(
    governance_workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    artifact = governance_workspace / "reports" / "result.txt"
    artifact.parent.mkdir()
    artifact.write_text("ok", encoding="utf-8")
    monkeypatch.chdir(governance_workspace)

    assert validate_safe_path(governance_workspace, Path("reports") / "result.txt") == artifact.resolve()


def test_validate_safe_path_rejects_parent_directory_escape(governance_workspace: Path) -> None:
    outside = governance_workspace.parent / "outside-artifact.txt"

    with pytest.raises(ValueError, match="must stay within project root"):
        validate_safe_path(governance_workspace, outside)


def test_validate_safe_path_rejects_relative_parent_escape(
    governance_workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    nested_root = governance_workspace / "project"
    nested_root.mkdir()
    monkeypatch.chdir(nested_root)

    with pytest.raises(ValueError, match="must stay within project root"):
        validate_safe_path(nested_root, Path("..") / "escaped.txt")


def test_hash_artifact_returns_stable_sha256(governance_workspace: Path) -> None:
    artifact = governance_workspace / "artifact.txt"
    artifact.write_text("workflow artifact\n", encoding="utf-8")

    first_hash = hash_artifact(artifact)
    second_hash = hash_artifact(artifact)

    assert first_hash == second_hash
    assert first_hash == "d44e3708fbe71246cec791a0597d9430a03f4436b0c57fe5372333b341f97c70"


def test_hash_artifact_raises_for_missing_file(governance_workspace: Path) -> None:
    with pytest.raises(FileNotFoundError):
        hash_artifact(governance_workspace / "missing.txt")


@pytest.mark.parametrize("actor", ["verifier", "system"])
def test_validate_gate_decision_allows_verifier_or_system_with_evidence(actor: str) -> None:
    validate_gate_decision(actor=actor, evidence=["tests passed"], waiver_reason=None)


def test_validate_gate_decision_allows_verifier_with_non_empty_waiver() -> None:
    validate_gate_decision(actor="verifier", evidence=[], waiver_reason="accepted risk")


@pytest.mark.parametrize("actor", ["human", "agent", "planner"])
def test_validate_gate_decision_rejects_unauthorized_actor(actor: str) -> None:
    with pytest.raises(ValueError, match="only verifier or system"):
        validate_gate_decision(actor=actor, evidence=["tests passed"], waiver_reason=None)


@pytest.mark.parametrize(
    ("evidence", "waiver_reason"),
    [
        ([], None),
        (["", "   "], None),
        ([], ""),
        ([], "   "),
    ],
)
def test_validate_gate_decision_requires_evidence_or_non_empty_waiver(
    evidence: list[str],
    waiver_reason: str | None,
) -> None:
    with pytest.raises(ValueError, match="requires evidence or a non-empty waiver"):
        validate_gate_decision(actor="verifier", evidence=evidence, waiver_reason=waiver_reason)


def test_validate_human_decision_allows_trusted_human() -> None:
    validate_human_decision(actor="trusted_human")


@pytest.mark.parametrize("actor", ["untrusted_human", "agent", "system"])
def test_validate_human_decision_rejects_untrusted_actors(actor: str) -> None:
    with pytest.raises(ValueError, match="only trusted human"):
        validate_human_decision(actor=actor)
