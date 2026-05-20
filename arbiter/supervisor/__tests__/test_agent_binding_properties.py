"""
Property-based tests for agent binding override application in arbiter/supervisor/agent_config.py

Feature: agent-apps-platform
Tests P7 (agent binding override application).
"""

import sys
import os
from unittest.mock import MagicMock, patch

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agents-table")
os.environ.setdefault("APPS_TABLE", "fake-apps-table")

# Patch boto3 at module level before importing agent_config
_mock_dynamodb = MagicMock()
with patch("boto3.resource", return_value=_mock_dynamodb):
    import agent_config as _agent_config_mod
    _agent_config_mod.dynamodb = _mock_dynamodb
    from agent_config import load_app_scoped_agents


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

agent_id_st = st.text(
    alphabet=st.characters(whitelist_categories=("Ll", "Nd"), whitelist_characters="-_"),
    min_size=1,
    max_size=20,
).filter(lambda s: s.strip() != "")

non_empty_text_st = st.text(min_size=1, max_size=100).filter(lambda s: s.strip() != "")

model_id_st = st.sampled_from([
    "us.anthropic.claude-sonnet-4-6",
    "us.anthropic.claude-haiku-3",
    "us.amazon.nova-pro-v1:0",
    "us.amazon.nova-lite-v1:0",
])

system_prompt_addition_st = st.one_of(st.none(), non_empty_text_st)
model_override_st = st.one_of(st.none(), model_id_st)


# ---------------------------------------------------------------------------
# P7: Agent binding override application
# ---------------------------------------------------------------------------

class TestAgentBindingOverrideApplication:
    """
    Feature: agent-apps-platform, Property 7: Agent binding override application

    For any agent configuration and any set of binding overrides
    (systemPromptAddition, modelOverride), applying the overrides should:
    (a) append systemPromptAddition to the agent's description,
    (b) use modelOverride as the Bedrock model ID.
    Unrecognized tool IDs in toolRestrictions should be silently ignored.

    Note: toolRestrictions are applied at the Worker Wrapper level (Task 16),
    not in load_app_scoped_agents, so we test systemPromptAddition and
    modelOverride here.

    **Validates: Requirements 3.6, 12.6**
    """

    def setup_method(self):
        _mock_dynamodb.reset_mock()
        _mock_dynamodb.Table.side_effect = None
        # Re-pin the mock so this file controls it regardless of import order
        _agent_config_mod.dynamodb = _mock_dynamodb

    @given(
        agent_id=agent_id_st,
        base_description=non_empty_text_st,
        system_prompt_addition=system_prompt_addition_st,
        model_override=model_override_st,
    )
    @settings(max_examples=100)
    def test_overrides_applied_correctly(
        self, agent_id, base_description, system_prompt_addition, model_override
    ):
        """systemPromptAddition is appended to description, modelOverride is stored on config.

        **Validates: Requirements 3.6, 12.6**
        """
        # Build binding item with overrides
        binding_item = {
            "appId": "app-test",
            "groupId": "APP#app-test",
            "sortId": f"AGENT#{agent_id}",
            "agentId": agent_id,
            "status": "READY",
            "addedAt": "2024-01-01T00:00:00Z",
        }
        if system_prompt_addition is not None:
            binding_item["systemPromptAddition"] = system_prompt_addition
        if model_override is not None:
            binding_item["modelOverride"] = model_override

        # Build agent config item
        agent_item = {
            "agentId": agent_id,
            "state": "active",
            "config": {
                "name": agent_id,
                "description": base_description,
                "schema": {"type": "object", "properties": {}},
            },
        }

        # Setup mocks
        mock_apps_table = MagicMock()
        mock_apps_table.query.return_value = {"Items": [binding_item]}

        mock_agents_table = MagicMock()
        mock_agents_table.get_item.return_value = {"Item": agent_item}

        _mock_dynamodb.Table.side_effect = lambda name: mock_apps_table if name == os.environ.get("APPS_TABLE") else mock_agents_table

        result = load_app_scoped_agents("app-test")

        assert len(result["agents"]) == 1
        agent_config = result["agents"][0]

        # (a) systemPromptAddition appended to description
        if system_prompt_addition is not None:
            assert base_description in agent_config["description"]
            assert system_prompt_addition in agent_config["description"]
        else:
            assert agent_config["description"] == base_description

        # (b) modelOverride stored on config
        if model_override is not None:
            assert agent_config["modelOverride"] == model_override
        else:
            assert "modelOverride" not in agent_config
