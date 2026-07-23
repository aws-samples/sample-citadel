"""
Tests for publish_intake_progress in arbiter/fabricator/index.py.

The project header's Build segment reserves the 10-60 window for fabrication
(confirm=10; post-fabrication milestones own 70-100). Per-agent completion
events must therefore scale within 10-60, not 0-100 — an unscaled 100 at the
last agent would leapfrog the post-fabrication milestones (70/80/85/90) and
prematurely complete the segment.

Failure convention is unchanged: a failed agent emits -1 (the backend updater
ignores negative values as failure signals, not progress).
"""

import json
import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

import index


def _publish_and_capture(agent_index: int, total_agents: int, failed: bool = False) -> dict:
    events_client = MagicMock()
    with patch.object(index.boto3, "client", return_value=events_client), \
         patch.dict(index.os.environ, {"COMPLETION_BUS_NAME": "fake-bus"}):
        index.publish_intake_progress("sess-1", agent_index, total_agents, "AgentA", failed=failed)
    entries = events_client.put_events.call_args.kwargs["Entries"]
    assert len(entries) == 1
    return json.loads(entries[0]["Detail"])


def test_last_agent_caps_at_60_not_100():
    detail = _publish_and_capture(agent_index=3, total_agents=4)
    assert detail["phase"] == "implementation"
    assert detail["completionPercentage"] == 60


def test_single_agent_completion_is_60():
    detail = _publish_and_capture(agent_index=0, total_agents=1)
    assert detail["completionPercentage"] == 60


def test_first_of_four_agents_lands_inside_the_window():
    detail = _publish_and_capture(agent_index=0, total_agents=4)
    # 10 + (1/4)*50 = 22 (int-truncated from 22.5)
    assert detail["completionPercentage"] == 22


def test_mid_progress_is_strictly_within_10_and_60():
    for i in range(4):
        detail = _publish_and_capture(agent_index=i, total_agents=4)
        assert 10 < detail["completionPercentage"] <= 60


def test_failed_agent_still_emits_minus_one():
    detail = _publish_and_capture(agent_index=1, total_agents=4, failed=True)
    assert detail["completionPercentage"] == -1


def test_no_publish_without_session_or_bus():
    events_client = MagicMock()
    with patch.object(index.boto3, "client", return_value=events_client):
        index.publish_intake_progress("", 0, 1, "AgentA")
        index.publish_intake_progress("0", 0, 1, "AgentA")
    events_client.put_events.assert_not_called()


def test_process_event_emits_failure_signal_once_only_after_final_attempt():
    # An always-transient fabricator must NOT emit -1 per attempt: the retry
    # wrapper swallows intermediate faults, so exactly ONE failed=True
    # progress publish happens, after the retry budget exhausts.
    import functools
    from botocore.exceptions import ClientError
    import pytest
    import transient_retry

    boom = ClientError(
        {"Error": {"Code": "internalServerException", "Message": "boom"}},
        "ConverseStream",
    )
    agent = MagicMock(side_effect=boom)
    progress_calls = []

    def record_progress(orchestration_id, agent_index, total_agents,
                        agent_use_id, failed=False):
        progress_calls.append(failed)

    no_sleep_retry = functools.partial(
        transient_retry.call_with_transient_retry, sleep=lambda _d: None
    )
    event = {
        "orchestration_id": "sess-1",
        "agent_use_id": "AgentA",
        "node": "fabricator",
        "agent_input": {"taskDetails": "Create an agent"},
        "agent_index": 0,
        "total_agents": 1,
    }
    with patch.object(index, "_write_fabrication_status"), \
            patch.object(index, "check_design_assessment"), \
            patch.object(index, "create_agent_fabricator") as mk, \
            patch.object(index, "publish_intake_progress", side_effect=record_progress), \
            patch.object(index, "publish_fabrication_event"), \
            patch.object(index, "call_with_transient_retry", no_sleep_retry):
        mk.return_value = agent
        with pytest.raises(ClientError):
            index.process_event(event, {}, request_type="agent-creation")

    assert agent.call_count == transient_retry.MAX_ATTEMPTS
    assert progress_calls == [True]
