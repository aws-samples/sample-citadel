"""CIT-102 Pass B — GovernedToolHandler eval_run_id stamping tests.

Mirrors test_governed_tool_handler.py's structure. Covers the acceptance
criteria: forbidden-tool attempt => DENY short-circuit (real tool never
invoked) + finding stamped eval_run_id (the block-only contract), and a
property test over arbitrary tool names/args (hypothesis) proving forbidden
tools are NEVER permitted through regardless of eval_run_id presence.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

from hypothesis import given, settings, strategies as st

_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

from governed_tool_handler import GovernedToolHandler  # noqa: E402
from arbiter.governance.models import ArbitrationDecision  # noqa: E402


def test_ctor_defaults_eval_run_id_to_none():
    handler = GovernedToolHandler(denied_tools=set())
    assert handler.eval_run_id is None


def test_deny_finding_stamped_with_eval_run_id_when_present():
    handler = GovernedToolHandler(
        agent_id='agent-42',
        workflow_id='wf-123',
        denied_tools={'dangerous_tool'},
        eval_run_id='eval-run-99',
    )

    with patch('governed_tool_handler.write_finding') as mock_write:
        result = handler.preprocess({'name': 'dangerous_tool', 'toolUseId': 'tu-1'})

    assert isinstance(result, dict)
    assert result['status'] == 'error'
    (written_finding,), _ = mock_write.call_args
    assert written_finding.decision == ArbitrationDecision.DENY
    assert written_finding.eval_run_id == 'eval-run-99'


def test_permit_finding_stamped_with_eval_run_id_when_present():
    handler = GovernedToolHandler(
        agent_id='agent-a', workflow_id='wf-b', denied_tools=set(),
        eval_run_id='eval-run-100',
    )

    with patch('governed_tool_handler.write_finding') as mock_write:
        result = handler.preprocess({'name': 'safe_tool'})

    assert result is None
    (written_finding,), _ = mock_write.call_args
    assert written_finding.decision == ArbitrationDecision.PERMIT
    assert written_finding.eval_run_id == 'eval-run-100'


def test_finding_eval_run_id_none_when_absent():
    """Non-eval invocation (the overwhelming majority): finding.eval_run_id
    stays None — byte-identical to pre-CIT-102 behavior."""
    handler = GovernedToolHandler(denied_tools={'blocked'})

    with patch('governed_tool_handler.write_finding') as mock_write:
        handler.preprocess({'name': 'blocked', 'toolUseId': 'tu-x'})

    (written_finding,), _ = mock_write.call_args
    assert written_finding.eval_run_id is None


# ---------------------------------------------------------------------------
# Property test: forbidden tool never executes (block-only contract).
# ---------------------------------------------------------------------------


@settings(max_examples=200, deadline=None)
@given(
    tool_name=st.text(
        alphabet=st.characters(blacklist_categories=('Cs',)),
        min_size=0,
        max_size=40,
    ),
    forbidden_tools=st.sets(
        st.text(alphabet=st.characters(blacklist_categories=('Cs',)), min_size=1, max_size=40),
        max_size=10,
    ),
    eval_run_id=st.one_of(st.none(), st.text(min_size=1, max_size=20)),
    tool_args=st.dictionaries(
        st.text(min_size=1, max_size=10),
        st.one_of(st.text(max_size=20), st.integers(), st.booleans()),
        max_size=5,
    ),
)
def test_property_forbidden_tool_never_executes(tool_name, forbidden_tools, eval_run_id, tool_args):
    """[FORBIDDEN-NEVER-EXECUTES property] For arbitrary tool names/args and
    an arbitrary forbidden-tools set injected as denied_tools: preprocess
    returns a DENY error dict for every tool in forbidden_tools (the real
    tool handler is never reached — Strands short-circuits on a non-None
    return), and PERMIT (None) for every tool not in the set. The DENY
    finding always carries eval_run_id when the run is eval-scoped."""
    handler = GovernedToolHandler(denied_tools=set(forbidden_tools), eval_run_id=eval_run_id)

    with patch('governed_tool_handler.write_finding') as mock_write:
        result = handler.preprocess({'name': tool_name, 'toolUseId': 'tu', **tool_args})

    if tool_name in forbidden_tools:
        # DENY short-circuit: a non-None ToolResult-shaped dict is returned,
        # which is precisely what makes Strands skip the real tool handler.
        assert isinstance(result, dict)
        assert result['status'] == 'error'
        (written_finding,), _ = mock_write.call_args
        assert written_finding.decision == ArbitrationDecision.DENY
        assert written_finding.eval_run_id == eval_run_id
    else:
        assert result is None
        (written_finding,), _ = mock_write.call_args
        assert written_finding.decision == ArbitrationDecision.PERMIT
        assert written_finding.eval_run_id == eval_run_id

    assert mock_write.call_count == 1
