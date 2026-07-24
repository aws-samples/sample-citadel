"""GovernedToolHandler — worker-side tool-call governance hook (US-ARB-012).

Provides a Strands AgentToolHandler subclass whose preprocess() method:
  1. Looks up the tool's name against a denied-tool list (agent-config or
     env var DENIED_TOOLS).
  2. Writes an independent GovernanceFinding with scope_evaluated set to
     SCOPE_WORKER_TOOL_HANDLER ('worker-tool-handler'). Per QD-5, this
     finding is distinct from the pre-filter layer's 'worker-pre-filter'
     finding — both layers fire independently; never merged.
  3. On DENY returns a ToolResult containing an error message; execution
     halts for that tool.
  4. On PERMIT returns None; execution proceeds through the default
     Strands handler.

Best-effort ledger semantics: if ``GOVERNANCE_LEDGER_TABLE`` is unset (e.g.
local test env), ``write_finding`` raises ``LedgerWriteError``. The worker
handler catches it and WARN-logs — it does NOT fail closed at this
scope. Fail-closed semantics apply at the supervisor dispatch level
(US-ARB-008), not at the per-tool preprocess hook.

Import path note
----------------
``arbiter/governance/ledger.py`` uses a relative import (``from .models
import GovernanceFinding``). That means ``ledger`` MUST be loaded as a
submodule of the ``arbiter.governance`` package — importing it as a
top-level module (e.g. by inserting ``arbiter/governance`` onto
``sys.path`` and doing ``from ledger import write_finding``) would break
its relative import at load time. We therefore place the **project
root** on ``sys.path`` and import via the fully-qualified
``arbiter.governance.*`` path, matching the pattern already used by
``arbiter/governance/__tests__/test_ledger.py``.

Wiring status
-------------
Wired. ``arbiter/workerWrapper/agent_runner.py`` installs a
``strands.Agent.__init__`` patch (``_install_governed_tool_handler``) before
the agent module is exec'd inside the subprocess, so every ``Agent(...)``
constructed by the loaded module automatically receives a
``GovernedToolHandler`` instance as its ``tool_handler`` — unless the caller
explicitly passes its own, which always wins. The patch is a no-op when
``CITADEL_AGENT_ID`` is unset in the subprocess environment (back-compat with
agents run outside the governance envelope). See
``arbiter/workerWrapper/__tests__/test_agent_runner_properties.py`` for the
injection-contract tests.

Spec: arbiter-governance-engine/requirements.md Requirement 9.1–9.5.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any

# Put the project root on sys.path so ``from arbiter.governance.*`` resolves
# regardless of how this module is loaded (direct subprocess, Lambda runtime,
# or pytest under ``arbiter/conftest.py``). The path walk is:
#     this file   = <root>/arbiter/workerWrapper/governed_tool_handler.py
#     project root = three levels up.
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.abspath(os.path.join(_HERE, '..', '..'))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance.models import ArbitrationDecision, GovernanceFinding  # noqa: E402
from arbiter.governance.ledger import write_finding, LedgerWriteError  # noqa: E402

# Strands imports — these live in the Lambda runtime image but may be
# absent (or differently namespaced) in local test envs. Fall back to a
# no-op stub so the module is importable without strands-agents.
try:
    from strands.handlers.tool_handler import AgentToolHandler  # type: ignore
    from strands.types.tools import ToolResult  # type: ignore  # noqa: F401
    _STRANDS_AVAILABLE = True
except ImportError:  # pragma: no cover — dev-env only
    _STRANDS_AVAILABLE = False

    class AgentToolHandler:  # type: ignore[no-redef]
        """Stub base class used when strands-agents is not installed.

        The real Strands ``AgentToolHandler`` provides default
        ``preprocess`` / ``postprocess`` hooks plus tool-registry plumbing;
        we only need a class object to subclass so this module is
        importable in dev / CI environments that lack the SDK.
        """

        def preprocess(self, tool, tool_config, **kwargs):  # noqa: D401
            return None

    ToolResult = dict  # type: ignore[misc,assignment]


logger = logging.getLogger(__name__)

# Per QD-5 this scope value MUST be distinct from 'worker-pre-filter'
# (governance.py layer). Exported so US-ARB-015's header comment can
# reference it symmetrically.
SCOPE_WORKER_TOOL_HANDLER = 'worker-tool-handler'


def _parse_denied_tools_env() -> set[str]:
    """Parse the ``DENIED_TOOLS`` env var.

    Comma-separated, whitespace-tolerant. Empty tokens are skipped so a
    trailing comma (``'a,b,'``) doesn't produce an empty-string entry.
    Returns an empty set if the var is unset or entirely whitespace.
    """
    raw = os.environ.get('DENIED_TOOLS', '')
    return {t.strip() for t in raw.split(',') if t.strip()}


class GovernedToolHandler(AgentToolHandler):  # type: ignore[misc]
    """Strands ``AgentToolHandler`` that enforces a denied-tool allowlist
    and emits an independent ``GovernanceFinding`` per tool invocation.

    A finding is written to the ledger on every preprocess call — both
    PERMIT and DENY — so the ledger carries a complete audit trail of
    worker-level tool decisions, not just the blocked ones.
    """

    def __init__(
        self,
        tool_registry: Any = None,
        agent_id: str = 'unknown-agent',
        workflow_id: str = 'unknown-workflow',
        denied_tools: set[str] | None = None,
    ):
        # Strands ``AgentToolHandler.__init__`` may require specific kwargs
        # and the signature has drifted across SDK releases. Fall back
        # gracefully if the base ``__init__`` rejects our positional arg
        # (e.g. the dev stub above takes no args).
        try:
            super().__init__(tool_registry)  # type: ignore[arg-type]
        except TypeError:
            try:
                super().__init__()  # type: ignore[call-arg]
            except TypeError:
                # Truly unknown base signature — just ignore and rely on
                # the attributes we set below.
                pass
        self.tool_registry = tool_registry
        self.agent_id = agent_id
        self.workflow_id = workflow_id
        # Constructor arg takes precedence; fall back to env var. An
        # explicit empty set still overrides the env var — that is how
        # callers disable the env-var fallback (e.g. in tests).
        self.denied_tools = (
            denied_tools if denied_tools is not None else _parse_denied_tools_env()
        )

    def preprocess(
        self,
        tool: Any,  # ToolUse or plain dict
        tool_config: Any = None,  # ToolConfig
        **kwargs: Any,
    ) -> Any | None:  # ToolResult | None
        """Enforce the denied-tool policy.

        Returns a ToolResult-shaped dict on DENY so Strands short-circuits
        the tool invocation and surfaces the error back to the model.
        Returns ``None`` on PERMIT so the default Strands handler runs.
        """
        # Duck-typed extraction: Strands passes a ``ToolUse`` dict at
        # runtime, but unit tests pass plain dicts. ``hasattr(..., 'get')``
        # picks up the mapping case; ``getattr(..., 'name', '')`` covers
        # an attribute-style object.
        if hasattr(tool, 'get'):
            tool_name = tool.get('name', '') or ''
            tool_use_id = tool.get('toolUseId', '') or ''
        else:
            tool_name = getattr(tool, 'name', '') or ''
            tool_use_id = getattr(tool, 'toolUseId', '') or ''

        denied = tool_name in self.denied_tools
        decision = ArbitrationDecision.DENY if denied else ArbitrationDecision.PERMIT

        finding = GovernanceFinding.create(
            workflow_id=self.workflow_id,
            decision=decision,
            requesting_agent=self.agent_id,
            target_agent=f'tool:{tool_name}',
            reason=(
                f'tool_denied:explicit_deny_list:{tool_name}'
                if denied
                else f'tool_permitted:not_on_deny_list:{tool_name}'
            ),
            scope_evaluated=SCOPE_WORKER_TOOL_HANDLER,
            contract_evaluated=None,
        )

        try:
            write_finding(finding)
        except LedgerWriteError as exc:
            # Best-effort at worker-tool-handler scope per AC 9.4.
            # Fail-closed semantics belong at supervisor dispatch
            # (US-ARB-008), not here — logging + continue is correct.
            logger.warning(
                'governance ledger write failed at worker-tool-handler '
                'finding_id=%s tool=%s: %s',
                finding.finding_id, tool_name, exc,
            )

        if denied:
            # ToolResult-shaped dict; Strands accepts duck-typed dicts.
            return {
                'toolUseId': tool_use_id,
                'status': 'error',
                'content': [
                    {'text': f"Tool '{tool_name}' is not authorised for this agent."}
                ],
            }

        # PERMIT → fall through to default handler.
        return None
