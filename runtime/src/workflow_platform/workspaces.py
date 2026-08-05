import os
from pathlib import Path


def normalize_workspace_path(value: str | Path) -> str:
    try:
        path = Path(value).expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise ValueError(
            "EXECUTION_WORKSPACE_INVALID: execution workspace does not exist"
        ) from error
    if not path.is_dir():
        raise ValueError(
            "EXECUTION_WORKSPACE_INVALID: execution workspace must be a directory"
        )
    return os.path.normcase(os.path.normpath(str(path)))
