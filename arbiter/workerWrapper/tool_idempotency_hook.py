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
            # never ran.
            yield ToolResultEvent(_error_result(
                tool_use_id,
                "tool execution refused: worker fenced by a newer dispatch "
                "generation (no side effect performed)",
            ))
            return

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
        last_result: Any = None
        try:
            async for event in self._inner.stream(tool_use, invocation_state, **kwargs):
                if isinstance(event, ToolResultEvent):
                    last_result = event.tool_result
                yield event
        except Exception as exc:  # noqa: BLE001 — unknown outcome, fail safe
            ledger.finalize_failure(
                self._pk, self._sk, error_type=type(exc).__name__,
                retryable=False, outcome_indeterminate=True,
            )
            raise

        if isinstance(last_result, dict) and last_result.get("status") == "error":
            ledger.finalize_failure(self._pk, self._sk, error_type="tool_error_result", retryable=False)
        elif last_result is not None:
            ledger.finalize_success(self._pk, self._sk, result=last_result)


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
    ):
        self._org_id = org_id or ""
        self._execution_id = execution_id or ""
        self._node_id = node_id or ""
        self._mode_resolver = mode_resolver
        self._dispatch_generation = dispatch_generation
        self._client_token_param_resolver = client_token_param_resolver
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
    ):
        self._governance = governance
        self._idempotency = idempotency

    @property
    def governance(self) -> Any | None:  # pragma: no cover — accessor
        return self._governance

    @property
    def idempotency(self) -> "IdempotencyToolHook | None":  # pragma: no cover
        return self._idempotency

    def register_hooks(self, registry: Any, **_kwargs: Any) -> None:
        if not _STRANDS_AVAILABLE:  # pragma: no cover — dev/CI guard
            logger.warning("composed tool hook skipped — strands unavailable")
            return
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)

    def _on_before_tool_call(self, event: Any) -> None:
        # 1) Governance decision FIRST. On DENY the evaluator swaps
        #    ``event.selected_tool`` for a deny-only tool and returns True; we
        #    then RETURN so idempotency's reserve/wrap never runs (deny before
        #    reserve — no reservation, no side effect).
        if self._governance is not None:
            if self._governance.evaluate(event):
                return
        # 2) PERMIT → idempotency reserve/execute/finalize wrapping.
        if self._idempotency is not None:
            self._idempotency._on_before_tool_call(event)
