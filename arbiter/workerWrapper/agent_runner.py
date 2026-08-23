"""
Subprocess agent runner.

Executed by the worker wrapper as an isolated subprocess. Receives the
agent module path and request payload via stdin (JSON). Scoped AWS
credentials are injected into this process's environment by the parent
— they never touch the parent's os.environ.

Writes the agent response as a JSON line to stdout.
"""

import json
import sys
import os
import time
import importlib.util

# Module-global sink for usage records captured during this subprocess's
# lifetime. Reset per-process (one agent_runner.main() invocation == one
# subprocess), so callIndex is a simple monotonic counter starting at 0.
_CAPTURED_USAGE: list = []

# Structural agent-body failure marker (finding 56d763d4). ``agent_runner``
# writes this top-level key ONLY when the agent body raises, so a failed run
# is unambiguously distinguishable from a successful ``{"response": ...}``
# envelope. The consumer (``index.run_agent_in_subprocess`` /
# ``index._interpret_agent_result``) raises on its presence REGARDLESS of exit
# code, so an agent-body exception can never be laundered into a completed
# node result. Kept in lockstep with the mirror constant + defensive fallback
# in index.py (a parity test pins them equal).
AGENT_EXECUTION_FAILURE_MARKER = 'agentExecutionFailed'


def build_failure_envelope(exc: BaseException, usage: list) -> dict:
    """Build the stdout envelope for an agent-body exception (finding 56d763d4).

    Carries the exception CLASS name (``errorClass`` — the key retry.py's
    failure-class ``should_retry`` matches on) and the human-readable
    diagnostic (``error``), plus any usage captured before the crash. The
    presence of the ``AGENT_EXECUTION_FAILURE_MARKER`` top-level key is the
    structural signal that this is a failure, not a success — it never appears
    in a successful ``{"response": ...}`` envelope.
    """
    return {
        AGENT_EXECUTION_FAILURE_MARKER: True,
        'errorClass': type(exc).__name__,
        'error': str(exc) or type(exc).__name__,
        'usage': usage if isinstance(usage, list) else [],
    }


# Governance/infrastructure refusal marker (finding be80ccd7). Distinct
# observability key so a governance-refusal failure envelope is
# distinguishable from an agent-body crash envelope — but it ALSO carries the
# shared AGENT_EXECUTION_FAILURE_MARKER, so the SAME structural guard in
# index._interpret_agent_result raises on it. That is how the "no
# completed-with-failure" guard is EXTENDED from the exception path to the
# tool-result path: a completed turn that hid a governance/infrastructure
# refusal is turned into a failure-marked envelope here and can never be
# laundered into a node.completed.
GOVERNANCE_REFUSAL_MARKER = 'governanceRefused'


def build_refusal_envelope(refusals: list, usage: list) -> dict:
    """Build the stdout failure envelope for governance/infrastructure refusals
    recorded during a turn that otherwise COMPLETED normally (finding
    be80ccd7).

    The envelope carries the SAME ``AGENT_EXECUTION_FAILURE_MARKER`` as an
    agent-body crash (so index._interpret_agent_result's structural guard
    raises regardless of exit code), plus:
      * ``errorClass`` — the FIRST refusal's LedgerError subclass name, the key
        retry.py's ``should_retry`` matches on. (First is deterministic and
        sufficient; a run is failed by the first gate refusal it hit.)
      * ``error`` — the refusal diagnostic(s).
      * ``GOVERNANCE_REFUSAL_MARKER`` — True, for observability.

    The caller must only invoke this when ``refusals`` is non-empty.
    """
    first = refusals[0]
    diagnostics = '; '.join(
        str(r.get('error') or r.get('errorClass') or 'governance refusal')
        for r in refusals
    )
    return {
        AGENT_EXECUTION_FAILURE_MARKER: True,
        GOVERNANCE_REFUSAL_MARKER: True,
        'errorClass': first.get('errorClass') or 'LedgerError',
        'error': diagnostics or 'governance/infrastructure refusal',
        'usage': usage if isinstance(usage, list) else [],
    }

# Ordered candidate method names probed on strands.models.BedrockModel to
# find the response-producing seam to wrap. Multiple candidates survive a
# strands rename of the primary method without requiring a code change here.
_USAGE_CAPTURE_SEAM_CANDIDATES = ('converse', 'stream', 'structured_output')


def _usage_builder():
    """Return the canonical ``build_usage_record`` helper.

    Imported defensively: the worker Lambda bundle currently ships only
    ``arbiter/workerWrapper/`` (see the ``tools_config``/``workflow_contract``
    deferred-bundling notes elsewhere in this package), so
    ``arbiter/common/usage.py`` may not be present at runtime yet. We first
    try adding the project root to ``sys.path`` and importing the canonical
    module; if that fails we fall back to an inline mirror with the same
    contract so capture still works pending the bundling follow-up.
    """
    _here = os.path.dirname(os.path.abspath(__file__))
    _project_root = os.path.dirname(os.path.dirname(_here))
    if _project_root not in sys.path:
        sys.path.insert(0, _project_root)

    try:
        from common.usage import build_usage_record  # type: ignore[import-not-found]
        return build_usage_record
    except ImportError as exc:
        sys.stderr.write(
            f'[agent_runner] WARN canonical usage module unavailable, '
            f'using inline mirror: {exc}\n'
        )

        def _inline_build_usage_record(
            *, model_id, input_tokens, output_tokens, latency_ms,
            call_index, source, captured_at=None, total_tokens=None,
            bedrock_request_id=None,
        ):
            import datetime as _dt

            def _nn_int(value):
                try:
                    if isinstance(value, bool):
                        return 1 if value else 0
                    if isinstance(value, (int, float)):
                        if isinstance(value, float) and (value != value or value in (float('inf'), float('-inf'))):
                            return 0
                        coerced = int(value)
                    elif isinstance(value, str):
                        coerced = int(float(value.strip()))
                    else:
                        return 0
                except (TypeError, ValueError, OverflowError):
                    return 0
                return max(0, coerced)

            if source not in ('worker', 'supervisor'):
                raise ValueError(f'invalid usage record source {source!r}')

            record = {
                'modelId': model_id if isinstance(model_id, str) and model_id else '',
                'inputTokens': _nn_int(input_tokens),
                'outputTokens': _nn_int(output_tokens),
                'latencyMs': _nn_int(latency_ms),
                'callIndex': _nn_int(call_index),
                'capturedAt': captured_at or _dt.datetime.now(_dt.timezone.utc).isoformat(),
                'source': source,
            }
            if total_tokens is not None:
                record['totalTokens'] = _nn_int(total_tokens)
            if isinstance(bedrock_request_id, str) and bedrock_request_id:
                record['bedrockRequestId'] = bedrock_request_id
            return record

        return _inline_build_usage_record


def _extract_usage_from_response(resp):
    """Best-effort ``(inputTokens, outputTokens, totalTokens)`` extraction
    from a non-streaming Converse-shaped dict result. Never raises —
    returns ``(0, 0, None)`` on any non-conforming shape.
    """
    try:
        if not isinstance(resp, dict):
            return (0, 0, None)
        usage = resp.get('usage')
        if not isinstance(usage, dict):
            return (0, 0, None)

        def _nn_int(value):
            try:
                return max(0, int(value))
            except (TypeError, ValueError):
                return 0

        input_tokens = _nn_int(usage.get('inputTokens'))
        output_tokens = _nn_int(usage.get('outputTokens'))
        raw_total = usage.get('totalTokens')
        total_tokens = _nn_int(raw_total) if raw_total is not None else None
        return (input_tokens, output_tokens, total_tokens)
    except Exception as exc:  # noqa: BLE001 — extraction must never raise
        sys.stderr.write(
            f'[agent_runner] WARN usage extraction failed: {exc}\n'
        )
        return (0, 0, None)


def _extract_request_id_from_response(resp):
    """Best-effort Bedrock request-id extraction from a Converse-shaped
    dict result, per SDK: ``resp['ResponseMetadata']['RequestId']``.

    VERIFY-then-degrade: the installed strands version's dict result shape
    is not guaranteed to carry ``ResponseMetadata`` the way a raw boto3
    Converse response does (strands may wrap/strip it) — this extractor
    checks defensively for the field and returns ``None`` when absent,
    rather than assuming its presence. Never raises, never fabricates.
    """
    try:
        if not isinstance(resp, dict):
            return None
        metadata = resp.get('ResponseMetadata')
        if not isinstance(metadata, dict):
            return None
        request_id = metadata.get('RequestId')
        return request_id if isinstance(request_id, str) and request_id else None
    except Exception as exc:  # noqa: BLE001 — extraction must never raise
        sys.stderr.write(
            f'[agent_runner] WARN request-id extraction failed: {exc}\n'
        )
        return None


def _wrap_streaming_usage_capture(event_iterator, model_id, start_time, build_record):
    """Passthrough generator wrapping a streaming response iterator.

    Yields every event unchanged; inspects each event's ``metadata.usage``
    (when present) to capture usage at stream completion. Any inspection
    failure is swallowed with a WARN — the underlying stream is never
    disrupted by capture bookkeeping.
    """
    last_usage = None
    last_request_id = None
    try:
        for event in event_iterator:
            try:
                if isinstance(event, dict):
                    metadata = event.get('metadata')
                    if isinstance(metadata, dict) and isinstance(metadata.get('usage'), dict):
                        last_usage = metadata['usage']
                    # Per-event metadata may also carry response-metadata
                    # style request-id fields on some strands streaming
                    # shapes. Best-effort: keep the last non-empty id seen
                    # (mirrors last_usage's "last wins" semantics), never
                    # fabricated when absent.
                    extracted_id = _extract_request_id_from_response(
                        {'ResponseMetadata': metadata.get('ResponseMetadata')}
                        if isinstance(metadata, dict) and isinstance(metadata.get('ResponseMetadata'), dict)
                        else {}
                    )
                    if extracted_id:
                        last_request_id = extracted_id
            except Exception as exc:  # noqa: BLE001 — never break the stream
                sys.stderr.write(
                    f'[agent_runner] WARN streaming usage inspection failed: {exc}\n'
                )
            yield event
    finally:
        try:
            input_tokens, output_tokens, total_tokens = _extract_usage_from_response(
                {'usage': last_usage} if last_usage else {}
            )
            latency_ms = int((time.perf_counter() - start_time) * 1000)
            record = build_record(
                model_id=model_id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                latency_ms=latency_ms,
                call_index=len(_CAPTURED_USAGE),
                source='worker',
                total_tokens=total_tokens,
                bedrock_request_id=last_request_id,
            )
            _CAPTURED_USAGE.append(record)
        except Exception as exc:  # noqa: BLE001 — capture must never raise
            sys.stderr.write(
                f'[agent_runner] WARN streaming usage capture failed: {exc}\n'
            )


def _install_usage_capture():
    """Patch ``strands.models.BedrockModel``'s response-producing method to
    append a ``source='worker'`` usage record to the module-global
    ``_CAPTURED_USAGE`` list after every call.

    Discovers the seam method by name from ``_USAGE_CAPTURE_SEAM_CANDIDATES``
    to survive strands renames. Wraps both a non-streaming dict result and a
    streaming event iterator (inspected via a passthrough generator).
    Latency is timed with ``perf_counter``; ``model_id`` prefers the
    ``MODEL_OVERRIDE`` env var (mirroring ``_install_model_override``'s
    precedence) and falls back to the instance's ``model_id`` attribute.

    Every capture step is wrapped in ``except Exception`` -> WARN-to-stderr
    + continue. Capture must never raise into ``main()`` and must never
    alter the response returned to the caller.

    Graceful degrade when ``strands``/``BedrockModel`` cannot be imported,
    or when none of the candidate seam methods exist on ``BedrockModel``:
    WARN to stderr and return False.

    Returns True when the patch was installed, False otherwise.
    """
    try:
        import strands  # type: ignore[import-not-found]  # noqa: F401
        from strands import models as _sm
    except ImportError as exc:
        sys.stderr.write(
            f'[agent_runner] WARN usage capture skipped — '
            f'strands unavailable: {exc}\n'
        )
        return False

    Bedrock = getattr(_sm, 'BedrockModel', None)
    if Bedrock is None:
        sys.stderr.write(
            '[agent_runner] WARN usage capture skipped — '
            'strands.models.BedrockModel unavailable\n'
        )
        return False

    seam_name = None
    for candidate in _USAGE_CAPTURE_SEAM_CANDIDATES:
        if hasattr(Bedrock, candidate):
            seam_name = candidate
            break

    if seam_name is None:
        sys.stderr.write(
            '[agent_runner] WARN usage capture skipped — no known '
            f'response-producing method found on BedrockModel '
            f'(tried {_USAGE_CAPTURE_SEAM_CANDIDATES})\n'
        )
        return False

    build_record = _usage_builder()
    original_method = getattr(Bedrock, seam_name)

    def _capturing_method(self, *args, **kwargs):
        start_time = time.perf_counter()
        result = original_method(self, *args, **kwargs)

        try:
            model_id = os.environ.get('MODEL_OVERRIDE') or getattr(self, 'model_id', None) or ''
        except Exception as exc:  # noqa: BLE001 — never break the call
            sys.stderr.write(
                f'[agent_runner] WARN usage capture model_id lookup failed: {exc}\n'
            )
            model_id = ''

        # Streaming case: result is a generator/iterator, not a dict. Wrap
        # it in a passthrough generator that captures usage at completion
        # without altering the yielded events.
        if hasattr(result, '__next__') or (hasattr(result, '__iter__') and not isinstance(result, (dict, list, str, bytes))):
            return _wrap_streaming_usage_capture(result, model_id, start_time, build_record)

        try:
            input_tokens, output_tokens, total_tokens = _extract_usage_from_response(result)
            request_id = _extract_request_id_from_response(result)
            latency_ms = int((time.perf_counter() - start_time) * 1000)
            record = build_record(
                model_id=model_id,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                latency_ms=latency_ms,
                call_index=len(_CAPTURED_USAGE),
                source='worker',
                total_tokens=total_tokens,
                bedrock_request_id=request_id,
            )
            _CAPTURED_USAGE.append(record)
        except Exception as exc:  # noqa: BLE001 — capture must never raise
            sys.stderr.write(
                f'[agent_runner] WARN usage capture failed for non-streaming '
                f'response: {exc}\n'
            )

        return result

    setattr(Bedrock, seam_name, _capturing_method)
    return True


def _read_dispatch_generation():
    """Parse ``CITADEL_DISPATCH_GENERATION`` to an int, or None when unset/invalid.

    The step runner sets this only for a fenced workflow-node dispatch. A
    missing/non-integer value degrades to None -> the tool-call reserve is
    unfenced (exactly-once-within-attempt only), preserving back-compat for
    the supervisor task path and pre-fence dispatchers."""
    raw = os.environ.get('CITADEL_DISPATCH_GENERATION')
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _install_tool_call_hooks():
    """Install the SINGLE composed ``BeforeToolCallEvent`` seam that applies
    layer-2 tool governance THEN tool-call idempotency (finding 027c4a89).

    Replaces the two former independent ``strands.Agent.__init__`` patches
    (``_install_governed_tool_handler`` targeting the removed ``tool_handler``
    kwarg, and ``_install_idempotency_hook``). Those two installers were the
    root cause: idempotency was re-ported to the hooks API while governance
    still targeted the dead kwarg and silently went inert. One installer +
    one ``ComposedToolHook`` (one callback) makes divergence impossible.

    Two independent envelopes:
      * governance active  ⇔ ``CITADEL_AGENT_ID`` set (both dispatch paths).
      * idempotency active ⇔ ``CITADEL_EXECUTION_ID`` AND ``CITADEL_NODE_ID``
        set (workflow-node path). Idempotency-active ⟹ governance-active.

    Back-compat: when NEITHER envelope is present, this is a silent no-op
    (agents run outside any envelope are unchanged) and returns False.

    FAIL-LOUD (finding 027c4a89 step 4): inside an ACTIVE envelope, a control
    that cannot install must ABORT the node — never degrade to a warning. A
    silently-skipped control lets a node run UNPROTECTED while looking
    protected. This now applies to governance too, matching the rule already
    enforced for idempotency. Raising exits the subprocess non-zero, which the
    workflow-node dispatch (``run_agent_in_subprocess`` ``raise_on_error=True``)
    turns into ``workflow.node.failed``.

    Returns True when the composed hook was installed, False on back-compat
    no-op.
    """
    agent_id = os.environ.get('CITADEL_AGENT_ID')
    execution_id = os.environ.get('CITADEL_EXECUTION_ID')
    node_id = os.environ.get('CITADEL_NODE_ID')
    governance_active = bool(agent_id)
    idempotency_active = bool(execution_id and node_id)

    if not governance_active and not idempotency_active:
        return False

    # FAIL-LOUD: strands must be importable to install ANY active control.
    try:
        import strands  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            'tool-call governance/idempotency REQUIRED but strands is '
            'unavailable in the agent_runner subprocess while an active '
            'envelope is present (CITADEL_AGENT_ID and/or CITADEL_EXECUTION_ID'
            f'/CITADEL_NODE_ID set): {exc}'
        ) from exc

    _here = os.path.dirname(os.path.abspath(__file__))
    if _here not in sys.path:
        sys.path.insert(0, _here)

    governance = None
    if governance_active:
        # FAIL-LOUD: an uninstallable governance control inside its envelope
        # aborts the node (never a warning) — this is the finding-027c4a89 fix.
        try:
            from governance_tool_hook import GovernanceEvaluator
        except ImportError as exc:
            raise RuntimeError(
                'layer-2 tool governance REQUIRED but governance_tool_hook '
                'could not be imported in the agent_runner subprocess while a '
                'governance envelope is active (CITADEL_AGENT_ID set). This '
                'control must not silently disable itself — check that the '
                "ArbiterCatalogLayer 'governance'/'common' packages are on the "
                'subprocess PYTHONPATH (index.py propagates the parent '
                f'sys.path): {exc}'
            ) from exc
        governance = GovernanceEvaluator(
            agent_id=agent_id or 'unknown-agent',
            workflow_id=os.environ.get('CITADEL_WORKFLOW_ID', 'unknown-workflow'),
            # ``denied_tools=None`` → read DENIED_TOOLS from env (single
            # env-parsing source of truth; the worker already merges static
            # deny-list + per-run forbiddenTools into DENIED_TOOLS).
            denied_tools=None,
            eval_run_id=os.environ.get('CITADEL_EVAL_RUN_ID') or None,
        )

    idempotency = None
    if idempotency_active:
        # FAIL-LOUD idempotency (unchanged intent from the former
        # _install_idempotency_hook): a fail-closed security control that
        # silently degrades would let a node duplicate side effects across a
        # watchdog re-dispatch while looking protected.
        try:
            from tool_idempotency_hook import IdempotencyToolHook
        except ImportError as exc:
            raise RuntimeError(
                'idempotency hook REQUIRED but tool_idempotency_hook could not '
                'be imported in the agent_runner subprocess while an '
                'idempotency envelope is active. This fail-closed security '
                'control must not silently disable itself — check that the '
                "ArbiterCatalogLayer 'governance'/'common' packages are on the "
                'subprocess PYTHONPATH (index.py propagates the parent '
                'sys.path) and that the worker bundle ships '
                f'tool_idempotency/tool_idempotency_hook: {exc}'
            ) from exc
        idempotency = IdempotencyToolHook(
            org_id=os.environ.get('CITADEL_ORG_ID', ''),
            execution_id=execution_id or '',
            node_id=node_id or '',
            dispatch_generation=_read_dispatch_generation(),
        )

    # The composed hook lives with the idempotency seam so both concerns share
    # one module and one BeforeToolCallEvent callback.
    try:
        from tool_idempotency_hook import ComposedToolHook
    except ImportError as exc:
        raise RuntimeError(
            'composed tool hook REQUIRED but tool_idempotency_hook could not '
            'be imported in the agent_runner subprocess while an active '
            f'envelope is present: {exc}'
        ) from exc

    composed = ComposedToolHook(governance=governance, idempotency=idempotency)

    original_init = strands.Agent.__init__

    def _hooked_init(self, *args, **kwargs):
        existing = kwargs.get('hooks')
        if existing is None:
            kwargs['hooks'] = [composed]
        elif isinstance(existing, list):
            kwargs['hooks'] = [*existing, composed]
        # A non-list caller hooks value is left untouched — strands validates
        # it; we never overwrite caller intent.
        return original_init(self, *args, **kwargs)

    strands.Agent.__init__ = _hooked_init
    return True


def _install_model_override():
    """Patch ``strands.models.BedrockModel.__init__`` to force ``model_id``.

    Overrides the model id for operator-selected per-agent overrides; a no-op
    unless ``MODEL_OVERRIDE`` is set in the subprocess environment. Runs inside
    the subprocess before the agent module is exec'd, so every ``BedrockModel``
    construction in the loaded module picks up the operator-selected id.

    Graceful degrade when ``strands`` (or its ``models`` submodule) cannot be
    imported, or when ``BedrockModel`` is absent: WARN to stderr and return
    False. A missing override layer must never halt an otherwise-valid agent.

    Returns True when the patch was installed, False otherwise.
    """
    override = os.environ.get('MODEL_OVERRIDE')
    if not override:
        return False

    try:
        import strands  # type: ignore[import-not-found]  # noqa: F401
        from strands import models as _sm
    except ImportError as exc:
        sys.stderr.write(
            f'[agent_runner] WARN model override skipped — '
            f'strands unavailable: {exc}\n'
        )
        return False

    Bedrock = getattr(_sm, 'BedrockModel', None)
    if Bedrock is None:
        return False

    original_init = Bedrock.__init__

    def _override_init(self, *args, **kwargs):
        kwargs['model_id'] = override
        return original_init(self, *args, **kwargs)

    Bedrock.__init__ = _override_init
    return True


def _drain_governance_refusals() -> list:
    """Drain the tool-call governance/infrastructure refusal sink (finding
    be80ccd7).

    The refusals are recorded by ``tool_idempotency_hook`` when the ledger gate
    raises a ``LedgerError`` during a tool call (strands swallows it into an
    error ToolResult, so the turn completes normally). Imported defensively:
    if the hook module is unavailable in this environment there can be no
    recorded refusals, so degrade to an empty list rather than failing the run.
    """
    try:
        from tool_idempotency_hook import drain_governance_refusals
    except ImportError:
        return []
    try:
        return drain_governance_refusals()
    except Exception as exc:  # noqa: BLE001 — draining must never break dispatch
        sys.stderr.write(
            f'[agent_runner] WARN governance-refusal drain failed: {exc}\n'
        )
        return []


def main():
    # Read input from stdin (single JSON line)
    raw = sys.stdin.read()
    payload = json.loads(raw)

    module_path = payload['modulePath']
    request = payload.get('request', {})

    # Reset the per-process usage sink. In the real Lambda subprocess each
    # main() invocation IS the process lifetime (one exec per subprocess),
    # so this is a no-op in production; it exists so tests that call main()
    # repeatedly within one interpreter (or re-run this module) get a fresh
    # 0-based callIndex sequence each time rather than accumulating state.
    _CAPTURED_USAGE.clear()

    # Reset the per-process governance/infrastructure REFUSAL sink (finding
    # be80ccd7) so repeated in-process main() calls in tests start clean, and
    # so the post-turn drain below only ever observes THIS run's refusals. In
    # the real one-exec-per-process Lambda subprocess this is a no-op. Kept from
    # #84 because #84's post-turn refusal-drain machinery (build_refusal_envelope
    # + the drain block after module.handler) is part of this merged file.
    _drain_governance_refusals()

    # Install the SINGLE composed tool-call seam (finding 027c4a89): layer-2
    # tool governance THEN tool-call idempotency, at one BeforeToolCallEvent
    # callback, patched onto strands.Agent.__init__ BEFORE exec_module so every
    # Agent(...) in the loaded module picks it up. No-op when neither the
    # governance envelope (CITADEL_AGENT_ID) nor the idempotency envelope
    # (CITADEL_EXECUTION_ID + CITADEL_NODE_ID) is present. FAIL-LOUD (raises)
    # when an active envelope's control cannot install.
    #
    # MERGE (#84 ⋈ #85): this REPLACES the two former independent installers
    # (_install_governed_tool_handler + _install_idempotency_hook) that #84
    # called here. #85 removed those functions entirely: governance targeted the
    # strands 1.30.0-removed ``tool_handler`` kwarg and silently went inert,
    # which is the very defect finding 027c4a89 fixes. The refusal machinery
    # #84 added (build_refusal_envelope, the LedgerError catch in
    # tool_idempotency_hook, the post-turn drain) is ORTHOGONAL to which
    # installer runs and is preserved unchanged — an infrastructure LedgerError
    # from reserve/finalize still fails the node, while an intentional
    # governance POLICY denial (deny-before-reserve, no LedgerError, no ledger
    # row) completes the node with a durable DENY GovernanceFinding. See the
    # node-status decision documented on ComposedToolHook in
    # tool_idempotency_hook.py.
    _install_tool_call_hooks()

    # Overrides the model id for operator-selected per-agent overrides;
    # no-op unless MODEL_OVERRIDE is set in the subprocess environment.
    _install_model_override()

    # Wraps BedrockModel's response-producing method to capture per-call
    # token usage/latency into _CAPTURED_USAGE; degrades to a no-op (WARN
    # to stderr) when strands/BedrockModel/the seam method are unavailable.
    # Never alters the response and never raises into main().
    _install_usage_capture()

    # Load and execute the agent module
    spec = importlib.util.spec_from_file_location("agent_module", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    try:
        response = module.handler(**request)
    except Exception as exc:  # noqa: BLE001 — mapped to a failure envelope below
        # DEFECT FIX (finding 56d763d4): an agent-body exception must NOT be
        # laundered into a successful ``response`` string. The old code did
        # ``response = f"Agent execution failed: {e}"`` and fell through to the
        # success print with exit 0, so the worker recorded a crashed run as
        # ``node.completed`` and the execution finalized ``completed`` —
        # starving retry.py's failure-class logic, the durable-execution
        # watchdog, and every downstream pass/fail consumer.
        #
        # Instead emit a FAILURE-MARKED envelope carrying the exception CLASS
        # (for retry classification) + the diagnostic message, and exit
        # non-zero. The marker is the structural signal the parent keys on to
        # raise regardless of raise_on_error, so no caller can turn a marked
        # payload into a completed result.
        sys.stdout.write(json.dumps(build_failure_envelope(exc, _CAPTURED_USAGE)))
        sys.stdout.flush()
        sys.exit(1)

    # The turn COMPLETED normally, but a tool call may have hit a governance /
    # infrastructure REFUSAL (a LedgerError from the idempotency/ledger gate)
    # that strands swallowed into an error-status ToolResult (finding
    # be80ccd7). Drain the refusal sink and, if any were recorded, emit a
    # failure-marked envelope INSTEAD of the success response so the node fails
    # with the refusal class (fed to retry.py) rather than being laundered into
    # node.completed. Domain-level tool errors record NO refusal and fall
    # through to the normal success envelope below.
    refusals = _drain_governance_refusals()
    if refusals:
        sys.stdout.write(json.dumps(build_refusal_envelope(refusals, _CAPTURED_USAGE)))
        sys.stdout.flush()
        sys.exit(1)

    # Write response as JSON to stdout. 'usage' is additive: an empty list
    # is legal and simply means no BedrockModel call was captured this run.
    print(json.dumps({"response": str(response), "usage": _CAPTURED_USAGE}))


if __name__ == "__main__":
    main()
