"""Tests for org_id threading through stepRunner/events.py publish helpers
(finding: chatter-publisher refuses every workflow.* / supervisor.chatter
event because these producers never stamp detail.orgId). Mirrors the
run_id/eval_run_id precedent in test_events_run_id.py: additive, optional,
omitted-when-absent-or-falsy.
"""
import sys
import os
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock


@pytest.fixture
def mock_eb_client():
    with patch('events.eb_client') as mock_client:
        mock_client.put_events = MagicMock(return_value={'FailedEntryCount': 0})
        yield mock_client


def _entries(mock_eb_client):
    call_args = mock_eb_client.put_events.call_args
    return call_args[1].get('Entries') or call_args.kwargs.get('Entries')


class TestPublishEventOrgId:
    def test_org_id_merged_into_detail_when_passed(self, mock_eb_client):
        import events

        events.publish_event(
            'workflow.started', {'executionId': 'e1', 'correlationId': 'e1'},
            org_id='org-1',
        )
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['orgId'] == 'org-1'

    def test_org_id_omitted_when_absent(self, mock_eb_client):
        import events

        events.publish_event('workflow.started', {'executionId': 'e1', 'correlationId': 'e1'})
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'orgId' not in detail

    def test_org_id_omitted_when_empty_string(self, mock_eb_client):
        import events

        events.publish_event(
            'workflow.started', {'executionId': 'e1', 'correlationId': 'e1'},
            org_id='',
        )
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'orgId' not in detail


class TestWorkflowLifecycleHelpersOrgId:
    """workflow.* + supervisor.chatter: org_id threaded through so
    chatter-publisher.ts (which refuses any event with no detail.orgId)
    stops dropping every live workflow/node/chatter event.
    """

    def test_publish_workflow_started_includes_org_id(self, mock_eb_client):
        import events

        events.publish_workflow_started('e1', 'w1', 'a1', '2025-01-01T00:00:00Z', org_id='org-1')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['orgId'] == 'org-1'

    def test_publish_workflow_started_omits_org_id_when_absent(self, mock_eb_client):
        import events

        events.publish_workflow_started('e1', 'w1', 'a1', '2025-01-01T00:00:00Z')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'orgId' not in detail

    def test_publish_node_started_includes_org_id(self, mock_eb_client):
        import events

        events.publish_node_started('e2', 'w2', 'n1', 'ag1', '2025-01-01T00:00:00Z', org_id='org-2')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['orgId'] == 'org-2'

    def test_publish_node_completed_includes_org_id(self, mock_eb_client):
        import events

        events.publish_node_completed(
            'e3', 'w3', 'n2', 'ag2', '2025-01-01T00:01:00Z', {}, org_id='org-3',
        )
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['orgId'] == 'org-3'

    def test_publish_node_failed_includes_org_id(self, mock_eb_client):
        import events

        events.publish_node_failed('e4', 'w4', 'n3', 'ag3', 'boom', 0, org_id='org-4')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['orgId'] == 'org-4'

    def test_publish_node_retrying_includes_org_id(self, mock_eb_client):
        import events

        events.publish_node_retrying('e5', 'w5', 'n4', 'ag4', 1, 2.0, org_id='org-5')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['orgId'] == 'org-5'

    def test_publish_workflow_completed_includes_org_id(self, mock_eb_client):
        import events

        events.publish_workflow_completed('e6', 'w6', '2025-01-01T00:10:00Z', {}, org_id='org-6')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['orgId'] == 'org-6'

    def test_publish_workflow_failed_includes_org_id(self, mock_eb_client):
        import events

        events.publish_workflow_failed('e7', 'w7', 'n5', 'boom', '2025-01-01T00:10:00Z', org_id='org-7')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['orgId'] == 'org-7'

    def test_publish_supervisor_chatter_includes_org_id(self, mock_eb_client):
        import events

        events.publish_supervisor_chatter('e8', 'w8', 'n6', org_id='org-8')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert detail['orgId'] == 'org-8'

    def test_publish_supervisor_chatter_omits_org_id_when_absent(self, mock_eb_client):
        import events

        events.publish_supervisor_chatter('e9', 'w9', 'n7')
        detail = json.loads(_entries(mock_eb_client)[0]['Detail'])
        assert 'orgId' not in detail
