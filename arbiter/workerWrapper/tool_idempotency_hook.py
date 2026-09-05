"""Strands tool-idempotency hook — the single atomic seam (PR1 of 2).

Verified against ``strands-agents==1.30.0`` (the version pinned in
``arbiter/workerWrapper/requirements.txt``): there is **no**
``strands.handlers.tool_handler.AgentToolHandler`` and ``Agent.__init__``
accepts neither ``tool_handler`` nor ``**kwargs``. The supported tool-call
extension surface is the **hooks system**:

* ``ToolExecutor._stream`` fires ``BeforeToolCallEvent`` (whose
  ``selected_tool`` is writable), then runs ``selected_tool.stream(...)``,
  then fires ``AfterToolCallEvent``.
* A ``HookProvider`` registers callbacks via ``registry.add_callback``, and is
  attached with ``Agent(hooks=[...])``.

To get reserve -> execute -> finalize with **no pre/post window** (the
requirement, and security condition C2), this hook does NOT split logic across
Before/After. Instead, in ``BeforeToolCallEvent`` it REPLACES ``selected_tool``
with an :class:`_IdempotentToolWrapper` whose ``stream()`` performs
reserve -> delegate-to-real-tool -> finalize inside one coroutine. The reserve
strictly precedes any adapter call, and there is no seam between reserve and
execute that another actor could slip through.

The idempotency decision logic itself lives in
``arbiter/governance/tool_execution_ledger.py`` (fully unit-tested via the
synchronous ``execute_idempotent`` coordinator with a stubbed adapter + a
conditional-write fake). This module is the thin async glue that binds that
logic to the real Strands seam; it degrades to a no-op import when
``strands`` is unavailable (dev/CI), mirroring ``governed_tool_handler.py``.

Scope note (honesty requirement): this delivers exactly-once WITHIN an
attempt + reservation-race safety, AND — for a workflow-node tool call carrying
a ``dispatch_generation`` — exactly-once ACROSS a watchdog re-dispatch, because
the reserve is fenced against the execution row's current generation (a stale
re-dispatched-away worker is refused before any side effect). A supervisor task
call or a ``bypass`` tool carries no generation and is unfenced (exactly-once
within an attempt only). This hook also injects an optional server-side
client-idempotency token (post-canonicalization) for targets that support one.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any, Callable

_HERE = os.path.dirname(os.path.abspath(__file__))
# Import convention (DEPLOYED layout). The worker Lambda bundle roots this
# file's own directory (arbiter/workerWrapper/ → the task root) on sys.path,
# and the shared ``ArbiterCatalogLayer`` stages ``governance``/``common``/
# ``catalog`` at ``/opt/python``. So the ledger is imported from the top-level
# ``governance`` package (layer) and ``tool_idempotency`` as a bundle-root
# sibling — NEVER via an ``arbiter.*`` prefix, which exists in NEITHER the
# deployed bundle NOR the layer. The old ``from arbiter.governance import``
# form is exactly what raised "No module named arbiter" in the first real
# smoke run, silently disabling the whole idempotency capability. These same
# names resolve under pytest via ``arbiter/conftest.py`` (which puts the
# arbiter root and each subdir on sys.path); the deployed subprocess resolves
# ``governance`` because ``index.py`` propagates the parent's sys.path onto the
# child's PYTHONPATH. Insert _HERE so the bundle-root sibling resolves even
# when this module is imported before the caller widens sys.path.
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from governance import tool_execution_ledger as ledger  # noqa: E402
from tool_idempotency import (  # noqa: E402
    MODE_LEDGER,
    build_client_token,
    build_key,
    classify_idempotency_mode,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Governance / infrastructure REFUSAL sink (finding be80ccd7).
# ---------------------------------------------------------------------------
# A ``LedgerError`` raised by the idempotency/ledger gate during a tool call is
# an INFRASTRUCTURE / GOVERNANCE REFUSAL — the gate itself failed (transport /
# credential error) or refused; the tool did NOT run under a completed
# reservation. strands catches a tool exception, converts it to an
# error-status ToolResult, and lets the agent turn COMPLETE "normally"
# (returncode 0, no agent-body failure marker). Without capturing it here the
# worker would emit ``workflow.node.completed`` for a run whose governance gate
# hard-failed — the exact defect in finding be80ccd7 (the earlier fix, finding
# 56d763d4, only mapped agent-body EXCEPTIONS, not error-status tool RESULTS).
#
# We therefore record such refusals into this per-process sink. ``agent_runner``
# drains it AFTER the turn and, if non-empty, emits a failure-marked envelope so
# the node fails with the refusal CLASS fed into retry.py's failure-class logic.
#
# DISCRIMINATOR (concrete, uses the EXISTING typed marker the governance layer
# emits — ``governance.tool_execution_ledger.LedgerError`` and subclasses):
#   * INFRA/GOVERNANCE REFUSAL -> a LedgerError was raised by reserve/finalize
#     => recorded here => node FAILS with that class.
#   * DOMAIN-LEVEL tool error -> the tool ran and returned {"status":"error"},
#     or the agent handled a tool error and completed its turn. No LedgerError
#     is raised => nothing recorded => the node COMPLETES. The agent is
#     expected to handle these; they must NOT blanket-fail the node.
# CARVE-OUT: ``StaleWorkerFencedError`` is a DESIGNED exactly-once outcome (this
# worker was re-dispatched away; a NEWER worker owns the node). It is surfaced
# as an error ToolResult but is NOT recorded as a node-failing refusal —
# failing here would double-signal a node another worker is completing.
_GOVERNANCE_REFUSALS: list[dict[str, Any]] = []


def drain_governance_refusals() -> list[dict[str, Any]]:
    """Return and CLEAR the governance/infrastructure refusals recorded during
    this process's tool calls. Called once by ``agent_runner`` after the turn.
    Clearing keeps repeated in-process test invocations independent."""
    drained = list(_GOVERNANCE_REFUSALS)
    _GOVERNANCE_REFUSALS.clear()
    return drained


def _record_governance_refusal(exc: "ledger.LedgerError") -> None:
    """Record a LedgerError refusal (class + diagnostic + retryable flag).

    ``retryable`` is read from the LedgerError subclass (the ledger hierarchy
    already encodes it) and preserved for observability; the node-failure
    CLASS is what retry.py's ``should_retry`` matches on downstream."""
    _GOVERNANCE_REFUSALS.append({
        "errorClass": type(exc).__name__,
        "error": str(exc) or type(exc).__name__,
        "retryable": bool(getattr(exc, "retryable", False)),
    })


# ---------------------------------------------------------------------------
# Tool-CRASH sink — third arm of the failure discriminator (finding 4595b730).
# ---------------------------------------------------------------------------
# STRUCTURAL basis (never message matching): the two node-failing arms are
# distinguished by SHAPE, not text.
#   * INFRA/GOVERNANCE REFUSAL -> a LedgerError raised by reserve/finalize (the
#     gate itself failed / refused) -> _GOVERNANCE_REFUSALS -> node FAILS.
#   * TOOL UNHANDLED EXCEPTION  -> an exception ESCAPED the real tool's stream()
#     -> recorded HERE -> node FAILS. A crash is NOT a business outcome: strands
#     converts a tool exception into an error-status ToolResult and lets the
#     turn COMPLETE normally, so without capturing it the worker would emit
#     workflow.node.completed for a run whose tool crashed. This sink is what
#     the third discriminator arm keys on.
#   * TOOL-RETURNED STRUCTURED DOMAIN ERROR ({"status":"error"}) records NOTHING
#     in either sink -> node COMPLETES (the tool ran and reported a handled
#     outcome; the agent is expected to deal with it).
# ``agent_runner`` drains this sink AFTER the turn (alongside the refusal sink)
# and, if non-empty, emits a failure-marked envelope so the node fails with the
# crash CLASS fed into retry.py.
_TOOL_CRASHES: list[dict[str, Any]] = []


def drain_tool_crashes() -> list[dict[str, Any]]:
    """Return and CLEAR the tool-execution crashes recorded during this
    process's tool calls. Called once by ``agent_runner`` after the turn;
    clearing keeps repeated in-process test invocations independent."""
    drained = list(_TOOL_CRASHES)
    _TOOL_CRASHES.clear()
    return drained


def _record_tool_crash(exc: BaseException) -> None:
    """Record that an exception ESCAPED the real tool's ``stream()``.

    Structural signal (not message matching): we are inside the wrapper's
    ``except`` for ``self._inner.stream(...)``, so an exception provably escaped
    the tool. ``retryable`` is read from a classified ``ToolOutcomeError`` when
    present (else False); the crash CLASS is what retry.py matches on."""
    _TOOL_CRASHES.append({
        "errorClass": type(exc).__name__,
        "error": str(exc) or type(exc).__name__,
        "retryable": bool(getattr(exc, "retryable", False)),
    })


try:
    from strands.hooks import BeforeToolCallEvent  # type: ignore
    from strands.types.tools import AgentTool  # type: ignore

    _STRANDS_AVAILABLE = True
except ImportError:  # pragma: no cover — dev/CI without strands-agents
    _STRANDS_AVAILABLE = False
    BeforeToolCallEvent = object  # type: ignore[assignment,misc]
    AgentTool = object  # type: ignore[assignment,misc]


def _error_result(tool_use_id: str, message: str) -> dict[str, Any]:
    """A Strands ToolResult-shaped error dict."""
    return {
        "toolUseId": tool_use_id,
        "status": "error",
        "content": [{"text": message}],
    }


def _event_tool_name(event: Any) -> str:
    """Best-effort tool name from a BeforeToolCallEvent, for seam logging only
    (never logs tool input/payload)."""
    tool_use = getattr(event, "tool_use", None)
    if tool_use is not None and hasattr(tool_use, "get"):
        return str(tool_use.get("name", "") or "")
    return ""


class _IdempotentToolWrapper(AgentTool):  # type: ignore[misc]
    """Wraps a selected tool so its ``stream()`` is ledger-protected.

    Reserve -> execute -> finalize happen inside this one ``stream()``
    coroutine, mirroring ``ledger.execute_idempotent``'s branches (that sync
    coordinator is the unit-tested authority for the invariant; this async
    path applies the identical failure matrix over the same primitives).
    """

    def __init__(self, inner: Any, pk: str, sk: str, tool_name: str, mode: str,
                 *, dispatch_generation: int | None = None,
                 execution_id: str = "", node_id: str = ""):
        try:
            super().__init__()
        except TypeError:  # pragma: no cover — base signature drift
            pass
        self._inner = inner
        self._pk = pk
        self._sk = sk
        self._tool_name = tool_name
        self._mode = mode
        self._dispatch_generation = dispatch_generation
        self._execution_id = execution_id
        self._node_id = node_id

    # --- AgentTool interface delegation --------------------------------------
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

        tool_use_id = str(tool_use.get("toolUseId", "")) if hasattr(tool_use, "get") else ""

        try:
            reservation = ledger.reserve(
                self._pk, self._sk, tool_name=self._tool_name,
                dispatch_generation=self._dispatch_generation,
                execution_id=self._execution_id or None,
                node_id=self._node_id or None,
            )
        except ledger.StaleWorkerFencedError:
            # This worker was re-dispatched away (its generation is stale). It
            # is refused at the reserve fence BEFORE any side effect — a newer
            # worker owns the node. Surface as an error ToolResult; the tool
            # never ran. DESIGNED exactly-once outcome, NOT a node-failing
            # refusal (see the carve-out on _GOVERNANCE_REFUSALS): a newer
            # worker is completing this node, so we must not double-signal it.
            yield ToolResultEvent(_error_result(
                tool_use_id,
                "tool execution refused: worker fenced by a newer dispatch "
                "generation (no side effect performed)",
            ))
            return
        except ledger.LedgerError as exc:
            # Infrastructure / governance REFUSAL (finding be80ccd7): the ledger
            # gate itself FAILED — e.g. the ground-truth "ledger fenced reserve
            # transport error" that a NoCredentialsError produced. The tool
            # never ran. Record it so agent_runner fails the node with this
            # class (fed into retry.py); surface an error ToolResult so the turn
            # does not crash mid-stream (the node-failure decision is made
            # uniformly post-turn from the drained refusal sink).
            _record_governance_refusal(exc)
            yield ToolResultEvent(_error_result(
                tool_use_id,
                f"tool execution refused (governance/infrastructure): {exc}",
            ))
            return

        # SEAM LOG (finding 1a57e526): reserve outcome. Key + generation only —
        # never tool input/payload/secrets. pk/sk are identifiers + an args
        # HASH (not the args), safe to log.
        logger.info(
            "tool-ledger reserve outcome=%s pk=%s sk=%s gen=%s",
            reservation.outcome.value, self._pk, self._sk, self._dispatch_generation,
        )

        if reservation.outcome == ledger.ReserveOutcome.HIT_COMPLETED:
            yield ToolResultEvent(ledger._recorded_result(reservation.row or {}, self._pk))
            return
        if reservation.outcome == ledger.ReserveOutcome.HIT_FAILED:
            yield ToolResultEvent(_error_result(tool_use_id, "prior terminal failure (idempotent replay)"))
            return
        if reservation.outcome == ledger.ReserveOutcome.IN_FLIGHT:
            settled = ledger.wait_for_terminal(self._pk, self._sk)
            if settled is not None and settled.get("status") == ledger.STATUS_COMPLETED:
                yield ToolResultEvent(ledger._recorded_result(settled, self._pk))
                return
            # Concurrent loser (or terminal-failed winner): retryable, no
            # execution. Surface as an error ToolResult — we NEVER ran the tool.
            yield ToolResultEvent(_error_result(
                tool_use_id,
                "tool execution reserved by a concurrent run; retry (no side effect performed)",
            ))
            return

        # WON — execute the real tool under the reservation.
        #
        # THREE-WAY FAILURE DISCRIMINATOR (finding 4595b730), decided on a
        # STRUCTURAL basis — an exception ESCAPING the tool vs the tool
        # RETURNING an error payload — never on error-message matching:
        #   * TOOL UNHANDLED EXCEPTION (anything escaping self._inner.stream)
        #     -> a crash is NOT a business outcome -> finalize the reservation
        #        FAILED + _record_tool_crash -> node FAILS.
        #   * TOOL-RETURNED STRUCTURED domain error ({"status":"error"})
        #     -> the tool ran and reported a handled outcome -> finalize the
        #        reservation FAILED but record NOTHING -> node COMPLETES.
        #   (INFRA/GOVERNANCE REFUSAL is the LedgerError arm, handled above at
        #    reserve and below at finalize via _record_governance_refusal.)
        last_result: Any = None
        finalized = False

        def _finalize_return(result: Any) -> None:
            # Transition the reservation to its terminal state from the tool's
            # RETURNED payload. A structured domain error ({"status":"error"})
            # finalizes FAILED (the node COMPLETES; the agent handles it);
            # anything else finalizes COMPLETED carrying the recorded result.
            # Raises ledger.LedgerError on an infrastructure failure — the
            # caller records a governance refusal so the node fails post-turn.
            if isinstance(result, dict) and result.get("status") == "error":
                logger.info(
                    "tool-ledger finalize status=failed(domain_error) pk=%s sk=%s gen=%s",
                    self._pk, self._sk, self._dispatch_generation,
                )
                ledger.finalize_failure(self._pk, self._sk, error_type="tool_error_result", retryable=False)
            else:
                logger.info(
                    "tool-ledger finalize status=completed pk=%s sk=%s gen=%s",
                    self._pk, self._sk, self._dispatch_generation,
                )
                ledger.finalize_success(self._pk, self._sk, result=result)

        # SEAM LOG: about to execute the real tool under the held reservation.
        logger.info(
            "tool-ledger execute pk=%s sk=%s gen=%s tool=%s",
            self._pk, self._sk, self._dispatch_generation, self._tool_name,
        )
        try:
            async for event in self._inner.stream(tool_use, invocation_state, **kwargs):
                if isinstance(event, ToolResultEvent):
                    last_result = event.tool_result
                    # FINALIZE BEFORE YIELDING THE TERMINAL RESULT (finding
                    # 1a57e526). The strands tool-executor is guaranteed to
                    # PULL the terminal ToolResultEvent — that is how it obtains
                    # a tool result — but is NOT guaranteed to RESUME this async
                    # generator past that yield. Any finalize placed AFTER the
                    # ``async for`` loop is therefore unreachable in production:
                    # that is exactly why a SUCCESSFUL call left its ledger row
                    # in_flight forever (reserve ran pre-loop, the tool ran and
                    # yielded, then the generator was abandoned at the yield, so
                    # the completed transition never ran and no result was
                    # recorded — defeating the retried-COMPLETED-key replay
                    # guarantee). Finalizing here, immediately BEFORE the yield,
                    # runs the transition while the runtime is still driving us.
                    if not finalized:
                        try:
                            _finalize_return(last_result)
                        except ledger.LedgerError as exc:
                            # The tool ran but its outcome could not be durably
                            # recorded (infrastructure refusal). Record it so
                            # the node fails post-turn; still yield the result
                            # below (the side effect already happened).
                            _record_governance_refusal(exc)
                        finalized = True
                yield event
        except ledger.ToolOutcomeError as exc:
            # Adapter-CLASSIFIED failure that ESCAPED the tool. Apply the same
            # failure matrix as the sync execute_idempotent coordinator, then
            # record a tool crash (an exception escaped -> node FAILS). Only the
            # genuinely-unknown branch marks the row indeterminate.
            if exc.side_effect == "not_sent" and exc.retryable:
                ledger.release(self._pk, self._sk)
            elif exc.side_effect == "applied":
                ledger.finalize_failure(
                    self._pk, self._sk, error_type=exc.error_type, retryable=False,
                )
            else:  # 'unknown' — genuinely indeterminate outcome
                ledger.finalize_failure(
                    self._pk, self._sk, error_type=exc.error_type,
                    retryable=False, outcome_indeterminate=True,
                )
            _record_tool_crash(exc)
            raise
        except Exception as exc:  # noqa: BLE001 — unhandled tool crash
            # FINALIZE ON RAISE (finding 4595b730): an unclassified exception
            # escaped the tool. Transition the reservation to FAILED so no row
            # is left in_flight. Deliberately NOT marked indeterminate —
            # 'indeterminate' is reserved strictly for a genuinely-unknown
            # outcome (the ToolOutcomeError 'unknown' branch above); a bare
            # crash is a determinate node failure retry.py may retry per policy.
            ledger.finalize_failure(
                self._pk, self._sk, error_type=type(exc).__name__, retryable=False,
            )
            _record_tool_crash(exc)
            raise

        # FALLBACK for a tool that streamed NO ToolResultEvent (last_result is
        # None): with no terminal event to stop at, the runtime DID exhaust us,
        # so this post-loop code runs. Finalize completed-with-null so a
        # completed turn can NEVER leave a row in_flight (finding 4595b730),
        # even in that shape. Guarded by ``finalized`` so the normal path — where
        # we already finalized before yielding the terminal result — is not
        # double-written (a second finalize_success would re-offload a large
        # result to S3 before the conditional no-op).
        if not finalized:
            try:
                _finalize_return(last_result)
            except ledger.LedgerError as exc:
                # The tool already ran, but the ledger could not durably record
                # its outcome (infrastructure refusal). Record it so the node
                # fails (the run's governance state is indeterminate); no
                # ToolResult to yield here — the tool's own result already
                # streamed.
                _record_governance_refusal(exc)


class IdempotencyToolHook:
    """A Strands ``HookProvider`` that installs ledger-backed idempotency.

    Attach with ``Agent(hooks=[IdempotencyToolHook(...)])``. A no-op unless
    ``execution_id`` and ``node_id`` are present (back-compat: an agent run
    outside the idempotency envelope behaves byte-identically to today).

    ``org_id`` MUST be resolved server-side (execution row / trusted env) by
    the caller — never taken from a subprocess-supplied payload. ``call_index``
    is a per-instance monotonic counter (one hook instance == one agent == one
    subprocess == one node attempt), so it is attempt-scoped by construction.

    ``mode_resolver`` maps a tool name to ``'ledger'``/``'bypass'`` (fail-safe
    default ``'ledger'`` via ``classify_idempotency_mode``); when absent every
    tool is ledger-protected.

    ``is_compensation`` is a STRUCTURAL flag, not a string convention: the
    caller (``compensation_executor.build_compensation_hook``) sets it
    explicitly because it already knows it is building the compensation
    path's hook, rather than the collision-prone alternative of suffixing
    ``node_id`` itself with a marker like ``"#comp"`` before handing it here.
    Forwarded verbatim to ``tool_idempotency.build_key`` so a compensation
    call's ledger key can never coincide with an original call's key for any
    ``node_id`` value — see that function's docstring.
    """

    def __init__(
        self,
        *,
        org_id: str,
        execution_id: str,
        node_id: str,
        mode_resolver: Callable[[str], str] | None = None,
        dispatch_generation: int | None = None,
        client_token_param_resolver: Callable[[str], str | None] | None = None,
        is_compensation: bool = False,
    ):
        self._org_id = org_id or ""
        self._execution_id = execution_id or ""
        self._node_id = node_id or ""
        self._mode_resolver = mode_resolver
        self._dispatch_generation = dispatch_generation
        self._client_token_param_resolver = client_token_param_resolver
        self._is_compensation = is_compensation
        self._call_index = 0

    @property
    def enabled(self) -> bool:
        return bool(self._execution_id and self._node_id)

    def register_hooks(self, registry: Any, **_kwargs: Any) -> None:
        if not _STRANDS_AVAILABLE:  # pragma: no cover — dev/CI guard
            logger.warning("idempotency hook skipped — strands unavailable")
            return
        if not self.enabled:
            logger.warning(
                "idempotency hook skipped — execution/node context absent "
                "(back-compat no-op)"
            )
            return
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)

    def _resolve_mode(self, tool_name: str) -> str:
        if self._mode_resolver is None:
            return MODE_LEDGER
        try:
            return classify_idempotency_mode({"idempotency": {"mode": self._mode_resolver(tool_name)}})
        except Exception:  # noqa: BLE001 — resolver failure must fail safe
            return MODE_LEDGER

    def _on_before_tool_call(self, event: Any) -> None:  # pragma: no cover — requires strands runtime
        tool_use = getattr(event, "tool_use", None)
        selected = getattr(event, "selected_tool", None)
        if tool_use is None or selected is None:
            return
        tool_name = tool_use.get("name", "") if hasattr(tool_use, "get") else ""
        tool_input = tool_use.get("input", {}) if hasattr(tool_use, "get") else {}

        # Attempt-scoped monotonic index: increment for EVERY intercepted call
        # (ledger and bypass alike) so numbering is stable within the attempt.
        call_index = self._call_index
        self._call_index += 1

        mode = self._resolve_mode(tool_name)
        if mode != MODE_LEDGER:
            return  # bypass: leave the real tool in place, write no ledger row

        try:
            pk, sk = build_key(
                self._org_id, self._execution_id, self._node_id,
                call_index, tool_name, tool_input,
                is_compensation=self._is_compensation,
            )
        except Exception:  # noqa: BLE001 — canonicalization failure: fail closed
            # A side-effecting call whose key cannot be derived must not run
            # unprotected. Replace the tool with one that errors deterministically.
            event.selected_tool = _KeyDerivationFailedTool(selected)
            return

        # Client-token passthrough (PR2): for a target that supports an
        # end-to-end idempotency token, inject it SERVER-SIDE now — AFTER
        # build_key has already hashed the ORIGINAL input, so the token never
        # perturbs the argsHash — and OVERWRITE any model-supplied value so the
        # model cannot inject its own token (which could impersonate another
        # org's idempotency namespace). Only when the per-tool config declares
        # a clientTokenParam AND the tool input is a mutable mapping.
        token_param = self._resolve_client_token_param(tool_name)
        if token_param and isinstance(tool_input, dict):
            tool_input[token_param] = build_client_token(pk, sk)

        event.selected_tool = _IdempotentToolWrapper(
            selected, pk, sk, tool_name, mode,
            dispatch_generation=self._dispatch_generation,
            execution_id=self._execution_id,
            node_id=self._node_id,
        )

    def _resolve_client_token_param(self, tool_name: str) -> str | None:
        """Resolve the per-tool client-token param name, or None. Fail-safe:
        any resolver error yields None (no token injected)."""
        if self._client_token_param_resolver is None:
            return None
        try:
            param = self._client_token_param_resolver(tool_name)
        except Exception:  # noqa: BLE001 — resolver failure must not break the call
            return None
        return param if isinstance(param, str) and param else None


class _KeyDerivationFailedTool(AgentTool):  # type: ignore[misc]
    """Replacement tool that refuses to run when the idempotency key cannot be
    derived (fail-closed for a side-effecting call)."""

    def __init__(self, inner: Any):
        try:
            super().__init__()
        except TypeError:  # pragma: no cover
            pass
        self._inner = inner

    @property
    def tool_name(self) -> str:  # pragma: no cover
        return self._inner.tool_name

    @property
    def tool_spec(self) -> Any:  # pragma: no cover
        return self._inner.tool_spec

    @property
    def tool_type(self) -> str:  # pragma: no cover
        return self._inner.tool_type

    async def stream(self, tool_use: Any, invocation_state: dict[str, Any], **kwargs: Any):  # pragma: no cover
        from strands.types._events import ToolResultEvent

        tool_use_id = str(tool_use.get("toolUseId", "")) if hasattr(tool_use, "get") else ""
        yield ToolResultEvent(_error_result(
            tool_use_id,
            "idempotency key could not be derived from tool input; refused "
            "(fail-closed, no side effect performed)",
        ))


class ComposedToolHook:
    """The SINGLE ``BeforeToolCallEvent`` seam that composes layer-2 tool
    governance with tool-call idempotency (finding 027c4a89).

    Root cause of 027c4a89: governance and idempotency were two INDEPENDENT
    ``strands.Agent.__init__`` monkeypatches. Idempotency was re-ported to the
    hooks API; governance still targeted the removed ``tool_handler`` kwarg and
    silently went inert. Composing both concerns behind ONE callback (this
    class) removes the ability for them to diverge again.

    Ordering (invariant): a governance DENIAL is applied FIRST, and on denial we
    RETURN before the idempotency step runs. Therefore a denied tool:
      * performs no side effect (``selected_tool`` is swapped for a tool that
        only yields the deny error), AND
      * creates NO idempotency reservation / execution-ledger row (``reserve``
        is never reached) — so no ledger row can imply a completed run that
        never happened.
    A DENY audit ``GovernanceFinding`` IS still written (that is the governance
    findings ledger, distinct from the idempotency execution ledger).

    NODE-STATUS DECISION (merge of #84 refusal-mapping ⋈ #85 governance seam —
    the open question "what node status results from a governance DENIAL?"):

      A governance POLICY DENIAL COMPLETES the node; it does NOT fail it. The
      denial is recorded durably as a DENY ``GovernanceFinding`` (written by
      ``record_governance_decision`` BEFORE the tool swap) and the agent is
      handed an "not authorised" error ToolResult it may legitimately handle.
      A denial is therefore treated as an EXPECTED governed outcome, not an
      error — and it is deliberately NOT written into the
      ``_GOVERNANCE_REFUSALS`` sink, so ``agent_runner``'s post-turn drain does
      not turn it into a failure-marked envelope.

      This is distinct from an INFRASTRUCTURE REFUSAL — a ``LedgerError`` raised
      by ``reserve``/``finalize`` (the gate itself failing: transport /
      credential error). That IS recorded in ``_GOVERNANCE_REFUSALS`` and FAILS
      the node with its LedgerError class fed to retry.py (finding be80ccd7).

      Both invariants of finding be80ccd7 are preserved:
        * NO UNAUTHORISED SIDE EFFECT — deny-before-reserve: the real tool never
          runs and no reservation / execution-ledger row is created (``reserve``
          is unreachable on the deny path).
        * NO SILENT INVISIBILITY — the DENY ``GovernanceFinding`` is a durable,
          queryable record of the denial; "completes" does not mean "hidden".

      Rationale for COMPLETE over FAIL: record-and-block eval mode (the
      ``eval_run_id`` path) depends on the run CONTINUING — the eval sandbox
      exists to OBSERVE a forbidden action attempt WITHOUT executing it and then
      watch what the agent does next. Failing the node on the first denial would
      abort the eval trajectory and defeat the sandbox's purpose. Finding
      be80ccd7 listed "governance denials" as must-be-visible refusals in the
      era when the real allow/deny layer was INERT, so the only "refusal" that
      existed then was the infra-gate LedgerError; now that a live policy layer
      exists, an intentional policy DENY is a distinct, expected outcome that
      must be VISIBLE (satisfied by the DENY finding) but need not FAIL the node.

    Either collaborator may be ``None``:
      * governance-only (supervisor task path): idempotency=None.
      * governance+idempotency (workflow-node path): both present.
    At least one MUST be non-None (the installer guarantees this); a fully-empty
    composed hook would be a no-op.
    """

    def __init__(
        self,
        *,
        governance: Any | None = None,
        idempotency: "IdempotencyToolHook | None" = None,
        breaker: Any | None = None,
    ):
        self._governance = governance
        self._idempotency = idempotency
        self._breaker = breaker

    @property
    def governance(self) -> Any | None:  # pragma: no cover — accessor
        return self._governance

    @property
    def idempotency(self) -> "IdempotencyToolHook | None":  # pragma: no cover
        return self._idempotency

    @property
    def breaker(self) -> Any | None:  # pragma: no cover — accessor
        return self._breaker

    def register_hooks(self, registry: Any, **_kwargs: Any) -> None:
        if not _STRANDS_AVAILABLE:  # pragma: no cover — dev/CI guard
            logger.warning("composed tool hook skipped — strands unavailable")
            return
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)

    def _on_before_tool_call(self, event: Any) -> None:
        # LEGACY path (no breaker configured): byte-identical to the pre-breaker
        # behaviour — governance.evaluate() (deny-list THEN approval) then
        # idempotency. Preserves the finding-027c4a89 / c947aa77 invariants and
        # the existing composed-governance tests unchanged.
        if self._breaker is None:
            if self._governance is not None:
                if self._governance.evaluate(event):
                    logger.info("tool-governance decision=deny tool=%s", _event_tool_name(event))
                    return
                logger.info("tool-governance decision=permit tool=%s", _event_tool_name(event))
            if self._idempotency is not None:
                self._idempotency._on_before_tool_call(event)
            return

        # BREAKER-ENABLED path. Ordering (task 28d624b1), exactly:
        #   deny-list → breaker pre-check → approval-consume →
        #   idempotency reserve/execute/finalize → outermost breaker observer.
        # A breaker fast-fail happens BEFORE approval-consume and BEFORE the
        # reserve, so it burns no approval single-use and leaves no reservation.

        # 1) Deny-list phase (mints the opaque approval token on PERMIT).
        token = None
        if self._governance is not None:
            outcome = self._governance.evaluate_denylist(event)
            if outcome.refused:
                logger.info("tool-governance decision=deny tool=%s", _event_tool_name(event))
                return  # DENY: no breaker read, no approval, no reserve
            logger.info("tool-governance decision=permit tool=%s", _event_tool_name(event))
            token = outcome.token

        # 2) Breaker pre-check — BEFORE approval-consume and BEFORE reserve.
        pre = self._breaker.pre_check(event)
        if pre is not None and pre.fast_fail:
            selected = getattr(event, "selected_tool", None)
            if selected is not None:
                event.selected_tool = self._breaker.circuit_open_tool(selected, pre)
            return  # fast-fail: no approval consumed, no reservation

        # 3) Approval-consume phase (requires the deny-list token).
        if self._governance is not None and token is not None:
            if self._governance.evaluate_approval(event, token):
                return

        # 4) Idempotency reserve → execute → finalize (wraps selected_tool).
        if self._idempotency is not None:
            self._idempotency._on_before_tool_call(event)

        # 5) OUTERMOST breaker observer — wraps the (idempotency-wrapped) tool so
        #    the terminal outcome drives CLOSED→OPEN / HALF_OPEN transitions.
        if pre is not None and pre.observing:
            selected = getattr(event, "selected_tool", None)
            if selected is not None:
                event.selected_tool = self._breaker.wrap_observer(selected, pre)
