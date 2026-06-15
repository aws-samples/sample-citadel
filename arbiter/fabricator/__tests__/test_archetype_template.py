"""Unit tests for the archetype template loader.

Validates backlog ACs 2 (load returns parsed object), 3 (ArchetypeNotFoundError
on unknown archetype), and 4 (README cites GOV-FW §Component 3).

The tests read the real template files on disk; Track A owns creation of
those files. If Track A has not yet landed the templates the three
deterministic MONOLITHIC_DB / ENTERPRISE_APP_SPRAWL / HYBRID_IT_OT loads
will surface a FileNotFoundError — that failure is the intentional
integration boundary between Track A and Track B (do NOT paper over it
here by creating files).
"""
import os
import sys

import pytest
from hypothesis import given, settings, strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from tools_config import ( # noqa: E402
    ArchetypeNotFoundError,
    load_archetype_template,
)

# The three whitelisted archetype enum values (QT2A-8 frozen-at-three).
VALID_ARCHETYPES = ['MONOLITHIC_DB', 'ENTERPRISE_APP_SPRAWL', 'HYBRID_IT_OT']

# Expected dict keys returned by load_archetype_template (contract AC 2).
EXPECTED_KEYS = {
    'archetype',
    'system_prompt',
    'agent_suite',
    'metadata',
    'readme_path',
}

# ---------------------------------------------------------------------------
# AC 2 — load returns a parsed object with the contract keys, for each of
# the three whitelisted archetypes.
# ---------------------------------------------------------------------------

class TestLoadReturnsParsedObject:
    @pytest.mark.parametrize('archetype', VALID_ARCHETYPES)
    def test_returns_dict_with_expected_keys(self, archetype):
        """AC 2: load returns a dict containing all contract keys."""
        result = load_archetype_template(archetype)
        assert isinstance(result, dict)
        assert EXPECTED_KEYS.issubset(result.keys()), (
            f"missing keys: {EXPECTED_KEYS - set(result.keys())}"
        )

    @pytest.mark.parametrize('archetype', VALID_ARCHETYPES)
    def test_archetype_field_echoes_input(self, archetype):
        """`archetype` key echoes the requested value for traceability."""
        result = load_archetype_template(archetype)
        assert result['archetype'] == archetype

    @pytest.mark.parametrize('archetype', VALID_ARCHETYPES)
    def test_system_prompt_has_required_xml_tags(self, archetype):
        """system_prompt is a non-empty string with <role> and
        <archetype_profile> tags (Track A content convention)."""
        result = load_archetype_template(archetype)
        prompt = result['system_prompt']
        assert isinstance(prompt, str)
        assert prompt.strip(), 'system_prompt must not be empty'
        assert '<role>' in prompt, "system_prompt must contain <role> tag"
        assert '<archetype_profile>' in prompt, (
            'system_prompt must contain <archetype_profile> tag'
        )

    @pytest.mark.parametrize('archetype', VALID_ARCHETYPES)
    def test_agent_suite_is_list(self, archetype):
        """agent_suite is a list (possibly empty per QT2B-3 placeholder)."""
        result = load_archetype_template(archetype)
        assert isinstance(result['agent_suite'], list)

    @pytest.mark.parametrize('archetype', VALID_ARCHETYPES)
    def test_metadata_is_dict(self, archetype):
        """metadata is a dict (possibly empty per placeholder)."""
        result = load_archetype_template(archetype)
        assert isinstance(result['metadata'], dict)

# ---------------------------------------------------------------------------
# AC 4 — README cites GOV-FW §Component 3.
# ---------------------------------------------------------------------------

class TestReadmeCitation:
    @pytest.mark.parametrize('archetype', VALID_ARCHETYPES)
    def test_readme_path_is_absolute_and_ends_correctly(self, archetype):
        """readme_path is an absolute filesystem path ending in /README.md."""
        result = load_archetype_template(archetype)
        readme_path = result['readme_path']
        assert isinstance(readme_path, str)
        assert os.path.isabs(readme_path), (
            f'readme_path must be absolute, got: {readme_path!r}'
        )
        assert readme_path.endswith(os.sep + 'README.md'), (
            f'readme_path must end in /README.md, got: {readme_path!r}'
        )

    @pytest.mark.parametrize('archetype', VALID_ARCHETYPES)
    def test_readme_exists_and_cites_gov_fw_component_3(self, archetype):
        """AC 4: README file exists and contains the GOV-FW §Component 3
        citation string."""
        result = load_archetype_template(archetype)
        readme_path = result['readme_path']
        assert os.path.isfile(readme_path), (
            f'README.md not found at {readme_path}'
        )
        with open(readme_path, 'r', encoding='utf-8') as fh:
            content = fh.read()
        assert 'GOV-FW §Component 3' in content, (
            f"README for {archetype} must cite 'GOV-FW §Component 3'"
        )

# ---------------------------------------------------------------------------
# AC 3 — ArchetypeNotFoundError on unknown / case-variant / empty / None.
# ---------------------------------------------------------------------------

class TestArchetypeNotFound:
    def test_unknown_archetype_raises(self):
        with pytest.raises(ArchetypeNotFoundError):
            load_archetype_template('OTHER')

    def test_lowercase_is_case_sensitive_and_raises(self):
        """Enum membership is case-sensitive; 'monolithic_db' must reject."""
        with pytest.raises(ArchetypeNotFoundError):
            load_archetype_template('monolithic_db')

    def test_empty_string_raises(self):
        with pytest.raises(ArchetypeNotFoundError):
            load_archetype_template('')

    def test_none_raises(self):
        """None is not a frozenset member, so the `not in` check rejects it
        without raising TypeError."""
        with pytest.raises(ArchetypeNotFoundError):
            load_archetype_template(None) # type: ignore[arg-type]

    def test_error_message_lists_valid_values(self):
        """Error message cites the three valid archetypes (developer UX)."""
        with pytest.raises(ArchetypeNotFoundError) as excinfo:
            load_archetype_template('NOPE')
        message = str(excinfo.value)
        for valid in VALID_ARCHETYPES:
            assert valid in message, (
                f"error message should list {valid}: {message!r}"
            )

# ---------------------------------------------------------------------------
# Broken-checkout boundary: valid enum value but templates_root points
# nowhere ⇒ FileNotFoundError bubbles up from open().
# ---------------------------------------------------------------------------

class TestBrokenCheckout:
    def test_missing_templates_root_raises_file_not_found(self):
        with pytest.raises(FileNotFoundError):
            load_archetype_template(
                'MONOLITHIC_DB', templates_root='/nonexistent/path'
            )

# ---------------------------------------------------------------------------
# Property test — only the three whitelisted strings succeed, all other
# strings raise ArchetypeNotFoundError. The property is what guarantees
# the frozen-at-three invariant (QT2A-8) under arbitrary input.
# ---------------------------------------------------------------------------

@given(candidate=st.text(min_size=0, max_size=50))
@settings(max_examples=200, deadline=None)
def test_property_only_three_archetypes_succeed(candidate):
    valid = {'MONOLITHIC_DB', 'ENTERPRISE_APP_SPRAWL', 'HYBRID_IT_OT'}
    if candidate in valid:
        result = load_archetype_template(candidate)
        assert result['archetype'] == candidate
    else:
        with pytest.raises(ArchetypeNotFoundError):
            load_archetype_template(candidate)
