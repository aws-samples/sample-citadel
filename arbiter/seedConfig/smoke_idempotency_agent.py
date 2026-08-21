"""Idempotency-seam smoke agent — diagnostic fixture, NEVER a product agent.

Exposes the ``handler`` entry point the worker's subprocess runner invokes
(``module.handler(**request)``). Unlike ``demo_echo_agent.py`` (which has no
tools and never touches the idempotency seam at all), this agent constructs
a real ``strands.Agent`` carrying one harmless side-effecting tool
(``smoke_write_marker``, defined inline below) and invokes it directly — no
model call is needed to exercise the seam, since the seam wraps the
tool-call path itself: for a workflow-dispatched node (``CITADEL_EXECUTION_ID``
/``CITADEL_NODE_ID`` set), ``agent_runner._install_idempotency_hook`` patches
``strands.Agent.__init__`` to attach an ``IdempotencyToolHook`` to every
``Agent(...)`` constructed inside the loaded module — including this one.

Single-file contract
---------------------
The worker downloads exactly one file per agent
(``load_file_from_s3_into_tmp`` in ``arbiter/workerWrapper/index.py`` fetches
only ``agents/<filename>`` — no sibling imports are possible), mirroring the
fabricator's own "MUST be a single, importable Python file" contract
(``arbiter/fabricator/index.py``). The tool logic therefore lives inline in
this module (nested inside ``handler``, matching how the fabricator's own
worked examples define a ``@tool``-decorated function next to ``handler`` in
one file) rather than importing a shared helper. It is unit-tested by
``arbiter/seedConfig/__tests__/test_smoke_idempotency_agent.py`` via
``exec_module`` against a temp copy of this exact file, the same technique
``test_agent_runner_properties.py`` uses for other single-file agent
modules.

This file is data for the seed Lambda: uploaded verbatim to the agent code
bucket at ``agents/smoke_idempotency_agent.py`` (mirroring
``demo_echo_agent.py``'s upload path) so the worker can resolve it from the
seeded agent config's ``filename`` field. Never imported by the seed Lambda
itself. Seeded ONLY in non-production environments (see
``backend/lib/arbiter-stack.ts``) — production has no seeded agent config
row, no seeded workflow, and no smoke table for this fixture to write to.

Side-effect classification (MUST be side-effecting, never bypassed)
---------------------------------------------------------------------
``smoke_write_marker`` declares no ``idempotency`` config. Per
``tool_idempotency.classify_idempotency_mode``, the fail-safe default for a
missing/malformed/unrecognized ``idempotency.mode`` is ``MODE_LEDGER``
(side-effecting) — reaching ``MODE_BYPASS`` requires an *explicit*
``mode: "bypass"`` flag, which this tool never sets. Independently,
production wiring never passes a ``mode_resolver`` into
``IdempotencyToolHook`` at all (see ``agent_runner._install_idempotency_hook``),
so every tool call in a real dispatch resolves to ``MODE_LEDGER`` regardless
of any tool-level config. Both facts point the same way: this tool always
reserves in the ledger before it writes.

Duplicate-visibility design (fresh per-invocation uuid, never deterministic)
-----------------------------------------------------------------------------
Each execution that actually runs (i.e. is not absorbed as a duplicate by
the ledger) appends exactly one row keyed by a freshly minted
``uuid.uuid4()`` — never derived from the ledger key, execution id, or any
other deterministic input. A deterministic id would let a duplicate side
effect silently overwrite the same row, masking exactly the failure this
fixture exists to catch. One row after one workflow Run = correct. Two rows
after a forced retry/re-dispatch = the fence did not hold.
"""

import asyncio
import os
import time
import uuid

# 24h operational TTL — long enough to inspect after a manual smoke run,
# short enough that the table never accumulates real state.
SMOKE_TTL_SECONDS = 24 * 3600


def handler(**kwargs):
    """Invoke the smoke marker tool once and return its result.

    The worker's subprocess runner calls this as ``handler(**request)``.
    ``kwargs`` (the workflow node's input payload) is used only for an
    optional ``note`` passthrough — this fixture's only job is to drive
    exactly one tool call through the idempotency seam per execution
    attempt.
    """
    from strands import Agent, tool

    def _table_name() -> str:
        name = os.environ.get("SMOKE_IDEMPOTENCY_TABLE")
        if not name:
            raise RuntimeError(
                "SMOKE_IDEMPOTENCY_TABLE is not configured — this smoke "
                "agent must only run in a non-prod environment where the "
                "smoke table is provisioned (fail closed rather than "
                "silently no-op)"
            )
        return name

    @tool
    def smoke_write_marker(note: str = "") -> dict:
        """Write one diagnostic marker row with a fresh uuid (idempotency smoke).

        DIAGNOSTIC FIXTURE ONLY. Every invocation that actually executes
        appends exactly one row to the dedicated smoke table, keyed by a
        freshly generated uuid so a duplicate execution is visible as a
        second row rather than silently overwriting the first.
        """
        import boto3

        marker_id = str(uuid.uuid4())
        org_id = os.environ.get("CITADEL_ORG_ID") or "unscoped"
        now = time.time()

        table = boto3.resource("dynamodb").Table(_table_name())
        table.put_item(
            Item={
                "orgId": org_id,
                "markerId": marker_id,
                "note": (note or "")[:200],
                "writtenAt": now,
                "ttl": int(now) + SMOKE_TTL_SECONDS,
            }
        )

        return {
            "markerId": marker_id,
            "orgId": org_id,
            "writtenAt": str(now),
        }

    agent = Agent(tools=[smoke_write_marker])
    note = kwargs.get("note", "idempotency-smoke")

    async def _invoke():
        return await agent.tool.smoke_write_marker(note=note)

    return asyncio.run(_invoke())
