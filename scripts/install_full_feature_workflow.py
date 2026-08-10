from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_SOURCE = REPOSITORY_ROOT / "runtime" / "src"
if str(RUNTIME_SOURCE) not in sys.path:
    sys.path.insert(0, str(RUNTIME_SOURCE))

from workflow_platform.compiler.compiler import compile_workflow
from workflow_platform.examples.full_feature_workflow import (
    REQUIRED_ROLE_IDS,
    WORKFLOW_ID,
    build_full_feature_workflow,
)
from workflow_platform.persistence.database import connect
from workflow_platform.persistence.migrations import migrate
from workflow_platform.runtime_service import WorkflowRuntimeService


DEFAULT_DB = REPOSITORY_ROOT / ".workflow-platform" / "runtime.db"
DEFAULT_PROJECT_ID = "project-c13c4a32-5d0a-5801-ab82-5e1a9125a9ad"
ACTOR = {
    "id": "full-feature-workflow-installer",
    "type": "human",
    "source": "runtime",
    "trusted": True,
}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Install and bind the full-feature local delivery example workflow.",
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--project-id", default=DEFAULT_PROJECT_ID)
    args = parser.parse_args()

    db_path = args.db.resolve()
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    db = connect(db_path)
    try:
        migrate(db)
        project = db.execute(
            "SELECT id, name, root_path, archived_at FROM projects WHERE id = ?",
            (args.project_id,),
        ).fetchone()
        if project is None:
            raise SystemExit(f"Project not found: {args.project_id}")
        if project["archived_at"] is not None:
            raise SystemExit(f"Project is archived: {args.project_id}")

        role_versions = _active_role_versions(db)
        workflow = build_full_feature_workflow(role_versions)
        diagnostics = compile_workflow(workflow)["diagnostics"]
        if diagnostics:
            raise SystemExit(f"Workflow compilation failed: {json.dumps(diagnostics, ensure_ascii=False)}")

        previous_binding_row = db.execute(
            "SELECT project_id, workflow_id, workflow_version_id, bound_at "
            "FROM project_workflow_bindings WHERE project_id = ?",
            (args.project_id,),
        ).fetchone()
        previous_binding = dict(previous_binding_row) if previous_binding_row else None

        service = WorkflowRuntimeService(db)
        asset = db.execute(
            "SELECT current_workflow_version_id FROM workflow_assets WHERE id = ?",
            (WORKFLOW_ID,),
        ).fetchone()
        if asset is None:
            created = service.create_workflow(
                definition=workflow.model_dump(by_alias=True),
                is_builtin=False,
                actor=ACTOR,
                now=now,
            )
            workflow_version_id = created["workflowVersionId"]
            created_now = True
            upgraded_now = False
        else:
            workflow_version_id = asset["current_workflow_version_id"]
            if not workflow_version_id:
                raise SystemExit(f"Workflow has no current version: {WORKFLOW_ID}")
            created_now = False
            current_definition = service._workflow_versions.get(workflow_version_id)
            if current_definition is None:
                raise SystemExit(f"Workflow version not found: {workflow_version_id}")
            if current_definition.metadata.get("installerSchemaVersion") != 2:
                saved = service.save_workflow_version(
                    workflow_version_id,
                    definition=workflow.model_dump(by_alias=True),
                    actor=ACTOR,
                    now=now,
                )
                workflow_version_id = saved["workflowVersionId"]
                upgraded_now = True
            else:
                upgraded_now = False

        binding = service.bind_project_workflow(
            args.project_id,
            workflow_id=WORKFLOW_ID,
            workflow_version_id=workflow_version_id,
            actor=ACTOR,
            now=now,
        )
        print(json.dumps(
            {
                "database": str(db_path),
                "project": dict(project),
                "workflowId": WORKFLOW_ID,
                "workflowVersionId": workflow_version_id,
                "createdNow": created_now,
                "upgradedNow": upgraded_now,
                "previousBinding": previous_binding,
                "binding": binding,
                "nodeCount": len(workflow.nodes),
                "edgeCount": len(workflow.edges),
                "deploymentTarget": "local-staging",
            },
            ensure_ascii=False,
            indent=2,
        ))
        return 0
    finally:
        db.close()


def _active_role_versions(db) -> dict[str, str]:
    role_versions: dict[str, str] = {}
    for role_id in REQUIRED_ROLE_IDS:
        row = db.execute(
            "SELECT current_role_version_id FROM role_assets "
            "WHERE id = ? AND archived_at IS NULL",
            (role_id,),
        ).fetchone()
        if row is None or not row["current_role_version_id"]:
            raise SystemExit(f"Required active role is missing: {role_id}")
        role_versions[role_id] = row["current_role_version_id"]
    return role_versions


if __name__ == "__main__":
    raise SystemExit(main())
