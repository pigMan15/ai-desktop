from __future__ import annotations

import asyncio
import os
import json
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from typing import Any, Callable
from secrets import compare_digest
from threading import Lock
from uuid import uuid4

from fastapi import Body, FastAPI, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from workflow_platform.main import health
from workflow_platform.execution.diagnostics import diagnose_cli_provider
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService
from workflow_platform.runtime_errors import RuntimeContractError
from workflow_platform.terminals.redaction import redact_terminal_output


DEFAULT_RUNTIME_DB_ENV = "WORKFLOW_PLATFORM_RUNTIME_DB"
DEFAULT_RUNTIME_DB_PATH = ".workflow-platform/runtime.db"
LOCAL_RUNTIME_TOKEN_ENV = "WORKFLOW_PLATFORM_RUNTIME_TOKEN"


class ImportProjectRequest(BaseModel):
    projectPath: str
    now: str


class ArchiveProjectRequest(BaseModel):
    actor: dict[str, Any]
    now: str


class ProjectConcurrencyRequest(BaseModel):
    maxActiveRuns: int = Field(ge=1, le=10)
    maxActiveAgents: int = Field(ge=1, le=10)
    actor: dict[str, Any]
    now: str


class CreateProjectWorktreeRequest(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    branchName: str = Field(min_length=1, max_length=120)
    baseRef: str = "HEAD"


class ScopedCreateRunRequest(BaseModel):
    workflowVersionId: str
    title: str = Field(min_length=1, max_length=120)
    taskGoal: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    executionWorkspace: dict[str, str]
    actor: dict[str, Any]
    now: str | None = None


class ScopedRunActionRequest(BaseModel):
    actionId: str
    expectedRevision: str
    actor: dict[str, Any]
    payload: dict[str, Any] | None = None
    now: str | None = None


class ReleaseWorkspaceRequest(BaseModel):
    reason: str = Field(min_length=1)
    now: str | None = None


class SaveWorkflowVersionRequest(BaseModel):
    definition: dict[str, Any]
    actor: dict[str, Any]
    now: str


class CreateWorkflowRequest(BaseModel):
    definition: dict[str, Any]
    isBuiltin: bool = False
    actor: dict[str, Any]
    now: str


class CopyWorkflowRequest(BaseModel):
    name: str
    actor: dict[str, Any]
    now: str


class ArchiveWorkflowRequest(BaseModel):
    actor: dict[str, Any]
    now: str


class SaveRoleAssetRequest(BaseModel):
    definition: dict[str, Any]
    isBuiltin: bool = False
    actor: dict[str, Any]
    now: str


class ArchiveRoleAssetRequest(BaseModel):
    actor: dict[str, Any]
    now: str


class BindProjectWorkflowRequest(BaseModel):
    workflowId: str
    workflowVersionId: str
    actor: dict[str, Any]
    now: str


class SubmitArtifactRequest(BaseModel):
    nodeId: str
    artifactPath: str
    artifactType: str
    artifactSpecId: str | None = None
    artifactStatus: str = "verified"
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class ScanNodeArtifactsRequest(BaseModel):
    expectedRevision: str
    now: str


class ConfirmArtifactRequest(BaseModel):
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class CompleteNodeRequest(BaseModel):
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class ApprovalDecisionRequest(BaseModel):
    decision: str
    actor: dict[str, Any]
    comment: str | None = None
    expectedRevision: str
    now: str


class GateResultRequest(BaseModel):
    nodeId: str
    gateId: str
    status: str
    evidence: list[str] = Field(default_factory=list)
    waiverReason: str | None = None
    failureReason: str | None = None
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class RebuildProjectionRequest(BaseModel):
    now: str


class CleanupOrphanAgentsRequest(BaseModel):
    now: str


class RegisterTerminalSessionRequest(BaseModel):
    nodeId: str
    kind: str
    cwd: str
    pid: int | None = None
    now: str


class StopTerminalSessionRequest(BaseModel):
    now: str


class AppendTerminalOutputRequest(BaseModel):
    stream: str
    data: str
    now: str


class TerminalCommandDecisionRequest(BaseModel):
    decision: str
    riskLevel: str
    commandSummary: str
    impact: str
    actor: dict[str, Any]
    now: str


class ExportTerminalEvidenceRequest(BaseModel):
    actor: dict[str, Any]
    now: str


class StartAgentJobRequest(BaseModel):
    nodeId: str
    provider: str
    prompt: str
    cwd: str | None = None
    actor: dict[str, Any]
    mode: str = "automatic"
    transport: str = "auto"
    conversational: bool = False
    allowedTools: list[str] = Field(default_factory=list)
    timeoutSeconds: float = 300
    maxOutputBytes: int = 1_000_000
    now: str


class DecideAgentPermissionRequest(BaseModel):
    decision: str
    reason: str | None = None
    actor: dict[str, Any]
    now: str


class ContinueAgentConversationRequest(BaseModel):
    message: str
    actor: dict[str, Any]
    now: str


class StartInteractiveAgentSessionRequest(BaseModel):
    desktopSessionId: str
    pid: int
    actor: dict[str, Any]
    now: str


class InteractiveAgentInputRequest(BaseModel):
    content: str
    actor: dict[str, Any]
    now: str


class InteractiveAgentOutputRequest(BaseModel):
    events: list[dict[str, str]]
    now: str


class FinishInteractiveAgentSessionRequest(BaseModel):
    status: str
    summary: str | None = None
    error: str | None = None
    actor: dict[str, Any]
    now: str


class ContinueInteractiveAgentSessionRequest(BaseModel):
    actor: dict[str, Any]
    now: str


class CancelAgentJobRequest(BaseModel):
    actor: dict[str, Any] | None = None
    now: str | None = None


class StartDeploymentRequest(BaseModel):
    nodeId: str
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class CancelDeploymentRequest(BaseModel):
    actor: dict[str, Any]
    now: str


class ResumeAgentCheckpointRequest(BaseModel):
    actor: dict[str, Any]
    now: str


class CreateKnowledgeCandidateRequest(BaseModel):
    title: str
    content: str
    source: str
    actor: dict[str, Any]
    now: str


class ReviewKnowledgeCandidateRequest(BaseModel):
    decision: str
    actor: dict[str, Any]
    comment: str | None = None
    now: str


class PublishKnowledgeCandidateRequest(BaseModel):
    actor: dict[str, Any]
    now: str


class StartKnowledgeSynthesisRequest(BaseModel):
    provider: str
    actor: dict[str, Any]
    now: str


class ExtractArtifactKnowledgeSynthesisRequest(BaseModel):
    artifactIds: list[str] = Field(min_length=1)
    provider: str
    actor: dict[str, Any]
    now: str


class KnowledgeSynthesisFeedbackRequest(BaseModel):
    feedback: str
    actor: dict[str, Any]
    now: str


class RecordKnowledgeGitPublicationRequest(BaseModel):
    branch: str
    relativePath: str
    commitHash: str
    actor: dict[str, Any]
    now: str


def create_app(
    runtime_service: WorkflowRuntimeService | None = None,
    *,
    cli_diagnostics: Callable[[str], dict[str, str | bool | None]] = diagnose_cli_provider,
    local_token: str | None = None,
    maintenance: bool = False,
) -> FastAPI:
    application = FastAPI(title="AI Workflow Platform Runtime")
    expected_local_token = local_token.strip() if local_token else None
    runtime_request_lock = Lock()

    def require_runtime_available() -> None:
        if maintenance:
            raise RuntimeContractError(
                "RUN_REARCHITECTURE_MAINTENANCE",
                "Runtime migration is in progress",
                status=503,
            )

    def is_maintenance_blocked_start(request: Request) -> bool:
        if not maintenance or request.method != "POST":
            return False
        parts = [part for part in request.url.path.split("/") if part]
        if len(parts) == 3:
            return parts[0] == "projects" and parts[2] == "runs"
        return (
            len(parts) == 5
            and parts[0] == "projects"
            and parts[2] == "runs"
            and parts[4] in {"agents", "terminals", "deployments"}
        )

    def runtime_contract_response(
        request: Request, error: RuntimeContractError
    ) -> JSONResponse:
        correlation_id = request.headers.get("X-Correlation-Id") or str(uuid4())
        content: dict[str, Any] = {
            "code": error.code,
            "message": error.message,
            "correlationId": correlation_id,
        }
        if error.details is not None:
            content["details"] = error.details
        return JSONResponse(status_code=error.status, content=content)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_origin_regex=r"^https?://(?:127\.0\.0\.1|localhost):\d+$",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.exception_handler(RuntimeContractError)
    async def runtime_contract_error_handler(
        request: Request, error: RuntimeContractError
    ) -> JSONResponse:
        return runtime_contract_response(request, error)

    @application.exception_handler(KeyError)
    async def key_error_handler(request: Request, error: KeyError) -> JSONResponse:
        return runtime_contract_response(
            request,
            RuntimeContractError(
                "RESOURCE_NOT_FOUND",
                str(error),
                status=404,
            ),
        )

    @application.exception_handler(ValueError)
    async def value_error_handler(request: Request, error: ValueError) -> JSONResponse:
        code = str(error).split(":", 1)[0]
        status_by_code = {
            "REVISION_CONFLICT": 409,
            "PERMISSION_DENIED": 403,
            "ACTOR_NOT_TRUSTED": 403,
            "PROJECT_ARCHIVED": 409,
        }
        return runtime_contract_response(
            request,
            RuntimeContractError(
                code,
                str(error),
                status=status_by_code.get(code, 400),
            ),
        )

    @application.middleware("http")
    async def require_local_runtime_token(request: Request, call_next: Callable):
        if (
            expected_local_token
            and request.method != "OPTIONS"
            and request.url.path != "/health"
        ):
            supplied_token = request.headers.get("X-Workflow-Platform-Token", "")
            if not compare_digest(supplied_token, expected_local_token):
                return JSONResponse(
                    status_code=401,
                    content={"detail": "LOCAL_AUTH_REQUIRED: Runtime 本地认证令牌无效或缺失。"},
                )
        if is_maintenance_blocked_start(request):
            return runtime_contract_response(
                request,
                RuntimeContractError(
                    "RUN_REARCHITECTURE_MAINTENANCE",
                    "Runtime migration is in progress",
                    status=503,
                ),
            )
        # The Runtime owns one SQLite connection, so one request retains the lock
        # until its endpoint has completed all repository operations.
        await asyncio.to_thread(runtime_request_lock.acquire)
        try:
            return await call_next(request)
        finally:
            runtime_request_lock.release()

    @application.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        _request: object,
        exc: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": exc.errors()})

    @application.get("/health")
    def get_health() -> dict[str, str]:
        return health()

    @application.get("/agents/providers")
    def get_agent_provider_diagnostics() -> list[dict[str, str | bool | None]]:
        return [cli_diagnostics(provider) for provider in ("codex", "claude")]

    @application.get("/diagnostics/support-bundle")
    def export_diagnostic_support_bundle() -> dict[str, str]:
        providers = get_agent_provider_diagnostics()
        unavailable = [provider["id"] for provider in providers if not provider["available"]]
        recommendations = [
            "确认 Runtime 已运行并可通过本机回环地址访问。",
            "如遇工作流中断，请在恢复页面检查遗留终端和 Agent checkpoint。",
        ]
        if "codex" in unavailable:
            recommendations.append("请安装 Codex CLI 并完成认证。")
        if "claude" in unavailable:
            recommendations.append("请安装 Claude Code CLI 并完成认证。")
        recent_audit_records = (
            runtime_service.list_audit_records(limit=50)
            if runtime_service is not None
            else []
        )
        content = {
            "title": "Runtime 诊断支持包",
            "schemaVersion": 1,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "health": health(),
            "cliProviders": providers,
            "recentAuditRecords": recent_audit_records,
            "recoverySuggestions": recommendations,
        }
        return {
            "fileName": "workflow-platform-diagnostics.json",
            "mediaType": "application/json",
            "content": redact_terminal_output(
                json.dumps(content, ensure_ascii=False, indent=2, sort_keys=True)
            ),
        }

    @application.post("/knowledge/candidates")
    def create_knowledge_candidate(request: CreateKnowledgeCandidateRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.create_knowledge_candidate(
                title=request.title,
                content=request.content,
                source=request.source,
                actor=request.actor,
                now=request.now,
            )
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/knowledge/candidates")
    def list_knowledge_candidates(status: str | None = None) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        return service.list_knowledge_candidates(status=status)

    @application.post("/knowledge/candidates/{candidate_id}/review")
    def review_knowledge_candidate(
        candidate_id: str,
        request: ReviewKnowledgeCandidateRequest,
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.review_knowledge_candidate(
                candidate_id,
                decision=request.decision,
                actor=request.actor,
                comment=request.comment,
                now=request.now,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/knowledge/candidates/{candidate_id}/publish")
    def publish_knowledge_candidate(
        candidate_id: str,
        request: PublishKnowledgeCandidateRequest,
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.publish_knowledge_candidate(
                candidate_id,
                actor=request.actor,
                now=request.now,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/knowledge/candidates/{candidate_id}/syntheses")
    def start_knowledge_synthesis(
        candidate_id: str,
        request: StartKnowledgeSynthesisRequest,
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.start_knowledge_synthesis(
                candidate_id,
                provider=request.provider,
                actor=request.actor,
                now=request.now,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/knowledge/syntheses")
    def list_knowledge_syntheses() -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        return service.list_knowledge_syntheses()

    @application.get("/knowledge/syntheses/{synthesis_id}/output")
    def list_knowledge_synthesis_output(
        synthesis_id: str,
        afterSequence: int = 0,
    ) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        try:
            return service.list_knowledge_synthesis_output(
                synthesis_id,
                after_sequence=afterSequence,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/knowledge/syntheses/{synthesis_id}/feedback")
    def record_knowledge_synthesis_feedback(
        synthesis_id: str,
        request: KnowledgeSynthesisFeedbackRequest,
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.record_knowledge_synthesis_feedback(
                synthesis_id,
                feedback=request.feedback,
                actor=request.actor,
                now=request.now,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/knowledge/syntheses/{synthesis_id}/publish")
    def publish_knowledge_synthesis(
        synthesis_id: str,
        request: PublishKnowledgeCandidateRequest,
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.publish_knowledge_synthesis(
                synthesis_id,
                actor=request.actor,
                now=request.now,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/knowledge/search")
    def search_knowledge(query: str) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        return service.search_knowledge(query)

    @application.get("/knowledge/documents")
    def list_knowledge_documents() -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        return service.list_knowledge_documents()

    @application.get("/knowledge/documents/{document_id}/replay")
    def replay_knowledge_document(document_id: str) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.replay_knowledge_document(document_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/knowledge/documents/{document_id}/export")
    def export_knowledge_document(document_id: str) -> dict[str, str]:
        service = _require_service(runtime_service)
        try:
            return service.export_knowledge_document(document_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.post("/knowledge/documents/{document_id}/git-publications")
    def record_knowledge_git_publication(
        document_id: str,
        request: RecordKnowledgeGitPublicationRequest,
    ) -> dict[str, str]:
        service = _require_service(runtime_service)
        try:
            return service.record_knowledge_git_publication(
                document_id,
                branch=request.branch,
                relative_path=request.relativePath,
                commit_hash=request.commitHash,
                actor=request.actor,
                now=request.now,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/audit-records")
    def list_audit_records(
        actorId: str | None = None,
        action: str | None = None,
        resource: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        try:
            return service.list_audit_records(
                actor_id=actorId,
                action=action,
                resource=resource,
                limit=limit,
            )
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/projects/import")
    def import_project(request: ImportProjectRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.import_project(Path(request.projectPath), now=request.now)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @application.post("/projects/{project_id}/archive")
    def archive_project(
        project_id: str,
        request: ArchiveProjectRequest,
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.archive_project(project_id, actor=request.actor, now=request.now)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/projects/{project_id}/concurrency")
    def get_project_concurrency(project_id: str) -> dict[str, int]:
        try:
            return _require_service(runtime_service).get_project_concurrency(project_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.put("/projects/{project_id}/concurrency")
    def update_project_concurrency(project_id: str, request: ProjectConcurrencyRequest) -> dict[str, int]:
        try:
            return _require_service(runtime_service).update_project_concurrency(
                project_id,
                max_active_runs=request.maxActiveRuns,
                max_active_agents=request.maxActiveAgents,
                actor=request.actor,
                now=request.now,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/projects/{project_id}/workspaces")
    def list_project_workspaces(project_id: str) -> list[dict[str, Any]]:
        try:
            return _require_service(runtime_service).list_project_workspaces(project_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.post("/projects/{project_id}/worktrees", status_code=201)
    def create_project_worktree(project_id: str, request: CreateProjectWorktreeRequest) -> dict[str, Any]:
        try:
            return _require_service(runtime_service).create_project_worktree(
                project_id, name=request.name, branch_name=request.branchName, base_ref=request.baseRef,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/projects/{project_id}/workflow-binding")
    def get_project_workflow_binding(project_id: str) -> dict[str, Any] | None:
        service = _require_service(runtime_service)
        try:
            return service.get_project_workflow_binding(project_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.post("/projects/{project_id}/workflow-binding")
    def bind_project_workflow(project_id: str, request: BindProjectWorkflowRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.bind_project_workflow(
                project_id,
                workflow_id=request.workflowId,
                workflow_version_id=request.workflowVersionId,
                actor=request.actor,
                now=request.now,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/workflows")
    def list_workflows() -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_workflows()

    @application.get("/roles")
    def list_role_assets() -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_role_assets()

    @application.post("/roles")
    def save_role_asset(request: SaveRoleAssetRequest) -> dict[str, Any]:
        try:
            return _require_service(runtime_service).save_role_asset(
                definition=request.definition, is_builtin=request.isBuiltin, actor=request.actor, now=request.now,
            )
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/roles/{role_id}/archive")
    def archive_role_asset(role_id: str, request: ArchiveRoleAssetRequest) -> dict[str, Any]:
        try:
            return _require_service(runtime_service).archive_role_asset(role_id, actor=request.actor, now=request.now)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/roles/{role_id}/restore")
    def restore_role_asset(role_id: str, request: ArchiveRoleAssetRequest) -> dict[str, Any]:
        try:
            return _require_service(runtime_service).restore_role_asset(role_id, actor=request.actor, now=request.now)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/roles/{role_id}/delete")
    def delete_role_asset(role_id: str, request: ArchiveRoleAssetRequest) -> dict[str, Any]:
        try:
            return _require_service(runtime_service).delete_role_asset(role_id, actor=request.actor, now=request.now)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/roles/{role_id}/history")
    def list_role_version_history(role_id: str) -> list[dict[str, Any]]:
        try:
            return _require_service(runtime_service).list_role_version_history(role_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/roles/{role_id}/references")
    def list_role_references(role_id: str) -> list[dict[str, Any]]:
        try:
            return _require_service(runtime_service).list_role_references(role_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.post("/workflows")
    def create_workflow(request: CreateWorkflowRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.create_workflow(
                definition=request.definition,
                is_builtin=request.isBuiltin,
                actor=request.actor,
                now=request.now,
            )
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/workflows/{workflow_id}/copy")
    def copy_workflow_template(workflow_id: str, request: CopyWorkflowRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.copy_workflow_template(workflow_id, name=request.name, actor=request.actor, now=request.now)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/workflows/{workflow_id}/archive")
    def archive_workflow(workflow_id: str, request: ArchiveWorkflowRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.archive_workflow(workflow_id, actor=request.actor, now=request.now)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/workflows/{workflow_id}/delete")
    def delete_workflow(workflow_id: str, request: ArchiveWorkflowRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.delete_workflow(workflow_id, actor=request.actor, now=request.now)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/workflow-versions/{workflow_version_id}")
    def get_workflow_definition(workflow_version_id: str) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.get_workflow_definition(workflow_version_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/workflow-versions/{workflow_version_id}/export")
    def export_workflow_definition(
        workflow_version_id: str,
        format: str,
    ) -> dict[str, str]:
        service = _require_service(runtime_service)
        try:
            return service.export_workflow_version(workflow_version_id, format=format)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/workflow-versions/{workflow_version_id}/compile")
    def compile_workflow_definition(workflow_version_id: str) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.compile_workflow_version(workflow_version_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.post("/workflow-versions/{workflow_version_id}/simulate")
    def simulate_workflow_definition(workflow_version_id: str) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.simulate_workflow_version(workflow_version_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/workflow-versions/{workflow_version_id}/history")
    def list_workflow_version_history(workflow_version_id: str) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        try:
            return service.list_workflow_version_history(workflow_version_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/workflow-versions/{workflow_version_id}/diff")
    def diff_workflow_versions(
        workflow_version_id: str,
        against: str,
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.diff_workflow_versions(
                workflow_version_id,
                against_workflow_version_id=against,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/workflow-versions/{workflow_version_id}/save")
    def save_workflow_definition(
        workflow_version_id: str,
        request: SaveWorkflowVersionRequest,
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.save_workflow_version(
                workflow_version_id,
                definition=request.definition,
                actor=request.actor,
                now=request.now,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/projects/{project_id}/runs", status_code=201)
    def create_project_run(
        project_id: str,
        request: ScopedCreateRunRequest,
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> JSONResponse:
        require_runtime_available()
        service = _require_service(runtime_service)
        workspace_path = request.executionWorkspace.get("path")
        workspace_mode = request.executionWorkspace.get("mode")
        if not workspace_path or workspace_mode not in {"write", "read"}:
            raise RuntimeContractError(
                "INVALID_REQUEST",
                "executionWorkspace requires a path and valid mode",
                status=400,
            )
        now = request.now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        try:
            projection = service.create_run(
                project_id,
                request.workflowVersionId,
                title=request.title,
                task_goal=request.taskGoal,
                parameters=request.parameters,
                execution_workspace=workspace_path,
                workspace_mode=workspace_mode,
                actor=request.actor,
                idempotency_key=idempotency_key,
                now=now,
            )
        except KeyError as error:
            raise RuntimeContractError(
                "INVALID_REQUEST", str(error), status=404
            ) from error
        except ValueError as error:
            legacy_error = _http_error_from_value_error(error)
            code, _, message = str(error).partition(":")
            raise RuntimeContractError(
                code,
                message.strip() or str(error),
                status=legacy_error.status_code,
            ) from error
        overview = service.get_scoped_overview(project_id, projection.runId)
        return JSONResponse(
            status_code=201,
            content=overview,
            headers={"Location": f"/projects/{project_id}/runs/{projection.runId}"},
        )

    @application.get("/projects/{project_id}/runs")
    def list_project_runs(
        project_id: str,
        status: list[str] | None = Query(default=None),
        workflowVersionId: str | None = None,
        workspacePath: str | None = None,
        q: str | None = None,
        cursor: str | None = None,
        limit: int = Query(default=20, ge=1, le=100),
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.list_project_runs(
                project_id,
                statuses=status or [],
                workflow_version_id=workflowVersionId,
                workspace_path=workspacePath,
                query=q,
                cursor=cursor,
                limit=limit,
            )
        except ValueError as error:
            raise RuntimeContractError(
                "INVALID_REQUEST", str(error), status=400
            ) from error

    @application.get("/projects/{project_id}/runs/{run_id}")
    def get_project_run(project_id: str, run_id: str) -> dict[str, Any]:
        return _require_service(runtime_service).get_scoped_run(project_id, run_id)

    @application.get("/projects/{project_id}/runs/{run_id}/projection")
    def get_project_run_projection(project_id: str, run_id: str) -> dict[str, Any]:
        return _require_service(runtime_service).get_scoped_projection(
            project_id, run_id
        ).model_dump()

    @application.get("/projects/{project_id}/runs/{run_id}/overview")
    def get_project_run_overview(project_id: str, run_id: str) -> dict[str, Any]:
        return _require_service(runtime_service).get_scoped_overview(project_id, run_id)

    @application.post("/projects/{project_id}/runs/{run_id}/actions")
    def execute_project_run_action(
        project_id: str, run_id: str, request: ScopedRunActionRequest
    ) -> dict[str, Any]:
        now = request.now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        service = _require_service(runtime_service)
        try:
            return service.execute_scoped_action(
                project_id,
                run_id,
                action_id=request.actionId,
                expected_revision=request.expectedRevision,
                actor=request.actor,
                payload=request.payload,
                now=now,
            )
        except FileNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/projects/{project_id}/runs/{run_id}/workspace/release")
    def release_project_run_workspace(
        project_id: str, run_id: str, request: ReleaseWorkspaceRequest
    ) -> dict[str, Any]:
        now = request.now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        return _require_service(runtime_service).release_scoped_workspace(
            project_id, run_id, reason=request.reason, now=now
        )

    @application.post("/projects/{project_id}/runs/{run_id}/agents")
    def start_project_agent_job(
        project_id: str, run_id: str, request: StartAgentJobRequest
    ) -> dict[str, Any]:
        require_runtime_available()
        return _require_service(runtime_service).start_agent_job(
            run_id,
            project_id=project_id,
            node_id=request.nodeId,
            provider=request.provider,
            prompt=request.prompt,
            cwd=request.cwd,
            actor=request.actor,
            allowed_tools=request.allowedTools,
            timeout_seconds=request.timeoutSeconds,
            max_output_bytes=request.maxOutputBytes,
            mode=request.mode,
            transport=request.transport,
            conversational=request.conversational,
            now=request.now,
        )

    @application.post("/projects/{project_id}/runs/{run_id}/terminals")
    def start_project_terminal_session(
        project_id: str, run_id: str, request: RegisterTerminalSessionRequest
    ) -> dict[str, Any]:
        require_runtime_available()
        return _require_service(runtime_service).register_terminal_session(
            run_id,
            project_id=project_id,
            node_id=request.nodeId,
            kind=request.kind,
            cwd=Path(request.cwd),
            pid=request.pid,
            now=request.now,
        )

    @application.post("/projects/{project_id}/runs/{run_id}/deployments")
    def start_project_deployment(
        project_id: str, run_id: str, request: StartDeploymentRequest
    ) -> dict[str, Any]:
        require_runtime_available()
        return _require_service(runtime_service).start_deployment(
            run_id,
            project_id=project_id,
            node_id=request.nodeId,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    @application.get("/projects/{project_id}/runs/{run_id}/agents")
    def list_project_agent_jobs(project_id: str, run_id: str) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_agent_jobs(project_id, run_id)

    @application.get("/projects/{project_id}/runs/{run_id}/agents/{job_id}")
    def get_project_agent_job(project_id: str, run_id: str, job_id: str) -> dict[str, Any]:
        return _require_service(runtime_service).get_scoped_agent_job(project_id, run_id, job_id)

    @application.get("/projects/{project_id}/runs/{run_id}/agents/{job_id}/output")
    def list_project_agent_output(project_id: str, run_id: str, job_id: str, afterSequence: int = 0) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_agent_output(project_id, run_id, job_id, after_sequence=afterSequence)

    @application.post("/projects/{project_id}/runs/{run_id}/agents/{job_id}/cancel")
    def cancel_project_agent_job(project_id: str, run_id: str, job_id: str, request: CancelAgentJobRequest | None = Body(default=None)) -> dict[str, Any]:
        return _require_service(runtime_service).cancel_scoped_agent_job(
            project_id, run_id, job_id,
            actor=request.actor if request is not None else None,
            now=request.now if request is not None else None,
        )

    @application.post("/projects/{project_id}/runs/{run_id}/agents/{job_id}/conversation/message")
    def continue_project_agent_conversation(
        project_id: str, run_id: str, job_id: str, request: ContinueAgentConversationRequest
    ) -> dict[str, Any]:
        return _require_service(runtime_service).continue_scoped_agent_conversation(
            project_id,
            run_id,
            job_id,
            message=request.message,
            actor=request.actor,
            now=request.now,
        )

    @application.get("/projects/{project_id}/runs/{run_id}/agents/{job_id}/permissions")
    def list_project_agent_permissions(
        project_id: str, run_id: str, job_id: str, status: str = "PENDING"
    ) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_agent_permissions(
            project_id, run_id, job_id, status=status
        )

    @application.post("/projects/{project_id}/runs/{run_id}/agents/{job_id}/permissions/{request_id}/decide")
    def decide_project_agent_permission(
        project_id: str, run_id: str, job_id: str, request_id: str, request: DecideAgentPermissionRequest
    ) -> dict[str, Any]:
        return _require_service(runtime_service).decide_scoped_agent_permission(
            project_id,
            run_id,
            job_id,
            request_id,
            decision=request.decision,
            reason=request.reason,
            actor=request.actor,
            now=request.now,
        )

    @application.post("/projects/{project_id}/runs/{run_id}/agents/{job_id}/interactive-session/start")
    def start_project_interactive_agent_session(project_id: str, run_id: str, job_id: str, request: StartInteractiveAgentSessionRequest) -> dict[str, Any]:
        return _require_service(runtime_service).start_scoped_interactive_agent_session(
            project_id, run_id, job_id, desktop_session_id=request.desktopSessionId,
            pid=request.pid, actor=request.actor, now=request.now,
        )

    @application.post("/projects/{project_id}/runs/{run_id}/agents/{job_id}/interactive-session/input")
    def record_project_interactive_agent_input(project_id: str, run_id: str, job_id: str, request: InteractiveAgentInputRequest) -> dict[str, Any]:
        return _require_service(runtime_service).record_scoped_interactive_agent_input(
            project_id, run_id, job_id, content=request.content, actor=request.actor, now=request.now,
        )

    @application.post("/projects/{project_id}/runs/{run_id}/agents/{job_id}/interactive-session/output")
    def append_project_interactive_agent_output(project_id: str, run_id: str, job_id: str, request: InteractiveAgentOutputRequest) -> list[dict[str, Any]]:
        return _require_service(runtime_service).append_scoped_interactive_agent_output(
            project_id, run_id, job_id, events=request.events, now=request.now,
        )

    @application.get("/projects/{project_id}/runs/{run_id}/agents/{job_id}/interactive-session")
    def get_project_interactive_agent_session(project_id: str, run_id: str, job_id: str) -> dict[str, Any]:
        return _require_service(runtime_service).get_scoped_interactive_agent_session(project_id, run_id, job_id)

    @application.post("/projects/{project_id}/runs/{run_id}/agents/{job_id}/interactive-session/ended")
    def finish_project_interactive_agent_session(project_id: str, run_id: str, job_id: str, request: FinishInteractiveAgentSessionRequest) -> dict[str, Any]:
        return _require_service(runtime_service).finish_scoped_interactive_agent_session(
            project_id, run_id, job_id, status=request.status, summary=request.summary,
            error=request.error, actor=request.actor, now=request.now,
        )

    @application.post("/projects/{project_id}/runs/{run_id}/agents/{job_id}/interactive-session/continue")
    def continue_project_interactive_agent_session(project_id: str, run_id: str, job_id: str, request: ContinueInteractiveAgentSessionRequest) -> dict[str, Any]:
        return _require_service(runtime_service).continue_scoped_interactive_agent(
            project_id, run_id, job_id, actor=request.actor, now=request.now,
        )

    @application.get("/projects/{project_id}/runs/{run_id}/agent-checkpoints")
    def list_project_agent_checkpoints(project_id: str, run_id: str) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_agent_checkpoints(project_id, run_id)

    @application.post("/projects/{project_id}/runs/{run_id}/agent-checkpoints/{checkpoint_id}/resume")
    def resume_project_agent_checkpoint(project_id: str, run_id: str, checkpoint_id: str, request: ResumeAgentCheckpointRequest) -> dict[str, Any]:
        return _require_service(runtime_service).resume_scoped_agent_checkpoint(
            project_id, run_id, checkpoint_id, actor=request.actor, now=request.now,
        )

    @application.post("/projects/{project_id}/runs/{run_id}/agent-checkpoints/{checkpoint_id}/discard")
    def discard_project_agent_checkpoint(project_id: str, run_id: str, checkpoint_id: str, request: ResumeAgentCheckpointRequest) -> dict[str, Any]:
        return _require_service(runtime_service).discard_scoped_agent_checkpoint(
            project_id, run_id, checkpoint_id, actor=request.actor, now=request.now,
        )

    @application.get("/projects/{project_id}/runs/{run_id}/terminals")
    def list_project_terminal_sessions(project_id: str, run_id: str) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_terminal_sessions(project_id, run_id)

    @application.post("/projects/{project_id}/runs/{run_id}/terminals/{session_id}/stop")
    def stop_project_terminal_session(project_id: str, run_id: str, session_id: str, request: StopTerminalSessionRequest) -> dict[str, Any]:
        return _require_service(runtime_service).stop_scoped_terminal_session(project_id, run_id, session_id, now=request.now)

    @application.get("/projects/{project_id}/runs/{run_id}/terminals/{session_id}/output")
    def list_project_terminal_output(project_id: str, run_id: str, session_id: str, afterSequence: int = 0) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_terminal_output(project_id, run_id, session_id, after_sequence=afterSequence)

    @application.post("/projects/{project_id}/runs/{run_id}/terminals/{session_id}/output")
    def append_project_terminal_output(project_id: str, run_id: str, session_id: str, request: AppendTerminalOutputRequest) -> dict[str, bool]:
        _require_service(runtime_service).append_scoped_terminal_output(project_id, run_id, session_id, stream=request.stream, data=request.data, now=request.now)
        return {"accepted": True}

    @application.post("/projects/{project_id}/runs/{run_id}/terminals/{session_id}/evidence")
    def export_project_terminal_evidence(project_id: str, run_id: str, session_id: str, request: ExportTerminalEvidenceRequest) -> dict[str, Any]:
        return _require_service(runtime_service).export_scoped_terminal_evidence(project_id, run_id, session_id, actor=request.actor, now=request.now)

    @application.post("/projects/{project_id}/runs/{run_id}/terminals/{session_id}/command-decisions")
    def record_project_terminal_command_decision(project_id: str, run_id: str, session_id: str, request: TerminalCommandDecisionRequest) -> dict[str, Any]:
        return _require_service(runtime_service).record_scoped_terminal_command_decision(
            project_id, run_id, session_id, decision=request.decision, risk_level=request.riskLevel,
            command_summary=request.commandSummary, impact=request.impact, actor=request.actor, now=request.now,
        )

    @application.get("/projects/{project_id}/runs/{run_id}/deployments")
    def list_project_deployments(project_id: str, run_id: str) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_deployments(project_id, run_id)

    @application.get("/projects/{project_id}/runs/{run_id}/deployments/{deployment_id}")
    def get_project_deployment(project_id: str, run_id: str, deployment_id: str) -> dict[str, Any]:
        return _require_service(runtime_service).get_scoped_deployment(project_id, run_id, deployment_id)

    @application.get("/projects/{project_id}/runs/{run_id}/deployments/{deployment_id}/output")
    def list_project_deployment_output(project_id: str, run_id: str, deployment_id: str, afterSequence: int = 0) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_deployment_output(project_id, run_id, deployment_id, after_sequence=afterSequence)

    @application.post("/projects/{project_id}/runs/{run_id}/deployments/{deployment_id}/cancel")
    def cancel_project_deployment(project_id: str, run_id: str, deployment_id: str, request: CancelDeploymentRequest) -> dict[str, Any]:
        return _require_service(runtime_service).cancel_scoped_deployment(project_id, run_id, deployment_id, actor=request.actor, now=request.now)

    @application.get("/projects/{project_id}/runs/{run_id}/recovery-diagnostics")
    def get_project_recovery_diagnostics(project_id: str, run_id: str) -> dict[str, Any]:
        return _require_service(runtime_service).get_scoped_recovery_diagnostics(project_id, run_id)

    @application.post("/projects/{project_id}/runs/{run_id}/recovery/cleanup-orphan-agents")
    def cleanup_project_orphan_agents(project_id: str, run_id: str, request: CleanupOrphanAgentsRequest) -> dict[str, Any]:
        return _require_service(runtime_service).cleanup_scoped_orphan_agent_jobs(
            project_id, run_id, now=request.now
        )

    @application.post("/projects/{project_id}/runs/{run_id}/recovery/cleanup-orphan-terminals")
    def cleanup_project_orphan_terminals(project_id: str, run_id: str, request: CleanupOrphanAgentsRequest) -> dict[str, Any]:
        return _require_service(runtime_service).cleanup_scoped_orphan_terminal_sessions(
            project_id, run_id, now=request.now
        )

    @application.post("/projects/{project_id}/runs/{run_id}/rebuild-projection")
    def rebuild_project_projection(project_id: str, run_id: str, request: RebuildProjectionRequest) -> dict[str, Any]:
        return _require_service(runtime_service).rebuild_scoped_projection(project_id, run_id, now=request.now).model_dump()

    @application.get("/projects/{project_id}/runs/{run_id}/timeline")
    def get_project_timeline(project_id: str, run_id: str) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_timeline(project_id, run_id)

    @application.get("/projects/{project_id}/runs/{run_id}/artifacts")
    def get_project_artifacts(project_id: str, run_id: str) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_artifacts(project_id, run_id)

    @application.get("/projects/{project_id}/runs/{run_id}/approvals")
    def get_project_approvals(project_id: str, run_id: str) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_approvals(project_id, run_id)

    @application.get("/projects/{project_id}/runs/{run_id}/gates")
    def get_project_gates(project_id: str, run_id: str) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_gates(project_id, run_id)

    @application.get("/projects/{project_id}/runs/{run_id}/audit-records")
    def get_project_audit_records(
        project_id: str,
        run_id: str,
        action: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_audit_records(
            project_id,
            run_id,
            action=action,
            limit=limit,
        )

    @application.get("/projects/{project_id}/runs/{run_id}/artifacts/{artifact_id}/consumers")
    def get_project_artifact_consumers(project_id: str, run_id: str, artifact_id: str) -> list[dict[str, Any]]:
        return _require_service(runtime_service).list_scoped_artifact_consumers(project_id, run_id, artifact_id)

    @application.get("/projects/{project_id}/runs/{run_id}/artifacts/{artifact_id}/preview")
    def preview_project_artifact(project_id: str, run_id: str, artifact_id: str) -> dict[str, Any]:
        return _require_service(runtime_service).preview_scoped_artifact(project_id, run_id, artifact_id)

    @application.get("/projects/{project_id}/runs/{run_id}/evidence-package")
    def get_project_evidence_package(project_id: str, run_id: str) -> dict[str, Any]:
        return _require_service(runtime_service).get_scoped_evidence_package(project_id, run_id)

    @application.get("/projects/{project_id}/runs/{run_id}/report")
    def get_project_run_report(project_id: str, run_id: str) -> dict[str, Any]:
        return _require_service(runtime_service).get_scoped_run_report(project_id, run_id)

    @application.post("/projects/{project_id}/runs/{run_id}/artifacts")
    def submit_project_artifact(project_id: str, run_id: str, request: SubmitArtifactRequest) -> dict[str, Any]:
        try:
            return _require_service(runtime_service).submit_scoped_artifact(
                project_id, run_id, node_id=request.nodeId, artifact_path=Path(request.artifactPath), artifact_type=request.artifactType,
                artifact_spec_id=request.artifactSpecId, artifact_status=request.artifactStatus, actor=request.actor,
                expected_revision=request.expectedRevision, now=request.now,
            ).model_dump()
        except FileNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/projects/{project_id}/runs/{run_id}/nodes/{node_id}/artifacts/scan")
    def scan_project_node_artifacts(project_id: str, run_id: str, node_id: str, request: ScanNodeArtifactsRequest) -> dict[str, Any]:
        result = _require_service(runtime_service).scan_scoped_node_artifacts(project_id, run_id, node_id=node_id, expected_revision=request.expectedRevision, now=request.now)
        return {**result, "projection": result["projection"].model_dump() if hasattr(result.get("projection"), "model_dump") else result.get("projection")}

    @application.get("/projects/{project_id}/runs/{run_id}/nodes/{node_id}/artifact-requirements")
    def get_project_node_artifact_requirements(project_id: str, run_id: str, node_id: str) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        return _require_service(runtime_service).get_scoped_node_artifact_requirements(
            project_id, run_id, node_id, now=now,
        )

    @application.post("/projects/{project_id}/runs/{run_id}/artifacts/knowledge-syntheses")
    def extract_project_artifact_knowledge_syntheses(project_id: str, run_id: str, request: ExtractArtifactKnowledgeSynthesisRequest) -> dict[str, Any]:
        return _require_service(runtime_service).extract_scoped_artifacts_to_knowledge_syntheses(
            project_id, run_id, artifact_ids=request.artifactIds, provider=request.provider,
            actor=request.actor, now=request.now,
        )

    @application.post("/projects/{project_id}/runs/{run_id}/nodes/{node_id}/complete")
    def complete_project_node(project_id: str, run_id: str, node_id: str, request: CompleteNodeRequest) -> dict[str, Any]:
        return _require_service(runtime_service).complete_scoped_node(project_id, run_id, node_id=node_id, actor=request.actor, expected_revision=request.expectedRevision, now=request.now).model_dump()

    @application.post("/projects/{project_id}/runs/{run_id}/nodes/{node_id}/artifacts/{artifact_id}/confirm")
    def confirm_project_artifact(project_id: str, run_id: str, node_id: str, artifact_id: str, request: ConfirmArtifactRequest) -> dict[str, Any]:
        result = _require_service(runtime_service).confirm_scoped_artifact(project_id, run_id, node_id=node_id, artifact_id=artifact_id, actor=request.actor, expected_revision=request.expectedRevision, now=request.now)
        return {**result, "projection": result["projection"].model_dump() if hasattr(result.get("projection"), "model_dump") else result.get("projection")}

    @application.post("/projects/{project_id}/runs/{run_id}/approvals/{node_id}/decide")
    def decide_project_approval(project_id: str, run_id: str, node_id: str, request: ApprovalDecisionRequest) -> dict[str, Any]:
        return _require_service(runtime_service).decide_scoped_approval(project_id, run_id, node_id=node_id, decision=request.decision, actor=request.actor, comment=request.comment, expected_revision=request.expectedRevision, now=request.now).model_dump()

    @application.post("/projects/{project_id}/runs/{run_id}/gates")
    def submit_project_gate(project_id: str, run_id: str, request: GateResultRequest) -> dict[str, Any]:
        return _require_service(runtime_service).submit_scoped_gate(project_id, run_id, node_id=request.nodeId, gate_id=request.gateId, status=request.status, evidence=request.evidence, waiver_reason=request.waiverReason, failure_reason=request.failureReason, actor=request.actor, expected_revision=request.expectedRevision, now=request.now).model_dump()

    if runtime_service is not None:
        from workflow_platform.api.knowledge_repositories import create_knowledge_router

        application.include_router(
            create_knowledge_router(
                runtime_service._knowledge_repositories,
                runtime_service._knowledge_change_sets,
            )
        )
    return application


def create_runtime_app(db_path: str | Path | None = None) -> FastAPI:
    runtime_db_path = Path(
        db_path or os.environ.get(DEFAULT_RUNTIME_DB_ENV, DEFAULT_RUNTIME_DB_PATH)
    )
    db = connect(runtime_db_path)
    migrate(db)
    return create_app(
        WorkflowRuntimeService(db),
        local_token=os.environ.get(LOCAL_RUNTIME_TOKEN_ENV),
    )


def _require_service(runtime_service: WorkflowRuntimeService | None) -> WorkflowRuntimeService:
    if runtime_service is None:
        raise HTTPException(status_code=503, detail="Runtime service is not configured")
    return runtime_service


def _http_error_from_value_error(error: ValueError) -> HTTPException:
    code = str(error).split(":", 1)[0]
    status_by_code = {
        "REVISION_CONFLICT": 409,
        "PERMISSION_DENIED": 403,
        "ACTOR_INVALID": 400,
        "ACTOR_NOT_TRUSTED": 403,
        "ACTOR_PERMISSION_DENIED": 403,
        "PROJECT_ARCHIVED": 409,
        "INVALID_TRANSITION": 400,
        "MISSING_ARTIFACT": 400,
        "MISSING_APPROVAL": 400,
        "MISSING_GATE_RESULT": 400,
        "MISSING_EVIDENCE": 400,
        "UNSAFE_PATH": 400,
        "AGENT_UNKNOWN_NODE": 400,
        "AGENT_PROVIDER_UNAVAILABLE": 400,
        "AGENT_UNSAFE_CWD": 400,
        "AGENT_MODE_INVALID": 400,
        "AGENT_INTERACTIVE_SESSION_REQUIRED": 400,
        "AGENT_INTERACTIVE_SESSION_INVALID": 400,
        "AGENT_INTERACTIVE_INPUT_INVALID": 400,
        "AGENT_INTERACTIVE_OUTPUT_INVALID": 400,
        "AGENT_INTERACTIVE_SESSION_STATUS_INVALID": 400,
        "AGENT_INTERACTIVE_SESSION_STATE_INVALID": 409,
        "AGENT_TIMEOUT": 408,
        "AGENT_OUTPUT_LIMIT": 413,
        "KNOWLEDGE_INPUT_INVALID": 400,
        "KNOWLEDGE_STATUS_INVALID": 400,
        "KNOWLEDGE_REVIEW_INVALID": 400,
        "KNOWLEDGE_REVIEW_CONFLICT": 409,
        "KNOWLEDGE_CANDIDATE_NOT_APPROVED": 409,
        "KNOWLEDGE_ALREADY_PUBLISHED": 409,
        "AUDIT_LIMIT_INVALID": 400,
    }
    return HTTPException(status_code=status_by_code.get(code, 400), detail=str(error))


app = create_app()
