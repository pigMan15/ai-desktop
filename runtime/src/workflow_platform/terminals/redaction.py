from __future__ import annotations

import re


_ASSIGNMENT_SECRET = re.compile(
    r"(?i)(\b(?:[A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|token|password|secret)\s*(?:=|:)\s*)[^\r\n\s&#]+"
)
_AUTHORIZATION_SECRET = re.compile(
    r"(?im)^(\s*authorization\s*:\s*(?:bearer|basic)\s+)[^\r\n]+"
)
_JSON_SECRET = re.compile(
    r'(?i)("(?:api[_-]?key|access[_-]?token|token|password|secret)"\s*:\s*")[^"]*(")'
)
_QUERY_SECRET = re.compile(
    r"(?i)([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]+"
)
_BEARER_SECRET = re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+")
_KNOWN_TOKEN = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b"
)
_UNPAIRED_SURROGATE = re.compile(r"[\ud800-\udfff]")


def normalize_terminal_output(output: str) -> str:
    """Make arbitrary PTY chunks safe for UTF-8 storage and JSON responses."""
    return _UNPAIRED_SURROGATE.sub("\ufffd", output)


def redact_terminal_output(output: str) -> str:
    redacted = _ASSIGNMENT_SECRET.sub(r"\1[REDACTED]", normalize_terminal_output(output))
    redacted = _AUTHORIZATION_SECRET.sub(r"\1[REDACTED]", redacted)
    redacted = _JSON_SECRET.sub(r"\1[REDACTED]\2", redacted)
    redacted = _QUERY_SECRET.sub(r"\1[REDACTED]", redacted)
    redacted = _BEARER_SECRET.sub("Bearer [REDACTED]", redacted)
    return _KNOWN_TOKEN.sub("[REDACTED]", redacted)
