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
  confirmed) or the execution/node status is ``awaiting_approval``. A declared
  entry matches by ANY of its identifiers (``name`` or ``toolId``), compared
  with case and ``-``/``_`` folded. An EMPTY declared list means the agent
  declares no external tools and uses only built-in tools defined inline by
  its own module, so nothing can expand beyond it and every tool is in scope.
* ``run_id`` and ``trace_id`` ride along only when known.

Credentials: the agent subprocess runs with every ambient AWS credential
scrubbed (scoped STS credentials, or none for ``credentialMode: none``), so it
cannot read the governance tables or the executions table with the worker's
Lambda role. The parent loads that read-only evidence with its own credentials
before spawning (``prepare_governance_snapshot``) and passes it through a
private file named by ``CITADEL_GOVERNANCE_STATE_FILE``. Without the variable
the gate reads live (same ``boto3.resource('dynamodb')`` construction as the
ledger write) and fails closed if that read is refused.

Findings: the subprocess cannot write the governance ledger either. The parent
creates a private outbox file (``prepare_findings_outbox``) named by
``CITADEL_GOVERNANCE_FINDINGS_OUTBOX``; with it set the gate appends each
finding as one JSON line instead of calling ``write_finding`` and does not
refuse on that basis (the verdict is still enforced in the subprocess). After
the subprocess exits the parent writes every line with its own role
(``drain_findings_outbox``). Without the variable the gate writes directly and
fails closed.

Enforcement mirrors the supervisor: ``strict`` refuses any non-PERMIT
decision, ``shadow``/``permissive`` log the would-block and proceed. A state
or engine failure, or a finding-write failure, refuses in every mode.

Bundle-sibling module (top-level importable, no ``arbiter.`` prefix); the
``governance`` package comes from the ArbiterCatalogLayer.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import os
import pickle
import tempfile
from dataclasses import dataclass
from typing import Any, Callable

from governance.models import (  # noqa: E402
    ArbitrationDecision,
    DispatchRequest,
    GovernanceFinding,
)
from governance.ledger import LedgerWriteError, write_finding  # noqa: E402

logger = logging.getLogger(__name__)

SCOPE_WORKER_TOOL_DISPATCH = 'worker-tool-dispatch'

FINDINGS_OUTBOX_ENV = 'CITADEL_GOVERNANCE_FINDINGS_OUTBOX'

# Upper bounds on what the parent will read back from a file the agent
# subprocess could also write to.
_OUTBOX_MAX_BYTES = 8 * 1024 * 1024
_OUTBOX_MAX_LINES = 10_000

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


def _fold_tool_name(name: str) -> str:
    return name.strip().lower().replace('-', '_')


def _tool_in_declared_scope(tool_name: str, declared: frozenset[str] | None) -> bool:
    """None (unknown) is never in scope; an empty set is built-in tools only."""
    if declared is None:
        return False
    if not declared:
        return True
    folded = _fold_tool_name(tool_name)
    return tool_name in declared or any(_fold_tool_name(d) == folded for d in declared)


def prepare_governance_snapshot(
    *,
    execution_id: str,
    registry_id: str | None = None,
    load_state_fn: Callable[..., Any] | None = None,
    execution_lookup_fn: Callable[[str], dict | None] | None = None,
    directory: str | None = None,
) -> str | None:
    """Parent side: load the gate's read-only evidence with the worker's own
    credentials and write it to a private (0600) file for the subprocess.

    Returns the file path, or None when any read fails (logged). None leaves
    the subprocess to read live, which fails closed if it lacks access.
    """
    try:
        state = (load_state_fn or _default_load_state)(registry_id=registry_id)
        item = (execution_lookup_fn or _default_execution_lookup)(execution_id)
    except Exception:  # noqa: BLE001 — subprocess falls back to a live (fail-closed) read
        logger.error(
            'governance snapshot unavailable for execution=%s; the subprocess '
            'will read live', execution_id, exc_info=True,
        )
        return None
    fd, path = tempfile.mkstemp(
        prefix='citadel-governance-', suffix='.pkl', dir=directory,
    )
    try:
        with os.fdopen(fd, 'wb') as fh:
            pickle.dump({'state': state, 'execution': item}, fh)
    except Exception:  # noqa: BLE001
        logger.error('governance snapshot write failed', exc_info=True)
        remove_governance_snapshot(path)
        return None
    return path


def remove_governance_snapshot(path: str | None) -> None:
    if not path:
        return
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning('could not remove governance snapshot %s', path, exc_info=True)


def prepare_findings_outbox(*, directory: str | None = None) -> str | None:
    """Parent side: create the private (0600) empty file the subprocess
    appends its constitution findings to.

    Returns the path, or None when the file cannot be created (logged). None
    leaves the subprocess to write directly, which fails closed without
    ledger access.
    """
    try:
        fd, path = tempfile.mkstemp(
            prefix='citadel-findings-', suffix='.jsonl', dir=directory,
        )
        os.close(fd)
        return path
    except OSError:
        logger.error('governance findings outbox unavailable', exc_info=True)
        return None


def remove_findings_outbox(path: str | None) -> None:
    if not path:
        return
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        logger.warning('could not remove findings outbox %s', path, exc_info=True)


@dataclass
class OutboxDrainResult:
    """Outcome of writing an outbox to the ledger from the parent.

    ``permit_failures`` lists the finding ids (``'<unreadable>'`` for a line
    that could not be parsed) of PERMIT findings that were not recorded: the
    tool ran, so that execution is unaudited.
    """

    written: int = 0
    failed: int = 0
    permit_failures: list[str] = dataclasses.field(default_factory=list)


def _finding_from_record(record: dict) -> GovernanceFinding:
    names = {f.name for f in dataclasses.fields(GovernanceFinding)}
    kwargs = {k: v for k, v in record.items() if k in names}
    kwargs['finding_id'] = record['findingId']
    kwargs['workflow_id'] = record['workflowId']
    kwargs['decision'] = ArbitrationDecision(record['decision'])
    return GovernanceFinding(**kwargs)


def drain_findings_outbox(
    path: str | None,
    *,
    expected_workflow_id: str | None = None,
    write_finding_fn: Callable[[Any], None] | None = None,
) -> OutboxDrainResult:
    """Parent side: write every finding in the outbox to the ledger with the
    worker's own credentials. Never raises; failures are counted and logged.

    A line that is not a valid finding, or whose ``workflowId`` differs from
    ``expected_workflow_id`` (the file is writable by the agent subprocess),
    is rejected and counted as failed.
    """
    result = OutboxDrainResult()
    if not path:
        return result
    try:
        size = os.path.getsize(path)
        if size > _OUTBOX_MAX_BYTES:
            logger.error('findings outbox %s too large (%d bytes); not drained', path, size)
            result.failed += 1
            result.permit_failures.append('<unreadable>')
            return result
        with open(path, 'r', encoding='utf-8') as fh:
            lines = fh.read().splitlines()
    except FileNotFoundError:
        return result
    except (OSError, UnicodeDecodeError):
        logger.error('findings outbox %s unreadable', path, exc_info=True)
        result.failed += 1
        result.permit_failures.append('<unreadable>')
        return result

    writer = write_finding_fn or write_finding
    for line in lines[:_OUTBOX_MAX_LINES]:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
            if (
                expected_workflow_id is not None
                and record.get('workflowId') != expected_workflow_id
            ):
                raise ValueError('finding belongs to another workflow')
            finding = _finding_from_record(record)
        except Exception:  # noqa: BLE001 — one bad line must not hide the rest
            logger.error('malformed finding in outbox %s; skipped', path, exc_info=True)
            result.failed += 1
            result.permit_failures.append('<unreadable>')
            continue
        try:
            writer(finding)
            result.written += 1
        except Exception as exc:  # noqa: BLE001 — keep draining the rest
            result.failed += 1
            logger.error(
                'parent ledger write FAILED finding_id=%s decision=%s: %s',
                finding.finding_id, finding.decision, exc,
            )
            if finding.decision == ArbitrationDecision.PERMIT:
                result.permit_failures.append(finding.finding_id)
    if len(lines) > _OUTBOX_MAX_LINES:
        logger.error('findings outbox %s truncated at %d lines', path, _OUTBOX_MAX_LINES)
        result.failed += len(lines) - _OUTBOX_MAX_LINES
        result.permit_failures.append('<unreadable>')
    logger.info(
        'findings outbox drained written=%d failed=%d', result.written, result.failed,
    )
    return result


def _append_to_outbox(path: str, finding: GovernanceFinding) -> None:
    """Append one finding (the item ``write_finding`` would store) as a JSON line."""
    from governance.ledger import _serialize_finding
    data = (json.dumps(_serialize_finding(finding), default=str) + '\n').encode('utf-8')
    fd = os.open(path, os.O_WRONLY | os.O_APPEND)
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
    finally:
        os.close(fd)


def deliver_finding(
    finding: GovernanceFinding,
    *,
    write_fn: Callable[[Any], None] | None = None,
) -> None:
    """Child side: hand one governance finding to the ledger.

    With ``CITADEL_GOVERNANCE_FINDINGS_OUTBOX`` set (the worker subprocess)
    the finding is appended as one JSON line for the parent to write with its
    own role, because the subprocess may hold no AWS credentials. Without it
    the finding is written directly (tests, supervisor paths); ``write_fn``
    overrides the default ``write_finding`` for callers that expose their own
    patchable writer.

    Raises ``LedgerWriteError`` when the finding could not be delivered:
    a failed append, or a failed direct write.
    """
    path = os.environ.get(FINDINGS_OUTBOX_ENV) or None
    if not path:
        (write_fn or write_finding)(finding)
        return
    try:
        _append_to_outbox(path, finding)
    except Exception as exc:  # noqa: BLE001 — queueing failed
        raise LedgerWriteError(f'findings outbox write failed: {exc}') from exc


def _load_snapshot(path: str) -> dict:
    with open(path, 'rb') as fh:
        data = pickle.load(fh)
    if not isinstance(data, dict) or 'state' not in data:
        raise ValueError('malformed governance snapshot')
    return data


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
        findings_outbox: str | None = None,
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
        # An empty list is "built-in tools only" (see module docstring).
        self._declared_tools = (
            None if declared_tools is None else frozenset(declared_tools)
        )
        self._domain = domain or '*'
        self._registry_id = registry_id
        self._load_state_fn = load_state_fn or _default_load_state
        self._write_finding_fn = write_finding_fn or write_finding
        # Set in the agent subprocess (no ledger access): findings are queued
        # for the parent to write instead of written here.
        self._findings_outbox = (
            findings_outbox or os.environ.get(FINDINGS_OUTBOX_ENV) or None
        )
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
        in_scope = _tool_in_declared_scope(tool_name, self._declared_tools)
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

        # Fail closed: an unauditable dispatch is refused in every mode. With an
        # outbox the parent writes the ledger row, so only a failure to queue
        # the finding makes the dispatch unauditable.
        try:
            if self._findings_outbox:
                try:
                    _append_to_outbox(self._findings_outbox, finding)
                except Exception as exc:  # noqa: BLE001 — queueing failed
                    raise LedgerWriteError(
                        f'findings outbox write failed: {exc}'
                    ) from exc
            else:
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
    load_state_fn = None
    execution_lookup_fn = None
    snapshot_path = os.environ.get('CITADEL_GOVERNANCE_STATE_FILE')
    if snapshot_path:
        def load_state_fn(registry_id=None, _p=snapshot_path):  # noqa: F811
            return _load_snapshot(_p)['state']

        def execution_lookup_fn(_eid, _p=snapshot_path):  # noqa: F811
            return _load_snapshot(_p).get('execution')
    return ConstitutionGate(
        load_state_fn=load_state_fn,
        execution_lookup_fn=execution_lookup_fn,
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
