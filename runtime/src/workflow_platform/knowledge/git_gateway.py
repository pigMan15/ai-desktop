from __future__ import annotations

import hashlib
import posixpath
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

EMPTY_HEAD = "EMPTY_HEAD"
GIT_TIMEOUT_SECONDS = 30
MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024


class KnowledgeGitError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def validate_repository_relative_path(path: str) -> str:
    if not isinstance(path, str) or not path:
        raise KnowledgeGitError("KNOWLEDGE_PATH_OUTSIDE_REPOSITORY", "路径为空", status=400)
    if "\x00" in path or any(ord(ch) < 32 for ch in path):
        raise KnowledgeGitError("KNOWLEDGE_PATH_OUTSIDE_REPOSITORY", "路径包含非法控制字符", status=400)
    normalized = path.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise KnowledgeGitError("KNOWLEDGE_PATH_OUTSIDE_REPOSITORY", "不允许绝对路径", status=400)
    parts = normalized.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise KnowledgeGitError("KNOWLEDGE_PATH_OUTSIDE_REPOSITORY", "路径包含 . 或 .. 片段", status=400)
    if posixpath.normpath(normalized) != normalized:
        raise KnowledgeGitError("KNOWLEDGE_PATH_OUTSIDE_REPOSITORY", "路径未规范化", status=400)
    return normalized


def sha256_hex(content: bytes | str) -> str:
    if isinstance(content, str):
        content = content.encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def repository_identity(canonical_root_path: str, git_common_dir: str) -> str:
    return sha256_hex(f"{canonical_root_path}\n{git_common_dir}")


def _decode_output(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return data.decode("gb18030")
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="replace")


@dataclass
class GitInspection:
    rootPath: str
    commonDir: str
    branch: str | None
    headCommit: str
    dirty: bool
    conflict: bool
    worktreeFingerprint: str
    stagedPaths: list[str]
    unstagedPaths: list[str]


@dataclass
class GitCommit:
    commitHash: str
    branch: str | None
    committedPaths: list[str]


_WHITELIST = (
    ("rev-parse", "--show-toplevel"),
    ("rev-parse", "--git-common-dir"),
    ("rev-parse", "HEAD"),
    ("symbolic-ref", "--quiet", "--short", "HEAD"),
    ("status", "--porcelain=v1", "-z"),
    ("diff", "--no-ext-diff", "--binary"),
    ("diff", "--no-ext-diff", "--binary", "--cached"),
    ("add", "--"),
    ("add", "-A", "--"),
    ("reset", "--"),
    ("commit", "--only", "-m"),
)


def _parse_status(data: bytes) -> tuple[list[str], list[str], bool]:
    staged: list[str] = []
    unstaged: list[str] = []
    conflict = False
    fields = data.split(b"\x00")
    index = 0
    while index < len(fields):
        entry = fields[index]
        if not entry:
            index += 1
            continue
        raw_xy = entry[:2].decode("ascii", errors="replace")
        path = _decode_output(entry[3:])
        x, y = raw_xy[0], raw_xy[1]
        old_path: str | None = None
        if x in {"R", "C"} and index + 1 < len(fields) and fields[index + 1]:
            # porcelain v1 -z 的 rename/copy：第一字段是新路径，下一字段是旧路径
            old_path = _decode_output(fields[index + 1])
            index += 1
        if x == "U" or y == "U":
            conflict = True
        if x != " " and x != "?":
            staged.append(path)
            if old_path is not None and old_path != path:
                staged.append(old_path)
        if y != " " and y != "?":
            unstaged.append(path)
        index += 1
    return staged, unstaged, conflict


class KnowledgeGitGateway:
    def __init__(self, *, timeout: float = GIT_TIMEOUT_SECONDS) -> None:
        self._timeout = timeout

    def inspect(self, root: Path) -> GitInspection:
        root_path = self._run(root, ["rev-parse", "--show-toplevel"]).strip() or str(root.resolve())
        common_dir = self._run(root, ["rev-parse", "--git-common-dir"]).strip()
        branch: str | None = None
        try:
            branch_output = self._run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).strip()
            branch = branch_output or None
        except KnowledgeGitError:
            branch = None
        head_commit = EMPTY_HEAD
        try:
            head_output = self._run(root, ["rev-parse", "HEAD"]).strip()
            head_commit = head_output or EMPTY_HEAD
        except KnowledgeGitError:
            head_commit = EMPTY_HEAD
        status_bytes = self._run_bytes(root, ["status", "--porcelain=v1", "-z"])
        staged, unstaged, conflict = _parse_status(status_bytes)
        return GitInspection(
            rootPath=root_path,
            commonDir=common_dir,
            branch=branch,
            headCommit=head_commit,
            dirty=bool(staged or unstaged or b"??" in status_bytes),
            conflict=conflict,
            worktreeFingerprint=sha256_hex(status_bytes),
            stagedPaths=staged,
            unstagedPaths=unstaged,
        )

    def diff(
        self, root: Path, *, staged: bool, paths: list[str] | None = None
    ) -> str:
        args = ["diff", "--no-ext-diff", "--binary"]
        if staged:
            args.append("--cached")
        if paths:
            validated = [self._validate(root, path) for path in paths]
            args.append("--")
            args.extend(validated)
        return self._run(root, args)

    def stage(self, root: Path, paths: list[str]) -> GitInspection:
        validated = [self._validate(root, path) for path in paths]
        # -A：显式路径可同时暂存新增、修改与删除（转正会删除源文件）
        self._run(root, ["add", "-A", "--", *validated])
        return self.inspect(root)

    def unstage(self, root: Path, paths: list[str]) -> GitInspection:
        validated = [self._validate(root, path) for path in paths]
        self._run(root, ["reset", "--", *validated])
        return self.inspect(root)

    def commit(
        self,
        root: Path,
        *,
        title: str,
        body: str,
        paths: list[str] | None,
    ) -> GitCommit:
        if not title or not title.strip():
            raise KnowledgeGitError("KNOWLEDGE_GIT_COMMIT_INVALID", "提交标题不能为空", status=400)
        validated = [self._validate(root, path) for path in (paths or [])]
        message = title.strip()
        if body and body.strip():
            message = f"{message}\n\n{body.strip()}"
        status = self.inspect(root)
        if status.conflict:
            raise KnowledgeGitError("KNOWLEDGE_GIT_CONFLICT", "存在未解决冲突，禁止提交", status=409)
        if validated:
            missing = [
                path
                for path in validated
                if path not in status.stagedPaths and path not in status.unstagedPaths
            ]
            if missing:
                raise KnowledgeGitError(
                    "KNOWLEDGE_CHANGE_SET_NOT_APPLIED",
                    f"提交路径未应用到工作区: {missing}",
                    status=409,
                )
        args = ["commit", "--only", "-m", message]
        if validated:
            args.append("--")
            args.extend(validated)
        self._run(root, args)
        inspection = self.inspect(root)
        return GitCommit(
            commitHash=inspection.headCommit,
            branch=inspection.branch,
            committedPaths=validated,
        )

    def _validate(self, root: Path, path: str) -> str:
        relative = validate_repository_relative_path(path)
        root_resolved = root.resolve()
        candidate = (root / relative).resolve()
        if not _is_within(candidate, root_resolved):
            raise KnowledgeGitError(
                "KNOWLEDGE_PATH_PROTECTED",
                f"路径越过仓库根或符号链接越界: {relative}",
                status=403,
            )
        return relative

    def _run(self, root: Path, args: list[str]) -> str:
        return _decode_output(self._run_bytes(root, args))

    def _run_bytes(self, root: Path, args: list[str]) -> bytes:
        self._assert_whitelisted(args)
        try:
            result = subprocess.run(
                ["git", *args],
                cwd=str(root),
                shell=False,
                check=True,
                capture_output=True,
                timeout=self._timeout,
            )
        except subprocess.TimeoutExpired as error:
            raise KnowledgeGitError(
                "KNOWLEDGE_GIT_TIMEOUT", "Git 命令执行超时", status=423
            ) from error
        except subprocess.CalledProcessError as error:
            detail = (
                _decode_output(error.stderr or b"").strip()
                or _decode_output(error.stdout or b"").strip()
            )
            raise KnowledgeGitError(
                "KNOWLEDGE_GIT_COMMAND_FAILED", detail[:500], status=409
            ) from error
        if len(result.stdout) > MAX_GIT_OUTPUT_BYTES:
            raise KnowledgeGitError(
                "KNOWLEDGE_GIT_OUTPUT_LIMIT", "Git 输出超过 2 MiB 上限", status=413
            )
        return result.stdout

    def _assert_whitelisted(self, args: list[str]) -> None:
        for allowed in _WHITELIST:
            if tuple(args[: len(allowed)]) == allowed:
                return
        raise KnowledgeGitError(
            "KNOWLEDGE_GIT_COMMAND_NOT_ALLOWED",
            f"Git 命令不在白名单: {args}",
            status=403,
        )


def _is_within(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False
