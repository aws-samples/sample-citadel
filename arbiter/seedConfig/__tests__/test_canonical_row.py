"""Tests for canonical recordId-keyed row seeding (CIT-272).

Verifies:
  - seedConfig writes one canonical row (agentId = recordId) with full config
    + projection fields + orgId 'All Organizations'.
  - seedConfig writes one thin pointer row (agentId = name) with
    _canonicalRecordId and no config.
  - Running twice produces exactly two rows per agent (idempotent upsert).
  - S3 scoped key agents/{recordId}/{basename} is created via copy.
  - Registry-unavailable fallback: legacy name-keyed full-config row.
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock, call

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/worker")
os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/fabricator")
os.environ.setdefault("AUTHORITY_UNITS_TABLE", "fake-authority-units-table")
os.environ.setdefault(
    "CONSTITUTIONAL_LAYERS_TABLE", "fake-constitutional-layers-table"
)
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-agent-bucket")

from index import (  # noqa: E402
    handler,
    ALL_ORGS,
    SEEDER_PROJECTION_VERSION,
    DEMO_ECHO_AGENT_ID,
    DEMO_ECHO_MODULE_FILENAME,
    FABRICATOR_AGENT_ID,
    _write_canonical_and_pointer,
    _copy_s3_to_scoped_key,
)

REGISTRY_ID = "fake-registry-id"
ECHO_RECORD_ID = "mjaKkVyqoFGN"
FABRICATOR_RECORD_ID = "6WsQHauFdu4h"


# ---------------------------------------------------------------------------
# Stateful fake DynamoDB table
# ---------------------------------------------------------------------------
class FakeTable:
    """In-memory DynamoDB Table fake — supports put_item and get_item."""

    def __init__(self):
        self.items: dict[str, dict] = {}

    def put_item(self, *, Item):
        key = Item.get('agentId') or Item.get('unitId') or Item.get('layerId')
        self.items[key] = dict(Item)

    def get_item(self, *, Key):
        key = list(Key.values())[0]
        item = self.items.get(key)
        return {'Item': item} if item else {}


# ---------------------------------------------------------------------------
# _write_canonical_and_pointer unit tests
# ---------------------------------------------------------------------------
class TestWriteCanonicalAndPointer:
    def test_writes_canonical_and_pointer(self):
        table = FakeTable()
        record_info = {
            'recordId': ECHO_RECORD_ID,
            'status': 'APPROVED',
            'createdAt': '2026-09-26T08:12:25.545Z',
        }
        config = {
            'name': 'demo-echo-agent',
            'filename': 'demo_echo_agent.py',
            'description': 'Demo agent',
            'schema': {},
            'version': '1',
            'action': {'type': 'sqs', 'target': 'https://sqs/q'},
        }
        _write_canonical_and_pointer(
            table, 'demo-echo-agent', record_info, config,
            description='Demo agent',
            categories=['built-in', 'worker', 'demo'],
        )
        canonical = table.items[ECHO_RECORD_ID]
        assert canonical['agentId'] == ECHO_RECORD_ID
        assert canonical['name'] == 'demo-echo-agent'
        assert canonical['config']['filename'] == 'demo_echo_agent.py'
        assert canonical['citadelKind'] == 'agent'
        assert canonical['projectionVersion'] == SEEDER_PROJECTION_VERSION
        assert canonical['orgId'] == ALL_ORGS
        assert canonical['createdBy'] == 'seedConfig'
        assert canonical['registryStatus'] == 'APPROVED'
        assert canonical['registryRecordId'] == ECHO_RECORD_ID
        assert 'projectedAt' in canonical

        pointer = table.items['demo-echo-agent']
        assert pointer['_canonicalRecordId'] == ECHO_RECORD_ID
        assert pointer['orgId'] == ALL_ORGS
        assert pointer['registryStatus'] == 'APPROVED'
        assert 'config' not in pointer

    def test_idempotent_double_write(self):
        """Running twice yields exactly one canonical + one pointer."""
        table = FakeTable()
        record_info = {
            'recordId': ECHO_RECORD_ID,
            'status': 'APPROVED',
            'createdAt': '2026-01-01T00:00:00Z',
        }
        config = {'name': 'echo', 'filename': 'echo.py', 'description': 'x',
                  'schema': {}, 'version': '1', 'action': {}}

        for _ in range(2):
            _write_canonical_and_pointer(
                table, 'demo-echo-agent', record_info, config,
                description='x', categories=['a'],
            )

        assert len(table.items) == 2
        assert ECHO_RECORD_ID in table.items
        assert 'demo-echo-agent' in table.items
        # Config intact on second run
        assert table.items[ECHO_RECORD_ID]['config']['filename'] == 'echo.py'

    def test_fallback_when_no_registry(self):
        """When record_info is None, writes a legacy name-keyed full-config row."""
        table = FakeTable()
        config = {'name': 'test', 'filename': 'test.py'}
        _write_canonical_and_pointer(
            table, 'test-agent', None, config,
            description='test', categories=[],
        )
        assert len(table.items) == 1
        item = table.items['test-agent']
        assert item['config']['filename'] == 'test.py'
        assert item['orgId'] == ALL_ORGS


# ---------------------------------------------------------------------------
# _copy_s3_to_scoped_key unit tests
# ---------------------------------------------------------------------------
class TestCopyS3ToScopedKey:
    def test_copies_when_scoped_key_missing(self):
        from botocore.exceptions import ClientError
        s3 = MagicMock()
        s3.head_object.side_effect = ClientError(
            {'Error': {'Code': '404'}}, 'HeadObject'
        )
        _copy_s3_to_scoped_key(s3, 'bucket', 'demo_echo_agent.py', 'recId')
        s3.copy_object.assert_called_once_with(
            Bucket='bucket',
            CopySource={'Bucket': 'bucket', 'Key': 'agents/demo_echo_agent.py'},
            Key='agents/recId/demo_echo_agent.py',
        )

    def test_skips_when_scoped_key_exists(self):
        s3 = MagicMock()
        s3.head_object.return_value = {}
        _copy_s3_to_scoped_key(s3, 'bucket', 'demo_echo_agent.py', 'recId')
        s3.copy_object.assert_not_called()


# ---------------------------------------------------------------------------
# Full handler integration — canonical rows written end-to-end
# ---------------------------------------------------------------------------
def _make_registry_client(echo_rid=ECHO_RECORD_ID, fab_rid=FABRICATOR_RECORD_ID):
    client = MagicMock(name="agent-registry-control-mock")
    # Map agent name → recordId for deterministic assignment
    rid_map = {
        'fabricator': fab_rid,
        'demo-echo-agent': echo_rid,
        'smoke-idempotency-agent': 'obEoj56JCATf',
    }

    def _create(**kwargs):
        name = kwargs.get('name', '')
        rid = rid_map.get(name, f'rec-{name}')
        return {
            'recordId': rid,
            'status': 'DRAFT',
            'createdAt': '2026-09-26T00:00:00Z',
        }

    client.create_registry_record.side_effect = _create
    client.submit_registry_record_for_approval.return_value = {
        'status': 'APPROVED'
    }
    return client


def _cfn_event():
    return {
        "RequestType": "Create",
        "ResponseURL": "https://cfn-response.example.com/callback",
        "StackId": "arn:aws:cloudformation:us-east-1:123456789012:stack/s",
        "RequestId": "req-1",
        "LogicalResourceId": "SeedAgentConfigResource",
    }


def _ctx():
    return type("Ctx", (), {"log_stream_name": "stream"})()


class TestHandlerCanonicalRows:
    """End-to-end: handler writes canonical + pointer rows for seeded agents."""

    def _run_handler(self, registry_client, existing_records=None,
                     smoke=False):
        existing_records = existing_records or []
        created = {}
        approved = set()

        # Capture the original side_effect before wrapping
        orig_se = registry_client.create_registry_record.side_effect

        def _create_se(**kwargs):
            result = orig_se(**kwargs)
            name = kwargs.get('name', '')
            created[name] = {
                'recordId': result.get('recordId'),
                'name': name,
                'status': result.get('status', 'DRAFT'),
                'createdAt': result.get('createdAt'),
            }
            return result

        registry_client.create_registry_record.side_effect = _create_se

        def _submit_se(**kwargs):
            rid = kwargs.get('recordId', '')
            for name, rec in created.items():
                if rec['recordId'] == rid:
                    approved.add(name)
                    rec['status'] = 'APPROVED'
            return {'status': 'APPROVED'}

        registry_client.submit_registry_record_for_approval.side_effect = _submit_se

        def _list_se(rid):
            result = list(existing_records)
            for name, rec in created.items():
                if not any(r.get('name') == name for r in result):
                    result.append(dict(rec))
            return result

        list_mock = MagicMock(side_effect=_list_se)

        def _client_factory(service_name, *args, **kwargs):
            if service_name == 'agent-registry-control':
                return registry_client
            mock = MagicMock(name=f'{service_name}-mock')
            # S3 mock: head_object raises 404 (scoped key doesn't exist)
            if service_name == 's3':
                from botocore.exceptions import ClientError
                mock.head_object.side_effect = ClientError(
                    {'Error': {'Code': '404'}}, 'HeadObject'
                )
            return mock

        table = FakeTable()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = table

        env = dict(os.environ)
        env['REGISTRY_ID'] = REGISTRY_ID
        env['REGISTRY_ENABLED'] = 'true'
        if smoke:
            env['SMOKE_FIXTURES_ENABLED'] = 'true'
        else:
            env.pop('SMOKE_FIXTURES_ENABLED', None)

        with patch.dict(os.environ, env, clear=True), \
             patch('index.boto3') as mock_boto3, \
             patch('index._SETTLE_SLEEP', 0), \
             patch('catalog.registry_client.list_agent_records', list_mock), \
             patch('cfnresponse.send') as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb
            mock_boto3.client.side_effect = _client_factory
            handler(_cfn_event(), _ctx())

        return table, mock_send

    def test_echo_canonical_and_pointer_exist(self):
        client = _make_registry_client()
        table, send = self._run_handler(client)
        assert send.call_args[0][2] == 'SUCCESS'

        canonical = table.items.get(ECHO_RECORD_ID)
        assert canonical is not None, f"Missing canonical row {ECHO_RECORD_ID}"
        assert canonical['config']['filename'] == 'demo_echo_agent.py'
        assert canonical['citadelKind'] == 'agent'
        assert canonical['projectionVersion'] == SEEDER_PROJECTION_VERSION
        assert canonical['orgId'] == ALL_ORGS
        assert canonical['createdBy'] == 'seedConfig'

        pointer = table.items.get(DEMO_ECHO_AGENT_ID)
        assert pointer is not None
        assert pointer['_canonicalRecordId'] == ECHO_RECORD_ID
        assert 'config' not in pointer
        assert pointer['orgId'] == ALL_ORGS

    def test_fabricator_canonical_and_pointer_exist(self):
        client = _make_registry_client()
        table, _ = self._run_handler(client)

        canonical = table.items.get(FABRICATOR_RECORD_ID)
        assert canonical is not None
        assert canonical['name'] == 'fabricator'
        assert canonical['citadelKind'] == 'agent'
        assert canonical['orgId'] == ALL_ORGS

        pointer = table.items.get('fabricator')
        assert pointer is not None
        assert pointer['_canonicalRecordId'] == FABRICATOR_RECORD_ID
        assert 'config' not in pointer

    def test_idempotent_two_runs_same_rows(self):
        """Running handler twice → same two rows per agent, config intact."""
        client = _make_registry_client()
        # First run
        table1, _ = self._run_handler(client)
        echo1 = table1.items[ECHO_RECORD_ID]

        # Second run with existing records
        existing = [
            {'recordId': FABRICATOR_RECORD_ID, 'name': 'fabricator',
             'status': 'APPROVED'},
            {'recordId': ECHO_RECORD_ID, 'name': 'demo-echo-agent',
             'status': 'APPROVED'},
        ]
        client2 = _make_registry_client()
        table2, _ = self._run_handler(client2, existing_records=existing)

        # Same canonical row, config preserved
        echo2 = table2.items[ECHO_RECORD_ID]
        assert echo2['config']['filename'] == echo1['config']['filename']
        # Pointer exists
        assert 'demo-echo-agent' in table2.items
        assert table2.items['demo-echo-agent']['_canonicalRecordId'] == ECHO_RECORD_ID

    def test_orgId_all_organizations_in_descriptor(self):
        """Registry descriptor carries orgId='All Organizations', not ''."""
        client = _make_registry_client()
        self._run_handler(client)
        # Check the create call metadata
        for c in client.create_registry_record.call_args_list:
            data = json.loads(c.kwargs['descriptors']['custom']['data'])
            assert data['orgId'] == ALL_ORGS, (
                f"Expected orgId='{ALL_ORGS}', got '{data['orgId']}'"
            )
