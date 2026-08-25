"""No-parallel-retryable-list guard (board task 9099b8cb).

The whole point of the unified failure taxonomy is that retry classification
lives in ONE place (``common/failure_taxonomy.py``). This guard FAILS if any
consumer reintroduces its own hardcoded collection of error-code string
literals — the exact "second parallel list" this story removed (the failure
mode that let layer-2 governance drift inert, finding 027c4a89).

Detection is STRUCTURAL (AST), not text matching: it flags any tuple / list /
set / frozenset(...) / set(...) literal that contains >= 2 string constants
that look like error codes (ending in ``Exception`` or ``Error``, any casing).
That is precisely the shape of the private sets that were removed:
``("ThrottlingException", "InternalServerException", ...)`` and
``frozenset({"internalserverexception", ...})``.

Bite-proof: a positive control asserts the detector fires on a reintroduced
literal set; the real-file scan asserts every guarded consumer is clean.
"""
import ast
import os
import re

import pytest

_ARBITER_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# The consumers that MUST source retryability from the taxonomy, never a
# private literal set. (failure_taxonomy.py itself is intentionally excluded —
# it IS the single source of truth and legitimately holds the mapping.)
_GUARDED_FILES = [
    os.path.join(_ARBITER_ROOT, "supervisor", "circuit_breaker.py"),
    os.path.join(_ARBITER_ROOT, "fabricator", "transient_retry.py"),
    os.path.join(_ARBITER_ROOT, "stepRunner", "executor.py"),
]

_ERROR_CODE_RE = re.compile(r"(exception|error)$", re.IGNORECASE)


def _string_elts(node: ast.AST):
    """Yield the string-constant values directly contained in a collection
    literal node (Tuple/List/Set), or in a frozenset(...)/set(...) call whose
    single argument is such a literal."""
    target = node
    if isinstance(node, ast.Call):
        func = node.func
        name = getattr(func, "id", None) or getattr(func, "attr", None)
        if name not in ("frozenset", "set", "tuple", "list"):
            return
        if len(node.args) != 1:
            return
        target = node.args[0]
    if isinstance(target, (ast.Tuple, ast.List, ast.Set)):
        for elt in target.elts:
            if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                yield elt.value


def find_error_code_literal_collections(source: str) -> list[list[str]]:
    """Return each collection literal in *source* that holds >= 2 error-code-
    looking string constants (the reintroduced-parallel-list shape)."""
    tree = ast.parse(source)
    offenders: list[list[str]] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Tuple, ast.List, ast.Set, ast.Call)):
            codes = [s for s in _string_elts(node) if _ERROR_CODE_RE.search(s)]
            if len(codes) >= 2:
                offenders.append(codes)
    return offenders


class TestGuardBitesOnReintroducedLiteralSet:
    """Positive control — the detector MUST fire on a parallel list."""

    def test_tuple_form_detected(self):
        src = (
            "RETRYABLE = (\n"
            "    'ThrottlingException',\n"
            "    'InternalServerException',\n"
            ")\n"
        )
        assert find_error_code_literal_collections(src)

    def test_frozenset_form_detected(self):
        src = (
            "CODES = frozenset({'throttlingexception', 'modelstreamerrorexception'})\n"
        )
        assert find_error_code_literal_collections(src)

    def test_benign_collections_not_flagged(self):
        # A single error-ish string, or non-error strings, must NOT trip it.
        assert not find_error_code_literal_collections("X = ('ThrottlingException',)")
        assert not find_error_code_literal_collections("Y = ['pending', 'failed', 'running']")
        assert not find_error_code_literal_collections("Z = {'a': 1, 'b': 2}")


class TestGuardedConsumersHaveNoParallelList:
    @pytest.mark.parametrize("path", _GUARDED_FILES, ids=lambda p: os.path.basename(p))
    def test_no_error_code_literal_collection(self, path):
        with open(path, "r", encoding="utf-8") as fh:
            source = fh.read()
        offenders = find_error_code_literal_collections(source)
        assert offenders == [], (
            f"{os.path.basename(path)} reintroduced a private retryable set "
            f"{offenders}; classify via common.failure_taxonomy instead."
        )
