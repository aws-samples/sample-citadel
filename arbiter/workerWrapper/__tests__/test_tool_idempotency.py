"""Tests for arbiter/workerWrapper/tool_idempotency.py (PR1).

Covers canonicalization (incl. the two flagged determinism traps: non-string
dict keys and integral-float/-0.0 collapse), key derivation, org-scoping in
the partition key, bypass classification (fail-safe default), and the
bypass-misflag guard (strict-mode block).
"""
from __future__ import annotations

import os
import sys

import pytest
from hypothesis import given, settings, strategies as st

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.workerWrapper.tool_idempotency import (  # noqa: E402
    BypassMisflagError,
    CanonicalizationError,
    COMPENSATION_MARKER,
    MODE_BYPASS,
    MODE_LEDGER,
    args_hash,
    build_key,
    build_partition_key,
    build_sort_key,
    canonicalize,
    check_bypass_classification,
    classify_idempotency_mode,
    detect_write_verbs,
)


# ---------------------------------------------------------------------------
# Canonicalization — determinism basics
# ---------------------------------------------------------------------------


class TestCanonicalizationDeterminism:
    def test_key_order_permutation_hashes_equal(self):
        a = {"b": 1, "a": 2, "c": {"y": 1, "x": 2}}
        b = {"c": {"x": 2, "y": 1}, "a": 2, "b": 1}
        assert args_hash(a) == args_hash(b)

    def test_naive_json_dumps_differs_on_shuffled_keys_but_canonical_does_not(self):
        # Differential: unsorted json.dumps produces different text on
        # reordered keys; our canonicalizer collapses them.
        import json

        a = {"b": 1, "a": 2}
        b = {"a": 2, "b": 1}
        assert json.dumps(a) != json.dumps(b)  # RED for naive approach
        assert canonicalize(a) == canonicalize(b)  # GREEN for canonical

    def test_string_key_distinct_from_int_value(self):
        # "1" (string) must NOT collapse into 1 (number).
        assert args_hash({"k": "1"}) != args_hash({"k": 1})

    def test_null_is_not_equal_to_missing(self):
        assert args_hash({"a": None}) != args_hash({})

    def test_nested_lists_stable(self):
        assert args_hash({"xs": [1, 2, 3]}) == args_hash({"xs": [1, 2, 3]})
        assert args_hash({"xs": [1, 2, 3]}) != args_hash({"xs": [3, 2, 1]})


# ---------------------------------------------------------------------------
# Flagged trap #1 — non-string dict keys reject deterministically
# ---------------------------------------------------------------------------


class TestNonStringKeys:
    def test_int_key_rejected(self):
        with pytest.raises(CanonicalizationError):
            canonicalize({1: "a"})

    def test_mixed_str_int_keys_rejected(self):
        # json.dumps(sort_keys=True) would raise TypeError on this; we reject
        # with a clear, deterministic CanonicalizationError instead.
        with pytest.raises(CanonicalizationError):
            canonicalize({"a": 1, 2: "b"})

    def test_nested_non_string_key_rejected(self):
        with pytest.raises(CanonicalizationError):
            canonicalize({"outer": {None: "x"}})

    def test_rejection_is_deterministic(self):
        # Same pathological input always raises (never sometimes-collides).
        for _ in range(5):
            with pytest.raises(CanonicalizationError):
                canonicalize({True: 1})  # bool key is not a str


# ---------------------------------------------------------------------------
# Flagged trap #2 — integral-float / -0.0 semantic collapse
# ---------------------------------------------------------------------------


class TestNumberNormalization:
    def test_integral_float_collapses_to_int(self):
        assert args_hash({"n": 2.0}) == args_hash({"n": 2})

    def test_exponent_integral_float_collapses(self):
        assert args_hash({"n": 1e0}) == args_hash({"n": 1})

    def test_negative_zero_collapses_to_zero(self):
        assert args_hash({"n": -0.0}) == args_hash({"n": 0})
        assert args_hash({"n": -0.0}) == args_hash({"n": 0.0})

    def test_non_integral_float_preserved(self):
        assert args_hash({"n": 2.5}) != args_hash({"n": 2})
        assert canonicalize({"n": 2.5}) == canonicalize({"n": 2.5})

    def test_nan_rejected(self):
        with pytest.raises(CanonicalizationError):
            canonicalize({"n": float("nan")})

    def test_inf_rejected(self):
        with pytest.raises(CanonicalizationError):
            canonicalize({"n": float("inf")})
        with pytest.raises(CanonicalizationError):
            canonicalize({"n": float("-inf")})

    def test_bool_not_collapsed_to_int(self):
        # bool is an int subclass; True must stay a boolean, not become 1.
        assert args_hash({"b": True}) != args_hash({"b": 1})
        assert canonicalize({"b": True}) == canonicalize({"b": True})


# ---------------------------------------------------------------------------
# Property tests
# ---------------------------------------------------------------------------

_json_scalars = st.one_of(
    st.none(),
    st.booleans(),
    st.integers(min_value=-(10**12), max_value=10**12),
    st.text(max_size=20),
)
_json_values = st.recursive(
    _json_scalars,
    lambda children: st.one_of(
        st.lists(children, max_size=5),
        st.dictionaries(st.text(min_size=1, max_size=8), children, max_size=5),
    ),
    max_leaves=25,
)


class TestCanonicalizationProperties:
    @settings(max_examples=200, deadline=None)
    @given(_json_values)
    def test_canonicalize_is_stable(self, value):
        # Property: canonicalize is a pure function of value — same input,
        # same output, and the same key never yields two different hashes.
        assert args_hash(value) == args_hash(value)

    @settings(max_examples=200, deadline=None)
    @given(st.dictionaries(st.text(min_size=1, max_size=6), _json_scalars, max_size=6))
    def test_dict_key_reordering_is_hash_invariant(self, d):
        import random

        items = list(d.items())
        random.shuffle(items)
        shuffled = dict(items)
        assert args_hash(d) == args_hash(shuffled)


# ---------------------------------------------------------------------------
# Key derivation + org scoping
# ---------------------------------------------------------------------------


class TestKeyDerivation:
    def test_partition_key_is_org_prefixed(self):
        assert build_partition_key("orgA", "exec1") == "orgA#exec1"

    def test_same_call_different_org_yields_different_pk(self):
        pk_a, sk_a = build_key("orgA", "exec1", "node1", 0, "createTicket", {"x": 1})
        pk_b, sk_b = build_key("orgB", "exec1", "node1", 0, "createTicket", {"x": 1})
        assert pk_a != pk_b            # structural cross-org isolation
        assert sk_a == sk_b            # same logical call -> same SK

    def test_sort_key_composition(self):
        _, sk = build_key("o", "e", "node9", 3, "sendEmail", {"to": "a@b.c"})
        assert sk.startswith("node9#3#sendEmail#")
        assert len(sk.rsplit("#", 1)[1]) == 64  # sha256 hex

    def test_same_call_index_different_tool_differs(self):
        _, sk_a = build_key("o", "e", "n", 0, "toolA", {"x": 1})
        _, sk_b = build_key("o", "e", "n", 0, "toolB", {"x": 1})
        assert sk_a != sk_b  # toolName in SK prevents wrongful absorption

    def test_different_args_differ(self):
        _, sk_a = build_key("o", "e", "n", 0, "t", {"x": 1})
        _, sk_b = build_key("o", "e", "n", 0, "t", {"x": 2})
        assert sk_a != sk_b


# ---------------------------------------------------------------------------
# f9ceb38e — compensation ledger-key collision fix
#
# The defect (verified empirically): a compensation for node id 'n1' derived
# its key by handing build_key/build_sort_key the ALREADY-SUFFIXED string
# 'n1#comp' as a plain node_id. A node literally NAMED 'n1#comp' running its
# OWN original (non-compensation) call derives the identical sort key
# ('n1#comp#0#TOOL#argsHash' either way) — the colliding party then replays
# the other's recorded result via a ledger HIT_COMPLETED and skips its real
# side effect. Fixed at two layers:
#   1. common.workflow_contract._validate_identity now rejects the reserved
#      '#' delimiter in any identifier that flows into a dispatch/result
#      message build (covered by test_workflow_contract.py).
#   2. Belt-and-braces, HERE: build_sort_key/build_key take an explicit
#      is_compensation flag that appends COMPENSATION_MARKER as a 5th field
#      AFTER hash_hex (never adjacent to node_id). hash_hex is always exactly
#      64 lowercase hex characters with no '#', so an original (4-field) key
#      can never end in the literal "#comp" a compensation (5-field) key
#      appends — collision-freedom holds for EVERY possible node_id,
#      independent of identifier hygiene. Two earlier designs (a marker
#      segment adjacent to node_id; splitting the partition key) were tried
#      and proven unsound/invasive respectively — see COMPENSATION_MARKER's
#      docstring in tool_idempotency.py for why they were rejected.
# ---------------------------------------------------------------------------


class TestCompensationMarkerCollisionFix:
    def test_concrete_regression_n1_comp_literal_node_id(self):
        """The exact defect scenario: an ORIGINAL (non-compensation) call for
        a node literally named 'n1#comp' must NOT collide with a
        COMPENSATION call for a node named 'n1'."""
        original_pk, original_sk = build_key(
            "org1", "exec1", "n1#comp", 0, "TOOL", {"a": 1},
            is_compensation=False,
        )
        compensation_pk, compensation_sk = build_key(
            "org1", "exec1", "n1", 0, "TOOL", {"a": 1},
            is_compensation=True,
        )
        assert original_pk == compensation_pk  # same org/execution partition
        assert original_sk != compensation_sk  # sort keys MUST differ

    def test_compensation_key_differs_from_same_node_original_key(self):
        """The common case: a compensation for node 'n1' must not collide
        with node 'n1's own original call, for identical tool/args/call
        index (the two attempts a real double-delivery guard must tell
        apart)."""
        pk_a, sk_a = build_key("org1", "exec1", "n1", 0, "TOOL", {"a": 1}, is_compensation=False)
        pk_b, sk_b = build_key("org1", "exec1", "n1", 0, "TOOL", {"a": 1}, is_compensation=True)
        assert pk_a == pk_b
        assert sk_a != sk_b

    def test_compensation_marker_is_appended_after_the_hex_digest_field(self):
        # Precondition the collision-freedom proof relies on: hash_hex is
        # always exactly 64 lowercase hex characters (sha256 hexdigest,
        # alphabet [0-9a-f]) with no '#', so appending "#" + COMPENSATION_
        # MARKER after it can never be produced by hash_hex's own content —
        # the boundary is anchored to a field callers cannot control the
        # alphabet of, not to node_id (which callers fully control).
        hash_hex = "0" * 64
        assert all(c in "0123456789abcdef" for c in hash_hex)
        original = build_sort_key("n", 0, "t", hash_hex, is_compensation=False)
        compensation = build_sort_key("n", 0, "t", hash_hex, is_compensation=True)
        assert compensation == f"{original}#{COMPENSATION_MARKER}"
        assert not original.endswith(f"#{COMPENSATION_MARKER}")

    @given(
        node_id=st.text(min_size=0, max_size=40),
        other_node_id=st.text(min_size=0, max_size=40),
        call_index=st.integers(min_value=0, max_value=1000),
        tool_name=st.text(min_size=1, max_size=40),
        args=st.dictionaries(st.text(min_size=1, max_size=10), st.integers(), max_size=5),
    )
    @settings(max_examples=300, deadline=None)
    def test_original_and_compensation_keys_never_equal_for_any_node_ids(
        self, node_id, other_node_id, call_index, tool_name, args,
    ):
        """Property: for ARBITRARY node ids — including hostile ones
        containing '#', the literal substring '#comp', unicode, and
        empty-ish segments (the empty string itself, and strings composed
        only of '#') — an ORIGINAL call's key and a COMPENSATION call's key
        are NEVER equal, whether the two calls are for the same node id or
        two different (possibly colliding-by-construction) node ids.

        This must hold at the ``build_sort_key``/``build_key`` layer alone,
        independent of ``common.workflow_contract``'s identifier-hygiene
        rejection — it is the belt-and-braces guarantee, so the strategy
        deliberately generates node ids a validator would reject (this
        module has no opinion on identifier hygiene; the ``is_compensation``
        flag alone must carry collision-freedom).
        """
        original_sk = build_sort_key(node_id, call_index, tool_name, "deadbeef", is_compensation=False)
        compensation_sk = build_sort_key(
            other_node_id, call_index, tool_name, "deadbeef", is_compensation=True,
        )
        assert original_sk != compensation_sk

    @given(
        node_id=st.one_of(
            st.just(""),
            st.just("#"),
            st.just("##"),
            st.just("#comp"),
            st.just("n1#comp"),
            st.text(alphabet=st.characters(min_codepoint=0x1F600, max_codepoint=0x1F64F), min_size=1, max_size=5),
            st.text(min_size=0, max_size=40),
        ),
        call_index=st.integers(min_value=0, max_value=1000),
        tool_name=st.text(min_size=1, max_size=40),
    )
    @settings(max_examples=300, deadline=None)
    def test_same_node_id_original_vs_compensation_never_equal_hostile_ids(
        self, node_id, call_index, tool_name,
    ):
        """Property, narrower and stronger than the above: for the SAME
        hostile node id (including '#', '#comp', 'n1#comp', unicode, and
        empty string), the ORIGINAL call's key for that id and the
        COMPENSATION call's key for that SAME id are never equal — the
        exact shape of the historical defect (one node id, two roles).
        """
        original_sk = build_sort_key(node_id, call_index, tool_name, "deadbeef", is_compensation=False)
        compensation_sk = build_sort_key(node_id, call_index, tool_name, "deadbeef", is_compensation=True)
        assert original_sk != compensation_sk


# ---------------------------------------------------------------------------
# Bypass classification (fail-safe default = ledger)
# ---------------------------------------------------------------------------


class TestBypassClassification:
    def test_absent_flag_defaults_to_ledger(self):
        assert classify_idempotency_mode({}) == MODE_LEDGER
        assert classify_idempotency_mode(None) == MODE_LEDGER

    def test_malformed_idempotency_block_defaults_to_ledger(self):
        assert classify_idempotency_mode({"idempotency": "nope"}) == MODE_LEDGER
        assert classify_idempotency_mode({"idempotency": {}}) == MODE_LEDGER

    def test_unrecognized_mode_defaults_to_ledger(self):
        assert classify_idempotency_mode({"idempotency": {"mode": "weird"}}) == MODE_LEDGER

    def test_explicit_bypass(self):
        assert classify_idempotency_mode({"idempotency": {"mode": "bypass"}}) == MODE_BYPASS

    def test_explicit_ledger(self):
        assert classify_idempotency_mode({"idempotency": {"mode": "ledger"}}) == MODE_LEDGER


# ---------------------------------------------------------------------------
# Bypass misflag guard (blocks in strict mode)
# ---------------------------------------------------------------------------


class TestBypassMisflagGuard:
    _WRITING_CODE = "def handler(x):\n    ddb.put_item(Item=x)\n    return 'ok'\n"
    _READONLY_CODE = "def handler(x):\n    return ddb.get_item(Key=x)\n"

    def test_detect_write_verbs_finds_put_item(self):
        assert "put_item" in detect_write_verbs(self._WRITING_CODE)

    def test_detect_write_verbs_clean_on_readonly(self):
        assert detect_write_verbs(self._READONLY_CODE) == []

    def test_ledger_tool_is_never_scrutinized(self):
        # A ledger-classified tool with writing code is fine — the guard only
        # scrutinizes bypass claims.
        assert check_bypass_classification(
            {"idempotency": {"mode": "ledger"}}, self._WRITING_CODE,
            enforcement_mode="strict",
        ) == []

    def test_misflagged_bypass_blocks_in_strict(self):
        with pytest.raises(BypassMisflagError):
            check_bypass_classification(
                {"idempotency": {"mode": "bypass"}}, self._WRITING_CODE,
                enforcement_mode="strict",
            )

    def test_misflagged_bypass_warns_not_blocks_in_shadow(self):
        hits = check_bypass_classification(
            {"idempotency": {"mode": "bypass"}}, self._WRITING_CODE,
            enforcement_mode="shadow",
        )
        assert "put_item" in hits  # returned for the caller to WARN/record

    def test_clean_bypass_passes_in_strict(self):
        assert check_bypass_classification(
            {"idempotency": {"mode": "bypass"}}, self._READONLY_CODE,
            enforcement_mode="strict",
        ) == []
