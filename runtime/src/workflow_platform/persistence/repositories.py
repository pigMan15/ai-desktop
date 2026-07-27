import json
import sqlite3

from workflow_platform.models import WorkflowDefinition


class WorkflowVersionRepository:
    def __init__(self, db: sqlite3.Connection) -> None:
        self._db = db

    def save(self, definition: WorkflowDefinition) -> None:
        definition_json = json.dumps(
            definition.model_dump(by_alias=True),
            separators=(",", ":"),
            sort_keys=True,
        )
        self._db.execute(
            """
            INSERT INTO workflow_versions (workflow_id, version, definition_json)
            VALUES (?, ?, ?)
            ON CONFLICT(workflow_id, version) DO UPDATE SET
                definition_json = excluded.definition_json
            """,
            (definition.id, definition.version, definition_json),
        )
        self._db.commit()

    def get(self, workflow_id: str, version: str) -> WorkflowDefinition | None:
        row = self._db.execute(
            """
            SELECT definition_json
            FROM workflow_versions
            WHERE workflow_id = ? AND version = ?
            """,
            (workflow_id, version),
        ).fetchone()

        if row is None:
            return None

        return WorkflowDefinition.model_validate(json.loads(row["definition_json"]))
