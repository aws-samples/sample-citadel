"""Tests for arbiter/governance/tool_execution_ledger.py (PR1).

The DynamoDB conditional write is NOT stubbed to always-succeed: ``FakeTable``
faithfully evaluates the ``attribute_not_exists`` / ``status = :inflight`` /
``createdAt = :seen`` conditions this module emits and raises a real
``ConditionalCheckFailedException`` when they fail. The SaaS adapter IS
stubbed (a call counter). Together they let us prove exactly-once execution +
one recorded result, and — via a captured RED differential — that a
NON-conditional reserve lets both callers through.
"""
from __future__ import annotations

import os
import sys

import pytest
from botocore.exceptions import ClientError
from hypothesis import HealthCheck, given, settings, strategies as st

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import tool_execution_ledger as ledger  # noqa: E402
from arbiter.governance.tool_execution_ledger import (  # noqa: E402
    OutcomeIndeterminateError,
    RecordedToolFailure,
    ReserveOutcome,
    RetryableNoExecutionError,
    ToolOutcomeError,
    __reset_ledger_client_for_test,
    execute_idempotent,
    reserve,
)
from arbiter.workerWrapper.tool_idempotency import MODE_BYPASS, MODE_LEDGER, build_key  # noqa: E402

TABLE_NAME = "citadel-tool-execution-ledger-test"


# ---------------------------------------------------------------------------
# Conditional-write fake (faithful, NOT always-succeed)
# ---------------------------------------------------------------------------


def _ccf(op: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": "ConditionalCheckFailedException", "Message": "cond"}}, op
    )


class FakeTable:
    """Stateful DynamoDB Table honoring the conditions this module emits."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.store: dict[tuple, dict] = {}

    @staticmethod
    def _key(d: dict) -> tuple:
        return (d[ledger.PK_ATTR], d[ledger.SK_ATTR])

    def _resolve_name(self, token: str, names: dict) -> str:
        return names.get(token, token) if token.startswith("#") else token

    def _eval_condition(self, expr, existing, names, values) -> bool:
        if not expr:
            return True
        if "attribute_not_exists" in expr:
            return existing is None
        # Handle "LHS = :v [AND LHS = :v]" conjunctions.
        for term in expr.split(" AND "):
            lhs, rhs = [t.strip() for t in term.split("=")]
            attr = self._resolve_name(lhs, names or {})
            expected = values[rhs]
            if existing is None or existing.get(attr) != expected:
                return False
        return True

    def put_item(self, Item, ConditionExpression=None, **_kw):  # noqa: N803
        key = self._key(Item)
        existing = self.store.get(key)
        if not self._eval_condition(ConditionExpression, existing, {}, {}):
            raise _ccf("PutItem")
        self.store[key] = dict(Item)
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    def get_item(self, Key, **_kw):  # noqa: N803
        item = self.store.get((Key[ledger.PK_ATTR], Key[ledger.SK_ATTR]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ConditionExpression=None,  # noqa: N803
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_kw):
        key = (Key[ledger.PK_ATTR], Key[ledger.SK_ATTR])
        existing = self.store.get(key)
        names = ExpressionAttributeNames or {}
        values = ExpressionAttributeValues or {}
        if not self._eval_condition(ConditionExpression, existing, names, values):
            raise _ccf("UpdateItem")
        assert UpdateExpression.startswith("SET ")
        target = dict(existing) if existing else {ledger.PK_ATTR: key[0], ledger.SK_ATTR: key[1]}
        for assignment in UpdateExpression[4:].split(","):
            lhs, rhs = [t.strip() for t in assignment.split("=")]
            attr = self._resolve_name(lhs, names)
            target[attr] = values[rhs.strip()]
        self.store[key] = target
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}

    def delete_item(self, Key, ConditionExpression=None,  # noqa: N803
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_kw):
        key = (Key[ledger.PK_ATTR], Key[ledger.SK_ATTR])
        existing = self.store.get(key)
        if not self._eval_condition(ConditionExpression, existing,
                                    ExpressionAttributeNames or {}, ExpressionAttributeValues or {}):
            raise _ccf("DeleteItem")
        self.store.pop(key, None)
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


class FakeResource:
    def __init__(self):
        self.tables: dict[str, FakeTable] = {}

    def Table(self, name):  # noqa: N802
        return self.tables.setdefault(name, FakeTable(name))


@pytest.fixture(autouse=True)
def _fake_ddb(monkeypatch):
    __reset_ledger_client_for_test()
    monkeypatch.setenv("TOOL_EXECUTION_LEDGER_TABLE", TABLE_NAME)
    fake = FakeResource()
    monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: fake)
    yield fake
    __reset_ledger_client_for_test()


def _table(fake) -> FakeTable:
    return fake.Table(TABLE_NAME)


def _key():
    return build_key("orgA", "exec1", "node1", 0, "createTicket", {"subject": "hi"})


# Module-level alias: a dunder-prefixed name referenced bare inside a class
# body is name-mangled by Python (e.g. `__reset_ledger_client_for_test()` in
# a method becomes `_ClassName__reset_ledger_client_for_test`). Binding it to
# a plain-named module attribute here lets the property test call it safely.
_reset_ledger_client_for_test = __reset_ledger_client_for_test


# ---------------------------------------------------------------------------
# Acceptance: forced double delivery
# ---------------------------------------------------------------------------


class TestForcedDoubleDelivery:
    def test_same_key_executes_once_one_recorded_result(self, _fake_ddb):
        pk, sk = _key()
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            return {"status": "success", "ticketId": "T-1"}

        r1 = execute_idempotent(pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER, run_tool=adapter)
        r2 = execute_idempotent(pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER, run_tool=adapter)

        assert calls["n"] == 1                     # exactly one execution
        assert r1["ticketId"] == "T-1"
        assert r2["ticketId"] == "T-1"             # loser gets recorded result
        rows = [v for v in _table(_fake_ddb).store.values() if v.get("status") == "completed"]
        assert len(rows) == 1                      # one recorded result


# ---------------------------------------------------------------------------
# Concurrent race + RED proof
# ---------------------------------------------------------------------------


class TestConcurrentRace:
    def test_loser_polls_then_retryable_never_executes(self, _fake_ddb):
        pk, sk = _key()
        # Winner A reserves and stays in_flight (does not finalize).
        assert reserve(pk, sk, tool_name="createTicket").outcome == ReserveOutcome.WON

        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            return {"status": "success"}

        clock = {"t": 0.0}
        wait_kwargs = {
            "timeout": 0.3,
            "interval": 0.1,
            "clock": lambda: clock.__setitem__("t", clock["t"] + 0.2) or clock["t"],
            "sleep": lambda _s: None,
        }
        with pytest.raises(RetryableNoExecutionError):
            execute_idempotent(
                pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER,
                run_tool=adapter, wait_kwargs=wait_kwargs,
            )
        assert calls["n"] == 0  # loser NEVER executed

    def test_red_proof_nonconditional_reserve_lets_both_execute(self, _fake_ddb, monkeypatch):
        # Captured RED: replace the conditional reserve with a NON-conditional
        # one (always WON) and show both callers execute (the bug). This proves
        # the conditional write — not app logic — is what enforces exactly-once.
        pk, sk = _key()
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            return {"status": "success", "ticketId": f"T-{calls['n']}"}

        def nonconditional_reserve(_pk, _sk, *, tool_name, now=None, **_kw):
            _table(_fake_ddb).store[(_pk, _sk)] = {
                ledger.PK_ATTR: _pk, ledger.SK_ATTR: _sk, "status": "in_flight",
            }
            return ledger.ReserveResult(ReserveOutcome.WON)

        monkeypatch.setattr(ledger, "reserve", nonconditional_reserve)
        execute_idempotent(pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER, run_tool=adapter)
        execute_idempotent(pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER, run_tool=adapter)
        assert calls["n"] == 2  # RED: non-conditional reserve double-executes

    def test_green_conditional_reserve_lets_one_execute(self, _fake_ddb):
        # GREEN counterpart: the real conditional reserve yields exactly one.
        pk, sk = _key()
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            return {"status": "success", "ticketId": f"T-{calls['n']}"}

        execute_idempotent(pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER, run_tool=adapter)
        execute_idempotent(pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER, run_tool=adapter)
        assert calls["n"] == 1


# ---------------------------------------------------------------------------
# TTL + org scope
# ---------------------------------------------------------------------------


class TestTtlAndOrgScope:
    def test_ttl_set_from_server_write_time(self, _fake_ddb, monkeypatch):
        monkeypatch.setenv("TOOL_LEDGER_TTL_SECONDS", "172800")  # 48h
        pk, sk = _key()
        reserve(pk, sk, tool_name="t", now=1_000_000.0)
        row = _table(_fake_ddb).store[(pk, sk)]
        assert row["ttl"] == 1_000_000 + 172800  # write-time + configured TTL

    def test_org_scope_isolates_partitions(self, _fake_ddb):
        pk_a, sk = build_key("orgA", "exec1", "n", 0, "t", {"x": 1})
        pk_b, _ = build_key("orgB", "exec1", "n", 0, "t", {"x": 1})
        reserve(pk_a, sk, tool_name="t")
        # org B's reserve for the "same" logical call is a different PK -> WON,
        # never colliding with org A's row.
        assert reserve(pk_b, sk, tool_name="t").outcome == ReserveOutcome.WON
        assert ledger.get(pk_b, sk)[ledger.PK_ATTR] == "orgB#exec1"
        # A cross-org read of the other org's key returns that org's row only.
        assert ledger.get(pk_a, sk)[ledger.PK_ATTR] == "orgA#exec1"


# ---------------------------------------------------------------------------
# Failure matrix
# ---------------------------------------------------------------------------


class TestFailureMatrix:
    def test_terminal_failure_recorded_and_replayed_without_reexec(self, _fake_ddb):
        pk, sk = _key()
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            raise ToolOutcomeError("bad request", side_effect="applied", error_type="Http400")

        with pytest.raises(RecordedToolFailure):
            execute_idempotent(pk=pk, sk=sk, tool_name="t", mode=MODE_LEDGER, run_tool=adapter)
        # Replay: recorded terminal failure, NO re-execution.
        with pytest.raises(RecordedToolFailure):
            execute_idempotent(pk=pk, sk=sk, tool_name="t", mode=MODE_LEDGER, run_tool=adapter)
        assert calls["n"] == 1

    def test_retryable_not_sent_releases_and_reexecutes(self, _fake_ddb):
        pk, sk = _key()
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            raise ToolOutcomeError("conn refused", side_effect="not_sent", retryable=True)

        with pytest.raises(RetryableNoExecutionError):
            execute_idempotent(pk=pk, sk=sk, tool_name="t", mode=MODE_LEDGER, run_tool=adapter)
        # Reservation released (status transition, not a delete) -> next
        # attempt re-reserves (WON via conditional CAS) and may execute.
        assert _table(_fake_ddb).store[(pk, sk)]["status"] == "released"
        assert reserve(pk, sk, tool_name="t").outcome == ReserveOutcome.WON

    def test_unknown_outcome_is_fail_safe_indeterminate_never_reexec(self, _fake_ddb):
        pk, sk = _key()
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            raise RuntimeError("5xx after send")  # unclassified -> unknown

        with pytest.raises(OutcomeIndeterminateError):
            execute_idempotent(pk=pk, sk=sk, tool_name="t", mode=MODE_LEDGER, run_tool=adapter)
        row = _table(_fake_ddb).store[(pk, sk)]
        assert row["status"] == "failed"
        assert row["outcomeIndeterminate"] is True
        assert row["retryable"] is False
        # Replay: never re-executed, surfaced (not swallowed).
        with pytest.raises(RecordedToolFailure):
            execute_idempotent(pk=pk, sk=sk, tool_name="t", mode=MODE_LEDGER, run_tool=adapter)
        assert calls["n"] == 1

    def test_tool_error_result_recorded_and_returned(self, _fake_ddb):
        pk, sk = _key()

        def adapter():
            return {"status": "error", "content": [{"text": "nope"}]}

        result = execute_idempotent(pk=pk, sk=sk, tool_name="t", mode=MODE_LEDGER, run_tool=adapter)
        assert result["status"] == "error"
        assert _table(_fake_ddb).store[(pk, sk)]["status"] == "failed"


# ---------------------------------------------------------------------------
# Bypass path writes no ledger row
# ---------------------------------------------------------------------------


class TestBypassPath:
    def test_bypass_skips_ledger_entirely(self, _fake_ddb):
        pk, sk = _key()
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            return {"status": "success"}

        execute_idempotent(pk=pk, sk=sk, tool_name="t", mode=MODE_BYPASS, run_tool=adapter)
        execute_idempotent(pk=pk, sk=sk, tool_name="t", mode=MODE_BYPASS, run_tool=adapter)
        assert calls["n"] == 2                      # no dedupe (read-only tool)
        assert _table(_fake_ddb).store == {}        # NO ledger row written


# ---------------------------------------------------------------------------
# Property: execute_idempotent never repeats the side effect (any JSON args)
# ---------------------------------------------------------------------------

_json_scalars = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(min_value=-(2**53), max_value=2**53),
    st.floats(allow_nan=False, allow_infinity=False, width=32),
    st.text(max_size=20),
)
_json_values = st.recursive(
    _json_scalars,
    lambda children: st.one_of(
        st.lists(children, max_size=5),
        st.dictionaries(st.text(min_size=1, max_size=8), children, max_size=5),
    ),
    max_leaves=15,
)
# str-keyed JSON-serializable "args" object, as build_key's tool_input.
_tool_args = st.dictionaries(st.text(min_size=1, max_size=8), _json_values, max_size=6)


class TestExecuteIdempotentProperty:
    """The mandated execution-level property test (checker finding).

    Drives ``execute_idempotent`` itself (not just canonicalization) under
    Hypothesis: for ANY str-keyed JSON-serializable args, calling it twice
    against a freshly derived key must invoke the adapter exactly once and
    leave exactly one completed ledger row — never zero, never two.
    """

    @settings(
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.function_scoped_fixture],
    )
    @given(_tool_args)
    def test_double_call_executes_adapter_exactly_once_per_example(self, tool_args):
        # Fresh FakeTable + fresh counter + fresh ledger client cache for
        # EVERY generated example — no state leaks across examples, so the
        # assertion holds independently per example rather than only in
        # aggregate.
        _reset_ledger_client_for_test()
        os.environ["TOOL_EXECUTION_LEDGER_TABLE"] = TABLE_NAME
        fake = FakeResource()
        original_get_resource = ledger._get_dynamodb_resource
        ledger._get_dynamodb_resource = lambda: fake
        try:
            pk, sk = build_key("orgProp", "execProp", "nodeProp", 0, "createTicket", tool_args)

            calls = {"n": 0}

            def counting_adapter():
                calls["n"] += 1
                return {"status": "success", "ticketId": "T-prop"}

            r1 = execute_idempotent(
                pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER,
                run_tool=counting_adapter,
            )
            r2 = execute_idempotent(
                pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER,
                run_tool=counting_adapter,
            )

            assert calls["n"] == 1, f"adapter invoked {calls['n']} times for args={tool_args!r}"
            completed_rows = [
                v for v in _table(fake).store.values() if v.get("status") == ledger.STATUS_COMPLETED
            ]
            assert len(completed_rows) == 1, (
                f"expected exactly one completed ledger row for args={tool_args!r}, "
                f"got {len(completed_rows)}"
            )
            assert r1 == r2 == {"status": "success", "ticketId": "T-prop"}
        finally:
            ledger._get_dynamodb_resource = original_get_resource
            _reset_ledger_client_for_test()


# ---------------------------------------------------------------------------
# Dead-holder reclaim
# ---------------------------------------------------------------------------


class TestDeadHolderReclaim:
    def test_stale_inflight_is_reclaimed(self, _fake_ddb, monkeypatch):
        monkeypatch.setenv("TOOL_LEDGER_LEASE_SECONDS", "900")
        pk, sk = _key()
        # A holder reserved long ago and died before finalizing.
        reserve(pk, sk, tool_name="t", now=1000.0)
        # A later attempt, well past the lease, reclaims via conditional CAS.
        result = reserve(pk, sk, tool_name="t", now=1000.0 + 901)
        assert result.outcome == ReserveOutcome.WON
        assert result.reclaimed is True

    def test_fresh_inflight_is_not_reclaimed(self, _fake_ddb, monkeypatch):
        monkeypatch.setenv("TOOL_LEDGER_LEASE_SECONDS", "900")
        pk, sk = _key()
        reserve(pk, sk, tool_name="t", now=1000.0)
        result = reserve(pk, sk, tool_name="t", now=1000.0 + 10)
        assert result.outcome == ReserveOutcome.IN_FLIGHT

    def test_missing_table_env_fails_closed(self, _fake_ddb, monkeypatch):
        monkeypatch.delenv("TOOL_EXECUTION_LEDGER_TABLE", raising=False)
        pk, sk = _key()
        with pytest.raises(ledger.LedgerError):
            reserve(pk, sk, tool_name="t")
