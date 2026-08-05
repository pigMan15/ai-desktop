import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock, Thread
from typing import Any, Callable
from urllib.parse import unquote, urlparse
from uuid import uuid4, uuid5, NAMESPACE_URL

import yaml

from workflow_platform.adapters.registry import default_registry
from workflow_platform.artifacts.service import hash_artifact, render_artifact_path, validate_safe_path
from workflow_platform.compiler.compiler import compile_workflow
from workflow_platform.execution.cli import CliAgentExecutor
from workflow_platform.execution.agent_context import AgentContextBuilder
from workflow_platform.execution.deploy import DeployExecutor
from workflow_platform.execution.providers import ClaudeCliProvider, CliProvider, CodexCliProvider
from workflow_platform.governance.actors import require_trusted_human
from workflow_platform.governance.audit import AuditLog
from workflow_platform.kernel.projection import rebuild_projection
from workflow_platform.kernel.transition import transition
from workflow_platform.knowledge.service import LocalKnowledgeService
from workflow_platform.models import Actor, Role, RunEvent, RunProjection, WorkflowDefinition
from workflow_platform.terminals.redaction import normalize_terminal_output, redact_terminal_output
from workflow_platform.persistence.repositories import (
    AgentCheckpointRepository,
    AgentJobRepository,
    AgentSessionRepository,
    ApprovalRepository,
    ArtifactRepository,
    DeploymentRepository,
    GateResultRepository,
    KnowledgeSynthesisRepository,
    KnowledgeSynthesisOutputRepository,
    ProjectRepository,
    ProjectWorkflowBindingRepository,
    ProjectionRepository,
    RunEventRepository,
    RunRepository,
    TerminalSessionRepository,
    WorkspaceLeaseRepository,
    WorkflowVersionRepository,
    WorkflowAssetRepository,
    RoleAssetRepository,
)
from workflow_platform.runtime_errors import RuntimeContractError
from workflow_platform.workspaces import normalize_workspace_path


class WorkflowRuntimeService:
    def __init__(
        self,
        db: sqlite3.Connection,
        *,
        agent_provider_factory: Callable[[str], CliProvider] | None = None,
        maintenance_mode: bool = False,
    ) -> None:
        self._db = db
        self._projects = ProjectRepository(db)
        self._workflow_versions = WorkflowVersionRepository(db)
        self._workflow_assets = WorkflowAssetRepository(db)
        self._role_assets = RoleAssetRepository(db)
        self._workflow_bindings = ProjectWorkflowBindingRepository(db)
        self._runs = RunRepository(db)
        self._workspace_leases = WorkspaceLeaseRepository(db)
        self._events = RunEventRepository(db)
        self._projections = ProjectionRepository(db)
        self._artifacts = ArtifactRepository(db)
        self._approvals = ApprovalRepository(db)
        self._gate_results = GateResultRepository(db)
        self._terminals = TerminalSessionRepository(db)
        self._agent_jobs = AgentJobRepository(db)
        self._agent_sessions = AgentSessionRepository(db)
        self._agent_checkpoints = AgentCheckpointRepository(db)
        self._deployments = DeploymentRepository(db)
        self._knowledge_syntheses = KnowledgeSynthesisRepository(db)
        self._knowledge_synthesis_output = KnowledgeSynthesisOutputRepository(db)
        self._audit = AuditLog(db)
        self._lock = RLock()
        self._knowledge = LocalKnowledgeService(db, self._audit, lock=self._lock)
        self._adapter_registry = default_registry()
        self._agent_provider_factory = agent_provider_factory or _default_agent_provider
        self._maintenance_mode = maintenance_mode
        self._agent_executors: dict[str, CliAgentExecutor] = {}
        self._interactive_desktop_sessions: dict[str, str] = {}
        self._deploy_executors: dict[str, DeployExecutor] = {}
        self._knowledge_synthesis_executors: dict[str, CliAgentExecutor] = {}

    def import_project(self, project_path: Path, *, now: str) -> dict:
        project_path = project_path.resolve()
        detections = self._adapter_registry.detect(project_path)
        if not detections:
            detection = {
                "adapterId": None,
                "name": "No workflow detected",
                "score": 0,
                "diagnostics": ["未检测到工作流定义，请在工作流库中创建或选择工作流后绑定项目"],
            }
            workflow = None
        else:
            detection = detections[0]
            adapter = self._adapter_registry.adapter_for(detection.adapter_id)
            workflow = adapter.import_workflow(project_path)
        if workflow is not None:
            _require_valid_workflow(workflow)
        project_id = _stable_id("project", project_path.as_posix())
        workflow_version_id = None

        with self._lock:
            try:
                self._db.execute("BEGIN IMMEDIATE")
                self._projects.save(
                    id=project_id,
                    name=project_path.name,
                    root_path=project_path,
                    active_protocol=detection["adapterId"] if isinstance(detection, dict) else detection.adapter_id,
                    now=now,
                )
                if workflow is not None:
                    workflow_version_id = _stable_id(
                        "workflow-version", f"{project_id}:{workflow.id}:{workflow.version}"
                    )
                    content_hash = hashlib.sha256(
                        workflow.model_dump_json(by_alias=True).encode("utf-8")
                    ).hexdigest()
                    workflow_asset_id = _project_workflow_asset_id(project_id, workflow.id)
                    self._workflow_assets.save(
                        id=workflow_asset_id,
                        name=workflow.name,
                        is_builtin=False,
                        actor={"id": "adapter", "type": "adapter", "source": "adapter", "trusted": True},
                        now=now,
                        workflow_version_id=None,
                    )
                    self._workflow_versions.save(
                        workflow,
                        id=workflow_version_id,
                        project_id=project_id,
                        content_hash=content_hash,
                        workflow_asset_id=workflow_asset_id,
                        created_at=now,
                        adapter_id=detection["adapterId"] if isinstance(detection, dict) else detection.adapter_id,
                    )
                    self._workflow_assets.update_current_version(workflow_asset_id, workflow_version_id, now=now)
                    self._workflow_bindings.bind(
                        project_id=project_id,
                        workflow_id=workflow_asset_id,
                        workflow_version_id=workflow_version_id,
                        actor={"id": "adapter", "type": "adapter", "source": "adapter", "trusted": True},
                        now=now,
                    )
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise

        return {
            "projectId": project_id,
            "workflowVersionId": workflow_version_id,
            "workflowId": _project_workflow_asset_id(project_id, workflow.id) if workflow is not None else None,
            "workflowName": workflow.name if workflow is not None else None,
            "createdDefaultWorkflow": False,
            "workflowBindingStatus": "bound" if workflow is not None else "unbound",
            **(detection if isinstance(detection, dict) else detection.model_dump(by_alias=True)),
        }

    def create_run(
        self,
        project_id: str,
        workflow_version_id: str | None = None,
        *,
        title: str,
        task_goal: str | None = None,
        parameters: dict[str, Any] | None = None,
        execution_workspace: str | None = None,
        workspace_mode: str | None = None,
        actor: Actor | dict | None = None,
        idempotency_key: str | None = None,
        now: str,
    ) -> RunProjection:
        if self._maintenance_mode:
            raise RuntimeContractError(
                "RUN_REARCHITECTURE_MAINTENANCE",
                "Runtime is temporarily unavailable during Run migration",
                status=503,
            )
        if not 1 <= len(title) <= 120:
            raise RuntimeContractError(
                "INVALID_REQUEST",
                "Run title must contain between 1 and 120 characters",
                status=400,
            )
        if workspace_mode is not None and workspace_mode not in {"write", "read"}:
            raise RuntimeContractError(
                "INVALID_REQUEST",
                "Workspace mode must be 'write' or 'read'",
                status=400,
            )
        request_actor = (
            Actor.model_validate(actor)
            if actor is not None
            else Actor(id="runtime", type="system", source="runtime", trusted=True)
        )
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                result = self._create_run_in_transaction(
                    project_id,
                    workflow_version_id,
                    title=title,
                    task_goal=task_goal,
                    parameters=parameters,
                    execution_workspace=execution_workspace,
                    workspace_mode=workspace_mode,
                    actor=request_actor,
                    idempotency_key=idempotency_key,
                    now=now,
                )
                self._db.commit()
                return result
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise

    def _create_run_in_transaction(
        self,
        project_id: str,
        workflow_version_id: str | None = None,
        *,
        title: str,
        task_goal: str | None = None,
        parameters: dict[str, Any] | None = None,
        execution_workspace: str | None = None,
        workspace_mode: str | None = None,
        actor: Actor,
        idempotency_key: str | None = None,
        now: str,
    ) -> RunProjection:
        # Keep direct service callers from older integrations working while all
        # API callers must provide projectId. The fallback resolves the version's
        # owning project, never a global binding.
        if workflow_version_id is None and project_id.startswith("workflow-version-"):
            legacy_version = self._workflow_versions.metadata(project_id)
            if legacy_version is None:
                raise KeyError(f"Workflow version not found: {project_id}")
            workflow_version_id = project_id
            project_id = legacy_version["project_id"]
        if not self._projects.exists(project_id):
            raise KeyError(f"Project not found: {project_id}")
        binding = self._workflow_bindings.get(project_id)
        if binding is None:
            raise ValueError("PROJECT_WORKFLOW_UNBOUND: 请先为项目绑定工作流后再创建 Run")

        workflow_version_id = workflow_version_id or binding["workflow_version_id"]
        version = self._workflow_versions.metadata(workflow_version_id)
        if version is None:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")
        workflow = self._workflow_versions.get(workflow_version_id)
        if workflow is None:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")
        workflow = self._resolve_role_snapshots(workflow)
        _require_valid_workflow(workflow)

        asset = self._workflow_assets.get(binding["workflow_id"])
        if asset is None:
            raise ValueError("WORKFLOW_ASSET_NOT_FOUND: 工作流资产不存在")
        if asset["archived_at"] is not None:
            raise ValueError("WORKFLOW_ARCHIVED: 工作流已归档，无法创建新的 Run")
        if version["workflow_asset_id"] != binding["workflow_id"]:
            raise ValueError("PROJECT_WORKFLOW_BINDING_MISMATCH: 工作流版本不属于项目绑定资产")
        project_root_row = self._db.execute(
            "SELECT root_path FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if project_root_row is None:
            raise KeyError(f"Project not found: {project_id}")
        workspace_value = execution_workspace or project_root_row["root_path"]
        try:
            workspace = normalize_workspace_path(workspace_value)
        except ValueError as error:
            raise RuntimeContractError(
                "INVALID_REQUEST",
                "Execution workspace is invalid",
                status=400,
                details={"workspacePath": str(workspace_value)},
            ) from error
        resolved_workspace_mode = workspace_mode or "read"
        normalized_task_goal = (task_goal or "").strip()
        normalized_parameters = dict(parameters or {})
        request_hash = _run_request_hash(
            project_id=project_id,
            workflow_version_id=workflow_version_id,
            title=title,
            task_goal=normalized_task_goal,
            parameters=normalized_parameters,
            execution_workspace=workspace,
            workspace_mode=resolved_workspace_mode,
            actor=actor,
        )
        if idempotency_key:
            existing_key = self._db.execute(
                """
                SELECT run_id, request_hash, created_at
                FROM run_idempotency_keys
                WHERE project_id = ? AND idempotency_key = ?
                """,
                (project_id, idempotency_key),
            ).fetchone()
            if existing_key is not None:
                if _within_idempotency_window(existing_key["created_at"], now):
                    if existing_key["request_hash"] != request_hash:
                        raise RuntimeContractError(
                            "INVALID_REQUEST",
                            "Idempotency key was already used for a different request",
                            status=400,
                        )
                    existing_projection = self._projections.get(existing_key["run_id"])
                    if existing_projection is None:
                        raise RuntimeError(
                            "Idempotency key references a Run without a projection"
                        )
                    return existing_projection
                self._db.execute(
                    """
                    DELETE FROM run_idempotency_keys
                    WHERE project_id = ? AND idempotency_key = ?
                    """,
                    (project_id, idempotency_key),
                )
        run_id = _stable_id("run", f"{workflow_version_id}:{title}:{now}")
        context = {
            "taskGoal": normalized_task_goal,
            "parameters": normalized_parameters,
        }
        if execution_workspace:
            context["executionWorkspace"] = workspace
        created_event = RunEvent(
            id=f"{run_id}:event:1",
            runId=run_id,
            type="RUN_CREATED",
            nodeId=None,
            actor=actor,
            payload={
                "workflowVersionId": workflow_version_id,
                "title": title,
                "context": context,
                "workspaceMode": resolved_workspace_mode,
            },
            createdAt=now,
            revision="1",
        )
        projection = rebuild_projection(run_id, workflow, [created_event])

        if self._projects.is_archived(project_id):
            raise ValueError("PROJECT_ARCHIVED: 项目已归档，无法创建新的 Run")
        self._runs.save(
            id=run_id,
            project_id=project_id,
            workflow_version_id=workflow_version_id,
            title=title,
            status=projection.status,
            context=context,
            now=now,
            workflow_snapshot=workflow,
            execution_workspace=workspace,
            workspace_mode=resolved_workspace_mode,
        )
        try:
            self._workspace_leases.acquire(
                id=f"{run_id}:workspace-lease",
                project_id=project_id,
                run_id=run_id,
                workspace_path=workspace,
                mode=resolved_workspace_mode,
                acquired_at=now,
            )
        except ValueError as error:
            if str(error) != "WORKSPACE_LEASE_CONFLICT":
                raise
            occupants = self._workspace_leases.active_for_path(project_id, workspace)
            raise RuntimeContractError(
                "WORKSPACE_LEASE_CONFLICT",
                "Workspace is already leased",
                status=409,
                details={
                    "workspacePath": workspace,
                    "occupyingRunId": occupants[0]["runId"] if occupants else None,
                },
            ) from error
        self._events.append(created_event, 1)
        self._projections.save(projection)
        if idempotency_key:
            self._db.execute(
                """
                INSERT INTO run_idempotency_keys (
                    project_id, idempotency_key, run_id, request_hash, created_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (project_id, idempotency_key, run_id, request_hash, now),
            )

        return projection

    def get_scoped_run(self, project_id: str, run_id: str) -> dict:
        run = self._runs.get(project_id, run_id)
        if run is None:
            raise RuntimeContractError(
                "RUN_NOT_FOUND_IN_PROJECT",
                "Run was not found in this project",
                status=404,
            )
        return run

    def list_project_runs(
        self,
        project_id: str,
        *,
        statuses: list[str],
        workflow_version_id: str | None,
        workspace_path: str | None,
        query: str | None,
        cursor: str | None,
        limit: int,
    ) -> dict:
        if not self._projects.exists(project_id):
            raise RuntimeContractError(
                "RUN_NOT_FOUND_IN_PROJECT",
                "Project was not found",
                status=404,
            )
        return self._runs.list_summaries(
            project_id,
            statuses=statuses,
            workflow_version_id=workflow_version_id,
            workspace_path=workspace_path,
            query=query,
            cursor=cursor,
            limit=limit,
        )

    def get_scoped_projection(self, project_id: str, run_id: str) -> RunProjection:
        self.get_scoped_run(project_id, run_id)
        return self.get_projection(run_id)

    def get_scoped_overview(self, project_id: str, run_id: str) -> dict:
        run = self.get_scoped_run(project_id, run_id)
        projection = self.get_projection(run_id)
        lease = self._workspace_leases.get_for_run(run_id)
        return {"run": run, "projection": projection.model_dump(), "workspace": lease}

    def execute_scoped_action(
        self,
        project_id: str,
        run_id: str,
        *,
        action_id: str,
        expected_revision: str,
        actor: dict,
        payload: dict | None,
        now: str,
    ) -> RunProjection:
        projection = self.get_scoped_projection(project_id, run_id)
        if projection.revision != expected_revision:
            raise RuntimeContractError(
                "REVISION_CONFLICT",
                "Run revision does not match the current projection",
                status=409,
                details={"currentRevision": projection.revision},
            )
        action = next(
            (candidate for candidate in projection.allowedActions if candidate.id == action_id),
            None,
        )
        if action is None:
            raise RuntimeContractError(
                "INVALID_REQUEST", "Action is not currently allowed", status=409
            )
        return self.transition_run(
            run_id,
            action.eventType,
            node_id=action.nodeId,
            actor=actor,
            payload=payload,
            expected_revision=expected_revision,
            now=now,
        )

    def release_scoped_workspace(
        self, project_id: str, run_id: str, *, reason: str, now: str
    ) -> dict:
        projection = self.get_scoped_projection(project_id, run_id)
        if projection.status not in {"DONE", "ARCHIVED"}:
            raise RuntimeContractError(
                "WORKSPACE_LEASE_RELEASE_REJECTED",
                "Run is not in a terminal state",
                status=409,
            )
        active_agents = [
            job for job in self._agent_jobs.list_for_run(run_id)
            if job["status"] in {"QUEUED", "RUNNING"}
        ]
        active_terminals = [
            session for session in self._terminals.list_for_run(run_id)
            if session["status"].lower() in {"queued", "running"}
        ]
        active_deployments = [
            deployment for deployment in self._deployments.list_for_run(run_id)
            if deployment["status"] in {"QUEUED", "RUNNING"}
        ]
        if active_agents or active_terminals or active_deployments:
            raise RuntimeContractError(
                "WORKSPACE_LEASE_RELEASE_REJECTED",
                "Run still has active execution resources",
                status=409,
                details={
                    "activeAgentCount": len(active_agents),
                    "activeTerminalCount": len(active_terminals),
                    "activeDeploymentCount": len(active_deployments),
                },
            )
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                self._workspace_leases.transition(
                    run_id,
                    status="released",
                    reason=reason,
                    transitioned_at=now,
                )
                self._db.commit()
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise
        lease = self._workspace_leases.get_for_run(run_id)
        if lease is None:
            raise RuntimeError("Workspace lease disappeared after release")
        return lease

    def list_workflows(self) -> list[dict]:
        return [
            {
                "workflowId": item["workflow_id"],
                "name": item["name"],
                "isBuiltin": bool(item["is_builtin"]),
                "archivedAt": item["archived_at"],
                "updatedAt": item["updated_at"],
                "workflowVersionId": item["current_workflow_version_id"],
                "currentVersion": item["current_version"],
                "nodeCount": item["node_count"] or 0,
                "boundProjectCount": item["bound_project_count"],
            }
            for item in self._workflow_assets.list()
        ]

    def list_role_assets(self) -> list[dict]:
        result: list[dict] = []
        for item in self._role_assets.list_assets():
            definition = json.loads(item["definition_json"]) if item["definition_json"] else {}
            result.append({
                **definition,
                "id": item["id"],
                "name": item["name"],
                "isBuiltin": bool(item["is_builtin"]),
                "archivedAt": item["archived_at"],
                "updatedAt": item["updated_at"],
                "roleVersionId": item["current_role_version_id"],
                "version": item["version"],
            })
        return result

    def save_role_asset(self, *, definition: dict, is_builtin: bool, actor: dict, now: str) -> dict:
        editor = require_trusted_human(actor, operation="保存角色资产")
        role = Role.model_validate(definition)
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                version_id, version = self._role_assets.save(role, is_builtin=is_builtin, actor=editor.model_dump(by_alias=True), now=now)
                self._audit.record(actor=editor, action="role.version.created", resource=f"role:{role.id}", detail={"roleVersionId": version_id, "version": version}, created_at=now)
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
        return {"roleId": role.id, "roleVersionId": version_id, "version": version}

    def archive_role_asset(self, role_id: str, *, actor: dict, now: str) -> dict:
        editor = require_trusted_human(actor, operation="归档角色资产")
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                archived = self._role_assets.archive(role_id, now=now)
                if archived:
                    self._audit.record(actor=editor, action="role.archived", resource=f"role:{role_id}", detail={}, created_at=now)
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
        return {"roleId": role_id, "archived": archived, "archivedAt": now if archived else None}

    def restore_role_asset(self, role_id: str, *, actor: dict, now: str) -> dict:
        editor = require_trusted_human(actor, operation="恢复角色资产")
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                restored = self._role_assets.restore(role_id, now=now)
                if restored:
                    self._audit.record(actor=editor, action="role.restored", resource=f"role:{role_id}", detail={}, created_at=now)
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
        return {"roleId": role_id, "restored": restored}

    def delete_role_asset(self, role_id: str, *, actor: dict, now: str) -> dict:
        editor = require_trusted_human(actor, operation="删除角色资产")
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                deleted = self._role_assets.delete(role_id)
                if deleted:
                    self._audit.record(actor=editor, action="role.deleted", resource=f"role:{role_id}", detail={}, created_at=now)
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
        return {"roleId": role_id, "deleted": deleted}

    def list_role_version_history(self, role_id: str) -> list[dict]:
        if self._role_assets.get(role_id) is None:
            raise KeyError(f"Role not found: {role_id}")
        return [
            {"roleVersionId": item["id"], "version": item["version"], "createdAt": item["created_at"], "definition": json.loads(item["definition_json"])}
            for item in self._role_assets.list_versions(role_id)
        ]

    def list_role_references(self, role_id: str) -> list[dict]:
        if self._role_assets.get(role_id) is None:
            raise KeyError(f"Role not found: {role_id}")
        rows = self._db.execute(
            """
            SELECT versions.id AS workflow_version_id, versions.name AS workflow_name, versions.version AS workflow_version
            FROM workflow_versions AS versions
            WHERE EXISTS (
                SELECT 1 FROM json_each(json_extract(versions.definition_json, '$.roles')) AS role
                WHERE json_extract(role.value, '$.id') = ?
                  AND json_extract(role.value, '$.assetVersionId') IS NOT NULL
            )
            ORDER BY versions.created_at DESC, versions.id
            """,
            (role_id,),
        ).fetchall()
        return [{"workflowVersionId": row["workflow_version_id"], "workflowName": row["workflow_name"], "workflowVersion": row["workflow_version"]} for row in rows]

    def _resolve_role_snapshots(self, workflow: WorkflowDefinition) -> WorkflowDefinition:
        snapshots: list[Role] = []
        for role in workflow.roles:
            if not role.assetVersionId:
                snapshots.append(role)
                continue
            asset = self._role_assets.get(role.id)
            snapshot = self._role_assets.get_version(role.assetVersionId)
            if asset is None or snapshot is None or snapshot.id != role.id:
                raise ValueError(f"ROLE_VERSION_NOT_FOUND: 角色 {role.id} 的指定版本不可用")
            if asset["archived_at"] is not None:
                raise ValueError(f"ROLE_ARCHIVED: 角色 {role.id} 已归档，不能用于新工作流版本")
            snapshots.append(snapshot)
        return workflow.model_copy(update={"roles": snapshots})

    def create_workflow(self, *, definition: dict, is_builtin: bool, actor: dict, now: str) -> dict:
        creator = require_trusted_human(actor, operation="创建工作流")
        workflow = WorkflowDefinition.model_validate(definition)
        workflow = self._resolve_role_snapshots(workflow)
        _require_valid_workflow(workflow)
        if self._workflow_assets.get(workflow.id) is not None:
            raise ValueError(f"WORKFLOW_ALREADY_EXISTS: 工作流已存在：{workflow.id}")
        content_hash = hashlib.sha256(workflow.model_dump_json(by_alias=True).encode("utf-8")).hexdigest()
        version_id = _stable_id("workflow-version", f"workflow-library:{workflow.id}:{content_hash}:{now}")
        library_project_id = "project-workflow-library"
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                self._projects.save(
                    id=library_project_id,
                    name="Workflow Library",
                    root_path=Path.cwd(),
                    active_protocol="workflow-library",
                    now=now,
                )
                self._workflow_assets.save(
                    id=workflow.id,
                    name=workflow.name,
                    is_builtin=is_builtin,
                    actor=creator.model_dump(by_alias=True),
                    now=now,
                    workflow_version_id=None,
                )
                self._workflow_versions.save(
                    workflow,
                    id=version_id,
                    project_id=library_project_id,
                    content_hash=content_hash,
                    workflow_asset_id=workflow.id,
                    created_at=now,
                    adapter_id="workflow-library",
                )
                self._workflow_assets.update_current_version(workflow.id, version_id, now=now)
                self._audit.record(
                    actor=creator,
                    action="workflow.created",
                    resource=f"workflow:{workflow.id}",
                    detail={"workflowVersionId": version_id, "isBuiltin": is_builtin},
                    created_at=now,
                )
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
        return {"workflowId": workflow.id, "workflowVersionId": version_id, "isBuiltin": is_builtin}

    def copy_workflow_template(self, workflow_id: str, *, name: str, actor: dict, now: str) -> dict:
        copier = require_trusted_human(actor, operation="复制工作流模板")
        source = self._workflow_assets.get(workflow_id)
        if source is None:
            raise KeyError(f"Workflow not found: {workflow_id}")
        if source["archived_at"] is not None:
            raise ValueError("WORKFLOW_ARCHIVED: 已归档工作流不能复制")
        source_definition = self._workflow_versions.get(source["current_workflow_version_id"])
        if source_definition is None:
            raise KeyError(f"Workflow version not found: {source['current_workflow_version_id']}")
        copied = source_definition.model_copy(
            update={"id": f"workflow-{uuid4()}", "name": name.strip() or f"{source_definition.name} 副本", "version": "1"}
        )
        return self.create_workflow(
            definition=copied.model_dump(by_alias=True),
            is_builtin=False,
            actor=copier.model_dump(by_alias=True),
            now=now,
        )

    def archive_workflow(self, workflow_id: str, *, actor: dict, now: str) -> dict:
        archivist = require_trusted_human(actor, operation="归档工作流")
        asset = self._workflow_assets.get(workflow_id)
        if asset is None:
            raise KeyError(f"Workflow not found: {workflow_id}")
        if asset["is_builtin"]:
            raise ValueError("BUILTIN_WORKFLOW_READ_ONLY: 内置模板不可归档")
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                archived = self._workflow_assets.archive(workflow_id, now=now)
                if archived:
                    self._audit.record(actor=archivist, action="workflow.archived", resource=f"workflow:{workflow_id}", detail={}, created_at=now)
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
        return {"workflowId": workflow_id, "archived": archived, "archivedAt": now if archived else asset["archived_at"]}

    def delete_workflow(self, workflow_id: str, *, actor: dict, now: str) -> dict:
        deleter = require_trusted_human(actor, operation="删除工作流资产")
        asset = self._workflow_assets.get(workflow_id)
        if asset is None:
            raise KeyError(f"Workflow not found: {workflow_id}")
        if asset["is_builtin"]:
            raise ValueError("BUILTIN_WORKFLOW_READ_ONLY: 内置模板不可删除")
        binding = self._db.execute("SELECT 1 FROM project_workflow_bindings WHERE workflow_id = ? LIMIT 1", (workflow_id,)).fetchone()
        if binding is not None:
            raise ValueError("WORKFLOW_IN_USE: 工作流仍绑定项目，请先解除绑定")
        version_ids = [row["id"] for row in self._db.execute("SELECT id FROM workflow_versions WHERE workflow_asset_id = ?", (workflow_id,)).fetchall()]
        if version_ids:
            placeholders = ", ".join("?" for _ in version_ids)
            run = self._db.execute(f"SELECT 1 FROM runs WHERE workflow_version_id IN ({placeholders}) LIMIT 1", version_ids).fetchone()
            if run is not None:
                raise ValueError("WORKFLOW_HAS_RUNS: 工作流已有运行记录，不能直接删除")
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                deleted = self._workflow_assets.delete(workflow_id)
                if deleted:
                    self._audit.record(actor=deleter, action="workflow.deleted", resource=f"workflow:{workflow_id}", detail={}, created_at=now)
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
        return {"workflowId": workflow_id, "deleted": deleted}

    def get_project_workflow_binding(self, project_id: str) -> dict | None:
        if not self._projects.exists(project_id):
            raise KeyError(f"Project not found: {project_id}")
        binding = self._workflow_bindings.get(project_id)
        if binding is None:
            return None
        return {
            "projectId": binding["project_id"], "workflowId": binding["workflow_id"],
            "workflowVersionId": binding["workflow_version_id"], "actor": binding["actor"],
            "boundAt": binding["bound_at"], "workflowBindingStatus": "bound",
        }

    def bind_project_workflow(self, project_id: str, *, workflow_id: str, workflow_version_id: str, actor: dict, now: str) -> dict:
        binder = require_trusted_human(actor, operation="绑定项目工作流")
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                if not self._projects.exists(project_id):
                    raise KeyError(f"Project not found: {project_id}")
                if self._projects.is_archived(project_id):
                    raise ValueError("PROJECT_ARCHIVED: 项目已归档，不能绑定工作流")
                asset = self._workflow_assets.get(workflow_id)
                if asset is None:
                    raise KeyError(f"Workflow not found: {workflow_id}")
                if asset["archived_at"] is not None:
                    raise ValueError("WORKFLOW_ARCHIVED: 已归档工作流不能绑定项目")
                version = self._workflow_versions.metadata(workflow_version_id)
                if version is None:
                    raise KeyError(f"Workflow version not found: {workflow_version_id}")
                if version["workflow_asset_id"] != workflow_id:
                    raise ValueError("WORKFLOW_VERSION_OWNERSHIP_INVALID: 工作流版本不属于指定工作流")
                self._workflow_bindings.bind(project_id=project_id, workflow_id=workflow_id, workflow_version_id=workflow_version_id, actor=binder.model_dump(by_alias=True), now=now)
                self._audit.record(actor=binder, action="project.workflow.bound", resource=f"project:{project_id}", detail={"workflowId": workflow_id, "workflowVersionId": workflow_version_id}, created_at=now)
                self._db.commit()
            except Exception:
                self._db.rollback()
                raise
        return self.get_project_workflow_binding(project_id) or {}

    def archive_project(self, project_id: str, *, actor: dict, now: str) -> dict:
        archivist = require_trusted_human(actor, operation="归档项目")
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                archived = self._projects.archive(project_id, now=now)
                if archived:
                    self._audit.record(
                        actor=archivist,
                        action="project.archived",
                        resource=f"project:{project_id}",
                        detail={"projectId": project_id},
                        created_at=now,
                    )
                self._db.commit()

            except Exception:
                self._db.rollback()
                raise
        return {"projectId": project_id, "archived": True, "archivedAt": now}

    def list_runs_for_workflow_version(self, workflow_version_id: str) -> list[dict]:
        if self._workflow_versions.get(workflow_version_id) is None:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")
        with self._lock:
            return self._runs.list_for_workflow_version(workflow_version_id)

    def get_workflow_definition(self, workflow_version_id: str) -> dict:
        workflow = self._workflow_versions.get(workflow_version_id)
        if workflow is None:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")
        return workflow.model_dump(by_alias=True)

    def export_workflow_version(self, workflow_version_id: str, *, format: str) -> dict[str, str]:
        workflow = self._workflow_versions.get(workflow_version_id)
        if workflow is None:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")

        definition = workflow.model_dump(by_alias=True)
        if format == "canonical-json":
            return {
                "fileName": f"{workflow.id}-{workflow.version}.json",
                "mediaType": "application/json",
                "content": json.dumps(definition, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            }
        if format == "generic-yaml":
            return {
                "fileName": f"{workflow.id}-{workflow.version}.yaml",
                "mediaType": "application/x-yaml",
                "content": yaml.safe_dump(
                    definition,
                    allow_unicode=True,
                    sort_keys=False,
                ),
            }
        raise ValueError(
            "WORKFLOW_EXPORT_FORMAT_INVALID: 仅支持 canonical-json 或 generic-yaml 导出格式"
        )

    def compile_workflow_version(self, workflow_version_id: str) -> dict:
        workflow = self._workflow_versions.get(workflow_version_id)
        if workflow is None:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")
        return compile_workflow(workflow)

    def simulate_workflow_version(self, workflow_version_id: str) -> dict:
        workflow = self._workflow_versions.get(workflow_version_id)
        if workflow is None:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")
        compiled = compile_workflow(workflow)
        blocked = len(compiled["diagnostics"]) > 0
        incoming_node_ids = {edge.to for edge in workflow.edges}
        return {
            "workflowVersionId": workflow_version_id,
            "status": "blocked" if blocked else "ready",
            "diagnostics": compiled["diagnostics"],
            "steps": [
                {
                    "nodeId": node.id,
                    "state": "BLOCKED"
                    if blocked
                    else ("READY" if node.id not in incoming_node_ids else "PENDING"),
                }
                for node in workflow.nodes
            ],
        }

    def list_workflow_version_history(self, workflow_version_id: str) -> list[dict]:
        history = self._workflow_versions.list_history(workflow_version_id)
        if not history:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")
        return [
            {
                "id": entry["id"],
                "name": entry["name"],
                "version": entry["version"],
                "contentHash": entry["contentHash"],
                "createdAt": entry["createdAt"],
                "nodeCount": len(entry["definition"].nodes),
                "edgeCount": len(entry["definition"].edges),
                "nodeSummary": _workflow_node_summary(entry["definition"]),
            }
            for entry in history
        ]

    def diff_workflow_versions(
        self,
        workflow_version_id: str,
        *,
        against_workflow_version_id: str,
    ) -> dict:
        target = self._workflow_versions.get(workflow_version_id)
        baseline = self._workflow_versions.get(against_workflow_version_id)
        if target is None or baseline is None:
            raise KeyError("Workflow version not found")
        if target.id != baseline.id:
            raise ValueError("WORKFLOW_VERSION_MISMATCH: 只能比较同一工作流的版本")

        return {
            "fromVersionId": against_workflow_version_id,
            "toVersionId": workflow_version_id,
            "addedNodes": _added_items(baseline.nodes, target.nodes),
            "removedNodes": _added_items(target.nodes, baseline.nodes),
            "changedNodes": _changed_items(baseline.nodes, target.nodes),
            "addedEdges": _added_items(baseline.edges, target.edges),
            "removedEdges": _added_items(target.edges, baseline.edges),
            "changedEdges": _changed_items(baseline.edges, target.edges),
        }

    def save_workflow_version(
        self,
        workflow_version_id: str,
        *,
        definition: dict,
        actor: dict,
        now: str,
    ) -> dict:
        base = self._workflow_versions.get(workflow_version_id)
        if base is None:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")
        version_metadata = self._workflow_versions.metadata(workflow_version_id)
        asset = self._workflow_assets.get(version_metadata["workflow_asset_id"]) if version_metadata else None
        if asset is None:
            raise ValueError("WORKFLOW_ASSET_NOT_FOUND: 工作流资产不存在")
        if asset is not None and asset["is_builtin"]:
            raise ValueError("BUILTIN_WORKFLOW_READ_ONLY: 内置模板只能复制后编辑")
        editor = require_trusted_human(actor, operation="保存工作流版本")
        candidate = self._resolve_role_snapshots(WorkflowDefinition.model_validate(definition))
        _require_valid_workflow(candidate)
        if candidate.id != base.id:
            raise ValueError("WORKFLOW_ID_IMMUTABLE: 新版本不能更改工作流标识")

        draft_hash = hashlib.sha256(
            candidate.model_dump_json(by_alias=True).encode("utf-8")
        ).hexdigest()
        version = f"{base.version}+{draft_hash[:8]}"
        saved_definition = candidate.model_copy(
            update={"version": version, "sourceAdapter": base.sourceAdapter}
        )
        content_hash = hashlib.sha256(
            saved_definition.model_dump_json(by_alias=True).encode("utf-8")
        ).hexdigest()
        row = self._db.execute(
            "SELECT project_id, adapter_id FROM workflow_versions WHERE id = ?",
            (workflow_version_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"Workflow version not found: {workflow_version_id}")
        new_version_id = _stable_id(
            "workflow-version",
            f"{row['project_id']}:{saved_definition.id}:{content_hash}:{now}",
        )

        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                self._workflow_versions.save(
                    saved_definition,
                    id=new_version_id,
                    project_id=row["project_id"],
                    content_hash=content_hash,
                    workflow_asset_id=asset["id"],
                    created_at=now,
                    adapter_id=row["adapter_id"],
                )
                self._workflow_assets.update_current_version(asset["id"], new_version_id, now=now)
                self._audit.record(
                    actor=editor,
                    action="workflow.version.created",
                    resource=f"workflow-version:{new_version_id}",
                    detail={
                        "parentWorkflowVersionId": workflow_version_id,
                        "workflowId": saved_definition.id,
                        "version": saved_definition.version,
                        "contentHash": content_hash,
                    },
                    created_at=now,
                )
                self._db.commit()
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise

        return {
            "workflowVersionId": new_version_id,
            "definition": saved_definition.model_dump(by_alias=True),
            "compiled": compile_workflow(saved_definition),
        }

    def submit_artifact(
        self,
        run_id: str,
        *,
        node_id: str,
        artifact_path: Path,
        artifact_type: str,
        artifact_spec_id: str | None = None,
        artifact_status: str = "verified",
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> RunProjection:
        self._assert_run_project_active(run_id)
        if artifact_status not in {"verified", "provisional"}:
            raise ValueError(f"ARTIFACT_STATUS_INVALID: unsupported artifact status {artifact_status}")
        workflow = self._runs.workflow_for_run(run_id)
        project_root = self._runs.project_root_for_run(run_id)
        execution_workspace = self._runs.execution_workspace_for_run(run_id)
        safe_path = validate_safe_path(execution_workspace, artifact_path)
        node = next((candidate for candidate in workflow.nodes if candidate.id == node_id), None)
        if node is None:
            raise ValueError(f"ARTIFACT_UNKNOWN_NODE: Node not found in workflow: {node_id}")
        if node.artifacts.outputs:
            artifact_spec_id = artifact_spec_id or _matching_artifact_spec_id(
                workflow=workflow,
                project_root=execution_workspace,
                run_id=run_id,
                node_id=node_id,
                artifact_path=safe_path,
                artifact_type=artifact_type,
                now=now,
            )
            if artifact_spec_id is None:
                raise ValueError(
                    "ARTIFACT_SPEC_MISMATCH: declared artifacts must match a configured path and type"
                )
        artifact_uri = safe_path.as_uri()
        content_hash = hash_artifact(safe_path)
        before_hashes = self._artifacts.verified_hashes_for_node(run_id=run_id, node_id=node_id)
        artifact_metadata = {
            "run_id": run_id,
            "node_id": node_id,
            "type": artifact_type,
            "uri": artifact_uri,
            "content_hash": content_hash,
            "producer": Actor.model_validate(actor),
            "created_at": now,
            "artifact_spec_id": artifact_spec_id,
            "workflow_version_id": workflow.id,
            "template_path": next(
                (output.templatePath for output in node.artifacts.outputs if output.id == artifact_spec_id),
                None,
            ),
            "relative_path": safe_path.relative_to(execution_workspace.resolve()).as_posix(),
            "file_size": safe_path.stat().st_size,
            "media_type": _artifact_media_type(safe_path),
        }
        if artifact_status == "provisional":
            with self._lock, self._db:
                projection = self.get_projection(run_id)
                if projection.revision != expected_revision:
                    raise ValueError("REVISION_CONFLICT: Expected revision does not match current revision")
                provisional_id = f"{run_id}:artifact:{node_id}:provisional:{uuid4()}"
                self._artifacts.save(id=provisional_id, status="provisional", **artifact_metadata)
                self._audit.record(
                    actor={
                        "id": "runtime-artifact-scanner",
                        "type": "system",
                        "source": "runtime",
                        "trusted": True,
                    },
                    action="artifact.provisional.recorded",
                    resource=f"artifact:{provisional_id}",
                    detail={
                        "runId": run_id,
                        "nodeId": node_id,
                        "artifactSpecId": artifact_spec_id,
                        "producer": Actor.model_validate(actor).model_dump(),
                    },
                    created_at=now,
                )
            return projection
        projection = self._transition_run(
            run_id,
            "ARTIFACT_SUBMITTED",
            node_id=node_id,
            actor=actor,
            payload={
                "artifactUri": artifact_uri,
                "artifactType": artifact_type,
                "contentHash": content_hash,
                **({"artifactSpecId": artifact_spec_id} if artifact_spec_id else {}),
            },
            expected_revision=expected_revision,
            now=now,
            after_accept=lambda result: self._artifacts.save(
                id=f"{run_id}:artifact:{node_id}:{result['emittedEvents'][0].revision}",
                status="verified",
                **artifact_metadata,
            ),
        )
        projection = self._invalidate_artifact_decisions_if_changed(
            run_id=run_id,
            node_id=node_id,
            before_hashes=before_hashes,
            projection=projection,
            now=now,
        )
        return self._evaluate_automatic_gate(run_id, node_id=node_id, projection=projection, now=now)

    def scan_node_artifacts(
        self,
        run_id: str,
        *,
        node_id: str,
        expected_revision: str,
        now: str,
        artifact_status: str = "verified",
    ) -> dict:
        """Register declared artifact files without creating duplicate revisions for unchanged content."""
        self._assert_run_project_active(run_id)
        workflow = self._runs.workflow_for_run(run_id)
        node = next((candidate for candidate in workflow.nodes if candidate.id == node_id), None)
        if node is None:
            raise ValueError(f"ARTIFACT_UNKNOWN_NODE: Node not found in workflow: {node_id}")
        project_root = self._runs.execution_workspace_for_run(run_id)
        projection = self.get_projection(run_id)
        if projection.revision != expected_revision:
            raise ValueError("REVISION_CONFLICT: Expected revision does not match current revision")

        timeline = self.timeline(run_id)
        registered: list[str] = []
        unchanged: list[str] = []
        missing: list[str] = []
        invalid: list[dict[str, str]] = []
        revision = expected_revision
        scanner_actor = {
            "id": "runtime-artifact-scanner",
            "type": "system",
            "source": "runtime",
            "trusted": True,
        }

        for output in node.artifacts.outputs:
            try:
                target = render_artifact_path(
                    project_root,
                    output.path,
                    run_id=run_id,
                    node_id=node_id,
                    workflow_id=workflow.id,
                    artifact_id=output.id,
                    date=now[:10],
                )
                if not target.is_file():
                    missing.append(output.id)
                    continue
                content_hash = hash_artifact(target)
            except (OSError, ValueError) as error:
                invalid.append({"artifactSpecId": output.id, "reason": str(error)})
                continue

            already_registered = any(
                event["nodeId"] == node_id
                and event["type"] == "ARTIFACT_SUBMITTED"
                and event["payload"].get("artifactSpecId") == output.id
                and event["payload"].get("contentHash") == content_hash
                for event in timeline
            )
            if already_registered:
                unchanged.append(output.id)
                continue

            projection = self.submit_artifact(
                run_id,
                node_id=node_id,
                artifact_path=target,
                artifact_type=output.type,
                artifact_spec_id=output.id,
                artifact_status=artifact_status,
                actor=scanner_actor,
                expected_revision=revision,
                now=now,
            )
            revision = projection.revision
            registered.append(output.id)
            timeline = self.timeline(run_id)

        with self._lock:
            self._audit.record(
                actor=scanner_actor,
                action="artifact.node.scanned",
                resource=f"run:{run_id}:node:{node_id}",
                detail={
                    "registered": registered,
                    "unchanged": unchanged,
                    "missing": missing,
                    "invalid": invalid,
                },
                created_at=now,
            )
            self._db.commit()
        return {
            "runId": run_id,
            "nodeId": node_id,
            "registered": registered,
            "unchanged": unchanged,
            "missing": missing,
            "invalid": invalid,
            "projection": projection,
        }

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
        event_type_by_decision = {
            "approved": "HUMAN_APPROVED",
            "rejected": "HUMAN_REJECTED",
            "deferred": "HUMAN_DEFERRED",
        }
        try:
            event_type = event_type_by_decision[decision]
        except KeyError as exc:
            raise ValueError(f"INVALID_TRANSITION: unsupported approval decision {decision}") from exc

        actor_model = Actor.model_validate(actor)
        requested_by = Actor(id="runtime", type="system", source="runtime", trusted=True)
        artifact_hashes = self._artifacts.verified_hashes_for_node(run_id=run_id, node_id=node_id)
        projection = self._transition_run(
            run_id,
            event_type,
            node_id=node_id,
            actor=actor,
            payload={"comment": comment, "artifactHashes": artifact_hashes},
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
                artifact_hashes=artifact_hashes,
                created_at=now,
                decided_at=now,
            ),
        )
        return self._evaluate_automatic_gate(run_id, node_id=node_id, projection=projection, now=now)

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
        failure_reason: str | None = None,
    ) -> RunProjection:
        event_type_by_status = {
            "passed": "GATE_PASSED",
            "failed": "GATE_FAILED",
            "waived": "GATE_WAIVED",
        }
        try:
            event_type = event_type_by_status[status]
        except KeyError as exc:
            raise ValueError(f"INVALID_TRANSITION: unsupported gate status {status}") from exc

        evidence = [item.strip() for item in evidence if item.strip()]
        waiver_reason = waiver_reason.strip() if waiver_reason is not None else None
        failure_reason = failure_reason.strip() if failure_reason is not None else None
        if status == "waived":
            if not waiver_reason:
                raise ValueError("MISSING_EVIDENCE: Gate waivers require a non-empty waiverReason")
            if evidence:
                raise ValueError("INVALID_TRANSITION: Gate waivers cannot include pass/fail evidence")
        elif waiver_reason is not None:
            raise ValueError("INVALID_TRANSITION: waiverReason is only allowed for waived gates")
        elif not evidence:
            raise ValueError("MISSING_EVIDENCE: Gate decisions require evidence")
        elif status == "failed" and not failure_reason:
            raise ValueError("GATE_FAILURE_REASON_REQUIRED: failed gates require a non-empty failureReason")
        elif status != "failed" and failure_reason is not None:
            raise ValueError("INVALID_TRANSITION: failureReason is only allowed for failed gates")

        actor_model = Actor.model_validate(actor)
        artifact_hashes = self._artifacts.verified_hashes_for_node(run_id=run_id, node_id=node_id)
        return self._transition_run(
            run_id,
            event_type,
            node_id=node_id,
            actor=actor,
            payload={
                "evidence": evidence,
                "waiverReason": waiver_reason,
                "failureReason": failure_reason,
                "gateId": gate_id,
                "artifactHashes": artifact_hashes,
            },
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
                failure_reason=failure_reason,
                actor=actor_model,
                artifact_hashes=artifact_hashes,
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
        if event_type in {"HUMAN_APPROVED", "HUMAN_REJECTED", "HUMAN_DEFERRED"}:
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
        with self._lock:
            self.get_projection(run_id)
            return self._artifacts.list_for_run(run_id)

    def list_artifact_consumers(self, run_id: str, artifact_id: str) -> list[dict]:
        with self._lock:
            self.get_projection(run_id)
            return self._artifacts.list_consumers(run_id=run_id, artifact_id=artifact_id)

    def get_node_artifact_requirements(self, run_id: str, *, node_id: str, now: str) -> dict:
        workflow = self._runs.workflow_for_run(run_id)
        node = next((candidate for candidate in workflow.nodes if candidate.id == node_id), None)
        if node is None:
            raise ValueError(f"ARTIFACT_UNKNOWN_NODE: Node not found in workflow: {node_id}")
        project_root = self._runs.execution_workspace_for_run(run_id)
        artifacts = self._artifacts.list_for_run(run_id)
        requirements = []
        for output in node.artifacts.outputs:
            target = render_artifact_path(
                project_root, output.path, run_id=run_id, node_id=node_id,
                workflow_id=workflow.id, artifact_id=output.id, date=now[:10],
            )
            matching = [
                artifact for artifact in artifacts
                if artifact.get("artifactSpecId") == output.id and artifact.get("nodeId") == node_id
            ]
            requirements.append({
                "id": output.id,
                "name": output.name,
                "type": output.type,
                "required": output.required,
                "relativePath": target.relative_to(project_root.resolve()).as_posix(),
                "templatePath": output.templatePath,
                "description": output.description,
                "artifacts": matching,
            })
        return {"runId": run_id, "nodeId": node_id, "requirements": requirements}

    def get_node_context(self, run_id: str, *, node_id: str, now: str) -> dict:
        workflow = self._runs.workflow_for_run(run_id)
        project_root = self._runs.execution_workspace_for_run(run_id)
        context = AgentContextBuilder().build(
            workflow=workflow,
            node_id=node_id,
            node_states=self.get_projection(run_id).nodeStates,
            artifacts=self._artifacts.list_for_run(run_id),
            project_root=project_root,
        )
        return {
            "runId": run_id,
            "nodeId": node_id,
            "artifacts": context.artifacts,
            "prompt": context.prompt,
            "expectedArtifacts": _expected_artifacts(
                workflow=workflow,
                node_id=node_id,
                run_id=run_id,
                project_root=project_root,
                now=now,
            ),
        }

    def complete_node(
        self,
        run_id: str,
        *,
        node_id: str,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> RunProjection:
        return self._transition_run(
            run_id,
            "NODE_COMPLETED",
            node_id=node_id,
            actor=actor,
            expected_revision=expected_revision,
            now=now,
        )

    def confirm_artifact(
        self,
        run_id: str,
        *,
        node_id: str,
        artifact_id: str,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        confirmer = require_trusted_human(actor, operation="确认临时产物")
        existing = self._artifacts.get_for_run(run_id, artifact_id)
        if existing["nodeId"] != node_id:
            raise KeyError(f"artifact {artifact_id} was not found for node {node_id}")
        if existing["status"] != "provisional":
            raise ValueError("ARTIFACT_CONFIRMATION_INVALID: artifact is not provisional")
        projection = self._transition_run(
            run_id,
            "ARTIFACT_SUBMITTED",
            node_id=node_id,
            actor=confirmer.model_dump(),
            payload={
                "artifactUri": existing["uri"],
                "artifactType": existing["type"],
                "contentHash": existing["contentHash"],
                **({"artifactSpecId": existing["artifactSpecId"]} if existing["artifactSpecId"] else {}),
            },
            expected_revision=expected_revision,
            now=now,
            after_accept=lambda _result: self._artifacts.confirm(
                run_id=run_id, artifact_id=artifact_id, verified_at=now
            ),
        )
        artifact = self._artifacts.get_for_run(run_id, artifact_id)
        self._audit.record(
            actor=confirmer,
            action="artifact.confirmed",
            resource=f"artifact:{artifact_id}",
            detail={"runId": run_id, "nodeId": node_id, "contentHash": artifact["contentHash"]},
            created_at=now,
        )
        projection = self._evaluate_automatic_gate(run_id, node_id=node_id, projection=projection, now=now)
        return {"artifact": artifact, "projection": projection}

    def preview_artifact(self, run_id: str, artifact_id: str) -> dict:
        with self._lock:
            artifact = self._artifacts.get_for_run(run_id, artifact_id)
            project_root = self._runs.execution_workspace_for_run(run_id)
            safe_path = validate_safe_path(project_root, _file_uri_to_path(artifact["uri"]))
            size_bytes = safe_path.stat().st_size
            raw_content = safe_path.read_bytes()
            truncated = len(raw_content) > 262_144
            preview_bytes = raw_content[:262_144]
            current_hash = hash_artifact(safe_path)

            try:
                content = preview_bytes.decode("utf-8")
                if "\x00" in content:
                    content = None
            except UnicodeDecodeError:
                content = None

            return {
                "id": artifact["id"],
                "uri": artifact["uri"],
                "contentHash": artifact["contentHash"],
                "currentHash": current_hash,
                "integrity": "verified" if current_hash == artifact["contentHash"] else "changed",
                "mediaType": _artifact_media_type(safe_path),
                "sizeBytes": size_bytes,
                "truncated": truncated,
                "content": content,
            }

    def extract_artifacts_to_knowledge_syntheses(
        self,
        run_id: str,
        *,
        artifact_ids: list[str],
        provider: str,
        actor: dict,
        now: str,
    ) -> dict:
        reviewer = require_trusted_human(actor, operation="从产物启动知识 CLI 合成")
        if not artifact_ids or any(not isinstance(artifact_id, str) or not artifact_id.strip() for artifact_id in artifact_ids):
            raise ValueError("KNOWLEDGE_EXTRACTION_INPUT_INVALID: 至少选择一个有效产物。")
        if len(set(artifact_ids)) != len(artifact_ids):
            raise ValueError("KNOWLEDGE_EXTRACTION_INPUT_INVALID: 不能重复选择同一个产物。")

        prepared: list[tuple[dict, dict]] = []
        for artifact_id in artifact_ids:
            artifact = self._artifacts.get_for_run(run_id, artifact_id)
            if artifact["status"] != "verified":
                raise ValueError(f"KNOWLEDGE_EXTRACTION_ARTIFACT_INVALID: 产物未完成验证：{artifact_id}")
            preview = self.preview_artifact(run_id, artifact_id)
            if preview["integrity"] != "verified":
                raise ValueError(f"KNOWLEDGE_EXTRACTION_ARTIFACT_CHANGED: 产物内容已变化：{artifact_id}")
            if preview["truncated"]:
                raise ValueError(f"KNOWLEDGE_EXTRACTION_ARTIFACT_TRUNCATED: 产物超过可合成大小：{artifact_id}")
            if preview["content"] is None or not preview["content"].strip():
                raise ValueError(f"KNOWLEDGE_EXTRACTION_ARTIFACT_TEXT_REQUIRED: 产物必须是非空 UTF-8 文本：{artifact_id}")
            prepared.append((artifact, preview))

        items: list[dict] = []
        for artifact, preview in prepared:
            path = artifact.get("relativePath") or artifact["uri"]
            candidate = self._knowledge.create_candidate(
                title=artifact.get("artifactSpecId") or f"{artifact['type']} - {path}",
                content=preview["content"],
                source=f"run:{run_id}:artifact:{artifact['id']}",
                actor=reviewer.model_dump(),
                now=now,
            )
            self._knowledge.review_candidate(
                candidate["id"],
                decision="approved",
                actor=reviewer.model_dump(),
                comment="已验证产物由人工发起 CLI 提取；合成结果仍需人工审核后发布。",
                now=now,
            )
            synthesis = self.start_knowledge_synthesis(
                candidate["id"],
                provider=provider,
                actor=reviewer.model_dump(),
                now=now,
            )
            items.append({
                "artifactId": artifact["id"],
                "candidateId": candidate["id"],
                "synthesisId": synthesis["id"],
                "status": synthesis["status"],
            })

        return {"runId": run_id, "items": items}

    def get_evidence_package(self, run_id: str) -> dict:
        projection = self.get_projection(run_id)
        timeline = self.timeline(run_id)
        artifacts = self.list_artifacts(run_id)
        approvals = self.list_approvals(run_id)
        gates = self.list_gate_results(run_id)
        return {
            "schemaVersion": 1,
            "runId": run_id,
            "projection": projection.model_dump(),
            "timeline": timeline,
            "artifacts": artifacts,
            "approvals": approvals,
            "gates": gates,
        }

    def get_run_report(self, run_id: str) -> dict:
        package = self.get_evidence_package(run_id)
        projection = package["projection"]
        lines = [
            f"# Run 证据报告：{run_id}",
            "",
            "## 运行状态",
            "",
            f"- 状态：{projection['status']}",
            f"- 当前节点：{', '.join(projection['currentNodeIds']) or '无'}",
            f"- 修订版本：{projection['revision']}",
            f"- 事件数量：{len(package['timeline'])}",
            "",
            "## 产物",
            "",
        ]
        if package["artifacts"]:
            for artifact in package["artifacts"]:
                lines.extend(
                    [
                        f"- `{artifact['id']}`（{artifact['type']}）",
                        f"  - 位置：{artifact['uri']}",
                        f"  - 内容哈希：{artifact['contentHash']}",
                    ]
                )
        else:
            lines.append("- 无已登记产物。")

        lines.extend(["", "## 人工审批", ""])
        if package["approvals"]:
            for approval in package["approvals"]:
                lines.append(
                    f"- `{approval['nodeId']}`：{approval['status']}；"
                    f"意见：{approval.get('comment') or '无'}"
                )
        else:
            lines.append("- 无审批记录。")

        lines.extend(["", "## Gate 与证据", ""])
        if package["gates"]:
            for gate in package["gates"]:
                lines.append(f"- `{gate['gateId']}`：{gate['status']}")
                if gate.get("nodeId"):
                    lines.append(f"  - 节点：{gate['nodeId']}")
                actor = gate.get("actor") or {}
                if actor.get("id"):
                    lines.append(f"  - 执行者：{actor['id']}")
                if gate.get("createdAt"):
                    lines.append(f"  - 提交时间：{gate['createdAt']}")
                if gate.get("failureReason"):
                    lines.append(f"  - 失败原因：{gate['failureReason']}")
                if gate.get("waiverReason"):
                    lines.append(f"  - 豁免原因：{gate['waiverReason']}")
                for evidence in gate.get("evidence", []):
                    lines.append(f"  - 证据：{evidence}")
        else:
            lines.append("- 无 Gate 记录。")

        lines.extend(["", "## 事件时间线", ""])
        for event in package["timeline"]:
            lines.append(
                f"- {event['createdAt']} · {event['type']}"
                f"{f' · {event['nodeId']}' if event.get('nodeId') else ''}"
            )

        return {
            "fileName": f"{run_id}-evidence-report.md",
            "mediaType": "text/markdown",
            "content": "\n".join(lines) + "\n",
        }

    def list_approvals(self, run_id: str) -> list[dict]:
        with self._lock:
            self.get_projection(run_id)
            return self._approvals.list_for_run(run_id)

    def list_gate_results(self, run_id: str) -> list[dict]:
        with self._lock:
            self.get_projection(run_id)
            return self._gate_results.list_for_run(run_id)

    def register_terminal_session(
        self,
        run_id: str,
        *,
        node_id: str,
        kind: str,
        cwd: Path,
        pid: int | None,
        now: str,
    ) -> dict:
        if kind not in {"shell", "codex"}:
            raise ValueError(f"TERMINAL_KIND_INVALID: unsupported terminal kind {kind}")

        with self._lock:
            workflow = self._runs.workflow_for_run(run_id)
            if node_id not in {node.id for node in workflow.nodes}:
                raise ValueError(f"TERMINAL_UNKNOWN_NODE: Node not found in workflow: {node_id}")
            project_root = self._runs.execution_workspace_for_run(run_id)
            safe_cwd = validate_safe_path(project_root, cwd)
            session_id = f"terminal-session-{uuid4()}"
            project_id = self._runs.project_id_for_run(run_id)
            try:
                self._db.execute("BEGIN IMMEDIATE")
                self._terminals.save(
                    id=session_id,
                    project_id=project_id,
                    run_id=run_id,
                    node_id=node_id,
                    kind=kind,
                    status="running",
                    cwd=str(safe_cwd),
                    pid=pid,
                    created_at=now,
                    updated_at=now,
                )
                self._audit.record(
                    actor={
                        "id": "desktop-terminal",
                        "type": "system",
                        "source": "terminal",
                        "trusted": True,
                    },
                    action="terminal.session.started",
                    resource=f"terminal:{session_id}",
                    detail={"runId": run_id, "nodeId": node_id, "kind": kind, "cwd": str(safe_cwd)},
                    created_at=now,
                )
                self._db.commit()
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise

            return self._terminals.list_for_run(run_id)[-1]

    def list_terminal_sessions(self, run_id: str) -> list[dict]:
        with self._lock:
            self.get_projection(run_id)
            return self._terminals.list_for_run(run_id)

    def stop_terminal_session(self, run_id: str, session_id: str, *, now: str) -> dict:
        with self._lock:
            self.get_projection(run_id)
            try:
                self._db.execute("BEGIN IMMEDIATE")
                session = self._terminals.stop(run_id, session_id, updated_at=now)
                self._audit.record(
                    actor={
                        "id": "desktop-terminal",
                        "type": "system",
                        "source": "terminal",
                        "trusted": True,
                    },
                    action="terminal.session.stopped",
                    resource=f"terminal:{session_id}",
                    detail={"runId": run_id},
                    created_at=now,
                )
                self._db.commit()
                return session
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise

    def record_terminal_command_decision(
        self,
        run_id: str,
        session_id: str,
        *,
        decision: str,
        risk_level: str,
        command_summary: str,
        impact: str,
        actor: dict,
        now: str,
    ) -> dict:
        if decision not in {"approved", "rejected"}:
            raise ValueError("TERMINAL_COMMAND_DECISION_INVALID: 命令审批决定必须为 approved 或 rejected。")
        if risk_level != "high":
            raise ValueError("TERMINAL_COMMAND_RISK_INVALID: 终端命令审批仅接受 high 风险等级。")
        if not command_summary.strip():
            raise ValueError("TERMINAL_COMMAND_SUMMARY_INVALID: 命令摘要不能为空。")
        if not impact.strip():
            raise ValueError("TERMINAL_COMMAND_IMPACT_INVALID: 影响范围不能为空。")

        human_actor = require_trusted_human(actor, operation="批准或拒绝危险终端命令")
        with self._lock:
            self._terminal_session_for_run(run_id, session_id)
            try:
                self._db.execute("BEGIN IMMEDIATE")
                record = self._audit.record(
                    actor=human_actor,
                    action=f"terminal.command.{decision}",
                    resource=f"terminal:{session_id}",
                    detail={
                        "runId": run_id,
                        "sessionId": session_id,
                        "riskLevel": risk_level,
                        "commandSummary": redact_terminal_output(command_summary),
                        "impact": redact_terminal_output(impact),
                    },
                    created_at=now,
                )
                self._db.commit()
                return record
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise

    def append_terminal_output(
        self,
        run_id: str,
        session_id: str,
        *,
        stream: str,
        data: str,
        now: str,
    ) -> None:
        if stream not in {"stdout", "stderr"}:
            raise ValueError(f"TERMINAL_STREAM_INVALID: unsupported stream {stream}")
        if not data:
            raise ValueError("TERMINAL_OUTPUT_INVALID: terminal output cannot be empty")
        redacted_data = redact_terminal_output(data)

        with self._lock:
            self._terminal_session_for_run(run_id, session_id)
            output = self._terminals.list_output(session_id)
            sequence = len(output) + 1
            try:
                self._db.execute("BEGIN IMMEDIATE")
                self._terminals.append_output(
                    id=f"{session_id}:output:{sequence}",
                    session_id=session_id,
                    sequence=sequence,
                    stream=stream,
                    data=redacted_data,
                    created_at=now,
                )
                self._db.commit()
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise

    def list_terminal_output(
        self,
        run_id: str,
        session_id: str,
        *,
        after_sequence: int = 0,
    ) -> list[dict]:
        if after_sequence < 0:
            raise ValueError("TERMINAL_CURSOR_INVALID: output cursor must not be negative")
        with self._lock:
            self._terminal_session_for_run(run_id, session_id)
            return self._terminals.list_output(session_id, after_sequence=after_sequence)

    def export_terminal_output_as_evidence(
        self,
        run_id: str,
        session_id: str,
        *,
        actor: dict,
        now: str,
    ) -> dict:
        human_actor = require_trusted_human(actor, operation="导出终端证据")
        with self._lock:
            session = self._terminal_session_for_run(run_id, session_id)
            output = self._terminals.list_output(session_id)
            if not output:
                raise ValueError("TERMINAL_EVIDENCE_EMPTY: terminal session has no persisted output")

            first_sequence = output[0]["sequence"]
            last_sequence = output[-1]["sequence"]
            project_root = self._runs.execution_workspace_for_run(run_id)
            evidence_path = validate_safe_path(
                project_root,
                Path(".workflow-platform")
                / "evidence"
                / f"{session_id}-{first_sequence}-{last_sequence}.log",
            )
            evidence_path.parent.mkdir(parents=True, exist_ok=True)
            evidence_path.write_text(
                "".join(event["data"] for event in output),
                encoding="utf-8",
            )
            content_hash = hash_artifact(evidence_path)
            artifact_id = f"{run_id}:terminal-evidence:{session_id}:{last_sequence}"

            try:
                self._db.execute("BEGIN IMMEDIATE")
                self._artifacts.save(
                    id=artifact_id,
                    run_id=run_id,
                    node_id=session["nodeId"] or "terminal",
                    type="evidence",
                    uri=evidence_path.as_uri(),
                    content_hash=content_hash,
                    producer=human_actor,
                    created_at=now,
                )
                self._audit.record(
                    actor=human_actor,
                    action="terminal.output.evidence.created",
                    resource=f"artifact:{artifact_id}",
                    detail={
                        "runId": run_id,
                        "terminalSessionId": session_id,
                        "firstSequence": first_sequence,
                        "lastSequence": last_sequence,
                        "uri": evidence_path.as_uri(),
                        "contentHash": content_hash,
                    },
                    created_at=now,
                )
                self._db.commit()
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise

            artifact = self._artifacts.get_for_run(run_id, artifact_id)
            return artifact

    def create_knowledge_candidate(
        self,
        *,
        title: str,
        content: str,
        source: str,
        actor: dict,
        now: str,
    ) -> dict:
        return self._knowledge.create_candidate(
            title=title,
            content=content,
            source=source,
            actor=actor,
            now=now,
        )

    def list_knowledge_candidates(self, *, status: str | None = None) -> list[dict]:
        return self._knowledge.list_candidates(status=status)

    def review_knowledge_candidate(
        self,
        candidate_id: str,
        *,
        decision: str,
        actor: dict,
        comment: str | None,
        now: str,
    ) -> dict:
        return self._knowledge.review_candidate(
            candidate_id,
            decision=decision,
            actor=actor,
            comment=comment,
            now=now,
        )

    def publish_knowledge_candidate(
        self,
        candidate_id: str,
        *,
        actor: dict,
        now: str,
    ) -> dict:
        return self._knowledge.publish_candidate(candidate_id, actor=actor, now=now)

    def search_knowledge(self, query: str) -> list[dict]:
        return self._knowledge.search(query)

    def list_knowledge_documents(self) -> list[dict]:
        return self._knowledge.list_documents()

    def replay_knowledge_document(self, document_id: str) -> dict:
        return self._knowledge.replay_document(document_id)

    def export_knowledge_document(self, document_id: str) -> dict:
        return self._knowledge.export_document(document_id)

    def record_knowledge_git_publication(
        self,
        document_id: str,
        *,
        branch: str,
        relative_path: str,
        commit_hash: str,
        actor: dict,
        now: str,
    ) -> dict:
        return self._knowledge.record_git_publication(
            document_id,
            branch=branch,
            relative_path=relative_path,
            commit_hash=commit_hash,
            actor=actor,
            now=now,
        )

    def start_knowledge_synthesis(
        self,
        candidate_id: str,
        *,
        provider: str,
        actor: dict,
        now: str,
        timeout_seconds: float = 300,
        max_output_bytes: int = 1_000_000,
    ) -> dict:
        reviewer = require_trusted_human(actor, operation="启动知识合成")
        candidate = self._knowledge.get_candidate(candidate_id)
        if candidate["status"] != "approved" or candidate["publishedAt"]:
            raise ValueError("KNOWLEDGE_SYNTHESIS_NOT_READY: 只有未发布的已批准候选可以进行知识合成。")
        project_root = self._project_root_for_knowledge_source(candidate["source"])
        cli_provider = self._agent_provider_factory(provider)
        prompt = _knowledge_synthesis_prompt(candidate)
        command = cli_provider.build_command(cwd=project_root, prompt=prompt, allowed_tools=[])
        synthesis_id = f"knowledge-synthesis-{uuid4()}"
        output_sequence = 0

        def append_output(event: dict[str, Any]) -> None:
            nonlocal output_sequence
            output_sequence += 1
            with self._lock:
                self._knowledge_synthesis_output.append(
                    id=f"{synthesis_id}:output:{output_sequence}",
                    synthesis_id=synthesis_id,
                    sequence=output_sequence,
                    kind=event["kind"],
                    payload=event["payload"],
                    created_at=now,
                )
                self._db.commit()

        with self._lock:
            self._knowledge_syntheses.create(
                id=synthesis_id,
                candidate_id=candidate_id,
                provider=provider,
                prompt=prompt,
                created_at=now,
            )
            self._audit.record(
                actor=reviewer,
                action="knowledge.synthesis.started",
                resource=f"knowledge-synthesis:{synthesis_id}",
                detail={
                    "candidateId": candidate_id,
                    "provider": provider,
                    "command": [command.executable, *command.args[:3]],
                },
                created_at=now,
            )
            self._db.commit()

        def mark_running(_pid: int) -> None:
            with self._lock:
                self._knowledge_syntheses.set_running(id=synthesis_id, updated_at=now)
                self._db.commit()

        executor = CliAgentExecutor(
            provider=cli_provider,
            on_output=append_output,
            on_started=mark_running,
        )
        self._knowledge_synthesis_executors[synthesis_id] = executor

        def execute_synthesis() -> None:
            try:
                result = executor.run(
                    job_id=synthesis_id,
                    prompt=prompt,
                    cwd=project_root,
                    project_root=project_root,
                    timeout_seconds=timeout_seconds,
                    max_output_bytes=max_output_bytes,
                    allowed_tools=[],
                )
                status = result.status
                summary = result.summary
                error = result.error
            except Exception as exception:
                status = "FAILED"
                summary = None
                error = f"KNOWLEDGE_SYNTHESIS_EXECUTION_ERROR: {exception}"
            finally:
                self._knowledge_synthesis_executors.pop(synthesis_id, None)

            with self._lock:
                self._knowledge_syntheses.finish(
                    id=synthesis_id,
                    status=status,
                    summary=summary,
                    error=error,
                    updated_at=now,
                )
                self._audit.record(
                    actor={
                        "id": "runtime-knowledge-synthesis",
                        "type": "system",
                        "source": "runtime",
                        "trusted": True,
                    },
                    action=(
                        "knowledge.synthesis.completed"
                        if status == "COMPLETED"
                        else "knowledge.synthesis.failed"
                    ),
                    resource=f"knowledge-synthesis:{synthesis_id}",
                    detail={"candidateId": candidate_id, "error": error},
                    created_at=now,
                )
                self._db.commit()

        Thread(
            target=execute_synthesis,
            name=f"knowledge-synthesis-{synthesis_id}",
            daemon=True,
        ).start()
        synthesis = self._knowledge_syntheses.get(synthesis_id)
        if synthesis is None:
            raise KeyError(f"Knowledge synthesis not found: {synthesis_id}")
        return synthesis

    def list_knowledge_syntheses(self) -> list[dict]:
        with self._lock:
            return self._knowledge_syntheses.list()

    def list_knowledge_synthesis_output(
        self,
        synthesis_id: str,
        *,
        after_sequence: int = 0,
    ) -> list[dict]:
        if after_sequence < 0:
            raise ValueError("KNOWLEDGE_SYNTHESIS_OUTPUT_CURSOR_INVALID: 合成输出游标不能为负数。")
        with self._lock:
            if self._knowledge_syntheses.get(synthesis_id) is None:
                raise KeyError(f"KNOWLEDGE_SYNTHESIS_NOT_FOUND: 未找到知识合成任务 {synthesis_id}。")
            return self._knowledge_synthesis_output.list(
                synthesis_id,
                after_sequence=after_sequence,
            )

    def record_knowledge_synthesis_feedback(
        self,
        synthesis_id: str,
        *,
        feedback: str,
        actor: dict,
        now: str,
    ) -> dict:
        reviewer = require_trusted_human(actor, operation="提交知识合成反馈")
        normalized_feedback = feedback.strip()
        if not normalized_feedback:
            raise ValueError("KNOWLEDGE_SYNTHESIS_FEEDBACK_INVALID: 合成反馈不能为空。")
        with self._lock:
            synthesis = self._knowledge_syntheses.get(synthesis_id)
            if synthesis is None:
                raise KeyError(f"KNOWLEDGE_SYNTHESIS_NOT_FOUND: 未找到知识合成任务 {synthesis_id}。")
            self._knowledge_syntheses.set_feedback(
                id=synthesis_id,
                feedback=normalized_feedback,
                updated_at=now,
            )
            self._audit.record(
                actor=reviewer,
                action="knowledge.synthesis.feedback_recorded",
                resource=f"knowledge-synthesis:{synthesis_id}",
                detail={"candidateId": synthesis["candidateId"]},
                created_at=now,
            )
            self._db.commit()
            updated = self._knowledge_syntheses.get(synthesis_id)
        if updated is None:
            raise KeyError(f"KNOWLEDGE_SYNTHESIS_NOT_FOUND: 未找到知识合成任务 {synthesis_id}。")
        return updated

    def publish_knowledge_synthesis(self, synthesis_id: str, *, actor: dict, now: str) -> dict:
        synthesis = self._knowledge_syntheses.get(synthesis_id)
        if synthesis is None:
            raise KeyError(f"KNOWLEDGE_SYNTHESIS_NOT_FOUND: 未找到知识合成任务 {synthesis_id}。")
        if synthesis["status"] != "COMPLETED" or not synthesis["summary"]:
            raise ValueError("KNOWLEDGE_SYNTHESIS_NOT_COMPLETED: 只有成功的知识合成稿可以发布。")
        document = self._knowledge.publish_candidate(
            synthesis["candidateId"],
            actor=actor,
            now=now,
            content_override=synthesis["summary"],
        )
        with self._lock:
            self._audit.record(
                actor=require_trusted_human(actor, operation="发布知识合成稿"),
                action="knowledge.synthesis.published",
                resource=f"knowledge-synthesis:{synthesis_id}",
                detail={"documentId": document["id"]},
                created_at=now,
            )
            self._db.commit()
        return document

    def list_audit_records(
        self,
        *,
        actor_id: str | None = None,
        action: str | None = None,
        resource: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        if not 1 <= limit <= 200:
            raise ValueError("AUDIT_LIMIT_INVALID: 审计查询数量必须在 1 到 200 之间。")
        return self._audit.list(
            actor_id=actor_id,
            action=action,
            resource=resource,
            limit=limit,
        )

    def start_agent_job(
        self,
        run_id: str,
        *,
        node_id: str,
        provider: str,
        prompt: str,
        cwd: str | None = None,
        actor: dict,
        now: str,
        allowed_tools: list[str] | None = None,
        timeout_seconds: float = 300,
        max_output_bytes: int = 1_000_000,
        resumed_from_checkpoint_id: str | None = None,
        mode: str = "automatic",
        parent_job_id: str | None = None,
    ) -> dict:
        self._assert_run_project_active(run_id)
        if mode not in {"automatic", "interactive"}:
            raise ValueError(f"AGENT_MODE_INVALID: unsupported mode {mode}")
        if mode == "interactive":
            actor_model = require_trusted_human(actor, operation="启动交互式 Agent")
        else:
            actor_model = Actor.model_validate(actor)
        workflow = self._runs.workflow_for_run(run_id)
        if node_id not in {node.id for node in workflow.nodes}:
            raise ValueError(f"AGENT_UNKNOWN_NODE: Node not found in workflow: {node_id}")

        project_root = self._runs.project_root_for_run(run_id)
        configured_workspace = self._runs.execution_workspace_for_run(run_id)
        execution_cwd = validate_safe_path(project_root, cwd or configured_workspace)
        if not execution_cwd.is_dir():
            raise ValueError(f"AGENT_CWD_INVALID: Agent 工作目录不存在：{execution_cwd}")
        job_id = f"agent-job-{uuid4()}"
        effective_prompt, context_artifacts = _build_effective_agent_prompt(
            workflow=workflow,
            run_id=run_id,
            node_id=node_id,
            user_prompt=prompt,
            node_states=self.get_projection(run_id).nodeStates,
            artifacts=self._artifacts.list_for_run(run_id),
            project_root=configured_workspace,
            now=now,
        )
        cli_provider = self._agent_provider_factory(provider)
        safe_allowed_tools = allowed_tools or []
        command = cli_provider.build_command(
            cwd=execution_cwd,
            prompt=effective_prompt,
            allowed_tools=safe_allowed_tools,
        )
        checkpoint_id = f"agent-checkpoint-{uuid4()}" if mode == "automatic" else None
        session_id = f"agent-session-{uuid4()}" if mode == "interactive" else None
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

        with self._lock, self._db:
            self._agent_jobs.create(
                id=job_id,
                run_id=run_id,
                node_id=node_id,
                provider=provider,
                status="QUEUED",
                command=(
                    [redact_terminal_output(item) for item in [command.executable, *command.args]]
                    if mode == "interactive"
                    else [command.executable, *command.args]
                ),
                cwd=str(execution_cwd),
                created_at=now,
                mode=mode,
                session_id=session_id,
                parent_job_id=parent_job_id,
            )
            for artifact in context_artifacts:
                artifact_id = artifact.get("artifactId")
                if artifact_id:
                    self._artifacts.record_consumer(
                        id=f"{job_id}:consumer:{artifact_id}",
                        artifact_id=artifact_id,
                        consumer_run_id=run_id,
                        consumer_node_id=node_id,
                        agent_job_id=job_id,
                        context_created_at=now,
                    )
            if mode == "interactive":
                if session_id is None:
                    raise AssertionError("Interactive agent sessions require an id")
                self._agent_sessions.create(
                    id=session_id,
                    run_id=run_id,
                    job_id=job_id,
                    provider=provider,
                    cwd=str(execution_cwd),
                    max_output_bytes=max_output_bytes,
                    created_at=now,
                )
                self._agent_sessions.append_input(
                    id=f"{session_id}:input:1",
                    session_id=session_id,
                    sequence=1,
                    kind="initial_prompt",
                    content=redact_terminal_output(effective_prompt.strip()),
                    created_at=now,
                )
                self._audit.record(
                    actor=actor_model,
                    action="agent.interactive.created",
                    resource=f"agent-session:{session_id}",
                    detail={"runId": run_id, "jobId": job_id, "nodeId": node_id},
                    created_at=now,
                )
            else:
                if checkpoint_id is None:
                    raise AssertionError("Automatic agent checkpoints require an id")
                self._agent_checkpoints.create(
                    id=checkpoint_id,
                    run_id=run_id,
                    job_id=job_id,
                    parent_checkpoint_id=resumed_from_checkpoint_id,
                    node_id=node_id,
                    provider=provider,
                    prompt=effective_prompt,
                    allowed_tools=safe_allowed_tools,
                    timeout_seconds=timeout_seconds,
                    max_output_bytes=max_output_bytes,
                    status="running",
                    created_at=now,
                )
                self._audit.record(
                    actor={
                        "id": "runtime-agent",
                        "type": "system",
                        "source": "runtime",
                        "trusted": True,
                    },
                    action="agent.checkpoint.created",
                    resource=f"agent-checkpoint:{checkpoint_id}",
                    detail={"runId": run_id, "jobId": job_id, "nodeId": node_id},
                    created_at=now,
                )

        if mode == "interactive":
            with self._lock:
                job = self._agent_jobs.get(job_id)
            if job is None:
                raise KeyError(f"Agent job not found: {job_id}")
            return _agent_start_response(
                job=job,
                effective_prompt=effective_prompt,
                context_artifacts=context_artifacts,
                workflow=workflow,
                node_id=node_id,
                run_id=run_id,
                project_root=project_root,
                now=now,
            )

        def mark_running(pid: int) -> None:
            with self._lock:
                self._agent_jobs.set_running(id=job_id, pid=pid, updated_at=now)
                self._db.commit()

        executor = CliAgentExecutor(
            provider=cli_provider,
            on_output=append_output,
            on_started=mark_running,
        )
        self._agent_executors[job_id] = executor

        def execute_job() -> None:
            try:
                result = executor.run(
                    job_id=job_id,
                    prompt=effective_prompt,
                    cwd=execution_cwd,
                    project_root=project_root,
                    timeout_seconds=timeout_seconds,
                    max_output_bytes=max_output_bytes,
                    allowed_tools=safe_allowed_tools,
                )
                status = result.status
                summary = result.summary
                error = result.error
            except Exception as exception:
                status = "FAILED"
                summary = None
                error = f"AGENT_EXECUTION_ERROR: {exception}"
            finally:
                self._agent_executors.pop(job_id, None)

            with self._lock:
                self._agent_jobs.finish(
                    id=job_id,
                    status=status,
                    summary=summary,
                    error=error,
                    updated_at=now,
                )
                checkpoint_status = "completed" if status == "COMPLETED" else "recoverable"
                self._agent_checkpoints.update_for_job(
                    job_id=job_id,
                    status=checkpoint_status,
                    recovery_reason=error,
                    updated_at=now,
                )
                if checkpoint_status == "recoverable":
                    self._audit.record(
                        actor={
                            "id": "runtime-agent",
                            "type": "system",
                            "source": "runtime",
                            "trusted": True,
                        },
                        action="agent.checkpoint.recoverable",
                        resource=f"agent-checkpoint:{checkpoint_id}",
                        detail={"runId": run_id, "jobId": job_id, "reason": error},
                        created_at=now,
                    )
                self._db.commit()

            self._scan_completed_agent_artifacts(
                run_id=run_id,
                node_id=node_id,
                job_id=job_id,
                status=status,
                now=now,
            )

        Thread(target=execute_job, name=f"workflow-agent-{job_id}", daemon=True).start()
        with self._lock:
            job = self._agent_jobs.get(job_id)
        if job is None:
            raise KeyError(f"Agent job not found: {job_id}")
        return _agent_start_response(
            job=job,
            effective_prompt=effective_prompt,
            context_artifacts=context_artifacts,
            workflow=workflow,
            node_id=node_id,
            run_id=run_id,
            project_root=project_root,
            now=now,
        )

    def start_interactive_agent_session(
        self,
        run_id: str,
        job_id: str,
        *,
        desktop_session_id: str,
        pid: int,
        actor: dict,
        now: str,
    ) -> dict:
        human_actor = require_trusted_human(actor, operation="启动交互式 Agent 会话")
        if not desktop_session_id.strip() or pid <= 0:
            raise ValueError("AGENT_INTERACTIVE_SESSION_INVALID: desktop session and pid are required")
        with self._lock:
            with self._db:
                job, session = self._interactive_job_and_session(run_id, job_id)
                if session["status"] != "QUEUED":
                    raise ValueError(
                        "AGENT_INTERACTIVE_SESSION_STATE_INVALID: session is already active"
                    )
                self._agent_sessions.mark_running(
                    id=session["id"],
                    desktop_session_id=desktop_session_id,
                    pid=pid,
                    updated_at=now,
                )
                self._agent_jobs.set_running(id=job["id"], pid=pid, updated_at=now)
                self._audit.record(
                    actor=human_actor,
                    action="agent.interactive.session.started",
                    resource=f"agent-session:{session['id']}",
                    detail={
                        "runId": run_id,
                        "jobId": job_id,
                        "desktopSessionId": desktop_session_id,
                    },
                    created_at=now,
                )
                started = self._agent_sessions.get_for_job(job_id)
            if started is None:
                raise KeyError(f"Interactive agent session not found: {job_id}")
            self._interactive_desktop_sessions[job_id] = desktop_session_id
        return started

    def record_interactive_agent_input(
        self,
        run_id: str,
        job_id: str,
        *,
        content: str,
        actor: dict,
        now: str,
    ) -> dict:
        human_actor = require_trusted_human(actor, operation="记录交互式 Agent 输入")
        if "\x00" in content or not content.strip():
            raise ValueError("AGENT_INTERACTIVE_INPUT_INVALID: input cannot be blank or contain NUL")
        redacted_content = redact_terminal_output(content.strip())
        with self._lock, self._db:
            _job, session = self._interactive_job_and_session(run_id, job_id)
            if session["status"] != "RUNNING":
                raise ValueError("AGENT_INTERACTIVE_SESSION_STATE_INVALID: session is not running")
            sequence = len(self._agent_sessions.list_input(session["id"])) + 1
            recorded = {
                "id": f"{session['id']}:input:{sequence}",
                "sessionId": session["id"],
                "sequence": sequence,
                "kind": "human_input",
                "content": redacted_content,
                "createdAt": now,
            }
            self._agent_sessions.append_input(
                id=recorded["id"],
                session_id=session["id"],
                sequence=sequence,
                kind=recorded["kind"],
                content=recorded["content"],
                created_at=now,
            )
            self._audit.record(
                actor=human_actor,
                action="agent.interactive.input.recorded",
                resource=f"agent-session:{session['id']}",
                detail={"runId": run_id, "jobId": job_id, "sequence": sequence},
                created_at=now,
            )
        return recorded

    def list_agent_input(self, session_id: str) -> list[dict]:
        return self._agent_sessions.list_input(session_id)

    def append_interactive_agent_output(
        self,
        run_id: str,
        job_id: str,
        *,
        events: list[dict[str, str]],
        now: str,
    ) -> list[dict]:
        output_data: list[str] = []
        for event in events:
            data = event.get("data")
            if not isinstance(data, str) or not data:
                raise ValueError(
                    "AGENT_INTERACTIVE_OUTPUT_INVALID: event data must be a non-empty string"
                )
            output_data.append(normalize_terminal_output(data))
        with self._lock, self._db:
            _job, session = self._interactive_job_and_session(run_id, job_id)
            if session["status"] != "RUNNING":
                raise ValueError("AGENT_INTERACTIVE_SESSION_STATE_INVALID: session is not running")
            current_output = self._agent_jobs.list_output(job_id)
            output_data = [redact_terminal_output(data) for data in output_data]
            max_output_bytes = session["maxOutputBytes"]
            output_data, incoming_truncated = _limit_output_batch_bytes(
                output_data,
                max_output_bytes,
            )
            current_bytes = sum(
                len(str(event["payload"].get("text", "")).encode("utf-8"))
                for event in current_output
            )
            incoming_bytes = sum(len(data.encode("utf-8")) for data in output_data)
            removed_output_ids: list[str] = []
            for event in current_output:
                if current_bytes + incoming_bytes <= max_output_bytes:
                    break
                removed_output_ids.append(event["id"])
                current_bytes -= len(str(event["payload"].get("text", "")).encode("utf-8"))
            if removed_output_ids:
                self._agent_jobs.delete_output(removed_output_ids)
            if removed_output_ids or incoming_truncated:
                self._audit.record(
                    actor={
                        "id": "runtime-agent",
                        "type": "system",
                        "source": "runtime",
                        "trusted": True,
                    },
                    action="agent.interactive.output.persistence_limited",
                    resource=f"agent-session:{session['id']}",
                    detail={
                        "runId": run_id,
                        "jobId": job_id,
                        "reason": "AGENT_OUTPUT_HISTORY_TRIMMED",
                        "removedEvents": len(removed_output_ids),
                        "incomingTruncated": incoming_truncated,
                    },
                    created_at=now,
                )
            next_sequence = current_output[-1]["sequence"] + 1 if current_output else 1
            recorded = []
            for data in output_data:
                item = {
                    "id": f"{job_id}:output:{next_sequence}",
                    "jobId": job_id,
                    "sequence": next_sequence,
                    "kind": "terminal_raw",
                    "payload": {"text": data},
                    "createdAt": now,
                }
                self._agent_jobs.append_output(
                    id=item["id"],
                    job_id=job_id,
                    sequence=next_sequence,
                    kind=item["kind"],
                    payload=item["payload"],
                    created_at=now,
                )
                recorded.append(item)
                next_sequence += 1
        return recorded

    def finish_interactive_agent_session(
        self,
        run_id: str,
        job_id: str,
        *,
        status: str,
        summary: str | None,
        error: str | None,
        actor: dict,
        now: str,
    ) -> dict:
        human_actor = require_trusted_human(actor, operation="结束交互式 Agent 会话")
        if status not in {"COMPLETED", "FAILED", "CANCELLED", "RECOVERABLE"}:
            raise ValueError(f"AGENT_INTERACTIVE_SESSION_STATUS_INVALID: unsupported status {status}")
        with self._lock, self._db:
            job, session = self._interactive_job_and_session(run_id, job_id)
            if session["status"] not in {"QUEUED", "RUNNING"}:
                raise ValueError("AGENT_INTERACTIVE_SESSION_STATE_INVALID: session is already finished")
            redacted_summary = redact_terminal_output(summary) if summary else None
            redacted_error = redact_terminal_output(error) if error else None
            self._agent_sessions.finish(
                id=session["id"],
                status=status,
                recovery_reason=redacted_error if status == "RECOVERABLE" else None,
                ended_at=now,
            )
            self._agent_jobs.finish(
                id=job["id"],
                status="CANCELLED" if status == "RECOVERABLE" else status,
                summary=redacted_summary,
                error=redacted_error,
                updated_at=now,
            )
            self._audit.record(
                actor=human_actor,
                action="agent.interactive.session.finished",
                resource=f"agent-session:{session['id']}",
                detail={"runId": run_id, "jobId": job_id, "status": status},
                created_at=now,
            )
            finished = self._agent_sessions.get_for_job(job_id)
        if finished is None:
            raise KeyError(f"Interactive agent session not found: {job_id}")
        self._interactive_desktop_sessions.pop(job_id, None)
        self._scan_completed_agent_artifacts(
            run_id=run_id,
            node_id=job["nodeId"],
            job_id=job_id,
            status=status,
            now=now,
        )
        return finished

    def continue_interactive_agent(
        self,
        run_id: str,
        job_id: str,
        *,
        actor: dict,
        now: str,
    ) -> dict:
        require_trusted_human(actor, operation="继续交互式 Agent 会话")
        with self._lock, self._db:
            job, session = self._interactive_job_and_session(run_id, job_id)
            if session["status"] not in {"FAILED", "CANCELLED", "RECOVERABLE"}:
                raise ValueError("AGENT_INTERACTIVE_SESSION_STATE_INVALID: session is not continuable")
            history = self._agent_sessions.list_input(session["id"])
            output = self._agent_jobs.list_output(job_id)
        history_lines = [
            f"{'用户' if item['kind'] == 'human_input' else '提示'}：{item['content']}"
            for item in history
        ]
        history_lines.extend(
            f"Agent：{item['payload'].get('text', '')}"
            for item in output[-100:]
            if item["kind"] == "terminal_raw"
        )
        return self.start_agent_job(
            run_id,
            node_id=job["nodeId"],
            provider=job["provider"],
            prompt="历史交互记录：\n" + "\n".join(history_lines),
            cwd=job["cwd"],
            actor=actor,
            now=now,
            mode="interactive",
            parent_job_id=job_id,
        )

    def _scan_completed_agent_artifacts(
        self,
        *,
        run_id: str,
        node_id: str,
        job_id: str,
        status: str,
        now: str,
    ) -> None:
        if status != "COMPLETED":
            return
        try:
            projection = self.get_projection(run_id)
            result = self.scan_node_artifacts(
                run_id,
                node_id=node_id,
                expected_revision=projection.revision,
                now=now,
            )
            self._audit.record(
                actor={"id": "runtime-agent", "type": "system", "source": "runtime", "trusted": True},
                action="agent.artifacts.scanned",
                resource=f"agent-job:{job_id}",
                detail={
                    "runId": run_id,
                    "nodeId": node_id,
                    "registered": result["registered"],
                    "missing": result["missing"],
                },
                created_at=now,
            )
            self._db.commit()
        except Exception as error:
            self._audit.record(
                actor={"id": "runtime-agent", "type": "system", "source": "runtime", "trusted": True},
                action="agent.artifacts.scan_failed",
                resource=f"agent-job:{job_id}",
                detail={"runId": run_id, "nodeId": node_id, "reason": str(error)},
                created_at=now,
            )
            self._db.commit()

    def list_agent_jobs(self, run_id: str) -> list[dict]:
        with self._lock:
            self.get_projection(run_id)
            return self._agent_jobs.list_for_run(run_id)

    def list_agent_checkpoints(self, run_id: str) -> list[dict]:
        with self._lock:
            self.get_projection(run_id)
            return self._agent_checkpoints.list_for_run(run_id)

    def resume_agent_checkpoint(
        self,
        run_id: str,
        checkpoint_id: str,
        *,
        actor: dict,
        now: str,
    ) -> dict:
        human_actor = require_trusted_human(actor, operation="恢复 Agent checkpoint")
        with self._lock:
            checkpoint = self._agent_checkpoints.get(checkpoint_id)
            if checkpoint is None or checkpoint["runId"] != run_id:
                raise KeyError(f"Agent checkpoint not found: {checkpoint_id}")
            if checkpoint["status"] != "recoverable":
                raise ValueError("AGENT_CHECKPOINT_NOT_RECOVERABLE: checkpoint is not recoverable")
            self._agent_checkpoints.update_status(
                checkpoint_id=checkpoint_id,
                status="resumed",
                updated_at=now,
            )
            self._audit.record(
                actor=human_actor,
                action="agent.checkpoint.resumed",
                resource=f"agent-checkpoint:{checkpoint_id}",
                detail={"runId": run_id},
                created_at=now,
            )
            self._db.commit()

        return self.start_agent_job(
            run_id,
            node_id=checkpoint["nodeId"],
            provider=checkpoint["provider"],
            prompt=checkpoint["prompt"],
            actor=actor,
            now=now,
            allowed_tools=checkpoint["allowedTools"],
            timeout_seconds=checkpoint["timeoutSeconds"],
            max_output_bytes=checkpoint["maxOutputBytes"],
            resumed_from_checkpoint_id=checkpoint_id,
        )

    def discard_agent_checkpoint(
        self,
        run_id: str,
        checkpoint_id: str,
        *,
        actor: dict,
        now: str,
    ) -> dict:
        human_actor = require_trusted_human(actor, operation="放弃 Agent checkpoint")
        with self._lock:
            checkpoint = self._agent_checkpoints.get(checkpoint_id)
            if checkpoint is None or checkpoint["runId"] != run_id:
                raise KeyError(f"Agent checkpoint not found: {checkpoint_id}")
            if checkpoint["status"] != "recoverable":
                raise ValueError("AGENT_CHECKPOINT_NOT_RECOVERABLE: checkpoint is not recoverable")
            self._agent_checkpoints.update_status(
                checkpoint_id=checkpoint_id,
                status="discarded",
                updated_at=now,
            )
            self._audit.record(
                actor=human_actor,
                action="agent.checkpoint.discarded",
                resource=f"agent-checkpoint:{checkpoint_id}",
                detail={"runId": run_id},
                created_at=now,
            )
            self._db.commit()
            discarded = self._agent_checkpoints.get(checkpoint_id)
        if discarded is None:
            raise KeyError(f"Agent checkpoint not found: {checkpoint_id}")
        return discarded

    def get_agent_job(self, run_id: str, job_id: str) -> dict:
        self.get_projection(run_id)
        job = self._agent_jobs.get(job_id)
        if job is None or job["runId"] != run_id:
            raise KeyError(f"Agent job not found: {job_id}")
        return job

    def list_agent_output(self, job_id: str, *, after_sequence: int = 0) -> list[dict]:
        if self._agent_jobs.get(job_id) is None:
            raise KeyError(f"Agent job not found: {job_id}")
        return [
            {
                **event,
                "payload": {
                    key: normalize_terminal_output(value) if isinstance(value, str) else value
                    for key, value in event["payload"].items()
                },
            }
            for event in self._agent_jobs.list_output(job_id, after_sequence=after_sequence)
        ]

    def get_interactive_agent_session(self, run_id: str, job_id: str) -> dict:
        with self._lock:
            _job, session = self._interactive_job_and_session(run_id, job_id)
            return session

    def cancel_agent_job(
        self,
        run_id: str,
        job_id: str,
        *,
        actor: dict | None = None,
        now: str | None = None,
    ) -> dict:
        job = self.get_agent_job(run_id, job_id)
        executor = self._agent_executors.get(job_id)
        if executor is not None:
            executor.cancel(job_id)
            return job
        if job["mode"] != "interactive" or job["status"] not in {"QUEUED", "RUNNING"}:
            return job

        human_actor = require_trusted_human(actor or {}, operation="取消交互式 Agent 会话")
        if not now:
            raise ValueError("AGENT_INTERACTIVE_SESSION_INVALID: cancellation time is required")

        with self._lock, self._db:
            current_job, session = self._interactive_job_and_session(run_id, job_id)
            if current_job["status"] not in {"QUEUED", "RUNNING"} or session["status"] not in {
                "QUEUED",
                "RUNNING",
            }:
                return current_job
            self._agent_sessions.finish(
                id=session["id"],
                status="CANCELLED",
                recovery_reason=None,
                ended_at=now,
            )
            self._agent_jobs.finish(
                id=job_id,
                status="CANCELLED",
                summary="交互式 Agent 会话已取消",
                error=None,
                updated_at=now,
            )
            self._audit.record(
                actor=human_actor,
                action="agent.interactive.session.cancelled",
                resource=f"agent-session:{session['id']}",
                detail={"runId": run_id, "jobId": job_id},
                created_at=now,
            )
            cancelled = self._agent_jobs.get(job_id)
        if cancelled is None:
            raise KeyError(f"Agent job not found: {job_id}")
        self._interactive_desktop_sessions.pop(job_id, None)
        return cancelled

    def start_deployment(
        self,
        run_id: str,
        *,
        node_id: str,
        actor: dict,
        expected_revision: str,
        now: str,
    ) -> dict:
        self._assert_run_project_active(run_id)
        human_actor = require_trusted_human(actor, operation="启动部署")
        workflow = self._runs.workflow_for_run(run_id)
        node = next((candidate for candidate in workflow.nodes if candidate.id == node_id), None)
        if node is None:
            raise ValueError(f"DEPLOY_UNKNOWN_NODE: 未找到部署节点 {node_id}。")
        if node.kind != "deploy":
            raise ValueError(f"DEPLOY_NODE_KIND_INVALID: 节点 {node_id} 不是 deploy 节点。")

        project_root = self._runs.project_root_for_run(run_id)
        execution_workspace = self._runs.execution_workspace_for_run(run_id)
        command, cwd, timeout_seconds, max_output_bytes = _deployment_configuration(node, execution_workspace)
        deployment_id = f"deployment-{uuid4()}"
        output_sequence = 0

        def append_output(data: str) -> None:
            nonlocal output_sequence
            output_sequence += 1
            with self._lock:
                self._deployments.append_output(
                    id=f"{deployment_id}:output:{output_sequence}",
                    deployment_id=deployment_id,
                    sequence=output_sequence,
                    data=redact_terminal_output(data),
                    created_at=now,
                )
                self._db.commit()

        def mark_running(pid: int) -> None:
            with self._lock:
                self._deployments.set_running(id=deployment_id, pid=pid, updated_at=now)
                self._db.commit()

        self._transition_run(
            run_id,
            "NODE_STARTED",
            node_id=node_id,
            actor=human_actor.model_dump(),
            expected_revision=expected_revision,
            now=now,
            after_accept=lambda _result: self._record_deployment_started(
                deployment_id=deployment_id,
                run_id=run_id,
                node_id=node_id,
                command=command,
                cwd=cwd,
                actor=human_actor,
                now=now,
            ),
        )

        executor = DeployExecutor(on_output=append_output, on_started=mark_running)
        self._deploy_executors[deployment_id] = executor

        def execute_deployment() -> None:
            try:
                result = executor.run(
                    deployment_id=deployment_id,
                    command=command,
                    cwd=cwd,
                    timeout_seconds=timeout_seconds,
                    max_output_bytes=max_output_bytes,
                )
            except Exception as exception:
                result_status = "FAILED"
                summary = None
                error = f"DEPLOY_EXECUTION_ERROR: {exception}"
                output = ""
            else:
                result_status = result.status
                summary = redact_terminal_output(result.summary) if result.summary else None
                error = redact_terminal_output(result.error) if result.error else None
                output = redact_terminal_output(result.output)
            finally:
                self._deploy_executors.pop(deployment_id, None)

            try:
                log_path = validate_safe_path(
                    execution_workspace,
                    Path(".workflow-platform") / "deployments" / f"{deployment_id}.log",
                )
                log_path.parent.mkdir(parents=True, exist_ok=True)
                log_path.write_text(output, encoding="utf-8")
                content_hash = hash_artifact(log_path)
                executor_actor = {
                    "id": "runtime-deploy-executor",
                    "type": "executor",
                    "source": "runtime",
                    "trusted": True,
                }
                expected = self.get_projection(run_id).revision
                if result_status == "COMPLETED":
                    self._transition_run(
                        run_id,
                        "NODE_COMPLETED",
                        node_id=node_id,
                        actor=executor_actor,
                        payload={
                            "deploymentId": deployment_id,
                            "artifactUri": log_path.as_uri(),
                            "artifactType": "deploy-log",
                            "contentHash": content_hash,
                        },
                        expected_revision=expected,
                        now=now,
                        after_accept=lambda result: self._record_deployment_finished(
                            deployment_id=deployment_id,
                            run_id=run_id,
                            node_id=node_id,
                            status=result_status,
                            summary=summary,
                            error=None,
                            log_path=log_path,
                            content_hash=content_hash,
                            actor=executor_actor,
                            now=now,
                            event_revision=result["emittedEvents"][0].revision,
                        ),
                    )
                else:
                    self._transition_run(
                        run_id,
                        "NODE_FAILED",
                        node_id=node_id,
                        actor=executor_actor,
                        payload={
                            "deploymentId": deployment_id,
                            "artifactUri": log_path.as_uri(),
                            "artifactType": "deploy-log",
                            "contentHash": content_hash,
                            "error": error,
                        },
                        expected_revision=expected,
                        now=now,
                        after_accept=lambda result: self._record_deployment_finished(
                            deployment_id=deployment_id,
                            run_id=run_id,
                            node_id=node_id,
                            status=result_status,
                            summary=None,
                            error=error,
                            log_path=log_path,
                            content_hash=content_hash,
                            actor=executor_actor,
                            now=now,
                            event_revision=result["emittedEvents"][0].revision,
                        ),
                    )
            except Exception as exception:
                with self._lock:
                    self._deployments.finish(
                        id=deployment_id,
                        status="FAILED",
                        summary=None,
                        error=f"DEPLOY_FINALIZATION_ERROR: {exception}",
                        updated_at=now,
                    )
                    self._db.commit()

        Thread(
            target=execute_deployment,
            name=f"workflow-deployment-{deployment_id}",
            daemon=True,
        ).start()
        deployment = self._deployments.get(deployment_id)
        if deployment is None:
            raise KeyError(f"Deployment not found: {deployment_id}")
        return deployment

    def list_deployments(self, run_id: str) -> list[dict]:
        with self._lock:
            self.get_projection(run_id)
            return self._deployments.list_for_run(run_id)

    def get_deployment(self, run_id: str, deployment_id: str) -> dict:
        self.get_projection(run_id)
        deployment = self._deployments.get(deployment_id)
        if deployment is None or deployment["runId"] != run_id:
            raise KeyError(f"Deployment not found: {deployment_id}")
        return deployment

    def list_deployment_output(
        self,
        run_id: str,
        deployment_id: str,
        *,
        after_sequence: int = 0,
    ) -> list[dict]:
        if after_sequence < 0:
            raise ValueError("DEPLOY_OUTPUT_CURSOR_INVALID: 部署输出游标不能为负数。")
        self.get_deployment(run_id, deployment_id)
        return self._deployments.list_output(deployment_id, after_sequence=after_sequence)

    def cancel_deployment(self, run_id: str, deployment_id: str, *, actor: dict, now: str) -> dict:
        human_actor = require_trusted_human(actor, operation="取消部署")
        deployment = self.get_deployment(run_id, deployment_id)
        if deployment["status"] not in {"QUEUED", "RUNNING"}:
            raise ValueError("DEPLOY_NOT_ACTIVE: 只能取消正在等待或运行中的部署。")
        executor = self._deploy_executors.get(deployment_id)
        if executor is not None:
            executor.cancel(deployment_id)
        with self._lock:
            self._audit.record(
                actor=human_actor,
                action="deployment.cancel.requested",
                resource=f"deployment:{deployment_id}",
                detail={"runId": run_id, "nodeId": deployment["nodeId"]},
                created_at=now,
            )
            self._db.commit()
        return self.get_deployment(run_id, deployment_id)

    def get_run(self, run_id: str) -> dict:
        return self.get_projection(run_id).model_dump()

    def timeline(self, run_id: str) -> list[dict]:
        with self._lock:
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

    def get_recovery_diagnostics(self, run_id: str) -> dict:
        with self._lock:
            self._runs.workflow_for_run(run_id)
            projection = self._projections.get(run_id)
            if projection is None:
                raise KeyError(f"Projection not found: {run_id}")
            events = self._events.list_for_run(run_id)
            jobs = self._agent_jobs.list_for_run(run_id)
            terminal_sessions = self._terminals.list_for_run(run_id)
            checkpoints = self._agent_checkpoints.list_for_run(run_id)
            orphan_agent_job_ids = [
                job["id"]
                for job in jobs
                if job["status"] in {"QUEUED", "RUNNING"}
                and (
                    (
                        job["mode"] == "automatic"
                        and job["id"] not in self._agent_executors
                    )
                    or (
                        job["mode"] == "interactive"
                        and not self._interactive_job_has_active_desktop_session(job["id"])
                    )
                )
            ]
            orphan_terminal_session_ids = [
                session["id"] for session in terminal_sessions if session["status"] == "running"
            ]
            return {
                "runId": run_id,
                "eventCount": len(events),
                "projectionStatus": projection.status,
                "orphanAgentJobIds": orphan_agent_job_ids,
                "orphanTerminalSessionIds": orphan_terminal_session_ids,
                "recoverableAgentCheckpointIds": [
                    checkpoint["id"]
                    for checkpoint in checkpoints
                    if checkpoint["status"] == "recoverable"
                ],
                "rebuildAvailable": True,
            }

    def cleanup_orphan_agent_jobs(self, run_id: str, *, now: str) -> dict:
        self._runs.workflow_for_run(run_id)
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                orphan_job_ids = [
                    job["id"]
                    for job in self._agent_jobs.list_for_run(run_id)
                    if job["status"] in {"QUEUED", "RUNNING"}
                    and (
                        (
                            job["mode"] == "automatic"
                            and job["id"] not in self._agent_executors
                        )
                        or (
                            job["mode"] == "interactive"
                            and not self._interactive_job_has_active_desktop_session(job["id"])
                        )
                    )
                ]
                for job_id in orphan_job_ids:
                    job = self._agent_jobs.get(job_id)
                    self._agent_jobs.finish(
                        id=job_id,
                        status="CANCELLED",
                        summary="恢复流程已清理遗留 Agent 任务",
                        error="RECOVERY_ORPHANED: Runtime 执行器已不可用",
                        updated_at=now,
                    )
                    self._agent_checkpoints.update_for_job(
                        job_id=job_id,
                        status="recoverable",
                        recovery_reason="RECOVERY_ORPHANED: Runtime 执行器已不可用",
                        updated_at=now,
                    )
                    if job is not None and job["mode"] == "interactive":
                        session = self._agent_sessions.get_for_job(job_id)
                        if session is not None and session["status"] in {"QUEUED", "RUNNING"}:
                            self._agent_sessions.finish(
                                id=session["id"],
                                status="RECOVERABLE",
                                recovery_reason=(
                                    "RECOVERY_ORPHANED: interactive desktop session is unavailable"
                                ),
                                ended_at=now,
                            )
                        self._interactive_desktop_sessions.pop(job_id, None)
                if orphan_job_ids:
                    self._audit.record(
                        actor={
                            "id": "runtime-recovery",
                            "type": "system",
                            "source": "runtime",
                            "trusted": True,
                        },
                        action="recovery.orphan_agents.cleaned",
                        resource=f"run:{run_id}",
                        detail={"jobIds": orphan_job_ids},
                        created_at=now,
                    )
                self._db.commit()
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise
        return {"runId": run_id, "cleanedJobIds": orphan_job_ids}

    def cleanup_orphan_terminal_sessions(self, run_id: str, *, now: str) -> dict:
        with self._lock:
            self.get_projection(run_id)
            orphan_session_ids = [
                session["id"]
                for session in self._terminals.list_for_run(run_id)
                if session["status"] == "running"
            ]
            try:
                self._db.execute("BEGIN IMMEDIATE")
                for session_id in orphan_session_ids:
                    self._terminals.stop(run_id, session_id, updated_at=now)
                if orphan_session_ids:
                    self._audit.record(
                        actor={
                            "id": "runtime-recovery",
                            "type": "system",
                            "source": "runtime",
                            "trusted": True,
                        },
                        action="recovery.orphan_terminals.cleaned",
                        resource=f"run:{run_id}",
                        detail={"sessionIds": orphan_session_ids},
                        created_at=now,
                    )
                self._db.commit()
            except Exception:
                if self._db.in_transaction:
                    self._db.rollback()
                raise
        return {"runId": run_id, "cleanedSessionIds": orphan_session_ids}

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
                self._assert_run_project_active(run_id)
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

    def _assert_run_project_active(self, run_id: str) -> None:
        project_id = self._runs.project_id_for_run(run_id)
        if self._projects.is_archived(project_id):
            raise ValueError("PROJECT_ARCHIVED: 项目已归档，不能继续操作已有 Run")

    def _evaluate_automatic_gate(
        self,
        run_id: str,
        *,
        node_id: str,
        projection: RunProjection,
        now: str,
    ) -> RunProjection:
        if projection.nodeStates.get(node_id) != "AWAITING_GATE":
            return projection

        workflow = self._runs.workflow_for_run(run_id)
        node = next((candidate for candidate in workflow.nodes if candidate.id == node_id), None)
        if node is None or len(node.gates) != 1:
            return projection
        gate = next((candidate for candidate in workflow.gates if candidate.id == node.gates[0]), None)
        if gate is None:
            return projection
        automatic = gate.metadata.get("automatic")
        if not automatic:
            return projection

        configuration = automatic if isinstance(automatic, dict) else {}
        required_types = configuration.get("requiredArtifactTypes", [])
        if not isinstance(required_types, list) or not all(
            isinstance(item, str) and item.strip() for item in required_types
        ):
            raise ValueError(
                "AUTOMATIC_GATE_CONFIGURATION_INVALID: requiredArtifactTypes must be a string array"
            )

        artifacts = [
            artifact
            for artifact in self._artifacts.list_for_run(run_id)
            if artifact["nodeId"] == node_id
        ]
        evidence = [artifact["uri"] for artifact in artifacts]
        available_types = {artifact["type"] for artifact in artifacts}
        missing_types = [artifact_type for artifact_type in required_types if artifact_type not in available_types]
        status = "passed" if evidence and not missing_types else "failed"
        failure_reason = (
            None
            if status == "passed"
            else (
                f"自动 Gate 缺少必需 Artifact 类型：{', '.join(missing_types)}"
                if missing_types
                else "自动 Gate 未找到当前节点的 Artifact 证据"
            )
        )
        return self.submit_gate_result(
            run_id,
            node_id=node_id,
            gate_id=gate.id,
            status=status,
            evidence=evidence,
            waiver_reason=None,
            failure_reason=failure_reason,
            actor={
                "id": "runtime-auto-gate",
                "type": "system",
                "source": "runtime",
                "trusted": True,
            },
            expected_revision=projection.revision,
            now=now,
        )

    def _invalidate_artifact_decisions_if_changed(
        self,
        *,
        run_id: str,
        node_id: str,
        before_hashes: list[str],
        projection: RunProjection,
        now: str,
    ) -> RunProjection:
        after_hashes = self._artifacts.verified_hashes_for_node(run_id=run_id, node_id=node_id)
        if not before_hashes or before_hashes == after_hashes:
            return projection
        if projection.nodeStates.get(node_id) not in {"PASSED", "AWAITING_APPROVAL", "AWAITING_GATE"}:
            return projection

        reason = "正式 Artifact 内容哈希集合发生变化，需要重新审批或验证。"
        projection = self._transition_run(
            run_id,
            "ARTIFACT_INVALIDATED",
            node_id=node_id,
            actor={"id": "runtime-artifact-scanner", "type": "system", "source": "runtime", "trusted": True},
            payload={"reason": reason, "beforeHashes": before_hashes, "afterHashes": after_hashes},
            expected_revision=projection.revision,
            now=now,
        )
        with self._lock, self._db:
            approvals = self._approvals.invalidate_for_node(
                run_id=run_id, node_id=node_id, reason=reason, invalidated_at=now
            )
            gates = self._gate_results.invalidate_for_node(
                run_id=run_id, node_id=node_id, reason=reason, invalidated_at=now
            )
            self._audit.record(
                actor={"id": "runtime-artifact-scanner", "type": "system", "source": "runtime", "trusted": True},
                action="artifact.decision.invalidated",
                resource=f"run:{run_id}:node:{node_id}",
                detail={
                    "reason": reason,
                    "beforeHashes": before_hashes,
                    "afterHashes": after_hashes,
                    "invalidatedApprovals": approvals,
                    "invalidatedGates": gates,
                },
                created_at=now,
            )
        return projection

    def get_projection(self, run_id: str) -> RunProjection:
        with self._lock:
            workflow = self._runs.workflow_for_run(run_id)
            events = self._events.list_for_run(run_id)
            if not events:
                raise KeyError(f"Projection not found: {run_id}")
            return rebuild_projection(run_id, workflow, events)

    def _interactive_job_and_session(self, run_id: str, job_id: str) -> tuple[dict, dict]:
        job = self.get_agent_job(run_id, job_id)
        if job["mode"] != "interactive":
            raise ValueError("AGENT_INTERACTIVE_SESSION_REQUIRED: job is not interactive")
        session = self._agent_sessions.get_for_job(job_id)
        if session is None:
            raise ValueError("AGENT_INTERACTIVE_SESSION_REQUIRED: session is missing")
        return job, session

    def _interactive_job_has_active_desktop_session(self, job_id: str) -> bool:
        session = self._agent_sessions.get_for_job(job_id)
        if session is None or not session["desktopSessionId"]:
            return False
        return self._interactive_desktop_sessions.get(job_id) == session["desktopSessionId"]

    def _terminal_session_for_run(self, run_id: str, session_id: str) -> dict:
        self.get_projection(run_id)
        for session in self._terminals.list_for_run(run_id):
            if session["id"] == session_id:
                return session
        raise KeyError(f"Terminal session not found: {session_id}")

    def _record_deployment_started(
        self,
        *,
        deployment_id: str,
        run_id: str,
        node_id: str,
        command: list[str],
        cwd: Path,
        actor: Actor,
        now: str,
    ) -> None:
        self._deployments.create(
            id=deployment_id,
            run_id=run_id,
            node_id=node_id,
            command=command,
            cwd=str(cwd),
            created_at=now,
        )
        self._audit.record(
            actor=actor,
            action="deployment.started",
            resource=f"deployment:{deployment_id}",
            detail={
                "runId": run_id,
                "nodeId": node_id,
                "command": redact_terminal_output(" ".join(command)),
                "cwd": str(cwd),
            },
            created_at=now,
        )

    def _record_deployment_finished(
        self,
        *,
        deployment_id: str,
        run_id: str,
        node_id: str,
        status: str,
        summary: str | None,
        error: str | None,
        log_path: Path,
        content_hash: str,
        actor: dict,
        now: str,
        event_revision: str,
    ) -> None:
        self._deployments.finish(
            id=deployment_id,
            status=status,
            summary=summary,
            error=error,
            updated_at=now,
        )
        self._artifacts.save(
            id=f"{run_id}:deployment-artifact:{deployment_id}:{event_revision}",
            run_id=run_id,
            node_id=node_id,
            type="deploy-log",
            uri=log_path.as_uri(),
            content_hash=content_hash,
            producer=Actor.model_validate(actor),
            created_at=now,
        )
        self._audit.record(
            actor=actor,
            action="deployment.completed" if status == "COMPLETED" else "deployment.failed",
            resource=f"deployment:{deployment_id}",
            detail={
                "runId": run_id,
                "nodeId": node_id,
                "artifactUri": log_path.as_uri(),
                "contentHash": content_hash,
                "error": error,
            },
            created_at=now,
        )

    def _project_root_for_knowledge_source(self, source: str) -> Path:
        if not source.startswith("run:") or not source.removeprefix("run:").strip():
            raise ValueError("KNOWLEDGE_SYNTHESIS_SOURCE_INVALID: 知识候选必须关联有效 Run 才能启动 CLI 合成。")
        run_id = source.removeprefix("run:").split(":", 1)[0].strip()
        if not run_id:
            raise ValueError("KNOWLEDGE_SYNTHESIS_SOURCE_INVALID: 知识候选必须关联有效 Run 才能启动 CLI 合成。")
        return self._runs.execution_workspace_for_run(run_id)


def _added_items(before: list, after: list) -> list[dict]:
    before_ids = {item.id for item in before}
    return [
        item.model_dump(by_alias=True)
        for item in after
        if item.id not in before_ids
    ]


def _changed_items(before: list, after: list) -> list[dict]:
    before_by_id = {item.id: item.model_dump(by_alias=True) for item in before}
    changed: list[dict] = []
    for item in after:
        prior = before_by_id.get(item.id)
        current = item.model_dump(by_alias=True)
        if prior is None:
            continue
        fields = {
            field: {"from": prior.get(field), "to": current.get(field)}
            for field in sorted(set(prior) | set(current))
            if field != "id" and prior.get(field) != current.get(field)
        }
        if fields:
            changed.append({"id": item.id, "changes": fields})
    return changed


def _deployment_configuration(node, project_root: Path) -> tuple[list[str], Path, float, int]:
    raw_config = node.metadata.get("deploy")
    if not isinstance(raw_config, dict):
        raise ValueError("DEPLOY_CONFIG_INVALID: deploy 节点必须配置 metadata.deploy。")
    raw_command = raw_config.get("command")
    if (
        not isinstance(raw_command, list)
        or not raw_command
        or any(not isinstance(token, str) or not token.strip() for token in raw_command)
    ):
        raise ValueError("DEPLOY_COMMAND_INVALID: metadata.deploy.command 必须是非空命令数组。")
    command = [token.strip() for token in raw_command]
    if any("\x00" in token or "\r" in token or "\n" in token for token in command):
        raise ValueError("DEPLOY_COMMAND_INVALID: 部署命令不能包含控制字符。")
    if command[0].lower() in {"cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "sh", "bash"}:
        raise ValueError("DEPLOY_COMMAND_INVALID: 部署命令不能通过 Shell 解释器执行。")

    raw_cwd = raw_config.get("cwd", ".")
    if not isinstance(raw_cwd, str) or not raw_cwd.strip():
        raise ValueError("DEPLOY_CWD_INVALID: metadata.deploy.cwd 必须是项目内相对路径。")
    cwd = validate_safe_path(project_root, raw_cwd.strip())
    if not cwd.is_dir():
        raise ValueError(f"DEPLOY_CWD_INVALID: 部署工作目录不存在：{cwd}")

    timeout_seconds = raw_config.get("timeoutSeconds", 300)
    if (
        isinstance(timeout_seconds, bool)
        or not isinstance(timeout_seconds, (int, float))
        or not 1 <= float(timeout_seconds) <= 3_600
    ):
        raise ValueError("DEPLOY_TIMEOUT_INVALID: timeoutSeconds 必须在 1 到 3600 之间。")
    max_output_bytes = raw_config.get("maxOutputBytes", 1_000_000)
    if (
        isinstance(max_output_bytes, bool)
        or not isinstance(max_output_bytes, int)
        or not 1_024 <= max_output_bytes <= 2_000_000
    ):
        raise ValueError("DEPLOY_OUTPUT_LIMIT_INVALID: maxOutputBytes 必须在 1024 到 2000000 之间。")
    return command, cwd, float(timeout_seconds), max_output_bytes


def _run_request_hash(
    *,
    project_id: str,
    workflow_version_id: str,
    title: str,
    task_goal: str,
    parameters: dict[str, Any],
    execution_workspace: str,
    workspace_mode: str,
    actor: Actor,
) -> str:
    payload = {
        "projectId": project_id,
        "workflowVersionId": workflow_version_id,
        "title": title,
        "taskGoal": task_goal,
        "parameters": parameters,
        "executionWorkspace": execution_workspace,
        "workspaceMode": workspace_mode,
        "actor": actor.model_dump(by_alias=True),
    }
    serialized = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _within_idempotency_window(created_at: str, now: str) -> bool:
    return _parse_utc(now) < _parse_utc(created_at) + timedelta(hours=24)


def _parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _stable_id(prefix: str, value: str) -> str:
    return f"{prefix}-{uuid5(NAMESPACE_URL, value)}"


def _project_workflow_asset_id(project_id: str, workflow_id: str) -> str:
    return f"workflow-asset:{project_id}:{workflow_id}"


def _default_workflow_for_project(project_path: Path) -> WorkflowDefinition:
    project_name = project_path.name or "新项目"
    return WorkflowDefinition.model_validate(
        {
            "id": _stable_id("workflow", project_path.as_posix()),
            "name": f"{project_name} 工作流",
            "version": "1",
            "sourceAdapter": "platform-default",
            "nodes": [
                {
                    "id": "understand",
                    "name": "需求澄清",
                    "kind": "task",
                    "description": "明确目标、范围、约束与验收标准。",
                },
                {
                    "id": "plan",
                    "name": "方案设计",
                    "kind": "task",
                    "description": "产出可执行的实施方案和验证计划。",
                },
                {
                    "id": "implement",
                    "name": "实施交付",
                    "kind": "task",
                    "description": "完成实现并记录交付内容。",
                },
                {
                    "id": "verify",
                    "name": "验收验证",
                    "kind": "task",
                    "description": "验证结果符合既定验收标准。",
                },
            ],
            "edges": [
                {"id": "understand-plan", "from": "understand", "to": "plan"},
                {"id": "plan-implement", "from": "plan", "to": "implement"},
                {"id": "implement-verify", "from": "implement", "to": "verify"},
            ],
            "roles": [],
            "gates": [],
            "policies": {},
            "metadata": {
                "generated": True,
                "generatedForProject": project_path.as_posix(),
                "canvas": {
                    "nodes": {
                        "understand": {"x": 0, "y": 0},
                        "plan": {"x": 260, "y": 0},
                        "implement": {"x": 520, "y": 0},
                        "verify": {"x": 780, "y": 0},
                    }
                },
            },
        }
    )


def _workflow_node_summary(workflow: WorkflowDefinition) -> str:
    names = [node.name for node in workflow.nodes[:3]]
    if len(workflow.nodes) > 3:
        names.append(f"还有 {len(workflow.nodes) - 3} 个节点")
    return "、".join(names) if names else "空工作流"


def _require_valid_workflow(workflow: WorkflowDefinition) -> None:
    diagnostics = compile_workflow(workflow)["diagnostics"]
    if diagnostics:
        codes = ", ".join(diagnostic["code"] for diagnostic in diagnostics)
        raise ValueError(f"WORKFLOW_DIAGNOSTICS_ERROR: {codes}")


def _build_effective_agent_prompt(
    *,
    workflow: WorkflowDefinition,
    run_id: str,
    node_id: str,
    user_prompt: str,
    node_states: dict[str, str],
    artifacts: list[dict],
    project_root: Path,
    now: str,
) -> tuple[str, list[dict]]:
    """Build the immutable workflow instructions before user-provided task text."""
    node = next((candidate for candidate in workflow.nodes if candidate.id == node_id), None)
    if node is None:
        raise ValueError(f"AGENT_UNKNOWN_NODE: Node not found in workflow: {node_id}")

    sections: list[str] = []
    if node.agent.roleId:
        role = next((candidate for candidate in workflow.roles if candidate.id == node.agent.roleId), None)
        if role is not None:
            role_lines = ["角色定义：", f"角色名：{role.name}"]
            if role.purpose and role.purpose.strip():
                role_lines.append(f"角色目标：{role.purpose.strip()}")
            if role.description and role.description.strip():
                role_lines.append(f"说明：{role.description.strip()}")
            if role.instructions and role.instructions.strip():
                role_lines.append(f"职责与边界：{role.instructions.strip()}")
            if role.inputRequirements and role.inputRequirements.strip():
                role_lines.append(f"输入上下文要求：{role.inputRequirements.strip()}")
            if role.outputRequirements and role.outputRequirements.strip():
                role_lines.append(f"输出与交付要求：{role.outputRequirements.strip()}")
            if role.acceptanceCriteria and role.acceptanceCriteria.strip():
                role_lines.append(f"验收标准：{role.acceptanceCriteria.strip()}")
            if role.forbiddenActions and role.forbiddenActions.strip():
                role_lines.append(f"禁止行为：{role.forbiddenActions.strip()}")
            sections.append("\n".join(role_lines))
    if node.agent.promptTemplate and node.agent.promptTemplate.strip():
        sections.append(f"节点执行要求：\n{node.agent.promptTemplate.strip()}")

    if node.artifacts.outputs:
        output_lines = ["本节点交付物："]
        for output in node.artifacts.outputs:
            target = render_artifact_path(
                project_root,
                output.path,
                run_id=run_id,
                node_id=node_id,
                workflow_id=workflow.id,
                artifact_id=output.id,
                date=now[:10],
            )
            relative_target = target.relative_to(project_root.resolve()).as_posix()
            requirement = "必需" if output.required else "可选"
            output_lines.append(
                f"- {output.name}（{requirement}，类型：{output.type}）：{relative_target}"
            )
            if output.description:
                output_lines.append(f"  说明：{output.description}")
            if output.templatePath:
                output_lines.append(f"  模板：{output.templatePath}")
        sections.append("\n".join(output_lines))

    context = AgentContextBuilder().build(
        workflow=workflow,
        node_id=node_id,
        node_states=node_states,
        artifacts=artifacts,
        project_root=project_root,
    )
    if context.prompt:
        sections.append(context.prompt)

    if user_prompt.strip():
        sections.append(f"用户任务：\n{user_prompt.strip()}")
    if not sections:
        return "请完成当前工作流节点任务。", context.artifacts
    return "\n\n".join(sections), context.artifacts


def _agent_start_response(
    *,
    job: dict,
    effective_prompt: str,
    context_artifacts: list[dict],
    workflow: WorkflowDefinition,
    node_id: str,
    run_id: str,
    project_root: Path,
    now: str,
) -> dict:
    expected_artifacts = _expected_artifacts(
        workflow=workflow, node_id=node_id, run_id=run_id, project_root=project_root, now=now
    )
    return {
        **job,
        "job": job,
        "effectivePrompt": effective_prompt,
        "contextArtifacts": context_artifacts,
        "expectedArtifacts": expected_artifacts,
    }


def _expected_artifacts(
    *,
    workflow: WorkflowDefinition,
    node_id: str,
    run_id: str,
    project_root: Path,
    now: str,
) -> list[dict]:
    node = next((candidate for candidate in workflow.nodes if candidate.id == node_id), None)
    if node is None:
        raise ValueError(f"AGENT_UNKNOWN_NODE: Node not found in workflow: {node_id}")
    return [
        {
            "id": output.id,
            "name": output.name,
            "type": output.type,
            "required": output.required,
            "relativePath": render_artifact_path(
                project_root, output.path, run_id=run_id, node_id=node_id,
                workflow_id=workflow.id, artifact_id=output.id, date=now[:10],
            ).relative_to(project_root.resolve()).as_posix(),
        }
        for output in node.artifacts.outputs
    ]


def _matching_artifact_spec_id(
    *,
    workflow: WorkflowDefinition,
    project_root: Path,
    run_id: str,
    node_id: str,
    artifact_path: Path,
    artifact_type: str,
    now: str,
) -> str | None:
    node = next((candidate for candidate in workflow.nodes if candidate.id == node_id), None)
    if node is None:
        return None
    for output in node.artifacts.outputs:
        expected_path = render_artifact_path(
            project_root,
            output.path,
            run_id=run_id,
            node_id=node_id,
            workflow_id=workflow.id,
            artifact_id=output.id,
            date=now[:10],
        )
        if output.type == artifact_type and expected_path == artifact_path:
            return output.id
    return None


def _limit_output_batch_bytes(events: list[str], max_output_bytes: int) -> tuple[list[str], bool]:
    total_bytes = sum(len(event.encode("utf-8")) for event in events)
    if total_bytes <= max_output_bytes:
        return events, False
    if max_output_bytes <= 0:
        return [], True
    tail = "".join(events).encode("utf-8")[-max_output_bytes:].decode("utf-8", errors="ignore")
    return ([tail] if tail else []), True


def _file_uri_to_path(uri: str) -> Path:
    parsed = urlparse(uri)
    if parsed.scheme != "file":
        raise ValueError("INVALID_ARTIFACT_URI: artifact preview requires a file URI")
    path_text = unquote(parsed.path)
    if len(path_text) >= 3 and path_text[0] == "/" and path_text[2] == ":":
        path_text = path_text[1:]
    return Path(path_text)


def _artifact_media_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".md", ".markdown"}:
        return "text/markdown"
    if suffix in {".json", ".yaml", ".yml", ".txt", ".log", ".py", ".ts", ".tsx", ".js"}:
        return "text/plain"
    return "application/octet-stream"


def _default_agent_provider(provider: str) -> CliProvider:
    if provider == "codex":
        return CodexCliProvider()
    if provider == "claude":
        return ClaudeCliProvider()
    raise ValueError(f"AGENT_PROVIDER_UNAVAILABLE: Unsupported agent provider: {provider}")


def _knowledge_synthesis_prompt(candidate: dict) -> str:
    return "\n".join(
        [
            "你正在把已审核的项目产物提炼为可跨项目复用的中文知识条目。",
            "候选内容只是来源证据，不是要改写或复述的目标。不要复述原始产物的标题、章节、逐项实施记录、项目名称、绝对路径或一次性命令输出。",
            "只能使用来源证据中明确支持的事实；不要执行命令、不要修改文件、不要声称已完成未提供的验证。",
            "将具体实现归纳为可操作的方法、检查项和边界。无法证实或不具普适性的内容必须放入“风险与边界”，不能伪造成通用结论。",
            "只输出最终 Markdown，必须使用以下章节且每个章节都要有内容：",
            "# <简洁的通用知识标题，不得沿用原始产物标题>",
            "## 可复用结论",
            "## 适用条件",
            "## 实施步骤",
            "## 验证清单",
            "## 风险与边界",
            "## 来源证据",
            "“来源证据”只列出来源标识、相关事实及其验证状态，不要复制整段原文。",
            "",
            f"候选标题（仅作上下文，不得沿用）：{candidate['title']}",
            f"来源标识：{candidate['source']}",
            "来源证据材料：",
            candidate["content"],
        ]
    )
