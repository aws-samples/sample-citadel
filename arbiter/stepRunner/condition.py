"""Condition module — pure functions for conditional edge evaluation.

Provides condition evaluation and dot-notation field path resolution
for workflow conditional branching.
All functions are pure (no side effects, no AWS calls).
"""


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


def resolve_field_path(obj: dict, path: str) -> any:
    """Resolve dot-notation path (e.g., 'result.status') into nested dict.

    Returns None on missing path (never raises).
    """
    if not path:
        return None
    parts = path.split('.')
    current = obj
    for part in parts:
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current
