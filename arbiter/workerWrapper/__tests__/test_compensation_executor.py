"""CIT-123 slice 4 — worker-side GOVERNED compensation execution (red-first).

Covers the load-bearing D2 decision: a compensation dispatch executes through
the SAME ``ComposedToolHook`` seam as any agent tool call — deny-list →
breaker → approval-consume → idempotency reservation — via an LLM-free direct
governed tool invocation entry point. No second installer, no parallel path.

strands is not installed in this env, so the strands seam is simulated with
the SAME fake ``strands.types._events.ToolResultEvent`` / fake tool-object
technique ``test_composed_tool_governance.py`` /
``test_composed_tool_breaker_seam.py`` already use.
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
from tool_idempotency_hook import ComposedToolHook, _IdempotentToolWrapper  # noqa: E402
from governance_tool_hook import _GovernanceDeniedTool  # noqa: E402
from tool_breaker_hook import ToolBreaker, _CircuitOpenTool  # noqa: E402
from governance.tool_breaker_store import (  # noqa: E402
    BreakerConfig, ToolBreakerStore, __reset_breaker_client_for_test,
)
from governance.tool_breaker_logic import BreakerTarget  # noqa: E402
from governance.tool_execution_ledger import StaleWorkerFencedError  # noqa: E402

ledger = tool_idempotency_hook.ledger

LEDGER_TABLE = "citadel-tool-execution-ledger-comp-test"
EXEC_TABLE = "citadel-executions-comp-test"
BREAKER_TABLE = "citadel-tool-breaker-comp-test"

import compensation_executor as ce  # noqa: E402


@pytest.fixture(autouse=True)
def _governance_writes_succeed(monkeypatch):
    monkeypatch.setattr(governed_tool_handler, "write_finding", lambda *a, **k: None)
    tool_idempotency_hook.drain_governance_refusals()
    yield
    tool_idempotency_hook.drain_governance_refusals()


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


@pytest.fixture
def moto_tables(monkeypatch):
    with mock_aws():
        resource = boto3.Session(region_name="us-east-1").resource("dynamodb")
        resource.create_table(
            TableName=LEDGER_TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                   {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        resource.create_table(
            TableName=EXEC_TABLE,
            KeySchema=[{"AttributeName": "executionId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "executionId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        resource.create_table(
            TableName=BREAKER_TABLE,
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"},
                       {"AttributeName": "sk", "KeyType": "RANGE"}],
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"},
                                   {"AttributeName": "sk", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        monkeypatch.setenv("TOOL_EXECUTION_LEDGER_TABLE", LEDGER_TABLE)
        monkeypatch.setenv("EXECUTIONS_TABLE", EXEC_TABLE)
        # Patch the RESOURCE resolver, not _table/_get_dynamodb_client
        # individually — _get_dynamodb_client derives from
        # _get_dynamodb_resource().meta.client, so both the Table() and the
        # fenced TransactWriteItems path must share this SAME moto-backed
        # resource object or the conditional writes silently stop being
        # mutually exclusive.
        ledger.__reset_ledger_client_for_test()
        monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: resource)
        __reset_breaker_client_for_test()
        import governance.tool_breaker_store as store_mod
        monkeypatch.setattr(store_mod, "_get_dynamodb_resource", lambda: resource)
        try:
            yield resource
        finally:
            __reset_breaker_client_for_test()


def _seed_execution_row(resource, execution_id, node_id, generation=1):
    resource.Table(EXEC_TABLE).put_item(Item={
        "executionId": execution_id,
        "nodeResults": {node_id: {"dispatchGeneration": generation}},
    })


def _dispatch(*, execution_id="exec-1", node_id="node-a", tool="close_ticket",
              args=None, generation=1, output=None):
    return {
        "message_type": "workflow_compensation",
        "execution_id": execution_id,
        "node_id": f"{node_id}#comp",
        "workflow_id": "wf-1",
        "tool": tool,
        "args": args if args is not None else {"ticketId": "${output.ticketId}"},
        "compensation_generation": generation,
    }


def _recorded_output(**overrides):
    base = {"ticketId": "T-42"}
    base.update(overrides)
    return base


class _RegisteredTool:
    """A stand-in real compensation tool (mirrors _FakeInnerTool in the
    sibling composed-hook tests). Appends to a shared log so a test can prove
    whether the real side effect ran."""

    def __init__(self, name, executed_log, result=None):
        self._name = name
        self._log = executed_log
        self._result = result or {
            "toolUseId": "tu", "status": "success", "content": [{"text": "closed"}],
        }

    @property
    def tool_name(self):
        return self._name

    @property
    def tool_spec(self):
        return {"name": self._name}

    @property
    def tool_type(self):
        return "python"

    def get_display_properties(self):
        return {}

    async def stream(self, tool_use, invocation_state, **kwargs):
        from strands.types._events import ToolResultEvent
        self._log.append(tool_use.get("input"))
        yield ToolResultEvent(self._result)


def _resolver(executed_log, name="close_ticket", result=None):
    tool = _RegisteredTool(name, executed_log, result=result)
    return lambda tool_name: tool if tool_name == name else None


# ---------------------------------------------------------------------------
# NO-BYPASS structural test: compensation path and agent path share ONE
# ComposedToolHook object/construction, never a second installer.
# ---------------------------------------------------------------------------


class TestNoBypassStructural:
    def test_compensation_hook_builder_returns_a_composed_tool_hook_instance(self):
        """The compensation entry point must build (or accept) a real
        ComposedToolHook — never a bespoke governance-only shortcut."""
        hook = ce.build_compensation_hook(
            org_id="org1", execution_id="exec-1", node_id="node-a#comp",
            agent_id="agent-1", workflow_id="wf-1",
            compensation_generation=1, denied_tools=set(),
        )
        assert isinstance(hook, ComposedToolHook)

    def test_compensation_and_agent_paths_call_the_same_seam_function(self, monkeypatch):
        """Structural proof: patch ComposedToolHook.__init__ once; assert the
        compensation executor's hook-construction path invokes the SAME class
        object agent_runner._install_tool_call_hooks uses — not a lookalike."""
        calls = []
        original_init = ComposedToolHook.__init__

        def _spy_init(self, *a, **k):
            calls.append((a, k))
            return original_init(self, *a, **k)

        monkeypatch.setattr(ComposedToolHook, "__init__", _spy_init)
        ce.build_compensation_hook(
            org_id="org1", execution_id="exec-1", node_id="node-a#comp",
            agent_id="agent-1", workflow_id="wf-1",
            compensation_generation=1, denied_tools=set(),
        )
        assert len(calls) == 1

    def test_no_second_installer_module_exists(self):
        """compensation_executor must NOT define its own deny-list/approval/
        idempotency-ordering logic — it must import and delegate to the
        existing seam objects, not reimplement them."""
        import inspect
        src = inspect.getsource(ce)
        # The banned move: re-deriving the deny→breaker→approval→idempotency
        # order locally instead of delegating to ComposedToolHook.
        assert "def _on_before_tool_call" not in src
        assert "ComposedToolHook" in src


# ---------------------------------------------------------------------------
# DENY -> escalate, no execution, no bypass
# ---------------------------------------------------------------------------


class TestGovernanceDeny:
    def test_deny_never_executes_and_escalates(self, moto_tables, fake_tool_result_event, monkeypatch):
        executed = []
        resolver = _resolver(executed, name="close_ticket")
        escalations = []
        monkeypatch.setattr(ce, "_escalate", lambda **kw: escalations.append(kw))

        _seed_execution_row(moto_tables, "exec-1", "node-a#comp", generation=1)

        result = ce.execute_compensation(
            _dispatch(),
            recorded_output=_recorded_output(),
            org_id="org1",
            denied_tools={"close_ticket"},
            tool_resolver=resolver,
        )

        assert executed == []
        assert result.status == "compensation_failed"
        assert result.escalated is True
        assert len(escalations) == 1

    def test_deny_creates_no_ledger_reservation(self, moto_tables, fake_tool_result_event, monkeypatch):
        executed = []
        resolver = _resolver(executed, name="close_ticket")
        monkeypatch.setattr(ce, "_escalate", lambda **kw: None)
        _seed_execution_row(moto_tables, "exec-1", "node-a#comp", generation=1)

        ce.execute_compensation(
            _dispatch(), recorded_output=_recorded_output(), org_id="org1",
            denied_tools={"close_ticket"}, tool_resolver=resolver,
        )

        rows = moto_tables.Table(LEDGER_TABLE).scan()["Items"]
        assert rows == []


# ---------------------------------------------------------------------------
# Double delivery -> exactly one side effect (ledger HIT_COMPLETED replay)
# ---------------------------------------------------------------------------


class TestDoubleDelivery:
    def test_second_identical_dispatch_replays_no_second_side_effect(
        self, moto_tables, fake_tool_result_event, monkeypatch,
    ):
        executed = []
        resolver = _resolver(executed, name="close_ticket")
        monkeypatch.setattr(ce, "_escalate", lambda **kw: None)
        _seed_execution_row(moto_tables, "exec-1", "node-a#comp", generation=1)

        first = ce.execute_compensation(
            _dispatch(), recorded_output=_recorded_output(), org_id="org1",
            denied_tools=set(), tool_resolver=resolver,
        )
        second = ce.execute_compensation(
            _dispatch(), recorded_output=_recorded_output(), org_id="org1",
            denied_tools=set(), tool_resolver=resolver,
        )

        assert len(executed) == 1  # exactly one real side effect
        assert first.status == "compensated"
        assert second.status == "compensated"
        assert second.replayed is True


# ---------------------------------------------------------------------------
# Stale generation -> refused, no side effect
# ---------------------------------------------------------------------------


class TestStaleGeneration:
    def test_stale_generation_refused_with_no_side_effect(
        self, moto_tables, fake_tool_result_event, monkeypatch,
    ):
        executed = []
        resolver = _resolver(executed, name="close_ticket")
        monkeypatch.setattr(ce, "_escalate", lambda **kw: None)
        # Execution row fenced at generation 2; dispatch carries stale gen 1.
        _seed_execution_row(moto_tables, "exec-1", "node-a#comp", generation=2)

        result = ce.execute_compensation(
            _dispatch(generation=1), recorded_output=_recorded_output(),
            org_id="org1", denied_tools=set(), tool_resolver=resolver,
        )

        assert executed == []
        assert result.status == "compensation_failed"
        assert result.error_class == "StaleWorkerFencedError"


# ---------------------------------------------------------------------------
# Breaker OPEN -> fast-fail, no execution
# ---------------------------------------------------------------------------


class TestBreakerOpen:
    def test_breaker_open_fast_fails_without_execution(
        self, moto_tables, fake_tool_result_event, monkeypatch,
    ):
        executed = []
        resolver = _resolver(executed, name="close_ticket")
        monkeypatch.setattr(ce, "_escalate", lambda **kw: None)
        _seed_execution_row(moto_tables, "exec-1", "node-a#comp", generation=1)

        target = BreakerTarget(kind="mcp_server", target_id="mcp-1")
        moto_tables.Table(BREAKER_TABLE).put_item(Item={
            "pk": "org1#mcp_server#mcp-1", "sk": "STATE", "state": "OPEN",
            "openedAt": 1000, "failureCount": 5, "stateVersion": 1,
            "windowStart": 0, "updatedAt": 1000, "ttl": 1000 + 86400,
        })

        result = ce.execute_compensation(
            _dispatch(), recorded_output=_recorded_output(), org_id="org1",
            denied_tools=set(), tool_resolver=resolver,
            breaker_table=BREAKER_TABLE,
            breaker_target_resolver=lambda name: target if name == "close_ticket" else None,
            breaker_clock=lambda: 1005.0,
        )

        assert executed == []
        assert result.status == "compensation_failed"

        rows = moto_tables.Table(LEDGER_TABLE).scan()["Items"]
        assert rows == []  # breaker fast-fail precedes reserve: no reservation


# ---------------------------------------------------------------------------
# Offloaded output rehydrated then rendered
# ---------------------------------------------------------------------------


class TestOffloadedRehydration:
    def test_offloaded_output_rehydrated_before_render(
        self, moto_tables, fake_tool_result_event, monkeypatch,
    ):
        executed = []
        resolver = _resolver(executed, name="close_ticket")
        monkeypatch.setattr(ce, "_escalate", lambda **kw: None)
        _seed_execution_row(moto_tables, "exec-1", "node-a#comp", generation=1)

        rehydrate_calls = []

        def _fake_rehydrate(offloaded):
            rehydrate_calls.append(offloaded)
            return {"ticketId": "T-99"}

        monkeypatch.setattr(ce, "_rehydrate_recorded_output", _fake_rehydrate)

        offloaded = {"resultOffloaded": True, "resultRef": {"bucket": "b", "key": "k"}}
        result = ce.execute_compensation(
            _dispatch(), recorded_output=offloaded, org_id="org1",
            denied_tools=set(), tool_resolver=resolver,
        )

        assert rehydrate_calls == [offloaded]
        assert executed == [{"ticketId": "T-99"}]
        assert result.status == "compensated"


# ---------------------------------------------------------------------------
# Missing/truncated output -> fail-closed to compensation_failed
# ---------------------------------------------------------------------------


class TestFailClosedOutput:
    def test_missing_output_fails_closed(self, moto_tables, fake_tool_result_event, monkeypatch):
        executed = []
        resolver = _resolver(executed, name="close_ticket")
        escalations = []
        monkeypatch.setattr(ce, "_escalate", lambda **kw: escalations.append(kw))
        _seed_execution_row(moto_tables, "exec-1", "node-a#comp", generation=1)

        result = ce.execute_compensation(
            _dispatch(), recorded_output=None, org_id="org1",
            denied_tools=set(), tool_resolver=resolver,
        )

        assert executed == []
        assert result.status == "compensation_failed"
        assert result.error_class == "CompensationTemplateError"

    def test_truncated_output_fails_closed(self, moto_tables, fake_tool_result_event, monkeypatch):
        executed = []
        resolver = _resolver(executed, name="close_ticket")
        monkeypatch.setattr(ce, "_escalate", lambda **kw: None)
        _seed_execution_row(moto_tables, "exec-1", "node-a#comp", generation=1)

        result = ce.execute_compensation(
            _dispatch(), recorded_output={"resultTruncated": True, "ticketId": "T-1"},
            org_id="org1", denied_tools=set(), tool_resolver=resolver,
        )

        assert executed == []
        assert result.status == "compensation_failed"


# ---------------------------------------------------------------------------
# Successful compensation emits the expected result contract
# ---------------------------------------------------------------------------


class TestResultContract:
    def test_success_result_carries_expected_fields(
        self, moto_tables, fake_tool_result_event, monkeypatch,
    ):
        executed = []
        resolver = _resolver(executed, name="close_ticket")
        monkeypatch.setattr(ce, "_escalate", lambda **kw: None)
        _seed_execution_row(moto_tables, "exec-1", "node-a#comp", generation=1)

        result = ce.execute_compensation(
            _dispatch(), recorded_output=_recorded_output(), org_id="org1",
            denied_tools=set(), tool_resolver=resolver,
        )

        assert result.status == "compensated"
        assert result.execution_id == "exec-1"
        assert result.node_id == "node-a#comp"
        assert result.tool == "close_ticket"
        assert executed == [{"ticketId": "T-42"}]


# ---------------------------------------------------------------------------
# CIT-121 key derivation
# ---------------------------------------------------------------------------


class TestKeyDerivation:
    def test_key_uses_comp_namespace_and_call_index_zero(self, moto_tables, fake_tool_result_event, monkeypatch):
        executed = []
        resolver = _resolver(executed, name="close_ticket")
        monkeypatch.setattr(ce, "_escalate", lambda **kw: None)
        _seed_execution_row(moto_tables, "exec-1", "node-a#comp", generation=1)

        ce.execute_compensation(
            _dispatch(), recorded_output=_recorded_output(), org_id="org1",
            denied_tools=set(), tool_resolver=resolver,
        )

        rows = moto_tables.Table(LEDGER_TABLE).scan()["Items"]
        assert len(rows) == 1
        row = rows[0]
        assert row["pk"] == "org1#exec-1"
        # sk = origNodeId(#comp already embedded in node_id)#0#tool#argsHash
        assert row["sk"].startswith("node-a#comp#0#close_ticket#")
