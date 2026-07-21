"""Tests for tools/registry_name.py — the Python twin of the backend's
sanitizeRegistryName (backend/src/utils/registry-name.ts).

The AgentCore Registry rejects record names failing
^[a-zA-Z0-9][a-zA-Z0-9_\\-./]*$ with a ValidationException (live-verified:
'Test - Ingest' fails — spaces are illegal). The intake agent pre-sanitizes
PROPOSED app names with the same rules the backend applies at creation so
the consent gate shows exactly the name that will be created.

SHARED_VECTORS is duplicated byte-for-byte in the TS suite
(backend/src/utils/__tests__/registry-name.test.ts) — the two suites pin the
implementations to agree. Update BOTH when changing either.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_registry_name.py -q
from the service/agent_intake_single directory.
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tools.registry_name import REGISTRY_NAME_PATTERN, sanitize_registry_name

CONSTRAINT = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$")

# Keep in sync with registry-name.test.ts SHARED_VECTORS.
SHARED_VECTORS = [
    ("Test - Ingest", "Test-Ingest"),
    ("Test Ingest 1", "Test-Ingest-1"),
    ("  café app! ", "caf-app"),
    ("---", "app"),
    ("9lives", "9lives"),
    ("ok_name-1.2/x", "ok_name-1.2/x"),
]


def test_pattern_matches_registry_constraint():
    assert REGISTRY_NAME_PATTERN.pattern == CONSTRAINT.pattern


def test_shared_vectors_agree_with_typescript_sanitizer():
    for raw, expected in SHARED_VECTORS:
        assert sanitize_registry_name(raw) == expected, raw


def test_output_always_matches_constraint_and_is_idempotent():
    samples = [raw for raw, _ in SHARED_VECTORS] + [
        "", "   ", "!!!", "\u0000\u0001", "汉字 name", "a" * 300,
        "emoji 😀 name", "-leading", "trailing-", "a..b//c__d",
        "Intake Request 2026-07-20", "Intake abc12345",
    ]
    for raw in samples:
        out = sanitize_registry_name(raw)
        assert out, raw
        assert CONSTRAINT.match(out), (raw, out)
        assert sanitize_registry_name(out) == out, (raw, out)


def test_legal_inputs_pass_through_unchanged():
    for legal in ["9lives", "ok_name-1.2/x", "A", "z0", "a--b", "x_y.z/w-"]:
        assert CONSTRAINT.match(legal)  # sample sanity
        assert sanitize_registry_name(legal) == legal
