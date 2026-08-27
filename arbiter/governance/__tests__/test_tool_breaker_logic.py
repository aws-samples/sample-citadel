"""Pure-logic unit tests for the per-target circuit breaker (task 28d624b1)."""
from __future__ import annotations

import os
import sys

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.common.failure_taxonomy import FailureClass as FC  # noqa: E402
from arbiter.governance import tool_breaker_logic as L  # noqa: E402
from arbiter.governance.tool_breaker_logic import BreakerState, BreakerTarget  # noqa: E402


class TestResolveBreakerTarget:
    def test_mcp_binding_resolves_to_mcp_server_kind(self):
        t = L.resolve_breaker_target(
            {"toolId": "t1", "integrationBindings": [{"integrationId": "mcp-1", "type": "MCP"}]}
        )
        assert t == BreakerTarget(kind="mcp_server", target_id="mcp-1")

    def test_two_tools_one_server_share_the_key(self):
        cfg_a = {"toolId": "a", "integrationBindings": [{"integrationId": "mcp-1", "type": "mcp"}]}
        cfg_b = {"toolId": "b", "integrationBindings": [{"integrationId": "mcp-1", "type": "mcp"}]}
        ta = L.resolve_breaker_target(cfg_a)
        tb = L.resolve_breaker_target(cfg_b)
        assert ta == tb
        assert L.breaker_pk("org1", ta) == L.breaker_pk("org1", tb) == "org1#mcp_server#mcp-1"

    def test_non_mcp_integration_resolves_to_integration_kind(self):
        t = L.resolve_breaker_target(
            {"toolId": "t", "integrationBindings": [{"integrationId": "jira-1", "type": "JIRA"}]}
        )
        assert t == BreakerTarget(kind="integration", target_id="jira-1")

    def test_datastore_binding_resolves_to_datastore_kind(self):
        t = L.resolve_breaker_target(
            {"toolId": "t", "dataStoreBindings": [{"dataStoreId": "ds-1"}]}
        )
        assert t == BreakerTarget(kind="datastore", target_id="ds-1")

    def test_local_tool_no_binding_resolves_to_none(self):
        # D7: a local/deterministic tool with no external binding gets NO breaker.
        assert L.resolve_breaker_target({"toolId": "calc"}) is None
        assert L.resolve_breaker_target({"toolId": "calc", "integrationBindings": []}) is None
        assert L.resolve_breaker_target({}) is None
        assert L.resolve_breaker_target(None) is None

    def test_integration_preferred_over_datastore(self):
        t = L.resolve_breaker_target({
            "toolId": "t",
            "integrationBindings": [{"integrationId": "i-1"}],
            "dataStoreBindings": [{"dataStoreId": "ds-1"}],
        })
        assert t.kind == "integration" and t.target_id == "i-1"

    def test_multi_binding_logs_and_gates_first(self, caplog):
        import logging
        with caplog.at_level(logging.WARNING):
            t = L.resolve_breaker_target({
                "toolId": "multi",
                "integrationBindings": [{"integrationId": "i-1"}, {"integrationId": "i-2"}],
            })
        assert t.target_id == "i-1"  # first binding gated (D3 single-target)
        assert any("multi" in r.message and "external bindings" in r.message for r in caplog.records)


class TestWindowStart:
    def test_coarse_bucket(self):
        assert L.window_start(1000, 60) == 960
        assert L.window_start(1059, 60) == 1020
        assert L.window_start(1020, 60) == 1020

    def test_zero_window_is_identity(self):
        assert L.window_start(1234, 0) == 1234


class TestShouldCountFailure:
    def test_transient_and_timeout_always_count(self):
        assert L.should_count_failure(FC.TRANSIENT, include_throttle=False) is True
        assert L.should_count_failure(FC.TIMEOUT, include_throttle=False) is True

    def test_throttle_gated_off_by_default(self):
        # D4: THROTTLE does NOT count toward opening by default; env-gated.
        assert L.should_count_failure(FC.THROTTLE, include_throttle=False) is False
        assert L.should_count_failure(FC.THROTTLE, include_throttle=True) is True

    def test_neutral_classes_never_count(self):
        for fc in (FC.VALIDATION, FC.POLICY_DENIED, FC.AUTHZ, FC.APPROVAL_ABSENT,
                   FC.INDETERMINATE, FC.UNKNOWN, FC.CIRCUIT_OPEN):
            assert L.should_count_failure(fc, include_throttle=True) is False, fc


class TestTransitionPredicates:
    def test_open_fast_fail_inside_recovery(self):
        assert L.is_open_fast_fail(BreakerState.OPEN, opened_at=100, now_epoch=120, recovery_seconds=30) is True
        assert L.is_probe_eligible(BreakerState.OPEN, opened_at=100, now_epoch=120, recovery_seconds=30) is False

    def test_probe_eligible_after_recovery(self):
        assert L.is_probe_eligible(BreakerState.OPEN, opened_at=100, now_epoch=131, recovery_seconds=30) is True
        assert L.is_open_fast_fail(BreakerState.OPEN, opened_at=100, now_epoch=131, recovery_seconds=30) is False

    def test_closed_is_never_fast_fail_or_probe(self):
        assert L.is_open_fast_fail(BreakerState.CLOSED, 0, 999, 30) is False
        assert L.is_probe_eligible(BreakerState.CLOSED, 0, 999, 30) is False

    def test_crosses_threshold(self):
        assert L.crosses_threshold(5, 5) is True
        assert L.crosses_threshold(4, 5) is False


class TestCacheFreshness:
    def test_open_entry_sticky_to_open_ttl(self):
        # Stale-OPEN acceptable (fails closed): valid up to open_ttl.
        assert L.cache_entry_fresh(BreakerState.OPEN, cached_at=100, now_epoch=120,
                                   open_ttl_seconds=30, closed_ttl_seconds=3) is True
        assert L.cache_entry_fresh(BreakerState.OPEN, cached_at=100, now_epoch=131,
                                   open_ttl_seconds=30, closed_ttl_seconds=3) is False

    def test_closed_entry_short_ttl(self):
        # Stale-CLOSED minimised: short TTL.
        assert L.cache_entry_fresh(BreakerState.CLOSED, cached_at=100, now_epoch=102,
                                   open_ttl_seconds=30, closed_ttl_seconds=3) is True
        assert L.cache_entry_fresh(BreakerState.CLOSED, cached_at=100, now_epoch=104,
                                   open_ttl_seconds=30, closed_ttl_seconds=3) is False
