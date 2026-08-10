import base64
import binascii
import json
import sqlite3
from pathlib import Path

from workflow_platform.models import Actor, Role, RunEvent, RunProjection, WorkflowDefinition


class WorkflowVersionRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(
        self,
        definition: WorkflowDefinition,
        *,
        id: str,
        project_id: str,
        content_hash: str,
        workflow_asset_id: str,
        created_at: str,
        adapter_id: str | None = None,
    ) -> None:
        definition_json = json.dumps(
            definition.model_dump(by_alias=True),
            separators=(",", ":"),
            sort_keys=True,
        )
        existing = self._db.execute(
            """
            SELECT project_id, adapter_id, name, version, definition_json, content_hash,
                   workflow_asset_id, created_at
            FROM workflow_versions WHERE id = ?
            """,
            (id,),
        ).fetchone()
        if existing is not None:
            candidate = {
                "project_id": project_id,
                "adapter_id": adapter_id or definition.sourceAdapter,
                "name": definition.name,
                "version": definition.version,
                "definition_json": definition_json,
                "content_hash": content_hash,
                "workflow_asset_id": workflow_asset_id,
            }
            if all(existing[key] == value for key, value in candidate.items()):
                return
            raise ValueError(f"WORKFLOW_VERSION_IMMUTABLE: 版本标识已存在且内容或资产归属不同：{id}")
        self._db.execute(
            """
            INSERT INTO workflow_versions (
                id,
                project_id,
                adapter_id,
                name,
                version,
                definition_json,
                content_hash,
                workflow_asset_id,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                project_id,
                adapter_id or definition.sourceAdapter,
                definition.name,
                definition.version,
                definition_json,
                content_hash,
                workflow_asset_id,
                created_at,
            ),
        )

    def get(self, id: str) -> WorkflowDefinition | None:
        row = self._db.execute(
            """
            SELECT definition_json
            FROM workflow_versions
            WHERE id = ?
            """,
            (id,),
        ).fetchone()

        if row is None:
            return None

        return WorkflowDefinition.model_validate(json.loads(row["definition_json"]))

    def metadata(self, id: str) -> dict | None:
        row = self._db.execute(
            """
            SELECT id, project_id, adapter_id, name, version, content_hash, workflow_asset_id, created_at
            FROM workflow_versions
            WHERE id = ?
            """,
            (id,),
        ).fetchone()
        return dict(row) if row is not None else None

    def list_history(self, id: str) -> list[dict]:
        target = self._db.execute(
            """
            SELECT workflow_asset_id
            FROM workflow_versions
            WHERE id = ?
            """,
            (id,),
        ).fetchone()
        if target is None:
            return []

        rows = self._db.execute(
            """
            SELECT id, name, version, definition_json, content_hash, created_at
            FROM workflow_versions
            WHERE workflow_asset_id = ?
            ORDER BY rowid ASC
            """,
            (target["workflow_asset_id"],),
        ).fetchall()
        history: list[dict] = []
        for row in rows:
            definition = WorkflowDefinition.model_validate(json.loads(row["definition_json"]))
            history.append(
                {
                    "id": row["id"],
                    "name": row["name"],
                    "version": row["version"],
                    "contentHash": row["content_hash"],
                    "createdAt": row["created_at"],
                    "definition": definition,
                }
            )
        return history


class ProjectRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(
        self,
        *,
        id: str,
        name: str,
        root_path: Path,
        active_protocol: str | None,
        now: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO projects (
                id,
                name,
                root_path,
                active_protocol,
                archived_at,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, NULL, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                root_path = excluded.root_path,
                active_protocol = excluded.active_protocol,
                archived_at = NULL,
                updated_at = excluded.updated_at
            """,
            (id, name, str(root_path), active_protocol, now, now),
        )

    def archive(self, project_id: str, *, now: str) -> bool:
        cursor = self._db.execute(
            """
            UPDATE projects
            SET archived_at = ?, updated_at = ?
            WHERE id = ? AND archived_at IS NULL
            """,
            (now, now, project_id),
        )
        if cursor.rowcount > 0:
            return True
        if not self.exists(project_id):
            raise KeyError(f"Project not found: {project_id}")
        return False

    def is_archived(self, project_id: str) -> bool:
        row = self._db.execute(
            "SELECT archived_at FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"Project not found: {project_id}")
        return row["archived_at"] is not None

    def exists(self, project_id: str) -> bool:
        return (
            self._db.execute(
                "SELECT 1 FROM projects WHERE id = ?",
                (project_id,),
            ).fetchone()
            is not None
        )

    def concurrency(self, project_id: str) -> dict[str, int]:
        row = self._db.execute(
            "SELECT max_active_runs, max_active_agents FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"Project not found: {project_id}")
        return {"maxActiveRuns": int(row["max_active_runs"]), "maxActiveAgents": int(row["max_active_agents"])}

    def update_concurrency(
        self, project_id: str, *, max_active_runs: int, max_active_agents: int, now: str
    ) -> dict[str, int]:
        if not 1 <= max_active_runs <= 10 or not 1 <= max_active_agents <= 10:
            raise ValueError("PROJECT_CONCURRENCY_INVALID: limits must be between 1 and 10")
        cursor = self._db.execute(
            "UPDATE projects SET max_active_runs = ?, max_active_agents = ?, updated_at = ? WHERE id = ?",
            (max_active_runs, max_active_agents, now, project_id),
        )
        if cursor.rowcount == 0 and not self.exists(project_id):
            raise KeyError(f"Project not found: {project_id}")
        return self.concurrency(project_id)


class WorkflowAssetRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(
        self,
        *,
        id: str,
        name: str,
        is_builtin: bool,
        actor: dict,
        now: str,
        workflow_version_id: str | None,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO workflow_assets (
                id, name, is_builtin, archived_at, created_by_json,
                created_at, updated_at, current_workflow_version_id
            ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                updated_at = excluded.updated_at,
                current_workflow_version_id = excluded.current_workflow_version_id
            """,
            (id, name, int(is_builtin), json.dumps(actor, separators=(",", ":")), now, now, workflow_version_id),
        )

    def get(self, workflow_id: str) -> dict | None:
        row = self._db.execute("SELECT * FROM workflow_assets WHERE id = ?", (workflow_id,)).fetchone()
        return dict(row) if row is not None else None

    def list(self) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT assets.id AS workflow_id, assets.name, assets.is_builtin,
                   assets.archived_at, assets.updated_at,
                   assets.current_workflow_version_id,
                   versions.version AS current_version,
                   json_array_length(json_extract(versions.definition_json, '$.nodes')) AS node_count,
                   (
                       SELECT COUNT(*) FROM project_workflow_bindings bindings
                       WHERE bindings.workflow_id = assets.id
                   ) AS bound_project_count
            FROM workflow_assets AS assets
            LEFT JOIN workflow_versions AS versions ON versions.id = assets.current_workflow_version_id
            ORDER BY assets.archived_at IS NOT NULL, assets.updated_at DESC, assets.id
            """
        ).fetchall()
        return [dict(row) for row in rows]

    def archive(self, workflow_id: str, *, now: str) -> bool:
        cursor = self._db.execute(
            "UPDATE workflow_assets SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL",
            (now, now, workflow_id),
        )
        if cursor.rowcount:
            return True
        if self.get(workflow_id) is None:
            raise KeyError(f"Workflow not found: {workflow_id}")
        return False

    def delete(self, workflow_id: str) -> bool:
        asset = self.get(workflow_id)
        if asset is None:
            raise KeyError(f"Workflow not found: {workflow_id}")
        self._db.execute("UPDATE workflow_assets SET current_workflow_version_id = NULL WHERE id = ?", (workflow_id,))
        self._db.execute("DELETE FROM workflow_versions WHERE workflow_asset_id = ?", (workflow_id,))
        self._db.execute("DELETE FROM workflow_assets WHERE id = ?", (workflow_id,))
        return True

    def update_current_version(self, workflow_id: str, workflow_version_id: str, *, now: str) -> None:
        self._db.execute(
            "UPDATE workflow_assets SET current_workflow_version_id = ?, updated_at = ? WHERE id = ?",
            (workflow_version_id, now, workflow_id),
        )


class RoleAssetRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def list_assets(self) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT assets.id, assets.name, assets.is_builtin, assets.archived_at, assets.updated_at,
                   assets.current_role_version_id, versions.version, versions.definition_json
            FROM role_assets AS assets
            LEFT JOIN role_versions AS versions ON versions.id = assets.current_role_version_id
            ORDER BY assets.archived_at IS NOT NULL, assets.updated_at DESC, assets.id
            """
        ).fetchall()
        return [dict(row) for row in rows]

    def get(self, role_id: str) -> dict | None:
        row = self._db.execute("SELECT * FROM role_assets WHERE id = ?", (role_id,)).fetchone()
        return dict(row) if row is not None else None

    def get_version(self, role_version_id: str) -> Role | None:
        row = self._db.execute("SELECT definition_json FROM role_versions WHERE id = ?", (role_version_id,)).fetchone()
        return Role.model_validate(json.loads(row["definition_json"])) if row is not None else None

    def list_versions(self, role_id: str) -> list[dict]:
        rows = self._db.execute(
            "SELECT id, version, definition_json, created_at FROM role_versions WHERE role_id = ? ORDER BY version DESC",
            (role_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def save(self, role: Role, *, is_builtin: bool, actor: dict, now: str) -> tuple[str, int]:
        asset = self.get(role.id)
        if asset is not None and asset["is_builtin"]:
            raise ValueError("BUILTIN_ROLE_READ_ONLY: 内置角色只能复制后编辑")
        version = int(self._db.execute("SELECT COALESCE(MAX(version), 0) AS value FROM role_versions WHERE role_id = ?", (role.id,)).fetchone()["value"]) + 1
        version_id = f"role-version:{role.id}:{version}"
        definition = role.model_copy(update={"assetVersionId": version_id})
        self._db.execute(
            """
            INSERT INTO role_assets (id, name, is_builtin, archived_at, created_by_json, created_at, updated_at, current_role_version_id)
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at, current_role_version_id = excluded.current_role_version_id
            """,
            (role.id, role.name, int(is_builtin if asset is None else bool(asset["is_builtin"])), json.dumps(actor, separators=(",", ":")), now, now, version_id),
        )
        self._db.execute(
            "INSERT INTO role_versions (id, role_id, version, definition_json, created_at) VALUES (?, ?, ?, ?, ?)",
            (version_id, role.id, version, json.dumps(definition.model_dump(by_alias=True), separators=(",", ":"), sort_keys=True), now),
        )
        return version_id, version

    def archive(self, role_id: str, *, now: str) -> bool:
        cursor = self._db.execute("UPDATE role_assets SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL", (now, now, role_id))
        if cursor.rowcount:
            return True
        if self.get(role_id) is None:
            raise KeyError(f"Role not found: {role_id}")
        return False

    def restore(self, role_id: str, *, now: str) -> bool:
        cursor = self._db.execute(
            "UPDATE role_assets SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL",
            (now, role_id),
        )
        if cursor.rowcount:
            return True
        if self.get(role_id) is None:
            raise KeyError(f"Role not found: {role_id}")
        return False

    def delete(self, role_id: str) -> bool:
        asset = self.get(role_id)
        if asset is None:
            raise KeyError(f"Role not found: {role_id}")
        if asset["is_builtin"]:
            raise ValueError("BUILTIN_ROLE_READ_ONLY: 内置角色不可删除")
        self._db.execute("DELETE FROM role_assets WHERE id = ?", (role_id,))
        return True


class ProjectWorkflowBindingRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def get(self, project_id: str) -> dict | None:
        row = self._db.execute(
            """
            SELECT project_id, workflow_id, workflow_version_id, actor_json, bound_at
            FROM project_workflow_bindings WHERE project_id = ?
            """,
            (project_id,),
        ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["actor"] = json.loads(result.pop("actor_json"))
        return result

    def bind(
        self, *, project_id: str, workflow_id: str, workflow_version_id: str, actor: dict, now: str
    ) -> None:
        self._db.execute(
            """
            INSERT INTO project_workflow_bindings (project_id, workflow_id, workflow_version_id, actor_json, bound_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                workflow_id = excluded.workflow_id,
                workflow_version_id = excluded.workflow_version_id,
                actor_json = excluded.actor_json,
                bound_at = excluded.bound_at
            """,
            (project_id, workflow_id, workflow_version_id, json.dumps(actor, separators=(",", ":")), now),
        )

class RunRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(
        self,
        *,
        id: str,
        project_id: str,
        workflow_version_id: str,
        title: str,
        status: str,
        context: dict,
        now: str,
        workflow_snapshot: WorkflowDefinition | dict | None = None,
        execution_workspace: str | Path | None = None,
        workspace_mode: str = "write",
    ) -> None:
        if workflow_snapshot is None:
            version = self._db.execute(
                "SELECT definition_json FROM workflow_versions WHERE id = ?",
                (workflow_version_id,),
            ).fetchone()
            if version is None:
                raise KeyError(f"Workflow version not found: {workflow_version_id}")
            snapshot_payload = json.loads(version["definition_json"])
        elif isinstance(workflow_snapshot, WorkflowDefinition):
            snapshot_payload = workflow_snapshot.model_dump(by_alias=True)
        else:
            snapshot_payload = workflow_snapshot
        if execution_workspace is None:
            run_context = _run_context(context)
            execution_workspace = run_context.get("executionWorkspace")
            if not execution_workspace:
                project = self._db.execute(
                    "SELECT root_path FROM projects WHERE id = ?",
                    (project_id,),
                ).fetchone()
                if project is None:
                    raise KeyError(f"Project not found: {project_id}")
                execution_workspace = project["root_path"]
        self._db.execute(
            """
            INSERT INTO runs (
                id,
                project_id,
                workflow_version_id,
                workflow_snapshot_json,
                title,
                context_json,
                execution_workspace,
                workspace_mode,
                status,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                project_id,
                workflow_version_id,
                json.dumps(snapshot_payload, separators=(",", ":"), sort_keys=True),
                title,
                json.dumps(context, separators=(",", ":"), sort_keys=True),
                str(execution_workspace),
                workspace_mode,
                status,
                now,
                now,
            ),
        )

    def get(self, project_id: str, run_id: str) -> dict | None:
        row = self._db.execute(
            """
            SELECT *
            FROM runs
            WHERE project_id = ? AND id = ?
            """,
            (project_id, run_id),
        ).fetchone()
        if row is None:
            return None
        return {
            "id": row["id"],
            "projectId": row["project_id"],
            "workflowVersionId": row["workflow_version_id"],
            "workflowSnapshot": json.loads(row["workflow_snapshot_json"]),
            "title": row["title"],
            "context": _run_context(json.loads(row["context_json"])),
            "executionWorkspace": row["execution_workspace"],
            "workspaceMode": row["workspace_mode"],
            "status": row["status"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def workflow_for_run(
        self, project_id: str, run_id: str | None = None
    ) -> WorkflowDefinition:
        if run_id is None:
            run_id = project_id
            project_id = self.project_id_for_run(run_id)
        row = self._db.execute(
            """
            SELECT workflow_snapshot_json
            FROM runs
            WHERE project_id = ? AND id = ?
            """,
            (project_id, run_id),
        ).fetchone()
        if row is None:
            raise KeyError(f"Run not found: {run_id}")
        return WorkflowDefinition.model_validate(json.loads(row["workflow_snapshot_json"]))

    def list_summaries(
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
        cursor_value = _decode_run_cursor(cursor) if cursor else None
        conditions = ["project_id = ?"]
        values: list[str | int] = [project_id]
        if statuses:
            placeholders = ", ".join("?" for _ in statuses)
            conditions.append(f"status IN ({placeholders})")
            values.extend(statuses)
        if workflow_version_id:
            conditions.append("workflow_version_id = ?")
            values.append(workflow_version_id)
        if workspace_path:
            conditions.append("execution_workspace = ?")
            values.append(workspace_path)
        if query:
            conditions.append("title LIKE ? COLLATE NOCASE")
            values.append(f"%{query}%")
        if cursor_value:
            conditions.append(
                "((updated_at < ?) OR (updated_at = ? AND id < ?))"
            )
            values.extend(
                [
                    cursor_value["updatedAt"],
                    cursor_value["updatedAt"],
                    cursor_value["id"],
                ]
            )
        values.append(limit + 1)
        rows = self._db.execute(
            f"""
            WITH run_summaries AS (
                SELECT
                    runs.id,
                    runs.project_id,
                    runs.workflow_version_id,
                    runs.workflow_snapshot_json,
                    runs.title,
                    runs.context_json,
                    runs.execution_workspace,
                    COALESCE(run_projections.status, runs.status) AS status,
                    runs.created_at,
                    COALESCE(run_projections.updated_at, runs.updated_at) AS updated_at,
                    run_projections.current_node_ids_json,
                    run_projections.node_states_json,
                    run_projections.blocking_reasons_json,
                    run_workspace_leases.workspace_path AS lease_workspace_path,
                    run_workspace_leases.mode AS lease_mode,
                    run_workspace_leases.status AS lease_status,
                    (
                        SELECT COUNT(*) FROM agent_jobs
                        WHERE agent_jobs.run_id = runs.id
                          AND agent_jobs.status IN ('QUEUED', 'RUNNING')
                    ) AS active_agent_count,
                    (
                        SELECT COUNT(*) FROM deployments
                        WHERE deployments.run_id = runs.id
                          AND deployments.status IN ('QUEUED', 'RUNNING')
                    ) AS active_deployment_count
                FROM runs
                LEFT JOIN run_projections ON run_projections.run_id = runs.id
                LEFT JOIN run_workspace_leases ON run_workspace_leases.run_id = runs.id
            )
            SELECT * FROM run_summaries
            WHERE {' AND '.join(conditions)}
            ORDER BY updated_at DESC, id DESC
            LIMIT ?
            """,
            values,
        ).fetchall()
        has_next_page = len(rows) > limit
        page_rows = rows[:limit]
        items = [_run_summary_from_row(row) for row in page_rows]
        next_cursor = None
        if has_next_page and page_rows:
            next_cursor = _encode_run_cursor(
                updated_at=page_rows[-1]["updated_at"], id=page_rows[-1]["id"]
            )
        return {"items": items, "nextCursor": next_cursor}

    def project_root_for_run(self, run_id: str) -> Path:
        row = self._db.execute(
            """
            SELECT projects.root_path
            FROM runs
            JOIN projects ON projects.id = runs.project_id
            WHERE runs.id = ?
            """,
            (run_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"Run not found: {run_id}")
        return Path(row["root_path"])

    def execution_workspace_for_run(self, run_id: str) -> Path:
        row = self._db.execute(
            "SELECT execution_workspace FROM runs WHERE id = ?",
            (run_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"Run not found: {run_id}")
        return Path(row["execution_workspace"])

    def project_id_for_run(self, run_id: str) -> str:
        row = self._db.execute(
            """
            SELECT project_id
            FROM runs
            WHERE id = ?
            """,
            (run_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"Run not found: {run_id}")
        return str(row["project_id"])

    def list_for_workflow_version(self, workflow_version_id: str) -> list[dict]:
        target = self._db.execute(
            """
            SELECT project_id, definition_json
            FROM workflow_versions
            WHERE id = ?
            """,
            (workflow_version_id,),
        ).fetchone()
        if target is None:
            return []
        workflow_id = WorkflowDefinition.model_validate(
            json.loads(target["definition_json"])
        ).id
        rows = self._db.execute(
            """
            SELECT
                runs.id,
                runs.title,
                runs.context_json,
                COALESCE(run_projections.status, runs.status) AS status,
                runs.created_at,
                COALESCE(run_projections.updated_at, runs.updated_at) AS updated_at
            FROM runs
            JOIN workflow_versions ON workflow_versions.id = runs.workflow_version_id
            LEFT JOIN run_projections ON run_projections.run_id = runs.id
            WHERE workflow_versions.project_id = ?
              AND json_extract(workflow_versions.definition_json, '$.id') = ?
            ORDER BY updated_at DESC, runs.id DESC
            """,
            (target["project_id"], workflow_id),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "title": row["title"],
                "context": _run_context(json.loads(row["context_json"])),
                "status": row["status"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]


def _run_context(value: object) -> dict:
    context = value if isinstance(value, dict) else {}
    task_goal = context.get("taskGoal")
    parameters = context.get("parameters")
    execution_workspace = context.get("executionWorkspace")
    result = {
        "taskGoal": task_goal if isinstance(task_goal, str) else "",
        "parameters": parameters if isinstance(parameters, dict) else {},
    }
    if isinstance(execution_workspace, str) and execution_workspace:
        result["executionWorkspace"] = execution_workspace
    return result


def _encode_run_cursor(*, updated_at: str, id: str) -> str:
    payload = json.dumps(
        {"updatedAt": updated_at, "id": id},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_run_cursor(cursor: str) -> dict[str, str]:
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = base64.b64decode(
            cursor + padding,
            altchars=b"-_",
            validate=True,
        )
        value = json.loads(payload.decode("utf-8"))
        if (
            not isinstance(value, dict)
            or set(value) != {"updatedAt", "id"}
            or not isinstance(value["updatedAt"], str)
            or not isinstance(value["id"], str)
            or not value["updatedAt"]
            or not value["id"]
        ):
            raise ValueError
        return value
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError("INVALID_REQUEST: invalid cursor") from error


def _run_summary_from_row(row: sqlite3.Row) -> dict:
    workflow = json.loads(row["workflow_snapshot_json"])
    nodes = workflow.get("nodes", [])
    nodes_by_id = {node["id"]: node for node in nodes}
    current_node_ids = json.loads(row["current_node_ids_json"] or "[]")
    node_states = json.loads(row["node_states_json"] or "{}")
    current_nodes = [
        {
            "id": node_id,
            "name": nodes_by_id[node_id]["name"],
            "kind": nodes_by_id[node_id]["kind"],
            "state": node_states.get(node_id, "PENDING"),
        }
        for node_id in current_node_ids
        if node_id in nodes_by_id
    ]
    next_nodes = []
    seen_next_nodes: set[str] = set()
    for edge in workflow.get("edges", []):
        target_id = edge.get("to")
        if (
            edge.get("from") not in current_node_ids
            or target_id not in nodes_by_id
            or target_id in seen_next_nodes
        ):
            continue
        seen_next_nodes.add(target_id)
        target = nodes_by_id[target_id]
        next_nodes.append(
            {
                "id": target_id,
                "name": target["name"],
                "kind": target["kind"],
                "condition": edge.get("condition"),
            }
        )

    states = [node_states.get(node["id"], "PENDING") for node in nodes]
    passed = sum(state in {"PASSED", "SKIPPED"} for state in states)
    running = sum(
        state
        in {
            "RUNNING",
            "AWAITING_ARTIFACT",
            "AWAITING_APPROVAL",
            "AWAITING_GATE",
        }
        for state in states
    )
    blocked = sum(state in {"BLOCKED", "FAILED"} for state in states)
    context = _run_context(json.loads(row["context_json"]))
    blockers = json.loads(row["blocking_reasons_json"] or "[]")
    workspace = None
    if row["lease_workspace_path"] is not None:
        workspace = {
            "path": row["lease_workspace_path"],
            "label": Path(row["lease_workspace_path"]).name,
            "leaseMode": row["lease_mode"],
            "leaseStatus": row["lease_status"],
        }
    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "workflowVersionId": row["workflow_version_id"],
        "workflowName": workflow.get("name", ""),
        "workflowVersion": workflow.get("version", ""),
        "title": row["title"],
        "status": row["status"],
        "taskGoal": context.get("taskGoal") or None,
        "currentNodes": current_nodes,
        "nextNodes": next_nodes,
        "progress": {
            "total": len(states),
            "passed": passed,
            "running": running,
            "blocked": blocked,
            "pending": len(states) - passed - running - blocked,
        },
        "blocker": blockers[0] if blockers else None,
        "workspace": workspace,
        "activeAgentCount": row["active_agent_count"],
        "activeDeploymentCount": row["active_deployment_count"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


LEASE_TRANSITIONS = {
    "active": {"released", "expired"},
    "expired": {"released"},
    "released": set(),
}


class WorkspaceLeaseRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def acquire(
        self,
        *,
        id: str,
        project_id: str,
        run_id: str,
        workspace_path: str,
        mode: str,
        acquired_at: str,
    ) -> None:
        try:
            self._db.execute(
                """
                INSERT INTO run_workspace_leases (
                    id, project_id, run_id, workspace_path, mode, status,
                    acquired_at, last_verified_at
                ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
                """,
                (
                    id,
                    project_id,
                    run_id,
                    workspace_path,
                    mode,
                    acquired_at,
                    acquired_at,
                ),
            )
        except sqlite3.IntegrityError as error:
            if (
                "run_workspace_leases.project_id, "
                "run_workspace_leases.workspace_path"
            ) in str(error):
                raise ValueError("WORKSPACE_LEASE_CONFLICT") from error
            raise

    def get_for_run(self, run_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM run_workspace_leases WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def active_for_path(self, project_id: str, workspace_path: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM run_workspace_leases
            WHERE project_id = ? AND workspace_path = ? AND status = 'active'
            ORDER BY acquired_at, id
            """,
            (project_id, workspace_path),
        ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def verify(self, run_id: str, *, verified_at: str) -> None:
        cursor = self._db.execute(
            """
            UPDATE run_workspace_leases
            SET last_verified_at = ?
            WHERE run_id = ?
            """,
            (verified_at, run_id),
        )
        if cursor.rowcount == 0:
            raise KeyError(f"Workspace lease not found for Run: {run_id}")

    def transition(
        self,
        run_id: str,
        *,
        status: str,
        reason: str,
        transitioned_at: str,
    ) -> None:
        current = self._db.execute(
            "SELECT status FROM run_workspace_leases WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        if current is None:
            raise KeyError(f"Workspace lease not found for Run: {run_id}")
        if status not in LEASE_TRANSITIONS.get(current["status"], set()):
            raise ValueError("WORKSPACE_LEASE_TRANSITION_INVALID")
        if status in {"expired", "released"} and not reason.strip():
            raise ValueError("WORKSPACE_LEASE_RELEASE_REASON_REQUIRED")

        self._db.execute(
            """
            UPDATE run_workspace_leases
            SET status = ?, released_at = ?, release_reason = ?
            WHERE run_id = ?
            """,
            (status, transitioned_at, reason.strip(), run_id),
        )

    def list_for_project(self, project_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM run_workspace_leases
            WHERE project_id = ?
            ORDER BY acquired_at, id
            """,
            (project_id,),
        ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "projectId": row["project_id"],
            "runId": row["run_id"],
            "workspacePath": row["workspace_path"],
            "mode": row["mode"],
            "status": row["status"],
            "acquiredAt": row["acquired_at"],
            "lastVerifiedAt": row["last_verified_at"],
            "releasedAt": row["released_at"],
            "releaseReason": row["release_reason"],
        }


class RunEventRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def list_for_run(self, run_id: str) -> list[RunEvent]:
        rows = self._db.execute(
            """
            SELECT *
            FROM run_events
            WHERE run_id = ?
            ORDER BY sequence
            """,
            (run_id,),
        ).fetchall()
        return [
            RunEvent(
                id=row["id"],
                runId=row["run_id"],
                type=row["type"],
                nodeId=row["node_id"],
                actor=Actor.model_validate(json.loads(row["actor_json"])),
                payload=json.loads(row["payload_json"]),
                createdAt=row["created_at"],
                revision=row["revision"],
            )
            for row in rows
        ]

    def append(self, event: RunEvent, sequence: int) -> None:
        self._db.execute(
            """
            INSERT INTO run_events (
                id,
                run_id,
                sequence,
                type,
                node_id,
                actor_json,
                payload_json,
                revision,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event.id,
                event.runId,
                sequence,
                event.type,
                event.nodeId,
                json.dumps(event.actor.model_dump(), separators=(",", ":"), sort_keys=True),
                json.dumps(event.payload, separators=(",", ":"), sort_keys=True),
                event.revision,
                event.createdAt,
            ),
        )


class ArtifactRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(
        self,
        *,
        id: str,
        run_id: str,
        node_id: str,
        type: str,
        uri: str,
        content_hash: str,
        producer: Actor,
        created_at: str,
        artifact_spec_id: str | None = None,
        workflow_version_id: str | None = None,
        template_path: str | None = None,
        relative_path: str | None = None,
        file_size: int | None = None,
        media_type: str | None = None,
        status: str = "verified",
    ) -> None:
        supersedes_artifact_id: str | None = None
        if artifact_spec_id is not None and status == "verified":
            previous = self._db.execute(
                "SELECT id FROM artifacts WHERE run_id = ? AND node_id = ? AND artifact_spec_id = ? AND status = 'verified' ORDER BY created_at DESC, id DESC LIMIT 1",
                (run_id, node_id, artifact_spec_id),
            ).fetchone()
            if previous is not None:
                supersedes_artifact_id = previous["id"]
                self._db.execute("UPDATE artifacts SET status = 'invalidated' WHERE id = ?", (previous["id"],))
        self._db.execute(
            """
            INSERT INTO artifacts (
                id,
                run_id,
                node_id,
                type,
                uri,
                content_hash,
                producer_json,
                created_at, artifact_spec_id, workflow_version_id, template_path,
                relative_path, file_size, media_type, status, supersedes_artifact_id, verified_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                run_id,
                node_id,
                type,
                uri,
                content_hash,
                json.dumps(producer.model_dump(), separators=(",", ":"), sort_keys=True),
                created_at,
                artifact_spec_id, workflow_version_id, template_path, relative_path,
                file_size, media_type, status, supersedes_artifact_id,
                created_at if status == "verified" else None,
            ),
        )

    def list_for_run(self, run_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM artifacts
            WHERE run_id = ?
            ORDER BY created_at, id
            """,
            (run_id,),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "runId": row["run_id"],
                "nodeId": row["node_id"],
                "type": row["type"],
                "uri": row["uri"],
                "contentHash": row["content_hash"],
                "artifactSpecId": row["artifact_spec_id"],
                "workflowVersionId": row["workflow_version_id"],
                "templatePath": row["template_path"],
                "relativePath": row["relative_path"],
                "fileSize": row["file_size"],
                "mediaType": row["media_type"],
                "status": row["status"],
                "supersedesArtifactId": row["supersedes_artifact_id"],
                "producer": json.loads(row["producer_json"]),
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    def get_for_run(self, run_id: str, artifact_id: str) -> dict:
        row = self._db.execute(
            """
            SELECT *
            FROM artifacts
            WHERE run_id = ? AND id = ?
            """,
            (run_id, artifact_id),
        ).fetchone()
        if row is None:
            raise KeyError(f"artifact {artifact_id} was not found for run {run_id}")
        return {
            "id": row["id"],
            "runId": row["run_id"],
            "nodeId": row["node_id"],
            "type": row["type"],
            "uri": row["uri"],
            "contentHash": row["content_hash"],
            "artifactSpecId": row["artifact_spec_id"],
            "workflowVersionId": row["workflow_version_id"],
            "templatePath": row["template_path"],
            "relativePath": row["relative_path"],
            "fileSize": row["file_size"],
            "mediaType": row["media_type"],
            "status": row["status"],
            "supersedesArtifactId": row["supersedes_artifact_id"],
            "producer": json.loads(row["producer_json"]),
            "createdAt": row["created_at"],
        }

    def confirm(self, *, run_id: str, artifact_id: str, verified_at: str) -> dict:
        provisional = self.get_for_run(run_id, artifact_id)
        if provisional["status"] != "provisional":
            raise ValueError("ARTIFACT_CONFIRMATION_INVALID: artifact is not provisional")
        supersedes_artifact_id: str | None = None
        if provisional["artifactSpecId"] is not None:
            previous = self._db.execute(
                "SELECT id FROM artifacts WHERE run_id = ? AND node_id = ? AND artifact_spec_id = ? AND status = 'verified' ORDER BY created_at DESC, id DESC LIMIT 1",
                (run_id, provisional["nodeId"], provisional["artifactSpecId"]),
            ).fetchone()
            if previous is not None:
                supersedes_artifact_id = previous["id"]
                self._db.execute("UPDATE artifacts SET status = 'invalidated' WHERE id = ?", (supersedes_artifact_id,))
        self._db.execute(
            "UPDATE artifacts SET status = 'verified', verified_at = ?, supersedes_artifact_id = ? WHERE run_id = ? AND id = ? AND status = 'provisional'",
            (verified_at, supersedes_artifact_id, run_id, artifact_id),
        )
        artifact = self.get_for_run(run_id, artifact_id)
        return artifact

    def record_consumer(
        self,
        *,
        id: str,
        artifact_id: str,
        consumer_run_id: str,
        consumer_node_id: str,
        agent_job_id: str,
        context_created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT OR IGNORE INTO artifact_consumers (
                id, artifact_id, consumer_run_id, consumer_node_id, agent_job_id, context_created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (id, artifact_id, consumer_run_id, consumer_node_id, agent_job_id, context_created_at),
        )

    def list_consumers(self, *, run_id: str, artifact_id: str) -> list[dict]:
        self.get_for_run(run_id, artifact_id)
        rows = self._db.execute(
            """
            SELECT id, artifact_id, consumer_run_id, consumer_node_id, agent_job_id, context_created_at
            FROM artifact_consumers
            WHERE artifact_id = ? AND consumer_run_id = ?
            ORDER BY context_created_at, id
            """,
            (artifact_id, run_id),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "artifactId": row["artifact_id"],
                "consumerRunId": row["consumer_run_id"],
                "consumerNodeId": row["consumer_node_id"],
                "agentJobId": row["agent_job_id"],
                "contextCreatedAt": row["context_created_at"],
            }
            for row in rows
        ]

    def verified_hashes_for_node(self, *, run_id: str, node_id: str) -> list[str]:
        rows = self._db.execute(
            "SELECT content_hash FROM artifacts WHERE run_id = ? AND node_id = ? AND status = 'verified' ORDER BY artifact_spec_id, created_at, id",
            (run_id, node_id),
        ).fetchall()
        return [row["content_hash"] for row in rows]


class ApprovalRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(
        self,
        *,
        id: str,
        run_id: str,
        node_id: str,
        status: str,
        requested_by: Actor,
        decided_by: Actor,
        comment: str | None,
        artifact_hashes: list[str],
        created_at: str,
        decided_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO approvals (
                id,
                run_id,
                node_id,
                status,
                requested_by_json,
                decided_by_json,
                comment,
                artifact_hashes_json,
                created_at,
                decided_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                run_id,
                node_id,
                status,
                json.dumps(requested_by.model_dump(), separators=(",", ":"), sort_keys=True),
                json.dumps(decided_by.model_dump(), separators=(",", ":"), sort_keys=True),
                comment,
                json.dumps(artifact_hashes, separators=(",", ":")),
                created_at,
                decided_at,
            ),
        )

    def list_for_run(self, run_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM approvals
            WHERE run_id = ?
            ORDER BY created_at, id
            """,
            (run_id,),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "runId": row["run_id"],
                "nodeId": row["node_id"],
                "status": row["status"],
                "requestedBy": json.loads(row["requested_by_json"]),
                "decidedBy": json.loads(row["decided_by_json"])
                if row["decided_by_json"]
                else None,
                "comment": row["comment"],
                "artifactHashes": json.loads(row["artifact_hashes_json"] or "[]"),
                "invalidatedAt": row["invalidated_at"],
                "invalidationReason": row["invalidation_reason"],
                "createdAt": row["created_at"],
                "decidedAt": row["decided_at"],
            }
            for row in rows
        ]

    def invalidate_for_node(self, *, run_id: str, node_id: str, reason: str, invalidated_at: str) -> int:
        cursor = self._db.execute(
            "UPDATE approvals SET invalidated_at = ?, invalidation_reason = ? WHERE run_id = ? AND node_id = ? AND invalidated_at IS NULL",
            (invalidated_at, reason, run_id, node_id),
        )
        return cursor.rowcount


class GateResultRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(
        self,
        *,
        id: str,
        run_id: str,
        node_id: str,
        gate_id: str,
        status: str,
        evidence: list[str],
        waiver_reason: str | None,
        failure_reason: str | None,
        actor: Actor,
        created_at: str,
        artifact_hashes: list[str],
    ) -> None:
        payload = {
            "evidence": evidence,
            "waiverReason": waiver_reason,
            "failureReason": failure_reason,
            "artifactHashes": artifact_hashes,
        }
        self._db.execute(
            """
            INSERT INTO gate_results (
                id,
                run_id,
                node_id,
                gate_id,
                status,
                evidence_json,
                actor_json,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                run_id,
                node_id,
                gate_id,
                status,
                json.dumps(payload, separators=(",", ":"), sort_keys=True),
                json.dumps(actor.model_dump(), separators=(",", ":"), sort_keys=True),
                created_at,
            ),
        )

    def list_for_run(self, run_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM gate_results
            WHERE run_id = ?
            ORDER BY created_at, id
            """,
            (run_id,),
        ).fetchall()
        results = []
        for row in rows:
            payload = json.loads(row["evidence_json"])
            results.append(
                {
                    "id": row["id"],
                    "runId": row["run_id"],
                    "nodeId": row["node_id"],
                    "gateId": row["gate_id"],
                    "status": row["status"],
                    "evidence": payload["evidence"],
                    "waiverReason": payload.get("waiverReason"),
                    "failureReason": payload.get("failureReason"),
                    "artifactHashes": payload.get("artifactHashes", []),
                    "invalidatedAt": row["invalidated_at"],
                    "invalidationReason": row["invalidation_reason"],
                    "actor": json.loads(row["actor_json"]),
                    "createdAt": row["created_at"],
                }
            )
        return results

    def invalidate_for_node(self, *, run_id: str, node_id: str, reason: str, invalidated_at: str) -> int:
        cursor = self._db.execute(
            "UPDATE gate_results SET invalidated_at = ?, invalidation_reason = ? WHERE run_id = ? AND node_id = ? AND invalidated_at IS NULL",
            (invalidated_at, reason, run_id, node_id),
        )
        return cursor.rowcount


class TerminalSessionRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(
        self,
        *,
        id: str,
        project_id: str,
        run_id: str,
        node_id: str | None,
        kind: str,
        status: str,
        cwd: str,
        pid: int | None,
        created_at: str,
        updated_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO terminal_sessions (
                id,
                project_id,
                run_id,
                node_id,
                kind,
                status,
                cwd,
                pid,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                pid = excluded.pid,
                updated_at = excluded.updated_at
            """,
            (
                id,
                project_id,
                run_id,
                node_id,
                kind,
                status,
                cwd,
                pid,
                created_at,
                updated_at,
            ),
        )

    def list_for_run(self, run_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM terminal_sessions
            WHERE run_id = ?
            ORDER BY created_at, id
            """,
            (run_id,),
        ).fetchall()
        return [self._session_row_to_dict(row) for row in rows]

    def stop(self, run_id: str, session_id: str, *, updated_at: str) -> dict:
        cursor = self._db.execute(
            """
            UPDATE terminal_sessions
            SET status = ?, pid = NULL, updated_at = ?
            WHERE id = ? AND run_id = ?
            """,
            ("stopped", updated_at, session_id, run_id),
        )
        if cursor.rowcount != 1:
            raise KeyError(f"Terminal session not found: {session_id}")
        row = self._db.execute(
            """
            SELECT *
            FROM terminal_sessions
            WHERE id = ? AND run_id = ?
            """,
            (session_id, run_id),
        ).fetchone()
        if row is None:
            raise KeyError(f"Terminal session not found: {session_id}")
        return self._session_row_to_dict(row)

    def append_output(
        self,
        *,
        id: str,
        session_id: str,
        sequence: int,
        stream: str,
        data: str,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO terminal_output_events (
                id,
                session_id,
                sequence,
                stream,
                data,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (id, session_id, sequence, stream, data, created_at),
        )

    def list_output(self, session_id: str, *, after_sequence: int = 0) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM terminal_output_events
            WHERE session_id = ? AND sequence > ?
            ORDER BY sequence
            """,
            (session_id, after_sequence),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "sessionId": row["session_id"],
                "sequence": row["sequence"],
                "stream": row["stream"],
                "data": row["data"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    @staticmethod
    def _session_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "projectId": row["project_id"],
            "runId": row["run_id"],
            "nodeId": row["node_id"],
            "kind": row["kind"],
            "status": row["status"],
            "cwd": row["cwd"],
            "pid": row["pid"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }


class AgentJobRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        run_id: str | None,
        node_id: str | None,
        provider: str,
        status: str,
        command: list[str],
        cwd: str,
        created_at: str,
        mode: str = "automatic",
        session_id: str | None = None,
        parent_job_id: str | None = None,
        project_id: str | None = None,
        purpose: str = "workflow-node",
        owner_id: str | None = None,
        metadata: dict | None = None,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO agent_jobs (
                id,
                project_id,
                run_id,
                node_id,
                purpose,
                owner_id,
                provider,
                status,
                command_json,
                cwd,
                mode,
                session_id,
                parent_job_id,
                metadata_json,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                project_id,
                run_id,
                node_id,
                purpose,
                owner_id,
                provider,
                status,
                json.dumps(command, separators=(",", ":"), sort_keys=True),
                cwd,
                mode,
                session_id,
                parent_job_id,
                json.dumps(metadata or {}, separators=(",", ":"), sort_keys=True),
                created_at,
                created_at,
            ),
        )
    def set_running(self, *, id: str, pid: int, updated_at: str) -> None:
        self._db.execute(
            """
            UPDATE agent_jobs
            SET status = ?, pid = ?, updated_at = ?
            WHERE id = ?
            """,
            ("RUNNING", pid, updated_at, id),
        )

    def set_status(self, *, id: str, status: str, updated_at: str) -> None:
        self._db.execute(
            """
            UPDATE agent_jobs
            SET status = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, updated_at, id),
        )

    def finish(
        self,
        *,
        id: str,
        status: str,
        summary: str | None,
        error: str | None,
        updated_at: str,
    ) -> None:
        self._db.execute(
            """
            UPDATE agent_jobs
            SET status = ?, summary = ?, error = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, summary, error, updated_at, id),
        )

    def get(self, id: str) -> dict | None:
        row = self._db.execute(
            """
            SELECT *
            FROM agent_jobs
            WHERE id = ?
            """,
            (id,),
        ).fetchone()
        if row is None:
            return None
        return self._job_row_to_dict(row)

    def list_for_run(self, run_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM agent_jobs
            WHERE run_id = ?
            ORDER BY created_at, id
            """,
            (run_id,),
        ).fetchall()
        return [self._job_row_to_dict(row) for row in rows]

    def append_output(
        self,
        *,
        id: str,
        job_id: str,
        sequence: int,
        kind: str,
        payload: dict,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO agent_output_events (
                id,
                job_id,
                sequence,
                kind,
                payload_json,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                job_id,
                sequence,
                kind,
                json.dumps(payload, separators=(",", ":"), sort_keys=True),
                created_at,
            ),
        )

    def list_output(self, job_id: str, after_sequence: int = 0) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM agent_output_events
            WHERE job_id = ? AND sequence > ?
            ORDER BY sequence
            """,
            (job_id, after_sequence),
        ).fetchall()
        return [self._output_row_to_dict(row) for row in rows]

    def delete_output(self, output_ids: list[str]) -> None:
        if not output_ids:
            return
        placeholders = ", ".join("?" for _ in output_ids)
        self._db.execute(
            f"DELETE FROM agent_output_events WHERE id IN ({placeholders})",
            output_ids,
        )

    def get_owned(self, id: str, *, purpose: str, owner_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM agent_jobs WHERE id = ? AND purpose = ? AND owner_id = ?",
            (id, purpose, owner_id),
        ).fetchone()
        return self._job_row_to_dict(row) if row is not None else None

    def list_by_purpose_owner(self, *, purpose: str, owner_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM agent_jobs
            WHERE purpose = ? AND owner_id = ?
            ORDER BY created_at, id
            """,
            (purpose, owner_id),
        ).fetchall()
        return [self._job_row_to_dict(row) for row in rows]

    def list_active_by_purpose(self, purpose: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM agent_jobs
            WHERE purpose = ? AND status IN ('QUEUED', 'RUNNING')
            ORDER BY created_at, id
            """,
            (purpose,),
        ).fetchall()
        return [self._job_row_to_dict(row) for row in rows]

    def list_active_by_purpose_owner(self, *, purpose: str, owner_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM agent_jobs
            WHERE purpose = ? AND owner_id = ? AND status IN ('QUEUED', 'RUNNING')
            ORDER BY created_at, id
            """,
            (purpose, owner_id),
        ).fetchall()
        return [self._job_row_to_dict(row) for row in rows]

    def count_active_by_purpose(self, purpose: str) -> int:
        row = self._db.execute(
            """
            SELECT COUNT(*) AS c FROM agent_jobs
            WHERE purpose = ? AND status IN ('QUEUED', 'RUNNING')
            """,
            (purpose,),
        ).fetchone()
        return int(row["c"])

    def set_metadata(self, id: str, *, metadata: dict, updated_at: str) -> None:
        self._db.execute(
            "UPDATE agent_jobs SET metadata_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(metadata, separators=(",", ":"), sort_keys=True), updated_at, id),
        )

    @staticmethod
    def _job_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "projectId": row["project_id"],
            "runId": row["run_id"],
            "nodeId": row["node_id"],
            "purpose": row["purpose"],
            "ownerId": row["owner_id"],
            "provider": row["provider"],
            "status": row["status"],
            "mode": row["mode"],
            "command": json.loads(row["command_json"]),
            "cwd": row["cwd"],
            "pid": row["pid"],
            "sessionId": row["session_id"],
            "parentJobId": row["parent_job_id"],
            "metadata": json.loads(row["metadata_json"]) if row["metadata_json"] else {},
            "summary": row["summary"],
            "error": row["error"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _output_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "jobId": row["job_id"],
            "sequence": row["sequence"],
            "kind": row["kind"],
            "payload": json.loads(row["payload_json"]),
            "createdAt": row["created_at"],
        }


class AgentSessionRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        run_id: str,
        job_id: str,
        provider: str,
        cwd: str,
        max_output_bytes: int,
        created_at: str,
        kind: str = "interactive",
    ) -> None:
        self._db.execute(
            """
            INSERT INTO agent_sessions (
                id,
                run_id,
                job_id,
                provider,
                status,
                kind,
                cwd,
                max_output_bytes,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                run_id,
                job_id,
                provider,
                "QUEUED",
                kind,
                cwd,
                max_output_bytes,
                created_at,
                created_at,
            ),
        )

    def mark_running(
        self,
        *,
        id: str,
        desktop_session_id: str,
        pid: int,
        updated_at: str,
    ) -> None:
        self._db.execute(
            """
            UPDATE agent_sessions
            SET status = ?, desktop_session_id = ?, pid = ?, updated_at = ?
            WHERE id = ?
            """,
            ("RUNNING", desktop_session_id, pid, updated_at, id),
        )

    def finish(
        self,
        *,
        id: str,
        status: str,
        recovery_reason: str | None,
        ended_at: str,
    ) -> None:
        self._db.execute(
            """
            UPDATE agent_sessions
            SET status = ?, recovery_reason = ?, updated_at = ?, ended_at = ?
            WHERE id = ?
            """,
            (status, recovery_reason, ended_at, ended_at, id),
        )

    def get_for_job(self, job_id: str) -> dict | None:
        row = self._db.execute(
            """
            SELECT *
            FROM agent_sessions
            WHERE job_id = ?
            """,
            (job_id,),
        ).fetchone()
        if row is None:
            return None
        return self._session_row_to_dict(row)

    def append_input(
        self,
        *,
        id: str,
        session_id: str,
        sequence: int,
        kind: str,
        content: str,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO agent_input_events (
                id,
                session_id,
                sequence,
                kind,
                content,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (id, session_id, sequence, kind, content, created_at),
        )

    def list_input(self, session_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM agent_input_events
            WHERE session_id = ?
            ORDER BY sequence
            """,
            (session_id,),
        ).fetchall()
        return [self._input_row_to_dict(row) for row in rows]

    @staticmethod
    def _session_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "runId": row["run_id"],
            "jobId": row["job_id"],
            "provider": row["provider"],
            "status": row["status"],
            "kind": row["kind"],
            "desktopSessionId": row["desktop_session_id"],
            "pid": row["pid"],
            "cwd": row["cwd"],
            "maxOutputBytes": row["max_output_bytes"],
            "recoveryReason": row["recovery_reason"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
            "endedAt": row["ended_at"],
        }

    @staticmethod
    def _input_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "sessionId": row["session_id"],
            "sequence": row["sequence"],
            "kind": row["kind"],
            "content": row["content"],
            "createdAt": row["created_at"],
        }


class AgentCheckpointRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        run_id: str,
        job_id: str,
        parent_checkpoint_id: str | None,
        node_id: str,
        provider: str,
        prompt: str,
        allowed_tools: list[str],
        timeout_seconds: float,
        max_output_bytes: int,
        status: str,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO agent_checkpoints (
                id, run_id, job_id, parent_checkpoint_id, node_id, provider,
                prompt, allowed_tools_json, timeout_seconds, max_output_bytes,
                status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                run_id,
                job_id,
                parent_checkpoint_id,
                node_id,
                provider,
                prompt,
                json.dumps(allowed_tools, separators=(",", ":"), sort_keys=True),
                timeout_seconds,
                max_output_bytes,
                status,
                created_at,
                created_at,
            ),
        )

    def get(self, checkpoint_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM agent_checkpoints WHERE id = ?",
            (checkpoint_id,),
        ).fetchone()
        return self._checkpoint_row_to_dict(row) if row is not None else None

    def list_for_run(self, run_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM agent_checkpoints
            WHERE run_id = ?
            ORDER BY created_at, id
            """,
            (run_id,),
        ).fetchall()
        return [self._checkpoint_row_to_dict(row) for row in rows]

    def update_status(
        self,
        *,
        checkpoint_id: str,
        status: str,
        updated_at: str,
        recovery_reason: str | None = None,
    ) -> None:
        self._db.execute(
            """
            UPDATE agent_checkpoints
            SET status = ?, recovery_reason = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, recovery_reason, updated_at, checkpoint_id),
        )

    def update_for_job(
        self,
        *,
        job_id: str,
        status: str,
        updated_at: str,
        recovery_reason: str | None = None,
    ) -> None:
        self._db.execute(
            """
            UPDATE agent_checkpoints
            SET status = ?, recovery_reason = ?, updated_at = ?
            WHERE job_id = ?
            """,
            (status, recovery_reason, updated_at, job_id),
        )

    @staticmethod
    def _checkpoint_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "runId": row["run_id"],
            "jobId": row["job_id"],
            "parentCheckpointId": row["parent_checkpoint_id"],
            "nodeId": row["node_id"],
            "provider": row["provider"],
            "prompt": row["prompt"],
            "allowedTools": json.loads(row["allowed_tools_json"]),
            "timeoutSeconds": row["timeout_seconds"],
            "maxOutputBytes": row["max_output_bytes"],
            "status": row["status"],
            "recoveryReason": row["recovery_reason"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }


class DeploymentRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        run_id: str,
        node_id: str,
        command: list[str],
        cwd: str,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO deployments (
                id, run_id, node_id, command_json, cwd, status, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                run_id,
                node_id,
                json.dumps(command, ensure_ascii=False, separators=(",", ":")),
                cwd,
                "QUEUED",
                created_at,
                created_at,
            ),
        )

    def set_running(self, *, id: str, pid: int, updated_at: str) -> None:
        self._db.execute(
            """
            UPDATE deployments
            SET status = ?, pid = ?, updated_at = ?
            WHERE id = ?
            """,
            ("RUNNING", pid, updated_at, id),
        )

    def finish(
        self,
        *,
        id: str,
        status: str,
        summary: str | None,
        error: str | None,
        updated_at: str,
    ) -> None:
        self._db.execute(
            """
            UPDATE deployments
            SET status = ?, summary = ?, error = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, summary, error, updated_at, id),
        )

    def get(self, deployment_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM deployments WHERE id = ?",
            (deployment_id,),
        ).fetchone()
        return self._deployment_row_to_dict(row) if row is not None else None

    def list_for_run(self, run_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM deployments
            WHERE run_id = ?
            ORDER BY created_at DESC, id DESC
            """,
            (run_id,),
        ).fetchall()
        return [self._deployment_row_to_dict(row) for row in rows]

    def append_output(
        self,
        *,
        id: str,
        deployment_id: str,
        sequence: int,
        data: str,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO deployment_output_events (id, deployment_id, sequence, data, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (id, deployment_id, sequence, data, created_at),
        )

    def list_output(self, deployment_id: str, *, after_sequence: int = 0) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM deployment_output_events
            WHERE deployment_id = ? AND sequence > ?
            ORDER BY sequence
            """,
            (deployment_id, after_sequence),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "deploymentId": row["deployment_id"],
                "sequence": row["sequence"],
                "data": row["data"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    @staticmethod
    def _deployment_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "runId": row["run_id"],
            "nodeId": row["node_id"],
            "command": json.loads(row["command_json"]),
            "cwd": row["cwd"],
            "status": row["status"],
            "pid": row["pid"],
            "summary": row["summary"],
            "error": row["error"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }


class ProjectionRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(self, projection: RunProjection) -> None:
        self._db.execute(
            """
            INSERT INTO run_projections (
                run_id,
                status,
                current_node_ids_json,
                node_states_json,
                allowed_actions_json,
                blocking_reasons_json,
                revision,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id) DO UPDATE SET
                status = excluded.status,
                current_node_ids_json = excluded.current_node_ids_json,
                node_states_json = excluded.node_states_json,
                allowed_actions_json = excluded.allowed_actions_json,
                blocking_reasons_json = excluded.blocking_reasons_json,
                revision = excluded.revision,
                updated_at = excluded.updated_at
            """,
            (
                projection.runId,
                projection.status,
                json.dumps(projection.currentNodeIds, separators=(",", ":"), sort_keys=True),
                json.dumps(projection.nodeStates, separators=(",", ":"), sort_keys=True),
                json.dumps(
                    [action.model_dump() for action in projection.allowedActions],
                    separators=(",", ":"),
                    sort_keys=True,
                ),
                json.dumps(
                    [reason.model_dump() for reason in projection.blockingReasons],
                    separators=(",", ":"),
                    sort_keys=True,
                ),
                projection.revision,
                projection.updatedAt,
            ),
        )

    def get(self, run_id: str) -> RunProjection | None:
        row = self._db.execute(
            """
            SELECT *
            FROM run_projections
            WHERE run_id = ?
            """,
            (run_id,),
        ).fetchone()
        if row is None:
            return None
        return RunProjection(
            runId=row["run_id"],
            status=row["status"],
            currentNodeIds=json.loads(row["current_node_ids_json"]),
            nodeStates=json.loads(row["node_states_json"]),
            allowedActions=json.loads(row["allowed_actions_json"]),
            blockingReasons=json.loads(row["blocking_reasons_json"]),
            revision=row["revision"],
            updatedAt=row["updated_at"],
        )


class AuditRecordRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def latest_hash(self) -> str | None:
        row = self._db.execute(
            """
            SELECT record_hash
            FROM audit_records
            ORDER BY rowid DESC
            LIMIT 1
            """
        ).fetchone()
        return row["record_hash"] if row is not None else None

    def append(
        self,
        *,
        id: str,
        actor: Actor,
        action: str,
        resource: str,
        detail: dict,
        previous_hash: str | None,
        record_hash: str,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO audit_records (
                id,
                actor_id,
                actor_json,
                action,
                resource,
                detail_json,
                previous_hash,
                record_hash,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                actor.id,
                json.dumps(actor.model_dump(), separators=(",", ":"), sort_keys=True),
                action,
                resource,
                json.dumps(detail, separators=(",", ":"), sort_keys=True),
                previous_hash,
                record_hash,
                created_at,
            ),
        )

    def list(
        self,
        *,
        actor_id: str | None = None,
        action: str | None = None,
        resource: str | None = None,
        run_id: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        conditions: list[str] = []
        values: list[str | int] = []
        if actor_id:
            conditions.append("actor_id = ?")
            values.append(actor_id)
        if action:
            conditions.append("action = ?")
            values.append(action)
        if resource:
            conditions.append("resource = ?")
            values.append(resource)
        if run_id:
            conditions.append("(resource = ? OR json_extract(detail_json, '$.runId') = ?)")
            values.extend((f"run:{run_id}", run_id))
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        values.append(limit)
        rows = self._db.execute(
            f"""
            SELECT *
            FROM audit_records
            {where}
            ORDER BY rowid
            LIMIT ?
            """,
            values,
        ).fetchall()
        return [
            {
                "id": row["id"],
                "actor": json.loads(row["actor_json"]),
                "action": row["action"],
                "resource": row["resource"],
                "detail": json.loads(row["detail_json"]),
                "previousHash": row["previous_hash"],
                "recordHash": row["record_hash"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]


class KnowledgeRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create_candidate(
        self,
        *,
        id: str,
        title: str,
        content: str,
        source: str,
        actor: Actor,
        created_at: str,
    ) -> dict:
        self._db.execute(
            """
            INSERT INTO knowledge_candidates (
                id,
                title,
                content,
                source,
                status,
                created_by_json,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                title,
                content,
                source,
                "pending",
                json.dumps(actor.model_dump(), separators=(",", ":"), sort_keys=True),
                created_at,
            ),
        )
        candidate = self.get_candidate(id)
        if candidate is None:
            raise RuntimeError("知识候选创建后无法读取。")
        return candidate

    def get_candidate(self, candidate_id: str) -> dict | None:
        row = self._db.execute(
            """
            SELECT *
            FROM knowledge_candidates
            WHERE id = ?
            """,
            (candidate_id,),
        ).fetchone()
        return self._candidate_row_to_dict(row) if row is not None else None

    def list_candidates(self, *, status: str | None = None) -> list[dict]:
        if status:
            rows = self._db.execute(
                """
                SELECT *
                FROM knowledge_candidates
                WHERE status = ?
                ORDER BY created_at, id
                """,
                (status,),
            ).fetchall()
        else:
            rows = self._db.execute(
                """
                SELECT *
                FROM knowledge_candidates
                ORDER BY created_at, id
                """
            ).fetchall()
        return [self._candidate_row_to_dict(row) for row in rows]

    def review_candidate(
        self,
        candidate_id: str,
        *,
        decision: str,
        reviewer: Actor,
        comment: str | None,
        reviewed_at: str,
    ) -> dict:
        self._db.execute(
            """
            UPDATE knowledge_candidates
            SET
                status = ?,
                reviewer_json = ?,
                review_comment = ?,
                reviewed_at = ?
            WHERE id = ? AND status = ?
            """,
            (
                decision,
                json.dumps(reviewer.model_dump(), separators=(",", ":"), sort_keys=True),
                comment,
                reviewed_at,
                candidate_id,
                "pending",
            ),
        )
        candidate = self.get_candidate(candidate_id)
        if candidate is None:
            raise RuntimeError("知识候选审核后无法读取。")
        return candidate

    def mark_published(self, candidate_id: str, *, published_at: str) -> None:
        self._db.execute(
            """
            UPDATE knowledge_candidates
            SET published_at = ?
            WHERE id = ?
            """,
            (published_at, candidate_id),
        )

    def create_document(
        self,
        *,
        id: str,
        candidate: dict,
        publisher: Actor,
        published_at: str,
        content: str | None = None,
    ) -> dict:
        self._db.execute(
            """
            INSERT INTO knowledge_documents (
                id,
                candidate_id,
                title,
                content,
                source,
                status,
                published_by_json,
                published_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                candidate["id"],
                candidate["title"],
                content if content is not None else candidate["content"],
                candidate["source"],
                "published",
                json.dumps(publisher.model_dump(), separators=(",", ":"), sort_keys=True),
                published_at,
            ),
        )
        document = self.get_document(id)
        if document is None:
            raise RuntimeError("知识文档发布后无法读取。")
        return document

    def create_publication(
        self,
        *,
        id: str,
        candidate_id: str,
        document_id: str,
        publisher: Actor,
        published_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO knowledge_publications (
                id,
                candidate_id,
                document_id,
                published_by_json,
                published_at
            )
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                id,
                candidate_id,
                document_id,
                json.dumps(publisher.model_dump(), separators=(",", ":"), sort_keys=True),
                published_at,
            ),
        )

    def has_publication(self, candidate_id: str) -> bool:
        return (
            self._db.execute(
                """
                SELECT 1
                FROM knowledge_publications
                WHERE candidate_id = ?
                """,
                (candidate_id,),
            ).fetchone()
            is not None
        )

    def get_document(self, document_id: str) -> dict | None:
        row = self._db.execute(
            """
            SELECT *
            FROM knowledge_documents
            WHERE id = ?
            """,
            (document_id,),
        ).fetchone()
        return self._document_row_to_dict(row) if row is not None else None

    def list_documents(self) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT *
            FROM knowledge_documents
            ORDER BY published_at DESC, id DESC
            """
        ).fetchall()
        return [self._document_row_to_dict(row) for row in rows]

    def search_documents(self, query: str) -> list[dict]:
        pattern = f"%{query}%"
        rows = self._db.execute(
            """
            SELECT *
            FROM knowledge_documents
            WHERE title LIKE ? COLLATE NOCASE OR content LIKE ? COLLATE NOCASE
            ORDER BY published_at, id
            """,
            (pattern, pattern),
        ).fetchall()
        return [self._document_row_to_dict(row) for row in rows]

    def record_git_publication(
        self,
        *,
        id: str,
        document_id: str,
        branch: str,
        relative_path: str,
        commit_hash: str,
        pushed_at: str,
    ) -> dict:
        self._db.execute(
            """
            INSERT INTO knowledge_git_publications (
                id,
                document_id,
                branch,
                relative_path,
                commit_hash,
                pushed_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (id, document_id, branch, relative_path, commit_hash, pushed_at),
        )
        return {
            "branch": branch,
            "relativePath": relative_path,
            "commitHash": commit_hash,
            "pushedAt": pushed_at,
        }

    def list_git_publications(self, document_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT branch, relative_path, commit_hash, pushed_at
            FROM knowledge_git_publications
            WHERE document_id = ?
            ORDER BY pushed_at DESC, id DESC
            """,
            (document_id,),
        ).fetchall()
        return [
            {
                "branch": row["branch"],
                "relativePath": row["relative_path"],
                "commitHash": row["commit_hash"],
                "pushedAt": row["pushed_at"],
            }
            for row in rows
        ]

    @staticmethod
    def _candidate_row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "title": row["title"],
            "content": row["content"],
            "source": row["source"],
            "status": row["status"],
            "createdBy": json.loads(row["created_by_json"]),
            "reviewedBy": json.loads(row["reviewer_json"]) if row["reviewer_json"] else None,
            "reviewComment": row["review_comment"],
            "createdAt": row["created_at"],
            "reviewedAt": row["reviewed_at"],
            "publishedAt": row["published_at"],
        }

    def _document_row_to_dict(self, row: sqlite3.Row) -> dict:
        git_publications = self.list_git_publications(row["id"])
        return {
            "id": row["id"],
            "candidateId": row["candidate_id"],
            "title": row["title"],
            "content": row["content"],
            "source": row["source"],
            "status": row["status"],
            "publishedBy": json.loads(row["published_by_json"]),
            "publishedAt": row["published_at"],
            "gitPublicationCount": len(git_publications),
            "latestGitPublication": git_publications[0] if git_publications else None,
        }


class KnowledgeSynthesisRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        candidate_id: str,
        provider: str,
        prompt: str,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO knowledge_syntheses (
                id, candidate_id, provider, status, prompt, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (id, candidate_id, provider, "QUEUED", prompt, created_at, created_at),
        )

    def set_running(self, *, id: str, updated_at: str) -> None:
        self._db.execute(
            """
            UPDATE knowledge_syntheses
            SET status = ?, updated_at = ?
            WHERE id = ?
            """,
            ("RUNNING", updated_at, id),
        )

    def finish(
        self,
        *,
        id: str,
        status: str,
        summary: str | None,
        error: str | None,
        updated_at: str,
    ) -> None:
        self._db.execute(
            """
            UPDATE knowledge_syntheses
            SET status = ?, summary = ?, error = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, summary, error, updated_at, id),
        )

    def set_feedback(self, *, id: str, feedback: str, updated_at: str) -> None:
        self._db.execute(
            """
            UPDATE knowledge_syntheses
            SET feedback = ?, updated_at = ?
            WHERE id = ?
            """,
            (feedback, updated_at, id),
        )

    def get(self, synthesis_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM knowledge_syntheses WHERE id = ?",
            (synthesis_id,),
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def list(self) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM knowledge_syntheses
            ORDER BY updated_at DESC, id DESC
            """
        ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "candidateId": row["candidate_id"],
            "provider": row["provider"],
            "status": row["status"],
            "prompt": row["prompt"],
            "summary": row["summary"],
            "error": row["error"],
            "feedback": row["feedback"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }


class KnowledgeSynthesisOutputRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def append(
        self,
        *,
        id: str,
        synthesis_id: str,
        sequence: int,
        kind: str,
        payload: dict,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO knowledge_synthesis_output_events (
                id, synthesis_id, sequence, kind, payload_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                synthesis_id,
                sequence,
                kind,
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                created_at,
            ),
        )

    def list(self, synthesis_id: str, *, after_sequence: int = 0) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM knowledge_synthesis_output_events
            WHERE synthesis_id = ? AND sequence > ?
            ORDER BY sequence
            """,
            (synthesis_id, after_sequence),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "synthesisId": row["synthesis_id"],
                "sequence": row["sequence"],
                "kind": row["kind"],
                "payload": json.loads(row["payload_json"]),
                "createdAt": row["created_at"],
            }
            for row in rows
        ]


class AgentPermissionRequestRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def create(
        self,
        *,
        id: str,
        job_id: str,
        run_id: str,
        permission_type: str,
        target: str,
        details: dict,
        created_at: str,
    ) -> None:
        self._db.execute(
            """
            INSERT INTO agent_permission_requests (
                id, job_id, run_id, permission_type, target, details_json,
                status, decided_by_json, decided_at, decision_reason, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, 'PENDING', NULL, NULL, NULL, ?, ?)
            """,
            (
                id,
                job_id,
                run_id,
                permission_type,
                target,
                json.dumps(details, ensure_ascii=False, separators=(",", ":")),
                created_at,
                created_at,
            ),
        )

    def get(self, id: str) -> dict | None:
        row = self._db.execute(
            "SELECT * FROM agent_permission_requests WHERE id = ?", (id,)
        ).fetchone()
        return self._row_to_dict(row) if row is not None else None

    def list_pending_for_job(self, job_id: str) -> list[dict]:
        rows = self._db.execute(
            """
            SELECT * FROM agent_permission_requests
            WHERE job_id = ? AND status = 'PENDING'
            ORDER BY created_at, id
            """,
            (job_id,),
        ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def list_for_job(self, job_id: str, *, status: str | None = None) -> list[dict]:
        if status is None:
            rows = self._db.execute(
                """
                SELECT * FROM agent_permission_requests
                WHERE job_id = ? ORDER BY created_at, id
                """,
                (job_id,),
            ).fetchall()
        else:
            rows = self._db.execute(
                """
                SELECT * FROM agent_permission_requests
                WHERE job_id = ? AND status = ? ORDER BY created_at, id
                """,
                (job_id, status),
            ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def list_for_run(self, run_id: str, *, status: str | None = None) -> list[dict]:
        if status is None:
            rows = self._db.execute(
                """
                SELECT * FROM agent_permission_requests
                WHERE run_id = ? ORDER BY created_at, id
                """,
                (run_id,),
            ).fetchall()
        else:
            rows = self._db.execute(
                """
                SELECT * FROM agent_permission_requests
                WHERE run_id = ? AND status = ? ORDER BY created_at, id
                """,
                (run_id, status),
            ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def decide(
        self,
        id: str,
        *,
        status: str,
        decided_by: dict,
        decided_at: str,
        reason: str | None,
    ) -> None:
        self._db.execute(
            """
            UPDATE agent_permission_requests
            SET status = ?, decided_by_json = ?, decided_at = ?,
                decision_reason = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                status,
                json.dumps(decided_by, ensure_ascii=False, separators=(",", ":")),
                decided_at,
                reason,
                decided_at,
                id,
            ),
        )

    def expire_pending_for_job(self, job_id: str, *, expired_at: str) -> int:
        cursor = self._db.execute(
            """
            UPDATE agent_permission_requests
            SET status = 'EXPIRED', updated_at = ?
            WHERE job_id = ? AND status = 'PENDING'
            """,
            (expired_at, job_id),
        )
        return cursor.rowcount

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "jobId": row["job_id"],
            "runId": row["run_id"],
            "permissionType": row["permission_type"],
            "target": row["target"],
            "details": json.loads(row["details_json"]),
            "status": row["status"],
            "decidedBy": json.loads(row["decided_by_json"]) if row["decided_by_json"] else None,
            "decidedAt": row["decided_at"],
            "decisionReason": row["decision_reason"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }
