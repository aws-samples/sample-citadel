"""Slice B (CIT-125) COMPOSED dedupe proof — fabricator, real DDB engine.

The sibling ``test_event_idempotency.py`` proves the two-phase claim logic
and the handler wiring SEPARATELY with ``unittest.mock``. This suite locks
in the COMPOSED path — the REAL ``lambda_handler`` driving the REAL
``_claim_message_id`` / ``_complete_message_id`` whose conditional PutItem
and UpdateItem are evaluated by a REAL DynamoDB engine (moto) — as a
permanent regression suite (the slice-B verification's F1–F6 proof set;
pattern per ``workerWrapper/__tests__/test_tool_call_write_paths_e2e_moto.py``).

Dedupe key: the SQS ``messageId`` (disclosed deviation from design B.1's
``event.id`` — the fabricator queue's producers send hand-built JSON bodies
with no EventBridge envelope; see the sibling suite's module docstring for
the full verification). ``messageId`` is stable across at-least-once SQS
redelivery AND across a DLQ redrive, so the composed proofs below model a
redrive as re-delivering the SAME record.

REAL vs STUBBED (explicit)
--------------------------
* REAL, against moto: ``lambda_handler``'s two-phase guard,
  ``_claim_message_id`` (conditional PutItem + get_item fallback),
  ``_complete_message_id`` (UpdateExpression with the reserved-word-safe
  ``#status`` alias — exactly the class of wire defect moto catches and a
  dict-backed fake cannot), the claim rows, and the idempotency table
  (schema verbatim from backend/lib/backend-stack.ts IdempotencyTable:
  PK ``eventId`` (S), PAY_PER_REQUEST).
* STUBBED: ``process_event`` ONLY — a counting MagicMock so fabrication
  multiplicity is observable without running the fabrication body.

conftest note: ``arbiter/conftest.py`` swaps ``boto3.client`` /
``boto3.resource`` for MagicMock factories. The fabricator's
``_idempotency_table()`` lazily does ``import boto3; boto3.resource(...)``
per call, so inside ``mock_aws`` the fixture restores ``boto3.resource`` to
a real ``boto3.Session``-backed callable (``boto3.Session`` is NOT stubbed)
— the real helper body then reaches moto, not a mock.
"""

import json
import os
import sys
import time
from unittest.mock import MagicMock

import boto3
import pytest
from botocore.exceptions import ClientError

try:
    from moto import mock_aws
except ImportError:  # pragma: no cover
    pytest.skip("moto not installed", allow_module_level=True)

# The fabricator's index.py imports `strands` at module level, so the
# `import index` below errors at collection time in environments without
# the strands SDK. Skip (don't error) there; the suite still EXECUTES
# wherever strands is installed — CI's arbiter jobs `pip install
# strands-agents` (see .github/workflows/ci.yml), and local runs use the
# pinned .venv-check.
pytest.importorskip(
    "strands", reason="CI installs strands-agents; local runs use .venv-check"
)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("IDEMPOTENCY_TABLE", "citadel-idempotency-test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

import index  # noqa: E402

REGION = "us-east-1"
TABLE = "citadel-idempotency-moto"
SEVEN_DAYS = 7 * 24 * 60 * 60  # design B.1 TTL


def _sqs_event(*message_ids: str) -> dict:
    """An SQS batch event with one record per message id."""
    return {
        "Records": [
            {
                "messageId": mid,
                "body": json.dumps(
                    {"agent_input": {"taskDetails": f"fabricate {mid}"}}
                ),
                "messageAttributes": {},
            }
            for mid in message_ids
        ]
    }


@pytest.fixture
def composed(monkeypatch):
    """Real idempotency table in moto + real two-phase claim path;
    process_event counted."""
    with mock_aws():
        # Restore the REAL boto3.resource factory (conftest stubbed it) so
        # the fabricator's lazy per-call `boto3.resource('dynamodb')` in
        # _idempotency_table() reaches moto.
        monkeypatch.setattr(
            boto3,
            "resource",
            lambda *a, **k: boto3.Session(region_name=REGION).resource(*a, **k),
        )
        resource = boto3.Session(region_name=REGION).resource("dynamodb")
        # Schema verbatim from backend/lib/backend-stack.ts IdempotencyTable.
        resource.create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "eventId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "eventId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        monkeypatch.setattr(index, "IDEMPOTENCY_TABLE", TABLE)
        process_event = MagicMock(name="process_event")
        monkeypatch.setattr(index, "process_event", process_event)
        yield resource.Table(TABLE), process_event


def test_f1_first_delivery_fabricates_once_and_promotes_pending_to_done(composed):
    """First sight: process_event runs once; row lands as DONE (the PENDING
    claim written before the body is promoted after it succeeds)."""
    table, process_event = composed
    index.lambda_handler(_sqs_event("msg-F1"), {})
    assert process_event.call_count == 1
    item = table.get_item(Key={"eventId": "msg-F1"}).get("Item")
    assert item is not None
    assert item["status"] == "DONE"


def test_f2_redrive_of_done_message_is_a_noop(composed):
    """A DLQ redrive re-delivering a completed messageId must NOT
    re-fabricate — the documented historical duplicate-fabrication failure."""
    table, process_event = composed
    index.lambda_handler(_sqs_event("msg-F2"), {})
    assert table.get_item(Key={"eventId": "msg-F2"})["Item"]["status"] == "DONE"
    process_event.reset_mock()
    index.lambda_handler(_sqs_event("msg-F2"), {})
    assert process_event.call_count == 0


def test_f3_claim_row_keyed_on_literal_message_id_with_design_ttl(composed):
    """Row uses the LITERAL SQS messageId, consumer tag, 7d TTL."""
    table, _process_event = composed
    before = int(time.time())
    index.lambda_handler(_sqs_event("msg-F3"), {})
    item = table.get_item(Key={"eventId": "msg-F3"}).get("Item")
    assert item is not None, "claim row must exist under the literal messageId"
    assert item["consumer"] == "fabricator"
    assert int(item["ttl"]) - int(item["claimedAt"]) == SEVEN_DAYS
    assert before <= int(item["claimedAt"]) <= int(time.time())


def test_f4_poison_pending_reconcile_lifecycle(composed, caplog):
    """(a) poison raises and the row stays PENDING (never falsely DONE);
    (b) a redrive while PENDING routes to reconcile WITHOUT re-entering the
    fabrication body; (c) after an operator row-clean the redrive
    fabricates exactly once and promotes to DONE (runbook path)."""
    table, process_event = composed
    # (a) poison AFTER the claim: propagate (SQS retry/DLQ semantics),
    # row must remain PENDING — a failed fabrication is never marked DONE.
    process_event.side_effect = RuntimeError("poison: fabrication blew up")
    with pytest.raises(RuntimeError):
        index.lambda_handler(_sqs_event("msg-F4"), {})
    assert table.get_item(Key={"eventId": "msg-F4"})["Item"]["status"] == "PENDING"
    # (b) fixed handler; redrive of the SAME messageId sees PENDING ->
    # reconcile route, fabrication body NOT re-entered.
    process_event.side_effect = None
    process_event.reset_mock()
    with caplog.at_level("WARNING"):
        index.lambda_handler(_sqs_event("msg-F4"), {})
    assert process_event.call_count == 0
    assert any(
        "PENDING" in rec.getMessage() and "msg-F4" in rec.getMessage()
        for rec in caplog.records
    ), "reconcile routing must be observable in the WARNING log"
    assert table.get_item(Key={"eventId": "msg-F4"})["Item"]["status"] == "PENDING"
    # (c) operator clears the row (DLQ_REDRIVE runbook reconcile step) ->
    # redrive fabricates exactly once and completes.
    table.delete_item(Key={"eventId": "msg-F4"})
    index.lambda_handler(_sqs_event("msg-F4"), {})
    assert process_event.call_count == 1
    assert table.get_item(Key={"eventId": "msg-F4"})["Item"]["status"] == "DONE"


def test_f5_distinct_message_ids_in_one_batch_each_fabricate(composed):
    """No false dedupe across a batch: two distinct messageIds -> two
    fabrications, both promoted to DONE."""
    table, process_event = composed
    index.lambda_handler(_sqs_event("msg-F5-a", "msg-F5-b"), {})
    assert process_event.call_count == 2
    for mid in ("msg-F5-a", "msg-F5-b"):
        assert table.get_item(Key={"eventId": mid})["Item"]["status"] == "DONE"


def test_f6_fail_closed_on_dedupe_store_error(composed, monkeypatch):
    """A REAL non-conditional ClientError (table missing ->
    ResourceNotFoundException) propagates and blocks fabrication: the
    message redelivers/DLQs rather than being silently acked."""
    _table, process_event = composed
    monkeypatch.setattr(index, "IDEMPOTENCY_TABLE", "citadel-idempotency-absent")
    with pytest.raises(ClientError) as excinfo:
        index.lambda_handler(_sqs_event("msg-F6"), {})
    assert (
        excinfo.value.response["Error"]["Code"] != "ConditionalCheckFailedException"
    )
    assert process_event.call_count == 0
