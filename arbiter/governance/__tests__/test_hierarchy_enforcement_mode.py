"""Tests for governance enforcement-mode resolution in hierarchy.py.

Covers the SSM-backed ``_resolve_enforcement_mode`` helper and its wiring
into ``GovernanceState.enforcement_mode`` via ``load_governance_state``.
The parameter path (``/citadel/governance/enforce/{ENVIRONMENT}``) mirrors
the TypeScript reader in ``backend/src/utils/governance-flag.ts`` so both
runtimes observe one persisted control surface.
"""
from __future__ import annotations

import logging
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


def _install_fake_ssm(monkeypatch: pytest.MonkeyPatch, value: str | None) -> MagicMock:
    """Patch boto3.client('ssm') to return ``value`` for GetParameter."""
    fake_client = MagicMock()
    if value is None:
        fake_client.get_parameter.side_effect = Exception("ParameterNotFound (simulated)")
    else:
        fake_client.get_parameter.return_value = {"Parameter": {"Value": value}}

    def _client(service_name: str, *a: Any, **kw: Any) -> Any:
        assert service_name == "ssm"
        return fake_client

    monkeypatch.setattr(hierarchy.boto3, "client", _client)
    return fake_client


def _stub_ddb_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """No DDB tables configured -> hierarchy loaders return empty lists fast."""
    for name in (
        "AUTHORITY_UNITS_TABLE",
        "COMPOSITION_CONTRACTS_TABLE",
        "CASE_LAW_TABLE",
        "CONSTITUTIONAL_LAYERS_TABLE",
    ):
        monkeypatch.delenv(name, raising=False)


# ---------------------------------------------------------------------------
# ENVIRONMENT unset -> no SSM call at all, default 'shadow'
# ---------------------------------------------------------------------------


def test_no_environment_var_skips_ssm_and_defaults_shadow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    _stub_ddb_empty(monkeypatch)

    def _should_not_call(service_name: str, *a: Any, **kw: Any) -> Any:
        raise AssertionError("boto3.client('ssm') must not be called when ENVIRONMENT is unset")

    monkeypatch.setattr(hierarchy.boto3, "client", _should_not_call)

    state = load_governance_state()

    assert state.enforcement_mode == "shadow"


# ---------------------------------------------------------------------------
# Valid SSM values map through unchanged
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["permissive", "shadow", "strict"])
def test_valid_ssm_value_is_used_directly(
    monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test-env")
    _stub_ddb_empty(monkeypatch)
    fake_client = _install_fake_ssm(monkeypatch, mode)

    state = load_governance_state()

    assert state.enforcement_mode == mode
    fake_client.get_parameter.assert_called_once_with(
        Name="/citadel/governance/enforce/test-env"
    )


# ---------------------------------------------------------------------------
# Invalid / unresolvable values default to shadow, with a warning logged
# ---------------------------------------------------------------------------


def test_invalid_ssm_value_defaults_to_shadow_with_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test-env")
    _stub_ddb_empty(monkeypatch)
    _install_fake_ssm(monkeypatch, "not-a-real-mode")

    with caplog.at_level(logging.WARNING, logger=hierarchy.logger.name):
        state = load_governance_state()

    assert state.enforcement_mode == "shadow"
    assert any(
        "unresolvable" in r.getMessage().lower() for r in caplog.records
    )


def test_ssm_failure_defaults_to_shadow_with_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test-env")
    _stub_ddb_empty(monkeypatch)
    _install_fake_ssm(monkeypatch, None)  # raises inside get_parameter

    with caplog.at_level(logging.WARNING, logger=hierarchy.logger.name):
        state = load_governance_state()

    assert state.enforcement_mode == "shadow"
    assert any(
        "failed to resolve" in r.getMessage().lower() for r in caplog.records
    )


# ---------------------------------------------------------------------------
# Caching: second call within TTL does not re-query SSM
# ---------------------------------------------------------------------------


def test_mode_is_cached_within_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test-env")
    _stub_ddb_empty(monkeypatch)
    fake_client = _install_fake_ssm(monkeypatch, "strict")

    load_governance_state()
    load_governance_state()  # cache hit on both DDB state and mode

    assert fake_client.get_parameter.call_count == 1


def test_explicit_force_reload_also_refreshes_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """force_reload=True is an explicit request for fresh everything,
    including the enforcement mode — not just the four DDB tables."""
    monkeypatch.setenv("ENVIRONMENT", "test-env")
    _stub_ddb_empty(monkeypatch)
    fake_client = _install_fake_ssm(monkeypatch, "strict")

    load_governance_state(force_reload=True)
    load_governance_state(force_reload=True)

    assert fake_client.get_parameter.call_count == 2


def test_force_reload_refreshes_mode_after_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test-env")
    _stub_ddb_empty(monkeypatch)
    fake_client = _install_fake_ssm(monkeypatch, "strict")

    fake_now = [1000.0]
    monkeypatch.setattr(hierarchy.time, "time", lambda: fake_now[0])

    load_governance_state()
    assert fake_client.get_parameter.call_count == 1

    fake_now[0] = 1000.0 + hierarchy._MODE_CACHE_TTL_SECONDS + 1
    load_governance_state(force_reload=True)
    assert fake_client.get_parameter.call_count == 2
