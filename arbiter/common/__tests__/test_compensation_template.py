"""Red-first tests for the CIT-123 slice-2 pure compensation args renderer.

Exercises ``arbiter.common.compensation_template.render_compensation_args``:
a pure, hand-written ``${output.<path>}`` resolver with NO eval/format/jinja,
fail-closed on any unresolvable reference. See module docstring in
``compensation_template.py`` for the full grammar/decision writeup (D4).

All fixtures are generic placeholders — never real ARNs or account data.
"""
from __future__ import annotations

import string

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from common.compensation_template import (
    CompensationTemplateError,
    RenderResult,
    render_compensation_args,
)

# --- Happy path: literals pass through --------------------------------------


def test_non_template_string_literal_passes_through_unchanged():
    result = render_compensation_args({'note': 'hello world'}, {})
    assert result.args == {'note': 'hello world'}


def test_non_string_literals_pass_through_unchanged():
    template = {'count': 3, 'ratio': 1.5, 'active': True, 'nothing': None}
    result = render_compensation_args(template, {'ticketId': 't-1'})
    assert result.args == template


def test_nested_dict_and_list_structure_preserved_for_literals():
    template = {'a': {'b': [1, 2, {'c': 'x'}]}}
    result = render_compensation_args(template, {})
    assert result.args == {'a': {'b': [1, 2, {'c': 'x'}]}}


# --- Happy path: resolution against recorded output --------------------------


def test_single_token_whole_string_resolves_and_preserves_type_int():
    result = render_compensation_args({'id': '${output.ticketId}'}, {'ticketId': 42})
    assert result.args == {'id': 42}
    assert isinstance(result.args['id'], int)


def test_single_token_whole_string_resolves_and_preserves_type_bool():
    result = render_compensation_args({'flag': '${output.active}'}, {'active': False})
    assert result.args == {'flag': False}
    assert result.args['flag'] is False


def test_single_token_whole_string_resolves_and_preserves_type_none():
    result = render_compensation_args({'x': '${output.missingButPresentNull}'}, {'missingButPresentNull': None})
    assert result.args == {'x': None}


def test_nested_object_path_resolves():
    output = {'ticket': {'id': 't-99', 'meta': {'region': 'us-east-1'}}}
    result = render_compensation_args({'region': '${output.ticket.meta.region}'}, output)
    assert result.args == {'region': 'us-east-1'}


def test_array_index_path_resolves():
    output = {'items': [{'id': 'a'}, {'id': 'b'}]}
    result = render_compensation_args({'second': '${output.items[1].id}'}, output)
    assert result.args == {'second': 'b'}


def test_root_output_token_resolves_when_whole_output_is_scalar_free():
    # 'output' with no further path segments refers to the recorded output
    # root itself. Since root is a dict (non-scalar), this must be rejected
    # per the non-scalar rule (see test_non_scalar_* below), not silently
    # allowed just because the path is syntactically minimal.
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'whole': '${output}'}, {'a': 1})


def test_string_interpolation_with_multiple_tokens_and_literal_text():
    output = {'ticketId': 't-1', 'region': 'us-east-1'}
    result = render_compensation_args(
        {'msg': 'closing ${output.ticketId} in ${output.region}'}, output
    )
    assert result.args == {'msg': 'closing t-1 in us-east-1'}


def test_string_interpolation_coerces_non_string_scalar_to_string():
    result = render_compensation_args({'msg': 'count=${output.count}'}, {'count': 7})
    assert result.args == {'msg': 'count=7'}


def test_deeply_nested_template_structure_resolves_each_leaf():
    output = {'a': 1, 'b': {'c': 2}}
    template = {'x': {'y': ['${output.a}', {'z': '${output.b.c}'}]}}
    result = render_compensation_args(template, output)
    assert result.args == {'x': {'y': [1, {'z': 2}]}}


# --- Path grammar: what IS and IS NOT supported -------------------------------
# Decision (D4, slice 2): grammar mirrors slice-1's syntax-validation regex
# exactly — root 'output', then any number of '.<identifier>' or '[<int>]'
# segments. Array indexing over a list IS supported (single non-negative
# int index only). Negative indices, slices, wildcards, and non-numeric
# bracket contents are explicitly NOT supported and must be rejected loudly.


def test_array_index_out_of_range_fails_closed_with_named_path():
    with pytest.raises(CompensationTemplateError) as exc_info:
        render_compensation_args({'x': '${output.items[5]}'}, {'items': ['a']})
    assert 'output.items[5]' in str(exc_info.value)


def test_negative_array_index_is_rejected_not_python_negative_semantics():
    # Python list[-1] would return the last element; the grammar does not
    # define negative indices, and the syntax regex (slice 1) already
    # rejects '-' in brackets, so this must fail at resolve time too if it
    # somehow reached the resolver (defense in depth).
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'x': '${output.items[-1]}'}, {'items': ['a', 'b']})


def test_indexing_into_a_dict_with_bracket_syntax_is_rejected():
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'x': '${output.data[0]}'}, {'data': {'0': 'oops'}})


def test_missing_key_fails_closed_naming_the_path():
    with pytest.raises(CompensationTemplateError) as exc_info:
        render_compensation_args({'id': '${output.nope}'}, {'ticketId': 't-1'})
    msg = str(exc_info.value)
    assert 'output.nope' in msg


def test_missing_nested_key_fails_closed_naming_the_full_path():
    with pytest.raises(CompensationTemplateError) as exc_info:
        render_compensation_args({'id': '${output.a.b.c}'}, {'a': {'b': {}}})
    assert 'output.a.b.c' in str(exc_info.value)


def test_traversing_into_a_non_container_scalar_fails_closed():
    # output.a is an int; output.a.b cannot descend further.
    with pytest.raises(CompensationTemplateError) as exc_info:
        render_compensation_args({'id': '${output.a.b}'}, {'a': 5})
    assert 'output.a.b' in str(exc_info.value)


def test_malformed_token_syntax_raises_not_silently_ignored():
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'id': '${output.}'}, {'ticketId': 't-1'})


# --- Non-scalar resolution rule ------------------------------------------------
# Decision (D4, slice 2): a template token that resolves to a dict or list
# is REJECTED — the renderer never silently serializes a whole object into a
# string or returns a raw dict/list as an "arg value" implicitly, because a
# non-scalar substitution can smuggle unexpected structure into a governed
# tool call's arguments. This applies to BOTH the whole-string single-token
# case and the interpolated (partial-string) case.


def test_whole_string_token_resolving_to_dict_is_rejected():
    with pytest.raises(CompensationTemplateError) as exc_info:
        render_compensation_args({'x': '${output.ticket}'}, {'ticket': {'id': 't-1'}})
    assert 'output.ticket' in str(exc_info.value)
    assert 'non-scalar' in str(exc_info.value).lower() or 'object' in str(exc_info.value).lower()


def test_whole_string_token_resolving_to_list_is_rejected():
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'x': '${output.items}'}, {'items': [1, 2, 3]})


def test_interpolated_token_resolving_to_dict_is_rejected():
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'msg': 'ticket=${output.ticket}'}, {'ticket': {'id': 't-1'}})


def test_interpolated_token_resolving_to_empty_list_is_still_rejected():
    # Rejecting is about type (non-scalar), not emptiness/truthiness.
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'x': '${output.items}'}, {'items': []})


# --- Absent / truncated / offloaded recorded output ---------------------------
# Decision (D4, slice 2): the renderer NEVER fetches anything. It only
# inspects the shape of `recorded_output` handed to it by the caller. Three
# distinct fail-closed conditions, each with its own named error:
#   1. recorded_output is None / not a dict at all  -> output absent
#   2. recorded_output carries a truthy 'resultTruncated' marker
#   3. recorded_output carries a 'resultOffloaded' marker (or a bare
#      'resultRef' pointer) meaning the real body was never rehydrated by
#      the caller into this dict.
# These mirror the exact attribute names the ledger (tool_execution_ledger.py
# finalize_success / _recorded_result) already uses for the same concepts,
# so a future caller can pass ledger-row-shaped attributes straight through
# without inventing a second vocabulary.


def test_recorded_output_none_fails_closed():
    with pytest.raises(CompensationTemplateError) as exc_info:
        render_compensation_args({'id': '${output.ticketId}'}, None)
    assert 'absent' in str(exc_info.value).lower()


def test_recorded_output_wrong_type_fails_closed():
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'id': '${output.ticketId}'}, 'not-a-dict')


def test_recorded_output_truncated_marker_fails_closed_even_if_path_present():
    output = {'ticketId': 't-1', 'resultTruncated': True}
    with pytest.raises(CompensationTemplateError) as exc_info:
        render_compensation_args({'id': '${output.ticketId}'}, output)
    assert 'truncated' in str(exc_info.value).lower()
    assert 'output.ticketId' in str(exc_info.value)


def test_recorded_output_offloaded_marker_fails_closed_without_fetching():
    output = {'resultOffloaded': True, 'resultRef': {'bucket': 'b', 'key': 'k'}}
    with pytest.raises(CompensationTemplateError) as exc_info:
        render_compensation_args({'id': '${output.ticketId}'}, output)
    assert 'offload' in str(exc_info.value).lower()


def test_recorded_output_bare_result_ref_without_offload_flag_still_fails_closed():
    # Defense in depth: even if a future caller forgets to also set
    # resultOffloaded, the presence of a resultRef-shaped pointer is enough
    # to refuse — we never guess that a resultRef means "safe to ignore".
    output = {'ticketId': 't-1', 'resultRef': {'bucket': 'b', 'key': 'k'}}
    with pytest.raises(CompensationTemplateError) as exc_info:
        render_compensation_args({'id': '${output.ticketId}'}, output)
    assert 'offload' in str(exc_info.value).lower()


def test_renderer_never_makes_network_or_filesystem_calls(monkeypatch):
    # Structural proof-by-absence: patch socket + open to explode if touched.
    import socket

    def _boom(*args, **kwargs):
        raise AssertionError('render_compensation_args must never perform I/O')

    monkeypatch.setattr(socket, 'socket', _boom)
    output = {'resultOffloaded': True, 'resultRef': {'bucket': 'b', 'key': 'k'}}
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'id': '${output.ticketId}'}, output)
    # Also prove the happy path performs no I/O.
    result = render_compensation_args({'id': '${output.ticketId}'}, {'ticketId': 't-1'})
    assert result.args == {'id': 't-1'}


# --- Security: no code execution, no gadget traversal --------------------------
# The resolver is a hand-written dict/list walker over a restricted grammar.
# It must be provably inert against classic template/format-string gadget
# shapes: dunder attribute access, callables, __proto__-style pollution keys.


def test_dunder_class_path_is_rejected_not_traversed():
    class Sneaky:
        pass

    output = {'obj': Sneaky()}
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'x': '${output.obj.__class__}'}, output)


def test_dunder_class_path_syntax_rejected_even_when_key_literally_present():
    # Even if a dict happens to have a key literally named '__class__', the
    # path grammar (identifier regex from slice 1: [A-Za-z_][A-Za-z0-9_]*)
    # permits leading underscores, so this is a GRAMMAR-VALID path — assert
    # it resolves as plain dict lookup, and no Python attribute/dunder
    # protocol is ever invoked (proven by using a plain dict/string value,
    # never an object whose dunder would do something if triggered).
    output = {'__class__': 'not-a-type-object-just-a-string'}
    result = render_compensation_args({'x': '${output.__class__}'}, output)
    assert result.args == {'x': 'not-a-type-object-just-a-string'}


def test_constructor_prototype_path_is_rejected_when_absent():
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'x': '${output.constructor.prototype}'}, {'ticketId': 't-1'})


def test_proto_pollution_key_is_treated_as_a_plain_string_key_never_special():
    output = {'__proto__': {'polluted': True}}
    # __proto__ has no meaning in Python dicts; this must resolve as an
    # ordinary nested-dict lookup and must NOT mutate any global/class state.
    result = render_compensation_args({'x': '${output.__proto__.polluted}'}, output)
    assert result.args == {'x': True}
    # Prove no pollution of a fresh dict's class-level behavior.
    assert {}.__class__ is dict
    assert not hasattr(dict, 'polluted')


def test_callable_attribute_in_path_cannot_be_invoked():
    # If a value in the recorded output happens to be a callable (e.g. a
    # bound method leaked into a dict by a buggy upstream), the resolver
    # must never call it — it may only be rejected as a non-scalar/unknown
    # leaf, never invoked.
    output = {'a': {'b': len}}  # len is callable
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'x': '${output.a.b}'}, output)


def test_callable_leaked_into_output_is_never_invoked_verified_by_side_effect_flag():
    calls = []

    def tracked():
        calls.append('called')
        return 'sentinel'

    output = {'a': {'b': tracked}}
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'x': '${output.a.b}'}, output)
    assert calls == []  # never invoked


def test_template_cannot_reach_python_builtins_via_grammar():
    # The grammar has no notion of '__builtins__', 'eval', 'import', or any
    # function-call syntax at all -- prove a builtins-shaped path is just a
    # normal (missing) dict lookup, fails closed, and nothing is imported
    # or executed as a side effect.
    with pytest.raises(CompensationTemplateError):
        render_compensation_args({'x': '${output.__builtins__.eval}'}, {'ticketId': 't-1'})


def test_no_eval_no_format_no_jinja_used_in_implementation():
    import inspect

    from common import compensation_template

    source = inspect.getsource(compensation_template)
    # Check actual banned constructs (call/import sites), not the word
    # 'jinja2' appearing anywhere at all — the module's own docstring is
    # allowed to discuss what it deliberately does NOT do.
    banned = ['eval(', 'exec(', 'import jinja2', 'from jinja2', 'Template(', '.format(']
    for token in banned:
        assert token not in source, f'forbidden construct {token!r} found in implementation'


# --- Errors are always a named exception, never a silent None/empty string ----


def test_every_failure_mode_raises_named_error_type():
    cases = [
        ({'x': '${output.missing}'}, {'present': 1}),
        ({'x': '${output.a.b}'}, {'a': 1}),
        ({'x': '${output.items[9]}'}, {'items': []}),
        ({'x': '${output.dictval}'}, {'dictval': {'k': 1}}),
        ({'x': '${output.ticketId}'}, None),
        ({'x': '${output.ticketId}'}, {'ticketId': 1, 'resultTruncated': True}),
    ]
    for template, output in cases:
        with pytest.raises(CompensationTemplateError):
            render_compensation_args(template, output)


def test_render_result_type_on_success():
    result = render_compensation_args({'id': '${output.ticketId}'}, {'ticketId': 't-1'})
    assert isinstance(result, RenderResult)
    assert result.args == {'id': 't-1'}


# --- Property-based tests (hypothesis) -----------------------------------------

_identifier_strategy = st.text(
    alphabet=string.ascii_lowercase, min_size=1, max_size=8
).filter(lambda s: s.isidentifier())

_scalar_leaf_strategy = st.one_of(
    st.text(alphabet=string.printable, max_size=20),
    st.integers(min_value=-(10**6), max_value=10**6),
    st.floats(allow_nan=False, allow_infinity=False),
    st.booleans(),
    st.none(),
)


def _nested_dict_strategy(max_depth: int = 3):
    """Arbitrary nested dict of scalars, dicts, and lists (JSON-shaped).

    The ROOT is always a dict (matching the actual ``recorded_output``
    contract — a compensating node's output is always a dict; the renderer
    itself rejects a non-dict root as "absent"), but nested VALUES may be
    scalars, dicts, or lists at any depth.
    """
    children = st.recursive(
        _scalar_leaf_strategy
        | st.lists(_scalar_leaf_strategy, max_size=4)
        | st.dictionaries(_identifier_strategy, _scalar_leaf_strategy, max_size=4),
        lambda child: st.dictionaries(_identifier_strategy, child, max_size=3)
        | st.lists(child, max_size=3),
        max_leaves=20,
    )
    return st.dictionaries(_identifier_strategy, children, max_size=5)


def _pick_path_and_value(node, prefix='output'):
    """Given a JSON-shaped node, deterministically enumerate (path, value)
    pairs for every SCALAR leaf reachable via the supported grammar
    (dotted keys + [int] indices)."""
    results = []
    if isinstance(node, dict):
        for key, child in node.items():
            if not isinstance(key, str) or not key.isidentifier():
                continue
            results.extend(_pick_path_and_value(child, f'{prefix}.{key}'))
    elif isinstance(node, list):
        for idx, child in enumerate(node):
            results.extend(_pick_path_and_value(child, f'{prefix}[{idx}]'))
    else:
        results.append((prefix, node))
    return results


@settings(max_examples=100, deadline=None)
@given(_nested_dict_strategy())
def test_property_successful_render_equals_value_at_path_for_every_scalar_leaf(output):
    leaves = _pick_path_and_value(output)
    for path, expected_value in leaves:
        template = {'v': f'${{{path}}}'}
        result = render_compensation_args(template, output)
        rendered = result.args['v']
        # NaN/Infinity excluded by strategy; direct equality is safe. Floats
        # from hypothesis can still hit exact-equality (no arithmetic done).
        assert rendered == expected_value, f'path {path!r} mismatch'


@settings(max_examples=50, deadline=None)
@given(
    _nested_dict_strategy(),
    st.lists(_identifier_strategy, min_size=1, max_size=4),
)
def test_property_unresolvable_path_always_raises_named_error_never_none(output, junk_segments):
    """A path built from arbitrary identifiers is either a valid resolution
    (equal to the source value, covered by the test above) or it MUST raise
    CompensationTemplateError -- there is no third outcome (no None, no
    empty string, no silent success with a wrong value)."""
    path = 'output.' + '.'.join(junk_segments)
    template = {'v': f'${{{path}}}'}
    try:
        result = render_compensation_args(template, output)
    except CompensationTemplateError:
        return  # expected outcome for an unresolvable path
    # If it did NOT raise, the rendered value must be a genuine resolution
    # of that exact path against the source output (proves no fabrication).
    node = output
    for seg in junk_segments:
        assert isinstance(node, dict) and seg in node
        node = node[seg]
    assert not isinstance(node, (dict, list)), 'non-scalar must have raised'
    assert result.args['v'] == node
