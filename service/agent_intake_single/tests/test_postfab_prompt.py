"""Tests for the PHASE 8 (post-fabrication) system-prompt addition in agent.py.

Contract (per the approved design + UX copy review):
- PHASE 8 exists with a turn-start check_fabrication_status instruction
  (poll-on-turn: the agent cannot receive push notifications).
- Consent gates: never auto-proceed, decline = stop, defer allowed.
- Honest poll-only framing: never promise unprompted follow-up.
- The 5 post-fabrication tools are imported AND registered on the Agent.
- The postfab marker stage is baked into the state summary.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_postfab_prompt.py -q
from the service/agent_intake_single directory.
"""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("APPSYNC_GRAPHQL_URL", "https://test.example/graphql")

# Stub the AgentCore SDK (only present in the runtime image) — same pattern
# as tests/test_agent_cache.py.
if 'bedrock_agentcore' not in sys.modules:
    stub = types.ModuleType('bedrock_agentcore')

    class _StubApp:
        def __init__(self, *a, **kw): pass
        def add_middleware(self, *a, **kw): pass
        def entrypoint(self, fn):
            return fn

    class _StubRequestContext:
        pass

    stub.BedrockAgentCoreApp = _StubApp  # type: ignore[attr-defined]
    stub.RequestContext = _StubRequestContext  # type: ignore[attr-defined]
    sys.modules['bedrock_agentcore'] = stub

import inspect

import agent

POSTFAB_TOOLS = (
    "check_fabrication_status",
    "activate_agents",
    "create_agent_app",
    "generate_process_blueprint",
    "import_blueprint_to_app",
)


def test_phase8_present_with_turn_start_poll_instruction():
    assert "PHASE 8" in agent.SYSTEM_PROMPT
    assert "check_fabrication_status" in agent.SYSTEM_PROMPT
    assert "START of every turn" in agent.SYSTEM_PROMPT
    assert "push notifications" in agent.SYSTEM_PROMPT


def test_consent_gates_never_auto_proceed_and_decline_stops():
    prompt = agent.SYSTEM_PROMPT.lower()
    assert "never auto-proceed" in prompt
    assert "decline" in prompt
    assert "defer" in prompt


def test_honest_poll_only_framing():
    prompt = agent.SYSTEM_PROMPT
    assert "Never promise unprompted follow-up" in prompt
    assert "check back" in prompt.lower()


def test_failure_copy_rules_present():
    prompt = agent.SYSTEM_PROMPT.lower()
    # partial-failure handling + no raw errors rule from the UX review
    assert "partial success is still success" in prompt
    assert "never surface raw error" in prompt


def test_five_postfab_tools_imported_and_registered():
    src = inspect.getsource(agent)
    for name in POSTFAB_TOOLS:
        assert hasattr(agent, name), f"{name} not imported into agent.py"
        # once in the import, once in the Agent tools list (PHASE 8 prompt
        # references check_fabrication_status too, so require >= 2)
        assert src.count(name) >= 2, f"{name} not registered in the tools list"


def test_postfab_stage_baked_into_state_summary():
    src = inspect.getsource(agent.get_agent)
    assert "get_postfab_marker" in src
    assert "Post-fabrication" in src
