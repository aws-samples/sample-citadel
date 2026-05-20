"""Tests for parallel design generation."""
import time
from unittest.mock import patch, MagicMock
import pytest


def _mock_template():
    return {
        'sections': [
            {'id': '1', 'title': 'Overview', 'description': 'desc', 'required_content': ['a']},
            {'id': '2', 'title': 'Agents', 'description': 'desc', 'required_content': ['b']},
            {'id': '3', 'title': 'Workflows', 'description': 'desc', 'required_content': ['c']},
            {'id': '4', 'title': 'Integrations', 'description': 'desc', 'required_content': ['d']},
            {'id': '5', 'title': 'HITL', 'description': 'desc', 'required_content': ['e'], 'depends_on': ['2']},
            {'id': '6', 'title': 'Security', 'description': 'desc', 'required_content': ['f'], 'depends_on': ['4']},
        ]
    }


class TestParallelDesignGeneration:
    @patch('tools.design.s3_get', return_value='')
    @patch('tools.design.s3_put')
    @patch('tools.design.save_json_to_s3')
    @patch('tools.design.load_json_from_s3', return_value=None)
    @patch('tools.design._assessment_summary', return_value='summary')
    @patch('tools.design._load_template')
    @patch('tools.design.update_intake_progress', return_value='ok')
    def test_independent_sections_run_concurrently(self, mock_progress, mock_tmpl, mock_assess, mock_load, mock_save, mock_s3put, mock_s3get):
        mock_tmpl.return_value = _mock_template()

        call_times = []

        def slow_generate(session_id, section, assessment):
            start = time.time()
            time.sleep(0.15)
            call_times.append((section['id'], start, time.time()))
            return f"## {section['id']}. {section['title']}\ncontent\n<!-- summary: done -->"

        with patch('tools.design._generate_section', side_effect=slow_generate):
            from tools.design import generate_technical_design
            generate_technical_design(session_id='test-parallel-design')

        # Independent sections (1-4) should overlap in time
        independent_times = [t for t in call_times if t[0] in ('1', '2', '3', '4')]
        if len(independent_times) >= 2:
            # At least 2 should have overlapping start/end times
            starts = [t[1] for t in independent_times]
            ends = [t[2] for t in independent_times]
            # If parallel, the total time should be < sum of individual times
            total_wall = max(ends) - min(starts)
            sum_individual = sum(e - s for _, s, e in independent_times)
            assert total_wall < sum_individual, f"Wall time {total_wall:.2f}s not less than sum {sum_individual:.2f}s"

    @patch('tools.design.s3_get', return_value='')
    @patch('tools.design.s3_put')
    @patch('tools.design.save_json_to_s3')
    @patch('tools.design.load_json_from_s3', return_value=None)
    @patch('tools.design._assessment_summary', return_value='summary')
    @patch('tools.design._load_template')
    @patch('tools.design.update_intake_progress', return_value='ok')
    def test_dependent_sections_run_after_dependencies(self, mock_progress, mock_tmpl, mock_assess, mock_load, mock_save, mock_s3put, mock_s3get):
        mock_tmpl.return_value = _mock_template()
        order = []

        def track_generate(session_id, section, assessment):
            order.append(section['id'])
            return f"## {section['id']}. {section['title']}\ncontent\n<!-- summary: done -->"

        with patch('tools.design._generate_section', side_effect=track_generate):
            from tools.design import generate_technical_design
            generate_technical_design(session_id='test-dep-order')

        # Dependent sections (5, 6) must come after their dependencies (2, 4)
        assert order.index('5') > order.index('2')
        assert order.index('6') > order.index('4')
