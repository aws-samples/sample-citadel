"""Tests for parallel field extraction optimizations."""
import json
import time
from unittest.mock import patch, MagicMock
import pytest


def _sample_pillar_data():
    return {
        'sections': {
            'sec1': {
                'title': 'Section 1',
                'fields': {
                    'f1': {'label': 'Field 1', 'required': True, 'value': 'filled', 'kb_hint': 'hint1'},
                    'f2': {'label': 'Field 2', 'required': True, 'value': None, 'kb_hint': 'hint2'},
                }
            },
            'sec2': {
                'title': 'Section 2',
                'fields': {
                    'f3': {'label': 'Field 3', 'required': True, 'value': None, 'kb_hint': 'hint3'},
                    'f4': {'label': 'Field 4', 'required': False, 'value': None, 'kb_hint': 'hint4'},
                }
            }
        }
    }


class TestScorecardFromData:
    def test_produces_correct_completed_and_pending(self):
        from tools.extract import _all_fields_scorecard_from_data
        data = {'business': _sample_pillar_data()}
        completed, pending = _all_fields_scorecard_from_data(data)
        assert len(completed) == 1
        assert completed[0]['label'] == 'Field 1'
        assert len(pending) == 2  # f2 and f3 (f4 not required)

    def test_skips_non_required_fields(self):
        from tools.extract import _all_fields_scorecard_from_data
        data = {'business': _sample_pillar_data()}
        _, pending = _all_fields_scorecard_from_data(data)
        labels = [f['label'] for f in pending]
        assert 'Field 4' not in labels


class TestSectionGroupedKBBatching:
    @patch('tools.extract.kb_query')
    @patch('tools.extract._extract_field_with_llm', return_value='extracted')
    @patch('tools.extract.save_json_to_s3')
    @patch('tools.extract.load_json_from_s3')
    @patch('tools.extract._init_if_needed')
    def test_one_kb_call_per_section(self, mock_init, mock_load, mock_save, mock_llm, mock_kb):
        from tools.extract import extract_information
        pillar = _sample_pillar_data()
        mock_load.return_value = pillar
        mock_kb.return_value = 'some context'

        extract_information(session_id='test-session')

        # 2 sections with pending fields -> 2 KB calls (not 2 per-field calls)
        assert mock_kb.call_count == 2


class TestParallelExecution:
    @patch('tools.extract.kb_query', return_value='context')
    @patch('tools.extract.save_json_to_s3')
    @patch('tools.extract.load_json_from_s3')
    @patch('tools.extract._init_if_needed')
    def test_parallel_faster_than_sequential(self, mock_init, mock_load, mock_save, mock_kb):
        from tools.extract import extract_information

        def slow_llm(*args, **kwargs):
            time.sleep(0.1)
            return 'value'

        # 3 pillars, each with 2 pending fields = 6 fields
        pillar = _sample_pillar_data()
        mock_load.return_value = pillar

        with patch('tools.extract._extract_field_with_llm', side_effect=slow_llm):
            start = time.time()
            extract_information(session_id='test-parallel')
            elapsed = time.time() - start

        # 6 fields * 0.1s sequential = 0.6s; parallel with 5 workers should be < 0.4s
        assert elapsed < 0.5, f"Parallel extraction took {elapsed:.2f}s, expected < 0.5s"


class TestBulkS3Write:
    @patch('tools.extract.kb_query', return_value='context')
    @patch('tools.extract._extract_field_with_llm', return_value='val')
    @patch('tools.extract.save_json_to_s3')
    @patch('tools.extract.load_json_from_s3')
    @patch('tools.extract._init_if_needed')
    def test_s3_writes_equal_pillar_count(self, mock_init, mock_load, mock_save, mock_llm, mock_kb):
        from tools.extract import extract_information, PILLARS
        mock_load.return_value = _sample_pillar_data()

        extract_information(session_id='test-bulk')

        # Should write once per pillar (3), not once per field
        assert mock_save.call_count == len(PILLARS)


class TestOutputFormat:
    @patch('tools.extract.kb_query', return_value='context')
    @patch('tools.extract._extract_field_with_llm', return_value='val')
    @patch('tools.extract.save_json_to_s3')
    @patch('tools.extract.load_json_from_s3')
    @patch('tools.extract._init_if_needed')
    def test_return_json_has_expected_keys(self, mock_init, mock_load, mock_save, mock_llm, mock_kb):
        from tools.extract import extract_information
        mock_load.return_value = _sample_pillar_data()

        result = json.loads(extract_information(session_id='test-format'))

        assert 'filled_this_run' in result
        assert 'total_filled' in result
        assert 'total_required' in result
        assert 'completion_pct' in result
        assert 'still_missing' in result
