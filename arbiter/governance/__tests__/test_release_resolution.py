"""Tests for arbiter/governance/release_resolution.py.

Covers the read-only (GetItem-only) pointer -> release resolution used by
the release-aware dispatch gate. Three distinct outcomes are asserted
throughout, per the module's fail-closed doctrine:

  * RESOLVED       — pointer + release both found.
  * NO_POINTER     — clean "not configured yet" (table unset, or a GetItem
                      that returns no Item). This is the backward-
                      compatible case: an existing deployment with no
                      pointers/releases must land here, not in
                      LOOKUP_FAILED.
  * LOOKUP_FAILED  — the lookup itself raised (throttle, network,
                      permissions, or a resolved table name that does not
                      exist). Distinct from NO_POINTER because the
                      established doctrine (this codebase's governance
                      layer: design_assessment_gate's env-unset no-op vs.
                      hierarchy.py's SSM-failure-vs-missing-param split) is
                      assert-or-refuse in strict mode: a failed lookup must
                      never be silently treated as "no release, proceed".
"""
from __future__ import annotations

import os
import sys
from typing import Any
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import release_resolution as rr  # noqa: E402
from arbiter.governance.release_resolution import (  # noqa: E402
    ReleaseResolutionStatus,
    resolve_release,
    __reset_clients_for_test,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    __reset_clients_for_test()
    yield
    __reset_clients_for_test()


def _client_error(code: str) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "simulated"}},
        "GetItem",
    )


# ---------------------------------------------------------------------------
# Tables unset -> clean NO_POINTER, zero AWS calls (mirrors
# design_assessment_gate's AGENT_DESIGN_ASSESSMENTS_TABLE-unset no-op).
# ---------------------------------------------------------------------------


def test_no_pointer_table_env_unset_is_no_pointer_with_zero_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ENVIRONMENT_RELEASE_POINTERS_TABLE", raising=False)
    monkeypatch.delenv("AGENT_RELEASES_TABLE", raising=False)

    should_not_be_called = MagicMock()
    monkeypatch.setattr(rr.boto3, "resource", should_not_be_called)

    result = resolve_release(org_id="org-1", agent_target_id="agent-1", environment="PROD")

    assert result.status == ReleaseResolutionStatus.NO_POINTER
    assert result.release is None
    should_not_be_called.assert_not_called()


def test_release_table_env_unset_is_no_pointer_even_if_pointer_table_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backward-compat: a partially-provisioned environment (pointer table
    exists, releases table doesn't — or vice versa) must still degrade to
    NO_POINTER, not crash or fabricate a release."""
    monkeypatch.setenv("ENVIRONMENT_RELEASE_POINTERS_TABLE", "pointers-table")
    monkeypatch.delenv("AGENT_RELEASES_TABLE", raising=False)

    result = resolve_release(org_id="org-1", agent_target_id="agent-1", environment="PROD")

    assert result.status == ReleaseResolutionStatus.NO_POINTER
    assert result.release is None


# ---------------------------------------------------------------------------
# Pointer GetItem returns no Item -> clean NO_POINTER (never queries the
# releases table — nothing to look up).
# ---------------------------------------------------------------------------


def test_pointer_missing_is_no_pointer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT_RELEASE_POINTERS_TABLE", "pointers-table")
    monkeypatch.setenv("AGENT_RELEASES_TABLE", "releases-table")

    pointers_table = MagicMock()
    pointers_table.get_item.return_value = {}  # no 'Item' key
    releases_table = MagicMock()

    def _fake_resource(service_name: str, *a: Any, **kw: Any) -> Any:
        assert service_name == "dynamodb"
        fake = MagicMock()
        fake.Table.side_effect = lambda name: (
            pointers_table if name == "pointers-table" else releases_table
        )
        return fake

    monkeypatch.setattr(rr.boto3, "resource", _fake_resource)

    result = resolve_release(org_id="org-1", agent_target_id="agent-1", environment="PROD")

    assert result.status == ReleaseResolutionStatus.NO_POINTER
    assert result.release is None
    releases_table.get_item.assert_not_called()


# ---------------------------------------------------------------------------
# Pointer found, release found -> RESOLVED.
# ---------------------------------------------------------------------------


def test_pointer_and_release_found_is_resolved(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT_RELEASE_POINTERS_TABLE", "pointers-table")
    monkeypatch.setenv("AGENT_RELEASES_TABLE", "releases-table")

    pointer_item = {
        "orgId": "org-1",
        "agentTargetId_environment": "agent-1#PROD",
        "releaseId": "sha256-abc",
        "version": 3,
    }
    release_item = {"releaseId": "sha256-abc", "orgId": "org-1", "agentTargetId": "agent-1"}

    pointers_table = MagicMock()
    pointers_table.get_item.return_value = {"Item": pointer_item}
    releases_table = MagicMock()
    releases_table.get_item.return_value = {"Item": release_item}

    def _fake_resource(service_name: str, *a: Any, **kw: Any) -> Any:
        fake = MagicMock()
        fake.Table.side_effect = lambda name: (
            pointers_table if name == "pointers-table" else releases_table
        )
        return fake

    monkeypatch.setattr(rr.boto3, "resource", _fake_resource)

    result = resolve_release(org_id="org-1", agent_target_id="agent-1", environment="PROD")

    assert result.status == ReleaseResolutionStatus.RESOLVED
    assert result.release == release_item
    pointers_table.get_item.assert_called_once_with(
        Key={"orgId": "org-1", "agentTargetId_environment": "agent-1#PROD"}
    )
    releases_table.get_item.assert_called_once_with(Key={"releaseId": "sha256-abc"})


# ---------------------------------------------------------------------------
# Pointer found but release row itself missing (dangling pointer) ->
# LOOKUP_FAILED. A pointer that resolves to no release is NOT the clean
# "no release" case (that's NO_POINTER when the POINTER itself is absent);
# it is a data-integrity failure the same way any other lookup failure is
# — the promise of the immutable-release table (release-store.ts: rows are
# create-only, never deleted) means a dangling pointer indicates something
# is wrong with the read path, not a normal "not yet promoted" state.
# ---------------------------------------------------------------------------


def test_pointer_found_but_release_row_missing_is_lookup_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT_RELEASE_POINTERS_TABLE", "pointers-table")
    monkeypatch.setenv("AGENT_RELEASES_TABLE", "releases-table")

    pointer_item = {
        "orgId": "org-1",
        "agentTargetId_environment": "agent-1#PROD",
        "releaseId": "sha256-abc",
        "version": 1,
    }
    pointers_table = MagicMock()
    pointers_table.get_item.return_value = {"Item": pointer_item}
    releases_table = MagicMock()
    releases_table.get_item.return_value = {}  # dangling pointer

    def _fake_resource(service_name: str, *a: Any, **kw: Any) -> Any:
        fake = MagicMock()
        fake.Table.side_effect = lambda name: (
            pointers_table if name == "pointers-table" else releases_table
        )
        return fake

    monkeypatch.setattr(rr.boto3, "resource", _fake_resource)

    result = resolve_release(org_id="org-1", agent_target_id="agent-1", environment="PROD")

    assert result.status == ReleaseResolutionStatus.LOOKUP_FAILED
    assert result.release is None
    assert "dangling" in (result.error or "").lower()


# ---------------------------------------------------------------------------
# The lookup ITSELF fails (throttle / network / missing table) ->
# LOOKUP_FAILED, distinct from a clean NO_POINTER. This is the doctrine
# this task requires: assert-or-refuse, not warn-and-proceed.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "error_code",
    ["ProvisionedThroughputExceededException", "ResourceNotFoundException", "ThrottlingException"],
)
def test_pointer_lookup_raising_is_lookup_failed(
    monkeypatch: pytest.MonkeyPatch, error_code: str
) -> None:
    monkeypatch.setenv("ENVIRONMENT_RELEASE_POINTERS_TABLE", "pointers-table")
    monkeypatch.setenv("AGENT_RELEASES_TABLE", "releases-table")

    pointers_table = MagicMock()
    pointers_table.get_item.side_effect = _client_error(error_code)
    releases_table = MagicMock()

    def _fake_resource(service_name: str, *a: Any, **kw: Any) -> Any:
        fake = MagicMock()
        fake.Table.side_effect = lambda name: (
            pointers_table if name == "pointers-table" else releases_table
        )
        return fake

    monkeypatch.setattr(rr.boto3, "resource", _fake_resource)

    result = resolve_release(org_id="org-1", agent_target_id="agent-1", environment="PROD")

    assert result.status == ReleaseResolutionStatus.LOOKUP_FAILED
    assert result.release is None
    assert result.error is not None
    releases_table.get_item.assert_not_called()


def test_release_lookup_raising_after_pointer_found_is_lookup_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT_RELEASE_POINTERS_TABLE", "pointers-table")
    monkeypatch.setenv("AGENT_RELEASES_TABLE", "releases-table")

    pointer_item = {
        "orgId": "org-1",
        "agentTargetId_environment": "agent-1#PROD",
        "releaseId": "sha256-abc",
        "version": 1,
    }
    pointers_table = MagicMock()
    pointers_table.get_item.return_value = {"Item": pointer_item}
    releases_table = MagicMock()
    releases_table.get_item.side_effect = _client_error("InternalServerError")

    def _fake_resource(service_name: str, *a: Any, **kw: Any) -> Any:
        fake = MagicMock()
        fake.Table.side_effect = lambda name: (
            pointers_table if name == "pointers-table" else releases_table
        )
        return fake

    monkeypatch.setattr(rr.boto3, "resource", _fake_resource)

    result = resolve_release(org_id="org-1", agent_target_id="agent-1", environment="PROD")

    assert result.status == ReleaseResolutionStatus.LOOKUP_FAILED
    assert result.release is None


def test_unexpected_exception_type_is_also_lookup_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Not just ClientError — any exception from the lookup path (e.g. a
    malformed response causing a KeyError/TypeError) must resolve to
    LOOKUP_FAILED, never propagate and never silently become NO_POINTER."""
    monkeypatch.setenv("ENVIRONMENT_RELEASE_POINTERS_TABLE", "pointers-table")
    monkeypatch.setenv("AGENT_RELEASES_TABLE", "releases-table")

    pointers_table = MagicMock()
    pointers_table.get_item.side_effect = TypeError("simulated malformed response")
    releases_table = MagicMock()

    def _fake_resource(service_name: str, *a: Any, **kw: Any) -> Any:
        fake = MagicMock()
        fake.Table.side_effect = lambda name: (
            pointers_table if name == "pointers-table" else releases_table
        )
        return fake

    monkeypatch.setattr(rr.boto3, "resource", _fake_resource)

    result = resolve_release(org_id="org-1", agent_target_id="agent-1", environment="PROD")

    assert result.status == ReleaseResolutionStatus.LOOKUP_FAILED
