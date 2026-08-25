"""moto-backed contract tests for approval-required tool gating (finding
c947aa77) — the DynamoDB wire contract for the new ``tool-approval`` /
``tool-approval-consumption`` rows in GOVERNANCE_LEDGER_TABLE.

Follows the ``test_tool_call_write_paths_e2e_moto.py`` / ``deployment-contract-
moto-audit`` precedent: REAL boto3 against moto, the REAL CDK key schema
(PK findingId, sole key), raw low-level reads to assert stored attribute TYPES.
This is where the store's atomic single-use, int-timestamp (finding 96d24639),
and GetItem-not-Query lookup are proven against a real client — the seam tests
in ``test_tool_approval_gating.py`` stub the store.
"""
from __future__ import annotations

import decimal
import os
import sys
import time

import boto3
import pytest

try:
    from moto import mock_aws
except ImportError:  # pragma: no cover
    pytest.skip("moto not installed", allow_module_level=True)

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

REGION = "us-east-1"
GOV_TABLE = "citadel-governance-ledger-moto"

_ORG = "orgA"
_WFDEF = "wf-def-1"
_NODE = "node-1"
_TOOL = "gated_tool"


def _make_gov_table(resource):
    # Verbatim from backend/lib/arbiter-stack.ts GovernanceLedgerTable:
    # PK findingId(S) — SOLE key (a deterministic-id lookup is a GetItem) —
    # + workflow-index GSI, ttl attribute "ttl".
    resource.create_table(
        TableName=GOV_TABLE,
        KeySchema=[{"AttributeName": "findingId", "KeyType": "HASH"}],
        AttributeDefinitions=[
            {"AttributeName": "findingId", "AttributeType": "S"},
            {"AttributeName": "workflowId", "AttributeType": "S"},
            {"AttributeName": "timestamp", "AttributeType": "N"},
        ],
        GlobalSecondaryIndexes=[
            {
                "IndexName": "workflow-index",
                "KeySchema": [
                    {"AttributeName": "workflowId", "KeyType": "HASH"},
                    {"AttributeName": "timestamp", "KeyType": "RANGE"},
                ],
                "Projection": {"ProjectionType": "ALL"},
            }
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@pytest.fixture
def moto_gov(monkeypatch):
    with mock_aws():
        monkeypatch.setattr(
            boto3, "resource", lambda *a, **k: boto3.Session(region_name=REGION).resource(*a, **k)
        )
        monkeypatch.setattr(
            boto3, "client", lambda *a, **k: boto3.Session(region_name=REGION).client(*a, **k)
        )
        resource = boto3.Session(region_name=REGION).resource("dynamodb")
        _make_gov_table(resource)
        monkeypatch.setenv("GOVERNANCE_LEDGER_TABLE", GOV_TABLE)

        from arbiter.governance import tool_approval

        tool_approval.__reset_approval_client_for_test()
        monkeypatch.setattr(tool_approval, "_get_dynamodb_resource", lambda: resource)
        try:
            yield {"resource": resource, "tool_approval": tool_approval}
        finally:
            tool_approval.__reset_approval_client_for_test()


def _raw(table, finding_id):
    client = boto3.Session(region_name=REGION).client("dynamodb")
    return client.get_item(TableName=table, Key={"findingId": {"S": finding_id}}).get("Item")


def _seed_grant(resource, *, expires_at):
    from arbiter.governance import tool_approval as ta
    fid = ta.grant_finding_id(_ORG, _WFDEF, _NODE, _TOOL)
    resource.Table(GOV_TABLE).put_item(Item={
        "findingId": fid,
        "workflowId": _WFDEF,
        "timestamp": decimal.Decimal(int(time.time())),
        "category": ta.APPROVAL_GRANT_CATEGORY,
        "orgId": _ORG, "workflowDefinitionId": _WFDEF, "nodeId": _NODE, "toolName": _TOOL,
        "decidedBy": "alice",
        "expiresAt": expires_at,
        "ttl": int(time.time()) + 90 * 86400,
    })
    return fid


# ===========================================================================
# 1. GetItem lookup (NOT a Query) round-trips a valid grant
# ===========================================================================
class TestGrantReadGetItem:
    def test_read_grant_getitem_and_valid(self, moto_gov):
        ta = moto_gov["tool_approval"]
        _seed_grant(moto_gov["resource"], expires_at=int(time.time()) + 3600)
        grant = ta.read_grant(_ORG, _WFDEF, _NODE, _TOOL)
        assert grant is not None
        assert ta.grant_is_valid(grant, _ORG, _WFDEF, _NODE, _TOOL) is True

    def test_absent_grant_reads_none(self, moto_gov):
        ta = moto_gov["tool_approval"]
        assert ta.read_grant(_ORG, _WFDEF, _NODE, _TOOL) is None

    def test_expired_grant_reads_but_invalid(self, moto_gov):
        ta = moto_gov["tool_approval"]
        _seed_grant(moto_gov["resource"], expires_at=int(time.time()) - 5)
        grant = ta.read_grant(_ORG, _WFDEF, _NODE, _TOOL)
        assert grant is not None                                   # audit row survives (ttl distinct)
        assert ta.grant_is_valid(grant, _ORG, _WFDEF, _NODE, _TOOL) is False


# ===========================================================================
# 2. Atomic single-use: two concurrent consumers, only ONE wins
# ===========================================================================
class TestAtomicSingleUse:
    def test_two_consumers_only_one_wins(self, moto_gov):
        ta = moto_gov["tool_approval"]
        _seed_grant(moto_gov["resource"], expires_at=int(time.time()) + 3600)

        first = ta.consume(_ORG, _WFDEF, _NODE, _TOOL, "exec-A")
        second = ta.consume(_ORG, _WFDEF, _NODE, _TOOL, "exec-B")

        assert (first, second) == (True, False)   # single-use exhausted after the winner
        # The single consumption row records the WINNER's execution only.
        marker = ta.read_consumption(_ORG, _WFDEF, _NODE, _TOOL)
        assert marker["consumedByExecutionId"] == "exec-A"

    def test_consumption_id_independent_of_execution(self, moto_gov):
        # The consumption key derives from the grant tuple ONLY (never the
        # executionId) — otherwise two executions would get distinct keys and
        # both "win", breaking single-use.
        ta = moto_gov["tool_approval"]
        _seed_grant(moto_gov["resource"], expires_at=int(time.time()) + 3600)
        assert ta.consume(_ORG, _WFDEF, _NODE, _TOOL, "exec-A") is True
        # A DIFFERENT execution attempting the same tuple is refused.
        assert ta.consume(_ORG, _WFDEF, _NODE, _TOOL, "exec-Z") is False


# ===========================================================================
# 3. Int-timestamp wire contract (finding 96d24639)
# ===========================================================================
class TestConsumptionIntTimestamps:
    def test_consumption_row_stores_int_consumedat_and_ttl(self, moto_gov):
        ta = moto_gov["tool_approval"]
        _seed_grant(moto_gov["resource"], expires_at=int(time.time()) + 3600)
        assert ta.consume(_ORG, _WFDEF, _NODE, _TOOL, "exec-A") is True

        fid = ta.consumption_finding_id(_ORG, _WFDEF, _NODE, _TOOL)
        row = _raw(GOV_TABLE, fid)
        assert row is not None
        # Stored as DynamoDB Number, and INTEGRAL (a native float would have
        # been rejected pre-boundary; a Decimal with a fraction would fail this).
        assert set(row["consumedAt"].keys()) == {"N"}
        assert set(row["ttl"].keys()) == {"N"}
        assert decimal.Decimal(row["consumedAt"]["N"]) == int(decimal.Decimal(row["consumedAt"]["N"]))
        assert decimal.Decimal(row["ttl"]["N"]) == int(decimal.Decimal(row["ttl"]["N"]))
        assert row["category"]["S"] == ta.APPROVAL_CONSUMPTION_CATEGORY
        # ttl (retention) is well beyond consumedAt (single-use audit survives).
        assert decimal.Decimal(row["ttl"]["N"]) > decimal.Decimal(row["consumedAt"]["N"])


# ===========================================================================
# 4. Fail-loud when the table is unconfigured (unreadable)
# ===========================================================================
class TestFailLoud:
    def test_unset_table_raises_read_error(self, moto_gov, monkeypatch):
        ta = moto_gov["tool_approval"]
        monkeypatch.delenv("GOVERNANCE_LEDGER_TABLE", raising=False)
        with pytest.raises(ta.ApprovalReadError):
            ta.read_grant(_ORG, _WFDEF, _NODE, _TOOL)
        with pytest.raises(ta.ApprovalReadError):
            ta.consume(_ORG, _WFDEF, _NODE, _TOOL, "exec-A")
