"""Shared correlation identity — run_id (decision f1cbd5ef, architect design
"runId — Shared Correlation Identity Design", Pass 1).

run_id is SERVER-MINTED ONLY. This module is the sole Python producer,
mirroring ``backend/src/utils/run-id.ts`` on the TypeScript side. No code
path may read a run_id off an external/client request body — any inbound
client-supplied value must be stripped/ignored.

Format: opaque string ``run-<uuidv4>`` (lowercase, hyphenated) — identical
shape to the TS producer, so a run_id minted by either tier is
indistinguishable to a downstream consumer.

``build_dispatch_context()`` is the Python half of the BUILD-TIME durability
guard (design §3, layer 1): ``run_id`` is a REQUIRED keyword-only parameter
with no default, so a call site omitting it fails at call time with a
``TypeError`` (Python has no compile-time check, so this is enforced as
strictly as the language allows: an unconditional, un-catchable
``TypeError`` from the interpreter itself for a missing required argument,
not a caught/logged soft failure).
"""
from __future__ import annotations

import uuid
from typing import Any


def mint_run_id() -> str:
    """Sole producer: mint a fresh, server-side run_id. Never derived from
    external input."""
    return f"run-{uuid.uuid4()}"


def build_dispatch_context(*, run_id: str, **context: Any) -> dict:
    """Construct a dispatch/event envelope dict. ``run_id`` is a required
    keyword-only argument — omitting it raises ``TypeError`` immediately,
    which is the build-time-equivalent durability guard for the Python tier
    (mirrors the TS `DispatchContext` type's required `runId` field).
    """
    return {"run_id": run_id, **context}
