from workflow_platform.main import health


def test_health_returns_runtime_status() -> None:
    assert health() == {"status": "ok", "service": "workflow-runtime"}
