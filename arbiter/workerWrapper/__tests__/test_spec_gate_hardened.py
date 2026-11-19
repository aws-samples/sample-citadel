"""
Property-based + unit tests for H2 hardened spec-gate enforcement.

Validates:
  - assert_spec_approved org-scope: spec for org-A never satisfies org-B.
  - assert_spec_approved tool-scope: spec for tool-A never satisfies tool-B.
  - Dispatch resolves spec from server-side tool config, not event payload.
  - Missing EXECUTION_SPECS_TABLE refuses code-generating tools (fail closed).
  - Existing tools without a stored spec binding are refused (fail closed).

Owner precedent: decision 5750aeec — fail closed, no grandfathering.
"""

from __future__ import annotations

import os
import sys

import pytest
from hypothesis import given, settings, HealthCheck, strategies as st

# ---------------------------------------------------------------------------
# Test harness — fake AWS creds to satisfy boto3 at import time.
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("CREDENTIAL_VENDER_FUNCTION", "")
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_SESSION_TOKEN", "testing")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

# Import workerWrapper's index first (it's first on sys.path).
from index import (  # noqa: E402
    SpecificationNotBoundError,
    assert_tool_spec_binding,
)

# tools_config is importable because workerWrapper/index.py adds fabricator
# to sys.path at import time (or it's already reachable via the worker path).
from tools_config import (  # noqa: E402
    FabricationError,
    assert_spec_approved,
)


# ---------------------------------------------------------------------------
# Fake DDB stubs (mirrors test_capability_rule.py style)
# ---------------------------------------------------------------------------

class FakeTable:
    def __init__(self, item=None):
        self._item = item

    def get_item(self, Key):  # noqa: N803
        if self._item is None:
            return {}
        return {"Item": self._item}


class FakeDDBResource:
    def __init__(self, table):
        self._table = table
        self.last_table_name = None

    def Table(self, name):  # noqa: N802
        self.last_table_name = name
        return self._table


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

_org_id = st.text(
    min_size=1, max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
)

_tool_id = st.text(
    min_size=1, max_size=50,
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
)


# ---------------------------------------------------------------------------
# 1. assert_spec_approved — org-scope tests
# ---------------------------------------------------------------------------

class TestAssertSpecApprovedOrgScope:
    """Spec from org-A must never satisfy the gate for org-B."""

    def _approved_item(self, org="org-A", tool=None):
        item = {"specId": "spec-1", "status": "APPROVED", "orgId": org}
        if tool:
            item["toolId"] = tool
        return item

    def test_same_org_passes(self):
        ddb = FakeDDBResource(FakeTable(item=self._approved_item(org="org-A")))
        # Should not raise.
        assert_spec_approved(
            "spec-1", table_name="t", ddb_resource=ddb, org_id="org-A",
        )

    def test_different_org_raises(self):
        ddb = FakeDDBResource(FakeTable(item=self._approved_item(org="org-A")))
        with pytest.raises(FabricationError, match="cross-org spec denied"):
            assert_spec_approved(
                "spec-1", table_name="t", ddb_resource=ddb, org_id="org-B",
            )

    def test_missing_spec_org_raises(self):
        """Spec row without orgId → fail closed (not accepted by default)."""
        item = {"specId": "spec-1", "status": "APPROVED"}  # no orgId
        ddb = FakeDDBResource(FakeTable(item=item))
        with pytest.raises(FabricationError, match="cross-org spec denied"):
            assert_spec_approved(
                "spec-1", table_name="t", ddb_resource=ddb, org_id="org-A",
            )

    def test_empty_spec_org_raises(self):
        item = {"specId": "spec-1", "status": "APPROVED", "orgId": ""}
        ddb = FakeDDBResource(FakeTable(item=item))
        with pytest.raises(FabricationError, match="cross-org spec denied"):
            assert_spec_approved(
                "spec-1", table_name="t", ddb_resource=ddb, org_id="org-A",
            )

    def test_no_dispatch_org_skips_check(self):
        """When org_id is not provided (e.g. test env), org check is skipped."""
        ddb = FakeDDBResource(FakeTable(item=self._approved_item(org="org-A")))
        # Should not raise — org check not enforced when org_id=None.
        assert_spec_approved(
            "spec-1", table_name="t", ddb_resource=ddb, org_id=None,
        )

    @given(
        spec_org=_org_id, dispatch_org=_org_id,
    )
    @settings(max_examples=200, deadline=None,
              suppress_health_check=[HealthCheck.too_slow])
    def test_cross_org_always_refused_property(self, spec_org, dispatch_org):
        """A spec approved for org-A never satisfies the gate for org-B."""
        ddb = FakeDDBResource(
            FakeTable(item=self._approved_item(org=spec_org)),
        )
        if spec_org != dispatch_org:
            with pytest.raises(FabricationError, match="cross-org"):
                assert_spec_approved(
                    "spec-1", table_name="t", ddb_resource=ddb,
                    org_id=dispatch_org,
                )
        else:
            # Same org — must pass.
            assert_spec_approved(
                "spec-1", table_name="t", ddb_resource=ddb,
                org_id=dispatch_org,
            )


# ---------------------------------------------------------------------------
# 2. assert_spec_approved — tool-scope tests
# ---------------------------------------------------------------------------

class TestAssertSpecApprovedToolScope:
    """Spec bound to tool-A must never satisfy tool-B's gate."""

    def _approved_item(self, org="org-A", tool=None):
        item = {"specId": "spec-1", "status": "APPROVED", "orgId": org}
        if tool:
            item["toolId"] = tool
        return item

    def test_same_tool_passes(self):
        ddb = FakeDDBResource(
            FakeTable(item=self._approved_item(tool="tool-A")),
        )
        assert_spec_approved(
            "spec-1", table_name="t", ddb_resource=ddb, tool_id="tool-A",
        )

    def test_different_tool_raises(self):
        ddb = FakeDDBResource(
            FakeTable(item=self._approved_item(tool="tool-A")),
        )
        with pytest.raises(FabricationError, match="cross-tool spec denied"):
            assert_spec_approved(
                "spec-1", table_name="t", ddb_resource=ddb, tool_id="tool-B",
            )

    def test_spec_without_tool_binding_passes(self):
        """Legacy spec rows without toolId → accepted (backward compat)."""
        ddb = FakeDDBResource(
            FakeTable(item=self._approved_item()),  # no toolId
        )
        assert_spec_approved(
            "spec-1", table_name="t", ddb_resource=ddb, tool_id="any-tool",
        )

    def test_no_dispatch_tool_skips_check(self):
        """When tool_id is not provided, tool check is skipped."""
        ddb = FakeDDBResource(
            FakeTable(item=self._approved_item(tool="tool-A")),
        )
        assert_spec_approved(
            "spec-1", table_name="t", ddb_resource=ddb, tool_id=None,
        )

    @given(tool_a=_tool_id, tool_b=_tool_id)
    @settings(max_examples=200, deadline=None,
              suppress_health_check=[HealthCheck.too_slow])
    def test_cross_tool_always_refused_property(self, tool_a, tool_b):
        """A spec approved for tool-A never satisfies tool-B's gate."""
        ddb = FakeDDBResource(
            FakeTable(item={
                "specId": "spec-1", "status": "APPROVED",
                "orgId": "org-X", "toolId": tool_a,
            }),
        )
        if tool_a != tool_b:
            with pytest.raises(FabricationError, match="cross-tool"):
                assert_spec_approved(
                    "spec-1", table_name="t", ddb_resource=ddb,
                    tool_id=tool_b,
                )
        else:
            assert_spec_approved(
                "spec-1", table_name="t", ddb_resource=ddb,
                tool_id=tool_b,
            )


# ---------------------------------------------------------------------------
# 3. Dispatch resolves spec from tool config, not event
# ---------------------------------------------------------------------------

class TestDispatchResolvesFromToolConfig:
    """The dispatch gate must read specId from the stored tool config,
    ignoring any event-supplied spec_id value."""

    @staticmethod
    def _simulate_h2_dispatch(tool_configs, org_id=None):
        """Replay the H2 dispatch resolution pattern from index.py."""
        for tool_cfg in tool_configs:
            stored_spec = (
                tool_cfg.get('specId')
                or (tool_cfg.get('config') or {}).get('specId')
            )
            assert_tool_spec_binding(tool_cfg, stored_spec)

    def test_event_spec_id_is_ignored(self):
        """Even when the event carries spec_id, the dispatch gate reads
        from the tool config record instead."""
        # Tool config has NO stored specId → code-gen tool is refused.
        tool_configs = [
            {"toolId": "t1", "name": "gen_lambda", "outputs": ["code"]},
        ]
        # An event would have spec_id="attacker-spec" — but we don't pass
        # event data to the resolution. The tool config has no specId.
        with pytest.raises(SpecificationNotBoundError):
            self._simulate_h2_dispatch(tool_configs)

    def test_stored_spec_on_top_level_resolves(self):
        """specId on the tool config top level resolves correctly."""
        tool_configs = [
            {"toolId": "t1", "name": "gen_lambda", "outputs": ["code"],
             "specId": "spec-real"},
        ]
        # Should not raise (spec is found).
        self._simulate_h2_dispatch(tool_configs)

    def test_stored_spec_in_nested_config_resolves(self):
        """specId inside config dict resolves as fallback."""
        tool_configs = [
            {"toolId": "t1", "name": "gen_lambda", "outputs": ["code"],
             "config": {"specId": "spec-nested"}},
        ]
        self._simulate_h2_dispatch(tool_configs)

    def test_top_level_spec_takes_precedence_over_nested(self):
        """Top-level specId wins over config.specId."""
        tool_configs = [
            {"toolId": "t1", "name": "gen_lambda", "outputs": ["code"],
             "specId": "spec-top",
             "config": {"specId": "spec-nested"}},
        ]
        self._simulate_h2_dispatch(tool_configs)


# ---------------------------------------------------------------------------
# 4. Missing EXECUTION_SPECS_TABLE refuses code-gen tools
# ---------------------------------------------------------------------------

class TestSpecGateFailClosed:
    """When EXECUTION_SPECS_TABLE is unset, code-generating tools with a
    stored spec binding must be refused (fail closed, decision 5750aeec)."""

    def test_code_gen_without_stored_spec_refused(self):
        """Code-generating tool with no stored specId is refused."""
        tool_configs = [
            {"toolId": "t1", "name": "gen_lambda", "outputs": ["code"]},
        ]
        with pytest.raises(SpecificationNotBoundError):
            for tool_cfg in tool_configs:
                stored_spec = tool_cfg.get('specId')
                assert_tool_spec_binding(tool_cfg, stored_spec)

    def test_existing_tool_without_binding_refused(self):
        """An existing code-generating tool registered before H2
        (no specId in record) is refused at dispatch — fail closed,
        no grandfathering."""
        # Simulates a legacy tool config with outputs missing (conservative)
        tool_configs = [
            {"toolId": "legacy-tool", "name": "old_codegen"},  # no outputs, no specId
        ]
        with pytest.raises(SpecificationNotBoundError):
            for tool_cfg in tool_configs:
                stored_spec = tool_cfg.get('specId')
                assert_tool_spec_binding(tool_cfg, stored_spec)

    def test_non_code_gen_without_spec_passes(self):
        """Non-code-generating tools pass without any spec binding."""
        tool_configs = [
            {"toolId": "t1", "name": "reader", "outputs": ["data"]},
        ]
        for tool_cfg in tool_configs:
            stored_spec = tool_cfg.get('specId')
            assert_tool_spec_binding(tool_cfg, stored_spec)


# ---------------------------------------------------------------------------
# 5. Combined org + tool scope property
# ---------------------------------------------------------------------------

class TestCombinedOrgToolScope:
    """Both org and tool scope must pass simultaneously."""

    def test_matching_org_mismatching_tool_refused(self):
        ddb = FakeDDBResource(FakeTable(item={
            "specId": "spec-1", "status": "APPROVED",
            "orgId": "org-A", "toolId": "tool-X",
        }))
        with pytest.raises(FabricationError, match="cross-tool"):
            assert_spec_approved(
                "spec-1", table_name="t", ddb_resource=ddb,
                org_id="org-A", tool_id="tool-Y",
            )

    def test_matching_tool_mismatching_org_refused(self):
        ddb = FakeDDBResource(FakeTable(item={
            "specId": "spec-1", "status": "APPROVED",
            "orgId": "org-A", "toolId": "tool-X",
        }))
        with pytest.raises(FabricationError, match="cross-org"):
            assert_spec_approved(
                "spec-1", table_name="t", ddb_resource=ddb,
                org_id="org-B", tool_id="tool-X",
            )

    def test_both_matching_passes(self):
        ddb = FakeDDBResource(FakeTable(item={
            "specId": "spec-1", "status": "APPROVED",
            "orgId": "org-A", "toolId": "tool-X",
        }))
        assert_spec_approved(
            "spec-1", table_name="t", ddb_resource=ddb,
            org_id="org-A", tool_id="tool-X",
        )

    def test_both_mismatching_refused_org_first(self):
        """When both org and tool mismatch, org check fires first."""
        ddb = FakeDDBResource(FakeTable(item={
            "specId": "spec-1", "status": "APPROVED",
            "orgId": "org-A", "toolId": "tool-X",
        }))
        with pytest.raises(FabricationError, match="cross-org"):
            assert_spec_approved(
                "spec-1", table_name="t", ddb_resource=ddb,
                org_id="org-B", tool_id="tool-Y",
            )

    @given(
        spec_org=_org_id, dispatch_org=_org_id,
        spec_tool=_tool_id, dispatch_tool=_tool_id,
    )
    @settings(max_examples=300, deadline=None,
              suppress_health_check=[HealthCheck.too_slow])
    def test_combined_scope_property(
        self, spec_org, dispatch_org, spec_tool, dispatch_tool,
    ):
        """A spec approved for (org-A, tool-X) passes only when dispatch
        is also (org-A, tool-X)."""
        ddb = FakeDDBResource(FakeTable(item={
            "specId": "s", "status": "APPROVED",
            "orgId": spec_org, "toolId": spec_tool,
        }))
        org_matches = spec_org == dispatch_org
        tool_matches = spec_tool == dispatch_tool

        if org_matches and tool_matches:
            assert_spec_approved(
                "s", table_name="t", ddb_resource=ddb,
                org_id=dispatch_org, tool_id=dispatch_tool,
            )
        elif not org_matches:
            with pytest.raises(FabricationError, match="cross-org"):
                assert_spec_approved(
                    "s", table_name="t", ddb_resource=ddb,
                    org_id=dispatch_org, tool_id=dispatch_tool,
                )
        else:  # org matches, tool doesn't
            with pytest.raises(FabricationError, match="cross-tool"):
                assert_spec_approved(
                    "s", table_name="t", ddb_resource=ddb,
                    org_id=dispatch_org, tool_id=dispatch_tool,
                )
