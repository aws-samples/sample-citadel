"""Approval-gate enumeration guard (CIT-041 PR3).

Every agent-dispatch entry point in arbiter must call the record-approval gate
BEFORE it performs the dispatch (or its first side effect), so a strict-mode
refusal leaves no partial dispatch trace. The gated entry points are
enumerated in ``fixtures/dispatch_entry_points.py``; this guard FAILS if:

* an enumerated entry point stops calling one of its required gate functions,
  or calls it after the dispatch anchor (``TestEnumeratedEntryPointsAreGated``);
* a function whose name looks like a dispatch path appears in one of the
  guarded modules without being enumerated or explicitly exempted with a
  reason (``TestEveryDispatchLikeFunctionIsAccountedFor``).

Detection is STRUCTURAL (stdlib ``ast``), like
``arbiter/common/__tests__/test_no_parallel_retryable_lists.py``: the checker
parses the module, locates the function, and compares source positions of the
gate ``Call`` nodes against the anchor ``Call``. Nested scopes (inner defs,
lambdas, classes) are NOT descended into — a gate call sitting in a closure
that is never invoked must not count as gating the enclosing function.

Bite-proof: ``TestGuardBitesOnUngatedDispatch`` runs the checker on synthetic
sources with the gate missing / misordered / hidden in a closure and asserts
it reports each one.
"""
from __future__ import annotations

import ast
import os
import sys

import pytest

_ARBITER_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_PROJECT_ROOT = os.path.abspath(os.path.join(_ARBITER_ROOT, ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.governance.__tests__.fixtures.dispatch_entry_points import (  # noqa: E402
    DISPATCH_ENTRY_POINTS,
    DISPATCH_NAME_PATTERN,
    EXEMPT,
    DispatchEntryPoint,
)

_FunctionNode = ast.FunctionDef | ast.AsyncFunctionDef
_NESTED_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)


# --------------------------------------------------------------------------
# Checker
# --------------------------------------------------------------------------


def _callee_name(call: ast.Call) -> str | None:
    """Dotted name of a call's callee: ``foo`` for ``foo(...)``,
    ``a.b.c`` for ``a.b.c(...)``. ``None`` for anything else (subscripts,
    calls on call results, ...)."""
    parts: list[str] = []
    node: ast.AST = call.func
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    parts.append(node.id)
    return ".".join(reversed(parts))


def _name_matches(callee: str | None, target: str) -> bool:
    """``target`` matches the callee exactly, or matches its trailing dotted
    segment(s) (so ``update_item`` matches ``_executions_table.update_item``)."""
    if callee is None:
        return False
    return callee == target or callee.endswith("." + target)


def _iter_calls_in_scope(func: _FunctionNode):
    """Yield every ``ast.Call`` in *func*'s own body, in source order, without
    descending into nested function / lambda / class scopes."""
    stack: list[ast.AST] = list(reversed(func.body))
    while stack:
        node = stack.pop()
        if isinstance(node, _NESTED_SCOPES):
            continue
        if isinstance(node, ast.Call):
            yield node
        stack.extend(reversed(list(ast.iter_child_nodes(node))))


def _find_functions(tree: ast.AST, name: str) -> list[_FunctionNode]:
    return [
        n
        for n in ast.walk(tree)
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name
    ]


def _pos(node: ast.AST) -> tuple[int, int]:
    return (node.lineno, node.col_offset)


def check_dispatch_entry_point(
    source: str,
    function: str,
    required_gates: tuple[str, ...],
    anchor: str,
) -> list[str]:
    """Return every violation found for *function* in *source*; ``[]`` means
    the entry point is correctly gated.

    Violations:
    * the function is missing (or defined more than once — ambiguous);
    * a required gate is never called in the function's own scope;
    * the dispatch anchor is never called (the fixture is stale);
    * the FIRST call of a required gate is positioned after the FIRST call
      of the anchor (the dispatch can run un-gated).
    """
    tree = ast.parse(source)
    matches = _find_functions(tree, function)
    if not matches:
        return [f"function {function!r} not found"]
    if len(matches) > 1:
        return [f"function {function!r} defined {len(matches)} times; ambiguous"]
    func = matches[0]

    calls = sorted(_iter_calls_in_scope(func), key=_pos)
    first_call: dict[str, ast.Call] = {}
    for call in calls:
        callee = _callee_name(call)
        for target in (*required_gates, anchor):
            if target not in first_call and _name_matches(callee, target):
                first_call[target] = call

    violations: list[str] = []
    for gate in required_gates:
        if gate not in first_call:
            violations.append(f"{function}: required gate {gate!r} is never called")
    if anchor not in first_call:
        violations.append(
            f"{function}: dispatch anchor {anchor!r} not found; fixture is stale"
        )
    if violations:
        return violations

    anchor_call = first_call[anchor]
    for gate in required_gates:
        gate_call = first_call[gate]
        if _pos(gate_call) >= _pos(anchor_call):
            violations.append(
                f"{function}: gate {gate!r} (line {gate_call.lineno}) is called "
                f"AFTER dispatch anchor {anchor!r} (line {anchor_call.lineno})"
            )
    return violations


def dispatch_like_functions(source: str) -> list[str]:
    """Names of every function (any nesting, methods included) in *source*
    whose name matches ``DISPATCH_NAME_PATTERN``."""
    return sorted(
        {
            n.name
            for n in ast.walk(ast.parse(source))
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))
            and DISPATCH_NAME_PATTERN.search(n.name)
        }
    )


def _read(module: str) -> str:
    with open(os.path.join(_ARBITER_ROOT, module), "r", encoding="utf-8") as fh:
        return fh.read()


def _entry_id(ep: DispatchEntryPoint) -> str:
    return f"{ep.module}::{ep.function}"


# --------------------------------------------------------------------------
# Test 3 — positive controls: the checker MUST bite.
# --------------------------------------------------------------------------


_GATED = (
    "def invoke_node(execution_id, node):\n"
    "    refused, reason = _check_approval_gate(node['agentId'], 'wf', execution_id)\n"
    "    if refused:\n"
    "        return\n"
    "    _executions_table.update_item(Key={'executionId': execution_id})\n"
    "    events.publish_node_started(execution_id)\n"
)

_MISSING_GATE = (
    "def invoke_node(execution_id, node):\n"
    "    _executions_table.update_item(Key={'executionId': execution_id})\n"
    "    events.publish_node_started(execution_id)\n"
)

_GATE_AFTER_DISPATCH = (
    "def invoke_node(execution_id, node):\n"
    "    _executions_table.update_item(Key={'executionId': execution_id})\n"
    "    refused, reason = _check_approval_gate(node['agentId'], 'wf', execution_id)\n"
    "    if refused:\n"
    "        return\n"
)

_GATE_ONLY_IN_CLOSURE = (
    "def invoke_node(execution_id, node):\n"
    "    def _gate():\n"
    "        return _check_approval_gate(node['agentId'], 'wf', execution_id)\n"
    "    _executions_table.update_item(Key={'executionId': execution_id})\n"
)

_TWO_GATES_ONE_MISSING = (
    "def governed_process_agent_call(cfg):\n"
    "    approval_resolution = resolve_record_approval(cfg)\n"
    "    return process_agent_call(cfg)\n"
)


class TestGuardBitesOnUngatedDispatch:
    def test_missing_gate_is_reported(self):
        violations = check_dispatch_entry_point(
            _MISSING_GATE, "invoke_node", ("_check_approval_gate",), "update_item"
        )
        assert violations and "never called" in violations[0], violations

    def test_gate_after_dispatch_anchor_is_reported(self):
        violations = check_dispatch_entry_point(
            _GATE_AFTER_DISPATCH, "invoke_node", ("_check_approval_gate",), "update_item"
        )
        assert violations and "AFTER dispatch anchor" in violations[0], violations

    def test_gate_hidden_in_closure_does_not_count(self):
        violations = check_dispatch_entry_point(
            _GATE_ONLY_IN_CLOSURE, "invoke_node", ("_check_approval_gate",), "update_item"
        )
        assert violations and "never called" in violations[0], violations

    def test_each_required_gate_is_checked_independently(self):
        violations = check_dispatch_entry_point(
            _TWO_GATES_ONE_MISSING,
            "governed_process_agent_call",
            ("resolve_record_approval", "approval_decide"),
            "process_agent_call",
        )
        assert violations == [
            "governed_process_agent_call: required gate 'approval_decide' is never called"
        ]

    def test_missing_function_is_reported(self):
        violations = check_dispatch_entry_point(
            _GATED, "no_such_function", ("_check_approval_gate",), "update_item"
        )
        assert violations == ["function 'no_such_function' not found"]

    def test_stale_anchor_is_reported(self):
        violations = check_dispatch_entry_point(
            _GATED, "invoke_node", ("_check_approval_gate",), "send_message"
        )
        assert violations and "fixture is stale" in violations[0], violations

    def test_correctly_gated_dispatch_is_clean(self):
        # Negative control: both the bare and the dotted anchor spelling match.
        assert check_dispatch_entry_point(
            _GATED, "invoke_node", ("_check_approval_gate",), "update_item"
        ) == []
        assert check_dispatch_entry_point(
            _GATED, "invoke_node", ("_check_approval_gate",), "_executions_table.update_item"
        ) == []

    def test_anchor_matching_is_segment_anchored_not_substring(self):
        # 'item' is a substring of 'update_item' but not a dotted segment.
        violations = check_dispatch_entry_point(
            _GATED, "invoke_node", ("_check_approval_gate",), "item"
        )
        assert violations and "fixture is stale" in violations[0], violations

    def test_dispatch_like_name_scan_finds_nested_and_methods(self):
        src = (
            "def helper():\n"
            "    def _dispatch_inner():\n"
            "        pass\n"
            "class W:\n"
            "    def process_event(self):\n"
            "        pass\n"
            "def unrelated():\n"
            "    pass\n"
        )
        assert dispatch_like_functions(src) == ["_dispatch_inner", "process_event"]


# --------------------------------------------------------------------------
# Test 1 — every enumerated entry point calls its gate(s) before dispatching.
# --------------------------------------------------------------------------


class TestEnumeratedEntryPointsAreGated:
    @pytest.mark.parametrize("ep", DISPATCH_ENTRY_POINTS, ids=_entry_id)
    def test_gate_called_before_dispatch(self, ep: DispatchEntryPoint):
        violations = check_dispatch_entry_point(
            _read(ep.module), ep.function, ep.required_gates, ep.anchor
        )
        assert violations == [], (
            f"{ep.module} — {ep.note}\n  " + "\n  ".join(violations)
        )


# --------------------------------------------------------------------------
# Test 2 — completeness: no dispatch-looking function escapes enumeration.
# --------------------------------------------------------------------------


_GUARDED_MODULES = sorted({ep.module for ep in DISPATCH_ENTRY_POINTS})
_ENUMERATED = {(ep.module, ep.function) for ep in DISPATCH_ENTRY_POINTS}


class TestEveryDispatchLikeFunctionIsAccountedFor:
    @pytest.mark.parametrize("module", _GUARDED_MODULES)
    def test_no_unaccounted_dispatch_like_function(self, module: str):
        found = dispatch_like_functions(_read(module))
        unaccounted = [
            name
            for name in found
            if (module, name) not in _ENUMERATED and (module, name) not in EXEMPT
        ]
        assert unaccounted == [], (
            f"{module} defines dispatch-looking function(s) {unaccounted} that are "
            "neither enumerated in DISPATCH_ENTRY_POINTS nor listed in EXEMPT "
            "(fixtures/dispatch_entry_points.py). If it dispatches an agent, "
            "add it to the fixture with its gate + anchor; otherwise exempt it "
            "with a concrete reason."
        )

    def test_enumerated_entry_points_match_the_name_pattern(self):
        # The completeness scan can only protect names the pattern catches.
        unmatched = [
            _entry_id(ep)
            for ep in DISPATCH_ENTRY_POINTS
            if not DISPATCH_NAME_PATTERN.search(ep.function)
        ]
        assert unmatched == [], (
            f"{unmatched} would not be caught by DISPATCH_NAME_PATTERN; widen it"
        )

    def test_exempt_entries_are_live_and_not_also_enumerated(self):
        stale = [
            key
            for key in EXEMPT
            if key[0] not in _GUARDED_MODULES
            or key[1] not in dispatch_like_functions(_read(key[0]))
        ]
        assert stale == [], f"stale EXEMPT entries (function gone or renamed): {stale}"
        overlap = sorted(set(EXEMPT) & _ENUMERATED)
        assert overlap == [], f"both enumerated and exempt: {overlap}"

    def test_every_exemption_carries_a_reason(self):
        empty = [key for key, reason in EXEMPT.items() if not reason.strip()]
        assert empty == [], f"EXEMPT entries without a reason: {empty}"
