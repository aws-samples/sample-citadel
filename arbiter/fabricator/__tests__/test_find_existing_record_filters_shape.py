"""Validates _find_existing_record_id sends correct ListRegistryRecords kwargs.

Strategy: validate the kwargs the function builds against the REAL botocore
service model via ``botocore.validate.ParamValidator`` (independent of the
code), plus a Stubber happy-path round-trip.  A scratch-copy section proves
the test bites by asserting BOTH wrong shapes are rejected by the real model
validator.

Service identity note: the runtime code uses ``boto3.client('agent-registry-
control')`` — that is the service name whose model defines ``filters`` on
ListRegistryRecords.  ``bedrock-agentcore-control`` is a different service
with a different ListRegistryRecords shape (top-level ``name``); tests must
use ``agent-registry-control`` to match runtime.
"""

import os
import sys

import pytest
import botocore.session
from botocore.stub import Stubber
from botocore.validate import ParamValidator

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

import index  # noqa: E402


REGISTRY_ID = "fake-registry-id"
AGENT_NAME = "escalation_router"

# Must match the service the runtime code constructs via
# ``boto3.client('agent-registry-control')``.
_SERVICE_NAME = "agent-registry-control"

# ---------------------------------------------------------------------------
# Helpers: resolve the real service model once
# ---------------------------------------------------------------------------

_botocore_session = botocore.session.get_session()
_service_model = _botocore_session.get_service_model(_SERVICE_NAME)
_op_model = _service_model.operation_model("ListRegistryRecords")
_input_shape = _op_model.input_shape
_validator = ParamValidator()


def _validate_kwargs(kwargs: dict) -> list:
    """Return a list of validation error strings (empty == valid)."""
    report = _validator.validate(kwargs, _input_shape)
    return report.generate_report().split("\n") if report.has_errors() else []


def _stubbed_client():
    """Create a real botocore client + Stubber for shape validation."""
    session = botocore.session.get_session()
    client = session.create_client(_SERVICE_NAME, region_name="us-west-2")
    stubber = Stubber(client)
    return client, stubber


# Minimal valid response record for the output shape (Stubber validates it).
def _record(record_id: str, display_name: str) -> dict:
    return {
        "registryArn": f"arn:aws:bedrock-agentcore:us-west-2:123456789012:registry/{REGISTRY_ID}",
        "recordArn": f"arn:aws:bedrock-agentcore:us-west-2:123456789012:registry/{REGISTRY_ID}/record/{record_id}",
        "recordId": record_id,
        "name": display_name,
        "displayName": display_name,
        "recordType": "CUSTOM",
        "recordVersion": "1",
        "status": "APPROVED",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
    }


# ---------------------------------------------------------------------------
# 1. Prove the FIXED code builds valid kwargs
# ---------------------------------------------------------------------------


class TestFixedKwargsAreValid:
    """Build the kwargs exactly as the fixed _find_existing_record_id does
    and validate them against the real botocore model."""

    def test_kwargs_pass_model_validation(self):
        kwargs = {
            "registryId": REGISTRY_ID,
            "filters": [
                {"name": "recordType", "values": ["CUSTOM"]},
                {"name": "name", "values": [AGENT_NAME]},
            ],
            "maxResults": 100,
        }
        errors = _validate_kwargs(kwargs)
        assert errors == [], f"Model validation errors: {errors}"


# ---------------------------------------------------------------------------
# 2. Prove BOTH wrong shapes are REJECTED by the real model validator
# ---------------------------------------------------------------------------


class TestWrongShapesAreRejected:
    """Scratch-copy validation: the test must bite on both historic bugs."""

    def test_key_entries_shape_rejected(self):
        """Original bug: filter entries used {key, values} not {name, values}."""
        kwargs = {
            "registryId": REGISTRY_ID,
            "filters": [
                {"key": "recordType", "values": ["CUSTOM"]},
                {"key": "displayName", "values": [AGENT_NAME]},
            ],
            "maxResults": 100,
        }
        errors = _validate_kwargs(kwargs)
        assert len(errors) > 0, "Expected validation to reject {key, values} filter entries"

    def test_top_level_name_rejected(self):
        """Second bug: name passed as top-level kwarg, not inside filters."""
        kwargs = {
            "registryId": REGISTRY_ID,
            "name": AGENT_NAME,
        }
        errors = _validate_kwargs(kwargs)
        assert len(errors) > 0, "Expected validation to reject top-level 'name' param"


# ---------------------------------------------------------------------------
# 3. Stubber happy-path: _find_existing_record_id returns the matched recordId
# ---------------------------------------------------------------------------


class TestFindExistingRecordIdHappyPath:
    """End-to-end with Stubber: the function calls the API with valid kwargs
    and returns the matched recordId from the response."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        index._reset_registry_client_for_test()
        yield
        index._reset_registry_client_for_test()

    def test_returns_record_id_on_match(self):
        client, stubber = _stubbed_client()
        response = {"registryRecords": [_record("rptXf951FL9C", AGENT_NAME)]}
        stubber.add_response("list_registry_records", response)
        stubber.activate()

        index._registry_client = client
        result = index._find_existing_record_id(REGISTRY_ID, AGENT_NAME)
        assert result == "rptXf951FL9C"
        stubber.assert_no_pending_responses()

    def test_returns_none_when_no_match(self):
        client, stubber = _stubbed_client()
        response = {"registryRecords": []}
        stubber.add_response("list_registry_records", response)
        stubber.activate()

        index._registry_client = client
        result = index._find_existing_record_id(REGISTRY_ID, AGENT_NAME)
        assert result is None
        stubber.assert_no_pending_responses()

    def test_returns_none_when_name_mismatch(self):
        """Filter may be prefix/substring — exact match is enforced in code."""
        client, stubber = _stubbed_client()
        response = {"registryRecords": [_record("rptOTHER1234", "escalation_router_v2")]}
        stubber.add_response("list_registry_records", response)
        stubber.activate()

        index._registry_client = client
        result = index._find_existing_record_id(REGISTRY_ID, AGENT_NAME)
        assert result is None
        stubber.assert_no_pending_responses()
