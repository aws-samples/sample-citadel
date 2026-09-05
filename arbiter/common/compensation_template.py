"""CIT-123 slice 2 — pure compensation args-template renderer.

Resolves the restricted ``${output.<path>}`` grammar (declared and syntax-
validated in slice 1's ``workflow_contract.normalize_compensation_block``)
against a compensating node's recorded output, producing concrete tool-call
args. This module has NO I/O, NO AWS calls, and is not wired into the
executor/worker — that wiring is slice 3/4. It is a pure function:
``(template_args, recorded_output) -> RenderResult``, or a raised
``CompensationTemplateError`` naming the offending path.

Design decisions (D4), restated here as the load-bearing contract for this
slice:

1. **Grammar** — identical to the slice-1 syntax regex
   (``^output(?:\\.[A-Za-z_][A-Za-z0-9_]*|\\[\\d+\\])*$``): a root token
   ``output``, followed by zero or more ``.<identifier>`` or ``[<int>]``
   segments. Array indexing over a Python ``list`` IS supported with a
   single non-negative integer index; negative indices, slices, wildcards,
   and non-numeric bracket contents are NOT supported and are rejected
   loudly (never silently coerced to Python's negative-index semantics).
   Indexing into anything that is not a ``list`` (e.g. a ``dict``) is
   rejected — bracket syntax means "list index", nothing else.

2. **Resolution engine** — a hand-written recursive-descent walker over
   ``dict``/``list`` structures using plain ``dict.get`` / list-index
   lookups. There is no ``eval``, ``exec``, ``str.format``, f-string
   evaluation of untrusted data, or template-engine library of the sort
   used for HTML/text templating anywhere in this module (enforced by a
   source-scan test in the test suite). A dict key that happens to be
   spelled like a dunder (``__class__``, ``__proto__``, ``constructor``)
   is just an ordinary string key — the walker never calls ``getattr``,
   never invokes ``__getattribute__``, and never calls a value even if
   that value is callable. A callable (or any other non-JSON-scalar/dict/
   list) value reached via a path segment that still has further segments
   to descend, or is asked to resolve as a final scalar and is a callable,
   is REJECTED (see rule 4) — never invoked.

3. **Literal passthrough** — any template value that is not a string, or is
   a string containing no ``${...}`` token, passes through completely
   unchanged (same object/value, no copy semantics implied beyond normal
   Python dict/list literals).

4. **Non-scalar resolution rule** — if a ``${output.<path>}`` token resolves
   to a ``dict`` or ``list`` (a non-scalar), rendering FAILS CLOSED with a
   named error, in both the whole-string single-token case and the
   interpolated (partial-string) case. Rationale: silently serializing an
   object into a string, or smuggling a raw dict/list into a governed
   tool-call argument, is exactly the kind of implicit structural
   surprise a fail-closed renderer must not allow. A resolved value must be
   a JSON scalar: str, int, float, bool, or None.

5. **Whole-token type preservation** — when a template string is *exactly*
   one token (e.g. ``"${output.count}"`` with nothing else), the resolved
   value's native Python type is preserved (an int stays an int, a bool
   stays a bool, etc). When a token is embedded inside surrounding literal
   text (e.g. ``"count=${output.count}"``), the resolved scalar is coerced
   to its ``str()`` form for interpolation, matching ordinary string
   templating semantics.

6. **Fail-closed absent/truncated/offloaded output** — the renderer never
   fetches anything. It only inspects the shape of the ``recorded_output``
   argument the caller hands it:
     - ``recorded_output`` is ``None`` or not a ``dict`` -> "output absent"
       error (raised as soon as ANY template token needs resolution; a
       template with zero tokens still renders fine against an absent
       output, since nothing needs to be looked up).
     - ``recorded_output`` carries a truthy ``resultTruncated`` key -> a
       truncated-output error, even if the specific requested path is
       technically present in the partial dict (a truncated capture must
       never be treated as trustworthy for ANY path).
     - ``recorded_output`` carries a truthy ``resultOffloaded`` key, OR
       carries a ``resultRef`` key at all (regardless of ``resultOffloaded``
       being set) -> an offloaded-reference error. These two attribute
       names mirror ``arbiter/governance/tool_execution_ledger.py``'s
       ``finalize_success`` / ``_recorded_result`` vocabulary exactly, so a
       future caller (slice 3/4) can pass ledger-row-shaped attributes
       straight through without inventing a second vocabulary. Rehydrating
       an offloaded result is explicitly the CALLER's job in a later
       slice — this module must never perform that fetch itself.
   These three checks run BEFORE path resolution and take precedence over
   a plain missing-path error, because an absent/truncated/offloaded output
   is a stronger, output-level condition, not a path-level one.

7. **Errors are always a raised, named exception** — every failure path
   raises :class:`CompensationTemplateError` with a message naming the
   offending path (when path-scoped) or the output-level condition. There
   is no code path that returns ``None`` or an empty string in place of a
   failure.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

# --- Grammar --------------------------------------------------------------
#
# Mirrors workflow_contract._TEMPLATE_TOKEN_RE / _TEMPLATE_PATH_RE exactly
# (slice 1 validates this same grammar at parse time; slice 2 resolves it).
_TEMPLATE_TOKEN_RE = re.compile(r'\$\{([^{}]*)\}')
_TEMPLATE_PATH_RE = re.compile(r'^output(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$')

# Splits a validated path body into ordered segments, each either a
# ('key', name) dotted-identifier segment or an ('index', int) bracket
# segment. The leading 'output' root is consumed separately.
_SEGMENT_RE = re.compile(r'\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]')

_SCALAR_TYPES = (str, int, float, bool, type(None))


class CompensationTemplateError(Exception):
    """Raised for every fail-closed condition in this module.

    Always carries a human-actionable message naming the offending
    ``${output.<path>}`` reference (or the output-level condition — absent
    / truncated / offloaded — when the failure is not path-scoped).
    """


@dataclass(frozen=True)
class RenderResult:
    """The successful result of rendering a compensation args template."""

    args: dict[str, Any]


def _parse_path_segments(path_body: str) -> list[tuple[str, Any]]:
    """Parse a validated ``output...`` path body into ordered segments.

    Assumes *path_body* already matched ``_TEMPLATE_PATH_RE`` (validated by
    the caller before this is invoked). Returns a list of
    ``('key', name)`` / ``('index', int)`` tuples, root ``'output'``
    excluded.
    """
    rest = path_body[len('output'):]
    segments: list[tuple[str, Any]] = []
    pos = 0
    for match in _SEGMENT_RE.finditer(rest):
        if match.start() != pos:
            # Should be unreachable given _TEMPLATE_PATH_RE validation, but
            # fail closed rather than silently skip a gap.
            raise CompensationTemplateError(
                f"compensation template: malformed path segment near "
                f"'output{rest}' — fail-closed"
            )
        key_seg, index_seg = match.groups()
        if key_seg is not None:
            segments.append(('key', key_seg))
        else:
            segments.append(('index', int(index_seg)))
        pos = match.end()
    if pos != len(rest):
        raise CompensationTemplateError(
            f"compensation template: malformed path segment near "
            f"'output{rest}' — fail-closed"
        )
    return segments


def _check_output_usable(recorded_output: Any, *, full_path: str) -> dict:
    """Fail closed on an absent/truncated/offloaded recorded output.

    Runs before any path resolution for a given token. Returns the usable
    dict on success.
    """
    if not isinstance(recorded_output, dict):
        raise CompensationTemplateError(
            f"compensation template: cannot resolve '${{{full_path}}}' — "
            "the compensating node's recorded output is absent (not a "
            "recorded object); refusing to render (fail-closed)"
        )
    if recorded_output.get('resultTruncated'):
        raise CompensationTemplateError(
            f"compensation template: cannot resolve '${{{full_path}}}' — "
            "the recorded output is marked resultTruncated=true; a "
            "truncated capture is never trustworthy for templating "
            "(fail-closed)"
        )
    if recorded_output.get('resultOffloaded') or 'resultRef' in recorded_output:
        raise CompensationTemplateError(
            f"compensation template: cannot resolve '${{{full_path}}}' — "
            "the recorded output is an S3-offloaded reference "
            "(resultOffloaded/resultRef) that has not been rehydrated; "
            "this renderer never fetches — rehydration is the caller's "
            "responsibility in a later slice (fail-closed)"
        )
    return recorded_output


def _resolve_path(recorded_output: Any, path_body: str) -> Any:
    """Resolve a single ``output...`` path body against recorded_output.

    Returns the resolved (possibly non-scalar) value, or raises
    ``CompensationTemplateError`` naming the full path on any failure:
    absent/truncated/offloaded output, a missing key, an out-of-range or
    malformed index, indexing into a non-list, or descending through a
    non-container.
    """
    full_path = path_body
    node = _check_output_usable(recorded_output, full_path=full_path)

    segments = _parse_path_segments(path_body)
    traversed = 'output'
    for kind, value in segments:
        if kind == 'key':
            if not isinstance(node, dict):
                raise CompensationTemplateError(
                    f"compensation template: cannot resolve '${{{full_path}}}' — "
                    f"'{traversed}' is not an object, cannot look up key "
                    f"'{value}' (fail-closed)"
                )
            if value not in node:
                raise CompensationTemplateError(
                    f"compensation template: cannot resolve '${{{full_path}}}' — "
                    f"path segment '{traversed}.{value}' is missing from the "
                    "recorded output (fail-closed)"
                )
            node = node[value]
            traversed = f'{traversed}.{value}'
        else:  # kind == 'index'
            if not isinstance(node, list):
                raise CompensationTemplateError(
                    f"compensation template: cannot resolve '${{{full_path}}}' — "
                    f"'{traversed}' is not an array, cannot index [{value}] "
                    "(fail-closed)"
                )
            if value < 0 or value >= len(node):
                raise CompensationTemplateError(
                    f"compensation template: cannot resolve '${{{full_path}}}' — "
                    f"array index '{traversed}[{value}]' is out of range "
                    f"(length {len(node)}) (fail-closed)"
                )
            node = node[value]
            traversed = f'{traversed}[{value}]'
    return node


def _render_string_value(value: str, recorded_output: Any) -> Any:
    """Render a single template string value.

    A string with no ``${...}`` token passes through unchanged. A string
    that is EXACTLY one token resolves with native type preservation. A
    string with one or more tokens embedded in literal text resolves each
    token and string-interpolates the result. Any resolved non-scalar
    (dict/list) — whole-token or interpolated — fails closed.
    """
    matches = list(_TEMPLATE_TOKEN_RE.finditer(value))
    if not matches:
        return value

    if len(matches) == 1 and matches[0].span() == (0, len(value)):
        path_body = matches[0].group(1)
        if not _TEMPLATE_PATH_RE.match(path_body):
            raise CompensationTemplateError(
                f"compensation template: malformed template reference "
                f"'${{{path_body}}}' — expected 'output', 'output.<key>', "
                "or 'output[<index>]' segments (fail-closed)"
            )
        resolved = _resolve_path(recorded_output, path_body)
        _reject_if_non_scalar(resolved, path_body)
        return resolved

    # Interpolated case: resolve every token, string-coerce, and splice
    # back into the surrounding literal text.
    pieces: list[str] = []
    cursor = 0
    for match in matches:
        pieces.append(value[cursor:match.start()])
        path_body = match.group(1)
        if not _TEMPLATE_PATH_RE.match(path_body):
            raise CompensationTemplateError(
                f"compensation template: malformed template reference "
                f"'${{{path_body}}}' — expected 'output', 'output.<key>', "
                "or 'output[<index>]' segments (fail-closed)"
            )
        resolved = _resolve_path(recorded_output, path_body)
        _reject_if_non_scalar(resolved, path_body)
        pieces.append('' if resolved is None else str(resolved))
        cursor = match.end()
    pieces.append(value[cursor:])
    return ''.join(pieces)


def _reject_if_non_scalar(resolved: Any, path_body: str) -> None:
    if isinstance(resolved, (dict, list)):
        kind = 'object' if isinstance(resolved, dict) else 'array'
        raise CompensationTemplateError(
            f"compensation template: '${{{path_body}}}' resolves to a "
            f"non-scalar {kind}, not a scalar value; templating a whole "
            f"{kind} into a tool-call argument is not permitted "
            "(fail-closed)"
        )
    if not isinstance(resolved, _SCALAR_TYPES) or callable(resolved):
        raise CompensationTemplateError(
            f"compensation template: '${{{path_body}}}' resolves to a "
            "value that is not a JSON scalar (str/int/float/bool/None); "
            "refusing to render (fail-closed)"
        )


def _render_value(value: Any, recorded_output: Any) -> Any:
    if isinstance(value, str):
        return _render_string_value(value, recorded_output)
    if isinstance(value, dict):
        return {key: _render_value(nested, recorded_output) for key, nested in value.items()}
    if isinstance(value, list):
        return [_render_value(nested, recorded_output) for nested in value]
    # int, float, bool, None, or any other non-template scalar: pass
    # through unchanged.
    return value


def render_compensation_args(template_args: dict, recorded_output: Any) -> RenderResult:
    """Render a validated compensation args template against recorded output.

    Pure function: no I/O, no AWS calls, no mutation of *template_args* or
    *recorded_output*. See module docstring for the full D4 contract.

    Raises ``CompensationTemplateError`` — never returns a fabricated or
    partial result — on any unresolvable path, non-scalar resolution, or an
    absent/truncated/offloaded ``recorded_output``.
    """
    if not isinstance(template_args, dict):
        raise CompensationTemplateError(
            "compensation template: template_args must be an object"
        )
    rendered = {key: _render_value(value, recorded_output) for key, value in template_args.items()}
    return RenderResult(args=rendered)
