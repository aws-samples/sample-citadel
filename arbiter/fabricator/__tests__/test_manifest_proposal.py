"""Tests for Tier-3 agent-import manifest-proposal (ARBITER-A).

Covers:
  - manifest_proposal.propose_agent_manifest: JSON parsing (incl. markdown
    fences / prose stripping + one repair attempt), required-key validation,
    fieldConfidence forced-to-'low', secret redaction, and the typed
    ManifestProposalError on unparseable/invalid output.
  - index.process_event 'manifest-proposal' branch: publishes the B1 contract
    'agent.import.manifest.proposed' / 'agent.import.manifest.failed' events,
    BYPASSES the design-assessment / code-fabrication gate, and never lets an
    exception escape (poison-queue safety).
  - index.publish_manifest_event PutEvents wiring (agent bus / Source /
    DetailType / JSON detail).
  - unknown requestType is a safe no-op.

No live AWS, no live model — the LLM client (manifest_proposal._invoke_model)
and EventBridge (index.boto3 / index.publish_manifest_event) are mocked.
"""

import json
import os
import sys
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Required env vars before importing the module under test.
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

import index  # noqa: E402
import manifest_proposal  # noqa: E402
from manifest_proposal import (  # noqa: E402
    ManifestProposalError,
    force_field_confidence_low,
    propose_agent_manifest,
    redact_signals,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _descriptor_json(confidence: str = "high") -> str:
    """A well-formed capability-descriptor JSON string with the supplied
    (non-'low') fieldConfidence so tests can prove forcing-to-low."""
    return json.dumps(
        {
            "name": "invoice_parser",
            "description": "Parses invoices into structured records",
            "operations": [
                {
                    "name": "parse",
                    "description": "Parse one invoice document",
                    "fieldConfidence": {"name": confidence, "description": confidence},
                }
            ],
            "inputSchema": {
                "type": "object",
                "properties": {"document": {"type": "string"}},
            },
            "fieldConfidence": {"name": confidence, "description": confidence},
        }
    )


def _all_field_confidence_leaves(obj):
    """Collect every leaf value that lives under a 'fieldConfidence' key."""
    leaves = []

    def _collect_under(v):
        if isinstance(v, dict):
            for sub in v.values():
                _collect_under(sub)
        elif isinstance(v, list):
            for item in v:
                _collect_under(item)
        else:
            leaves.append(v)

    def _walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k == "fieldConfidence":
                    _collect_under(v)
                else:
                    _walk(v)
        elif isinstance(node, list):
            for item in node:
                _walk(item)

    _walk(obj)
    return leaves


SECRET_AKIA = "AKIAIOSFODNN7EXAMPLE"
SECRET_TOKEN = "ghp_aBcD1234567890aBcD1234567890aBcD12"


def _signals_with_secret() -> dict:
    return {
        "sourceUrl": "https://github.com/acme/connector",
        "apiToken": SECRET_TOKEN,
        "awsAccessKeyValue": SECRET_AKIA,
        "summary": "A connector that reads issues",
    }


# ===========================================================================
# manifest_proposal.propose_agent_manifest — parsing & validation
# ===========================================================================
class TestProposeAgentManifestParsing:
    def test_wellformed_json_returns_dict_with_required_keys(self):
        result = propose_agent_manifest(
            {"summary": "x"}, invoke=lambda _p: _descriptor_json()
        )
        assert isinstance(result, dict)
        assert result["name"] == "invoice_parser"
        assert "description" in result

    def test_all_field_confidence_forced_low_even_if_llm_returns_high(self):
        result = propose_agent_manifest(
            {"summary": "x"}, invoke=lambda _p: _descriptor_json(confidence="high")
        )
        leaves = _all_field_confidence_leaves(result)
        assert leaves, "expected at least one fieldConfidence leaf"
        assert all(v == "low" for v in leaves), f"non-low leaves: {leaves}"

    def test_field_confidence_added_when_llm_omits_it(self):
        raw = json.dumps({"name": "x", "description": "y"})
        result = propose_agent_manifest({"summary": "x"}, invoke=lambda _p: raw)
        assert isinstance(result.get("fieldConfidence"), dict)
        assert all(v == "low" for v in result["fieldConfidence"].values())

    def test_strips_markdown_fences_and_prose(self):
        wrapped = (
            "Sure! Here is the descriptor you asked for:\n\n"
            "```json\n" + _descriptor_json() + "\n```\n\n"
            "Let me know if you need changes."
        )
        result = propose_agent_manifest({"summary": "x"}, invoke=lambda _p: wrapped)
        assert result["name"] == "invoice_parser"

    def test_repairs_trailing_comma_then_parses(self):
        # Invalid JSON (trailing comma) — must survive the single repair attempt.
        broken = '{"name": "x", "description": "y",}'
        result = propose_agent_manifest({"summary": "x"}, invoke=lambda _p: broken)
        assert result["name"] == "x"

    def test_unparseable_junk_raises_manifest_error(self):
        with pytest.raises(ManifestProposalError):
            propose_agent_manifest(
                {"summary": "x"},
                invoke=lambda _p: "I'm sorry, I cannot produce that.",
            )

    def test_json_array_not_object_raises(self):
        with pytest.raises(ManifestProposalError):
            propose_agent_manifest({"summary": "x"}, invoke=lambda _p: "[1, 2, 3]")

    def test_missing_required_keys_raises(self):
        with pytest.raises(ManifestProposalError):
            propose_agent_manifest(
                {"summary": "x"}, invoke=lambda _p: json.dumps({"foo": "bar"})
            )


# ===========================================================================
# manifest_proposal — secret handling
# ===========================================================================
class TestSecretRedaction:
    def test_redact_signals_redacts_secret_value_and_key(self):
        red = redact_signals(_signals_with_secret())
        blob = json.dumps(red)
        assert SECRET_AKIA not in blob
        assert SECRET_TOKEN not in blob
        assert "[REDACTED]" in blob
        # Non-secret values survive.
        assert red["sourceUrl"] == "https://github.com/acme/connector"

    def test_secret_never_reaches_the_prompt(self):
        captured = {}

        def fake_invoke(prompt):
            captured["prompt"] = prompt
            return _descriptor_json()

        propose_agent_manifest(_signals_with_secret(), invoke=fake_invoke)
        assert SECRET_AKIA not in captured["prompt"]
        assert SECRET_TOKEN not in captured["prompt"]


# ===========================================================================
# manifest_proposal.force_field_confidence_low — property test
# ===========================================================================
_json_leaves = st.one_of(
    st.text(max_size=8), st.integers(), st.booleans(), st.none(), st.sampled_from(["high", "medium", "low"])
)


@st.composite
def _nested(draw, depth=3):
    if depth <= 0:
        return draw(_json_leaves)
    keys = st.sampled_from(["fieldConfidence", "name", "operations", "x", "y"])
    return draw(
        st.one_of(
            _json_leaves,
            st.lists(_nested(depth - 1), max_size=3),
            st.dictionaries(keys, _nested(depth - 1), max_size=4),
        )
    )


class TestForceFieldConfidenceProperty:
    @given(structure=_nested())
    @settings(max_examples=120)
    def test_every_field_confidence_leaf_is_low(self, structure):
        forced = force_field_confidence_low(structure)
        for leaf in _all_field_confidence_leaves(forced):
            assert leaf == "low"


# ===========================================================================
# index.publish_manifest_event — EventBridge wiring
# ===========================================================================
class TestPublishManifestEvent:
    def test_publishes_to_agent_bus_with_source_and_detailtype(self):
        mock_client = MagicMock()
        mock_client.put_events.return_value = {"FailedEntryCount": 0}
        detail = {
            "requestId": "r1",
            "correlationId": "c1",
            "importId": "i1",
            "proposedManifest": {"name": "x"},
            "status": "proposed",
        }
        with patch.object(index, "boto3") as mock_boto3:
            mock_boto3.client.return_value = mock_client
            index.publish_manifest_event("agent.import.manifest.proposed", detail)

        entries = mock_client.put_events.call_args.kwargs["Entries"]
        entry = entries[0]
        assert entry["Source"] == "agent.import.manifest.proposed"
        assert entry["DetailType"] == "agent.import.manifest.proposed"
        assert entry["EventBusName"] == os.environ["COMPLETION_BUS_NAME"]
        parsed = json.loads(entry["Detail"])
        assert parsed == detail


# ===========================================================================
# index.process_event — 'manifest-proposal' branch
# ===========================================================================
def _proposal_event() -> dict:
    return {
        "requestId": "req-123",
        "correlationId": "corr-456",
        "importId": "imp-789",
        "signals": {"sourceUrl": "https://example.com/agent", "summary": "demo"},
    }


class TestProcessEventManifestProposal:
    def test_publishes_proposed_with_contract_detail_and_low_confidence(self):
        with patch.object(
            manifest_proposal, "_invoke_model", return_value=_descriptor_json("high")
        ), patch.object(index, "publish_manifest_event") as pub, patch.object(
            index, "check_design_assessment"
        ), patch.object(
            index, "create_agent_fabricator"
        ), patch.object(
            index, "create_tool_fabricator"
        ):
            index.process_event(_proposal_event(), {}, request_type="manifest-proposal")

        assert pub.call_count == 1
        detail_type, detail = pub.call_args.args[0], pub.call_args.args[1]
        assert detail_type == "agent.import.manifest.proposed"
        assert detail["requestId"] == "req-123"
        assert detail["correlationId"] == "corr-456"
        assert detail["importId"] == "imp-789"
        assert detail["status"] == "proposed"
        leaves = _all_field_confidence_leaves(detail["proposedManifest"])
        assert leaves and all(v == "low" for v in leaves)

    def test_bypasses_design_assessment_and_codegen(self):
        with patch.object(
            manifest_proposal, "_invoke_model", return_value=_descriptor_json()
        ), patch.object(index, "publish_manifest_event"), patch.object(
            index, "check_design_assessment"
        ) as gate, patch.object(
            index, "create_agent_fabricator"
        ) as mk_agent, patch.object(
            index, "create_tool_fabricator"
        ) as mk_tool:
            index.process_event(_proposal_event(), {}, request_type="manifest-proposal")

        gate.assert_not_called()
        mk_agent.assert_not_called()
        mk_tool.assert_not_called()

    def test_unparseable_llm_output_publishes_failed_no_raise(self):
        with patch.object(
            manifest_proposal, "_invoke_model", return_value="not json at all"
        ), patch.object(index, "publish_manifest_event") as pub, patch.object(
            index, "check_design_assessment"
        ), patch.object(
            index, "create_agent_fabricator"
        ), patch.object(
            index, "create_tool_fabricator"
        ):
            # Must NOT raise.
            index.process_event(_proposal_event(), {}, request_type="manifest-proposal")

        assert pub.call_count == 1
        detail_type, detail = pub.call_args.args[0], pub.call_args.args[1]
        assert detail_type == "agent.import.manifest.failed"
        assert detail["status"] == "failed"
        assert detail["importId"] == "imp-789"
        assert isinstance(detail.get("error"), str) and detail["error"]

    def test_model_client_error_publishes_failed_no_raise(self):
        def boom(_prompt):
            raise RuntimeError("bedrock throttled")

        with patch.object(
            manifest_proposal, "_invoke_model", side_effect=boom
        ), patch.object(index, "publish_manifest_event") as pub, patch.object(
            index, "check_design_assessment"
        ), patch.object(
            index, "create_agent_fabricator"
        ):
            index.process_event(_proposal_event(), {}, request_type="manifest-proposal")

        assert pub.call_args.args[0] == "agent.import.manifest.failed"

    def test_secret_not_in_emitted_event_or_logs(self, caplog):
        event = {
            "requestId": "r",
            "correlationId": "c",
            "importId": "i",
            "signals": _signals_with_secret(),
        }
        with patch.object(
            manifest_proposal, "_invoke_model", return_value=_descriptor_json()
        ), patch.object(index, "publish_manifest_event") as pub, patch.object(
            index, "check_design_assessment"
        ), patch.object(
            index, "create_agent_fabricator"
        ):
            with caplog.at_level("DEBUG"):
                index.process_event(event, {}, request_type="manifest-proposal")

        emitted = json.dumps(pub.call_args.args[1])
        assert SECRET_AKIA not in emitted
        assert SECRET_TOKEN not in emitted
        assert SECRET_AKIA not in caplog.text
        assert SECRET_TOKEN not in caplog.text


# ===========================================================================
# index.process_event — unknown requestType safe no-op
# ===========================================================================
class TestUnknownRequestType:
    def test_unknown_request_type_is_safe_noop(self):
        with patch.object(index, "publish_manifest_event") as pub, patch.object(
            index, "publish_fabrication_event"
        ) as fab_pub, patch.object(
            index, "check_design_assessment"
        ) as gate, patch.object(
            index, "create_agent_fabricator"
        ) as mk_agent:
            # Must NOT raise even though there is no taskDetails / signals.
            index.process_event({"foo": "bar"}, {}, request_type="totally-bogus-type")

        pub.assert_not_called()
        fab_pub.assert_not_called()
        gate.assert_not_called()
        mk_agent.assert_not_called()
