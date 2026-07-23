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
