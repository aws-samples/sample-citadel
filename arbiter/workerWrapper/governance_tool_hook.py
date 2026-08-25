"""Layer-2 tool-call governance on the live Strands hooks seam (finding 027c4a89).

Background
----------
The original layer-2 governance surface (``governed_tool_handler.GovernedToolHandler``)
was injected as ``Agent(tool_handler=...)``. ``strands-agents==1.30.0`` REMOVED
that seam: ``Agent.__init__`` accepts neither ``tool_handler`` nor ``**kwargs``,
and ``strands.handlers.tool_handler`` is gone. So the injector
(``agent_runner._install_governed_tool_handler``) detected the missing kwarg and
merely WARNED — layer-2 allow/deny was INERT at runtime on every workflow-node
agent execution, while the sibling idempotency concern HAD been re-ported to the
hooks API. This module re-ports governance onto the SAME seam the idempotency
hook uses (``BeforeToolCallEvent`` + writable ``selected_tool``), so the two are
composed at one seam and can never diverge again (see ``tool_idempotency_hook.ComposedToolHook``).

Decision (single source of truth)
----------------------------------
The allow/deny + audit-finding decision itself lives in
``governed_tool_handler.record_governance_decision`` — this module only binds
that decision to the real tool-call event. On DENY it REPLACES ``selected_tool``
with a :class:`_GovernanceDeniedTool` whose ``stream()`` yields the deny error
ToolResult and NEVER touches the real tool (mirroring the idempotency hook's
``_KeyDerivationFailedTool``). On PERMIT it leaves ``selected_tool`` unchanged
(the composing hook then applies idempotency).

Degrades to a no-op import when ``strands`` is unavailable (dev/CI), mirroring
``tool_idempotency_hook.py`` / ``governed_tool_handler.py``.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from governed_tool_handler import (  # noqa: E402
    SCOPE_WORKER_TOOL_HANDLER,  # re-exported for symmetric reference
    LedgerWriteError,
    _approval_required_result,
    _approval_unavailable_result,
    _parse_approval_required_tools_env,
    _parse_denied_tools_env,
    record_approval_finding,
    record_governance_decision,
)

logger = logging.getLogger(__name__)

try:
    from strands.hooks import BeforeToolCallEvent  # type: ignore
    from strands.types.tools import AgentTool  # type: ignore

    _STRANDS_AVAILABLE = True
except ImportError:  # pragma: no cover — dev/CI without strands-agents
    _STRANDS_AVAILABLE = False
    BeforeToolCallEvent = object  # type: ignore[assignment,misc]
    AgentTool = object  # type: ignore[assignment,misc]


class _GovernanceDeniedTool(AgentTool):  # type: ignore[misc]
    """Replacement tool installed when governance DENYs a call. Its ``stream()``
    yields the deny error ToolResult and never delegates to the real tool — so a
    denied tool performs no side effect and never reaches the idempotency
    reserve. Mirrors ``tool_idempotency_hook._KeyDerivationFailedTool``."""

    def __init__(self, inner: Any, error_result: dict[str, Any]):
        try:
            super().__init__()
        except TypeError:  # pragma: no cover — base signature drift
            pass
        self._inner = inner
        self._error_result = error_result

    @property
    def tool_name(self) -> str:  # pragma: no cover — thin delegation
        return self._inner.tool_name

    @property
    def tool_spec(self) -> Any:  # pragma: no cover — thin delegation
        return self._inner.tool_spec

    @property
    def tool_type(self) -> str:  # pragma: no cover — thin delegation
        return self._inner.tool_type

    def get_display_properties(self) -> dict[str, str]:  # pragma: no cover
        return self._inner.get_display_properties()

    async def stream(self, tool_use: Any, invocation_state: dict[str, Any], **kwargs: Any):  # pragma: no cover — requires strands runtime
        from strands.types._events import ToolResultEvent  # local import; strands-only

        yield ToolResultEvent(self._error_result)


class GovernanceEvaluator:
    """Applies the layer-2 allow/deny decision to a ``BeforeToolCallEvent``.

    ``evaluate(event)`` writes the audit finding (PERMIT or DENY) via the shared
    ``record_governance_decision`` and, on DENY, swaps ``event.selected_tool``
    for a :class:`_GovernanceDeniedTool` and returns ``True``. On PERMIT it
    returns ``False`` and leaves the event untouched. This is deliberately a
    plain object (not a HookProvider) so it can be COMPOSED into the single
    idempotency callback (``ComposedToolHook``) rather than registering a second,
    independently-ordered callback.
    """

    def __init__(
        self,
        *,
        agent_id: str,
        workflow_id: str,
        denied_tools: set[str] | None = None,
        eval_run_id: str | None = None,
        approval_required_tools: set[str] | None = None,
        org_id: str = "",
        workflow_definition_id: str = "",
        execution_id: str = "",
        node_id: str = "",
    ):
        self._agent_id = agent_id or 'unknown-agent'
        self._workflow_id = workflow_id or 'unknown-workflow'
        # ``None`` → read DENIED_TOOLS from env (single env-parsing source of
        # truth). An explicit (possibly empty) set overrides the env fallback.
        self._denied_tools = (
            denied_tools if denied_tools is not None else _parse_denied_tools_env()
        )
        self._eval_run_id = eval_run_id
        # Approval-required tool gating (finding c947aa77). ``None`` → read the
        # OPT-IN APPROVAL_REQUIRED_TOOLS set from env (mirrors DENIED_TOOLS);
        # an explicit (possibly empty) set overrides the env fallback. The
        # scope tuple for a grant is (org, workflow DEFINITION, node, tool).
        self._approval_required_tools = (
            approval_required_tools
            if approval_required_tools is not None
            else _parse_approval_required_tools_env()
        )
        self._org_id = org_id or ""
        self._workflow_definition_id = workflow_definition_id or ""
        self._execution_id = execution_id or ""
        self._node_id = node_id or ""

    @property
    def denied_tools(self) -> set[str]:  # pragma: no cover — trivial accessor
        return self._denied_tools

    @property
    def approval_required_tools(self) -> set[str]:  # pragma: no cover — accessor
        return self._approval_required_tools

    def evaluate(self, event: Any) -> bool:
        """Return True if the call was REFUSED (and ``selected_tool`` swapped) —
        by the deny-list decision OR the approval gate. On PERMIT (not denied
        AND, for a gated tool, a valid approval was consumed) returns False and
        leaves the event untouched so idempotency wrapping proceeds."""
        tool_use = getattr(event, "tool_use", None)
        selected = getattr(event, "selected_tool", None)
        if tool_use is None or selected is None:
            return False
        if hasattr(tool_use, "get"):
            tool_name = tool_use.get("name", "") or ""
            tool_use_id = tool_use.get("toolUseId", "") or ""
        else:
            tool_name = getattr(tool_use, "name", "") or ""
            tool_use_id = getattr(tool_use, "toolUseId", "") or ""

        denied, error_result = record_governance_decision(
            tool_name, tool_use_id,
            agent_id=self._agent_id,
            workflow_id=self._workflow_id,
            denied_tools=self._denied_tools,
            eval_run_id=self._eval_run_id,
        )
        if denied and error_result is not None:
            event.selected_tool = _GovernanceDeniedTool(selected, error_result)
            return True
        # PERMITTED by the deny-list. Now the approval gate — runs INSIDE the
        # governance evaluation, BEFORE any idempotency reserve, so a refusal
        # leaves ZERO ledger reservations (inherits the deny-before-reserve
        # invariant, finding 027c4a89).
        return self._evaluate_approval(event, selected, tool_name, tool_use_id)

    def _evaluate_approval(
        self, event: Any, selected: Any, tool_name: str, tool_use_id: str,
    ) -> bool:
        """Approval-required gate (finding c947aa77). Returns True if REFUSED
        (tool swapped + refusal recorded so the node FAILS), False on PERMIT.

        A tool is gated iff it is in the OPT-IN approval-required set. For a
        gated tool a valid, unconsumed, pre-granted approval for
        (org, workflowDef, node, tool) is atomically consumed against this
        execution; absent/expired/already-consumed ⇒ POLICY refusal (node
        FAILS, decision c0ca4576); an unreadable set/record ⇒ INFRA refusal
        (fail-loud). An always-visible APPROVAL finding is written either way."""
        if tool_name not in self._approval_required_tools:
            return False  # not gated → permit passthrough

        # Lazy import (avoids a governance_tool_hook ↔ tool_idempotency_hook
        # import cycle; the refusal sink lives with the idempotency seam).
        try:
            from tool_idempotency_hook import _record_governance_refusal
        except ImportError:  # pragma: no cover — worker-bundle sibling
            _record_governance_refusal = None  # type: ignore[assignment]

        try:
            from governance import tool_approval
        except ImportError:  # pragma: no cover — layer-staged package
            from arbiter.governance import tool_approval  # type: ignore

        def _refuse(exc: Exception, reason_code: str, infra: bool) -> bool:
            # Write the always-visible APPROVAL finding (fail-closed). If the
            # finding write itself fails, that is an infra refusal a fortiori.
            try:
                record_approval_finding(
                    tool_name, permitted=False, reason_code=reason_code,
                    agent_id=self._agent_id, workflow_id=self._workflow_id,
                    eval_run_id=self._eval_run_id,
                )
            except LedgerWriteError as write_exc:
                if _record_governance_refusal is not None:
                    _record_governance_refusal(write_exc)
            result = (
                _approval_unavailable_result(tool_use_id, tool_name)
                if infra
                else _approval_required_result(tool_use_id, tool_name)
            )
            event.selected_tool = _GovernanceDeniedTool(selected, result)
            if _record_governance_refusal is not None:
                _record_governance_refusal(exc)
            return True

        # Fail-safe: a gated tool with an incomplete scope context cannot be
        # validated against a (org, workflowDef, node, tool) grant ⇒ require
        # approval (refuse), never run unapproved.
        if not (self._org_id and self._workflow_definition_id and self._node_id and self._execution_id):
            return _refuse(
                tool_approval.ApprovalRequiredError(
                    f"approval-required tool {tool_name!r} invoked without a "
                    "complete (org, workflowDef, node, execution) context"
                ),
                "approval_required_context_incomplete", infra=False,
            )

        try:
            grant = tool_approval.read_grant(
                self._org_id, self._workflow_definition_id, self._node_id, tool_name,
            )
        except tool_approval.ApprovalReadError as exc:
            return _refuse(exc, "approval_unreadable", infra=True)

        if not tool_approval.grant_is_valid(
            grant, self._org_id, self._workflow_definition_id, self._node_id, tool_name,
        ):
            return _refuse(
                tool_approval.ApprovalRequiredError(
                    f"no valid approval for tool {tool_name!r} "
                    "(absent, expired, or malformed)"
                ),
                "approval_required_absent", infra=False,
            )

        try:
            won = tool_approval.consume(
                self._org_id, self._workflow_definition_id, self._node_id, tool_name,
                self._execution_id,
            )
        except tool_approval.ApprovalReadError as exc:
            return _refuse(exc, "approval_unreadable", infra=True)

        if not won:
            return _refuse(
                tool_approval.ApprovalRequiredError(
                    f"approval for tool {tool_name!r} already consumed "
                    "(single-use exhausted)"
                ),
                "approval_required_already_consumed", infra=False,
            )

        # PERMIT: valid approval consumed by this execution. Write the visible
        # PERMIT finding (fail-closed — a failed write is an infra refusal).
        try:
            record_approval_finding(
                tool_name, permitted=True, reason_code="approval_consumed",
                agent_id=self._agent_id, workflow_id=self._workflow_id,
                eval_run_id=self._eval_run_id,
            )
        except LedgerWriteError as exc:
            return _refuse(exc, "approval_permit_finding_unwritable", infra=True)
        return False


class GovernanceToolHook:
    """A standalone Strands ``HookProvider`` for layer-2 governance.

    Used on the supervisor-task path (governance active, no idempotency
    envelope). On the workflow-node path governance is instead COMPOSED with
    idempotency into a single callback (``ComposedToolHook``) so ordering is
    guaranteed and the two seams cannot diverge.
    """

    def __init__(
        self,
        *,
        agent_id: str,
        workflow_id: str,
        denied_tools: set[str] | None = None,
        eval_run_id: str | None = None,
    ):
        self._evaluator = GovernanceEvaluator(
            agent_id=agent_id, workflow_id=workflow_id,
            denied_tools=denied_tools, eval_run_id=eval_run_id,
        )

    @property
    def evaluator(self) -> GovernanceEvaluator:  # pragma: no cover — accessor
        return self._evaluator

    def register_hooks(self, registry: Any, **_kwargs: Any) -> None:
        if not _STRANDS_AVAILABLE:  # pragma: no cover — dev/CI guard
            logger.warning("governance hook skipped — strands unavailable")
            return
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)

    def _on_before_tool_call(self, event: Any) -> None:  # pragma: no cover — requires strands runtime
        self._evaluator.evaluate(event)
