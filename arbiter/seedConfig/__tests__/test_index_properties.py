"""
Property-based tests for arbiter/seedConfig/index.py

Tests the CloudFormation custom resource handler for seed configuration,
verifying Delete always succeeds and Create seeds correct data structure.
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# US-ARB-011: the governance table env vars must be set *before* the
# handler module is imported, because index.py reads them at module
# import time (AUTHORITY_UNITS_TABLE / CONSTITUTIONAL_LAYERS_TABLE).
# Use setdefault so anything the caller injects (e.g. a future
# integration harness) still wins.
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/worker")
os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/fabricator")
os.environ.setdefault("AUTHORITY_UNITS_TABLE", "fake-authority-units-table")
os.environ.setdefault("CONSTITUTIONAL_LAYERS_TABLE", "fake-constitutional-layers-table")


# Add project root so the parsability test can import from
# arbiter.governance.* without depending on how pytest was launched.
_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

cfn_events_base = st.fixed_dictionaries({
    "ResponseURL": st.just("https://cfn-response.example.com/callback"),
    "StackId": st.text(min_size=1, max_size=40).map(
        lambda s: f"arn:aws:cloudformation:us-east-1:123456789012:stack/{s}"
    ),
    "RequestId": st.uuids().map(str),
    "LogicalResourceId": st.text(
        min_size=1, max_size=30,
        alphabet=st.characters(whitelist_categories=("L", "N")),
    ),
})

lambda_contexts = st.builds(
    lambda name: type("Ctx", (), {"log_stream_name": name})(),
    st.text(min_size=1, max_size=60),
)


# ---------------------------------------------------------------------------
# handler
# ---------------------------------------------------------------------------

class TestSeedConfigHandler:
    """Property tests for the seedConfig handler."""

    @given(event=cfn_events_base, context=lambda_contexts)
    @settings(max_examples=50)
    def test_delete_always_sends_success(self, event, context):
        """Delete requests always respond with SUCCESS."""
        event = {**event, "RequestType": "Delete"}

        with patch("cfnresponse.send") as mock_send:
            from index import handler
            handler(event, context)

            mock_send.assert_called_once()
            call_args = mock_send.call_args[0]
            assert call_args[2] == "SUCCESS"

    @given(event=cfn_events_base, context=lambda_contexts)
    @settings(max_examples=50)
    def test_create_seeds_fabricator_agent(self, event, context):
        """Create requests seed a fabricator agent + governance corpus.

        US-ARB-011 extends this from a single put_item assertion to the full
        deterministic five: 1 agent + 2 authority units + 1 layer = 5 total,
        with field-level assertions on each row. The single shared
        ``mock_table`` is fine here because the test only cares about the
        aggregated sequence of put_items observed through the dynamodb
        resource; the handler routes them to different tables by name,
        which is asserted indirectly via unitId / layerId uniqueness in
        the payloads themselves.
        """
        event = {**event, "RequestType": "Create"}

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb

            from index import handler
            handler(event, context)

            # --- Deterministic call count: 2 agents (fabricator + echo) +
            # 2 units + 1 layer = 5. (Per D3: no global fabricator unit.)
            assert mock_table.put_item.call_count == 5, (
                f"expected 5 put_item calls (2 agents + 2 units + 1 layer), "
                f"got {mock_table.put_item.call_count}"
            )

            items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]

            # --- Fabricator agent (unchanged AC).
            agent_items = [i for i in items if i.get("agentId") == "fabricator"]
            assert len(agent_items) == 1
            agent = agent_items[0]
            assert agent["state"] == "active"
            assert "config" in agent
            assert agent["config"]["name"] == "fabricator"
            assert "description" in agent["config"]
            assert "schema" in agent["config"]
            assert "action" in agent["config"]
            assert agent["config"]["action"]["type"] == "sqs"

            # --- Authority units (US-ARB-011 D2/D3).
            unit_items = [i for i in items if "unitId" in i]
            unit_ids = {i["unitId"] for i in unit_items}
            assert unit_ids == {"arbiter-invoke-all", "escalate-invoke-all"}, (
                f"unexpected unit ids: {unit_ids}"
            )

            arbiter_unit = next(
                i for i in unit_items if i["unitId"] == "arbiter-invoke-all"
            )
            assert arbiter_unit["agentId"] == "arbiter"
            assert arbiter_unit["registryId"] == "*GLOBAL*"
            assert arbiter_unit["riskRating"] == "low"
            assert arbiter_unit["revoked"] is False
            assert arbiter_unit["scope"]["decision_type"] == "invoke_agent"
            assert arbiter_unit["scope"]["domain"] == "*"
            assert arbiter_unit["scope"]["conditions"] == {}
            assert arbiter_unit["scope"]["limits"] == {}

            escalate_unit = next(
                i for i in unit_items if i["unitId"] == "escalate-invoke-all"
            )
            assert escalate_unit["agentId"] == "arbiter"
            assert escalate_unit["registryId"] == "*GLOBAL*"
            assert escalate_unit["scope"]["decision_type"] == "invoke_tool"
            assert escalate_unit["scope"]["domain"] == "escalate"

            # Per D3: no global fabricator unit.
            assert not any(
                i.get("unitId", "").startswith("fabricator-") for i in unit_items
            ), "D3 violation: global fabricator authority unit seeded"

            # --- Constitutional layer (US-ARB-011).
            layer_items = [i for i in items if "layerId" in i]
            assert len(layer_items) == 1
            layer = layer_items[0]
            assert layer["layerId"] == "global-constitution"
            assert layer["layerType"] == "global"
            assert layer["appliesTo"] == []
            assert len(layer["rules"]) == 2, (
                f"expected 2 rules, got {len(layer['rules'])}"
            )
            rule_fields = {r["field"] for r in layer["rules"]}
            assert rule_fields == {
                "audit.record_produced",
                "scope.expansion_under_unconfirmed_state",
            }
            # Every rule must carry the deterministic operator contract:
            # field / operator / value / description.
            for rule in layer["rules"]:
                assert set(rule.keys()) >= {"field", "operator", "value", "description"}
                assert rule["operator"] == "eq"

    @given(event=cfn_events_base, context=lambda_contexts)
    @settings(max_examples=50)
    def test_create_schema_is_valid_object_schema(self, event, context):
        """Seeded agent schema is a valid JSON object schema."""
        event = {**event, "RequestType": "Create"}

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send"):
            mock_boto3.resource.return_value = mock_dynamodb

            from index import handler
            handler(event, context)

            # Find the fabricator agent put among the 5 total.
            agent_items = [
                c.kwargs["Item"]
                for c in mock_table.put_item.call_args_list
                if c.kwargs["Item"].get("agentId") == "fabricator"
            ]
            assert len(agent_items) == 1
            schema = agent_items[0]["config"]["schema"]

            assert schema["type"] == "object"
            assert "properties" in schema
            assert "required" in schema
            assert isinstance(schema["required"], list)
            assert "taskDetails" in schema["properties"]

    @given(event=cfn_events_base, context=lambda_contexts)
    @settings(max_examples=30)
    def test_create_sends_success_on_completion(self, event, context):
        """Successful Create sends SUCCESS cfnresponse."""
        event = {**event, "RequestType": "Create"}

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb

            from index import handler
            handler(event, context)

            mock_send.assert_called_once()
            call_args = mock_send.call_args[0]
            assert call_args[2] == "SUCCESS"

    @given(event=cfn_events_base, context=lambda_contexts)
    @settings(max_examples=30)
    def test_create_failure_sends_failed(self, event, context):
        """DynamoDB errors during Create send FAILED cfnresponse."""
        event = {**event, "RequestType": "Create"}

        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.side_effect = Exception("DDB error")

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb

            from index import handler
            handler(event, context)

            mock_send.assert_called_once()
            call_args = mock_send.call_args[0]
            assert call_args[2] == "FAILED"

    @given(
        request_type=st.sampled_from(["Create", "Update", "Delete"]),
        event=cfn_events_base,
        context=lambda_contexts,
    )
    @settings(max_examples=30)
    def test_handler_never_raises(self, request_type, event, context):
        """Handler never raises; errors are sent via cfnresponse."""
        event = {**event, "RequestType": request_type}

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send"):
            mock_boto3.resource.return_value = mock_dynamodb

            from index import handler
            # Should not raise
            handler(event, context)


# ---------------------------------------------------------------------------
# US-ARB-011 AC 5 — parsability into the engine
# ---------------------------------------------------------------------------
#
# The seeded constitutional layer dict must round-trip through
# ``ConstitutionalLayer`` and be understood by
# ``GovernanceEngine._constitutional_review``. This closes the loop between
# the CFN seed and the runtime engine: if the engine's operator set ever
# diverges from what the seed emits, this test fails loudly.
#
# We verify two scenarios against the *real* engine (no mocks):
#   (a) context satisfies both rules → no violation (returns None)
#   (b) context violates audit.record_produced → DENY finding returned


class TestConstitutionalLayerParsability:
    """AC 5 — seed payload is engine-parsable."""

    @staticmethod
    def _seeded_layer():
        """Construct a ConstitutionalLayer from the exact seed payload.

        Mirror of the dict in ``arbiter/seedConfig/index.py`` — kept in
        lockstep so drift between seed and engine triggers a test failure
        rather than a production constitution misread.
        """
        from arbiter.governance.models import ConstitutionalLayer

        seed_dict = {
            "layerId": "global-constitution",
            "layerType": "global",
            "appliesTo": [],
            "rules": [
                {
                    "field": "audit.record_produced",
                    "operator": "eq",
                    "value": True,
                    "description": "no_irreversible_action_without_audit_trail",
                },
                {
                    "field": "scope.expansion_under_unconfirmed_state",
                    "operator": "eq",
                    "value": False,
                    "description": "no_scope_expansion_under_unconfirmed_state",
                },
            ],
        }
        # Dataclass field names use snake_case; map from the DDB camelCase
        # attrs the seed writes.
        return ConstitutionalLayer(
            layer_id=seed_dict["layerId"],
            layer_type=seed_dict["layerType"],
            applies_to=seed_dict["appliesTo"],
            rules=seed_dict["rules"],
        )

    @staticmethod
    def _make_engine(layer):
        from arbiter.governance.engine import GovernanceEngine
        return GovernanceEngine(
            authority_units=[],
            composition_contracts=[],
            case_law=[],
            constitutional_layers=[layer],
        )

    @staticmethod
    def _make_request(ctx):
        from arbiter.governance.models import DispatchRequest
        return DispatchRequest(
            requesting_agent_id="arbiter",
            target_agent_id="worker",
            action_type="invoke_agent",
            domain="*",
            workflow_id="wf-test",
            agent_use_id="use-test",
            context=ctx,
        )

    @staticmethod
    def _make_permit_finding():
        """A stand-in permit for _constitutional_review to override."""
        from arbiter.governance.models import ArbitrationDecision, GovernanceFinding
        return GovernanceFinding(
            workflow_id="wf-test",
            decision=ArbitrationDecision.PERMIT,
            requesting_agent="arbiter",
            target_agent="worker",
            reason="scope_match:arbiter-invoke-all",
            scope_evaluated="arbiter-invoke-all",
        )

    def test_engine_accepts_seed_layer_when_rules_satisfied(self):
        """(a) Context satisfies both rules → _constitutional_review returns None."""
        layer = self._seeded_layer()
        engine = self._make_engine(layer)

        # Both invariants held: audit record produced, no scope expansion.
        request = self._make_request({
            "audit.record_produced": True,
            "scope.expansion_under_unconfirmed_state": False,
        })
        permit = self._make_permit_finding()

        override = engine._constitutional_review(request, permit)
        assert override is None, (
            "engine must not override a permit when all seed rules are satisfied "
            f"— got {override}"
        )

    def test_engine_denies_when_audit_record_missing(self):
        """(b) audit.record_produced=False → DENY finding with preserved scope."""
        from arbiter.governance.models import ArbitrationDecision

        layer = self._seeded_layer()
        engine = self._make_engine(layer)

        # Violates rule 1 (audit.record_produced expected True, got False).
        request = self._make_request({
            "audit.record_produced": False,
            "scope.expansion_under_unconfirmed_state": False,
        })
        permit = self._make_permit_finding()

        override = engine._constitutional_review(request, permit)
        assert override is not None, (
            "engine must override a permit when audit.record_produced is False"
        )
        assert override.decision == ArbitrationDecision.DENY
        # Reason encodes the layer + field so the ledger entry is self-describing.
        assert override.reason == (
            "constitutional_review:global-constitution:"
            "invariant_violated:audit.record_produced"
        )
        # The originating scope is carried through so legibility is preserved.
        assert override.scope_evaluated == "arbiter-invoke-all"


# ---------------------------------------------------------------------------
# Runnable demo echo agent seed
# ---------------------------------------------------------------------------
#
# The seed must register one runnable worker agent (deterministic id
# 'demo-echo-agent', state 'active') whose config carries the S3 module
# filename the worker resolves at dispatch, and upload that module to the
# agent code bucket so it is genuinely reachable.

ECHO_AGENT_ID = "demo-echo-agent"
ECHO_MODULE_FILENAME = "demo_echo_agent.py"
ECHO_MODULE_S3_KEY = f"agents/{ECHO_MODULE_FILENAME}"


def _create_event():
    return {
        "RequestType": "Create",
        "ResponseURL": "https://cfn-response.example.com/callback",
        "StackId": "arn:aws:cloudformation:us-east-1:123456789012:stack/s",
        "RequestId": "req-echo-1",
        "LogicalResourceId": "SeedAgentConfigResource",
    }


def _context():
    return type("Ctx", (), {"log_stream_name": "log-stream-echo"})()


class TestSeedEchoAgent:
    """The seed registers a runnable, active echo worker agent."""

    def _run_create(self, *, bucket=None):
        """Invoke the handler for a Create with boto3 fully mocked.

        Returns (mock_table, mock_s3, seeded_items). ``bucket`` toggles the
        AGENT_BUCKET_NAME env var so the S3-upload branch can be exercised
        both ways.
        """
        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table
        mock_s3 = MagicMock()

        env = {}
        if bucket is not None:
            env["AGENT_BUCKET_NAME"] = bucket

        with patch("index.boto3") as mock_boto3, \
             patch("cfnresponse.send") as mock_send, \
             patch.dict(os.environ, env, clear=False):
            if bucket is None:
                os.environ.pop("AGENT_BUCKET_NAME", None)
            mock_boto3.resource.return_value = mock_dynamodb
            mock_boto3.client.return_value = mock_s3

            from index import handler
            handler(_create_event(), _context())

        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        return mock_table, mock_s3, mock_send, items

    def _echo_item(self, items):
        echo = [i for i in items if i.get("agentId") == ECHO_AGENT_ID]
        assert len(echo) == 1, f"expected exactly one echo agent, got {len(echo)}"
        return echo[0]

    def test_create_seeds_echo_agent_active(self):
        """The echo agent is seeded active with the fields the worker reads."""
        _table, _s3, _send, items = self._run_create(bucket="citadel-code-bucket")
        echo = self._echo_item(items)

        assert echo["state"] == "active"
        assert "config" in echo
        cfg = echo["config"]
        assert cfg["name"] == ECHO_AGENT_ID
        # The S3-key field the worker resolves the runnable module from.
        assert cfg["filename"] == ECHO_MODULE_FILENAME
        assert cfg["action"]["type"] == "sqs"
        assert "schema" in cfg and cfg["schema"]["type"] == "object"
        assert "worker" in echo.get("categories", [])

    def test_echo_module_uploaded_to_code_bucket_when_set(self):
        """When AGENT_BUCKET_NAME is set, the module lands at agents/<filename>."""
        _table, mock_s3, _send, _items = self._run_create(bucket="citadel-code-bucket")

        assert mock_s3.put_object.called, "expected the echo module to be uploaded"
        kwargs = mock_s3.put_object.call_args.kwargs
        assert kwargs["Bucket"] == "citadel-code-bucket"
        assert kwargs["Key"] == ECHO_MODULE_S3_KEY
        # Body must be the real module source exposing a handler.
        body = kwargs["Body"]
        body_text = body.decode() if isinstance(body, (bytes, bytearray)) else str(body)
        assert "def handler" in body_text

    def test_echo_module_upload_skipped_when_bucket_unset(self):
        """No bucket env → skip upload but still seed the config and SUCCESS."""
        _table, mock_s3, mock_send, items = self._run_create(bucket=None)

        assert not mock_s3.put_object.called
        # Config is still seeded so the agent record exists for wiring.
        self._echo_item(items)
        assert mock_send.call_args[0][2] == "SUCCESS"

    def test_echo_agent_seed_is_idempotent(self):
        """Re-running Create yields an identical echo item (deterministic)."""
        _t1, _s1, _snd1, items1 = self._run_create(bucket="citadel-code-bucket")
        _t2, _s2, _snd2, items2 = self._run_create(bucket="citadel-code-bucket")
        assert self._echo_item(items1) == self._echo_item(items2)
