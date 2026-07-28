from __future__ import annotations

import os

import uvicorn

from workflow_platform.api.app import create_runtime_app


def runtime_host() -> str:
    return os.environ.get("WORKFLOW_PLATFORM_RUNTIME_HOST", "127.0.0.1")


def runtime_port() -> int:
    raw_port = os.environ.get("WORKFLOW_PLATFORM_RUNTIME_PORT", "8765")
    try:
        return int(raw_port)
    except ValueError as exc:
        raise ValueError("WORKFLOW_PLATFORM_RUNTIME_PORT must be an integer") from exc


def main() -> None:
    uvicorn.run(
        create_runtime_app(),
        host=runtime_host(),
        port=runtime_port(),
        log_level="info",
    )


if __name__ == "__main__":
    main()
