"""Guard: no arbiter production code may import ``strands`` private paths.

The ONLY allowed private-path import lives in
``arbiter/workerWrapper/strands_compat.py`` — the centralised shim.
Everything else must import ``ToolResultEvent`` (and any future private
symbols) from ``strands_compat``.

This test scans every ``*.py`` file under ``arbiter/`` (excluding this
test, the shim itself, and other ``__tests__/`` helpers that monkeypatch
``sys.modules`` for SDK-absent envs) and fails naming the offending
``file:line`` when a private ``strands.*._*`` import is found.
"""

from __future__ import annotations

import re
from pathlib import Path

# Match lines like:
#   from strands.types._events import ToolResultEvent
#   import strands.types._events
#   from strands.foo.bar._baz import Something
_PRIVATE_IMPORT_RE = re.compile(
    r"^\s*(?:from|import)\s+strands\.[a-zA-Z0-9_.]*\._",
)

_REPO = Path(__file__).resolve().parents[3]  # …/sample-citadel
_ARBITER = _REPO / "arbiter"

# Files that are ALLOWED to use the private path.
_ALLOWED = {
    str((_ARBITER / "workerWrapper" / "strands_compat.py").resolve()),
}


def _is_test_helper(path: Path) -> bool:
    """True for files inside ``__tests__/`` dirs (they monkeypatch sys.modules)."""
    return "__tests__" in path.parts


def test_no_private_strands_imports() -> None:
    violations: list[str] = []
    for py in sorted(_ARBITER.rglob("*.py")):
        resolved = str(py.resolve())
        if resolved in _ALLOWED:
            continue
        if _is_test_helper(py):
            continue
        for lineno, line in enumerate(py.read_text().splitlines(), start=1):
            if _PRIVATE_IMPORT_RE.match(line):
                violations.append(f"{py.relative_to(_REPO)}:{lineno}: {line.strip()}")

    assert not violations, (
        "Private strands imports found outside the shim "
        f"(strands_compat.py).  Move them to the shim or import from it.\n"
        + "\n".join(violations)
    )
