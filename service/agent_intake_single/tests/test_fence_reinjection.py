"""Tests that every _llm() re-injection site in agent_intake_single fences
untrusted document/extraction text through ``fence_untrusted`` before it
reaches the model.

Two classes:
1. Grep-oracle — enumerate every _llm() call that receives S3/doc-derived
   content and assert the call-site passes through fence_untrusted.
2. Hypothesis property — ``fence_untrusted`` output has exactly one BEGIN
   and one END delimiter, and the content region never contains a raw
   delimiter line.
"""
import ast
import json
import os
import re
import sys
import textwrap
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from tools.fence import (
    _DELIMITER_LINE_RE,
    fence_untrusted,
)


# ── Grep-oracle: _llm call sites must fence untrusted inputs ────────────

_TOOLS_DIR = os.path.join(os.path.dirname(__file__), "..", "tools")


def _read_source(filename: str) -> str:
    with open(os.path.join(_TOOLS_DIR, filename)) as f:
        return f.read()


class TestFenceReinjectionOracle:
    """Every _llm() call in fabricate.py and postfab.py that interpolates
    untrusted S3 document content must wrap it in fence_untrusted first."""

    def test_fabricate_imports_fence_untrusted(self):
        src = _read_source("fabricate.py")
        assert "from tools.fence import fence_untrusted" in src or \
               "from tools.fence import" in src and "fence_untrusted" in src, \
            "fabricate.py must import fence_untrusted"

    def test_postfab_imports_fence_untrusted(self):
        src = _read_source("postfab.py")
        assert "from tools.fence import fence_untrusted" in src or \
               "from tools.fence import" in src and "fence_untrusted" in src, \
            "postfab.py must import fence_untrusted"

    def test_extract_agents_fences_td2_content(self):
        """_extract_agents must call fence_untrusted on td2_content before
        passing it to _llm."""
        src = _read_source("fabricate.py")
        # Find the _extract_agents function body
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "_extract_agents":
                func_src = ast.get_source_segment(src, node)
                assert func_src is not None
                # The function must call fence_untrusted before _llm
                assert "fence_untrusted" in func_src, \
                    "_extract_agents must call fence_untrusted on td2_content"
                break
        else:
            pytest.fail("_extract_agents not found in fabricate.py")

    def test_compose_steps_fences_td2_and_plan(self):
        """_compose_steps in postfab.py must fence both td2 and plan inputs."""
        src = _read_source("postfab.py")
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "_compose_steps":
                func_src = ast.get_source_segment(src, node)
                assert func_src is not None
                # Must call fence_untrusted at least twice (td2 and plan)
                count = func_src.count("fence_untrusted")
                assert count >= 2, \
                    f"_compose_steps must fence both td2 and plan (found {count} calls)"
                break
        else:
            pytest.fail("_compose_steps not found in postfab.py")


# ── Unit: _extract_agents calls fence_untrusted ─────────────────────────


class TestExtractAgentsFencing:
    @patch("tools.fabricate._llm")
    @patch("tools.fabricate.fence_untrusted")
    def test_extract_agents_passes_content_through_fence(self, mock_fence, mock_llm):
        """The td2_content argument must go through fence_untrusted before
        reaching _llm."""
        mock_fence.return_value = "[FENCED] doc content"
        mock_llm.return_value = "[]"
        from tools.fabricate import _extract_agents
        _extract_agents("raw doc content", "sess-1")
        mock_fence.assert_called_once()
        assert mock_fence.call_args[0][0] == "raw doc content"
        # The fenced text must appear in the _llm user prompt
        user_prompt = mock_llm.call_args[0][1]
        assert "[FENCED] doc content" in user_prompt
        assert "raw doc content" not in user_prompt


# NOTE: _send_to_fabricator is deliberately NOT fenced here because the
# arbiter/fabricator already fences the TASK text (lines 3040/3128 in
# fabricator/index.py). Double-fencing would neutralise the inner delimiters
# and corrupt the spec content.


class TestComposeStepsFencing:
    @patch("tools.postfab._llm")
    @patch("tools.postfab.fence_untrusted")
    def test_compose_steps_fences_both_inputs(self, mock_fence, mock_llm):
        """Both td2 and plan must be fenced before reaching _llm."""
        fence_map = {
            "raw td2 content here": "[FENCED-TD2]",
            "raw plan content here": "[FENCED-PLAN]",
        }
        mock_fence.side_effect = lambda text, source, **kw: fence_map.get(text, text)
        mock_llm.return_value = "[]"
        from tools.postfab import _compose_steps
        _compose_steps("sess-1", "raw td2 content here", "raw plan content here", ["agent-a"])
        assert mock_fence.call_count >= 2, "Must fence both td2 and plan"
        fenced_texts = [c[0][0] for c in mock_fence.call_args_list]
        assert "raw td2 content here" in fenced_texts
        assert "raw plan content here" in fenced_texts
        user_prompt = mock_llm.call_args[0][1]
        assert "[FENCED-TD2]" in user_prompt
        assert "[FENCED-PLAN]" in user_prompt
        assert "raw td2 content here" not in user_prompt
        assert "raw plan content here" not in user_prompt


# ── Hypothesis property: fence output structure ──────────────────────────

_BEGIN_RE = re.compile(
    r"^=== BEGIN UNTRUSTED DOCUMENT CONTENT ([0-9a-f]+) \(source: [^)]+\) ===$",
)
_END_RE = re.compile(
    r"^=== END UNTRUSTED DOCUMENT CONTENT ([0-9a-f]+) ===$",
)


class TestFenceOutputProperty:
    @given(text=st.text(
        min_size=0,
        max_size=3000,
        alphabet=st.characters(whitelist_categories=("L", "M", "N", "P", "S", "Z", "Cc")),
    ))
    @settings(max_examples=500, deadline=10_000)
    def test_exactly_one_begin_one_end_content_region_clean(self, text):
        result = fence_untrusted(text, source="prop")
        lines = result.splitlines()

        begin_matches = [(i, _BEGIN_RE.match(l)) for i, l in enumerate(lines)]
        begin_hits = [(i, m) for i, m in begin_matches if m]
        end_matches = [(i, _END_RE.match(l)) for i, l in enumerate(lines)]
        end_hits = [(i, m) for i, m in end_matches if m]

        assert len(begin_hits) == 1, f"Expected 1 BEGIN, got {len(begin_hits)}"
        assert len(end_hits) == 1, f"Expected 1 END, got {len(end_hits)}"

        # Nonces must match
        begin_nonce = begin_hits[0][1].group(1)
        end_nonce = end_hits[0][1].group(1)
        assert begin_nonce == end_nonce, "BEGIN and END nonces must match"

        # Content between delimiters must not contain any raw delimiter-like line
        content_lines = lines[begin_hits[0][0] + 1:end_hits[0][0]]
        for cl in content_lines:
            assert not _DELIMITER_LINE_RE.match(cl), \
                f"Raw delimiter-like line found in content region: {cl!r}"
