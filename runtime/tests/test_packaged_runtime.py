from workflow_platform.packaged_runtime import runtime_host, runtime_port


def test_packaged_runtime_reads_host_and_port_from_environment(
    monkeypatch,
) -> None:
    monkeypatch.setenv("WORKFLOW_PLATFORM_RUNTIME_HOST", "127.0.0.1")
    monkeypatch.setenv("WORKFLOW_PLATFORM_RUNTIME_PORT", "9876")

    assert runtime_host() == "127.0.0.1"
    assert runtime_port() == 9876


def test_packaged_runtime_uses_safe_defaults(monkeypatch) -> None:
    monkeypatch.delenv("WORKFLOW_PLATFORM_RUNTIME_HOST", raising=False)
    monkeypatch.delenv("WORKFLOW_PLATFORM_RUNTIME_PORT", raising=False)

    assert runtime_host() == "127.0.0.1"
    assert runtime_port() == 8765
