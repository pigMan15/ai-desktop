from workflow_platform.terminals.redaction import redact_terminal_output


def test_redact_terminal_output_masks_common_assignment_secrets() -> None:
    output = (
        "OPENAI_API_KEY=sk-live-123\n"
        "token: bearer-token\n"
        "password = correct-horse-battery-staple\n"
        "safe=value\n"
    )

    assert redact_terminal_output(output) == (
        "OPENAI_API_KEY=[REDACTED]\n"
        "token: [REDACTED]\n"
        "password = [REDACTED]\n"
        "safe=value\n"
    )


def test_redact_terminal_output_preserves_non_secret_text() -> None:
    assert redact_terminal_output("正在编译项目\n完成\n") == "正在编译项目\n完成\n"


def test_redact_terminal_output_masks_headers_json_urls_and_common_cli_tokens() -> None:
    output = (
        'Authorization: Bearer bearer-secret-token\n'
        '{"api_key":"json-secret","name":"workflow"}\n'
        "https://example.test/callback?access_token=url-secret&mode=preview\n"
        "github token ghp_abcdefghijklmnopqrstuvwxyz1234567890\n"
        "OpenAI key sk-proj-abcdefghijklmnopqrstuvwxyz\n"
        "项目路径 G:\\Project\\demo\\README.md\n"
    )

    redacted = redact_terminal_output(output)

    assert "bearer-secret-token" not in redacted
    assert "json-secret" not in redacted
    assert "url-secret" not in redacted
    assert "ghp_abcdefghijklmnopqrstuvwxyz1234567890" not in redacted
    assert "sk-proj-abcdefghijklmnopqrstuvwxyz" not in redacted
    assert '"name":"workflow"' in redacted
    assert "mode=preview" in redacted
    assert "G:\\Project\\demo\\README.md" in redacted
