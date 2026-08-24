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

Fail-closed ledger semantics (decision gov-write-fail-closed): if
``GOVERNANCE_LEDGER_TABLE`` is unset (e.g. local test env) or the write
otherwise fails, ``write_finding`` raises ``LedgerWriteError``. Both the
legacy ``preprocess`` path and the hooks-based path route that failure
through ``record_governance_decision``, which refuses the tool call (an
unauditable PERMIT/DENY record is never allowed to reach an unprotected
execution) and records the failure into the shared node-failure sink so the
node fails post-turn. This REPLACES the former best-effort WARN+continue
(AC 9.4) and applies at the per-tool preprocess/hook scope itself, not only
at the supervisor dispatch level.

Import path note
----------------
``governance/ledger.py`` uses a relative import (``from .models import
GovernanceFinding``), so ``ledger`` MUST be loaded as a submodule of the
``governance`` *package* — never as a bare top-level ``ledger`` module. In
the DEPLOYED worker Lambda the shared ``ArbiterCatalogLayer`` stages the
whole ``governance`` package (with its ``__init__.py``) at
``/opt/python/governance``, so ``from governance.ledger import ...`` resolves
and its relative ``.models`` import works. We import via the top-level
``governance`` package — NOT ``arbiter.governance`` — because no ``arbiter``
package exists in the deployed bundle or the layer (importing via
``arbiter.*`` is exactly what raised "No module named arbiter" in the first
real smoke run). The same names resolve under pytest via
``arbiter/conftest.py`` (which puts the arbiter root on sys.path).

Wiring status
-------------
The ``strands.Agent(tool_handler=...)`` seam this class was written for was
REMOVED in ``strands-agents==1.30.0`` (``Agent.__init__`` accepts neither
``tool_handler`` nor ``**kwargs``), which left layer-2 governance INERT at
runtime (finding 027c4a89). Governance was re-ported onto the live hooks seam:
``arbiter/workerWrapper/governance_tool_hook.py`` (``GovernanceEvaluator`` /
``GovernanceToolHook``), composed with tool-call idempotency behind ONE
``BeforeToolCallEvent`` callback (``tool_idempotency_hook.ComposedToolHook``),
installed by ``agent_runner._install_tool_call_hooks``.

The DECISION itself (deny-list lookup + audit finding) lives in the shared
``record_governance_decision`` / ``build_governance_finding`` helpers in this
module — the SINGLE source of truth both the (now legacy) ``preprocess`` path
and the live hooks path call, so the two can never diverge again. This
``GovernedToolHandler`` class is retained for the legacy ``AgentToolHandler``
interface but is no longer installed on strands 1.30.0.

Spec: arbiter-governance-engine/requirements.md Requirement 9.1–9.5.
"""

from __future__ import annotations

import logging
import os
from typing import Any

# Import convention (DEPLOYED layout): the shared ``ArbiterCatalogLayer``
# stages the ``governance`` package at ``/opt/python/governance`` and the
# worker bundle roots this file's directory on sys.path. Import via the
# top-level ``governance`` package — NEVER ``arbiter.governance`` (no
# ``arbiter`` package exists in the deployed bundle or the layer). Under
# pytest, ``arbiter/conftest.py`` puts the arbiter root on sys.path so
# ``governance`` resolves there too.
from governance.models import ArbitrationDecision, GovernanceFinding  # noqa: E402
from governance.ledger import write_finding, LedgerWriteError  # noqa: E402

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


def _deny_error_result(tool_use_id: str, tool_name: str) -> dict:
    """The ToolResult-shaped error dict returned when a tool is denied.

    Strands accepts duck-typed dicts; the same shape is used whether the
    decision fires from the legacy ``preprocess`` path or the hooks-based
    ``GovernanceToolHook`` path — a single source of truth for the message
    the model sees on a denial.
    """
    return {
        'toolUseId': tool_use_id,
        'status': 'error',
        'content': [
            {'text': f"Tool '{tool_name}' is not authorised for this agent."}
        ],
    }


def _audit_unavailable_result(tool_use_id: str, tool_name: str) -> dict:
    """ToolResult-shaped error dict returned when the governance legibility
    write FAILED (fail-closed, decision gov-write-fail-closed).

    Distinct message from a policy denial: the tool was not *denied by policy*,
    it was blocked because its PERMIT/DENY audit record could not be written and
    an unauditable tool execution is not permitted (see
    ``record_governance_decision``)."""
    return {
        'toolUseId': tool_use_id,
        'status': 'error',
        'content': [
            {'text': (
                f"Tool '{tool_name}' execution refused: its governance audit "
                "record could not be written (fail-closed — an unauditable "
                "tool execution is not permitted)."
            )}
        ],
    }


def _record_audit_write_refusal(exc: Exception) -> None:
    """Record a governance-finding-WRITE failure into the shared node-failure
    refusal sink so the node FAILS post-turn (decision gov-write-fail-closed).

    Uses the SAME structural sink (``tool_idempotency_hook._GOVERNANCE_REFUSALS``)
    that a tool-execution-ledger infra refusal uses, so a governance-write
    failure and a ledger infra failure fail the node through ONE mechanism
    (three-way discriminator, finding 4595b730). Lazily imported: the sink lives
    in the worker bundle, always present in the deployed worker and under
    pytest; a genuinely-absent sink still leaves the tool blocked (the caller's
    error ToolResult), it just can't additionally fail the node."""
    try:
        from tool_idempotency_hook import _record_governance_refusal
    except ImportError:  # pragma: no cover — worker-bundle sibling; always present
        return
    try:
        _record_governance_refusal(exc)
    except Exception as sink_exc:  # noqa: BLE001 — recording must never itself crash
        logger.error('failed to record governance-write refusal: %s', sink_exc)


def build_governance_finding(
    tool_name: str,
    denied: bool,
    *,
    agent_id: str,
    workflow_id: str,
    eval_run_id: str | None = None,
) -> GovernanceFinding:
    """Build the worker-tool-handler-scope ``GovernanceFinding`` for one tool
    call. Shared by the legacy ``GovernedToolHandler.preprocess`` and the
    hooks-based ``GovernanceToolHook`` so both layers emit byte-identical
    findings (QD-5: scope ``worker-tool-handler``, distinct from
    ``worker-pre-filter``). PERMIT and DENY both produce a finding."""
    decision = ArbitrationDecision.DENY if denied else ArbitrationDecision.PERMIT
    return GovernanceFinding.create(
        workflow_id=workflow_id,
        decision=decision,
        requesting_agent=agent_id,
        target_agent=f'tool:{tool_name}',
        reason=(
            f'tool_denied:explicit_deny_list:{tool_name}'
            if denied
            else f'tool_permitted:not_on_deny_list:{tool_name}'
        ),
        scope_evaluated=SCOPE_WORKER_TOOL_HANDLER,
        contract_evaluated=None,
        eval_run_id=eval_run_id,
    )


def record_governance_decision(
    tool_name: str,
    tool_use_id: str,
    *,
    agent_id: str,
    workflow_id: str,
    denied_tools: set[str],
    eval_run_id: str | None = None,
) -> tuple[bool, dict | None]:
    """Evaluate the deny-list decision, write the audit finding, and return
    ``(denied_or_blocked, error_result_or_None)``.

    THE single source of truth for the layer-2 tool-call governance decision.
    Both the legacy ``GovernedToolHandler.preprocess`` (strands ``tool_handler``
    seam, dead on 1.30.0) and the live ``GovernanceToolHook`` (BeforeToolCallEvent
    seam) call this — so the two can never diverge (the exact root cause of
    finding 027c4a89 was two decision surfaces, one live and one dead).

    A finding is written on BOTH permit and deny (full audit trail).

    GOVERNANCE-WRITE POLICY — FAIL-CLOSED (decision gov-write-fail-closed,
    settling the run-3/run-4 inconsistency of finding 4595b730). A governance
    legibility write failure is NOT best-effort here: it is treated as an
    infrastructure refusal. A PERMIT/DENY audit record that cannot be persisted
    means an UNAUDITABLE tool execution, which is exactly what Citadel's
    governance guarantee (and Article 3's fail-closed constitutional rule)
    forbids — the platform's whole value is that every governed action leaves a
    defensible record. On a ``LedgerWriteError`` we therefore:
      1. record the failure into the shared node-failure refusal sink so the
         node FAILS post-turn (same structural mechanism a tool-execution-ledger
         infra refusal uses — three-way discriminator), and
      2. return ``(True, audit_unavailable_result)`` so the caller BLOCKS the
         tool (it never runs unaudited — a DENY is preserved a fortiori).
    The availability cost (a governance-ledger blip fails the tool call) is the
    intended tradeoff for an audit platform, and is bounded: the recorded class
    (``LedgerWriteError``) is a retry.py classification key a node's retry policy
    can retry, and the single marshalling boundary (finding 96d24639) removes the
    most common historical cause of these write failures (a native-float item).

    This REPLACES the former best-effort WARN+continue (AC 9.4). The DENY
    short-circuit is still independent of the write: a denial is never weakened
    by a ledger outage, and now an unauditable PERMIT is blocked too.
    """
    denied = tool_name in denied_tools
    finding = build_governance_finding(
        tool_name, denied,
        agent_id=agent_id, workflow_id=workflow_id, eval_run_id=eval_run_id,
    )
    try:
        write_finding(finding)
    except LedgerWriteError as exc:
        # FAIL-CLOSED: unauditable execution is not permitted. Fail the node
        # (refusal sink) AND block the tool (audit-unavailable error result).
        logger.error(
            'governance ledger write FAILED at worker-tool-handler (fail-closed) '
            'finding_id=%s tool=%s: %s',
            finding.finding_id, tool_name, exc,
        )
        _record_audit_write_refusal(exc)
        return True, _audit_unavailable_result(tool_use_id, tool_name)
    if denied:
        return True, _deny_error_result(tool_use_id, tool_name)
    return False, None


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
        eval_run_id: str | None = None,
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
        # CIT-102 Pass B: per-run eval-context correlation id, stamped on
        # every finding this handler writes (PERMIT and DENY alike) so a
        # forbidden-tool attempt in an eval dispatch surfaces in that run's
        # replay-package findings. None (the default) for every non-eval
        # invocation — byte-identical finding/ledger-write behavior.
        self.eval_run_id = eval_run_id

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

        # Delegate to the shared decision (single source of truth, also used by
        # the live BeforeToolCallEvent seam in governance_tool_hook.py).
        _denied, error_result = record_governance_decision(
            tool_name, tool_use_id,
            agent_id=self.agent_id,
            workflow_id=self.workflow_id,
            denied_tools=self.denied_tools,
            eval_run_id=self.eval_run_id,
        )
        # error_result is the ToolResult-shaped deny dict on DENY, else None
        # (PERMIT → fall through to the default handler).
        return error_result
