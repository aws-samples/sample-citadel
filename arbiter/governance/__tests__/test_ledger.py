"""Unit + property tests for arbiter/governance/ledger.py (US-ARB-004).

The ledger is the fail-closed audit trail of every governance decision.
These tests verify:

* happy-path item shape (key-schema aliases + flattened fields)
* TTL math (90-day default, caller-overridable)
* write-once semantics (ConditionalCheckFailedException → LedgerWriteError)
* generic AWS failures (InternalServerError → LedgerWriteError)
* missing env var is fail-closed (no network I/O attempted)
* Enum fields serialise to ``.value`` strings
* property-based fuzzing: 100 randomly generated findings always produce a
  well-formed item containing the four key-schema attributes.

boto3 is mocked by patching ``ledger._get_dynamodb_resource`` rather than
``boto3.resource`` directly — the reference implementation (and hierarchy.py)
use a lazy accessor for exactly this reason (QB-013-1).
"""
from __future__ import annotations

import dataclasses
import os
import sys
import time
import uuid
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from hypothesis import HealthCheck, given, settings, strategies as st

# Add the project root (three levels up from this file) to sys.path so that
# ``arbiter.governance.ledger``'s ``from .models import ...`` relative import
# resolves.
_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import ledger  # noqa: E402
from arbiter.governance.ledger import (  # noqa: E402
    LedgerWriteError,
    write_finding,
    __reset_ledger_client_for_test,
)
from arbiter.governance.models import (  # noqa: E402
    ArbitrationDecision,
    ConflictResolution,
    GovernanceFinding,
)


TABLE_NAME = "citadel-governance-ledger-test"


# ---------------------------------------------------------------------------
# Fake DDB plumbing
# ---------------------------------------------------------------------------


class FakeTable:
    """Minimal stand-in for a boto3 DynamoDB Table.

    Records every ``put_item`` invocation so tests can assert the written
    item shape. ``raise_on_put`` lets a test force a ``ClientError`` or any
    other exception from the DDB call.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self.put_calls: list[dict[str, Any]] = []
        self.raise_on_put: Exception | None = None

    def put_item(self, **kwargs: Any) -> dict[str, Any]:
        self.put_calls.append(kwargs)
        if self.raise_on_put is not None:
            raise self.raise_on_put
        return {"ResponseMetadata": {"HTTPStatusCode": 200}}


class FakeDynamoDBResource:
    """Stand-in for ``boto3.resource('dynamodb')``."""

    def __init__(self) -> None:
        self.tables: dict[str, FakeTable] = {}

    def Table(self, name: str) -> FakeTable:  # noqa: N802 — mirrors boto3 API
        if name not in self.tables:
            self.tables[name] = FakeTable(name)
        return self.tables[name]


def _install_fake_ddb(monkeypatch: pytest.MonkeyPatch) -> FakeDynamoDBResource:
    """Patch ``ledger._get_dynamodb_resource`` + env var.

    Returns the fake resource so tests can inspect table call history.
    """
    monkeypatch.setenv("GOVERNANCE_LEDGER_TABLE", TABLE_NAME)
    fake = FakeDynamoDBResource()
    monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: fake)
    return fake


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_cached_client() -> None:
    """Reset the cached boto3 resource between tests (mirrors test_hierarchy)."""
    __reset_ledger_client_for_test()
    yield
    __reset_ledger_client_for_test()


def _make_finding(**overrides: Any) -> GovernanceFinding:
    """Build a canonical finding for tests, with per-test overrides."""
    defaults: dict[str, Any] = {
        "workflow_id": "wf-test-001",
        "decision": ArbitrationDecision.PERMIT,
        "requesting_agent": "agent-a",
        "target_agent": "agent-b",
        "reason": "scope covers request",
        "finding_id": str(uuid.uuid4()),
        "timestamp": 1_700_000_000.0,
        "scope_evaluated": "unit-001",
        "contract_evaluated": None,
        "escalation_target": None,
        "residual_authority_denial": False,
        "trace_id": None,
    }
    defaults.update(overrides)
    return GovernanceFinding(**defaults)


# ---------------------------------------------------------------------------
# 1. Happy path
# ---------------------------------------------------------------------------


def test_happy_path_writes_expected_item_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    finding = _make_finding()

    write_finding(finding)

    table = fake.tables[TABLE_NAME]
    assert len(table.put_calls) == 1
    call = table.put_calls[0]

    # ConditionExpression enforces write-once on the HASH key.
    assert call["ConditionExpression"] == "attribute_not_exists(findingId)"

    item = call["Item"]
    # Key-schema aliases MUST always be present (table HASH + GSI keys).
    assert item["findingId"] == finding.finding_id
    assert item["workflowId"] == finding.workflow_id
    assert float(item["timestamp"]) == pytest.approx(float(finding.timestamp))
    assert "ttl" in item
    # Flattened dataclass fields are carried on the item as well.
    assert item["requesting_agent"] == "agent-a"
    assert item["target_agent"] == "agent-b"
    assert item["reason"] == "scope covers request"
    assert item["decision"] == "permit"  # Enum serialised to .value
    # None-valued fields are stripped (DDB rejects None for S/N types).
    assert "contract_evaluated" not in item
    assert "escalation_target" not in item
    assert "trace_id" not in item
    assert "traceId" not in item


# ---------------------------------------------------------------------------
# 2. TTL math
# ---------------------------------------------------------------------------


def test_ttl_math_matches_ttl_days_argument(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    finding = _make_finding()

    before = time.time()
    write_finding(finding, ttl_days=90)
    after = time.time()

    item = fake.tables[TABLE_NAME].put_calls[0]["Item"]
    ttl = item["ttl"]
    # Within a 1-second window of the wall clock at write time.
    assert before + (90 * 86400) - 1 <= ttl <= after + (90 * 86400) + 1


def test_ttl_math_honours_custom_retention(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    finding = _make_finding()

    before = time.time()
    write_finding(finding, ttl_days=7)
    after = time.time()

    item = fake.tables[TABLE_NAME].put_calls[0]["Item"]
    ttl = item["ttl"]
    assert before + (7 * 86400) - 1 <= ttl <= after + (7 * 86400) + 1


# ---------------------------------------------------------------------------
# 3. Duplicate finding_id rejected
# ---------------------------------------------------------------------------


def test_duplicate_finding_id_raises_ledger_write_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    finding = _make_finding()

    table = fake.Table(TABLE_NAME)
    table.raise_on_put = ClientError(
        {
            "Error": {
                "Code": "ConditionalCheckFailedException",
                "Message": "The conditional request failed",
            }
        },
        "PutItem",
    )

    with pytest.raises(LedgerWriteError) as excinfo:
        write_finding(finding)

    assert "ConditionalCheckFailedException" in str(excinfo.value)
    assert isinstance(excinfo.value.__cause__, ClientError)


# ---------------------------------------------------------------------------
# 4. Network / transient error is fail-closed
# ---------------------------------------------------------------------------


def test_network_error_is_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    finding = _make_finding()

    fake.Table(TABLE_NAME).raise_on_put = ClientError(
        {"Error": {"Code": "InternalServerError", "Message": "boom"}},
        "PutItem",
    )

    with pytest.raises(LedgerWriteError) as excinfo:
        write_finding(finding)
    assert "InternalServerError" in str(excinfo.value)


def test_throttling_error_is_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    finding = _make_finding()

    fake.Table(TABLE_NAME).raise_on_put = ClientError(
        {"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "slow down"}},
        "PutItem",
    )

    with pytest.raises(LedgerWriteError):
        write_finding(finding)


# ---------------------------------------------------------------------------
# 5. Missing env var is fail-closed (no network I/O)
# ---------------------------------------------------------------------------


def test_missing_env_var_raises_without_network_io(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("GOVERNANCE_LEDGER_TABLE", raising=False)

    # Install a fake that would blow up if Table() were ever called, so that
    # a broken implementation (one that *did* reach for the resource) would
    # fail the test deterministically.
    sentinel = MagicMock()
    sentinel.Table.side_effect = AssertionError(
        "Table() must not be called when GOVERNANCE_LEDGER_TABLE is unset"
    )
    monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: sentinel)

    finding = _make_finding()
    with pytest.raises(LedgerWriteError) as excinfo:
        write_finding(finding)

    assert "GOVERNANCE_LEDGER_TABLE" in str(excinfo.value)
    sentinel.Table.assert_not_called()


def test_empty_env_var_raises_without_network_io(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GOVERNANCE_LEDGER_TABLE", "")

    sentinel = MagicMock()
    sentinel.Table.side_effect = AssertionError("must not be called")
    monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: sentinel)

    with pytest.raises(LedgerWriteError):
        write_finding(_make_finding())
    sentinel.Table.assert_not_called()


# ---------------------------------------------------------------------------
# 6. Enum serialisation
# ---------------------------------------------------------------------------


def test_enum_decision_serialised_as_lowercase_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    finding = _make_finding(decision=ArbitrationDecision.DENY)

    write_finding(finding)

    item = fake.tables[TABLE_NAME].put_calls[0]["Item"]
    assert item["decision"] == "deny"
    # Make sure we did NOT serialise the repr / raw enum.
    assert item["decision"] != repr(ArbitrationDecision.DENY)
    assert item["decision"] != str(ArbitrationDecision.DENY)


@pytest.mark.parametrize(
    ("decision", "expected"),
    [
        (ArbitrationDecision.PERMIT, "permit"),
        (ArbitrationDecision.DENY, "deny"),
        (ArbitrationDecision.ESCALATE, "escalate"),
        (ArbitrationDecision.HALT, "halt"),
    ],
)
def test_enum_values_for_every_decision(
    monkeypatch: pytest.MonkeyPatch,
    decision: ArbitrationDecision,
    expected: str,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    write_finding(_make_finding(decision=decision))

    item = fake.tables[TABLE_NAME].put_calls[0]["Item"]
    assert item["decision"] == expected


# ---------------------------------------------------------------------------
# 7. Property-based fuzzing (Hypothesis)
# ---------------------------------------------------------------------------


_decision_strategy = st.sampled_from(list(ArbitrationDecision))
_optional_str = st.one_of(
    st.none(),
    st.text(min_size=1, max_size=20).filter(lambda s: s.strip() != ""),
)
_required_str = st.text(min_size=1, max_size=40).filter(lambda s: s.strip() != "")


@st.composite
def _finding_strategy(draw: st.DrawFn) -> GovernanceFinding:
    return GovernanceFinding(
        workflow_id=draw(_required_str),
        decision=draw(_decision_strategy),
        requesting_agent=draw(_required_str),
        target_agent=draw(_required_str),
        reason=draw(_required_str),
        finding_id=str(uuid.uuid4()),
        timestamp=draw(st.floats(min_value=0.0, max_value=2e9)),
        scope_evaluated=draw(_optional_str),
        contract_evaluated=draw(_optional_str),
        escalation_target=draw(_optional_str),
        residual_authority_denial=draw(st.booleans()),
        trace_id=None,
    )


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(finding=_finding_strategy())
def test_property_write_finding_always_emits_key_schema_attrs(
    monkeypatch: pytest.MonkeyPatch,
    finding: GovernanceFinding,
) -> None:
    __reset_ledger_client_for_test()
    fake = _install_fake_ddb(monkeypatch)

    write_finding(finding)

    item = fake.tables[TABLE_NAME].put_calls[-1]["Item"]
    # The four invariants: key-schema attrs always present on every write.
    assert "findingId" in item
    assert "workflowId" in item
    assert "timestamp" in item
    assert "ttl" in item

    # And they must hold the finding's values, not something else.
    assert item["findingId"] == finding.finding_id
    assert item["workflowId"] == finding.workflow_id
    # timestamp is now normalized by the marshalling boundary (finding 96d24639):
    # integral -> int, fractional -> Decimal. Compare via float() so the type
    # doesn't matter, only the value.
    assert float(item["timestamp"]) == pytest.approx(float(finding.timestamp))
    # Decision always serialises to its enum .value, never repr.
    assert item["decision"] == finding.decision.value


# ---------------------------------------------------------------------------
# 8. Decision<->runtime trace linking (architect task 9b3f4f78) —
#    P1 test 1: ledger byte-identity property for trace_id=None.
# ---------------------------------------------------------------------------


def _finding_strategy_with_trace_id() -> st.SearchStrategy[GovernanceFinding]:
    """Same shape as ``_finding_strategy`` but with an explicit,
    independently-drawn ``trace_id`` (None or a string) so the byte-identity
    property below can be checked against the *same* random finding with
    and without a trace id.
    """

    @st.composite
    def _inner(draw: st.DrawFn) -> GovernanceFinding:
        return GovernanceFinding(
            workflow_id=draw(_required_str),
            decision=draw(_decision_strategy),
            requesting_agent=draw(_required_str),
            target_agent=draw(_required_str),
            reason=draw(_required_str),
            finding_id=str(uuid.uuid4()),
            timestamp=draw(st.floats(min_value=0.0, max_value=2e9)),
            scope_evaluated=draw(_optional_str),
            contract_evaluated=draw(_optional_str),
            escalation_target=draw(_optional_str),
            residual_authority_denial=draw(st.booleans()),
            trace_id=None,
        )

    return _inner()


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(finding=_finding_strategy_with_trace_id())
def test_property_serialize_finding_byte_identical_when_trace_id_none(
    finding: GovernanceFinding,
) -> None:
    """[FAIL-CLOSED NON-REGRESSION property] For an arbitrary finding with
    ``trace_id=None`` (the default / absent-trace-context case), the
    serialized ledger item is dict-equal to what a finding with NO
    ``trace_id`` field at all would have produced, and it contains neither
    ``trace_id`` nor ``traceId``. Absent trace context => byte-identical
    write to the pre-linking serialization.
    """
    assert finding.trace_id is None
    item = ledger._serialize_finding(finding)

    assert "trace_id" not in item
    assert "traceId" not in item

    # Cross-check against dataclasses.asdict directly: the raw dataclass
    # field is None and must never survive into the item under either name.
    raw = dataclasses.asdict(finding)
    assert raw["trace_id"] is None


def test_serialize_finding_emits_camelcase_trace_id_when_present() -> None:
    finding = _make_finding(trace_id="1-5f2f0000-abcdef0123456789abcdef01")
    item = ledger._serialize_finding(finding)

    assert item["traceId"] == "1-5f2f0000-abcdef0123456789abcdef01"
    # snake_case raw field name is not separately duplicated on the item
    # under its own key (the top-level loop already flattens dataclass
    # fields under their dataclass names, so `trace_id` IS present too —
    # this assertion documents that fact rather than hiding it).
    assert item.get("trace_id") == "1-5f2f0000-abcdef0123456789abcdef01"

    # TTL and the write-once condition target are untouched by trace-id
    # stamping.
    assert "ttl" not in item  # ttl is added by write_finding, not _serialize_finding
    assert item["findingId"] == finding.finding_id
