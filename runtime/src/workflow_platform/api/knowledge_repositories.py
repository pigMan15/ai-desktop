"""Knowledge repository Runtime API router (document sections 13, 27).

Registered by `create_app()` so it passes through the existing local auth,
request lock and error handlers.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Header, Query
from pydantic import BaseModel, Field


class KnowledgeImportRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    rootPath: str
    autoApplyLowRisk: bool
    actor: dict[str, Any]
    now: str


class KnowledgeRemoveRequest(BaseModel):
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class KnowledgeRuleDiscoveryRequest(BaseModel):
    provider: str
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class KnowledgeRuleSnapshotConfirmRequest(BaseModel):
    writablePaths: list[str] = Field(default_factory=list)
    protectedPaths: list[str] = Field(default_factory=list)
    indexFiles: list[str] = Field(default_factory=list)
    routingFiles: list[str] = Field(default_factory=list)
    templateFiles: list[str] = Field(default_factory=list)
    validationCommands: list[str] = Field(default_factory=list)
    summary: str
    openQuestions: list[str] = Field(default_factory=list)
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class KnowledgeSettingsRequest(BaseModel):
    autoApplyLowRisk: bool
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class KnowledgeExampleInitializeRequest(BaseModel):
    mode: str
    targetPath: str
    initializeGit: bool
    actor: dict[str, Any]
    now: str


class KnowledgeChangeSetCreateRequest(BaseModel):
    repositoryId: str
    artifactIds: list[str]
    provider: str
    mode: str
    actor: dict[str, Any]
    now: str


class KnowledgeMutationRequest(BaseModel):
    actor: dict[str, Any]
    expectedRevision: str
    now: str


class KnowledgeCommentRequest(KnowledgeMutationRequest):
    comment: str


class KnowledgeAbandonRequest(KnowledgeMutationRequest):
    reason: str


class KnowledgeGitStageRequest(KnowledgeMutationRequest):
    paths: list[str]
    expectedRepositoryRevision: str


class KnowledgeGitCommitRequest(KnowledgeMutationRequest):
    title: str
    body: str = ""
    paths: list[str]
    expectedRepositoryRevision: str


def create_knowledge_router(repository_service: Any, change_set_service: Any) -> APIRouter:
    router = APIRouter()

    # -- examples -----------------------------------------------------------

    @router.get("/knowledge-examples")
    def list_knowledge_examples() -> dict:
        return {"items": repository_service.list_examples()}

    @router.post("/knowledge-examples/{example_id}/initialize", status_code=201)
    def initialize_knowledge_example(
        example_id: str, request: KnowledgeExampleInitializeRequest
    ) -> dict:
        return repository_service.initialize_example(
            example_id=example_id,
            mode=request.mode,
            target_path=request.targetPath,
            initialize_git=request.initializeGit,
            actor=request.actor,
            now=request.now,
        )

    # -- repositories -------------------------------------------------------

    @router.post("/knowledge-repositories/import", status_code=201)
    def import_knowledge_repository(
        request: KnowledgeImportRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        return repository_service.import_repository(
            name=request.name,
            root_path=request.rootPath,
            auto_apply_low_risk=request.autoApplyLowRisk,
            actor=request.actor,
            now=request.now,
        )

    @router.get("/knowledge-repositories")
    def list_knowledge_repositories() -> dict:
        return {
            "items": [repository_service._detail(repo["id"]) for repo in repository_service._repositories.list()]
        }

    @router.get("/knowledge-repositories/{repository_id}")
    def get_knowledge_repository(repository_id: str) -> dict:
        return repository_service._detail(repository_id)

    @router.post("/knowledge-repositories/{repository_id}/remove")
    def remove_knowledge_repository(
        repository_id: str, request: KnowledgeRemoveRequest
    ) -> dict:
        return repository_service.remove_repository(
            repository_id,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    @router.post("/knowledge-repositories/{repository_id}/discover-rules", status_code=202)
    def discover_knowledge_rules(
        repository_id: str,
        request: KnowledgeRuleDiscoveryRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        return repository_service.discover_rules(
            repository_id,
            provider=request.provider,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    @router.get("/knowledge-repositories/{repository_id}/rule-snapshots")
    def list_rule_snapshots(repository_id: str, limit: int = Query(default=20, ge=1, le=100)) -> dict:
        return {
            "items": repository_service._snapshots.list_for_repository(repository_id, limit=limit)
        }

    @router.post("/knowledge-repositories/{repository_id}/rule-snapshots/{snapshot_id}/confirm")
    def confirm_rule_snapshot(
        repository_id: str, snapshot_id: str, request: KnowledgeRuleSnapshotConfirmRequest
    ) -> dict:
        return repository_service.confirm_rule_snapshot(
            repository_id,
            snapshot_id,
            payload={
                "writablePaths": request.writablePaths,
                "protectedPaths": request.protectedPaths,
                "indexFiles": request.indexFiles,
                "routingFiles": request.routingFiles,
                "templateFiles": request.templateFiles,
                "validationCommands": request.validationCommands,
                "summary": request.summary,
                "openQuestions": request.openQuestions,
            },
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    @router.post("/knowledge-repositories/{repository_id}/settings")
    def update_knowledge_settings(
        repository_id: str, request: KnowledgeSettingsRequest
    ) -> dict:
        return repository_service.update_settings(
            repository_id,
            auto_apply_low_risk=request.autoApplyLowRisk,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    @router.get("/knowledge-repositories/{repository_id}/git/status")
    def git_status(repository_id: str) -> dict:
        return repository_service.git_status(repository_id)

    @router.get("/knowledge-repositories/{repository_id}/git/diff")
    def git_diff(
        repository_id: str, scope: str = Query(default="working", pattern="^(working|staged)$")
    ) -> dict:
        return repository_service.git_diff(repository_id, staged=scope == "staged")

    @router.get("/knowledge-repositories/{repository_id}/rule-discovery-jobs/{job_id}")
    def get_rule_discovery_job(repository_id: str, job_id: str) -> dict:
        return repository_service.get_rule_discovery_job(repository_id, job_id)

    @router.get("/knowledge-repositories/{repository_id}/rule-discovery-jobs/{job_id}/output")
    def list_rule_discovery_output(
        repository_id: str,
        job_id: str,
        after_sequence: int = Query(default=0, ge=0),
    ) -> dict:
        return {
            "items": repository_service.list_rule_discovery_output(
                repository_id, job_id, after_sequence=after_sequence
            )
        }

    @router.post("/knowledge-repositories/{repository_id}/rule-discovery-jobs/{job_id}/cancel")
    def cancel_rule_discovery_job(
        repository_id: str,
        job_id: str,
        request: KnowledgeRemoveRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        return repository_service.cancel_rule_discovery(
            repository_id,
            job_id,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    _register_change_set_routes(router, change_set_service)
    return router


def _register_change_set_routes(router: APIRouter, service: Any) -> None:
    @router.post("/projects/{project_id}/runs/{run_id}/knowledge-change-sets", status_code=201)
    def create_change_set(
        project_id: str,
        run_id: str,
        request: KnowledgeChangeSetCreateRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        return service.create(
            project_id=project_id,
            run_id=run_id,
            repository_id=request.repositoryId,
            artifact_ids=request.artifactIds,
            provider=request.provider,
            mode=request.mode,
            actor=request.actor,
            now=request.now,
        )

    @router.get("/projects/{project_id}/runs/{run_id}/knowledge-change-sets")
    def list_change_sets(
        project_id: str,
        run_id: str,
        cursor: str | None = Query(default=None),
        limit: int = Query(default=20, ge=1, le=100),
    ) -> dict:
        return service.list_for_run(project_id, run_id, cursor=cursor, limit=limit)

    @router.get("/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}")
    def get_change_set(project_id: str, run_id: str, change_set_id: str) -> dict:
        return service.get(project_id, run_id, change_set_id)

    @router.get(
        "/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}/output"
    )
    def get_change_set_output(
        project_id: str,
        run_id: str,
        change_set_id: str,
        after_sequence: int = Query(default=0, ge=0),
    ) -> dict:
        return {
            "items": service.list_output(
                project_id, run_id, change_set_id, after_sequence=after_sequence
            )
        }

    @router.post(
        "/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}/generate",
        status_code=202,
    )
    def generate_change_set(
        project_id: str,
        run_id: str,
        change_set_id: str,
        request: KnowledgeMutationRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    ) -> dict:
        return service.start_generation(
            project_id,
            run_id,
            change_set_id,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    @router.post(
        "/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}/approve"
    )
    def approve_change_set(
        project_id: str, run_id: str, change_set_id: str, request: KnowledgeCommentRequest
    ) -> dict:
        return service.approve(
            project_id,
            run_id,
            change_set_id,
            comment=request.comment,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    @router.post(
        "/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}/reject"
    )
    def reject_change_set(
        project_id: str, run_id: str, change_set_id: str, request: KnowledgeCommentRequest
    ) -> dict:
        return service.reject(
            project_id,
            run_id,
            change_set_id,
            comment=request.comment,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    @router.post(
        "/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}/apply"
    )
    def apply_change_set(
        project_id: str, run_id: str, change_set_id: str, request: KnowledgeMutationRequest
    ) -> dict:
        return service.apply(
            project_id,
            run_id,
            change_set_id,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    @router.post(
        "/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}/abandon"
    )
    def abandon_change_set(
        project_id: str, run_id: str, change_set_id: str, request: KnowledgeAbandonRequest
    ) -> dict:
        return service.abandon(
            project_id,
            run_id,
            change_set_id,
            reason=request.reason,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            now=request.now,
        )

    @router.get(
        "/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}/git/diff"
    )
    def change_set_git_diff(
        project_id: str,
        run_id: str,
        change_set_id: str,
        scope: str = Query(default="working", pattern="^(working|staged)$"),
    ) -> dict:
        return service.git_diff(
            project_id, run_id, change_set_id, staged=scope == "staged"
        )

    @router.post(
        "/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}/git/stage"
    )
    def stage_change_set(
        project_id: str, run_id: str, change_set_id: str, request: KnowledgeGitStageRequest
    ) -> dict:
        return service.git_stage(
            project_id,
            run_id,
            change_set_id,
            paths=request.paths,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            expected_repository_revision=request.expectedRepositoryRevision,
            now=request.now,
        )

    @router.post(
        "/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}/git/unstage"
    )
    def unstage_change_set(
        project_id: str, run_id: str, change_set_id: str, request: KnowledgeGitStageRequest
    ) -> dict:
        return service.git_unstage(
            project_id,
            run_id,
            change_set_id,
            paths=request.paths,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            expected_repository_revision=request.expectedRepositoryRevision,
            now=request.now,
        )

    @router.post(
        "/projects/{project_id}/runs/{run_id}/knowledge-change-sets/{change_set_id}/git/commit"
    )
    def commit_change_set(
        project_id: str, run_id: str, change_set_id: str, request: KnowledgeGitCommitRequest
    ) -> dict:
        return service.git_commit(
            project_id,
            run_id,
            change_set_id,
            title=request.title,
            body=request.body,
            paths=request.paths,
            actor=request.actor,
            expected_revision=request.expectedRevision,
            expected_repository_revision=request.expectedRepositoryRevision,
            now=request.now,
        )
