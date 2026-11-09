"""Condition module — pure functions for conditional edge evaluation.

Provides condition evaluation and dot-notation field path resolution
for workflow conditional branching.
All functions are pure (no side effects, no AWS calls).
"""

import json


def evaluate_condition(condition: dict, source_output: dict) -> bool:
    """Evaluate a conditional edge expression against source node output.

    condition: {field: str, operator: str, value: any}
    Operators: equals, notEquals, contains, greaterThan, lessThan, exists
    Returns False for unknown operators.
    """
    field = condition.get('field', '')
    operator = condition.get('operator', '')
    expected = condition.get('value')

    actual = resolve_field_path(source_output, field)

    if operator == 'equals':
        return actual == expected
    elif operator == 'notEquals':
        return actual != expected
    elif operator == 'contains':
        if actual is None:
            return False
        try:
            return expected in actual
        except TypeError:
            return False
    elif operator == 'greaterThan':
        if actual is None or expected is None:
            return False
        try:
            return actual > expected
        except TypeError:
            return False
    elif operator == 'lessThan':
        if actual is None or expected is None:
            return False
        try:
            return actual < expected
        except TypeError:
            return False
    elif operator == 'exists':
        return actual is not None
    else:
        return False


def _try_parse_json(s):
    """Attempt to parse *s* as JSON.  Returns the parsed object on
    success, or ``None`` on failure (never raises)."""
    if not isinstance(s, str):
        return None
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return None


def _is_worker_envelope(obj: dict) -> bool:
    """Return ``True`` when *obj* looks like a worker envelope — a dict
    whose keys are a subset of ``{'response', 'usage'}`` and that
    contains at least ``response``."""
    if not isinstance(obj, dict):
        return False
    return 'response' in obj and set(obj.keys()) <= {'response', 'usage'}


def _unwrap_envelope(obj: dict):
    """If *obj* is a worker envelope, parse the ``response`` value (when
    it is a JSON string) and return the inner dict.  Returns ``None``
    when the envelope cannot be unwrapped to a dict."""
    raw = obj.get('response')
    if isinstance(raw, dict):
        return raw
    parsed = _try_parse_json(raw)
    return parsed if isinstance(parsed, dict) else None


def resolve_field_path(obj: dict, path: str):
    """Resolve dot-notation path (e.g., ``result.status``) into nested dict.

    Worker-envelope unwrapping
    ~~~~~~~~~~~~~~~~~~~~~~~~~~
    The arbiter worker wraps every agent return in a thin envelope::

        {"response": "<JSON-serialised agent return>", "usage": [...]}

    Condition fields authored in blueprints use the ``result.<key>``
    convention to reference fields of the agent's *logical* return — e.g.
    ``result.route`` — but after the worker envelope is applied the raw
    node output no longer contains a top-level ``result`` key.

    To bridge the gap transparently, ``resolve_field_path`` applies the
    following precedence when the node output matches the worker-envelope
    shape (a dict whose keys ⊆ {``response``, ``usage``}):

    1. **Full path against the unwrapped inner object** — parse
       ``response`` (if it is a JSON string) and try the entire path
       against the resulting dict.  This covers cases where the inner
       object itself contains the first path segment as a key.
    2. **Sub-path after** ``result.`` — when the path starts with
       ``result.``, strip the prefix and resolve the remainder against
       the inner object.  This is the primary fix: ``result.route``
       resolves to ``inner["route"]`` when the worker envelope wraps
       the agent return.
    3. **Raw envelope fallback** — if neither inner-object resolution
       succeeded, resolve against the original envelope dict so that
       explicit envelope references (``response.route``, ``usage``)
       keep working, and legacy outputs without an envelope are
       unaffected.

    Additionally, when an intermediate value along the path is a JSON
    string (e.g. the worker serialised a dict via ``json.dumps``), a
    single ``json.loads`` is attempted to continue traversal — this is
    orthogonal to the envelope unwrap and handles nested JSON at any
    depth.

    Returns ``None`` on missing path (never raises).
    """
    if not path:
        return None

    # --- Worker-envelope unwrap ---
    if _is_worker_envelope(obj):
        inner = _unwrap_envelope(obj)
        if inner is not None:
            # Precedence 1: full path against inner object.
            result = _resolve_path(inner, path)
            if result is not None:
                return result
            # Precedence 2: strip ``result.`` prefix and retry.
            if path.startswith('result.'):
                sub_path = path[len('result.'):]
                result = _resolve_path(inner, sub_path)
                if result is not None:
                    return result

    # --- Precedence 3: raw / fallback resolution ---
    return _resolve_path(obj, path)


def diagnose_resolution_failure(obj: dict, path: str) -> str:
    """Return a short reason string explaining why *path* could not be
    resolved inside *obj*.

    Possible return values:

    * ``'output_not_json'`` — an intermediate value was a string that
      could not be parsed as JSON.
    * ``'field_missing'`` — the path (or a segment of it) does not
      exist in the object.
    """
    targets: list[tuple[dict, str]] = []

    if _is_worker_envelope(obj):
        inner = _unwrap_envelope(obj)
        if inner is not None:
            targets.append((inner, path))
            if path.startswith('result.'):
                targets.append((inner, path[len('result.'):]))
        elif isinstance(obj.get('response'), str):
            # response was a non-JSON string — diagnose as output_not_json
            # only when the path would have needed to traverse it.
            if path.startswith('result.') or path.startswith('response.'):
                return 'output_not_json'

    targets.append((obj, path))

    # Walk each target; the first that hits an unparseable string wins.
    for target, p in targets:
        reason = _diagnose_walk(target, p)
        if reason == 'output_not_json':
            return reason

    return 'field_missing'


def _diagnose_walk(obj, path: str) -> str:
    """Single-target diagnostic walk.  Returns ``'output_not_json'``
    when an intermediate string is unparseable, else
    ``'field_missing'``."""
    parts = path.split('.') if path else []
    current = obj
    for part in parts:
        if isinstance(current, str):
            try:
                current = json.loads(current)
            except (json.JSONDecodeError, TypeError):
                return 'output_not_json'
        if not isinstance(current, dict) or part not in current:
            return 'field_missing'
        current = current[part]
    return 'field_missing'


def _resolve_path(obj, path: str):
    """Walk a dot-notation *path* into *obj*, auto-parsing JSON strings
    at intermediate steps.  Returns ``None`` on any missing segment."""
    parts = path.split('.')
    current = obj
    for part in parts:
        if isinstance(current, str):
            try:
                current = json.loads(current)
            except (json.JSONDecodeError, TypeError):
                return None
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current
