"""Tests for arbiter/eval_judge/index.py (CIT-103 Pass B).

Covers:
  - governance.eval.case.judge.requested consumption: resolves the "judge"
    slot (requires_converse=True) via common.model_resolver, fetches the
    replay-package artifact (SSM bucket param + S3 GetObject
    eval-runs/{evalRunId}/{caseId}.json, mirroring Pass A's naming), invokes
    Bedrock Converse at temperature=0 once per requested dimension, and
    emits governance.eval.case.judged with the FROZEN Pass A/B contract
    shape (verbatim: no `detail` field on the wire event).
  - Malformed/unparseable judge output never fabricates a score: the
    dimension is emitted with status=UNKNOWN and no `verdict` key, but ALL
    THREE reproducibility stamps (judgeModelId/judgeModelVersion/
    judgePromptHash) are still present (they describe the model that was
    called, not the parse outcome).
  - judgePromptHash stability: same case + artifact -> same hash, across
    two independent invocations.
  - Contract-shape fidelity: the exact key set of the judged detail matches
    notifier-base.ts's GovernancePayloadMap["governance.eval.case.judged"]
    byte-for-byte (extra/missing keys fail the test).
  - Single-writer invariant: this module never calls any DynamoDB write API
    (no put_item/update_item anywhere in the mocked boto3 clients used).

Bedrock is mocked throughout (manifest_proposal._invoke_model precedent —
no live model call in the suite). property/hypothesis used for the
malformed-output and prompt-hash-stability bites.
"""
import json
import os
import sys
from unittest.mock import MagicMock, patch

from hypothesis import given, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("MODEL_CONFIG_TABLE", "fake-model-config")
os.environ.setdefault("MODEL_CATALOG_TABLE", "fake-model-catalog")
os.environ.setdefault("REPLAY_BUCKET_PARAM", "/citadel/eval-replay-bucket-test")

import eval_judge.index as ej  # noqa: E402


# ---------------------------------------------------------------------------
# Frozen contract fixtures (mirrors notifier-base.ts verbatim).
# ---------------------------------------------------------------------------
FROZEN_JUDGED_KEYS = {
    "evalRunId",
    "caseId",
    "orgId",
    "dimension",
    "status",
    "verdict",
    "judgeModelId",
    "judgeModelVersion",
    "judgePromptHash",
}
# Keys that MUST be present on every emitted event regardless of outcome.
FROZEN_JUDGED_REQUIRED_KEYS = {
    "evalRunId",
    "caseId",
    "orgId",
    "dimension",
    "status",
    "judgeModelId",
    "judgeModelVersion",
    "judgePromptHash",
}


def _requested_event(dimension="task_success", rubric="Evaluate the response. Score 0..1."):
    return {
        "evalRunId": "run-1",
        "caseId": "case-1",
        "orgId": "org-1",
        "artifactRef": "eval-runs/run-1/case-1.json",
        "judgeDimensions": [{"dimension": dimension, "rubric": rubric}],
        "judgeSlot": "judge",
    }


def _mock_config_item():
    return {
        "scope": "platform",
        "slotDefaults": {"judge": "claude-judge-key"},
        "globalDefaultKey": None,
        "orgDefaults": {},
        "agentOverrides": {},
        "localityMode": "off",
    }


def _mock_catalog_items():
    return [
        {
            "modelKey": "claude-judge-key",
            "provider": "anthropic",
            "baseModelId": "anthropic.claude-sonnet-4-6",
            "status": "enabled",
            "modality": "text",
            "invocationMode": "converse",
            "supportsTools": False,
            "supportsSystemPrompt": True,
            "supportsStreaming": True,
            "regionProfiles": {"us": "us.anthropic.claude-sonnet-4-6"},
        }
    ]


def _mock_ddb_resource():
    resource = MagicMock(name="dynamodb.resource.stub")
    tables = {}

    def table(name):
        if name not in tables:
            t = MagicMock(name=f"table:{name}")
            if name == os.environ["MODEL_CONFIG_TABLE"]:
                t.get_item.return_value = {"Item": _mock_config_item()}
            elif name == os.environ["MODEL_CATALOG_TABLE"]:
                t.scan.return_value = {"Items": _mock_catalog_items()}
            tables[name] = t
        return tables[name]

    resource.Table.side_effect = table
    # Exposed for assertions (single-writer invariant test): lets tests reach
    # the per-name table mocks WITHOUT re-calling resource.Table(), which
    # would mutate its live call_args_list. Note: because Table uses a
    # side_effect, resource.Table.return_value is NOT what callers receive —
    # only this cache holds the mocks production code actually touched.
    resource.created_tables = tables
    return resource


def _mock_ssm_client(bucket_name="fake-replay-bucket"):
    client = MagicMock(name="ssm.client.stub")
    client.get_parameter.return_value = {"Parameter": {"Value": bucket_name}}
    return client


def _mock_s3_client(artifact=None):
    client = MagicMock(name="s3.client.stub")
    body = MagicMock()
    payload = artifact if artifact is not None else {"sections": {"messages": []}}
    body.read.return_value = json.dumps(payload).encode("utf-8")
    client.get_object.return_value = {"Body": body}
    return client


def _well_formed_verdict_text(score=0.87):
    return json.dumps({"score": score})


class _FakeBedrockClient:
    """Stand-in for boto3 bedrock-runtime client's converse() call."""

    def __init__(self, response_text):
        self._response_text = response_text
        self.calls = []

    def converse(self, **kwargs):
        self.calls.append(kwargs)
        return {
            "output": {"message": {"content": [{"text": self._response_text}]}},
        }


# ---------------------------------------------------------------------------
# Slot resolution + happy path.
# ---------------------------------------------------------------------------
def test_resolves_judge_slot_with_requires_converse():
    """The judge slot must be resolved with requires_converse=True — a
    non-converse catalog entry for the same key must NOT be selected."""
    reqs = ej.JUDGE_SLOT_REQUIREMENTS
    assert reqs.requires_converse is True
    assert reqs.modality.value == "text"


def test_happy_path_emits_scored_with_all_stamps():
    bedrock = _FakeBedrockClient(_well_formed_verdict_text(0.9))
    events_client = MagicMock()

    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()), \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handle_judge_requested(_requested_event())

    assert events_client.put_events.called
    (call_kwargs,) = [c.kwargs for c in events_client.put_events.call_args_list]
    entries = call_kwargs["Entries"]
    assert len(entries) == 1
    detail = json.loads(entries[0]["Detail"])

    assert set(detail.keys()) == FROZEN_JUDGED_KEYS
    assert detail["status"] == "SCORED"
    assert detail["verdict"] == {"kind": "score", "score": 0.9}
    assert detail["judgeModelId"]
    assert detail["judgeModelVersion"]
    assert detail["judgePromptHash"]
    # temperature=0 on every converse call.
    assert bedrock.calls[0]["inferenceConfig"]["temperature"] == 0


def test_judged_event_source_matches_the_backend_routing_rule_convention():
    """B2 (taskId 316427f2, HIGH): EvalCaseJudgedRule and
    EvalSampleJudgedRule (telemetry-stack.ts) both match
    source=["citadel.backend"] for governance.eval.case.judged — the same
    Source every other governance.* event uses (notifier-base.ts's
    emitGovernanceEvent hardcodes "citadel.backend"; EVENTBRIDGE_CATALOG.md
    documents it as the convention for this event). If the judge emitted
    any other Source, the event would route to NO consumer and every
    judge-basis dimension (task_success, groundedness_faithfulness) would
    silently stay PENDING forever. Pin the emitter's real Source against
    the documented/rule-side convention so the two sides can't drift
    again."""
    bedrock = _FakeBedrockClient(_well_formed_verdict_text(0.9))
    events_client = MagicMock()

    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()), \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handle_judge_requested(_requested_event())

    (call_kwargs,) = [c.kwargs for c in events_client.put_events.call_args_list]
    judged_entries = [
        e for e in call_kwargs["Entries"]
        if e["DetailType"] == "governance.eval.case.judged"
    ]
    assert len(judged_entries) == 1
    # This is the documented rule-side convention (telemetry-stack.ts's
    # EvalCaseJudgedRule/EvalSampleJudgedRule eventPattern.source), pinned
    # here on the emitter side so a future edit to either cannot silently
    # diverge from the other again.
    EXPECTED_ROUTING_RULE_SOURCE = "citadel.backend"
    assert judged_entries[0]["Source"] == EXPECTED_ROUTING_RULE_SOURCE


def test_never_writes_ddb_directly():
    """Single-writer invariant (design §7): the judge handler must never
    call any DynamoDB write API. Only get_item/scan (reads) may be called
    on the mocked resource."""
    bedrock = _FakeBedrockClient(_well_formed_verdict_text(0.5))
    events_client = MagicMock()
    ddb_resource = _mock_ddb_resource()

    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=ddb_resource), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()), \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handle_judge_requested(_requested_event())

    # Inspect every MagicMock created via resource.Table() and assert no
    # write-shaped method was ever invoked. Snapshot the call list first and
    # NEVER re-call ddb_resource.Table(...) in this loop: a re-call appends
    # to the live call_args_list being iterated, so the loop never
    # terminates (observed as a kernel OOM kill, exit 137). The actual table
    # mocks handed to production code live in the helper's exposed cache.
    table_names = [call.args[0] for call in list(ddb_resource.Table.call_args_list)]
    assert table_names, "expected the handler to read at least one DDB table"
    for table_name in table_names:
        table_mock = ddb_resource.created_tables[table_name]
        for write_method in ("put_item", "update_item", "delete_item", "batch_write_item"):
            assert not getattr(table_mock, write_method).called


# ---------------------------------------------------------------------------
# Malformed judge output -> UNKNOWN, never fabricated. Property-based.
# ---------------------------------------------------------------------------
@given(garbage=st.one_of(
    st.text(),
    st.just(""),
    st.just("not json at all {{{"),
    st.just('{"score": "not-a-number"}'),
    st.just('{"score": null}'),
    st.just('{"totally": "unrelated"}'),
    st.just("[]"),
    st.just("null"),
))
@settings(max_examples=50, deadline=None)
def test_malformed_judge_output_never_fabricates_score(garbage):
    """For ANY garbage judge output, the dimension must land UNKNOWN with
    no verdict key — and the reproducibility stamps must still be present
    (they describe the call that was made, independent of parse success)."""
    bedrock = _FakeBedrockClient(garbage)
    events_client = MagicMock()

    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()), \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handle_judge_requested(_requested_event())

    (call_kwargs,) = [c.kwargs for c in events_client.put_events.call_args_list]
    detail = json.loads(call_kwargs["Entries"][0]["Detail"])

    assert detail["status"] == "UNKNOWN"
    assert "verdict" not in detail
    assert detail["judgeModelId"]
    assert detail["judgeModelVersion"]
    assert detail["judgePromptHash"]
    assert set(detail.keys()) <= FROZEN_JUDGED_KEYS
    assert FROZEN_JUDGED_REQUIRED_KEYS <= set(detail.keys())


def test_out_of_range_score_is_unknown_not_clamped_or_fabricated():
    """A syntactically valid but out-of-[0,1]-range score must not be
    silently clamped into a fabricated in-range value — UNKNOWN instead."""
    bedrock = _FakeBedrockClient(json.dumps({"score": 5.0}))
    events_client = MagicMock()

    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()), \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handle_judge_requested(_requested_event())

    (call_kwargs,) = [c.kwargs for c in events_client.put_events.call_args_list]
    detail = json.loads(call_kwargs["Entries"][0]["Detail"])
    assert detail["status"] == "UNKNOWN"
    assert "verdict" not in detail


# ---------------------------------------------------------------------------
# Prompt-hash stability.
# ---------------------------------------------------------------------------
@given(
    dimension=st.sampled_from(["task_success", "groundedness_faithfulness"]),
    rubric=st.text(min_size=1, max_size=200).filter(lambda s: s.strip() != ""),
)
@settings(max_examples=25, deadline=None)
def test_prompt_hash_stable_for_same_case_and_artifact(dimension, rubric):
    """Same case + artifact -> same judgePromptHash, across two independent
    invocations (nothing time-based or random leaks into the hash input)."""
    artifact = {"sections": {"messages": [{"role": "assistant", "content": "hello"}]}}

    def run_once():
        bedrock = _FakeBedrockClient(_well_formed_verdict_text(0.5))
        events_client = MagicMock()
        with patch.object(ej, "_bedrock_client", return_value=bedrock), \
             patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
             patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
             patch.object(ej, "_s3_client", return_value=_mock_s3_client(artifact)), \
             patch.object(ej, "_events_client", return_value=events_client):
            ej.handle_judge_requested(_requested_event(dimension=dimension, rubric=rubric))
        (call_kwargs,) = [c.kwargs for c in events_client.put_events.call_args_list]
        return json.loads(call_kwargs["Entries"][0]["Detail"])["judgePromptHash"]

    hash_a = run_once()
    hash_b = run_once()
    assert hash_a == hash_b


def test_prompt_hash_changes_when_rubric_changes():
    """Negative bite: a different rubric must change the hash (proves the
    hash is not a constant / degenerate function)."""
    artifact = {"sections": {"messages": []}}

    def run_with_rubric(rubric):
        bedrock = _FakeBedrockClient(_well_formed_verdict_text(0.5))
        events_client = MagicMock()
        with patch.object(ej, "_bedrock_client", return_value=bedrock), \
             patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
             patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
             patch.object(ej, "_s3_client", return_value=_mock_s3_client(artifact)), \
             patch.object(ej, "_events_client", return_value=events_client):
            ej.handle_judge_requested(_requested_event(rubric=rubric))
        (call_kwargs,) = [c.kwargs for c in events_client.put_events.call_args_list]
        return json.loads(call_kwargs["Entries"][0]["Detail"])["judgePromptHash"]

    assert run_with_rubric("Rubric A. Score 0..1.") != run_with_rubric("Rubric B. Score 0..1.")


# ---------------------------------------------------------------------------
# Contract-shape fidelity (byte-exact key set) vs frozen event.
# ---------------------------------------------------------------------------
def test_judged_event_never_carries_extra_keys_like_detail():
    """The frozen contract has NO `detail` field. Even though the task's
    prose mentions 'status UNKNOWN + detail', the FROZEN wire shape (design
    §7 / notifier-base.ts GovernancePayloadMap) has no such field — this
    test pins that the judge never adds one."""
    bedrock = _FakeBedrockClient("garbage")
    events_client = MagicMock()
    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()), \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handle_judge_requested(_requested_event())
    (call_kwargs,) = [c.kwargs for c in events_client.put_events.call_args_list]
    detail = json.loads(call_kwargs["Entries"][0]["Detail"])
    assert "detail" not in detail
    assert set(detail.keys()) <= FROZEN_JUDGED_KEYS


def test_multiple_requested_dimensions_emit_one_event_each():
    event = _requested_event()
    event["judgeDimensions"] = [
        {"dimension": "task_success", "rubric": "r1"},
        {"dimension": "groundedness_faithfulness", "rubric": "r2"},
    ]
    bedrock = _FakeBedrockClient(_well_formed_verdict_text(0.5))
    events_client = MagicMock()
    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()), \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handle_judge_requested(event)

    assert events_client.put_events.call_count == 2
    dims_seen = set()
    for call in events_client.put_events.call_args_list:
        detail = json.loads(call.kwargs["Entries"][0]["Detail"])
        dims_seen.add(detail["dimension"])
    assert dims_seen == {"task_success", "groundedness_faithfulness"}


def test_missing_artifact_ref_still_judges_with_empty_context():
    """artifactRef is optional on the requested event (design: materialization
    can degrade). Judge must never throw — it judges with an empty/degraded
    context and still emits UNKNOWN or SCORED with full stamps."""
    event = _requested_event()
    del event["artifactRef"]
    bedrock = _FakeBedrockClient(_well_formed_verdict_text(0.3))
    events_client = MagicMock()
    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()) as s3_factory, \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handle_judge_requested(event)

    assert events_client.put_events.called
    (call_kwargs,) = [c.kwargs for c in events_client.put_events.call_args_list]
    detail = json.loads(call_kwargs["Entries"][0]["Detail"])
    assert detail["judgeModelId"]


def test_handler_routes_eventbridge_envelope_to_handle_judge_requested():
    """The Lambda entrypoint `handler(event, context)` must unwrap the
    EventBridge envelope (detail-type + detail) and dispatch only on
    governance.eval.case.judge.requested, no-op on anything else."""
    bedrock = _FakeBedrockClient(_well_formed_verdict_text(0.5))
    events_client = MagicMock()
    envelope = {
        "detail-type": "governance.eval.case.judge.requested",
        "detail": _requested_event(),
    }
    with patch.object(ej, "_bedrock_client", return_value=bedrock), \
         patch.object(ej, "_ddb_resource", return_value=_mock_ddb_resource()), \
         patch.object(ej, "_ssm_client", return_value=_mock_ssm_client()), \
         patch.object(ej, "_s3_client", return_value=_mock_s3_client()), \
         patch.object(ej, "_events_client", return_value=events_client):
        ej.handler(envelope, None)
    assert events_client.put_events.called


def test_handler_noops_on_unrecognized_detail_type():
    events_client = MagicMock()
    envelope = {"detail-type": "governance.eval.case.completed", "detail": {}}
    with patch.object(ej, "_events_client", return_value=events_client):
        ej.handler(envelope, None)
    assert not events_client.put_events.called
