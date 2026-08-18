"""Tests for the canary arm selection in
``arbiter/governance/release_resolution.py`` (decision D2, attribution-only).

Verifies that ``resolve_release``:
  * resolves the CANDIDATE release when a server-minted stickiness key
    hashes below the canary threshold, and the STABLE release otherwise;
  * is byte-identically backward-compatible when the pointer has no
    canary (arm="stable", resolved_release_id == stable releaseId);
  * degrades to the stable arm when no stickiness key is threaded, or the
    canary object is malformed — never routing everyone to the candidate;
  * treats a dangling CANDIDATE release as LOOKUP_FAILED, same doctrine as
    a dangling stable pointer.

Bucket values used below are the same fixture-verified digests as
``canary-assignment-parity-cases.json``: under salt "salt-A", key
"orch-42" -> bucket 1817, so percent 5000 -> candidate, percent 1000 ->
stable.
"""
from __future__ import annotations

import os
import sys
from typing import Any
from unittest.mock import MagicMock

import pytest

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import release_resolution as rr  # noqa: E402
from arbiter.governance.release_resolution import (  # noqa: E402
    ReleaseResolutionStatus,
    __reset_clients_for_test,
    resolve_release,
)


@pytest.fixture(autouse=True)
def _reset() -> None:
    __reset_clients_for_test()
    yield
    __reset_clients_for_test()


def _wire(
    monkeypatch: pytest.MonkeyPatch,
    pointer_item: dict | None,
    releases: dict[str, dict],
) -> tuple[MagicMock, MagicMock]:
    monkeypatch.setenv("ENVIRONMENT_RELEASE_POINTERS_TABLE", "pointers-table")
    monkeypatch.setenv("AGENT_RELEASES_TABLE", "releases-table")

    pointers_table = MagicMock()
    pointers_table.get_item.return_value = (
        {"Item": pointer_item} if pointer_item is not None else {}
    )
    releases_table = MagicMock()

    def _release_get(Key: dict) -> dict:
        rid = Key["releaseId"]
        return {"Item": releases[rid]} if rid in releases else {}

    releases_table.get_item.side_effect = _release_get

    def _fake_resource(service_name: str, *a: Any, **kw: Any) -> Any:
        assert service_name == "dynamodb"
        fake = MagicMock()
        fake.Table.side_effect = lambda name: (
            pointers_table if name == "pointers-table" else releases_table
        )
        return fake

    monkeypatch.setattr(rr.boto3, "resource", _fake_resource)
    return pointers_table, releases_table


def _canary_pointer(percent: int) -> dict:
    return {
        "orgId": "org-1",
        "agentTargetId_environment": "agent-1#PROD",
        "releaseId": "rel-stable",
        "canary": {
            "candidateReleaseId": "rel-candidate",
            "percentBasisPoints": percent,
            "salt": "salt-A",
            "stickiness": "conversation",
        },
    }


def test_canary_key_below_threshold_resolves_candidate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _wire(
        monkeypatch,
        _canary_pointer(5000),  # orch-42 bucket 1817 < 5000 -> candidate
        {"rel-stable": {"releaseId": "rel-stable"}, "rel-candidate": {"releaseId": "rel-candidate"}},
    )
    result = resolve_release(
        org_id="org-1",
        agent_target_id="agent-1",
        environment="PROD",
        stickiness_key="orch-42",
    )
    assert result.status == ReleaseResolutionStatus.RESOLVED
    assert result.arm == "candidate"
    assert result.resolved_release_id == "rel-candidate"
    assert result.release == {"releaseId": "rel-candidate"}


def test_canary_key_above_threshold_resolves_stable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _wire(
        monkeypatch,
        _canary_pointer(1000),  # orch-42 bucket 1817 >= 1000 -> stable
        {"rel-stable": {"releaseId": "rel-stable"}, "rel-candidate": {"releaseId": "rel-candidate"}},
    )
    result = resolve_release(
        org_id="org-1",
        agent_target_id="agent-1",
        environment="PROD",
        stickiness_key="orch-42",
    )
    assert result.status == ReleaseResolutionStatus.RESOLVED
    assert result.arm == "stable"
    assert result.resolved_release_id == "rel-stable"


def test_canary_present_but_no_stickiness_key_resolves_stable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _wire(
        monkeypatch,
        _canary_pointer(5000),
        {"rel-stable": {"releaseId": "rel-stable"}},
    )
    # No key threaded -> safe stable arm, never candidate.
    result = resolve_release(
        org_id="org-1", agent_target_id="agent-1", environment="PROD"
    )
    assert result.status == ReleaseResolutionStatus.RESOLVED
    assert result.arm == "stable"
    assert result.resolved_release_id == "rel-stable"


def test_no_canary_is_backward_compatible_stable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pointer = {
        "orgId": "org-1",
        "agentTargetId_environment": "agent-1#PROD",
        "releaseId": "rel-stable",
    }
    _wire(monkeypatch, pointer, {"rel-stable": {"releaseId": "rel-stable"}})
    result = resolve_release(
        org_id="org-1",
        agent_target_id="agent-1",
        environment="PROD",
        stickiness_key="orch-42",
    )
    assert result.status == ReleaseResolutionStatus.RESOLVED
    assert result.arm == "stable"
    assert result.resolved_release_id == "rel-stable"


def test_dangling_candidate_is_lookup_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _wire(
        monkeypatch,
        _canary_pointer(5000),  # -> candidate arm
        {"rel-stable": {"releaseId": "rel-stable"}},  # candidate row MISSING
    )
    result = resolve_release(
        org_id="org-1",
        agent_target_id="agent-1",
        environment="PROD",
        stickiness_key="orch-42",
    )
    assert result.status == ReleaseResolutionStatus.LOOKUP_FAILED


def test_malformed_canary_degrades_to_stable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pointer = {
        "orgId": "org-1",
        "agentTargetId_environment": "agent-1#PROD",
        "releaseId": "rel-stable",
        "canary": {"candidateReleaseId": "rel-candidate"},  # missing salt/percent
    }
    _wire(monkeypatch, pointer, {"rel-stable": {"releaseId": "rel-stable"}})
    result = resolve_release(
        org_id="org-1",
        agent_target_id="agent-1",
        environment="PROD",
        stickiness_key="orch-42",
    )
    assert result.status == ReleaseResolutionStatus.RESOLVED
    assert result.arm == "stable"
    assert result.resolved_release_id == "rel-stable"
