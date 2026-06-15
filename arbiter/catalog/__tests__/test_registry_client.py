"""Tests for arbiter/catalog/registry_client.py (P1-T6).

Validates the read-only AgentCore Registry client. Covers all three
public functions (``get_agent_record``, ``get_source_project_id``,
``list_agent_records``) plus the lazy-client pattern (QB-013-1): no
boto3 construction at import time; the client cache must reset
between tests.

Contract reminder
-----------------
Per the module docstring, the client catches ``ClientError`` only.
Other exceptions (``RuntimeError``, ``ValueError`` etc.) are allowed
to propagate — the contract says "return None / [] on failure and
log a warning" where failure is defined as an AWS API error, not a
programmer bug. See ``test_get_agent_record_non_client_error_propagates``
for the explicit guardrail.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

# Make the catalog module importable as a top-level module, mirroring the
# pattern used in sibling arbiter test files (see fabricator/__tests__).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import registry_client  # noqa: E402
from registry_client import (  # noqa: E402
    get_agent_record,
    get_source_project_id,
    list_agent_records,
)


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_registry_client():
    """Reset the module-global boto3 cache around every test (QB-013-1).

    The module caches the boto3 client in ``_client`` after first use.
    Tests patch ``_get_client`` so the cache should never populate, but
    we reset defensively either side of each test.
    """
    registry_client.__reset_client_for_test()
    yield
    registry_client.__reset_client_for_test()


def _make_client_error(
    code: str = "ResourceNotFoundException",
    op: str = "GetRegistryRecord",
) -> ClientError:
    return ClientError(
        error_response={"Error": {"Code": code, "Message": f"{code} from test"}},
        operation_name=op,
    )


def _sample_get_response() -> dict[str, Any]:
    return {
        "recordId": "rec-1",
        "name": "orchestrator",
        "description": "primary supervisor",
        "status": "APPROVED",
        "customDescriptorContent": '{"sourceProjectId":"proj-9"}',
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-02-01T00:00:00Z",
        # Extra keys the AWS SDK may return; the client must NOT leak them.
        "ResponseMetadata": {"HTTPStatusCode": 200},
    }


# ---------------------------------------------------------------------------
# Lazy-client invariants (QB-013-1)
# ---------------------------------------------------------------------------


def test_get_client_is_cached_across_calls() -> None:
    """Two calls to ``_get_client()`` must yield the same boto3 instance.

    Guards the documented caching behaviour in the module docstring so
    Lambda cold-start cost is paid at most once per container.
    """
    c1 = registry_client._get_client()
    c2 = registry_client._get_client()
    assert c1 is c2


def test_reset_client_for_test_forces_rebuild() -> None:
    """``__reset_client_for_test`` must zero the cache so the next call
    constructs a fresh client — otherwise the autouse fixture is a lie.
    """
    c1 = registry_client._get_client()
    registry_client.__reset_client_for_test()
    assert registry_client._client is None
    c2 = registry_client._get_client()
    # Under the arbiter conftest's MagicMock stub, each boto3.client(...)
    # call yields a distinct MagicMock instance, so post-reset rebuild
    # must produce a different object.
    assert c1 is not c2


# ---------------------------------------------------------------------------
# get_agent_record
# ---------------------------------------------------------------------------


def test_get_agent_record_success_returns_all_seven_keys() -> None:
    fake = MagicMock()
    fake.get_registry_record.return_value = _sample_get_response()
    with patch.object(registry_client, "_get_client", return_value=fake):
        result = get_agent_record("reg-1", "rec-1")
    assert result is not None
    assert set(result.keys()) == {
        "recordId",
        "name",
        "description",
        "status",
        "customDescriptorContent",
        "createdAt",
        "updatedAt",
    }
    assert result["recordId"] == "rec-1"
    assert result["name"] == "orchestrator"
    assert result["status"] == "APPROVED"
    assert result["customDescriptorContent"] == '{"sourceProjectId":"proj-9"}'
    # Kwargs forwarded verbatim to the SDK.
    fake.get_registry_record.assert_called_once_with(
        registryId="reg-1",
        recordId="rec-1",
    )


def test_get_agent_record_client_error_returns_none_and_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    fake = MagicMock()
    fake.get_registry_record.side_effect = _make_client_error()
    caplog.set_level(logging.WARNING, logger="registry_client")
    with patch.object(registry_client, "_get_client", return_value=fake):
        result = get_agent_record("reg-1", "rec-missing")
    assert result is None
    assert any(
        "Registry get_registry_record failed" in rec.message
        for rec in caplog.records
    ), "ClientError must be surfaced via a WARNING log line"


def test_get_agent_record_non_client_error_propagates() -> None:
    """Documented contract: only ``ClientError`` is caught.

    Arbitrary exceptions (RuntimeError, ValueError, TimeoutError …)
    represent programmer bugs or infrastructure issues callers did not
    sign up to silently swallow, so they must bubble out. This test
    pins that behaviour so a future refactor to ``except Exception``
    fails loudly.
    """
    fake = MagicMock()
    fake.get_registry_record.side_effect = RuntimeError("unexpected bug")
    with patch.object(registry_client, "_get_client", return_value=fake):
        with pytest.raises(RuntimeError, match="unexpected bug"):
            get_agent_record("reg-1", "rec-1")


def test_get_agent_record_missing_response_keys_default_to_none() -> None:
    """AWS may omit optional fields; the client still returns a dict
    with all seven keys, each defaulting to ``None``."""
    fake = MagicMock()
    fake.get_registry_record.return_value = {"recordId": "rec-only"}
    with patch.object(registry_client, "_get_client", return_value=fake):
        result = get_agent_record("reg-1", "rec-only")
    assert result is not None
    assert result["recordId"] == "rec-only"
    assert result["name"] is None
    assert result["customDescriptorContent"] is None
    assert result["createdAt"] is None


# ---------------------------------------------------------------------------
# get_source_project_id
# ---------------------------------------------------------------------------


def test_get_source_project_id_happy_path() -> None:
    fake = MagicMock()
    fake.get_registry_record.return_value = {
        "recordId": "rec-1",
        "customDescriptorContent": '{"sourceProjectId":"proj-1"}',
    }
    with patch.object(registry_client, "_get_client", return_value=fake):
        assert get_source_project_id("reg-1", "rec-1") == "proj-1"


def test_get_source_project_id_malformed_json_returns_none(
    caplog: pytest.LogCaptureFixture,
) -> None:
    fake = MagicMock()
    fake.get_registry_record.return_value = {
        "recordId": "rec-1",
        "customDescriptorContent": "{not-valid-json",
    }
    caplog.set_level(logging.WARNING, logger="registry_client")
    with patch.object(registry_client, "_get_client", return_value=fake):
        assert get_source_project_id("reg-1", "rec-1") is None
    assert any(
        "Malformed customDescriptorContent" in rec.message
        for rec in caplog.records
    )


def test_get_source_project_id_when_record_lookup_failed() -> None:
    """If the underlying record fetch returns None (ClientError path),
    the source-project lookup must return None too — no further
    parsing is attempted."""
    fake = MagicMock()
    fake.get_registry_record.side_effect = _make_client_error()
    with patch.object(registry_client, "_get_client", return_value=fake):
        assert get_source_project_id("reg-1", "rec-1") is None


def test_get_source_project_id_when_custom_descriptor_missing() -> None:
    fake = MagicMock()
    fake.get_registry_record.return_value = {"recordId": "rec-1"}
    with patch.object(registry_client, "_get_client", return_value=fake):
        assert get_source_project_id("reg-1", "rec-1") is None


def test_get_source_project_id_when_custom_descriptor_empty_string() -> None:
    fake = MagicMock()
    fake.get_registry_record.return_value = {
        "recordId": "rec-1",
        "customDescriptorContent": "",
    }
    with patch.object(registry_client, "_get_client", return_value=fake):
        assert get_source_project_id("reg-1", "rec-1") is None


def test_get_source_project_id_non_string_value_returns_none() -> None:
    """JSON parses successfully but sourceProjectId is an int — reject."""
    fake = MagicMock()
    fake.get_registry_record.return_value = {
        "recordId": "rec-1",
        "customDescriptorContent": '{"sourceProjectId": 42}',
    }
    with patch.object(registry_client, "_get_client", return_value=fake):
        assert get_source_project_id("reg-1", "rec-1") is None


def test_get_source_project_id_parsed_non_dict_returns_none() -> None:
    """JSON that parses to a list / scalar cannot carry a sourceProjectId
    key, so the client must return None rather than raise AttributeError."""
    fake = MagicMock()
    fake.get_registry_record.return_value = {
        "recordId": "rec-1",
        "customDescriptorContent": '["sourceProjectId", "proj-1"]',
    }
    with patch.object(registry_client, "_get_client", return_value=fake):
        assert get_source_project_id("reg-1", "rec-1") is None


# ---------------------------------------------------------------------------
# list_agent_records
# ---------------------------------------------------------------------------


def test_list_agent_records_single_page() -> None:
    fake = MagicMock()
    fake.list_registry_records.return_value = {
        "records": [
            {"recordId": "a", "name": "A", "status": "APPROVED", "updatedAt": "t1"},
            {"recordId": "b", "name": "B", "status": "APPROVED", "updatedAt": "t2"},
        ],
    }
    with patch.object(registry_client, "_get_client", return_value=fake):
        result = list_agent_records("reg-1")
    assert [r["recordId"] for r in result] == ["a", "b"]
    fake.list_registry_records.assert_called_once_with(registryId="reg-1")


def test_list_agent_records_paginated_two_pages_returns_union() -> None:
    fake = MagicMock()
    fake.list_registry_records.side_effect = [
        {
            "records": [
                {"recordId": "a", "name": "A", "status": "APPROVED", "updatedAt": "t1"},
            ],
            "nextToken": "tok-1",
        },
        {
            "records": [
                {"recordId": "b", "name": "B", "status": "APPROVED", "updatedAt": "t2"},
            ],
        },
    ]
    with patch.object(registry_client, "_get_client", return_value=fake):
        result = list_agent_records("reg-1")
    assert [r["recordId"] for r in result] == ["a", "b"]
    assert fake.list_registry_records.call_count == 2
    # First call has no nextToken; second carries the one from page 1.
    first_call = fake.list_registry_records.call_args_list[0]
    second_call = fake.list_registry_records.call_args_list[1]
    assert "nextToken" not in first_call.kwargs
    assert second_call.kwargs.get("nextToken") == "tok-1"


def test_list_agent_records_filter_status_excludes_other_statuses() -> None:
    fake = MagicMock()
    fake.list_registry_records.return_value = {
        "records": [
            {"recordId": "a", "name": "A", "status": "APPROVED", "updatedAt": "t1"},
            {"recordId": "b", "name": "B", "status": "DRAFT", "updatedAt": "t2"},
            {"recordId": "c", "name": "C", "status": "APPROVED", "updatedAt": "t3"},
        ],
    }
    with patch.object(registry_client, "_get_client", return_value=fake):
        result = list_agent_records("reg-1", filter_status="APPROVED")
    assert [r["recordId"] for r in result] == ["a", "c"]
    assert all(r["status"] == "APPROVED" for r in result)


def test_list_agent_records_no_filter_includes_all_statuses() -> None:
    fake = MagicMock()
    fake.list_registry_records.return_value = {
        "records": [
            {"recordId": "a", "status": "APPROVED"},
            {"recordId": "b", "status": "DRAFT"},
        ],
    }
    with patch.object(registry_client, "_get_client", return_value=fake):
        result = list_agent_records("reg-1")
    assert {r["recordId"] for r in result} == {"a", "b"}


def test_list_agent_records_client_error_returns_empty_list(
    caplog: pytest.LogCaptureFixture,
) -> None:
    fake = MagicMock()
    fake.list_registry_records.side_effect = _make_client_error(
        code="AccessDeniedException",
        op="ListRegistryRecords",
    )
    caplog.set_level(logging.WARNING, logger="registry_client")
    with patch.object(registry_client, "_get_client", return_value=fake):
        assert list_agent_records("reg-1") == []
    assert any(
        "Registry list_registry_records failed" in rec.message
        for rec in caplog.records
    )


# ---------------------------------------------------------------------------
# Property test (Hypothesis) — matches the arbiter suite convention.
# ---------------------------------------------------------------------------


# Printable-ASCII identifiers of bounded length. Mirrors the strategy
# used in sibling property tests (e.g. test_fabricator_app_id_properties).
_identifier = st.text(
    alphabet=st.characters(min_codepoint=33, max_codepoint=126),
    min_size=1,
    max_size=64,
)


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(registry_id=_identifier, record_id=_identifier)
def test_property_registry_and_record_ids_round_trip(
    registry_id: str,
    record_id: str,
) -> None:
    """For arbitrary printable-ASCII identifiers, the client forwards
    them verbatim as kwargs and returns a dict whose ``recordId`` echoes
    what the fake AWS response supplied. Guards against accidental
    string munging (case-folding, trimming, URL-encoding) in the
    wrapper layer.
    """
    registry_client.__reset_client_for_test()
    fake = MagicMock()
    fake.get_registry_record.return_value = {
        "recordId": record_id,
        "name": "any",
        "description": "any",
        "status": "APPROVED",
        "customDescriptorContent": None,
        "createdAt": "t",
        "updatedAt": "t",
    }
    with patch.object(registry_client, "_get_client", return_value=fake):
        result = get_agent_record(registry_id, record_id)
    assert result is not None
    assert result["recordId"] == record_id
    fake.get_registry_record.assert_called_once_with(
        registryId=registry_id,
        recordId=record_id,
    )
