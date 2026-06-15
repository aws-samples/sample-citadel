"""Unit + property tests for arbiter/governance/case_law_admin.py (US-ARB-013)."""

from __future__ import annotations

import os
import sys
import uuid
from typing import Any
from unittest.mock import patch

import pytest
from botocore.exceptions import ClientError
from hypothesis import given, settings, strategies as st

# Import via the project root so the module's ``import boto3`` works and so
# ``arbiter.governance.case_law_admin`` resolves as a package.
_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import case_law_admin  # noqa: E402
from arbiter.governance.case_law_admin import (  # noqa: E402
    encode_entry,
    list_entries,
    revoke_entry,
    verify_entry,
)
from arbiter.governance.engine import GovernanceEngine  # noqa: E402
from arbiter.governance.models import (  # noqa: E402
    ArbitrationDecision,
    DispatchRequest,
)


# ---------------------------------------------------------------------------
# Fake DDB table
# ---------------------------------------------------------------------------


class FakeTable:
    """Minimal dict-backed stand-in for a boto3 DynamoDB Table.

    Supports the four operations the CLI uses: ``put_item``, ``get_item``,
    ``update_item`` (with the conditional existence check), and ``scan``.
    """

    def __init__(self) -> None:
        self.items: dict[str, dict[str, Any]] = {}

    def put_item(self, *, Item: dict[str, Any], **_: Any) -> dict[str, Any]:
        self.items[Item["entryId"]] = dict(Item)
        return {}

    def get_item(self, *, Key: dict[str, Any], **_: Any) -> dict[str, Any]:
        eid = Key["entryId"]
        if eid in self.items:
            return {"Item": dict(self.items[eid])}
        return {}

    def update_item(
        self,
        *,
        Key: dict[str, Any],
        UpdateExpression: str = "",
        ConditionExpression: str = "",
        ExpressionAttributeValues: dict[str, Any] | None = None,
        **_: Any,
    ) -> dict[str, Any]:
        eid = Key["entryId"]
        if eid not in self.items:
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException"}},
                "UpdateItem",
            )
        values = ExpressionAttributeValues or {}
        # Apply the specific update pattern the CLI uses. The FakeTable is
        # not a general-purpose UpdateExpression parser — it mirrors the one
        # update shape this module writes.
        self.items[eid]["revoked"] = values.get(":r", True)
        self.items[eid]["revokedAt"] = values.get(":t", "")
        return {}

    def scan(self, **_: Any) -> dict[str, Any]:
        return {"Items": [dict(v) for v in self.items.values()]}


@pytest.fixture
def fake_table() -> FakeTable:
    """Fresh FakeTable + patched ``_get_table`` for every test."""
    table = FakeTable()
    with patch.object(case_law_admin, "_get_table", return_value=table):
        yield table


# ---------------------------------------------------------------------------
# encode_entry
# ---------------------------------------------------------------------------


def test_encode_entry_produces_expected_row(fake_table: FakeTable) -> None:
    entry_id = encode_entry(
        agent="payments-agent",
        target="fraud-agent",
        outcome="deny",
        adjudicator="operator@acme.com",
    )
    # entryId is a valid uuid4.
    parsed = uuid.UUID(entry_id)
    assert parsed.version == 4

    row = fake_table.items[entry_id]
    assert row["entryId"] == entry_id
    assert row["pattern"] == {"agent": "payments-agent", "target": "fraud-agent"}
    assert row["resolution"] == "deny"
    assert row["createdBy"] == "operator@acme.com"
    assert row["revoked"] is False
    assert row["precedence"] == 0
    # createdAt is an ISO-8601 string (has 'T' and a '+' or 'Z' offset).
    assert isinstance(row["createdAt"], str)
    assert "T" in row["createdAt"]
    assert ("+" in row["createdAt"]) or row["createdAt"].endswith("Z")


def test_encode_entry_rejects_invalid_outcome(fake_table: FakeTable) -> None:
    with pytest.raises(ValueError):
        encode_entry(
            agent="a", target="b", outcome="maybe", adjudicator="op",
        )
    assert fake_table.items == {}


def test_encode_entry_honours_precedence_and_scope(fake_table: FakeTable) -> None:
    scope = {"domain": "payment"}
    entry_id = encode_entry(
        agent="a",
        target="b",
        outcome="permit",
        adjudicator="op",
        precedence=42,
        description="context",
        scope=scope,
    )
    row = fake_table.items[entry_id]
    assert row["precedence"] == 42
    assert row["scopeOfApplicability"] == scope
    assert row["description"] == "context"


def test_encode_entry_pattern_is_a_dict_not_json_string(
    fake_table: FakeTable,
) -> None:
    # Hierarchy._maybe_json expects a dict or a JSON string; the CLI must
    # write the dict form so loaders on either side work without an extra
    # parse step.
    entry_id = encode_entry(
        agent="x", target="y", outcome="halt", adjudicator="op",
    )
    row = fake_table.items[entry_id]
    assert isinstance(row["pattern"], dict)
    assert not isinstance(row["pattern"], str)


# ---------------------------------------------------------------------------
# list_entries
# ---------------------------------------------------------------------------


def test_list_entries_excludes_revoked_by_default(fake_table: FakeTable) -> None:
    eid_a = encode_entry(agent="a", target="b", outcome="deny", adjudicator="op")
    eid_b = encode_entry(agent="c", target="d", outcome="permit", adjudicator="op")

    # Revoke the first one.
    assert revoke_entry(eid_a) is True

    rows = list_entries()

    listed_ids = [r["entryId"] for r in rows]
    assert eid_a not in listed_ids
    assert eid_b in listed_ids
    assert len(rows) == 1


def test_list_entries_include_revoked_returns_all(fake_table: FakeTable) -> None:
    eid_a = encode_entry(agent="a", target="b", outcome="deny", adjudicator="op")
    eid_b = encode_entry(agent="c", target="d", outcome="permit", adjudicator="op")
    revoke_entry(eid_a)

    rows = list_entries(include_revoked=True)

    listed_ids = {r["entryId"] for r in rows}
    assert listed_ids == {eid_a, eid_b}


def test_list_entries_empty_table_returns_empty_list(fake_table: FakeTable) -> None:
    assert list_entries() == []
    assert list_entries(include_revoked=True) == []


# ---------------------------------------------------------------------------
# verify_entry
# ---------------------------------------------------------------------------


def test_verify_entry_returns_row_when_present(fake_table: FakeTable) -> None:
    eid = encode_entry(agent="a", target="b", outcome="deny", adjudicator="op")

    result = verify_entry(eid)

    assert result is not None
    assert result["entryId"] == eid
    assert result["resolution"] == "deny"


def test_verify_entry_returns_none_for_unknown_id(fake_table: FakeTable) -> None:
    assert verify_entry("no-such-id") is None


def test_verify_entry_returns_none_for_revoked(fake_table: FakeTable) -> None:
    eid = encode_entry(agent="a", target="b", outcome="deny", adjudicator="op")
    revoke_entry(eid)

    assert verify_entry(eid) is None


# ---------------------------------------------------------------------------
# revoke_entry
# ---------------------------------------------------------------------------


def test_revoke_entry_flips_revoked_and_sets_timestamp(fake_table: FakeTable) -> None:
    eid = encode_entry(agent="a", target="b", outcome="deny", adjudicator="op")

    assert revoke_entry(eid) is True

    row = fake_table.items[eid]
    assert row["revoked"] is True
    assert "revokedAt" in row
    assert isinstance(row["revokedAt"], str)
    assert "T" in row["revokedAt"]


def test_revoke_entry_returns_false_for_unknown_id(fake_table: FakeTable) -> None:
    assert revoke_entry("no-such-id") is False


def test_revoke_entry_idempotent_on_already_revoked_row(
    fake_table: FakeTable,
) -> None:
    # The conditional check is ``attribute_exists(entryId)`` — it only
    # guards against missing rows, not against the already-revoked state.
    # The engine still filters revoked rows at load time, so a double-revoke
    # is a harmless no-op that just refreshes revokedAt.
    eid = encode_entry(agent="a", target="b", outcome="deny", adjudicator="op")
    assert revoke_entry(eid) is True
    # Second revoke still returns True because the row still exists.
    assert revoke_entry(eid) is True
    assert fake_table.items[eid]["revoked"] is True


def test_revoke_then_delete_returns_false_on_second_attempt(
    fake_table: FakeTable,
) -> None:
    # If the underlying row is actually gone (not just revoked), a second
    # revoke against the now-missing id returns False.
    eid = encode_entry(agent="a", target="b", outcome="deny", adjudicator="op")
    fake_table.items.pop(eid)
    assert revoke_entry(eid) is False


def test_revoke_entry_reraises_non_conditional_errors(
    fake_table: FakeTable, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _boom(**kwargs: Any) -> Any:
        raise ClientError(
            {"Error": {"Code": "ProvisionedThroughputExceededException"}},
            "UpdateItem",
        )

    monkeypatch.setattr(fake_table, "update_item", _boom)
    with pytest.raises(ClientError):
        revoke_entry("whatever")


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


def test_round_trip_encode_list_verify(fake_table: FakeTable) -> None:
    eid = encode_entry(
        agent="payments-agent",
        target="fraud-agent",
        outcome="deny",
        adjudicator="op",
        precedence=5,
    )
    # list returns the row.
    listed = list_entries()
    assert any(r["entryId"] == eid for r in listed)

    # verify returns the same shape and matches encode output.
    verified = verify_entry(eid)
    assert verified is not None
    assert verified["entryId"] == eid
    assert verified["pattern"] == {
        "agent": "payments-agent",
        "target": "fraud-agent",
    }
    assert verified["resolution"] == "deny"
    assert verified["precedence"] == 5


# ---------------------------------------------------------------------------
# Env-var handling
# ---------------------------------------------------------------------------


def test_get_table_raises_when_env_var_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CASE_LAW_TABLE", raising=False)
    # Reset the cached resource so we don't accidentally bypass the check.
    monkeypatch.setattr(case_law_admin, "_dynamodb", None)
    with pytest.raises(RuntimeError, match="CASE_LAW_TABLE"):
        case_law_admin._get_table()


def test_main_exits_nonzero_without_env_var(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("CASE_LAW_TABLE", raising=False)
    rc = case_law_admin.main(["list"])
    assert rc == 1
    assert "CASE_LAW_TABLE" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# CLI wrappers (argparse layer) — smoke-check NOT_FOUND / REVOKED strings
# ---------------------------------------------------------------------------


def test_cli_verify_prints_not_found(
    fake_table: FakeTable,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("CASE_LAW_TABLE", "test-table")
    rc = case_law_admin.main(["verify", "--entry-id", "missing"])
    assert rc == 1
    assert capsys.readouterr().out.strip() == "NOT_FOUND"


def test_cli_verify_prints_revoked(
    fake_table: FakeTable,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("CASE_LAW_TABLE", "test-table")
    eid = encode_entry(agent="a", target="b", outcome="deny", adjudicator="op")
    revoke_entry(eid)
    rc = case_law_admin.main(["verify", "--entry-id", eid])
    assert rc == 1
    assert capsys.readouterr().out.strip() == "REVOKED"


def test_cli_revoke_prints_revoked_line(
    fake_table: FakeTable,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("CASE_LAW_TABLE", "test-table")
    eid = encode_entry(agent="a", target="b", outcome="deny", adjudicator="op")
    rc = case_law_admin.main(["revoke", "--entry-id", eid])
    out = capsys.readouterr().out.strip()
    assert rc == 0
    assert out.startswith("REVOKED ")
    assert eid in out


def test_cli_list_prints_one_row_per_line(
    fake_table: FakeTable,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("CASE_LAW_TABLE", "test-table")
    eid = encode_entry(agent="a", target="b", outcome="deny", adjudicator="op")
    rc = case_law_admin.main(["list"])
    out = capsys.readouterr().out
    assert rc == 0
    lines = [line for line in out.strip().splitlines() if line]
    assert len(lines) == 1
    assert eid in lines[0]
    assert " | " in lines[0]


def test_cli_encode_bad_scope_json_exits_2(
    fake_table: FakeTable,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("CASE_LAW_TABLE", "test-table")
    rc = case_law_admin.main(
        [
            "encode",
            "--agent", "a",
            "--target", "b",
            "--outcome", "deny",
            "--adjudicator", "op",
            "--scope-json", "{not valid json",
        ]
    )
    assert rc == 2
    assert "scope-json" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Hypothesis property test: encode → verify round-trips pattern + resolution.
# ---------------------------------------------------------------------------


_identifier = st.text(
    alphabet=st.characters(
        whitelist_categories=("Ll", "Lu", "Nd"),
        whitelist_characters="-_",
    ),
    min_size=1,
    max_size=20,
)
_outcome = st.sampled_from(["permit", "deny", "escalate", "halt"])


@given(
    agent=_identifier,
    target=_identifier,
    outcome=_outcome,
    adjudicator=_identifier,
)
@settings(max_examples=200, deadline=None)
def test_property_encode_verify_round_trip(
    agent: str, target: str, outcome: str, adjudicator: str
) -> None:
    """For any valid (agent, target, outcome, adjudicator), encoding then
    verifying must return a row whose pattern and resolution match the
    arguments exactly.

    A fresh FakeTable is built per example so the property is evaluated
    in isolation (no cross-contamination between hypothesis draws).
    """
    table = FakeTable()
    with patch.object(case_law_admin, "_get_table", return_value=table):
        entry_id = encode_entry(
            agent=agent,
            target=target,
            outcome=outcome,
            adjudicator=adjudicator,
        )
        row = verify_entry(entry_id)

    assert row is not None
    assert row["pattern"] == {"agent": agent, "target": target}
    assert row["resolution"] == outcome
    assert row["createdBy"] == adjudicator
    assert row["revoked"] is False


# ---------------------------------------------------------------------------
# Engine-integration test: case-law hit fires BEFORE the 8-step pipeline.
#
# We encode a case-law row via the CLI helper, feed it into
# GovernanceEngine with empty constitutional_layers, and assert the first
# finding's reason is the case-law branch (``case_law:<entryId>``) rather
# than a covering-unit ``scope_match:`` or a residual-authority deny.
# ---------------------------------------------------------------------------


def test_engine_case_law_fires_before_covering_unit_pipeline(
    fake_table: FakeTable,
) -> None:
    # Encode a PERMIT row via the CLI — this is the source-of-truth for the
    # pattern shape we're testing.
    entry_id = encode_entry(
        agent="requester",
        target="fraud-agent",
        outcome="permit",
        adjudicator="operator",
        precedence=100,
    )
    ddb_row = fake_table.items[entry_id]

    # Build a DispatchRequest that carries the pattern keys in its context
    # so the engine's ``_matches_pattern`` fallback
    # (``request.context.get(key)``) can satisfy the match. The CLI writes
    # patterns keyed by ``agent`` / ``target`` per spec; the engine reads
    # pattern keys off request attrs first, then context.
    request = DispatchRequest(
        requesting_agent_id="requester",
        target_agent_id="fraud-agent",
        action_type="invoke_agent",
        domain="payment",
        workflow_id="wf-1",
        agent_use_id="use-1",
        context={"agent": "requester", "target": "fraud-agent"},
    )

    # Translate the CDK row into the CaseLawEntry shape via the hierarchy
    # loader's deserialiser — this exercises the US-ARB-013 field-name
    # reconciliation end-to-end.
    from arbiter.governance.hierarchy import _case_law_from_item

    entry = _case_law_from_item(ddb_row)
    assert entry is not None, "Encoded row must round-trip through the loader"

    engine = GovernanceEngine(
        authority_units=[],  # NO covering units — residual-deny would fire
        composition_contracts=[],
        case_law=[entry],
        constitutional_layers=[],
    )
    finding = engine.evaluate(request)

    # Case-law hit must fire first. If the 8-step pipeline were evaluated
    # instead, the reason would be "residual_authority_denial:..." because
    # no authority unit covers the request.
    assert finding.decision == ArbitrationDecision.PERMIT
    assert finding.reason == f"case_law:{entry_id}"
    assert not finding.residual_authority_denial


def test_engine_revoked_case_law_is_dropped_at_load_time(
    fake_table: FakeTable,
) -> None:
    """A revoked row must never reach the engine — the loader filters it."""
    entry_id = encode_entry(
        agent="requester",
        target="fraud-agent",
        outcome="permit",
        adjudicator="operator",
        precedence=100,
    )
    revoke_entry(entry_id)
    ddb_row = fake_table.items[entry_id]

    from arbiter.governance.hierarchy import _case_law_from_item

    entry = _case_law_from_item(ddb_row)
    assert entry is None
