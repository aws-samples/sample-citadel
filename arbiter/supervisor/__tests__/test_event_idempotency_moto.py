"""Slice B (CIT-125) COMPOSED dedupe proof — supervisor, real DDB engine.

The sibling ``test_event_idempotency.py`` proves the handler wiring and the
claim helper SEPARATELY, with ``unittest.mock`` standing in for DynamoDB.
That leaves the composed path — the REAL ``handler`` calling the REAL
``_claim_event_id`` whose ``put_item``/``ConditionExpression`` is evaluated
by a REAL DynamoDB engine — unlocked-in. This suite closes that gap using
moto (the slice-B verification's P1–P5 proof set, re-derived here as a
permanent regression suite; pattern per
``workerWrapper/__tests__/test_tool_call_write_paths_e2e_moto.py``).

REAL vs STUBBED (explicit)
--------------------------
* REAL, against moto: ``handler``'s dedupe guard, ``_claim_event_id``'s
  conditional PutItem (moto enforces ``attribute_not_exists`` semantics,
  attribute typing, and raises genuine ``ConditionalCheckFailedException``
  / ``ResourceNotFoundException`` ClientErrors), the claim-row contents,
  and the idempotency table itself (schema verbatim from
  backend/lib/backend-stack.ts IdempotencyTable: PK ``eventId`` (S),
  PAY_PER_REQUEST, TTL attribute ``ttl``).
* STUBBED: ``orchestrate`` ONLY — replaced with a counting MagicMock so
  dispatch multiplicity is observable without running the LLM
  orchestration loop. Nothing between the handler entry and the
  ``orchestrate(...)`` call site is faked.

conftest note: ``arbiter/conftest.py`` swaps ``boto3.client`` /
``boto3.resource`` for MagicMock factories for the whole suite, so this
module's import-time ``dynamodb = boto3.resource('dynamodb')`` global is a
mock. Inside ``mock_aws`` the fixture rebinds ``index.dynamodb`` to a real
``boto3.Session``-backed resource (``boto3.Session`` is NOT stubbed), so
``_idempotency_table()`` reaches moto.
"""

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

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orchestration-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-state-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-config-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("IDEMPOTENCY_TABLE", "citadel-idempotency-test")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

import index  # noqa: E402

REGION = "us-east-1"
TABLE = "citadel-idempotency-moto"
SEVEN_DAYS = 7 * 24 * 60 * 60  # design B.1 TTL


def _task_request(event_id: str | None) -> dict:
    """A minimal EventBridge task.request envelope (id optional)."""
    event = {
        "source": "task.request",
        "detail-type": "System-Task",
        "detail": {"task": "compose a plan", "appId": "app-1"},
    }
    if event_id is not None:
        event["id"] = event_id
    return event


@pytest.fixture
def composed(monkeypatch):
    """Real idempotency table in moto + real claim path; orchestrate counted."""
    with mock_aws():
        resource = boto3.Session(region_name=REGION).resource("dynamodb")
        # Schema verbatim from backend/lib/backend-stack.ts IdempotencyTable
        # (PK eventId (S); TTL attr `ttl` is data, not schema).
        resource.create_table(
            TableName=TABLE,
            KeySchema=[{"AttributeName": "eventId", "KeyType": "HASH"}],
            AttributeDefinitions=[{"AttributeName": "eventId", "AttributeType": "S"}],
            BillingMode="PAY_PER_REQUEST",
        )
        # Rebind the module's import-time globals: the conftest-mocked
        # `dynamodb` resource -> real moto-backed resource; table name ->
        # the moto table. monkeypatch restores both after the test.
        monkeypatch.setattr(index, "dynamodb", resource)
        monkeypatch.setattr(index, "IDEMPOTENCY_TABLE", TABLE)
        orchestrate = MagicMock(name="orchestrate")
        monkeypatch.setattr(index, "orchestrate", orchestrate)
        yield resource.Table(TABLE), orchestrate


def test_p1_duplicate_event_id_dispatches_exactly_once(composed):
    """Same event.id delivered twice -> orchestrate() called EXACTLY once."""
    _table, orchestrate = composed
    index.handler(_task_request("evt-P1"), {})
    index.handler(_task_request("evt-P1"), {})
    assert orchestrate.call_count == 1


def test_p2_distinct_event_ids_are_each_processed(composed):
    """No false dedupe: two distinct ids -> two dispatches."""
    _table, orchestrate = composed
    index.handler(_task_request("evt-P2-a"), {})
    index.handler(_task_request("evt-P2-b"), {})
    assert orchestrate.call_count == 2


def test_p3_claim_row_keyed_on_literal_event_id_with_design_ttl(composed):
    """Row uses the LITERAL event.id (not a hash), consumer tag, 7d TTL."""
    table, _orchestrate = composed
    before = int(time.time())
    index.handler(_task_request("evt-P3"), {})
    item = table.get_item(Key={"eventId": "evt-P3"}).get("Item")
    assert item is not None, "claim row must exist under the literal event.id"
    assert item["consumer"] == "supervisor"
    assert int(item["ttl"]) - int(item["claimedAt"]) == SEVEN_DAYS
    assert before <= int(item["claimedAt"]) <= int(time.time())


def test_p4_poison_redrive_lifecycle(composed):
    """Poison propagates; a same-id redrive stays a no-op (claim survives,
    NEEDS-RECONCILE-FIRST per design B.1); after an operator row-clean the
    redrive processes exactly once (the DLQ_REDRIVE runbook path)."""
    table, orchestrate = composed
    # (a) poison AFTER the claim: error must propagate (EB retry/DLQ
    # semantics preserved — never silently acked)...
    orchestrate.side_effect = RuntimeError("poison: downstream blew up")
    with pytest.raises(RuntimeError):
        index.handler(_task_request("evt-P4"), {})
    # ...and the claim row survives the failure.
    assert table.get_item(Key={"eventId": "evt-P4"}).get("Item") is not None
    # (b) handler fixed; a redrive of the SAME envelope is still a no-op —
    # the claim outlives the failure, so supervisor redrive is
    # reconcile-first, exactly as the runbook documents.
    orchestrate.side_effect = None
    orchestrate.reset_mock()
    index.handler(_task_request("evt-P4"), {})
    assert orchestrate.call_count == 0
    # (c) operator clears the row (runbook reconcile step) -> redrive
    # processes exactly once.
    table.delete_item(Key={"eventId": "evt-P4"})
    index.handler(_task_request("evt-P4"), {})
    assert orchestrate.call_count == 1


def test_p5_fail_closed_on_dedupe_store_error(composed, monkeypatch):
    """A REAL non-conditional ClientError from the engine (table missing ->
    ResourceNotFoundException) must propagate and block dispatch: the event
    redelivers/DLQs rather than being silently acked or double-run."""
    _table, orchestrate = composed
    monkeypatch.setattr(index, "IDEMPOTENCY_TABLE", "citadel-idempotency-absent")
    with pytest.raises(ClientError) as excinfo:
        index.handler(_task_request("evt-P5"), {})
    assert (
        excinfo.value.response["Error"]["Code"] != "ConditionalCheckFailedException"
    )
    assert orchestrate.call_count == 0


def test_fail_open_without_event_id_writes_no_claim_row(composed):
    """Documented fail-open: an envelope with no `id` is processed WITHOUT
    dedupe and leaves no claim row (never silently drop work)."""
    table, orchestrate = composed
    index.handler(_task_request(None), {})
    assert orchestrate.call_count == 1
    assert table.scan()["Count"] == 0
