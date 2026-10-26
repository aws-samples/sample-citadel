"""Unit tests for common.tenant_guard — the shared tenant-isolation module."""
from __future__ import annotations

import logging
import pytest
from hypothesis import given, strategies as st, assume

from common.tenant_guard import (
    OrgMismatchError,
    filter_by_org,
    require_same_org,
)


# ---------------------------------------------------------------------------
# require_same_org — happy path
# ---------------------------------------------------------------------------
class TestRequireSameOrgMatch:
    def test_matching_org_passes(self):
        record = {"agentId": "a1", "orgId": "org-a"}
        require_same_org(record, "org-a", component="test")

    def test_system_record_passes_when_allow_system(self):
        record = {"agentId": "echo", "orgId": ""}
        require_same_org(record, "org-a", allow_system=True, component="test")

    def test_system_record_rejected_when_allow_system_false(self):
        record = {"agentId": "echo", "orgId": ""}
        with pytest.raises(OrgMismatchError) as exc_info:
            require_same_org(record, "org-a", allow_system=False, component="test")
        assert exc_info.value.record_id == "echo"
        assert exc_info.value.component == "test"


# ---------------------------------------------------------------------------
# require_same_org — mismatch
# ---------------------------------------------------------------------------
class TestRequireSameOrgMismatch:
    def test_different_org_raises(self):
        record = {"agentId": "b1", "orgId": "org-b"}
        with pytest.raises(OrgMismatchError) as exc_info:
            require_same_org(record, "org-a", component="worker")
        err = exc_info.value
        assert err.record_org == "org-b"
        assert err.bound_org == "org-a"
        assert err.record_id == "b1"
        assert err.component == "worker"

    def test_missing_orgId_treated_as_empty(self):
        """A record without an orgId key is rejected (fail-closed).
        With allow_system=False, absent orgId is a mismatch."""
        record = {"agentId": "x1"}
        with pytest.raises(OrgMismatchError):
            require_same_org(record, "org-a", component="test")

    def test_missing_orgId_rejected_even_with_system(self):
        """A record without orgId is NOT treated as system-shared — fail closed.
        Only an explicit orgId == '' counts as system."""
        record = {"agentId": "x1"}
        with pytest.raises(OrgMismatchError):
            require_same_org(record, "org-a", allow_system=True, component="test")

    def test_custom_fields(self):
        record = {"toolId": "t1", "org": "org-b"}
        with pytest.raises(OrgMismatchError):
            require_same_org(
                record,
                "org-a",
                record_id_field="toolId",
                org_field="org",
                component="fabricator",
            )


# ---------------------------------------------------------------------------
# require_same_org — structured logging
# ---------------------------------------------------------------------------
class TestRequireSameOrgLogging:
    def test_mismatch_logs_error(self, caplog):
        record = {"agentId": "bad", "orgId": "org-b"}
        with caplog.at_level(logging.ERROR), pytest.raises(OrgMismatchError):
            require_same_org(record, "org-a", component="worker")
        assert "TenantOrgMismatch" in caplog.text
        assert "bad" in caplog.text


# ---------------------------------------------------------------------------
# filter_by_org
# ---------------------------------------------------------------------------
class TestFilterByOrg:
    def test_filters_to_matching_org(self):
        items = [
            {"agentId": "a1", "orgId": "org-a"},
            {"agentId": "b1", "orgId": "org-b"},
            {"agentId": "a2", "orgId": "org-a"},
        ]
        result = filter_by_org(items, "org-a", component="test")
        assert [r["agentId"] for r in result] == ["a1", "a2"]

    def test_includes_system_when_allowed(self):
        items = [
            {"agentId": "a1", "orgId": "org-a"},
            {"agentId": "sys", "orgId": ""},
        ]
        result = filter_by_org(items, "org-a", allow_system=True, component="test")
        assert len(result) == 2

    def test_excludes_system_when_not_allowed(self):
        items = [
            {"agentId": "a1", "orgId": "org-a"},
            {"agentId": "sys", "orgId": ""},
        ]
        result = filter_by_org(items, "org-a", allow_system=False, component="test")
        assert len(result) == 1
        assert result[0]["agentId"] == "a1"

    def test_empty_list(self):
        assert filter_by_org([], "org-a", component="test") == []


# ---------------------------------------------------------------------------
# Hypothesis property: filter_by_org NEVER returns another org's record
# ---------------------------------------------------------------------------
@given(
    org_a=st.text(min_size=1, max_size=20, alphabet=st.characters(categories=("L", "N"))),
    org_b=st.text(min_size=1, max_size=20, alphabet=st.characters(categories=("L", "N"))),
    n_a=st.integers(min_value=0, max_value=10),
    n_b=st.integers(min_value=0, max_value=10),
    n_sys=st.integers(min_value=0, max_value=3),
)
def test_filter_never_returns_another_orgs_record(org_a, org_b, n_a, n_b, n_sys):
    """Invariant: filter_by_org(items, org_a) never includes org_b items."""
    assume(org_a != org_b)
    assume(org_a != "")
    assume(org_b != "")
    items = (
        [{"agentId": f"a{i}", "orgId": org_a} for i in range(n_a)]
        + [{"agentId": f"b{i}", "orgId": org_b} for i in range(n_b)]
        + [{"agentId": f"sys{i}", "orgId": ""} for i in range(n_sys)]
    )
    filtered = filter_by_org(items, org_a, allow_system=True, component="test")
    for item in filtered:
        assert item["orgId"] in (org_a, ""), (
            f"filter_by_org returned item with org={item['orgId']!r}, "
            f"expected org_a={org_a!r} or system ('')"
        )


# ---------------------------------------------------------------------------
# orgUnknown handling tests
# ---------------------------------------------------------------------------
class TestOrgUnknownRequireSameOrg:
    """require_same_org rejects orgUnknown rows (fail-closed)."""

    def test_orgUnknown_true_raises(self):
        record = {"agentId": "legacy-1", "orgId": "", "orgUnknown": True}
        with pytest.raises(OrgMismatchError):
            require_same_org(record, "org-a", allow_system=True, component="test")

    def test_orgUnknown_false_system_allowed(self):
        """orgUnknown=False with orgId='' is system-shared — should pass."""
        record = {"agentId": "sys-1", "orgId": "", "orgUnknown": False}
        require_same_org(record, "org-a", allow_system=True, component="test")

    def test_absent_orgId_raises(self):
        """No orgId key at all → fail closed."""
        record = {"agentId": "no-org"}
        with pytest.raises(OrgMismatchError):
            require_same_org(record, "org-a", allow_system=True, component="test")

    def test_explicit_empty_string_system_allowed(self):
        """Explicit orgId='' (no orgUnknown) is system-shared."""
        record = {"agentId": "seeded", "orgId": ""}
        require_same_org(record, "org-a", allow_system=True, component="test")


class TestOrgUnknownFilterByOrg:
    """filter_by_org excludes orgUnknown rows."""

    def test_excludes_orgUnknown_items(self):
        items = [
            {"agentId": "a1", "orgId": "org-a"},
            {"agentId": "legacy", "orgId": "", "orgUnknown": True},
            {"agentId": "sys", "orgId": ""},
        ]
        result = filter_by_org(items, "org-a", allow_system=True, component="test")
        ids = [r["agentId"] for r in result]
        assert "a1" in ids
        assert "sys" in ids
        assert "legacy" not in ids

    def test_excludes_absent_orgId_items(self):
        items = [
            {"agentId": "a1", "orgId": "org-a"},
            {"agentId": "no-org"},
        ]
        result = filter_by_org(items, "org-a", allow_system=True, component="test")
        assert len(result) == 1
        assert result[0]["agentId"] == "a1"
