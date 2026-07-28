from __future__ import annotations

import os
from pathlib import Path
import sqlite3
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from workflow_platform.main import health
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService


DEFAULT_RUNTIME_DB_ENV = "WORKFLOW_PLATFORM_RUNTIME_DB"
DEFAULT_RUNTIME_DB_PATH = ".workflow-platform/runtime.db"


class ImportProjectRequest(BaseModel):
    projectPath: str
    now: str


class CreateRunRequest(BaseModel):
    workflowVersionId: str
    title: str
    now: str


class TransitionRequest(BaseModel):
    eventType: str
    nodeId: str | None = None
    actor: dict[str, Any]
    payload: dict[str, Any] | None = None
    expectedRevision: str
    now: str


class SubmitArtifactRequest(BaseModel):
    nodeId: str
    artifactPath: str
    artifactType: str
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
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class RebuildProjectionRequest(BaseModel):
    now: str


class StartAgentJobRequest(BaseModel):
    nodeId: str
    provider: str
    prompt: str
    actor: dict[str, Any]
    allowedTools: list[str] = Field(default_factory=list)
    timeoutSeconds: float = 300
    maxOutputBytes: int = 1_000_000
    now: str


def create_app(runtime_service: WorkflowRuntimeService | None = None) -> FastAPI:
    application = FastAPI(title="AI Workflow Platform Runtime")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @application.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        _request: object,
        exc: RequestValidationError,
    ) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": exc.errors()})

    @application.get("/health")
    def get_health() -> dict[str, str]:
        return health()

    @application.post("/projects/import")
    def import_project(request: ImportProjectRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.import_project(Path(request.projectPath), now=request.now)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @application.post("/runs")
    def create_run(request: CreateRunRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            projection = service.create_run(
                request.workflowVersionId,
                title=request.title,
                now=request.now,
            )
            return projection.model_dump()
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except sqlite3.IntegrityError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @application.post("/runs/{run_id}/transition")
    def transition_run(run_id: str, request: TransitionRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            projection = service.transition_run(
                run_id,
                request.eventType,
                node_id=request.nodeId,
                actor=request.actor,
                payload=request.payload,
                expected_revision=request.expectedRevision,
                now=request.now,
            )
            return projection.model_dump()
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error
        except sqlite3.IntegrityError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @application.post("/runs/{run_id}/artifacts")
    def submit_artifact(run_id: str, request: SubmitArtifactRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            projection = service.submit_artifact(
                run_id,
                node_id=request.nodeId,
                artifact_path=Path(request.artifactPath),
                artifact_type=request.artifactType,
                actor=request.actor,
                expected_revision=request.expectedRevision,
                now=request.now,
            )
            return projection.model_dump()
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except FileNotFoundError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error
        except sqlite3.IntegrityError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @application.get("/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.get_run(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/runs/{run_id}/timeline")
    def get_timeline(run_id: str) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        try:
            return service.timeline(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/runs/{run_id}/artifacts")
    def get_artifacts(run_id: str) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        try:
            return service.list_artifacts(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/runs/{run_id}/approvals")
    def get_approvals(run_id: str) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        try:
            return service.list_approvals(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.post("/runs/{run_id}/approvals/{node_id}/decide")
    def decide_approval(
        run_id: str,
        node_id: str,
        request: ApprovalDecisionRequest,
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            projection = service.decide_approval(
                run_id,
                node_id=node_id,
                decision=request.decision,
                actor=request.actor,
                comment=request.comment,
                expected_revision=request.expectedRevision,
                now=request.now,
            )
            return projection.model_dump()
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/runs/{run_id}/gates")
    def get_gates(run_id: str) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        try:
            return service.list_gate_results(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.post("/runs/{run_id}/gates")
    def submit_gate_result(run_id: str, request: GateResultRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            projection = service.submit_gate_result(
                run_id,
                node_id=request.nodeId,
                gate_id=request.gateId,
                status=request.status,
                evidence=request.evidence,
                waiver_reason=request.waiverReason,
                actor=request.actor,
                expected_revision=request.expectedRevision,
                now=request.now,
            )
            return projection.model_dump()
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.post("/runs/{run_id}/rebuild-projection")
    def rebuild_run_projection(
        run_id: str,
        request: RebuildProjectionRequest,
    ) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.rebuild_projection(run_id, now=request.now).model_dump()
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.post("/runs/{run_id}/agents")
    def start_agent_job(run_id: str, request: StartAgentJobRequest) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.start_agent_job(
                run_id,
                node_id=request.nodeId,
                provider=request.provider,
                prompt=request.prompt,
                actor=request.actor,
                allowed_tools=request.allowedTools,
                timeout_seconds=request.timeoutSeconds,
                max_output_bytes=request.maxOutputBytes,
                now=request.now,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error
        except ValueError as error:
            raise _http_error_from_value_error(error) from error

    @application.get("/runs/{run_id}/agents")
    def list_agent_jobs(run_id: str) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        try:
            return service.list_agent_jobs(run_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/runs/{run_id}/agents/{job_id}")
    def get_agent_job(run_id: str, job_id: str) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.get_agent_job(run_id, job_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/runs/{run_id}/agents/{job_id}/output")
    def list_agent_output(
        run_id: str,
        job_id: str,
        afterSequence: int = 0,
    ) -> list[dict[str, Any]]:
        service = _require_service(runtime_service)
        try:
            service.get_agent_job(run_id, job_id)
            return service.list_agent_output(job_id, after_sequence=afterSequence)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.post("/runs/{run_id}/agents/{job_id}/cancel")
    def cancel_agent_job(run_id: str, job_id: str) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.cancel_agent_job(run_id, job_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    @application.get("/runs/{run_id}/projection")
    def get_projection(run_id: str) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.get_projection(run_id).model_dump()
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    return application


def create_runtime_app(db_path: str | Path | None = None) -> FastAPI:
    runtime_db_path = Path(
        db_path or os.environ.get(DEFAULT_RUNTIME_DB_ENV, DEFAULT_RUNTIME_DB_PATH)
    )
    db = connect(runtime_db_path)
    migrate(db)
    return create_app(WorkflowRuntimeService(db))


def _require_service(runtime_service: WorkflowRuntimeService | None) -> WorkflowRuntimeService:
    if runtime_service is None:
        raise HTTPException(status_code=503, detail="Runtime service is not configured")
    return runtime_service


def _http_error_from_value_error(error: ValueError) -> HTTPException:
    code = str(error).split(":", 1)[0]
    status_by_code = {
        "REVISION_CONFLICT": 409,
        "PERMISSION_DENIED": 403,
        "INVALID_TRANSITION": 400,
        "MISSING_ARTIFACT": 400,
        "MISSING_APPROVAL": 400,
        "MISSING_GATE_RESULT": 400,
        "MISSING_EVIDENCE": 400,
        "UNSAFE_PATH": 400,
        "AGENT_UNKNOWN_NODE": 400,
        "AGENT_PROVIDER_UNAVAILABLE": 400,
        "AGENT_UNSAFE_CWD": 400,
        "AGENT_TIMEOUT": 408,
        "AGENT_OUTPUT_LIMIT": 413,
    }
    return HTTPException(status_code=status_by_code.get(code, 400), detail=str(error))


app = create_app()
