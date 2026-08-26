"""Real-client (moto) contract tests for the tool-target circuit-breaker store
(task 28d624b1).

Uses a REAL boto3 client backed by moto against ONE real-shaped table (never a
fake dict store), so conditional-write semantics, attribute typing, and float
marshalling are all exercised faithfully — the agent boundary is NOT stubbed.

conftest note (mirrors test_ledger_contract_moto.py): arbiter/conftest.py stubs
module-level boto3.client/resource for the whole suite, but leaves boto3.Session
intact. We build the REAL moto-backed resource via boto3.Session(...).resource(...)
inside mock_aws() and point the store's lazy _get_dynamodb_resource seam at it.
"""
from __future__ import annotations

import os
import sys
import time

import boto3
import pytest

try:
    from moto import mock_aws
except ImportError:  # pragma: no cover
    pytest.skip("moto not installed", allow_module_level=True)

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.common.failure_taxonomy import FailureClass  # noqa: E402
from arbiter.governance import tool_breaker_store as store_mod  # noqa: E402
from arbiter.governance.tool_breaker_store import (  # noqa: E402
    BreakerConfig,
    BreakerTransition,
    PreCheckDecision,
    ToolBreakerStore,
    __reset_breaker_client_for_test,
)
from arbiter.governance.tool_breaker_logic import BreakerState, BreakerTarget  # noqa: E402

TABLE = "citadel-tool-breaker-state-moto"
TARGET = BreakerTarget(kind="mcp_server", target_id="mcp-1")
PK = "org1#mcp_server#mcp-1"


def _make_table(resource):
    resource.create_table(
        TableName=TABLE,
        KeySchema=[
            {"AttributeName": "pk", "KeyType": "HASH"},
            {"AttributeName": "sk", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "pk", "AttributeType": "S"},
            {"AttributeName": "sk", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


@pytest.fixture
def moto_resource(monkeypatch):
    with mock_aws():
        resource = boto3.Session(region_name="us-east-1").resource("dynamodb")
        _make_table(resource)
        __reset_breaker_client_for_test()
        monkeypatch.setattr(store_mod, "_get_dynamodb_resource", lambda: resource)
        try:
            yield resource
        finally:
            __reset_breaker_client_for_test()


def _raw_item(pk):
    client = boto3.Session(region_name="us-east-1").client("dynamodb")
    resp = client.get_item(TableName=TABLE, Key={"pk": {"S": pk}, "sk": {"S": "STATE"}})
    return resp.get("Item")


def _seed(resource, *, state, opened_at=0, failure_count=0, state_version=1,
          probe_owner=None, probe_expiry=None, window_start=0):
    item = {
        "pk": PK, "sk": "STATE", "state": state, "openedAt": int(opened_at),
        "failureCount": int(failure_count), "stateVersion": int(state_version),
        "windowStart": int(window_start), "updatedAt": int(opened_at), "ttl": int(opened_at) + 86400,
    }
    if probe_owner is not None:
        item["probeLeaseOwner"] = probe_owner
        item["probeLeaseExpiresAt"] = int(probe_expiry)
    resource.Table(TABLE).put_item(Item=item)


def _store(resource, *, clock, threshold=3, window=60, recovery=30, lease=30,
           on_transition=None, org="org1"):
    return ToolBreakerStore(
        table_name=TABLE, org_id=org,
        config=BreakerConfig(
            failure_threshold=threshold, window_seconds=window, recovery_seconds=recovery,
            probe_lease_seconds=lease, closed_cache_ttl_seconds=3, ttl_seconds=86400,
            include_throttle=False,
        ),
        on_transition=on_transition, clock=clock,
    )


# ---------------------------------------------------------------------------
# A1 — opens after N failures in window W  (exactly one CLOSED->OPEN finding)
# ---------------------------------------------------------------------------


class TestOpensAfterNInWindow:
    def test_opens_after_threshold_and_files_one_finding(self, moto_resource):
        transitions = []
        s = _store(moto_resource, clock=lambda: 1000.0, threshold=3,
                   on_transition=transitions.append)
        for _ in range(2):
            s.observe_failure(TARGET, FailureClass.TRANSIENT, is_probe=False)
        # Not yet open after 2.
        assert _raw_item(PK)["state"]["S"] == "CLOSED"
        assert transitions == []
        # 3rd failure crosses the threshold -> OPEN.
        s.observe_failure(TARGET, FailureClass.TRANSIENT, is_probe=False)
        raw = _raw_item(PK)
        assert raw["state"]["S"] == "OPEN"
        assert len(transitions) == 1
        t = transitions[0]
        assert (t.from_state, t.to_state) == (BreakerState.CLOSED, BreakerState.OPEN)

    def test_neutral_class_never_counts_toward_opening(self, moto_resource):
        transitions = []
        s = _store(moto_resource, clock=lambda: 1000.0, threshold=1,
                   on_transition=transitions.append)
        # A business/validation error is breaker-neutral even at threshold 1.
        for fc in (FailureClass.VALIDATION, FailureClass.POLICY_DENIED, FailureClass.THROTTLE):
            s.observe_failure(TARGET, fc, is_probe=False)
        assert _raw_item(PK) is None or _raw_item(PK)["state"]["S"] == "CLOSED"
        assert transitions == []


# ---------------------------------------------------------------------------
# A2 — OPEN fast-fails WITHOUT touching target, ZERO DDB on cached OPEN, <100ms
# ---------------------------------------------------------------------------


class TestOpenFastFailIsLocal:
    def test_cached_open_fast_fail_does_zero_ddb_and_is_under_100ms(self, moto_resource):
        clock = {"t": 1000.0}
        s = _store(moto_resource, clock=lambda: clock["t"], recovery=30)
        _seed(moto_resource, state="OPEN", opened_at=1000, state_version=1)

        # First call: one GetItem (cache miss), OPEN inside recovery -> fast-fail.
        clock["t"] = 1005.0
        pre1 = s.pre_check(TARGET, probe_owner="w1")
        assert pre1.decision is PreCheckDecision.FAST_FAIL
        assert s.ddb_op_count == 1

        # Second call: served from cache -> ZERO additional DDB, and <100ms.
        clock["t"] = 1006.0
        start = time.monotonic()
        pre2 = s.pre_check(TARGET, probe_owner="w1")
        elapsed = time.monotonic() - start
        assert pre2.decision is PreCheckDecision.FAST_FAIL
        assert s.ddb_op_count == 1          # structural: NO DynamoDB call on cached OPEN
        assert pre2.observing is False       # nothing runs, nothing to observe
        assert elapsed < 0.1                 # generous wall-clock bound (secondary)

    def test_closed_proceeds(self, moto_resource):
        s = _store(moto_resource, clock=lambda: 1000.0)
        pre = s.pre_check(TARGET, probe_owner="w1")  # no row -> CLOSED
        assert pre.decision is PreCheckDecision.PROCEED
        assert pre.observing is True


# ---------------------------------------------------------------------------
# A3 — recovery closes via a bounded probe; probe failure reopens
# ---------------------------------------------------------------------------


class TestHalfOpenProbe:
    def test_probe_success_closes(self, moto_resource):
        transitions = []
        s = _store(moto_resource, clock=lambda: 1040.0, recovery=30,
                   on_transition=transitions.append)
        _seed(moto_resource, state="OPEN", opened_at=1000, state_version=2)  # now 1040 >= 1000+30
        pre = s.pre_check(TARGET, probe_owner="w1")
        assert pre.decision is PreCheckDecision.PROBE and pre.is_probe is True
        assert _raw_item(PK)["state"]["S"] == "HALF_OPEN"
        # Probe succeeds -> CLOSED, one recovered finding.
        s.observe_success(TARGET, is_probe=True)
        assert _raw_item(PK)["state"]["S"] == "CLOSED"
        assert [(t.from_state, t.to_state) for t in transitions] == [
            (BreakerState.HALF_OPEN, BreakerState.CLOSED)
        ]

    def test_probe_failure_reopens(self, moto_resource):
        transitions = []
        s = _store(moto_resource, clock=lambda: 1040.0, recovery=30,
                   on_transition=transitions.append)
        _seed(moto_resource, state="OPEN", opened_at=1000, state_version=2)
        pre = s.pre_check(TARGET, probe_owner="w1")
        assert pre.decision is PreCheckDecision.PROBE
        s.observe_failure(TARGET, FailureClass.TIMEOUT, is_probe=True)
        assert _raw_item(PK)["state"]["S"] == "OPEN"
        assert [(t.from_state, t.to_state) for t in transitions] == [
            (BreakerState.HALF_OPEN, BreakerState.OPEN)
        ]


# ---------------------------------------------------------------------------
# A4 — TWO CONCURRENT WORKERS NEVER DOUBLE-PROBE (+ adversarial RED bite)
# ---------------------------------------------------------------------------


class TestNeverDoubleProbe:
    def test_two_workers_exactly_one_wins_the_lease(self, moto_resource):
        _seed(moto_resource, state="OPEN", opened_at=1000, state_version=2)
        a = _store(moto_resource, clock=lambda: 1040.0, recovery=30)
        b = _store(moto_resource, clock=lambda: 1040.0, recovery=30)
        pre_a = a.pre_check(TARGET, probe_owner="wA")
        pre_b = b.pre_check(TARGET, probe_owner="wB")
        decisions = sorted([pre_a.decision.value, pre_b.decision.value])
        assert decisions == ["fast_fail", "probe"]  # exactly one prober
        raw = _raw_item(PK)
        assert raw["state"]["S"] == "HALF_OPEN"
        assert raw["probeLeaseOwner"]["S"] in ("wA", "wB")

    def test_RED_bite_unconditional_lease_double_probes(self, moto_resource, monkeypatch):
        """Adversarial proof the conditional lease is load-bearing: replace the
        lease conditional write with an UNCONDITIONAL one and BOTH workers win
        the probe (the double-probe the AC forbids)."""
        _seed(moto_resource, state="OPEN", opened_at=1000, state_version=2)

        def _unconditional_lease(self, pk, *, owner, now):
            self.ddb_op_count += 1
            self._table().update_item(
                Key={"pk": pk, "sk": "STATE"},
                UpdateExpression=(
                    "SET #state = :half, probeLeaseOwner = :owner, "
                    "probeLeaseExpiresAt = :expiry, updatedAt = :now ADD stateVersion :one"
                ),
                # NO ConditionExpression — the bite.
                ExpressionAttributeNames={"#state": "state"},
                ExpressionAttributeValues={
                    ":half": "HALF_OPEN", ":owner": owner,
                    ":expiry": now + 30, ":now": now, ":one": 1,
                },
            )
            return True

        monkeypatch.setattr(ToolBreakerStore, "_try_acquire_probe_lease", _unconditional_lease)
        a = _store(moto_resource, clock=lambda: 1040.0, recovery=30)
        b = _store(moto_resource, clock=lambda: 1040.0, recovery=30)
        pre_a = a.pre_check(TARGET, probe_owner="wA")
        pre_b = b.pre_check(TARGET, probe_owner="wB")
        # BOTH probe -> the vulnerability the conditional lease prevents.
        assert pre_a.decision is PreCheckDecision.PROBE
        assert pre_b.decision is PreCheckDecision.PROBE


# ---------------------------------------------------------------------------
# Storm-proof: exactly one CLOSED->OPEN finding under concurrency (+ RED bite)
# ---------------------------------------------------------------------------


class TestStormProof:
    def test_two_workers_crossing_threshold_file_one_finding(self, moto_resource):
        # Pre-seed a CLOSED row at failureCount = threshold-1 so a single further
        # failure from each of two workers races the CLOSED->OPEN transition.
        _seed(moto_resource, state="CLOSED", failure_count=2, state_version=0, window_start=960)
        ta, tb = [], []
        a = _store(moto_resource, clock=lambda: 1000.0, threshold=3, window=60, on_transition=ta.append)
        b = _store(moto_resource, clock=lambda: 1000.0, threshold=3, window=60, on_transition=tb.append)
        a.observe_failure(TARGET, FailureClass.TRANSIENT, is_probe=False)
        b.observe_failure(TARGET, FailureClass.TRANSIENT, is_probe=False)
        # Exactly one transition finding total (single-writer stateVersion CAS).
        assert len(ta) + len(tb) == 1
        assert _raw_item(PK)["state"]["S"] == "OPEN"

    def test_flapping_open_files_no_extra_findings(self, moto_resource):
        transitions = []
        s = _store(moto_resource, clock=lambda: 1000.0, threshold=1, on_transition=transitions.append)
        s.observe_failure(TARGET, FailureClass.TRANSIENT, is_probe=False)  # opens (1 finding)
        # Many further failures while OPEN write no finding (they'd fast-fail;
        # a direct observe while OPEN increments nothing — guarded CLOSED-only).
        for _ in range(10):
            s.observe_failure(TARGET, FailureClass.TRANSIENT, is_probe=False)
        assert len(transitions) == 1

    def test_RED_bite_unconditional_open_files_two_findings(self, moto_resource, monkeypatch):
        """Adversarial proof the stateVersion CAS is load-bearing: replace the
        conditional CLOSED->OPEN write with an UNCONDITIONAL one and two racing
        workers each file a finding (a storm)."""
        _seed(moto_resource, state="CLOSED", failure_count=2, state_version=0, window_start=960)

        def _unconditional_open(self, pk, target, *, now):
            # Mirror _count_and_maybe_open but with an UNCONDITIONAL transition.
            from arbiter.governance.tool_breaker_logic import window_start as _ws
            cur = _ws(now, self._config.window_seconds)
            self._increment_failure(pk, now=now, cur_window=cur, item_ttl=now + 86400)
            self.ddb_op_count += 1
            resp = self._table().update_item(
                Key={"pk": pk, "sk": "STATE"},
                UpdateExpression="SET #state = :open, openedAt = :now ADD stateVersion :one",
                ExpressionAttributeNames={"#state": "state"},
                ExpressionAttributeValues={":open": "OPEN", ":now": now, ":one": 1},
                ReturnValues="ALL_NEW",
            )
            new = resp.get("Attributes", {}) or {}
            self._emit(target, BreakerState.CLOSED, BreakerState.OPEN, int(new.get("stateVersion", 0) or 0), now)

        monkeypatch.setattr(ToolBreakerStore, "_count_and_maybe_open", _unconditional_open)
        ta, tb = [], []
        a = _store(moto_resource, clock=lambda: 1000.0, threshold=3, window=60, on_transition=ta.append)
        b = _store(moto_resource, clock=lambda: 1000.0, threshold=3, window=60, on_transition=tb.append)
        a.observe_failure(TARGET, FailureClass.TRANSIENT, is_probe=False)
        b.observe_failure(TARGET, FailureClass.TRANSIENT, is_probe=False)
        assert len(ta) + len(tb) == 2  # storm: two findings for one logical open


# ---------------------------------------------------------------------------
# Float-safety — int-epoch attributes, never a float
# ---------------------------------------------------------------------------


class TestFloatSafety:
    def test_transition_writes_are_int_typed(self, moto_resource):
        # A fractional clock must still persist int-epoch attributes (no float).
        s = _store(moto_resource, clock=lambda: 1000.75, threshold=1)
        s.observe_failure(TARGET, FailureClass.TRANSIENT, is_probe=False)
        raw = _raw_item(PK)
        assert raw["state"]["S"] == "OPEN"
        for attr in ("openedAt", "stateVersion", "failureCount", "updatedAt", "ttl", "windowStart"):
            assert "N" in raw[attr], attr
            assert "." not in raw[attr]["N"], (attr, raw[attr])  # integer, no float tail


# ---------------------------------------------------------------------------
# D7 — a breaker-store outage FAILS OPEN (never a fleet outage)
# ---------------------------------------------------------------------------


class TestStoreUnavailableFailsOpen:
    def test_missing_table_proceeds(self, moto_resource):
        # Point the store at a non-existent table -> GetItem raises -> fail-open.
        s = ToolBreakerStore(
            table_name="does-not-exist-table", org_id="org1",
            config=BreakerConfig(recovery_seconds=30), clock=lambda: 1000.0,
        )
        pre = s.pre_check(TARGET, probe_owner="w1")
        assert pre.decision is PreCheckDecision.PROCEED  # fail-open, never block

    def test_transition_write_failure_is_swallowed(self, moto_resource, monkeypatch):
        # A write error during observe must not raise (fail-open, best-effort):
        # the store's own conditional-write methods catch store errors and
        # degrade to a no-op. Force _table() to raise a transport error so the
        # real internal try/except path is exercised.
        s = _store(moto_resource, clock=lambda: 1000.0, threshold=1)

        def _boom():
            raise store_mod.BotoCoreError()

        monkeypatch.setattr(s, "_table", _boom)
        # Must not raise (a breaker-store outage never fails the tool call).
        s.observe_failure(TARGET, FailureClass.TRANSIENT, is_probe=False)
        s.observe_success(TARGET, is_probe=True)
