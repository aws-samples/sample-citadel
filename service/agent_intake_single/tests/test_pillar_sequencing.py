"""Property tests: the 'dimensions' pillar is a parallel
fourth pillar routed after business/technical/governance complete.

Validates backlog ACs 2 (routes to dimensions after governance), 3 (four
pillars completed before session complete), and 4 (no re-entry of
completed pillars).
"""
import json
import os
import sys
from unittest.mock import patch

import pytest
from hypothesis import given, settings, strategies as st

# tools.extract reads EXTRACTION_MODEL at import time; provide a harmless
# default before any 'from tools.extract import...' elsewhere in this file.
os.environ.setdefault('EXTRACTION_MODEL', 'test-model')

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

def _load_template(pillar):
    path = os.path.join(os.path.dirname(__file__), '..', 'templates', f'assessment_{pillar}.json')
    with open(path) as f:
        return json.load(f)

def _filled(template, complete=True):
    """Return a copy of the template with all required fields filled (or not)."""
    clone = json.loads(json.dumps(template))
    if not complete:
        return clone
    for section in clone['sections'].values():
        for field in section['fields'].values():
            if field.get('required'):
                field['value'] = 'filled'
    return clone

def _build_state(fill_map):
    """fill_map: dict[pillar_name, bool]. Returns a callable suitable for
    load_json_from_s3 patching that serves the correct per-pillar state."""
    state = {}
    for pillar, is_filled in fill_map.items():
        tpl = _load_template(pillar)
        state[f'assessment/{pillar}.json'] = _filled(tpl, complete=is_filled)
    def fake_load(key):
        # Match session-aware key shape 'session-xxx/assessment/{pillar}.json'
        for suffix, value in state.items():
            if key.endswith(suffix):
                return value
        return None
    return fake_load

SESSION = 'session-test-018'

def test_dimensions_template_exists_and_has_four_required_fields():
    """AC sanity: the new template JSON has the four required fields."""
    tpl = _load_template('dimensions')
    assert tpl['pillar'] == 'dimensions'
    fields = tpl['sections']['coverage']['fields']
    required = {k for k, v in fields.items() if v.get('required')}
    assert required == {'code_dimension', 'data_dimension', 'integration_dimension', 'infrastructure_dimension'}

def test_pillar_list_includes_dimensions_last():
    """AC 2: dimensions MUST be the fourth pillar so it is asked after the
    existing three complete."""
    from tools.extract import PILLARS
    assert PILLARS == ['business', 'technical', 'governance', 'dimensions']

def test_after_three_pillars_complete_next_question_is_dimensions():
    """AC 2: Given business/technical/governance complete and dimensions
    empty, get_next_assessment_question returns the first dimension field."""
    from tools.extract import get_next_assessment_question

    fake_load = _build_state({
        'business': True,
        'technical': True,
        'governance': True,
        'dimensions': False,
    })
    with patch('tools.extract.load_json_from_s3', side_effect=fake_load), \
         patch('tools.extract.save_json_to_s3'):
        result = json.loads(get_next_assessment_question(SESSION))
    assert result['pillar'] == 'dimensions'
    assert result['section'] == 'coverage'
    # First field in the 'coverage' section is code_dimension
    assert result['field'] == 'code_dimension'

def test_all_four_pillars_complete_returns_complete_literal():
    """AC 3/4: Given all four pillars filled, the string 'complete' is returned."""
    from tools.extract import get_next_assessment_question

    fake_load = _build_state({
        'business': True, 'technical': True,
        'governance': True, 'dimensions': True,
    })
    with patch('tools.extract.load_json_from_s3', side_effect=fake_load), \
         patch('tools.extract.save_json_to_s3'):
        assert get_next_assessment_question(SESSION) == 'complete'

def test_dimensions_never_asked_before_governance_complete():
    """AC 4: when governance is incomplete, dimensions MUST NOT be the
    returned pillar — pillars are asked in order."""
    from tools.extract import get_next_assessment_question

    fake_load = _build_state({
        'business': True, 'technical': True,
        'governance': False, 'dimensions': False,
    })
    with patch('tools.extract.load_json_from_s3', side_effect=fake_load), \
         patch('tools.extract.save_json_to_s3'):
        result = json.loads(get_next_assessment_question(SESSION))
    assert result['pillar'] == 'governance'
    assert result['pillar']!= 'dimensions'

@given(
    business_filled=st.booleans(),
    technical_filled=st.booleans(),
    governance_filled=st.booleans(),
    dimensions_filled=st.booleans(),
)
@settings(max_examples=100, deadline=None)
def test_property_pillar_sequencing_follows_pillars_order(
    business_filled, technical_filled, governance_filled, dimensions_filled,
):
    """AC 4 property: for any combination of pillar fill-states, the returned
    pillar is the first unfilled one in PILLARS order, and no completed pillar
    is ever returned. If all four are filled, result is 'complete'.
    """
    from tools.extract import get_next_assessment_question, PILLARS

    fill_map = {
        'business': business_filled,
        'technical': technical_filled,
        'governance': governance_filled,
        'dimensions': dimensions_filled,
    }
    fake_load = _build_state(fill_map)

    with patch('tools.extract.load_json_from_s3', side_effect=fake_load), \
         patch('tools.extract.save_json_to_s3'):
        out = get_next_assessment_question(SESSION)

    # Expected: first unfilled pillar in PILLARS order, or 'complete'
    expected_pillar = next((p for p in PILLARS if not fill_map[p]), None)

    if expected_pillar is None:
        assert out == 'complete'
    else:
        parsed = json.loads(out)
        assert parsed['pillar'] == expected_pillar
        # Invariant: completed pillars are never revisited.
        for p, filled in fill_map.items():
            if filled:
                assert parsed['pillar']!= p, (
                    f'pillar {p} was marked filled but get_next_assessment_question '
                    f'returned it anyway'
                )
