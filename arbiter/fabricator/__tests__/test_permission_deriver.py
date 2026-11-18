"""Tests for permission_deriver.derive_required_permissions (PR-4): deny-
default, least-privilege stamping of requiredPermissions from declared
integration/data-store bindings.

Owner decision 5750aeec: FAIL CLOSED, no grandfathering.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hypothesis import given, strategies as st

from permission_deriver import derive_required_permissions, EMPTY_PERMISSIONS


class TestDeriveRequiredPermissionsDenyDefault:
    def test_no_bindings_returns_explicit_empty_set(self):
        assert derive_required_permissions(None, None) == EMPTY_PERMISSIONS

    def test_empty_lists_returns_explicit_empty_set(self):
        assert derive_required_permissions([], []) == EMPTY_PERMISSIONS

    def test_result_is_never_none(self):
        assert derive_required_permissions(None, None) is not None
        assert derive_required_permissions([], []) is not None


class TestDeriveRequiredPermissionsIntegrations:
    def test_single_integration_binding(self):
        result = derive_required_permissions(
            [{"integrationId": "int-1", "integrationType": "jira", "direction": "input"}],
            None,
        )
        assert result["integrations"] == ["int-1"]
        assert result["dataStores"] == []

    def test_multiple_integration_bindings_preserved(self):
        result = derive_required_permissions(
            [
                {"integrationId": "int-1", "direction": "input"},
                {"integrationId": "int-2", "direction": "output"},
            ],
            None,
        )
        assert set(result["integrations"]) == {"int-1", "int-2"}

    def test_binding_missing_id_is_skipped(self):
        result = derive_required_permissions(
            [{"integrationType": "jira", "direction": "input"}], None,
        )
        assert result["integrations"] == []

    def test_non_dict_binding_entries_are_skipped(self):
        result = derive_required_permissions(["not-a-dict", 123, None], None)
        assert result["integrations"] == []


class TestDeriveRequiredPermissionsDataStores:
    def test_single_datastore_binding(self):
        result = derive_required_permissions(
            None, [{"dataStoreId": "ds-1", "direction": "bidirectional"}],
        )
        assert result["dataStores"] == ["ds-1"]
        assert result["integrations"] == []

    def test_multiple_datastore_bindings_preserved(self):
        result = derive_required_permissions(
            None,
            [
                {"dataStoreId": "ds-1", "direction": "input"},
                {"dataStoreId": "ds-2", "direction": "output"},
            ],
        )
        assert set(result["dataStores"]) == {"ds-1", "ds-2"}

    def test_binding_missing_id_is_skipped(self):
        result = derive_required_permissions(
            None, [{"dataStoreType": "dynamodb", "direction": "input"}],
        )
        assert result["dataStores"] == []



class TestDeriveRequiredPermissionsModels:
    def test_resolved_model_id_populates_models_key(self):
        result = derive_required_permissions(None, None, resolved_model_id="anthropic.claude-v2")
        assert result["models"] == ["anthropic.claude-v2"]

    def test_no_resolved_model_yields_empty_models_list(self):
        result = derive_required_permissions(None, None)
        assert result["models"] == []

    def test_models_key_always_present_in_result(self):
        result = derive_required_permissions([], [])
        assert "models" in result
        assert isinstance(result["models"], list)

    def test_models_combined_with_integrations_and_datastores(self):
        result = derive_required_permissions(
            [{"integrationId": "int-1"}],
            [{"dataStoreId": "ds-1"}],
            resolved_model_id="anthropic.claude-v2",
        )
        assert result["integrations"] == ["int-1"]
        assert result["dataStores"] == ["ds-1"]
        assert result["models"] == ["anthropic.claude-v2"]

class TestDeriveRequiredPermissionsBoth:
    def test_integrations_and_datastores_both_present(self):
        result = derive_required_permissions(
            [{"integrationId": "int-1", "direction": "input"}],
            [{"dataStoreId": "ds-1", "direction": "output"}],
        )
        assert result["integrations"] == ["int-1"]
        assert result["dataStores"] == ["ds-1"]


# ---------------------------------------------------------------------------
# Property-based coverage over arbitrary binding lists (Hypothesis).
# ---------------------------------------------------------------------------

_binding_strategy = st.fixed_dictionaries({
    "integrationId": st.one_of(st.none(), st.text(min_size=1, max_size=20)),
    "direction": st.sampled_from(["input", "output", "bidirectional", "unknown", None]),
})

_datastore_binding_strategy = st.fixed_dictionaries({
    "dataStoreId": st.one_of(st.none(), st.text(min_size=1, max_size=20)),
    "direction": st.sampled_from(["input", "output", "bidirectional", "unknown", None]),
})


class TestDeriveRequiredPermissionsProperties:
    @given(
        integration_bindings=st.lists(_binding_strategy, max_size=10),
        datastore_bindings=st.lists(_datastore_binding_strategy, max_size=10),
    )
    def test_every_bound_id_with_valid_id_appears_in_result(
        self, integration_bindings, datastore_bindings,
    ):
        result = derive_required_permissions(integration_bindings, datastore_bindings)
        expected_integrations = {
            b["integrationId"] for b in integration_bindings
            if isinstance(b.get("integrationId"), str) and b["integrationId"]
        }
        expected_datastores = {
            b["dataStoreId"] for b in datastore_bindings
            if isinstance(b.get("dataStoreId"), str) and b["dataStoreId"]
        }
        assert set(result["integrations"]) == expected_integrations
        assert set(result["dataStores"]) == expected_datastores

    @given(
        integration_bindings=st.lists(_binding_strategy, max_size=10),
        datastore_bindings=st.lists(_datastore_binding_strategy, max_size=10),
    )
    def test_result_always_has_both_keys(self, integration_bindings, datastore_bindings):
        result = derive_required_permissions(integration_bindings, datastore_bindings)
        assert "integrations" in result
        assert "dataStores" in result
        assert isinstance(result["integrations"], list)
        assert isinstance(result["dataStores"], list)

    @given(garbage=st.lists(st.one_of(st.none(), st.integers(), st.text()), max_size=5))
    def test_non_dict_entries_never_raise(self, garbage):
        # Must never raise regardless of malformed input shapes.
        derive_required_permissions(garbage, garbage)
