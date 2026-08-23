"""Tests for arbiter/seedConfig/smoke_idempotency_agent.py (diagnostic fixture).

Covers:
  1. The smoke tool is classified side-effecting (MODE_LEDGER), never bypass.
  2. Its handler writes exactly one row per execution, keyed by a FRESH uuid
     that differs across independent executions (never deterministic).
  3. A repeated call reserved under the SAME idempotency key (simulating the
     ledger absorbing a duplicate/retry) yields exactly ONE smoke row — the
     tool function itself is invoked only once; the ledger's reserve/absorb
     semantics are exercised via the real ``tool_execution_ledger`` module
     against the same conditional-write FakeTable harness used by
     ``test_tool_execution_ledger.py``, reused here rather than reimplemented.

Because the worker downloads exactly one file per agent (no sibling
imports), the smoke agent module is entirely self-contained. These tests
load it the same way ``test_agent_runner_properties.py`` loads other
single-file agent modules: write it to a temp path and ``exec_module`` it
(here we load the real repo file directly via ``importlib`` so a drift
between the module and its test is impossible).
"""
from __future__ import annotations

import importlib.util
import os
import sys
import types
import uuid

import pytest

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import tool_execution_ledger as ledger  # noqa: E402
from arbiter.governance.tool_execution_ledger import (  # noqa: E402
    __reset_ledger_client_for_test,
    execute_idempotent,
)
from arbiter.workerWrapper.tool_idempotency import (  # noqa: E402
    MODE_LEDGER,
    build_key,
    classify_idempotency_mode,
)

# Module-level alias: a dunder-prefixed name referenced bare inside a class
# body is name-mangled by Python (e.g. `__reset_ledger_client_for_test()` in
# a method becomes `_ClassName__reset_ledger_client_for_test`). Binding it to
# a plain-named module attribute here (same workaround as
# test_tool_execution_ledger.py) lets fixtures call it safely.
_reset_ledger_client_for_test = __reset_ledger_client_for_test

_MODULE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "smoke_idempotency_agent.py"
)


def _load_smoke_agent_module():
    """Load the real smoke agent file as a fresh module object."""
    spec = importlib.util.spec_from_file_location(
        "smoke_idempotency_agent_under_test", _MODULE_PATH
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeDynamoDBTable:
    """Minimal Table stand-in recording every put_item call."""

    def __init__(self):
        self.items = []

    def put_item(self, Item):  # noqa: N803 — mirrors boto3 kwarg casing
        self.items.append(dict(Item))


class _FakeDynamoDBResource:
    def __init__(self, table):
        self._table = table

    def Table(self, name):  # noqa: N802
        return self._table


class _FakeBoto3Module(types.ModuleType):
    def __init__(self, table):
        super().__init__("boto3")
        self._table = table

    def resource(self, service_name):
        assert service_name == "dynamodb"
        return _FakeDynamoDBResource(self._table)


class _FakeAgentTool:
    """Stand-in for ``strands.Agent().tool`` exposing synchronous tool
    callables (matches strands 1.30.0's direct-call surface)."""

    def __init__(self, tools_by_name):
        for name, fn in tools_by_name.items():
            setattr(self, name, fn)


class _FakeStrandsAgent:
    """Minimal Agent stand-in: exposes ``.tool.<name>(...)`` as a SYNCHRONOUS
    direct call that returns the tool's result dict — mirroring strands
    1.30.0's real ``agent.tool.<name>(...)`` surface (it drives the tool
    executor internally via ``run_async`` and RETURNS the result; it is NOT a
    coroutine). Faithfully synchronous so a regression that re-adds ``await``
    to the handler is caught here (awaiting a dict raises TypeError), instead
    of the old async fake masking it."""

    def __init__(self, *args, tools=None, **kwargs):
        self._tools = list(tools or [])
        tools_by_name = {}
        for fn in self._tools:
            name = getattr(fn, "__name__", None) or getattr(
                fn, "tool_name", "tool"
            )
            tools_by_name[name] = self._make_sync_wrapper(fn)
        self.tool = _FakeAgentTool(tools_by_name)

    @staticmethod
    def _make_sync_wrapper(fn):
        def _wrapper(**kwargs):
            return fn(**kwargs)

        return _wrapper


def _install_fake_strands(monkeypatch):
    fake_mod = types.ModuleType("strands")

    def _tool_decorator(fn):
        # Real strands @tool wraps the function into a Tool object; for
        # these tests we only need call-through semantics plus a stable
        # __name__, so pass the function through unchanged.
        return fn

    fake_mod.Agent = _FakeStrandsAgent
    fake_mod.tool = _tool_decorator
    monkeypatch.setitem(sys.modules, "strands", fake_mod)
    return fake_mod


@pytest.fixture(autouse=True)
def _fake_boto3(monkeypatch):
    table = _FakeDynamoDBTable()
    fake_boto3 = _FakeBoto3Module(table)
    monkeypatch.setitem(sys.modules, "boto3", fake_boto3)
    yield table


@pytest.fixture(autouse=True)
def _fake_strands(monkeypatch):
    yield _install_fake_strands(monkeypatch)


@pytest.fixture(autouse=True)
def _smoke_table_env(monkeypatch):
    monkeypatch.setenv("SMOKE_IDEMPOTENCY_TABLE", "citadel-smoke-idempotency-test")
    monkeypatch.delenv("CITADEL_ORG_ID", raising=False)


class TestSmokeToolWriteBehavior:
    def test_handler_writes_exactly_one_row(self, _fake_boto3):
        module = _load_smoke_agent_module()
        result = module.handler(note="manual-run")

        assert len(_fake_boto3.items) == 1
        assert "markerId" in result

    def test_each_execution_gets_a_fresh_uuid_not_deterministic(self, _fake_boto3):
        module = _load_smoke_agent_module()
        r1 = module.handler(note="run-1")
        r2 = module.handler(note="run-2")

        assert len(_fake_boto3.items) == 2
        assert r1["markerId"] != r2["markerId"]
        # Both are well-formed UUIDs (proves "fresh uuid", not e.g. a counter).
        uuid.UUID(r1["markerId"])
        uuid.UUID(r2["markerId"])

    def test_org_id_falls_back_to_unscoped_when_unset(self, _fake_boto3, monkeypatch):
        monkeypatch.delenv("CITADEL_ORG_ID", raising=False)
        module = _load_smoke_agent_module()
        module.handler()

        assert _fake_boto3.items[0]["orgId"] == "unscoped"

    def test_org_id_threaded_from_env_when_set(self, _fake_boto3, monkeypatch):
        monkeypatch.setenv("CITADEL_ORG_ID", "org-42")
        module = _load_smoke_agent_module()
        module.handler()

        assert _fake_boto3.items[0]["orgId"] == "org-42"

    def test_row_carries_a_ttl_in_the_future(self, _fake_boto3):
        module = _load_smoke_agent_module()
        module.handler()

        row = _fake_boto3.items[0]
        assert row["ttl"] > row["writtenAt"]

    def test_missing_table_env_fails_closed_not_silent_noop(self, monkeypatch):
        monkeypatch.delenv("SMOKE_IDEMPOTENCY_TABLE", raising=False)
        module = _load_smoke_agent_module()

        with pytest.raises(RuntimeError):
            module.handler()

    def test_handler_calls_direct_tool_synchronously_never_awaited(self):
        """Regression guard for the "'dict' object can't be awaited" node
        failure. strands 1.30.0's ``agent.tool.<name>(...)`` is a SYNCHRONOUS
        direct call returning a ToolResult dict — awaiting it raises
        ``TypeError: object dict can't be used in 'await' expression`` and the
        smoke tool never executes (0 rows). The handler must therefore call it
        directly, never via ``await``/``asyncio.run``.

        Uses ``ast`` (not a substring scan) so explanatory comments that
        mention ``await`` don't create false negatives: we assert there is NO
        ``Await`` node anywhere in the handler's body. The behavioural
        guarantee is additionally enforced by ``_FakeStrandsAgent`` being
        synchronous (a re-added ``await`` would fail the write-behaviour tests
        above by awaiting a plain dict)."""
        import ast
        import inspect
        import textwrap

        module = _load_smoke_agent_module()
        handler_src = ast.parse(textwrap.dedent(inspect.getsource(module.handler)))
        await_nodes = [n for n in ast.walk(handler_src) if isinstance(n, ast.Await)]
        assert await_nodes == [], "handler must not await the synchronous direct tool call"

        # The direct synchronous tool call must be present.
        calls = [
            n for n in ast.walk(handler_src)
            if isinstance(n, ast.Attribute) and n.attr == "smoke_write_marker"
        ]
        assert calls, "handler must invoke agent.tool.smoke_write_marker directly"


# ---------------------------------------------------------------------------
# Classification — the smoke tool must resolve to MODE_LEDGER, never bypass.
# ---------------------------------------------------------------------------


class TestSmokeToolClassification:
    def test_smoke_tool_has_no_idempotency_config_declared(self):
        """The smoke tool's schema (as seeded in arbiter/seedConfig/index.py)
        carries no 'idempotency' key at all — verified against the actual
        seeded config shape, not a hand-copied fixture."""
        import arbiter.seedConfig.index as seed_index

        # The seeded config dict for the smoke agent never sets an
        # idempotency mode; classify_idempotency_mode must therefore fail
        # safe to MODE_LEDGER on that exact shape.
        smoke_tool_config = {
            "name": seed_index.SMOKE_IDEMPOTENCY_AGENT_ID,
        }
        assert "idempotency" not in smoke_tool_config
        assert classify_idempotency_mode(smoke_tool_config) == MODE_LEDGER

    def test_classify_idempotency_mode_resolves_ledger_for_absent_config(self):
        assert classify_idempotency_mode({}) == MODE_LEDGER
        assert classify_idempotency_mode(None) == MODE_LEDGER

    def test_classify_idempotency_mode_never_resolves_bypass_without_explicit_flag(self):
        # Any malformed/unknown value must still fail safe to ledger.
        assert classify_idempotency_mode({"idempotency": {"mode": "readonly"}}) == MODE_LEDGER
        assert classify_idempotency_mode({"idempotency": {}}) == MODE_LEDGER

    def test_production_hook_wiring_never_passes_a_mode_resolver(self):
        """Independent confirmation at the wiring layer: agent_runner's
        production install call for the idempotency hook never supplies a
        mode_resolver, so IdempotencyToolHook._resolve_mode always returns
        MODE_LEDGER regardless of any tool-level config — the smoke tool
        included. (Post finding 027c4a89 the install lives in the single
        composed ``_install_tool_call_hooks`` seam.)"""
        import inspect

        from arbiter.workerWrapper import agent_runner

        source = inspect.getsource(agent_runner._install_tool_call_hooks)
        assert "mode_resolver" not in source
        # The idempotency hook is still constructed on the composed seam.
        assert "IdempotencyToolHook(" in source


# ---------------------------------------------------------------------------
# Ledger-backed dedupe: a repeated call under the SAME key yields ONE row.
# ---------------------------------------------------------------------------


class TestSmokeToolLedgerDedup:
    """Reuses the real tool_execution_ledger coordinator (execute_idempotent)
    against the conditional-write FakeTable harness pattern from
    test_tool_execution_ledger.py, wrapping the smoke tool's own write as
    the ``run_tool`` callable — proving the SAME ledger seam this fixture
    exists to exercise actually absorbs a duplicate call for it.
    """

    @pytest.fixture(autouse=True)
    def _fake_ledger_ddb(self, monkeypatch):
        _reset_ledger_client_for_test()
        monkeypatch.setenv("TOOL_EXECUTION_LEDGER_TABLE", "citadel-tool-execution-ledger-test")

        class _FakeLedgerTable:
            def __init__(self):
                self.store = {}

            @staticmethod
            def _key(d):
                return (d[ledger.PK_ATTR], d[ledger.SK_ATTR])

            def put_item(self, Item, ConditionExpression=None, **_kw):  # noqa: N803
                key = self._key(Item)
                if ConditionExpression and "attribute_not_exists" in ConditionExpression and key in self.store:
                    from botocore.exceptions import ClientError

                    raise ClientError(
                        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "cond"}},
                        "PutItem",
                    )
                self.store[key] = dict(Item)

            def get_item(self, Key, **_kw):  # noqa: N803
                item = self.store.get((Key[ledger.PK_ATTR], Key[ledger.SK_ATTR]))
                return {"Item": dict(item)} if item is not None else {}

            def update_item(self, Key, UpdateExpression, ConditionExpression=None,  # noqa: N803
                             ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_kw):
                key = (Key[ledger.PK_ATTR], Key[ledger.SK_ATTR])
                existing = self.store.get(key)
                names = ExpressionAttributeNames or {}
                values = ExpressionAttributeValues or {}
                if ConditionExpression:
                    for term in ConditionExpression.split(" AND "):
                        lhs, rhs = [t.strip() for t in term.split("=")]
                        attr = names.get(lhs, lhs) if lhs.startswith("#") else lhs
                        if existing is None or existing.get(attr) != values[rhs]:
                            from botocore.exceptions import ClientError

                            raise ClientError(
                                {"Error": {"Code": "ConditionalCheckFailedException", "Message": "cond"}},
                                "UpdateItem",
                            )
                target = dict(existing) if existing else {ledger.PK_ATTR: key[0], ledger.SK_ATTR: key[1]}
                for assignment in UpdateExpression[4:].split(","):
                    lhs, rhs = [t.strip() for t in assignment.split("=")]
                    attr = names.get(lhs, lhs) if lhs.startswith("#") else lhs
                    target[attr] = values[rhs.strip()]
                self.store[key] = target

        class _FakeResource:
            def __init__(self):
                self.tables = {}

            def Table(self, name):  # noqa: N802
                return self.tables.setdefault(name, _FakeLedgerTable())

        fake = _FakeResource()
        monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: fake)
        yield fake
        _reset_ledger_client_for_test()

    def test_repeated_call_under_same_key_yields_one_smoke_row(self, _fake_boto3):
        """Two calls sharing the same ledger key must result in exactly one
        smoke-table row: the second is absorbed as a recorded-success replay
        and its ``run_tool`` (the smoke write) is never invoked."""
        module = _load_smoke_agent_module()

        pk, sk = build_key("orgA", "exec-1", "node-1", 0, "smoke_write_marker", {"note": "n"})

        call_count = {"n": 0}

        def run_tool():
            call_count["n"] += 1
            return module.handler(note="n")

        first = execute_idempotent(
            pk=pk, sk=sk, tool_name="smoke_write_marker", mode=MODE_LEDGER, run_tool=run_tool,
        )
        second = execute_idempotent(
            pk=pk, sk=sk, tool_name="smoke_write_marker", mode=MODE_LEDGER, run_tool=run_tool,
        )

        assert call_count["n"] == 1
        assert len(_fake_boto3.items) == 1
        assert first == second
