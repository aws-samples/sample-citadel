"""Tests for tool-spec validation before the supervisor's Bedrock Converse call.

Incident: Converse rejected the whole request with
``ValidationException: toolConfig.tools.1.toolSpec.inputSchema.json.type must
be object`` because one active agent record carried an OpenAPI document (no
top-level ``type``) as its ``schema``. Three failures in a row came from
unvalidated agent records.

``create_agent_specs`` is the single function that turns agent configs into
Converse tool specs; it now validates every spec and never fails the whole
task because of one agent:

  - schema must be a dict;
  - ``type`` absent but ``properties`` present -> normalised to ``object``
    (WARN ``normalised_schema_type``);
  - any other ``type`` (or no ``type`` and no ``properties``), or a schema
    that is not a dict -> agent skipped (WARN ``skip_invalid_tool_schema``
    with agentId, name, reason);
  - name must match ``^[a-zA-Z0-9_-]{1,64}$``, otherwise the agent is
    skipped (WARN ``skip_invalid_tool_schema``, reason ``invalid_tool_name``).
    The name is never rewritten: dispatch looks the agent up by the tool name
    the model returns, and governance keys on that name;
  - blank description -> falls back to the name (WARN ``description_fallback``).
"""
from __future__ import annotations

import copy
import importlib
import json
import os
import sys
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")
os.environ.setdefault("ORCHESTRATION_TABLE", "fake-orch-table")
os.environ.setdefault("WORKER_STATE_TABLE", "fake-worker-table")

_GOOD_SCHEMA = {"type": "object", "properties": {"q": {"type": "string"}}}


def _fresh_agent_config():
    sys.modules.pop("agent_config", None)
    return importlib.import_module("agent_config")


def _agent(name="good", **overrides) -> dict:
    agent = {
        "name": name,
        "description": "Does a thing",
        "schema": copy.deepcopy(_GOOD_SCHEMA),
        "agentId": f"id-{name}",
        "action": {"type": "sqs", "target": "https://sqs.fake/q"},
    }
    agent.update(overrides)
    return agent


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


def _names(specs) -> list[str]:
    return [s["toolSpec"]["name"] for s in specs]


class TestInvalidSchemaIsSkipped:
    def test_string_typed_schema_is_skipped_and_others_remain(self, capsys):
        ac = _fresh_agent_config()
        bad = _agent("bad", schema={"type": "string"})
        specs = ac.create_agent_specs({"agents": [_agent("first"), bad, _agent("last")]})
        assert _names(specs) == ["first", "last"]
        warns = _warns(capsys.readouterr().out, "skip_invalid_tool_schema")
        assert len(warns) == 1
        assert warns[0]["level"] == "WARN"
        assert warns[0]["name"] == "bad"
        assert warns[0]["agentId"] == "id-bad"
        assert warns[0]["reason"] == "schema_type_not_object"

    def test_list_schema_is_skipped(self, capsys):
        ac = _fresh_agent_config()
        specs = ac.create_agent_specs(
            {"agents": [_agent("listy", schema=[{"type": "object"}]), _agent("good")]}
        )
        assert _names(specs) == ["good"]
        warns = _warns(capsys.readouterr().out, "skip_invalid_tool_schema")
        assert [w["reason"] for w in warns] == ["schema_not_dict"]

    def test_json_string_schema_is_skipped(self, capsys):
        ac = _fresh_agent_config()
        specs = ac.create_agent_specs(
            {"agents": [_agent("stringy", schema='{"type": "object"}')]}
        )
        assert specs == []
        warns = _warns(capsys.readouterr().out, "skip_invalid_tool_schema")
        assert [w["reason"] for w in warns] == ["schema_not_dict"]

    def test_openapi_document_without_type_is_skipped(self, capsys):
        ac = _fresh_agent_config()
        openapi = {"openapi": "3.0.0", "info": {"title": "x"}, "paths": {}}
        specs = ac.create_agent_specs({"agents": [_agent("oas", schema=openapi)]})
        assert specs == []
        warns = _warns(capsys.readouterr().out, "skip_invalid_tool_schema")
        assert [w["reason"] for w in warns] == ["schema_type_missing"]

    def test_function_wrapper_schema_is_skipped(self, capsys):
        ac = _fresh_agent_config()
        wrapped = {"function": {"name": "f", "parameters": {"type": "object"}}}
        specs = ac.create_agent_specs({"agents": [_agent("wrapped", schema=wrapped)]})
        assert specs == []
        assert len(_warns(capsys.readouterr().out, "skip_invalid_tool_schema")) == 1

    def test_non_string_type_is_skipped(self, capsys):
        ac = _fresh_agent_config()
        specs = ac.create_agent_specs(
            {"agents": [_agent("arr", schema={"type": ["object", "null"]})]}
        )
        assert specs == []
        warns = _warns(capsys.readouterr().out, "skip_invalid_tool_schema")
        assert [w["reason"] for w in warns] == ["schema_type_not_object"]

    def test_skipped_reasons_are_collected_when_a_list_is_passed(self):
        ac = _fresh_agent_config()
        skipped: list[str] = []
        ac.create_agent_specs(
            {
                "agents": [
                    _agent("a", schema={"type": "string"}),
                    _agent("b", schema=[]),
                    _agent("bad name"),
                    _agent("ok"),
                ]
            },
            skipped=skipped,
        )
        assert skipped == ["schema_type_not_object", "schema_not_dict", "invalid_tool_name"]


class TestMissingTypeWithProperties:
    def test_missing_type_with_properties_is_normalised_to_object(self, capsys):
        ac = _fresh_agent_config()
        schema = {"properties": {"q": {"type": "string"}}, "required": ["q"]}
        specs = ac.create_agent_specs({"agents": [_agent("fixme", schema=schema)]})
        assert _names(specs) == ["fixme"]
        sent = specs[0]["toolSpec"]["inputSchema"]["json"]
        assert sent["type"] == "object"
        assert sent["properties"] == {"q": {"type": "string"}}
        assert sent["required"] == ["q"]
        warns = _warns(capsys.readouterr().out, "normalised_schema_type")
        assert len(warns) == 1
        assert warns[0]["level"] == "WARN"
        assert warns[0]["name"] == "fixme"
        assert warns[0]["agentId"] == "id-fixme"

    def test_normalisation_does_not_mutate_the_input_config(self):
        ac = _fresh_agent_config()
        schema = {"properties": {"q": {"type": "string"}}}
        agent = _agent("fixme", schema=schema)
        ac.create_agent_specs({"agents": [agent]})
        assert "type" not in agent["schema"]

    def test_valid_object_schema_passes_through_without_warnings(self, capsys):
        ac = _fresh_agent_config()
        specs = ac.create_agent_specs({"agents": [_agent("fine")]})
        assert specs[0]["toolSpec"]["inputSchema"]["json"] == _GOOD_SCHEMA
        out = capsys.readouterr().out
        assert _warns(out, "normalised_schema_type") == []
        assert _warns(out, "skip_invalid_tool_schema") == []


class TestToolName:
    def test_name_with_invalid_characters_is_skipped(self, capsys):
        ac = _fresh_agent_config()
        specs = ac.create_agent_specs(
            {"agents": [_agent("Catering Agent!"), _agent("good")]}
        )
        assert _names(specs) == ["good"]
        warns = _warns(capsys.readouterr().out, "skip_invalid_tool_schema")
        assert len(warns) == 1
        assert warns[0]["reason"] == "invalid_tool_name"
        assert warns[0]["name"] == "Catering Agent!"

    def test_name_longer_than_64_characters_is_skipped(self):
        ac = _fresh_agent_config()
        assert ac.create_agent_specs({"agents": [_agent("a" * 65)]}) == []

    def test_name_of_exactly_64_characters_is_kept(self):
        ac = _fresh_agent_config()
        assert _names(ac.create_agent_specs({"agents": [_agent("a" * 64)]})) == ["a" * 64]

    def test_name_with_trailing_newline_is_skipped(self):
        # ``$`` alone would accept "good\n"; Bedrock does not.
        ac = _fresh_agent_config()
        assert ac.create_agent_specs({"agents": [_agent("good\n")]}) == []

    def test_non_string_name_is_skipped_not_raised(self):
        ac = _fresh_agent_config()
        assert ac.create_agent_specs({"agents": [_agent(123)]}) == []

    def test_dotted_name_is_skipped(self):
        ac = _fresh_agent_config()
        assert ac.create_agent_specs({"agents": [_agent("a.b")]}) == []


class TestDescription:
    def test_blank_description_falls_back_to_name_with_warning(self, capsys):
        ac = _fresh_agent_config()
        specs = ac.create_agent_specs({"agents": [_agent("quiet", description="   ")]})
        assert specs[0]["toolSpec"]["description"] == "quiet"
        warns = _warns(capsys.readouterr().out, "description_fallback")
        assert len(warns) == 1
        assert warns[0]["level"] == "WARN"
        assert warns[0]["name"] == "quiet"

    def test_non_string_description_falls_back_to_name(self):
        ac = _fresh_agent_config()
        specs = ac.create_agent_specs({"agents": [_agent("odd", description=["x"])]})
        assert specs[0]["toolSpec"]["description"] == "odd"


class TestLoaderStampsAgentIdForWarnings:
    def test_agent_id_from_the_row_reaches_the_skip_warning(self, capsys):
        ac = _fresh_agent_config()
        table = MagicMock()
        table.scan.return_value = {
            "Items": [
                {
                    "agentId": "M5jl8S5w7XO5",
                    "state": "active",
                    "orgId": "Default",
                    "config": {
                        "name": "catering-fuel-sequencing-agent",
                        "description": "d",
                        "schema": {"openapi": "3.0.0", "paths": {}},
                    },
                }
            ]
        }
        resource = MagicMock()
        resource.Table.return_value = table
        with patch.object(ac, "dynamodb", resource):
            loaded = ac.load_config_from_dynamodb(org_id="Default")
        assert ac.create_agent_specs(loaded) == []
        warns = _warns(capsys.readouterr().out, "skip_invalid_tool_schema")
        assert warns[0]["agentId"] == "M5jl8S5w7XO5"
        assert warns[0]["name"] == "catering-fuel-sequencing-agent"


# ---------------------------------------------------------------------------
# Converse payload: the skipped tool must not reach Bedrock
# ---------------------------------------------------------------------------

_mock_dynamodb = MagicMock()
with patch.multiple(
    "boto3",
    resource=MagicMock(return_value=_mock_dynamodb),
    client=MagicMock(return_value=MagicMock()),
):
    import index as supervisor_mod


def _orchestration() -> dict:
    return {
        "orchestrationId": "orch-1",
        "orgId": "Default",
        "conversation": [{"role": "user", "content": [{"text": "hello"}]}],
    }


_TEXT_RESPONSE = {
    "output": {"message": {"role": "assistant", "content": [{"text": "ok"}]}},
    "usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
}


class TestConversePayload:
    @patch.object(supervisor_mod, "invoke_agents_from_conversation")
    @patch.object(supervisor_mod, "bedrock_circuit_breaker")
    @patch.object(supervisor_mod, "load_config_from_dynamodb")
    def test_converse_payload_excludes_skipped_tool_and_keeps_the_rest(
        self, mock_load, mock_breaker, _mock_invoke
    ):
        mock_load.return_value = {
            "agents": [
                _agent("first"),
                _agent("openapi-agent", schema={"openapi": "3.0.0", "paths": {}}),
                _agent("needs-type", schema={"properties": {"x": {"type": "string"}}}),
            ]
        }
        mock_breaker.call.return_value = _TEXT_RESPONSE

        supervisor_mod._run_orchestration(_orchestration())

        tools = mock_breaker.call.call_args.kwargs["toolConfig"]["tools"]
        assert [t["toolSpec"]["name"] for t in tools] == ["first", "needs-type"]
        for tool in tools:
            assert tool["toolSpec"]["inputSchema"]["json"]["type"] == "object"

    @patch.object(supervisor_mod, "send_response")
    @patch.object(supervisor_mod, "invoke_agents_from_conversation")
    @patch.object(supervisor_mod, "bedrock_circuit_breaker")
    @patch.object(supervisor_mod, "load_config_from_dynamodb")
    def test_when_every_tool_is_skipped_bedrock_is_not_called(
        self, mock_load, mock_breaker, mock_invoke, mock_send
    ):
        mock_load.return_value = {
            "agents": [_agent("bad", schema={"type": "string"})]
        }

        supervisor_mod._run_orchestration(_orchestration())

        mock_breaker.call.assert_not_called()
        mock_invoke.assert_not_called()
        mock_send.assert_called_once()
