from __future__ import annotations

import json
import signal
import sys
import time


cancelled = False


def _handle_signal(_signum: int, _frame: object) -> None:
    global cancelled
    cancelled = True


signal.signal(signal.SIGTERM, _handle_signal)


def emit(kind: str, text: str) -> None:
    print(json.dumps({"type": kind, "text": text}, ensure_ascii=False), flush=True)


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "complete"
    if mode == "complete":
        emit("message", "fake-cli: started")
        emit("final", "fake-cli: completed")
        return 0
    if mode == "large":
        emit("message", "x" * 512)
        return 0
    if mode == "sleep":
        emit("message", "fake-cli: sleeping")
        for _ in range(50):
            if cancelled:
                emit("error", "fake-cli: cancelled")
                return 130
            time.sleep(0.1)
        emit("final", "fake-cli: woke")
        return 0
    emit("error", "fake-cli: failed")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
