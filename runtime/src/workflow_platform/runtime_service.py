import hashlib
import sqlite3
from pathlib import Path
from threading import RLock
from typing import Any, Callable
from uuid import uuid4, uuid5, NAMESPACE_URL

from workflow_platform.adapters.registry import default_registry
from workflow_platform.artifacts.service import hash_artifact, validate_safe_path
from workflow_platform.execution.cli import CliAgentExecutor
from workflow_platform.execution.providers import ClaudeCliProvider, CliProvider, CodexCliProvider
from workflow_platform.kernel.projection import rebuild_projection
from workflow_platform.kernel.transition import transition
from workflow_platform.models import Actor, RunEvent, RunProjection
from workflow_platform.persistence.repositories import (
    AgentJobRepository,
    ApprovalRepository,
    ArtifactRepository,
    GateResultRepository,
    ProjectRepository,
    ProjectionRepository,
    RunEventRepository,
    RunRepository,
    WorkflowVersionRepository,
)


class WorkflowRuntimeService:
    def __init__(
        self,
        db: sqlite3.Connection,
        *,
        agent_provider_factory: Callable[[str], CliProvider] | None = None,
    ) -> None:
        self._db = db
        self._projects = ProjectRepository(db)
        self._workflow_versions = WorkflowVersionRepository(db)
        self._runs = RunRepository(db)
        self._events = RunEventRepository(db)
        self._projections = ProjectionRepository(db)
        self._artifacts = ArtifactRepository(db)
        self._approvals = ApprovalRepository(db)
        self._gate_results = GateResultRepository(db)
        self._agent_jobs = AgentJobRepository(db)
        self._adapter_registry = default_registry()
        self._agent_provider_factory = agent_provider_factory or _default_agent_provider
        self._agent_executors: dict[str, CliAgentExecutor] = {}
        self._lock = RLock()

    def import_project(self, project_path: Path, *, now: str) -> dict:
        project_path = project_path.resolve()
        detections = self._adapter_registry.detect(project_path)
        if not detections:
            raise ValueError("ADAPTER_UNSUPPORTED: 未检测到支持的 workflow")

        detection = detections[0]
        adapter = self._adapter_registry.adapter_for(detection.adapter_id)
        workflow = adapter.import_workflow(project_path)
        project_id = _stable_id("project", project_path.as_posix())
        workflow_version_id = _stable_id("workflow-version", f"{project_id}:{workflow.id}:{workflow.version}")
        content_hash = hashlib.sha256(
            workflow.model_dump_json(by_alias=True).encode("utf-8")
        ).hexdigest()

        with self._lock:
            try:
                self._db.execute("BEGIN IMMEDIATE")
                self._projects.save(
                    id=project_id,
                    name=project_path.name,
                    root_path=project_path,
                    active_protocol=detection.adapter_id,
                    now=now,
                )
                self._workflow_versions.save(
                    workflow,
                    id=workflow_version_id,
                    project_id=project_id,
                    content_hash=content_hash,
                    created_at=now,
                    adapter_id=detection.adapter_id,
                )
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise

        return {
            "projectId": project_id,
            "workflowVersionId": workflow_version_id,
            **detection.model_dump(by_alias=True),
        }

    def create_run(self, workflow_version_id: str, *, title: str, now: str) -> RunProjection:
        workflow = self._workflow_versions.get(workflow_version_id)
        if workflow is None:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")

        row = self._db.execute(
            "SELECT project_id FROM workflow_versions WHERE id = ?",
            (workflow_version_id,),
        ).fetchone()
        project_id = row["project_id"]
        run_id = _stable_id("run", f"{workflow_version_id}:{title}:{now}")
        actor = Actor(id="runtime", type="system", source="runtime", trusted=True)
        created_event = RunEvent(
            id=f"{run_id}:event:1",
            runId=run_id,
            type="RUN_CREATED",
            nodeId=None,
            actor=actor,
            payload={"workflowVersionId": workflow_version_id, "title": title},
            createdAt=now,
            revision="1",
        )
        projection = rebuild_projection(run_id, workflow, [created_event])

        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                self._runs.save(
                    id=run_id,
                    project_id=project_id,
                    workflow_version_id=workflow_version_id,
                    title=title,
                    status=projection.status,
                    context={},
                    now=now,
                )
                self._events.append(created_event, 1)
                self._projections.save(projection)
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise

        return projection

    def submit_artifact(
        self,
        run_id: str,
        *,
        node_id: str,
        artifact_path: Path,
        artifact_type: str,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> RunProjection:
        project_root = self._runs.project_root_for_run(run_id)
        safe_path = validate_safe_path(project_root, artifact_path)
        artifact_uri = safe_path.as_uri()
        content_hash = hash_artifact(safe_path)
        return self._transition_run(
            run_id,
            "ARTIFACT_SUBMITTED",
            node_id=node_id,
            actor=actor,
            payload={
                "artifactUri": artifact_uri,
                "artifactType": artifact_type,
                "contentHash": content_hash,
            },
            expected_revision=expected_revision,
            now=now,
            after_accept=lambda result: self._artifacts.save(
                id=f"{run_id}:artifact:{node_id}:{result['emittedEvents'][0].revision}",
                run_id=run_id,
                node_id=node_id,
                type=artifact_type,
                uri=artifact_uri,
                content_hash=content_hash,
                producer=Actor.model_validate(actor),
                created_at=now,
            ),
        )

    def decide_approval(
        self,
        run_id: str,
        *,
        node_id: str,
        decision: str,
        actor: dict,
        comment: str | None,
        expected_revision: str,
        now: str,
    ) -> RunProjection:
        if decision == "deferred":
            raise ValueError("INVALID_TRANSITION: deferred approvals are not supported yet")
        event_type_by_decision = {
            "approved": "HUMAN_APPROVED",
            "rejected": "HUMAN_REJECTED",
        }
        try:
            event_type = event_type_by_decision[decision]
        except KeyError as exc:
            raise ValueError(f"INVALID_TRANSITION: unsupported approval decision {decision}") from exc

        actor_model = Actor.model_validate(actor)
        requested_by = Actor(id="runtime", type="system", source="runtime", trusted=True)
        return self._transition_run(
            run_id,
            event_type,
            node_id=node_id,
            actor=actor,
            payload={"comment": comment},
            expected_revision=expected_revision,
            now=now,
            after_accept=lambda result: self._approvals.save(
                id=f"{run_id}:approval:{node_id}:{result['emittedEvents'][0].revision}",
                run_id=run_id,
                node_id=node_id,
                status=decision,
                requested_by=requested_by,
                decided_by=actor_model,
                comment=comment,
                created_at=now,
                decided_at=now,
            ),
        )

    def submit_gate_result(
        self,
        run_id: str,
        *,
        node_id: str,
        gate_id: str,
        status: str,
        evidence: list[str],
        waiver_reason: str | None,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> RunProjection:
        if status == "waived" or waiver_reason is not None:
            raise ValueError("INVALID_TRANSITION: gate waiver is not supported yet")
        event_type_by_status = {
            "passed": "GATE_PASSED",
            "failed": "GATE_FAILED",
        }
        try:
            event_type = event_type_by_status[status]
        except KeyError as exc:
            raise ValueError(f"INVALID_TRANSITION: unsupported gate status {status}") from exc

        evidence = [item.strip() for item in evidence if item.strip()]
        if not evidence:
            raise ValueError("MISSING_EVIDENCE: Gate decisions require evidence or waiverReason")

        actor_model = Actor.model_validate(actor)
        return self._transition_run(
            run_id,
            event_type,
            node_id=node_id,
            actor=actor,
            payload={"evidence": evidence, "waiverReason": waiver_reason, "gateId": gate_id},
            expected_revision=expected_revision,
            now=now,
            after_accept=lambda result: self._gate_results.save(
                id=f"{run_id}:gate:{node_id}:{gate_id}:{result['emittedEvents'][0].revision}",
                run_id=run_id,
                node_id=node_id,
                gate_id=gate_id,
                status=status,
                evidence=evidence,
                waiver_reason=waiver_reason,
                actor=actor_model,
                created_at=now,
            ),
        )

    def transition_run(
        self,
        run_id: str,
        event_type: str,
        *,
        node_id: str | None,
        actor: dict,
        expected_revision: str,
        now: str,
        payload: dict | None = None,
    ) -> RunProjection:
        if event_type == "ARTIFACT_SUBMITTED":
            raise ValueError("MISSING_ARTIFACT: use artifacts endpoint for artifact submissions")
        if event_type in {"HUMAN_APPROVED", "HUMAN_REJECTED"}:
            raise ValueError(
                "MISSING_APPROVAL: use typed governance service methods for approval decisions"
            )
        if event_type in {"GATE_PASSED", "GATE_FAILED"}:
            raise ValueError(
                "MISSING_GATE_RESULT: use typed governance service methods for gate results"
            )
        return self._transition_run(
            run_id,
            event_type,
            node_id=node_id,
            actor=actor,
            expected_revision=expected_revision,
            now=now,
            payload=payload,
        )

    def list_artifacts(self, run_id: str) -> list[dict]:
        self.get_projection(run_id)
        return self._artifacts.list_for_run(run_id)

    def list_approvals(self, run_id: str) -> list[dict]:
        self.get_projection(run_id)
        return self._approvals.list_for_run(run_id)

    def list_gate_results(self, run_id: str) -> list[dict]:
        self.get_projection(run_id)
        return self._gate_results.list_for_run(run_id)

    def start_agent_job(
        self,
        run_id: str,
        *,
        node_id: str,
        provider: str,
        prompt: str,
        actor: dict,
        now: str,
        allowed_tools: list[str] | None = None,
        timeout_seconds: float = 300,
        max_output_bytes: int = 1_000_000,
    ) -> dict:
        Actor.model_validate(actor)
        workflow = self._runs.workflow_for_run(run_id)
        if node_id not in {node.id for node in workflow.nodes}:
            raise ValueError(f"AGENT_UNKNOWN_NODE: Node not found in workflow: {node_id}")

        project_root = self._runs.project_root_for_run(run_id)
        cli_provider = self._agent_provider_factory(provider)
        command = cli_provider.build_command(
            cwd=project_root,
            prompt=prompt,
            allowed_tools=allowed_tools or [],
        )
        job_id = f"agent-job-{uuid4()}"
        output_sequence = 0

        def append_output(event: dict[str, Any]) -> None:
            nonlocal output_sequence
            output_sequence += 1
            with self._lock:
                self._agent_jobs.append_output(
                    id=f"{job_id}:output:{output_sequence}",
                    job_id=job_id,
                    sequence=output_sequence,
                    kind=event["kind"],
                    payload=event["payload"],
                    created_at=now,
                )
                self._db.commit()

        with self._lock:
            self._agent_jobs.create(
                id=job_id,
                run_id=run_id,
                node_id=node_id,
                provider=provider,
                status="QUEUED",
                command=[command.executable, *command.args],
                cwd=str(project_root),
                created_at=now,
            )
            self._db.commit()

        executor = CliAgentExecutor(provider=cli_provider, on_output=append_output)
        self._agent_executors[job_id] = executor
        try:
            result = executor.run(
                job_id=job_id,
                prompt=prompt,
                cwd=project_root,
                project_root=project_root,
                timeout_seconds=timeout_seconds,
                max_output_bytes=max_output_bytes,
                allowed_tools=allowed_tools or [],
            )
        finally:
            self._agent_executors.pop(job_id, None)

        with self._lock:
            self._agent_jobs.finish(
                id=job_id,
                status=result.status,
                summary=result.summary,
                error=result.error,
                updated_at=now,
            )
            self._db.commit()
            job = self._agent_jobs.get(job_id)
        if job is None:
            raise KeyError(f"Agent job not found: {job_id}")
        return job

    def list_agent_jobs(self, run_id: str) -> list[dict]:
        self.get_projection(run_id)
        return self._agent_jobs.list_for_run(run_id)

    def get_agent_job(self, run_id: str, job_id: str) -> dict:
        self.get_projection(run_id)
        job = self._agent_jobs.get(job_id)
        if job is None or job["runId"] != run_id:
            raise KeyError(f"Agent job not found: {job_id}")
        return job

    def list_agent_output(self, job_id: str, *, after_sequence: int = 0) -> list[dict]:
        if self._agent_jobs.get(job_id) is None:
            raise KeyError(f"Agent job not found: {job_id}")
        return self._agent_jobs.list_output(job_id, after_sequence=after_sequence)

    def cancel_agent_job(self, run_id: str, job_id: str) -> dict:
        job = self.get_agent_job(run_id, job_id)
        executor = self._agent_executors.get(job_id)
        if executor is not None:
            executor.cancel(job_id)
        return job

    def get_run(self, run_id: str) -> dict:
        return self.get_projection(run_id).model_dump()

    def timeline(self, run_id: str) -> list[dict]:
        self.get_projection(run_id)
        return [event.model_dump() for event in self._events.list_for_run(run_id)]

    def rebuild_projection(self, run_id: str, *, now: str) -> RunProjection:
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                workflow = self._runs.workflow_for_run(run_id)
                events = self._events.list_for_run(run_id)
                projection = rebuild_projection(run_id, workflow, events)
                self._projections.save(projection)
                self._db.commit()
                return projection
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise

    def _transition_run(
        self,
        run_id: str,
        event_type: str,
        *,
        node_id: str | None,
        actor: dict,
        expected_revision: str,
        now: str,
        payload: dict | None = None,
        after_accept: Callable[[dict[str, Any]], None] | None = None,
    ) -> RunProjection:
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                workflow = self._runs.workflow_for_run(run_id)
                events = self._events.list_for_run(run_id)
                event = RunEvent(
                    id=f"{run_id}:event:{len(events) + 1}",
                    runId=run_id,
                    type=event_type,
                    nodeId=node_id,
                    actor=Actor.model_validate(actor),
                    payload=payload or {},
                    createdAt=now,
                    revision="0",
                )
                result = transition(run_id, workflow, events, event, expected_revision)
                if not result["accepted"]:
                    self._db.rollback()
                    reason = result["blockingReasons"][0]
                    raise ValueError(f"{reason.code}: {reason.message}")

                next_sequence = len(events) + 1
                for emitted_event in result["emittedEvents"]:
                    self._events.append(emitted_event, next_sequence)
                    next_sequence += 1
                self._projections.save(result["run"])
                if after_accept is not None:
                    after_accept(result)
                self._db.commit()
                return result["run"]
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise

    def get_projection(self, run_id: str) -> RunProjection:
        projection = self._projections.get(run_id)
        if projection is None:
            raise KeyError(f"Projection not found: {run_id}")
        return projection


def _stable_id(prefix: str, value: str) -> str:
    return f"{prefix}-{uuid5(NAMESPACE_URL, value)}"


def _default_agent_provider(provider: str) -> CliProvider:
    if provider == "codex":
        return CodexCliProvider()
    if provider == "claude":
        return ClaudeCliProvider()
    raise ValueError(f"AGENT_PROVIDER_UNAVAILABLE: Unsupported agent provider: {provider}")
