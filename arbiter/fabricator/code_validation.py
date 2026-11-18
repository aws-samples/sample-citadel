"""Static validation of LLM-generated code before persistence (PR-4 §2c,
owner decision 5750aeec: FAIL CLOSED, no grandfathering).

NET-NEW control — does not duplicate CIT-256. CIT-256's
``tools_config.validate_code_tool_binding`` / ``assert_spec_approved``
enforce that a code-generating TOOL is bound to an APPROVED
ExecutionSpecification; ``test_tool_surface_guard.py`` statically guards
the FABRICATOR'S OWN source tool surface. Neither validates the CONTENT of
the code the LLM generated. This module is the first control that looks at
the generated code body itself, applied at the single choke point both
fabricators write generated code through: ``write_job_file``.

Bundle-sibling module (entry: arbiter/fabricator) — top-level importable,
no ``arbiter.`` prefix.
"""
from __future__ import annotations

import ast

# Root modules a generated tool must never import. Chosen for direct
# process/OS-escape or serialization-exploit capability — NOT a general
# "unsafe stdlib" opinion (e.g. ``shutil``/``tempfile`` are allowed; the
# fabricator's own write_job_file already confines file writes to /tmp).
FORBIDDEN_MODULES = frozenset({
    "subprocess",
    "ctypes",
    "socket",
    "marshal",
    "pickle",
    "importlib",
    "pty",
    "multiprocessing",
    "resource",
    "mmap",
    "fcntl",
})

# Curated safe set a generated boto3 tool is expected to need. Used only
# for documentation/tests of intent — validate_generated_code DENIES by
# FORBIDDEN_MODULES, it does not ALLOW-list imports (an allow-list would be
# far more likely to break legitimate generated tools; the forbidden set is
# the deliberately narrow, high-confidence denylist).
SAFE_MODULE_EXAMPLES = frozenset({
    "boto3", "json", "base64", "datetime", "typing", "re", "math", "uuid",
    "hashlib", "logging",
})

# Dunder / reflection names that let code escape the module's declared
# surface regardless of which modules it imports.
_FORBIDDEN_CALL_NAMES = frozenset({"__import__", "eval", "exec", "compile"})
_FORBIDDEN_ATTR_NAMES = frozenset({
    "__builtins__", "__globals__", "__subclasses__", "__bases__", "__mro__",
})

# os.* members that are process/OS-escape surface even though the `os`
# module itself is not forbidden outright (os.path, os.environ reads, etc.
# are legitimate in generated tools).
_FORBIDDEN_OS_ATTRS = frozenset({
    "system", "popen", "execl", "execle", "execlp", "execlpe",
    "execv", "execve", "execvp", "execvpe", "spawnl", "spawnle",
    "spawnlp", "spawnlpe", "spawnv", "spawnve", "spawnvp", "spawnvpe",
    "fork", "forkpty",
})


class GeneratedCodeRejected(ValueError):
    """Raised when generated code fails static validation. Non-retryable —
    the SAME source text will fail identically on every retry."""


def _root_module(name: str) -> str:
    return name.split(".", 1)[0]


def _check_imports(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = _root_module(alias.name)
                if root in FORBIDDEN_MODULES:
                    raise GeneratedCodeRejected(
                        f"forbidden import: {alias.name!r} (root module {root!r})"
                    )
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            root = _root_module(module)
            if root in FORBIDDEN_MODULES:
                raise GeneratedCodeRejected(
                    f"forbidden import: from {module!r} import ... (root module {root!r})"
                )


def _check_os_escape_calls(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute) and func.attr in _FORBIDDEN_OS_ATTRS:
            # Best-effort: flag any `<expr>.system(...)`-shaped call where the
            # attribute name matches a forbidden os.* escape surface,
            # regardless of what the base expression resolves to (static
            # analysis cannot resolve aliasing generally; over-flagging a
            # same-named-but-unrelated method is an acceptable false
            # positive for a security control).
            raise GeneratedCodeRejected(
                f"forbidden call: *.{func.attr}(...) (process/OS-escape surface)"
            )


def _check_dunder_and_reflection(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in _FORBIDDEN_CALL_NAMES:
                raise GeneratedCodeRejected(f"forbidden call: {func.id}(...)")
            if isinstance(func, ast.Attribute) and func.attr in _FORBIDDEN_CALL_NAMES:
                raise GeneratedCodeRejected(f"forbidden call: *.{func.attr}(...)")
        if isinstance(node, ast.Attribute) and node.attr in _FORBIDDEN_ATTR_NAMES:
            raise GeneratedCodeRejected(f"forbidden attribute access: *.{node.attr}")
        if isinstance(node, ast.Name) and node.id in _FORBIDDEN_ATTR_NAMES:
            # Bare-name reference to a forbidden dunder (e.g. `__builtins__`
            # used directly rather than via `.`-attribute access).
            raise GeneratedCodeRejected(f"forbidden attribute access: {node.id}")
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in {"getattr", "setattr"}:
                for arg in node.args:
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                        if arg.value.startswith("__") and arg.value.endswith("__"):
                            raise GeneratedCodeRejected(
                                f"forbidden reflection: {func.id}(..., {arg.value!r}, ...)"
                            )


def validate_generated_code(source: str) -> None:
    """Validate generated Python source before it is persisted.

    Raises :class:`GeneratedCodeRejected` on:
      * a syntax error (unparseable source),
      * any import (``import`` / ``from ... import``) whose root module is
        in :data:`FORBIDDEN_MODULES`,
      * any ``os.system`` / ``os.popen`` / ``os.exec*`` / ``os.fork*``-
        shaped call,
      * a call to ``__import__`` / ``eval`` / ``exec`` / ``compile``,
      * attribute access to ``__builtins__`` / ``__globals__`` /
        ``__subclasses__`` / ``__bases__`` / ``__mro__``,
      * ``getattr``/``setattr`` with a string literal dunder name.

    Returns ``None`` on success (no exception). Never mutates *source*.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise GeneratedCodeRejected(f"syntax error in generated code: {exc}") from exc

    _check_imports(tree)
    _check_os_escape_calls(tree)
    _check_dunder_and_reflection(tree)
