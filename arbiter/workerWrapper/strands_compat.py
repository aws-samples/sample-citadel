"""Compatibility shim for ``strands-agents`` private types.

``ToolResultEvent`` is required by the wrapper-tool ``stream()`` methods
(governance, idempotency, breaker, compensation) but lives under
``strands.types._events`` — a private path that may move or disappear
between SDK releases.  This module centralises that import behind a
``try/except`` so the rest of the codebase uses only **this** public
re-export, and any breakage surfaces a single, actionable error message.

Usage (in the four hook/executor modules)::

    from strands_compat import ToolResultEvent

The import-guard test (``__tests__/test_no_private_strands_imports.py``)
enforces that no file outside this shim reaches into ``strands.*._*``.

Implementation note: the attribute is resolved lazily via ``__getattr__``
so that test fixtures can monkeypatch ``sys.modules["strands.types._events"]``
and have the fake class picked up by subsequent ``from strands_compat import
ToolResultEvent`` statements (which Python evaluates as
``import strands_compat; strands_compat.ToolResultEvent``).
"""

from __future__ import annotations

__all__ = ["ToolResultEvent"]


def __getattr__(name: str):  # noqa: N807 — module-level __getattr__ (PEP 562)
    if name == "ToolResultEvent":
        try:
            from strands.types._events import ToolResultEvent  # type: ignore[attr-defined]
            return ToolResultEvent
        except ImportError as _exc:
            raise ImportError(
                "strands_compat: cannot import ToolResultEvent from "
                "strands.types._events.  This private path was present in "
                "strands-agents <=1.59.0 but may have moved or been removed "
                "in the installed version.  Check the installed strands-agents "
                "version and update this shim accordingly."
            ) from _exc
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
