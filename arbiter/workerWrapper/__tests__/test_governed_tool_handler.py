"""US-ARB-012 tests — GovernedToolHandler preprocess hook.

Covers AC 9.1–9.5 for the worker-side tool-call governance hook:

* 9.1 tool-name lookup against a denied list (constructor arg + env var)
* 9.2 independent GovernanceFinding with scope_evaluated='worker-tool-handler'
* 9.3 DENY returns a ToolResult-shaped error dict; PERMIT returns None
* 9.4 ledger write failure at worker scope is WARN-logged, not fatal
* 9.5 denied-tool parsing from DENIED_TOOLS env var

Imports:

``arbiter/conftest.py`` already places ``arbiter/workerWrapper`` on
``sys.path`` for test collection, so ``from governed_tool_handler import
...`` resolves without any path gymnastics here. We still do an explicit
insert at the top so this file runs under ``pytest <this_file>`` when
invoked outside the arbiter tree (e.g. when the repo is mounted at a
different root).
"""

from __future__ import annotations

import logging
import os
import sys
from unittest.mock import patch

import pytest
from hypothesis import given, settings, strategies as st

# Make sibling-dir import resilient regardless of pytest invocation path.
_WORKER_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _WORKER_DIR not in sys.path:
    sys.path.insert(0, _WORKER_DIR)

from governed_tool_handler import (  # noqa: E402
    GovernedToolHandler,
    SCOPE_WORKER_TOOL_HANDLER,
    _parse_denied_tools_env,
)
from arbiter.governance.models import ArbitrationDecision  # noqa: E402
from arbiter.governance.ledger import LedgerWriteError  # noqa: E402


# ---------------------------------------------------------------------------
# AC 9.3 — DENY path returns ToolResult-shaped dict; finding captured.
# ---------------------------------------------------------------------------


def test_preprocess_deny_returns_tool_result_and_writes_finding():
    """DENY: tool on the deny list → error ToolResult + DENY finding."""
    handler = GovernedToolHandler(
        agent_id='agent-42',
        workflow_id='wf-123',
        denied_tools={'dangerous_tool'},
    )

    with patch('governed_tool_handler.write_finding') as mock_write:
        result = handler.preprocess(
            {'name': 'dangerous_tool', 'toolUseId': 'tu-1'}
        )

    assert isinstance(result, dict)
    assert result['status'] == 'error'
    assert result['toolUseId'] == 'tu-1'
    assert result['content'][0]['text'].startswith(
        "Tool 'dangerous_tool' is not authorised"
    )

    assert mock_write.call_count == 1
    (written_finding,), _kwargs = mock_write.call_args
    assert written_finding.decision == ArbitrationDecision.DENY
    assert written_finding.scope_evaluated == SCOPE_WORKER_TOOL_HANDLER
    assert written_finding.target_agent == 'tool:dangerous_tool'
    assert written_finding.requesting_agent == 'agent-42'
    assert written_finding.workflow_id == 'wf-123'


# ---------------------------------------------------------------------------
# AC 9.3 — PERMIT path returns None; finding still captured.
# ---------------------------------------------------------------------------


def test_preprocess_permit_returns_none_and_writes_permit_finding():
    """PERMIT: tool not on deny list → None + PERMIT finding."""
    handler = GovernedToolHandler(
        agent_id='agent-a',
        workflow_id='wf-b',
        denied_tools=set(),
    )

    with patch('governed_tool_handler.write_finding') as mock_write:
        result = handler.preprocess({'name': 'safe_tool'})

    assert result is None
    assert mock_write.call_count == 1
    (written_finding,), _kwargs = mock_write.call_args
    assert written_finding.decision == ArbitrationDecision.PERMIT
    assert written_finding.scope_evaluated == SCOPE_WORKER_TOOL_HANDLER
    assert written_finding.target_agent == 'tool:safe_tool'


# ---------------------------------------------------------------------------
# AC 9.4 — LedgerWriteError is caught and WARN-logged; preprocess does NOT
# raise. Covers both DENY and PERMIT paths.
# ---------------------------------------------------------------------------


def test_preprocess_ledger_unset_permit_best_effort(monkeypatch, caplog):
    """PERMIT path: ledger failure is best-effort — warn, return None."""
    monkeypatch.delenv('GOVERNANCE_LEDGER_TABLE', raising=False)
    handler = GovernedToolHandler(denied_tools=set())

    with patch(
        'governed_tool_handler.write_finding',
        side_effect=LedgerWriteError('GOVERNANCE_LEDGER_TABLE not configured'),
    ):
        with caplog.at_level(logging.WARNING, logger='governed_tool_handler'):
            result = handler.preprocess({'name': 'safe_tool'})

    assert result is None  # PERMIT path survives ledger failure
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert 'governance ledger write failed' in warnings[0].getMessage()


def test_preprocess_ledger_unset_deny_best_effort(monkeypatch, caplog):
    """DENY path: ledger failure is best-effort — warn, still return
    the denial ToolResult (the deny decision itself does NOT depend on
    the ledger at worker-tool-handler scope per AC 9.4)."""
    monkeypatch.delenv('GOVERNANCE_LEDGER_TABLE', raising=False)
    handler = GovernedToolHandler(denied_tools={'blocked'})

    with patch(
        'governed_tool_handler.write_finding',
        side_effect=LedgerWriteError('GOVERNANCE_LEDGER_TABLE not configured'),
    ):
        with caplog.at_level(logging.WARNING, logger='governed_tool_handler'):
            result = handler.preprocess({'name': 'blocked', 'toolUseId': 'tu-x'})

    assert isinstance(result, dict)
    assert result['status'] == 'error'
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert 'governance ledger write failed' in warnings[0].getMessage()


# ---------------------------------------------------------------------------
# AC 9.5 — DENIED_TOOLS env-var parsing.
# ---------------------------------------------------------------------------


def test_parse_denied_tools_env_strips_whitespace_and_empties(monkeypatch):
    """Comma-separated, whitespace-tolerant, empty tokens skipped."""
    monkeypatch.setenv('DENIED_TOOLS', 'a, b ,c, ')
    assert _parse_denied_tools_env() == {'a', 'b', 'c'}


def test_parse_denied_tools_env_unset_returns_empty(monkeypatch):
    monkeypatch.delenv('DENIED_TOOLS', raising=False)
    assert _parse_denied_tools_env() == set()


def test_handler_env_fallback_when_no_denied_tools_arg(monkeypatch):
    """Constructor omits ``denied_tools`` → reads from env var."""
    monkeypatch.setenv('DENIED_TOOLS', 'only_one')
    handler = GovernedToolHandler()
    assert handler.denied_tools == {'only_one'}


def test_handler_explicit_empty_set_overrides_env(monkeypatch):
    """Explicit ``denied_tools=set()`` MUST NOT silently fall through to
    the env var — that is the escape hatch tests rely on."""
    monkeypatch.setenv('DENIED_TOOLS', 'should_be_ignored')
    handler = GovernedToolHandler(denied_tools=set())
    assert handler.denied_tools == set()


# ---------------------------------------------------------------------------
# AC 9.1 / 9.3 — property-based invariant over random tool names + deny sets.
# ---------------------------------------------------------------------------


@settings(max_examples=200, deadline=None)
@given(
    tool_name=st.text(
        alphabet=st.characters(
            blacklist_categories=('Cs',),  # no lone surrogates
        ),
        min_size=0,
        max_size=40,
    ),
    denied_set=st.sets(
        st.text(
            alphabet=st.characters(blacklist_categories=('Cs',)),
            min_size=0,
            max_size=40,
        ),
        max_size=10,
    ),
)
def test_preprocess_property_deny_iff_in_denied_set(tool_name, denied_set):
    """Invariant: returns None iff tool_name NOT in denied_set;
    otherwise returns a dict with status='error'."""
    handler = GovernedToolHandler(denied_tools=set(denied_set))

    with patch('governed_tool_handler.write_finding') as mock_write:
        result = handler.preprocess({'name': tool_name, 'toolUseId': 'tu'})

    if tool_name in denied_set:
        assert isinstance(result, dict)
        assert result['status'] == 'error'
    else:
        assert result is None

    # Exactly one finding written per invocation, regardless of decision.
    assert mock_write.call_count == 1


# ---------------------------------------------------------------------------
# Contract-pinning test for the Strands SDK surface.
# ---------------------------------------------------------------------------


def test_strands_sdk_contract_if_installed():
    """If strands-agents exports AgentToolHandler at the path we expect,
    it MUST carry a ``preprocess`` attribute — that's the hook we
    subclass. If it does not, SDK drift has broken our integration and
    this test fails loud.

    If the symbol isn't exported at that path in the installed Strands
    version, we SKIP so local dev envs and older images aren't blocked;
    CI images that pin a Strands version exposing ``AgentToolHandler``
    will exercise the assertion.
    """
    try:
        from strands.handlers.tool_handler import AgentToolHandler  # type: ignore
        from strands.types.tools import ToolResult  # type: ignore  # noqa: F401
        from strands.types.tools import ToolUse  # type: ignore  # noqa: F401
    except ImportError:
        pytest.skip('strands-agents AgentToolHandler not importable in this env')

    assert hasattr(AgentToolHandler, 'preprocess'), (
        'Strands AgentToolHandler no longer exposes preprocess() — '
        'SDK drift detected, update GovernedToolHandler to match the '
        'new hook surface.'
    )


# ---------------------------------------------------------------------------
# Scope constant export — consumed by US-ARB-015's symmetry reference.
# ---------------------------------------------------------------------------


def test_scope_worker_tool_handler_constant_value():
    assert SCOPE_WORKER_TOOL_HANDLER == 'worker-tool-handler'
