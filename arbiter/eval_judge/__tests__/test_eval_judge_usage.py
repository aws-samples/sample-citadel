"""Tests for eval.usage.captured emission (Phase 2 §2.6).

After every Bedrock converse() call (per requested dimension), the judge
must ALSO emit a `eval.usage.captured` event (source citadel.eval.usage)
carrying the response's token usage, tagged costContext:eval — distinct
from the frozen governance.eval.case.judged emission. Never blocks the
judged emission if the usage event itself fails to construct/emit.
"""
import json
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("MODEL_CONFIG_TABLE", "fake-model-config")
os.environ.setdefault("MODEL_CATALOG_TABLE", "fake-model-catalog")
os.environ.setdefault("REPLAY_BUCKET_PARAM", "/citadel/eval-replay-bucket-test")

import eval_judge.index as ej  # noqa: E402

from test_eval_judge import (  # noqa: E402
    _mock_ddb_resource,
    _mock_s3_client,
    _mock_ssm_client,
    _requested_event,
    _well_formed_verdict_text,
)


class _FakeBedrockClientWithUsage:
    def __init__(self, response_text, usage):
        self._response_text = response_text
        self._usage = usage
        self.calls = []

    def converse(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "output": {"message": {"content": [{"text": self._response_text}]}},
            "usage": self._usage,
        }


def _run_with_usage(usage, dimension="task_success"):
    bedrock = _FakeBedrockClientWithUsage(_well_formed_verdict_text(0.9), usage)
    events_client = MagicMock()
    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()), \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handle_judge_requested(_requested_event(dimension=dimension))
    return events_client


def test_emits_eval_usage_captured_after_judged():
    events_client = _run_with_usage(
        {"inputTokens": 120, "outputTokens": 30, "totalTokens": 150}
    )

    entries = [
        e
        for call in events_client.put_events.call_args_list
        for e in call.kwargs["Entries"]
    ]
    usage_entries = [e for e in entries if e["DetailType"] == "eval.usage.captured"]
    assert len(usage_entries) == 1
    assert usage_entries[0]["Source"] == "citadel.eval.usage"

    detail = json.loads(usage_entries[0]["Detail"])
    assert detail["inputTokens"] == 120
    assert detail["outputTokens"] == 30
    assert detail["orgId"] == "org-1"
    assert detail["correlationId"] == "run-1"


def test_eval_usage_captured_carries_costContext_eval():
    events_client = _run_with_usage({"inputTokens": 10, "outputTokens": 5})
    entries = [
        e
        for call in events_client.put_events.call_args_list
        for e in call.kwargs["Entries"]
    ]
    usage_entries = [e for e in entries if e["DetailType"] == "eval.usage.captured"]
    detail = json.loads(usage_entries[0]["Detail"])
    assert detail["costContext"] == "eval"


def test_judged_event_still_emitted_alongside_usage_event():
    events_client = _run_with_usage({"inputTokens": 10, "outputTokens": 5})
    entries = [
        e
        for call in events_client.put_events.call_args_list
        for e in call.kwargs["Entries"]
    ]
    judged_entries = [
        e for e in entries if e["DetailType"] == "governance.eval.case.judged"
    ]
    assert len(judged_entries) == 1


def test_missing_usage_in_bedrock_response_does_not_crash():
    """A converse() response with no `usage` key (e.g. an older/mocked
    shape) must never crash the judge — the usage event is simply
    skipped, and the judged event still emits."""
    bedrock = MagicMock()
    bedrock.converse.return_value = {
        "output": {"message": {"content": [{"text": _well_formed_verdict_text(0.5)}]}},
    }
    events_client = MagicMock()
    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()), \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handle_judge_requested(_requested_event())

    entries = [
        e
        for call in events_client.put_events.call_args_list
        for e in call.kwargs["Entries"]
    ]
    assert any(e["DetailType"] == "governance.eval.case.judged" for e in entries)
    assert not any(e["DetailType"] == "eval.usage.captured" for e in entries)
