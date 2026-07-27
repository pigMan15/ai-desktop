from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from workflow_platform.api.app import app, create_app
from workflow_platform.main import health, run


def test_create_app_returns_fastapi_app() -> None:
    assert isinstance(create_app(), FastAPI)


def test_health_endpoint_returns_health_result() -> None:
    client = TestClient(create_app())

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == health()


def test_module_app_is_created_app() -> None:
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200


def test_run_starts_uvicorn_with_runtime_app(monkeypatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_run(app_path: str, **kwargs: object) -> None:
        calls.append({"app_path": app_path, **kwargs})

    monkeypatch.setattr("uvicorn.run", fake_run)

    run()

    assert calls == [
        {
            "app_path": "workflow_platform.api.app:app",
            "host": "127.0.0.1",
            "port": 8765,
            "reload": False,
        }
    ]
