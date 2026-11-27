"""Write-side contract for agent configs.

The supervisor builds one Converse tool per active agent from the config's
``name``, ``description`` and ``schema`` (``arbiter/supervisor/agent_config.py``,
``to_tool_input_schema``). A config it cannot build a tool from is skipped at
dispatch time, long after the writer reported success.

The fabricator cannot import ``arbiter/supervisor`` in its deployed bundle, so
``can_derive_tool_schema`` mirrors the shapes ``to_tool_input_schema`` accepts.
``arbiter/common/__tests__/test_agent_config_contract.py`` loads the supervisor
module and fails when the two disagree.

Both functions are pure: they never raise, log, or mutate their input.
"""
from __future__ import annotations

import json
from typing import Any, Optional

# Wrapper keys that hold the real input schema next to name/description.
_INPUT_SCHEMA_KEYS = ("inputSchema", "input_schema")
# Same nesting bound as the supervisor, so a malformed record cannot recurse.
_MAX_SCHEMA_DEPTH = 4


def can_derive_tool_schema(schema: Any, _depth: int = 0) -> bool:
    """Return True when the supervisor can derive a tool input schema.

    Accepted: ``type: 'object'``; ``properties`` with no ``type``; an
    OpenAPI/Swagger document (``openapi``/``swagger``/``paths``); a
    ``{'function': {'parameters': ...}}`` wrapper; an ``inputSchema`` /
    ``input_schema`` wrapper; a ``parameters`` wrapper with no ``type``; or a
    string holding a JSON object of any of these. Every wrapper's inner schema
    must itself be derivable.
    """
    if _depth > _MAX_SCHEMA_DEPTH:
        return False
    if isinstance(schema, str):
        try:
            parsed = json.loads(schema)
        except (ValueError, TypeError):
            return False
        if not isinstance(parsed, dict):
            return False
        return can_derive_tool_schema(parsed, _depth + 1)
    if not isinstance(schema, dict):
        return False

    schema_type = schema.get("type")
    function = schema.get("function")
    if isinstance(function, dict) and ("parameters" in function or schema_type is None):
        parameters = function.get("parameters")
        if not isinstance(parameters, (dict, str)):
            return False
        return can_derive_tool_schema(parameters, _depth + 1)
    if schema_type != "object":
        for key in _INPUT_SCHEMA_KEYS:
            if isinstance(schema.get(key), (dict, str)):
                return can_derive_tool_schema(schema[key], _depth + 1)
    if schema_type is not None:
        return schema_type == "object"
    if isinstance(schema.get("properties"), dict):
        return True
    if "openapi" in schema or "swagger" in schema or "paths" in schema:
        return True
    if isinstance(schema.get("parameters"), (dict, str)):
        return can_derive_tool_schema(schema["parameters"], _depth + 1)
    return False


def agent_config_problem(name: Any, description: Any, schema: Any) -> Optional[str]:
    """Return why a config cannot become a supervisor tool, or None if it can."""
    if not isinstance(name, str) or not name.strip():
        return "name (agent_id) must be a non-empty string"
    if not isinstance(description, str) or not description.strip():
        return "description must be a non-empty string"
    if not can_derive_tool_schema(schema):
        return (
            "schema must be a JSON Schema object (type 'object'), or a shape "
            "the supervisor can derive one from (OpenAPI document, function/"
            "inputSchema/parameters wrapper)"
        )
    return None
