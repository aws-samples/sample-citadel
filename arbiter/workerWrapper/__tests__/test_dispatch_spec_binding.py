"""
Property-based + deterministic tests for dispatch-time spec binding enforcement
in ``workerWrapper/index.py``.

QT3-6 — dispatch-time defence-in-depth for the code-generating
tool / ExecutionSpecification binding rule.

This suite verifies four invariants of ``assert_tool_spec_binding`` and the
``process_event`` insertion point:

1. Determinism of the binding rule across representative inputs.
2. Property invariant over random tool manifests: ``assert_tool_spec_binding``
   raises iff ``is_code_generating(tool) and not spec_id``. Production code
   and this test both resolve ``is_code_generating`` from the **same**
   ``tools_config`` module — that shared reference is the QT3-6 lockstep
   guarantee between fabricator manifest validation and worker dispatch.
3. Event-shape: the ``process_event`` insertion point rejects code-generating
   tools when neither ``spec_id`` nor ``specId`` is present on the incoming
   event/request, and accepts when either key is populated.
4. Key-alias coverage: any of ``event.spec_id``, ``event.specId``,
   ``request.spec_id``, ``request.specId`` resolves the spec. Empty strings
   do NOT satisfy the binding.

The DDB-backed ``assert_spec_approved`` path is **not** exercised here — it is
covered by Track A's fabricator tests. We only verify that the dispatch-side
wrapper imports the predicate consistently.

**Validates: Requirements 5.8, QT3-6.**
"""

from __future__ import annotations

import os
import sys

import pytest
from hypothesis import given, settings, HealthCheck, strategies as st

# ---------------------------------------------------------------------------
# Test harness setup
#
# Fake AWS creds let boto3.resource() succeed at tools_config import time
# without hitting any real credential provider. The DDB path is never called
# in this file. AWS_DEFAULT_REGION avoids botocore's NoRegionError.
# ---------------------------------------------------------------------------

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("CREDENTIAL_VENDER_FUNCTION", "")
os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AWS_ACCESS_KEY_ID", "testing")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "testing")
os.environ.setdefault("AWS_SESSION_TOKEN", "testing")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

import index # noqa: E402
from index import ( # noqa: E402
    SpecificationNotBoundError,
    assert_tool_spec_binding,
)
from tools_config import is_code_generating as shared_is_code_generating # noqa: E402

# ---------------------------------------------------------------------------
# Strategies
#
# The ``is_code_generating`` rule (Track A contract):
# - ``outputs`` missing entirely → True (conservative default)
# - ``outputs`` is a list containing the literal "code" → True
# - ``outputs`` is a list NOT containing "code" → False (incl. empty list)
# - ``outputs`` present but not a list → ValueError
# ---------------------------------------------------------------------------

tool_name = st.text(
    min_size=1,
    max_size=30,
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
)

# Spec IDs: None, empty, and well-formed non-empty strings.
spec_id_values = st.one_of(
    st.none(),
    st.just(""),
    st.text(
        min_size=1,
        max_size=40,
        alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
    ),
)

# Output tokens: include 'code' sometimes, plus a wide variety of other values.
output_token = st.one_of(
    st.just("code"),
    st.just("data"),
    st.just("report"),
    st.just("artifact"),
    st.text(min_size=1, max_size=15, alphabet="abcdefghijklmnopqrstuvwxyz_-"),
)

@st.composite
def tool_manifest(draw):
    """Random tool manifest exercising all code-generating-rule branches."""
    base: dict = {"name": draw(tool_name)}

    # Four branches of the rule: absent / empty-list / list-with-code /
    # list-without-code. Malformed (non-list) is tested separately.
    branch = draw(st.sampled_from(["absent", "empty", "with_code", "without_code"]))
    if branch == "absent":
        pass # do not add 'outputs'
    elif branch == "empty":
        base["outputs"] = []
    elif branch == "with_code":
        base["outputs"] = draw(
            st.lists(output_token, min_size=1, max_size=4)
        ) + ["code"]
    else: # without_code — lists that never contain the 'code' token
        base["outputs"] = draw(
            st.lists(
                output_token.filter(lambda t: t!= "code"),
                min_size=1,
                max_size=4,
            )
        )

    if draw(st.booleans()):
        base["description"] = draw(st.text(max_size=50))
    return base

# ---------------------------------------------------------------------------
# 1. Deterministic unit cases
# ---------------------------------------------------------------------------

class TestAssertToolSpecBindingDeterministic:
    """Case 1 — deterministic behaviour of ``assert_tool_spec_binding``."""

    def test_code_generating_without_spec_raises(self):
        """``outputs`` containing 'code' → code-generating; no spec → rejects."""
        tool = {"name": "gen_lambda", "outputs": ["code"]}
        with pytest.raises(SpecificationNotBoundError) as exc_info:
            assert_tool_spec_binding(tool, None)
        assert "gen_lambda" in str(exc_info.value)

    def test_code_generating_with_empty_spec_raises(self):
        tool = {"name": "gen_lambda", "outputs": ["code"]}
        with pytest.raises(SpecificationNotBoundError):
            assert_tool_spec_binding(tool, "")

    def test_code_generating_with_spec_passes(self):
        tool = {"name": "gen_lambda", "outputs": ["code"]}
        # Should not raise.
        assert_tool_spec_binding(tool, "spec-abc-123")

    def test_non_code_generating_empty_outputs_without_spec_passes(self):
        """``outputs = []`` → NOT code-generating per Track A rule."""
        tool = {"name": "read_only", "outputs": []}
        assert_tool_spec_binding(tool, None)

    def test_non_code_generating_no_code_token_without_spec_passes(self):
        """``outputs`` without the literal 'code' token → NOT code-generating."""
        tool = {"name": "read_only", "outputs": ["data", "report"]}
        assert_tool_spec_binding(tool, None)

    def test_non_code_generating_with_spec_passes(self):
        tool = {"name": "read_only", "outputs": ["data"]}
        assert_tool_spec_binding(tool, "spec-abc-123")

    def test_missing_outputs_without_spec_raises_conservative_default(self):
        """Missing ``outputs`` → conservative default treats as code-generating."""
        tool = {"name": "ambiguous"} # no 'outputs' key at all
        with pytest.raises(SpecificationNotBoundError):
            assert_tool_spec_binding(tool, None)

    def test_missing_outputs_with_spec_passes(self):
        tool = {"name": "ambiguous"}
        assert_tool_spec_binding(tool, "spec-abc-123")

    def test_malformed_outputs_surfaces_value_error(self):
        """Non-list ``outputs`` → ``ValueError`` propagates from predicate."""
        tool = {"name": "bad", "outputs": "not-a-list"}
        with pytest.raises(ValueError):
            assert_tool_spec_binding(tool, None)

    def test_tool_without_name_still_raises_with_unknown_placeholder(self):
        tool = {"outputs": ["code"]}
        with pytest.raises(SpecificationNotBoundError) as exc_info:
            assert_tool_spec_binding(tool, None)
        assert "<unknown>" in str(exc_info.value)

# ---------------------------------------------------------------------------
# 2. Property test: invariant via the SHARED predicate
# ---------------------------------------------------------------------------

class TestAssertToolSpecBindingProperty:
    """Case 2 — ``assert_tool_spec_binding`` raises iff
    ``is_code_generating(tool) and not spec_id`` for any random manifest
    and any spec value.

    Because we import ``is_code_generating`` from the same ``tools_config``
    module the production code uses, this test is the QT3-6 lockstep check.
    The invariant is exactly the same property verified by Track A's
    fabricator-side test over ``validate_code_tool_binding`` — any drift in
    the underlying predicate would break both tests simultaneously.
    """

    @given(tool=tool_manifest(), spec_id=spec_id_values)
    @settings(
        max_examples=300,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow],
    )
    def test_raises_iff_code_generating_and_no_spec(self, tool, spec_id):
        # Reference predicate is resolved through the SAME module as
        # production — there is no local copy.
        predicate_says_code_generating = shared_is_code_generating(tool)
        should_raise = predicate_says_code_generating and not spec_id

        if should_raise:
            with pytest.raises(SpecificationNotBoundError):
                assert_tool_spec_binding(tool, spec_id)
        else:
            # Must NOT raise for any other combination.
            assert_tool_spec_binding(tool, spec_id)

# ---------------------------------------------------------------------------
# 3. Event-shape test: simulate the ``process_event`` insertion point
# ---------------------------------------------------------------------------

class TestDispatchPipelineRejectsUnboundCodeGeneration:
    """Case 3 — the dispatch insertion point iterates ``tool_configs`` and
    rejects the first code-generating tool that lacks a bound spec_id.

    This test does not exercise ``process_event`` directly (that would pull in
    boto3/DDB/SQS) — instead it replays the exact resolution + iteration
    pattern that lives at the insertion point in ``index.py``.
    """

    @staticmethod
    def _simulate_dispatch(tool_configs, event, request):
        bound_spec_id = (
            event.get("spec_id")
            or event.get("specId")
            or request.get("spec_id")
            or request.get("specId")
        )
        for tool_cfg in tool_configs:
            assert_tool_spec_binding(tool_cfg, bound_spec_id)

    def test_rejects_code_generating_when_no_spec_anywhere(self):
        tool_configs = [
            {"toolId": "t1", "name": "read_only", "outputs": ["data"]},
            {"toolId": "t2", "name": "gen_lambda", "outputs": ["code"]},
        ]
        with pytest.raises(SpecificationNotBoundError):
            self._simulate_dispatch(tool_configs, event={}, request={})

    def test_accepts_when_spec_id_snake_case_on_event(self):
        tool_configs = [
            {"toolId": "t2", "name": "gen_lambda", "outputs": ["code"]},
        ]
        self._simulate_dispatch(
            tool_configs,
            event={"spec_id": "spec-snake"},
            request={},
        )

    def test_accepts_when_spec_id_camel_case_on_event(self):
        tool_configs = [
            {"toolId": "t2", "name": "gen_lambda", "outputs": ["code"]},
        ]
        self._simulate_dispatch(
            tool_configs,
            event={"specId": "spec-camel"},
            request={},
        )

    def test_accepts_when_spec_id_snake_case_on_request(self):
        tool_configs = [
            {"toolId": "t2", "name": "gen_lambda", "outputs": ["code"]},
        ]
        self._simulate_dispatch(
            tool_configs,
            event={},
            request={"spec_id": "spec-req-snake"},
        )

    def test_accepts_when_spec_id_camel_case_on_request(self):
        tool_configs = [
            {"toolId": "t2", "name": "gen_lambda", "outputs": ["code"]},
        ]
        self._simulate_dispatch(
            tool_configs,
            event={},
            request={"specId": "spec-req-camel"},
        )

    def test_event_spec_takes_precedence_over_empty_request(self):
        """Both keys searched; first non-empty wins."""
        tool_configs = [
            {"toolId": "t2", "name": "gen_lambda", "outputs": ["code"]},
        ]
        # Empty request.spec_id must not shadow a populated event.spec_id.
        self._simulate_dispatch(
            tool_configs,
            event={"spec_id": "real-spec"},
            request={"spec_id": ""},
        )

    def test_all_non_code_generating_tools_pass_without_spec(self):
        tool_configs = [
            {"toolId": "t1", "name": "read_only", "outputs": ["data"]},
            {"toolId": "t2", "name": "also_read_only", "outputs": []},
        ]
        self._simulate_dispatch(tool_configs, event={}, request={})

    def test_empty_tool_configs_is_noop(self):
        self._simulate_dispatch([], event={}, request={})

    def test_mixed_tools_spec_present_accepts_all(self):
        tool_configs = [
            {"toolId": "t1", "name": "read_only", "outputs": ["data"]},
            {"toolId": "t2", "name": "gen_lambda", "outputs": ["code"]},
            {"toolId": "t3", "name": "missing_outputs"}, # conservative default
        ]
        self._simulate_dispatch(
            tool_configs,
            event={"spec_id": "spec-abc"},
            request={},
        )

# ---------------------------------------------------------------------------
# 4. Key-alias coverage property
# ---------------------------------------------------------------------------

class TestSpecIdKeyAliases:
    """Case 4 — any of the four recognised key paths resolves the spec_id.

    Fail-closed: if none of ``event.spec_id``, ``event.specId``,
    ``request.spec_id``, ``request.specId`` carries a non-empty value, a
    code-generating tool must be rejected.
    """

    key_names = st.sampled_from(["spec_id", "specId"])
    container = st.sampled_from(["event", "request"])

    @given(
        container=container,
        key=key_names,
        spec=st.text(min_size=1, max_size=20, alphabet="abcdef0123456789-"),
    )
    @settings(max_examples=60, deadline=None)
    def test_any_valid_alias_unblocks_dispatch(self, container, key, spec):
        tool_configs = [
            {"toolId": "t", "name": "gen", "outputs": ["code"]},
        ]
        event: dict = {}
        request: dict = {}
        if container == "event":
            event[key] = spec
        else:
            request[key] = spec

        bound_spec_id = (
            event.get("spec_id")
            or event.get("specId")
            or request.get("spec_id")
            or request.get("specId")
        )
        # Must not raise.
        for tool_cfg in tool_configs:
            assert_tool_spec_binding(tool_cfg, bound_spec_id)

    @given(container=container, key=key_names)
    @settings(max_examples=40, deadline=None)
    def test_empty_string_alias_does_not_unblock_dispatch(self, container, key):
        tool_configs = [
            {"toolId": "t", "name": "gen", "outputs": ["code"]},
        ]
        event: dict = {}
        request: dict = {}
        if container == "event":
            event[key] = ""
        else:
            request[key] = ""

        bound_spec_id = (
            event.get("spec_id")
            or event.get("specId")
            or request.get("spec_id")
            or request.get("specId")
        )
        with pytest.raises(SpecificationNotBoundError):
            for tool_cfg in tool_configs:
                assert_tool_spec_binding(tool_cfg, bound_spec_id)
