from __future__ import annotations

from fastapi import FastAPI

from workflow_platform.main import health


def create_app() -> FastAPI:
    application = FastAPI()

    @application.get("/health")
    def get_health() -> dict[str, str]:
        return health()

    return application


app = create_app()
