"""Constitution gate: evaluates each worker tool dispatch against the
governance constitution.

The agent subprocess already runs the deny-list and approval gates in
``governance_tool_hook``. This module adds the third check: the real
``GovernanceEngine`` (the same engine and state loader the supervisor uses)
decides whether the dispatch is permitted, using evidence taken from
server-side facts only:

* ``audit.record_produced`` is True only when the execution record for
  ``CITADEL_EXECUTION_ID`` exists (one consistent ``GetItem`` on
  ``EXECUTIONS_TABLE``, cached per process).
* ``scope.expansion_under_unconfirmed_state`` is True when the tool is not in
  the agent's declared tools (``CITADEL_DECLARED_TOOLS``, absent means not
  confirmed) or the execution/node status is ``awaiting_approval``.
* ``run_id`` and ``trace_id`` ride along only when known.

Enforcement mirrors the supervisor: ``strict`` refuses any non-PERMIT
decision, ``shadow``/``permissive`` log the would-block and proceed. A state
or engine failure, or a finding-write failure, refuses in every mode.

Bundle-sibling module (top-level importable, no ``arbiter.`` prefix); the
``governance`` package comes from the ArbiterCatalogLayer.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Callable

from governance.models import ArbitrationDecision, DispatchRequest  # noqa: E402
from governance.ledger import LedgerWriteError, write_finding  # noqa: E402

logger = logging.getLogger(__name__)

SCOPE_WORKER_TOOL_DISPATCH = 'worker-tool-dispatch'

# Execution/node statuses meaning the run is parked waiting for a human.
_UNCONFIRMED_STATUSES = frozenset({'awaiting_approval'})


@dataclass(frozen=True)
class ConstitutionVerdict:
    """Outcome of one constitution evaluation.

    ``refuse`` is what the hook enforces. ``would_block`` is True when the
    engine did not PERMIT but the mode let the call proceed.
    """

    refuse: bool
    decision: ArbitrationDecision
    reason: str
    finding_id: str | None = None
    would_block: bool = False
    audit_write_failed: bool = False


def constitution_denied_result(
    tool_use_id: str, tool_name: str, reason: str, finding_id: str | None,
) -> dict:
    """ToolResult-shaped error returned when the constitution refuses a call."""
    ref = f' (finding {finding_id})' if finding_id else ''
    return {
        'toolUseId': tool_use_id,
        'status': 'error',
        'content': [
            {'text': (
                f"Tool '{tool_name}' was refused by the governance "
                f"constitution: {reason}{ref}."
            )}
        ],
    }


def _default_load_state(registry_id: str | None = None):
    from governance.hierarchy import load_governance_state
    return load_governance_state(registry_id=registry_id)


def _default_trace_id() -> str | None:
    try:
        import common.tracing as tracing
        ctx = tracing.active_trace_context()
        if ctx and ctx.get('traceId'):
            return ctx['traceId']
    except Exception:  # noqa: BLE001 — trace id is best-effort evidence
        logger.debug('trace-id lookup for tool dispatch failed', exc_info=True)
    return None


def _default_execution_lookup(execution_id: str) -> dict | None:
    """One consistent GetItem on the executions table the worker already uses.

    Returns the item, or None when the table is unset or the row is absent.
    Raises on a read failure so the caller treats the evidence as missing
    without caching the failure.
    """
    table_name = os.environ.get('EXECUTIONS_TABLE')
    if not table_name or not execution_id:
        return None
    import boto3
    resp = boto3.resource('dynamodb').Table(table_name).get_item(
        Key={'executionId': execution_id}, ConsistentRead=True,
    )
    return resp.get('Item')


def _record_write_refusal(exc: Exception) -> None:
    from governed_tool_handler import _record_audit_write_refusal
    _record_audit_write_refusal(exc)


class ConstitutionGate:
    """Evaluate one tool dispatch against the constitution per call."""

    def __init__(
        self,
        *,
        agent_id: str,
        workflow_id: str,
        execution_id: str,
        node_id: str = '',
        org_id: str = '',
        run_id: str = '',
        eval_run_id: str | None = None,
        declared_tools: Any = None,
        domain: str = '*',
        registry_id: str | None = None,
        load_state_fn: Callable[..., Any] | None = None,
        write_finding_fn: Callable[[Any], None] | None = None,
        execution_lookup_fn: Callable[[str], dict | None] | None = None,
        trace_id_fn: Callable[[], str | None] | None = None,
    ):
        self._agent_id = agent_id or 'unknown-agent'
        self._workflow_id = workflow_id or execution_id or 'unknown-workflow'
        self._execution_id = execution_id or ''
        self._node_id = node_id or ''
        self._org_id = org_id or ''
        self._run_id = run_id or ''
        self._eval_run_id = eval_run_id or None
        # ``None`` means the declared tool list is unknown: nothing can be
        # shown to be in scope, so every tool counts as an expansion.
        self._declared_tools = (
            None if declared_tools is None else frozenset(declared_tools)
        )
        self._domain = domain or '*'
        self._registry_id = registry_id
        self._load_state_fn = load_state_fn or _default_load_state
        self._write_finding_fn = write_finding_fn or write_finding
        self._execution_lookup_fn = execution_lookup_fn or _default_execution_lookup
        self._trace_id_fn = trace_id_fn or _default_trace_id
        # Per-process cache of the execution record (success only).
        self._execution_item: dict | None = None
        self._execution_cached = False

    # -- evidence ---------------------------------------------------------

    def _execution_record(self) -> dict | None:
        if self._execution_cached:
            return self._execution_item
        try:
            item = self._execution_lookup_fn(self._execution_id)
        except Exception:  # noqa: BLE001 — unreadable record is missing evidence
            logger.error(
                'execution record lookup failed for execution=%s; audit '
                'evidence withheld', self._execution_id, exc_info=True,
            )
            return None
        self._execution_item = item if isinstance(item, dict) else None
        self._execution_cached = True
        return self._execution_item

    def _unconfirmed_state(self, item: dict | None) -> bool:
        if item is None:
            return False
        try:
            if item.get('status') in _UNCONFIRMED_STATUSES:
                return True
            node = (item.get('nodeResults') or {}).get(self._node_id) or {}
            return node.get('status') in _UNCONFIRMED_STATUSES
        except Exception:  # noqa: BLE001 — unreadable status is not confirmed
            logger.debug('status lookup for tool dispatch failed', exc_info=True)
            return True

    def build_context(self, tool_name: str) -> dict:
        item = self._execution_record()
        produced = item is not None
        context: dict[str, Any] = {'audit.record_produced': produced}
        in_scope = (
            self._declared_tools is not None and tool_name in self._declared_tools
        )
        context['scope.expansion_under_unconfirmed_state'] = bool(
            (not in_scope) or self._unconfirmed_state(item)
        )
        if produced:
            context['audit_record_type'] = 'execution'
            context['audit_record_id'] = self._execution_id
        if self._run_id:
            context['run_id'] = self._run_id
        trace_id = self._trace_id_fn()
        if trace_id:
            context['trace_id'] = trace_id
        return context

    # -- decision ---------------------------------------------------------

    def _failure(self, reason: str, *, write_failed: bool = False) -> ConstitutionVerdict:
        return ConstitutionVerdict(
            refuse=True, decision=ArbitrationDecision.DENY, reason=reason,
            audit_write_failed=write_failed,
        )

    def evaluate(
        self, tool_name: str, tool_use_id: str, tool_input: Any,
    ) -> ConstitutionVerdict:
        try:
            from governance.engine import GovernanceEngine
            state = self._load_state_fn(registry_id=self._registry_id)
            enforcement_mode = getattr(state, 'enforcement_mode', 'shadow')
            engine = GovernanceEngine(
                authority_units=state.authority_units,
                composition_contracts=state.composition_contracts,
                case_law=state.case_law,
                constitutional_layers=state.constitutional_layers,
            )
        except Exception as exc:  # noqa: BLE001 — fail closed
            logger.error(
                'constitution state/engine load failed for tool=%s; refusing '
                '(fail-closed): %s', tool_name, exc, exc_info=True,
            )
            return self._failure('constitution_state_unavailable')

        request = DispatchRequest(
            requesting_agent_id=self._agent_id,
            target_agent_id=f'tool:{tool_name}',
            action_type='invoke_tool',
            domain=self._domain,
            workflow_id=self._workflow_id,
            agent_use_id=tool_use_id,
            context=self.build_context(tool_name),
            agent_input=tool_input if isinstance(tool_input, dict) else {'raw': tool_input},
        )
        try:
            finding = engine.evaluate(request)
        except Exception as exc:  # noqa: BLE001 — fail closed
            logger.error(
                'constitution engine failed for tool=%s; refusing '
                '(fail-closed): %s', tool_name, exc, exc_info=True,
            )
            return self._failure('constitution_engine_error')

        if not finding.scope_evaluated:
            finding.scope_evaluated = SCOPE_WORKER_TOOL_DISPATCH
        try:
            trace_id = request.context.get('trace_id')
            if trace_id:
                finding.trace_id = trace_id
            if self._run_id:
                finding.run_id = self._run_id
            if self._eval_run_id:
                finding.eval_run_id = self._eval_run_id
            if self._org_id:
                finding.org_id = self._org_id
        except Exception:  # noqa: BLE001 — stamps never alter the decision
            logger.debug('finding stamp failed; written unstamped', exc_info=True)

        # Fail closed: an unauditable dispatch is refused in every mode.
        try:
            self._write_finding_fn(finding)
        except LedgerWriteError as exc:
            logger.error(
                'constitution finding write FAILED (fail-closed) '
                'finding_id=%s tool=%s: %s', finding.finding_id, tool_name, exc,
            )
            try:
                _record_write_refusal(exc)
            except Exception:  # noqa: BLE001 — sink problems must not unblock
                logger.error('failed to record write refusal', exc_info=True)
            return ConstitutionVerdict(
                refuse=True, decision=finding.decision,
                reason='constitution_finding_write_failed',
                finding_id=finding.finding_id, audit_write_failed=True,
            )

        permitted = finding.decision == ArbitrationDecision.PERMIT
        bypass = os.environ.get('ARBITER_GOVERNANCE_BYPASS', 'false').lower() == 'true'
        if permitted:
            return ConstitutionVerdict(
                refuse=False, decision=finding.decision, reason=finding.reason,
                finding_id=finding.finding_id,
            )
        if bypass or enforcement_mode in ('permissive', 'shadow'):
            logger.warning(
                'constitution would block tool=%s decision=%s mode=%s '
                'finding_id=%s reason=%s; proceeding',
                tool_name, finding.decision, enforcement_mode,
                finding.finding_id, finding.reason,
            )
            return ConstitutionVerdict(
                refuse=False, decision=finding.decision, reason=finding.reason,
                finding_id=finding.finding_id, would_block=True,
            )
        return ConstitutionVerdict(
            refuse=True, decision=finding.decision, reason=finding.reason,
            finding_id=finding.finding_id,
        )


def _declared_tools_from_env() -> frozenset[str] | None:
    raw = os.environ.get('CITADEL_DECLARED_TOOLS')
    if raw is None:
        return None
    return frozenset(t.strip() for t in raw.split(',') if t.strip())


def build_constitution_gate_from_env(agent_id: str) -> ConstitutionGate | None:
    """Build the gate from the ``CITADEL_*`` subprocess env.

    Returns None when there is no execution context (the supervisor task
    path): there is no execution record to evidence the dispatch against.
    """
    execution_id = os.environ.get('CITADEL_EXECUTION_ID', '')
    if not execution_id:
        return None
    return ConstitutionGate(
        agent_id=agent_id,
        workflow_id=os.environ.get('CITADEL_WORKFLOW_ID', execution_id),
        execution_id=execution_id,
        node_id=os.environ.get('CITADEL_NODE_ID', ''),
        org_id=os.environ.get('CITADEL_ORG_ID', ''),
        run_id=os.environ.get('CITADEL_RUN_ID', ''),
        eval_run_id=os.environ.get('CITADEL_EVAL_RUN_ID') or None,
        declared_tools=_declared_tools_from_env(),
        domain=os.environ.get('CITADEL_AGENT_DOMAIN') or '*',
        registry_id=os.environ.get('CITADEL_APP_ID') or None,
    )
