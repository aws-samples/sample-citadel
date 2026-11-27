"""Tests for ``common.agent_config_contract``.

The fabricator cannot import ``arbiter/supervisor`` in the deployed bundle, so
``can_derive_tool_schema`` mirrors the shapes ``to_tool_input_schema`` accepts.
The parity test below loads the supervisor module by file path and fails when
the two disagree, so the copies cannot drift apart silently.
"""
from __future__ import annotations

import importlib.util
import json
import os

import pytest

from common.agent_config_contract import (
    agent_config_problem,
    can_derive_tool_schema,
)

_SUPERVISOR_AGENT_CONFIG = os.path.join(
    os.path.dirname(__file__), "..", "..", "supervisor", "agent_config.py"
)

_OBJECT = {"type": "object", "properties": {"q": {"type": "string"}}}
_OPENAPI = {
    "openapi": "3.0.0",
    "info": {"title": "x"},
    "paths": {"/x": {"post": {"requestBody": {"content": {}}}}},
}


def _corpus() -> dict:
    nested = _OBJECT
    for _ in range(6):
        nested = {"inputSchema": nested}
    return {
        "object": _OBJECT,
        "object-empty-properties": {"type": "object"},
        "properties-no-type": {"properties": {"q": {"type": "string"}}},
        "type-string": {"type": "string"},
        "type-array": {"type": "array", "items": {}},
        "empty-dict": {},
        "unknown-keys-only": {"foo": "bar"},
        "properties-not-a-dict": {"properties": ["q"]},
        "none": None,
        "list": [{"type": "object"}],
        "number": 7,
        "bool": True,
        "json-string-object": json.dumps(_OBJECT),
        "json-string-list": "[1, 2]",
        "json-string-type-string": '{"type": "string"}',
        "json-string-garbage": "{not json",
        "empty-string": "",
        "openapi": _OPENAPI,
        "swagger": {"swagger": "2.0", "paths": {}},
        "paths-only": {"paths": {}},
        "function-wrapper": {
            "type": "function",
            "function": {"name": "f", "parameters": _OBJECT},
        },
        "function-wrapper-no-type": {"function": {"name": "f", "parameters": _OBJECT}},
        "function-wrapper-bad-parameters": {
            "type": "function",
            "function": {"name": "f", "parameters": [1]},
        },
        "function-wrapper-string-parameters": {
            "function": {"parameters": json.dumps(_OBJECT)},
        },
        "function-without-parameters-with-type": {
            "type": "object",
            "function": {"name": "f"},
        },
        "inputSchema-wrapper": {"name": "t", "inputSchema": _OBJECT},
        "input_schema-wrapper": {"name": "t", "input_schema": _OBJECT},
        "inputSchema-string": {"inputSchema": json.dumps(_OBJECT)},
        "inputSchema-bad-inner": {"inputSchema": {"type": "string"}},
        "inputSchema-ignored-when-object": {"type": "object", "inputSchema": 5},
        "parameters-wrapper": {"parameters": _OBJECT},
        "parameters-string": {"parameters": json.dumps(_OBJECT)},
        "parameters-bad-inner": {"parameters": {"type": "string"}},
        "too-deeply-nested": nested,
    }


class TestCanDeriveToolSchema:
    @pytest.mark.parametrize(
        "label",
        [
            "object",
            "object-empty-properties",
            "properties-no-type",
            "json-string-object",
            "openapi",
            "swagger",
            "paths-only",
            "function-wrapper",
            "function-wrapper-no-type",
            "function-wrapper-string-parameters",
            "inputSchema-wrapper",
            "input_schema-wrapper",
            "inputSchema-string",
            "parameters-wrapper",
            "parameters-string",
            # An explicit object type wins over a stray ``function`` key.
            "function-without-parameters-with-type",
        ],
    )
    def test_accepts_shape_the_supervisor_can_turn_into_a_tool(self, label):
        assert can_derive_tool_schema(_corpus()[label]) is True

    @pytest.mark.parametrize(
        "label",
        [
            "type-string",
            "type-array",
            "empty-dict",
            "unknown-keys-only",
            "properties-not-a-dict",
            "none",
            "list",
            "number",
            "bool",
            "json-string-list",
            "json-string-type-string",
            "json-string-garbage",
            "empty-string",
            "function-wrapper-bad-parameters",
            "inputSchema-bad-inner",
            "parameters-bad-inner",
            "too-deeply-nested",
        ],
    )
    def test_rejects_shape_the_supervisor_would_skip(self, label):
        assert can_derive_tool_schema(_corpus()[label]) is False

    def test_never_mutates_its_input(self):
        schema = {"function": {"parameters": {"properties": {"q": {}}}}}
        before = json.dumps(schema, sort_keys=True)
        can_derive_tool_schema(schema)
        assert json.dumps(schema, sort_keys=True) == before

    def test_never_raises_on_unhashable_or_odd_values(self):
        for odd in (object(), {1, 2}, b"bytes", 3.5, {"type": ["object"]}):
            assert can_derive_tool_schema(odd) in (True, False)


class TestParityWithSupervisor:
    @pytest.fixture
    def supervisor_derive(self):
        spec = importlib.util.spec_from_file_location(
            "supervisor_agent_config_for_parity", _SUPERVISOR_AGENT_CONFIG
        )
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.to_tool_input_schema

    @pytest.mark.parametrize("label", sorted(_corpus()))
    def test_agrees_with_to_tool_input_schema(self, supervisor_derive, label):
        schema = _corpus()[label]
        derived, _reason = supervisor_derive(schema, "parity-agent")
        assert can_derive_tool_schema(schema) is (derived is not None)


class TestAgentConfigProblem:
    def test_returns_none_for_a_complete_config(self):
        assert agent_config_problem("billing", "Billing agent", _OBJECT) is None

    @pytest.mark.parametrize("name", ["", "   ", None, 5])
    def test_reports_empty_or_non_string_name(self, name):
        problem = agent_config_problem(name, "Billing agent", _OBJECT)
        assert problem is not None and "name" in problem

    @pytest.mark.parametrize("description", ["", "   ", None, 5])
    def test_reports_empty_or_non_string_description(self, description):
        problem = agent_config_problem("billing", description, _OBJECT)
        assert problem is not None and "description" in problem

    @pytest.mark.parametrize("schema", [None, {}, {"type": "string"}, "{not json", []])
    def test_reports_underivable_schema(self, schema):
        problem = agent_config_problem("billing", "Billing agent", schema)
        assert problem is not None and "schema" in problem

    def test_accepts_openapi_document_schema(self):
        assert agent_config_problem("billing", "Billing agent", _OPENAPI) is None
