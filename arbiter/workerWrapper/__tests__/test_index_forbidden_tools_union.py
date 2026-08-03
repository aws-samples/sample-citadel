"""
CIT-102 Pass B — workerWrapper/index.py process_event forbiddenTools union
tests.

Covers: forbiddenTools (frozen contract, supervisor dispatch payload) is
ADDED to the denied-tools union (never replaces static/binding-derived
denials), and eval_run_id threads through to build_subprocess_env so
CITADEL_EVAL_RUN_ID reaches the GovernedToolHandler ctor/env seam.
Absent contract keys => zero behavior change (byte-identical
build_subprocess_env call to the pre-CIT-102 shape).
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("CREDENTIAL_VENDER_FUNCTION", "")

import index


def _base_agent_config():
    return {
        "config": json.dumps({
            "tools": ["safe_tool"],
            "filename": "agent.zip",
            "description": "test agent",
        })
    }


def _run_process_event(event, agent_config=None):
    agent_config = agent_config or _base_agent_config()
    with patch.object(index, "load_config_from_dynamodb", return_value=agent_config), \
         patch.object(index, "get_scoped_credentials", return_value={}), \
         patch.object(index, "load_file_from_s3_into_tmp"), \
         patch.object(index, "run_agent_in_subprocess", return_value="ok"), \
         patch.object(index, "post_task_complete"), \
         patch.object(index, "build_subprocess_env", wraps=index.build_subprocess_env) as mock_build_env, \
         patch.object(index, "TOOLS_CONFIG_TABLE", None):
        index.process_event(event, {})
    return mock_build_env


class TestForbiddenToolsUnion:
    def test_forbidden_tools_added_to_denied_set(self):
        event = {
            "orchestration_id": "orch-1",
            "agent_use_id": "use-1",
            "agent_input": {"x": 1},
            "node": "agent1",
            "toolRestrictions": ["binding_blocked"],
            "forbiddenTools": ["eval_forbidden"],
        }
        mock_build_env = _run_process_event(event)

        _, kwargs = mock_build_env.call_args
        denied = set(kwargs["denied_tools"])
        # Union — binding restriction AND eval-forbidden tool both present.
        assert "binding_blocked" in denied
        assert "eval_forbidden" in denied

    def test_forbidden_tools_never_replaces_static_denials(self):
        """forbiddenTools ADDS to the denied set; the pre-existing
        toolRestrictions-derived denial must still be present."""
        event = {
            "orchestration_id": "orch-2",
            "agent_use_id": "use-2",
            "agent_input": {"x": 1},
            "node": "agent1",
            "toolRestrictions": ["static_deny"],
            "forbiddenTools": ["extra_eval_deny"],
        }
        mock_build_env = _run_process_event(event)

        _, kwargs = mock_build_env.call_args
        denied = set(kwargs["denied_tools"])
        assert {"static_deny", "extra_eval_deny"}.issubset(denied)

    def test_absent_forbidden_tools_byte_identical_denied_set(self):
        """Additive-contract guarantee: no forbiddenTools/evalRunId in the
        event produces the exact pre-CIT-102 denied_tools computation."""
        event = {
            "orchestration_id": "orch-3",
            "agent_use_id": "use-3",
            "agent_input": {"x": 1},
            "node": "agent1",
            "toolRestrictions": ["static_deny_only"],
        }
        mock_build_env = _run_process_event(event)

        _, kwargs = mock_build_env.call_args
        assert set(kwargs["denied_tools"]) == {"static_deny_only"}
        assert kwargs.get("eval_run_id") is None

    def test_eval_run_id_threaded_to_build_subprocess_env(self):
        event = {
            "orchestration_id": "orch-4",
            "agent_use_id": "use-4",
            "agent_input": {"x": 1},
            "node": "agent1",
            "evalRunId": "eval-run-55",
        }
        mock_build_env = _run_process_event(event)

        _, kwargs = mock_build_env.call_args
        assert kwargs.get("eval_run_id") == "eval-run-55"

    def test_no_forbidden_tools_and_no_restrictions_denied_tools_none(self):
        """When neither toolRestrictions nor forbiddenTools nor blocked
        stepConstraints tools exist, denied_tools stays None (unchanged
        pre-CIT-102 behavior — the empty-set sentinel)."""
        event = {
            "orchestration_id": "orch-5",
            "agent_use_id": "use-5",
            "agent_input": {"x": 1},
            "node": "agent1",
        }
        mock_build_env = _run_process_event(event)

        _, kwargs = mock_build_env.call_args
        assert kwargs.get("denied_tools") is None
