"""Unit + property tests for arbiter/governance/d4_retrospective.py (US-ARB-020).

The retrospective script is outcome-gated -- it cannot be exercised against
real telemetry until 30+ days of post-wave-4 ledger data exists -- so these
tests validate the script's logic with an in-memory FakeTable stand-in for
the DynamoDB ledger, mirroring the pattern used by ``test_ledger.py`` and
``test_case_law_admin.py``.

Cases covered:

1. Insufficient evidence (no tool-handler findings) -> deferred-90d.
2. High overlap (>90%) -> re-debate.
3. Medium overlap (20-90%) -> keep-both.
4. Low overlap (<20%) -> keep-both-strong-evidence.
5. Window filter: findings older than window_days excluded.
6. decision != 'deny' filter: PERMIT findings ignored.
7. Report rendering: H2 sections + recommendation value present.
8. CLI integration: main() writes output and exits 0.
9. Property test (100 iters): build_recommendation branches match thresholds.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

# Add the project root (three levels up from this file) so that
# ``arbiter.governance.d4_retrospective``'s relative imports resolve.
_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import d4_retrospective  # noqa: E402
from arbiter.governance.d4_retrospective import (  # noqa: E402
    RECOMMENDATION_THRESHOLD_HIGH,
    RECOMMENDATION_THRESHOLD_LOW,
    RetrospectiveData,
    __reset_clients_for_test,
    build_recommendation,
    main,
    scan_findings,
    write_report,
)


TABLE_NAME = "citadel-governance-ledger-test"


# ---------------------------------------------------------------------------
# Fake DDB plumbing
# ---------------------------------------------------------------------------


class FakeTable:
    """In-memory stand-in for a boto3 DynamoDB Table.

    Supports only the operations ``d4_retrospective.scan_findings`` uses
    -- a single ``scan()`` call that returns every seeded item at once.
    Pagination is still exercised because ``scan_findings`` loops until
    ``LastEvaluatedKey`` is falsy, which the fake omits from the
    response.
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self.items: list[dict[str, Any]] = []
        self.scan_calls: list[dict[str, Any]] = []

    def scan(self, **kwargs: Any) -> dict[str, Any]:
        self.scan_calls.append(kwargs)
        return {"Items": list(self.items)}


class FakeDynamoDBResource:
    """Stand-in for ``boto3.resource('dynamodb')``."""

    def __init__(self) -> None:
        self.tables: dict[str, FakeTable] = {}

    def Table(self, name: str) -> FakeTable:  # noqa: N802 -- mirrors boto3 API
        if name not in self.tables:
            self.tables[name] = FakeTable(name)
        return self.tables[name]


def _install_fake_ddb(monkeypatch: pytest.MonkeyPatch) -> FakeDynamoDBResource:
    """Patch ``d4_retrospective._dynamodb`` + env var.

    Returns the fake resource so tests can seed ledger items via
    ``fake.Table(TABLE_NAME).items.append(...)``.
    """
    monkeypatch.setenv("GOVERNANCE_LEDGER_TABLE", TABLE_NAME)
    fake = FakeDynamoDBResource()
    monkeypatch.setattr(d4_retrospective, "_dynamodb", fake)
    return fake


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_cached_client() -> Any:
    """Reset the module-level cached boto3 resource between tests."""
    __reset_clients_for_test()
    yield
    __reset_clients_for_test()


def _item(
    *,
    scope: str,
    workflow_id: str,
    reason: str,
    decision: str = "deny",
    timestamp: float | None = None,
) -> dict[str, Any]:
    """Build a ledger item shaped like the real ``ledger.py`` writes."""
    if timestamp is None:
        timestamp = time.time()
    return {
        "decision": decision,
        "scope_evaluated": scope,
        "workflow_id": workflow_id,
        "reason": reason,
        "timestamp": float(timestamp),
    }


# ---------------------------------------------------------------------------
# 1. Insufficient evidence
# ---------------------------------------------------------------------------


def test_insufficient_evidence_returns_deferred_90d(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    table = fake.Table(TABLE_NAME)
    # Only pre-filter findings, zero tool-handler findings.
    for i in range(5):
        table.items.append(
            _item(
                scope="worker-pre-filter",
                workflow_id=f"wf-{i}",
                reason=f"reason-{i}",
            )
        )

    data = scan_findings(window_days=30)
    recommendation = build_recommendation(data)

    assert recommendation == "deferred-90d"
    assert data.tool_handler_count == 0
    assert data.insufficient_evidence is True
    assert len(data.overlap) == 0


# ---------------------------------------------------------------------------
# 2. High overlap (>90%)
# ---------------------------------------------------------------------------


def test_high_overlap_returns_re_debate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    table = fake.Table(TABLE_NAME)

    # 10 (workflow_id, reason) tuples. 9 appear at BOTH scopes, 1 only at
    # pre-filter. Both distinct sets have size 10 and 9 respectively, so
    # overlap / max = 9/10 = 0.9 -- which is NOT strictly greater than 0.90.
    # Seed an extra disambiguating tuple so overlap / max strictly > 0.90:
    # 19 shared + 1 pre-filter-only -> overlap=19, max=20, ratio=0.95.
    for i in range(19):
        wf = f"wf-{i}"
        rsn = f"reason-{i}"
        table.items.append(_item(scope="worker-pre-filter", workflow_id=wf, reason=rsn))
        table.items.append(_item(scope="worker-tool-handler", workflow_id=wf, reason=rsn))
    table.items.append(
        _item(scope="worker-pre-filter", workflow_id="wf-only-pf", reason="solo")
    )

    data = scan_findings(window_days=30)
    recommendation = build_recommendation(data)

    assert recommendation == "re-debate"
    assert data.overlap_ratio > RECOMMENDATION_THRESHOLD_HIGH
    assert len(data.overlap) == 19


# ---------------------------------------------------------------------------
# 3. Medium overlap (20-90%)
# ---------------------------------------------------------------------------


def test_medium_overlap_returns_keep_both(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    table = fake.Table(TABLE_NAME)

    # 10 pre-filter tuples, 10 tool-handler tuples, 5 shared.
    # overlap=5, max=10, ratio=0.5 -> medium band.
    for i in range(5):
        wf = f"wf-shared-{i}"
        rsn = f"reason-shared-{i}"
        table.items.append(_item(scope="worker-pre-filter", workflow_id=wf, reason=rsn))
        table.items.append(_item(scope="worker-tool-handler", workflow_id=wf, reason=rsn))
    for i in range(5):
        table.items.append(
            _item(
                scope="worker-pre-filter",
                workflow_id=f"wf-pf-{i}",
                reason=f"reason-pf-{i}",
            )
        )
        table.items.append(
            _item(
                scope="worker-tool-handler",
                workflow_id=f"wf-th-{i}",
                reason=f"reason-th-{i}",
            )
        )

    data = scan_findings(window_days=30)
    recommendation = build_recommendation(data)

    assert recommendation == "keep-both"
    assert RECOMMENDATION_THRESHOLD_LOW <= data.overlap_ratio <= RECOMMENDATION_THRESHOLD_HIGH


# ---------------------------------------------------------------------------
# 4. Low overlap (<20%)
# ---------------------------------------------------------------------------


def test_low_overlap_returns_keep_both_strong_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    table = fake.Table(TABLE_NAME)

    # 20 pre-filter tuples, 20 tool-handler tuples, 1 shared.
    # overlap=1, max=20, ratio=0.05 -> strong evidence band.
    wf = "wf-shared"
    rsn = "reason-shared"
    table.items.append(_item(scope="worker-pre-filter", workflow_id=wf, reason=rsn))
    table.items.append(_item(scope="worker-tool-handler", workflow_id=wf, reason=rsn))
    for i in range(19):
        table.items.append(
            _item(
                scope="worker-pre-filter",
                workflow_id=f"wf-pf-{i}",
                reason=f"reason-pf-{i}",
            )
        )
        table.items.append(
            _item(
                scope="worker-tool-handler",
                workflow_id=f"wf-th-{i}",
                reason=f"reason-th-{i}",
            )
        )

    data = scan_findings(window_days=30)
    recommendation = build_recommendation(data)

    assert recommendation == "keep-both-strong-evidence"
    assert data.overlap_ratio < RECOMMENDATION_THRESHOLD_LOW


# ---------------------------------------------------------------------------
# 5. Window filter excludes old findings
# ---------------------------------------------------------------------------


def test_window_filter_excludes_findings_older_than_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    table = fake.Table(TABLE_NAME)

    now = time.time()
    one_hundred_days_ago = now - (100 * 86400)
    one_day_ago = now - 86400

    # Old finding -- must be excluded.
    table.items.append(
        _item(
            scope="worker-tool-handler",
            workflow_id="wf-old",
            reason="ancient",
            timestamp=one_hundred_days_ago,
        )
    )
    # Recent finding -- must be included.
    table.items.append(
        _item(
            scope="worker-tool-handler",
            workflow_id="wf-new",
            reason="fresh",
            timestamp=one_day_ago,
        )
    )

    data = scan_findings(window_days=30)

    assert data.tool_handler_count == 1
    assert "wf-new|fresh" in data.distinct_tool_handler
    assert "wf-old|ancient" not in data.distinct_tool_handler


# ---------------------------------------------------------------------------
# 6. decision != 'deny' filter
# ---------------------------------------------------------------------------


def test_permit_findings_are_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    table = fake.Table(TABLE_NAME)

    # PERMIT at tool-handler -- must NOT count toward the overlap calc.
    table.items.append(
        _item(
            scope="worker-tool-handler",
            workflow_id="wf-permitted",
            reason="allowed",
            decision="permit",
        )
    )
    # One DENY at each scope so there IS something to measure.
    table.items.append(
        _item(scope="worker-pre-filter", workflow_id="wf-1", reason="r-1")
    )
    table.items.append(
        _item(scope="worker-tool-handler", workflow_id="wf-2", reason="r-2")
    )

    data = scan_findings(window_days=30)

    assert data.tool_handler_count == 1
    assert "wf-permitted|allowed" not in data.distinct_tool_handler
    assert "wf-2|r-2" in data.distinct_tool_handler


# ---------------------------------------------------------------------------
# 7. Report rendering from a direct RetrospectiveData instance
# ---------------------------------------------------------------------------


def test_write_report_contains_expected_sections(tmp_path: Path) -> None:
    data = RetrospectiveData(
        pre_filter_count=10,
        tool_handler_count=10,
        distinct_pre_filter={f"wf-{i}|r-{i}" for i in range(10)},
        distinct_tool_handler={f"wf-{i}|r-{i}" for i in range(10)},
        overlap={f"wf-{i}|r-{i}" for i in range(10)},
        window_start="2026-01-01T00:00:00+00:00",
        window_end="2026-01-31T00:00:00+00:00",
    )

    out = tmp_path / "report.md"
    write_report(data, out)

    assert out.exists()
    content = out.read_text()
    # H2 sections -- stable contract for downstream consumers.
    assert "## Status" in content
    assert "## Layer counts" in content
    assert "## Overlap" in content
    assert "## Interpretation" in content
    assert "## Data sources" in content
    # Recommendation value rendered -- 100% overlap -> re-debate.
    assert "re-debate" in content
    assert "worker-pre-filter" in content
    assert "worker-tool-handler" in content


def test_write_report_for_deferred_90d_branch(tmp_path: Path) -> None:
    """Deferred branch renders its distinct Interpretation prose."""
    data = RetrospectiveData(
        pre_filter_count=3,
        tool_handler_count=0,
        distinct_pre_filter={"wf-a|r"},
        distinct_tool_handler=set(),
        overlap=set(),
        window_start="2026-01-01T00:00:00+00:00",
        window_end="2026-01-31T00:00:00+00:00",
    )
    out = tmp_path / "deferred.md"
    write_report(data, out)

    content = out.read_text()
    assert "deferred-90d" in content
    assert "Defer retrospective to day 90" in content


def test_write_report_creates_parent_dirs(tmp_path: Path) -> None:
    """``reports/`` parent is created on demand."""
    data = RetrospectiveData()
    out = tmp_path / "reports" / "nested" / "r.md"
    write_report(data, out)
    assert out.exists()


# ---------------------------------------------------------------------------
# 8. CLI integration
# ---------------------------------------------------------------------------


def test_main_writes_output_and_returns_zero(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fake = _install_fake_ddb(monkeypatch)
    table = fake.Table(TABLE_NAME)
    # Seed a deferred-90d scenario -- simplest "ledger is empty at
    # tool-handler" case.
    table.items.append(
        _item(scope="worker-pre-filter", workflow_id="wf-1", reason="r-1")
    )

    out = tmp_path / "d4.md"
    exit_code = main(["--window-days", "30", "--output", str(out)])

    assert exit_code == 0
    assert out.exists()

    captured = capsys.readouterr()
    payload = json.loads(captured.out.strip().splitlines()[-1])
    assert payload["status"] == "ok"
    assert payload["recommendation"] == "deferred-90d"
    assert payload["output_path"] == str(out)
    assert payload["tool_handler_count"] == 0


# ---------------------------------------------------------------------------
# 9. Property test -- recommendation branches match threshold rules
# ---------------------------------------------------------------------------


@settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.function_scoped_fixture],
)
@given(
    pre_count=st.integers(min_value=0, max_value=50),
    th_count=st.integers(min_value=0, max_value=50),
    overlap_count=st.integers(min_value=0, max_value=50),
)
def test_property_build_recommendation_matches_thresholds(
    pre_count: int,
    th_count: int,
    overlap_count: int,
) -> None:
    """Build a RetrospectiveData with arbitrary sizes and assert the
    recommendation branch is consistent with the documented thresholds."""
    # Bound overlap by the smaller distinct set so the constructed data
    # is semantically plausible (an intersection cannot exceed either
    # operand's size).
    overlap_count = min(overlap_count, pre_count, th_count)

    distinct_pre = {f"pf-{i}" for i in range(pre_count)}
    distinct_th = {f"th-{i}" for i in range(th_count)}
    overlap = {f"ol-{i}" for i in range(overlap_count)}

    data = RetrospectiveData(
        pre_filter_count=pre_count,
        tool_handler_count=th_count,
        distinct_pre_filter=distinct_pre,
        distinct_tool_handler=distinct_th,
        overlap=overlap,
    )
    rec = build_recommendation(data)

    if th_count < 1:
        assert rec == "deferred-90d"
    else:
        ratio = data.overlap_ratio
        if ratio > RECOMMENDATION_THRESHOLD_HIGH:
            assert rec == "re-debate"
        elif ratio < RECOMMENDATION_THRESHOLD_LOW:
            assert rec == "keep-both-strong-evidence"
        else:
            assert rec == "keep-both"
