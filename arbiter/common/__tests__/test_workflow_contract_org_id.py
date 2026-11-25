"""Tests for org_id additive threading through
arbiter/common/workflow_contract.py (chatter-producer stamping fix,
remaining-producers sweep) — mirrors the run_id additive-field test
pattern in test_workflow_contract_run_id.py.

chatter-publisher.ts refuses to forward any EventBridge detail lacking
``detail.orgId``. workflow.node.completed/failed events built via
``build_node_result_detail`` had no org_id parameter at all, so every
worker node result was being dropped before this fix.
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


class TestDispatchMessageOrgIdAdditive:
    def test_omitted_org_id_keeps_message_byte_identical(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
        )
        assert 'orgId' not in message

    def test_supplied_org_id_is_promoted_to_top_level_key(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            org_id='org-abc',
        )
        assert message['orgId'] == 'org-abc'

    def test_none_org_id_omits_key(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            org_id=None,
        )
        assert 'orgId' not in message

    def test_non_string_org_id_raises(self):
        with pytest.raises(ValueError):
            build_node_dispatch_message(
                execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
                org_id=12345,  # type: ignore[arg-type]
            )

    def test_parse_round_trips_org_id(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            org_id='org-abc',
        )
        parsed = parse_node_dispatch_message(message)
        assert parsed.org_id == 'org-abc'

    def test_parse_defaults_org_id_to_none_when_absent(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
        )
        parsed = parse_node_dispatch_message(message)
        assert parsed.org_id is None

    def test_parse_never_raises_on_malformed_org_id_on_the_wire(self):
        """A malformed orgId (wrong type) on the wire degrades to None
        rather than raising — org_id is best-effort, never gates parsing."""
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
        )
        message['orgId'] = 12345
        parsed = parse_node_dispatch_message(message)
        assert parsed.org_id is None


class TestNodeResultDetailOrgIdAdditive:
    def test_omitted_org_id_keeps_detail_byte_identical_completed(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status='completed', output={'ok': True},
        )
        assert 'orgId' not in detail

    def test_supplied_org_id_promoted_to_top_level_key_completed(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status='completed', output={'ok': True}, org_id='org-xyz',
        )
        assert detail['orgId'] == 'org-xyz'

    def test_supplied_org_id_promoted_to_top_level_key_failed(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status='failed', error='boom', org_id='org-fail',
        )
        assert detail['orgId'] == 'org-fail'

    def test_omitted_org_id_keeps_detail_byte_identical_failed(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status='failed', error='boom',
        )
        assert 'orgId' not in detail
