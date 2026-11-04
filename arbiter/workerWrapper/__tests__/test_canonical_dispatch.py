"""Tests for worker thin-pointer resolution (CIT-272).

Verifies:
  - load_config_from_dynamodb follows _canonicalRecordId when config is
    absent/empty.
  - The resolved item carries the canonical row's config.
  - The resolved item's agentId is set to the recordId (for S3 scoped key).
  - A full-config (non-pointer) name-keyed row is returned unchanged.
  - KeyError when the canonical row is missing or lacks config.
"""
import json
import os
import sys
import pytest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")

# ---------------------------------------------------------------------------
# Stateful fake DynamoDB table
# ---------------------------------------------------------------------------
class FakeTable:
    def __init__(self, items: dict | None = None):
        self.items = items or {}

    def get_item(self, *, Key):
        key = list(Key.values())[0]
        item = self.items.get(key)
        return {'Item': dict(item)} if item else {}

    def put_item(self, *, Item):
        key = Item.get('agentId')
        self.items[key] = dict(Item)


class FakeResource:
    def __init__(self, table):
        self._table = table

    def Table(self, name):
        return self._table


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class TestPointerResolution:
    def _load(self, table_items):
        """Helper: calls load_config_from_dynamodb with a fake table."""
        fake_table = FakeTable(table_items)
        fake_resource = FakeResource(fake_table)
        with patch('index.__reset_boto3_clients_for_test') as _:
            pass
        # Patch the module-level _dynamodb
        import index
        original = index._dynamodb
        index._dynamodb = fake_resource
        try:
            return index.load_config_from_dynamodb
        finally:
            pass  # We'll restore in each test

    def test_follows_pointer_to_canonical_row(self):
        items = {
            'demo-echo-agent': {
                'agentId': 'demo-echo-agent',
                '_canonicalRecordId': 'mjaKkVyqoFGN',
                'state': 'active',
                'orgId': 'All Organizations',
                'registryStatus': 'APPROVED',
            },
            'mjaKkVyqoFGN': {
                'agentId': 'mjaKkVyqoFGN',
                'name': 'demo-echo-agent',
                'config': {
                    'name': 'demo-echo-agent',
                    'filename': 'demo_echo_agent.py',
                    'description': 'Demo agent',
                    'schema': {},
                    'version': '1',
                    'action': {'type': 'sqs', 'target': 'q'},
                },
                'citadelKind': 'agent',
                'orgId': 'All Organizations',
            },
        }
        fake_table = FakeTable(items)
        import index
        old_ddb = index._dynamodb
        index._dynamodb = FakeResource(fake_table)
        try:
            result = index.load_config_from_dynamodb('demo-echo-agent')
            assert result['config']['filename'] == 'demo_echo_agent.py'
            # agentId replaced with canonical recordId for S3 key derivation
            assert result['agentId'] == 'mjaKkVyqoFGN'
            # Pointer-level fields preserved
            assert result['state'] == 'active'
            assert result['registryStatus'] == 'APPROVED'
        finally:
            index._dynamodb = old_ddb

    def test_non_pointer_row_returned_unchanged(self):
        """A full-config name-keyed row (legacy or fabricated) is returned as-is."""
        items = {
            'my-agent': {
                'agentId': 'my-agent',
                'config': {
                    'name': 'my-agent',
                    'filename': 'my_agent.py',
                },
                'state': 'active',
                'orgId': 'Default',
            },
        }
        fake_table = FakeTable(items)
        import index
        old_ddb = index._dynamodb
        index._dynamodb = FakeResource(fake_table)
        try:
            result = index.load_config_from_dynamodb('my-agent')
            assert result['config']['filename'] == 'my_agent.py'
            assert result['agentId'] == 'my-agent'
        finally:
            index._dynamodb = old_ddb

    def test_raises_when_canonical_row_missing(self):
        items = {
            'demo-echo-agent': {
                'agentId': 'demo-echo-agent',
                '_canonicalRecordId': 'missing-id',
                'state': 'active',
            },
        }
        fake_table = FakeTable(items)
        import index
        old_ddb = index._dynamodb
        index._dynamodb = FakeResource(fake_table)
        try:
            with pytest.raises(KeyError, match="Canonical row.*not found"):
                index.load_config_from_dynamodb('demo-echo-agent')
        finally:
            index._dynamodb = old_ddb

    def test_raises_when_agent_not_found(self):
        fake_table = FakeTable({})
        import index
        old_ddb = index._dynamodb
        index._dynamodb = FakeResource(fake_table)
        try:
            with pytest.raises(KeyError, match="Agent config not found"):
                index.load_config_from_dynamodb('nonexistent')
        finally:
            index._dynamodb = old_ddb

    def test_pointer_with_empty_dict_config_still_resolves(self):
        """config={} on the pointer row triggers resolution."""
        items = {
            'agent-a': {
                'agentId': 'agent-a',
                '_canonicalRecordId': 'rec-123',
                'config': {},
                'state': 'active',
            },
            'rec-123': {
                'agentId': 'rec-123',
                'config': {'name': 'agent-a', 'filename': 'a.py'},
            },
        }
        fake_table = FakeTable(items)
        import index
        old_ddb = index._dynamodb
        index._dynamodb = FakeResource(fake_table)
        try:
            result = index.load_config_from_dynamodb('agent-a')
            assert result['config']['filename'] == 'a.py'
            assert result['agentId'] == 'rec-123'
        finally:
            index._dynamodb = old_ddb
