"""Static guard: no arbiter Python file constructs a
``boto3.client('bedrock-agentcore-control')`` for Registry operations.

Registry operations (CreateRegistryRecord, GetRegistryRecord,
ListRegistryRecords, SubmitRegistryRecordForApproval,
UpdateRegistryRecordStatus, DeleteRegistryRecord, ...) moved to the GA
``agent-registry-control`` client/namespace. Non-registry
bedrock-agentcore usage (e.g. runtime invoke via ``bedrock-agentcore``,
data-plane invocations) is unaffected and stays on the old client — this
guard allowlists those known-legitimate call sites by file path rather
than by service-name string, since ``bedrock-agentcore`` (data plane,
runtime invoke) and ``bedrock-agentcore-control`` (the old registry
control plane) are distinct service identifiers and only the latter is a
registry-relevant regression risk.

Scope: scans arbiter/**/*.py (excluding this test file itself and any
__pycache__ dirs) for the literal substring
``boto3.client('bedrock-agentcore-control')`` or the double-quoted
equivalent. Any hit outside the allowlist fails the test.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

ARBITER_ROOT = Path(__file__).resolve().parents[2]

# Matches boto3.client('bedrock-agentcore-control') / "..." with either
# quote style and optional whitespace around the argument.
_REGISTRY_CONTROL_CLIENT_RE = re.compile(
    r"""boto3\.client\(\s*['"]bedrock-agentcore-control['"]"""
)

# Files legitimately allowed to reference the old control-plane client
# string: currently none. Registry operations have all migrated to
# agent-registry-control; runtime invoke uses the separate
# 'bedrock-agentcore' (no '-control' suffix) data-plane service name,
# which this regex does not match.
ALLOWLISTED_RELATIVE_PATHS: frozenset[str] = frozenset()


def _iter_arbiter_python_files():
    for path in ARBITER_ROOT.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        if path == Path(__file__).resolve():
            continue
        yield path


class TestNoLegacyRegistryControlClient:
    def test_no_file_calls_bedrock_agentcore_control_for_registry_ops(self):
        offenders = []
        for path in _iter_arbiter_python_files():
            rel = path.relative_to(ARBITER_ROOT).as_posix()
            if rel in ALLOWLISTED_RELATIVE_PATHS:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if _REGISTRY_CONTROL_CLIENT_RE.search(text):
                offenders.append(rel)

        assert offenders == [], (
            "Found boto3.client('bedrock-agentcore-control') outside the "
            "allowlist — registry operations must use "
            "boto3.client('agent-registry-control'). Offending files: "
            f"{offenders}"
        )

    def test_runtime_invoke_service_name_is_distinct_and_unaffected(self):
        """Sanity check the guard's own regex: 'bedrock-agentcore' (no
        '-control' suffix, used for runtime invoke) must NOT match the
        registry-control pattern this guard enforces."""
        runtime_invoke_snippet = "boto3.client('bedrock-agentcore')"
        assert not _REGISTRY_CONTROL_CLIENT_RE.search(runtime_invoke_snippet)

    @pytest.mark.parametrize(
        "snippet",
        [
            "boto3.client('bedrock-agentcore-control')",
            'boto3.client("bedrock-agentcore-control")',
            "boto3.client( 'bedrock-agentcore-control' )",
        ],
    )
    def test_regex_positive_matches(self, snippet):
        assert _REGISTRY_CONTROL_CLIENT_RE.search(snippet)
