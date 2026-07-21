"""Tests for _extract_resourcing_inputs robustness (live incident: 14
consecutive failures).

Contract under test (tools/design.py):
  - The Converse parser selects the TEXT content block, skipping
    reasoningContent blocks; when NO text block exists it retries ONCE
    requesting plain output, then returns a structured tool error (never an
    uncaught exception).
  - stopReason is respected: on max_tokens the body is truncated — the call
    retries ONCE with a higher token budget and NEVER json.loads a truncated
    body.
  - The base call budget is 4096 tokens (the old 2048 caused live truncation).
  - JSON extraction is balanced-brace (not greedy regex) and JSONDecodeError
    is converted to a structured retryable tool error.

Run with: PYTHONPATH=. pytest tests/test_resourcing_inference.py -q
from service/agent_intake_single.
"""
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

VALID_JSON = '{"agents": [{"name": "a", "size": "S", "reason": "r"}], "integrations": [], "hitl_points": 2}'

TEMPLATE = {
    "agent_sizing_criteria": {"S": "s", "M": "m", "L": "l"},
    "integration_sizing_criteria": {"S": "s", "M": "m", "L": "l"},
}


def _text_response(text, stop_reason="end_turn"):
    return {
        "output": {"message": {"content": [{"text": text}]}},
        "stopReason": stop_reason,
    }


def _reasoning_only_response(stop_reason="end_turn"):
    return {
        "output": {
            "message": {
                "content": [{"reasoningContent": {"reasoningText": {"text": "thinking..."}}}]
            }
        },
        "stopReason": stop_reason,
    }


def _reasoning_then_text_response(text, stop_reason="end_turn"):
    """Reasoning-enabled models prepend reasoningContent before the text block."""
    return {
        "output": {
            "message": {
                "content": [
                    {"reasoningContent": {"reasoningText": {"text": "thinking..."}}},
                    {"text": text},
                ]
            }
        },
        "stopReason": stop_reason,
    }


def _run(converse_side_effect):
    """Invoke _extract_resourcing_inputs with a mocked bedrock + S3 + template."""
    import tools.design as design

    mock_bedrock = MagicMock()
    if isinstance(converse_side_effect, list):
        mock_bedrock.converse.side_effect = converse_side_effect
    else:
        mock_bedrock.converse.return_value = converse_side_effect

    with patch.object(design, "bedrock", mock_bedrock), \
         patch.object(design, "get_agent_model_id", return_value="model-x"), \
         patch.object(design, "s3_get", return_value="section text"), \
         patch.object(design, "_load_resourcing_template", return_value=TEMPLATE):
        result = design._extract_resourcing_inputs("sess-1")
    return result, mock_bedrock


class TestHappyPath:
    def test_parses_json_from_text_block(self):
        result, bedrock = _run(_text_response(VALID_JSON))
        assert result["agents"] == [{"name": "a", "size": "S", "reason": "r"}]
        assert result["hitl_points"] == 2
        assert bedrock.converse.call_count == 1

    def test_base_call_uses_4096_token_budget(self):
        _, bedrock = _run(_text_response(VALID_JSON))
        cfg = bedrock.converse.call_args.kwargs["inferenceConfig"]
        assert cfg["maxTokens"] == 4096

    def test_text_block_selected_when_reasoning_block_precedes_it(self):
        result, bedrock = _run(_reasoning_then_text_response(VALID_JSON))
        assert result["hitl_points"] == 2
        assert bedrock.converse.call_count == 1


class TestNoTextBlock:
    def test_reasoning_only_response_retries_once_requesting_plain_output(self):
        result, bedrock = _run(
            [_reasoning_only_response(), _text_response(VALID_JSON)]
        )
        assert bedrock.converse.call_count == 2
        assert result["hitl_points"] == 2
        # The retry must explicitly steer the model back to plain text output.
        retry_prompt = bedrock.converse.call_args_list[1].kwargs["messages"][0]["content"][0]["text"]
        assert "plain text" in retry_prompt.lower() or "only" in retry_prompt.lower()

    def test_reasoning_only_twice_returns_structured_error(self):
        result, bedrock = _run(
            [_reasoning_only_response(), _reasoning_only_response()]
        )
        assert bedrock.converse.call_count == 2
        err = result["error"]
        assert err["retryable"] is True
        # Copy rules: what changed (nothing), one plain reason, one next action.
        assert "nothing" in err["what_changed"].lower()
        assert err["reason"]
        assert err["next_action"]


class TestTruncation:
    TRUNCATED = '{"agents": [{"name": "a", "size": "S"'

    def test_max_tokens_stop_reason_retries_once_with_higher_budget(self):
        result, bedrock = _run(
            [
                _text_response(self.TRUNCATED, stop_reason="max_tokens"),
                _text_response(VALID_JSON),
            ]
        )
        assert bedrock.converse.call_count == 2
        first = bedrock.converse.call_args_list[0].kwargs["inferenceConfig"]["maxTokens"]
        second = bedrock.converse.call_args_list[1].kwargs["inferenceConfig"]["maxTokens"]
        assert second > first
        assert result["hitl_points"] == 2

    def test_truncated_twice_returns_clean_error_without_exception(self):
        # Never json.loads a truncated body — the old code raised
        # JSONDecodeError here.
        result, bedrock = _run(
            [
                _text_response(self.TRUNCATED, stop_reason="max_tokens"),
                _text_response(self.TRUNCATED, stop_reason="max_tokens"),
            ]
        )
        assert bedrock.converse.call_count == 2
        assert result["error"]["retryable"] is True


class TestBalancedBraceExtraction:
    def test_trailing_garbage_with_stray_brace_still_parses(self):
        # The old greedy r'\{.*\}' regex spans to the LAST '}' — with a stray
        # trailing brace json.loads raised an uncaught JSONDecodeError.
        text = f"Here is the JSON:\n{VALID_JSON}\nHope this helps }} :)"
        result, _ = _run(_text_response(text))
        assert result["hitl_points"] == 2

    def test_malformed_json_returns_retryable_error_not_exception(self):
        result, _ = _run(_text_response('{"agents": [unquoted}'))
        err = result["error"]
        assert err["retryable"] is True
        assert err["next_action"]

    def test_no_json_object_returns_structured_error(self):
        result, _ = _run(_text_response("I could not produce the data."))
        assert "error" in result
        assert result["error"]["retryable"] is True

    def test_unbalanced_body_never_returns_partial_inner_object(self):
        # A truncated top-level object contains small balanced inner objects
        # ({"name": "a"...}); extraction must NOT silently return one of those.
        text = '{"agents": [{"name": "a", "size": "S"}, {"name": "b"'
        result, _ = _run(_text_response(text))
        assert "error" in result
