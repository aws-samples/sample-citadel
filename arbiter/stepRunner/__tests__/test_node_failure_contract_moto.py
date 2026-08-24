"""Real-client (moto) CONTRACT test for the step runner's node-failure UpdateItem.

The terminal node-failure branch of ``handle_node_failure`` issues an
``update_item`` that sets BOTH the node status (``nodeResults.<nid>.status``)
and the execution status to 'failed'. A malformed ExpressionAttributeNames on
that call (a declared alias that the expression never references) is rejected by
real DynamoDB with "Value provided in ExpressionAttributeNames unused in
expressions" — which crashed the handler on every retry and stranded the
execution in status=running (Bug B).

The FakeTable-style stand-ins in the other stepRunner tests do not validate
expression/attribute-name consistency, so this defect was invisible to them.
This test runs the REAL update against moto, so an unused-alias (or reserved-
keyword, or attribute-typing) regression on this write fails here.
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

EXEC_TABLE = "citadel-executions-sr-moto"
WF_TABLE = "citadel-workflows-sr-moto"


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
        # Point the executor's module-global tables at the real moto tables.
        monkeypatch.setattr(executor, "_executions_table", exec_table)
        monkeypatch.setattr(executor, "_workflows_table", wf_table)
        yield {"exec_table": exec_table, "wf_table": wf_table}


def _seed(exec_table, wf_table):
    # A single-node workflow whose node has no retry policy (maxRetries=0), so a
    # failure lands directly in the terminal no-retry branch under test.
    wf_table.put_item(
        Item={
            "workflowId": "wf1",
            "definition": json.dumps({"nodes": [{"id": "node1", "data": {}}], "edges": []}),
        }
    )
    exec_table.put_item(
        Item={
            "executionId": "exec1",
            "workflowId": "wf1",
            "status": "running",
            "nodeResults": {"node1": {"status": "running", "agentId": "agentA"}},
        }
    )


class TestNodeFailureUpdatePersists:
    def test_terminal_failure_persists_node_and_execution_status(self, moto_executor):
        exec_table = moto_executor["exec_table"]
        _seed(exec_table, moto_executor["wf_table"])

        # Pre-fix, this raised ValidationException (unused #nstatus alias) and
        # never persisted — the execution stayed 'running'.
        executor.handle_node_failure("exec1", "node1", "BoomError")

        row = exec_table.get_item(Key={"executionId": "exec1"})["Item"]
        assert row["status"] == "failed"  # execution status persisted
        assert row["nodeResults"]["node1"]["status"] == "failed"  # node status persisted
        assert row["nodeResults"]["node1"]["error"] == "BoomError"
        assert "failedAt" in row
