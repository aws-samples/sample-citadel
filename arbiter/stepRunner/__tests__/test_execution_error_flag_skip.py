"""RED test for execution 7a07c9bf's reported defect: a DAG whose conditional
edge's false branch is correctly skipped, and whose dispatched nodes all
complete with no node failure, must NOT end with the execution-level
``error`` attribute truthy.

Reuses the real in-process executor + worker harness from
test_workflow_e2e.py (``_harness``/``_drive_to_terminal``/``FakeTable``) so
this exercises the genuine production DAG-advance/finalize code path, not a
hand-rolled stand-in.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from test_workflow_e2e import (  # noqa: E402
    AGENT_ID,
    _drive_to_terminal,
    _harness,
    _node,
    _published_workflow,
    _pending_execution,
)


def _branching_workflow(wid, eid):
    """router -> (true branch) kept -> target; router -> (false branch,
    never matches) skipped-branch, with no downstream of the skipped node.

    The condition field/value is chosen so it can NEVER match the worker's
    echo output (``{"response": "echo:...", "usage": [...]}``) — the
    false-branch edge is deterministically skipped, and the kept-branch
    edge is unconditional so the true path always dispatches.
    """
    nodes = [_node('router'), _node('kept'), _node('skipped-branch')]
    edges = [
        {'id': 'edge-kept', 'source': 'router', 'target': 'kept'},
        {
            'id': 'edge-skip',
            'source': 'router',
            'target': 'skipped-branch',
            'condition': {
                'field': 'response',
                'operator': 'equals',
                'value': '__never_matches__',
            },
        },
    ]
    workflow_item = _published_workflow(wid, nodes, edges)
    execution_item = _pending_execution(eid, wid, ['router', 'kept', 'skipped-branch'])
    return workflow_item, execution_item


class TestExecutionErrorFlagNotSetOnSkippedBranch:
    def test_completed_execution_with_skipped_false_branch_has_no_error(self):
        workflow_item, execution_item = _branching_workflow('wf-branch', 'exec-branch')

        with _harness(workflow_item, execution_item) as (executor_mod, worker_mod, sqs, ex_table, event_log):
            executor_mod.start_execution('exec-branch', 'wf-branch')
            _drive_to_terminal(executor_mod, worker_mod, sqs, event_log, 'exec-branch')

            row = ex_table.current('exec-branch')

        # All three dispatched/evaluated nodes reached a terminal, non-error
        # state: the two real nodes completed, the conditional false branch
        # was correctly skipped (never dispatched to the worker).
        assert row['status'] == 'completed'
        assert row['nodeResults']['router']['status'] == 'completed'
        assert row['nodeResults']['kept']['status'] == 'completed'
        assert row['nodeResults']['skipped-branch']['status'] == 'skipped'

        # The defect under test: a correctly-skipped branch with zero node
        # failures must not flag the execution as errored.
        assert not row.get('error'), (
            f"completed execution with a skipped (not failed) branch must not "
            f"carry a truthy top-level error attribute, got: {row.get('error')!r}"
        )

        types = [dt for dt, _ in event_log]
        assert 'workflow.completed' in types
        assert 'workflow.failed' not in types
        assert 'workflow.node.failed' not in types

