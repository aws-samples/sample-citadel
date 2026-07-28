"""Shared Bedrock Converse response parsing helpers."""
import logging
import time

from tools.usage import UsageCallCounter, build_usage_record, extract_converse_usage, extract_request_id

logger = logging.getLogger(__name__)

# Monotonic call-index counter shared by every direct bedrock.converse()
# caller that routes through this module (extract.py, design.py) — mirrors
# the arbiter convention of a 0-based per-process callIndex.
_call_counter = UsageCallCounter()


def capture_converse_usage(resp: dict, model_id: str, session_id: str, started_at: float | None = None) -> dict:
    """Build a ``source="intake"`` usage record for a completed
    ``bedrock.converse()`` call and emit it onto the ``agent_intake.usage``
    EventBridge namespace, attributed to ``session_id``.

    This is the single shared extraction point for all direct
    ``bedrock.converse()`` callers (extract.py, design.py) — call it right
    after ``bedrock.converse()`` returns, alongside ``extract_text``.
    Defensive by contract: never raises, so a malformed response or an
    EventBridge publish failure can never break the calling tool's turn.
    """
    try:
        input_tokens, output_tokens = extract_converse_usage(resp)
        latency_ms = int((time.monotonic() - started_at) * 1000) if started_at is not None else 0
        record = build_usage_record(
            model_id=model_id,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_ms=latency_ms,
            call_index=_call_counter.next(),
            bedrock_request_id=extract_request_id(resp),
        )
        from tools.state import publish_usage_event  # local import avoids a
        # module-load-time cycle (state.py doesn't import converse_utils).
        publish_usage_event(session_id, record)
        return record
    except Exception as exc:  # noqa: BLE001 — usage capture must never break a turn
        logger.warning("converse_utils: usage capture failed: %s", exc)
        return {}


def extract_text(resp: dict) -> str:
    """Return the first text block from a Bedrock Converse response, stripped.

    Reasoning-enabled models prepend a reasoningContent block to
    output.message.content, so content[0] is not guaranteed to carry a
    'text' key — the old ``resp['output']['message']['content'][0]['text']``
    idiom raised KeyError: 'text'. This iterates the content blocks and
    returns the first one that has 'text', skipping reasoningContent,
    toolUse, and any other block types.

    Args:
        resp: The raw bedrock.converse() response dict.

    Returns:
        The first text block's content, stripped of surrounding whitespace.

    Raises:
        ValueError: When no text block exists (never KeyError), naming the
            block types that were found so the failure is diagnosable.
    """
    content = ((resp.get("output") or {}).get("message") or {}).get("content") or []
    for block in content:
        if isinstance(block, dict) and "text" in block:
            return block["text"].strip()
    block_types = [
        ", ".join(sorted(block.keys())) if isinstance(block, dict) else type(block).__name__
        for block in content
    ]
    raise ValueError(
        "No text block in Converse response output.message.content; "
        f"found block types: {block_types if block_types else '(empty content)'}"
    )
