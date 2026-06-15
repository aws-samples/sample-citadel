"""Tests for arbiter/fabricator/design_assessment_gate.py (US-ARB-017).

Covers the seven specified unit paths plus a Hypothesis property test
that asserts the gate's decision truth table over random inputs.

The gate module caches boto3's ddb resource in a module-global; per
QB-013-1 each test must call ``__reset_clients_for_test()`` in its
setup to avoid leaking state between tests.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any
from unittest.mock import patch

import pytest
from hypothesis import given, settings, strategies as st

# Make the fabricator module importable as a top-level module, mirroring
# the pattern used in the other fabricator tests.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import design_assessment_gate  # noqa: E402
from design_assessment_gate import (  # noqa: E402
    DesignAssessmentMissingError,
    check_design_assessment,
)


# ---------------------------------------------------------------------------
# Fake DDB table mirroring boto3 Table.get_item contract
# ---------------------------------------------------------------------------


class FakeTable:
    """Minimal dict-backed stand-in for a boto3 DynamoDB Table.

    Records every ``get_item`` call so tests can assert no DDB call was
    made in the no-op paths.
    """

    def __init__(self, item: dict[str, Any] | None = None) -> None:
        self._item = item
        self.calls: list[dict[str, Any]] = []

    def get_item(self, **kwargs: Any) -> dict[str, Any]:  # noqa: N802 - boto3 API
        self.calls.append(kwargs)
        assert "Key" in kwargs, "get_item must be called with a Key kwarg"
        assert "projectId" in kwargs["Key"], (
            "design-assessment gate must query by 'projectId' partition key"
        )
        if self._item is None:
            return {}
        return {"Item": dict(self._item)}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_gate_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reset the module-global boto3 cache and default env var before each
    test (QB-013-1). Each test opts into its own env var configuration.
    """
    design_assessment_gate.__reset_clients_for_test()
    monkeypatch.setenv("AGENT_DESIGN_ASSESSMENTS_TABLE", "citadel-agent-design-assessments-test")
    yield
    design_assessment_gate.__reset_clients_for_test()


@pytest.fixture
def fake_table() -> FakeTable:
    """Fresh empty FakeTable bound via ``_get_table`` patch for a single test."""
    table = FakeTable()
    with patch.object(design_assessment_gate, "_get_table", return_value=table):
        yield table


# ---------------------------------------------------------------------------
# 1-4: no-op paths -- gate must return None and must NOT hit DDB.
# ---------------------------------------------------------------------------


def test_no_op_when_project_id_is_none() -> None:
    table = FakeTable()
    with patch.object(design_assessment_gate, "_get_table", return_value=table):
        result = check_design_assessment(None)
    assert result is None
    assert table.calls == [], "gate must not hit DDB when project_id is None"


def test_no_op_when_project_id_is_empty_string() -> None:
    table = FakeTable()
    with patch.object(design_assessment_gate, "_get_table", return_value=table):
        result = check_design_assessment("")
    assert result is None
    assert table.calls == [], "gate must not hit DDB when project_id is empty"


def test_bypassed_when_grandfathered_true_even_without_assessment() -> None:
    table = FakeTable(item=None)  # no row
    with patch.object(design_assessment_gate, "_get_table", return_value=table):
        result = check_design_assessment("proj-123", grandfathered=True)
    assert result is None
    assert table.calls == [], (
        "gate must not hit DDB when grandfathered=True -- upstream owns the bypass"
    )


def test_no_op_when_env_var_unset_logs_warning(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """When AGENT_DESIGN_ASSESSMENTS_TABLE is unset, _get_table() returns
    None and the gate short-circuits with a WARNING-level log line.
    """
    monkeypatch.delenv("AGENT_DESIGN_ASSESSMENTS_TABLE", raising=False)
    # Force _get_table to go through its real implementation so the env
    # var check actually fires.
    caplog.set_level(logging.WARNING, logger="design_assessment_gate")
    result = check_design_assessment("proj-123")
    assert result is None
    assert any(
        "AGENT_DESIGN_ASSESSMENTS_TABLE unset" in rec.message
        for rec in caplog.records
    ), "missing-table fallback must log at WARNING level"


# ---------------------------------------------------------------------------
# 5: pass path
# ---------------------------------------------------------------------------


def test_pass_when_row_present_and_completed_at_set() -> None:
    table = FakeTable(
        item={"projectId": "proj-123", "completedAt": "2026-04-01T12:00:00Z"}
    )
    with patch.object(design_assessment_gate, "_get_table", return_value=table):
        result = check_design_assessment("proj-123")
    assert result is None
    assert len(table.calls) == 1
    assert table.calls[0]["Key"] == {"projectId": "proj-123"}


# ---------------------------------------------------------------------------
# 6-7: fail paths
# ---------------------------------------------------------------------------


def test_fail_when_row_missing() -> None:
    table = FakeTable(item=None)
    with patch.object(design_assessment_gate, "_get_table", return_value=table):
        with pytest.raises(DesignAssessmentMissingError) as excinfo:
            check_design_assessment("proj-missing")
    assert "No AgentDesignAssessment row found" in str(excinfo.value)
    assert "proj-missing" in str(excinfo.value)


def test_fail_when_row_present_but_completed_at_falsy_none() -> None:
    table = FakeTable(item={"projectId": "proj-pending", "completedAt": None})
    with patch.object(design_assessment_gate, "_get_table", return_value=table):
        with pytest.raises(DesignAssessmentMissingError) as excinfo:
            check_design_assessment("proj-pending")
    assert "not marked completed" in str(excinfo.value)
    assert "proj-pending" in str(excinfo.value)


def test_fail_when_row_present_but_completed_at_empty_string() -> None:
    table = FakeTable(item={"projectId": "proj-pending", "completedAt": ""})
    with patch.object(design_assessment_gate, "_get_table", return_value=table):
        with pytest.raises(DesignAssessmentMissingError) as excinfo:
            check_design_assessment("proj-pending")
    assert "not marked completed" in str(excinfo.value)


def test_fail_when_row_present_but_completed_at_missing_key() -> None:
    """Row exists but has no completedAt attribute at all."""
    table = FakeTable(item={"projectId": "proj-pending"})
    with patch.object(design_assessment_gate, "_get_table", return_value=table):
        with pytest.raises(DesignAssessmentMissingError) as excinfo:
            check_design_assessment("proj-pending")
    assert "not marked completed" in str(excinfo.value)


# ---------------------------------------------------------------------------
# 8: Hypothesis property test — gate decision truth table
# ---------------------------------------------------------------------------


# A project id strategy that yields both falsy (None, "") and truthy
# values so the property covers every branch of the decision table.
_project_ids = st.one_of(
    st.none(),
    st.just(""),
    st.text(min_size=1, max_size=32).filter(lambda s: bool(s.strip())),
)


@settings(max_examples=200, deadline=None)
@given(
    project_id=_project_ids,
    grandfathered=st.booleans(),
    assessment_exists=st.booleans(),
    completed=st.booleans(),
    env_set=st.booleans(),
)
def test_property_gate_decision_truth_table(
    project_id: str | None,
    grandfathered: bool,
    assessment_exists: bool,
    completed: bool,
    env_set: bool,
) -> None:
    """Property: the gate raises DesignAssessmentMissingError iff

        project_id is truthy
        AND NOT grandfathered
        AND env var is set
        AND (assessment missing OR not completed)

    Otherwise the gate returns None silently.
    """
    # Build the fake table state. If the row exists but completed=False,
    # we emit completedAt='' (falsy); if completed=True, a real ISO stamp.
    if assessment_exists:
        item: dict[str, Any] | None = {
            "projectId": project_id or "unused",
            "completedAt": "2026-04-01T00:00:00Z" if completed else "",
        }
    else:
        item = None

    table = FakeTable(item=item)

    # Compute expected outcome.
    expect_raise = (
        bool(project_id)
        and not grandfathered
        and env_set
        and (not assessment_exists or not completed)
    )

    # Reset globals at property-example boundary (Hypothesis reuses the
    # process across examples; QB-013-1).
    design_assessment_gate.__reset_clients_for_test()

    with patch.dict(
        os.environ,
        {"AGENT_DESIGN_ASSESSMENTS_TABLE": "citadel-agent-design-assessments-test"}
        if env_set
        else {},
        clear=not env_set,
    ):
        # When env_set is False, ensure the var is truly absent for this
        # example even if the outer process had it set.
        if not env_set:
            os.environ.pop("AGENT_DESIGN_ASSESSMENTS_TABLE", None)
        with patch.object(
            design_assessment_gate, "_get_table", return_value=table if env_set else None
        ):
            if expect_raise:
                with pytest.raises(DesignAssessmentMissingError):
                    check_design_assessment(project_id, grandfathered=grandfathered)
            else:
                result = check_design_assessment(project_id, grandfathered=grandfathered)
                assert result is None



# ---------------------------------------------------------------------------
# PR 4 T2: projectId fallback via catalog.registry_client.get_source_project_id
# ---------------------------------------------------------------------------
#
# The fabricator's ``process_event`` gate extraction first reads
# ``agent_input.projectId`` (which the TS fabricator-request-resolver writes
# from ``AgentApp.sourceProjectId``). When that field is absent -- e.g. for
# apps fabricated before the resolver propagated the field, or registry
# records created directly bypassing AgentApp -- the code now attempts a
# secondary resolution via the PR 1 catalog bridge:
# ``catalog.registry_client.get_source_project_id(registry_id, record_id)``.
# The fallback degrades gracefully if the catalog Layer is unavailable
# (ImportError) or if the client raises (ClientError / anything else).
#
# Each test patches ``index.check_design_assessment`` with a short-circuit
# sentinel so execution halts at the gate boundary and we can assert on the
# exact ``project_id`` value the gate would have received, without dragging
# in Strands / boto3 / Bedrock model construction.


class TestProjectIdFallback:
    """Tests covering the five PR 4 T2 fallback paths in process_event."""

    @pytest.fixture(autouse=True)
    def _setup_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Env vars required at index.py import time.
        monkeypatch.setenv("TOOL_CONFIG_TABLE", "fake-tool-table")
        monkeypatch.setenv("AGENT_CONFIG_TABLE", "fake-agent-table")
        monkeypatch.setenv("AGENT_BUCKET_NAME", "fake-bucket")
        monkeypatch.setenv("COMPLETION_BUS_NAME", "fake-bus")
        monkeypatch.setenv("WORKER_QUEUE_URL", "https://sqs.fake/queue")
        # Put arbiter/ on sys.path so ``catalog.registry_client`` is
        # importable from within the fabricator fallback block.
        arbiter_root = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..")
        )
        monkeypatch.syspath_prepend(arbiter_root)
        yield

    @staticmethod
    def _base_event(**agent_input_overrides: Any) -> dict[str, Any]:
        agent_input: dict[str, Any] = {"taskDetails": "build something"}
        agent_input.update(agent_input_overrides)
        return {
            "orchestration_id": "orch-1",
            "agent_use_id": "use-1",
            "node": "fabricator",
            "agent_input": agent_input,
        }

    # ------------------------------------------------------------------
    # 1. Primary path unchanged: projectId present -> no fallback call.
    # ------------------------------------------------------------------
    def test_primary_path_projectid_present_skips_fallback(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import index  # noqa: PLC0415 - late import; env vars set in fixture

        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        event = self._base_event(projectId="proj-primary", agentId="agent-1")

        sentinel = RuntimeError("short-circuit after gate")
        with patch.object(
            index, "check_design_assessment", side_effect=sentinel
        ) as mock_gate, patch(
            "catalog.registry_client.get_source_project_id"
        ) as mock_get:
            with pytest.raises(RuntimeError, match="short-circuit"):
                index.process_event(event, None)

        assert mock_gate.call_args.args[0] == "proj-primary"
        mock_get.assert_not_called()

    # ------------------------------------------------------------------
    # 2. Fallback hit: projectId None, REGISTRY_ID + agentId present,
    #    registry_client returns 'proj-42' -> gate sees 'proj-42'.
    # ------------------------------------------------------------------
    def test_fallback_hit_resolves_project_id_from_registry(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import index  # noqa: PLC0415

        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        event = self._base_event(agentId="agent-42")

        sentinel = RuntimeError("short-circuit after gate")
        with patch.object(
            index, "check_design_assessment", side_effect=sentinel
        ) as mock_gate, patch(
            "catalog.registry_client.get_source_project_id",
            return_value="proj-42",
        ) as mock_get:
            with pytest.raises(RuntimeError, match="short-circuit"):
                index.process_event(event, None)

        mock_get.assert_called_once_with("reg-1", "agent-42")
        assert mock_gate.call_args.args[0] == "proj-42"

    # ------------------------------------------------------------------
    # 3. Fallback graceful degrade on ImportError.
    #    Setting sys.modules[name] = None makes ``from name import X``
    #    raise ModuleNotFoundError (subclass of ImportError) -- documented
    #    CPython behaviour. See https://docs.python.org/3/reference/import.html
    # ------------------------------------------------------------------
    def test_fallback_graceful_degrade_on_import_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import index  # noqa: PLC0415

        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        monkeypatch.setitem(sys.modules, "catalog.registry_client", None)
        event = self._base_event(agentId="agent-5")

        sentinel = RuntimeError("short-circuit after gate")
        with patch.object(
            index, "check_design_assessment", side_effect=sentinel
        ) as mock_gate:
            with pytest.raises(RuntimeError, match="short-circuit"):
                index.process_event(event, None)

        # Fallback swallowed ImportError; project_id stays None.
        assert mock_gate.call_args.args[0] is None

    # ------------------------------------------------------------------
    # 4. Fallback graceful degrade on client exception (ClientError).
    # ------------------------------------------------------------------
    def test_fallback_graceful_degrade_on_client_error(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from botocore.exceptions import ClientError  # noqa: PLC0415

        import index  # noqa: PLC0415

        monkeypatch.setenv("REGISTRY_ID", "reg-1")
        event = self._base_event(agentId="agent-9")

        client_err = ClientError(
            {"Error": {"Code": "ResourceNotFoundException", "Message": "nope"}},
            "GetAgentRuntime",
        )
        sentinel = RuntimeError("short-circuit after gate")
        with patch.object(
            index, "check_design_assessment", side_effect=sentinel
        ) as mock_gate, patch(
            "catalog.registry_client.get_source_project_id",
            side_effect=client_err,
        ) as mock_get:
            with pytest.raises(RuntimeError, match="short-circuit"):
                index.process_event(event, None)

        mock_get.assert_called_once_with("reg-1", "agent-9")
        assert mock_gate.call_args.args[0] is None

    # ------------------------------------------------------------------
    # 5. Fallback skipped when REGISTRY_ID env var is absent.
    # ------------------------------------------------------------------
    def test_fallback_skipped_when_registry_id_env_absent(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import index  # noqa: PLC0415

        monkeypatch.delenv("REGISTRY_ID", raising=False)
        event = self._base_event(agentId="agent-7")

        sentinel = RuntimeError("short-circuit after gate")
        with patch.object(
            index, "check_design_assessment", side_effect=sentinel
        ) as mock_gate, patch(
            "catalog.registry_client.get_source_project_id"
        ) as mock_get:
            with pytest.raises(RuntimeError, match="short-circuit"):
                index.process_event(event, None)

        mock_get.assert_not_called()
        assert mock_gate.call_args.args[0] is None
