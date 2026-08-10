import subprocess
from pathlib import Path

import pytest

from workflow_platform.knowledge.git_gateway import (
    EMPTY_HEAD,
    KnowledgeGitError,
    KnowledgeGitGateway,
    repository_identity,
    validate_repository_relative_path,
)


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(repo),
        shell=False,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _init_repo(tmp_path: Path, name: str = "repo") -> Path:
    repo = tmp_path / name
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "INDEX.md").write_text("# Index\n", encoding="utf-8")
    _git(repo, "add", "INDEX.md")
    _git(repo, "commit", "-q", "-m", "init")
    return repo


def test_validate_repository_relative_path_rejects_unsafe_inputs() -> None:
    for bad in ("", "/etc/passwd", "C:/x", "candidate/../x", "candidate//x", "a/./b", "..", ".", "a\\..\\b"):
        with pytest.raises(KnowledgeGitError):
            validate_repository_relative_path(bad)
    assert validate_repository_relative_path("candidate/new.md") == "candidate/new.md"
    assert validate_repository_relative_path("candidate\\new.md") == "candidate/new.md"


def test_inspect_reports_clean_repository(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    gateway = KnowledgeGitGateway()
    inspection = gateway.inspect(repo)
    assert inspection.branch == "master" or inspection.branch == "main"
    assert inspection.headCommit != EMPTY_HEAD
    assert inspection.dirty is False
    assert inspection.conflict is False
    assert inspection.stagedPaths == []
    assert inspection.unstagedPaths == []
    assert len(inspection.worktreeFingerprint) == 64
    assert repository_identity(inspection.rootPath, inspection.commonDir)


def test_inspect_reports_dirty_staged_and_unstaged(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    gateway = KnowledgeGitGateway()
    (repo / "INDEX.md").write_text("# Updated\n", encoding="utf-8")
    (repo / "candidate").mkdir()
    (repo / "candidate" / "new.md").write_text("new", encoding="utf-8")
    _git(repo, "add", "candidate/new.md")
    inspection = gateway.inspect(repo)
    assert inspection.dirty is True
    assert "candidate/new.md" in inspection.stagedPaths
    assert "INDEX.md" in inspection.unstagedPaths
    first = gateway.inspect(repo).worktreeFingerprint
    (repo / "candidate" / "new.md").write_text("changed", encoding="utf-8")
    assert gateway.inspect(repo).worktreeFingerprint != first


def test_stage_and_unstage_round_trip(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    gateway = KnowledgeGitGateway()
    (repo / "candidate").mkdir()
    (repo / "candidate" / "new.md").write_text("new", encoding="utf-8")
    after_stage = gateway.stage(repo, ["candidate/new.md"])
    assert "candidate/new.md" in after_stage.stagedPaths
    after_unstage = gateway.unstage(repo, ["candidate/new.md"])
    assert "candidate/new.md" not in after_unstage.stagedPaths


def test_diff_working_and_staged(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    gateway = KnowledgeGitGateway()
    (repo / "INDEX.md").write_text("# Index changed\n", encoding="utf-8")
    working = gateway.diff(repo, staged=False)
    assert "+# Index changed" in working
    _git(repo, "add", "INDEX.md")
    staged = gateway.diff(repo, staged=True)
    assert "+# Index changed" in staged


def test_commit_only_selected_paths(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    gateway = KnowledgeGitGateway()
    (repo / "candidate").mkdir()
    (repo / "candidate" / "a.md").write_text("a", encoding="utf-8")
    (repo / "candidate" / "b.md").write_text("b", encoding="utf-8")
    gateway.stage(repo, ["candidate/a.md", "candidate/b.md"])
    before = gateway.inspect(repo).headCommit
    commit = gateway.commit(repo, title="knowledge: add a and b", body="body", paths=["candidate/a.md"])
    after = gateway.inspect(repo).headCommit
    assert commit.commitHash == after
    assert commit.commitHash != before
    assert commit.committedPaths == ["candidate/a.md"]
    assert "candidate/a.md" not in gateway.inspect(repo).stagedPaths
    assert "candidate/b.md" in gateway.inspect(repo).stagedPaths


def test_commit_rejects_missing_paths(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    gateway = KnowledgeGitGateway()
    with pytest.raises(KnowledgeGitError) as exc:
        gateway.commit(repo, title="t", body="", paths=["candidate/missing.md"])
    assert exc.value.code == "KNOWLEDGE_CHANGE_SET_NOT_APPLIED"


def test_detached_head_reports_null_branch(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    _git(repo, "checkout", "-q", "--detach")
    gateway = KnowledgeGitGateway()
    inspection = gateway.inspect(repo)
    assert inspection.branch is None
    assert inspection.headCommit != EMPTY_HEAD


def test_conflict_detection(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    (repo / "INDEX.md").write_text("base\n", encoding="utf-8")
    _git(repo, "commit", "-q", "-am", "base")
    branch = _git(repo, "symbolic-ref", "--short", "HEAD")
    _git(repo, "checkout", "-q", "-b", "other")
    (repo / "INDEX.md").write_text("other\n", encoding="utf-8")
    _git(repo, "commit", "-q", "-am", "other")
    _git(repo, "checkout", "-q", branch)
    (repo / "INDEX.md").write_text("main\n", encoding="utf-8")
    _git(repo, "commit", "-q", "-am", "main")
    result = subprocess.run(
        ["git", "merge", "other"],
        cwd=str(repo),
        shell=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    gateway = KnowledgeGitGateway()
    inspection = gateway.inspect(repo)
    assert inspection.conflict is True
    with pytest.raises(KnowledgeGitError) as exc:
        gateway.commit(repo, title="t", body="", paths=["INDEX.md"])
    assert exc.value.code == "KNOWLEDGE_GIT_CONFLICT"


def test_outside_path_and_symlink_rejected(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    gateway = KnowledgeGitGateway()
    with pytest.raises(KnowledgeGitError) as exc:
        gateway.stage(repo, ["../outside.md"])
    assert exc.value.code == "KNOWLEDGE_PATH_OUTSIDE_REPOSITORY"
    outside = tmp_path / "outside.md"
    outside.write_text("secret", encoding="utf-8")
    link = repo / "link.md"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("创建符号链接需要管理员权限")
    with pytest.raises(KnowledgeGitError) as exc:
        gateway.stage(repo, ["link.md"])
    assert exc.value.code == "KNOWLEDGE_PATH_PROTECTED"


def test_whitelist_enforced(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    gateway = KnowledgeGitGateway()
    with pytest.raises(KnowledgeGitError) as exc:
        gateway._run(repo, ["push"])
    assert exc.value.code == "KNOWLEDGE_GIT_COMMAND_NOT_ALLOWED"
