"""End-to-end acceptance test for the workflow execution chain.

This is the top-level gate that proves the whole execution chain works
*in process*, with no story-specific shortcuts: the REAL step runner executor
and the REAL worker are driven through a full two-node run —

    start_execution
      -> node dispatched to a fake SQS queue (the worker queue)
      -> worker._process_workflow_node runs the (mocked) agent and emits
         workflow.node.completed on a fake EventBridge
      -> handle_node_completion advances the DAG and dispatches the next node
      -> ... repeat until the terminal workflow.completed

and a failure variant where the worker emits workflow.node.failed and the
step runner's handle_node_failure drives the execution to a terminal 'failed'.

Only the true external boundaries are mocked:
  * DynamoDB (executor tables via a stateful FakeTable that interprets the
    real SET UpdateExpressions; the worker's agent-config load).
  * SQS (a recording stand-in — messages are captured and hand-fed to the
    worker, mirroring the production SQS -> worker delivery).
  * EventBridge (a single shared recorder so the step runner's and the
    worker's events land in one ordered log — mirroring both sides publishing
    to the same bus the step runner's rules consume).
  * The agent subprocess (subprocess.run) — replaced with an echo stub, plus
    the S3 module fetch and credential vending.

Everything between those boundaries — dispatch/result contract building and
parsing, node-status persistence, convergence/terminal detection, and the
lifecycle event fan-out — is the real production code.

No real network or credentials are touched.
"""

import copy
import importlib.util
import json
import os
import sys
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

# --- Import the real modules under test -------------------------------------
# Mirror the sibling stepRunner tests: put stepRunner/ first so executor/events/
# dag resolve here. Defensively ensure the arbiter root (for the shared
# ``common`` package) and the worker/fabricator dirs (for the worker module's
# own imports) are importable regardless of collection order.
_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, '..')))
for _extra in ('..', os.path.join('..', '..', 'workerWrapper'),
               os.path.join('..', '..', 'fabricator')):
    _abs = os.path.abspath(os.path.join(_HERE, _extra))
    if _abs not in sys.path:
        sys.path.append(_abs)

import executor  # noqa: E402  — stepRunner/executor.py
import events  # noqa: E402    — stepRunner/events.py
from common import workflow_contract as wc  # noqa: E402


def _load_worker_module():
    """Load workerWrapper/index.py under a distinct name.

    Both stepRunner/ and workerWrapper/ ship an ``index.py``; the root conftest
    rebinds the ambiguous ``index`` name to the *stepRunner* copy for tests in
    this directory. Loading the worker from its explicit path under a unique
    module name sidesteps that collision — we get the genuine worker module,
    not the step runner's Lambda entry point.
    """
    path = os.path.abspath(os.path.join(_HERE, '..', '..', 'workerWrapper', 'index.py'))
    spec = importlib.util.spec_from_file_location('e2e_worker_wrapper', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # The worker's shared-contract import is defensive (falls back to None
    # before the Lambda bundle wires it in). In-process it must resolve, or the
    # node execution path cannot build/emit results.
    assert module.workflow_contract is not None, (
        'worker module failed to import the shared workflow_contract'
    )
    return module


_WORKER = _load_worker_module()


# ---------------------------------------------------------------------------
# Stateful in-memory DynamoDB Table stand-in.
# ---------------------------------------------------------------------------
# Interprets the SET-only UpdateExpressions the executor uses (both top-level
# and nested ``nodeResults.#nid.#attr`` paths), so each handler reads back
# exactly the state prior handlers persisted — mirroring DynamoDB's
# read-after-write within a single execution row. This is the same pattern the
# concurrency suite relies on.


def _apply_set_expression(item, expr, names, values):
    """Apply a ``SET a = :x, b.#c = :y`` update to *item* in place."""
    body = expr.strip()
    assert body.upper().startswith('SET '), f"unsupported expression: {expr!r}"
    body = body[4:]
    for assignment in body.split(','):
        lhs, rhs = assignment.split('=')
        segments = [seg.strip() for seg in lhs.strip().split('.')]
        resolved = [names[seg] if seg.startswith('#') else seg for seg in segments]
        value = values[rhs.strip()]
        target = item
        for seg in resolved[:-1]:
            target = target.setdefault(seg, {})
        target[resolved[-1]] = value


class FakeTable:
    """Minimal stateful stand-in for a boto3 DynamoDB Table."""

    def __init__(self, items, key_name):
        self._items = {k: copy.deepcopy(v) for k, v in items.items()}
        self._key_name = key_name

    def get_item(self, Key):  # noqa: N803 — boto3 kwarg name
        val = Key[self._key_name]
        item = self._items.get(val)
        return {'Item': copy.deepcopy(item)} if item is not None else {}

    def update_item(self, Key, UpdateExpression,  # noqa: N803 — boto3 kwarg names
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None):
        val = Key[self._key_name]
        item = self._items.setdefault(val, {self._key_name: val})
        _apply_set_expression(
            item, UpdateExpression,
            ExpressionAttributeNames or {}, ExpressionAttributeValues or {},
        )

    def current(self, val):
        return copy.deepcopy(self._items[val])


# ---------------------------------------------------------------------------
# Fake AWS side-effects shared across the two sides of the chain.
# ---------------------------------------------------------------------------


class _FakeEventBridge:
    """Records every published event as an ordered ``(detail_type, detail)``.

    Both the step runner (via ``events.eb_client``) and the worker (via
    ``boto3.client('events')``) publish through one instance, so the log is a
    single causal timeline across the whole chain.
    """

    def __init__(self, log):
        self._log = log

    def put_events(self, Entries):  # noqa: N803 — boto3 kwarg name
        for entry in Entries:
            self._log.append((entry['DetailType'], json.loads(entry['Detail'])))
        return {'FailedEntryCount': 0, 'Entries': [{} for _ in Entries]}


class _FakeBoto3:
    """Namespace substituting the worker module's ``boto3`` reference.

    Routes ``client('events')`` to the shared EventBridge recorder; anything
    else (unused on the workflow-node path) gets an inert MagicMock.
    """

    def __init__(self, event_bridge):
        self._eb = event_bridge

    def client(self, service, *args, **kwargs):
        if service == 'events':
            return self._eb
        return MagicMock(name=f'boto3.client({service})')

    def resource(self, *args, **kwargs):
        return MagicMock(name='boto3.resource')


def _make_fake_subprocess_run(*, fail):
    """Return a ``subprocess.run`` stub standing in for the agent subprocess.

    Happy path: echoes the dispatched request back as the agent response, so
    the worker's real result-marshalling and event emission run unchanged.
    Failure path: a non-zero exit, which ``run_agent_in_subprocess`` (invoked
    with ``raise_on_error=True`` on the workflow path) turns into a raise — the
    worker then emits node.failed rather than a canned success.
    """
    def _run(cmd, input=None, **kwargs):  # noqa: A002 — mirrors subprocess.run kwarg
        if fail:
            return SimpleNamespace(returncode=1, stdout='', stderr='simulated agent crash')
        payload = json.loads(input) if input else {}
        request = payload.get('request', {})
        echo = 'echo:' + json.dumps(request, sort_keys=True)
        return SimpleNamespace(
            returncode=0, stdout=json.dumps({'response': echo}), stderr='',
        )
    return _run


# ---------------------------------------------------------------------------
# Workflow / execution builders.
# ---------------------------------------------------------------------------

AGENT_ID = 'demo-echo-agent'


def _node(nid, agent_id=AGENT_ID):
    return {'id': nid, 'type': 'agent', 'agentId': agent_id, 'data': {}}


def _published_workflow(wid, nodes, edges):
    return {
        'workflowId': wid,
        'name': wid,
        'status': 'PUBLISHED',
        'definition': json.dumps({'nodes': nodes, 'edges': edges}),
        'configuration': json.dumps({}),
    }


def _pending_execution(eid, wid, node_ids):
    return {
        'executionId': eid,
        'workflowId': wid,
        'appId': 'app-1',
        'status': 'pending',
        'nodeResults': {
            nid: {'nodeId': nid, 'agentId': AGENT_ID, 'status': 'pending', 'retryCount': 0}
            for nid in node_ids
        },
    }


def _linear_two_node(wid, eid):
    """A PUBLISHED echo-1 -> echo-2 workflow plus a pending execution."""
    nodes = [_node('echo-1'), _node('echo-2')]
    edges = [{'id': 'edge-1', 'source': 'echo-1', 'target': 'echo-2'}]
    return _published_workflow(wid, nodes, edges), _pending_execution(eid, wid, ['echo-1', 'echo-2'])


@contextmanager
def _harness(workflow_item, execution_item, *, fail=False):
    """Wire the real executor + worker to fake tables / SQS / EventBridge.

    Yields ``(executor, worker, sqs, executions_table, event_log)``. All AWS
    boundaries are mocked; the orchestration in between is real.
    """
    workflows_table = FakeTable({workflow_item['workflowId']: workflow_item}, 'workflowId')
    executions_table = FakeTable({execution_item['executionId']: execution_item}, 'executionId')
    sqs = MagicMock(name='sqs')
    event_log = []
    fake_eb = _FakeEventBridge(event_log)
    fake_run = _make_fake_subprocess_run(fail=fail)

    with patch.object(executor, '_workflows_table', workflows_table), \
         patch.object(executor, '_executions_table', executions_table), \
         patch.object(executor, '_get_sqs_client', return_value=sqs), \
         patch.object(executor, '_get_cloudwatch_client', return_value=MagicMock()), \
         patch.object(events, 'eb_client', fake_eb), \
         patch.object(_WORKER, 'boto3', _FakeBoto3(fake_eb)), \
         patch.object(_WORKER, 'load_config_from_dynamodb',
                      return_value={'config': {'filename': 'echo_agent.py'}}), \
         patch.object(_WORKER, 'get_scoped_credentials', return_value=None), \
         patch.object(_WORKER, 'load_file_from_s3_into_tmp'), \
         patch('subprocess.run', side_effect=fake_run), \
         patch.dict(os.environ, {
             'WORKER_QUEUE_URL': 'https://sqs.fake/worker-queue',
             'AGENT_BUCKET_NAME': 'fake-agent-bucket',
         }):
        yield executor, worker_ref(), sqs, executions_table, event_log


def worker_ref():
    """Expose the loaded worker module (indirection keeps the harness terse)."""
    return _WORKER


def _dispatched_messages(sqs):
    """Parsed node-dispatch message bodies sent to the worker queue, in order."""
    return [json.loads(call.kwargs['MessageBody']) for call in sqs.send_message.call_args_list]


def _drive_to_terminal(executor_mod, worker_mod, sqs, event_log, execution_id, *, max_passes=200):
    """Pump the in-process event loop until it reaches a fixpoint.

    Each pass (1) hands any not-yet-delivered SQS dispatch messages to the real
    worker ``_process_workflow_node`` (which emits a node-result event), then
    (2) feeds any not-yet-consumed node-result events into the real
    ``handle_node_completion`` / ``handle_node_failure``. Repeats until neither
    side produces new work — mirroring the async SQS/EventBridge delivery the
    two Lambdas rely on in production, but deterministic and in-process.
    """
    sqs_cursor = 0
    event_cursor = 0
    for _ in range(max_passes):
        progressed = False

        calls = sqs.send_message.call_args_list
        while sqs_cursor < len(calls):
            body = json.loads(calls[sqs_cursor].kwargs['MessageBody'])
            sqs_cursor += 1
            worker_mod._process_workflow_node(body)
            progressed = True

        while event_cursor < len(event_log):
            detail_type, detail = event_log[event_cursor]
            event_cursor += 1
            if detail_type == wc.NODE_COMPLETED_DETAIL_TYPE:
                result = wc.parse_node_result_detail(detail)
                executor_mod.handle_node_completion(execution_id, result.node_id, result.output)
                progressed = True
            elif detail_type == wc.NODE_FAILED_DETAIL_TYPE:
                result = wc.parse_node_result_detail(detail)
                executor_mod.handle_node_failure(execution_id, result.node_id, result.error)
                progressed = True

        if not progressed:
            break
    else:  # pragma: no cover — a stuck pump is a real failure, surface it
        pytest.fail('workflow pump did not reach a fixpoint within max_passes')


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestWorkflowEndToEndSuccess:
    def test_two_node_workflow_reaches_completed_via_real_chain(self):
        workflow_item, execution_item = _linear_two_node('wf-echo', 'exec-echo')

        with _harness(workflow_item, execution_item) as (executor_mod, worker_mod, sqs, ex_table, event_log):
            executor_mod.start_execution('exec-echo', 'wf-echo')
            _drive_to_terminal(executor_mod, worker_mod, sqs, event_log, 'exec-echo')

            row = ex_table.current('exec-echo')
            dispatched = _dispatched_messages(sqs)

        # (1) Terminal execution + both nodes completed.
        assert row['status'] == 'completed'
        assert row['nodeResults']['echo-1']['status'] == 'completed'
        assert row['nodeResults']['echo-2']['status'] == 'completed'

        # (2) Nodes were dispatched to the worker in DAG order, each as a
        #     contract-valid workflow-node message for the seeded agent.
        assert [msg['node_id'] for msg in dispatched] == ['echo-1', 'echo-2']
        for msg in dispatched:
            assert wc.is_workflow_node_message(msg)
            assert msg['message_type'] == wc.MESSAGE_TYPE_WORKFLOW_NODE
            parsed = wc.parse_node_dispatch_message(msg)
            assert parsed.agent_id == AGENT_ID
            assert parsed.workflow_id == 'wf-echo'
            assert parsed.execution_id == 'exec-echo'

        # (3) The fan-out-relevant event sequence: started, a node.completed for
        #     each node (produced by the WORKER, not the step runner), completed.
        relevant = [
            dt for dt, _ in event_log
            if dt in ('workflow.started', 'workflow.node.completed', 'workflow.completed')
        ]
        assert relevant == [
            'workflow.started',
            'workflow.node.completed',
            'workflow.node.completed',
            'workflow.completed',
        ]
        completed_nodes = [
            detail['nodeId'] for dt, detail in event_log if dt == 'workflow.node.completed'
        ]
        assert completed_nodes == ['echo-1', 'echo-2']

        # (4) The worker's echo output actually flowed through the chain.
        for dt, detail in event_log:
            if dt == 'workflow.node.completed':
                assert detail['output']['response'].startswith('echo:')
        assert row['nodeResults']['echo-2']['output']['response'].startswith('echo:')

    def test_success_run_emits_no_terminal_failure_event(self):
        workflow_item, execution_item = _linear_two_node('wf-echo-2', 'exec-echo-2')

        with _harness(workflow_item, execution_item) as (executor_mod, worker_mod, sqs, ex_table, event_log):
            executor_mod.start_execution('exec-echo-2', 'wf-echo-2')
            _drive_to_terminal(executor_mod, worker_mod, sqs, event_log, 'exec-echo-2')
            types = [dt for dt, _ in event_log]

        assert 'workflow.completed' in types
        assert 'workflow.failed' not in types
        assert 'workflow.node.failed' not in types
        # Exactly one lifecycle open and one lifecycle close.
        assert types.count('workflow.started') == 1
        assert types.count('workflow.completed') == 1


# ---------------------------------------------------------------------------
# Failure path
# ---------------------------------------------------------------------------


class TestWorkflowEndToEndFailure:
    def test_worker_node_failure_drives_execution_to_failed(self):
        workflow_item, execution_item = _linear_two_node('wf-echo-fail', 'exec-echo-fail')

        with _harness(workflow_item, execution_item, fail=True) as (executor_mod, worker_mod, sqs, ex_table, event_log):
            executor_mod.start_execution('exec-echo-fail', 'wf-echo-fail')
            _drive_to_terminal(executor_mod, worker_mod, sqs, event_log, 'exec-echo-fail')

            row = ex_table.current('exec-echo-fail')
            dispatched = _dispatched_messages(sqs)

        # Execution is terminal-failed; the failing node is failed and the
        # downstream node was never dispatched (barrier held by the failure).
        assert row['status'] == 'failed'
        assert row['nodeResults']['echo-1']['status'] == 'failed'
        assert row['nodeResults']['echo-2']['status'] == 'pending'
        assert [msg['node_id'] for msg in dispatched] == ['echo-1']

        types = [dt for dt, _ in event_log]
        # The worker produced node.failed; the step runner produced the
        # terminal workflow.failed; no bogus completion was emitted.
        assert 'workflow.started' in types
        assert 'workflow.node.failed' in types
        assert 'workflow.failed' in types
        assert 'workflow.completed' not in types

        failed = [detail for dt, detail in event_log if dt == 'workflow.failed']
        assert failed[-1]['failedNodeId'] == 'echo-1'
        assert failed[-1]['error']  # non-empty error string propagated end to end
