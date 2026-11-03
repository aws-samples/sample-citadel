"""Regression guard: fabricator LLM agents must not have dangerous tools
in their tool surface.

AST-parses index.py and asserts no Agent(...) tools list contains names
in the deny set {shell, http_request, python_repl, editor, use_aws, file_write}
and that BYPASS_TOOL_CONSENT is not present unless allow-listed with a reason.
"""

import ast
import os
import re as _re
import textwrap

import pytest

FABRICATOR_PATH = os.path.join(
    os.path.dirname(__file__), "..", "index.py",
)

DENIED_TOOL_NAMES = frozenset({
    "shell",
    "http_request",
    "python_repl",
    "editor",
    "use_aws",
    "file_write",
})

# If a tool is allowed despite being in the deny set, list it here with
# a justification.  Format: {"tool_name": "reason it is needed"}
TOOL_ALLOWLIST: dict[str, str] = {}


class TestFabricatorToolSurfaceGuard:
    """Static analysis of the fabricator source to prevent tool-surface regression."""

    @pytest.fixture(autouse=True)
    def _load_source(self):
        with open(FABRICATOR_PATH) as f:
            self.source = f.read()
        self.tree = ast.parse(self.source)

    # ------------------------------------------------------------------
    # Helper: extract all Agent(..., tools=[...]) tool name lists
    # ------------------------------------------------------------------
    def _agent_tool_lists(self):
        """Yield (line_number, [tool_name, ...]) for each Agent() call with tools=."""
        for node in ast.walk(self.tree):
            if not isinstance(node, ast.Call):
                continue
            # Match Agent(...) or models.Agent(...)
            func = node.func
            is_agent_call = False
            if isinstance(func, ast.Name) and func.id == "Agent":
                is_agent_call = True
            elif isinstance(func, ast.Attribute) and func.attr == "Agent":
                is_agent_call = True
            if not is_agent_call:
                continue

            for kw in node.keywords:
                if kw.arg == "tools" and isinstance(kw.value, ast.List):
                    names = []
                    for elt in kw.value.elts:
                        if isinstance(elt, ast.Name):
                            names.append(elt.id)
                        elif isinstance(elt, ast.Attribute):
                            names.append(elt.attr)
                    yield (node.lineno, names)

    # ------------------------------------------------------------------
    # Tests
    # ------------------------------------------------------------------
    def test_no_denied_tools_in_agent_tool_lists(self):
        """No Agent() call should contain a denied tool unless allow-listed."""
        violations = []
        for lineno, names in self._agent_tool_lists():
            for name in names:
                if name in DENIED_TOOL_NAMES and name not in TOOL_ALLOWLIST:
                    violations.append(
                        f"  line {lineno}: Agent() tools list contains "
                        f"denied tool '{name}'"
                    )
        if violations:
            detail = "\n".join(violations)
            pytest.fail(
                f"Denied tools found in fabricator Agent() calls:\n{detail}"
            )

    def test_no_bypass_tool_consent(self):
        """BYPASS_TOOL_CONSENT must not appear in the source.

        The env var disables consent gates for ALL strands_tools tools
        process-wide.  Since shell, http_request, and raw file_write are
        removed and write_job_file does not need consent, there is no
        reason for BYPASS_TOOL_CONSENT to exist.
        """
        if "BYPASS_TOOL_CONSENT" in self.source:
            # Allow if every occurrence is inside a comment or allowlisted
            for i, line in enumerate(self.source.splitlines(), 1):
                stripped = line.lstrip()
                if "BYPASS_TOOL_CONSENT" in stripped and not stripped.startswith("#"):
                    pytest.fail(
                        f"BYPASS_TOOL_CONSENT found at line {i} "
                        f"(not in a comment): {stripped!r}"
                    )

    def test_denied_tools_set_is_not_empty(self):
        """Sanity: the deny set itself must not be accidentally emptied."""
        assert len(DENIED_TOOL_NAMES) >= 6

    def test_at_least_one_agent_call_found(self):
        """Sanity: we must find at least 2 Agent() calls (tool + agent fabricator)."""
        agent_calls = list(self._agent_tool_lists())
        assert len(agent_calls) >= 2, (
            f"Expected at least 2 Agent() calls with tools=, found {len(agent_calls)}"
        )


    def test_no_flat_s3_key_construction(self):
        """No f-string builds a flat tools/{name} or agents/{name} key.

        Flat keys like ``f'tools/{tool_name}'`` or ``f"tools/{filename}"``
        must not appear outside the legacy-fallback read path (marked with
        ``# legacy-fallback``).  All new writes must use the tenant-scoped
        key layout via ``upload_to_s3`` + ``fabrication_context``.
        """
        # Match f'tools/{var}' or f"tools/{var}" (and agents/) where var
        # is a simple name — i.e. no second '/' after the folder prefix.
        flat_key_pattern = _re.compile(
            r"""f['"](?:tools|agents)/\{[a-zA-Z_][a-zA-Z0-9_]*\}['"]"""
        )
        lines = self.source.split("\n")
        violations = []
        in_docstring = False
        for i, line in enumerate(lines, 1):
            stripped = line.lstrip()
            # Skip comments
            if stripped.startswith("#"):
                continue
            # Rough docstring toggle (good enough for a guard test)
            if '"""' in stripped or "'''" in stripped:
                count = stripped.count('"""') + stripped.count("'''")
                if count % 2 == 1:
                    in_docstring = not in_docstring
                continue
            if in_docstring:
                continue
            # Allow the legacy fallback path (marked with # legacy-fallback)
            if "# legacy-fallback" in line:
                continue
            match = flat_key_pattern.search(line)
            if match:
                violations.append(f"  line {i}: {match.group()}")
        if violations:
            detail = "\n".join(violations)
            pytest.fail(
                f"Flat S3 key construction found in fabricator source — "
                f"use upload_to_s3() with fabrication_context instead:\n{detail}"
            )

    # ------------------------------------------------------------------
    # Guard: no LLM-facing @tool function may accept s3_key/key/path
    # ------------------------------------------------------------------

    # Parameter names that, if present on a @tool-decorated function, expose
    # an untrusted-input surface for S3 key injection.
    _DENIED_PARAM_NAMES = frozenset({"s3_key", "key", "path"})

    # Functions that are allowed to have these params (with reason).
    _PARAM_ALLOWLIST: dict[str, dict[str, str]] = {
        # file_path is not in the deny set; upload_tool_to_s3 etc. use it
        # for the LOCAL filesystem path, not an S3 key.
    }

    def test_no_llm_facing_s3_key_params_on_tool_functions(self):
        """@tool-decorated functions must not accept params named s3_key, key, or path.

        LLM-facing tool parameters are untrusted inputs.  S3 key resolution
        must happen server-side (per-job map, registry codeKey, or legacy
        fallback), never via an LLM-supplied parameter.
        """
        violations = []
        for node in ast.walk(self.tree):
            if not isinstance(node, ast.FunctionDef):
                continue
            # Check if the function is decorated with @tool
            is_tool = False
            for deco in node.decorator_list:
                if isinstance(deco, ast.Name) and deco.id == "tool":
                    is_tool = True
                elif isinstance(deco, ast.Attribute) and deco.attr == "tool":
                    is_tool = True
            if not is_tool:
                continue
            # Check parameter names
            for arg in node.args.args:
                param_name = arg.arg
                if param_name in self._DENIED_PARAM_NAMES:
                    # Check allowlist
                    allowed = self._PARAM_ALLOWLIST.get(node.name, {})
                    if param_name not in allowed:
                        violations.append(
                            f"  line {node.lineno}: @tool {node.name}() has "
                            f"denied parameter '{param_name}'"
                        )
        if violations:
            detail = "\n".join(violations)
            pytest.fail(
                f"LLM-facing @tool functions must not accept S3 key params "
                f"(untrusted input — resolve server-side instead):\n{detail}"
            )
