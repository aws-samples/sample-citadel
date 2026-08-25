"""Executor-level failure-taxonomy tests (board task 9099b8cb).

The unified taxonomy is AUTHORITATIVE over a stored workflow's per-node
``retryableErrors`` (decision 843a959e): a definition may NARROW retries but
can never WIDEN a never-retry class. And when a stale/tampered list tries to
widen a SETTLED denial (policy-denied / authz), the executor files exactly ONE
governance-smell signal (storm-proof by construction) then goes terminal.

These run the REAL ``handle_node_failure`` against moto so the terminal-failure
UpdateItem is exercised for real (the FakeTable stand-ins do not validate it).
"""
import json
import os
import sys

import boto3
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

try:
    from moto import mock_aws
except ImportError:  # pragma: no cover
    pytest.skip("moto not installed", allow_module_level=True)

import executor  # noqa: E402
from common.failure_taxonomy import POLICY_DENIED_CLASS  # noqa: E402
from common.metrics_constants import METRIC_RETRY_GOVERNANCE_SMELL  # noqa: E402

EXEC_TABLE = "citadel-executions-tax-moto"
WF_TABLE = "citadel-workflows-tax-moto"


@pytest.fixture
def moto_executor(monkeypatch):
    with mock_aws():
        resource = boto3.Session(region_name="us-east-1").resource("dynamodb")
        exec_table = resource.create_table(
            TableName=EXEC_TABLE,
            KeySchema=[{"AttributeName": "executionId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "executionId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        wf_table = resource.create_table(
            TableName=WF_TABLE,
            KeySchema=[{"AttributeName": "workflowId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "workflowId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        monkeypatch.setattr(executor, "_executions_table", exec_table)
        monkeypatch.setattr(executor, "_workflows_table", wf_table)
        yield {"exec_table": exec_table, "wf_table": wf_table}


def _seed(exec_table, wf_table, *, retryable_errors, max_retries=3):
    wf_table.put_item(
        Item={
            "workflowId": "wf1",
            "definition": json.dumps({
                "nodes": [{
                    "id": "node1",
                    "data": {"retryPolicy": {
                        "maxRetries": max_retries,
                        "retryableErrors": retryable_errors,
                    }},
                }],
                "edges": [],
            }),
        }
    )
    exec_table.put_item(
        Item={
            "executionId": "exec1",
            "workflowId": "wf1",
            "status": "running",
            "nodeResults": {"node1": {"status": "running", "agentId": "agentA", "retryCount": 0}},
        }
    )


def _node_status(exec_table):
    row = exec_table.get_item(Key={"executionId": "exec1"}).get("Item", {})
    return row["nodeResults"]["node1"]["status"], row.get("status")


@pytest.fixture
def capture(monkeypatch):
    metrics = []
    retries = []
    monkeypatch.setattr(
        executor, "_emit_metric",
        lambda name, value, unit, **k: metrics.append((name, value)),
    )
    monkeypatch.setattr(
        executor.events, "publish_node_retrying",
        lambda **k: retries.append(k),
    )
    return {"metrics": metrics, "retries": retries}


class TestPerNodeListCannotWidenNeverRetryClass:
    @pytest.mark.parametrize("never_class", [
        "AccessDeniedException",       # authz
        "ValidationException",         # validation
        POLICY_DENIED_CLASS,           # policy-denied
        "OutcomeIndeterminateError",   # indeterminate
        "ApprovalRequiredError",       # approval-absent (retry-after-human)
    ])
    def test_never_retry_class_in_list_does_not_enable_retry(
        self, moto_executor, capture, never_class
    ):
        # A per-node retryableErrors entry naming a never-retry class must NOT
        # enable a retry — the taxonomy vetoes it (843a959e).
        _seed(moto_executor["exec_table"], moto_executor["wf_table"],
              retryable_errors=[never_class])

        executor.handle_node_failure("exec1", "node1", never_class)

        node_status, exec_status = _node_status(moto_executor["exec_table"])
        assert node_status == "failed"       # terminal, not retried
        assert exec_status == "failed"
        assert capture["retries"] == []      # no node.retrying published

    def test_unknown_error_still_honours_author_list(self):
        # Narrow-only, proved at the pure retry gate (avoids the retry-branch's
        # unrelated moto Decimal-retryCount path): an UNRECOGNISED error the
        # taxonomy has no opinion on is still governed by the author's list,
        # while a recognised never-retry class is vetoed regardless of the list.
        from retry import should_retry
        assert should_retry("TimeoutError", ["TimeoutError"], 0, 3) is True
        assert should_retry("AccessDeniedException", ["AccessDeniedException"], 0, 3) is False
        assert should_retry(POLICY_DENIED_CLASS, [POLICY_DENIED_CLASS], 0, 3) is False
        # An auto-retryable class still requires the author opt-in (narrow):
        assert should_retry("ThrottlingException", [], 0, 3) is False
        assert should_retry("ThrottlingException", ["ThrottlingException"], 0, 3) is True


class TestGovernanceSmellNoStorm:
    def test_widening_a_denial_files_exactly_one_smell_then_terminal(
        self, moto_executor, capture
    ):
        # A stale list listing a settled DENY class: the retry is refused AND a
        # single governance-smell signal is filed.
        _seed(moto_executor["exec_table"], moto_executor["wf_table"],
              retryable_errors=[POLICY_DENIED_CLASS])

        executor.handle_node_failure("exec1", "node1", POLICY_DENIED_CLASS)

        smells = [m for m in capture["metrics"] if m[0] == METRIC_RETRY_GOVERNANCE_SMELL]
        assert smells == [(METRIC_RETRY_GOVERNANCE_SMELL, 1.0)]  # exactly one
        assert _node_status(moto_executor["exec_table"])[0] == "failed"

    def test_duplicate_delivery_does_not_storm(self, moto_executor, capture):
        # A duplicate node-failed delivery (at-least-once) must NOT re-file the
        # smell: the terminal-status idempotency guard returns early.
        _seed(moto_executor["exec_table"], moto_executor["wf_table"],
              retryable_errors=["authz"])

        executor.handle_node_failure("exec1", "node1", "authz")
        executor.handle_node_failure("exec1", "node1", "authz")  # replay

        smells = [m for m in capture["metrics"] if m[0] == METRIC_RETRY_GOVERNANCE_SMELL]
        assert len(smells) == 1  # no storm across the duplicate delivery

    def test_non_smell_never_class_files_no_smell(self, moto_executor, capture):
        # validation / indeterminate / approval-absent are never-retry but NOT
        # governance smells — no smell metric, just terminal.
        _seed(moto_executor["exec_table"], moto_executor["wf_table"],
              retryable_errors=["ValidationException"])

        executor.handle_node_failure("exec1", "node1", "ValidationException")

        smells = [m for m in capture["metrics"] if m[0] == METRIC_RETRY_GOVERNANCE_SMELL]
        assert smells == []
        assert _node_status(moto_executor["exec_table"])[0] == "failed"
