"""Real-client (moto) CONTRACT tests for the tool-execution ledger.

Why this file exists (additive to the FakeTable logic tests, never a
replacement): the FakeTable in ``test_tool_execution_ledger.py`` /
``test_tool_execution_fence.py`` faithfully models the *conditional-write
semantics* this module relies on, but it CANNOT catch DynamoDB **wire-contract**
defects — attribute typing (S vs M), float-vs-Decimal marshalling, or a
double-marshal on the ``TransactWriteItems`` fenced reserve — because a Python
dict store neither marshals nor type-checks. Those are exactly the class of bug
that reached a live dev execution (double-marshal -> "Type mismatch for key pk
expected: S actual: M"; and native ``float`` timestamps -> "Float types are not
supported").

These tests run every conditional/transactional write in the reserve ->
finalize path against a REAL boto3 client backed by moto, so a marshalling or
attribute-typing regression fails here even though the FakeTable suite stays
green.

conftest note: ``arbiter/conftest.py`` replaces ``boto3.client`` /
``boto3.resource`` with MagicMock factories for the whole arbiter suite. We
deliberately bypass that stub by constructing a REAL resource via
``boto3.Session().resource(...)`` (the Session class is NOT stubbed) inside the
``mock_aws`` context, then point the ledger's lazy ``_get_dynamodb_resource``
seam at it. ``_get_dynamodb_client()`` then returns that resource's
transform-laden ``.meta.client`` -- the exact object whose double-marshal was
Bug A.
"""
from __future__ import annotations

import os
import sys

import boto3
import pytest

try:
    from moto import mock_aws
except ImportError:  # pragma: no cover
    pytest.skip("moto not installed", allow_module_level=True)

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import tool_execution_ledger as ledger  # noqa: E402
from arbiter.governance.tool_execution_ledger import (  # noqa: E402
    ReserveOutcome,
    StaleWorkerFencedError,
    __reset_ledger_client_for_test,
)
from arbiter.workerWrapper.tool_idempotency import build_key  # noqa: E402

LEDGER_TABLE = "citadel-tool-execution-ledger-moto"
EXEC_TABLE = "citadel-executions-moto"


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


def _make_exec_table(resource):
    return resource.create_table(
        TableName=EXEC_TABLE,
        KeySchema=[{"AttributeName": "executionId", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "executionId", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )


@pytest.fixture
def moto_ledger(monkeypatch):
    """Real moto-backed resource wired into the ledger's lazy seam."""
    with mock_aws():
        # boto3.Session is NOT stubbed by arbiter/conftest.py (only the
        # module-level boto3.client/resource are), so this reaches moto.
        resource = boto3.Session(region_name="us-east-1").resource("dynamodb")
        _make_ledger_table(resource)
        exec_table = _make_exec_table(resource)

        monkeypatch.setenv("TOOL_EXECUTION_LEDGER_TABLE", LEDGER_TABLE)
        monkeypatch.setenv("EXECUTIONS_TABLE", EXEC_TABLE)
        __reset_ledger_client_for_test()
        monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: resource)
        try:
            yield {"resource": resource, "exec_table": exec_table}
        finally:
            __reset_ledger_client_for_test()


def _raw_item(pk, sk):
    """Read the row via a fresh low-level client (marshalled view) to assert on
    the ACTUAL stored attribute types, not the auto-unmarshalled resource view."""
    client = boto3.Session(region_name="us-east-1").client("dynamodb")
    resp = client.get_item(TableName=LEDGER_TABLE, Key={"pk": {"S": pk}, "sk": {"S": sk}})
    return resp.get("Item")


# ---------------------------------------------------------------------------
# Unfenced reserve — conditional first-write-wins + correct attribute types
# ---------------------------------------------------------------------------


class TestUnfencedReserveContract:
    def test_reserve_persists_string_keys_and_numeric_timestamps(self, moto_ledger):
        pk, sk = build_key("orgA", "exec1", "node1", 0, "createTicket", {"x": 1})
        result = ledger.reserve(pk, sk, tool_name="createTicket", now=1_000.5)
        assert result.outcome == ReserveOutcome.WON

        raw = _raw_item(pk, sk)
        assert raw is not None
        # pk/sk MUST be stored as scalar String (S), not Map (M) — the exact
        # regression the double-marshal produced ("expected S actual M").
        assert set(raw["pk"].keys()) == {"S"} and raw["pk"]["S"] == pk
        assert set(raw["sk"].keys()) == {"S"} and raw["sk"]["S"] == sk
        # timestamps stored as Number (int), not rejected as float.
        assert raw["createdAt"] == {"N": "1000"}
        assert raw["status"] == {"S": "in_flight"}

    def test_concurrent_race_second_reserve_does_not_win(self, moto_ledger):
        pk, sk = build_key("orgA", "exec1", "node1", 0, "createTicket", {"x": 1})
        first = ledger.reserve(pk, sk, tool_name="createTicket", now=2000.0)
        assert first.outcome == ReserveOutcome.WON
        # Second reserve of the SAME key: the real conditional
        # attribute_not_exists(pk) write is refused; a live holder -> IN_FLIGHT.
        second = ledger.reserve(pk, sk, tool_name="createTicket", now=2000.0)
        assert second.outcome == ReserveOutcome.IN_FLIGHT

    def test_finalize_success_transitions_to_completed(self, moto_ledger):
        pk, sk = build_key("orgA", "exec1", "node1", 0, "createTicket", {"x": 1})
        ledger.reserve(pk, sk, tool_name="createTicket", now=3000.0)
        ledger.finalize_success(pk, sk, result={"ticketId": "T-1"}, now=3001.0)
        row = ledger.get(pk, sk)
        assert row["status"] == "completed"
        # updatedAt persisted as an int-derived Number (a float would have raised).
        raw = _raw_item(pk, sk)
        assert raw["updatedAt"] == {"N": "3001"}

    def test_release_then_rereserve(self, moto_ledger):
        pk, sk = build_key("orgA", "exec1", "node1", 0, "createTicket", {"x": 1})
        ledger.reserve(pk, sk, tool_name="createTicket", now=4000.0)
        ledger.release(pk, sk)
        assert ledger.get(pk, sk)["status"] == "released"
        # A released row is re-reservable via the conditional CAS.
        again = ledger.reserve(pk, sk, tool_name="createTicket", now=4001.0)
        assert again.outcome == ReserveOutcome.WON
        assert again.reclaimed is True


# ---------------------------------------------------------------------------
# Fenced reserve — the TransactWriteItems that carried the double-marshal
# ---------------------------------------------------------------------------


class TestFencedReserveContract:
    def _seed_exec(self, exec_table, gen):
        exec_table.put_item(
            Item={
                "executionId": "exec1",
                "nodeResults": {"node1": {"dispatchGeneration": gen}},
            }
        )

    def test_fenced_reserve_matching_generation_wins(self, moto_ledger):
        self._seed_exec(moto_ledger["exec_table"], 2)
        pk, sk = build_key("orgA", "exec1", "node1", 0, "createTicket", {"x": 1})
        result = ledger.reserve(
            pk, sk, tool_name="createTicket", now=5000.0,
            dispatch_generation=2, execution_id="exec1", node_id="node1",
        )
        assert result.outcome == ReserveOutcome.WON
        raw = _raw_item(pk, sk)
        # The fenced Put landed with correctly-typed scalar keys (single marshal).
        assert raw["pk"] == {"S": pk}
        assert raw["dispatchGeneration"] == {"N": "2"}

    def test_fenced_reserve_stale_generation_rejected(self, moto_ledger):
        # Execution row is at generation 2; a worker carrying stale gen 1 must be
        # refused at the reserve fence (ConditionCheck) with NO ledger row written.
        self._seed_exec(moto_ledger["exec_table"], 2)
        pk, sk = build_key("orgA", "exec1", "node1", 0, "createTicket", {"x": 1})
        with pytest.raises(StaleWorkerFencedError):
            ledger.reserve(
                pk, sk, tool_name="createTicket", now=5000.0,
                dispatch_generation=1, execution_id="exec1", node_id="node1",
            )
        assert ledger.get(pk, sk) is None  # nothing written on the stale reject
