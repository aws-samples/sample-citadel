"""CIT-123 slice 4 — WORKER-SIDE governed compensation execution.

Consumes the compensation-dispatch CONTRACT slice 3 sends
(``workflow_contract.build_compensation_dispatch_message`` /
``is_workflow_compensation_message``) — message_type='workflow_compensation'
carrying ``node_id`` (the compensation PSEUDO-node id, ``{origNodeId}#comp``),
``tool``, the RAW unresolved ``args`` template, ``compensation_generation``,
and (out of band, passed by the caller as ``recorded_output``) the
compensating node's recorded output reference. Slice 3's executor file(s) and
the stepRunner orchestration are NOT imported or depended upon here — only the
wire-contract shape is consumed, matching the field names
``build_compensation_dispatch_message`` emits (cited from
``arbiter/common/workflow_contract.py`` on origin/main, commit c101ff0 not yet
merged, so this module reads the dispatch dict directly rather than importing
any slice-3-only helper).

D2 — NO BYPASS BY CONSTRUCTION
-------------------------------
A compensation executes through the EXACT SAME ``ComposedToolHook`` seam an
agent tool call uses: deny-list -> breaker pre-check -> approval-consume ->
idempotency reserve/execute/finalize -> breaker observer
(``tool_idempotency_hook.ComposedToolHook``, the identical class
``agent_runner._install_tool_call_hooks`` installs for the LLM path). This
module builds no second installer and no parallel governance/idempotency
logic — ``build_compensation_hook`` constructs a REAL ``ComposedToolHook``
(the very same class object) and ``execute_compensation`` drives it with a
synthetic ``BeforeToolCallEvent``-shaped object (``tool_use`` dict +
``selected_tool``), then awaits the (possibly hook-wrapped) tool's
``stream()`` — LLM-free, no agent turn, no model call. This is exactly the
technique ``test_composed_tool_governance.py`` / ``test_composed_tool_breaker_
seam.py`` use to drive the hook in-process without a real strands runtime.

On a governance DENY the compensation MUST escalate and MUST NOT execute —
never bypass. On any other terminal failure (stale generation, breaker OPEN,
unresolvable template, missing/offloaded-unrehydrated output, tool crash) the
result is ``compensation_failed`` and — for a DENY specifically — an
escalation is emitted (D6, reusing ``tools/escalate.py``'s event+metric
shape). This module does NOT write the executor's ``#comp`` node-status rows
or the interim sink's three durable writes (D6/D7) — that is slice 3/5's
job; it emits a compensation-RESULT the caller (slice 3's
``handle_compensation_result``, when merged) can consume, via
``CompensationResult``.
"""
from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from governance import tool_execution_ledger as ledger  # noqa: E402
from tool_idempotency import build_key  # noqa: E402
from tool_idempotency_hook import ComposedToolHook, IdempotencyToolHook  # noqa: E402
from governance_tool_hook import GovernanceEvaluator  # noqa: E402

#: Wire-contract suffix slice 3's dispatch uses to mint the compensation
#: PSEUDO-node id (``"{origNodeId}#comp"``) carried in the dispatch's
#: ``node_id`` field — kept ONLY for stripping it back off below, never used
#: to derive a ledger key by concatenation again. The actual collision
#: protection is the ``is_compensation`` STRUCTURAL flag threaded into
#: ``build_key`` / ``IdempotencyToolHook`` (see ``tool_idempotency.
#: build_sort_key``'s docstring) — this constant exists so a dispatch's
#: reporting/escalation messages can keep echoing the wire pseudo-id
#: unchanged while the ORIGINAL node id (with the suffix stripped) is what
#: actually reaches key derivation. Stripping is a display/compat nicety on
#: top of the structural fix, not itself the fix: even if this strip were
#: wrong or absent, ``is_compensation=True`` alone already guarantees no
#: collision with any original call's key, because no valid (post-
#: validation) node id can contain the reserved '#' delimiter this suffix
#: is built from.
_COMPENSATION_PSEUDO_ID_SUFFIX = "#comp"


def _origin_node_id(pseudo_node_id: str) -> str:
    """Strip the wire-contract ``'#comp'`` suffix, if present, to recover the
    original node id for key derivation. A pseudo id missing the suffix
    (already-bare, or a caller that changes the wire convention later) is
    returned unchanged — safe either way, since ``is_compensation=True`` is
    what actually prevents the key collision, not this string surgery.
    """
    if pseudo_node_id.endswith(_COMPENSATION_PSEUDO_ID_SUFFIX):
        return pseudo_node_id[: -len(_COMPENSATION_PSEUDO_ID_SUFFIX)]
    return pseudo_node_id

try:
    from common.compensation_template import (
        render_compensation_args,
        CompensationTemplateError,
    )
except ImportError:  # pragma: no cover — deferred-bundling fallback (mirrors
    # index.py's existing convention for shared arbiter/common modules): a
    # missing import must never let a compensation render unprotected. Fail
    # closed rather than silently skip templating.
    class CompensationTemplateError(Exception):  # type: ignore[no-redef]
        pass

    def render_compensation_args(template_args, recorded_output):  # type: ignore[no-redef]
        raise CompensationTemplateError(
            "compensation template renderer unavailable "
            "(common.compensation_template import failed) — fail-closed"
        )

try:
    from strands.hooks import BeforeToolCallEvent  # type: ignore  # noqa: F401
    _STRANDS_AVAILABLE = True
except ImportError:  # pragma: no cover — dev/CI without strands-agents
    _STRANDS_AVAILABLE = False


# --- Compensation-result contract (slice 4 -> slice 3's handle_compensation_
#     result, once merged) --------------------------------------------------

STATUS_COMPENSATED = "compensated"
STATUS_COMPENSATION_FAILED = "compensation_failed"


@dataclass
class CompensationResult:
    """Emitted back on the same contract the orchestrator expects: keyed by
    the compensation pseudo-node id, carrying enough to let slice 3 advance
    (or stop) the unwind without re-deriving anything this module already
    computed."""

    execution_id: str
    node_id: str  # the '{origNodeId}#comp' pseudo-node id
    workflow_id: str
    tool: str
    status: str  # STATUS_COMPENSATED | STATUS_COMPENSATION_FAILED
    escalated: bool = False
    replayed: bool = False
    error_class: Optional[str] = None
    error: Optional[str] = None
    result: Any = None


# --- Fake BeforeToolCallEvent (LLM-free direct governed invocation) --------


class _DirectToolCallEvent:
    """A minimal ``BeforeToolCallEvent``-shaped object: a ``tool_use`` dict
    (``name``/``toolUseId``/``input``) and a mutable ``selected_tool``. This
    is the EXACT surface ``ComposedToolHook._on_before_tool_call`` reads
    (``event.tool_use`` / ``event.selected_tool``) — no strands runtime, no
    agent turn, no model call is required to drive it, mirroring the fakes
    the composed-hook test suite already uses to exercise the seam
    in-process."""

    def __init__(self, *, tool_name: str, tool_use_id: str, tool_input: dict, selected_tool: Any):
        self.tool_use = {"name": tool_name, "toolUseId": tool_use_id, "input": tool_input}
        self.selected_tool = selected_tool


class _RegisteredAgentTool:
    """Adapts a resolved compensation tool CALLABLE to the minimal AgentTool
    surface (``tool_name``/``tool_spec``/``tool_type``/``stream``) the
    ComposedToolHook and its wrappers delegate through. ``tool_resolver``
    callers are expected to hand back an object already shaped this way
    (e.g. a real ``@tool``-decorated strands function, or a test double); this
    class exists only as a thin structural adapter when a resolver returns a
    plain callable instead of a full AgentTool object."""

    def __init__(self, name: str, fn: Callable[..., Any]):
        self._name = name
        self._fn = fn

    @property
    def tool_name(self) -> str:
        return self._name

    @property
    def tool_spec(self) -> Any:
        return {"name": self._name}

    @property
    def tool_type(self) -> str:
        return "python"

    def get_display_properties(self) -> dict[str, str]:
        return {}

    async def stream(self, tool_use: Any, invocation_state: dict[str, Any], **kwargs: Any):
        from strands.types._events import ToolResultEvent

        tool_use_id = str(tool_use.get("toolUseId", "")) if hasattr(tool_use, "get") else ""
        tool_input = tool_use.get("input", {}) if hasattr(tool_use, "get") else {}
        try:
            output = self._fn(**tool_input) if isinstance(tool_input, dict) else self._fn(tool_input)
        except Exception as exc:  # noqa: BLE001 — let the real crash discriminator see it
            raise exc
        if isinstance(output, dict) and "status" in output:
            result = {**output, "toolUseId": tool_use_id}
        else:
            result = {"toolUseId": tool_use_id, "status": "success", "content": [{"text": str(output)}]}
        yield ToolResultEvent(result)


def _adapt_tool(tool_name: str, resolved: Any) -> Any:
    """Return an AgentTool-shaped object for ``resolved``: pass through
    objects that already look like one (have ``tool_name``/``stream``), else
    wrap a plain callable via ``_RegisteredAgentTool``."""
    if hasattr(resolved, "tool_name") and hasattr(resolved, "stream"):
        return resolved
    return _RegisteredAgentTool(tool_name, resolved)


# --- Seam construction: delegates to the SAME ComposedToolHook the agent path
#     installs (agent_runner._install_tool_call_hooks) — never reimplemented.


def build_compensation_hook(
    *,
    org_id: str,
    execution_id: str,
    node_id: str,
    agent_id: str,
    workflow_id: str,
    compensation_generation: Optional[int],
    denied_tools: Optional[set[str]] = None,
    approval_required_tools: Optional[set[str]] = None,
    workflow_definition_id: str = "",
    breaker: Any = None,
) -> ComposedToolHook:
    """Build the ONE ``ComposedToolHook`` a compensation call is driven
    through — the identical class ``agent_runner._install_tool_call_hooks``
    constructs for the agent (LLM) path. This is the ONLY place slice 4
    assembles governance + idempotency; there is no bespoke deny/approval/
    reserve ordering anywhere else in this module (see the module docstring's
    D2 section) — a structural test asserts this file never defines its own
    ``_on_before_tool_call``.

    ``node_id`` here MUST be the ORIGINAL node id (the caller strips any
    wire-contract ``'#comp'`` pseudo-id suffix via ``_origin_node_id`` before
    calling this function) — never a string with a compensation marker
    concatenated onto it. The ``IdempotencyToolHook`` below is always built
    with ``is_compensation=True`` (this function is exclusively the
    compensation-path hook builder), which is what actually makes the
    resulting ledger key distinct from the SAME node's original-call key —
    structurally, not by relying on ``node_id`` carrying a distinguishing
    suffix.
    """
    governance = GovernanceEvaluator(
        agent_id=agent_id or "unknown-agent",
        workflow_id=workflow_id or "unknown-workflow",
        denied_tools=denied_tools if denied_tools is not None else set(),
        eval_run_id=None,
        approval_required_tools=approval_required_tools if approval_required_tools is not None else set(),
        org_id=org_id or "",
        workflow_definition_id=workflow_definition_id or "",
        execution_id=execution_id or "",
        node_id=node_id or "",
    )
    idempotency = IdempotencyToolHook(
        org_id=org_id or "",
        execution_id=execution_id or "",
        node_id=node_id or "",
        dispatch_generation=compensation_generation,
        is_compensation=True,
    )
    return ComposedToolHook(governance=governance, idempotency=idempotency, breaker=breaker)


def _build_breaker(
    *,
    org_id: str,
    execution_id: str,
    node_id: str,
    workflow_id: str,
    agent_id: str,
    breaker_table: Optional[str],
    breaker_target_resolver: Optional[Callable[[str], Any]],
    breaker_clock: Optional[Callable[[], float]] = None,
):
    """FAIL-OPEN by construction (mirrors ``agent_runner._build_tool_breaker``
    exactly — the breaker is an availability optimisation, never a security
    control): a missing table, resolver, or import degrades to ``None``
    (breaker skipped), never aborts the compensation."""
    if not breaker_table or breaker_target_resolver is None:
        return None
    try:
        from tool_breaker_hook import ToolBreaker
        from governance.tool_breaker_store import ToolBreakerStore, BreakerConfig
    except ImportError:
        return None
    kwargs: dict[str, Any] = dict(
        table_name=breaker_table, org_id=org_id or "", config=BreakerConfig.from_env(),
    )
    if breaker_clock is not None:
        kwargs["clock"] = breaker_clock
    store = ToolBreakerStore(**kwargs)
    return ToolBreaker(
        store=store,
        target_resolver=breaker_target_resolver,
        probe_owner=f"{execution_id or ''}#{node_id or ''}",
    )


# --- Rehydration (slice-2 renderer refuses offloaded refs by contract) -----


def _rehydrate_recorded_output(recorded_output: Any) -> Any:
    """Rehydrate an S3-offloaded recorded output BEFORE rendering (D4(a)).

    The slice-2 renderer (``common.compensation_template``) refuses, by
    contract, any ``recorded_output`` carrying a truthy ``resultOffloaded``
    key or a ``resultRef`` key at all — it never fetches. This function is
    the caller-side rehydration step the renderer's docstring explicitly
    defers to a later slice: it recognises the SAME ledger-row vocabulary
    (``resultOffloaded``/``resultRef``) and, when present, fetches the full
    body via the ledger's own ``_fetch_result_ref`` (org-prefix re-checked —
    never re-implemented here) using the compensation's ledger PK, then
    returns the rehydrated plain dict so the renderer sees ordinary,
    non-offloaded output. A non-offloaded ``recorded_output`` passes through
    unchanged (including ``None`` / non-dict / ``resultTruncated`` shapes —
    those are the renderer's own fail-closed checks, left untouched here).
    """
    if not isinstance(recorded_output, dict):
        return recorded_output
    result_ref = recorded_output.get("resultRef")
    if not recorded_output.get("resultOffloaded") and result_ref is None:
        return recorded_output
    if result_ref is None:
        # resultOffloaded=True but no resultRef: nothing to fetch — let the
        # renderer's own fail-closed check raise a named error downstream.
        return recorded_output
    pk = recorded_output.get("_ledgerPk")
    if not isinstance(pk, str) or not pk:
        # No ledger PK context to re-check the org prefix against — fail
        # closed rather than trust an unscoped ref (mirrors
        # ledger._recorded_result's own "no pk -> fail closed" rule).
        raise CompensationTemplateError(
            "compensation rehydration: an offloaded recorded output was "
            "supplied without a ledger PK for the org-prefix re-check "
            "(fail-closed)"
        )
    fetched = ledger._fetch_result_ref(pk, result_ref)
    return fetched if isinstance(fetched, dict) else {"value": fetched}


# --- Escalation (D6: reuse tools/escalate.py's event+metric shape) ---------


def _escalate(*, execution_id: str, node_id: str, tool: str, reason: str, agent_id: str = "") -> None:
    """Emit exactly one escalation for a compensation DENY, reusing the
    existing ``escalate`` tool's event+metric vocabulary (D6) rather than
    inventing a second escalation channel. Best-effort: an escalation-path
    failure must never mask the underlying DENY result (the caller has
    already decided ``compensation_failed`` regardless)."""
    try:
        from tools.escalate import escalate as escalate_tool
    except ImportError:
        try:
            from escalate import escalate as escalate_tool  # sibling-module layout
        except ImportError:
            return
    try:
        escalate_tool(
            reason=reason,
            project_id=execution_id,
            agent_id=agent_id or "compensation-worker",
            correlation_id=f"{execution_id}#{node_id}",
        )
    except Exception:  # noqa: BLE001 — escalation is best-effort, never masks the DENY
        pass


# --- Drive the composed hook synchronously (LLM-free) ----------------------


def _drain(agen) -> list:
    async def _run():
        return [ev async for ev in agen]

    return asyncio.run(_run())


def _run_direct_governed_call(
    *,
    hook: ComposedToolHook,
    tool_name: str,
    tool_input: dict,
    resolved_tool: Any,
    node_id: str,
) -> tuple[str, Any, Optional[str], Optional[str]]:
    """Drive ``hook`` over a synthetic event for ONE direct tool call — no
    agent turn, no model call. Returns
    ``(status, tool_result_or_None, error_class_or_None, error_or_None)``.

    ``status`` is one of: 'denied', 'stale_generation', 'breaker_open',
    'executed'. The caller maps this (plus the drained ToolResult) onto the
    final compensation-result status.

    NOTE on stale-generation detection: ``_IdempotentToolWrapper.stream()``
    deliberately does NOT raise ``StaleWorkerFencedError`` to its caller —
    per its own docstring, a fenced-away worker's refusal is surfaced as an
    error ToolResult ("... worker fenced by a newer dispatch generation
    (no side effect performed)") so a real strands turn can continue rather
    than crash. Since this module drives the SAME wrapper object with no
    strands runtime in between, it must discriminate on that SAME stable,
    documented marker text rather than inventing a second signalling path —
    the ledger module is the single source of truth for the wording; this
    check exists only at the boundary where the ToolResult must be turned
    back into the compensation-result contract's error_class.
    """
    inner = _adapt_tool(tool_name, resolved_tool)
    event = _DirectToolCallEvent(
        tool_name=tool_name, tool_use_id=f"comp-{node_id}", tool_input=tool_input,
        selected_tool=inner,
    )

    try:
        hook._on_before_tool_call(event)
    except ledger.StaleWorkerFencedError as exc:
        return "stale_generation", None, type(exc).__name__, str(exc)

    from governance_tool_hook import _GovernanceDeniedTool
    if isinstance(event.selected_tool, _GovernanceDeniedTool):
        return "denied", None, None, None

    try:
        from tool_breaker_hook import _CircuitOpenTool
        if isinstance(event.selected_tool, _CircuitOpenTool):
            events = _drain(event.selected_tool.stream(event.tool_use, {}))
            result = events[0].tool_result if events else None
            return "breaker_open", result, "CircuitOpenError", None
    except ImportError:
        pass

    try:
        events = _drain(event.selected_tool.stream(event.tool_use, {}))
    except ledger.StaleWorkerFencedError as exc:  # pragma: no cover — defensive
        return "stale_generation", None, type(exc).__name__, str(exc)
    except Exception as exc:  # noqa: BLE001 — tool crash, structural (not message-matched)
        return "executed", None, type(exc).__name__, str(exc)

    result = events[0].tool_result if events else None
    if _is_fenced_refusal_result(result):
        return "stale_generation", result, "StaleWorkerFencedError", _result_text(result)

    return "executed", result, None, None


def _result_text(result: Any) -> str:
    if not isinstance(result, dict):
        return ""
    content = result.get("content") or []
    if content and isinstance(content[0], dict):
        return content[0].get("text", "") or ""
    return ""


def _is_fenced_refusal_result(result: Any) -> bool:
    """True when ``result`` is the STABLE, documented error ToolResult
    ``_IdempotentToolWrapper.stream()`` yields for a stale-generation refusal
    (see that method's ``ledger.StaleWorkerFencedError`` handler). Matching
    on this exact, code-owned marker string — not a generic substring guess —
    keeps this check tied to the ledger module's own contract."""
    text = _result_text(result)
    return "fenced by a newer dispatch generation" in text


# --- Public entry point ------------------------------------------------------


def execute_compensation(
    dispatch: dict,
    *,
    recorded_output: Any,
    org_id: str,
    denied_tools: Optional[set[str]] = None,
    tool_resolver: Callable[[str], Any],
    agent_id: str = "compensation-worker",
    workflow_definition_id: str = "",
    approval_required_tools: Optional[set[str]] = None,
    breaker_table: Optional[str] = None,
    breaker_target_resolver: Optional[Callable[[str], Any]] = None,
    breaker_clock: Optional[Callable[[], float]] = None,
) -> CompensationResult:
    """LLM-free, worker-side governed execution of ONE compensation dispatch.

    ``dispatch`` is the wire-shaped compensation dispatch message (mirrors
    ``workflow_contract.build_compensation_dispatch_message``'s output):
    ``execution_id``, ``node_id`` (the '{origNodeId}#comp' pseudo-node id),
    ``workflow_id``, ``tool``, ``args`` (the RAW unresolved template),
    ``compensation_generation``. ``recorded_output`` is the compensating
    node's recorded output (or an S3-offloaded reference shape) — the
    RECORDED OUTPUT REFERENCE the dispatch contract carries out of band from
    slice 3, per the task's field-name mirroring instruction.

    Pipeline (fail-closed at every step, D2/D4 D3):
      1. rehydrate an offloaded recorded_output (a).
      2. render args via the slice-2 module (import only, never reimplement).
      3. derive the CIT-121 key: sk = '{node_id}#0#{tool}#{argsHash}' — since
         ``node_id`` already carries the '#comp' suffix, this yields exactly
         '{origNodeId}#comp#0#{tool}#{argsHash}' (b).
      4. drive the SAME ComposedToolHook seam a real agent tool call uses,
         fenced on compensation_generation (c) — LLM-free, no agent turn.
      5. on DENY: escalate, never execute (d).
      6. return the compensation-result contract (e).
    """
    execution_id = dispatch.get("execution_id", "")
    node_id = dispatch.get("node_id", "")
    workflow_id = dispatch.get("workflow_id", "")
    tool_name = dispatch.get("tool", "")
    raw_args = dispatch.get("args") or {}
    compensation_generation = dispatch.get("compensation_generation")

    result_kwargs = dict(
        execution_id=execution_id, node_id=node_id, workflow_id=workflow_id, tool=tool_name,
    )

    # --- (a) rehydrate BEFORE rendering -------------------------------------
    try:
        usable_output = _rehydrate_recorded_output(recorded_output)
    except CompensationTemplateError as exc:
        return CompensationResult(
            **result_kwargs, status=STATUS_COMPENSATION_FAILED,
            error_class=type(exc).__name__, error=str(exc),
        )
    except ledger.LedgerError as exc:
        return CompensationResult(
            **result_kwargs, status=STATUS_COMPENSATION_FAILED,
            error_class=type(exc).__name__, error=str(exc),
        )

    # --- (a) render via the slice-2 module (import, never reimplement) -----
    try:
        rendered = render_compensation_args(raw_args, usable_output)
    except CompensationTemplateError as exc:
        return CompensationResult(
            **result_kwargs, status=STATUS_COMPENSATION_FAILED,
            error_class=type(exc).__name__, error=str(exc),
        )

    # --- resolve the tool BEFORE building the hook (fail fast, no reserve) -
    resolved_tool = tool_resolver(tool_name)
    if resolved_tool is None:
        return CompensationResult(
            **result_kwargs, status=STATUS_COMPENSATION_FAILED,
            error_class="ToolNotFound", error=f"no compensation tool registered for {tool_name!r}",
        )

    # --- (b) CIT-121 key derivation, mirrored for replay detection ONLY —
    # the actual reserve/dedupe decision is made by the IdempotencyToolHook
    # inside build_compensation_hook's wrapper (never duplicated here as a
    # second authority). This is purely observability: was a completed row
    # already present before THIS call reserves/executes?
    #
    # ``origin_node_id`` strips the wire ``'#comp'`` pseudo-id suffix before
    # key derivation and ``is_compensation=True`` is passed explicitly — the
    # structural fix (see ``tool_idempotency.build_sort_key``'s docstring)
    # that removes this key's correctness from depending on node-id string
    # hygiene. ``node_id`` (the pseudo id) is still used for the
    # CompensationResult / escalation messages below — that is a
    # reporting/wire-contract concern, unrelated to the ledger key.
    origin_node_id = _origin_node_id(node_id)
    pk, sk = build_key(
        org_id or "", execution_id, origin_node_id, 0, tool_name, rendered.args,
        is_compensation=True,
    )
    pre_existing_row = None
    try:
        pre_existing_row = ledger.get(pk, sk)
    except ledger.LedgerError:
        pre_existing_row = None  # best-effort observability only; never fail-closed on this
    was_already_completed = bool(pre_existing_row and pre_existing_row.get("status") == ledger.STATUS_COMPLETED)

    # --- (c) build the fenced breaker, then the SAME ComposedToolHook seam -
    breaker = _build_breaker(
        org_id=org_id, execution_id=execution_id, node_id=origin_node_id,
        workflow_id=workflow_id, agent_id=agent_id,
        breaker_table=breaker_table, breaker_target_resolver=breaker_target_resolver,
        breaker_clock=breaker_clock,
    )
    hook = build_compensation_hook(
        org_id=org_id, execution_id=execution_id, node_id=origin_node_id,
        agent_id=agent_id, workflow_id=workflow_id,
        compensation_generation=compensation_generation,
        denied_tools=denied_tools, approval_required_tools=approval_required_tools,
        workflow_definition_id=workflow_definition_id, breaker=breaker,
    )

    status, tool_result, error_class, error = _run_direct_governed_call(
        hook=hook, tool_name=tool_name, tool_input=rendered.args,
        resolved_tool=resolved_tool, node_id=node_id,
    )

    # --- (d) DENY -> escalate, never execute --------------------------------
    if status == "denied":
        _escalate(
            execution_id=execution_id, node_id=node_id, tool=tool_name,
            reason=f"compensation for {node_id!r} denied by governance deny-list",
            agent_id=agent_id,
        )
        return CompensationResult(
            **result_kwargs, status=STATUS_COMPENSATION_FAILED, escalated=True,
            error_class="GovernanceDenied", error="compensation denied by governance deny-list",
        )

    if status == "stale_generation":
        return CompensationResult(
            **result_kwargs, status=STATUS_COMPENSATION_FAILED,
            error_class=error_class or "StaleWorkerFencedError", error=error,
        )

    if status == "breaker_open":
        return CompensationResult(
            **result_kwargs, status=STATUS_COMPENSATION_FAILED,
            error_class=error_class or "CircuitOpenError", error=error,
        )

    # status == 'executed' (covers WON/HIT_COMPLETED/HIT_FAILED/IN_FLIGHT —
    # the wrapper's own internal branching; only a raised exception or an
    # error-shaped ToolResult indicates this specific call did not succeed).
    if error_class is not None:
        return CompensationResult(
            **result_kwargs, status=STATUS_COMPENSATION_FAILED,
            error_class=error_class, error=error,
        )

    if isinstance(tool_result, dict) and tool_result.get("status") == "error":
        text = ""
        content = tool_result.get("content") or []
        if content and isinstance(content[0], dict):
            text = content[0].get("text", "")
        replayed = "reserved by a concurrent" not in text and (
            "fenced by a newer dispatch" not in text
        )
        return CompensationResult(
            **result_kwargs, status=STATUS_COMPENSATION_FAILED,
            error_class="ToolResultError", error=text or "compensation tool returned an error result",
            replayed="idempotent replay" in text,
        )

    return CompensationResult(
        **result_kwargs, status=STATUS_COMPENSATED, result=tool_result,
        replayed=was_already_completed,
    )
