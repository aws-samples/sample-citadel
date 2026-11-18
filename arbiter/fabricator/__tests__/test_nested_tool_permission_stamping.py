"""PR-4 (owner decision 5750aeec: FAIL CLOSED, no grandfathering) — the
NESTED tool-fabrication path (``_make_create_custom_tool`` /
``create_custom_tool``) must ALSO derive requiredPermissions from its own
integration/data-store bindings and thread them into
``store_tool_config_registry``, exactly like the outer process_event path.
"""
import json
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")
os.environ.setdefault("REGISTRY_ID", "fake-registry-id")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-west-2")

import index
from index import _make_create_custom_tool


def _make_registry_client_stub():
    client = MagicMock()
    client.list_registry_records.return_value = {"registryRecords": []}
    client.create_registry_record.return_value = {
        "recordArn": "arn:aws:agent-registry:us-west-2:123:registry/fake-registry-id/record/rec-new-001",
    }
    client.get_registry_record.return_value = {"status": "DRAFT"}
    client.submit_registry_record_for_approval.return_value = {"status": "APPROVED"}
    return client


class TestNestedCreateCustomToolStampsPermissions:
    def test_bindings_passed_to_create_custom_tool_derive_permissions(self):
        mock_client = _make_registry_client_stub()

        def spy_create_tool_fabricator(store_tool_tool=None):
            def fake_agent(prompt):
                store_tool_tool(
                    file_name="/tmp/nested_tool.py",
                    tool_id="nested_tool",
                    tool_schema={"type": "object"},
                    tool_description="A nested test tool",
                    integration_bindings=[{"integrationId": "int-nested", "direction": "input"}],
                    datastore_bindings=[{"dataStoreId": "ds-nested", "direction": "output"}],
                )
                return "done"
            return fake_agent

        with (
            patch.object(index, "create_tool_fabricator", side_effect=spy_create_tool_fabricator),
            patch.object(index, "_get_registry_client", return_value=mock_client),
            patch.object(index, "registration_checkpoint"),
            patch.object(index, "_emit_org_missing_metric"),
        ):
            bound_tool = _make_create_custom_tool(
                org_id="org-OUTER", requested_by="fabricator", spec_id=None,
            )
            bound_tool._tool_func(
                tool_description="Create a nested tool",
                integration_bindings=[{"integrationId": "int-nested", "direction": "input"}],
                datastore_bindings=[{"dataStoreId": "ds-nested", "direction": "output"}],
            )

        call_kwargs = mock_client.create_registry_record.call_args[1]
        custom_data = json.loads(call_kwargs["descriptors"]["custom"]["data"])
        assert custom_data["requiredPermissions"]["integrations"] == ["int-nested"]
        assert custom_data["requiredPermissions"]["dataStores"] == ["ds-nested"]
        assert custom_data["config"]["requiredPermissions"]["integrations"] == ["int-nested"]

    def test_no_bindings_yields_deny_default_empty_permissions(self):
        mock_client = _make_registry_client_stub()

        def spy_create_tool_fabricator(store_tool_tool=None):
            def fake_agent(prompt):
                store_tool_tool(
                    file_name="/tmp/nested_tool2.py",
                    tool_id="nested_tool2",
                    tool_schema={"type": "object"},
                    tool_description="A nested test tool with no bindings",
                )
                return "done"
            return fake_agent

        with (
            patch.object(index, "create_tool_fabricator", side_effect=spy_create_tool_fabricator),
            patch.object(index, "_get_registry_client", return_value=mock_client),
            patch.object(index, "registration_checkpoint"),
            patch.object(index, "_emit_org_missing_metric"),
        ):
            bound_tool = _make_create_custom_tool(
                org_id="org-OUTER", requested_by="fabricator", spec_id=None,
            )
            bound_tool._tool_func(tool_description="Create a tool with no bindings")

        call_kwargs = mock_client.create_registry_record.call_args[1]
        custom_data = json.loads(call_kwargs["descriptors"]["custom"]["data"])
        assert custom_data["requiredPermissions"] == {"integrations": [], "dataStores": []}
