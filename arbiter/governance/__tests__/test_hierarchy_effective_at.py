"""Tests for governance effective_at resolution in hierarchy.py.

Covers the SSM-backed ``_resolve_effective_at`` helper and its wiring into
``GovernanceState.effective_at`` via ``load_governance_state``. Mirrors
``_resolve_enforcement_mode``'s existing test shape and cache discipline —
this is the second of the two parameters ``backend/src/utils/
governance-flag.ts`` reads (``enforce`` was ported first; this ports
``effective_at``), read from the same parameter path
(``/citadel/governance/effective_at/{ENVIRONMENT}``).
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

from arbiter.governance import hierarchy  # noqa: E402
from arbiter.governance.hierarchy import (  # noqa: E402
    load_governance_state,
    __reset_hierarchy_cache_for_test,
    __reset_mode_cache_for_test,
)


@pytest.fixture(autouse=True)
def _reset_caches() -> None:
    __reset_hierarchy_cache_for_test()
    __reset_mode_cache_for_test()
    yield
    __reset_hierarchy_cache_for_test()
    __reset_mode_cache_for_test()


def _install_fake_ssm(
    monkeypatch: pytest.MonkeyPatch,
    enforce_value: str | None,
    effective_at_value: str | None,
    *,
    effective_at_raises: bool = False,
) -> MagicMock:
    """Patch boto3.client('ssm') to answer both GetParameter calls."""
    fake_client = MagicMock()

    def _get_parameter(Name: str, **_kw: Any) -> Any:
        if Name.startswith("/citadel/governance/enforce/"):
            if enforce_value is None:
                raise Exception("ParameterNotFound (simulated)")
            return {"Parameter": {"Value": enforce_value}}
        if Name.startswith("/citadel/governance/effective_at/"):
            if effective_at_raises:
                raise Exception("ParameterNotFound (simulated)")
            return {"Parameter": {"Value": effective_at_value}}
        raise AssertionError(f"unexpected parameter name: {Name}")

    fake_client.get_parameter.side_effect = _get_parameter

    def _client(service_name: str, *a: Any, **kw: Any) -> Any:
        assert service_name == "ssm"
        return fake_client

    monkeypatch.setattr(hierarchy.boto3, "client", _client)
    return fake_client


def _stub_ddb_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "AUTHORITY_UNITS_TABLE",
        "COMPOSITION_CONTRACTS_TABLE",
        "CASE_LAW_TABLE",
        "CONSTITUTIONAL_LAYERS_TABLE",
    ):
        monkeypatch.delenv(name, raising=False)


def test_no_environment_var_skips_ssm_and_defaults_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    _stub_ddb_empty(monkeypatch)

    def _should_not_call(service_name: str, *a: Any, **kw: Any) -> Any:
        raise AssertionError("boto3.client('ssm') must not be called when ENVIRONMENT is unset")

    monkeypatch.setattr(hierarchy.boto3, "client", _should_not_call)

    state = load_governance_state()

    assert state.effective_at is None


def test_valid_effective_at_value_is_used_directly(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test-env")
    _stub_ddb_empty(monkeypatch)
    fake_client = _install_fake_ssm(monkeypatch, "shadow", "2026-05-15T00:00:00Z")

    state = load_governance_state()

    assert state.effective_at == "2026-05-15T00:00:00Z"
    fake_client.get_parameter.assert_any_call(
        Name="/citadel/governance/effective_at/test-env"
    )


def test_empty_string_effective_at_normalizes_to_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test-env")
    _stub_ddb_empty(monkeypatch)
    _install_fake_ssm(monkeypatch, "shadow", "")

    state = load_governance_state()

    assert state.effective_at is None


def test_missing_effective_at_param_defaults_to_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test-env")
    _stub_ddb_empty(monkeypatch)
    _install_fake_ssm(monkeypatch, "shadow", None, effective_at_raises=True)

    state = load_governance_state()

    assert state.effective_at is None


def test_effective_at_is_cached_within_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test-env")
    _stub_ddb_empty(monkeypatch)
    fake_client = _install_fake_ssm(monkeypatch, "strict", "2026-05-15T00:00:00Z")

    load_governance_state()
    load_governance_state()

    # One enforce + one effective_at call per resolution, cached on the
    # second load_governance_state() call.
    assert fake_client.get_parameter.call_count == 2
