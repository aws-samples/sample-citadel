"""Seam tests for the per-target breaker composed into the REAL ComposedToolHook
(task 28d624b1).

The agent boundary is NOT stubbed: these drive the real ``ComposedToolHook`` +
``GovernanceEvaluator`` + ``ToolBreaker`` (backed by a REAL moto client, real-
shaped rows), asserting the exact ordering
    deny-list → breaker pre-check → approval-consume → idempotency reserve →
    outermost breaker observer
and the invariants: a breaker fast-fail burns no approval single-use and leaves
no ledger reservation; a deny precedes (and masks) the breaker; a local tool
with no external binding skips the breaker entirely (zero DynamoDB).
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

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)
_HERE_WW = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _HERE_WW not in sys.path:
    sys.path.insert(0, _HERE_WW)

import governed_tool_handler  # noqa: E402
import tool_idempotency_hook  # noqa: E402
import tool_breaker_hook  # noqa: E402  # noqa: F401
from governance_tool_hook import GovernanceEvaluator, _GovernanceDeniedTool  # noqa: E402
from tool_idempotency_hook import (  # noqa: E402
    ComposedToolHook, IdempotencyToolHook, _IdempotentToolWrapper,
)
from tool_breaker_hook import ToolBreaker, _CircuitOpenTool, _BreakerObserverTool  # noqa: E402
from arbiter.governance import tool_breaker_store as store_mod  # noqa: E402
from arbiter.governance.tool_breaker_store import (  # noqa: E402
    BreakerConfig, ToolBreakerStore, __reset_breaker_client_for_test,
)
from arbiter.governance.tool_breaker_logic import BreakerTarget  # noqa: E402

ledger = tool_idempotency_hook.ledger

TABLE = "citadel-tool-breaker-seam-moto"
MCP_TARGET = BreakerTarget(kind="mcp_server", target_id="mcp-1")
PK = "org1#mcp_server#mcp-1"


@pytest.fixture(autouse=True)
def _governance_writes_succeed(monkeypatch):
    monkeypatch.setattr(governed_tool_handler, "write_finding", lambda *a, **k: None)
    tool_idempotency_hook.drain_governance_refusals()
    yield
    tool_idempotency_hook.drain_governance_refusals()


@pytest.fixture
def moto_breaker(monkeypatch):
    with mock_aws():
        resource = boto3.Session(region_name="us-east-1").resource("dynamodb")
        resource.create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                  {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        __reset_breaker_client_for_test()
        monkeypatch.setattr(store_mod, "_get_dynamodb_resource", lambda: resource)
        try:
            yield resource
        finally:
            __reset_breaker_client_for_test()


class _FakeEvent:
    def __init__(self, name, selected_tool, tool_use_id="tu", tool_input=None):
        self.tool_use = {"name": name, "toolUseId": tool_use_id, "input": tool_input or {}}
        self.selected_tool = selected_tool


class _FakeInnerTool:
    def __init__(self, name, executed_log):
        self._name = name
        self._log = executed_log

    @property
    def tool_name(self):
        return self._name

    async def stream(self, tool_use, invocation_state, **kwargs):
        from strands.types._events import ToolResultEvent
        self._log.append(self._name)
        yield ToolResultEvent({"toolUseId": "tu", "status": "success", "content": [{"text": "ran"}]})


@pytest.fixture
def fake_tool_result_event(monkeypatch):
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


def _drain(agen):
    async def _run():
        return [ev async for ev in agen]
    return asyncio.run(_run())


def _seed_open(resource, opened_at=1000, state_version=1):
    resource.Table(TABLE).put_item(Item={
        "pk": PK, "sk": "STATE", "state": "OPEN", "openedAt": opened_at,
        "failureCount": 5, "stateVersion": state_version, "windowStart": 0,
        "updatedAt": opened_at, "ttl": opened_at + 86400,
    })


def _breaker(resource, *, targets, clock=lambda: 1005.0):
    store = ToolBreakerStore(
        table_name=TABLE, org_id="org1",
        config=BreakerConfig(recovery_seconds=30, closed_cache_ttl_seconds=3),
        clock=clock,
    )
    return ToolBreaker(
        store=store,
        target_resolver=lambda name: targets.get(name),
        probe_owner="exec1#node1",
    ), store


def _evaluator(denied=()):
    return GovernanceEvaluator(
        agent_id="a", workflow_id="wf", denied_tools=set(denied), eval_run_id=None,
    )


def _idempotency():
    return IdempotencyToolHook(org_id="org1", execution_id="exec1", node_id="node1")


class TestBreakerFastFailOrdering:
    def test_open_breaker_fast_fails_without_approval_or_reservation(self, moto_breaker, monkeypatch):
        _seed_open(moto_breaker)
        breaker, store = _breaker(moto_breaker, targets={"remote_tool": MCP_TARGET})
        evaluator = _evaluator()

        approval_calls = []
        monkeypatch.setattr(evaluator, "evaluate_approval",
                            lambda *a, **k: approval_calls.append((a, k)) or False)
        reserve_calls = []
        monkeypatch.setattr(ledger, "reserve", lambda *a, **k: reserve_calls.append((a, k)))

        inner = _FakeInnerTool("remote_tool", [])
        event = _FakeEvent("remote_tool", inner)
        ComposedToolHook(
            governance=evaluator, idempotency=_idempotency(), breaker=breaker,
        )._on_before_tool_call(event)

        assert isinstance(event.selected_tool, _CircuitOpenTool)
        assert approval_calls == []   # no approval single-use burned
        assert reserve_calls == []    # no ledger reservation

    def test_circuit_open_tool_stream_never_calls_inner_and_records_refusal(
        self, moto_breaker, fake_tool_result_event
    ):
        _seed_open(moto_breaker)
        breaker, store = _breaker(moto_breaker, targets={"remote_tool": MCP_TARGET})
        executed = []
        inner = _FakeInnerTool("remote_tool", executed)
        event = _FakeEvent("remote_tool", inner)
        ComposedToolHook(governance=_evaluator(), idempotency=_idempotency(),
                         breaker=breaker)._on_before_tool_call(event)
        assert isinstance(event.selected_tool, _CircuitOpenTool)

        events = _drain(event.selected_tool.stream(event.tool_use, {}))

        assert executed == []  # target never called
        assert len(events) == 1 and events[0].tool_result["status"] == "error"
        assert "circuit is OPEN" in events[0].tool_result["content"][0]["text"]
        refusals = tool_idempotency_hook.drain_governance_refusals()
        assert any(r["errorClass"] == "CircuitOpenError" for r in refusals)


class TestDenyPrecedesBreaker:
    def test_denied_tool_reports_deny_not_circuit_open_and_skips_breaker(self, moto_breaker):
        _seed_open(moto_breaker)
        breaker, store = _breaker(moto_breaker, targets={"remote_tool": MCP_TARGET})
        inner = _FakeInnerTool("remote_tool", [])
        event = _FakeEvent("remote_tool", inner)
        ComposedToolHook(
            governance=_evaluator(denied=("remote_tool",)),
            idempotency=_idempotency(), breaker=breaker,
        )._on_before_tool_call(event)
        assert isinstance(event.selected_tool, _GovernanceDeniedTool)
        assert store.ddb_op_count == 0  # breaker never consulted on a deny


class TestClosedPathObserverIsOutermost:
    def test_closed_wraps_observer_over_idempotency(self, moto_breaker):
        breaker, store = _breaker(moto_breaker, targets={"remote_tool": MCP_TARGET})
        inner = _FakeInnerTool("remote_tool", [])
        event = _FakeEvent("remote_tool", inner)
        ComposedToolHook(governance=_evaluator(), idempotency=_idempotency(),
                         breaker=breaker)._on_before_tool_call(event)
        assert isinstance(event.selected_tool, _BreakerObserverTool)
        assert isinstance(event.selected_tool._inner, _IdempotentToolWrapper)


class TestLocalToolSkipsBreaker:
    def test_local_tool_no_target_skips_breaker_zero_ddb(self, moto_breaker):
        breaker, store = _breaker(moto_breaker, targets={})  # "calc" resolves to None
        inner = _FakeInnerTool("calc", [])
        event = _FakeEvent("calc", inner)
        ComposedToolHook(governance=_evaluator(), idempotency=_idempotency(),
                         breaker=breaker)._on_before_tool_call(event)
        assert isinstance(event.selected_tool, _IdempotentToolWrapper)
        assert not isinstance(event.selected_tool, _BreakerObserverTool)
        assert store.ddb_op_count == 0


class TestAgentRunnerBreakerWiring:
    def _agent_runner(self):
        sys.modules.pop("agent_runner", None)
        import agent_runner
        return agent_runner

    def test_no_table_yields_no_breaker(self, monkeypatch):
        monkeypatch.delenv("TOOL_BREAKER_TABLE", raising=False)
        assert self._agent_runner()._build_tool_breaker("exec1", "node1") is None

    def test_table_but_no_targets_yields_no_breaker(self, monkeypatch):
        monkeypatch.setenv("TOOL_BREAKER_TABLE", TABLE)
        monkeypatch.delenv("TOOL_BREAKER_TARGETS", raising=False)
        assert self._agent_runner()._build_tool_breaker("exec1", "node1") is None

    def test_table_and_targets_build_a_resolving_breaker(self, monkeypatch):
        import json as _json
        monkeypatch.setenv("TOOL_BREAKER_TABLE", TABLE)
        monkeypatch.setenv("TOOL_BREAKER_TARGETS", _json.dumps({
            "remote_tool": ["mcp_server", "mcp-1"],
        }))
        monkeypatch.setenv("CITADEL_ORG_ID", "org1")
        ar = self._agent_runner()
        breaker = ar._build_tool_breaker("exec1", "node1")
        assert isinstance(breaker, ToolBreaker)
        # The resolver maps the known tool to its target and unknown to None.
        # Compare by fields: agent_runner's BreakerTarget is imported via the
        # deployed 'governance.*' path, a distinct class object from this test's
        # 'arbiter.governance.*' import (module-identity), so dataclass eq would
        # be False across identities even for identical fields.
        resolved = breaker._target_resolver("remote_tool")
        assert (resolved.kind, resolved.target_id) == (MCP_TARGET.kind, MCP_TARGET.target_id)
        assert breaker._target_resolver("calc") is None
