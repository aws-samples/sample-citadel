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


def _install_governed_tool_handler():
    """Patch ``strands.Agent.__init__`` to inject a GovernedToolHandler.

    Runs inside the subprocess before the agent module is exec'd, so every
    ``Agent(...)`` construction inside the loaded module automatically
    picks up governance enforcement at tool-call time (QD-5 layer 2,
    ``scope_evaluated='worker-tool-handler'``).

    No-op when ``CITADEL_AGENT_ID`` is not set in the environment — that
    preserves backward compatibility with agents running outside the
    governance envelope (local dev, legacy callers).

    Graceful degrade when ``strands`` or ``governed_tool_handler`` cannot
    be imported: WARN to stderr and return False. Best-effort semantics
    (AC 9.4) mean a missing layer-2 handler must not halt execution of
    an otherwise-valid agent.

    Caller-supplied ``tool_handler=...`` on ``Agent(...)`` always wins —
    the injector only fills in the default. This preserves the escape
    hatch for agents that ship their own policy surface.

    Returns True when the patch was installed, False otherwise.
    """
    if not os.environ.get('CITADEL_AGENT_ID'):
        return False

    try:
        import strands  # type: ignore[import-not-found]
    except ImportError as exc:
        sys.stderr.write(
            f'[agent_runner] WARN governance injection skipped — '
            f'strands unavailable: {exc}\n'
        )
        return False

    # governed_tool_handler lives alongside this file in
    # arbiter/workerWrapper/. Its own module-load logic wires the project
    # root onto sys.path so ``arbiter.governance.*`` imports inside the
    # handler resolve correctly.
    _here = os.path.dirname(os.path.abspath(__file__))
    if _here not in sys.path:
        sys.path.insert(0, _here)

    try:
        from governed_tool_handler import GovernedToolHandler
    except ImportError as exc:
        sys.stderr.write(
            f'[agent_runner] WARN governance injection skipped — '
            f'governed_tool_handler unavailable: {exc}\n'
        )
        return False

    original_init = strands.Agent.__init__

    def _governed_init(self, *args, **kwargs):
        # Caller-supplied handler always wins — never override an explicit
        # tool_handler= in generated code.
        if 'tool_handler' not in kwargs or kwargs['tool_handler'] is None:
            kwargs['tool_handler'] = GovernedToolHandler(
                agent_id=os.environ.get('CITADEL_AGENT_ID', 'unknown-agent'),
                workflow_id=os.environ.get('CITADEL_WORKFLOW_ID', 'unknown-workflow'),
                # ``denied_tools=None`` lets GovernedToolHandler read
                # DENIED_TOOLS from env itself, keeping a single source of
                # truth for env parsing semantics. DENIED_TOOLS itself
                # already carries the union of static deny-list entries
                # and any per-run forbiddenTools (CIT-102 Pass B) — see
                # worker_governance.build_subprocess_env, which merges
                # them before setting the env var.
                denied_tools=None,
                # CIT-102 Pass B: per-run eval-context correlation id.
                # None (the trigger is absent) for every non-eval
                # invocation — GovernedToolHandler treats None
                # byte-identically to its pre-CIT-102 behavior.
                eval_run_id=os.environ.get('CITADEL_EVAL_RUN_ID') or None,
            )
        return original_init(self, *args, **kwargs)

    strands.Agent.__init__ = _governed_init
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


def _install_idempotency_hook():
    """Patch ``strands.Agent.__init__`` to attach an idempotency HookProvider.

    Tool-call idempotency (PR1). Uses the ONLY tool-call extension surface the
    pinned ``strands-agents==1.30.0`` actually exposes: the hooks system
    (``Agent(hooks=[...])`` + ``BeforeToolCallEvent``). Verified against the
    1.30.0 source — that release has NO ``strands.handlers.tool_handler``
    /``AgentToolHandler`` and ``Agent.__init__`` accepts neither
    ``tool_handler`` nor ``**kwargs``; it does accept ``hooks``. We therefore
    APPEND an ``IdempotencyToolHook`` to whatever ``hooks`` list the caller
    passed (never clobbering caller-supplied hooks).

    No-op unless BOTH ``CITADEL_EXECUTION_ID`` and ``CITADEL_NODE_ID`` are set
    (back-compat: an agent run outside the idempotency envelope is unchanged).
    ``CITADEL_ORG_ID`` is optional (empty -> shared org prefix; executionId is
    still globally unique) and is read ONLY from the trusted subprocess env
    that the worker set server-side, never from tool/agent input.

    Graceful degrade (WARN, return False) when strands or the hook module
    cannot be imported — a missing idempotency layer must never halt an
    otherwise-valid agent.

    Returns True when the patch was installed, False otherwise.
    """
    if not (os.environ.get('CITADEL_EXECUTION_ID') and os.environ.get('CITADEL_NODE_ID')):
        return False

    try:
        import strands  # type: ignore[import-not-found]
    except ImportError as exc:
        sys.stderr.write(
            f'[agent_runner] WARN idempotency hook skipped — '
            f'strands unavailable: {exc}\n'
        )
        return False

    _here = os.path.dirname(os.path.abspath(__file__))
    if _here not in sys.path:
        sys.path.insert(0, _here)

    try:
        from tool_idempotency_hook import IdempotencyToolHook
    except ImportError as exc:
        sys.stderr.write(
            f'[agent_runner] WARN idempotency hook skipped — '
            f'tool_idempotency_hook unavailable: {exc}\n'
        )
        return False

    original_init = strands.Agent.__init__

    def _idempotent_init(self, *args, **kwargs):
        hook = IdempotencyToolHook(
            org_id=os.environ.get('CITADEL_ORG_ID', ''),
            execution_id=os.environ.get('CITADEL_EXECUTION_ID', ''),
            node_id=os.environ.get('CITADEL_NODE_ID', ''),
            dispatch_generation=_read_dispatch_generation(),
        )
        existing = kwargs.get('hooks')
        if existing is None:
            kwargs['hooks'] = [hook]
        elif isinstance(existing, list):
            kwargs['hooks'] = [*existing, hook]
        # If a caller passed a non-list hooks value we leave it untouched —
        # strands will validate it; we never overwrite caller intent.
        return original_init(self, *args, **kwargs)

    strands.Agent.__init__ = _idempotent_init
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

    # Install governance patch BEFORE exec_module so every Agent(...)
    # construction in the loaded module picks it up. Safe no-op when the
    # subprocess env lacks CITADEL_AGENT_ID (backward compatible).
    _install_governed_tool_handler()

    # Install the tool-call idempotency hook (PR1) via the strands hooks
    # system — no-op unless CITADEL_EXECUTION_ID + CITADEL_NODE_ID are set.
    _install_idempotency_hook()

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

    # Write response as JSON to stdout. 'usage' is additive: an empty list
    # is legal and simply means no BedrockModel call was captured this run.
    print(json.dumps({"response": str(response), "usage": _CAPTURED_USAGE}))


if __name__ == "__main__":
    main()
