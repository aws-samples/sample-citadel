"""Record-approval dispatch gate tests for ``executor.invoke_node``
(stepRunner).

Mirrors ``test_release_aware_dispatch.py``'s structure and patch
conventions exactly, layered right after the release gate at the same
call site in ``invoke_node``. Covers the scenarios from the story brief:

  * strict + DRAFT (not APPROVED) -> refused, node not dispatched.
  * shadow + DRAFT -> proceeds (would-block only).
  * GetItem raises -> refused with 'approval_lookup_failed' in strict.
  * APPROVED -> proceeds.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unittest.mock import patch, MagicMock

import pytest


NODE = {'id': 'n0', 'agentId': 'agent-A', 'data': {}}


@pytest.fixture(autouse=True)
def _clean_env():
    saved = {}
    for key in (
        'RELEASE_DISPATCH_ENVIRONMENT',
        'RELEASE_DEFAULT_ORG_ID',
        'WORKER_QUEUE_URL',
        'AGENT_CONFIG_TABLE',
    ):
        saved[key] = os.environ.pop(key, None)
    os.environ['WORKER_QUEUE_URL'] = 'https://sqs.fake/worker-queue'
    os.environ['AGENT_CONFIG_TABLE'] = 'fake-agent-table'
    yield
    for key, value in saved.items():
        if value is not None:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)


def _patched_executor(agent_table=None):
    """Returns (executor module, patch context tuple, fake_sqs) with
    tables/events/sqs neutralised, mirroring
    test_release_aware_dispatch.py's _patched_executor. The release gate
    is patched to always pass through (not refused) so the approval gate
    can be exercised in isolation. ``agent_table`` (a MagicMock) stands in
    for the agents table returned by ``_dynamodb.Table``.
    """
    import executor
    fake_sqs = MagicMock()
    fake_agent_table = agent_table if agent_table is not None else MagicMock()
    fake_dynamodb = MagicMock()
    fake_dynamodb.Table.return_value = fake_agent_table
    ctx = (
        patch.object(executor, '_executions_table', MagicMock()),
        patch.object(executor, 'events', MagicMock()),
        patch.object(executor, '_get_sqs_client', return_value=fake_sqs),
        patch.object(executor, '_check_release_gate', return_value=(False, None)),
        patch.object(executor, '_dynamodb', fake_dynamodb),
    )
    return executor, ctx, fake_sqs, fake_agent_table


def _make_state(mode='shadow', effective_at=None):
    return MagicMock(enforcement_mode=mode, effective_at=effective_at)


# ---------------------------------------------------------------------------
# strict + not-approved (DRAFT) -> refused, node not dispatched.
# ---------------------------------------------------------------------------


def test_strict_not_approved_refuses_dispatch():
    executor, ctx, fake_sqs, fake_agent_table = _patched_executor()
    fake_agent_table.get_item.return_value = {
        'Item': {'agentId': 'agent-A', 'registryStatus': 'DRAFT'},
    }
    fake_state = _make_state('strict')

    with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, '_emit_approval_dispatch_metric') as mock_metric:
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    fake_sqs.send_message.assert_not_called()
    assert mock_metric.call_args.kwargs['outcome'] == 'refused'
    assert mock_metric.call_args.kwargs['mode'] == 'strict'


# ---------------------------------------------------------------------------
# shadow + not-approved -> proceeds, would-block telemetry only.
# ---------------------------------------------------------------------------


def test_shadow_not_approved_proceeds_with_would_block():
    executor, ctx, fake_sqs, fake_agent_table = _patched_executor()
    fake_agent_table.get_item.return_value = {
        'Item': {'agentId': 'agent-A', 'registryStatus': 'DRAFT'},
    }
    fake_state = _make_state('shadow')

    with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, '_emit_approval_dispatch_metric') as mock_metric:
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    fake_sqs.send_message.assert_called_once()
    assert mock_metric.call_args.kwargs['outcome'] == 'proceed'
    assert mock_metric.call_args.kwargs['would_block'] is True
    assert mock_metric.call_args.kwargs['mode'] == 'shadow'


# ---------------------------------------------------------------------------
# GetItem raises -> refused with 'approval_lookup_failed' in strict.
# ---------------------------------------------------------------------------


def test_getitem_raises_refuses_with_lookup_failed_in_strict():
    executor, ctx, fake_sqs, fake_agent_table = _patched_executor()
    fake_agent_table.get_item.side_effect = RuntimeError('DDB throttled')
    fake_state = _make_state('strict')

    with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, '_emit_approval_dispatch_metric'):
        refused, reason = executor._check_approval_gate('agent-A', 'wf-1', 'exec-1')
        assert refused is True
        assert reason == 'approval_lookup_failed'

        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    fake_sqs.send_message.assert_not_called()


# ---------------------------------------------------------------------------
# APPROVED -> proceeds, no would-block.
# ---------------------------------------------------------------------------


def test_approved_proceeds():
    executor, ctx, fake_sqs, fake_agent_table = _patched_executor()
    fake_agent_table.get_item.return_value = {
        'Item': {'agentId': 'agent-A', 'registryStatus': 'APPROVED'},
    }
    fake_state = _make_state('strict')

    with ctx[0], ctx[1], ctx[2], ctx[3], ctx[4], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, '_emit_approval_dispatch_metric') as mock_metric:
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    fake_sqs.send_message.assert_called_once()
    assert mock_metric.call_args.kwargs['outcome'] == 'proceed'
    assert mock_metric.call_args.kwargs['would_block'] is False
