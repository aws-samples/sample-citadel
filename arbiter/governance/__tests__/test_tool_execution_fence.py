"""Tests for the PR2 dispatch-generation fence in tool_execution_ledger.reserve.

The fence closes the inherited O7 commitment: a worker that was re-dispatched
away (its node's dispatchGeneration was bumped by the watchdog) is REFUSED at
the reserve step before any side effect. Security condition C2 requires the
generation guard to be evaluated inside the SAME conditional write as the
reserve — so it is implemented as a ``ConditionCheck`` on the execution row
inside the reserve's ``TransactWriteItems``.

The fake ``transact_write_items`` here mirrors the CORRECTED contract: production
passes **native** Python values in the ``TransactItems`` (the resource-backed
client auto-marshals them exactly once), so the fake reads them natively — no
manual unmarshalling. It evaluates BOTH the ledger ``attribute_not_exists`` Put
condition and the execution-row generation ``ConditionCheck`` against shared
state, and raises a real ``TransactionCanceledException`` with per-item
``CancellationReasons`` — so the differential RED (unfenced double-execute) and
the TOCTOU proof (a generation bump interleaved at commit time) both bite for
the right reason. Real-DynamoDB attribute typing / double-marshal regressions
are covered by the moto contract suite (``test_ledger_contract_moto.py``).
"""
from __future__ import annotations

import os
import sys

import pytest
from botocore.exceptions import ClientError

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import tool_execution_ledger as ledger  # noqa: E402
from arbiter.governance.tool_execution_ledger import (  # noqa: E402
    ReserveOutcome,
    StaleWorkerFencedError,
    __reset_ledger_client_for_test,
    execute_idempotent,
)
from arbiter.workerWrapper.tool_idempotency import MODE_LEDGER, build_key  # noqa: E402

LEDGER_TABLE = "citadel-tool-execution-ledger-test"
EXEC_TABLE = "citadel-executions-test"


class _FakeLedgerTable:
    """Ledger table: (pk, sk) keyed, honours attribute_not_exists / status /
    createdAt conditions for put/get/update (finalize path)."""

    def __init__(self) -> None:
        self.store: dict[tuple, dict] = {}

    @staticmethod
    def _k(d):
        return (d[ledger.PK_ATTR], d[ledger.SK_ATTR])

    def _cond_ok(self, expr, existing, names, values):
        if not expr:
            return True
        if "attribute_not_exists" in expr:
            return existing is None
        for term in expr.split(" AND "):
            lhs, rhs = [t.strip() for t in term.split("=")]
            attr = names.get(lhs, lhs) if lhs.startswith("#") else lhs
            if existing is None or existing.get(attr) != values[rhs]:
                return False
        return True

    def put_item(self, Item, ConditionExpression=None, **_kw):  # noqa: N803
        if not self._cond_ok(ConditionExpression, self.store.get(self._k(Item)), {}, {}):
            raise _ccf("PutItem")
        self.store[self._k(Item)] = dict(Item)
        return {}

    def get_item(self, Key, **_kw):  # noqa: N803
        item = self.store.get((Key[ledger.PK_ATTR], Key[ledger.SK_ATTR]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ConditionExpression=None,  # noqa: N803
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_kw):
        key = (Key[ledger.PK_ATTR], Key[ledger.SK_ATTR])
        existing = self.store.get(key)
        names = ExpressionAttributeNames or {}
        values = ExpressionAttributeValues or {}
        if not self._cond_ok(ConditionExpression, existing, names, values):
            raise _ccf("UpdateItem")
        target = dict(existing) if existing else {ledger.PK_ATTR: key[0], ledger.SK_ATTR: key[1]}
        for assignment in UpdateExpression[4:].split(","):
            lhs, rhs = [t.strip() for t in assignment.split("=")]
            attr = names.get(lhs, lhs) if lhs.startswith("#") else lhs
            target[attr] = values[rhs.strip()]
        self.store[key] = target
        return {}


def _ccf(op):
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "c"}}, op)


class _FakeClient:
    """Faithful transact_write_items over the shared ledger + executions state.

    ``pre_eval_hook`` runs immediately before the fence ConditionCheck is
    evaluated — the TOCTOU test uses it to bump the execution generation at
    commit time and prove the guard reads LIVE state (no read-then-check gap).
    """

    def __init__(self, ledger_table, exec_store, *, pre_eval_hook=None):
        self._ledger = ledger_table
        self._exec = exec_store
        self.pre_eval_hook = pre_eval_hook

    def transact_write_items(self, TransactItems):  # noqa: N803
        put = TransactItems[0]["Put"]
        check = TransactItems[1]["ConditionCheck"]
        # Production passes NATIVE values (the resource-backed client
        # auto-marshals once); the fake mirrors that. A regression back to
        # pre-marshalled {"S": ...} maps would make pk/sk dicts here and blow
        # up — the in-process analogue of DynamoDB's "expected S actual M".
        put_item = put["Item"]
        put_ok = self._ledger.store.get((put_item[ledger.PK_ATTR], put_item[ledger.SK_ATTR])) is None

        if self.pre_eval_hook is not None:
            self.pre_eval_hook()

        check_key = check["Key"]
        names = check["ExpressionAttributeNames"]
        gen_value = check["ExpressionAttributeValues"][":gen"]
        row = self._exec.get(check_key["executionId"], {})
        node = (row.get("nodeResults") or {}).get(names["#nid"], {})
        current = node.get(names["#gen"])
        fence_ok = current is not None and current == gen_value

        if put_ok and fence_ok:
            self._ledger.store[(put_item[ledger.PK_ATTR], put_item[ledger.SK_ATTR])] = put_item
            return {}
        reasons = [
            {"Code": "None" if put_ok else "ConditionalCheckFailed"},
            {"Code": "None" if fence_ok else "ConditionalCheckFailed"},
        ]
        raise ClientError(
            {"Error": {"Code": "TransactionCanceledException", "Message": "cancelled"},
             "CancellationReasons": reasons},
            "TransactWriteItems",
        )


class _FakeResource:
    def __init__(self, ledger_table, exec_store, *, pre_eval_hook=None):
        self._ledger_table = ledger_table
        self.meta = type("M", (), {})()
        self.meta.client = _FakeClient(ledger_table, exec_store, pre_eval_hook=pre_eval_hook)

    def Table(self, name):  # noqa: N802
        return self._ledger_table


@pytest.fixture
def fence_env(monkeypatch):
    monkeypatch.setenv("TOOL_EXECUTION_LEDGER_TABLE", LEDGER_TABLE)
    monkeypatch.setenv("EXECUTIONS_TABLE", EXEC_TABLE)
    __reset_ledger_client_for_test()
    yield
    __reset_ledger_client_for_test()


def _wire(monkeypatch, exec_store, *, pre_eval_hook=None):
    lt = _FakeLedgerTable()
    resource = _FakeResource(lt, exec_store, pre_eval_hook=pre_eval_hook)
    monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: resource)
    return lt


def _exec_store(gen):
    return {"exec1": {"executionId": "exec1", "nodeResults": {"node1": {"dispatchGeneration": gen}}}}


# ---------------------------------------------------------------------------
# THE RED PROOF (captured, permanent differential)
# ---------------------------------------------------------------------------


class TestFenceDifferentialRedProof:
    """A stale-generation split-brain: worker A (gen 1) and worker B (gen 2)
    both run; the node's current generation is 2 (A was re-dispatched away).

    UNFENCED (dispatch_generation=None), nondeterministic re-dispatch yields
    DIFFERENT keys -> both reserve WON -> BOTH execute (calls == 2, the bug).
    FENCED -> A is refused at the reserve fence (StaleWorkerFencedError, no
    execution); only B executes (calls == 1)."""

    def test_unfenced_stale_worker_double_executes_RED(self, fence_env, monkeypatch):
        _wire(monkeypatch, _exec_store(2))
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            return {"status": "success", "ticketId": f"T-{calls['n']}"}

        # Nondeterministic re-dispatch -> different args -> different keys.
        pk_a, sk_a = build_key("orgA", "exec1", "node1", 0, "createTicket", {"subject": "A"})
        pk_b, sk_b = build_key("orgA", "exec1", "node1", 0, "createTicket", {"subject": "B"})
        # Unfenced: no dispatch_generation threaded.
        execute_idempotent(pk=pk_a, sk=sk_a, tool_name="createTicket", mode=MODE_LEDGER, run_tool=adapter)
        execute_idempotent(pk=pk_b, sk=sk_b, tool_name="createTicket", mode=MODE_LEDGER, run_tool=adapter)

        assert calls["n"] == 2  # RED: the unfenced path lets the stale worker through

    def test_fenced_stale_worker_refused_single_execute_GREEN(self, fence_env, monkeypatch):
        _wire(monkeypatch, _exec_store(2))
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            return {"status": "success", "ticketId": f"T-{calls['n']}"}

        pk_a, sk_a = build_key("orgA", "exec1", "node1", 0, "createTicket", {"subject": "A"})
        pk_b, sk_b = build_key("orgA", "exec1", "node1", 0, "createTicket", {"subject": "B"})

        # Worker A carries the STALE generation 1 -> fenced, never executes.
        with pytest.raises(StaleWorkerFencedError):
            execute_idempotent(
                pk=pk_a, sk=sk_a, tool_name="createTicket", mode=MODE_LEDGER,
                run_tool=adapter, dispatch_generation=1,
                execution_id="exec1", node_id="node1",
            )
        # Worker B carries the CURRENT generation 2 -> wins, executes once.
        execute_idempotent(
            pk=pk_b, sk=sk_b, tool_name="createTicket", mode=MODE_LEDGER,
            run_tool=adapter, dispatch_generation=2,
            execution_id="exec1", node_id="node1",
        )

        assert calls["n"] == 1  # GREEN: only the current generation executed


# ---------------------------------------------------------------------------
# TOCTOU: the guard is IN the reserve's conditional write, not a prior read
# ---------------------------------------------------------------------------


class TestFenceTOCTOU:
    def test_generation_bump_at_commit_time_refuses_stale_worker(self, fence_env, monkeypatch):
        """A generation bump interleaved BETWEEN a (hypothetical) read and the
        write must NOT let the stale worker through. The worker carries gen 1,
        which is current when it starts; a watchdog re-dispatch bumps the
        execution row to gen 2 at commit time (via pre_eval_hook). Because the
        guard is a ConditionCheck evaluated atomically WITH the reserve — not a
        separate read-then-act — the worker is refused. A naive read-then-check
        would have seen gen 1 and proceeded (the very TOCTOU window C2 forbids).
        """
        exec_store = _exec_store(1)  # worker's carried gen (1) IS current at start
        calls = {"n": 0}

        def bump_generation():
            # The re-dispatch lands right before the fence condition is evaluated.
            exec_store["exec1"]["nodeResults"]["node1"]["dispatchGeneration"] = 2

        _wire(monkeypatch, exec_store, pre_eval_hook=bump_generation)

        def adapter():
            calls["n"] += 1
            return {"status": "success"}

        pk, sk = build_key("orgA", "exec1", "node1", 0, "createTicket", {"subject": "hi"})
        with pytest.raises(StaleWorkerFencedError):
            execute_idempotent(
                pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER,
                run_tool=adapter, dispatch_generation=1,
                execution_id="exec1", node_id="node1",
            )
        assert calls["n"] == 0  # never executed — the guard read live state at write time

    def test_current_generation_worker_wins_and_dedupes_under_fence(self, fence_env, monkeypatch):
        """The current-generation worker reserves; a redelivery of the SAME key
        (fence Put fails, fence check passes) resolves to the recorded result —
        dedupe still works under the fence (exactly-once within the generation)."""
        lt = _wire(monkeypatch, _exec_store(3))
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            return {"status": "success", "ticketId": "T-1"}

        pk, sk = build_key("orgA", "exec1", "node1", 0, "createTicket", {"subject": "hi"})
        r1 = execute_idempotent(
            pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER, run_tool=adapter,
            dispatch_generation=3, execution_id="exec1", node_id="node1",
        )
        r2 = execute_idempotent(
            pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER, run_tool=adapter,
            dispatch_generation=3, execution_id="exec1", node_id="node1",
        )
        assert calls["n"] == 1
        assert r1["ticketId"] == "T-1" and r2["ticketId"] == "T-1"
        completed = [v for v in lt.store.values() if v.get("status") == "completed"]
        assert len(completed) == 1

    def test_missing_executions_table_fails_closed(self, fence_env, monkeypatch):
        """A generation was threaded but EXECUTIONS_TABLE is unset -> fail closed
        (never silently downgrade to an unfenced reserve)."""
        _wire(monkeypatch, _exec_store(1))
        monkeypatch.delenv("EXECUTIONS_TABLE", raising=False)
        pk, sk = build_key("orgA", "exec1", "node1", 0, "createTicket", {"subject": "hi"})
        with pytest.raises(ledger.LedgerError):
            execute_idempotent(
                pk=pk, sk=sk, tool_name="createTicket", mode=MODE_LEDGER, run_tool=lambda: {},
                dispatch_generation=1, execution_id="exec1", node_id="node1",
            )
