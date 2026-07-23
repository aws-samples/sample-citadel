"""Tests for the extraction searchability race + honest emptiness (Fix:
INDEXED documents return empty right after upload; a later retry succeeds).

Contract under test:
  - tools.kb distinguishes error/empty/content in its return contract —
    "KB error: {e}" strings are NEVER returned as if they were content.
  - extract_information probes that the just-uploaded document is actually
    retrievable (bounded, ~45s with backoff) BEFORE the field-extraction
    pass; when still unsearchable it returns a structured still-indexing
    result instead of silently reporting 0 fields.
  - Per-section KB errors get ONE bounded retry, then the section is marked
    skipped in the structured result — never silently treated as empty.

Run with: PYTHONPATH=. pytest tests/test_extraction_readiness.py -q
from service/agent_intake_single.
"""
import json
import os
import sys
from unittest import mock
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# ---------------------------------------------------------------------------
# tools.kb return contract
# ---------------------------------------------------------------------------

class TestKbRetrieveContract:
    def _patch_kb(self, monkeypatch, retrieve):
        import tools.kb as kb
        monkeypatch.setattr(kb, "KNOWLEDGE_BASE_ID", "kb-1")
        agent = MagicMock()
        agent.retrieve = retrieve
        monkeypatch.setattr(kb, "bedrock_agent", agent)
        return kb

    def test_content_status_carries_chunks(self, monkeypatch):
        kb = self._patch_kb(
            monkeypatch,
            MagicMock(return_value={"retrievalResults": [{"content": {"text": "chunk-1"}}]}),
        )
        result = kb.kb_retrieve("q", "sess")
        assert result.status == "content"
        assert result.content == "chunk-1"

    def test_no_results_is_empty_not_content(self, monkeypatch):
        kb = self._patch_kb(monkeypatch, MagicMock(return_value={"retrievalResults": []}))
        result = kb.kb_retrieve("q", "sess")
        assert result.status == "empty"
        assert result.content == ""

    def test_exception_is_error_status_and_never_content(self, monkeypatch):
        kb = self._patch_kb(monkeypatch, MagicMock(side_effect=Exception("boom-detail")))
        result = kb.kb_retrieve("q", "sess")
        assert result.status == "error"
        assert result.content == ""  # the error text is NOT content

    def test_kb_query_never_returns_error_strings(self, monkeypatch):
        kb = self._patch_kb(monkeypatch, MagicMock(side_effect=Exception("boom-detail")))
        out = kb.kb_query("q", "sess")
        assert out == ""
        assert "KB error" not in out
        assert "boom-detail" not in out


# ---------------------------------------------------------------------------
# extract_information readiness probe + per-section retry
# ---------------------------------------------------------------------------

def _pillar_with_two_sections():
    return {
        "sections": {
            "sec1": {
                "title": "Section 1",
                "fields": {
                    "f1": {"label": "Field 1", "required": True, "value": None, "kb_hint": "hint1"},
                },
            },
            "sec2": {
                "title": "Section 2",
                "fields": {
                    "f2": {"label": "Field 2", "required": True, "value": None, "kb_hint": "hint2"},
                },
            },
        }
    }


def _kbr(status, content=""):
    from tools.kb import KBResult
    return KBResult(status=status, content=content)


def _run_extraction(kb_side_effects, pillar_loader=None):
    """Run extract_information with only the 'business' pillar populated so
    kb_retrieve call order is deterministic: probe calls first, then one call
    per section (sec1, sec2)."""
    import tools.extract as extract

    def load(key):
        if pillar_loader:
            return pillar_loader(key)
        return _pillar_with_two_sections() if "business" in key else None

    sleeps = []
    kb_mock = MagicMock(side_effect=kb_side_effects)
    with patch.object(extract, "kb_retrieve", kb_mock), \
         patch.object(extract, "_extract_field_with_llm", return_value="val") as llm, \
         patch.object(extract, "save_json_to_s3"), \
         patch.object(extract, "load_json_from_s3", side_effect=load), \
         patch.object(extract, "_init_if_needed"), \
         patch.object(extract, "_probe_sleep", side_effect=sleeps.append):
        result = json.loads(extract.extract_information(session_id="sess-1"))
    return result, kb_mock, llm, sleeps


class TestReadinessProbe:
    def test_empty_then_ready_probe_sequence_succeeds(self):
        # Probe: empty, empty, content — then the two section retrievals.
        result, kb_mock, llm, sleeps = _run_extraction(
            [
                _kbr("empty"),
                _kbr("empty"),
                _kbr("content", "probe hit"),
                _kbr("content", "ctx1"),
                _kbr("content", "ctx2"),
            ]
        )
        assert result["filled_this_run"] == 2
        assert llm.called
        # Backoff slept between the three probe attempts (not after success).
        assert len(sleeps) == 2

    def test_persistent_unsearchable_returns_structured_still_indexing(self):
        import tools.extract as extract
        attempts = 1 + len(extract.READINESS_PROBE_DELAYS)
        result, kb_mock, llm, sleeps = _run_extraction([_kbr("empty")] * attempts)

        assert result["status"] == "document_not_searchable"
        assert result["retryable"] is True
        # Copy rules: what changed (nothing), one plain reason, one next action.
        assert "nothing" in result["what_changed"].lower()
        assert result["reason"]
        assert result["next_action"]
        # The silent 0/23 path is gone: no completion_pct-style payload.
        assert "filled_this_run" not in result
        assert not llm.called
        # Bounded: exactly the configured backoff delays were slept (~45s).
        assert sleeps == list(extract.READINESS_PROBE_DELAYS)
        assert sum(extract.READINESS_PROBE_DELAYS) <= 46

    def test_probe_skipped_when_no_pending_fields(self):
        filled = _pillar_with_two_sections()
        for section in filled["sections"].values():
            for field in section["fields"].values():
                field["value"] = "already"
        result, kb_mock, llm, _ = _run_extraction(
            [], pillar_loader=lambda key: filled if "business" in key else None
        )
        assert result["filled_this_run"] == 0
        kb_mock.assert_not_called()


class TestPerSectionErrors:
    def test_section_error_retried_once_then_succeeds(self):
        result, kb_mock, llm, _ = _run_extraction(
            [
                _kbr("content", "probe hit"),   # probe
                _kbr("error"),                   # sec1 attempt 1
                _kbr("content", "ctx1"),        # sec1 retry -> success
                _kbr("content", "ctx2"),        # sec2
            ]
        )
        assert result["filled_this_run"] == 2
        assert result["skipped_sections"] == []

    def test_persistent_section_error_marked_skipped_not_silent(self):
        result, kb_mock, llm, _ = _run_extraction(
            [
                _kbr("content", "probe hit"),   # probe
                _kbr("error"),                   # sec1 attempt 1
                _kbr("error"),                   # sec1 retry -> still failing
                _kbr("content", "ctx2"),        # sec2
            ]
        )
        assert result["filled_this_run"] == 1
        skipped = result["skipped_sections"]
        assert len(skipped) == 1
        assert skipped[0]["section"] == "sec1"

    def test_error_detail_never_reaches_llm_context(self):
        from tools.kb import KBResult
        result, kb_mock, llm, _ = _run_extraction(
            [
                _kbr("content", "probe hit"),
                KBResult(status="error", detail="KB error: AccessDenied boom"),
                KBResult(status="error", detail="KB error: AccessDenied boom"),
                _kbr("content", "ctx2"),
            ]
        )
        for call in llm.call_args_list:
            kb_context = call.args[2] if len(call.args) > 2 else call.kwargs.get("kb_context", "")
            assert "KB error" not in kb_context
            assert "boom" not in kb_context
