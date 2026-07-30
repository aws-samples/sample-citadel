"""Tests for run_id additive threading through
arbiter/common/workflow_contract.py (Pass 1, decision f1cbd5ef) — mirrors
the dispatched_at additive-field test pattern in
TestDispatchMessageDispatchedAtAdditive / TestNodeResultDetailQueueWaitTimestampsAdditive
in test_workflow_contract.py.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from common.workflow_contract import (  # noqa: E402
    build_node_dispatch_message,
    build_node_result_detail,
    parse_node_dispatch_message,
)


class TestDispatchMessageRunIdAdditive:
    def test_omitted_run_id_keeps_message_byte_identical(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
        )
        assert 'runId' not in message

    def test_supplied_run_id_is_promoted_to_top_level_key(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            run_id='run-abc',
        )
        assert message['runId'] == 'run-abc'

    def test_none_run_id_omits_key(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            run_id=None,
        )
        assert 'runId' not in message

    def test_non_string_run_id_raises(self):
        with pytest.raises(ValueError):
            build_node_dispatch_message(
                execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
                run_id=12345,  # type: ignore[arg-type]
            )

    def test_parse_round_trips_run_id(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            run_id='run-abc',
        )
        parsed = parse_node_dispatch_message(message)
        assert parsed.run_id == 'run-abc'

    def test_parse_defaults_run_id_to_none_when_absent(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
        )
        parsed = parse_node_dispatch_message(message)
        assert parsed.run_id is None

    def test_parse_never_raises_on_malformed_run_id_on_the_wire(self):
        """A malformed runId (wrong type) on the wire degrades to None
        rather than raising — run_id is best-effort, never gates parsing."""
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
        )
        message['runId'] = 12345
        parsed = parse_node_dispatch_message(message)
        assert parsed.run_id is None

    def test_client_supplied_run_id_in_raw_body_never_read_by_builder(self):
        """SERVER-MINTED ONLY: build_node_dispatch_message never reads a
        runId from anywhere except its own explicit run_id kwarg — there is
        no path from an inbound dict to the emitted runId."""
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
        )
        assert 'runId' not in message


class TestNodeResultDetailRunIdAdditive:
    def test_omitted_run_id_keeps_detail_byte_identical_completed(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status='completed', output={'ok': True},
        )
        assert 'runId' not in detail

    def test_supplied_run_id_promoted_to_top_level_key_completed(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status='completed', output={'ok': True}, run_id='run-xyz',
        )
        assert detail['runId'] == 'run-xyz'

    def test_supplied_run_id_promoted_to_top_level_key_failed(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status='failed', error='boom', run_id='run-fail',
        )
        assert detail['runId'] == 'run-fail'

    def test_omitted_run_id_keeps_detail_byte_identical_failed(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status='failed', error='boom',
        )
        assert 'runId' not in detail
