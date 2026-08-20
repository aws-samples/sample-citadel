"""Tests for the PR2 oversized-result S3 offload in tool_execution_ledger.

Replaces PR1's deterministic oversize marker: an oversized result is offloaded
to a CMK-encrypted, org/execution-prefixed S3 object so a deduped caller gets
the FULL recorded body (faithful replay). Security condition C3 pieces proven
here: SSE-KMS is requested on write, the object key is org/execution-prefixed,
the stored resultRef is re-checked against the caller's prefix on read
(cross-org refusal), and an oversize result with no bucket fails closed.
"""
from __future__ import annotations

import json
import os
import sys

import pytest
from botocore.exceptions import ClientError

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import tool_execution_ledger as ledger  # noqa: E402
from arbiter.governance.tool_execution_ledger import (  # noqa: E402
    CrossOrgResultRefError,
    LedgerError,
    __reset_ledger_client_for_test,
    execute_idempotent,
    finalize_success,
    reserve,
    _recorded_result,
)
from arbiter.workerWrapper.tool_idempotency import MODE_LEDGER, build_key  # noqa: E402

LEDGER_TABLE = "citadel-tool-execution-ledger-test"
BUCKET = "citadel-tool-results-test"

# Module-level alias: a dunder-prefixed name referenced bare inside a class
# method is name-mangled by Python, so bind a plain name here.
_reset_ledger_client_for_test = __reset_ledger_client_for_test


class _FakeLedgerTable:
    def __init__(self):
        self.store: dict[tuple, dict] = {}

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
        k = (Item[ledger.PK_ATTR], Item[ledger.SK_ATTR])
        if not self._cond_ok(ConditionExpression, self.store.get(k), {}, {}):
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "PutItem")
        self.store[k] = dict(Item)
        return {}

    def get_item(self, Key, **_kw):  # noqa: N803
        item = self.store.get((Key[ledger.PK_ATTR], Key[ledger.SK_ATTR]))
        return {"Item": dict(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression, ConditionExpression=None,  # noqa: N803
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_kw):
        k = (Key[ledger.PK_ATTR], Key[ledger.SK_ATTR])
        existing = self.store.get(k)
        names = ExpressionAttributeNames or {}
        values = ExpressionAttributeValues or {}
        if not self._cond_ok(ConditionExpression, existing, names, values):
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException"}}, "UpdateItem")
        target = dict(existing) if existing else {ledger.PK_ATTR: k[0], ledger.SK_ATTR: k[1]}
        for assignment in UpdateExpression[4:].split(","):
            lhs, rhs = [t.strip() for t in assignment.split("=")]
            attr = names.get(lhs, lhs) if lhs.startswith("#") else lhs
            target[attr] = values[rhs.strip()]
        self.store[k] = target
        return {}


class _FakeResource:
    def __init__(self, table):
        self._t = table

    def Table(self, name):  # noqa: N802
        return self._t


class _FakeS3:
    def __init__(self):
        self.objects: dict[tuple, bytes] = {}
        self.puts: list[dict] = []

    def put_object(self, **kwargs):
        self.puts.append(kwargs)
        self.objects[(kwargs["Bucket"], kwargs["Key"])] = kwargs["Body"]
        return {}

    def get_object(self, Bucket, Key):  # noqa: N803
        body = self.objects.get((Bucket, Key))
        if body is None:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": _Body(body)}


class _Body:
    def __init__(self, data):
        self._data = data

    def read(self):
        return self._data


@pytest.fixture
def offload_env(monkeypatch):
    monkeypatch.setenv("TOOL_EXECUTION_LEDGER_TABLE", LEDGER_TABLE)
    monkeypatch.setenv("TOOL_RESULT_BUCKET", BUCKET)
    monkeypatch.setenv("TOOL_RESULT_KMS_KEY_ID", "arn:aws:kms:region:acct:key/cmk-123")
    # Force everything above 40 bytes to offload.
    monkeypatch.setenv("TOOL_RESULT_MAX_INLINE_BYTES", "40")
    __reset_ledger_client_for_test()
    table = _FakeLedgerTable()
    s3 = _FakeS3()
    monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: _FakeResource(table))
    monkeypatch.setattr(ledger, "_get_s3_client", lambda: s3)
    yield table, s3
    __reset_ledger_client_for_test()


def _big_result():
    return {"status": "success", "payload": "x" * 500}


class TestOffloadRoundTrip:
    def test_oversized_result_offloaded_with_sse_kms_and_org_prefix(self, offload_env):
        table, s3 = offload_env
        pk, sk = build_key("orgA", "exec1", "node1", 0, "bigTool", {"a": 1})
        assert reserve(pk, sk, tool_name="bigTool").outcome.value == "won"
        finalize_success(pk, sk, result=_big_result())

        row = table.store[(pk, sk)]
        assert row.get("resultOffloaded") is True
        assert "result" not in row                       # not stored inline
        ref = row["resultRef"]
        assert ref["bucket"] == BUCKET
        assert ref["key"].startswith("tool-results/orgA/exec1/")   # org/exec prefixed
        # SSE-KMS requested on the write (deny-non-KMS is enforced by the bucket policy).
        put = s3.puts[0]
        assert put["ServerSideEncryption"] == "aws:kms"
        assert put["SSEKMSKeyId"] == "arn:aws:kms:region:acct:key/cmk-123"

    def test_dedupe_returns_full_offloaded_body(self, offload_env):
        table, s3 = offload_env
        calls = {"n": 0}

        def adapter():
            calls["n"] += 1
            return _big_result()

        pk, sk = build_key("orgA", "exec1", "node1", 0, "bigTool", {"a": 1})
        r1 = execute_idempotent(pk=pk, sk=sk, tool_name="bigTool", mode=MODE_LEDGER, run_tool=adapter)
        r2 = execute_idempotent(pk=pk, sk=sk, tool_name="bigTool", mode=MODE_LEDGER, run_tool=adapter)
        assert calls["n"] == 1
        # Faithful replay: the deduped caller gets the FULL body, not a marker.
        assert r1 == _big_result()
        assert r2 == _big_result()
        assert len(r2["payload"]) == 500


class TestCrossOrgResultRefRefused:
    def test_result_ref_outside_caller_prefix_is_refused(self, offload_env):
        table, s3 = offload_env
        # A completed row for orgA/exec1 whose resultRef points at ANOTHER org's
        # object (forged / confused-deputy). The read must refuse, not fetch.
        pk, sk = build_key("orgA", "exec1", "node1", 0, "bigTool", {"a": 1})
        s3.objects[(BUCKET, "tool-results/orgB/exec9/deadbeef.json")] = b'{"secret":"orgB"}'
        row = {
            ledger.PK_ATTR: pk, ledger.SK_ATTR: sk, "status": "completed",
            "resultOffloaded": True,
            "resultRef": {"bucket": BUCKET, "key": "tool-results/orgB/exec9/deadbeef.json"},
        }
        with pytest.raises(CrossOrgResultRefError):
            _recorded_result(row, pk)

    def test_valid_ref_within_prefix_reads(self, offload_env):
        table, s3 = offload_env
        pk, sk = build_key("orgA", "exec1", "node1", 0, "bigTool", {"a": 1})
        key = "tool-results/orgA/exec1/abc.json"
        s3.objects[(BUCKET, key)] = json.dumps({"ok": True}).encode()
        row = {ledger.PK_ATTR: pk, ledger.SK_ATTR: sk, "status": "completed",
               "resultRef": {"bucket": BUCKET, "key": key}}
        assert _recorded_result(row, pk) == {"ok": True}


class TestOffloadFailClosed:
    def test_oversized_without_bucket_fails_closed(self, monkeypatch):
        monkeypatch.setenv("TOOL_EXECUTION_LEDGER_TABLE", LEDGER_TABLE)
        monkeypatch.delenv("TOOL_RESULT_BUCKET", raising=False)
        monkeypatch.setenv("TOOL_RESULT_MAX_INLINE_BYTES", "40")
        _reset_ledger_client_for_test()
        table = _FakeLedgerTable()
        monkeypatch.setattr(ledger, "_get_dynamodb_resource", lambda: _FakeResource(table))
        pk, sk = build_key("orgA", "exec1", "node1", 0, "bigTool", {"a": 1})
        reserve(pk, sk, tool_name="bigTool")
        with pytest.raises(LedgerError):
            finalize_success(pk, sk, result=_big_result())
        _reset_ledger_client_for_test()
