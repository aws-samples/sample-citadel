"""Tests for ``to_tool_input_schema`` and tool-name handling in agent_config.

Bedrock Converse requires ``toolSpec.inputSchema.json`` to be a JSON Schema
with ``type: 'object'`` and ``toolSpec.name`` to match ``^[a-zA-Z0-9_-]{1,64}$``.
Stored agent records carry other shapes (an OpenAPI 3.0 document, an
OpenAI-style ``{"function": {...}}`` wrapper), so the supervisor derives a
valid input schema on read:

  a. ``type: object``                       -> unchanged
  b. ``properties`` but no ``type``         -> ``type: object`` added
  c. OpenAPI document (``openapi``/``paths``) -> first operation's JSON request
     body, else its parameters, else a free-text ``input`` property
  d. ``{"function": {"parameters": {...}}}`` -> the parameters schema
  e. anything else                           -> ``None`` (agent skipped)
"""
from __future__ import annotations

import copy
import importlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orch-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-table")


def _fresh_agent_config():
    sys.modules.pop("agent_config", None)
    return importlib.import_module("agent_config")


def _warns(out: str, action: str) -> list[dict]:
    found = []
    for raw in out.splitlines():
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            line = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if line.get("action") == action:
            found.append(line)
    return found


def _agent(name="good", **overrides) -> dict:
    agent = {
        "name": name,
        "description": "Does a thing",
        "schema": {"type": "object", "properties": {"q": {"type": "string"}}},
        "agentId": f"id-{name}",
    }
    agent.update(overrides)
    return agent


_FALLBACK = {
    "type": "object",
    "properties": {
        "input": {"type": "string", "description": "Free-text request for helper"}
    },
    "required": ["input"],
}


class TestObjectSchemas:
    def test_a_object_schema_is_returned_unchanged_without_warning(self, capsys):
        ac = _fresh_agent_config()
        schema = {"type": "object", "properties": {"q": {"type": "string"}}}
        result, reason = ac.to_tool_input_schema(copy.deepcopy(schema), "helper")
        assert (result, reason) == (schema, None)
        assert capsys.readouterr().out == ""

    def test_b_missing_type_with_properties_gets_type_object(self, capsys):
        ac = _fresh_agent_config()
        schema = {"properties": {"q": {"type": "string"}}}
        original = copy.deepcopy(schema)
        result, reason = ac.to_tool_input_schema(schema, "helper")
        assert reason is None
        assert result == {"type": "object", "properties": {"q": {"type": "string"}}}
        assert schema == original  # input not mutated
        assert len(_warns(capsys.readouterr().out, "normalised_schema_type")) == 1


class TestOpenApiDocuments:
    def test_c_request_body_object_schema_is_used(self, capsys):
        ac = _fresh_agent_config()
        body = {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
        doc = {
            "openapi": "3.0.0",
            "paths": {
                "/lookup": {
                    "post": {
                        "parameters": [{"name": "ignored", "in": "query", "schema": {"type": "string"}}],
                        "requestBody": {"content": {"application/json": {"schema": body}}},
                    }
                }
            },
        }
        result, reason = ac.to_tool_input_schema(doc, "helper")
        assert (result, reason) == (body, None)
        warns = _warns(capsys.readouterr().out, "schema_derived_from_openapi")
        assert [w["strategy"] for w in warns] == ["request_body"]

    def test_c_parameters_become_object_properties_with_required_list(self, capsys):
        ac = _fresh_agent_config()
        doc = {
            "openapi": "3.0.1",
            "paths": {
                "/items": {
                    "get": {
                        "parameters": [
                            {"name": "limit", "in": "query", "schema": {"type": "integer"}},
                            {
                                "name": "id",
                                "in": "path",
                                "required": True,
                                "description": "Item id",
                                "schema": {"type": "string"},
                            },
                        ]
                    }
                }
            },
        }
        result, reason = ac.to_tool_input_schema(doc, "helper")
        assert reason is None
        assert result == {
            "type": "object",
            "properties": {
                "limit": {"type": "integer"},
                "id": {"type": "string", "description": "Item id"},
            },
            "required": ["id"],
        }
        warns = _warns(capsys.readouterr().out, "schema_derived_from_openapi")
        assert [w["strategy"] for w in warns] == ["parameters"]

    def test_c_non_object_request_body_falls_back_to_parameters(self):
        ac = _fresh_agent_config()
        doc = {
            "openapi": "3.0.0",
            "paths": {
                "/x": {
                    "post": {
                        "parameters": [{"name": "q", "in": "query", "schema": {"type": "string"}}],
                        "requestBody": {"content": {"application/json": {"schema": {"type": "array"}}}},
                    }
                }
            },
        }
        result, _ = ac.to_tool_input_schema(doc, "helper")
        assert result["properties"] == {"q": {"type": "string"}}

    def test_c_request_body_with_unresolvable_ref_is_not_used(self):
        ac = _fresh_agent_config()
        ref_body = {"type": "object", "properties": {"a": {"$ref": "#/components/schemas/A"}}}
        doc = {
            "openapi": "3.0.0",
            "paths": {"/x": {"post": {"requestBody": {"content": {"application/json": {"schema": ref_body}}}}}},
        }
        result, _ = ac.to_tool_input_schema(doc, "helper")
        assert result == _FALLBACK

    def test_c_document_without_operations_falls_back_to_free_text_input(self, capsys):
        ac = _fresh_agent_config()
        result, reason = ac.to_tool_input_schema(
            {"openapi": "3.0.0", "info": {"title": "x"}, "paths": {}}, "helper"
        )
        assert (result, reason) == (_FALLBACK, None)
        warns = _warns(capsys.readouterr().out, "schema_derived_from_openapi")
        assert [w["strategy"] for w in warns] == ["fallback_input"]

    def test_c_operation_without_usable_parameters_falls_back(self):
        ac = _fresh_agent_config()
        doc = {"openapi": "3.0.0", "paths": {"/x": {"get": {"parameters": [{"$ref": "#/components/parameters/P"}]}}}}
        result, _ = ac.to_tool_input_schema(doc, "helper")
        assert result == _FALLBACK


class TestFunctionWrapper:
    def test_d_function_parameters_are_unwrapped(self, capsys):
        ac = _fresh_agent_config()
        params = {"type": "object", "properties": {"x": {"type": "number"}}}
        wrapped = {"function": {"name": "f", "description": "d", "parameters": params}}
        result, reason = ac.to_tool_input_schema(wrapped, "helper")
        assert (result, reason) == (params, None)
        assert len(_warns(capsys.readouterr().out, "unwrapped_function_schema")) == 1

    def test_d_function_with_non_object_parameters_is_skipped(self):
        ac = _fresh_agent_config()
        result, reason = ac.to_tool_input_schema({"function": {"parameters": {"type": "string"}}}, "helper")
        assert result is None
        assert reason


class TestInvalidSchemas:
    def test_e_non_dict_schemas_are_rejected(self):
        ac = _fresh_agent_config()
        for bad in ("not json", [{"type": "object"}], None, 5):
            result, reason = ac.to_tool_input_schema(bad, "helper")
            assert result is None and reason == "schema_not_dict"

    def test_e_non_object_type_is_rejected(self):
        ac = _fresh_agent_config()
        for bad in ({"type": "string"}, {"type": ["object", "null"]}):
            assert ac.to_tool_input_schema(bad, "helper") == (None, "schema_type_not_object")

    def test_e_stringified_empty_dict_is_rejected_as_type_missing(self):
        ac = _fresh_agent_config()
        assert ac.to_tool_input_schema("{}", "helper") == (None, "schema_type_missing")

    def test_e_dict_with_no_type_and_no_properties_is_rejected(self):
        ac = _fresh_agent_config()
        assert ac.to_tool_input_schema({"title": "x"}, "helper") == (None, "schema_type_missing")


class TestToolName:
    def test_sanitise_replaces_invalid_characters_and_cuts_to_64(self):
        ac = _fresh_agent_config()
        assert ac.sanitise_tool_name("Catering Agent!") == "Catering_Agent_"
        assert ac.sanitise_tool_name("a.b") == "a_b"
        assert ac.sanitise_tool_name("good\n") == "good_"
        assert ac.sanitise_tool_name("a" * 70) == "a" * 64
        assert ac.sanitise_tool_name("ok-name_1") == "ok-name_1"

    def test_sanitise_rejects_non_string_and_empty_names(self):
        ac = _fresh_agent_config()
        assert ac.sanitise_tool_name(123) is None
        assert ac.sanitise_tool_name("") is None

    def test_create_agent_specs_sanitises_name_and_warns(self, capsys):
        ac = _fresh_agent_config()
        specs = ac.create_agent_specs({"agents": [_agent("Catering Agent!")]})
        assert [s["toolSpec"]["name"] for s in specs] == ["Catering_Agent_"]
        warns = _warns(capsys.readouterr().out, "tool_name_sanitised")
        assert len(warns) == 1
        assert warns[0]["name"] == "Catering Agent!"
        assert warns[0]["toolName"] == "Catering_Agent_"

    def test_valid_name_is_not_changed_and_does_not_warn(self, capsys):
        ac = _fresh_agent_config()
        specs = ac.create_agent_specs({"agents": [_agent("good-name_1")]})
        assert [s["toolSpec"]["name"] for s in specs] == ["good-name_1"]
        assert _warns(capsys.readouterr().out, "tool_name_sanitised") == []

    def test_names_colliding_after_sanitising_keep_only_the_first(self):
        ac = _fresh_agent_config()
        skipped: list[str] = []
        specs = ac.create_agent_specs(
            {"agents": [_agent("a b"), _agent("a_b")]}, skipped=skipped
        )
        assert [s["toolSpec"]["name"] for s in specs] == ["a_b"]
        assert skipped == ["duplicate_tool_name"]

    def test_resolve_agent_name_maps_tool_name_back_to_original(self):
        ac = _fresh_agent_config()
        config = {"agents": [_agent("Catering Agent!"), _agent("plain")]}
        assert ac.resolve_agent_name(config, "Catering_Agent_") == "Catering Agent!"
        assert ac.resolve_agent_name(config, "plain") == "plain"
        assert ac.resolve_agent_name(config, "unknown") == "unknown"


class TestCreateAgentSpecsOutput:
    def test_openapi_document_agent_yields_object_input_schema(self):
        ac = _fresh_agent_config()
        doc = {
            "openapi": "3.0.0",
            "paths": {"/x": {"get": {"parameters": [{"name": "q", "in": "query", "schema": {"type": "string"}}]}}},
        }
        specs = ac.create_agent_specs({"agents": [_agent("oas", schema=doc)]})
        assert len(specs) == 1
        assert specs[0]["toolSpec"]["inputSchema"]["json"]["type"] == "object"
        assert specs[0]["toolSpec"]["name"] == "oas"


# Live stored shapes (2026-11 scan of the agents table), redacted.
_OBJ = {
    "type": "object",
    "properties": {"invoice_id": {"type": "string", "description": "Invoice id"}},
    "required": ["invoice_id"],
}


class TestStoredSchemaShapes:
    def test_function_wrapper_with_outer_type_function_is_unwrapped(self, capsys):
        # invoice_approval_router_agent: outer type gate used to reject it.
        ac = _fresh_agent_config()
        stored = {
            "type": "function",
            "function": {"name": "route", "description": "d", "parameters": _OBJ},
            "returns": {"type": "object", "properties": {"ok": {"type": "boolean"}}},
        }
        assert ac.to_tool_input_schema(stored, "helper") == (_OBJ, None)
        assert len(_warns(capsys.readouterr().out, "unwrapped_function_schema")) == 1

    def test_function_wrapper_with_outer_type_function_and_bad_parameters_is_skipped(self):
        ac = _fresh_agent_config()
        stored = {"type": "function", "function": {"parameters": {"type": "string"}}}
        result, reason = ac.to_tool_input_schema(stored, "helper")
        assert result is None and reason == "schema_type_not_object"

    def test_outer_type_function_without_function_key_is_still_rejected(self):
        ac = _fresh_agent_config()
        assert ac.to_tool_input_schema({"type": "function"}, "helper") == (None, "schema_type_not_object")

    def test_input_schema_wrapper_is_unwrapped(self, capsys):
        # 11 live agents: {name, description, handler, inputSchema, outputSchema, ...}
        ac = _fresh_agent_config()
        stored = {
            "name": "x", "description": "d", "version": "1",
            "inputSchema": _OBJ, "outputSchema": {"type": "object"},
        }
        assert ac.to_tool_input_schema(stored, "helper") == (_OBJ, None)
        warns = _warns(capsys.readouterr().out, "unwrapped_input_schema")
        assert len(warns) == 1 and warns[0]["key"] == "inputSchema"

    def test_input_schema_wrapper_keeps_json_schema_extras(self):
        ac = _fresh_agent_config()
        inner = {**_OBJ, "$schema": "http://json-schema.org/draft-07/schema#", "title": "T"}
        result, reason = ac.to_tool_input_schema({"inputSchema": inner}, "helper")
        assert (result, reason) == (inner, None)

    def test_snake_case_input_schema_wrapper_is_unwrapped(self, capsys):
        ac = _fresh_agent_config()
        assert ac.to_tool_input_schema({"name": "x", "input_schema": _OBJ}, "helper") == (_OBJ, None)
        warns = _warns(capsys.readouterr().out, "unwrapped_input_schema")
        assert len(warns) == 1 and warns[0]["key"] == "input_schema"

    def test_input_schema_wrapper_without_type_but_with_properties_is_normalised(self, capsys):
        ac = _fresh_agent_config()
        inner = {"properties": {"q": {"type": "string"}}}
        result, reason = ac.to_tool_input_schema({"inputSchema": inner}, "helper")
        assert reason is None and result == {**inner, "type": "object"}
        assert len(_warns(capsys.readouterr().out, "normalised_schema_type")) == 1

    def test_input_schema_wrapper_with_non_object_inner_is_skipped(self):
        ac = _fresh_agent_config()
        result, reason = ac.to_tool_input_schema({"inputSchema": {"type": "string"}}, "helper")
        assert result is None and reason == "schema_type_not_object"

    def test_input_schema_wrapper_with_non_schema_value_is_skipped(self):
        ac = _fresh_agent_config()
        assert ac.to_tool_input_schema({"inputSchema": 5}, "helper") == (None, "schema_type_missing")

    def test_parameters_only_document_is_unwrapped(self, capsys):
        # 3 live agents: {name, description, parameters, returns}
        ac = _fresh_agent_config()
        stored = {"name": "x", "description": "d", "parameters": _OBJ, "returns": {"type": "object"}}
        assert ac.to_tool_input_schema(stored, "helper") == (_OBJ, None)
        assert len(_warns(capsys.readouterr().out, "unwrapped_parameters_schema")) == 1

    def test_parameters_that_is_not_a_schema_is_skipped(self):
        ac = _fresh_agent_config()
        assert ac.to_tool_input_schema({"parameters": ["a", "b"]}, "helper") == (None, "schema_type_missing")

    def test_swagger_2_document_is_derived_like_openapi(self, capsys):
        ac = _fresh_agent_config()
        doc = {
            "swagger": "2.0",
            "info": {"title": "x"},
            "paths": {"/run": {"post": {"parameters": [
                {"name": "q", "in": "query", "type": "string", "required": True},
            ]}}},
        }
        result, reason = ac.to_tool_input_schema(doc, "helper")
        assert reason is None and result["type"] == "object"
        assert len(_warns(capsys.readouterr().out, "schema_derived_from_openapi")) == 1

    def test_swagger_document_without_paths_falls_back_to_free_text(self, capsys):
        ac = _fresh_agent_config()
        result, reason = ac.to_tool_input_schema({"swagger": "2.0", "info": {}}, "helper")
        assert (result, reason) == (_FALLBACK, None)
        warns = _warns(capsys.readouterr().out, "schema_derived_from_openapi")
        assert warns[0]["strategy"] == "fallback_input"

    def test_stringified_object_schema_is_parsed(self, capsys):
        ac = _fresh_agent_config()
        result, reason = ac.to_tool_input_schema(json.dumps(_OBJ), "helper")
        assert (result, reason) == (_OBJ, None)
        assert len(_warns(capsys.readouterr().out, "parsed_stringified_schema")) == 1

    def test_stringified_wrapper_is_parsed_then_unwrapped(self):
        ac = _fresh_agent_config()
        result, reason = ac.to_tool_input_schema(json.dumps({"inputSchema": _OBJ}), "helper")
        assert (result, reason) == (_OBJ, None)

    def test_stringified_non_dict_json_is_rejected(self):
        ac = _fresh_agent_config()
        for bad in ("[1, 2]", "5", "null", "not json"):
            assert ac.to_tool_input_schema(bad, "helper") == (None, "schema_not_dict")

    def test_nested_wrappers_stop_at_a_depth_limit(self):
        ac = _fresh_agent_config()
        deep = {"type": "object"}
        for _ in range(10):
            deep = {"inputSchema": deep}
        assert ac.to_tool_input_schema(deep, "helper") == (None, "schema_too_deeply_nested")

    def test_does_not_mutate_input(self):
        ac = _fresh_agent_config()
        stored = {"type": "function", "function": {"parameters": copy.deepcopy(_OBJ)}}
        before = copy.deepcopy(stored)
        ac.to_tool_input_schema(stored, "helper")
        assert stored == before

    def test_create_agent_specs_keeps_input_schema_wrapper_agent(self):
        ac = _fresh_agent_config()
        skipped: list = []
        specs = ac.create_agent_specs(
            {"agents": [_agent("claims-intake-agent", schema={"inputSchema": _OBJ, "outputSchema": {}})]},
            skipped,
        )
        assert skipped == []
        assert specs[0]["toolSpec"]["inputSchema"]["json"] == _OBJ
