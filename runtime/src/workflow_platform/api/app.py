from __future__ import annotations

from pathlib import Path
import sqlite3
from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

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


def create_app(runtime_service: WorkflowRuntimeService | None = None) -> FastAPI:
    application = FastAPI(title="AI Workflow Platform Runtime")

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
            status = 409 if str(error).startswith("REVISION_CONFLICT") else 400
            raise HTTPException(status_code=status, detail=str(error)) from error
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
            status = 409 if str(error).startswith("REVISION_CONFLICT") else 400
            raise HTTPException(status_code=status, detail=str(error)) from error
        except sqlite3.IntegrityError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

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


app = create_app()
