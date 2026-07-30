"""Shared correlation identity — run_id (container-local copy).

The service layer is a SEPARATE deployable (see ``Dockerfile`` — the build
context is ``service/agent_intake_single/`` only, so ``arbiter/`` is not
available at build or runtime). This module REPLICATES
``arbiter/common/run_id.py`` / ``backend/src/utils/run-id.ts`` rather than
importing across the arbiter/service boundary, mirroring the existing
container-local-copy pattern used by ``tools/usage.py``.

run_id is SERVER-MINTED ONLY: this module is the sole producer for the
intake service. No inbound request path (``payload`` in ``agent.py``'s
``invoke`` entrypoint) is ever read for a runId.

Format: opaque string ``run-<uuidv4>`` — identical shape to the arbiter and
backend producers, so a run_id minted by any tier is indistinguishable to a
downstream consumer.
"""
from __future__ import annotations

import uuid


def mint_run_id() -> str:
    """Sole producer (intake service): mint a fresh, server-side run_id.
    Never derived from external/request input."""
    return f"run-{uuid.uuid4()}"
