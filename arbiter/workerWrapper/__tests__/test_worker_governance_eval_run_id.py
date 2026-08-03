"""
CIT-102 Pass B — worker_governance.build_subprocess_env eval_run_id tests.

Mirrors test_governance_properties.py's style. Covers the additive-contract
guarantee: eval_run_id absent => CITADEL_EVAL_RUN_ID never set, byte-identical
env dict to the pre-CIT-102 shape.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from hypothesis import given, settings, strategies as st

from worker_governance import build_subprocess_env


def test_eval_run_id_sets_env_var_when_present():
    env = build_subprocess_env({}, eval_run_id="eval-run-123")
    assert env["CITADEL_EVAL_RUN_ID"] == "eval-run-123"


def test_eval_run_id_omitted_when_none():
    env = build_subprocess_env({}, eval_run_id=None)
    assert "CITADEL_EVAL_RUN_ID" not in env


def test_eval_run_id_omitted_when_empty_string():
    env = build_subprocess_env({}, eval_run_id="")
    assert "CITADEL_EVAL_RUN_ID" not in env


def test_eval_run_id_omitted_by_default():
    """Additive-contract guarantee: a caller that never passes eval_run_id
    produces a byte-identical env dict to the pre-CIT-102 signature."""
    env = build_subprocess_env({}, agent_id="agent-1", workflow_id="wf-1")
    assert "CITADEL_EVAL_RUN_ID" not in env


@given(eval_run_id=st.one_of(st.none(), st.text(min_size=1, max_size=64)))
@settings(max_examples=100, deadline=None)
def test_property_eval_run_id_iff_present_and_nonempty(eval_run_id):
    """[ADDITIVE-CONTRACT property] CITADEL_EVAL_RUN_ID is present in the
    output iff eval_run_id is a non-empty string; its value, when present,
    equals the input exactly."""
    env = build_subprocess_env({}, eval_run_id=eval_run_id)
    if isinstance(eval_run_id, str) and eval_run_id:
        assert env["CITADEL_EVAL_RUN_ID"] == eval_run_id
    else:
        assert "CITADEL_EVAL_RUN_ID" not in env
