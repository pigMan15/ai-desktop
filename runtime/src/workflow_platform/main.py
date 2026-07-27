from __future__ import annotations


def health() -> dict[str, str]:
    return {"status": "ok", "service": "workflow-runtime"}


def run() -> None:
    import uvicorn

    uvicorn.run(
        "workflow_platform.api.app:app",
        host="127.0.0.1",
        port=8765,
        reload=False,
    )
