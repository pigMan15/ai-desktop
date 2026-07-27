from __future__ import annotations

from pathlib import Path
import sqlite3
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from workflow_platform.main import health
from workflow_platform.runtime_service import WorkflowRuntimeService


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


def create_app(runtime_service: WorkflowRuntimeService | None = None) -> FastAPI:
    application = FastAPI(title="AI Workflow Platform Runtime")

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

    @application.get("/runs/{run_id}/projection")
    def get_projection(run_id: str) -> dict[str, Any]:
        service = _require_service(runtime_service)
        try:
            return service.get_projection(run_id).model_dump()
        except KeyError as error:
            raise HTTPException(status_code=404, detail=str(error)) from error

    return application


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
    }
    return HTTPException(status_code=status_by_code.get(code, 400), detail=str(error))


app = create_app()
