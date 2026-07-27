import json
import sqlite3
from pathlib import Path

from workflow_platform.models import Actor, RunEvent, RunProjection, WorkflowDefinition


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
        created_at: str,
        adapter_id: str | None = None,
    ) -> None:
        definition_json = json.dumps(
            definition.model_dump(by_alias=True),
            separators=(",", ":"),
            sort_keys=True,
        )
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
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                adapter_id = excluded.adapter_id,
                name = excluded.name,
                version = excluded.version,
                definition_json = excluded.definition_json,
                content_hash = excluded.content_hash,
                created_at = excluded.created_at
            """,
            (
                id,
                project_id,
                adapter_id or definition.sourceAdapter,
                definition.name,
                definition.version,
                definition_json,
                content_hash,
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
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                root_path = excluded.root_path,
                active_protocol = excluded.active_protocol,
                updated_at = excluded.updated_at
            """,
            (id, name, str(root_path), active_protocol, now, now),
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
    ) -> None:
        self._db.execute(
            """
            INSERT INTO runs (
                id,
                project_id,
                workflow_version_id,
                title,
                status,
                context_json,
                created_at,
                updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                id,
                project_id,
                workflow_version_id,
                title,
                status,
                json.dumps(context, separators=(",", ":"), sort_keys=True),
                now,
                now,
            ),
        )

    def workflow_for_run(self, run_id: str) -> WorkflowDefinition:
        row = self._db.execute(
            """
            SELECT workflow_versions.definition_json
            FROM runs
            JOIN workflow_versions ON workflow_versions.id = runs.workflow_version_id
            WHERE runs.id = ?
            """,
            (run_id,),
        ).fetchone()
        if row is None:
            raise KeyError(f"Run not found: {run_id}")
        return WorkflowDefinition.model_validate(json.loads(row["definition_json"]))

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
