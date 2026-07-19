"""
Tests for tools/converse_utils.extract_text — guarded Bedrock Converse parsing.

Reasoning-enabled models prepend a reasoningContent block to
output.message.content, so content[0] has no 'text' key and the old
unguarded `resp['output']['message']['content'][0]['text']` idiom raised
KeyError: 'text'. extract_text must return the first block that carries
'text' (stripped), skipping reasoningContent/toolUse/other blocks, and
raise a clear ValueError (never KeyError) naming the block types found
when no text block exists.

Also includes one integration-shaped test per consuming module
(fabricate / plan / design / extract) proving each call site survives a
reasoningContent-first response.

Run with:
    PYTHONPATH=. pytest tests/test_converse_utils.py -q
from the service/agent_intake_single directory.
"""
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _resp(content_blocks: list) -> dict:
    """Build a minimal Converse response with the given content blocks."""
    return {"output": {"message": {"role": "assistant", "content": content_blocks}}}


REASONING_BLOCK = {
    "reasoningContent": {"reasoningText": {"text": "thinking about it..."}}
}
TOOL_USE_BLOCK = {"toolUse": {"toolUseId": "t1", "name": "some_tool", "input": {}}}


# ---------------------------------------------------------------------------
# Unit tests — extract_text
# ---------------------------------------------------------------------------

class TestExtractText:
    def test_text_only_content_returns_stripped_text(self):
        from tools.converse_utils import extract_text
        assert extract_text(_resp([{"text": "  hello world \n"}])) == "hello world"

    def test_reasoning_content_first_then_text_returns_text(self):
        # THE bug: content[0] is reasoningContent, text is second.
        from tools.converse_utils import extract_text
        resp = _resp([REASONING_BLOCK, {"text": " the answer "}])
        assert extract_text(resp) == "the answer"

    def test_skips_tool_use_and_other_unknown_blocks(self):
        from tools.converse_utils import extract_text
        resp = _resp([REASONING_BLOCK, TOOL_USE_BLOCK, {"somethingNew": {}}, {"text": "ok"}])
        assert extract_text(resp) == "ok"

    def test_no_text_block_raises_value_error_naming_block_types(self):
        from tools.converse_utils import extract_text
        resp = _resp([REASONING_BLOCK, TOOL_USE_BLOCK])
        with pytest.raises(ValueError) as exc_info:
            extract_text(resp)
        msg = str(exc_info.value)
        assert "reasoningContent" in msg
        assert "toolUse" in msg

    def test_empty_content_list_raises_value_error(self):
        from tools.converse_utils import extract_text
        with pytest.raises(ValueError):
            extract_text(_resp([]))


# ---------------------------------------------------------------------------
# Integration-shaped tests — one per consuming module, each with a mocked
# converse response whose first content block is reasoningContent.
# ---------------------------------------------------------------------------

def _mock_bedrock(text: str) -> mock.MagicMock:
    client = mock.MagicMock()
    client.converse.return_value = _resp([REASONING_BLOCK, {"text": text}])
    return client


class TestConsumingModulesSurviveReasoningContent:
    def test_fabricate_llm_extracts_text_after_reasoning_block(self, monkeypatch):
        import tools.fabricate as fab
        monkeypatch.setattr(fab, "bedrock", _mock_bedrock('["extracted"]'))
        assert fab._llm("system", "user") == '["extracted"]'

    def test_plan_generate_planning_doc_extracts_text_after_reasoning_block(self, monkeypatch):
        import tools.plan as plan
        monkeypatch.setattr(plan, "bedrock", _mock_bedrock("SECTION BODY"))
        monkeypatch.setattr(plan, "_assessment_summary", lambda sid: "assessment")
        monkeypatch.setattr(plan, "_rolling_summary", lambda sid: "summary")
        monkeypatch.setattr(plan, "s3_get", lambda key: "")
        template = {
            "document_title": "Business Plan",
            "sections": [{
                "id": "1", "title": "Overview",
                "description": "d", "required_content": ["x"],
            }],
        }
        doc = plan._generate_planning_doc("sess-1", template)
        assert "SECTION BODY" in doc

    def test_design_generate_section_extracts_text_after_reasoning_block(self, monkeypatch):
        import tools.design as design
        monkeypatch.setattr(design, "bedrock", _mock_bedrock("## 1. Overview\ncontent"))
        monkeypatch.setattr(design, "kb_query", lambda q, sid: "kb context")
        monkeypatch.setattr(design, "s3_get", lambda key: "")  # _rolling_summary
        section = {
            "id": "1", "title": "Overview",
            "description": "d", "required_content": ["x"],
        }
        result = design._generate_section("sess-1", section, "assessment")
        assert result == "## 1. Overview\ncontent"

    def test_extract_field_with_llm_extracts_text_after_reasoning_block(self, monkeypatch):
        import tools.extract as ext
        monkeypatch.setattr(ext, "bedrock", _mock_bedrock('{"value": "42"}'))
        field = {"label": "Process name", "kb_hint": "name of the process"}
        value = ext._extract_field_with_llm("sess-1", field, "kb ctx", [], [])
        assert value == "42"
