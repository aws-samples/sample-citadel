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


def test_phase8_relays_next_steps_and_handles_show_me_how_to_publish():
    prompt = agent.SYSTEM_PROMPT
    assert "next_steps" in prompt
    assert "Show me how to publish" in prompt
    # walking through the steps is guidance only — no tool backs publishing
    assert "no tool call" in prompt.lower()


def test_phase8_never_claims_agent_publishes_on_users_behalf():
    prompt = agent.SYSTEM_PROMPT
    assert "NEVER offer or imply that you can publish" in prompt


def test_phase8_regenerate_blueprint_maps_to_explicit_tool_flag():
    """The already-published branch offers a 'Regenerate the blueprint'
    action; the prompt must map that choice (and only that choice) to
    generate_process_blueprint(..., regenerate=True) so the agent never
    regenerates without explicit consent."""
    prompt = agent.SYSTEM_PROMPT
    assert "Regenerate the blueprint" in prompt
    assert "regenerate=True" in prompt


def test_phase7_fabrication_started_progress_is_early_build_value():
    """The post-confirm progress instruction must be an early-Build value (10,
    the start of the fabrication window), NOT 0 — progress=0 regressed the
    Build segment after confirm_fabrication_plan had already recorded the
    confirm milestone."""
    prompt = agent.SYSTEM_PROMPT
    assert 'phase="implementation", progress=10' in prompt
    assert 'phase="implementation", progress=0,' not in prompt


def test_phase8_failed_tool_result_means_one_reply_then_stop():
    """Live transcript defect: the agent self-retried a failed post-fab tool
    ~5x within one turn, gluing narration between attempts. The prompt must
    pin the rule: ANY failed result -> compose ONE reply, present the
    result's actions, STOP. The user's button click is the only retry."""
    prompt = agent.SYSTEM_PROMPT
    assert "compose ONE reply" in prompt
    assert "never call the same tool again within the same turn" in prompt
    assert "the user's action choice is the only retry" in prompt.lower()


def test_phase8_no_self_retry_rule_covers_any_failure_not_just_sync():
    """The rule must be generic (ANY failed post-fabrication tool result),
    not scoped to the AGENTS_SYNCING case that already says 'the button IS
    the retry'."""
    prompt = agent.SYSTEM_PROMPT
    assert "ANY post-fabrication tool result that is not a success" in prompt
