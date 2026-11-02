"""
LeetLive practice runner — Python harness.

Reads a JSON spec (setup code, solution code, tests) and runs every test in
isolation against the solution, printing one JSON result line at the end.

Each test runs against a freshly loaded copy of the setup and solution code,
so module-level state (counters, caches, globals in helper code) never leaks
from one test into the next. A test passes when its code runs without raising;
`assert` is how tests check behaviour.
"""

import io
import json
import os
import signal
import sys
import time
import traceback

MAX_OUTPUT = 2000
RESULT_MARKER = "__LEETLIVE_RESULT__"


class TestTimeout(Exception):
    pass


def _on_alarm(signum, frame):
    raise TestTimeout()


def _trim(text):
    text = text or ""
    return text if len(text) <= MAX_OUTPUT else text[:MAX_OUTPUT] + "\n…(truncated)"


def _short_traceback(exc, filename_hint):
    """Last frames that point at the candidate's code or the test, not the harness."""
    frames = traceback.extract_tb(exc.__traceback__)
    keep = [f for f in frames if f.filename != __file__]
    lines = [f'  {f.filename}:{f.lineno} in {f.name}' for f in keep[-3:]]
    head = f"{type(exc).__name__}: {exc}".strip()
    return head + ("\n" + "\n".join(lines) if lines else "")


def main():
    spec_path = sys.argv[1]
    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)

    real_stdout = sys.stdout
    per_test_seconds = max(1, int(spec.get("perTestTimeoutMs", 5000) / 1000))
    signal.signal(signal.SIGALRM, _on_alarm)

    code = {}

    def fresh_namespace():
        ns = {"__name__": "solution"}
        if code["setup"]:
            exec(code["setup"], ns)
        exec(code["solution"], ns)
        return ns

    load_out = io.StringIO()
    sys.stdout = load_out
    try:
        signal.alarm(per_test_seconds)
        code["setup"] = compile(spec["setup"], "setup.py", "exec") if spec.get("setup") else None
        code["solution"] = compile(spec.get("solution", ""), "solution.py", "exec")
        fresh_namespace()
        signal.alarm(0)
    except BaseException as exc:  # noqa: BLE001 - report anything the solution raises
        signal.alarm(0)
        sys.stdout = real_stdout
        message = "Loading the solution timed out" if isinstance(exc, TestTimeout) else _short_traceback(exc, "solution.py")
        print(RESULT_MARKER + json.dumps({"compileError": _trim(message), "results": [], "stdout": _trim(load_out.getvalue())}))
        real_stdout.flush()
        os._exit(0)

    results = []
    for test in spec.get("tests", []):
        captured = io.StringIO()
        sys.stdout = captured
        started = time.perf_counter()
        status, message = "pass", ""
        try:
            signal.alarm(per_test_seconds)
            scope = fresh_namespace()
            exec(compile(test["code"], f"test_{test['id']}.py", "exec"), scope)
        except TestTimeout:
            status, message = "timeout", f"Exceeded {per_test_seconds}s"
        except AssertionError as exc:
            status = "fail"
            message = _short_traceback(exc, "") if str(exc) == "" else f"AssertionError: {exc}"
        except BaseException as exc:  # noqa: BLE001
            status, message = "error", _short_traceback(exc, "")
        finally:
            signal.alarm(0)
            sys.stdout = real_stdout
        results.append({
            "id": test["id"],
            "status": status,
            "message": _trim(message),
            "stdout": _trim(captured.getvalue()),
            "durationMs": round((time.perf_counter() - started) * 1000, 1),
        })

    print(RESULT_MARKER + json.dumps({"results": results, "stdout": _trim(load_out.getvalue())}))
    real_stdout.flush()
    # Hard exit: candidate code may have left non-daemon threads running.
    os._exit(0)


if __name__ == "__main__":
    main()
