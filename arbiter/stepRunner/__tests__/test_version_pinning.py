"""
Tests for workflow definition version pinning (CIT-259 H5).

Verifies that _load_workflow_for_execution returns the snapshot when present,
falls back to the LIVE row when absent, emits a metric on fallback, and that
handle_node_completion uses the pinned definition.
"""

import sys
import os
import json
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import patch, MagicMock, ANY

import executor
import timeout_watchdog as watchdog


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

WORKFLOW_ID = 'wf-pin-test'
EXECUTION_ID = 'exec-pin-test'

DEFINITION_V1 = json.dumps({
    'nodes': [{'id': 'n1'}, {'id': 'n2'}],
    'edges': [{'id': 'e1', 'source': 'n1', 'target': 'n2'}],
})

DEFINITION_V2 = json.dumps({
    'nodes': [{'id': 'n1'}, {'id': 'n2'}, {'id': 'n3'}],
    'edges': [
        {'id': 'e1', 'source': 'n1', 'target': 'n2'},
        {'id': 'e2', 'source': 'n2', 'target': 'n3'},
    ],
})

CONFIG_V1 = json.dumps({'model': 'claude-v1'})


# ---------------------------------------------------------------------------
# executor._load_workflow_for_execution
# ---------------------------------------------------------------------------

class TestLoadWorkflowForExecution:
    def test_returns_snapshot_when_present(self):
        execution = {
            'executionId': EXECUTION_ID,
            'workflowId': WORKFLOW_ID,
            'workflowDefinitionSnapshot': DEFINITION_V1,
            'workflowConfigurationSnapshot': CONFIG_V1,
        }
        result = executor._load_workflow_for_execution(execution)

        assert result['workflowId'] == WORKFLOW_ID
        assert result['definition'] == DEFINITION_V1
        assert result['configuration'] == CONFIG_V1

    def test_falls_back_to_live_when_no_snapshot(self):
        execution = {
            'executionId': EXECUTION_ID,
            'workflowId': WORKFLOW_ID,
        }
        live_workflow = {
            'workflowId': WORKFLOW_ID,
            'definition': DEFINITION_V2,
            'configuration': '{}',
        }
        with patch.object(executor, '_load_workflow', return_value=live_workflow) as mock_load, \
             patch.object(executor, '_emit_metric') as mock_metric:
            result = executor._load_workflow_for_execution(execution)

        assert result['definition'] == DEFINITION_V2
        mock_load.assert_called_once_with(WORKFLOW_ID)
        # Fallback should emit a metric
        mock_metric.assert_called_once_with('WorkflowPinFallback', 1, 'Count')

    def test_snapshot_takes_precedence_over_live(self):
        """Even if a live workflow exists, the snapshot wins."""
        execution = {
            'executionId': EXECUTION_ID,
            'workflowId': WORKFLOW_ID,
            'workflowDefinitionSnapshot': DEFINITION_V1,
            'workflowConfigurationSnapshot': CONFIG_V1,
        }
        with patch.object(executor, '_load_workflow') as mock_load:
            result = executor._load_workflow_for_execution(execution)

        # Should NOT call _load_workflow when snapshot is present
        mock_load.assert_not_called()
        assert result['definition'] == DEFINITION_V1

    def test_default_configuration_when_snapshot_config_missing(self):
        execution = {
            'executionId': EXECUTION_ID,
            'workflowId': WORKFLOW_ID,
            'workflowDefinitionSnapshot': DEFINITION_V1,
        }
        result = executor._load_workflow_for_execution(execution)
        assert result['configuration'] == '{}'


# ---------------------------------------------------------------------------
# watchdog._load_workflow_for_execution
# ---------------------------------------------------------------------------

class TestWatchdogLoadWorkflowForExecution:
    def test_returns_snapshot_when_present(self):
        execution = {
            'executionId': EXECUTION_ID,
            'workflowId': WORKFLOW_ID,
            'workflowDefinitionSnapshot': DEFINITION_V1,
            'workflowConfigurationSnapshot': CONFIG_V1,
        }
        result = watchdog._load_workflow_for_execution(execution)

        assert result['workflowId'] == WORKFLOW_ID
        assert result['definition'] == DEFINITION_V1
        assert result['configuration'] == CONFIG_V1

    def test_falls_back_to_live_when_no_snapshot(self):
        execution = {
            'executionId': EXECUTION_ID,
            'workflowId': WORKFLOW_ID,
        }
        live_workflow = {
            'workflowId': WORKFLOW_ID,
            'definition': DEFINITION_V2,
            'configuration': '{}',
        }
        with patch.object(watchdog, '_load_workflow', return_value=live_workflow) as mock_load, \
             patch.object(watchdog, '_get_cw_client', return_value=MagicMock()):
            result = watchdog._load_workflow_for_execution(execution)

        assert result['definition'] == DEFINITION_V2
        mock_load.assert_called_once_with(WORKFLOW_ID)


# ---------------------------------------------------------------------------
# Integration: mid-run publish doesn't affect execution
# ---------------------------------------------------------------------------

class TestMidRunPublishIsolation:
    def test_handle_node_completion_uses_snapshot_not_live(self):
        """After a node completes, the executor should use the pinned
        definition, not a potentially updated live workflow."""
        execution = {
            'executionId': EXECUTION_ID,
            'workflowId': WORKFLOW_ID,
            'status': 'running',
            'workflowDefinitionSnapshot': DEFINITION_V1,
            'workflowConfigurationSnapshot': CONFIG_V1,
            'nodeResults': {
                'n1': {'status': 'running', 'startedAt': '2025-01-01T00:00:00Z'},
            },
        }

        captured_workflow = {}

        original_schedule = executor.schedule_frontier

        def capture_schedule(exec_view, workflow, **kwargs):
            captured_workflow['definition'] = workflow.get('definition')

        with patch.object(executor, '_load_execution', return_value=execution), \
             patch.object(executor, '_executions_table', MagicMock()), \
             patch.object(executor, '_emit_metric'), \
             patch.object(executor, '_log_event'), \
             patch.object(executor, 'schedule_frontier', side_effect=capture_schedule), \
             patch.object(executor, 'events', MagicMock()):
            executor.handle_node_completion(
                EXECUTION_ID, 'n1', {'result': 'ok'},
            )

        # The workflow definition used should be V1 (the snapshot), not V2
        assert captured_workflow.get('definition') == DEFINITION_V1
