"""Real-client (moto) tests for the ASYNC idempotency seam
(``_IdempotentToolWrapper.stream``) — finding 1a57e526.

Why this file exists (the tests whose ABSENCE let a green suite coexist with an
inoperative replay path):

``test_tool_crash_discriminator.py`` already drives the async wrapper, but it
consumes the generator by FULLY EXHAUSTING it
(``async for ev in wrapper.stream(...): out.append(ev)``). Exhausting the
generator runs the code placed AFTER the ``async for`` loop — which is where
the success-path ``finalize_success`` lived. The REAL strands tool-executor is
guaranteed to PULL the terminal ``ToolResultEvent`` (that is how it obtains a
tool result) but is NOT guaranteed to RESUME the async generator past that
yield. So in production the post-loop finalize never ran: a successful call
left its ledger row ``in_flight`` forever (dev exec 61a0b4e7), and the
capability's stated guarantee — a retried COMPLETED key returns the recorded
result instead of re-executing — could never operate because no key ever
reached ``completed``.

These tests therefore drive the wrapper the way the runtime does: pull events
until the terminal ``ToolResultEvent`` and then STOP (``aclose`` the generator
without resuming it), against a REAL boto3 client backed by moto and the REAL
ledger reserve -> finalize path. No FakeTable, no mocked ledger.

conftest note: ``arbiter/conftest.py`` stubs ``boto3.client``/``boto3.resource``
for the whole suite; ``boto3.Session`` is NOT stubbed, so we build a real
moto-backed resource via ``boto3.Session().resource(...)`` and point the
ledger's lazy ``_get_dynamodb_resource`` seam (the SAME module object the hook
holds — ``tool_idempotency_hook.ledger`` — to avoid the arbiter.*/top-level
module-identity trap) at it.
"""
from __future__ import annotations

import asyncio
import os
import sys
import types

import boto3
import pytest

try:
    from moto import mock_aws
except ImportError:  # pragma: no cover
    pytest.skip("moto not installed", allow_module_level=True)

_HERE_WW = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _HERE_WW not in sys.path:
    sys.path.insert(0, _HERE_WW)

import tool_idempotency_hook  # noqa: E402
from tool_idempotency_hook import _IdempotentToolWrapper  # noqa: E402
from tool_idempotency import build_key  # noqa: E402

# Patch the EXACT ledger object the hook holds (module-identity trap): the hook
# did ``from governance import tool_execution_ledger as ledger``.
ledger = tool_idempotency_hook.ledger

REGION = "us-east-1"
LEDGER_TABLE = "citadel-tool-execution-ledger-hook-moto"


def _make_ledger_table(resource):
    resource.create_table(
        TableName=LEDGER_TABLE,
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def _install_fake_tool_result_event(monkeypatch):
    """Minimal strands stub so the wrapper's local
    ``from strands.types._events import ToolResultEvent`` resolves in an env
    without strands (mirrors test_tool_crash_discriminator.py)."""
    mod = types.ModuleType("strands.types._events")

    class ToolResultEvent:
        def __init__(self, tool_result):
            self.tool_result = tool_result

    mod.ToolResultEvent = ToolResultEvent
    strands_mod = sys.modules.get("strands") or types.ModuleType("strands")
    types_mod = sys.modules.get("strands.types") or types.ModuleType("strands.types")
    monkeypatch.setitem(sys.modules, "strands", strands_mod)
    monkeypatch.setitem(sys.modules, "strands.types", types_mod)
    monkeypatch.setitem(sys.modules, "strands.types._events", mod)
    return ToolResultEvent


@pytest.fixture
def moto_hook(monkeypatch):
    with mock_aws():
        resource = boto3.Session(region_name=REGION).resource("dynamodb")
        _make_ledger_table(resource)

        monkeypatch.setenv("TOOL_EXECUTION_LEDGER_TABLE", LEDGER_TABLE)
        # Keep the concurrent-loser poll tiny so the RED (main) path — where a
        # never-finalized row leaves the 2nd call polling IN_FLIGHT — does not
        # burn the 5s default.
        monkeypatch.setenv("TOOL_LEDGER_POLL_TIMEOUT_SECONDS", "0.05")
        monkeypatch.setenv("TOOL_LEDGER_POLL_INTERVAL_SECONDS", "0.01")

        getattr(ledger, "__reset_ledger_client_for_test")()
        monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: resource)
        tre = _install_fake_tool_result_event(monkeypatch)
        tool_idempotency_hook.drain_tool_crashes()
        tool_idempotency_hook.drain_governance_refusals()
        try:
            yield {"resource": resource, "ToolResultEvent": tre}
        finally:
            getattr(ledger, "__reset_ledger_client_for_test")()
            tool_idempotency_hook.drain_tool_crashes()
            tool_idempotency_hook.drain_governance_refusals()


class _CountingInner:
    """Inner tool that records how many times it was invoked and yields one
    terminal ToolResultEvent carrying ``result``."""

    def __init__(self, result):
        self._result = result
        self.invocations = 0

    tool_name = "smoke_write_marker"

    async def stream(self, tool_use, invocation_state, **kwargs):
        from strands.types._events import ToolResultEvent

        self.invocations += 1
        yield ToolResultEvent(self._result)


class _RaisingInner:
    """Inner tool whose stream RAISES ``exc`` (an exception escapes the tool)."""

    def __init__(self, exc):
        self._exc = exc
        self.invocations = 0

    tool_name = "smoke_write_marker"

    async def stream(self, tool_use, invocation_state, **kwargs):
        self.invocations += 1
        raise self._exc
        yield  # pragma: no cover — makes this an async generator


async def _drive_like_runtime(wrapper, tool_use):
    """Consume the wrapper the way the strands tool-executor does: pull events
    until the terminal ``ToolResultEvent``, then STOP and ``aclose`` the
    generator WITHOUT resuming it past that yield.

    This is the faithful model of the production consumption pattern that left
    the ledger row ``in_flight`` — the runtime never resumes the generator past
    the result it needs, so any finalize placed after the ``async for`` loop is
    unreachable."""
    from strands.types._events import ToolResultEvent

    agen = wrapper.stream(tool_use, {})
    result = None
    try:
        async for ev in agen:
            if isinstance(ev, ToolResultEvent):
                result = ev.tool_result
                break  # runtime stops as soon as it has the tool result
    finally:
        await agen.aclose()  # abandon the suspended generator (no resume)
    return result


def _key(suffix):
    return build_key("orgA", "exec1", "node1", 0, "smoke_write_marker", {"note": suffix})


class TestSuccessReachesTerminalWithResult:
    def test_success_row_is_terminal_and_holds_result(self, moto_hook):
        """(a) After a successful call the ledger row is TERMINAL (completed)
        and holds the recorded result. BITES on main: the row stays in_flight
        because finalize sat after the (un-resumed) terminal yield."""
        pk, sk = _key("a")
        recorded = {"toolUseId": "tu", "status": "success", "markerId": "m-1"}
        inner = _CountingInner(recorded)
        wrapper = _IdempotentToolWrapper(inner, pk, sk, "smoke_write_marker", "ledger")

        result = asyncio.run(_drive_like_runtime(wrapper, {"toolUseId": "tu"}))

        assert inner.invocations == 1
        assert result == recorded
        row = ledger.get(pk, sk)
        assert row is not None
        assert row["status"] == ledger.STATUS_COMPLETED  # not in_flight
        # createdAt != updatedAt proves the finalize transition actually ran.
        assert row["updatedAt"] >= row["createdAt"]
        # The recorded result is stored and faithfully replayable.
        assert ledger._recorded_result(row, pk) == recorded


class TestSecondCallReplaysRecordedResult:
    def test_second_call_returns_recorded_result_without_reinvoking(self, moto_hook):
        """(b) A second call with the SAME key returns the RECORDED result and
        the tool is NOT re-invoked (assert the invocation count, not just the
        return value). BITES on main: call #1 never completes, so call #2 finds
        an in_flight row and yields a retry error instead of the recorded
        result."""
        pk, sk = _key("b")
        recorded = {"toolUseId": "tu", "status": "success", "markerId": "m-1"}

        inner1 = _CountingInner(recorded)
        w1 = _IdempotentToolWrapper(inner1, pk, sk, "smoke_write_marker", "ledger")
        asyncio.run(_drive_like_runtime(w1, {"toolUseId": "tu"}))
        assert inner1.invocations == 1

        # Fresh wrapper + fresh inner for the retry; the inner MUST NOT run.
        inner2 = _CountingInner({"toolUseId": "tu2", "status": "success", "markerId": "SHOULD-NOT-APPEAR"})
        w2 = _IdempotentToolWrapper(inner2, pk, sk, "smoke_write_marker", "ledger")
        replayed = asyncio.run(_drive_like_runtime(w2, {"toolUseId": "tu2"}))

        assert inner2.invocations == 0, "duplicate call re-executed the side effect"
        assert replayed == recorded, "retry did not return the recorded result"


class TestRaisePathStillFinalizesFailed:
    def test_raising_tool_finalizes_failed_not_indeterminate(self, moto_hook):
        """(c) The raise path still finalizes as FAILED (a bare crash is a
        determinate failure, not indeterminate). Regression guard — the raise
        path was already reachable during iteration."""
        pk, sk = _key("c")
        inner = _RaisingInner(RuntimeError("tool crashed mid-execution"))
        wrapper = _IdempotentToolWrapper(inner, pk, sk, "smoke_write_marker", "ledger")

        with pytest.raises(RuntimeError):
            asyncio.run(_drive_like_runtime(wrapper, {"toolUseId": "tu"}))

        row = ledger.get(pk, sk)
        assert row["status"] == ledger.STATUS_FAILED
        assert row.get("outcomeIndeterminate") in (False, None)
        crashes = tool_idempotency_hook.drain_tool_crashes()
        assert crashes and crashes[0]["errorClass"] == "RuntimeError"


class TestIndeterminateStaysNonCompleted:
    def test_unknown_outcome_stays_non_completed_and_indeterminate(self, moto_hook):
        """(d) A genuinely-unknown outcome is finalized failed+indeterminate and
        is NEVER marked completed (the fail-safe-toward-no-duplicate rule): it
        must not be replayable as a success, and must not stay in_flight.
        Regression guard for the indeterminate rule."""
        pk, sk = _key("d")
        exc = ledger.ToolOutcomeError("5xx after send", side_effect="unknown", error_type="Http500")
        inner = _RaisingInner(exc)
        wrapper = _IdempotentToolWrapper(inner, pk, sk, "smoke_write_marker", "ledger")

        with pytest.raises(ledger.ToolOutcomeError):
            asyncio.run(_drive_like_runtime(wrapper, {"toolUseId": "tu"}))

        row = ledger.get(pk, sk)
        assert row["status"] != ledger.STATUS_COMPLETED
        assert row["status"] == ledger.STATUS_FAILED
        assert row["outcomeIndeterminate"] is True
