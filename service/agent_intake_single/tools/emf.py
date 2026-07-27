"""Per-turn CloudWatch EMF emitter for the intake agent (Wave 0 baseline).

OBSERVABILITY ONLY. Each flush is a structured-JSON line on stdout carrying
the ``_aws.CloudWatchMetrics`` envelope; the AgentCore runtime ships stdout to
CloudWatch Logs, where EMF becomes metrics automatically.

Layout per completed turn:
- ONE turn-level line (namespace ``Citadel/Intake``, dimension ``Environment``):
  TurnDuration_ms, ModelRoundTrips (strands event-loop cycle count), ToolCalls,
  InputTokens/OutputTokens and CacheReadInputTokens/CacheWriteInputTokens when
  present.
- One additional small line per distinct tool used, with ``Tool`` as a second
  dimension and ToolDuration_ms as the metric. The EMF spec permits only one
  value per dimension key per log event, so per-tool entries cannot share the
  turn line; the ~27 intake tool names are a fixed set, keeping the dimension
  bounded.

High-cardinality identifiers (session_id) ride as EMF *properties* — top-level
log fields that never become dimensions.

Extraction targets the installed strands-agents 1.30.0 API
(``AgentResult.metrics`` → ``EventLoopMetrics`` with ``cycle_count: int``,
``tool_metrics: dict[str, ToolMetrics]`` (``call_count``, ``total_time``
seconds) and ``accumulated_usage`` (``inputTokens``/``outputTokens`` plus
optional cache token counts)) and is fully defensive: missing or malformed
fields emit nothing, and the emitter NEVER raises — metrics must never break
the conversation turn.
"""
import json
import logging
import math
import os
import time

logger = logging.getLogger(__name__)

NAMESPACE = "Citadel/Intake"

_TURN_METRIC_UNITS = {
    "TurnDuration_ms": "Milliseconds",
    "ModelRoundTrips": "Count",
    "ToolCalls": "Count",
    "InputTokens": "Count",
    "OutputTokens": "Count",
    "CacheReadInputTokens": "Count",
    "CacheWriteInputTokens": "Count",
}

_USAGE_KEY_MAP = (
    ("inputTokens", "InputTokens"),
    ("outputTokens", "OutputTokens"),
    ("cacheReadInputTokens", "CacheReadInputTokens"),
    ("cacheWriteInputTokens", "CacheWriteInputTokens"),
)


def _is_metric_number(value):
    """True for finite ints/floats; bools are explicitly excluded."""
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _extract_result_metrics(agent_result):
    """Defensively pull turn metrics off a strands ``AgentResult``.

    Returns ``(turn_metrics, tool_durations_ms)`` where both are dicts; any
    missing or malformed field is simply skipped. Never raises.
    """
    turn = {}
    tools = {}
    if agent_result is None:
        return turn, tools
    try:
        metrics = getattr(agent_result, "metrics", None)
        if metrics is None:
            return turn, tools

        cycle_count = getattr(metrics, "cycle_count", None)
        if _is_metric_number(cycle_count):
            turn["ModelRoundTrips"] = cycle_count

        tool_metrics = getattr(metrics, "tool_metrics", None)
        if isinstance(tool_metrics, dict):
            total_calls = 0
            for name, tool in tool_metrics.items():
                call_count = getattr(tool, "call_count", None)
                if _is_metric_number(call_count):
                    total_calls += int(call_count)
                total_time = getattr(tool, "total_time", None)
                if isinstance(name, str) and name and _is_metric_number(total_time):
                    tools[name] = float(total_time) * 1000.0  # seconds → ms
            turn["ToolCalls"] = total_calls

        usage = getattr(metrics, "accumulated_usage", None)
        if isinstance(usage, dict):
            for source_key, metric_name in _USAGE_KEY_MAP:
                value = usage.get(source_key)
                if _is_metric_number(value):
                    turn[metric_name] = value
    except Exception as exc:  # noqa: BLE001 — metrics must never break the turn
        logger.warning("emf: metric extraction failed: %s", exc)
    return turn, tools


def _emit_blob(metric_units, values, dimensions, properties):
    """Print one EMF line. ``metric_units`` maps metric name → unit."""
    blob = {}
    blob.update(properties)
    blob.update(dimensions)
    blob.update(values)
    blob["_aws"] = {
        "Timestamp": int(time.time() * 1000),
        "CloudWatchMetrics": [
            {
                "Namespace": NAMESPACE,
                "Dimensions": [list(dimensions.keys())],
                "Metrics": [
                    {"Name": name, "Unit": metric_units[name]} for name in values
                ],
            }
        ],
    }
    print(json.dumps(blob))


def emit_turn_metrics(session_id, turn_duration_ms, agent_result=None):
    """Emit the per-turn EMF lines for a completed intake turn. Never raises."""
    try:
        environment = os.getenv("ENVIRONMENT", "dev")
        properties = {"session_id": str(session_id)} if session_id is not None else {}

        turn_values = {}
        if _is_metric_number(turn_duration_ms):
            turn_values["TurnDuration_ms"] = float(turn_duration_ms)
        extracted, tool_durations = _extract_result_metrics(agent_result)
        turn_values.update(extracted)

        if turn_values:
            _emit_blob(
                _TURN_METRIC_UNITS,
                turn_values,
                {"Environment": environment},
                properties,
            )

        for tool_name, duration_ms in tool_durations.items():
            _emit_blob(
                {"ToolDuration_ms": "Milliseconds"},
                {"ToolDuration_ms": duration_ms},
                {"Environment": environment, "Tool": tool_name},
                properties,
            )
    except Exception as exc:  # noqa: BLE001 — metrics must never break the turn
        try:
            logger.warning("emf: emit failed: %s", exc)
        except Exception:
            pass


def capture_turn_usage(session_id, turn_duration_ms, agent_result=None):
    """Capture per-turn model usage from the strands ``AgentResult`` and
    publish it as a ``source="intake"`` usage record.

    Reuses the same defensive ``_extract_result_metrics`` extraction seam as
    ``emit_turn_metrics`` (``AgentResult.metrics.accumulated_usage``) rather
    than adding a second parallel hook into the strands event loop — the
    strands Agent doesn't expose a per-call-index breakdown for the
    conversational loop the way the direct ``bedrock.converse()`` call sites
    do, so this captures one usage record per completed TURN (call_index is
    always 0 for this source's per-turn granularity) rather than per
    underlying model round trip. Defensive: never raises, so a malformed
    result or a publish failure can never break the conversation turn.
    """
    try:
        extracted, _tool_durations = _extract_result_metrics(agent_result)
        input_tokens = extracted.get("InputTokens")
        output_tokens = extracted.get("OutputTokens")
        if input_tokens is None and output_tokens is None:
            return  # nothing to report — e.g. no result event, or no usage on it
        model_id = ""
        try:
            from config import get_agent_model_id
            model_id = get_agent_model_id()
        except Exception as model_id_exc:  # noqa: BLE001 — fallback must never break the turn
            logger.warning(
                "emf: model id resolution failed, using empty modelId: %s",
                model_id_exc,
            )
        from tools.usage import build_usage_record
        # No per-call bedrockRequestId is available on this seam: strands'
        # AgentResult.metrics.accumulated_usage is a per-TURN rollup (see
        # module docstring), not a per-underlying-model-call boundary, so
        # there is no single ResponseMetadata.RequestId to attribute here.
        # Passing None (never fabricating) keeps this honest — the key is
        # simply omitted from the resulting record.
        record = build_usage_record(
            model_id=model_id,
            input_tokens=input_tokens or 0,
            output_tokens=output_tokens or 0,
            latency_ms=turn_duration_ms,
            call_index=0,
            bedrock_request_id=None,
        )
        from tools.state import publish_usage_event
        publish_usage_event(session_id, record)
    except Exception as exc:  # noqa: BLE001 — usage capture must never break the turn
        logger.warning("emf: turn usage capture failed: %s", exc)
