"""Registry-safe name derivation — Python twin of the backend sanitizer.

The AgentCore Registry (bedrock-agentcore CreateRegistryRecord /
UpdateRegistryRecord) constrains record ``name`` to::

    ^[a-zA-Z0-9][a-zA-Z0-9_\\-./]*$

(live-verified ValidationException: 'Test - Ingest' is rejected — spaces are
illegal). The backend sanitizes at creation (backend/src/utils/
registry-name.ts, applied in RegistryService); this module applies the SAME
rules to PROPOSED app names so the consent gate shows exactly the name that
will be created.

Rules (deterministic, idempotent — keep byte-identical to the TS twin):
 - input already legal -> returned unchanged
 - every illegal char maps to '-'
 - consecutive '-' runs collapse to one
 - leading non-alphanumeric chars are stripped (first char must be alnum)
 - trailing '-' artifacts are stripped
 - never empty: falls back to the literal 'app'

The two implementations are pinned to agree on shared vectors — see
tests/test_registry_name.py and backend/src/utils/__tests__/
registry-name.test.ts. Update BOTH when changing either.
"""
import re

# The registry ``name`` constraint, verbatim.
REGISTRY_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_\-./]*$")

_ILLEGAL_CHARS = re.compile(r"[^a-zA-Z0-9_\-./]")
_DASH_RUNS = re.compile(r"-{2,}")
_LEADING_NON_ALNUM = re.compile(r"^[^a-zA-Z0-9]+")
_TRAILING_DASHES = re.compile(r"-+$")

# Deterministic fallback when sanitization yields an empty string.
_FALLBACK_NAME = "app"


def sanitize_registry_name(raw: str) -> str:
    """Derive a registry-safe name from arbitrary human input.

    Pure, total, and idempotent: the output always matches
    ``REGISTRY_NAME_PATTERN``, and legal inputs pass through unchanged.
    """
    if REGISTRY_NAME_PATTERN.match(raw):
        return raw
    mapped = _ILLEGAL_CHARS.sub("-", raw)        # illegal chars -> '-'
    mapped = _DASH_RUNS.sub("-", mapped)         # collapse '-' runs
    mapped = _LEADING_NON_ALNUM.sub("", mapped)  # first char must be alnum
    mapped = _TRAILING_DASHES.sub("", mapped)    # strip trailing '-' artifacts
    return mapped if mapped else _FALLBACK_NAME
