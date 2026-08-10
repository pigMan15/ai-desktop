"""Knowledge Agent execution (document sections 28.1, 28.2).

Reuses `CliAgentExecutor` and `AgentJobRepository` with knowledge-specific job
records. It never validates workflow nodes, never takes a Run write lease and
never triggers artifact scanning.
"""
from __future__ import annotations

import shlex
import sqlite3
from pathlib import Path
from threading import RLock, Thread
from typing import Any, Callable
from uuid import uuid4

from workflow_platform.execution.cli import CliAgentExecutor, CliExecutionResult
from workflow_platform.governance.audit import AuditLog
from workflow_platform.persistence.repositories import AgentJobRepository
from workflow_platform.runtime_errors import RuntimeContractError

MAX_ACTIVE_PER_PURPOSE = 2
KNOWLEDGE_TIMEOUT_SECONDS = 300.0
MAX_KNOWLEDGE_OUTPUT_BYTES = 2 * 1024 * 1024

_RULE_DISCOVERY = "knowledge-rule-discovery"
_CHANGE_SET_GENERATION = "knowledge-change-set-generation"


def redact_command(args: list[str]) -> list[str]:
    """Keep diagnostic executable, flags and analysis root; drop prompt bodies.

    For Claude style `-p <prompt>` arguments the value after `-p` is removed.
    Any argument containing markdown or artifact body content is reduced to a
    hash placeholder.
    """
    redacted: list[str] = []
    skip_next = False
    for index, arg in enumerate(args):
        if skip_next:
            skip_next = False
            redacted.append("[REDACTED_PROMPT]")
            continue
        if arg == "-p" or arg == "--prompt":
            redacted.append(arg)
            skip_next = True
            continue
        if "\n" in arg or len(arg) > 2000 or "artifact" in arg.lower() and "\n" in arg:
            redacted.append(f"[REDACTED:{_short_hash(arg)}]")
            continue
        redacted.append(arg)
    return redacted


def _short_hash(value: str) -> str:
    import hashlib

    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


class KnowledgeAgentRunner:
    def __init__(
        self,
        *,
        db: sqlite3.Connection,
        lock: RLock,
        audit: AuditLog,
        agent_provider_factory: Callable[[str], Any],
        jobs_root: Path,
        on_completed: Callable[[str, CliExecutionResult, Path], None] | None = None,
    ) -> None:
        self._db = db
        self._lock = lock
        self._audit = audit
        self._jobs = AgentJobRepository(db)
        self._provider_factory = agent_provider_factory
        self._jobs_root = jobs_root
        self._on_completed = on_completed
        self._executors: dict[str, CliAgentExecutor] = {}
        self._threads: dict[str, Thread] = {}
        self._pending_cancelled: set[str] = set()

    # -- public API ---------------------------------------------------------

    def start_rule_discovery(
        self,
        *,
        job_id: str,
        repository_id: str,
        provider: str,
        analysis_root: Path,
        prompt: str,
        now: str,
    ) -> dict:
        return self._start(
            job_id=job_id,
            purpose=_RULE_DISCOVERY,
            owner_id=repository_id,
            project_id=None,
            run_id=None,
            provider=provider,
            analysis_root=analysis_root,
            prompt=prompt,
            now=now,
            metadata={"repositoryId": repository_id},
        )

    def start_change_set_generation(
        self,
        *,
        job_id: str,
        project_id: str,
        run_id: str,
        change_set_id: str,
        provider: str,
        analysis_root: Path,
        prompt: str,
        now: str,
    ) -> dict:
        return self._start(
            job_id=job_id,
            purpose=_CHANGE_SET_GENERATION,
            owner_id=change_set_id,
            project_id=project_id,
            run_id=run_id,
            provider=provider,
            analysis_root=analysis_root,
            prompt=prompt,
            now=now,
            metadata={"changeSetId": change_set_id},
        )

    def cancel(self, job_id: str, *, actor: dict, now: str) -> dict:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(f"Knowledge agent job not found: {job_id}")
            self._pending_cancelled.add(job_id)
            executor = self._executors.get(job_id)
        if executor is not None:
            executor.cancel(job_id)
            return job
        if job["status"] in {"QUEUED", "RUNNING"}:
            with self._lock, self._db:
                self._jobs.finish(
                    id=job_id,
                    status="CANCELLED",
                    summary="知识任务已取消",
                    error=None,
                    updated_at=now,
                )
                self._audit.record(
                    actor=actor,
                    action="knowledge.job.cancelled",
                    resource=f"knowledge-job:{job_id}",
                    detail={"purpose": job["purpose"], "ownerId": job["ownerId"]},
                    created_at=now,
                )
                self._db.commit()
        return self._jobs.get(job_id) or job

    def recover_orphaned_jobs(self, *, now: str) -> dict:
        """Mark QUEUED/RUNNING knowledge jobs without a live executor as failed."""
        recovered: list[str] = []
        with self._lock, self._db:
            for purpose in (_RULE_DISCOVERY, _CHANGE_SET_GENERATION):
                for job in self._jobs.list_active_by_purpose(purpose):
                    if job["id"] in self._executors or job["id"] in self._threads:
                        continue
                    self._jobs.finish(
                        id=job["id"],
                        status="FAILED",
                        summary=None,
                        error="KNOWLEDGE_AGENT_JOB_LOST: Runtime 执行器已不可用",
                        updated_at=now,
                    )
                    recovered.append(job["id"])
                    if self._on_completed is not None:
                        self._on_completed(
                            job["id"],
                            CliExecutionResult(
                                status="FAILED",
                                summary=None,
                                error="KNOWLEDGE_AGENT_JOB_LOST: Runtime 执行器已不可用",
                                exit_code=None,
                            ),
                            Path(job["cwd"]),
                        )
            self._db.commit()
        return {"recoveredJobIds": recovered}

    def active_count(self, purpose: str) -> int:
        with self._lock:
            return self._jobs.count_active_by_purpose(purpose)

    def is_active(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            if job["status"] not in {"QUEUED", "RUNNING"}:
                return False
            return job_id in self._executors or job_id in self._threads

    # -- internals ----------------------------------------------------------

    def _start(
        self,
        *,
        job_id: str,
        purpose: str,
        owner_id: str,
        project_id: str | None,
        run_id: str | None,
        provider: str,
        analysis_root: Path,
        prompt: str,
        now: str,
        metadata: dict,
    ) -> dict:
        with self._lock, self._db:
            active = self._jobs.count_active_by_purpose(purpose)
            if active >= MAX_ACTIVE_PER_PURPOSE:
                raise RuntimeContractError(
                    "KNOWLEDGE_JOB_ALREADY_RUNNING",
                    f"知识任务并发达到上限（{MAX_ACTIVE_PER_PURPOSE}）",
                    status=409,
                    details={"activeCount": active, "limit": MAX_ACTIVE_PER_PURPOSE},
                )
            existing = self._jobs.list_active_by_purpose_owner(purpose=purpose, owner_id=owner_id)
            if existing:
                raise RuntimeContractError(
                    "KNOWLEDGE_JOB_ALREADY_RUNNING",
                    "该资源已有活动知识任务",
                    status=409,
                    details={"jobId": existing[0]["id"]},
                )
            analysis_root.mkdir(parents=True, exist_ok=True)
            command = [provider, "knowledge", str(analysis_root)]
            self._jobs.create(
                id=job_id,
                project_id=project_id,
                run_id=run_id,
                node_id=None,
                purpose=purpose,
                owner_id=owner_id,
                provider=provider,
                status="QUEUED",
                command=redact_command(command),
                cwd=str(analysis_root),
                created_at=now,
                metadata=metadata,
            )
            self._db.commit()
        thread = Thread(
            target=self._execute,
            args=(job_id, provider, analysis_root, prompt, now),
            daemon=True,
        )
        with self._lock:
            self._threads[job_id] = thread
        thread.start()
        return {"jobId": job_id, "status": "QUEUED"}

    def _execute(
        self,
        job_id: str,
        provider: str,
        analysis_root: Path,
        prompt: str,
        now: str,
    ) -> None:
        output_sequence = 0

        def append_output(event: dict[str, Any]) -> None:
            nonlocal output_sequence
            output_sequence += 1
            with self._lock, self._db:
                self._jobs.append_output(
                    id=f"{job_id}:output:{output_sequence}",
                    job_id=job_id,
                    sequence=output_sequence,
                    kind=event["kind"],
                    payload=event["payload"],
                    created_at=now,
                )
                self._db.commit()

        def on_started(pid: int) -> None:
            with self._lock, self._db:
                self._jobs.set_running(id=job_id, pid=pid, updated_at=now)
                self._db.commit()

        cli_provider = self._provider_factory(provider)
        executor = CliAgentExecutor(
            provider=cli_provider,
            on_output=append_output,
            on_started=on_started,
        )
        with self._lock:
            self._executors[job_id] = executor
            cancelled = job_id in self._pending_cancelled
        if cancelled:
            executor.cancel(job_id)
        try:
            result = executor.run(
                job_id=job_id,
                prompt=prompt,
                cwd=analysis_root,
                project_root=analysis_root,
                timeout_seconds=KNOWLEDGE_TIMEOUT_SECONDS,
                max_output_bytes=MAX_KNOWLEDGE_OUTPUT_BYTES,
                allowed_tools=[],
            )
            with self._lock, self._db:
                self._jobs.finish(
                    id=job_id,
                    status=result.status,
                    summary=result.summary,
                    error=result.error,
                    updated_at=now,
                )
                self._db.commit()
            if result.status == "COMPLETED" and self._on_completed is not None:
                self._on_completed(job_id, result, analysis_root)
        except Exception:
            with self._lock, self._db:
                self._jobs.finish(
                    id=job_id,
                    status="FAILED",
                    summary=None,
                    error="KNOWLEDGE_AGENT_JOB_LOST: 知识任务执行器异常",
                    updated_at=now,
                )
                self._db.commit()
        finally:
            with self._lock:
                self._executors.pop(job_id, None)
                self._threads.pop(job_id, None)
                self._pending_cancelled.discard(job_id)
