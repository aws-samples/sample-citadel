"""
Property tests for the capability rule.
Validates Requirement 5.7 (FabricationError on missing spec_id for code-
generating tools) and the conservative-default behaviour (R4).

Consistency note (QT3-6 defence-in-depth):
  The fabrication-time check (`validate_code_tool_binding`) and the
  dispatch-time check (Track B's `SpecificationNotBoundError` in
  arbiter/workerWrapper/index.py) MUST agree on whether a manifest is
  code-generating. That agreement is guaranteed structurally by both
  call-sites delegating to `is_code_generating` in this module. Do NOT
  duplicate the rule in workerWrapper — import it.
"""
import csv
import os
import sys
import tempfile
from pathlib import Path

import pytest
from hypothesis import given, settings, strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tools_config import ( # noqa: E402
    FabricationError,
    is_code_generating,
    validate_code_tool_binding,
    assert_spec_approved,
    audit_tool_manifests,
)

# ---------------------------------------------------------------------------
# 1. is_code_generating — deterministic cases
# ---------------------------------------------------------------------------

class TestIsCodeGenerating:
    def test_missing_outputs_is_conservative_true(self):
        """R4: missing outputs key ⇒ treat as code-generating (conservative)."""
        assert is_code_generating({"name": "t1"}) is True

    def test_outputs_contains_code_only(self):
        assert is_code_generating({"name": "t1", "outputs": ["code"]}) is True

    def test_outputs_contains_code_with_others(self):
        assert is_code_generating(
            {"name": "t1", "outputs": ["code", "json"]}
        ) is True

    def test_outputs_empty_list_is_not_code_generating(self):
        """Empty list = explicit "no outputs declared" but is still a list,
        so not conservative — it's treated as non-code-generating."""
        assert is_code_generating({"name": "t1", "outputs": []}) is False

    def test_outputs_list_without_code(self):
        assert is_code_generating(
            {"name": "t1", "outputs": ["json", "text"]}
        ) is False

    def test_outputs_string_raises_value_error(self):
        with pytest.raises(ValueError):
            is_code_generating({"name": "t1", "outputs": "code"})

    def test_outputs_dict_raises_value_error(self):
        with pytest.raises(ValueError):
            is_code_generating({"name": "t1", "outputs": {"code": True}})

    def test_outputs_case_sensitive(self):
        """The rule is case-sensitive: 'Code' / 'CODE' must NOT match."""
        assert is_code_generating({"name": "t1", "outputs": ["Code"]}) is False
        assert is_code_generating({"name": "t1", "outputs": ["CODE"]}) is False

# ---------------------------------------------------------------------------
# 2. validate_code_tool_binding — backlog AC 1, 2, 3
# ---------------------------------------------------------------------------

class TestValidateCodeToolBinding:
    def test_ac1_code_generating_without_spec_id_raises(self):
        """AC 1: code-generating manifest + no spec_id → FabricationError."""
        with pytest.raises(FabricationError):
            validate_code_tool_binding({"name": "t", "outputs": ["code"]}, None)

    def test_ac1_code_generating_with_empty_spec_id_raises(self):
        with pytest.raises(FabricationError):
            validate_code_tool_binding({"name": "t", "outputs": ["code"]}, "")

    def test_ac2_code_generating_with_spec_id_ok(self):
        """AC 2: code-generating + valid spec_id → no error."""
        validate_code_tool_binding(
            {"name": "t", "outputs": ["code"]}, "spec-123"
        )

    def test_ac3_missing_outputs_without_spec_id_raises(self):
        """AC 3 (R4): missing outputs is conservatively code-generating, so
        the absence of spec_id is a violation."""
        with pytest.raises(FabricationError):
            validate_code_tool_binding({"name": "t"}, None)

    def test_non_code_generating_without_spec_id_ok(self):
        validate_code_tool_binding(
            {"name": "t", "outputs": ["json", "text"]}, None
        )

    def test_non_code_generating_with_spec_id_ok(self):
        """A non-code-generating manifest with a spec_id is allowed."""
        validate_code_tool_binding(
            {"name": "t", "outputs": ["json"]}, "spec-999"
        )

# ---------------------------------------------------------------------------
# 3. assert_spec_approved — status gating
# ---------------------------------------------------------------------------

class FakeTable:
    def __init__(self, item=None):
        self._item = item

    def get_item(self, Key): # noqa: N803 — mirrors boto3 API
        assert "specId" in Key, (
            "assert_spec_approved must query by 'specId' partition key"
        )
        if self._item is None:
            return {}
        return {"Item": self._item}

class FakeDDBResource:
    def __init__(self, table):
        self._table = table
        self.last_table_name = None

    def Table(self, name): # noqa: N802 — mirrors boto3 API
        self.last_table_name = name
        return self._table

class TestAssertSpecApproved:
    def test_row_missing_raises(self):
        ddb = FakeDDBResource(FakeTable(item=None))
        with pytest.raises(FabricationError, match="spec not found"):
            assert_spec_approved(
                "spec-abc", table_name="test-table", ddb_resource=ddb
            )

    def test_row_draft_raises_with_status(self):
        ddb = FakeDDBResource(
            FakeTable(item={"specId": "spec-abc", "status": "DRAFT"})
        )
        with pytest.raises(FabricationError, match="DRAFT"):
            assert_spec_approved(
                "spec-abc", table_name="test-table", ddb_resource=ddb
            )

    def test_row_pending_review_raises(self):
        ddb = FakeDDBResource(
            FakeTable(item={"specId": "spec-abc", "status": "PENDING_REVIEW"})
        )
        with pytest.raises(FabricationError, match="PENDING_REVIEW"):
            assert_spec_approved(
                "spec-abc", table_name="test-table", ddb_resource=ddb
            )

    def test_row_rejected_raises(self):
        ddb = FakeDDBResource(
            FakeTable(item={"specId": "spec-abc", "status": "REJECTED"})
        )
        with pytest.raises(FabricationError, match="REJECTED"):
            assert_spec_approved(
                "spec-abc", table_name="test-table", ddb_resource=ddb
            )

    def test_row_approved_returns_none(self):
        ddb = FakeDDBResource(
            FakeTable(item={"specId": "spec-abc", "status": "APPROVED"})
        )
        result = assert_spec_approved(
            "spec-abc", table_name="test-table", ddb_resource=ddb
        )
        assert result is None

    def test_table_name_is_passed_to_resource(self):
        ddb = FakeDDBResource(
            FakeTable(item={"specId": "x", "status": "APPROVED"})
        )
        assert_spec_approved("x", table_name="test-table", ddb_resource=ddb)
        assert ddb.last_table_name == "test-table"

    def test_table_name_falls_back_to_env_var(self, monkeypatch):
        monkeypatch.setenv("EXECUTION_SPECS_TABLE", "env-table")
        ddb = FakeDDBResource(
            FakeTable(item={"specId": "x", "status": "APPROVED"})
        )
        assert_spec_approved("x", ddb_resource=ddb)
        assert ddb.last_table_name == "env-table"

    def test_missing_table_name_raises(self, monkeypatch):
        monkeypatch.delenv("EXECUTION_SPECS_TABLE", raising=False)
        ddb = FakeDDBResource(FakeTable(item=None))
        with pytest.raises(FabricationError):
            assert_spec_approved("x", ddb_resource=ddb)

# ---------------------------------------------------------------------------
# 4. audit_tool_manifests — CSV output
# ---------------------------------------------------------------------------

class TestAuditToolManifests:
    def test_csv_has_expected_columns_and_rows(self):
        manifests = [
            {"name": "code-gen", "outputs": ["code"]},
            {"name": "reporter", "outputs": ["json", "text"]},
            {"name": "no-outputs-field"}, # missing outputs — conservative
            {"name": "empty-outputs", "outputs": []},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "sub", "audit.csv")
            result_path = audit_tool_manifests(manifests, output_path=out)

            assert result_path == os.path.abspath(out)
            assert os.path.exists(out)

            with open(out, newline="") as fh:
                reader = csv.DictReader(fh)
                rows = list(reader)
                assert reader.fieldnames == [
                    "name",
                    "has_outputs_field",
                    "outputs_value",
                    "is_code_generating",
                    "requires_spec_id",
                ]

        # Deterministic ordering: sorted by name
        assert [r["name"] for r in rows] == [
            "code-gen",
            "empty-outputs",
            "no-outputs-field",
            "reporter",
        ]

        by_name = {r["name"]: r for r in rows}

        # Column values — is_code_generating must match the pure function
        assert by_name["code-gen"]["is_code_generating"] == "True"
        assert by_name["code-gen"]["has_outputs_field"] == "True"
        assert by_name["code-gen"]["requires_spec_id"] == "True"

        assert by_name["reporter"]["is_code_generating"] == "False"
        assert by_name["reporter"]["has_outputs_field"] == "True"
        assert by_name["reporter"]["requires_spec_id"] == "False"

        assert by_name["no-outputs-field"]["is_code_generating"] == "True"
        assert by_name["no-outputs-field"]["has_outputs_field"] == "False"
        assert by_name["no-outputs-field"]["requires_spec_id"] == "True"

        assert by_name["empty-outputs"]["is_code_generating"] == "False"
        assert by_name["empty-outputs"]["has_outputs_field"] == "True"
        assert by_name["empty-outputs"]["requires_spec_id"] == "False"

    def test_audit_rows_match_pure_function(self):
        manifests = [
            {"name": "a", "outputs": ["code"]},
            {"name": "b", "outputs": ["json"]},
            {"name": "c"},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "audit.csv")
            audit_tool_manifests(manifests, output_path=out)
            with open(out, newline="") as fh:
                rows = list(csv.DictReader(fh))

        for row in rows:
            matching = next(m for m in manifests if m["name"] == row["name"])
            expected = is_code_generating(matching)
            assert row["is_code_generating"] == str(expected)

    def test_parent_directory_is_created(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "a", "b", "c", "audit.csv")
            audit_tool_manifests(
                [{"name": "t", "outputs": ["code"]}], output_path=out
            )
            assert Path(out).exists()

# ---------------------------------------------------------------------------
# 5. Property test — fabrication-time check is consistent
# ---------------------------------------------------------------------------

_name_alphabet = st.characters(
    whitelist_categories=("L", "N"),
    whitelist_characters="-_",
)

_tool_manifests = st.builds(
    lambda name, outputs: (
        {"name": name} if outputs is None else {"name": name, "outputs": outputs}
    ),
    name=st.text(min_size=1, max_size=30, alphabet=_name_alphabet),
    outputs=st.one_of(
        st.none(),
        st.lists(
            st.sampled_from(["code", "json", "text", "binary"]), max_size=4
        ),
    ),
)

_spec_ids = st.one_of(st.none(), st.text(min_size=1, max_size=20))

@given(manifest=_tool_manifests, spec_id=_spec_ids)
@settings(max_examples=300, deadline=None)
def test_validate_is_consistent_with_is_code_generating(manifest, spec_id):
    """The fabrication-time check raises iff the manifest is code-generating
    AND the spec_id is None or empty.

    This property is what guarantees Track B's dispatch-time check agrees —
    both sides delegate to `is_code_generating`.
    """
    is_code = is_code_generating(manifest)
    should_raise = is_code and (spec_id is None or spec_id == "")

    if should_raise:
        with pytest.raises(FabricationError):
            validate_code_tool_binding(manifest, spec_id)
    else:
        # Must not raise.
        validate_code_tool_binding(manifest, spec_id)
