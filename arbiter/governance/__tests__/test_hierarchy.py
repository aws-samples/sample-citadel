"""Unit + property tests for arbiter/governance/hierarchy.py (US-ARB-003)."""
from __future__ import annotations

import logging
import os
import sys
import time
from typing import Any
from unittest.mock import patch

import pytest
from hypothesis import given, settings, strategies as st

# Import via the package path so hierarchy.py's ``from .models import ...``
# relative import resolves. We add the project root (two levels up from this
# file) to sys.path, then import ``arbiter.governance.hierarchy``.
_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance import hierarchy  # noqa: E402
from arbiter.governance.hierarchy import (  # noqa: E402
    CACHE_TTL_SECONDS,
    GovernanceState,
    load_governance_state,
    __reset_hierarchy_cache_for_test,
)
from arbiter.governance.models import (  # noqa: E402
    ArbitrationDecision,
    AuthorityUnit,
    CaseLawEntry,
    CompositionContract,
    ConflictResolution,
    ConstitutionalLayer,
)


# ---------------------------------------------------------------------------
# Fake DDB resource
# ---------------------------------------------------------------------------


class FakeTable:
    """Minimal stand-in for a boto3 DynamoDB Table.

    Supports pagination via a configurable ``page_size``. Every call to
    ``scan`` (including paginated follow-up calls) increments a module-level
    counter so tests can assert exact scan counts.
    """

    def __init__(
        self,
        name: str,
        items: list[dict],
        scan_counter: dict[str, int],
        page_size: int | None = None,
    ) -> None:
        self.name = name
        self._items = items
        self._scan_counter = scan_counter
        self._page_size = page_size

    def scan(self, **kwargs: Any) -> dict[str, Any]:
        self._scan_counter["calls"] = self._scan_counter.get("calls", 0) + 1
        if self._page_size is None:
            return {"Items": list(self._items)}
        start_key = kwargs.get("ExclusiveStartKey")
        start = 0
        if start_key is not None:
            start = int(start_key.get("__cursor", 0))
        end = start + self._page_size
        page = self._items[start:end]
        response: dict[str, Any] = {"Items": page}
        if end < len(self._items):
            response["LastEvaluatedKey"] = {"__cursor": end}
        return response


class FakeDynamoDBResource:
    """Stand-in for ``boto3.resource('dynamodb')``."""

    def __init__(
        self,
        tables_by_name: dict[str, list[dict]],
        scan_counter: dict[str, int],
        page_size: int | None = None,
    ) -> None:
        self._tables_by_name = tables_by_name
        self._scan_counter = scan_counter
        self._page_size = page_size

    def Table(self, name: str) -> FakeTable:  # noqa: N802 — mirrors boto3 API
        items = self._tables_by_name.get(name, [])
        return FakeTable(
            name, items, self._scan_counter, page_size=self._page_size
        )


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


_ENV_VARS = {
    "AUTHORITY_UNITS_TABLE": "citadel-authority-units-test",
    "COMPOSITION_CONTRACTS_TABLE": "citadel-composition-contracts-test",
    "CASE_LAW_TABLE": "citadel-case-law-test",
    "CONSTITUTIONAL_LAYERS_TABLE": "citadel-constitutional-layers-test",
}


def _authority_unit_row(
    unit_id: str, agent_id: str = "agent-1", registry_id: str | None = None
) -> dict:
    row: dict[str, Any] = {
        "unitId": unit_id,
        "agentId": agent_id,
        "scope": {"decision_type": "*", "domain": "*"},
        "canRedelegate": False,
        "revoked": False,
        "riskRating": "low",
    }
    if registry_id is not None:
        row["registryId"] = registry_id
    return row


def _composition_contract_row(contract_id: str) -> dict:
    return {
        "contractId": contract_id,
        "partyA": "agent-a",
        "partyB": "agent-b",
        "authorityPrecedence": "none",
        "invariants": [],
        "conflictResolution": ConflictResolution.DEFAULT_DENY.value,
        "stopRights": [],
        "scope": {"decision_type": "*", "domain": "*"},
    }


def _case_law_row(case_id: str, precedence: int = 0) -> dict:
    # US-ARB-013: use CDK CaseLawTable field names.
    return {
        "entryId": case_id,
        "pattern": {"k": "v"},
        "resolution": ArbitrationDecision.DENY.value,
        "createdAt": "2023-11-14T22:13:20+00:00",
        "createdBy": "human-1",
        "scopeOfApplicability": {},
        "precedence": precedence,
        "revoked": False,
    }


def _constitutional_layer_row(layer_id: str) -> dict:
    return {
        "layerId": layer_id,
        "layerType": "global",
        "appliesTo": [],
        "rules": [],
    }


def _install_fake_ddb(
    monkeypatch: pytest.MonkeyPatch,
    *,
    authority_items: list[dict] | None = None,
    contract_items: list[dict] | None = None,
    case_law_items: list[dict] | None = None,
    layer_items: list[dict] | None = None,
    page_size: int | None = None,
) -> dict[str, int]:
    """Patch env vars + boto3.resource to return a FakeDynamoDBResource.

    Returns the scan-counter dict so tests can assert call counts.
    """
    for name, value in _ENV_VARS.items():
        monkeypatch.setenv(name, value)

    tables_by_name = {
        _ENV_VARS["AUTHORITY_UNITS_TABLE"]: authority_items or [],
        _ENV_VARS["COMPOSITION_CONTRACTS_TABLE"]: contract_items or [],
        _ENV_VARS["CASE_LAW_TABLE"]: case_law_items or [],
        _ENV_VARS["CONSTITUTIONAL_LAYERS_TABLE"]: layer_items or [],
    }
    scan_counter: dict[str, int] = {"calls": 0}
    fake_resource = FakeDynamoDBResource(
        tables_by_name, scan_counter, page_size=page_size
    )
    monkeypatch.setattr(
        hierarchy.boto3, "resource", lambda service_name: fake_resource
    )
    return scan_counter


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    """Ensure every test starts with a clean module-level cache."""
    __reset_hierarchy_cache_for_test()
    yield
    __reset_hierarchy_cache_for_test()


# ---------------------------------------------------------------------------
# AC 1: D2 app-scoped filter
# ---------------------------------------------------------------------------


def test_app_filter_keeps_only_target_and_global(monkeypatch: pytest.MonkeyPatch) -> None:
    authority_items = [
        _authority_unit_row("u-app1", registry_id="app-1"),
        _authority_unit_row("u-app2", registry_id="app-2"),
        _authority_unit_row("u-global", registry_id="*GLOBAL*"),
    ]
    _install_fake_ddb(monkeypatch, authority_items=authority_items)

    state = load_governance_state(registry_id="app-1")

    returned_ids = {u.unit_id for u in state.authority_units}
    returned_registry_ids = {u.registry_id for u in state.authority_units}
    assert returned_ids == {"u-app1", "u-global"}
    assert returned_registry_ids <= {"app-1", "*GLOBAL*"}
    assert state.registry_id == "app-1"


def test_app_filter_none_returns_all(monkeypatch: pytest.MonkeyPatch) -> None:
    authority_items = [
        _authority_unit_row("u-app1", registry_id="app-1"),
        _authority_unit_row("u-app2", registry_id="app-2"),
        _authority_unit_row("u-global", registry_id="*GLOBAL*"),
        _authority_unit_row("u-none", registry_id=None),
    ]
    _install_fake_ddb(monkeypatch, authority_items=authority_items)

    state = load_governance_state(registry_id=None)

    assert {u.unit_id for u in state.authority_units} == {
        "u-app1",
        "u-app2",
        "u-global",
        "u-none",
    }
    assert state.registry_id is None


def test_app_filter_drops_rows_without_registry_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Per D2: an unscoped unit has no claim to any specific app."""
    authority_items = [
        _authority_unit_row("u-app1", registry_id="app-1"),
        _authority_unit_row("u-none", registry_id=None),
        _authority_unit_row("u-global", registry_id="*GLOBAL*"),
    ]
    _install_fake_ddb(monkeypatch, authority_items=authority_items)

    state = load_governance_state(registry_id="app-1")

    assert {u.unit_id for u in state.authority_units} == {"u-app1", "u-global"}


def test_other_tables_are_not_filtered_by_registry_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_ddb(
        monkeypatch,
        authority_items=[_authority_unit_row("u-app1", registry_id="app-1")],
        contract_items=[
            _composition_contract_row("c-1"),
            _composition_contract_row("c-2"),
        ],
        case_law_items=[_case_law_row("case-1"), _case_law_row("case-2")],
        layer_items=[
            _constitutional_layer_row("l-1"),
            _constitutional_layer_row("l-2"),
        ],
    )

    state = load_governance_state(registry_id="app-1")

    assert len(state.composition_contracts) == 2
    assert len(state.case_law) == 2
    assert len(state.constitutional_layers) == 2


# ---------------------------------------------------------------------------
# AC 2 + 3: Caching behaviour
# ---------------------------------------------------------------------------


def test_cache_hit_within_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    counter = _install_fake_ddb(
        monkeypatch,
        authority_items=[_authority_unit_row("u-1", registry_id="app-1")],
    )

    load_governance_state(registry_id="app-1")
    first_calls = counter["calls"]
    load_governance_state(registry_id="app-1")
    second_calls = counter["calls"]

    assert first_calls == 4, (
        f"Expected 4 scans on first call (one per table), got {first_calls}"
    )
    assert second_calls == 4, (
        "Second call within TTL must not re-scan any table; "
        f"got {second_calls} total scans"
    )


def test_cache_miss_on_force_reload(monkeypatch: pytest.MonkeyPatch) -> None:
    counter = _install_fake_ddb(
        monkeypatch,
        authority_items=[_authority_unit_row("u-1", registry_id="app-1")],
    )

    load_governance_state(registry_id="app-1")
    load_governance_state(registry_id="app-1", force_reload=True)

    assert counter["calls"] == 8, (
        f"force_reload must trigger a second full scan round; got {counter['calls']}"
    )


def test_different_registry_ids_are_separate_cache_entries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    counter = _install_fake_ddb(
        monkeypatch,
        authority_items=[
            _authority_unit_row("u-1", registry_id="app-1"),
            _authority_unit_row("u-2", registry_id="app-2"),
        ],
    )

    load_governance_state(registry_id="app-1")
    load_governance_state(registry_id="app-2")

    assert counter["calls"] == 8, (
        f"Distinct registry_ids must each trigger a full scan round; got {counter['calls']}"
    )


def test_cache_entry_expires_after_ttl(monkeypatch: pytest.MonkeyPatch) -> None:
    counter = _install_fake_ddb(
        monkeypatch,
        authority_items=[_authority_unit_row("u-1", registry_id="app-1")],
    )

    # First load at t=1000.
    fake_now = [1000.0]
    monkeypatch.setattr(hierarchy.time, "time", lambda: fake_now[0])
    load_governance_state(registry_id="app-1")
    assert counter["calls"] == 4

    # Advance past the TTL boundary.
    fake_now[0] = 1000.0 + CACHE_TTL_SECONDS + 1
    load_governance_state(registry_id="app-1")
    assert counter["calls"] == 8


# ---------------------------------------------------------------------------
# AC 4: Missing env var → warning + empty list for that domain
# ---------------------------------------------------------------------------


def test_missing_authority_units_env_var_warns_and_returns_empty(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _install_fake_ddb(
        monkeypatch,
        authority_items=[_authority_unit_row("u-1", registry_id="app-1")],
        contract_items=[_composition_contract_row("c-1")],
        case_law_items=[_case_law_row("case-1")],
        layer_items=[_constitutional_layer_row("l-1")],
    )
    # AFTER install: unset the one env var under test.
    monkeypatch.delenv("AUTHORITY_UNITS_TABLE", raising=False)

    with caplog.at_level(logging.WARNING, logger=hierarchy.logger.name):
        state = load_governance_state()

    assert state.authority_units == []
    # Other tables still loaded normally.
    assert len(state.composition_contracts) == 1
    assert len(state.case_law) == 1
    assert len(state.constitutional_layers) == 1

    warnings = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "AUTHORITY_UNITS_TABLE" in r.getMessage()
    ]
    assert warnings, f"Expected a warning for AUTHORITY_UNITS_TABLE; got {caplog.records!r}"


def test_all_env_vars_missing_returns_empty_state(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in _ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    # boto3.resource should never be called in this case, but patch it to a
    # loud sentinel so a regression is obvious.
    def _should_not_call(service_name: str) -> Any:  # pragma: no cover - safety net
        raise AssertionError(
            f"boto3.resource should not be called when no env vars are set "
            f"(asked for {service_name!r})"
        )
    monkeypatch.setattr(hierarchy.boto3, "resource", _should_not_call)

    state = load_governance_state()

    assert state.authority_units == []
    assert state.composition_contracts == []
    assert state.case_law == []
    assert state.constitutional_layers == []


# ---------------------------------------------------------------------------
# Deserialisation / pagination / robustness
# ---------------------------------------------------------------------------


def test_pagination_collects_all_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    authority_items = [
        _authority_unit_row(f"u-{i}", registry_id="*GLOBAL*") for i in range(7)
    ]
    counter = _install_fake_ddb(
        monkeypatch, authority_items=authority_items, page_size=3
    )

    state = load_governance_state()

    assert {u.unit_id for u in state.authority_units} == {f"u-{i}" for i in range(7)}
    # 3 pages for authority (3+3+1) + 1 each for the other three empty tables.
    assert counter["calls"] == 3 + 1 + 1 + 1


def test_scope_accepts_json_string(monkeypatch: pytest.MonkeyPatch) -> None:
    authority_items = [
        {
            "unitId": "u-str",
            "agentId": "agent-1",
            "scope": '{"decision_type": "invoke_agent", "domain": "payment"}',
            "registryId": "*GLOBAL*",
        }
    ]
    _install_fake_ddb(monkeypatch, authority_items=authority_items)

    state = load_governance_state()

    assert len(state.authority_units) == 1
    unit = state.authority_units[0]
    assert unit.scope.decision_type == "invoke_agent"
    assert unit.scope.domain == "payment"


def test_malformed_authority_row_is_skipped(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    authority_items = [
        {"agentId": "orphan"},  # missing unitId
        _authority_unit_row("u-good", registry_id="*GLOBAL*"),
    ]
    _install_fake_ddb(monkeypatch, authority_items=authority_items)

    with caplog.at_level(logging.WARNING, logger=hierarchy.logger.name):
        state = load_governance_state()

    assert [u.unit_id for u in state.authority_units] == ["u-good"]


def test_case_law_sorted_by_precedence_desc(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_ddb(
        monkeypatch,
        case_law_items=[
            _case_law_row("case-low", precedence=1),
            _case_law_row("case-high", precedence=10),
            _case_law_row("case-mid", precedence=5),
        ],
    )

    state = load_governance_state()

    assert [e.case_id for e in state.case_law] == ["case-high", "case-mid", "case-low"]


def test_case_law_revoked_rows_excluded(monkeypatch: pytest.MonkeyPatch) -> None:
    # US-ARB-013: revoked=True rows are soft-deleted and must not reach the engine.
    items = [
        _case_law_row("case-active", precedence=1),
        {**_case_law_row("case-revoked", precedence=10), "revoked": True},
    ]
    _install_fake_ddb(monkeypatch, case_law_items=items)

    state = load_governance_state()

    assert [e.case_id for e in state.case_law] == ["case-active"]


def test_governance_state_fields_populated(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_ddb(
        monkeypatch,
        authority_items=[_authority_unit_row("u-1", registry_id="*GLOBAL*")],
        contract_items=[_composition_contract_row("c-1")],
        case_law_items=[_case_law_row("case-1")],
        layer_items=[_constitutional_layer_row("l-1")],
    )

    before = time.time()
    state = load_governance_state(registry_id="app-42")
    after = time.time()

    assert isinstance(state, GovernanceState)
    assert isinstance(state.authority_units[0], AuthorityUnit)
    assert isinstance(state.composition_contracts[0], CompositionContract)
    assert isinstance(state.case_law[0], CaseLawEntry)
    assert isinstance(state.constitutional_layers[0], ConstitutionalLayer)
    assert state.registry_id == "app-42"
    assert before <= state.loaded_at <= after


def test_boto3_resource_constructed_lazily(monkeypatch: pytest.MonkeyPatch) -> None:
    """QB-013-1: boto3.resource must not fire until a load actually happens."""
    call_count = {"n": 0}

    original_resource = hierarchy.boto3.resource

    def counting_resource(service_name: str) -> Any:
        call_count["n"] += 1
        return FakeDynamoDBResource({}, {"calls": 0})

    monkeypatch.setattr(hierarchy.boto3, "resource", counting_resource)

    # Importing/using the dataclass should not construct a resource.
    _ = GovernanceState()
    assert call_count["n"] == 0

    # Unset env vars — no scan needed, no resource expected.
    for name in _ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    load_governance_state()
    assert call_count["n"] == 0, (
        "boto3.resource should not be called when no tables are configured"
    )

    # Restore original before the fixture tears down.
    monkeypatch.setattr(hierarchy.boto3, "resource", original_resource)


# ---------------------------------------------------------------------------
# Property test (AC 6): per-app intersection contains only *GLOBAL* units
# ---------------------------------------------------------------------------


# Finite universe of app ids (excluding *GLOBAL* and None).
_APP_IDS = ["app-1", "app-2", "app-3", "app-4"]
_ALL_UNIT_APP_TAGS = _APP_IDS + ["*GLOBAL*"]


@st.composite
def _unit_rows(draw: st.DrawFn) -> list[dict]:
    size = draw(st.integers(min_value=0, max_value=20))
    rows: list[dict] = []
    for i in range(size):
        tag = draw(st.sampled_from(_ALL_UNIT_APP_TAGS))
        rows.append(_authority_unit_row(f"u-{i}", registry_id=tag))
    return rows


@given(
    rows=_unit_rows(),
    pair=st.lists(
        st.sampled_from(_APP_IDS), min_size=2, max_size=2, unique=True
    ),
)
@settings(max_examples=200, deadline=None)
def test_property_two_app_intersections_contain_only_global(
    rows: list[dict], pair: list[str]
) -> None:
    app_a, app_b = pair[0], pair[1]

    # Build a fresh FakeDDB per example via a manual patch (monkeypatch is
    # per-function and Hypothesis cannot use function-scoped fixtures inside
    # @given without `@settings(phases=...)` gymnastics — patching directly
    # is cleaner).
    tables = {_ENV_VARS["AUTHORITY_UNITS_TABLE"]: rows}
    scan_counter: dict[str, int] = {"calls": 0}
    fake = FakeDynamoDBResource(tables, scan_counter)

    prev_env: dict[str, str | None] = {}
    for name, value in _ENV_VARS.items():
        prev_env[name] = os.environ.get(name)
        os.environ[name] = value
    try:
        with patch.object(hierarchy.boto3, "resource", lambda service_name: fake):
            __reset_hierarchy_cache_for_test()
            state_a = load_governance_state(registry_id=app_a)
            state_b = load_governance_state(registry_id=app_b)
    finally:
        for name, previous in prev_env.items():
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous
        __reset_hierarchy_cache_for_test()

    ids_a = {u.unit_id: u for u in state_a.authority_units}
    ids_b = {u.unit_id: u for u in state_b.authority_units}
    shared_ids = set(ids_a) & set(ids_b)

    for unit_id in shared_ids:
        unit = ids_a[unit_id]
        assert unit.registry_id == "*GLOBAL*", (
            f"Unit {unit_id} with registry_id={unit.registry_id!r} leaked across "
            f"registry_id={app_a!r} and registry_id={app_b!r}"
        )
        # And the same unit as seen from the other filter must agree.
        assert ids_b[unit_id].registry_id == "*GLOBAL*"
