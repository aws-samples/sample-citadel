"""Release-aware dispatch tests for ``executor.invoke_node`` (stepRunner).

Mirrors the supervisor's release-gate semantics
(arbiter/supervisor/__tests__/test_release_aware_dispatch.py) applied at
the stepRunner's dispatch choke point. executor.py has no pre-existing
authority-graph governance gate (unlike supervisor/index.py's
governed_process_agent_call) — this story adds ONLY the release
resolution + mode + grandfathering + telemetry seam here, per scope
(the full authority DENY/ESCALATE engine is out of scope for this choke
point).

Backward compatibility: RELEASE_DISPATCH_ENVIRONMENT unset -> the gate is
a complete no-op (resolve_release never called), so an existing workflow
node dispatch is byte-identical to pre-feature behaviour — asserted first,
then permissive/shadow/strict branch semantics.
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
    ):
        saved[key] = os.environ.pop(key, None)
    os.environ['WORKER_QUEUE_URL'] = 'https://sqs.fake/worker-queue'
    yield
    for key, value in saved.items():
        if value is not None:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)


def _patched_executor():
    """Returns (executor module, patch context tuple) with tables/events/sqs
    neutralised, mirroring test_node_dispatch.py's _patch_tables fixture."""
    import executor
    fake_sqs = MagicMock()
    ctx = (
        patch.object(executor, '_executions_table', MagicMock()),
        patch.object(executor, 'events', MagicMock()),
        patch.object(executor, '_get_sqs_client', return_value=fake_sqs),
    )
    return executor, ctx, fake_sqs


# ---------------------------------------------------------------------------
# Backward-compat: feature switch unset -> resolve_release never called.
# ---------------------------------------------------------------------------


def test_release_gate_noop_when_dispatch_environment_unset():
    executor, ctx, fake_sqs = _patched_executor()
    with ctx[0], ctx[1], ctx[2], \
         patch.object(executor, 'resolve_release') as mock_resolve:
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    mock_resolve.assert_not_called()
    fake_sqs.send_message.assert_called_once()


# ---------------------------------------------------------------------------
# permissive/shadow — always dispatch, telemetry only.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["permissive", "shadow"])
def test_no_release_resolvable_still_dispatches_in_permissive_and_shadow(mode):
    executor, ctx, fake_sqs = _patched_executor()
    fake_state = MagicMock(enforcement_mode=mode, effective_at=None)
    fake_resolution = MagicMock(status=executor.ReleaseResolutionStatus.NO_POINTER, error=None)

    with ctx[0], ctx[1], ctx[2], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, 'resolve_release', return_value=fake_resolution), \
         patch.object(executor, '_emit_release_dispatch_metric') as mock_metric:
        os.environ['RELEASE_DISPATCH_ENVIRONMENT'] = 'PROD'
        os.environ['RELEASE_DEFAULT_ORG_ID'] = 'Default'
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    fake_sqs.send_message.assert_called_once()
    assert mock_metric.call_args.kwargs['mode'] == mode
    assert mock_metric.call_args.kwargs['would_block'] is True


# ---------------------------------------------------------------------------
# strict — refuses when unresolvable and not grandfathered.
# ---------------------------------------------------------------------------


def test_strict_no_release_and_not_grandfathered_refuses_dispatch():
    executor, ctx, fake_sqs = _patched_executor()
    fake_state = MagicMock(enforcement_mode='strict', effective_at='2026-05-15T00:00:00Z')
    fake_resolution = MagicMock(status=executor.ReleaseResolutionStatus.NO_POINTER, error=None)

    with ctx[0], ctx[1], ctx[2], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, 'resolve_release', return_value=fake_resolution), \
         patch.object(executor, '_resolve_agent_created_at', return_value='2026-06-01T00:00:00Z'), \
         patch.object(executor, 'handle_node_failure') as mock_fail:
        os.environ['RELEASE_DISPATCH_ENVIRONMENT'] = 'PROD'
        os.environ['RELEASE_DEFAULT_ORG_ID'] = 'Default'
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    fake_sqs.send_message.assert_not_called()
    mock_fail.assert_called_once_with('exec-1', 'n0', 'no_release_resolvable')


def test_strict_no_release_but_grandfathered_dispatches():
    executor, ctx, fake_sqs = _patched_executor()
    # No created_at signal available (the honest default) -> conservative
    # bypass -> grandfathered=True even with a cutoff set.
    fake_state = MagicMock(enforcement_mode='strict', effective_at='2026-05-15T00:00:00Z')
    fake_resolution = MagicMock(status=executor.ReleaseResolutionStatus.NO_POINTER, error=None)
    fake_agent_table = MagicMock()
    fake_agent_table.get_item.return_value = {
        'Item': {'agentId': 'agent-A', 'registryStatus': 'APPROVED'},
    }
    fake_dynamodb = MagicMock()
    fake_dynamodb.Table.return_value = fake_agent_table

    with ctx[0], ctx[1], ctx[2], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, 'resolve_release', return_value=fake_resolution), \
         patch.object(executor, '_dynamodb', fake_dynamodb):
        os.environ['RELEASE_DISPATCH_ENVIRONMENT'] = 'PROD'
        os.environ['RELEASE_DEFAULT_ORG_ID'] = 'Default'
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    fake_sqs.send_message.assert_called_once()


def test_strict_resolved_release_dispatches():
    executor, ctx, fake_sqs = _patched_executor()
    fake_state = MagicMock(enforcement_mode='strict', effective_at=None)
    fake_resolution = MagicMock(
        status=executor.ReleaseResolutionStatus.RESOLVED,
        release={'releaseId': 'r1'},
        error=None,
    )
    fake_agent_table = MagicMock()
    fake_agent_table.get_item.return_value = {
        'Item': {'agentId': 'agent-A', 'registryStatus': 'APPROVED'},
    }
    fake_dynamodb = MagicMock()
    fake_dynamodb.Table.return_value = fake_agent_table

    with ctx[0], ctx[1], ctx[2], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, 'resolve_release', return_value=fake_resolution), \
         patch.object(executor, '_dynamodb', fake_dynamodb):
        os.environ['RELEASE_DISPATCH_ENVIRONMENT'] = 'PROD'
        os.environ['RELEASE_DEFAULT_ORG_ID'] = 'Default'
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    fake_sqs.send_message.assert_called_once()


def test_strict_lookup_failed_always_refuses_even_pre_flip():
    """Assert-or-refuse: LOOKUP_FAILED refuses in strict mode regardless of
    effective_at/grandfathering — same doctrine as the supervisor gate."""
    executor, ctx, fake_sqs = _patched_executor()
    fake_state = MagicMock(enforcement_mode='strict', effective_at=None)
    fake_resolution = MagicMock(
        status=executor.ReleaseResolutionStatus.LOOKUP_FAILED,
        error='throttled',
    )

    with ctx[0], ctx[1], ctx[2], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, 'resolve_release', return_value=fake_resolution), \
         patch.object(executor, 'handle_node_failure') as mock_fail:
        os.environ['RELEASE_DISPATCH_ENVIRONMENT'] = 'PROD'
        os.environ['RELEASE_DEFAULT_ORG_ID'] = 'Default'
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    fake_sqs.send_message.assert_not_called()
    mock_fail.assert_called_once_with('exec-1', 'n0', 'release_lookup_failed')


def test_strict_lookup_failed_in_shadow_mode_still_dispatches_with_would_block():
    executor, ctx, fake_sqs = _patched_executor()
    fake_state = MagicMock(enforcement_mode='shadow', effective_at=None)
    fake_resolution = MagicMock(
        status=executor.ReleaseResolutionStatus.LOOKUP_FAILED,
        error='throttled',
    )

    with ctx[0], ctx[1], ctx[2], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, 'resolve_release', return_value=fake_resolution), \
         patch.object(executor, '_emit_release_dispatch_metric') as mock_metric:
        os.environ['RELEASE_DISPATCH_ENVIRONMENT'] = 'PROD'
        os.environ['RELEASE_DEFAULT_ORG_ID'] = 'Default'
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    fake_sqs.send_message.assert_called_once()
    assert mock_metric.call_args.kwargs['would_block'] is True


def test_no_agent_id_on_node_resolves_release_with_empty_target_id():
    """A node with no agentId (agent_id='' per executor's own
    node.get('agentId', '') default) must not crash the release gate —
    resolve_release is still called with an empty agent_target_id. (The
    subsequent SQS dispatch for an agentId-less node already fails its own
    pre-existing, unrelated validation in workflow_contract.py — out of
    scope here; this test only asserts the release gate itself tolerates
    the empty id.)"""
    executor, ctx, fake_sqs = _patched_executor()
    fake_state = MagicMock(enforcement_mode='permissive', effective_at=None)
    fake_resolution = MagicMock(status=executor.ReleaseResolutionStatus.NO_POINTER, error=None)

    node_without_agent = {'id': 'n0', 'data': {}}

    with ctx[0], ctx[1], ctx[2], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, 'resolve_release', return_value=fake_resolution) as mock_resolve:
        os.environ['RELEASE_DISPATCH_ENVIRONMENT'] = 'PROD'
        os.environ['RELEASE_DEFAULT_ORG_ID'] = 'Default'
        try:
            executor.invoke_node('exec-1', 'wf-1', node_without_agent, {'k': 'v'}, {'cfg': 1})
        except ValueError:
            pass  # pre-existing, unrelated workflow_contract validation

    mock_resolve.assert_called_once()
    assert mock_resolve.call_args.kwargs['agent_target_id'] == ''


# ---------------------------------------------------------------------------
# Empty org id — strict refuses without DynamoDB call, node marked failed.
# ---------------------------------------------------------------------------


def test_strict_empty_org_refuses_and_marks_node_failed():
    """When RELEASE_DEFAULT_ORG_ID is unset/empty and mode is strict,
    _check_release_gate returns refused='release_org_unconfigured' without
    calling resolve_release, and invoke_node writes a terminal node failure
    via handle_node_failure (same path as worker-reported failures)."""
    executor, ctx, fake_sqs = _patched_executor()
    fake_state = MagicMock(enforcement_mode='strict', effective_at=None)
    fake_exec_table = MagicMock()
    # handle_node_failure loads execution + workflow — provide minimal stubs.
    fake_exec_table.get_item.return_value = {
        'Item': {
            'executionId': 'exec-1',
            'workflowId': 'wf-1',
            'status': 'running',
            'nodeResults': {'n0': {'status': 'pending', 'agentId': 'agent-A'}},
        },
    }
    fake_wf_table = MagicMock()
    fake_wf_table.get_item.return_value = {
        'Item': {
            'workflowId': 'wf-1',
            'definition': '{"nodes": [{"id": "n0", "agentId": "agent-A", "data": {}}], "edges": []}',
            'configuration': '{}',
        },
    }

    with ctx[0], ctx[1], ctx[2], \
         patch.object(executor, '_executions_table', fake_exec_table), \
         patch.object(executor, '_workflows_table', fake_wf_table), \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, 'resolve_release') as mock_resolve, \
         patch.object(executor, '_emit_release_dispatch_metric') as mock_metric:
        os.environ['RELEASE_DISPATCH_ENVIRONMENT'] = 'PROD'
        # Ensure RELEASE_DEFAULT_ORG_ID is NOT set
        os.environ.pop('RELEASE_DEFAULT_ORG_ID', None)
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    # resolve_release must NOT be called — no DynamoDB lookup.
    mock_resolve.assert_not_called()
    # SQS dispatch must NOT happen.
    fake_sqs.send_message.assert_not_called()
    # The Refused metric must be emitted.
    assert mock_metric.call_args.kwargs['outcome'] == 'refused'
    # handle_node_failure writes terminal failure to the executions table.
    update_calls = [
        c for c in fake_exec_table.update_item.call_args_list
        if ':nstatus' in str(c) or ':failed' in str(c) or 'failed' in str(c.kwargs.get('ExpressionAttributeValues', {}))
    ]
    assert len(update_calls) > 0, "Expected handle_node_failure to write terminal node status"


def test_shadow_empty_org_proceeds_unchanged():
    """When RELEASE_DEFAULT_ORG_ID is unset/empty and mode is shadow,
    the gate emits would_block but does NOT refuse — dispatch proceeds."""
    executor, ctx, fake_sqs = _patched_executor()
    fake_state = MagicMock(enforcement_mode='shadow', effective_at=None)
    fake_agent_table = MagicMock()
    fake_agent_table.get_item.return_value = {
        'Item': {'agentId': 'agent-A', 'registryStatus': 'APPROVED'},
    }
    fake_dynamodb = MagicMock()
    fake_dynamodb.Table.return_value = fake_agent_table

    with ctx[0], ctx[1], ctx[2], \
         patch.object(executor, 'load_governance_state', return_value=fake_state), \
         patch.object(executor, 'resolve_release') as mock_resolve, \
         patch.object(executor, '_dynamodb', fake_dynamodb), \
         patch.object(executor, '_emit_release_dispatch_metric') as mock_metric:
        os.environ['RELEASE_DISPATCH_ENVIRONMENT'] = 'PROD'
        os.environ.pop('RELEASE_DEFAULT_ORG_ID', None)
        executor.invoke_node('exec-1', 'wf-1', NODE, {'k': 'v'}, {'cfg': 1})

    mock_resolve.assert_not_called()
    fake_sqs.send_message.assert_called_once()
    assert mock_metric.call_args.kwargs['outcome'] == 'proceed'
    assert mock_metric.call_args.kwargs['would_block'] is True
