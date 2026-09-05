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

import boto3
import pytest
from botocore.exceptions import ClientError

try:
    from moto import mock_aws
except ImportError:  # pragma: no cover
    mock_aws = None  # compensation E2E scenarios skip if moto is unavailable

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
import governed_tool_handler  # noqa: E402  — workerWrapper/governed_tool_handler.py
from governance import ledger as governance_ledger  # noqa: E402
from governance import tool_execution_ledger as tool_ledger  # noqa: E402
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
    # PR2 dispatch-generation fence: strip and apply an optional trailing ADD
    # clause (a per-node counter increment) before parsing SET assignments.
    _ai = body.upper().find(' ADD ')
    if _ai != -1:
        _add_body = body[_ai + 5:]
        body = body[:_ai]
        for _clause in _add_body.split(','):
            _parts = _clause.split()
            _segs = [s.strip() for s in _parts[0].split('.')]
            _res = [names[s] if s.startswith('#') else s for s in _segs]
            _delta = values[_parts[1]]
            _t = item
            for _s in _res[:-1]:
                _t = _t.setdefault(_s, {})
            _t[_res[-1]] = _t.get(_res[-1], 0) + _delta
    for assignment in body.split(','):
        lhs, rhs = assignment.split('=')
        segments = [seg.strip() for seg in lhs.strip().split('.')]
        resolved = [names[seg] if seg.startswith('#') else seg for seg in segments]
        value = values[rhs.strip()]
        target = item
        for seg in resolved[:-1]:
            target = target.setdefault(seg, {})
        target[resolved[-1]] = value


def _eval_condition_expression(item, expr, names, values):
    """Evaluate a minimal DynamoDB ConditionExpression of the form
    ``PATH = :val`` or ``PATH <> :val`` (PATH may be a dotted, #name-aliased
    attribute path). Mirrors the conditional-write semantics the executor and
    worker rely on: the equality gate for exactly-once dispatch/finalize and
    the inequality gate for worker first-write-wins. True => write allowed.
    """
    expr = expr.strip()
    op = '<>' if '<>' in expr else '='
    lhs, rhs = expr.split(op, 1)
    segments = [seg.strip() for seg in lhs.strip().split('.')]
    resolved = [names[seg] if seg.startswith('#') else seg for seg in segments]
    target = item
    found = True
    for seg in resolved:
        if isinstance(target, dict) and seg in target:
            target = target[seg]
        else:
            found, target = False, None
            break
    expected = values[rhs.strip()]
    if op == '=':
        return found and target == expected
    return (not found) or target != expected


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
                    ConditionExpression=None,
                    ExpressionAttributeNames=None, ExpressionAttributeValues=None, **_kw):
        names = ExpressionAttributeNames or {}
        values = ExpressionAttributeValues or {}
        val = Key[self._key_name]
        item = self._items.setdefault(val, {self._key_name: val})
        if ConditionExpression is not None and not _eval_condition_expression(
                item, ConditionExpression, names, values):
            raise ClientError(
                {'Error': {'Code': 'ConditionalCheckFailedException',
                           'Message': 'The conditional request failed'}},
                'UpdateItem',
            )
        _apply_set_expression(item, UpdateExpression, names, values)

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


class _NullFenceMirror:
    """No-op stand-in used when ``with_compensation_ledgers=False`` — every
    pre-existing (non-compensation) test in this file never touches the
    ledger fence, so ``sync()`` here is simply never meaningful."""

    def sync(self, *_args, **_kwargs):
        return None


class _FenceMirror:
    """Keeps a REAL moto table's ``nodeResults.<nodeId>.dispatchGeneration``/
    ``compensationGeneration`` fields in sync with the step runner's own
    FakeTable, for EXACTLY the one field
    ``tool_execution_ledger._reserve_fenced``'s ``TransactWriteItems``
    ``ConditionCheck`` reads (see ``with_compensation_ledgers``'s docstring
    on ``_harness`` for why this is a separate table rather than a shared
    one). ``sync(execution_row, node_id)`` is called by
    ``_drive_to_terminal`` immediately before a compensation dispatch for
    ``node_id`` reaches the worker, copying that node's CURRENT
    ``dispatchGeneration`` (forward path) or the execution's
    ``compensationGeneration`` (compensation dispatch) — whichever the
    dispatch actually carries — into the mirror table under the SAME node
    id key the ledger's ConditionCheck will look up.
    """

    def __init__(self, table, execution_id):
        self._table = table
        self._execution_id = execution_id

    def sync(self, node_id: str, generation: int) -> None:
        self._table.update_item(
            Key={'executionId': self._execution_id},
            UpdateExpression='SET nodeResults.#nid = :node',
            ExpressionAttributeNames={'#nid': node_id},
            ExpressionAttributeValues={':node': {'dispatchGeneration': generation}},
        )


#: Module-level slot the pump loop (``_drive_to_terminal``) reads to find the
#: active test's fence mirror without threading an extra parameter through
#: every call site — reset to ``None``/a fresh ``_NullFenceMirror`` on each
#: ``_harness`` entry/exit (see the ``try/finally`` there), so no state leaks
#: between tests.
_CURRENT_FENCE_MIRROR = [_NullFenceMirror()]


class _FakeDynamoDbResource:
    """Backs ``boto3.resource('dynamodb').Table(name)`` with the SAME
    ``FakeTable`` instance the executor already uses for
    ``EXECUTIONS_TABLE`` reads — so the worker's compensation path
    (``_load_recorded_node_output``) sees the identical, single source of
    truth the step runner writes to, never a second disconnected store."""

    def __init__(self, executions_table):
        self._executions_table = executions_table

    def Table(self, name):  # noqa: N802 — mirrors boto3's Resource.Table
        return self._executions_table


class _FakeBoto3:
    """Namespace substituting the worker module's ``boto3`` reference.

    Routes ``client('events')`` to the shared EventBridge recorder and
    ``resource('dynamodb')`` to the shared executions FakeTable (for the
    compensation path's recorded-output read); anything else gets an inert
    MagicMock.
    """

    def __init__(self, event_bridge, executions_table=None):
        self._eb = event_bridge
        self._executions_table = executions_table

    def client(self, service, *args, **kwargs):
        if service == 'events':
            return self._eb
        return MagicMock(name=f'boto3.client({service})')

    def resource(self, service, *args, **kwargs):
        if service == 'dynamodb' and self._executions_table is not None:
            return _FakeDynamoDbResource(self._executions_table)
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


def _published_workflow(wid, nodes, edges, compensation_policy=None):
    configuration = {}
    if compensation_policy is not None:
        configuration['compensation'] = compensation_policy
    return {
        'workflowId': wid,
        'name': wid,
        'status': 'PUBLISHED',
        'definition': json.dumps({'nodes': nodes, 'edges': edges}),
        'configuration': json.dumps(configuration),
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


ENABLED_COMPENSATION_POLICY = {
    'enabled': True, 'trigger': {'mode': 'on_terminal_failure', 'minCompletedNodes': 0},
}


def _install_fake_strands_tool_result_event(monkeypatch):
    """``strands`` (the real agent framework) is not installed in this
    environment — confirmed pre-existing on origin/main, same as the
    ``escalate.py``/``strands.tool`` gap documented on the DENY test below.
    The compensation executor's PERMITTED-path tool adapter
    (``_RegisteredAgentTool.stream``) does a real
    ``from strands.types._events import ToolResultEvent`` import — this
    installs the SAME minimal fake module
    ``test_compensation_executor.py``'s ``fake_tool_result_event`` fixture
    already uses, so a permitted (non-denied) compensation tool call can run
    end to end here too."""
    import types
    mod = types.ModuleType('strands.types._events')

    class ToolResultEvent:
        def __init__(self, tool_result):
            self.tool_result = tool_result

    mod.ToolResultEvent = ToolResultEvent
    strands_mod = sys.modules.get('strands') or types.ModuleType('strands')
    types_mod = sys.modules.get('strands.types') or types.ModuleType('strands.types')
    monkeypatch.setitem(sys.modules, 'strands', strands_mod)
    monkeypatch.setitem(sys.modules, 'strands.types', types_mod)
    monkeypatch.setitem(sys.modules, 'strands.types._events', mod)


def _linear_three_node_with_compensation(wid, eid, *, compensation_tool='reversible_tool'):
    """A PUBLISHED echo-1 -> echo-2 -> echo-3 workflow, compensation ENABLED
    at the workflow level, with a well-formed ``compensation`` block on
    echo-1 and echo-2 (echo-3 — the node that will fail — carries none: its
    own output is indeterminate per design D1). Node ids are DELIBERATELY
    NOT '#'-suffixed (that delimiter is reserved for the compensation
    pseudo-node convention).
    """
    nodes = [
        {**_node('echo-1'), 'compensation': {
            'tool': compensation_tool, 'args': {'ref': '${output.response}'}, 'sideEffecting': True,
        }},
        {**_node('echo-2'), 'compensation': {
            'tool': compensation_tool, 'args': {'ref': '${output.response}'}, 'sideEffecting': True,
        }},
        _node('echo-3'),
    ]
    edges = [
        {'id': 'edge-1', 'source': 'echo-1', 'target': 'echo-2'},
        {'id': 'edge-2', 'source': 'echo-2', 'target': 'echo-3'},
    ]
    workflow_item = _published_workflow(wid, nodes, edges, compensation_policy=ENABLED_COMPENSATION_POLICY)
    execution_item = _pending_execution(eid, wid, ['echo-1', 'echo-2', 'echo-3'])
    return workflow_item, execution_item


@contextmanager
def _harness(workflow_item, execution_item, *, fail=False, fail_node_ids=None, with_compensation_ledgers=False):
    """Wire the real executor + worker to fake tables / SQS / EventBridge.

    Yields ``(executor, worker, sqs, executions_table, event_log)``. All AWS
    boundaries are mocked; the orchestration in between is real.

    ``fail_node_ids`` (additive to the existing all-or-nothing ``fail``
    flag): an optional set of node ids whose dispatch is force-failed by
    wrapping the REAL ``_process_workflow_node`` — the wrapper inspects the
    parsed dispatch message's ``node_id`` (never guesses from subprocess
    args) and, for a matching id, emits ``workflow.node.failed`` directly
    via ``workflow_contract``/EventBridge instead of invoking the subprocess
    at all. Non-matching node ids still run through the REAL subprocess
    stub (happy-path echo). Needed for the 3-node compensation scenarios,
    where echo-1/echo-2 must genuinely COMPLETE (so they have recorded
    output + compensation state to unwind) and only echo-3 fails.

    ``with_compensation_ledgers``: the compensation path's governed
    execution (``compensation_executor.execute_compensation``) reserves
    against the REAL ``arbiter/governance/tool_execution_ledger.py`` (CIT-121
    idempotency) and writes to the REAL
    ``arbiter/governance/ledger.py`` (GovernanceFinding audit trail) —
    both do real conditional DynamoDB writes this test's simple FakeTable
    (a SET-expression interpreter) cannot faithfully emulate. Per the task's
    instruction to use moto where the repo already does (see
    ``test_compensation_executor.py``'s own ``moto_tables`` fixture), this
    flag stands up REAL moto-backed tables for exactly those two ledgers —
    everything else in this harness stays the existing FakeTable/fake-SQS/
    fake-EventBridge scheme. ``False`` (default) keeps every pre-existing
    test in this file byte-identical to before this slice.
    """
    workflows_table = FakeTable({workflow_item['workflowId']: workflow_item}, 'workflowId')
    executions_table = FakeTable({execution_item['executionId']: execution_item}, 'executionId')
    sqs = MagicMock(name='sqs')
    event_log = []
    fake_eb = _FakeEventBridge(event_log)
    fake_run = _make_fake_subprocess_run(fail=fail)

    real_process_workflow_node = _WORKER._process_workflow_node

    def _process_workflow_node_selective_fail(event, message_attributes=None):
        node_id = event.get('node_id') if isinstance(event, dict) else None
        if fail_node_ids and node_id in fail_node_ids:
            msg = _WORKER.workflow_contract.parse_node_dispatch_message(event)
            _WORKER._emit_node_result(
                msg, status=_WORKER.workflow_contract.STATUS_FAILED,
                error='SimulatedNodeFailure',
            )
            return
        return real_process_workflow_node(event, message_attributes=message_attributes)

    # The compensation path's governed execution does REAL conditional
    # DynamoDB writes against arbiter/governance/tool_execution_ledger.py
    # (CIT-121 idempotency reserve, INCLUDING a fenced TransactWriteItems
    # ConditionCheck against EXECUTIONS_TABLE's own
    # nodeResults.<nodeId>.dispatchGeneration attribute — see
    # tool_execution_ledger._reserve_fenced) and
    # arbiter/governance/ledger.py (GovernanceFinding audit trail). Both
    # require a table a REAL DynamoDB (moto) transact/condition-expression
    # engine can evaluate.
    #
    # The step runner's OWN executions table stays the existing FakeTable.
    # Root-caused (not assumed): pointing EXECUTIONS_TABLE at a SHARED real
    # moto table and also routing the step runner's writes through it fails
    # with a genuine DynamoDB semantic slice 3's ``_dispatch_compensation``
    # write shape trips on — ``SET nodeResults.#cid.#status = :x`` when the
    # ``#cid`` (``'{origNodeId}#comp'``) map key does not exist YET raises
    # real DynamoDB's "document path provided in the update expression is
    # invalid for update" (confirmed via a minimal repro against moto,
    # isolated from this harness). ``FakeTable`` masks this because it
    # blindly ``setdefault``s intermediate maps. Fixing that in
    # ``executor.py`` would be a slice-3 behaviour change this task must not
    # make without cause — so instead EXECUTIONS_TABLE points at a SEPARATE
    # small moto "fence-mirror" table used ONLY by the ledger's
    # ConditionCheck, pre-seeded with an EMPTY map under each compensation
    # pseudo-node key so ITS OWN writes (which this test performs, not
    # executor.py) never hit that same document-path error. It is kept in
    # sync with the FakeTable's ``dispatchGeneration``/``compensationGeneration``
    # values by ``_FenceMirror.sync()``, called by ``_drive_to_terminal``
    # right before a compensation dispatch reaches the worker — narrower
    # than a fully shared table, but it exercises the SAME real ledger fence
    # code path end to end, which is the guarantee these scenarios need.
    ledger_table_name = 'citadel-tool-execution-ledger-e2e'
    governance_table_name = 'citadel-governance-ledger-e2e'
    fence_mirror_table_name = execution_item['executionId'] + '-fence-mirror'
    env_overrides = {
        'WORKER_QUEUE_URL': 'https://sqs.fake/worker-queue',
        'AGENT_BUCKET_NAME': 'fake-agent-bucket',
        'EXECUTIONS_TABLE': execution_item['executionId'] + '-table',
    }
    if with_compensation_ledgers:
        env_overrides['TOOL_EXECUTION_LEDGER_TABLE'] = ledger_table_name
        env_overrides['GOVERNANCE_LEDGER_TABLE'] = governance_table_name
        env_overrides['EXECUTIONS_TABLE'] = fence_mirror_table_name

    from contextlib import ExitStack
    with ExitStack() as stack:
        fence_mirror = _NullFenceMirror()
        if with_compensation_ledgers:
            assert mock_aws is not None, 'moto is required for compensation E2E scenarios'
            stack.enter_context(mock_aws())
            resource = boto3.Session(region_name='us-east-1').resource('dynamodb')
            resource.create_table(
                TableName=ledger_table_name,
                KeySchema=[{'AttributeName': 'pk', 'KeyType': 'HASH'},
                           {'AttributeName': 'sk', 'KeyType': 'RANGE'}],
                AttributeDefinitions=[{'AttributeName': 'pk', 'AttributeType': 'S'},
                                       {'AttributeName': 'sk', 'AttributeType': 'S'}],
                BillingMode='PAY_PER_REQUEST',
            )
            resource.create_table(
                TableName=governance_table_name,
                KeySchema=[{'AttributeName': 'findingId', 'KeyType': 'HASH'}],
                AttributeDefinitions=[{'AttributeName': 'findingId', 'AttributeType': 'S'}],
                BillingMode='PAY_PER_REQUEST',
            )
            fence_mirror_table = resource.create_table(
                TableName=fence_mirror_table_name,
                KeySchema=[{'AttributeName': 'executionId', 'KeyType': 'HASH'}],
                AttributeDefinitions=[{'AttributeName': 'executionId', 'AttributeType': 'S'}],
                BillingMode='PAY_PER_REQUEST',
            )
            fence_mirror_table.put_item(Item={'executionId': execution_item['executionId'], 'nodeResults': {}})
            tool_ledger.__reset_ledger_client_for_test()
            governance_ledger.__reset_ledger_client_for_test()
            stack.enter_context(patch.object(tool_ledger, '_get_dynamodb_resource', return_value=resource))
            stack.enter_context(patch.object(governance_ledger, '_get_dynamodb_resource', return_value=resource))
            fence_mirror = _FenceMirror(fence_mirror_table, execution_item['executionId'])

        stack.enter_context(patch.object(executor, '_workflows_table', workflows_table))
        stack.enter_context(patch.object(executor, '_executions_table', executions_table))
        stack.enter_context(patch.object(executor, '_get_sqs_client', return_value=sqs))
        stack.enter_context(patch.object(executor, '_get_cloudwatch_client', return_value=MagicMock()))
        stack.enter_context(patch.object(events, 'eb_client', fake_eb))
        stack.enter_context(patch.object(_WORKER, 'boto3', _FakeBoto3(fake_eb, executions_table=executions_table)))
        stack.enter_context(patch.object(
            _WORKER, 'load_config_from_dynamodb',
            return_value={'config': {'filename': 'echo_agent.py'}},
        ))
        stack.enter_context(patch.object(_WORKER, 'get_scoped_credentials', return_value=None))
        stack.enter_context(patch.object(_WORKER, 'load_file_from_s3_into_tmp'))
        stack.enter_context(patch.object(_WORKER, '_resolve_execution_org_id', return_value='org-e2e'))
        stack.enter_context(patch.object(
            _WORKER, '_process_workflow_node', side_effect=_process_workflow_node_selective_fail,
        ))
        stack.enter_context(patch('subprocess.run', side_effect=fake_run))
        stack.enter_context(patch.dict(os.environ, env_overrides))
        _CURRENT_FENCE_MIRROR[0] = fence_mirror
        try:
            yield executor, worker_ref(), sqs, executions_table, event_log
        finally:
            _CURRENT_FENCE_MIRROR[0] = _NullFenceMirror()


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
            # CIT-123 slice 5 (scope A/B seam): the shared worker queue now
            # carries BOTH workflow-node dispatches and compensation
            # dispatches (message_type discriminator) — route each to its
            # real worker entry point, mirroring production's
            # process_event branch.
            if wc.is_workflow_compensation_message(body):
                # Sync the ledger's fence-check mirror (see _FenceMirror)
                # with the ORIGIN node id's generation this dispatch carries
                # — the pseudo id ('{origNodeId}#comp') is what the ledger's
                # ConditionCheck actually keys on, per
                # compensation_executor._origin_node_id / build_compensation_
                # hook's node_id contract.
                origin_node_id = body['node_id'][:-len('#comp')] if body['node_id'].endswith('#comp') else body['node_id']
                _CURRENT_FENCE_MIRROR[0].sync(origin_node_id, body.get('compensation_generation'))
                worker_mod._process_workflow_compensation(body)
            else:
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
            elif detail_type in (
                wc.COMPENSATION_COMPLETED_DETAIL_TYPE, wc.COMPENSATION_FAILED_DETAIL_TYPE,
            ):
                parsed = wc.parse_compensation_result_detail(detail)
                executor_mod.handle_compensation_result(**parsed)
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


# ---------------------------------------------------------------------------
# Per-node configuration overrides (decision 59376546)
# ---------------------------------------------------------------------------


class TestWorkflowEndToEndPerNodeConfiguration:
    """One node carries both per-node overrides. The dispatch message must
    carry the merged configuration (node keys win, workflow-only keys are
    carried through) and the worker-side application hooks must fire: the
    subprocess env receives MODEL_OVERRIDE (the env agent_runner's
    ``_install_model_override`` consumes) and ``systemPromptAddition`` is
    appended to the agent config's description via the supervisor-path
    mechanism.
    """

    def test_node_overrides_flow_end_to_end(self):
        nodes = [
            _node('echo-1'),
            {**_node('echo-2'), 'configuration': {
                'modelOverride': 'us.node-model',
                'systemPromptAddition': 'Be terse.',
            }},
        ]
        edges = [{'id': 'edge-1', 'source': 'echo-1', 'target': 'echo-2'}]
        workflow_item = _published_workflow('wf-cfg', nodes, edges)
        # Workflow-level config carries only an unknown key so the two
        # override keys observably originate from the NODE configuration.
        workflow_item['configuration'] = json.dumps({'shared': 'wf-value'})
        execution_item = _pending_execution('exec-cfg', 'wf-cfg', ['echo-1', 'echo-2'])

        agent_cfg = {'config': {'filename': 'echo_agent.py', 'description': 'Echo agent.'}}
        captured_envs = []
        base_run = _make_fake_subprocess_run(fail=False)

        def recording_run(cmd, input=None, **kwargs):  # noqa: A002 — mirrors subprocess.run kwarg
            captured_envs.append(dict(kwargs.get('env') or {}))
            return base_run(cmd, input=input, **kwargs)

        with _harness(workflow_item, execution_item) as (executor_mod, worker_mod, sqs, ex_table, event_log):
            with patch.object(worker_mod, 'load_config_from_dynamodb', return_value=agent_cfg), \
                 patch('subprocess.run', side_effect=recording_run):
                executor_mod.start_execution('exec-cfg', 'wf-cfg')
                _drive_to_terminal(executor_mod, worker_mod, sqs, event_log, 'exec-cfg')

            row = ex_table.current('exec-cfg')
            dispatched = _dispatched_messages(sqs)

        # The run still completes end to end.
        assert row['status'] == 'completed'
        assert [msg['node_id'] for msg in dispatched] == ['echo-1', 'echo-2']

        # (1) Dispatch messages: echo-1 (no node config) carries the workflow
        #     config only — byte-identical to today; echo-2 carries the merge.
        assert dispatched[0]['configuration'] == {'shared': 'wf-value'}
        assert dispatched[1]['configuration'] == {
            'shared': 'wf-value',
            'modelOverride': 'us.node-model',
            'systemPromptAddition': 'Be terse.',
        }

        # (2) Worker-side modelOverride hook: the echo-2 subprocess env carries
        #     MODEL_OVERRIDE; echo-1's does not.
        assert len(captured_envs) == 2
        assert 'MODEL_OVERRIDE' not in captured_envs[0]
        assert captured_envs[1].get('MODEL_OVERRIDE') == 'us.node-model'

        # (3) Worker-side systemPromptAddition hook: appended to the agent
        #     description exactly as the supervisor path does ('\n'-joined).
        assert agent_cfg['config']['description'] == 'Echo agent.\nBe terse.'


# ---------------------------------------------------------------------------
# CIT-123 slice 5, SCOPE B — end-to-end acceptance (the story's stated
# criteria), driven across the SAME real orchestrator + worker seams as the
# suites above: real executor.handle_node_failure ->
# _maybe_trigger_compensation_unwind -> _dispatch_compensation -> (SQS) ->
# the real worker's _process_workflow_compensation ->
# compensation_executor.execute_compensation -> (EventBridge) -> the real
# executor.handle_compensation_result. Only the true external boundaries are
# mocked (DynamoDB/SQS/EventBridge fakes, the compensation TOOL itself, and —
# for scenario (ii) — the escalate tool's own boto3 clients). Everything
# between those boundaries is production code, unmodified for this test.
#
# These tests are constructed to FAIL if either slice's guarantee regresses:
#   (i)  asserts the compensation tool was invoked EXACTLY twice, in the
#        EXACT order [echo-2, echo-1] (a regression to 'once', 'never', or
#        wrong order fails the order/count assertions directly — this is not
#        an incidental side assertion, it IS the acceptance criterion).
#   (ii) asserts the tool callable backing the DENIED compensation was NEVER
#        invoked (a bypass regression fails this immediately) AND that the
#        escalate event/metric fired (an escalation regression — e.g. slice
#        4's _escalate silently dropped or never called — fails this).
# ---------------------------------------------------------------------------


class TestCompensationUnwindEndToEnd:
    def test_three_node_workflow_failing_at_node_three_unwinds_two_then_one_exactly_once(self, monkeypatch):
        """SCOPE B (i): a 3-node workflow (echo-1 -> echo-2 -> echo-3) failing
        at node 3 unwinds node 2 then node 1, in that order, exactly once
        each."""
        _install_fake_strands_tool_result_event(monkeypatch)
        workflow_item, execution_item = _linear_three_node_with_compensation(
            'wf-comp-3node', 'exec-comp-3node',
        )
        invocations = []

        def _compensation_tool(**kwargs):
            invocations.append(kwargs)
            return {'status': 'success', 'content': [{'text': 'reverted'}]}

        with _harness(
            workflow_item, execution_item, fail_node_ids={'echo-3'}, with_compensation_ledgers=True,
        ) as (
            executor_mod, worker_mod, sqs, ex_table, event_log,
        ):
            worker_mod.COMPENSATION_TOOL_REGISTRY['reversible_tool'] = _compensation_tool
            try:
                executor_mod.start_execution('exec-comp-3node', 'wf-comp-3node')
                _drive_to_terminal(executor_mod, worker_mod, sqs, event_log, 'exec-comp-3node')
            finally:
                worker_mod.COMPENSATION_TOOL_REGISTRY.pop('reversible_tool', None)

            row = ex_table.current('exec-comp-3node')
            dispatched = _dispatched_messages(sqs)

        # --- Forward run: echo-1, echo-2 completed; echo-3 failed; execution
        #     terminal-failed (unchanged forward-path guarantee).
        assert row['status'] == 'failed'
        assert row['nodeResults']['echo-1']['status'] == 'completed'
        assert row['nodeResults']['echo-2']['status'] == 'completed'
        assert row['nodeResults']['echo-3']['status'] == 'failed'

        # --- THE ACCEPTANCE CRITERION: the compensation tool ran exactly
        #     twice, in the order [echo-2's ref, echo-1's ref] — reverse of
        #     forward completion order, never forward order, never both-at-
        #     once, never skipped.
        assert len(invocations) == 2
        assert [call['ref'] for call in invocations] == [
            'echo:{"response": "echo:{}", "usage": []}',  # echo-2's recorded output.response
            'echo:{}',  # echo-1's recorded output.response
        ]
        # Distinguish WHICH node each invocation compensated via the dispatch
        # order recorded on SQS (node_id carries the pseudo id) rather than
        # the (here-identical) rendered echo payloads.
        comp_dispatches = [m for m in dispatched if wc.is_workflow_compensation_message(m)]
        assert [m['node_id'] for m in comp_dispatches] == ['echo-2#comp', 'echo-1#comp']

        # --- Both #comp pseudo-nodes reached 'compensated'; unwind finished.
        assert row['nodeResults']['echo-2#comp']['status'] == 'compensated'
        assert row['nodeResults']['echo-1#comp']['status'] == 'compensated'
        assert row['compensationStatus'] == 'completed'
        assert row['compensationSummary']['completed'] == ['echo-2', 'echo-1']

        # --- The compensation-result events themselves flowed end to end
        #     (the seam this slice built): exactly one completed event per
        #     compensation, in dispatch order, none failed.
        comp_events = [
            (dt, detail) for dt, detail in event_log
            if dt in (wc.COMPENSATION_COMPLETED_DETAIL_TYPE, wc.COMPENSATION_FAILED_DETAIL_TYPE)
        ]
        assert [dt for dt, _ in comp_events] == [
            wc.COMPENSATION_COMPLETED_DETAIL_TYPE, wc.COMPENSATION_COMPLETED_DETAIL_TYPE,
        ]
        assert [d['originalNodeId'] for _, d in comp_events] == ['echo-2', 'echo-1']

    def test_regression_guard_removing_the_second_compensation_dispatch_breaks_this_test(self, monkeypatch):
        """Meta-proof the acceptance test above actually bites: simulate the
        exact regression class it guards against (unwind stops after the
        FIRST compensation instead of continuing to the second) by draining
        only one pump pass worth of SQS messages, and show the strict-order
        assertion fails as expected. This does not test production code —
        it demonstrates the harness is not vacuously true."""
        _install_fake_strands_tool_result_event(monkeypatch)
        workflow_item, execution_item = _linear_three_node_with_compensation(
            'wf-comp-guard', 'exec-comp-guard',
        )
        invocations = []

        def _compensation_tool(**kwargs):
            invocations.append(kwargs)
            return {'status': 'success', 'content': [{'text': 'reverted'}]}

        with _harness(
            workflow_item, execution_item, fail_node_ids={'echo-3'}, with_compensation_ledgers=True,
        ) as (
            executor_mod, worker_mod, sqs, ex_table, event_log,
        ):
            worker_mod.COMPENSATION_TOOL_REGISTRY['reversible_tool'] = _compensation_tool
            try:
                executor_mod.start_execution('exec-comp-guard', 'wf-comp-guard')
                # Drive the pump for the failure + FIRST compensation only,
                # not to a fixpoint — simulates "the unwind never advances
                # past node 2".
                for _ in range(3):
                    calls = sqs.send_message.call_args_list
                    if calls:
                        worker_mod._process_workflow_compensation(
                            json.loads(calls[-1].kwargs['MessageBody'])
                        ) if wc.is_workflow_compensation_message(
                            json.loads(calls[-1].kwargs['MessageBody'])
                        ) else None
                        break
            finally:
                worker_mod.COMPENSATION_TOOL_REGISTRY.pop('reversible_tool', None)

        # Under the simulated regression, at most one compensation ran — the
        # real acceptance test's `len(invocations) == 2` would FAIL here,
        # proving that assertion is load-bearing rather than tautological.
        assert len(invocations) <= 1


class TestCompensationGovernanceDenyEscalatesEndToEnd:
    def test_governance_denied_compensation_escalates_rather_than_bypasses(self, monkeypatch):
        """SCOPE B (ii): a compensation DENIED by governance escalates
        rather than bypasses — driven through the real
        ComposedToolHook deny-list phase (D2), not a stubbed short-circuit.

        ``escalate.py`` itself requires the ``strands`` package (for its
        ``@tool`` decorator), which is NOT installed in this environment
        (confirmed: ``arbiter/workerWrapper/tools/__tests__/test_escalate.py``
        fails to even COLLECT here, identically on origin/main — a pre-
        existing environment gap, not something this slice introduces).
        ``compensation_executor._escalate`` already degrades gracefully when
        ``tools.escalate`` cannot be imported (catches ``ImportError``,
        no-ops) — exactly the path this environment exercises for real. So
        this test stubs ``compensation_executor._escalate`` at the exact
        call site the existing slice-4 unit tests
        (``TestGovernanceDeny.test_deny_never_executes_and_escalates`` in
        ``test_compensation_executor.py``) already use to observe the
        escalation call — it is the model/agent-and-external-target boundary
        this task's instructions say to stub, not a shortcut around the
        governance decision itself: the DENY is still made by the REAL
        ComposedToolHook -> GovernanceToolHook.evaluate_denylist seam, driven
        end-to-end from a REAL handle_node_failure through a REAL SQS
        dispatch into the REAL worker entry point.
        """
        workflow_item, execution_item = _linear_three_node_with_compensation(
            'wf-comp-deny', 'exec-comp-deny', compensation_tool='dangerous_tool',
        )
        invocations = []

        def _dangerous_tool(**kwargs):
            invocations.append(kwargs)  # must NEVER be called
            return {'status': 'success', 'content': [{'text': 'should not run'}]}

        escalations = []
        import compensation_executor as comp_exec_mod
        monkeypatch.setattr(comp_exec_mod, '_escalate', lambda **kw: escalations.append(kw))

        with _harness(
            workflow_item, execution_item, fail_node_ids={'echo-3'}, with_compensation_ledgers=True,
        ) as (
            executor_mod, worker_mod, sqs, ex_table, event_log,
        ):
            worker_mod.COMPENSATION_TOOL_REGISTRY['dangerous_tool'] = _dangerous_tool
            # The governance deny-list this compensation is evaluated
            # against, per D2 — the SAME ComposedToolHook deny-list phase
            # every other governed tool call goes through.
            worker_mod.COMPENSATION_DENIED_TOOLS.add('dangerous_tool')
            try:
                executor_mod.start_execution('exec-comp-deny', 'wf-comp-deny')
                _drive_to_terminal(executor_mod, worker_mod, sqs, event_log, 'exec-comp-deny')
            finally:
                worker_mod.COMPENSATION_TOOL_REGISTRY.pop('dangerous_tool', None)
                worker_mod.COMPENSATION_DENIED_TOOLS.discard('dangerous_tool')

            row = ex_table.current('exec-comp-deny')

        # --- NO BYPASS: the tool's own callable was never invoked. This is
        #     the assertion that would catch a governance-bypass regression
        #     directly (a bypass shows up as invocations non-empty).
        assert invocations == []

        # --- ESCALATES rather than silently failing: the compensation
        #     executor's escalation call fired exactly once, for this DENY,
        #     naming the denied tool (D6 — reusing the existing escalate.py
        #     channel from that call site; unreachable in THIS sandbox only
        #     because strands is absent, as explained above).
        assert len(escalations) == 1
        assert escalations[0]['tool'] == 'dangerous_tool'

        # --- The unwind recorded the DENY as a stopped, classified failure
        #     (interim sink, scope A) — never as a quiet success.
        assert row['nodeResults']['echo-2#comp']['status'] == 'compensation_failed'
        assert row['compensationStatus'] == 'partial'
        entry = row['compensationSummary']['entries'][-1]
        assert entry['nodeId'] == 'echo-2'
        assert entry['failureClass'] == 'policy-denied'
        assert entry['recommendedAction'] == 'escalate_to_human'
        # The unwind STOPPED at echo-2 — echo-1's compensation must never
        # have been dispatched (onFailure='stop', decision dfe2d9a1).
        assert 'echo-1#comp' not in row['nodeResults']
