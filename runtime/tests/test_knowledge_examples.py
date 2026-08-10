import subprocess
from pathlib import Path

import pytest

from workflow_platform.examples.knowledge import (
    EXAMPLE_ID,
    _asset_files,
    _read_asset,
    initialize,
    list_examples,
)


def test_list_examples_returns_complex_business() -> None:
    examples = list_examples()
    assert examples[0]["id"] == EXAMPLE_ID
    assert examples[0]["modes"] == ["complete", "template"]


def test_all_assets_are_non_empty_and_safe() -> None:
    files = _asset_files()
    assert len(files) >= 30
    assert ".ai-workflow/knowledge-repo.yaml" in files
    assert "README.md" in files
    for relative in files:
        content = _read_asset(relative)
        assert content.strip(), f"empty asset: {relative}"
        assert not relative.startswith("/")
        assert ".." not in relative.split("/")


def test_initialize_complete_creates_full_knowledge_base(tmp_path: Path) -> None:
    target = tmp_path / "kb-complete"
    result = initialize(
        EXAMPLE_ID,
        mode="complete",
        target_path=str(target),
        initialize_git=True,
        now="2026-08-10T00:00:00Z",
    )
    assert result["rootPath"] == str(target)
    assert result["gitInitialized"] is True
    assert (target / "README.md").is_file()
    assert (target / "applications" / "sample-order-service" / "application.md").is_file()
    assert (target / "candidate" / "sample-pending-knowledge.md").is_file()
    assert (target / ".ai-workflow" / "knowledge-repo.yaml").is_file()
    assert result["createdFiles"]
    assert (target / ".git").is_dir()
    # git init 但不创建初始 commit
    result_proc = subprocess.run(
        ["git", "rev-parse", "--verify", "HEAD"],
        cwd=str(target),
        shell=False,
        capture_output=True,
    )
    assert result_proc.returncode != 0


def test_initialize_template_removes_business_content(tmp_path: Path) -> None:
    target = tmp_path / "kb-template"
    result = initialize(
        EXAMPLE_ID,
        mode="template",
        target_path=str(target),
        initialize_git=False,
        now="2026-08-10T00:00:00Z",
    )
    assert not (target / "applications" / "sample-order-service").exists()
    assert not (target / "candidate" / "sample-pending-knowledge.md").exists()
    assert not (target / "personal" / "sample-debugging-note.md").exists()
    assert (target / "KNOWLEDGE-RULES.md").is_file()
    assert (target / "template" / "knowledge-entry.md").is_file()
    assert result["gitInitialized"] is False
    for relative in result["createdFiles"]:
        content = (target / relative).read_bytes()
        assert content.strip(), f"empty created file: {relative}"


def test_initialize_rejects_non_empty_target(tmp_path: Path) -> None:
    target = tmp_path / "kb"
    target.mkdir()
    (target / "existing.md").write_text("x", encoding="utf-8")
    with pytest.raises(ValueError) as exc:
        initialize(
            EXAMPLE_ID,
            mode="complete",
            target_path=str(target),
            initialize_git=False,
            now="2026-08-10T00:00:00Z",
        )
    assert "KNOWLEDGE_EXAMPLE_TARGET_NOT_EMPTY" in str(exc.value)


def test_initialize_rejects_unknown_example_and_mode(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        initialize(
            "unknown",
            mode="complete",
            target_path=str(tmp_path / "x"),
            initialize_git=False,
            now="2026-08-10T00:00:00Z",
        )
    with pytest.raises(ValueError):
        initialize(
            EXAMPLE_ID,
            mode="other",
            target_path=str(tmp_path / "x"),
            initialize_git=False,
            now="2026-08-10T00:00:00Z",
        )
