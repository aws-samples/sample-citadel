"""Board 2b52a985 (slice-B checker advisory): surface the ALREADY_PENDING
poison-ack as a CloudWatch metric.

Gap this closes: `_route_to_reconcile` (see index.py) is a log-only no-op —
a poisoned/wedged fabrication that redelivers while a prior claim is still
PENDING gets a WARNING log line and an ack, and NEVER reaches
`citadel-fabricator-dlq-${ENV}` (maxReceiveCount is never incremented
because the message is deleted on every ALREADY_PENDING receipt, not
nacked). Today the only trace is the stale PENDING row itself — invisible
unless an operator runs the runbook's manual DynamoDB scan. This is a
metric-based signal on the ack event itself, precedented by
`arbiter/workerWrapper/tools/escalate.py`'s direct `put_metric_data` call
(same boto3 'cloudwatch' client, same lazy-client-cache convention, same
Count/Dimensions shape) — no EMF dependency, no new library.

Design choice (per task instructions, justified here): emit-on-ack (cheap,
fires at the exact poison-consumption moment, zero extra polling/Lambda
cost) rather than a separate stale-PENDING age-scan Lambda. The ack path is
the earliest, cheapest place the fabricator ITSELF knows a poison cycle is
occurring — a scheduled scanner would duplicate the runbook's own query and
add a new Lambda + IAM surface for a signal this call site already has for
free. The stale-age scan remains available manually via the runbook; this
metric is the paging trigger that tells an operator to go run it.

Metric contract (pinned so the CDK alarm math is oracle-validatable):
  Namespace: CitadelArbiter
  MetricName: FabricatorStalePendingClaim
  Unit: Count, Value: 1
  Dimensions: [{Name: Consumer, Value: 'fabricator'}]
No per-messageId dimension (unbounded cardinality) — mirrors the existing
cardinality rule in arbiter/common/metrics_constants.py.
"""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("IDEMPOTENCY_TABLE", "citadel-idempotency-test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

import index  # noqa: E402


class TestStalePendingMetric:
    def test_route_to_reconcile_emits_stale_pending_metric(self):
        """RED: _route_to_reconcile must emit exactly one CloudWatch
        PutMetricData call with the pinned namespace/name/dimension so the
        poison-ack is observable without an operator running the manual
        DynamoDB scan first."""
        fake_cw = MagicMock()
        with patch("index._cloudwatch", return_value=fake_cw):
            index._route_to_reconcile("msg-stale-1")

        fake_cw.put_metric_data.assert_called_once()
        _, kwargs = fake_cw.put_metric_data.call_args
        assert kwargs["Namespace"] == "CitadelArbiter"
        datum = kwargs["MetricData"][0]
        assert datum["MetricName"] == "FabricatorStalePendingClaim"
        assert datum["Value"] == 1
        assert datum["Unit"] == "Count"
        assert datum["Dimensions"] == [{"Name": "Consumer", "Value": "fabricator"}]

    def test_metric_emission_failure_never_breaks_the_ack_path(self):
        """A CloudWatch outage must not turn the (deliberately fail-open)
        reconcile no-op into a raise — that would nack the SQS message and
        change existing ack behavior, which is out of scope for this
        additive change."""
        fake_cw = MagicMock()
        fake_cw.put_metric_data.side_effect = RuntimeError("cloudwatch down")
        with patch("index._cloudwatch", return_value=fake_cw):
            index._route_to_reconcile("msg-stale-2")  # must not raise

    def test_lambda_handler_already_pending_path_emits_metric_via_reconcile(self):
        """Composed check: the lambda_handler ALREADY_PENDING branch still
        calls _route_to_reconcile (which is what emits the metric) and does
        not call process_event."""
        import json

        event = {
            "Records": [
                {
                    "messageId": "msg-composed-1",
                    "body": json.dumps(
                        {"agent_input": {"taskDetails": "x"}, "orchestration_id": "0"}
                    ),
                }
            ]
        }
        with patch("index._claim_message_id", return_value="ALREADY_PENDING"), \
                patch("index.process_event") as process_event, \
                patch("index._route_to_reconcile") as reconcile:
            index.lambda_handler(event, {})

        reconcile.assert_called_once_with("msg-composed-1")
        process_event.assert_not_called()
