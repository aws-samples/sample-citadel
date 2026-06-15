"""Tests for Requirement 9.4: each archetype system_prompt.md
contains an instruction to call `escalate` when tasks are outside AI-analytical
scope.

This is a structural invariant test — if any of the three archetype templates
loses the escalate instruction in a future refactor, this test catches it.
"""
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from tools_config import load_archetype_template # noqa: E402

_ARCHETYPES = ['MONOLITHIC_DB', 'ENTERPRISE_APP_SPRAWL', 'HYBRID_IT_OT']

@pytest.mark.parametrize('archetype', _ARCHETYPES)
def test_requirement_9_4_system_prompt_mentions_escalate(archetype):
    """Requirement 9.4: Each archetype system_prompt.md contains an
    instruction to call `escalate` when tasks are outside AI-analytical scope.
    """
    template = load_archetype_template(archetype)
    prompt = template['system_prompt']
    # The instruction must reference the escalate tool AND convey the
    # off-frontier semantic (judgment / political / constraint / analytical
    # scope). Use a regex anchored on the backticked tool name to avoid
    # false positives from incidental 'escalate' mentions.
    assert '`escalate`' in prompt, (
        f'{archetype}: system_prompt.md must mention the escalate tool by '
        f'backticked name (e.g. "call the `escalate` tool when …")'
    )
    # Accept any of several phrasings that denote the off-frontier semantic.
    off_frontier_pattern = re.compile(
        r'(judgment|analytical\s+(?:frontier|scope)|off-frontier|'
        r'political\s+awareness|constraint\s+reasoning)',
        re.IGNORECASE,
    )
    assert off_frontier_pattern.search(prompt), (
        f'{archetype}: system_prompt.md must reference the off-frontier '
        f'semantic (judgment / analytical scope / political / constraint)'
    )

